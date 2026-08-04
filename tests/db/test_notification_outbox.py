"""Acceptance tests for `notification_outbox` — the quiet-hours queue's Postgres home.

The design is `docs/plans/SHEET-FACILITIES.md` §3. This file decides whether the
migration is accepted, and it is written before the DDL for the reason that section
gives: this is the one facility of the four whose failure mode is the whole point.
`core/outbox.py:1` states it — "suppressed is not dropped" — and a queue that silently
loses a held notification is worse than one that refuses, because a dropped notification
is indistinguishable from a broken system.

WHAT MOVES, AND WHAT THE MOVE CHANGES. The Outbox tab becomes a table; `core/outbox.py`
keeps its semantics with two exceptions the design argues for and these tests pin:

  * `_free_key` (`core/outbox.py:62`) goes. Its `key-2`, `key-3` suffixing exists solely
    because `core.sheets.Tab.key_index` aborts the whole tab on a duplicate key. The
    invariant it was approximating — at most one OPEN row per (user, content) — is a
    partial unique index here, and closed history keeps as many rows with one dedupe_key
    as it likes. `core/outbox.py:83` already says that is what it wants.
  * `exists()` (`:122`) goes. Its job is the window between shipping a tab and self-heal
    creating it; a migration has applied or it has not.

WHAT THE MOVE PUTS AT RISK, said out loud because it is new. `core/outbox.py:17` records
that per-user isolation used to be STRUCTURAL — each user's queue lived in their own
spreadsheet, "so there is no user column to get wrong." One table for every tenant
introduces that column for the first time, and the tests below treat it as the primary
attack surface rather than a formality.

THESE NO LONGER SKIP: the migration is `db/migrations/20260803_105951_notification_outbox
.sql`, on this branch. See tests/db/test_engine_cursors.py's docstring for why the earlier
`to_regclass` guard existed and why it had to go the moment its condition did.

NO REAL NOTIFICATION TEXT. `title` and `body` are rendered user content naming companies
and roles. Every fixture value here is obviously synthetic.

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

TABLE = "notification_outbox"


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def as_authenticated(conn, user_id: str) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def as_engine(conn) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


def enqueue(conn, user_id: str, dedupe_key: str, *, event: str = "new_roles",
            deliver_after: str | None = "2026-08-03T06:30:00Z",
            title: str = "Test notification",
            body: str = "Synthetic body") -> bool:
    """`core.outbox.enqueue` as it becomes here.

    Returns True when the notification is durably queued — INCLUDING when an identical
    one is already queued and open, which is the contract `core/outbox.py:79` states.
    The `on conflict do nothing` is the whole of the dedupe: the partial unique index
    decides what "identical and open" means, so there is no read-then-write race for two
    sweeps inside one quiet window to lose.
    """
    row = conn.execute(
        "insert into public.notification_outbox "
        "  (user_id, dedupe_key, event, deliver_after, title, body) "
        "values (%s, %s, %s, %s, %s, %s) "
        "on conflict do nothing returning id",
        (user_id, dedupe_key, event, deliver_after, title, body),
    ).fetchone()
    if row is not None:
        return True
    # No row inserted: either an open duplicate exists (durably queued, the honest True)
    # or something else refused, which must not be reported as queued.
    open_rows = conn.execute(
        "select count(*) from public.notification_outbox "
        " where user_id = %s and dedupe_key = %s and delivered_at is null",
        (user_id, dedupe_key)).fetchone()[0]
    return open_rows > 0


def close(conn, row_id: int, outcome: str) -> None:
    conn.execute(
        "update public.notification_outbox "
        "   set delivered_at = now(), attempts = attempts + 1, outcome = %s "
        " where id = %s", (outcome, row_id))


def due(conn, user_id: str) -> list[tuple]:
    """`core.outbox.due`: undelivered rows whose wake time has passed. A NULL
    `deliver_after` is DUE — "between 'send it late' and 'never send it', late wins"
    (`core/outbox.py:143`)."""
    return conn.execute(
        "select id, dedupe_key from public.notification_outbox "
        " where user_id = %s and delivered_at is null "
        "   and (deliver_after is null or deliver_after <= now()) "
        " order by id", (user_id,)).fetchall()


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


# ------------------------------------------------------------------- the open latch

def test_a_second_enqueue_inside_one_quiet_window_does_not_buzz_the_phone_twice(conn):
    """Two sweeps inside one quiet window that find the same roles produce the same
    push, and queueing it twice would buzz the phone twice at 06:30 for one piece of
    news (`core/outbox.py:45`).

    The second call still returns True, because the notification IS durably queued —
    returning False would make `core.notify._hold` page ops for a queue that is working
    correctly.

    Asserted on the stored row count AND the return value: a version that inserted a
    second row would return True just as happily.

    KILLED BY: dropping the partial unique index, or making the insert unconditional.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    assert enqueue(conn, uid, "abc123") is True
    assert enqueue(conn, uid, "abc123") is True
    assert conn.execute(
        "select count(*) from public.notification_outbox where user_id = %s",
        (uid,)).fetchone()[0] == 1


