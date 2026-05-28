from __future__ import annotations
import html
import re
from urllib.parse import urlparse

import requests

TIMEOUT = 30
MAX_CHARS = 12000          # truncate before sending to the LLM
_WORKDAY_LOCALE = "/en-US/"

_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)


def html_to_text(raw: str) -> str:
    """Turn ATS HTML (sometimes double-escaped) into clean plain text."""
    if not raw:
        return ""
    text = html.unescape(raw)                  # &lt;p&gt; -> <p>
    text = _SCRIPT_STYLE_RE.sub(" ", text)     # drop <script>/<style> bodies, not just tags
    text = _TAG_RE.sub(" ", text)              # strip remaining tags
    text = html.unescape(text)                 # decode any remaining entities (&amp; -> &)
    text = text.replace("\xa0", " ")           # treat non-breaking spaces as spaces
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _clip(text: str) -> str:
    return text[:MAX_CHARS]


# --- pure per-ATS extractors (unit-tested) ---

def _greenhouse_text(payload: dict) -> str:
    return html_to_text(payload.get("content", "") or "")


def _ashby_text(payload: dict, native_id: str) -> str:
    for j in payload.get("jobs", []) or []:
        if str(j.get("id")) == str(native_id):
            return html_to_text(j.get("descriptionPlain") or j.get("descriptionHtml", "") or "")
    return ""


def _lever_text(payload: dict) -> str:
    parts = [payload.get("descriptionPlain", "") or ""]
    for lst in payload.get("lists", []) or []:
        parts.append(lst.get("text", "") or "")
        parts.append(html_to_text(lst.get("content", "") or ""))
    parts.append(payload.get("additionalPlain", "") or "")
    # outer html_to_text strips the lists' HTML; the *Plain fields are already plain and pass through unchanged
    return html_to_text("\n".join(p for p in parts if p))


def _smartrec_text(payload: dict) -> str:
    sections = ((payload.get("jobAd") or {}).get("sections") or {})
    order = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
    parts = [(sections.get(k) or {}).get("text", "") or "" for k in order]
    return html_to_text("\n".join(p for p in parts if p))


def _workday_text(payload: dict) -> str:
    info = payload.get("jobPostingInfo") or {}
    return html_to_text(info.get("jobDescription", "") or "")


def _workday_detail_url(url: str) -> str:
    """Reconstruct the CXS detail endpoint from a stored Workday job URL.
    https://{host}/en-US/{site}{externalPath} -> https://{host}/wday/cxs/{tenant}/{site}{externalPath}
    """
    p = urlparse(url)
    if not p.netloc or _WORKDAY_LOCALE not in p.path:
        return ""
    host = p.netloc
    tenant = host.split(".")[0]
    after = p.path.split(_WORKDAY_LOCALE, 1)[1]   # "{site}{externalPath}"
    site, sep, tail = after.partition("/")
    if not sep or not tail:
        return ""
    return f"https://{host}/wday/cxs/{tenant}/{site}/{tail}"


# --- HTTP entrypoint (routing; not unit-tested, mirrors fetchers' get_jobs) ---

def fetch_description(ats: str, native_id: str, slug: str, url: str,
                      session: requests.Session | None) -> str:
    """Return clean JD text, or "" when no zero-secret source exists.
    May raise on transient HTTP errors — the caller quarantines per-job failures.
    """
    if ats in ("greenhouse", "ashby", "lever", "smartrec") and not slug:
        return ""   # no board slug (e.g. a paused/unknown company) → can't build a detail URL
    if ats == "greenhouse":
        r = session.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{native_id}",
                        timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_greenhouse_text(r.json()))
    if ats == "ashby":
        r = session.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
                        f"?includeCompensation=true", timeout=TIMEOUT)  # includeCompensation=true (more than the listing fetch) so comp lands in the JD text
        r.raise_for_status()
        return _clip(_ashby_text(r.json(), native_id))
    if ats == "lever":
        r = session.get(f"https://api.lever.co/v0/postings/{slug}/{native_id}?mode=json",
                        timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_lever_text(r.json()))
    if ats == "smartrec":
        r = session.get(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{native_id}",
                        timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_smartrec_text(r.json()))
    if ats == "workday":
        detail = _workday_detail_url(url)
        if not detail:
            return ""
        r = session.get(detail, headers={"Accept": "application/json"}, timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_workday_text(r.json()))
    # amazon (JS SPA, no JD in HTML) and any unknown ATS: no zero-secret source.
    return ""
