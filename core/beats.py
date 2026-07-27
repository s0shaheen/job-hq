"""Heartbeats in the second store — SHEET-SUNSET Phase C1.

The sheet's beats are Config rows (`heartbeat_<lane>` holding a timestamp,
upserted by `core.sheets.HQ.heartbeat`) and the daily digest reads them to say
which jobs have gone quiet. Phase D takes the Config tab away, so the beats need
a pg home before the watchdog loses its eyes — this is that home.

NO NEW TABLE. `channel_runs` (0001) is already the health ledger, and its own
column comment names these exact lanes: "monitor|priority|wide-cafe|theirstack|
review|capture|digest|selfheal". A beat is one row; liveness is the newest
`ran_at` for a lane. The alternative — a `heartbeats` table with one row per lane
upserted in place — would have been a second health table with no history, next
to a health table with history and nothing in it.

APPEND, never upsert, for the reason the table is shaped that way: "when did this
last run" is answerable from an append-only log and "how often did it run last
week" is not answerable from an upserted cell. The cost is one row per lane per
run, which for the three lanes here is under 1100 rows a year.

`LANES` is declared HERE rather than at the call sites, and `write()` refuses a
lane that is not in it. The reason is the two-lane doctrine one level up: the
digest's watchdog iterates this same tuple, so a lane cannot start writing a pg
beat without the watchdog starting to watch it. A beat nobody watches is worse
than no beat — it looks like coverage.
"""
from __future__ import annotations

import datetime as _dt

from core.pgwrites import uid as _uid

#: The lanes with a pg heartbeat, and the ONLY lanes the watchdog expects one from.
#:
#: Pinned EQUAL to `tracker.digest.PG_CADENCE_HOURS` by a test, because the invariant
#: this file claimed was already broken when it was written: `digest` wrote a beat that
#: the watchdog never iterated. A tuple that is only a subset is a list of lanes some of
#: which are watched, which is the coverage-that-isn't this comment warns about.
#:
#: The lanes here are pg's OWN health, not a copy of the sheet's cadence table. `pgdump`
#: is in it and has no sheet beat at all: under `first_class` the store is what the system
#: depends on, and it is the store's backup that must not be able to die quietly.
LANES = ("snapshot", "snapshot_s3", "digest", "pgdump")

_TABLE = "channel_runs"


def write(lane: str, user_id: str, *, session=None) -> None:
    """Append this lane's beat. Raises on failure — the caller is first_class."""
    if lane not in LANES:
        raise ValueError(
            f"{lane!r} has no pg heartbeat lane — add it to core.beats.LANES so "
            f"tracker.digest's watchdog watches it, or it dies unnoticed")
    from core import pg
    pg.insert(_TABLE, [{"user_id": _uid(user_id), "channel": lane,
                        "detail": {"source": "engine"}}], session=session)


def last_seen(user_id: str, lanes=LANES, *, session=None) -> dict[str, _dt.datetime | None]:
    """Newest `ran_at` per lane, or None for a lane that has never beaten.

    One request per lane with `limit=1`, rather than one request for everything
    and a newest-wins pass in Python. A single windowed request needs a row cap,
    and the lane a cap would drop is precisely the DEAD one — its last beat is the
    oldest row in the table. Three exact requests once a day is the cheaper
    mistake.
    """
    from core import pg
    uid = _uid(user_id)
    out: dict[str, _dt.datetime | None] = {}
    for lane in lanes:
        rows = pg.select(
            _TABLE,
            f"select=ran_at&user_id=eq.{uid}&channel=eq.{lane}&order=ran_at.desc&limit=1",
            session=session)
        out[lane] = _parse(rows[0].get("ran_at", "")) if rows else None
    return out


def _parse(raw: str) -> _dt.datetime | None:
    """PostgREST timestamptz -> aware datetime, or None.

    Postgres renders `+00:00` as `+00` on its own, which `fromisoformat` refused
    before 3.11 and still refuses for the 6-digit-microsecond form some drivers
    emit. Widening the suffix here is cheaper than being wrong about it: an
    unparseable beat reads as "never beaten", which warns — the safe direction.
    """
    s = str(raw or "").strip().replace("Z", "+00:00")
    if len(s) > 3 and s[-3] in "+-" and s[-2:].isdigit():
        s += ":00"                        # '+00' -> '+00:00'
    try:
        ts = _dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=_dt.timezone.utc)
