"""Acceptance tests for `engine_cursors` — RM-12's home for the Sheet's Config cursors.

The design is `docs/plans/SHEET-FACILITIES.md` §1. This file is the half that decides
whether the migration is accepted, and it is written BEFORE the DDL on purpose: the
integrator authors the table, these run, and a shape that disagrees with the design here
is a shape that does not land.

WHAT IS BEING HOMED. Three engine-written resume points that today live as Config-tab
cells: `wide_cursor` (`monitor/wide.py:647`), `wide_theirstack_cursor` (`:651`) and
`linkedin_backfill_cursor` (`monitor/linkedin_backfill.py:668`). The fourth,
`monitor_sweep_cursor`, is homed separately in `monitor_sweep_state` and deliberately
stays there — §6 of the design says why, and `test_this_is_not_the_settings_table` below
pins the property that decision was protecting.

THESE NO LONGER SKIP. An earlier revision of this branch gated the suite on `to_regclass`
because the migration was not yet authored — the integrator role was held elsewhere. It is
now `db/migrations/20260803_105950_engine_cursors.sql`, on this branch, so the guard is
gone and a missing table is a FAILURE rather than a skip. A conditional skip that outlives
its condition is a suite that reports success for tests nobody ran, which is the shape of
defect this repo keeps paying for.

Run locally with a throwaway Postgres — see tests/db/test_write_path.py's docstring.
Without DATABASE_URL every test skips.
"""
from __future__ import annotations

import os
import uuid

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from tests.db.test_write_path import (  # noqa: E402
    make_user,
    schema,  # noqa: F401 — session fixture
)

TABLE = "engine_cursors"

#: The lanes the design fixes, in the order the design lists them. Pinned rather than
#: read out of the check constraint: reading the constraint would make this file agree
#: with whatever the migration happened to say, which is not an acceptance test.
LANES = ("wide_cafe", "wide_theirstack", "linkedin_backfill")


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def as_authenticated(conn, user_id: str) -> None:
    """Become a signed-in browser session: an identity AND the role.

    Skipping `set role` is the difference between testing RLS and testing nothing —
    `postgres` is a superuser and policies do not apply to it.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def as_engine(conn) -> None:
    """The engine's path: the service role, RLS-exempt, with no session identity."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


def park(conn, user_id: str, lane: str, value: str) -> None:
    """The write `monitor/wide.py:_upsert_config` becomes. Upsert, because a cursor is
    current state: the previous mark has no reader."""
    conn.execute(
        "insert into public.engine_cursors (user_id, lane, cursor) values (%s, %s, %s) "
        "on conflict (user_id, lane) do update set cursor = excluded.cursor, "
        "updated_at = now()",
        (user_id, lane, value),
    )


def _cols(conn, table: str) -> dict[str, tuple]:
    return {
        r[0]: (r[1], r[2], r[3])
        for r in conn.execute(
            "select column_name, data_type, is_nullable, column_default "
            "from information_schema.columns "
            "where table_schema = 'public' and table_name = %s",
            (table,),
        ).fetchall()
    }


# ------------------------------------------------------------------------ the shape

def test_an_absent_cursor_and_a_blank_cursor_mean_the_same_thing(conn):
    """`monitor/wide.py:505` reads `_config_value(...) or _default_cursor(today)`, so a
    missing cell falls back to a two-day window. The column has to preserve that: a
    NULLable cursor gives the reader a third state it has no branch for, and the branch
    it would fall into — comparing a timestamp against NULL — is the one that silently
    skips the window instead of re-sweeping it.

    Both halves asserted: the declared shape, and a real inserted row coming back as the
    empty string rather than None.

    KILLED BY: dropping `not null default ''` from the column.
    """
    col = _cols(conn, TABLE)["cursor"]
    assert col[0] == "text"
    assert col[1] == "NO"
    assert col[2] == "''::text"

    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute(
        "insert into public.engine_cursors (user_id, lane) values (%s, 'wide_cafe')", (uid,))
    got = conn.execute(
        "select cursor from public.engine_cursors where user_id = %s", (uid,)).fetchone()[0]
    assert got == ""


