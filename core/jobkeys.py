"""Canonical job keys — the dedup backbone.

A key identifies one job posting across every funnel (monitor, scout, Simplify,
Gmail evidence, manual paste). Format matches the monitor's historical row ids:
"{ats}-{native_id}" — so migrated history and new captures converge.

Contract with fetchers (monitor/fetchers/*): a fetcher's Job.id MUST equal
job_key() of that posting's public URL. Workday fetchers use the requisition
id (bulletFields[0]); amazon uses id_icims; greenhouse the numeric job id;
lever/ashby their UUIDs.

When no ATS id can be extracted, fall back to a normalized composite —
stable under case/punctuation noise, good enough for human-pasted rows.
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

# (ats, regex-with-one-capture) — first match wins. Applied to the full URL.
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("greenhouse", re.compile(r"greenhouse\.io/(?:embed/job_app\?.*token=|[^/]+/jobs/)(\d+)")),
    ("greenhouse", re.compile(r"[?&]gh_jid=(\d+)")),
    ("lever",      re.compile(rf"jobs(?:\.eu)?\.lever\.co/[^/]+/({_UUID})")),
    ("ashby",      re.compile(rf"jobs\.ashbyhq\.com/[^/]+/({_UUID})")),
    # token "smartrec" matches the fetcher/seed-csv ats value (system-wide id vocabulary)
    ("smartrec",   re.compile(r"jobs\.smartrecruiters\.com/[^/]+/(\d{6,})")),
    # (?:-\d+)? swallows posting-variant suffixes (Adobe _R168260-1); REF\d+W = Visa-style ids
    ("workday",    re.compile(r"myworkdayjobs\.com/.*[_/-](JR[-_]?\d+|R-?\d{4,}|REQ[-_]?\d{3,}|REF\d{4,}[A-Z]?)(?:-\d+)?(?:[/?#]|$)", re.I)),
    ("amazon",     re.compile(r"amazon\.jobs/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/(\d{5,})")),
    ("oraclehcm",  re.compile(r"oraclecloud\.com/.*/job/(\d+)")),
    ("google",     re.compile(r"google\.com/about/careers/applications/jobs/results/(\d{9,})")),
    ("apple",      re.compile(r"jobs\.apple\.com/[a-z-]+/details/(\d{6,})")),
    ("goldman",    re.compile(r"higher\.gs\.com/roles/(\d+)")),
    ("radancy",    re.compile(r"jobs\.intuit\.com/job/(?:[^/]+/)+(\d{6,})(?:[/?#]|$)")),
    ("eightfold",  re.compile(r"eightfold\.ai/careers.*[?&]pid=(\d{10,})")),
    ("eightfold",  re.compile(r"(?:explore\.jobs\.netflix\.net|apply\.careers\.microsoft\.com)/careers.*[?&]pid=(\d{10,})")),
    ("eightfold",  re.compile(r"(?:eightfold\.ai|jobs\.netflix\.net)/careers/job/(\d{10,})")),
    ("icims",      re.compile(r"careers?[-.]([a-z0-9]+)\.icims\.com/jobs/(\d+)")),
]


def _norm_token(s: str) -> str:
    s = (s or "").lower().strip()
    s = re.sub(r"&", " and ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", "-", s.strip())


def job_key(url: str = "", company: str = "", title: str = "", location: str = "") -> str:
    """Return the canonical key for a posting. ATS-derived when possible,
    normalized composite otherwise. Empty string only if there is nothing
    at all to key on."""
    u = (url or "").strip()
    if u:
        for ats, pat in _PATTERNS:
            m = pat.search(u)
            if m:
                if ats == "icims":
                    return f"icims-{m.group(1)}-{m.group(2)}"
                return f"{ats}-{m.group(1)}"
    co, ti = _norm_token(company), _norm_token(title)
    if co and ti:
        city = _norm_token((location or "").split(",")[0])[:24]
        return f"norm-{co[:32]}|{ti[:48]}|{city}"
    if u:
        # last resort: the URL itself, stripped of query noise
        p = urlparse(u)
        return f"url-{p.netloc}{p.path}".rstrip("/")
    return ""


def ats_of(key: str) -> str:
    return (key or "").split("-", 1)[0]


def is_strong(key: str) -> bool:
    """ATS-derived keys are strong (safe to auto-merge on); norm-/url- keys are
    weak — matching on them should stay a suggestion, not a hard merge."""
    return bool(key) and not key.startswith(("norm-", "url-"))
