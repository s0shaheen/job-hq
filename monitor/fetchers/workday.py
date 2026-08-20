from __future__ import annotations
import re
import requests

from core.useragent import USER_AGENT
from monitor.models import Job

TIMEOUT = 30
PAGE = 20

# Requisition token, mirroring core/jobkeys.py's workday pattern so Job.id ==
# job_key(url) (parity). Variant suffixes (-1) collapse to the base req.
_REQ = re.compile(r"[_/-](JR[-_]?\d+|R-?\d{4,}|REQ[-_]?\d{3,}|REF\d{4,}[A-Z]?)(?:-\d+)?(?:$|[/?#])", re.I)
_REQ_BARE = re.compile(r"(JR[-_]?\d+|R-?\d{4,}|REQ[-_]?\d{3,}|REF\d{4,}[A-Z]?)(?:-\d+)?$", re.I)


def _native_id(j: dict) -> str:
    """bulletFields[0] is the req id on most tenants — but some put a LOCATION
    there, which collides distinct jobs onto one key. Prefer the requisition
    token from externalPath; accept a req-shaped bullet; else the path itself
    (unique and stable per posting, never a collision)."""
    path = j.get("externalPath", "") or ""
    m = _REQ.search(path)
    if m:
        return m.group(1)
    b0 = str((j.get("bulletFields") or [""])[0] or "")
    m = _REQ_BARE.fullmatch(b0.strip())
    if m:
        return m.group(1)
    return path or b0


def _split_slug(slug: str) -> tuple[str, str, str]:
    host, site = slug.split("/", 1)
    tenant = host.split(".", 1)[0]
    return host, tenant, site


def parse(payload: dict, company: str, slug: str) -> list[Job]:
    host, _, site = _split_slug(slug)
    jobs = []
    for j in payload.get("jobPostings", []):
        native_id = _native_id(j)
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
        resp = session.post(endpoint, json=body, timeout=TIMEOUT,
                            headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
        payload = resp.json()
        page_jobs = parse(payload, company, slug)
        out.extend(page_jobs)
        total = payload.get("total", len(out))
        offset += PAGE
        if offset >= total or not page_jobs:
            break
    return out
