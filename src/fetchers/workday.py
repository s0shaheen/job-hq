from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30
PAGE = 20


def _split_slug(slug: str) -> tuple[str, str, str]:
    host, site = slug.split("/", 1)
    tenant = host.split(".", 1)[0]
    return host, tenant, site


def parse(payload: dict, company: str, slug: str) -> list[Job]:
    host, _, site = _split_slug(slug)
    jobs = []
    for j in payload.get("jobPostings", []):
        bullets = j.get("bulletFields") or [""]
        native_id = bullets[0] or j.get("externalPath", "")
        path = j.get("externalPath", "")
        jobs.append(Job(
            ats="workday", native_id=str(native_id), company=company,
            title=j.get("title", ""), location=j.get("locationsText", "") or "",
            url=f"https://{host}/en-US/{site}{path}",
            posted=j.get("postedOn", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    host, tenant, site = _split_slug(slug)
    endpoint = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    out: list[Job] = []
    offset = 0
    while True:
        body = {"appliedFacets": {}, "limit": PAGE, "offset": offset, "searchText": search}
        resp = session.post(endpoint, json=body, timeout=TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
        page_jobs = parse(payload, company, slug)
        out.extend(page_jobs)
        total = payload.get("total", len(out))
        offset += PAGE
        if offset >= total or not page_jobs:
            break
    return out