def test_one_row_per_user_and_lane_and_it_dies_with_the_account(conn):
    """Two rows for one (user, lane) is two runs disagreeing about where the sweep is,
    and the loser is whichever one the reader happens to see first. And the cascade,
    because a deleted account must not leave rows behind — the retention rule, at the
    only boundary that can enforce it.

    KILLED BY: dropping the (user_id, lane) primary key, or the `on delete cascade`.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    park(conn, uid, "wide_cafe", "2026-08-01T00:00:00Z")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "insert into public.engine_cursors (user_id, lane, cursor) "
            "values (%s, 'wide_cafe', 'other')", (uid,))

    # A different lane for the same user is a different row, not a conflict — three
    # lanes share this table and must not overwrite each other.
    for lane in LANES:
        park(conn, uid, lane, f"mark-{lane}")
    assert dict(conn.execute(
        "select lane, cursor from public.engine_cursors where user_id = %s",
        (uid,)).fetchall()) == {lane: f"mark-{lane}" for lane in LANES}

    conn.execute("delete from auth.users where id = %s", (uid,))
    assert conn.execute(
        "select count(*) from public.engine_cursors where user_id = %s",
        (uid,)).fetchone()[0] == 0


def test_this_is_not_the_settings_table(conn):
    """The property `monitor_sweep_state` protected with a named column, kept here with
    a closed lane domain.

    The Config tab mixes machine state with user-editable preferences under one grant,
    and the tempting port is a `(user_id, key, value)` table that absorbs both. This
    table has a lane column, which LOOKS like that key column — so the constraint is
    what makes it not one. `titles_include` is a preference, its home is
    `profiles.criteria` (0001), and an attempt to park it here has to be a constraint
    violation rather than a row. Otherwise the next person who needs a knob adds one
    here instead of designing the settings table, which is the conversation the sibling
    branch refused to pre-empt and this one is refusing too.

    Asserted by driving the write, not by reading the constraint's text: a check that
    parsed `pg_constraint` would pass on a constraint that named the lanes and was
    declared NOT VALID.

    KILLED BY: dropping the `check (lane in (...))`, or widening it to accept anything.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    for lane in LANES:                      # the positive control: the real lanes fit
        park(conn, uid, lane, "x")

    for smuggled in ("titles_include", "notify_digest", "wide_credit_budget",
                     "heartbeat_monitor", "monitor_sweep_cursor"):
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            conn.execute(
                "insert into public.engine_cursors (user_id, lane, cursor) "
                "values (%s, %s, 'smuggled')", (uid, smuggled))
        assert "engine_cursors" in exc.value.diag.message_primary, (
            f"the refusal for {smuggled!r} did not name this table's constraint: "
            f"{exc.value.diag.message_primary!r}")


def test_the_columns_are_exactly_the_four_the_design_names(conn):
    """A cursor table that grew a `value` or a `description` column is the Config tab
    again. Asserted as a whole set, both directions, because a check for the absence of
    one column name passes on a table that grew a differently-named one.

    KILLED BY: adding any column the design does not name.
    """
    assert set(_cols(conn, TABLE)) == {"user_id", "lane", "cursor", "updated_at"}


# --------------------------------------------------------------------- the boundary

def test_an_unentitled_account_reads_nothing_even_though_the_row_is_theirs(conn):
    """The gate 0027 cannot give a table created after it.

    The permissive read policy answers "is this row yours". It does NOT answer "is your
    account turned on", and a pending, suspended or removed account still satisfies
    `user_id = auth.uid()`. That hole was found and closed on another branch this week;
    `test_default_deny.py` catches it structurally because it derives its table set from
    `pg_catalog`, and this pins the same property from the attacker's side.

    Every state is driven against the SAME row, and the entitled read is asserted first
    — so a policy that denied everybody, or a query that selected nothing, cannot pass
    this as a refusal.

    KILLED BY: deleting the `engine_cursors_entitled` restrictive policy.
    """
    owner = make_user(conn, f"owner-{uuid.uuid4()}@example.com")
    park(conn, owner, "wide_cafe", "2026-08-01T00:00:00Z")

    as_authenticated(conn, owner)
    assert conn.execute("select cursor from public.engine_cursors").fetchall() \
        == [("2026-08-01T00:00:00Z",)], "an entitled owner cannot read their own cursor"

    # A signup with no entitlement row at all: the pending state, reached the way
    # production reaches it.
    pending = str(uuid.uuid4())
    as_engine(conn)
    conn.execute("insert into auth.users (id, email) values (%s, %s)",
                 (pending, f"pending-{uuid.uuid4()}@example.com"))
    park(conn, pending, "wide_cafe", "pending-mark")
    as_authenticated(conn, pending)
    assert conn.execute("select cursor from public.engine_cursors").fetchall() == []

    # And suspension, applied through the real operator RPC. The session identity is
    # dropped first: `hq_entitlement_guard` reads it, and the suspension writes an
    # `events` row the guard would refuse on behalf of the account being suspended.
    as_engine(conn)
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (owner,))
    as_authenticated(conn, owner)
    assert conn.execute("select cursor from public.engine_cursors").fetchall() == []


