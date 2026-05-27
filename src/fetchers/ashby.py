from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30


def parse(payload: dict, company: str) -> list[Job]:
    jobs = []
    for j in payload.get("jobs", []):
        jobs.append(Job(
            ats="ashby", native_id=str(j["id"]), company=company,
            title=j.get("title", ""), location=j.get("location", "") or "",
            url=j.get("jobUrl") or j.get("applyUrl", "") or "",
            posted=j.get("publishedDate", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false"
    resp = session.get(url, timeout=TIMEOUT)
    resp.raise_for_status()
    return parse(resp.json(), company)
