"""Per-run bot rows in `bot_runs` (E3), and the one property that matters most:
a telemetry write can never fail the bot job it wraps.

MUTATION TARGETS (mirrors core/runlog.py's own list):
  * remove the try/except in start/finish -> the "a broken recorder never fails
    the job" tests raise instead of swallowing;
  * drop `_counts.clear()` in start -> the warm-container test sees last run's
    counts on this row;
  * insert instead of patch when a run id is known -> the "one row, not two" test
    catches the second write;
  * skip the fallback insert when there is no id -> the "recorded even if the
    open-row write failed" test loses the row;
  * drop the `run is None` guard in finish -> the "no run at all records
    nothing" test sees a row invented for a job named '?'.
"""
from __future__ import annotations

import pytest

from core import runlog

UID = "00000000-0000-0000-0000-000000000009"


def _enable(monkeypatch, *, enabled=True):
    monkeypatch.setattr("core.pg.enabled", lambda: enabled)


# ---------------------------------------------------------------- uid coercion

def test_a_uuid_is_canonicalised_and_anything_else_is_none():
    assert runlog._uid_or_none(UID) == UID
    assert runlog._uid_or_none(" " + UID.upper() + " ") == UID   # trimmed, lowercased
    for bad in ("", None, "salman", "x&or=(user_id.gte.0)"):
        assert runlog._uid_or_none(bad) is None


# ---------------------------------------------------------------- start

def test_start_opens_a_row_and_keeps_its_id(monkeypatch):
    sent = []
    _enable(monkeypatch)
    monkeypatch.setattr("core.pgwrites.user_id", lambda: UID)
    monkeypatch.setattr("core.pg.insert_returning",
                        lambda table, rows, session=None, timeout=None: sent.append((table, rows)) or [{"id": 42}])
    run = runlog.start("monitor")
    assert sent == [("bot_runs", [{"job": "monitor", "user_id": UID}])]
    assert run.job == "monitor" and run.id == 42 and run.user_id == UID


def test_start_without_pg_writes_nothing_but_still_returns_a_handle(monkeypatch):
    _enable(monkeypatch, enabled=False)
    monkeypatch.setattr("core.pgwrites.user_id", lambda: UID)
    monkeypatch.setattr("core.pg.insert_returning",
                        lambda *a, **k: pytest.fail("wrote a run row with pg disabled"))
    run = runlog.start("digest")
    assert run.job == "digest" and run.id is None and run.user_id == UID


def test_start_swallows_a_pg_failure(monkeypatch):
    """A pg outage at start must not fail the bot — the whole point of E3's guard."""
    _enable(monkeypatch)
    monkeypatch.setattr("core.pgwrites.user_id", lambda: UID)
    monkeypatch.setattr("core.pg.insert_returning",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("pg down")))
    run = runlog.start("monitor")          # no raise
    assert run.id is None                  # …and finish can still record it


# ---------------------------------------------------------------- finish

def test_finish_patches_the_open_row_with_outcome_and_drained_counts(monkeypatch):
    patched = []
    _enable(monkeypatch)
    monkeypatch.setattr("core.pg.patch",
                        lambda table, query, values, session=None, timeout=None: patched.append((table, query, values)))
    monkeypatch.setattr("core.pg.insert",
                        lambda *a, **k: pytest.fail("patched AND inserted — two rows for one run"))
    runlog.add(fetched=38)
    runlog.add(new_rows=2)                 # accumulates across calls
    runlog.finish(runlog.Run("monitor", id=42, user_id=UID), ok=True)
    assert len(patched) == 1
    table, query, values = patched[0]
    assert table == "bot_runs" and query == "id=eq.42"
    assert values["ok"] is True and values["fetched"] == 38 and values["new_rows"] == 2
    assert values["error"] is None and "finished_at" in values


def test_finish_without_an_id_records_the_run_whole(monkeypatch):
    """The open-row write failed; the finished run is inserted so it is not lost."""
    inserted = []
    _enable(monkeypatch)
    monkeypatch.setattr("core.pg.patch",
                        lambda *a, **k: pytest.fail("patched a row that was never opened"))
    monkeypatch.setattr("core.pg.insert",
                        lambda table, rows, session=None, timeout=None: inserted.append((table, rows)))
    runlog.finish(runlog.Run("theirstack", id=None, user_id=UID), ok=False, error="  429  ")
    assert len(inserted) == 1
    table, rows = inserted[0]
    assert table == "bot_runs"
    assert rows[0]["job"] == "theirstack" and rows[0]["user_id"] == UID
    assert rows[0]["ok"] is False and rows[0]["error"] == "429"   # trimmed


def test_finish_with_no_run_at_all_records_nothing(monkeypatch):
    """`run is None` means start was never REACHED — the handler failed on the
    payload, the user select or the secret load, before it knew which job it was
    about to run. There is nothing to record. The first version recorded it
    anyway and minted a row for a job named '?': a phantom failure on the one
    surface whose whole promise is that what it shows really ran."""
    _enable(monkeypatch)
    monkeypatch.setattr("core.pg.patch", lambda *a, **k: pytest.fail("patched with no run"))
    monkeypatch.setattr("core.pg.insert", lambda *a, **k: pytest.fail("invented a run row"))
    runlog.finish(None, ok=False, error="-: ValueError: unknown job 'nope'")


def test_finish_swallows_a_pg_failure(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr("core.pg.patch",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("pg down")))
    runlog.finish(runlog.Run("monitor", id=1), ok=True)          # no raise


