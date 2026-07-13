"""Eightfold (SmartApply + PCSX variants) — slug is "host|domain", e.g.
"apply.careers.microsoft.com|microsoft.com", "explore.jobs.netflix.net|netflix.com",
"paypal.eightfold.ai|paypal.com". ats value: "eightfold".

Try SmartApply (/api/apply/v2/jobs) first; a PCSX-only tenant answers 403
{"message": "Not authorized for PCSX"} — then switch to /api/pcsx/search for
the rest of the run. Verified 2026-07-13: Netflix = SmartApply, Microsoft +
PayPal = PCSX. Both variants hard-cap at 10 jobs/page (num=50 still returns 10).

URL parity contract: job_key(url) must equal "eightfold-{position id}", but
tenants disagree on link shape (Microsoft's positionUrl "/careers/job/{id}"
is NOT key-able on its custom domain; its "?pid={id}" deep link is). So each
job picks the first candidate URL that round-trips through core.jobkeys. A new
custom-domain tenant needs a jobkeys pattern before its keys converge.

Microsoft rate-limits bursts (observed 429) — SLEEP paces page fetches.
"""
from __future__ import annotations
import time
from datetime import datetime, timezone
from urllib.parse import quote

import requests

from core import jobkeys
from monitor.models import Job

TIMEOUT = 30
PAGE = 10          # server-enforced on both variants
MAX_PAGES = 60     # runaway guard; largest verified tenant (Microsoft) has ~330 PM hits
SLEEP = 0.4        # ≤1 req/s/host politeness
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
_PCSX_DENIAL = "Not authorized for PCSX"


def _split_slug(slug: str) -> tuple[str, str]:
    host, domain = slug.split("|", 1)
    return host, domain


def _ts_to_date(ts) -> str:
    try:
        ts = float(ts)
        if ts > 1e12:      # milliseconds
            ts /= 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def _location(p: dict) -> str:
    loc = p.get("location") or ""
    if not loc:
        locs = p.get("locations") or []
        loc = str(locs[0]) if locs else ""
        if len(locs) > 1:
            loc += f" (+{len(locs) - 1} more)"
    return loc


def posting_url(host: str, domain: str, pid: str, api_url: str = "") -> str:
    """First candidate URL whose job_key round-trips to eightfold-{pid}."""
    expected = f"eightfold-{pid}"
    cands = []
    if api_url:
        cands.append(api_url if api_url.startswith("http") else f"https://{host}{api_url}")
    cands.append(f"https://{host}/careers/job/{pid}")
    cands.append(f"https://{host}/careers?pid={pid}&domain={domain}")
    for u in cands:
        if jobkeys.job_key(u) == expected:
            return u
    return cands[-1]   # keyless tenant: still a working link; parity test will flag it


def parse_smartapply(payload: dict, company: str, host: str, domain: str) -> list[Job]:
    jobs = []
    for p in payload.get("positions") or []:
        pid = str(p.get("id", ""))
        jobs.append(Job(
            ats="eightfold", native_id=pid, company=company,
            title=p.get("name", "") or "", location=_location(p),
            url=posting_url(host, domain, pid, p.get("canonicalPositionUrl") or ""),
            posted=_ts_to_date(p.get("t_create") or p.get("t_update")),
        ))
    return jobs


def parse_pcsx(payload: dict, company: str, host: str, domain: str) -> list[Job]:
    data = payload.get("data") or {}
    jobs = []
    for p in data.get("positions") or []:
        pid = str(p.get("id", ""))
        jobs.append(Job(
            ats="eightfold", native_id=pid, company=company,
            title=p.get("name", "") or "", location=_location(p),
            url=posting_url(host, domain, pid, p.get("positionUrl") or ""),
            posted=_ts_to_date(p.get("postedTs") or p.get("creationTs")),
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    host, domain = _split_slug(slug)
    headers = {"User-Agent": UA, "Accept": "application/json"}
    out: list[Job] = []
    start, total, pages = 0, None, 0
    mode = "smartapply"
    while pages < MAX_PAGES:
        if mode == "smartapply":
            url = (f"https://{host}/api/apply/v2/jobs?domain={quote(domain)}"
                   f"&query={quote(search)}&start={start}&num={PAGE}")
            resp = session.get(url, timeout=TIMEOUT, headers=headers)
            if resp.status_code == 403 and _PCSX_DENIAL in resp.text and start == 0:
                mode = "pcsx"      # PCSX-only tenant; re-fetch page 0 the other way
                continue
            resp.raise_for_status()
            payload = resp.json()
            total = int(payload.get("count") or 0)
            page_jobs = parse_smartapply(payload, company, host, domain)
        else:
            url = (f"https://{host}/api/pcsx/search?domain={quote(domain)}"
                   f"&query={quote(search)}&location=&start={start}")
            resp = session.get(url, timeout=TIMEOUT, headers=headers)
            resp.raise_for_status()
            payload = resp.json()
            total = int((payload.get("data") or {}).get("count") or 0)
            page_jobs = parse_pcsx(payload, company, host, domain)
        out.extend(page_jobs)
        start += len(page_jobs)
        pages += 1
        if not page_jobs or start >= total:
            break
        time.sleep(SLEEP)
    return out
