"""Deterministic geo/remote derivation from ATS location strings.

No LLM: board location fields are structured enough ("Chicago, IL",
"San Francisco, CA, USA", "Remote - US", "Toronto, ON, Canada") that a
parser covers them; work_model (from tagging) refines remoteness later.

`market` collapses the filter Salman actually uses into ONE column:
  Remote (anywhere) -> "Remote" · US-based -> "US" · else the country · else "".
Filtering Feed on market in {US, Remote} == "United States or remote-anywhere".
"""
from __future__ import annotations

import re

from monitor import metros

_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
    "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee",
    "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia",
}
_STATE_BY_NAME = {v.casefold(): k for k, v in _STATES.items()}
# Names that are BOTH a major city and a state. In a multi-part location the
# state comes from the OTHER part ("New York, NY" / "Washington, DC"), so
# these must not be consumed as the state — that's what left the city blank
# on two of the densest job markets there are. Alone ("Illinois", but also
# "Washington"), the state reading still wins.
_CITY_ALSO_STATE = {"new york", "washington"}

_US_TOKENS = re.compile(r"\b(usa|u\.s\.a?\.?|us|united states)\b", re.I)
# Unambiguous US city shorthands ATSs use without a state token — each one
# left unrecognized turns a real US posting into a geo-unknown row. Country
# detection ONLY: these must never join the city-extraction skip guard, or
# "San Francisco, CA" would parse with a blank city.
_US_CITY_HINTS = re.compile(
    r"\b(nyc|new york city|sf|san francisco|bay area|silicon valley"
    r"|chicagoland|washington,? d\.?c\.?)\b", re.I)
_REMOTE = re.compile(r"\bremote\b", re.I)
# Foreign CITY -> country. Country inference only: these must never join the
# city-extraction skip guard, or "Toronto, Canada" would parse with no city
# (the same trap as _US_CITY_HINTS).
_FOREIGN_CITIES = {
    "bengaluru": "India", "bangalore": "India", "hyderabad": "India",
    "noida": "India", "gurugram": "India", "gurgaon": "India",
    "pune": "India", "chennai": "India", "mumbai": "India",
    "tokyo": "Japan", "shanghai": "China", "beijing": "China",
    "shenzhen": "China", "tel aviv": "Israel", "dublin": "Ireland",
    "são paulo": "Brazil", "sao paulo": "Brazil", "toronto": "Canada",
    "vancouver": "Canada", "montreal": "Canada", "seoul": "South Korea",
    "manila": "Philippines", "taipei": "Taiwan", "sydney": "Australia",
    "amsterdam": "Netherlands", "berlin": "Germany", "munich": "Germany",
    "paris": "France", "madrid": "Spain", "barcelona": "Spain",
    "warsaw": "Poland", "krakow": "Poland", "zurich": "Switzerland",
    "stockholm": "Sweden", "singapore": "Singapore",
}
# ISO-3 codes appear verbatim in several ATS location strings ("Bengaluru,
# Karnataka, IND"). Without them the row reads as UNPLACEABLE rather than
# foreign — same outcome under filter_geo_unknown=filter, but flatly wrong
# for a user whose policy is `keep`, who would then be shown foreign roles.
_COUNTRIES = {
    "ind": "India", "jpn": "Japan", "chn": "China", "china": "China",
    "lux": "Luxembourg", "luxembourg": "Luxembourg", "deu": "Germany",
    "gbr": "United Kingdom", "fra": "France", "esp": "Spain",
    "nld": "Netherlands", "irl": "Ireland", "isr": "Israel",
    "bra": "Brazil", "mex": "Mexico", "aus": "Australia", "can": "Canada",
    "sgp": "Singapore", "che": "Switzerland", "swe": "Sweden",
    "pol": "Poland", "kor": "South Korea", "phl": "Philippines",
    "canada": "Canada", "united kingdom": "United Kingdom", "uk": "United Kingdom",
    "england": "United Kingdom", "london": "United Kingdom", "germany": "Germany",
    "france": "France", "netherlands": "Netherlands", "ireland": "Ireland",
    "spain": "Spain", "poland": "Poland", "india": "India", "singapore": "Singapore",
    "japan": "Japan", "australia": "Australia", "brazil": "Brazil", "mexico": "Mexico",
    "israel": "Israel", "uae": "UAE", "switzerland": "Switzerland", "sweden": "Sweden",
}


