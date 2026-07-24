from __future__ import annotations
import re

import requests

from monitor.models import Job

TIMEOUT = 30
PAGE = 100
_UA = "Mozilla/5.0 (compatible; job-hq/1.0)"

# The modern iCIMS careers-home / jibeapply JSON exposes each job's classic iCIMS
# apply_url (careers-<tenant>.icims.com/jobs/<id>). core.jobkeys keys email-captured
# iCIMS postings from that exact pattern, so deriving native_id from it keeps this
# adapter's Job.id aligned with Gmail auto-advance (the status ground truth) — and
# distinguishes jobs that share a slug number across sibling tenants (comed/peco/…).
_APPLY = re.compile(r"careers?[-.]([a-z0-9]+)\.icims\.com/jobs/(\d+)", re.I)


def _native_id(data: dict) -> str:
    m = _APPLY.search(data.get("apply_url") or "")
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return str(data.get("slug") or data.get("req_id") or "")


def _url(data: dict) -> str:
    apply_url = data.get("apply_url") or ""
    return apply_url[: -len("/login")] if apply_url.endswith("/login") else apply_url


def parse(payload: dict, company: str) -> list[Job]:
    jobs = []
    for entry in payload.get("jobs", []):
        d = entry.get("data") or {}
        native = _native_id(d)
        if not native:
            continue
        jobs.append(Job(
            ats="icims", native_id=native, company=company,
            title=d.get("title", "") or "",
            location=(d.get("full_location") or d.get("short_location") or "") or "",
            url=_url(d), posted=d.get("posted_date", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    """slug is the careers host, e.g. "jobs.exeloncorp.com" or "exeloncorp.jibeapply.com"."""
    jobs: list[Job] = []
    page = 1
    while True:
        url = f"https://{slug}/api/jobs?page={page}&limit={PAGE}"
        resp = session.get(url, timeout=TIMEOUT, headers={"User-Agent": _UA})
        resp.raise_for_status()
        payload = resp.json()
        batch = parse(payload, company)
        jobs.extend(batch)
        total = int(payload.get("totalCount") or 0)
        if not batch or page * PAGE >= total:
            break
        page += 1
    return jobs
