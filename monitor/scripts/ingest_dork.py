"""ATS-dorking ingestion — mine pre-resolved board slugs from web-search results.

The 4th free discovery source (after EDGAR, Form ADV, and Common Crawl). A site-scoped web
search — `site:boards.greenhouse.io "Chicago" (treasury OR "FP&A")`, `site:jobs.ashbyhq.com
Chicago`, `site:jobs.lever.co Chicago` — returns board URLs whose first path segment IS a
company's ATS board slug. Each hit is therefore a *pre-resolved* Tier-1 candidate:
`jobs.lever.co/<slug>` maps 1:1 to a company that runs Lever, exactly the way
`boards.greenhouse.io/<slug>` does for Common Crawl. No name->slug resolution step is needed;
the slug is the canonical identity, so `name`/`category` ship empty.

Host -> ATS (the ONLY board hosts we trust; the marketing sites www.greenhouse.io /
www.lever.co / www.ashbyhq.com are deliberately NOT board hosts and never match):

    boards.greenhouse.io/<slug>, job-boards.greenhouse.io/<slug>   -> greenhouse
    jobs.ashbyhq.com/<slug>                                        -> ashby
    jobs.lever.co/<slug>                                           -> lever

We keep only the FIRST path segment as the slug and drop the structural tails a real board URL
carries — `/jobs/<id>`, `/<posting-uuid>`, `/apply`, the `embed` first-segment, and the bare
host — then dedupe by (ats, slug). Point-in-time caveat identical to Common Crawl: a search
index can surface a STALE board (404s today); confirming each slug against the live ATS API is
the downstream resolver's job (`monitor.discover` / the fetchers), NOT this ingester's — we
emit candidates, the resolver validates them.

The search backend is INJECTABLE (`search: (query) -> [url, ...]`) so it is testable and
swappable: unit tests inject canned result URLs; the default hits DuckDuckGo's keyless HTML
endpoint via `requests` (no key, no secret — the "free" in "4th free source"). A paid or
agent-driven search can be dropped in without touching the extraction core. Fail-loud parity
with Common Crawl: zero board slugs across every dork means the backend is blocked or broken,
so a `strict` run raises rather than reporting an empty universe as success.

Run:  python -m monitor.scripts.ingest_dork [--csv] [--query Q ...]
"""
from __future__ import annotations

import csv
import re
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import unquote

import requests

SOURCE = "dork"
TIMEOUT = 30
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# The only hosts whose first path segment is a company board slug. Marketing hosts
# (www.greenhouse.io, www.lever.co, www.ashbyhq.com) are intentionally absent — a hit there
# is a corporate site, not a board, and must not seed a slug.
_HOST_ATS: dict[str, str] = {
    "job-boards.greenhouse.io": "greenhouse",
    "boards.greenhouse.io": "greenhouse",
    "jobs.ashbyhq.com": "ashby",
    "jobs.lever.co": "lever",
}
# Hosts longest-first so `job-boards.greenhouse.io` is tried before `boards.greenhouse.io`
# (the `^https?://` anchor already forbids the shorter one from matching the longer host, but
# ordering keeps the intent obvious).
_HOSTS_ALT = "|".join(re.escape(h) for h in sorted(_HOST_ATS, key=len, reverse=True))
# ^scheme://<board-host>/<rest>. A trailing `/` after the host is required, so a bare host
# (no path) never matches — exactly the "drop bare-host" rule.
_URL_RE = re.compile(rf"^https?://({_HOSTS_ALT})/(.*)$", re.I)
# A real board slug: leading alphanumeric, then alphanumerics / dash / underscore / dot.
_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")
# First path segments that are structural, never a company slug.
_NON_SLUG = {"embed", "jobs"}

# Default backend (DuckDuckGo): harvest any board URL out of the url-decoded results HTML.
# Stops at the first delimiter DDG can wrap a link in (`&`, quotes, angle brackets, space).
_HARVEST_RE = re.compile(rf"https?://(?:{_HOSTS_ALT})/[^\s\"'<>)&]*", re.I)
DDG_HTML_URL = "https://html.duckduckgo.com/html/"

# Site-scoped dorks (validated in research). Chicago / finance-flavoured to match the
# EDGAR + Form ADV "dad's corporate universe" focus; override with --query for a wider net.
DEFAULT_QUERIES: tuple[str, ...] = (
    'site:boards.greenhouse.io "Chicago" (treasury OR "FP&A")',
    'site:job-boards.greenhouse.io "Chicago" (treasury OR "FP&A")',
    "site:jobs.ashbyhq.com Chicago",
    "site:jobs.lever.co Chicago",
)

# A search backend: given a dork query, return the result URLs (order preserved).
SearchFn = Callable[[str], list[str]]


