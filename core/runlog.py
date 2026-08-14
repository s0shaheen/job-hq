"""Per-run bot rows in `bot_runs` — the source under Coverage's Activity tab (E3).

doc 07 §4 E3: every Lambda job invocation writes one row — job, started_at,
finished_at, ok/failed, result counts, error summary — so the Activity tab can
say, per job and in plain words, "Last succeeded 2h ago" / "Failing since Jul 24"
/ "Running". `infra/app/handler.py` is the caller: `start()` before a job's
modules, `finish()` after.

FAIL-LOUD HAS ONE EXCEPTION HERE, the same envelope doctrine as the handler's
ops alert (C1): a recorder failure must NEVER fail the bot job it wraps. The job
is the product; the row is observability. So `start`/`finish` swallow every error
and log it — a missing Activity row is recoverable, a job killed because its
telemetry write 4xx'd is not. This is the deliberate opposite of `core/beats.py`,
whose heartbeats are load-bearing under first_class and therefore RAISE.

Written whenever `pg.enabled()` (not gated on first_class), because the tab must
fill all through dual-write, not only after the cutover — and it is safe to,
precisely because it can never fail the job.

The swallow doctrine covers the WRITES only. `last_ok` — the digest watchdog's
freshness read over these rows (SHEET-INVENTORY §3.1) — raises, and says why.

MUTATION TARGETS:
  * remove the try/except in `start`/`finish` -> the "a broken recorder never
    fails the job" tests go red (a pg outage would start failing every bot);
  * drop the `_counts.clear()` in `start` -> the warm-container test sees the
    previous invocation's counts leak into this run's row;
  * insert instead of patch when a run id is known -> the "one row per run" test
    sees two rows for one invocation;
  * skip the fallback insert when `start` never got an id -> the "a run whose
    open-row write failed is still recorded at finish" test loses the row;
  * drop the `run is None` guard in `finish` -> the "a failure before start
    records nothing" test sees a phantom row for a job named "?";
  * drop `_WRITE_TIMEOUT` -> the "a hanging database cannot eat the job's
    graceful-stop reserve" test sees the 30s default again.
"""
from __future__ import annotations

import datetime as _dt
import uuid as _uuid
from dataclasses import dataclass

_TABLE = "bot_runs"

#: Seconds a recorder write may hold the process, against core.pg's 30s default.
#:
#: A recorder that cannot RAISE can still STARVE. The handler reserves 60s of the
#: Lambda runtime for a bot's graceful stop (`_export_runtime_deadline`: flush,
#: feed snapshot, heartbeat), and two 30s hangs against an unreachable-but-not-
#: refusing database would consume that entire reserve — turning "the telemetry
#: write was slow" into "the job was killed mid-flight and lost its flush". Five
#: seconds is far more than a single-row write needs and a twelfth of the reserve.
_WRITE_TIMEOUT = 5

#: In-process result counters a bot MAY report during its run (e.g. fetched,
#: new_rows), drained into the row at `finish`. Reset every `start`, because a
#: warm Lambda container is a process the previous invocation already ran in — a
#: counter left standing would attribute the last job's work to this one.
_counts: dict[str, int] = {}


@dataclass
class Run:
    """The handle `start` returns and `finish` closes. `id` is None when the
    open-row write never landed (pg was down, or the POST 4xx'd) — finish then
    records the finished run whole rather than losing it."""
    job: str
    id: int | None = None
    user_id: str | None = None


def _uid_or_none(raw) -> str | None:
    """A `users.id` as a canonical UUID string, or None for anything that is not
    one (unset, '', a non-uuid). Null user_id = a shared / operator-wide run,
    which the RLS policy reads as readable — a bot_runs row holds no secret."""
    try:
        return str(_uuid.UUID(str(raw).strip()))
    except (ValueError, AttributeError, TypeError):
        return None


def add(**counts: int) -> None:
    """A bot reports result counts for the run in flight, e.g.
    `runlog.add(fetched=38, new_rows=2)`. Accumulates, so a job that sweeps in
    passes can call it repeatedly; drained and reset at `finish`."""
    for key, value in counts.items():
        _counts[key] = _counts.get(key, 0) + int(value)


