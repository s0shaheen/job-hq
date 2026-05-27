from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30


def parse(payload: list, company: str) -> list[Job]:
    jobs = []
    for j in payload:
        loc = (j.get("categories") or {}).get("location", "") or ""
        jobs.append(Job(
            ats="lever", native_id=str(j["id"]), company=company,
            title=j.get("text", ""), location=loc,
            url=j.get("hostedUrl", "") or "", posted=str(j.get("createdAt", "")),
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    resp = session.get(url, timeout=TIMEOUT)
    resp.raise_for_status()
    return parse(resp.json(), company)
