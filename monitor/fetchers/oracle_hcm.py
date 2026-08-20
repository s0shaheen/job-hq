"""Oracle Recruiting Cloud CE (hcmRestApi) — slug is "host|siteNumber", e.g.
"eeho.fa.us2.oraclecloud.com|CX_45001", "jpmc.fa.oraclecloud.com|CX_1001".
ats value: "oraclehcm".

keyword= is FULL-TEXT (JPMC: 5,347 matches for "product manager" out of a much
larger corpus — verified 2026-07-13), so paginating the whole match set is not
viable. We rely on the default relevance ranking (no sortBy when keyword is
present; JPMC page 1 = 25/25 title matches) and cap pages: every title-matching
role ranks far above description-only matches, and titles are all the pipeline
keeps anyway.

Two non-obvious request requirements, both verified:
- expand=requisitionList.secondaryLocations is MANDATORY — without it the
  response omits requisitionList entirely.
- the finder value uses ";" then "," separators that must stay unencoded, so
  the URL is assembled by hand (requests' params= would mangle it).
"""
from __future__ import annotations
import time
from urllib.parse import quote

import requests

from core.useragent import USER_AGENT
from monitor.models import Job

TIMEOUT = 30
PAGE = 25          # research-safe limit; larger untested
MAX_PAGES = 12     # relevance head: 300 postings
SLEEP = 0.4


def _split_slug(slug: str) -> tuple[str, str]:
    host, site = slug.split("|", 1)
    return host, site


def _list_url(host: str, site: str, search: str, offset: int) -> str:
    kw = quote(search, safe="")
    return (f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions"
            f"?onlyData=true&expand=requisitionList.secondaryLocations"
            f"&finder=findReqs;siteNumber={site},keyword=%22{kw}%22,"
            f"limit={PAGE},offset={offset}")


def parse(payload: dict, company: str, slug: str) -> list[Job]:
    host, site = _split_slug(slug)
    item = (payload.get("items") or [{}])[0]
    jobs = []
    for r in item.get("requisitionList") or []:
        rid = str(r.get("Id", ""))
        jobs.append(Job(
            ats="oraclehcm", native_id=rid, company=company,
            title=r.get("Title", "") or "", location=r.get("PrimaryLocation", "") or "",
            url=f"https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{rid}",
            posted=r.get("PostedDate", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    host, site = _split_slug(slug)
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    out: list[Job] = []
    offset, pages = 0, 0
    while pages < MAX_PAGES:
        resp = session.get(_list_url(host, site, search, offset), timeout=TIMEOUT, headers=headers)
        resp.raise_for_status()
        payload = resp.json()
        page_jobs = parse(payload, company, slug)
        out.extend(page_jobs)
        item = (payload.get("items") or [{}])[0]
        try:
            total = int(item.get("TotalJobsCount") or 0)
        except (TypeError, ValueError):
            total = 0
        offset += len(page_jobs)
        pages += 1
        if not page_jobs or offset >= total:
            break
        time.sleep(SLEEP)
    return out
