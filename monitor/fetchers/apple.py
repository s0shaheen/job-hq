"""Apple (jobs.apple.com) — SSR search HTML for lists; CSRF-guarded JSON API
for details (see jobcontent). ats value: "apple"; slug is ignored.

List: GET /en-us/search?search=...&sort=relevance&page=N and parse the
server-rendered cards. sort=relevance is load-bearing: Apple's full-text match
for "product manager" spans ~6K jobs date-sorted by default, but relevance
puts every title match first, so a page cap keeps all roles the title filter
would keep. The POST /api/v1/search body schema is undocumented — HTML parsing
is the stable path.

Card anatomy (live-verified 2026-07-13 — the earlier PIPE-/row-number id
scheme is GONE; every id now ends in a constant row token, so fields are
joined by DOCUMENT ORDER, one segment per first-seen title anchor):
  <h3><a ... href="/en-us/details/{reqDigits}-{variant}/{slug}?team=X">Title</a></h3>
  <span class="job-posted-date" id="search-job-posted-date-1">Jul 08, 2026</span>
  <div id="search-location-search-job-title-{reqDigits}-{variant}-1">
    <span class="a11y">Location</span>
    <span id="search-store-name-container-1">Cupertino</span></div>

native_id is the requisition digits WITHOUT the -variant suffix: it equals the
detail API's reqId (REQ-{digits}), /api/v1/jobDetails accepts it, the
digits-only public URL resolves, and it is what core.jobkeys extracts — so
posting variants of one requisition converge on one key.
"""
from __future__ import annotations
import html as _html
import re
import time
from urllib.parse import quote

import requests

from core.useragent import USER_AGENT
from monitor.models import Job

TIMEOUT = 30
PAGE = 20
MAX_PAGES = 25
SLEEP = 0.4

_LINK_RE = re.compile(r'href="/en-us/details/(\d{6,})(?:-\d+)?/([^"/?]+)[^"]*"[^>]*>([^<]+)</a>')
_DATE_RE = re.compile(r'class="job-posted-date"[^>]*>([^<]*)<')
_STORE_RE = re.compile(r'id="search-store-name-container-\d+"[^>]*>(.*?)</span>', re.DOTALL)
_LOCDIV_RE = re.compile(r'id="search-location-search-job-title-[^"]*"[^>]*>(.*?)</div>',
                        re.DOTALL)
_A11Y_RE = re.compile(r'<span[^>]*class="a11y"[^>]*>.*?</span>', re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")


def _text(raw: str) -> str:
    return _html.unescape(_TAG_RE.sub(" ", raw)).replace("\xa0", " ").strip()


def _segment_location(seg: str) -> str:
    m = _STORE_RE.search(seg)
    if m:
        return _text(m.group(1))
    m = _LOCDIV_RE.search(seg)          # older markup fallback
    return _text(_A11Y_RE.sub(" ", m.group(1))) if m else ""


def parse(html: str, company: str) -> list[Job]:
    """Cards are segmented at each id's FIRST anchor (the title link); the
    card's trailing 'See full role description' link repeats the id and must
    neither duplicate the job nor end the segment."""
    firsts: list[re.Match] = []
    seen: set[str] = set()
    for m in _LINK_RE.finditer(html):
        if m.group(1) not in seen and _text(m.group(3)):
            seen.add(m.group(1))
            firsts.append(m)
    jobs = []
    for i, m in enumerate(firsts):
        jid, slug, title = m.group(1), m.group(2), _text(m.group(3))
        end = firsts[i + 1].start() if i + 1 < len(firsts) else len(html)
        seg = html[m.end():end]
        date = _DATE_RE.search(seg)
        jobs.append(Job(
            ats="apple", native_id=jid, company=company, title=title,
            location=_segment_location(seg),
            url=f"https://jobs.apple.com/en-us/details/{jid}/{slug}",
            posted=_text(date.group(1)) if date else "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    """Paginate page=1..N until a page adds no new ids ('slug' unused)."""
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"}
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
