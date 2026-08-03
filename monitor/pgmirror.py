"""Feed -> Postgres mirror (Phase-2 dual-write, entry: python -m monitor.pgmirror).

Strangler stage 2: the sheet remains the system of record; this mirror
copies the Feed into the v2 store (postings + user_postings) so the web app
has real data to render read-only. It is IDEMPOTENT (PostgREST upserts keyed
on postings.key / user_postings pk) and safe to run any time. Once the app
carries daily triage, truth flips and the sheet becomes the export — this
module is the bridge, not the destination.

Runs as the tail step of the `monitor` job (infra/app/handler.py) during the
Phase-A soak. Under `HQ_PG_WRITES=first_class` (core/pgwrites.py) the same pass
is performed by the sweep itself — `monitor.run` calls `mirror()` before its
heartbeat, so a store failure fails the sweep — and this entry point stands
down rather than upserting the same Feed a second time. Absent SUPABASE_* env
-> loud skip.
"""
from __future__ import annotations

import sys

import datetime as _dt
import re

from core import pg, pgwrites, schema

TAG_FIELDS = ["yoe", "seniority", "company_industry", "role_focus",
              "skills", "comp_range", "work_model", "min_yoe", "tagged_at"]
GEO_FIELDS = ["city", "state", "country", "remote", "market", "metro"]

_ISO = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
_EPOCH = re.compile(r"^\d{10,13}$")


def iso_date(raw: str) -> str | None:
    """Feed date cell -> ISO date, or None when it isn't one.

    The feed's `posted` column is NOT uniformly ISO: adapters pass through
    whatever the board gives. In the live feed ~40% of rows carry Workday
    prose ("Posted 30+ Days Ago") or epoch milliseconds ("1764070589246").
    Postgres would reject those on a `date` column and PostgREST fails the
    WHOLE 500-row chunk, so normalization has to happen here — unparseable
    means NULL, never a guess.
    """
    s = (raw or "").strip()
    if not s:
        return None
    m = _ISO.match(s)
    if m:
        try:
            return _dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
        except ValueError:
            return None
    if _EPOCH.match(s):
        try:
            secs = int(s) / 1000 if len(s) == 13 else int(s)
            return _dt.datetime.fromtimestamp(
                secs, _dt.timezone.utc).date().isoformat()
        except (ValueError, OSError, OverflowError):
            return None
    return None


def posting_row(r: dict) -> dict | None:
    """Feed-row dict -> postings upsert row. None for keyless rows."""
    key = (r.get(schema.KEY) or "").strip()
    if not key:
        return None
    # first_seen/last_seen are NOT NULL dates: a row whose dates don't parse
    # is malformed and is dropped (counted + warned by mirror_feed).
    first_seen = iso_date(r.get("first_seen", ""))
    if not first_seen:
        return None
    last_seen = iso_date(r.get("last_seen", "")) or first_seen
    return {
        "key": key,
        "company": (r.get("company") or "").strip(),
        "title": (r.get("title") or "").strip(),
        "location": (r.get("location") or "").strip(),
        "url": (r.get("url") or "").strip(),
        "posted": iso_date(r.get("posted", "")),
        "first_seen": first_seen,
        "last_seen": last_seen,
        "status": (r.get("status") or "New").strip() or "New",
        "tags": {f: (r.get(f) or "").strip() for f in TAG_FIELDS
                 if (r.get(f) or "").strip()},
        "geo": {f: (r.get(f) or "").strip() for f in GEO_FIELDS
                if (r.get(f) or "").strip()},
    }


def user_posting_row(r: dict, user_id: str) -> dict | None:
    """Feed-row dict -> user_postings upsert row. Rows that predate the
    disposition columns mirror as needs-info so nothing is silently hidden
    in the new store that regate hasn't decided yet."""
    key = (r.get(schema.KEY) or "").strip()
    if not key:
        return None
    d = (r.get("disposition") or "").strip() or "needs-info"
    triage = "interested" if (r.get("interested") or "").strip().upper() in (
        "TRUE", "1", "YES") else ""
    return {
        "user_id": user_id,
        "posting_key": key,
        "disposition": d,
        "disposition_reason": (r.get("disposition_reason") or "").strip(),
        "triage": triage,
    }


