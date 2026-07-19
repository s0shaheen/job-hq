"""Intake gates — per-profile disposition for every feed row (WS1).

The feed used to admit anything that passed the title filter; geo and YoE were
annotations, so ~97% of rows failed Salman's own criteria and sat visible
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
    geo_unknown: str = "filter"          # filter | keep — rows geo.enrich can't place
    yoe_max: int = 4
    yoe_unknown: str = "seniority-proxy"  # seniority-proxy | keep — tagged rows w/o a stated YoE
    seniority_exclude: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.countries = [_canon_country(c) for c in self.countries if str(c).strip()]
        self.seniority_exclude = [str(s).strip().casefold()
                                  for s in self.seniority_exclude if str(s).strip()]

    @classmethod
    def from_user_config(cls, cfg) -> "GateConfig":
        return cls(
            countries=list(cfg["filter_countries"]),
            geo_unknown=str(cfg["filter_geo_unknown"]),
            yoe_max=int(cfg["filter_yoe_max"]),
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

    # --- YoE (needs the tag block)
    raw_yoe = str(row.get("min_yoe", "")).strip()
    if raw_yoe:
        try:
            if int(float(raw_yoe)) > g.yoe_max:
                return FILTERED, f"yoe:{raw_yoe}>{g.yoe_max}"
            return QUALIFIED, ""
        except ValueError:
            pass                          # junk cell -> treat as unknown
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
