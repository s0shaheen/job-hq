from __future__ import annotations
from urllib.parse import quote

import requests

from src.models import Job

TIMEOUT = 30
PAGE = 100
# amazon.jobs rejects the default python-requests UA; present a browser-like one.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def parse(payload: dict, company: str) -> list[Job]:
    jobs = []
    for j in payload.get("jobs", []):
        path = j.get("job_path", "") or ""
        jobs.append(Job(
            ats="amazon", native_id=str(j["id_icims"]), company=company,
            title=j.get("title", ""), location=j.get("normalized_location", "") or "",
            url=f"https://www.amazon.jobs{path}", posted=j.get("posted_date", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    """Amazon has a global JSON search (no per-company slug); `slug` is ignored."""
    out: list[Job] = []
    offset = 0
    while True:
        url = (f"https://www.amazon.jobs/en/search.json?base_query={quote(search)}"
               f"&result_limit={PAGE}&offset={offset}")
        resp = session.get(url, timeout=TIMEOUT, headers={"User-Agent": UA})
        resp.raise_for_status()
        payload = resp.json()
        page = payload.get("jobs", [])
        out.extend(parse(payload, company))
        try:
            hits = int(payload.get("hits", len(out)) or 0)
        except (TypeError, ValueError):
            hits = len(out)
        offset += len(page)
        if not page or offset >= hits:
            break
    return out