def enrich(location: str, work_model: str = "") -> dict[str, str]:
    loc = (location or "").strip()
    blob = f"{loc} {work_model or ''}"
    remote = bool(_REMOTE.search(blob))

    country = ""
    if _US_TOKENS.search(loc) or _US_CITY_HINTS.search(loc):
        country = "United States"
    else:
        low = loc.casefold()
        for tok, name in list(_COUNTRIES.items()) + list(_FOREIGN_CITIES.items()):
            if re.search(rf"\b{re.escape(tok)}\b", low):
                country = name
                break

    # first listed location carries city/state
    first = re.split(r"[|;/]| or ", loc)[0].strip()
    parts = [p.strip() for p in first.split(",") if p.strip()]

    # A part that is BOTH a city and a state name ("New York", "Washington")
    # is only the city when some OTHER part supplies the state: "New York, NY"
    # and "Washington, DC" are city-first, but "Seattle, Washington" and
    # "New York, New York" have no other state token, so the collision name
    # must still be read as the state (dropping it blanks state AND country,
    # which then reads as geo-unknown and filters the row out entirely).
    def _is_state_token(p: str) -> bool:
        cf = p.casefold()
        return p.upper() in _STATES or cf in _STATE_BY_NAME

    def _other_part_supplies_state(idx: int) -> bool:
        return any(_is_state_token(q) and q.casefold() not in _CITY_ALSO_STATE
                   for j, q in enumerate(parts) if j != idx)

    state = ""
    city_collision_idx = -1
    for i, p in enumerate(parts):
        cf = p.casefold()
        if p.upper() in _STATES:
            state = p.upper()
        elif cf in _STATE_BY_NAME:
            if cf in _CITY_ALSO_STATE and _other_part_supplies_state(i):
                city_collision_idx = i      # it's the city; the state is elsewhere
                continue
            state = _STATE_BY_NAME[cf]

    def _skip_for_city(i: int, p: str) -> bool:
        if i == city_collision_idx:
            return False                     # "New York" in "New York, NY"
        cf = p.casefold()
        return (p.upper() in _STATES or cf in _STATE_BY_NAME
                or bool(_US_TOKENS.fullmatch(p)) or bool(_REMOTE.search(p))
                or cf in _COUNTRIES)

    city = next((p for i, p in enumerate(parts) if not _skip_for_city(i, p)), "")
    # "New York, New York": every part is the collision name, so the state
    # loop consumed them all. With the state already known, the leading part
    # is the city. A LONE collision name is the city only when it names a
    # major metro ("New York"); bare "Washington" stays the state.
    if not city and parts and parts[0].casefold() in _CITY_ALSO_STATE \
            and (len(parts) > 1 or metros.is_anchor(parts[0])):
        city = parts[0]
    if state and not country:
        country = "United States"
    if city.casefold() in ("remote", "anywhere"):
        city = ""

    metro = metros.metro_for(city, state)
    if metro and not country:
        # every metro in metros.py is a US metro, so placing one settles the
        # country. Without this a bare "Chicago" or "Seattle" — which ATSs
        # emit constantly — was filtered as UNPLACEABLE, silently hiding real
        # domestic jobs.
        country = "United States"

    market = "Remote" if remote else ("US" if country == "United States" else country)
    # metro is the grain a LOCAL search needs: "Chicago area" spans IL, IN and
    # WI suburbs that never carry the word Chicago, while state=IL admits
    # Peoria. Blank whenever the city can't be placed confidently — a guess
    # here would quietly admit the wrong city to someone's whole feed.
    return {"city": city, "state": state, "country": country,
            "remote": "TRUE" if remote else "", "market": market,
            "metro": metro}
