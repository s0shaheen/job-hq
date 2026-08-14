"""Intake gates — per-profile disposition for every feed row (WS1).

The feed used to admit anything that passed the title filter; geo and YoE were
annotations, so ~97% of rows failed the owner's own criteria and sat visible
forever. Gates turn the Search Profile (Config-tab knobs today, per-user
profiles later) into a disposition stamped on every row at write time:

    qualified   — surfaces: push/digest/triage candidates
    filtered    — stored + invisible + recoverable; disposition_reason says why
    needs-info  — geo passed but the row is untagged; review.py re-gates after
                  tagging, so nothing is shown until its YoE story is known

Ordering is cost-ordered: geo is deterministic and free and runs first; YoE
needs the LLM tag block, so untagged rows park as needs-info instead of
burning a Haiku call at the gate. Rows the tagger gave up on (tagged_at
sentinel no-jd:/failed:) fall to the yoe-unknown policy rather than hiding
real postings behind a fetch failure.

Pure logic — no sheet, no network. Callers stamp rows via
HQFeedStore(disposer=...) or set_disposition().
"""
from __future__ import annotations

from dataclasses import dataclass, field

from monitor import comp as _comp

QUALIFIED = "qualified"
FILTERED = "filtered"
NEEDS_INFO = "needs-info"

# Humans type "US" in a Config cell; geo.enrich writes "United States".
_COUNTRY_ALIASES = {
    "us": "United States", "usa": "United States", "u.s.": "United States",
    "united states": "United States", "united states of america": "United States",
    "uk": "United Kingdom",
}

_TRUEISH = ("TRUE", "1", "YES")


def _canon_country(name: str) -> str:
    s = str(name or "").strip()
    return _COUNTRY_ALIASES.get(s.casefold(), s)


@dataclass
class GateConfig:
    countries: list[str] = field(default_factory=lambda: ["United States"])
    # metros: empty = anywhere within `countries`. Non-empty narrows to those
    # metros (plus remote, which is location-independent) — the grain a local
    # search needs, where a country filter is useless and a state filter is
    # wrong (Chicago spans IL/IN/WI; IL includes Peoria).
    metros: list[str] = field(default_factory=list)
    geo_unknown: str = "filter"          # filter | keep — rows geo.enrich can't place
    # comp floor in $k. 0 = off. ~52% of live postings state a range, so this
    # gate genuinely bites; the other ~48% are governed by comp_unknown.
    comp_min: float = 0
    comp_unknown: str = "keep"           # keep | filter — postings that state no comp
    # substrings matched against work_model, e.g. ["onsite"] to never see
    # on-site roles. Case-insensitive.
    work_model_exclude: list[str] = field(default_factory=list)
    # None = no ceiling: the YoE gate does not run. The default is OFF, not a
    # number — a profile that never stated a ceiling must not inherit one
    # (RM-40 vault audit §3b / §9 Step 4: the old default of 4 was one
    # person's search encoded as everybody's deal-breaker).
    yoe_max: int | None = None
    yoe_unknown: str = "seniority-proxy"  # seniority-proxy | keep — tagged rows w/o a stated YoE
    seniority_exclude: list[str] = field(default_factory=list)

    def __post_init__(self):
        # Unified unset semantics for the ceiling (#251 review): a blank
        # string — INCLUDING whitespace — is the OFF state, exactly like None,
        # never a number. A numeric string still gates (int(float(...)), the
        # same truncation the stated-YoE side uses); junk raises, which is
        # this side's fail-loud posture. The TypeScript port makes the same
        # call in toIntOrNull, and the corpus pins both
        # (yoe-whitespace-ceiling-is-unset-not-zero).
        if isinstance(self.yoe_max, str):
            s = self.yoe_max.strip()
            self.yoe_max = None if s == "" else int(float(s))
        self.countries = [_canon_country(c) for c in self.countries if str(c).strip()]
        self.metros = [str(m).strip() for m in self.metros if str(m).strip()]
        self.seniority_exclude = [str(s).strip().casefold()
                                  for s in self.seniority_exclude if str(s).strip()]
        self.work_model_exclude = [str(w).strip().casefold()
                                   for w in self.work_model_exclude if str(w).strip()]
        try:
            self.comp_min = float(self.comp_min or 0)
        except (TypeError, ValueError):
            self.comp_min = 0

    @classmethod
    def from_user_config(cls, cfg) -> "GateConfig":
        return cls(
            countries=list(cfg["filter_countries"]),
            metros=list(cfg.get("filter_metros", []) or []),
            comp_min=float(cfg.get("filter_comp_min", 0) or 0),
            comp_unknown=str(cfg.get("filter_comp_unknown", "keep")),
            work_model_exclude=list(cfg.get("filter_work_model_exclude", []) or []),
            geo_unknown=str(cfg["filter_geo_unknown"]),
            # blank/absent = no ceiling; normalized in __post_init__ so a
            # whitespace-only value lands OFF here too, not in int()'s lap
            yoe_max=cfg["filter_yoe_max"],
            yoe_unknown=str(cfg["filter_yoe_unknown"]),
            seniority_exclude=list(cfg["filter_seniority_exclude"]),
        )


