"""Common Crawl slug mining — bulk-extract Greenhouse board slugs from the CC index.

Each Greenhouse board slug IS a pre-resolved Tier-1 company: `boards.greenhouse.io/<slug>`
maps 1:1 to a company that runs Greenhouse. We query the keyless, public Common Crawl CDX
index for every captured `boards.greenhouse.io/*` URL, extract the `<slug>` path segment,
and dedupe. The result feeds the discovery universe as already-resolved
`{ats: greenhouse, slug: <slug>}` rows — no name->slug resolution step is needed, so unlike
name-only sources these are Tier-1 the moment they land.

Point-in-time caveat: Common Crawl is a web snapshot, so some mined slugs are STALE (the
board 404s today). Confirming each slug against the live Greenhouse jobs API is the
downstream resolver's job (see `monitor/fetchers/greenhouse.py` / `monitor.discover`), NOT
this ingester's — we emit candidates, the resolver validates them. We therefore leave
`name`/`category` empty: Common Crawl exposes no human company name, and the slug is the
canonical identity here.

Keyless endpoints:
  - index:  https://index.commoncrawl.org/collinfo.json     (crawls, newest first)
  - cdx:    <cdx-api>?url=boards.greenhouse.io/*&output=json&limit=N

Run:  python -m monitor.scripts.ingest_commoncrawl [--limit N] [--csv]
"""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote

import requests

SOURCE = "commoncrawl"
TIMEOUT = 60
COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json"
# The legacy greenhouse board host. job-boards.greenhouse.io (the current redirect target)
# shares the same slug namespace; `slug_from_url` already parses both, so a caller can add
# "job-boards.greenhouse.io/*" for wider coverage — the default stays the validated one.
DEFAULT_PATTERNS: tuple[str, ...] = ("boards.greenhouse.io/*",)
DEFAULT_LIMIT = 1000
_UA = "job-hq-ingest/1.0 (+https://github.com/s0shaheen/job-hq)"

# boards.greenhouse.io/<slug>[/jobs/<id>][?query]  OR  job-boards.greenhouse.io/<slug>...
_BOARD_RE = re.compile(r"^https?://(?:job-)?boards\.greenhouse\.io/(.*)$", re.I)
# A real board slug: leading alphanumeric, then alphanumerics / dash / underscore / dot.
_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")
# First path segments that are structural, never a company slug.
_NON_SLUG = {"embed", "jobs"}


def slug_from_url(url: str) -> str | None:
    """Extract the Greenhouse board slug from a CDX capture URL, or None if it isn't one.

    Handles both `boards.` and `job-boards.greenhouse.io`; URL-decodes an encoded leading
    space ("%20forbes" -> "forbes", a real artifact in the crawl); strips the query string
    and any trailing `/jobs/<id>`; case-folds; and rejects structural first segments
    (`embed`, `jobs`) and the bare host. Splitting on the raw "/" *before* decoding is
    deliberate — decoding first could let an encoded slash forge a path boundary.
    """
    if not url:
        return None
    m = _BOARD_RE.match(url.strip())
    if not m:
        return None
    rest = m.group(1).split("?", 1)[0].split("#", 1)[0]      # drop query / fragment
    first = unquote(rest.split("/", 1)[0]).strip().lower()   # first path segment, decoded
    if not first or first in _NON_SLUG:
        return None
    return first if _SLUG_RE.fullmatch(first) else None


def slugs_from_cdx_lines(lines: Iterable[str]) -> list[str]:
    """Parse newline-delimited CDX JSON records into DEDUPED slugs, first-seen order.

    Blank lines, non-JSON lines, and records that carry no board slug are skipped — the CDX
    stream legitimately mixes in bare-host and embed captures, and skipping a junk line is
    robustness, not a guess. A *systemically* bad response (e.g. an HTML error page) parses
    to zero slugs, which the caller surfaces as a fail-loud condition rather than silently
    reporting an empty universe.
    """
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        slug = slug_from_url(rec.get("url", "") or "")
        if slug and slug not in seen:
            seen.add(slug)
            out.append(slug)
    return out


