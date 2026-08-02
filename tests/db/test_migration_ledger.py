"""`db/apply.sh` against a real database, with both filename schemes present.

This is the half of the migration-naming contract that cannot be checked from
the filesystem. `tests/core/test_migrations.py` proves the NAMES are well formed
and proves `ledger_gaps` reasons correctly about synthetic ledgers. Only a
database has the ledger, and the ledger is the thing that replaced the old
`RESERVED_MIGRATION_NUMBERS` contiguity rule:

    a number line could only guess whether a missing 0022 meant "reserved" or
    "somebody's migration never got committed". `public.schema_migrations`
    records what actually ran, so the question stops being a guess.

What runs here:

    fresh apply      every file applies, in `sort` order, to an empty database
    idempotent rerun a second `db/apply.sh` applies nothing and exits clean
    ledger agreement no file on disk is skipped, no ledger row is orphaned
    mixed ordering   the serial files really are applied before the stamped ones

Needs `psql` on PATH (db/apply.sh shells out to it) and its own throwaway
database, which it creates and drops — it must not run against the shared
`schema` fixture, which drops and rebuilds `public` without a ledger.

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55503:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55503/postgres HQ_REQUIRE_DB=1 \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_migration_ledger.py -q
"""
from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

from tests.core.test_migrations import (  # noqa: E402  (the pure half of this contract)
    MIGRATIONS,
    _classify,
    ledger_gaps,
)

ROOT = Path(__file__).resolve().parents[2]
APPLY = ROOT / "db" / "apply.sh"
#: `0001_init.sql` references `auth.users` on its first page. On Supabase that
#: schema is already there; on a vanilla Postgres it is not, so apply.sh's very
#: first file aborts. The harness is the same minimum Supabase surface the rest
#: of tests/db applies, and it is NOT a migration — it never enters the ledger.
HARNESS = ROOT / "db" / "test-harness.sql"

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")

pytestmark = [
    pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL"),
    # An honest skip, not a fake pass: apply.sh IS psql. Without it there is
    # nothing to assert and saying so is the only correct outcome.
    pytest.mark.skipif(
        shutil.which("psql") is None,
        reason="psql not on PATH — db/apply.sh cannot run, so its ledger cannot be checked",
    ),
]


@pytest.fixture(scope="module")
def applied_db():
    """A throwaway database with `db/apply.sh` run against it exactly once.

    Returns `(url, first_run_output)`.
    """
    name = f"hq_ledger_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DATABASE_URL, autocommit=True) as admin:
        admin.execute(f'create database "{name}"')
    parts = urlsplit(DATABASE_URL)
    url = urlunsplit((parts.scheme, parts.netloc, f"/{name}", parts.query, parts.fragment))
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(HARNESS.read_text())
        first = _apply(url)
        yield url, first
    finally:
        with psycopg.connect(DATABASE_URL, autocommit=True) as admin:
            admin.execute(
                "select pg_terminate_backend(pid) from pg_stat_activity where datname = %s",
                (name,),
            )
            admin.execute(f'drop database if exists "{name}"')


def _apply(url: str) -> str:
    proc = subprocess.run(
        ["bash", str(APPLY)],
        env={**os.environ, "DATABASE_URL": url},
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, f"db/apply.sh failed:\n{proc.stdout}\n{proc.stderr}"
    return proc.stdout


def _ledger(url: str) -> list[str]:
    with psycopg.connect(url, autocommit=True) as conn:
        return [
            r[0]
            for r in conn.execute(
                "select filename from public.schema_migrations order by filename"
            ).fetchall()
        ]


def test_a_fresh_apply_runs_every_migration(applied_db):
    """Both naming schemes apply, in one pass, to an empty database."""
    url, out = applied_db
    assert f"done: {len(MIGRATIONS)} applied this run" in out, out
    assert _ledger(url) == sorted(m.name for m in MIGRATIONS)


def test_rerunning_apply_is_a_no_op(applied_db):
    """The ledger, not idempotent SQL, is what makes the second run safe.

    0001 is unguarded (`create table allowed_emails`), so a rerun that re-applied
    anything would abort. "0 applied" is therefore a real assertion and not a
    formality.
    """
    url, _ = applied_db
    before = _ledger(url)
    out = _apply(url)
    assert "done: 0 applied this run" in out, out
    assert _ledger(url) == before


def test_the_ledger_and_the_directory_agree(applied_db):
    """No migration is skipped, and none is orphaned.

    This is what the deleted contiguity rule was for, asked of the only thing
    that can answer it. Against production the same call is the check that a
    file below the high-water mark is never missing — which is precisely what
    renaming an applied `0001`–`0028` would cause.
    """
    url, _ = applied_db
    assert ledger_gaps([m.name for m in MIGRATIONS], _ledger(url)) == {
        "skipped": [],
        "orphaned": [],
    }


def test_serial_migrations_are_applied_before_stamped_ones(applied_db):
    """Apply ORDER, read back from the database rather than assumed.

    `db/apply.sh` orders by `ls *.sql | sort`, whose collation is locale
    dependent. The whole no-rename argument rests on `0028_*` sorting before
    `20260802_*`; this reads the order the shell actually produced.
    """
    url, _ = applied_db
    with psycopg.connect(url, autocommit=True) as conn:
        order = [
            r[0]
            for r in conn.execute(
                "select filename from public.schema_migrations order by applied_at, filename"
            ).fetchall()
        ]
    kinds = [_classify(n) for n in order]
    assert "stamped" not in kinds[: kinds.count("serial")], (
        f"a stamped migration was applied before a serial one: {order}"
    )
    assert order == sorted(order), f"apply order was not filename order: {order}"
