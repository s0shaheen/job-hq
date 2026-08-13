"""The transactional-email ledger (#203), actually executed against Postgres.

`db/migrations/20260813_055534_email_sends.sql` is the durable half of
account-lifecycle mail: a send ledger claimed BEFORE any provider call, a
suppression list consulted INSIDE the claim, and a dispatch read keyed on the
audit rows `hq_activate_user` / `hq_suspend_user` (0027) already write. These
tests decide whether that migration is accepted, and each one is a line from
the issue's attack list rather than a coverage exercise:

  * Double-send. Replay `hq_activate_user` — the ledger must still hold ONE
    row, because the replay writes no second event and the unique send_key
    refuses a second claim. Then the nastier version: crash after the provider
    accepted but before the outcome was recorded — the stuck `claimed` row must
    keep every later dispatch away from the address. The ledger, not hope.
  * Suppressed address. A user whose address bounced must be REFUSED with the
    suppression named in the refusal, terminally — not retried forever.
  * Claiming sent on a refusal. `sent` without a provider message id (and the
    reverse) is unrepresentable, by CHECK and by the recorder's own raise.
  * Cross-tenant / browser reach. Browser roles hold NOTHING here — no select,
    no DML, no execute on any hq_email_* function. A second identity cannot
    read the first's rows because no identity can read anything.

NO REAL ADDRESSES. Every recipient below is synthetic (@example.com).

Run locally with a throwaway Postgres — see tests/db/test_write_path.py's
docstring. Without DATABASE_URL every test skips.
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
    schema,  # noqa: F401 — session fixture
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


# ─────────────────────────────────────────────────────────── role helpers

def as_system(conn) -> None:
    """The migration runner / SQL-editor lane: superuser, no auth.uid()."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


def as_service(conn) -> None:
    """The webapp's server lane — the only granted caller of hq_email_*."""
    as_system(conn)
    conn.execute("set role service_role")


def as_authenticated(conn, user_id: str) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def as_anon(conn) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("set role anon")


def refusal(exc) -> str:
    return (exc.value.diag.message_primary or "") if exc.value.diag else ""


# ─────────────────────────────────────────────────────────── fixtures

def pending_signup(conn, email: str | None = None) -> tuple[str, str]:
    """A real UNINVITED signup: the 0027 trigger creates users + a PENDING
    entitlement, and — deliberately — no events row. The activation event these
    tests key sends on does not exist until the operator acts."""
    as_system(conn)
    email = email or f"pending-{uuid.uuid4().hex[:10]}@example.com"
    uid = str(uuid.uuid4())
    conn.execute("insert into auth.users (id, email) values (%s, %s)", (uid, email))
    return uid, email.lower()


def activate(conn, uid: str) -> dict:
    as_system(conn)
    return conn.execute(
        "select public.hq_activate_user(%s, 'welcome')", (uid,)
    ).fetchone()[0]


def suspend(conn, uid: str) -> dict:
    as_system(conn)
    return conn.execute(
        "select public.hq_suspend_user(%s, 'hold')", (uid,)
    ).fetchone()[0]


def pending_sends(conn, for_user: str | None = None) -> list[tuple]:
    rows = conn.execute("select * from public.hq_email_pending_lifecycle()").fetchall()
    if for_user is None:
        return rows
    return [r for r in rows if str(r[1]) == str(for_user)]


def claim(conn, send_key: str, uid: str, kind: str, recipient: str) -> dict:
    return conn.execute(
        "select public.hq_email_claim_send(%s, %s, %s, %s)",
        (send_key, uid, kind, recipient),
    ).fetchone()[0]


def record(conn, send_key: str, status: str, provider: str = "",
           message_id: str = "", reason: str = "") -> dict:
    return conn.execute(
        "select public.hq_email_record_send(%s, %s, %s, %s, %s)",
        (send_key, status, provider, message_id, reason),
    ).fetchone()[0]