def test_the_same_news_raised_again_after_delivery_is_news_again(conn):
    """Dedupe is against OPEN rows only. Matching a delivered or abandoned row would
    make `enqueue` return True — "durably queued" — for a notification that was never
    written down, which is the silent drop the facility exists to prevent, wearing a
    success return value (`core/outbox.py:81`).

    This is also the test that makes `_free_key` unnecessary: the closed row keeps its
    dedupe_key, and the new open row has the same one, with no `-2` suffix anywhere.

    KILLED BY: making the unique index total instead of partial on `delivered_at is null`.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    enqueue(conn, uid, "abc123")
    row_id = due(conn, uid)[0][0]
    close(conn, row_id, "sent")

    assert due(conn, uid) == [], "a delivered row is still being flushed"
    assert enqueue(conn, uid, "abc123") is True
    reopened = due(conn, uid)
    assert len(reopened) == 1 and reopened[0][1] == "abc123", (
        "the same news raised after delivery was swallowed by the closed row")
    assert conn.execute(
        "select count(*) from public.notification_outbox where user_id = %s "
        "  and dedupe_key = 'abc123'", (uid,)).fetchone()[0] == 2


def test_two_tenants_holding_identical_news_both_get_it(conn):
    """The tenancy failure this table introduces, driven directly.

    Isolation used to be structural — one spreadsheet per user. With one shared table, a
    unique index on `dedupe_key` alone would collapse two users' identical notification
    into one row, and exactly one of them would silently receive nothing: the facility's
    own failure mode, arriving through its deduplication mechanism.

    `core.outbox.record_key` does include `user` in the hash (`core/outbox.py:57`), so
    in practice the two keys differ — which is precisely why this test supplies the SAME
    key by hand. A tenancy guarantee that rests on a hash input is a guarantee one
    refactor away from gone, and the index is what has to hold it.

    KILLED BY: dropping `user_id` from the partial unique index.
    """
    a = make_user(conn, f"a-{uuid.uuid4()}@example.com")
    b = make_user(conn, f"b-{uuid.uuid4()}@example.com")

    assert enqueue(conn, a, "same-hash") is True
    assert enqueue(conn, b, "same-hash") is True

    assert [r[1] for r in due(conn, a)] == ["same-hash"]
    assert [r[1] for r in due(conn, b)] == ["same-hash"], (
        "one tenant's held notification silenced another's")


def test_a_row_is_open_or_closed_and_never_delivered_with_no_outcome(conn):
    """The state machine made TOTAL rather than conventional, the move
    `bot_runs_outcome_matches_finish` (0023) makes for the same reason.

    `tracker/outbox.py:19` insists every outcome string names what actually occurred —
    "abandoned after 3 failed sends" on a row where no send was attempted sends the
    operator looking for a network fault. A row stamped delivered with no outcome is the
    degenerate case of that: it ended, nobody knows how, and neither the flush loop nor
    a human can act on it.

    Both illegal combinations are driven, and the legal pair is asserted first so the
    constraint cannot be passing by rejecting everything.

    KILLED BY: dropping the check constraint.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    enqueue(conn, uid, "k1")
    row_id = due(conn, uid)[0][0]
    close(conn, row_id, "sent")                     # the legal close

    with pytest.raises(psycopg.errors.CheckViolation) as exc:
        conn.execute(
            "update public.notification_outbox set delivered_at = now(), outcome = '' "
            " where id = %s", (row_id,))
    assert "notification_outbox" in exc.value.diag.message_primary

    enqueue(conn, uid, "k2")
    open_id = due(conn, uid)[0][0]
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "update public.notification_outbox set outcome = 'sent' where id = %s",
            (open_id,))


def test_a_row_with_no_wake_time_is_due_now(conn):
    """`core/outbox.py:143`: a row whose `deliver_after` cannot be read is treated as
    DUE, because between "send it late" and "never send it", late wins — that is the
    whole premise. NULL carries that into the type system, so no caller ever has to
    invent a timestamp for a row that has no wake time.

    The held row is the control: it must NOT come back, or "everything is due" would
    pass this too.

    KILLED BY: `deliver_after timestamptz not null`, or dropping the `is null` arm of
    the due predicate.
    """
    assert _cols(conn, TABLE)["deliver_after"][1] == "YES"

    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    enqueue(conn, uid, "no-wake", deliver_after=None)
    enqueue(conn, uid, "held", deliver_after="2099-01-01T00:00:00Z")
    enqueue(conn, uid, "ripe", deliver_after="2026-01-01T00:00:00Z")

    assert sorted(r[1] for r in due(conn, uid)) == ["no-wake", "ripe"]


