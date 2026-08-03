"""The discovery sweep's two Postgres homes (20260803_090223_sweep_state), on real Postgres.

RM-12 moves discovery off the Google Sheet. `monitor/run.py` is written against the
`SheetStore` protocol, so the cutover is a second implementation rather than a rewrite —
but `mark_pushed` and the sweep cursor had nowhere to live. This migration adds those
two and, deliberately, nothing else.

The shape assertions here are the cheap half. The half that matters is the boundary:
`monitor_sweep_state` is a new browser-reachable table, and a new table created after
0027 does not inherit 0027's entitlement gate — it has to bring its own. The first
version of the migration did not, and
`test_default_deny.py::test_every_browser_reachable_table_is_gated` caught it, because
that check derives its table set from `pg_catalog` rather than from a list. These tests
pin the same property from the attacker's side: an account nobody has turned on gets
nothing, and no browser session writes here at all.

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
    gate,
    make_posting,
    make_user,
    schema,  # noqa: F401 — session fixture
)


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


# ----------------------------------------------------------------- the push latch

def test_pushed_at_is_a_nullable_date_with_no_default(conn):
    """NULL is the latch, not a missing value.

    `mark_pushed` is fill-blank-only — "a role is pushed once; re-marks never
    clobber" (`monitor/sheet.py:289`) — so the writer is `where pushed_at is null`.
    A default would make every new row look already-pushed and silence the first
    notification for every posting the sweep ever finds.

    KILLED BY: `add column pushed_at date not null default current_date`.
    """
    col = _cols(conn, "user_postings")["pushed_at"]
    assert col == ("date", "YES", None)


def test_the_fill_blank_write_notifies_once_and_never_twice(conn):
    """The latch doing its job, driven as the sweep drives it.

    Asserted on the stored DATE, not on a row count: an update that clobbered the
    original would affect exactly the same number of rows as one that correctly
    did nothing, so a count cannot tell the two apart.

    KILLED BY: dropping `where pushed_at is null` from the writer below.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", "AlphaCorp")
    gate(conn, uid, key)

    def mark(day: str) -> None:
        conn.execute(
            "update public.user_postings set pushed_at = %s "
            " where user_id = %s and posting_key = %s and pushed_at is null",
            (day, uid, key),
        )

    def stored():
        return conn.execute(
            "select pushed_at from public.user_postings "
            " where user_id = %s and posting_key = %s", (uid, key)).fetchone()[0]

    assert stored() is None, "a freshly gated posting has never been pushed"
    mark("2026-08-03")
    first = stored()
    assert str(first) == "2026-08-03"
    mark("2026-08-04")                      # the re-run
    assert stored() == first, "a second sweep overwrote the push date"


def test_the_push_latch_is_per_user_not_per_posting(conn):
    """`postings` is shared across tenants; being pushed is a fact about ONE
    person's notifications. On the shared row, the first user to be notified would
    silence everyone else for that role.

    KILLED BY: moving `pushed_at` onto `public.postings`.
    """
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", "SharedCorp")
    gate(conn, a, key)
    gate(conn, b, key)

    conn.execute(
        "update public.user_postings set pushed_at = '2026-08-03' "
        " where user_id = %s and posting_key = %s and pushed_at is null", (a, key))

    rows = dict(conn.execute(
        "select user_id, pushed_at from public.user_postings where posting_key = %s",
        (key,)).fetchall())
    assert str(rows[uuid.UUID(a)]) == "2026-08-03"
    assert rows[uuid.UUID(b)] is None, "one user's push silenced another's"


# ---------------------------------------------------------------- the sweep cursor

def test_the_cursor_defaults_to_empty_so_an_absent_row_and_a_blank_row_agree(conn):
    """The sweep compares this to a company name and treats '' as "start at the
    beginning". A NULL would make an unstarted user's first sweep compare against
    NULL and skip every company, which looks exactly like a completed sweep.

    KILLED BY: dropping `not null default ''` from the column.
    """
    col = _cols(conn, "monitor_sweep_state")["cursor"]
    assert col[0] == "text"
    assert col[1] == "NO"
    assert col[2] == "''::text"

    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("insert into public.monitor_sweep_state (user_id) values (%s)", (uid,))
    got = conn.execute("select cursor from public.monitor_sweep_state where user_id = %s",
                       (uid,)).fetchone()[0]
    assert got == ""