def ledger(conn, uid: str) -> list[tuple]:
    as_system(conn)
    return conn.execute(
        "select send_key, kind, recipient, status, provider, provider_message_id, reason "
        "  from public.email_sends where user_id = %s order by id", (uid,)
    ).fetchall()


# ═══════════════════════════════════════════ idempotency: the headline claim

def test_one_activation_is_one_pending_send_and_a_replay_adds_nothing(conn):
    """WHEN an operator activates a pending user, exactly one lifecycle send
    becomes due, keyed on the audit event — and a REPLAY of hq_activate_user
    (its documented `changed: false` path) surfaces no second send.

    KILLED BY: making hq_activate_user write its event unconditionally, or
    keying hq_email_pending_lifecycle on anything a replay re-produces.
    """
    uid, email = pending_signup(conn)
    assert pending_sends(conn, uid) == []          # signup alone mails nobody

    assert activate(conn, uid)["changed"] is True
    as_service(conn)
    due = pending_sends(conn, uid)
    assert len(due) == 1
    key, _, kind, to, _, _ = due[0]
    assert kind == "entitlement.activated"
    assert to == email
    assert key.startswith("evt:")

    replay = activate(conn, uid)
    assert replay["changed"] is False
    as_service(conn)
    assert pending_sends(conn, uid) == due          # same one send, not two


def test_claiming_and_recording_leaves_one_sent_row_and_a_replay_still_sends_nothing(conn):
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    (key, _, _, to, _, _), = pending_sends(conn, uid)

    got = claim(conn, key, uid, "lifecycle.activation", to)
    assert got == {"claimed": True, "status": "claimed", "id": got["id"]}

    # The claim removes the event from the dispatch read IMMEDIATELY — before
    # any outcome lands — so two dispatchers racing see one queue, not two.
    assert pending_sends(conn, uid) == []

    done = record(conn, key, "sent", "fixture", "msg-0001")
    assert done["status"] == "sent"
    assert done["provider_message_id"] == "msg-0001"

    activate(conn, uid)                             # the replay, after the send
    as_service(conn)
    assert pending_sends(conn, uid) == []
    assert [r[3] for r in ledger(conn, uid)] == ["sent"]   # one row, ever


def test_a_second_claim_on_the_same_key_is_refused_with_the_first_answer(conn):
    """The crash window: provider accepted, outcome never recorded. The row is
    stuck at `claimed`, and that stuck row must keep every re-run away — an
    ambiguous outcome is never blindly retried (the outcome_unknown doctrine).

    KILLED BY: `on conflict (send_key) do update`, or a claim that answers
    `claimed: true` for an existing row.
    """
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    (key, _, _, to, _, _), = pending_sends(conn, uid)

    assert claim(conn, key, uid, "lifecycle.activation", to)["claimed"] is True
    # ── the dispatcher dies here, after the provider accepted ──
    again = claim(conn, key, uid, "lifecycle.activation", to)
    assert again["claimed"] is False
    assert again["status"] == "claimed"             # ambiguous, and says so
    assert len(ledger(conn, uid)) == 1


def test_suspension_after_activation_is_its_own_send_not_a_replay(conn):
    """Reactivation-after-suspension is the one flow where the SAME account
    legitimately gets a second mail: each operator action writes its own event,
    so each mints its own key."""
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    (k1, _, kind1, _, _, _), = pending_sends(conn, uid)
    claim(conn, k1, uid, "lifecycle.activation", email)
    record(conn, k1, "sent", "fixture", "msg-a")

    suspend(conn, uid)
    as_service(conn)
    due = pending_sends(conn, uid)
    assert [d[2] for d in due] == ["entitlement.suspended"]
    assert due[0][0] != k1


# ═══════════════════════════════════════════ suppression