def mirror_feed(rows: list[dict], user_id: str, *,
                session=None) -> tuple[int, int, list[str]]:
    """Upsert all feed rows into postings + user_postings.

    Returns (postings, user_postings, dropped_keys). user_postings are sent
    only for keys whose posting row was emitted — a dropped (malformed)
    posting must not leave a dangling FK that fails the chunk. Dropped rows
    are RETURNED, not swallowed: during dual-write a silent divergence
    between sheet and store is exactly the failure mode we're eliminating.
    """
    posts, dropped = [], []
    for r in rows:
        key = (r.get(schema.KEY) or "").strip()
        p = posting_row(r)
        if p:
            posts.append(p)
        elif key:
            dropped.append(key)
    keys = {p["key"] for p in posts}
    ups = [u for u in (user_posting_row(r, user_id) for r in rows)
           if u and u["posting_key"] in keys]
    n1 = pg.upsert("postings", posts, on_conflict="key", session=session)
    n2 = pg.upsert("user_postings", ups, on_conflict="user_id,posting_key",
                   session=session)
    return n1, n2, dropped


def mirror(hq, user_id: str, *, session=None) -> tuple[int, int, list[str]]:
    """Read the whole Feed tab and upsert it into postings + user_postings.

    The ONE mirror pass, shared by this module's `main()` (Phase A's tail step)
    and by `monitor.run` (Phase C's first-class write). Two copies of these six
    lines would be two lanes that can mirror differently — and the difference
    would only ever show up as a store that disagrees with the sheet.
    """
    rows = hq.tab("feed").records()
    n1, n2, dropped = mirror_feed(rows, user_id, session=session)
    print(f"[pgmirror] postings={n1} user_postings={n2} dropped={len(dropped)} "
          f"from {len(rows)} feed rows", file=sys.stderr)
    if dropped:
        print(f"::warning title=pgmirror dropped rows::{len(dropped)} feed row(s) "
              f"had an unparseable first_seen and are absent from the store: "
              f"{', '.join(dropped[:10])}{'…' if len(dropped) > 10 else ''}")
    return n1, n2, dropped


def main() -> int:
    # Phase C: the sweep owns this write and has already done it (monitor/run.py,
    # before its heartbeat). Re-running here would be a second full-Feed upsert
    # per sweep — harmless, being idempotent, and pure waste. Standing down is
    # also what keeps the failure attributable: under first_class the sweep is
    # the thing that must go red, not a tail step that ran afterwards.
    # RM-12: under HQ_FEED_STORE=pg the sweep wrote postings/user_postings ITSELF and
    # never wrote the Feed tab. This module's input is that tab, so running it here
    # would read rows the sweep never touched and upsert them over the sweep's own
    # work — status, tags, geo and disposition, for every row still in the tab, exit
    # 0, no alert. Checked BEFORE the pgwrites branch and independently of it, because
    # this module is the second step of the same `monitor` job (handler.py JOBS) and
    # must not depend on a second flag being set correctly to avoid corrupting the
    # first step's output.
    from monitor import feedstore
    if feedstore.mode() == feedstore.PG:
        print(f"[pgmirror] {feedstore.STORE_ENV}={feedstore.PG} — the sweep wrote the "
              f"store directly and did not write the Feed tab; mirroring it now would "
              f"overwrite this run's own rows with stale spreadsheet values",
              file=sys.stderr)
        return 0
    if pgwrites.mode() == pgwrites.FIRST_CLASS:
        print(f"[pgmirror] {pgwrites.FLAG_ENV}={pgwrites.FIRST_CLASS} — the sweep "
              f"mirrors the Feed itself; nothing to echo", file=sys.stderr)
        return 0
    if not pg.enabled():
        print("::warning title=pgmirror skipped::SUPABASE_URL/SUPABASE_SERVICE_KEY "
              "unset — v2 store not provisioned yet (db/README.md)")
        return 0
    user_id = pgwrites.user_id()
    if not user_id:
        print(f"[pgmirror] {pgwrites.USER_ENV} unset — need the owner's users.id "
              "(select id from users where email=...)", file=sys.stderr)
        return 1
    from core.sheets import HQ
    mirror(HQ.open(), user_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