def test_one_tenant_never_reads_another_tenants_cursor(conn):
    """Tenancy, and it is substantive rather than symmetric: `monitor/wide.py:578` builds
    the TheirStack company fence from THAT user's priority companies, so two users sweep
    different windows. A leaked or shared cursor would let one tenant's completed sweep
    advance the mark past another tenant's unfetched jobs — postings lost silently, which
    reads exactly like nobody hiring.

    Asserted over the WHOLE visible set rather than by looking for the other row: a
    policy that leaked a third tenant would pass a narrower check.

    KILLED BY: `using (true)` on the read policy.
    """
    a = make_user(conn, f"a-{uuid.uuid4()}@example.com")
    b = make_user(conn, f"b-{uuid.uuid4()}@example.com")
    park(conn, a, "wide_theirstack", "Alpha")
    park(conn, b, "wide_theirstack", "Beta")

    as_authenticated(conn, a)
    assert conn.execute(
        "select cursor from public.engine_cursors").fetchall() == [("Alpha",)]


@pytest.mark.parametrize("sql", [
    "insert into public.engine_cursors (user_id, lane, cursor) "
    "values (%s, 'wide_cafe', 'Injected')",
    "update public.engine_cursors set cursor = 'Injected' where user_id = %s",
    "delete from public.engine_cursors where user_id = %s",
])
def test_a_browser_session_has_no_write_path_at_all(conn, sql):
    """Machine state: the engine writes it through the service role and no human surface
    touches it. The privileges are revoked BY NAME as well as gated by RLS, so the
    refusal is a deterministic privilege error rather than an UPDATE that silently
    affects zero rows and reads to the caller as success.

    The account used is ACTIVE and entitled and owns the row — the strongest control
    available, because a refusal that only held for a suspended account would prove the
    entitlement gate rather than the missing write path.

    Asserted on `diag.message_primary`: `str(exc)` carries the CONTEXT block, which
    echoes the statement's own SQL, so a table name in it proves nothing. The value is
    re-read afterwards so a refusal that somehow still wrote would not pass.

    KILLED BY: dropping the `revoke insert, update, delete` line.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    park(conn, uid, "wide_cafe", "Acme")

    as_authenticated(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(sql, (uid,))
    assert "engine_cursors" in exc.value.diag.message_primary, (
        f"the refusal did not name this table: {exc.value.diag.message_primary!r}")

    as_engine(conn)
    assert conn.execute(
        "select cursor from public.engine_cursors where user_id = %s",
        (uid,)).fetchone() == ("Acme",)


def test_the_engine_can_park_a_cursor_it_has_already_parked(conn):
    """The upsert, driven as `_upsert_config` drives it: a cursor moves forward on every
    run and the previous mark has no reader, so the second write must replace rather than
    conflict. `monitor/linkedin_backfill.py:665` short-circuits when the value is
    unchanged, which is an optimisation and not a guarantee — the table has to accept the
    repeat.

    KILLED BY: dropping the `on conflict do update` from the writer, or making the row
    insert-only.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    park(conn, uid, "linkedin_backfill", "0")
    first = conn.execute(
        "select updated_at from public.engine_cursors where user_id = %s "
        " and lane = 'linkedin_backfill'", (uid,)).fetchone()[0]

    park(conn, uid, "linkedin_backfill", "1487")
    cursor, updated = conn.execute(
        "select cursor, updated_at from public.engine_cursors where user_id = %s "
        " and lane = 'linkedin_backfill'", (uid,)).fetchone()
    assert cursor == "1487"
    assert updated >= first, "the operator's is-this-lane-stuck stamp went backwards"
    assert conn.execute(
        "select count(*) from public.engine_cursors where user_id = %s "
        " and lane = 'linkedin_backfill'", (uid,)).fetchone()[0] == 1