def test_a_suppressed_address_is_refused_and_the_refusal_names_the_suppression(conn):
    """WHEN the address bounced last week, the claim refuses, says WHICH
    suppression applied, and the refusal is terminal — recorded once, asked
    never again. No provider is consulted (nothing here could).

    KILLED BY: dropping the suppression lookup from hq_email_claim_send, or
    recording the refusal without occupying the send_key.
    """
    uid, email = pending_signup(conn)
    as_service(conn)
    got = conn.execute(
        "select public.hq_email_suppress(%s, 'bounce', 'resend')", (email,)
    ).fetchone()[0]
    assert got == {"suppressed": True, "created": True}

    activate(conn, uid)
    as_service(conn)
    (key, _, _, to, _, _), = pending_sends(conn, uid)

    first = claim(conn, key, uid, "lifecycle.activation", to)
    assert first["claimed"] is False
    assert first["status"] == "suppressed"
    assert "bounce" in first["reason"]
    assert "resend" in first["reason"]

    # Terminal: the key is taken, the dispatch read is quiet, and a re-ask gets
    # the same answer instead of a retry loop.
    assert pending_sends(conn, uid) == []
    again = claim(conn, key, uid, "lifecycle.activation", to)
    assert again == {"claimed": False, "status": "suppressed", "reason": first["reason"]}
    assert [r[3] for r in ledger(conn, uid)] == ["suppressed"]


def test_suppression_is_idempotent_and_the_first_reason_stands(conn):
    uid, email = pending_signup(conn)
    as_service(conn)
    conn.execute("select public.hq_email_suppress(%s, 'bounce', 'resend')", (email,))
    second = conn.execute(
        "select public.hq_email_suppress(%s, 'complaint', 'resend')", (email,)
    ).fetchone()[0]
    assert second == {"suppressed": True, "created": False}
    as_system(conn)
    reason = conn.execute(
        "select reason from public.email_suppressions where address = %s", (email,)
    ).fetchone()[0]
    assert reason == "bounce"


def test_suppress_fails_loud_on_an_unknown_address_and_a_made_up_reason(conn):
    as_service(conn)
    with pytest.raises(psycopg.errors.NoDataFound):
        conn.execute("select public.hq_email_suppress('nobody@example.com', 'bounce', '')")
    uid, email = pending_signup(conn)
    as_service(conn)
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        conn.execute("select public.hq_email_suppress(%s, 'vibes', '')", (email,))
    assert "not a suppression reason" in refusal(exc)


# ═══════════════════════════════════════════ the recorder's refusals

def test_sent_without_a_message_id_is_unrepresentable(conn):
    """Claiming sent on a 4xx/5xx is the attack; the shape that would carry it
    — status 'sent', no provider evidence — is refused by the recorder AND by
    the table CHECK, so no code path (including a future one) can write it.

    KILLED BY: dropping email_sends_sent_has_message_id, or the recorder's
    argument check alone (the direct-insert half would still fail).
    """
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    (key, _, _, to, _, _), = pending_sends(conn, uid)
    claim(conn, key, uid, "lifecycle.activation", to)

    with pytest.raises(psycopg.errors.InvalidParameterValue):
        record(conn, key, "sent")                       # no message id
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        record(conn, key, "failed", "resend", "msg-x")  # evidence on a failure

    # And below the function: the constraint itself holds for a raw write.
    as_system(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "insert into public.email_sends (user_id, kind, send_key, recipient, status) "
            "values (%s, 'lifecycle.activation', 'raw:1', %s, 'sent')", (uid, email))


def test_a_provider_refusal_lands_as_failed_with_the_reason_never_success(conn):
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    (key, _, _, to, _, _), = pending_sends(conn, uid)
    claim(conn, key, uid, "lifecycle.activation", to)

    done = record(conn, key, "failed", "resend", "", "resend 403: sending domain not verified")
    assert done["status"] == "failed"
    (row,) = ledger(conn, uid)
    assert row[3] == "failed"
    assert "domain not verified" in row[6]
    assert row[5] == ""                                 # no message id claimed


