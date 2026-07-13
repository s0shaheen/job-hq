"""Apple (jobs.apple.com) — SSR search HTML for lists; CSRF-guarded JSON API
for details (see jobcontent). ats value: "apple"; slug is ignored.

List: GET /en-us/search?search=...&sort=relevance&page=N and parse the
server-rendered cards. sort=relevance is load-bearing: Apple's full-text match
for "product manager" spans ~6K jobs date-sorted by default, but relevance
puts every title match first (verified 20/20 on page 1, 2026-07-13), so a page
cap keeps all roles the title filter would keep. The POST /api/v1/search body
schema is undocumented — HTML parsing is the stable path.

Card anatomy (element ids carry both the job id and the row number):
  <a ... href="/en-us/details/{id}/{slug}?team=X">Title</a>
  <div id="search-location-search-job-title-PIPE-{id}-{row}" ...>Location</div>
  <span class="job-posted-date" id="search-job-posted-date-{row}">Jul 13, 2026</span>
"""
from __future__ import annotations
import html as _html
import re
import time
from urllib.parse import quote

import requests

from monitor.models import Job

TIMEOUT = 30
PAGE = 20
MAX_PAGES = 25
SLEEP = 0.4
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_LINK_RE = re.compile(r'href="/en-us/details/(\d{6,})/([^"/?]+)[^"]*"[^>]*>([^<]+)</a>')
_LOC_RE = re.compile(r'id="search-location-search-job-title-PIPE-(\d+)-(\d+)"[^>]*>(.*?)</div>',
                     re.DOTALL)
_DATE_RE = re.compile(r'id="search-job-posted-date-(\d+)"[^>]*>([^<]*)<')
_TAG_RE = re.compile(r"<[^>]+>")


def _text(raw: str) -> str:
    return _html.unescape(_TAG_RE.sub(" ", raw)).replace("\xa0", " ").strip()


def parse(html: str, company: str) -> list[Job]:
    titles: dict[str, tuple[str, str]] = {}   # id -> (slug, title), first link wins
    order: list[str] = []
    for jid, slug, text in _LINK_RE.findall(html):
        t = _text(text)
        if jid not in titles and t:
            titles[jid] = (slug, t)
            order.append(jid)
    locs: dict[str, str] = {}
    rows: dict[str, str] = {}                 # id -> row number, for the date join
    for jid, row, inner in _LOC_RE.findall(html):
        locs.setdefault(jid, _text(inner))
        rows.setdefault(jid, row)
    dates = {row: _text(v) for row, v in _DATE_RE.findall(html)}
    jobs = []
    for jid in order:
        slug, title = titles[jid]
        jobs.append(Job(
            ats="apple", native_id=jid, company=company, title=title,
            location=locs.get(jid, ""),
            url=f"https://jobs.apple.com/en-us/details/{jid}/{slug}",
            posted=dates.get(rows.get(jid, ""), ""),
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    """Paginate page=1..N until a page adds no new ids ('slug' unused)."""
    headers = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    out: list[Job] = []
    seen: set[str] = set()
    for page in range(1, MAX_PAGES + 1):
        url = (f"https://jobs.apple.com/en-us/search?search={quote(search)}"
               f"&sort=relevance&page={page}")
        resp = session.get(url, timeout=TIMEOUT, headers=headers)
        resp.raise_for_status()
        page_jobs = [j for j in parse(resp.text, company) if j.native_id not in seen]
        if not page_jobs:
            break
        seen.update(j.native_id for j in page_jobs)
        out.extend(page_jobs)
        if len(page_jobs) < PAGE:
            break
        time.sleep(SLEEP)
    return out
