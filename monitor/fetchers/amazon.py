from __future__ import annotations
from urllib.parse import quote

import requests

from monitor.models import Job

TIMEOUT = 30
PAGE = 100         # result_limit is honored up to 100; the old size/start params are ignored
MAX_PAGES = 50     # runaway guard only (~741 PM hits = 8 pages)
# amazon.jobs rejects the default python-requests UA; present a browser-like one.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# id_icims -> combined JD html, filled at parse time. search.json embeds the
# FULL description + basic/preferred qualifications per job (verified
# 2026-07-13), so review-tagging reads Amazon JDs with zero extra requests —
# the per-job endpoints are retired (HTTP 406). jobcontent consumes this.
DESCRIPTIONS: dict[str, str] = {}


def _jd_html(j: dict) -> str:
    parts = [j.get("description") or ""]
    for key, label in (("basic_qualifications", "Basic qualifications:"),
                       ("preferred_qualifications", "Preferred qualifications:")):
        v = j.get(key) or ""
        if v:
            parts.append(f"<h3>{label}</h3>{v}")
    return "\n".join(p for p in parts if p)


def parse(payload: dict, company: str) -> list[Job]:
    jobs = []
    for j in payload.get("jobs", []):
        path = j.get("job_path", "") or ""
        native_id = str(j["id_icims"])
        jd = _jd_html(j)
        if jd:
            DESCRIPTIONS[native_id] = jd
        jobs.append(Job(
            ats="amazon", native_id=native_id, company=company,
            title=j.get("title", ""), location=j.get("normalized_location", "") or "",
            url=f"https://www.amazon.jobs{path}", posted=j.get("posted_date", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    """Amazon has a global JSON search (no per-company slug); `slug` is ignored."""
    out: list[Job] = []
    offset, pages = 0, 0
    while pages < MAX_PAGES:
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
        pages += 1
        if not page or offset >= hits:
            break
    return out
