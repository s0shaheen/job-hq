from __future__ import annotations
import html
import json
import re
from urllib.parse import quote, urlparse

import requests

TIMEOUT = 30
MAX_CHARS = 12000          # truncate before sending to the LLM
_WORKDAY_LOCALE = "/en-US/"
# Big-tech ATSes reject the default python-requests UA; present a browser-like one.
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
_JSON_HEADERS = {"User-Agent": _UA, "Accept": "application/json"}

_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_JSONLD_RE = re.compile(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
                        re.DOTALL | re.IGNORECASE)


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


def _eightfold_text(payload: dict) -> str:
    """SmartApply detail ({job_description}) or PCSX ({data:{jobDescription}})."""
    data = payload.get("data") or {}
    return html_to_text(payload.get("job_description") or data.get("jobDescription") or "")


def _oraclehcm_text(payload: dict) -> str:
    """recruitingCEJobRequisitionDetails: items[0] carries the three JD strings
    (shape live-verified 2026-07-13 on Oracle CX_45001)."""
    item = (payload.get("items") or [{}])[0]
    parts = [item.get(k, "") or "" for k in
             ("ExternalDescriptionStr", "ExternalResponsibilitiesStr",
              "ExternalQualificationsStr")]
    return html_to_text("\n".join(p for p in parts if p))


def _apple_text(payload: dict) -> str:
    """jobDetails wraps everything in res.* (live-verified 2026-07-13)."""
    res = payload.get("res") or {}
    parts = [res.get(k, "") or "" for k in
             ("jobSummary", "description", "minimumQualifications",
              "preferredQualifications")]
    return html_to_text("\n".join(p for p in parts if p))


def _goldman_text(payload: dict) -> str:
    role = (payload.get("data") or {}).get("role") or {}
    return html_to_text(role.get("descriptionHtml", "") or "")


def _radancy_jsonld_text(page_html: str) -> str:
    """Radancy job pages embed a JSON-LD JobPosting with the full description."""
    for m in _JSONLD_RE.finditer(page_html):
        try:
            doc = json.loads(m.group(1).strip())
        except ValueError:
            continue
        for obj in doc if isinstance(doc, list) else [doc]:
            if isinstance(obj, dict) and obj.get("@type") == "JobPosting":
                return html_to_text(obj.get("description", "") or "")
    return ""


def _google_page_text(page_html: str, native_id: str) -> str:
    """A job's own page carries its list entry in an AF blob (ds:0 or ds:1);
    reuse the fetcher's parser so list and detail can never drift apart."""
    from monitor.fetchers import google as google_fetcher
    for key in ("ds:1", "ds:0"):
        entry = google_fetcher.find_entry(google_fetcher.af_data(page_html, key), native_id)
        if entry:
            return html_to_text(google_fetcher.entry_jd_html(entry))
    return ""


def _apple_csrf(session: requests.Session) -> str:
    """One handshake per session: GET /csrfToken, token arrives as a response
    header while the paired cookies land in the session jar."""
    tok = getattr(session, "_apple_csrf", "")
    if not tok:
        r = session.get("https://jobs.apple.com/api/v1/csrfToken",
                        headers={"User-Agent": _UA}, timeout=TIMEOUT)
        r.raise_for_status()
        tok = r.headers.get("x-apple-csrf-token", "")
        session._apple_csrf = tok
    return tok


# --- HTTP entrypoint (routing; stub-session tested, mirrors fetchers' get_jobs) ---

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
    if ats == "amazon":
        # search.json embeds full JDs, so the list fetch pre-fills the cache
        # (per-job endpoints are retired, HTTP 406). Cold cache — review.py in
        # a fresh process — warms via ONE by-id search (live-verified: hits=1).
        from monitor.fetchers import amazon as amazon_fetcher
        jd = amazon_fetcher.DESCRIPTIONS.get(native_id)
        if jd is None and session is not None:
            r = session.get(f"https://www.amazon.jobs/en/search.json"
                            f"?base_query={quote(native_id)}&result_limit=10&offset=0",
                            headers={"User-Agent": _UA}, timeout=TIMEOUT)
            r.raise_for_status()
            amazon_fetcher.parse(r.json(), "")   # side effect: fills DESCRIPTIONS
            jd = amazon_fetcher.DESCRIPTIONS.get(native_id)
        return _clip(html_to_text(jd or ""))
    if ats == "google":
        # list entries carry the whole JD too; cold cache falls back to the
        # job's own page (same AF blob, parsed by the fetcher's helpers).
        from monitor.fetchers import google as google_fetcher
        jd = google_fetcher.DESCRIPTIONS.get(native_id)
        if jd is not None:
            return _clip(html_to_text(jd))
        if not url or session is None:
            return ""
        r = session.get(url, headers={"User-Agent": _UA}, timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_google_page_text(r.text, native_id))
    if ats == "eightfold":
        if "|" not in (slug or ""):
            return ""   # slug is "host|domain"; without it no tenant to ask
        host, domain = slug.split("|", 1)
        r = session.get(f"https://{host}/api/apply/v2/jobs/{native_id}"
                        f"?domain={quote(domain)}", headers=_JSON_HEADERS, timeout=TIMEOUT)
        if r.status_code == 403 and "Not authorized for PCSX" in r.text:
            r = session.get(f"https://{host}/api/pcsx/position_details"
                            f"?position_id={native_id}&domain={quote(domain)}",
                            headers=_JSON_HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_eightfold_text(r.json()))
    if ats == "oraclehcm":
        if "|" not in (slug or ""):
            return ""   # slug is "host|siteNumber"
        host, site = slug.split("|", 1)
        r = session.get(
            f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
            f"?expand=all&onlyData=true&finder=ById;siteNumber={site},Id=%22{native_id}%22",
            headers=_JSON_HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_oraclehcm_text(r.json()))
    if ats == "apple":
        tok = _apple_csrf(session)
        r = session.get(f"https://jobs.apple.com/api/v1/jobDetails/{native_id}?locale=en-us",
                        headers={"User-Agent": _UA, "X-Apple-CSRF-Token": tok},
                        timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_apple_text(r.json()))
    if ats == "goldman":
        r = session.post(
            "https://api-higher.gs.com/gateway/api/v1/graphql",
            json={"query": ('query { role(externalSourceId: "%s") '
                            "{ jobTitle descriptionHtml } }") % native_id},
            headers={"User-Agent": _UA, "Origin": "https://higher.gs.com",
                     "Referer": "https://higher.gs.com/"},
            timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_goldman_text(r.json()))
    if ats == "radancy":
        if not url:
            return ""
        r = session.get(url, headers={"User-Agent": _UA}, timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_radancy_jsonld_text(r.text))
    # unknown ATS: no zero-secret source.
    return ""
