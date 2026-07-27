"""One-time (idempotent) seed: the sheet's Companies tab -> the pg universe.

    python -m monitor.seed_universe [--dry-run]

SHEET-SUNSET Phase A/B bridge work: pg `companies` starts empty, and Phase B
(the sweep reading `swept_companies`) is impossible until the 644 sheet-era
companies exist there with the operator subscribed. Rows ride the SAME
hardened path every other universe write takes — `discover_universe.run`
(normalized dedup, board-identity collisions, reconcile-before-upsert) — so
this module adds no second write path, only a mapping:

  sheet (name, ats, slug, monitor, priority)
    -> candidate {name, ats, slug, source: "sheet-seed"}   [ats+slug present]
    -> skipped + counted                                    [unresolved rows]

then subscribes HQ_PG_USER_ID to every seeded company: review_state='approved'
(these ARE the human-curated universe — the sheet was the approval), monitor
from the sheet's own column. Re-runs are merge-duplicates end to end.
"""
from __future__ import annotations

import os
import sys

from core import pg
from core.companykeys import company_name_key
from core.sheets import HQ
from monitor import discover_universe


def sheet_candidates(rows: list[dict]) -> tuple[list[dict], int]:
    """Companies-tab rows -> pre-resolved candidates; unresolved rows counted, not guessed."""
    out, skipped = [], 0
    for r in rows:
        name = (r.get("name") or "").strip()
        ats = (r.get("ats") or "").strip().lower()
        slug = (r.get("slug") or "").strip()
        if not name:
            continue
        if not (ats and slug):
            skipped += 1          # Tier-2/manual territory; seeding must not invent boards
            continue
        out.append({"name": name, "ats": ats, "slug": slug, "source": "sheet-seed"})
    return out, skipped


def subscribe(user_id: str, rows: list[dict], *, monitor_by_key: dict[str, bool],
              priority_by_key: dict[str, bool], session=None) -> int:
    """user_companies rows for every seeded company, keyed back by normalized identity."""
    have = pg.select("companies", "select=id,name,ats,slug", session=session)
    by_key = {(company_name_key(c["name"]), c["ats"], c["slug"]): c["id"] for c in have}
    subs = []
    for r in rows:
        k = (company_name_key(r["name"]), r["ats"], r["slug"])
        cid = by_key.get(k)
        if cid is None:
            continue             # collision-dropped upstream; already warned there
        subs.append({"user_id": user_id, "company_id": cid,
                     "review_state": "approved",
                     "monitor": monitor_by_key.get(k[0], True),
                     "priority": priority_by_key.get(k[0], False)})
    if subs:
        pg.upsert("user_companies", subs, on_conflict="user_id,company_id", session=session)
    return len(subs)


def main() -> int:
    dry = "--dry-run" in sys.argv[1:]
    if not pg.enabled():
        print("::warning title=seed skipped::SUPABASE_URL/SUPABASE_SERVICE_KEY unset")
        return 0
    user_id = os.environ.get("HQ_PG_USER_ID", "")
    if not user_id:
        print("[seed] HQ_PG_USER_ID unset — need the owner's users.id", file=sys.stderr)
        return 1
    hq = HQ.open()
    rows = hq.tab("companies").records()
    cands, skipped = sheet_candidates(rows)
    truthy = ("true", "yes", "1", "x", "✓")
    monitor_by_key = {company_name_key(r["name"]): str(r.get("monitor", "")).strip().lower() in truthy
                     for r in rows if (r.get("name") or "").strip()}
    priority_by_key = {company_name_key(r["name"]): str(r.get("priority", "")).strip().lower() in truthy
                      for r in rows if (r.get("name") or "").strip()}
    print(f"[seed] sheet rows={len(rows)} candidates={len(cands)} unresolved_skipped={skipped}")
    if dry:
        return 0
    counts = discover_universe.run(cands, user_id=user_id)
    n_subs = subscribe(user_id, cands, monitor_by_key=monitor_by_key,
                       priority_by_key=priority_by_key)
    print(f"[seed] {counts} subscribed={n_subs}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