def test_a_deleted_account_leaves_no_queued_notification_behind(conn):
    """Retention at the only boundary that can enforce it. A held push carries rendered
    notification text about a person's job search; it must not outlive their account.

    A second account holds rows throughout. Without it, "0 rows left" is equally true of
    a cascade that emptied the whole table, which is a data-loss bug wearing this test's
    green tick.

    KILLED BY: dropping the `on delete cascade`, or widening it to the table.
    """
    doomed = make_user(conn, f"doomed-{uuid.uuid4()}@example.com")
    bystander = make_user(conn, f"bystander-{uuid.uuid4()}@example.com")
    enqueue(conn, doomed, "k1")
    enqueue(conn, doomed, "k2", deliver_after=None)
    enqueue(conn, bystander, "k1")

    def held(user_id: str) -> int:
        return conn.execute(
            "select count(*) from public.notification_outbox where user_id = %s",
            (user_id,)).fetchone()[0]

    assert (held(doomed), held(bystander)) == (2, 1), "the fixture never queued anything"

    conn.execute("delete from auth.users where id = %s", (doomed,))
    assert held(doomed) == 0, "a deleted account's held notifications outlived it"
    assert held(bystander) == 1, "the cascade took another account's queue with it"


# --------------------------------------------------------------------- the boundary

@pytest.mark.parametrize("sql", [
    "insert into public.notification_outbox (user_id, dedupe_key, event) "
    "values (%s, 'injected', 'new_roles')",
    "update public.notification_outbox set body = 'Injected' where user_id = %s",
    "delete from public.notification_outbox where user_id = %s",
    "select body from public.notification_outbox where user_id = %s",
])
def test_no_browser_session_reaches_this_table_at_all(conn, sql):
    """Stricter than `bot_runs` and `monitor_sweep_state`, which keep `select`.

    `title` and `body` are rendered notification text naming companies and roles —
    private user content. There is no design state for a held-notifications surface, and
    inventing one is forbidden, so the browser gets nothing: not a read, not a write,
    not a function.

    The account is ACTIVE, entitled, and OWNS the rows — the strongest control
    available. A refusal that only held for a suspended account would be proving the
    entitlement gate instead of the missing grant.

    Asserted on `diag.message_primary`, not `str(exc)`: the latter carries the CONTEXT
    block, which echoes the statement's own SQL, so this table's name appearing in it
    would prove nothing at all.

    KILLED BY: dropping any verb from the `revoke ... from public, anon, authenticated`.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    enqueue(conn, uid, "private")

    as_authenticated(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(sql, (uid,))
    assert "notification_outbox" in exc.value.diag.message_primary, (
        f"the refusal did not name this table: {exc.value.diag.message_primary!r}")

    as_engine(conn)
    assert conn.execute(
        "select body from public.notification_outbox where user_id = %s",
        (uid,)).fetchone() == ("Synthetic body",)


def test_the_entitlement_gate_is_armed_for_a_grant_this_table_does_not_have_yet(conn):
    """The gate that only matters later, proven now rather than trusted.

    With every privilege revoked, `test_default_deny.py`'s catalog sweep may not count
    this table as browser-reachable, so its restrictive policy and definer-path trigger
    are not what that check is asking for. They are there so a LATER migration that
    grants `select` for some future surface cannot un-gate the table by omission — a
    table created after 0027 inherits nothing, and a table that becomes browser-reachable
    inherits nothing either. That hole was found and closed on another branch this week.

    So the grant is made here, inside the test, and taken away again: the gate is driven
    over the real path an entitled owner would use, then over the same path for a pending
    and a suspended account, then a second tenant. The entitled read comes first, so a
    gate that denied everybody could not pass this as a refusal.

    KILLED BY: deleting the `notification_outbox_entitled` restrictive policy, or the
    permissive owner-read policy it is ANDed with.
    """
    owner = make_user(conn, f"owner-{uuid.uuid4()}@example.com")
    other = make_user(conn, f"other-{uuid.uuid4()}@example.com")
    pending = str(uuid.uuid4())
    as_engine(conn)
    conn.execute("insert into auth.users (id, email) values (%s, %s)",
                 (pending, f"pending-{uuid.uuid4()}@example.com"))

    enqueue(conn, owner, "owners-row", title="Owner", body="Owner body")
    enqueue(conn, other, "others-row", title="Other", body="Other body")
    enqueue(conn, pending, "pendings-row", title="Pending", body="Pending body")

    conn.execute("grant select on public.notification_outbox to authenticated")
    try:
        as_authenticated(conn, owner)
        assert conn.execute(
            "select dedupe_key from public.notification_outbox").fetchall() \
            == [("owners-row",)], (
                "with select granted, an entitled owner reads their own row and only "
                "their own — the positive control for both refusals below")

        as_authenticated(conn, pending)
        assert conn.execute(
            "select dedupe_key from public.notification_outbox").fetchall() == []

        as_engine(conn)
        conn.execute("select public.hq_suspend_user(%s, 'abuse')", (owner,))
        as_authenticated(conn, owner)
        assert conn.execute(
            "select dedupe_key from public.notification_outbox").fetchall() == []
    finally:
        as_engine(conn)
        conn.execute("revoke select on public.notification_outbox from authenticated")

    # And the revoke really went back, or every later test in this file is measuring a
    # table that is no longer the one the migration shipped.
    as_authenticated(conn, other)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("select dedupe_key from public.notification_outbox")
