"""One-off (idempotent) history migration into Job Search HQ.

    python -m tracker.migrate [--legacy] [--scout-xlsx [PATH]] [--applog [PATH]] [--dry-run]

Three independent sources, each opt-in:
- --legacy      legacy Job Monitor sheet's Jobs tab -> feed (id becomes key verbatim,
                so monitor history and new captures converge on the same keys).
- --scout-xlsx  the scout's historical "Jobs Applied" workbook -> scout_jobs
                (his column layout, header row 4; only 2026 rows — older rows are
                a different search-season and would drown the tab).
- --applog      applications-log.csv (resume pipeline) -> pipeline rows,
                source=manual status=Applied applied_via=self.

Everything is idempotent by job key: a row whose key already exists on the
target tab is skipped, so re-running after a partial failure is always safe.
--dry-run prints per-source counts and writes nothing.
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import os
from pathlib import Path

from core import config, schema
from core import sheets
from core.jobkeys import job_key
from core.sheets import HQ

DEFAULT_XLSX = ("/Users/s0shaheen/Library/CloudStorage/"
                "GoogleDrive-shaheensalmant@gmail.com/My Drive/"
                "Job Search & Recruiting/Jobs Applied -Salman - Sample.xlsx")
DEFAULT_APPLOG = "applications/applications-log.csv"
DEFAULT_SCOUT_CSV = "tracker/data/scout-import.csv"
SCOUT_SINCE = _dt.date(2026, 1, 1)

# Legacy Jobs-tab header map, local on purpose: the legacy sheet is frozen
# history, so we pin what it looked like rather than track a live schema.
_LEGACY_COLS = ["id", "company", "title", "location", "url", "status",
                "first_seen", "last_seen", "posted",
                "yoe", "seniority", "company_industry", "role_focus",
                "skills", "comp_range", "work_model", "tagged_at"]


def _min_yoe(yoe: str) -> str:
    """monitor.tagging.min_yoe_from when it exists (built by the discovery
    agent); a missing helper degrades to blank, never an import error."""
    try:
        from monitor import tagging
        fn = getattr(tagging, "min_yoe_from", None)
        if fn is None:
            return ""
        v = fn(yoe)
        return "" if v in (None, "") else str(v)
    except Exception:
        return ""


# ------------------------------------------------------------------ legacy

def load_legacy_rows() -> list[dict]:
    legacy_id = (config.registry().get("drive") or {}).get("legacy_job_monitor_sheet", "")
    if not legacy_id:
        raise SystemExit("registry drive.legacy_job_monitor_sheet unset — nothing to migrate")
    ws = sheets._client().open_by_key(legacy_id).worksheet("Jobs")
    values = ws.get_all_values()
    if not values:
        return []
    hdr = [str(h).strip() for h in values[0]]
    pos = {c: hdr.index(c) for c in _LEGACY_COLS if c in hdr}
    out = []
    for raw in values[1:]:
        rec = {c: (str(raw[i]).strip() if i < len(raw) else "") for c, i in pos.items()}
        out.append(rec)
    return out


def migrate_legacy(hq: HQ, rows: list[dict], *, dry_run: bool = False) -> dict:
    feed = hq.tab("feed")
    have = set(feed.key_index())
    recs, skipped = [], 0
    for r in rows:
        key = (r.get("id") or "").strip()
        if not key or key in have:
            skipped += 1
            continue
        recs.append({
            schema.KEY: key,
            "company": r.get("company", ""), "title": r.get("title", ""),
            "location": r.get("location", ""), "url": r.get("url", ""),
            "status": r.get("status", ""),
            "first_seen": r.get("first_seen", ""), "last_seen": r.get("last_seen", ""),
            "posted": r.get("posted", ""),
            "yoe": r.get("yoe", ""), "seniority": r.get("seniority", ""),
            "company_industry": r.get("company_industry", ""),
            "role_focus": r.get("role_focus", ""), "skills": r.get("skills", ""),
            "comp_range": r.get("comp_range", ""), "work_model": r.get("work_model", ""),
            "tagged_at": r.get("tagged_at", ""),
            "min_yoe": _min_yoe(r.get("yoe", "")),
        })
        have.add(key)
    if not dry_run:
        feed.append_records(recs)
    return {"source_rows": len(rows), "appended": len(recs), "skipped": skipped}


# ------------------------------------------------------------- scout xlsx

def _norm_hdr(s) -> str:
    out, prev_sp = [], True
    for ch in str(s or "").casefold():
        if ch.isalnum():
            out.append(ch)
            prev_sp = False
        elif not prev_sp:
            out.append(" ")
            prev_sp = True
    return "".join(out).strip()


def _xlsx_header_map(cells: list) -> dict[int, str]:
    """xlsx column index -> scout_jobs schema header. His workbook headers carry
    noise ('Date Searched (mm/dd/yyyy)', 'Min Experience Required', missing
    spaces) so we match normalized-exact first, then prefix."""
    targets = [h for h in schema.HEADERS["scout_jobs"]
               if not h.startswith(schema.BOT) and h != "Applied"]
    norm_targets = [(_norm_hdr(t), t) for t in targets]
    out: dict[int, str] = {}
    taken: set[str] = set()
    for i, cell in enumerate(cells):
        n = _norm_hdr(cell)
        if not n:
            continue
        for nt, t in norm_targets:
            if t not in taken and (n == nt or n.startswith(nt + " ")):
                out[i] = t
                taken.add(t)
                break
    return out


def _parse_date(v) -> _dt.date | None:
    if isinstance(v, _dt.datetime):
        return v.date()
    if isinstance(v, _dt.date):
        return v
    s = str(v or "").strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return _dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, _dt.datetime):
        return v.date().isoformat()
    if isinstance(v, _dt.date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _scout_key(rec: dict) -> str:
    return job_key(url=rec.get("Job Link", ""), company=rec.get("Company", ""),
                   title=rec.get("Position", ""), location=rec.get("City", ""))


def _scout_rows_from_xlsx(path: str) -> tuple[list[dict], int]:
    """Normalized 2026 rows from the workbook (his columns + Applied=TRUE),
    plus the pre-2026 skip count. No HQ access — runs anywhere the file is."""
    import openpyxl
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True)["Jobs Applied"]
    rows = ws.iter_rows(min_row=4, values_only=True)
    hmap = _xlsx_header_map(list(next(rows)))
    recs, old = [], 0
    for raw in rows:
        rec = {h: _cell(raw[i]) if i < len(raw) else "" for i, h in hmap.items()}
        if not rec.get("Company", "").strip():
            continue
        d = _parse_date(_raw_date(raw, hmap))
        if d is None or d < SCOUT_SINCE:
            old += 1
            continue
        rec["Date Searched"] = d.isoformat()
        rec["Applied"] = "TRUE"
        recs.append(rec)
    return recs, old


def _append_scout(hq: HQ, recs: list[dict], *, dry_run: bool) -> dict:
    tab = hq.tab("scout_jobs")
    have = {k for k in (_scout_key(r) for r in tab.records()) if k}
    out, skipped = [], 0
    for rec in recs:
        key = _scout_key(rec)
        if not key or key in have:
            skipped += 1
            continue
        have.add(key)
        out.append(rec)
    if not dry_run:
        tab.append_records(out)
    return {"appended": len(out), "skipped_dup": skipped}


def migrate_scout_xlsx(hq: HQ, path: str, *, dry_run: bool = False) -> dict:
    if not os.path.exists(path):
        return {"missing": path, "appended": 0}
    recs, old = _scout_rows_from_xlsx(path)
    rep = _append_scout(hq, recs, dry_run=dry_run)
    rep["skipped_pre2026"] = old
    return rep


def export_scout_csv(xlsx_path: str, csv_path: str) -> dict:
    """Local, credential-free half of the scout migration: workbook -> a
    sanitized CSV (Jobs Applied rows only — the Preferences tab and anything
    sensitive never leaves the Mac). Commit the CSV; the runner imports it."""
    recs, old = _scout_rows_from_xlsx(xlsx_path)
    fields = [h for h in schema.HEADERS["scout_jobs"] if not h.startswith(schema.BOT)]
    Path(csv_path).parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(recs)
    return {"exported": len(recs), "skipped_pre2026": old, "csv": csv_path}


def migrate_scout_csv(hq: HQ, path: str, *, dry_run: bool = False) -> dict:
    if not os.path.exists(path):
        return {"missing": path, "appended": 0}
    with open(path, newline="") as f:
        recs = [dict(r) for r in csv.DictReader(f)]
    return _append_scout(hq, recs, dry_run=dry_run)


def _raw_date(raw: tuple, hmap: dict[int, str]):
    for i, h in hmap.items():
        if h == "Date Searched":
            return raw[i] if i < len(raw) else None
    return None


# ----------------------------------------------------------------- applog

def migrate_applog(hq: HQ, path: str, *, dry_run: bool = False) -> dict:
    """applications-log.csv is an event log (created/packaged/applied rows per
    slug); only the created row carries url+role, so we merge per slug before
    keying. Missing file (broken Drive symlink on a runner) is a clean no-op."""
    p = Path(path)
    if not p.is_absolute():
        p = config.REPO_ROOT / p
    try:
        with open(p, newline="") as f:
            rows = list(csv.DictReader(f))
    except OSError:
        return {"missing": str(p), "appended": 0}

    slugs: dict[str, dict] = {}
    for r in rows:
        slug = (r.get("slug") or "").strip()
        if not slug:
            continue
        a = slugs.setdefault(slug, {"company": "", "role": "", "url": "", "events": []})
        for f in ("company", "role", "url"):
            if not a[f] and (r.get(f) or "").strip():
                a[f] = r[f].strip()
        a["events"].append(((r.get("event") or "").strip(), (r.get("timestamp") or "").strip()))

    pipe = hq.tab("pipeline")
    have = set(pipe.key_index())
    recs, skipped, unkeyed = [], 0, 0
    for slug, a in slugs.items():
        ts = sorted(t for e, t in a["events"] if e in ("applied", "packaged"))
        if not ts:
            continue
        key = job_key(url=a["url"]) if a["url"] else job_key(company=a["company"], title=a["role"])
        if not key:
            unkeyed += 1
            continue
        if key in have:
            skipped += 1
            continue
        have.add(key)
        recs.append({
            schema.KEY: key, "company": a["company"], "title": a["role"],
            "url": a["url"], "source": "manual", "status": "Applied",
            "applied_via": "self", "applied_date": ts[0][:10],
        })
    if not dry_run:
        pipe.append_records(recs)
    return {"slugs": len(slugs), "appended": len(recs),
            "skipped_dup": skipped, "unkeyed": unkeyed}


# ------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tracker.migrate",
                                 description="Import legacy history into HQ (opt-in per source).")
    ap.add_argument("--legacy", action="store_true", help="legacy Job Monitor sheet -> feed")
    ap.add_argument("--scout-xlsx", nargs="?", const=DEFAULT_XLSX, default=None,
                    metavar="PATH", help="scout workbook -> scout_jobs")
    ap.add_argument("--scout-csv", nargs="?", const=DEFAULT_SCOUT_CSV, default=None,
                    metavar="PATH", help="sanitized scout CSV (see --export-scout-csv) -> scout_jobs")
    ap.add_argument("--export-scout-csv", nargs="?", const=DEFAULT_SCOUT_CSV, default=None,
                    metavar="OUT", help="LOCAL: workbook -> sanitized CSV; no credentials, no sheet access")
    ap.add_argument("--applog", nargs="?", const=DEFAULT_APPLOG, default=None,
                    metavar="PATH", help="applications-log.csv -> pipeline")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if args.export_scout_csv:
        rep = export_scout_csv(args.scout_xlsx or DEFAULT_XLSX, args.export_scout_csv)
        print("[migrate] export_scout_csv: " + "  ".join(f"{k}={v}" for k, v in rep.items()))
        if not (args.legacy or args.scout_csv or args.applog):
            return 0

    if not (args.legacy or args.scout_xlsx or args.scout_csv or args.applog):
        ap.error("pick at least one source: --legacy / --scout-xlsx / --scout-csv / --applog")

    hq = HQ.open()
    reports: dict[str, dict] = {}
    if args.legacy:
        reports["legacy"] = migrate_legacy(hq, load_legacy_rows(), dry_run=args.dry_run)
    if args.scout_xlsx and not args.export_scout_csv:
        reports["scout_xlsx"] = migrate_scout_xlsx(hq, args.scout_xlsx, dry_run=args.dry_run)
    if args.scout_csv:
        reports["scout_csv"] = migrate_scout_csv(hq, args.scout_csv, dry_run=args.dry_run)
    if args.applog:
        reports["applog"] = migrate_applog(hq, args.applog, dry_run=args.dry_run)

    prefix = "DRY RUN " if args.dry_run else ""
    for src, rep in reports.items():
        print(f"[migrate] {prefix}{src}: " + "  ".join(f"{k}={v}" for k, v in rep.items()))
    if not args.dry_run:
        hq.log("migrate", "run", detail="; ".join(f"{s}:{r}" for s, r in reports.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