def ats_slug_from_url(url: str) -> tuple[str, str] | None:
    """Extract (ats, slug) from a board result URL, or None if it isn't a board URL.

    Maps the host to its ATS; keeps only the FIRST path segment as the slug; URL-decodes an
    encoded leading space ("%20forbes" -> "forbes", a real search-result artifact); strips the
    query string, fragment, and any trailing `/jobs/<id>` `/<uuid>` `/apply`; case-folds; and
    rejects structural first segments (`embed`, `jobs`) and the bare host. Splitting on the raw
    "/" *before* decoding is deliberate — decoding first could let an encoded slash forge a
    path boundary.
    """
    if not url:
        return None
    m = _URL_RE.match(url.strip())
    if not m:
        return None
    ats = _HOST_ATS[m.group(1).lower()]
    rest = m.group(2).split("?", 1)[0].split("#", 1)[0]       # drop query / fragment
    first = unquote(rest.split("/", 1)[0]).strip().lower()    # first path segment, decoded
    if not first or first in _NON_SLUG:
        return None
    return (ats, first) if _SLUG_RE.fullmatch(first) else None


def candidates_from_urls(urls: Iterable[str]) -> list[dict]:
    """Board result URLs -> DEDUPED pre-resolved candidate dicts, first-seen order.

    Non-board URLs (marketing pages, unrelated hosts, junk) extract to nothing and are skipped
    — a real search legitimately mixes them in, so skipping is robustness, not a guess. The
    dedup key is (ats, slug): the same slug string on two ATS families is two distinct boards,
    so both survive.
    """
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for url in urls:
        hit = ats_slug_from_url(url or "")
        if not hit or hit in seen:
            continue
        seen.add(hit)
        ats, slug = hit
        out.append({"name": "", "source": SOURCE, "category": "", "ats": ats, "slug": slug})
    return out


def search_duckduckgo(query: str, session: requests.Session | None = None) -> list[str]:
    """Default keyless backend: POST the dork to DuckDuckGo's HTML endpoint, harvest board URLs.

    DDG wraps result links in `/l/?uddg=<percent-encoded>` redirects, so we URL-decode the whole
    response once and regex-scan for board hosts — robust to DDG markup changes, since we never
    parse its result structure, only harvest the board URLs it echoes. Each harvested URL is
    re-validated by `ats_slug_from_url` downstream, so a loose harvest cannot forge a bad slug.
    A non-2xx (rate-limit / block) raises rather than silently returning nothing.
    """
    session = session or requests.Session()
    r = session.post(DDG_HTML_URL, data={"q": query}, timeout=TIMEOUT,
                     headers={"User-Agent": _UA})
    r.raise_for_status()
    return _HARVEST_RE.findall(unquote(r.text or ""))


def run_searches(search: SearchFn, queries: Iterable[str]) -> list[str]:
    """Run each dork through `search` and concatenate the result URLs (order preserved)."""
    urls: list[str] = []
    for q in queries:
        urls.extend(search(q))
    return urls


def candidates(search: SearchFn | None = None, *,
               queries: Iterable[str] = DEFAULT_QUERIES,
               session: requests.Session | None = None,
               strict: bool = True) -> list[dict]:
    """Mine pre-resolved ATS board slugs from web-search dorks as candidate rows.

    `search(query) -> [url, ...]` is the injectable backend (default: keyless DuckDuckGo).
    Returns one dict per distinct (ats, slug):

        {"name": "", "source": "dork", "category": "", "ats": <ats>, "slug": <slug>}

    With `strict` (the default), zero slugs across every dork raises — a healthy board-host
    dork always returns some, so zero means the backend is blocked or broken, and (Common Crawl
    parity) we refuse to report an empty universe as success. Pass `strict=False` for a
    deliberately narrow query set where zero is a legitimate result.
    """
    backend = search
    if backend is None:
        sess = session or requests.Session()

        def backend(q: str) -> list[str]:
            return search_duckduckgo(q, sess)

    rows = candidates_from_urls(run_searches(backend, queries))
    if strict and not rows:
        raise RuntimeError(
            "ATS-dork search returned zero board slugs — search backend blocked or broken; "
            "refusing to report an empty universe as success.")
    return rows


def write_csv(rows: list[dict], path: Path) -> None:
    """Write candidate rows to `path` with the standard ingest header (LF line endings)."""
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["name", "source", "category", "ats", "slug"])
        for r in rows:
            w.writerow([r["name"], r["source"], r["category"], r["ats"], r["slug"]])


def main(argv: list[str] | None = None) -> int:
    import argparse

    p = argparse.ArgumentParser(
        description="Mine pre-resolved ATS board slugs from web-search dorks "
                    "(greenhouse / ashby / lever).")
    p.add_argument("--query", action="append", dest="queries", metavar="Q",
                   help="dork to run (repeatable); default: the built-in Chicago/finance set")
    p.add_argument("--csv", action="store_true",
                   help=f"also write monitor/candidates_{SOURCE}.csv")
    args = p.parse_args(argv)

    queries = tuple(args.queries) if args.queries else DEFAULT_QUERIES
    rows = candidates(queries=queries)

    by_ats: dict[str, int] = {}
    for r in rows:
        by_ats[r["ats"]] = by_ats.get(r["ats"], 0) + 1
    breakdown = ", ".join(f"{k}={v}" for k, v in sorted(by_ats.items()))
    print(f"{SOURCE}: {len(rows)} distinct board slugs ({breakdown})")
    print("first 10:")
    for r in rows[:10]:
        print(f"  {r['ats']}/{r['slug']}")

    if args.csv:
        out = Path(__file__).resolve().parent.parent / f"candidates_{SOURCE}.csv"
        write_csv(rows, out)
        print(f"wrote {len(rows)} rows -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
