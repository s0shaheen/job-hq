"""Ingest Illinois registered investment advisers (RIAs) from SEC Form ADV.

The SEC publishes the authoritative roster of SEC-registered investment advisers
as a monthly FOIA compilation: one `.zip` wrapping a single CSV, one row per firm
across the ~448 Form ADV columns (firm name, CRD#, regulatory AUM, main-office
address, ...). This module downloads the current month's file, keeps the firms
whose **main office is in Illinois**, and emits their primary business names as
company-discovery candidates. A later stage resolves each plain name to an ATS
board via `monitor.discover`; Form ADV yields no board slug, so these ship
unresolved (no `ats`/`slug`).

Source index page (always links the newest monthly file):
  https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers

The per-file URL shifts monthly as `ia<MMDDYY>.zip`; `IA_URL` below pins the
current file (May 1 2026 roster). When it 404s, refresh it from the index page
above — that is the one hand-maintained knob here, kept explicit on purpose
rather than guessed from today's date (fail loud, never guess).

SEC returns HTTP 403 to automated clients that don't declare a descriptive
User-Agent carrying a contact address, so `USER_AGENT` is required, not optional.

    candidates() -> [{name, source: "formadv", category: "il-ria"}]   # IL only

Run `python -m monitor.scripts.ingest_formadv` for a live count + sample; pass
`--write` to also emit `monitor/candidates_formadv.csv`.
"""
from __future__ import annotations
import csv
import io
import sys
import zipfile
from pathlib import Path

import requests

SOURCE = "formadv"
CATEGORY = "il-ria"
STATE = "IL"

# Current monthly FOIA compilation (registered advisers; the `-exempt.zip` sibling
# is the Exempt Reporting Advisers set, deliberately excluded). The SEC index page
# always links the newest `ia<MMDDYY>.zip`; when this 404s, refresh it from there.
IA_URL = (
    "https://www.sec.gov/files/investment/data/other/"
    "information-about-registered-investment-advisers-exempt-reporting-advisers/"
    "ia050126.zip"
)
# SEC blocks automated access without a real UA + contact; this is a hard requirement.
USER_AGENT = "job-hq company-discovery (shaheensalmant@gmail.com)"

NAME_COL = "Primary Business Name"
STATE_COL = "Main Office State"
TIMEOUT = 90

ROOT = Path(__file__).resolve().parent.parent
OUT_CSV = ROOT / "candidates_formadv.csv"


def parse_csv(text: str) -> list[dict]:
    """Firm-roster CSV text -> IL-only candidate dicts, de-duplicated by name.

    Fails loud if either column we depend on is absent: the SEC changing its
    header is a stop-the-line event, never a silent empty run (the discovery
    durability contract — a missing required header aborts, it does not guess).

    The Form ADV header carries embedded newlines and commas inside quoted
    fields, so parsing goes through `csv` over a file-like object, never a naive
    line split.
    """
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []
    missing = [c for c in (NAME_COL, STATE_COL) if c not in headers]
    if missing:
        raise ValueError(
            f"Form ADV CSV missing expected column(s) {missing}; got {len(headers)} "
            f"columns. The SEC header layout may have changed — refuse to guess."
        )

    out: list[dict] = []
    seen: set[str] = set()
    for row in reader:
        if (row.get(STATE_COL) or "").strip().upper() != STATE:
            continue
        name = (row.get(NAME_COL) or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "source": SOURCE, "category": CATEGORY})
    return out


def fetch_csv_text(session: requests.Session | None = None, url: str = IA_URL) -> str:
    """Download the monthly zip and return the decoded CSV text inside it.

    The SEC layout is exactly one CSV per zip; anything else is unexpected and
    aborts rather than silently picking one.
    """
    session = session or requests.Session()
    resp = session.get(url, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        members = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if len(members) != 1:
            raise ValueError(
                f"expected exactly one CSV in {url}, found {members or zf.namelist()}"
            )
        return zf.read(members[0]).decode("utf-8", errors="replace")


def candidates(session: requests.Session | None = None) -> list[dict]:
    """Illinois SEC-registered investment advisers as discovery candidates.

    Each dict: {name, source: "formadv", category: "il-ria"}. No ats/slug — Form
    ADV is a plain-name source; slug resolution is a downstream step.
    """
    return parse_csv(fetch_csv_text(session))


def _write_csv(rows: list[dict], path: Path = OUT_CSV) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "source", "category", "ats", "slug"])
        for r in rows:
            w.writerow([
                r.get("name", ""), r.get("source", ""), r.get("category", ""),
                r.get("ats", ""), r.get("slug", ""),
            ])


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    rows = candidates()
    print(f"formadv: {len(rows)} Illinois RIA candidates")
    for r in rows[:10]:
        print(f"  - {r['name']}")
    if "--write" in argv:
        _write_csv(rows)
        print(f"wrote {len(rows)} rows -> {OUT_CSV.relative_to(ROOT.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
