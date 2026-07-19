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

_US_TOKENS = re.compile(r"\b(usa|u\.s\.a?\.?|us|united states)\b", re.I)
# Unambiguous US city shorthands ATSs use without a state token — each one
# left unrecognized turns a real US posting into a geo-unknown row. Country
# detection ONLY: these must never join the city-extraction skip guard, or
# "San Francisco, CA" would parse with a blank city.
_US_CITY_HINTS = re.compile(
    r"\b(nyc|new york city|sf|san francisco|bay area|silicon valley"
    r"|chicagoland|washington,? d\.?c\.?)\b", re.I)
_REMOTE = re.compile(r"\bremote\b", re.I)
_COUNTRIES = {
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
        for tok, name in _COUNTRIES.items():
            if re.search(rf"\b{re.escape(tok)}\b", low):
                country = name
                break

    # first listed location carries city/state
    first = re.split(r"[|;/]| or ", loc)[0].strip()
    parts = [p.strip() for p in first.split(",") if p.strip()]
    city, state = "", ""
    for p in parts:
        up = p.upper()
        if up in _STATES:
            state = up
        elif p.casefold() in _STATE_BY_NAME:
            state = _STATE_BY_NAME[p.casefold()]
        elif not city and not _US_TOKENS.fullmatch(p) and not _REMOTE.search(p) \
                and p.casefold() not in _COUNTRIES:
            city = p
    if state and not country:
        country = "United States"
    if city.casefold() in ("remote", "anywhere"):
        city = ""

    market = "Remote" if remote else ("US" if country == "United States" else country)
    return {"city": city, "state": state, "country": country,
            "remote": "TRUE" if remote else "", "market": market}
