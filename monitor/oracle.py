"""Coverage oracle — how comprehensive is a user's company universe, measured.

The design (docs/plans/COMPANY-DISCOVERY.md) makes "comprehensive" mechanical: for a facet
("companies posting {titles} in {geo} right now"), TheirStack gives the denominator D directly.

Mechanic (empirically validated 2026-07-24, all FREE — blurred queries consume no credits):
  D      = jobs/search + blur + facet          -> metadata.total_companies
  gap_D  = same + company_name_not=<universe>  -> metadata.total_companies (facet cos NOT ours)
  recall = 1 - gap_D / D

The jobs/search endpoint (not companies/search, which filters firmographics and can't take a
job facet) returns metadata.total_companies = the distinct-company count for the query. And
EXCLUSION filters apply under blur even though the INCLUSION fence does not: wide.py's preview
shape strips the inclusion fences (company_name_case_insensitive_or / company_domain_or — fencing
TO companies), but company_name_not / company_domain_not (excluding companies) both dropped the
count in testing. So the recall-diff is free.

Caveats: name exclusion is fuzzy (variants like "J.P. Morgan" vs "JPMorgan Chase" can miss), so
recall is approximate — a domain-based universe (once we store domains) is tighter. Very large
exclusion lists may hit an array cap; chunk_names() splits them and the gap is unionable only
approximately, so prefer domains at scale. No credits are spent here; only the later "reveal the
top-N missing companies" step (blur off) costs credits, and that lives with the discovery agent.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import requests

TS_URL = "https://api.theirstack.com/v1/jobs/search"
TIMEOUT = 45


@dataclass
class Facet:
    """A slice of the job market the oracle can size."""
    titles: list[str]
    country_codes: list[str] = field(default_factory=lambda: ["US"])
    location_ids: list[int] = field(default_factory=list)  # TheirStack catalog location ids
    max_age_days: int = 30


def build_body(facet: Facet, *, exclude_names: list[str] | None = None,
               exclude_domains: list[str] | None = None) -> dict:
    """The blurred, credit-free request body. limit=1 because we only read metadata."""
    body: dict = {
        "limit": 1,
        "offset": 0,
        "blur_company_data": True,      # free: blurred queries do not consume credits
        "include_total_results": True,  # populates metadata.total_companies
        "job_title_or": list(facet.titles),
        "posted_at_max_age_days": facet.max_age_days,
    }
    if facet.country_codes:
        body["job_country_code_or"] = list(facet.country_codes)
    if facet.location_ids:
        body["job_location_or"] = [{"id": int(i)} for i in facet.location_ids]
    if exclude_names:
        body["company_name_not"] = list(exclude_names)
    if exclude_domains:
        body["company_domain_not"] = list(exclude_domains)
    return body


def _total_companies(body: dict, api_key: str, session: requests.Session) -> int:
    r = session.post(TS_URL, json=body,
                     headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
                     timeout=TIMEOUT)
    r.raise_for_status()
    meta = (r.json() or {}).get("metadata") or {}
    return int(meta.get("total_companies") or 0)


def denominator(facet: Facet, api_key: str, session: requests.Session) -> int:
    """D — distinct companies posting this facet right now. Free (blurred)."""
    return _total_companies(build_body(facet), api_key, session)


@dataclass
class Coverage:
    denominator: int   # D — companies posting the facet
    gap: int           # gap_D — those NOT in our universe (name/domain-excluded)
    covered: int       # D - gap_D (approximate; name matching is fuzzy)
    recall: float      # covered / D, in [0, 1]


def coverage(facet: Facet, universe_names: list[str], api_key: str,
             session: requests.Session, *, universe_domains: list[str] | None = None) -> Coverage:
    """Recall of our universe against the facet. All free (blurred).

    `covered`/`recall` are approximate: exclusion matches companies by name (or domain), which
    can miss name variants. Treat recall as a lower bound and prefer domains when available.
    """
    d = denominator(facet, api_key, session)
    gap = _total_companies(
        build_body(facet, exclude_names=universe_names or None, exclude_domains=universe_domains),
        api_key, session,
    )
    covered = max(0, d - gap)
    return Coverage(denominator=d, gap=gap, covered=covered, recall=(covered / d) if d else 0.0)


if __name__ == "__main__":
    import os
    import sys

    facet = Facet(titles=sys.argv[1:] or ["software engineer", "product manager"])
    key = os.environ.get("THEIRSTACK_API_KEY", "")
    if not key:
        print("THEIRSTACK_API_KEY unset — export it (or source .env) first")
        raise SystemExit(1)
    d = denominator(facet, key, requests.Session())
    print(f"{', '.join(facet.titles)} (US, {facet.max_age_days}d): {d} companies posting (free/blurred)")