def test_recording_an_unclaimed_or_already_terminal_key_raises(conn):
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    with pytest.raises(psycopg.errors.NoDataFound):
        record(conn, "evt:999999999", "failed", "resend", "", "x")

    (key, _, _, to, _, _), = pending_sends(conn, uid)
    claim(conn, key, uid, "lifecycle.activation", to)
    record(conn, key, "sent", "fixture", "msg-1")
    with pytest.raises(psycopg.errors.NoDataFound) as exc:
        record(conn, key, "failed", "resend", "", "second thoughts")
    assert "already recorded" in refusal(exc)
    assert [r[3] for r in ledger(conn, uid)] == ["sent"]


def test_the_flag_off_skip_is_a_recorded_row_not_a_silent_drop(conn):
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    (key, _, _, to, _, _), = pending_sends(conn, uid)
    claim(conn, key, uid, "lifecycle.activation", to)
    done = record(conn, key, "skipped", "", "", "email disabled: RESEND_API_KEY is not set")
    assert done["status"] == "skipped"
    (row,) = ledger(conn, uid)
    assert row[3] == "skipped"
    assert "RESEND_API_KEY" in row[6]
    # Terminal by design: mail that was off when the fact happened is not sent
    # weeks later when the flag turns on. The dispatch read stays quiet.
    assert pending_sends(conn, uid) == []


def test_the_claim_fails_loud_on_garbage(conn):
    uid, email = pending_signup(conn)
    as_service(conn)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        claim(conn, "", uid, "lifecycle.activation", email)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        claim(conn, "evt:1", uid, "lifecycle.activation", "   ")
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        claim(conn, "evt:1", str(uuid.uuid4()), "lifecycle.activation", email)
    with pytest.raises(psycopg.errors.CheckViolation):
        claim(conn, f"bad-kind:{uid}", uid, "lifecycle.newsletter", email)


# ═══════════════════════════════════════════ browser roles hold nothing

def test_browser_roles_reach_no_table_and_no_function(conn):
    """The server lane is the ONLY lane. `authenticated` — even an ACTIVE,
    entitled account — can neither read the ledger nor call any hq_email_*
    function; `anon` even less. Cross-tenant reads are impossible a fortiori:
    no identity reads anything.

    KILLED BY: any `grant` to anon/authenticated on these tables or functions,
    or an `on conflict` path that leaks through a definer (none is definer).
    """
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    (key, _, _, to, _, _), = pending_sends(conn, uid)
    claim(conn, key, uid, "lifecycle.activation", to)
    record(conn, key, "sent", "fixture", "msg-priv")

    intruder, _ = pending_signup(conn)
    activate(conn, intruder)

    for become in (lambda: as_authenticated(conn, intruder),
                   lambda: as_authenticated(conn, uid),   # even the row's owner
                   lambda: as_anon(conn)):
        become()
        for table in ("email_sends", "email_suppressions"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(f"select * from public.{table}")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(
                    f"insert into public.{table} (user_id, address, reason) "
                    "values (%s, 'x@example.com', 'manual')"
                    if table == "email_suppressions" else
                    f"insert into public.{table} (user_id, kind, send_key, recipient) "
                    "values (%s, 'lifecycle.activation', 'steal:1', 'x@example.com')",
                    (uid,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("select * from public.hq_email_pending_lifecycle()")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "select public.hq_email_claim_send('k', %s, 'lifecycle.activation', %s)",
                (uid, to))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("select public.hq_email_record_send('k', 'failed', '', '', 'x')")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("select public.hq_email_suppress(%s, 'manual', '')", (to,))
    conn.execute("reset role")


def test_the_service_role_is_actually_granted(conn):
    """The positive control for the sweep above: the grants exist, so the
    webapp's server lane works without superuser. (Every earlier test drove
    the functions as service_role; this pins the table privileges too — the
    functions are NOT security definer, so service_role's own table rights are
    what the claim runs on.)"""
    uid, email = pending_signup(conn)
    activate(conn, uid)
    as_service(conn)
    (key, _, _, to, _, _), = pending_sends(conn, uid)
    got = claim(conn, key, uid, "lifecycle.activation", to)
    assert got["claimed"] is True
    conn.execute("reset role")
