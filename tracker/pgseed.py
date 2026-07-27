"""One-time (idempotent) seed: the sheet's Pipeline tab -> pg `applications`.

    python -m tracker.pgseed [--dry-run]

The twin of `monitor.seed_universe`, for the other half of the store. Phase C's
event lane can only create an application when an email arrives about it, and most
applications have already received every email they are ever going to get — so
without this, flipping `HQ_PG_WRITES=first_class` leaves the store's pipeline empty
of everything the sheet already holds, and every event about those rows answers
`no_application` (recorded pg-side as an `email.unapplied` event; this is what
drains them).

Dispatchable, never scheduled — `seed_universe`'s posture, for the same reason: it
is a bridge, run deliberately, and re-running it is free.

WHAT IT WILL NOT DO. A Pipeline row whose key names no `postings` row cannot be
seeded: `applications.posting_key` is a foreign key, and a NULL-keyed row would be
a twin the event lane could never match — the next real email would mint a SECOND
application for the same job. Those rows are counted and NAMED in the summary
instead. Today that is a handful of pre-Feed rows plus the weak `norm-` keys the
fuzzy matcher mints; both are honest gaps, not guesses.

The reconcile rules (blanks only, forward-only status, the app's claim untouched,
the sheet's claim carried across once) live in SQL — `hq_upsert_sheet_application`
in 0015 — for `hq_apply_email_event`'s reason: a copy of them here would be a copy
that disagrees with the 0010 trigger the day one of them is edited.
"""
from __future__ import annotations

import sys

from core import pg, pgwrites
from core.sheets import HQ

#: 0015. Named, so `tests/core/test_migrations.py` can prove it exists with these
#: parameters rather than discovering the typo as a 404 mid-seed.
PG_SEED_FN = "hq_upsert_sheet_application"

#: The Pipeline columns that mean something in `applications`. Everything else on
#: that tab (min_yoe, comp, priority, resume_version, contact, stale) is sheet-side
#: working state with no column here — listing what DOES cross is how a future
#: schema change gets noticed instead of silently dropping a field.
SEED_COLUMNS = ("company", "title", "url", "source", "status", "status_actor",
                "suggested_status", "evidence", "applied_date", "applied_via",
                "applied_email", "last_activity", "next_action", "next_action_date",
                "notes")

#: Every outcome `hq_upsert_sheet_application` can return. Pinned against the
#: migration's own literals by `tests/core/test_migrations.py`, and an outcome
#: outside it RAISES rather than being counted — the same rule the event lane
#: applies, for the same reason: an answer nobody recognises is not a seeded row.
PG_SEED_OUTCOMES = ("created", "updated", "unchanged", "no_posting")

_SAMPLE = 10


def payload(row: dict) -> dict:
    """One Pipeline row -> the jsonb the SQL reconciler reads."""
    return {c: str(row.get(c) or "").strip() for c in SEED_COLUMNS}


def seed(rows: list[dict], user_id: str, *, session=None) -> dict:
    """Reconcile every keyed Pipeline row. Returns counts, the keys it could not
    seed, and the rows that ERRORED.

    A per-row RPC rather than a bulk upsert, deliberately: the decision each row
    needs (does the app already hold this? is it claimed? is the sheet's status
    forward?) is a read-then-write that must not be split, which is the whole
    reason `hq_upsert_sheet_application` exists. 141 rows is a one-off cost paid by
    a job nobody schedules.

    ONE BAD ROW DOES NOT END THE SEED. Row-level refusals are a normal outcome of
    reconciling a hand-edited spreadsheet — a status of `Offer-Accepted` typed into
    the Pipeline with the actor dropdown left blank is refused by the SQL, and
    that is the rule working. Aborting on it stopped the run partway through, with
    an error naming no row, so the operator learned neither which row was wrong nor
    how much of the pipeline had been seeded. Now every row is attempted, the
    failures are collected WITH their keys, and `main` reports them all and exits
    nonzero: a partial seed is a failure, and it has to read as one.

    The catch is deliberately broad. A refusal from Postgres arrives as a driver
    exception whose type depends on which check fired, and the caller's job here is
    to attribute it to a row rather than to classify it.
    """
    counts = {o: 0 for o in PG_SEED_OUTCOMES}
    unseedable: list[str] = []
    failed: list[dict] = []
    for r in rows:
        key = str(r.get("key") or "").strip()
        if not key:
            continue
        try:
            res = pg.rpc(PG_SEED_FN, {"p_user_id": user_id, "p_posting_key": key,
                                      "p_row": payload(r)}, session=session) or {}
            outcome = str(res.get("outcome", ""))
            if outcome not in counts:
                # Still refused, still not counted — but attributed to the row that
                # produced it and no longer able to abandon the other 140.
                raise RuntimeError(
                    f"{PG_SEED_FN} returned an outcome this version does not "
                    f"understand: {outcome!r}")
        except Exception as e:
            failed.append({"key": key, "error": f"{type(e).__name__}: {e}"[:300]})
            print(f"[pgseed] {key} FAILED: {type(e).__name__}: {e}", file=sys.stderr)
            continue
        counts[outcome] += 1
        if outcome == "no_posting":
            unseedable.append(key)
    return {"counts": counts, "unseedable": unseedable, "failed": failed}


def main() -> int:
    dry = "--dry-run" in sys.argv[1:]
    # The same gate every other store write goes through, so a half-configured run
    # refuses here instead of writing one user's pipeline into another's lanes.
    if not pgwrites.first_class():
        print(f"[pgseed] {pgwrites.FLAG_ENV} is not {pgwrites.FIRST_CLASS} — the store "
              f"is not the engine's to write yet; nothing seeded", file=sys.stderr)
        return 0
    hq = HQ.open()
    rows = [r for r in hq.tab("pipeline").records() if str(r.get("key") or "").strip()]
    print(f"[pgseed] {len(rows)} keyed Pipeline rows", file=sys.stderr)
    if dry:
        return 0
    out = seed(rows, pgwrites.user_id())
    c = out["counts"]
    print(f"[pgseed] created={c['created']} updated={c['updated']} "
          f"unchanged={c['unchanged']} no_posting={c['no_posting']}", file=sys.stderr)
    if out["unseedable"]:
        # NAMED, not just counted. "18 rows could not be seeded" is a number nobody
        # can act on; the keys say which applications have no pg twin and why —
        # they name no posting, so nothing here may invent one.
        keys = out["unseedable"]
        print(f"::warning title=HQ pgseed skipped {len(keys)} row(s)::"
              f"their keys name no mirrored posting, so `applications.posting_key` "
              f"(a foreign key) has nothing to point at: "
              f"{', '.join(keys[:_SAMPLE])}{'…' if len(keys) > _SAMPLE else ''}")
    if out["failed"]:
        # EVERY failed row, not a sample: the point of surviving the first failure is
        # that the operator gets the whole list in one pass instead of discovering
        # them one re-run at a time. Bounded by the size of the Pipeline tab.
        for f in out["failed"]:
            print(f"::error title=HQ pgseed row failed::{f['key']}: {f['error']}")
        print(f"[pgseed] {len(out['failed'])} row(s) FAILED and were not seeded: "
              f"{', '.join(f['key'] for f in out['failed'])}", file=sys.stderr)
        # Nonzero, so the dispatch reports failure and the ops push fires. A seed
        # that skipped rows is a seed that did not do its job, and a partial
        # success that exits 0 is how the residue becomes permanent.
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