def test_it_holds_one_row_per_user_and_dies_with_the_account(conn):
    """Primary key on user_id: a second resume point for one user is two sweeps
    disagreeing about where they are. And the cascade, because a deleted account
    must not leave rows behind — the retention rule, at the only boundary that
    can enforce it.

    KILLED BY: dropping the primary key, or the `on delete cascade`.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("insert into public.monitor_sweep_state (user_id, cursor) values (%s, 'Acme')",
                 (uid,))
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("insert into public.monitor_sweep_state (user_id) values (%s)", (uid,))

    conn.execute("delete from auth.users where id = %s", (uid,))
    left = conn.execute("select count(*) from public.monitor_sweep_state where user_id = %s",
                        (uid,)).fetchone()[0]
    assert left == 0


def test_it_is_not_a_key_value_table(conn):
    """The Sheet keeps this cursor in the Config tab beside the user's real knobs,
    and the tempting port is a `(user_id, key, value)` table that would absorb
    every setting the product has. That table is a separate authority question —
    it mixes machine state with user-editable preferences under one grant.

    A named column cannot absorb them by accident. This pins that there is no
    generic key column to start adding rows to, so the next person who needs a
    knob has to design the knobs table rather than widening this one.

    KILLED BY: adding a `key` column here instead of designing the settings table.
    """
    cols = set(_cols(conn, "monitor_sweep_state"))
    assert cols == {"user_id", "cursor", "updated_at"}


# ------------------------------------------------------------------ the boundary

def test_an_unentitled_account_reads_nothing_even_though_the_row_is_theirs(conn):
    """The gate 0027 cannot give a table created after it.

    The permissive read policy answers "is this row yours". It does NOT answer "is
    your account turned on", and a pending, suspended or removed account still
    satisfies `user_id = auth.uid()`. Both halves are asserted: the entitled read
    proves the query and the policy work at all, so the denial below cannot pass
    by querying nothing.

    KILLED BY: deleting the `monitor_sweep_state_entitled` restrictive policy.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("insert into public.monitor_sweep_state (user_id, cursor) values (%s, 'Acme')",
                 (uid,))

    as_authenticated(conn, uid)
    assert conn.execute("select cursor from public.monitor_sweep_state").fetchall() \
        == [("Acme",)], "an entitled owner cannot read their own resume point"

    # Drop the session identity as well as the role: `hq_entitlement_guard` reads
    # it, and the operator action writes an `events` row that the guard would
    # refuse on behalf of the very account being suspended.
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (uid,))
    as_authenticated(conn, uid)
    assert conn.execute("select cursor from public.monitor_sweep_state").fetchall() == []


def test_one_user_never_reads_another_users_resume_point(conn):
    """Tenant isolation, asserted over the WHOLE visible set rather than by looking
    for the other user's row — a policy that leaked a third tenant's row would pass
    a narrower check.

    KILLED BY: `using (true)` on the read policy.
    """
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("insert into public.monitor_sweep_state (user_id, cursor) values (%s, 'Alpha')",
                 (a,))
    conn.execute("insert into public.monitor_sweep_state (user_id, cursor) values (%s, 'Beta')",
                 (b,))

    as_authenticated(conn, a)
    assert conn.execute("select cursor from public.monitor_sweep_state").fetchall() \
        == [("Alpha",)]


@pytest.mark.parametrize("sql", [
    "insert into public.monitor_sweep_state (user_id, cursor) values (%s, 'Injected')",
    "update public.monitor_sweep_state set cursor = 'Injected' where user_id = %s",
    "delete from public.monitor_sweep_state where user_id = %s",
])
def test_a_browser_session_has_no_write_path_at_all(conn, sql):
    """Machine state: the engine writes it through the service role and no human
    surface touches it. The privileges are revoked BY NAME as well as gated by RLS,
    so the refusal is a deterministic privilege error rather than an UPDATE that
    silently affects zero rows and reads to the caller as success.

    Asserted on the error CLASS, not on the message text, and the value is checked
    afterwards so a refusal that somehow still wrote would not pass.

    KILLED BY: dropping the `revoke insert, update, delete` line.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("insert into public.monitor_sweep_state (user_id, cursor) values (%s, 'Acme')",
                 (uid,))

    as_authenticated(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(sql, (uid,))

    conn.execute("reset role")
    assert conn.execute("select cursor from public.monitor_sweep_state where user_id = %s",
                        (uid,)).fetchone() == ("Acme",)