def latest_cdx_api(session: requests.Session) -> str:
    """The `cdx-api` endpoint of the most recent Common Crawl index (collinfo.json[0]).

    collinfo.json lists crawls newest-first; each entry's `cdx-api` is its query endpoint.
    Fail loud if the list is empty or the entry lacks `cdx-api` — we never guess an index id.
    """
    r = session.get(COLLINFO_URL, timeout=TIMEOUT, headers={"User-Agent": _UA})
    r.raise_for_status()
    info = r.json()
    if not isinstance(info, list) or not info:
        raise RuntimeError(f"collinfo.json returned no collections: {str(info)[:120]!r}")
    cdx = info[0].get("cdx-api") if isinstance(info[0], dict) else None
    if not cdx:
        raise RuntimeError(f"most-recent collection has no cdx-api: {str(info[0])[:160]!r}")
    return cdx


def fetch_cdx_page(cdx_api: str, pattern: str, session: requests.Session,
                   limit: int = DEFAULT_LIMIT, page: int | None = None) -> list[str]:
    """GET one page of CDX JSON records for `pattern`; return the raw text lines.

    A 404 is the CDX "No Captures found" signal — a legitimate empty result for this pattern,
    not an error — so it yields []. Any other non-2xx fails loud via raise_for_status.
    """
    params = {"url": pattern, "output": "json", "limit": str(limit)}
    if page is not None:
        params["page"] = str(page)
    r = session.get(cdx_api, params=params, timeout=TIMEOUT, headers={"User-Agent": _UA})
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return r.text.splitlines()


def candidates(session: requests.Session | None = None, *,
               cdx_api: str | None = None,
               patterns: Iterable[str] = DEFAULT_PATTERNS,
               limit: int = DEFAULT_LIMIT) -> list[dict]:
    """Mine distinct Greenhouse board slugs from Common Crawl as pre-resolved candidates.

    Returns one dict per distinct slug, each already resolved to a board:

        {"name": "", "source": "commoncrawl", "category": "",
         "ats": "greenhouse", "slug": <slug>}

    `name`/`category` are empty by design (see module docstring). Fails loud if the query
    yields zero slugs — a healthy Greenhouse-board query always returns some — so a broken
    or changed endpoint cannot masquerade as "no companies found".
    """
    session = session or requests.Session()
    cdx_api = cdx_api or latest_cdx_api(session)
    seen: set[str] = set()
    ordered: list[str] = []
    for pattern in patterns:
        for slug in slugs_from_cdx_lines(fetch_cdx_page(cdx_api, pattern, session, limit=limit)):
            if slug not in seen:
                seen.add(slug)
                ordered.append(slug)
    if not ordered:
        raise RuntimeError(
            "Common Crawl returned zero Greenhouse slugs — endpoint down or query changed; "
            "refusing to report an empty universe as success.")
    return [
        {"name": "", "source": SOURCE, "category": "", "ats": "greenhouse", "slug": slug}
        for slug in ordered
    ]


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
        description="Mine pre-resolved Greenhouse board slugs from the Common Crawl index.")
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                   help=f"CDX rows to request per host pattern (default {DEFAULT_LIMIT})")
    p.add_argument("--csv", action="store_true",
                   help=f"also write monitor/candidates_{SOURCE}.csv")
    args = p.parse_args(argv)

    session = requests.Session()
    cdx_api = latest_cdx_api(session)
    rows = candidates(session, cdx_api=cdx_api, limit=args.limit)

    print(f"{SOURCE}: {len(rows)} distinct greenhouse slugs (index {cdx_api})")
    print("first 10 slugs:")
    for r in rows[:10]:
        print(f"  greenhouse/{r['slug']}")

    if args.csv:
        out = Path(__file__).resolve().parent.parent / f"candidates_{SOURCE}.csv"
        write_csv(rows, out)
        print(f"wrote {len(rows)} rows -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
