from __future__ import annotations
import html as _html
import re
from urllib.parse import quote

import requests

from monitor.models import Job

TIMEOUT = 30
PAGE = 25            # Career Site Builder returns 25 tiles per page
MAX_PAGES = 40       # safety cap (~1000 postings) — real termination is "no new ids"
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# <a ... class="jobTitle-link" ...>TITLE</a> — attribute order varies (mobile vs desktop tile).
_LINK = re.compile(r'<a\b([^>]*\bclass="jobTitle-link"[^>]*)>(.*?)</a>', re.S)
_HREF = re.compile(r'href="(/job/[^"]*?/(\d{9,})/)"')
_LOC = re.compile(r'class="jobLocation[^"]*"[^>]*>(.*?)</span>', re.S)
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
_MORE = re.compile(r"\s*\+\s*\d+\s*more.*$", re.S)


def _text(s: str) -> str:
    return _WS.sub(" ", _html.unescape(_TAG.sub("", s or ""))).strip()


def _clean_loc(s: str) -> str:
    return _MORE.sub("", _text(s)).strip(" ,")


def parse(html_text: str, company: str, host: str) -> list[Job]:
    jobs: list[Job] = []
    seen: set[str] = set()
    for m in _LINK.finditer(html_text):
        h = _HREF.search(m.group(1))
        if not h:
            continue
        native = h.group(2)
        if native in seen:
            continue
        seen.add(native)
        loc_m = _LOC.search(html_text, m.end(), m.end() + 800)
        jobs.append(Job(
            ats="sfsf", native_id=native, company=company,
            title=_text(m.group(2)),
            location=_clean_loc(loc_m.group(1)) if loc_m else "",
            url=f"https://{host}{h.group(1)}", posted="",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    """slug is the CSB careers host, e.g. "jobs.grainger.com". search hits the server-side filter."""
    host = slug
    headers = {"User-Agent": _UA, "Accept": "text/html,application/xhtml+xml"}
    jobs: list[Job] = []
    seen: set[str] = set()
    startrow = 0
    for _ in range(MAX_PAGES):
        url = f"https://{host}/search/?q={quote(search)}&startrow={startrow}"
        resp = session.get(url, timeout=TIMEOUT, headers=headers)
        resp.raise_for_status()
        fresh = [j for j in parse(resp.text, company, host) if j.native_id not in seen]
        if not fresh:
            break
        for j in fresh:
            seen.add(j.native_id)
        jobs.extend(fresh)
        startrow += PAGE
    return jobs
