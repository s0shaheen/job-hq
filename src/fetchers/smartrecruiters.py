from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30
PAGE = 100


def parse(payload: dict, company: str, slug: str) -> list[Job]:
    jobs = []
    for j in payload.get("content", []):
        loc = (j.get("location") or {}).get("city", "") or ""
        jobs.append(Job(
            ats="smartrec", native_id=str(j["id"]), company=company,
            title=j.get("name", ""), location=loc,
            url=f"https://jobs.smartrecruiters.com/{slug}/{j['id']}",
            posted=j.get("releasedDate", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    out: list[Job] = []
    offset = 0
    while True:
        url = (f"https://api.smartrecruiters.com/v1/companies/{slug}/postings"
               f"?limit={PAGE}&offset={offset}")
        resp = session.get(url, timeout=TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
        content = payload.get("content") or []
        out.extend(parse(payload, company, slug))
        total = payload.get("totalFound", len(out))
        offset += len(content)  # advance by items actually returned (robust to short final page)
        if offset >= total or not content:
            break
    return out
