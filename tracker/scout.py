"""Sync the scout's tab: advisory flags in, applied rows out, daily counts.

The scout (a trusted human assistant) works entirely in their own columns — the historical
headers, his muscle memory. The bot NEVER writes a column without the "· "
prefix; it only annotates (dup / do-not-apply / validation / min_yoe) and
harvests rows he marked Applied into the Pipeline. Bot columns are recomputed
every run — they are state readouts, not history — but a row is only written
when something actually changed, so ✔-and-forget rows stay quiet.

Rows are addressed by their Job Link cell (the only usable identity on this
tab); a link pasted twice is a SchemaAnomaly — loud, actionable, no writes.
Rows without a link can't be addressed at all, so they get no flags (they do
still count toward the daily totals).
"""
from __future__ import annotations

import datetime as _dt
import re
import sys

from core import jobkeys, schema
from core.sheets import HQ, SchemaAnomaly, today

_TRUTHY = {"true", "yes", "y", "1", "x", "on", "✓", "✔"}
_DATE_FMTS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y")


def _truthy(v: str) -> bool:
    return (v or "").strip().casefold() in _TRUTHY


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def _digits(v) -> str:
    m = re.search(r"\d+", str(v or ""))
    return m.group(0) if m else ""


def _date_part(raw: str, fallback: str) -> str:
    """The scout types dates however he types them; normalize what we can."""
    tok = (raw or "").strip().split(" ")[0]
    for fmt in _DATE_FMTS:
        try:
            return _dt.datetime.strptime(tok, fmt).date().isoformat()
        except ValueError:
            pass
    return fallback


def _dna_hit(company: str, dna: list[str]) -> str:
    c = (company or "").casefold()
    for name in dna or []:
        if name.casefold() in c:
            return company
    return ""


def _bot_values(row: dict, key: str, pstatus: dict[str, str], dna: list[str]) -> dict:
    B = schema.BOT
    missing = [f for f in ("Company", "Position", "Job Link") if not (row.get(f) or "").strip()]
    hit = _dna_hit(row.get("Company", ""), dna)
    return {
        B + "min_yoe": _digits(row.get("Min Experience", "")),
        B + "duplicate": f"⚠ already in Pipeline ({pstatus[key]})" if key in pstatus else "",
        B + "do_not_apply": f"⚠ {hit} matches the do-not-apply list" if hit else "",
        B + "validation": ("missing: " + ", ".join(missing)) if missing else "",
    }


def _rewrite_daily(hq: HQ, day_rows: list[list[str]]) -> None:
    """scout_daily is bot-only: rewrite the whole body under the intact header,
    padding with blank rows so a shrinking dataset leaves no stale tail."""
    tab = hq.tab("scout_daily")
    header = schema.HEADERS["scout_daily"]
    old_body = max(len(tab.ws.get_all_values()) - 1, 0)
    grid = [list(header)] + [list(r) for r in day_rows]
    for _ in range(old_body - len(day_rows)):
        grid.append([""] * len(header))
    tab.ws.update(grid, "A1", value_input_option="RAW")


def run(hq: HQ, *, cfg=None) -> dict:
    cfg = cfg or hq.user_config()
    dna = cfg.get("dna_companies") or []
    scout = hq.tab("scout_jobs")
    pipeline = hq.tab("pipeline")
    B = schema.BOT
    rows = scout.records()

    links = [(r.get("Job Link") or "").strip() for r in rows if (r.get("Job Link") or "").strip()]
    dups = sorted({u for u in links if links.count(u) > 1})
    if dups:   # Job Link is the row key here — duplicates make writes ambiguous
        raise SchemaAnomaly(f"[scout_jobs] duplicate Job Link rows {dups[:3]} — "
                            "remove the duplicates; no writes attempted")

    pstatus = {r["key"]: (r.get("status") or "").strip()
               for r in pipeline.records() if (r.get("key") or "").strip()}
    counts = {"synced": 0, "applied_created": 0, "applied_backfilled": 0}
    daily: dict[str, list[int]] = {}   # date -> [jobs, applied, dup_flagged]

    for r in rows:
        link = (r.get("Job Link") or "").strip()
        applied = _truthy(r.get("Applied", ""))
        dup_flag = (r.get(B + "duplicate") or "").strip()   # for no-link daily counts

        if link:
            key = jobkeys.job_key(link, r.get("Company", ""), r.get("Position", ""),
                                  r.get("City", ""))
            desired = _bot_values(r, key, pstatus, dna)
            dup_flag = desired[B + "duplicate"]
            changed = any((r.get(h) or "").strip() != v for h, v in desired.items())
            if changed or not (r.get(B + "synced_at") or "").strip():
                scout.set_by_key(link, {**desired, B + "synced_at": _now()},
                                 key_header="Job Link")
                counts["synced"] += 1

            if applied:
                a_date = _date_part(r.get("Date Searched", ""), today())
                if key not in pstatus:
                    loc = ", ".join(p for p in ((r.get("City") or "").strip(),
                                                (r.get("State") or "").strip()) if p)
                    pipeline.append_records([{
                        "key": key,
                        "company": r.get("Company", ""),
                        "title": r.get("Position", ""),
                        "url": link,
                        "location": loc,
                        "source": "scout",
                        "status": "Applied",
                        "applied_via": "scout",
                        "applied_email": "alt",
                        "applied_date": a_date,
                        "comp": r.get("Salary Range", ""),
                        "contact": r.get("Contact", ""),
                        "min_yoe": desired[B + "min_yoe"],
                        "last_activity": a_date,
                    }])
                    pstatus[key] = "Applied"
                    counts["applied_created"] += 1
                    hq.log("scout", "applied_created", key, r.get("Company", ""))
                else:   # his row explains an existing entry — fill blanks only
                    pipeline.set_by_key(key, {"applied_via": "scout",
                                              "applied_email": "alt",
                                              "applied_date": a_date},
                                        only_if_blank=True)
                    counts["applied_backfilled"] += 1
                    hq.log("scout", "applied_backfilled", key, r.get("Company", ""))

        raw_date = (r.get("Date Searched") or "").strip()
        if raw_date:
            day = _date_part(raw_date, raw_date)
            bucket = daily.setdefault(day, [0, 0, 0])
            bucket[0] += 1
            bucket[1] += 1 if applied else 0
            bucket[2] += 1 if dup_flag else 0

    _rewrite_daily(hq, [[d, str(j), str(a), str(f)]
                        for d, (j, a, f) in sorted(daily.items())])
    return counts


def main() -> int:
    import traceback
    from core import notify
    try:
        counts = run(HQ.open())
    except Exception as e:
        print(f"[scout] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("tracker/scout failed", str(e)[:300])
        return 1
    print(f"[scout] {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
