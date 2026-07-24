"""Ingest candidate company names from SEC EDGAR full-text search.

Free, keyless source for the discovery universe: every public company with an
Illinois business address that has filed a 10-K or DEF 14A. This is "dad's
corporate universe" — established IL public filers — fed in as plain company
NAMES for the resolver (monitor.discover) to turn into ATS board slugs later.
EDGAR yields no board slug, so these land as un-resolved Tier-2 candidates.

Source of truth: the EDGAR full-text search API (`efts.sec.gov/LATEST/search-index`).
Company identities live under `hits.hits[]._source.display_names`, a LIST whose
entries look like:

    "AAR CORP  (AIR)  (CIK 0000001750)"              # name + ticker + CIK
    "Veradigm Inc.  (CIK 0001124804)"                # no ticker
    "Viskase Holdings, Inc.  (ENZN, ENZND)  (CIK ..)"  # multiple tickers

`clean_name` strips the trailing "(TICKER)"/"(CIK …)" parenthetical groups SEC
appends, leaving the entity's own name. A single filing can carry several
registrants (securitization trusts / funding LLCs co-file), so we flatten every
display_names entry and dedupe case-insensitively across pages and forms — the
raw feed repeats a company on every filing and lists shared co-registrants many
times over.

KEYLESS but SEC rejects requests without a descriptive User-Agent (403). Every
request here carries `UA` below; keep it descriptive and contactable.

Paginate with `from`/`size` (SEC caps deep paging at from+size <= 10000, far
beyond our few-hundred-name cap). Both forms get their own budget so proxy-only
filers (no 10-K) still surface.

Run:
    python -m monitor.scripts.ingest_edgar            # count + first ~10 names
    python -m monitor.scripts.ingest_edgar --csv      # + write monitor/candidates_edgar.csv
    python -m monitor.scripts.ingest_edgar --max 500  # raise the name cap
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

import requests

SOURCE = "edgar"
CATEGORY = "il-public-filer"

BASE_URL = "https://efts.sec.gov/LATEST/search-index"
# SEC requires a descriptive, contactable User-Agent on every request or it 403s.
UA = "job-hq ingest shaheensalmant@gmail.com"
FORMS = ("10-K", "DEF 14A")
LOCATION = "IL"
PAGE_SIZE = 100
DEFAULT_MAX = 300
# EDGAR full-text search refuses from+size beyond 10000; a hard stop long before
# our name cap is ever reached, kept as a guard so a bad total can't loop forever.
DEEP_CAP = 10000
TIMEOUT = 30

_TRAILING_PAREN = re.compile(r"\s*\([^()]*\)\s*$")


def clean_name(raw: str) -> str:
    """Strip the trailing "(TICKER)" / "(CIK …)" groups SEC appends to a filer name.

    Repeatedly removes trailing parenthetical groups (a filing may carry both a
    ticker group and the CIK group, or a multi-ticker group) but never strips the
    name down to nothing — if a strip would empty it, the last non-empty form is
    kept, so we never emit a blank candidate.
    """
    name = (raw or "").strip()
    while True:
        stripped = _TRAILING_PAREN.sub("", name)
        if stripped == name or not stripped.strip():
            break
        name = stripped
    return name.strip()


def parse_page(payload: dict) -> list[str]:
    """Clean company names from one EDGAR search page, in order, dupes preserved.

    Flattens every entry of each hit's `display_names` (co-filed registrants
    included); deduping is the caller's job so it can span pages and forms.
    """
    names: list[str] = []
    hits = ((payload or {}).get("hits") or {}).get("hits") or []
    for hit in hits:
        src = hit.get("_source") or {}
        for raw in src.get("display_names") or []:
            nm = clean_name(raw)
            if nm:
                names.append(nm)
    return names


def _page_total(payload: dict) -> int:
    """Total matching filings reported by EDGAR for the query (0 if absent)."""
    try:
        return int(payload["hits"]["total"]["value"])
    except (KeyError, TypeError, ValueError):
        return 0


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "application/json"})
    return s


def _fetch_page(session: requests.Session, form: str, location: str,
                frm: int, size: int) -> dict:
    params = {"q": "", "forms": form, "locationCodes": location,
              "from": frm, "size": size}
    resp = session.get(BASE_URL, params=params, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def candidates(session: requests.Session | None = None,
               forms: tuple[str, ...] = FORMS, location: str = LOCATION,
               max_names: int = DEFAULT_MAX, page_size: int = PAGE_SIZE) -> list[dict]:
    """Candidate IL public-filer companies from EDGAR, deduped across pages/forms.

    Returns [{name, source:"edgar", category:"il-public-filer"}], first-seen order.
    Each form gets its own share of the cap so a form with many filings can't
    starve the others (proxy-only filers still surface).
    """
    session = session or _session()
    seen: set[str] = set()
    out: list[dict] = []
    per_form = max(1, max_names // max(1, len(forms)))
    for form in forms:
        added = 0
        frm = 0
        while added < per_form and len(out) < max_names:
            payload = _fetch_page(session, form, location, frm, page_size)
            page_names = parse_page(payload)
            if not page_names:
                break  # no more hits for this form
            for nm in page_names:
                key = nm.casefold()
                if key in seen:
                    continue
                seen.add(key)
                out.append({"name": nm, "source": SOURCE, "category": CATEGORY})
                added += 1
                if added >= per_form or len(out) >= max_names:
                    break
            frm += page_size
            if frm >= _page_total(payload) or frm >= DEEP_CAP:
                break  # exhausted the result set (or hit EDGAR's deep-paging cap)
    return out


def _write_csv(rows: list[dict], path: Path) -> None:
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "source", "category", "ats", "slug"])
        for r in rows:
            w.writerow([r["name"], r.get("source", SOURCE),
                        r.get("category", ""), r.get("ats", ""), r.get("slug", "")])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Ingest IL public-company filers from SEC EDGAR full-text search.")
    ap.add_argument("--max", type=int, default=DEFAULT_MAX,
                    help=f"max distinct company names to collect (default {DEFAULT_MAX})")
    ap.add_argument("--csv", action="store_true",
                    help="also write monitor/candidates_edgar.csv")
    args = ap.parse_args(argv)

    rows = candidates(max_names=args.max)
    print(f"edgar: {len(rows)} candidate IL public filers", file=sys.stderr)
    for r in rows[:10]:
        print("  " + r["name"])
    if args.csv:
        out = Path(__file__).resolve().parent.parent / "candidates_edgar.csv"
        _write_csv(rows, out)
        print(f"wrote {len(rows)} rows -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
