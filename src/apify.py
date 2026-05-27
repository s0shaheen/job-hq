from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 120


def parse(items: list, company: str) -> list[Job]:
    jobs = []
    for it in items:
        nid = str(it.get("id") or it.get("url", ""))
        jobs.append(Job(
            ats="apify", native_id=nid, company=company,
            title=it.get("title", ""), location=it.get("location", "") or "",
            url=it.get("url", "") or "", posted=it.get("postedAt", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, token: str) -> list[Job]:
    """slug = '<actor_id>:<careers_url>'. Runs the actor synchronously and returns items."""
    actor_id, _, careers_url = slug.partition(":")
    url = (f"https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items"
           f"?token={token}")
    resp = session.post(url, json={"startUrls": [{"url": careers_url}]}, timeout=TIMEOUT)
    resp.raise_for_status()
    return parse(resp.json(), company)