def test_finish_without_pg_writes_nothing(monkeypatch):
    _enable(monkeypatch, enabled=False)
    monkeypatch.setattr("core.pg.patch", lambda *a, **k: pytest.fail("patched with pg disabled"))
    monkeypatch.setattr("core.pg.insert", lambda *a, **k: pytest.fail("inserted with pg disabled"))
    runlog.finish(runlog.Run("monitor", id=1), ok=True)


def test_an_empty_error_string_stores_null(monkeypatch):
    _enable(monkeypatch)
    seen = {}
    monkeypatch.setattr("core.pg.patch",
                        lambda table, query, values, session=None, timeout=None: seen.update(values))
    runlog.finish(runlog.Run("monitor", id=1), ok=True, error="   ")
    assert seen["error"] is None


def test_a_long_error_is_truncated(monkeypatch):
    _enable(monkeypatch)
    seen = {}
    monkeypatch.setattr("core.pg.patch",
                        lambda table, query, values, session=None, timeout=None: seen.update(values))
    runlog.finish(runlog.Run("monitor", id=1), ok=False, error="x" * 900)
    assert len(seen["error"]) == 500


# ---------------------------------------------------------------- the slow database
#
# The recorder cannot RAISE (above). The other half of "it never breaks the bot"
# is that it cannot STARVE: the handler reserves 60s of Lambda runtime for a
# bot's graceful stop, and core.pg's default budget is 30s per call. A database
# that accepts the connection and then hangs is the failure that gets past every
# try/except in this file, because nothing ever throws.

def _recorded_timeouts(monkeypatch) -> list:
    seen = []
    monkeypatch.setattr("core.pg.insert_returning",
                        lambda t, rows, session=None, timeout=None: seen.append(timeout) or [{"id": 3}])
    monkeypatch.setattr("core.pg.patch",
                        lambda t, q, v, session=None, timeout=None: seen.append(timeout))
    monkeypatch.setattr("core.pg.insert",
                        lambda t, rows, session=None, timeout=None: seen.append(timeout))
    return seen


def test_every_recorder_write_is_time_boxed_well_inside_the_graceful_stop_reserve(monkeypatch):
    """All three write paths — open, close-by-patch, close-by-insert — must carry
    a bounded timeout, and the bound must leave the handler's 60s reserve intact
    even if both calls of one invocation hang."""
    _enable(monkeypatch)
    monkeypatch.setattr("core.pgwrites.user_id", lambda: UID)
    seen = _recorded_timeouts(monkeypatch)
    runlog.finish(runlog.start("monitor"), ok=True)          # open + patch
    runlog.finish(runlog.Run("monitor", id=None), ok=True)   # the fallback insert
    assert len(seen) == 3
    assert all(t is not None for t in seen), "a recorder write ran on core.pg's 30s default"
    # Two hangs per invocation must not eat the reserve the graceful stop needs.
    assert max(seen) * 2 < 60


def test_a_hanging_database_does_not_reach_the_bot(monkeypatch):
    """And when the bound fires, it arrives as a swallowed exception, not a raise —
    requests raises Timeout, which is an Exception like any other."""
    import requests

    _enable(monkeypatch)
    monkeypatch.setattr("core.pgwrites.user_id", lambda: UID)
    monkeypatch.setattr("core.pg.insert_returning",
                        lambda *a, **k: (_ for _ in ()).throw(requests.exceptions.Timeout("hung")))
    monkeypatch.setattr("core.pg.patch",
                        lambda *a, **k: (_ for _ in ()).throw(requests.exceptions.Timeout("hung")))
    monkeypatch.setattr("core.pg.insert",
                        lambda *a, **k: (_ for _ in ()).throw(requests.exceptions.Timeout("hung")))
    runlog.finish(runlog.start("monitor"), ok=True)          # no raise


def test_a_missing_table_before_the_migration_is_swallowed(monkeypatch):
    """The pre-migration window: the engine deploys before 0023 is applied, so
    PostgREST answers 404 and core.pg raises PgError. Every bot would fail on its
    first invocation if that reached the handler."""
    from core import pg

    _enable(monkeypatch)
    monkeypatch.setattr("core.pgwrites.user_id", lambda: UID)
    boom = lambda *a, **k: (_ for _ in ()).throw(  # noqa: E731
        pg.PgError("insert bot_runs -> HTTP 404: relation does not exist"))
    monkeypatch.setattr("core.pg.insert_returning", boom)
    monkeypatch.setattr("core.pg.patch", boom)
    monkeypatch.setattr("core.pg.insert", boom)
    runlog.finish(runlog.start("monitor"), ok=True)          # no raise


# ---------------------------------------------------------------- warm container

def test_start_clears_counts_so_a_warm_container_does_not_leak(monkeypatch):
    """A reused Lambda process must not attribute the previous invocation's counts
    to this run — the warm-container bug the handler's other resets guard against."""
    _enable(monkeypatch)
    monkeypatch.setattr("core.pgwrites.user_id", lambda: UID)
    monkeypatch.setattr("core.pg.insert_returning", lambda *a, **k: [{"id": 7}])
    seen = {}
    monkeypatch.setattr("core.pg.patch",
                        lambda table, query, values, session=None, timeout=None: seen.update(values))

    runlog.add(fetched=999)                # leftover from a previous run
    run = runlog.start("monitor")          # a new invocation begins
    runlog.finish(run, ok=True)
    assert seen["fetched"] == 0            # the leftover did not survive start
