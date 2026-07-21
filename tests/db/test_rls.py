"""Row-level security, proven against a real database.

docs/PRODUCT-SPEC.md section I names this by hand as the thing that does not
exist: *"an RLS test that signs in as two real users and proves one cannot read
the other's rows."* Three users share this system today and ten are planned, so
"A cannot see B's job search" is the whole privacy model.

Two traps make a careless version of this test worthless, and both are guarded
against here:

1. **The superuser bypasses RLS entirely.** Every other test in this suite
   connects as `postgres`, which ignores policies. A test that forgets to
   `set role authenticated` passes no matter what the policies say.

2. **A negative assertion alone proves nothing.** "A reads 0 of B's rows" is
   equally true when A can read nothing at all — which is exactly what happened
   before `db/test-harness.sql` granted the privileges Supabase grants. Every
   test below asserts the POSITIVE control in the same breath: A can read its
   own rows. Without that, dropping every policy in the schema still passes.
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

from tests.db.test_write_path import (  # noqa: E402  (fixtures are shared on purpose)
    gate,
    make_posting,
    make_user,
    schema,  # noqa: F401 — session fixture
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def two_users(conn):
    """Two allowlisted users, each gated to a posting the other cannot see."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    ka = make_posting(conn, f"gh-a-{uuid.uuid4().hex[:8]}", "AlphaCorp")
    kb = make_posting(conn, f"gh-b-{uuid.uuid4().hex[:8]}", "BetaCorp")
    gate(conn, a, ka)
    gate(conn, b, kb)
    conn.execute(
        """insert into public.applications (user_id, posting_key, company, title, status)
           values (%s, %s, 'AlphaCorp', 'PM', 'Applied'), (%s, %s, 'BetaCorp', 'PM', 'Applied')""",
        (a, ka, b, kb),
    )
    conn.execute(
        """insert into public.events (user_id, kind, posting_key, actor)
           values (%s, 'action.interested', %s, 'user'), (%s, 'action.interested', %s, 'user')""",
        (a, ka, b, kb),
    )
    return {"a": a, "b": b, "ka": ka, "kb": kb}


def as_authenticated(conn, user_id: str):
    """Become a signed-in browser session: an identity AND the anon role.

    Skipping `set role` is the difference between testing RLS and testing
    nothing — `postgres` is a superuser and policies do not apply to it.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def count(conn, sql: str, *args) -> int:
    return conn.execute(sql, args).fetchone()[0]


# ---------------------------------------------------------- the core promise

def test_a_user_reads_their_own_rows_and_none_of_the_other_users(conn, two_users):
    u = two_users
    as_authenticated(conn, u["a"])

    for table, own, theirs in [
        ("user_postings", u["a"], u["b"]),
        ("applications", u["a"], u["b"]),
        ("events", u["a"], u["b"]),
    ]:
        mine = count(conn, f"select count(*) from public.{table} where user_id = %s", own)
        yours = count(conn, f"select count(*) from public.{table} where user_id = %s", theirs)
        # Both halves matter. The first proves the query works at all.
        assert mine > 0, f"A cannot read its own {table} — the test proves nothing"
        assert yours == 0, f"A read {yours} of B's {table} rows"


def test_the_positive_control_really_is_load_bearing(conn, two_users):
    """Drop the policies and the suite must go RED, not stay green.

    This is the meta-test: it proves the assertions above are sensitive to the
    thing they claim to check. Without it, "A reads 0 of B's rows" could be
    passing for any number of unrelated reasons.
    """
    u = two_users
    conn.execute("reset role")
    conn.execute("alter table public.user_postings disable row level security")
    try:
        as_authenticated(conn, u["a"])
        leaked = count(
            conn, "select count(*) from public.user_postings where user_id = %s", u["b"]
        )
        assert leaked > 0, (
            "with RLS disabled A still could not see B's rows — the test is "
            "measuring something other than the policy"
        )
    finally:
        conn.execute("reset role")
        conn.execute("alter table public.user_postings enable row level security")


def test_postings_are_visible_only_to_a_user_who_was_gated_them(conn, two_users):
    """0002 replaced 0001's blanket authenticated-read with a per-user join."""
    u = two_users
    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.postings where key = %s", u["ka"]) == 1
    assert count(conn, "select count(*) from public.postings where key = %s", u["kb"]) == 0


def test_channel_runs_shared_rows_are_readable_and_other_users_rows_are_not(conn, two_users):
    u = two_users
    conn.execute("reset role")
    conn.execute(
        """insert into public.channel_runs (user_id, channel, ran_at)
           values (null, 'monitor', now()), (%s, 'tracker', now())""",
        (u["b"],),
    )
    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.channel_runs where user_id is null") > 0
    assert count(conn, "select count(*) from public.channel_runs where user_id = %s", u["b"]) == 0


# ---------------------------------------------------------- the audit trail

def test_an_authenticated_user_cannot_rewrite_or_delete_an_audit_row(conn, two_users):
    """events is append-only or it is decoration. 0002 revokes update/delete."""
    u = two_users
    as_authenticated(conn, u["a"])
    for sql in (
        "update public.events set kind = 'tampered' where user_id = %s",
        "delete from public.events where user_id = %s",
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(sql, (u["a"],))
        assert "permission denied" in str(exc.value).lower(), sql


def test_an_authenticated_user_cannot_truncate_the_audit_trail(conn, two_users):
    """TRUNCATE is not covered by RLS and is not an UPDATE or a DELETE.

    Revoking update/delete on `events` reads like "the audit trail cannot be
    rewritten", and it is not: TRUNCATE is governed by its own privilege, which
    the owner holds by default. One statement emptied the entire append-only
    trail for every user at once — the loudest possible action leaving the
    quietest possible trace, since the evidence is what gets deleted.
    """
    u = two_users
    as_authenticated(conn, u["a"])
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("truncate public.events")
    assert "permission denied" in str(exc.value).lower()

    conn.execute("reset role")
    assert count(conn, "select count(*) from public.events where user_id = %s", u["a"]) > 0


def test_command_idempotency_is_not_readable_by_anyone(conn, two_users):
    """Its stored results contain whole posting rows. RLS is on with no policy,
    so it is default-deny; it is reached only through security-definer code."""
    u = two_users
    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.command_idempotency") == 0


# ---------------------------------------------------------- the write path

def test_the_write_path_still_works_as_a_real_signed_in_session(conn, two_users):
    """Everything above is worthless if the app cannot function under the same
    role. `app_set_triage` is security definer precisely so it can write past
    the policies — this proves that still holds for an ordinary session."""
    u = two_users
    as_authenticated(conn, u["a"])
    row = conn.execute(
        "select public.app_set_triage(%s,'interested',null,'',%s,null)",
        (u["ka"], str(uuid.uuid4())),
    ).fetchone()[0]
    assert row["triage"] == "interested"

    conn.execute("reset role")
    assert count(
        conn,
        "select count(*) from public.events where user_id = %s and kind = 'action.interested'",
        u["a"],
    ) >= 1


def test_a_user_cannot_triage_a_posting_they_cannot_see(conn, two_users):
    u = two_users
    as_authenticated(conn, u["a"])
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "select public.app_set_triage(%s,'dismissed',null,'',%s,null)",
            (u["kb"], str(uuid.uuid4())),
        )
    assert "no such posting" in str(exc.value).lower()

    conn.execute("reset role")
    assert conn.execute(
        "select triage from public.user_postings where user_id=%s and posting_key=%s",
        (u["b"], u["kb"]),
    ).fetchone()[0] == ""
