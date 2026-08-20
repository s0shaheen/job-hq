from __future__ import annotations
import requests

from core.useragent import USER_AGENT
from monitor.models import Job

TIMEOUT = 30


def parse(payload: dict, company: str) -> list[Job]:
    jobs = []
    for j in payload.get("jobs", []):
        loc = (j.get("location") or {}).get("name", "") or ""
        jobs.append(Job(
            ats="greenhouse", native_id=str(j["id"]), company=company,
            title=j.get("title", ""), location=loc,
            url=j.get("absolute_url", ""), posted=j.get("updated_at", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false"
    resp = session.get(url, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return parse(resp.json(), company)