def dispose(row: dict, g: GateConfig) -> tuple[str, str]:
    """(disposition, reason) for a row dict carrying country/remote (post
    geo.enrich), min_yoe, seniority, tagged_at. Reasons are short, stable
    strings — they feed the digest's filtered-counts and future suppression
    rules, so keep them mechanical, not prose."""
    country = _canon_country(row.get("country", ""))
    remote = str(row.get("remote", "")).strip().upper() in _TRUEISH

    # --- geo (free, always known at append time)
    if country:
        if country not in g.countries:
            return FILTERED, f"geo:{country}"
    elif not remote:                      # blank country, not remote
        if g.geo_unknown == "filter":
            return FILTERED, "geo-unknown"
        # keep -> fall through to YoE
    # blank country + remote passes: a remote role with no stated origin is
    # worth a look; foreign-anchored remote carries its country and was caught.

    # --- metro (only when the profile names metros: a LOCAL search)
    if g.metros and not remote:
        metro = str(row.get("metro", "")).strip()
        if not metro:
            # in-country but unplaceable: same policy the user chose for geo
            if g.geo_unknown == "filter":
                return FILTERED, "metro-unknown"
        elif metro not in g.metros:
            return FILTERED, f"metro:{metro}"

    # --- work model (free once tagged: "never show me on-site")
    wm = str(row.get("work_model", "")).casefold()
    if wm and g.work_model_exclude:
        for tok in g.work_model_exclude:
            if tok in wm:
                return FILTERED, f"work-model:{tok}"

    # --- compensation. Judged on the TOP of the stated band, so a
    # $110-160k posting clears a $120k floor. Unknown comp follows an explicit
    # policy: with ~half of postings stating nothing, defaulting to `filter`
    # here would delete most of the feed.
    tagged = bool(str(row.get("tagged_at", "")).strip())
    if g.comp_min:
        clears = _comp.meets_floor(row.get("comp_range", ""), g.comp_min)
        if clears is False:
            return FILTERED, f"comp:<{g.comp_min:g}k"
        if clears is None and tagged and g.comp_unknown == "filter":
            return FILTERED, "comp-unknown"

    # --- YoE (needs the tag block)
    raw_yoe = str(row.get("min_yoe", "")).strip()
    if raw_yoe:
        try:
            stated = int(float(raw_yoe))
        except ValueError:
            stated = None                 # junk cell -> treat as unknown
        if stated is not None:
            # yoe_max None = no ceiling set: a stated YoE qualifies unfiltered
            if g.yoe_max is not None and stated > g.yoe_max:
                return FILTERED, f"yoe:{raw_yoe}>{g.yoe_max}"
            return QUALIFIED, ""
    if not str(row.get("tagged_at", "")).strip():
        return NEEDS_INFO, "awaiting-tags"

    # tagged (or gave up: no-jd:/failed: sentinel) but the JD states no YoE
    if g.yoe_unknown == "seniority-proxy":
        sen = str(row.get("seniority", "")).strip()
        if sen and sen.casefold() in g.seniority_exclude:
            return FILTERED, f"seniority:{sen}"
    return QUALIFIED, "yoe-unknown"


def make_disposer(g: GateConfig):
    """Row-dict -> {'disposition': ..., 'disposition_reason': ...} for store
    write paths (append + tag-write + regate all stamp through this)."""
    def disposer(row: dict) -> dict:
        d, r = dispose(row, g)
        return {"disposition": d, "disposition_reason": r}
    return disposer
