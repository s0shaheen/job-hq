"""The SQL backend of the pinned-mutant ledger, as a pytest plugin.

WHY A PLUGIN AND NOT A SCRIPT. Three of the six defects the ledger backfills
lived in the database, and the guards there are policies and triggers rather
than lines of a file. Postgres DDL is transactional, so breaking one of those
guards is cheap: `drop policy`, run the test, put it back. What is NOT cheap is
rebuilding the schema, and what does not work at all is mutating the database
from outside pytest — `tests/db`'s session-scoped `schema` fixture drops
`public` and re-applies every migration before the first test runs, so anything
applied beforehand is wiped by the very run it was meant to affect.

So the mutation is applied from INSIDE the pytest process, after `schema` has
built the database and before the first test touches it. One autouse fixture,
once per session.

RESTORE. `tests/db/test_autopilot_staging.py::_restore` already establishes the
idiom the mutation tests in that file use: re-apply the migration, which is
written to be re-appliable (`create or replace`, `drop ... if exists`,
`if not exists`) because `db/apply.sh` requires that anyway. This does the same
at session finish. It is belt-and-braces rather than the safety property: every
pytest run of `tests/db` rebuilds the schema from scratch, so a mutation cannot
survive into another run even if the restore fails.

THE STATUS FILE is the part that matters to the runner. A fixture that never
ran, a mutation that never applied, or a restore that failed must not be
reported as "the guard held" or "the guard did not hold" — they are both
unknown, and unknown fails loudly. `scripts/mutants.py` reads this file and
refuses a verdict without `applied=1`.
"""
from __future__ import annotations

import json
import os
import pathlib

import pytest

_MUTANT = os.environ.get("HQ_SQL_MUTANT", "")
_RESTORE = os.environ.get("HQ_SQL_MUTANT_RESTORE", "")
_STATUS = os.environ.get("HQ_SQL_MUTANT_STATUS", "")

_state = {"applied": False, "restored": False, "error": ""}


def _write_status() -> None:
    if _STATUS:
        pathlib.Path(_STATUS).write_text(json.dumps(_state))


def _connect():
    import psycopg

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("HQ_SQL_MUTANT is set but DATABASE_URL is not")
    return psycopg.connect(url, autocommit=True)


@pytest.fixture(autouse=True)
def _hq_sql_mutant(request):
    """Apply the mutation once, after the schema exists.

    `request.getfixturevalue("schema")` is the whole ordering argument: it forces
    the session-scoped schema build to complete before the mutation lands, rather
    than relying on pytest's scope ordering to have done the right thing. If a
    test module has no `schema` fixture in scope, that is a mutant pointed at the
    wrong suite and it fails here rather than reporting a false verdict.
    """
    if not _MUTANT or _state["applied"]:
        yield
        return

    request.getfixturevalue("schema")
    sql = pathlib.Path(_MUTANT).read_text()
    with _connect() as conn:
        conn.execute("reset role")
        conn.execute(sql)
    _state["applied"] = True
    _write_status()
    yield


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    if not _state["applied"] or not _RESTORE:
        _write_status()
        return
    try:
        with _connect() as conn:
            conn.execute("reset role")
            conn.execute(pathlib.Path(_RESTORE).read_text())
        _state["restored"] = True
    except Exception as exc:  # pragma: no cover - surfaces through the status file
        _state["error"] = f"{type(exc).__name__}: {exc}"
    _write_status()
