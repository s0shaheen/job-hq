"""Radancy career sites — slug is the site host (e.g. "jobs.intuit.com").
ats value: "radancy".

GET /search-jobs/results returns {"results": "<html>", "hasJobs": ...}. The
SearchResultsModuleName param is load-bearing: without it the endpoint answers
200 with an EMPTY results string (verified 2026-07-13). Cards inside the html:
  <a href="/job/{city}/{title-slug}/{siteId}/{jobId}">
    <h2>Title</h2> ... <span class="job-location">Location</span>
The section tag carries data-total-pages for pagination.

NOTE core/jobkeys.py has no radancy pattern yet, so job_key(url) falls back to
a url-… key instead of "radancy-{id}". Suggested line for jobkeys (scoped to
known radancy hosts to avoid false positives on arbitrary /job/ paths):
    ("radancy", re.compile(r"(?:jobs\\.intuit\\.com)/job/(?:[^/]+/)+(\\d{6,})(?:[/?#]|$)")),
"""
from __future__ import annotations
import html as _html
import re
import time
from urllib.parse import quote_plus

import requests

from monitor.models import Job

TIMEOUT = 30
PAGE = 15          # RecordsPerPage — the sites' own default
MAX_PAGES = 40
SLEEP = 0.4
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_LINK_RE = re.compile(r'<a[^>]*href="(/job/[^"]+)"[^>]*>(.*?)</a>', re.DOTALL)
_ID_RE = re.compile(r"/(\d{6,})/?$")
_H2_RE = re.compile(r"<h2[^>]*>(.*?)</h2>", re.DOTALL)
_LOC_RE = re.compile(r'class="job-location"[^>]*>([^<]*)<')
_PAGES_RE = re.compile(r'data-total-pages="(\d+)"')
_TAG_RE = re.compile(r"<[^>]+>")


def _text(raw: str) -> str:
    return _html.unescape(_TAG_RE.sub(" ", raw)).replace("\xa0", " ").strip()


def _list_url(host: str, search: str, page: int) -> str:
    return (f"https://{host}/search-jobs/results?ActiveFacetID=0&CurrentPage={page}"
            f"&RecordsPerPage={PAGE}&Keywords={quote_plus(search)}&SearchType=5"
            f"&SortCriteria=0&SortDirection=1"
            f"&SearchResultsModuleName={quote_plus('Search Results')}"
            f"&SearchFiltersModuleName={quote_plus('Search Filters')}")


def parse(results_html: str, company: str, host: str) -> list[Job]:
    jobs, seen = [], set()
    for href, inner in _LINK_RE.findall(results_html):
        m = _ID_RE.search(href)
        if not m:
            continue
        jid = m.group(1)
        if jid in seen:
            continue
        seen.add(jid)
        h2 = _H2_RE.search(inner)
        loc = _LOC_RE.search(inner)
        jobs.append(Job(
            ats="radancy", native_id=jid, company=company,
            title=_text(h2.group(1)) if h2 else "",
            location=_text(loc.group(1)) if loc else "",
            url=f"https://{host}{href}",
            posted="",     # not shown on cards
        ))
    return jobs


def total_pages(results_html: str) -> int:
    m = _PAGES_RE.search(results_html)
    return int(m.group(1)) if m else 1


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    host = slug
    headers = {"User-Agent": UA, "X-Requested-With": "XMLHttpRequest"}
    out: list[Job] = []
    seen: set[str] = set()
    pages = MAX_PAGES
    for page in range(1, MAX_PAGES + 1):
        resp = session.get(_list_url(host, search, page), timeout=TIMEOUT, headers=headers)
        resp.raise_for_status()
        results = (resp.json() or {}).get("results") or ""
        page_jobs = [j for j in parse(results, company, host) if j.native_id not in seen]
        if not page_jobs:
            break
        seen.update(j.native_id for j in page_jobs)
        out.extend(page_jobs)
        if page == 1:
            pages = min(total_pages(results), MAX_PAGES)
        if page >= pages:
            break
        time.sleep(SLEEP)
    return out
