"""Grow the curated company registry: resolve names to working (ats, slug) pairs.

Produces monitor/companies.expansion.csv (header: name,ats,slug,monitor,seeded,
priority,notes). Sources, in order:

  1. monitor/candidates_resolved.csv  — already-verified rows, passed through.
  2. monitor/candidates_unresolved.csv — re-probed with better guesses.
  3. CURATED below — the hand-picked expansion universe (AI infra/labs, fintech,
     banks/insurers from the legacy xlsx, platform SaaS, dev tools, marketplaces,
     F500 tech). Hints pin known slugs so one request verifies instead of ~20
     guessing.

Families probed: greenhouse, ashby, lever, smartrecruiters ("smartrec"),
workday, oraclehcm, eightfold, radancy — each probe mirrors the corresponding
monitor/fetchers/ endpoint so a resolved slug is guaranteed fetchable. Names
verified as dead ends (acquired, shut down, or on unsupported ATS families)
live in SKIP_KNOWN and are never probed.

Politeness: <=1 req/s per host (every Workday tenant is its own host), browser
UA, 10s timeouts. Parallel across hosts up to 8 workers.

Checkpointing: the output csv itself is the resolved checkpoint and a sidecar
state json caches unresolved names + reasons, so re-runs only probe new names.
Use --retry-unresolved (or delete the state file) to re-probe past failures —
transient network errors are cached as unresolved, so a final retry pass is
part of the normal workflow.

False-positive guard: name-derived slug guesses that don't encode ~the whole
name (first word, first two words) are only accepted when the ATS response
confirms the org identity (greenhouse board name / ashby organization name /
smartrecruiters company name); lever can't confirm, so risky lever hits are
rejected. Full-name slugs are accepted directly.

Usage:
  python -m monitor.scripts.expand_companies resolve   [--workers 8]
  python -m monitor.scripts.expand_companies validate  [--sample 0.05]
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

MON = Path(__file__).resolve().parent.parent
OUT = MON / "companies.expansion.csv"
STATE = MON / "companies.expansion.csv.state.json"
SEED = MON / "companies.seed.csv"
RESOLVED = MON / "candidates_resolved.csv"
UNRESOLVED = MON / "candidates_unresolved.csv"
CATEGORIES = MON / "candidate_companies.csv"
BIGTECH_CSV = MON / "companies.bigtech.csv"   # other agent's file; dedupe if present

HEADER = ["name", "ats", "slug", "monitor", "seeded", "priority", "notes"]
ALLOWED_ATS = {"greenhouse", "ashby", "lever", "smartrec", "workday", "oraclehcm",
               "eightfold", "radancy"}
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
TIMEOUT = 10
WD_INSTANCES = ("wd1", "wd5", "wd3", "wd12", "wd2")
WD_RE = re.compile(r"^[a-z0-9._-]+\.wd\d+\.myworkdayjobs\.com/.+$")

# Handled by monitor/companies.bigtech.csv (separate agent) — never duplicate.
BIGTECH_NAMES = {
    "microsoft", "google", "alphabet", "apple", "netflix", "paypal", "oracle",
    "jpmorgan", "jpmorgan chase", "goldman", "goldman sachs", "intuit", "adobe",
    "mastercard", "visa", "salesforce", "airbnb", "coinbase", "block",
    "block (square)", "amazon", "meta",
}

# Stripe-tier obvious targets for a platform/fintech-infra PM, marked
# priority=TRUE when (and only when) they resolve. Hard cap ~15.
# (groq dropped 2026-07-13: board is live on job-boards.greenhouse.io but its
# public Job Board API is disabled, so the pipeline can't monitor it.)
PRIORITY_NAMES = {
    "capital one", "xai", "circle", "kraken", "paxos", "chainalysis",
    "trm labs", "checkout.com", "bill.com", "melio", "column", "increase",
    "highnote", "palantir",
}
PRIORITY_CAP = 15

# Names we deliberately do NOT probe — verified dead ends (2026-07-13 audit).
# The wide discovery layer still covers these employers' postings; they just
# can't be first-class registry rows. Keys casefolded; values are the reason
# reported in docs/companies-expansion.md.
SKIP_KNOWN: dict[str, str] = {
    "adept": "team acqui-hired into Amazon (2024); no independent job board",
    "ai21 labs": "hires via Comeet (unsupported ATS family)",
    "bamboohr": "runs hiring on its own ATS product (unsupported)",
    "bilt rewards": "hires via Gem (jobs.gem.com/bilt) — unsupported family",
    "census": "acquired by Fivetran (2025); Fivetran already in the registry",
    "coda": "merged into Grammarly (2024); Grammarly row covers it",
    "discover": "acquired by Capital One (2025); the Capital One row covers it",
    "eigenlayer": "no API-accessible board (greenhouse eigenlabs/eigenlayer 404)",
    "goodrx": "no API-accessible board found on any supported family",
    "groq": "greenhouse board live but public Job Board API disabled (v1 404)",
    "hashicorp": "acquired by IBM (2025); hiring moved into IBM Avature (unsupported)",
    "grammarly": "greenhouse v1 API disabled (job-boards only; now under Superhuman)",
    "hugging face": "hires via Workable (unsupported family)",
    "joby aviation": "hires via iCIMS (careers-jobyaviation.icims.com) — unsupported",
    "klarna": "hires via Deel-hosted careers (jobs.deel.com/klarna) — unsupported",
    "moneylion": "acquired by Gen Digital (2025); no API-accessible board",
    "moveworks": "acquired by ServiceNow (2025); ServiceNow already in seed",
    "liveblocks": "no standard board found (tiny team, custom careers page)",
    "modular": "greenhouse board (modularai) live but public Job Board API disabled",
    "monday.com": "hires via Comeet (unsupported family)",
    "outerbounds": "no standard board found (tiny team)",
    "patronus ai": "no API-accessible board found",
    "plenty": "wound down (Chapter 11, 2025)",
    "privy": "acquired by Stripe (2025); Stripe already in the seed registry",
    "qdrant": "hires via join.com (unsupported family)",
    "replicate": "no API-accessible board found (custom careers page)",
    "retool": "greenhouse board (retool) live on job-boards but public v1 API disabled",
    "rippling": "runs hiring on its own ATS (unsupported)",
    "sakana ai": "Japan-based, hires via Herp (unsupported; non-US)",
    "shopify": "moved off SmartRecruiters to a custom careers platform",
    "tome": "pivoted + tiny; former ashby board gone",
    "turso": "no standard board found (tiny team)",
    "verily": "no API-accessible board found (greenhouse verily 404)",
    "weights & biases": "acquired by CoreWeave (2025); CoreWeave already in seed",
    "windsurf": "acquired by Cognition (2025); Cognition already in seed",
    "xata": "no standard board found (tiny team)",
}

# Words safe to drop when deriving slug guesses ("Patronus AI" -> patronus).
STRIP_WORDS = {"inc", "llc", "corp", "corporation", "co", "company", "labs",
               "lab", "technologies", "technology", "systems", "software",
               "holdings", "group", "the", "and", "ai", "io", "hq"}

# --------------------------------------------------------------- rate limit

class HostGate:
    """Serialize requests per host at >=1s spacing — politeness is per-host."""

    def __init__(self, interval: float = 1.0):
        self._interval = interval
        self._lock = threading.Lock()
        self._next: dict[str, float] = {}
        self._host_locks: dict[str, threading.Lock] = {}

    def wait(self, host: str) -> None:
        with self._lock:
            hl = self._host_locks.setdefault(host, threading.Lock())
        with hl:
            now = time.monotonic()
            wait = self._next.get(host, 0.0) - now
            if wait > 0:
                time.sleep(wait)
            self._next[host] = time.monotonic() + self._interval


GATE = HostGate()
_TLS = threading.local()


def _session() -> requests.Session:
    s = getattr(_TLS, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"User-Agent": UA, "Accept": "application/json"})
        _TLS.s = s
    return s


def _get(url: str) -> requests.Response | None:
    host = url.split("/", 3)[2]
    GATE.wait(host)
    try:
        return _session().get(url, timeout=TIMEOUT)
    except requests.RequestException:
        return None


def _post_json(url: str, body: dict) -> requests.Response | None:
    host = url.split("/", 3)[2]
    GATE.wait(host)
    try:
        return _session().post(url, json=body, timeout=TIMEOUT)
    except requests.RequestException:
        return None


# --------------------------------------------------------------- probes
# Each returns the confirmed org display name if the API exposes one ("" when
# it can't), or None on miss — the caller uses the name for identity checks.

def probe_greenhouse(slug: str) -> str | None:
    r = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false")
    if r is None or r.status_code != 200:
        return None
    try:
        if "jobs" not in r.json():
            return None
    except ValueError:
        return None
    r2 = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug}")
    if r2 is not None and r2.status_code == 200:
        try:
            return str(r2.json().get("name") or "")
        except ValueError:
            pass
    return ""


def probe_ashby(slug: str) -> str | None:
    r = _get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false")
    if r is None or r.status_code != 200:
        return None
    try:
        d = r.json()
    except ValueError:
        return None
    if not isinstance(d, dict) or "jobs" not in d:
        return None
    return str(d.get("organizationName") or d.get("name") or "")


def probe_lever(slug: str) -> str | None:
    r = _get(f"https://api.lever.co/v0/postings/{slug}?limit=1&mode=json")
    if r is None or r.status_code != 200:
        return None
    try:
        if not isinstance(r.json(), list):
            return None
    except ValueError:
        return None
    return ""   # lever exposes no org name


def probe_smartrec(slug: str) -> str | None:
    r = _get(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=1")
    if r is None or r.status_code != 200:
        return None
    try:
        d = r.json()
    except ValueError:
        return None
    # SR returns 200 + empty body for unknown companies; require a real posting.
    if not isinstance(d, dict) or int(d.get("totalFound") or 0) < 1:
        return None
    content = d.get("content") or []
    return str((content[0].get("company") or {}).get("name") or "") if content else ""


def _workday_status(host: str, site: str) -> int:
    """0 = network fail. Observed: 200 ok; 422 tenant not on this wdN
    instance; 404 instance right, site name wrong."""
    tenant = host.split(".", 1)[0]
    r = _post_json(f"https://{host}/wday/cxs/{tenant}/{site}/jobs",
                   {"appliedFacets": {}, "limit": 1, "offset": 0})
    if r is None:
        return 0
    if r.status_code == 200:
        try:
            return 200 if "total" in r.json() else 404
        except ValueError:
            return 404
    return r.status_code


def probe_workday(slug: str) -> bool:
    """slug = '{tenant}.wdN.myworkdayjobs.com/{site}' (monitor/fetchers/workday.py)."""
    host, site = slug.split("/", 1)
    return _workday_status(host, site) == 200


def probe_oraclehcm(slug: str) -> bool:
    """slug = '{host}|{CX_n}'. Bogus sites still 200 — require >=1 requisition.
    expand=requisitionList.secondaryLocations mirrors monitor/fetchers/oracle_hcm.py:
    without exactly that expand the response omits requisitionList entirely."""
    host, site = slug.split("|", 1)
    r = _get(f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions"
             f"?onlyData=true&expand=requisitionList.secondaryLocations"
             f"&finder=findReqs;siteNumber={site},limit=1")
    if r is None or r.status_code != 200:
        return False
    try:
        items = r.json().get("items") or []
    except ValueError:
        return False
    return bool(items and (items[0].get("requisitionList") or []))


def probe_eightfold(slug: str) -> bool:
    """slug = '{host}|{domain}' (monitor/fetchers/eightfold.py). SmartApply
    tenants answer /api/apply/v2/jobs; PCSX-only tenants 403 there and answer
    /api/pcsx/search instead — both count as a working tenant."""
    host, domain = slug.split("|", 1)
    r = _get(f"https://{host}/api/apply/v2/jobs?domain={domain}&query=product&start=0&num=1")
    if r is not None and r.status_code == 200:
        try:
            d = r.json()
        except ValueError:
            return False
        return isinstance(d, dict) and ("positions" in d or "count" in d)
    if r is not None and r.status_code == 403 and "Not authorized for PCSX" in r.text:
        r2 = _get(f"https://{host}/api/pcsx/search?domain={domain}&query=product&location=&start=0")
        if r2 is None or r2.status_code != 200:
            return False
        try:
            return isinstance(r2.json().get("data"), dict)
        except ValueError:
            return False
    return False


def probe_radancy(slug: str) -> bool:
    """slug = site host (monitor/fetchers/radancy.py). SearchResultsModuleName
    is load-bearing; a real Radancy site answers JSON with a 'results' key
    (hasJobs may be false when the keyword has no hits — still a valid site)."""
    r = _get(f"https://{slug}/search-jobs/results?ActiveFacetID=0&CurrentPage=1"
             f"&RecordsPerPage=15&Keywords=product&SearchType=5&SortCriteria=0"
             f"&SortDirection=1&SearchResultsModuleName=Search%20Results"
             f"&SearchFiltersModuleName=Search%20Filters")
    if r is None or r.status_code != 200:
        return False
    try:
        d = r.json()
    except ValueError:
        return False
    return isinstance(d, dict) and "results" in d


PROBES = {"greenhouse": probe_greenhouse, "ashby": probe_ashby,
          "lever": probe_lever, "smartrec": probe_smartrec}

# --------------------------------------------------------------- slug guessing

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _identity_ok(company: str, confirmed: str) -> bool:
    a, b = _norm(company), _norm(confirmed)
    if not b:
        return False
    if a in b or b in a:
        return True
    at = set(re.sub(r"[^a-z0-9 ]", "", company.lower()).split())
    bt = set(re.sub(r"[^a-z0-9 ]", "", confirmed.lower()).split())
    small = min(at, bt, key=len)
    return bool(small) and len(at & bt) / len(small) >= 0.6


def candidate_slugs(name: str) -> list[tuple[str, bool]]:
    """(slug, risky) guesses, specific first. Risky = doesn't encode ~the full
    name, so a hit must be identity-confirmed before we trust it."""
    base = re.sub(r"[^a-z0-9 .]", "", name.lower().replace("&", " and "))
    words = base.replace(".", "").split()
    if not words:
        return []
    stripped = [w for w in words if w not in STRIP_WORDS] or words
    out: list[tuple[str, bool]] = []
    seen: set[str] = set()

    def add(slug: str, risky: bool) -> None:
        if slug and slug not in seen:
            seen.add(slug)
            out.append((slug, risky))

    add("".join(words), False)
    add("-".join(words), False)
    add("".join(stripped), False)
    add(base.replace(".", " ").split()[0], True)   # monday.com -> monday
    add(words[0], True)
    add("".join(words[:2]), True)
    return out


def resolve_generic(name: str) -> tuple[str, str] | None:
    for slug, risky in candidate_slugs(name):
        for ats in ("greenhouse", "ashby", "lever", "smartrec"):
            confirmed = PROBES[ats](slug)
            if confirmed is None:
                continue
            if risky and not _identity_ok(name, confirmed):
                continue    # board exists but may be someone else's — keep looking
            return ats, slug
    return None


def resolve_workday_hint(hint: str) -> str | None:
    """hint: 'host/site', bare 'host' (guess common site names), or a careers
    URL (myworkdayjobs or myworkdaysite form). The cxs status codes steer the
    search: 422 means the tenant isn't on this wdN instance (skip it), 404
    means instance right / site wrong (keep guessing sites here)."""
    hint = hint.strip().rstrip("/")
    if hint.startswith("http"):
        # Two host shapes: {tenant}.wdN.myworkdayjobs.com/{site} and the
        # tenant-less wdN.myworkdaysite.com/recruiting/{tenant}/{site} — the
        # leading tenant group must be optional or the second never matches.
        m = re.search(
            r"(?:https?://)?(?:([a-z0-9_-]+)\.)?(wd\d+)\.(?:myworkdayjobs|myworkdaysite)\.com/"
            r"(?:[a-z]{2}-[A-Z]{2}/)?(?:recruiting/([a-z0-9._-]+)/)?([^/?#]+)",
            hint)
        if not m:
            return None
        tenant, wd, rec_tenant, site = m.groups()
        if not tenant:
            if not rec_tenant:
                return None
            tenant = rec_tenant
        hint = f"{tenant}.{wd}.myworkdayjobs.com/{site}"

    host, _, site = hint.partition("/")
    tenant = host.split(".", 1)[0]
    parts = host.split(".")
    wd = parts[1] if len(parts) > 1 and re.fullmatch(r"wd\d+", parts[1]) else None
    instances = ([wd] + [i for i in WD_INSTANCES if i != wd]) if wd else list(WD_INSTANCES)
    sites = [site] if site else [
        tenant.capitalize(), tenant, "External", "Careers", "External_Career_Site",
        f"{tenant}careers", "External_Careers", "Search", tenant.upper(),
    ]

    for inst in instances:
        h = f"{tenant}.{inst}.myworkdayjobs.com"
        for s in sites:
            status = _workday_status(h, s)
            if status == 200:
                return f"{h}/{s}"
            if status in (422, 0):
                break    # wrong instance / unreachable — next wdN
    return None


def resolve_hints(name: str, hints: tuple[str, ...]) -> tuple[str, str] | None:
    for hint in hints:
        kind, _, val = hint.partition(":")
        if kind in PROBES:
            if PROBES[kind](val) is not None:
                return kind, val
        elif kind == "workday":
            slug = resolve_workday_hint(val)
            if slug:
                return "workday", slug
        elif kind == "wdurl":
            slug = resolve_workday_hint(val)
            if slug:
                return "workday", slug
        elif kind == "oraclehcm":
            if probe_oraclehcm(val):
                return "oraclehcm", val
        elif kind == "eightfold":
            if probe_eightfold(val):
                return "eightfold", val
        elif kind == "radancy":
            if probe_radancy(val):
                return "radancy", val
    return None


# --------------------------------------------------------------- curated universe
# (name, category, hints). Hints verified-first; empty hints = generic probe.
# Workday hints from the legacy xlsx careers URLs are tagged in the category.

CURATED: list[tuple[str, str, tuple[str, ...]]] = [
    # ---- re-probes of candidates_unresolved.csv with better guesses
    # (names verified as dead ends live in SKIP_KNOWN, not here)
    ("DoorDash", "consumer-marketplace", ("greenhouse:doordashusa",)),
    ("Snap", "consumer-marketplace", ("workday:snapchat.wd1.myworkdayjobs.com/snap", "workday:snap.wd5.myworkdayjobs.com")),
    ("Eventbrite", "consumer-marketplace", ("greenhouse:eventbriteinc",)),
    ("Sourcegraph", "dev-tools", ("greenhouse:sourcegraph91",)),
    ("Hims & Hers", "healthtech", ("greenhouse:himshers",)),
    ("Pulumi", "dev-tools", ("greenhouse:pulumicorporation",)),
    ("Convex", "data-infra", ("ashby:convex-dev",)),
    ("Hinge", "consumer-marketplace", ("lever:hinge", "greenhouse:hinge")),
    ("Procore", "enterprise-saas", ("workday:procore.wd12.myworkdayjobs.com/Procore_External_Careers",)),
    ("Box", "enterprise-saas", ("greenhouse:boxinc",)),
    ("Pipe", "fintech", ("greenhouse:pipetechnologies",)),
    ("Optimism", "fintech-crypto", ("greenhouse:oplabs", "ashby:oplabs")),
    ("Tempus AI", "healthtech", ("workday:tempus.wd5.myworkdayjobs.com/Tempus_Careers",)),
    ("Commonwealth Fusion Systems", "climate-frontier", ("lever:cfsenergy",)),
    ("Recursion Pharma", "healthtech", ("greenhouse:recursionpharmaceuticals",)),

    # ---- AI labs / AI infra
    ("xAI", "ai-labs", ("greenhouse:xai", "ashby:xai")),
    ("Baseten", "ai-infra", ("ashby:baseten",)),
    ("Fireworks AI", "ai-infra", ("ashby:fireworks-ai", "greenhouse:fireworksai")),
    ("SambaNova Systems", "ai-infra", ("greenhouse:sambanovasystems",)),
    ("Etched", "ai-infra", ("ashby:etched",)),
    ("Contextual AI", "ai-labs", ("ashby:contextual-ai",)),
    ("Inflection AI", "ai-labs", ("greenhouse:inflectionai",)),
    ("Luma AI", "ai-labs", ("lever:luma-ai", "ashby:lumalabs")),
    ("Ideogram", "ai-labs", ("ashby:ideogram",)),
    ("Black Forest Labs", "ai-labs", ("ashby:black-forest-labs",)),
    ("Midjourney", "ai-labs", ()),
    ("HeyGen", "ai-apps", ("ashby:heygen",)),
    ("Descript", "ai-apps", ("ashby:descript", "greenhouse:descript")),
    ("AssemblyAI", "ai-infra", ("greenhouse:assemblyai", "ashby:assemblyai")),
    ("Deepgram", "ai-infra", ("ashby:deepgram", "greenhouse:deepgram")),
    ("Weaviate", "ai-infra", ()),
    ("Chroma", "ai-infra", ("ashby:trychroma",)),
    ("Zilliz", "ai-infra", ("greenhouse:zilliz",)),
    ("LanceDB", "ai-infra", ("ashby:lancedb",)),
    ("Galileo", "ai-infra", ("ashby:galileo", "greenhouse:rungalileo")),
    ("Arthur AI", "ai-infra", ("greenhouse:arthur",)),
    ("Fiddler AI", "ai-infra", ()),
    ("Snorkel AI", "ai-infra", ("greenhouse:snorkelai",)),
    ("Labelbox", "ai-infra", ("greenhouse:labelbox",)),
    ("Surge AI", "ai-infra", ("ashby:surge",)),
    ("Invisible Technologies", "ai-infra", ("ashby:invisible-technologies",)),
    ("Turing", "ai-infra", ()),
    ("RunPod", "ai-infra", ("ashby:runpod",)),
    ("Nebius", "ai-infra", ("greenhouse:nebius",)),
    ("Voltage Park", "ai-infra", ("ashby:voltagepark",)),
    ("SF Compute", "ai-infra", ("ashby:sfcompute",)),
    ("Prime Intellect", "ai-labs", ("ashby:primeintellect",)),
    ("Nous Research", "ai-labs", ("ashby:nousresearch",)),
    ("Reka AI", "ai-labs", ("ashby:reka",)),
    ("Twelve Labs", "ai-labs", ("greenhouse:twelvelabs", "ashby:twelvelabs")),
    ("Captions", "ai-apps", ("greenhouse:captions", "ashby:captions")),
    ("Photoroom", "ai-apps", ("ashby:photoroom",)),
    ("Cartesia", "ai-labs", ("ashby:cartesia",)),
    ("LiveKit", "ai-infra", ("ashby:livekit",)),
    ("Retell AI", "ai-apps", ("ashby:retellai",)),
    ("Vapi", "ai-apps", ("ashby:vapi",)),
    ("Sesame", "ai-labs", ("ashby:sesame",)),
    ("Speak", "ai-apps", ("ashby:speak",)),
    ("Aisera", "ai-apps", ("greenhouse:aiserajobs",)),
    ("Forethought", "ai-apps", ("ashby:forethought",)),
    ("Ada", "ai-apps", ("greenhouse:ada18",)),
    ("ASAPP", "ai-apps", ("greenhouse:asapp",)),
    ("Observe.AI", "ai-apps", ("greenhouse:observeai",)),
    ("Clari", "ai-apps", ("greenhouse:clari",)),
    ("People.ai", "ai-apps", ("greenhouse:peopleai",)),
    ("Outreach", "enterprise-saas", ("greenhouse:outreach",)),
    ("Salesloft", "enterprise-saas", ("greenhouse:salesloft",)),
    ("Copy.ai", "ai-apps", ()),
    ("Jasper", "ai-apps", ("greenhouse:jasperai", "lever:jasper")),
    ("Typeface", "ai-apps", ("ashby:typeface",)),
    ("Gamma", "ai-apps", ("ashby:gamma",)),
    ("Lindy", "ai-apps", ("ashby:lindy",)),
    ("CrewAI", "ai-infra", ("ashby:crewai",)),
    ("OpenRouter", "ai-infra", ("ashby:openrouter",)),
    ("Allen Institute for AI", "ai-labs", ("greenhouse:thealleninstituteforai",)),
    ("World Labs", "ai-labs", ("ashby:worldlabs",)),
    ("Skild AI", "ai-labs", ("ashby:skildai",)),
    ("Waymo", "ai-labs", ("greenhouse:waymo",)),
    ("Zoox", "ai-labs", ("lever:zoox", "greenhouse:zoox")),
    ("Aurora Innovation", "ai-labs", ("greenhouse:aurorainnovation",)),
    ("Applied Intuition", "ai-infra", ("ashby:applied",)),
    ("Nuro", "ai-labs", ("greenhouse:nuro",)),
    ("Shield AI", "defense", ("greenhouse:shieldai",)),
    ("Saronic", "defense", ("ashby:saronic",)),
    ("Palantir", "data-infra", ("lever:palantir",)),

    # ---- fintech: payments / infra / banking-as-a-service
    ("Fiserv", "fintech-infra", ("workday:fiserv.wd5.myworkdayjobs.com/EXT",)),
    ("FIS", "fintech-infra", ("workday:fis.wd5.myworkdayjobs.com/SearchJobs", "workday:fis.wd5.myworkdayjobs.com")),
    ("Global Payments", "fintech-infra", ("workday:globalpayments.wd5.myworkdayjobs.com", "workday:tsys.wd1.myworkdayjobs.com")),
    ("Jack Henry", "fintech-infra", ("radancy:careers.jackhenry.com",)),
    ("nCino", "fintech-infra", ("workday:ncino.wd5.myworkdayjobs.com", "greenhouse:ncino")),
    ("Q2", "fintech-infra", ("workday:q2ebanking.wd5.myworkdayjobs.com/Q2",)),
    ("Alkami", "fintech-infra", ("workday:alkami.wd12.myworkdayjobs.com/Alkami",)),
    ("Blend", "fintech-infra", ("greenhouse:blend", "greenhouse:blendlabs")),
    ("Upstart", "fintech", ("greenhouse:upstart",)),
    ("Happen (LendingClub)", "fintech", ("workday:lendingclub.wd1.myworkdayjobs.com/External",)),
    ("Oportun", "fintech", ("greenhouse:oportun",)),
    ("Self Financial", "fintech", ("greenhouse:self",)),
    ("Mission Lane", "fintech", ("greenhouse:missionlane",)),
    ("Dave", "fintech", ("greenhouse:dave", "lever:dave")),
    ("Empower Finance", "fintech", ("ashby:empower", "lever:empower")),
    ("Albert", "fintech", ("greenhouse:albert", "lever:albert")),
    ("Varo Bank", "fintech", ("greenhouse:varomoney", "lever:varomoney")),
    ("Current", "fintech", ("greenhouse:current",)),
    ("Step", "fintech", ("greenhouse:step", "lever:step")),
    ("Greenlight", "fintech", ("greenhouse:greenlight",)),
    ("Acorns", "fintech", ("greenhouse:acorns",)),
    ("Stash", "fintech", ("greenhouse:stashinvest",)),
    ("Betterment", "fintech", ("greenhouse:betterment",)),
    ("Wealthfront", "fintech", ("lever:wealthfront", "greenhouse:wealthfront")),
    ("M1 Finance", "fintech", ("lever:m1finance", "greenhouse:m1finance")),
    ("Apex Fintech Solutions", "fintech-infra", ("greenhouse:apexfintechsolutions",)),
    ("DriveWealth", "fintech-infra", ("greenhouse:drivewealth",)),
    ("Alpaca", "fintech-infra", ("greenhouse:alpaca", "ashby:alpaca")),
    ("Zero Hash", "fintech-crypto", ("greenhouse:zerohash",)),
    ("Paxos", "fintech-crypto", ("greenhouse:joinpaxos", "greenhouse:paxos")),
    ("Circle", "fintech-crypto", ("greenhouse:circle",)),
    ("Ripple", "fintech-crypto", ("greenhouse:ripple",)),
    ("Kraken", "fintech-crypto", ("lever:kraken", "greenhouse:kraken123")),
    ("Gemini", "fintech-crypto", ("greenhouse:gemini",)),
    ("BitGo", "fintech-crypto", ("greenhouse:bitgo",)),
    ("Chainalysis", "fintech-crypto", ("ashby:chainalysis-careers",)),
    ("TRM Labs", "fintech-crypto", ("ashby:trm", "greenhouse:trmlabs")),
    ("CoinTracker", "fintech-crypto", ("ashby:cointracker",)),
    ("TaxBit", "fintech-crypto", ("greenhouse:taxbit",)),
    ("Galaxy Digital", "fintech-crypto", ("greenhouse:galaxydigitalservices",)),
    ("Blockchain.com", "fintech-crypto", ("greenhouse:blockchain",)),
    ("Checkout.com", "fintech-infra", ("greenhouse:checkoutcom", "greenhouse:checkout")),
    ("Bolt", "fintech-infra", ("greenhouse:bolt",)),
    ("Rapyd", "fintech-infra", ("greenhouse:rapyd",)),
    ("Payoneer", "fintech", ("greenhouse:payoneer",)),
    ("Remitly", "fintech", ("greenhouse:remitly",)),
    ("Zepz", "fintech", ("greenhouse:zepz", "greenhouse:worldremit")),
    ("Flywire", "fintech", ("greenhouse:flywire",)),
    ("Nium", "fintech-infra", ("lever:nium", "greenhouse:nium")),
    ("AvidXchange", "fintech", ("workday:avidxchange.wd1.myworkdayjobs.com", "greenhouse:avidxchange")),
    ("Bill.com", "fintech", ("greenhouse:bill", "lever:bill")),
    ("Melio", "fintech", ("greenhouse:melio", "ashby:melio")),
    ("Tipalti", "fintech", ("greenhouse:tipalti", "lever:tipalti")),
    ("Stampli", "fintech", ("lever:stampli", "greenhouse:stampli")),
    ("Expensify", "fintech", ("greenhouse:expensify",)),
    ("Shift4", "fintech-infra", ("workday:shift4.wd1.myworkdayjobs.com", "greenhouse:shift4")),
    ("Finix", "fintech-infra", ("greenhouse:finix", "ashby:finix")),
    ("Moov", "fintech-infra", ("greenhouse:moov", "ashby:moov")),
    ("Dwolla", "fintech-infra", ("greenhouse:dwolla", "lever:dwolla")),
    ("Orum", "fintech-infra", ("ashby:orum", "greenhouse:orum")),
    ("Increase", "fintech-infra", ("ashby:increase",)),
    ("Column", "fintech-infra", ("ashby:column",)),
    ("Cross River", "fintech-infra", ("greenhouse:crossriverbank",)),
    ("Treasury Prime", "fintech-infra", ("greenhouse:treasuryprime",)),
    ("Synctera", "fintech-infra", ("greenhouse:synctera", "ashby:synctera")),
    ("Highnote", "fintech-infra", ("greenhouse:highnote", "ashby:highnote")),
    # Zeta: greenhouse:zeta 404s and lever:zeta can't be identity-confirmed
    # (lever exposes no org name; "zeta" could be Zeta Global) — left out.
    ("Green Dot", "fintech", ("workday:greendot.wd5.myworkdayjobs.com", "workday:greendotcorp.wd5.myworkdayjobs.com")),
    ("Pathward", "fintech", ("workday:pathward.wd5.myworkdayjobs.com",)),
    ("Worldpay", "fintech-infra", ("workday:worldpay.wd5.myworkdayjobs.com", "workday:worldpay.wd1.myworkdayjobs.com")),
    ("ACI Worldwide", "fintech-infra", ("workday:aciworldwide.wd5.myworkdayjobs.com", "workday:aciworldwide.wd1.myworkdayjobs.com")),
    ("WEX", "fintech-infra", ("workday:wexinc.wd5.myworkdayjobs.com", "workday:wexinc.wd1.myworkdayjobs.com")),
    ("Corpay", "fintech-infra", ("workday:fleetcor.wd1.myworkdayjobs.com", "greenhouse:corpay")),
    ("Sezzle", "fintech", ("greenhouse:sezzle",)),
    ("Brigit", "fintech", ("greenhouse:brigit", "lever:brigit")),
    ("MX", "fintech-infra", ("greenhouse:mx", "lever:mx")),
    ("Akoya", "fintech-infra", ("greenhouse:akoya",)),
    ("Codat", "fintech-infra", ("greenhouse:codat",)),
    ("Rutter", "fintech-infra", ("ashby:rutter",)),
    ("Argyle", "fintech-infra", ("greenhouse:argyle", "ashby:argyle")),
    ("Pinwheel", "fintech-infra", ("greenhouse:pinwheelapi", "greenhouse:pinwheel")),
    ("Atomic", "fintech-infra", ("ashby:atomic", "greenhouse:atomic")),
    ("Truv", "fintech-infra", ("ashby:truv",)),
    ("Finch", "fintech-infra", ("ashby:finch",)),
    ("Merge", "fintech-infra", ("greenhouse:merge", "ashby:merge")),
    ("Trustly", "fintech-infra", ("greenhouse:trustly",)),
    ("Method Financial", "fintech-infra", ("ashby:methodfi",)),
    ("Unit21", "fintech-infra", ("greenhouse:unit21", "ashby:unit21")),
    ("Middesk", "fintech-infra", ("ashby:middesk", "greenhouse:middesk")),
    ("SentiLink", "fintech-infra", ("greenhouse:sentilink", "ashby:sentilink")),
    ("Sift", "fintech-infra", ("greenhouse:siftscience", "greenhouse:sift")),
    ("Forter", "fintech-infra", ("greenhouse:forter",)),
    ("Signifyd", "fintech-infra", ("greenhouse:signifyd",)),
    ("Riskified", "fintech-infra", ("greenhouse:riskified",)),
    ("Feedzai", "fintech-infra", ("greenhouse:feedzai",)),
    ("ComplyAdvantage", "fintech-infra", ("greenhouse:complyadvantage",)),
    ("Prove", "fintech-infra", ("greenhouse:prove",)),
    ("Jumio", "fintech-infra", ("greenhouse:jumio", "lever:jumio")),
    ("Veriff", "fintech-infra", ("greenhouse:veriff",)),
    ("Incode", "fintech-infra", ("greenhouse:incode",)),
    ("Footprint", "fintech-infra", ("ashby:footprint",)),
    ("Array", "fintech-infra", ("greenhouse:array",)),
    ("Anrok", "fintech-infra", ("ashby:anrok",)),
    ("Avalara", "fintech-infra", ("workday:avalara.wd5.myworkdayjobs.com", "greenhouse:avalara")),
    ("Vertex Inc", "fintech-infra", ("workday:vertexinc.wd1.myworkdayjobs.com", "workday:vertexinc.wd5.myworkdayjobs.com")),
    ("Recurly", "fintech-infra", ("greenhouse:recurly", "lever:recurly")),
    ("Chargebee", "fintech-infra", ("greenhouse:chargebee",)),
    ("Zuora", "fintech-infra", ("workday:zuora.wd5.myworkdayjobs.com", "greenhouse:zuora")),
    ("PayNearMe", "fintech-infra", ("greenhouse:paynearme", "lever:paynearme")),
    ("Payhawk", "fintech", ()),

    # ---- banks & insurers (xlsx-sourced workday hints where the sheet had URLs)
    ("Capital One", "bank", ("workday:capitalone.wd12.myworkdayjobs.com/Capital_One",)),
    ("U.S. Bank", "bank", ("workday:usbank.wd1.myworkdayjobs.com/US_Bank_Careers",)),
    ("TD Bank", "bank", ("workday:td.wd3.myworkdayjobs.com/TD_Bank_Careers",)),
    ("Fifth Third Bank", "bank", ("workday:fifththird.wd5.myworkdayjobs.com/53careers",)),
    ("M&T Bank", "bank", ("workday:mtb.wd5.myworkdayjobs.com/MTB",)),
    ("KeyBank", "bank", ("workday:keybank.wd5.myworkdayjobs.com/External_Career_Site",)),
    ("Northern Trust", "bank", ("workday:ntrs.wd1.myworkdayjobs.com/northerntrust",)),
    ("Western Alliance Bank", "bank", ("workday:westernalliancebank.wd5.myworkdayjobs.com/WAB",)),
    ("CIBC US", "bank", ("workday:cibc.wd3.myworkdayjobs.com/search",)),
    ("TIAA", "bank", ("workday:tiaa.wd1.myworkdayjobs.com/Search",)),
    ("UMB Bank", "bank", ("workday:umb.wd1.myworkdayjobs.com/UMBExternal",)),
    ("Associated Bank", "bank", ("workday:associatedbank.wd1.myworkdayjobs.com/external_careers",)),
    ("Texas Capital Bank", "bank", ("workday:texascapitalbank.wd12.myworkdayjobs.com/Careers",)),
    ("Sallie Mae", "bank", ("workday:sallie-mae.wd5.myworkdayjobs.com/Careers",)),
    ("FNB Corp", "bank", ("workday:fnbcorp.wd1.myworkdayjobs.com/FNBCORP",)),
    ("PNC", "bank", ("workday:pnc.wd5.myworkdayjobs.com", "workday:pncbank.wd5.myworkdayjobs.com")),
    ("Truist", "bank", ("workday:truist.wd1.myworkdayjobs.com", "workday:truist.wd5.myworkdayjobs.com")),
    ("Citizens", "bank", ("radancy:jobs.citizensbank.com",)),
    ("Huntington National Bank", "bank", ("radancy:careers.huntington.com", "workday:huntington.wd5.myworkdayjobs.com")),
    ("Regions Bank", "bank", ("radancy:careers.regions.com", "workday:regions.wd5.myworkdayjobs.com")),
    ("Synchrony", "bank", ("radancy:careers.synchrony.com", "workday:synchrony.wd1.myworkdayjobs.com")),
    ("BMO US", "bank", ("workday:bmo.wd3.myworkdayjobs.com", "workday:bmo.wd1.myworkdayjobs.com")),
    ("HSBC US", "bank", ("workday:hsbc.wd3.myworkdayjobs.com", "workday:hsbc.wd1.myworkdayjobs.com")),
    ("Santander US", "bank", ("workday:santander.wd3.myworkdayjobs.com", "workday:santander.wd1.myworkdayjobs.com")),
    ("USAA", "bank", ("workday:usaa.wd1.myworkdayjobs.com/USAAJOBSWD",)),
    ("State Street", "bank", ("radancy:careers.statestreet.com", "workday:statestreet.wd1.myworkdayjobs.com")),
    ("First Citizens Bank", "bank", ("workday:fcb.wd1.myworkdayjobs.com", "workday:firstcitizens.wd5.myworkdayjobs.com")),
    ("Comerica", "bank", ("workday:comerica.wd5.myworkdayjobs.com", "workday:comerica.wd1.myworkdayjobs.com")),
    ("Vanguard", "bank", ("radancy:www.vanguardjobs.com", "radancy:vanguardjobs.com")),
    ("BlackRock", "bank", ("radancy:careers.blackrock.com",)),
    ("BNY Mellon", "bank", ("oraclehcm:eofe.fa.us2.oraclecloud.com|CX_1001",)),
    ("Navy Federal Credit Union", "bank", ("oraclehcm:fa-etbx-saasfaprod1.fa.ocs.oraclecloud.com|CX_1",)),
    ("RLI Corp", "insurance", ("workday:rlicorp.wd1.myworkdayjobs.com/RLI_Corp_Careers",)),
    ("AIG", "insurance", ("workday:aig.wd1.myworkdayjobs.com/aig",)),
    ("CNA Insurance", "insurance", ("workday:cna.wd1.myworkdayjobs.com/CNA_Careers",)),
    ("Markel", "insurance", ("workday:markelcorp.wd5.myworkdayjobs.com/GlobalCareers",)),
    ("Corebridge Financial", "insurance", ("workday:corebridgefinancial.wd1.myworkdayjobs.com/CorebridgeFinancial",)),
    ("Hagerty", "insurance", ("workday:hagerty.wd5.myworkdayjobs.com/hagerty",)),
    ("Northwestern Mutual", "insurance", ("workday:northwesternmutual.wd5.myworkdayjobs.com", "workday:nm.wd1.myworkdayjobs.com")),
    ("MetLife", "insurance", ("workday:metlife.wd5.myworkdayjobs.com", "workday:metlife.wd1.myworkdayjobs.com")),
    ("Prudential Financial", "insurance", ("workday:pru.wd5.myworkdayjobs.com", "workday:prudential.wd5.myworkdayjobs.com")),
    ("The Hartford", "insurance", ("radancy:careers.thehartford.com", "workday:thehartford.wd5.myworkdayjobs.com")),
    ("Travelers", "insurance", ("workday:travelers.wd5.myworkdayjobs.com", "workday:travelers.wd1.myworkdayjobs.com")),
    ("Nationwide", "insurance", ("radancy:careers.nationwide.com", "workday:nationwide.wd1.myworkdayjobs.com")),
    ("Humana", "insurance", ("radancy:careers.humana.com", "workday:humana.wd5.myworkdayjobs.com")),
    ("Elevance Health", "insurance", ("workday:elevancehealth.wd1.myworkdayjobs.com", "workday:antheminc.wd1.myworkdayjobs.com")),
    ("Centene", "insurance", ("workday:centene.wd5.myworkdayjobs.com", "workday:centene.wd1.myworkdayjobs.com")),
    ("Root Insurance", "insurance", ("greenhouse:root", "lever:root")),
    ("Hippo Insurance", "insurance", ("greenhouse:hippo", "lever:hippo")),
    ("Next Insurance", "insurance", ("greenhouse:nextinsurance", "lever:nextinsurance")),
    ("Coalition", "insurance", ("greenhouse:coalition", "ashby:coalition")),
    ("At-Bay", "insurance", ("greenhouse:atbay", "lever:at-bay")),
    ("Newfront", "insurance", ("greenhouse:newfront", "ashby:newfront")),
    ("Vouch Insurance", "insurance", ("greenhouse:vouch", "ashby:vouch")),
    ("Ethos Life", "insurance", ("greenhouse:ethoslife", "ashby:ethoslife")),
    ("Ladder Life", "insurance", ("lever:ladder", "greenhouse:ladder")),
    ("Jerry", "insurance", ("greenhouse:jerry", "ashby:jerry")),
    ("Clearcover", "insurance", ("greenhouse:clearcover", "lever:clearcover")),
    ("Kin Insurance", "insurance", ("greenhouse:kininsurance", "greenhouse:kin")),
    ("Federato", "insurance", ("ashby:federato",)),
    ("Snapsheet", "insurance", ("greenhouse:snapsheet", "lever:snapsheet")),
    ("Guidewire", "insurance", ("workday:guidewire.wd5.myworkdayjobs.com", "greenhouse:guidewire")),
    ("Duck Creek", "insurance", ("workday:duckcreek.wd1.myworkdayjobs.com", "greenhouse:duckcreek")),
    ("CCC Intelligent Solutions", "insurance", ("workday:cccis.wd1.myworkdayjobs.com", "workday:cccis.wd5.myworkdayjobs.com")),
    ("Lincoln Financial", "insurance", ("workday:lfg.wd1.myworkdayjobs.com", "workday:lfg.wd5.myworkdayjobs.com")),

    # ---- pharma / health (PM-at-scale digital orgs only)
    ("Pfizer", "pharma", ("workday:pfizer.wd1.myworkdayjobs.com/PfizerCareers",)),
    ("Gilead Sciences", "pharma", ("workday:gilead.wd1.myworkdayjobs.com/gileadcareers",)),
    ("Vertex Pharmaceuticals", "pharma", ("workday:vrtx.wd5.myworkdayjobs.com/vertex_careers",)),
    ("Zoetis", "pharma", ("workday:zoetis.wd5.myworkdayjobs.com/zoetis",)),
    ("Merck", "pharma", ("radancy:jobs.merck.com", "workday:merck.wd5.myworkdayjobs.com")),
    ("AbbVie", "pharma", ("workday:abbvie.wd5.myworkdayjobs.com", "workday:abbvie.wd1.myworkdayjobs.com")),
    ("Amgen", "pharma", ("workday:amgen.wd1.myworkdayjobs.com", "workday:amgen.wd5.myworkdayjobs.com")),
    ("Bristol Myers Squibb", "pharma", ("workday:bristolmyerssquibb.wd5.myworkdayjobs.com/BMS",)),
    ("Moderna", "pharma", ("workday:modernatx.wd1.myworkdayjobs.com/M_tx",)),
    ("Regeneron", "pharma", ("workday:regeneron.wd1.myworkdayjobs.com", "workday:regeneron.wd5.myworkdayjobs.com")),
    ("Biogen", "pharma", ("workday:biogen.wd1.myworkdayjobs.com", "workday:biogen.wd5.myworkdayjobs.com")),
    ("CVS Health", "healthtech", ("workday:cvshealth.wd1.myworkdayjobs.com/CVS_Health_Careers",)),
    ("McKesson", "healthtech", ("workday:mckesson.wd3.myworkdayjobs.com", "workday:mckesson.wd1.myworkdayjobs.com")),
    ("Cardinal Health", "healthtech", ("workday:cardinalhealth.wd1.myworkdayjobs.com", "workday:cardinalhealth.wd5.myworkdayjobs.com")),
    ("athenahealth", "healthtech", ("workday:athenahealth.wd1.myworkdayjobs.com", "greenhouse:athenahealth")),
    ("Teladoc Health", "healthtech", ("greenhouse:teladochealth", "lever:teladoc")),
    ("Veeva Systems", "healthtech", ("lever:veeva", "greenhouse:veeva")),
    ("Doximity", "healthtech", ("greenhouse:doximity",)),
    ("Zocdoc", "healthtech", ("greenhouse:zocdoc",)),
    ("Included Health", "healthtech", ("greenhouse:includedhealth",)),
    ("Transcarent", "healthtech", ("greenhouse:transcarent", "lever:transcarent")),
    ("K Health", "healthtech", ("greenhouse:khealth", "lever:khealth")),
    ("Sword Health", "healthtech", ("lever:swordhealth", "greenhouse:swordhealth")),
    ("Virta Health", "healthtech", ("greenhouse:virtahealth",)),
    ("Noom", "healthtech", ("greenhouse:noom", "lever:noom")),
    ("Carbon Health", "healthtech", ("greenhouse:carbonhealth", "lever:carbonhealth")),
    ("Talkiatry", "healthtech", ("greenhouse:talkiatry",)),
    ("Grow Therapy", "healthtech", ("greenhouse:growtherapy", "ashby:growtherapy")),
    ("Alma", "healthtech", ("greenhouse:helloalma", "ashby:alma")),
    ("Rula", "healthtech", ("greenhouse:rula", "ashby:rula")),
    ("Charlie Health", "healthtech", ("greenhouse:charliehealth",)),
    ("SonderMind", "healthtech", ("greenhouse:sondermind", "lever:sondermind")),
    ("Two Chairs", "healthtech", ("greenhouse:twochairs", "ashby:twochairs")),
    ("Thirty Madison", "healthtech", ("greenhouse:thirtymadison",)),
    ("Function Health", "healthtech", ("ashby:function", "greenhouse:functionhealth")),
    ("Levels", "healthtech", ("ashby:levels", "greenhouse:levelshealth")),
    ("Oura", "healthtech", ("greenhouse:ouraring", "lever:oura")),
    ("Eight Sleep", "healthtech", ("ashby:eightsleep", "lever:eightsleep")),
    ("Peloton", "healthtech", ("greenhouse:pelotoncycle",)),
    ("Datavant", "healthtech", ("greenhouse:datavant", "lever:datavant")),
    ("Truveta", "healthtech", ("greenhouse:truveta",)),
    ("Flatiron Health", "healthtech", ("greenhouse:flatironhealth",)),
    ("Color Health", "healthtech", ("greenhouse:color", "lever:color")),
    ("Cityblock Health", "healthtech", ("greenhouse:cityblockhealth",)),
    ("Redox", "healthtech", ("greenhouse:redoxengine", "lever:redoxengine")),

    # ---- dev tools / security / data infra
    ("Twilio", "dev-tools", ("greenhouse:twilio",)),
    ("Ping Identity", "security", ("greenhouse:pingidentity", "workday:pingidentity.wd1.myworkdayjobs.com")),
    ("CyberArk", "security", ("greenhouse:cyberark", "workday:cyberark.wd1.myworkdayjobs.com")),
    ("SailPoint", "security", ("workday:sailpoint.wd1.myworkdayjobs.com", "greenhouse:sailpoint")),
    ("Snyk", "security", ("greenhouse:snyk",)),
    ("Veracode", "security", ("greenhouse:veracode", "lever:veracode")),
    ("Semgrep", "security", ("greenhouse:semgrep", "ashby:semgrep")),
    ("Socket", "security", ("ashby:socket",)),
    ("Chainguard", "security", ("greenhouse:chainguard", "ashby:chainguard")),
    ("Orca Security", "security", ("greenhouse:orcasecurity",)),
    ("Sysdig", "security", ("greenhouse:sysdig",)),
    ("Aqua Security", "security", ("greenhouse:aquasecurity",)),
    ("Palo Alto Networks", "security", ("smartrec:PaloAltoNetworks2", "smartrec:paloaltonetworks", "smartrec:PaloAltoNetworks3")),
    ("Zscaler", "security", ("smartrec:zscaler", "greenhouse:zscaler")),
    ("Netskope", "security", ("greenhouse:netskope",)),
    ("Rapid7", "security", ("workday:rapid7.wd5.myworkdayjobs.com", "greenhouse:rapid7")),
    ("Tenable", "security", ("workday:tenable.wd12.myworkdayjobs.com", "greenhouse:tenable")),
    ("Qualys", "security", ("greenhouse:qualys", "workday:qualys.wd5.myworkdayjobs.com")),
    ("Arctic Wolf", "security", ("greenhouse:arcticwolf",)),
    ("Huntress", "security", ("greenhouse:huntress", "ashby:huntress")),
    ("SentinelOne", "security", ("greenhouse:sentinellabs", "greenhouse:sentinelone")),
    ("Proofpoint", "security", ("greenhouse:proofpoint", "workday:proofpoint.wd5.myworkdayjobs.com")),
    ("KnowBe4", "security", ("greenhouse:knowbe4",)),
    ("Dashlane", "security", ("greenhouse:dashlane",)),
    ("Twingate", "security", ("ashby:twingate", "greenhouse:twingate")),
    ("Expel", "security", ("greenhouse:expel",)),
    ("Material Security", "security", ("greenhouse:materialsecurity", "ashby:material")),
    ("Torq", "security", ("ashby:torq", "greenhouse:torq")),
    ("Secureframe", "security", ("greenhouse:secureframe", "ashby:secureframe")),
    ("Sonatype", "security", ("greenhouse:sonatype", "lever:sonatype")),
    ("Endor Labs", "security", ("greenhouse:endorlabs", "ashby:endorlabs")),
    ("Fastly", "infra", ("greenhouse:fastly",)),
    ("Akamai", "infra", ("workday:akamai.wd1.myworkdayjobs.com", "workday:akamai.wd5.myworkdayjobs.com")),
    ("Netlify", "infra", ("greenhouse:netlify", "ashby:netlify")),
    ("Fly.io", "infra", ("ashby:flyio", "greenhouse:flyio")),
    ("Railway", "infra", ("ashby:railway",)),
    ("DigitalOcean", "infra", ("greenhouse:digitalocean98", "greenhouse:digitalocean")),
    ("Vultr", "infra", ("greenhouse:vultr", "ashby:vultr")),
    ("Docker", "dev-tools", ("greenhouse:docker", "ashby:docker")),
    ("Harness", "dev-tools", ("greenhouse:harness", "lever:harness")),
    ("CircleCI", "dev-tools", ("greenhouse:circleci",)),
    ("Buildkite", "dev-tools", ("greenhouse:buildkite", "ashby:buildkite")),
    ("Gradle", "dev-tools", ("greenhouse:gradle",)),
    ("Cypress", "dev-tools", ("greenhouse:cypressio", "ashby:cypress")),
    ("BrowserStack", "dev-tools", ("greenhouse:browserstack",)),
    ("Sauce Labs", "dev-tools", ("greenhouse:saucelabs",)),
    ("QA Wolf", "dev-tools", ("ashby:qawolf",)),
    ("LogRocket", "dev-tools", ("greenhouse:logrocket", "lever:logrocket")),
    ("FullStory", "dev-tools", ("greenhouse:fullstory",)),
    ("Optimizely", "dev-tools", ("greenhouse:optimizely",)),
    ("PostHog", "dev-tools", ("ashby:posthog",)),
    ("Kong", "dev-tools", ("greenhouse:kong",)),
    ("Apollo GraphQL", "dev-tools", ("greenhouse:apollographql", "ashby:apollographql")),
    ("Hasura", "dev-tools", ("greenhouse:hasura", "ashby:hasura")),
    ("Clerk", "dev-tools", ("ashby:clerk",)),
    ("WorkOS", "dev-tools", ("greenhouse:workos", "ashby:workos")),
    ("Stytch", "dev-tools", ("greenhouse:stytch", "ashby:stytch")),
    ("Descope", "dev-tools", ("ashby:descope", "greenhouse:descope")),
    ("Mux", "dev-tools", ("greenhouse:mux",)),
    ("Cloudinary", "dev-tools", ("greenhouse:cloudinary",)),
    ("Telnyx", "dev-tools", ("greenhouse:telnyx",)),
    ("Sanity", "dev-tools", ("greenhouse:sanity", "ashby:sanity")),
    ("Contentful", "dev-tools", ("greenhouse:contentful",)),
    ("Solo.io", "dev-tools", ("greenhouse:soloioinc", "lever:solo")),
    ("Spectro Cloud", "dev-tools", ("greenhouse:spectrocloud", "lever:spectrocloud")),
    ("Octopus Deploy", "dev-tools", ("greenhouse:octopusdeploy",)),
    ("Spacelift", "dev-tools", ("ashby:spacelift",)),
    ("Redpanda", "data-infra", ("greenhouse:redpandadata",)),
    ("StarTree", "data-infra", ("greenhouse:startree", "lever:startree")),
    ("Imply", "data-infra", ("greenhouse:imply",)),
    ("Firebolt", "data-infra", ("greenhouse:firebolt", "ashby:firebolt")),
    ("SingleStore", "data-infra", ("greenhouse:singlestore",)),
    ("Yugabyte", "data-infra", ("greenhouse:yugabyte",)),
    ("PingCAP", "data-infra", ("greenhouse:pingcap", "ashby:pingcap")),
    ("Timescale", "data-infra", ("greenhouse:timescale", "ashby:timescale")),
    ("InfluxData", "data-infra", ("greenhouse:influxdata",)),
    ("Neo4j", "data-infra", ("greenhouse:neo4j",)),
    ("Redis", "data-infra", ("greenhouse:redislabs", "greenhouse:redis")),
    ("Elastic", "data-infra", ("greenhouse:elastic",)),
    ("Algolia", "data-infra", ("greenhouse:algolia",)),
    ("Dataiku", "data-infra", ("greenhouse:dataiku",)),
    ("Domino Data Lab", "data-infra", ("greenhouse:dominodatalab",)),
    ("DataRobot", "data-infra", ("greenhouse:datarobot",)),
    ("H2O.ai", "data-infra", ("greenhouse:h2oai", "lever:h2oai")),
    ("Tecton", "data-infra", ("greenhouse:tecton", "ashby:tecton")),
    ("Prefect", "data-infra", ("ashby:prefect", "greenhouse:prefect")),
    ("Dagster Labs", "data-infra", ("ashby:dagster", "greenhouse:dagsterlabs")),
    ("Astronomer", "data-infra", ("greenhouse:astronomer", "ashby:astronomer")),
    ("Temporal", "data-infra", ("greenhouse:temporaltechnologies", "ashby:temporal")),
    ("Superblocks", "dev-tools", ("ashby:superblocks",)),
    ("Paragon", "dev-tools", ("ashby:useparagon", "greenhouse:paragon")),
    ("New Relic", "observability", ("workday:newrelic.wd5.myworkdayjobs.com", "greenhouse:newrelic")),
    ("Dynatrace", "observability", ("smartrec:dynatrace1", "smartrec:dynatrace")),
    ("Sumo Logic", "observability", ("greenhouse:sumologic",)),
    ("Chronosphere", "observability", ("greenhouse:chronosphere", "ashby:chronosphere")),
    ("Observe Inc", "observability", ("greenhouse:observe", "lever:observe")),
    ("Axiom", "observability", ("ashby:axiom", "greenhouse:axiom")),
    ("Matillion", "data-infra", ("greenhouse:matillion",)),

    # ---- enterprise SaaS / collaboration / HR
    ("Zoom", "enterprise-saas", ("workday:zoom.wd5.myworkdayjobs.com/Zoom",)),
    ("RingCentral", "enterprise-saas", ("greenhouse:ringcentral", "workday:ringcentral.wd1.myworkdayjobs.com")),
    ("Five9", "enterprise-saas", ("workday:five9.wd1.myworkdayjobs.com", "greenhouse:five9")),
    ("Genesys", "enterprise-saas", ("workday:genesys.wd1.myworkdayjobs.com", "greenhouse:genesys")),
    ("Dialpad", "enterprise-saas", ("greenhouse:dialpad",)),
    ("Talkdesk", "enterprise-saas", ("greenhouse:talkdesk",)),
    ("HubSpot", "enterprise-saas", ("greenhouse:hubspotjobs", "greenhouse:hubspot")),
    ("Zendesk", "enterprise-saas", ("workday:zendesk.wd1.myworkdayjobs.com", "greenhouse:zendesk")),
    ("Freshworks", "enterprise-saas", ("smartrec:freshworks", "greenhouse:freshworks")),
    ("Help Scout", "enterprise-saas", ("greenhouse:helpscout", "ashby:helpscout")),
    ("Miro", "enterprise-saas", ("greenhouse:mirohq", "greenhouse:miro")),
    ("Lucid Software", "enterprise-saas", ("greenhouse:lucidsoftware",)),
    ("Egnyte", "enterprise-saas", ("greenhouse:egnyte", "lever:egnyte")),
    ("DocuSign", "enterprise-saas", ("workday:docusign.wd1.myworkdayjobs.com", "greenhouse:docusign")),
    ("PandaDoc", "enterprise-saas", ("greenhouse:pandadoc", "lever:pandadoc")),
    ("Workiva", "enterprise-saas", ("workday:workiva.wd1.myworkdayjobs.com", "greenhouse:workiva")),
    ("Anaplan", "enterprise-saas", ("workday:anaplan.wd1.myworkdayjobs.com", "greenhouse:anaplan")),
    ("Pigment", "enterprise-saas", ("ashby:pigment",)),
    ("Cube", "enterprise-saas", ("ashby:cube", "greenhouse:cubesoftware")),
    ("AngelList", "fintech", ("ashby:angellist",)),
    ("Pave", "enterprise-saas", ("ashby:pave", "greenhouse:pave")),
    ("Oyster", "enterprise-saas", ("greenhouse:oysterhr", "ashby:oyster")),
    ("Velocity Global", "enterprise-saas", ("greenhouse:velocityglobal",)),
    ("Paylocity", "enterprise-saas", ("workday:paylocity.wd1.myworkdayjobs.com", "greenhouse:paylocity")),
    ("Workday", "enterprise-saas", ("workday:workday.wd5.myworkdayjobs.com/Workday",)),
    ("UKG", "enterprise-saas", ("workday:ukg.wd5.myworkdayjobs.com", "workday:ukg.wd1.myworkdayjobs.com")),
    ("Dayforce", "enterprise-saas", ("workday:dayforce.wd1.myworkdayjobs.com", "workday:ceridian.wd5.myworkdayjobs.com")),
    ("Culture Amp", "enterprise-saas", ("greenhouse:cultureamp",)),
    ("15Five", "enterprise-saas", ("greenhouse:15five", "lever:15five")),
    ("Greenhouse Software", "enterprise-saas", ("greenhouse:greenhouse",)),
    ("SmartRecruiters", "enterprise-saas", ("smartrec:smartrecruiters", "greenhouse:smartrecruiters")),
    ("Gem", "enterprise-saas", ("greenhouse:gem", "ashby:gem")),
    ("SeekOut", "enterprise-saas", ("greenhouse:seekout",)),
    ("Eightfold AI", "enterprise-saas", ("greenhouse:eightfoldai",)),
    ("Phenom", "enterprise-saas", ("greenhouse:phenompeople",)),
    ("Checkr", "enterprise-saas", ("greenhouse:checkr",)),
    ("Fountain", "enterprise-saas", ("greenhouse:fountain", "lever:fountain")),
    ("Instawork", "consumer-marketplace", ("greenhouse:instawork", "lever:instawork")),
    ("Traba", "consumer-marketplace", ("ashby:traba",)),
    ("Guild", "enterprise-saas", ("greenhouse:guild", "greenhouse:guildeducation")),
    ("Handshake", "consumer-marketplace", ("greenhouse:joinhandshake",)),
    ("Motion", "enterprise-saas", ("ashby:motion",)),
    ("Clockwise", "enterprise-saas", ("greenhouse:clockwise", "ashby:clockwise")),
    ("Coursera", "consumer-marketplace", ("greenhouse:coursera",)),
    ("Udemy", "consumer-marketplace", ("greenhouse:udemy",)),
    ("Indeed", "consumer-marketplace", ("greenhouse:indeed",)),
    ("Glassdoor", "consumer-marketplace", ("greenhouse:glassdoor",)),
    ("ZipRecruiter", "consumer-marketplace", ("greenhouse:ziprecruiter",)),

    # ---- marketplaces / consumer
    ("Gopuff", "consumer-marketplace", ("lever:gopuff", "greenhouse:gopuff")),
    ("Grubhub", "consumer-marketplace", ("greenhouse:grubhubholdings", "greenhouse:grubhub")),
    ("Wonder", "consumer-marketplace", ("greenhouse:wonder", "lever:wonder")),
    ("ezCater", "consumer-marketplace", ("greenhouse:ezcater",)),
    ("Olo", "enterprise-saas", ("greenhouse:olo", "lever:olo")),
    ("Owner.com", "enterprise-saas", ("ashby:owner",)),
    ("ChowNow", "consumer-marketplace", ("greenhouse:chownow", "lever:chownow")),
    ("Slice", "consumer-marketplace", ("greenhouse:slice", "lever:slice")),
    ("OpenTable", "consumer-marketplace", ("greenhouse:opentable",)),
    ("SevenRooms", "enterprise-saas", ("greenhouse:sevenrooms",)),
    ("Yelp", "consumer-marketplace", ("greenhouse:yelp",)),
    ("Thumbtack", "consumer-marketplace", ("greenhouse:thumbtack",)),
    ("Angi", "consumer-marketplace", ("greenhouse:angi",)),
    ("Houzz", "consumer-marketplace", ("greenhouse:houzz", "lever:houzz")),
    ("Redfin", "consumer-marketplace", ("greenhouse:redfin",)),
    ("Zillow", "consumer-marketplace", ("workday:zillow.wd5.myworkdayjobs.com", "greenhouse:zillow")),
    ("Opendoor", "consumer-marketplace", ("greenhouse:opendoor",)),
    ("Compass", "consumer-marketplace", ("greenhouse:urbancompass", "lever:compass")),
    ("Apartment List", "consumer-marketplace", ("greenhouse:apartmentlist",)),
    ("Hopper", "consumer-marketplace", ("greenhouse:hopper", "lever:hopper")),
    ("Turo", "consumer-marketplace", ("greenhouse:turo",)),
    ("Lime", "consumer-marketplace", ("greenhouse:limebike", "lever:lime")),
    ("Via", "consumer-marketplace", ("greenhouse:via",)),
    ("Fetch", "consumer-marketplace", ("greenhouse:fetchrewards",)),
    ("Ibotta", "consumer-marketplace", ("greenhouse:ibotta",)),
    ("StubHub", "consumer-marketplace", ("greenhouse:stubhub", "greenhouse:stubhubholdings")),
    ("SeatGeek", "consumer-marketplace", ("greenhouse:seatgeek",)),
    ("Gametime", "consumer-marketplace", ("lever:gametime", "greenhouse:gametime")),
    ("Vivid Seats", "consumer-marketplace", ("greenhouse:vividseats",)),
    ("Etsy", "consumer-marketplace", ("greenhouse:etsy",)),
    ("Poshmark", "consumer-marketplace", ("lever:poshmark", "greenhouse:poshmark")),
    ("Mercari", "consumer-marketplace", ("greenhouse:mercari",)),
    ("ThredUp", "consumer-marketplace", ("greenhouse:thredup", "lever:thredup")),
    ("StockX", "consumer-marketplace", ("greenhouse:stockx",)),
    ("GOAT Group", "consumer-marketplace", ("greenhouse:goatgroup",)),
    ("Whatnot", "consumer-marketplace", ("greenhouse:whatnot", "ashby:whatnot")),
    ("OfferUp", "consumer-marketplace", ("greenhouse:offerup",)),
    ("Nextdoor", "consumer-marketplace", ("greenhouse:nextdoor",)),
    ("Chewy", "consumer-marketplace", ("workday:chewy.wd5.myworkdayjobs.com", "workday:chewy.wd1.myworkdayjobs.com")),
    ("Wayfair", "consumer-marketplace", ("greenhouse:wayfair",)),
    ("Rover", "consumer-marketplace", ("greenhouse:rover",)),
    ("Care.com", "consumer-marketplace", ("greenhouse:carecom",)),
    ("Zola", "consumer-marketplace", ("greenhouse:zola",)),
    ("Quora", "consumer-marketplace", ("ashby:quora",)),
    ("Substack", "consumer-marketplace", ("ashby:substack",)),
    ("Patreon", "consumer-marketplace", ("greenhouse:patreon",)),
    ("AllTrails", "consumer-marketplace", ("greenhouse:alltrails",)),
    ("Headspace", "healthtech", ("greenhouse:headspace",)),
    ("Twitch", "consumer-marketplace", ("greenhouse:twitch",)),
    ("Unity", "dev-tools", ("greenhouse:unity3d", "greenhouse:unitytechnologies")),
    ("Niantic", "consumer-marketplace", ("greenhouse:niantic",)),
    ("project44", "enterprise-saas", ("greenhouse:project44",)),
    ("FourKites", "enterprise-saas", ("greenhouse:fourkites", "lever:fourkites")),
    ("Samsara", "enterprise-saas", ("greenhouse:samsara",)),
    ("Motive", "enterprise-saas", ("greenhouse:gomotive",)),

    # ---- F500 tech / semis / space / defense
    ("Broadcom", "f500-tech", ("workday:broadcom.wd1.myworkdayjobs.com/External_Career",)),
    ("AMD", "f500-tech", ("workday:amd.wd1.myworkdayjobs.com/External", "workday:amd.wd1.myworkdayjobs.com")),
    ("Intel", "f500-tech", ("workday:intel.wd1.myworkdayjobs.com", "workday:intel.wd5.myworkdayjobs.com")),
    ("Micron", "f500-tech", ("workday:micron.wd1.myworkdayjobs.com", "workday:micron.wd5.myworkdayjobs.com")),
    ("Marvell", "f500-tech", ("workday:marvell.wd1.myworkdayjobs.com", "workday:marvell.wd5.myworkdayjobs.com")),
    ("Arm", "f500-tech", ("greenhouse:arm", "workday:arm.wd3.myworkdayjobs.com")),
    ("Analog Devices", "f500-tech", ("workday:analogdevices.wd1.myworkdayjobs.com", "workday:adi.wd1.myworkdayjobs.com")),
    ("NetApp", "f500-tech", ("workday:netapp.wd1.myworkdayjobs.com", "workday:netapp.wd5.myworkdayjobs.com")),
    ("Pure Storage", "f500-tech", ("greenhouse:purestorage",)),
    ("Nutanix", "f500-tech", ("workday:nutanix.wd1.myworkdayjobs.com", "workday:nutanix.wd5.myworkdayjobs.com")),
    ("Motorola Solutions", "f500-tech", ("workday:motorolasolutions.wd1.myworkdayjobs.com", "workday:motorolasolutions.wd5.myworkdayjobs.com")),
    ("HPE", "f500-tech", ("workday:hpe.wd5.myworkdayjobs.com", "workday:hpe.wd1.myworkdayjobs.com")),
    ("T-Mobile", "f500-tech", ("workday:tmobile.wd1.myworkdayjobs.com", "workday:tmobileusa.wd1.myworkdayjobs.com")),
    ("Disney", "f500-tech", ("workday:disney.wd5.myworkdayjobs.com/disneycareer", "workday:disney.wd5.myworkdayjobs.com", "radancy:jobs.disneycareers.com")),
    ("Warner Bros. Discovery", "f500-tech", ("workday:wbd.wd5.myworkdayjobs.com/global", "workday:warnerbros.wd5.myworkdayjobs.com")),
    ("Electronic Arts", "f500-tech", ("workday:ea.wd1.myworkdayjobs.com/EA_Careers", "greenhouse:electronicarts")),
    ("Sonos", "f500-tech", ("greenhouse:sonos",)),
    ("Roku", "f500-tech", ("greenhouse:roku",)),
    ("Best Buy", "f500-tech", ("workday:bestbuy.wd1.myworkdayjobs.com", "workday:bestbuy.wd5.myworkdayjobs.com")),
    ("Target", "f500-tech", ("workday:target.wd5.myworkdayjobs.com/targetcareers", "workday:target.wd5.myworkdayjobs.com")),
    ("Nike", "f500-tech", ("workday:nike.wd1.myworkdayjobs.com/nikecareers", "workday:nike.wd1.myworkdayjobs.com")),
    ("Starbucks", "f500-tech", ("workday:starbucks.wd1.myworkdayjobs.com", "workday:starbucks.wd5.myworkdayjobs.com")),
    ("United Airlines", "f500-tech", ("workday:unitedairlines.wd1.myworkdayjobs.com", "workday:ual.wd1.myworkdayjobs.com")),
    ("SpaceX", "defense", ("greenhouse:spacex",)),
    ("Blue Origin", "defense", ("workday:blueorigin.wd5.myworkdayjobs.com/BlueOrigin",)),
    ("Relativity Space", "defense", ("greenhouse:relativity",)),
    ("Vast", "defense", ("ashby:vast",)),
    ("Rivian", "f500-tech", ("workday:rivian.wd5.myworkdayjobs.com", "greenhouse:rivian")),

    # ---- expansion round 2 (2026-07-13): xlsx re-audit, market infrastructure,
    # credit bureaus, Chicago cluster, plus eightfold/radancy tenants verified
    # against the fetchers' own endpoints.
    ("Fidelity Investments", "fintech", ("workday:https://wd1.myworkdaysite.com/en-US/recruiting/fmr/FidelityCareers",)),
    ("Charles Schwab", "bank", ("workday:schwab.wd1.myworkdayjobs.com", "workday:charlesschwab.wd1.myworkdayjobs.com")),
    ("Morgan Stanley", "bank", ("eightfold:morganstanley.eightfold.ai|morganstanley.com",)),
    ("CME Group", "fintech-infra", ("workday:cmegroup.wd1.myworkdayjobs.com", "workday:cmegroup.wd5.myworkdayjobs.com")),
    ("Cboe Global Markets", "fintech-infra", ("workday:cboe.wd1.myworkdayjobs.com", "workday:cboe.wd5.myworkdayjobs.com")),
    ("Nasdaq", "fintech-infra", ("workday:nasdaq.wd1.myworkdayjobs.com/Global_External_Site", "workday:nasdaq.wd1.myworkdayjobs.com")),
    ("Intercontinental Exchange", "fintech-infra", ("workday:theice.wd5.myworkdayjobs.com", "workday:ice.wd5.myworkdayjobs.com")),
    ("DTCC", "fintech-infra", ("workday:dtcc.wd1.myworkdayjobs.com", "workday:dtcc.wd5.myworkdayjobs.com")),
    ("Broadridge", "fintech-infra", ("workday:broadridge.wd5.myworkdayjobs.com", "workday:broadridge.wd1.myworkdayjobs.com")),
    ("Morningstar", "fintech-infra", ("workday:morningstar.wd5.myworkdayjobs.com", "workday:morningstar.wd1.myworkdayjobs.com")),
    ("S&P Global", "fintech-infra", ("workday:spgi.wd5.myworkdayjobs.com", "workday:spglobal.wd5.myworkdayjobs.com")),
    ("Moody's", "fintech-infra", ("workday:moodys.wd4.myworkdayjobs.com", "workday:moodys.wd1.myworkdayjobs.com")),
    ("MSCI", "fintech-infra", ("workday:msci.wd1.myworkdayjobs.com", "workday:msci.wd5.myworkdayjobs.com")),
    ("Tradeweb", "fintech-infra", ("workday:tradeweb.wd1.myworkdayjobs.com", "workday:tradeweb.wd5.myworkdayjobs.com")),
    ("Experian", "fintech-infra", ("smartrec:experian",)),
    ("Equifax", "fintech-infra", ("workday:equifax.wd5.myworkdayjobs.com", "workday:equifax.wd1.myworkdayjobs.com")),
    ("TransUnion", "fintech-infra", ("workday:transunion.wd5.myworkdayjobs.com", "workday:transunion.wd1.myworkdayjobs.com")),
    ("FICO", "fintech-infra", ("workday:fico.wd1.myworkdayjobs.com", "workday:fico.wd5.myworkdayjobs.com")),
    ("Amount", "fintech-infra", ("greenhouse:amount",)),
    ("Enova", "fintech", ("greenhouse:enova",)),
    ("AlphaSense", "enterprise-saas", ("greenhouse:alphasense",)),
    ("Sprout Social", "enterprise-saas", ("greenhouse:sproutsocial",)),
    ("G2", "enterprise-saas", ("greenhouse:g2crowd",)),
    ("Qualcomm", "f500-tech", ("eightfold:careers.qualcomm.com|qualcomm.com",)),
    ("Boeing", "f500-tech", ("radancy:jobs.boeing.com",)),
    ("AT&T", "f500-tech", ("radancy:www.att.jobs",)),
    ("Verizon", "f500-tech", ("workday:verizon.wd12.myworkdayjobs.com", "workday:verizon.wd1.myworkdayjobs.com", "workday:verizon.wd5.myworkdayjobs.com")),
    ("Eli Lilly", "pharma", ("workday:lilly.wd5.myworkdayjobs.com", "workday:elilillyandcompany.wd5.myworkdayjobs.com")),
    ("Abbott", "healthtech", ("workday:abbott.wd5.myworkdayjobs.com/abbottcareers", "workday:abbott.wd5.myworkdayjobs.com")),
    ("AstraZeneca", "pharma", ("workday:astrazeneca.wd3.myworkdayjobs.com/Careers", "workday:astrazeneca.wd3.myworkdayjobs.com")),
    ("Takeda", "pharma", ("workday:takeda.wd3.myworkdayjobs.com/External", "workday:takeda.wd3.myworkdayjobs.com")),
    ("Walgreens", "f500-tech", ("workday:wba.wd3.myworkdayjobs.com/External", "workday:wba.wd3.myworkdayjobs.com", "workday:walgreens.wd5.myworkdayjobs.com")),
    ("McDonald's", "f500-tech", ("workday:mcdonalds.wd1.myworkdayjobs.com", "workday:mcd.wd1.myworkdayjobs.com")),
    ("Applied Materials", "f500-tech", ("workday:amat.wd1.myworkdayjobs.com/External", "workday:amat.wd1.myworkdayjobs.com")),
    ("Stryker", "healthtech", ("workday:stryker.wd1.myworkdayjobs.com", "workday:stryker.wd5.myworkdayjobs.com")),
    ("Cigna", "insurance", ("workday:cigna.wd5.myworkdayjobs.com", "workday:cigna.wd1.myworkdayjobs.com")),
    ("Marsh McLennan", "insurance", ("workday:mmc.wd1.myworkdayjobs.com", "workday:marshmclennan.wd1.myworkdayjobs.com")),
    ("First National Bank of Omaha", "bank", ("workday:firstnational.wd5.myworkdayjobs.com/fnbocareers",)),
    ("Johnson & Johnson", "pharma", ("workday:jj.wd5.myworkdayjobs.com/JJ",)),
]


# --------------------------------------------------------------- csv assembly

def _read_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def _existing_names() -> set[str]:
    """Names already covered elsewhere — never emit them here."""
    names = {r["name"].strip().casefold() for r in _read_rows(SEED) if r.get("name")}
    names |= {r["name"].strip().casefold() for r in _read_rows(BIGTECH_CSV) if r.get("name")}
    names |= BIGTECH_NAMES
    return names


def _load_state() -> dict:
    if STATE.exists():
        with STATE.open() as f:
            return json.load(f)
    return {"resolved": {}, "unresolved": {}}


def _save_state(state: dict) -> None:
    tmp = STATE.with_suffix(".tmp")
    with tmp.open("w") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    tmp.replace(STATE)


def _passthrough_rows() -> list[dict]:
    """candidates_resolved.csv rows, category joined from candidate_companies.csv."""
    cats = {r["name"].strip().casefold(): r.get("category", "")
            for r in _read_rows(CATEGORIES) if r.get("name")}
    rows = []
    for r in _read_rows(RESOLVED):
        name = (r.get("name") or "").strip()
        if not name:
            continue
        rows.append({"name": name, "ats": r["ats"].strip(), "slug": r["slug"].strip(),
                     "notes": cats.get(name.casefold(), "")})
    return rows


def _write_csv(rows: list[dict]) -> None:
    """Full deterministic rewrite — the csv IS the resolved checkpoint."""
    pri_used = 0
    out = []
    for r in sorted(rows, key=lambda r: (r["notes"], r["name"].casefold())):
        pri = "FALSE"
        if r["name"].casefold() in PRIORITY_NAMES and pri_used < PRIORITY_CAP:
            pri = "TRUE"
            pri_used += 1
        out.append([r["name"], r["ats"], r["slug"], "TRUE", "FALSE", pri, r["notes"]])
    with OUT.open("w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(HEADER)
        w.writerows(out)


# --------------------------------------------------------------- resolve cmd

def _work_items() -> list[tuple[str, str, tuple[str, ...]]]:
    items: dict[str, tuple[str, str, tuple[str, ...]]] = {}
    for name, cat, hints in CURATED:
        items[name.casefold()] = (name, cat, hints)
    # any unresolved-file names the curated list doesn't already cover
    for r in _read_rows(UNRESOLVED):
        name = (r.get("name") or "").strip()
        if name and name.casefold() not in items:
            items[name.casefold()] = (name, r.get("category", ""), ())
    # verified dead ends never re-probe; docs/companies-expansion.md lists them
    return [v for k, v in items.items() if k not in SKIP_KNOWN]


def _resolve_one(name: str, hints: tuple[str, ...]) -> tuple[str, str] | None:
    return resolve_hints(name, hints) or resolve_generic(name)


def cmd_resolve(workers: int, retry_unresolved: bool = False) -> int:
    state = _load_state()
    if retry_unresolved:
        state["unresolved"] = {}
    skip = _existing_names()
    passthrough = _passthrough_rows()
    pass_names = {r["name"].casefold() for r in passthrough}

    todo = []
    for name, cat, hints in _work_items():
        key = name.casefold()
        if key in skip or key in pass_names:
            continue
        if key in state["resolved"] or key in state["unresolved"]:
            continue
        todo.append((name, cat, hints))

    print(f"curated+unresolved to probe: {len(todo)}  "
          f"(cached resolved={len(state['resolved'])} unresolved={len(state['unresolved'])})",
          file=sys.stderr)

    lock = threading.Lock()
    done = 0

    def run(name: str, cat: str, hints: tuple[str, ...]):
        nonlocal done
        hit = _resolve_one(name, hints)
        with lock:
            done += 1
            if hit:
                ats, slug = hit
                state["resolved"][name.casefold()] = {
                    "name": name, "ats": ats, "slug": slug, "notes": cat}
                print(f"  [{done}/{len(todo)}] {name}: {ats}/{slug}", file=sys.stderr)
            else:
                reason = "hint+generic probes missed" if hints else "no standard ATS match"
                state["unresolved"][name.casefold()] = {"name": name, "notes": cat,
                                                        "reason": reason}
                print(f"  [{done}/{len(todo)}] {name}: UNRESOLVED", file=sys.stderr)
            if done % 10 == 0:
                _save_state(state)
                _write_csv(passthrough + list(state["resolved"].values()))

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(run, n, c, h) for n, c, h in todo]
        for f in as_completed(futs):
            f.result()

    _save_state(state)
    _write_csv(passthrough + list(state["resolved"].values()))
    new = len(state["resolved"])
    print(f"\nresolved(new)={new}  passthrough={len(passthrough)}  "
          f"unresolved={len(state['unresolved'])}  -> {OUT}", file=sys.stderr)
    return 0


# --------------------------------------------------------------- validate cmd

def cmd_validate(sample_frac: float) -> int:
    errs: list[str] = []
    with OUT.open() as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = [r for r in reader if any(c.strip() for c in r)]
    if header != HEADER:
        errs.append(f"header mismatch: {header}")

    seen: set[str] = set()
    others = _existing_names()
    pri = 0
    for i, r in enumerate(rows, 2):
        if len(r) != len(HEADER):
            errs.append(f"line {i}: {len(r)} cols")
            continue
        name, ats, slug, monitor, seeded, priority, _notes = r
        key = name.strip().casefold()
        if not name.strip() or not slug.strip():
            errs.append(f"line {i}: empty name/slug")
        if key in seen:
            errs.append(f"line {i}: duplicate name {name!r}")
        if key in others:
            errs.append(f"line {i}: {name!r} already in seed/bigtech")
        seen.add(key)
        if ats not in ALLOWED_ATS:
            errs.append(f"line {i}: bad ats {ats!r}")
        if ats == "workday" and not WD_RE.match(slug):
            errs.append(f"line {i}: bad workday slug {slug!r}")
        if monitor != "TRUE" or seeded != "FALSE":
            errs.append(f"line {i}: monitor/seeded flags {monitor}/{seeded}")
        if priority not in ("TRUE", "FALSE"):
            errs.append(f"line {i}: bad priority {priority!r}")
        pri += priority == "TRUE"
    if pri > PRIORITY_CAP:
        errs.append(f"priority=TRUE on {pri} rows (cap {PRIORITY_CAP})")

    n = max(1, round(len(rows) * sample_frac))
    sample = random.sample(rows, min(n, len(rows)))
    print(f"integrity: {len(rows)} rows, {pri} priority; re-probing {len(sample)} sampled rows",
          file=sys.stderr)
    for r in sample:
        name, ats, slug = r[0], r[1], r[2]
        if ats in PROBES:
            ok = PROBES[ats](slug) is not None
        elif ats == "workday":
            ok = probe_workday(slug)
        elif ats == "oraclehcm":
            ok = probe_oraclehcm(slug)
        elif ats == "eightfold":
            ok = probe_eightfold(slug)
        elif ats == "radancy":
            ok = probe_radancy(slug)
        else:
            ok = False
        print(f"  {name}: {ats}/{slug} -> {'OK' if ok else 'FAIL'}", file=sys.stderr)
        if not ok:
            errs.append(f"re-probe failed: {name} ({ats}/{slug})")

    if errs:
        print("\nVALIDATION FAILED:", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("validation OK", file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd")
    r = sub.add_parser("resolve")
    r.add_argument("--workers", type=int, default=8)
    r.add_argument("--retry-unresolved", action="store_true",
                   help="drop the unresolved cache and probe those names again")
    v = sub.add_parser("validate")
    v.add_argument("--sample", type=float, default=0.05)
    args = ap.parse_args()
    if args.cmd == "validate":
        return cmd_validate(args.sample)
    return cmd_resolve(getattr(args, "workers", 8),
                       getattr(args, "retry_unresolved", False))


if __name__ == "__main__":
    raise SystemExit(main())
