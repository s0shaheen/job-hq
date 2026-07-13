"""Google Careers — server-rendered pages; the old /api/v3/search is dead
(404). ats value: "google"; slug is ignored (one global board).

The search page embeds results as AF_initDataCallback JSON blobs. ds:1
data[0] is the results list (20/page); each entry is a 21-field array
(indices verified 2026-07-13):
  [0] id  [1] title  [3] [_, responsibilities html]  [4] [_, qualifications
  html]  [9] locations [[display, ...], ...]  [10] [_, description html]
  [12] [posted epoch, ns]
The blob regex + indices are scrape-shaped — the smoke script is the canary.

List entries carry the COMPLETE JD, so parse() also fills DESCRIPTIONS and
review-tagging reads Google JDs with zero extra requests (same trick as
amazon search.json). On a job's own page the same entry sits in ds:0 as
data[0] — find_entry() handles both wrappings for jobcontent's fallback.
"""
from __future__ import annotations
import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import quote

import requests

from monitor.models import Job

TIMEOUT = 30
PAGE = 20
MAX_PAGES = 25     # 500 postings; PM queries run ~150-300
SLEEP = 0.4
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
BASE = "https://www.google.com/about/careers/applications/jobs/results"

# native_id -> combined JD html, filled at list-parse time (process-lifetime cache).
DESCRIPTIONS: dict[str, str] = {}


def af_data(html: str, key: str) -> list | None:
    """The data: payload of one AF_initDataCallback block ('ds:0' / 'ds:1')."""
    m = re.search(rf"AF_initDataCallback\(\{{key: '{key}'.*?data:(.*?), sideChannel",
                  html, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


def find_entry(data: list | None, job_id: str) -> list | None:
    """Locate a job entry by id: ds:0 wraps the entry itself as data[0]; ds:1
    wraps the results list at data[0]."""
    if not isinstance(data, list) or not data:
        return None
    cand = data[0]
    if not isinstance(cand, list) or not cand:
        return None
    if str(cand[0]) == str(job_id) and len(cand) >= 11:
        return cand
    for e in cand:
        if isinstance(e, list) and e and str(e[0]) == str(job_id):
            return e
    return None


def _cell_html(entry: list, idx: int) -> str:
    v = entry[idx] if len(entry) > idx else None
    if isinstance(v, list) and len(v) > 1 and isinstance(v[1], str):
        return v[1]
    return ""


def entry_jd_html(entry: list) -> str:
    """Description + qualifications + responsibilities, still as html."""
    parts = [_cell_html(entry, 10), _cell_html(entry, 4)]
    resp = _cell_html(entry, 3)
    if resp:
        parts.append("<h3>Responsibilities:</h3>" + resp)
    return "\n".join(p for p in parts if p)


def _entry_location(entry: list) -> str:
    locs = entry[9] if len(entry) > 9 and isinstance(entry[9], list) else []
    displays = [l[0] for l in locs if isinstance(l, list) and l and isinstance(l[0], str)]
    if not displays:
        return ""
    loc = displays[0]
    if len(displays) > 1:
        loc += f" (+{len(displays) - 1} more)"
    return loc


def _entry_posted(entry: list) -> str:
    v = entry[12] if len(entry) > 12 else None
    try:
        ts = float(v[0]) if isinstance(v, list) and v else float(v)
        return datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
    except (TypeError, ValueError, IndexError, OSError, OverflowError):
        return ""


def parse(html: str, company: str) -> list[Job]:
    data = af_data(html, "ds:1")
    entries = data[0] if isinstance(data, list) and data and isinstance(data[0], list) else []
    jobs = []
    for e in entries:
        if not (isinstance(e, list) and e and isinstance(e[0], (str, int))):
            continue
        jid = str(e[0])
        if not jid.isdigit():
            continue
        jd = entry_jd_html(e)
        if jd:
            DESCRIPTIONS[jid] = jd
        jobs.append(Job(
            ats="google", native_id=jid, company=company,
            title=str(e[1]) if len(e) > 1 and e[1] else "",
            location=_entry_location(e),
            url=f"{BASE}/{jid}",
            posted=_entry_posted(e),
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    """Paginate ?q=&page=1..N until a page adds no new ids ('slug' unused)."""
    headers = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    out: list[Job] = []
    seen: set[str] = set()
    for page in range(1, MAX_PAGES + 1):
        url = f"{BASE}/?q={quote(search)}&page={page}"
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
