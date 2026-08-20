"""Goldman Sachs (higher.gs.com) — custom GraphQL gateway. ats value:
"goldman"; slug is ignored.

POST https://api-higher.gs.com/gateway/api/v1/graphql with Origin + Referer
headers (required). GetRoles paginates 20/page under RELEVANCE sort; like
Oracle, the keyword match is broad (721 for "product manager") so MAX_PAGES
keeps the relevance head, where every title match lives.

native_id is externalSource.sourceId — the id the detail query keys on
(role(externalSourceId:...)) AND the public /roles/{id} page accepts
(higher.gs.com/roles/168945 → 200, verified 2026-07-13). roleId carries a
"_GS_MID_CAREER"-style suffix; its digit prefix is the same number.

NOTE core/jobkeys.py has no goldman pattern yet, so job_key(url) falls back to
a url-… key instead of "goldman-{id}". Suggested one-liner for jobkeys:
    ("goldman", re.compile(r"higher\\.gs\\.com/roles/(\\d+)")),
"""
from __future__ import annotations
import re
import time

import requests

from core.useragent import USER_AGENT
from monitor.models import Job

TIMEOUT = 30
PAGE = 20
MAX_PAGES = 15     # relevance head: 300 roles
SLEEP = 0.4
ENDPOINT = "https://api-higher.gs.com/gateway/api/v1/graphql"
HEADERS = {"Origin": "https://higher.gs.com", "Referer": "https://higher.gs.com/",
           "User-Agent": USER_AGENT}

_QUERY = ("query GetRoles($searchQueryInput: RoleSearchQueryInput!) { "
          "roleSearch(searchQueryInput: $searchQueryInput) { totalCount items { "
          "roleId jobTitle division locations { city country } "
          "externalSource { sourceId } } } }")


def _body(search: str, page_number: int) -> dict:
    return {
        "operationName": "GetRoles",
        "variables": {"searchQueryInput": {
            "page": {"pageSize": PAGE, "pageNumber": page_number},
            "sort": {"sortStrategy": "RELEVANCE", "sortOrder": "DESC"},
            "filters": [], "experiences": ["EARLY_CAREER", "PROFESSIONAL"],
            "searchTerm": search,
        }},
        "query": _QUERY,
    }


def _native_id(item: dict) -> str:
    sid = str((item.get("externalSource") or {}).get("sourceId") or "")
    if sid:
        return sid
    m = re.match(r"(\d+)", str(item.get("roleId") or ""))
    return m.group(1) if m else str(item.get("roleId") or "")


def _location(item: dict) -> str:
    locs = item.get("locations") or []
    parts = [", ".join(x for x in (l.get("city"), l.get("country")) if x)
             for l in locs if isinstance(l, dict)]
    parts = [p for p in parts if p]
    if not parts:
        return ""
    loc = parts[0]
    if len(parts) > 1:
        loc += f" (+{len(parts) - 1} more)"
    return loc


def parse(payload: dict, company: str) -> list[Job]:
    rs = ((payload.get("data") or {}).get("roleSearch") or {})
    jobs = []
    for item in rs.get("items") or []:
        nid = _native_id(item)
        jobs.append(Job(
            ats="goldman", native_id=nid, company=company,
            title=item.get("jobTitle", "") or "", location=_location(item),
            url=f"https://higher.gs.com/roles/{nid}",
            posted="",     # not exposed by GetRoles
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    out: list[Job] = []
    for page in range(MAX_PAGES):
        resp = session.post(ENDPOINT, json=_body(search, page), timeout=TIMEOUT,
                            headers=HEADERS)
        resp.raise_for_status()
        payload = resp.json()
        page_jobs = parse(payload, company)
        out.extend(page_jobs)
        total = int(((payload.get("data") or {}).get("roleSearch") or {}).get("totalCount") or 0)
        if not page_jobs or len(out) >= total:
            break
        time.sleep(SLEEP)
    return out