def start(job: str) -> Run:
    """Open a `bot_runs` row for this invocation (finished_at null = running).

    Best-effort: any failure is logged and swallowed, and a `Run` is always
    returned so `finish` can still close (or record) the run. Resets the counter
    accumulator first — see `_counts`.
    """
    _counts.clear()
    run = Run(job=job)
    try:
        from core import pg, pgwrites
        run.user_id = _uid_or_none(pgwrites.user_id())
        if not pg.enabled():
            return run
        created = pg.insert_returning(_TABLE, [{"job": job, "user_id": run.user_id}],
                                      timeout=_WRITE_TIMEOUT)
        if created:
            run.id = created[0].get("id")
    except Exception as exc:                     # never fail the job for a telemetry write
        print(f"[runlog] could not open a run row for {job!r}: {exc!r}")
    return run


def last_ok(user_id: str, jobs, *, session=None) -> "dict[str, _dt.datetime | None]":
    """Newest SUCCESSFUL finish per `bot_runs.job`, or None for a job that has
    never succeeded — the digest watchdog's freshness read (SHEET-INVENTORY §3.1).

    `ok = true` ONLY, on purpose: that filter is the whole reason this read is
    stronger than the Config stamp it replaces. A lane failing on every
    invocation refreshes its sheet stamp each run and reads healthy on the tab;
    here its last success ages out and it warns. A lane whose every run failed
    is therefore indistinguishable from one that never ran — both are "no
    successful run", which is exactly the verdict a watchdog should hand them.

    RAISES on failure, unlike everything above it in this module. The swallow
    doctrine is for the WRITES, which are telemetry riding inside a bot job that
    must not die for them. This read is not telemetry — it IS the watchdog's
    product, and a swallowed read is a watchdog reporting green on nothing. The
    caller (tracker/digest.py) catches and turns the failure into its own loud,
    paging warn line, the same path `core.beats.last_seen` failures take.

    One request per job with `limit=1`, the same shape and reasoning as
    `core.beats.last_seen`: a single windowed request needs a row cap, and the
    job a cap would drop is precisely the dead one. Filtered to THIS user's rows
    — a shared (null user_id) or another tenant's run is not evidence that this
    user's lane ran, and the miss reads as "never succeeded", which warns: the
    safe direction.
    """
    from core import pg
    from core.beats import _parse       # the ONE PostgREST-timestamptz parser;
    #                                     an unparseable finish reads as never-
    #                                     succeeded, which warns — safe direction
    from core.pgwrites import uid as _uid
    uid = _uid(user_id)                 # injection guard; a non-UUID raises HERE
    out: dict[str, _dt.datetime | None] = {}
    for job in jobs:
        rows = pg.select(
            _TABLE,
            f"select=finished_at&user_id=eq.{uid}&job=eq.{job}&ok=is.true"
            f"&order=finished_at.desc&limit=1",
            session=session)
        out[job] = _parse(rows[0].get("finished_at", "")) if rows else None
    return out


def finish(run: Run | None, *, ok: bool, error: str = "") -> None:
    """Close the run: stamp finished_at, the outcome, and the drained counts.

    Best-effort like `start`. Patches the open row by id; if there is no id (the
    open-row write failed), inserts the finished run whole so a run is never lost
    for want of its opening write.

    `run is None` is a THIRD case and not the same as `run.id is None`: it means
    `start` was never reached at all — the handler failed on the payload, the
    user select, or the secret load, before it knew which job to open a row for.
    There is no run to record, so nothing is written. Recording one anyway is
    what the first version did, and it invented a row for a job literally named
    "?" — a phantom failure on the one surface whose entire promise is that what
    it shows really ran.
    """
    if run is None:
        return
    counts = dict(_counts)
    _counts.clear()
    job = run.job
    try:
        from core import pg
        if not pg.enabled():
            return
        values: dict = {
            "finished_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "ok": bool(ok),
            "fetched": int(counts.get("fetched", 0)),
            "new_rows": int(counts.get("new_rows", 0)),
            "error": (error or "").strip()[:500] or None,
        }
        if run.id is not None:
            pg.patch(_TABLE, f"id=eq.{int(run.id)}", values, timeout=_WRITE_TIMEOUT)
        else:
            values["job"] = job
            values["user_id"] = run.user_id
            pg.insert(_TABLE, [values], timeout=_WRITE_TIMEOUT)
    except Exception as exc:                     # never fail the job for a telemetry write
        print(f"[runlog] could not close the run row for {job!r}: {exc!r}")
