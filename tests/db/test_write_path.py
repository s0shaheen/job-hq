"""The write path, actually executed against Postgres.

`tests/core/test_migrations.py` reads the SQL as text. That catches a function
the app calls but nobody defined — the bug that prompted all of this — and it
cannot catch a logic error. Everything here RUNS.

These tests discharge acceptance criteria 9, 10, 11 and 26 from
docs/PRODUCT-SPEC.md §H, which until now had no executable proof anywhere:

    9  `i` on a queue row -> triage=interested, one application at Queued, one event
    10 undo -> triage reverts, application removed, a COMPENSATING event is
       appended (the original event is never deleted)
    11 an application a bot already advanced survives an un-triage
    26 two concurrent triage writes -> one succeeds, one 409s, exactly one event

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q

Without DATABASE_URL every test here skips, so the default suite stays
dependency-free. CI sets it (see .github/workflows/ci.yml, job `db`).
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# A suite that skips itself reports green, which is worse than not existing. CI
# sets HQ_REQUIRE_DB=1, so a misconfigured job fails loudly instead of quietly
# proving nothing.
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError(
        "HQ_REQUIRE_DB=1 but DATABASE_URL is unset — the db suite would have "
        "skipped every test and reported success"
    )

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "db" / "test-harness.sql"
MIGRATIONS = sorted((ROOT / "db" / "migrations").glob("*.sql"))


@pytest.fixture(scope="session")
def schema():
    """Apply the harness + every migration once, to a clean schema.

    Applying them in order against an empty database is itself a test: a
    migration that does not apply is a migration that cannot ship, and nothing
    else in this repo would have noticed.
    """
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute("drop schema if exists public cascade")
        conn.execute("drop schema if exists auth cascade")
        conn.execute("create schema public")
        conn.execute(HARNESS.read_text())
        for m in MIGRATIONS:
            try:
                conn.execute(m.read_text())
            except Exception as exc:  # pragma: no cover - surfaces as a failure
                pytest.fail(f"{m.name} failed to apply: {exc}")
    return True


@pytest.fixture
def conn(schema):
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def as_user(conn, user_id: str):
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))


def make_user(conn, email: str = "a@example.com") -> str:
    """Create a user the way a real signup does.

    Allowlist first: 0001's `handle_new_auth_user` trigger fires on the
    auth.users insert and REFUSES any address not in `allowed_emails` — the
    front door of the whole system ("non-allowlisted emails are refused at the
    door"). The trigger then creates the public.users row itself, so inserting
    one here would be writing a row the system owns.

    This exercising the real signup path is the point: a helper that inserted
    into public.users directly would have quietly bypassed the gate and proved
    nothing about it.
    """
    uid = str(uuid.uuid4())
    conn.execute(
        "insert into public.allowed_emails (email) values (%s) on conflict do nothing",
        (email.lower(),),
    )
    conn.execute("insert into auth.users (id, email) values (%s, %s)", (uid, email))
    return uid


def make_posting(conn, key: str = "greenhouse-1", company: str = "Ramp") -> str:
    # first_seen/last_seen are NOT NULL: a posting the engine never saw is not
    # a posting. Supplying them keeps the fixture honest about that.
    conn.execute(
        """insert into public.postings
             (key, company, title, url, status, first_seen, last_seen)
           values (%s, %s, 'Product Manager', 'https://example.com/1', 'Open',
                   current_date, current_date)
           on conflict (key) do nothing""",
        (key, company),
    )
    return key


def gate(conn, user_id: str, key: str, disposition: str = "qualified") -> None:
    conn.execute(
        """insert into public.user_postings (user_id, posting_key, disposition)
           values (%s, %s, %s)
           on conflict (user_id, posting_key) do nothing""",
        (user_id, key, disposition),
    )


def set_triage(conn, key, triage, idem, expected=None, snooze=None, reason=""):
    return conn.execute(
        "select public.app_set_triage(%s, %s, %s, %s, %s, %s)",
        (key, triage, snooze, reason, idem, expected),
    ).fetchone()[0]


def updated_at(conn, user_id, key):
    return conn.execute(
        "select updated_at from public.user_postings where user_id=%s and posting_key=%s",
        (user_id, key),
    ).fetchone()[0]


# ------------------------------------------------------------------ AC 9

def test_interested_creates_one_application_and_one_event(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    result = set_triage(conn, key, "interested", idem=str(uuid.uuid4()))

    assert result["triage"] == "interested"
    # The row the client renders comes back from inside the same transaction
    # that wrote it, nested exactly as toJobView() unwraps it.
    assert result["postings"]["key"] == key

    apps = conn.execute(
        "select status from public.applications where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchall()
    assert apps == [("Queued",)]

    events = conn.execute(
        "select kind, actor from public.events where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchall()
    assert events == [("action.interested", "user")]


# ------------------------------------------------------------------ AC 10

def test_undo_reverts_and_appends_a_compensating_event(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    set_triage(conn, key, "interested", idem=str(uuid.uuid4()))
    set_triage(conn, key, "", idem=str(uuid.uuid4()),
               expected=updated_at(conn, user, key))

    triage = conn.execute(
        "select triage from public.user_postings where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchone()[0]
    assert triage == ""

    assert conn.execute(
        "select count(*) from public.applications where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchone()[0] == 0

    kinds = [r[0] for r in conn.execute(
        "select kind from public.events where user_id=%s and posting_key=%s order by id",
        (user, key),
    ).fetchall()]
    # The original is still there. An audit trail you can rewrite is not one.
    assert kinds == ["action.interested", "action.untriage"]


# ------------------------------------------------------------------ AC 11

def test_untriage_keeps_an_application_a_bot_already_advanced(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    set_triage(conn, key, "interested", idem=str(uuid.uuid4()))
    # A confirmation email arrived and the engine advanced it. That application
    # is now evidence of something that really happened.
    conn.execute(
        "update public.applications set status='Applied' where user_id=%s and posting_key=%s",
        (user, key),
    )

    set_triage(conn, key, "", idem=str(uuid.uuid4()),
               expected=updated_at(conn, user, key))

    rows = conn.execute(
        "select status from public.applications where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchall()
    assert rows == [("Applied",)], "un-triage erased a bot-advanced application"


# ------------------------------------------------------------- idempotency

def test_replaying_a_key_returns_the_first_result_and_writes_once(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    idem = str(uuid.uuid4())
    first = set_triage(conn, key, "interested", idem=idem)
    second = set_triage(conn, key, "interested", idem=idem)

    assert first == second, "a replayed key returned a different result"
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and posting_key=%s", (user, key)
    ).fetchone()[0] == 1
    assert conn.execute(
        "select count(*) from public.applications where user_id=%s and posting_key=%s", (user, key)
    ).fetchone()[0] == 1


def test_a_replay_is_free_even_after_the_row_moved_on(conn):
    """The offline outbox replays gestures precisely because it does not know
    whether they landed. A replay arriving after the row changed must still
    return the original result rather than fail a conflict check."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    idem = str(uuid.uuid4())
    first = set_triage(conn, key, "dismissed", idem=idem)
    set_triage(conn, key, "", idem=str(uuid.uuid4()), expected=updated_at(conn, user, key))

    assert set_triage(conn, key, "dismissed", idem=idem) == first


# ------------------------------------------------------- optimistic concurrency

def test_a_stale_expected_updated_at_is_a_conflict(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    stale = updated_at(conn, user, key)
    set_triage(conn, key, "dismissed", idem=str(uuid.uuid4()), expected=stale)

    with pytest.raises(psycopg.errors.Error) as exc:
        set_triage(conn, key, "interested", idem=str(uuid.uuid4()), expected=stale)
    # supabase-source.ts matches /conflict|stale/i to choose the conflict path.
    assert "conflict" in str(exc.value).lower()


def test_the_expectation_round_trips_as_the_string_the_client_actually_sends(conn):
    """The browser never sends a timestamp object — it sends back the exact
    string it read, and Supabase casts it to timestamptz.

    This is where precision goes wrong. Postgres keeps microseconds; anything
    that passes the value through a JS `Date` truncates to milliseconds, and a
    truncated expectation never equals the stored value again. The symptom is
    not an error — it is every second gesture reporting a phantom conflict,
    which reads as "the app randomly refuses to save".
    """
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    # Exactly what supabase-source.ts hands back: the raw column, as text.
    as_text = conn.execute(
        "select updated_at::text from public.user_postings where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchone()[0]
    assert isinstance(as_text, str)

    set_triage(conn, key, "interested", idem=str(uuid.uuid4()), expected=as_text)

    assert conn.execute(
        "select triage from public.user_postings where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchone()[0] == "interested"


def test_a_millisecond_truncated_expectation_is_caught_as_a_conflict(conn):
    """The other half of the precision story: if a client DOES truncate, that
    must surface as a conflict the UI handles, never as a silent overwrite."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    truncated = conn.execute(
        "select date_trunc('milliseconds', updated_at)::text from public.user_postings "
        "where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchone()[0]
    exact = conn.execute(
        "select updated_at::text from public.user_postings where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchone()[0]
    if truncated == exact:
        pytest.skip("this row's timestamp happens to have no sub-millisecond part")

    with pytest.raises(psycopg.errors.Error) as exc:
        set_triage(conn, key, "interested", idem=str(uuid.uuid4()), expected=truncated)
    assert "conflict" in str(exc.value).lower()


def test_a_null_expectation_is_allowed(conn):
    """Sending no expectation is knowingly choosing last-write-wins, which the
    undo path and the outbox replay both rely on."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)
    set_triage(conn, key, "dismissed", idem=str(uuid.uuid4()))
    set_triage(conn, key, "interested", idem=str(uuid.uuid4()), expected=None)


# ------------------------------------------------------------------ AC 26

def test_two_concurrent_writes_produce_one_success_and_exactly_one_event(conn):
    """Both sessions read the same updated_at, then both write. Without the row
    lock, both pass the conflict check and both commit — two events for one
    decision, and a silent clobber."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)
    seen = updated_at(conn, user, key)

    outcomes: list[str] = []
    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        for c in (a, b):
            c.execute("select set_config('hq.test_user', %s, false)", (user,))
        # B must not sit on A's row lock until the test times out: a bounded
        # wait turns "blocked" into a visible outcome instead of a hang.
        b.execute("set lock_timeout = '3s'")

        # A writes and holds the lock inside an open transaction.
        try:
            a.execute(
                "select public.app_set_triage(%s,'interested',null,'',%s,%s)",
                (key, str(uuid.uuid4()), seen),
            )
            outcomes.append("a-ok")
        except psycopg.errors.Error as exc:
            outcomes.append(f"a-fail:{exc}")

        # B arrives with the SAME updated_at it read before A ran. It blocks on
        # the row lock until A commits, and then must see a conflict — the lock
        # is what stops both from passing the check and both writing.
        a.commit()
        try:
            b.execute(
                "select public.app_set_triage(%s,'dismissed',null,'',%s,%s)",
                (key, str(uuid.uuid4()), seen),
            )
            b.commit()
            outcomes.append("b-ok")
        except psycopg.errors.Error as exc:
            b.rollback()
            outcomes.append(f"b-fail:{exc}")

    assert sum(o.endswith("-ok") for o in outcomes) == 1, outcomes
    assert any("conflict" in o.lower() for o in outcomes if "fail" in o), outcomes
    # Exactly one event: the loser wrote nothing at all, not even an audit row.
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and posting_key=%s", (user, key)
    ).fetchone()[0] == 1


# ------------------------------------------------------------------ security

def test_a_non_allowlisted_email_cannot_become_a_user(conn):
    """Journey B1's first line: "non-allowlisted emails are refused at the door."

    This one announced itself — the first run of this suite failed on it,
    because the helper created users without seeding the allowlist. Worth an
    explicit test rather than an incidental one: the gate is the only thing
    standing between a Google sign-in button and anybody with a Gmail account.
    """
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "insert into auth.users (id, email) values (%s, %s)",
            (str(uuid.uuid4()), f"stranger-{uuid.uuid4()}@example.com"),
        )
    assert "not allowlisted" in str(exc.value).lower()


def test_an_unauthenticated_caller_is_refused(conn):
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    conn.execute("select set_config('hq.test_user', '', false)")
    with pytest.raises(psycopg.errors.Error) as exc:
        set_triage(conn, key, "interested", idem=str(uuid.uuid4()))
    assert "not authenticated" in str(exc.value).lower()


def test_a_user_cannot_triage_another_users_row(conn):
    """The function derives the user from auth.uid(); there is no argument to
    name someone else. The blast radius of a hostile caller is itself."""
    victim = make_user(conn, f"{uuid.uuid4()}@example.com")
    attacker = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, victim, key)

    as_user(conn, attacker)
    with pytest.raises(psycopg.errors.Error) as exc:
        set_triage(conn, key, "dismissed", idem=str(uuid.uuid4()))
    assert "no such posting" in str(exc.value).lower()

    assert conn.execute(
        "select triage from public.user_postings where user_id=%s and posting_key=%s",
        (victim, key),
    ).fetchone()[0] == ""


def test_two_users_may_hold_the_same_idempotency_key(conn):
    """Keys are client-generated. They are scoped per user so one user's key
    can never replay another user's result back to them."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, a, key)
    gate(conn, b, key)
    shared = "same-key-both-users"

    as_user(conn, a)
    set_triage(conn, key, "interested", idem=shared)
    as_user(conn, b)
    set_triage(conn, key, "dismissed", idem=shared)

    assert conn.execute(
        "select triage from public.user_postings where user_id=%s and posting_key=%s", (b, key)
    ).fetchone()[0] == "dismissed"


# ------------------------------------------------------------------ validation

@pytest.mark.parametrize("bad", ["INTERESTED", "maybe", "deleted", "'; drop table users;--"])
def test_an_invalid_triage_value_is_refused(conn, bad):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)
    with pytest.raises(psycopg.errors.Error) as exc:
        set_triage(conn, key, bad, idem=str(uuid.uuid4()))
    assert "invalid triage" in str(exc.value).lower()


def test_snoozing_without_a_wake_date_is_refused(conn):
    """A snooze with no wake date is a row that leaves the queue and never
    comes back."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)
    with pytest.raises(psycopg.errors.Error) as exc:
        set_triage(conn, key, "snoozed", idem=str(uuid.uuid4()))
    assert "wake date" in str(exc.value).lower()


def test_clearing_a_snooze_clears_its_wake_date(conn):
    """A dismissed row still carrying a snooze date is a row that reanimates."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    as_user(conn, user)

    set_triage(conn, key, "snoozed", idem=str(uuid.uuid4()), snooze="2026-08-01")
    set_triage(conn, key, "dismissed", idem=str(uuid.uuid4()),
               expected=updated_at(conn, user, key))

    assert conn.execute(
        "select snooze_until from public.user_postings where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchone()[0] is None


def test_events_cannot_be_updated_by_the_app_roles(conn):
    """0002 revokes update on events from anon/authenticated/service_role. The
    audit trail is append-only or it is decoration."""
    grants = conn.execute(
        """select grantee, privilege_type from information_schema.role_table_grants
            where table_name='events' and privilege_type='UPDATE'"""
    ).fetchall()
    assert not [g for g in grants if g[0] in ("anon", "authenticated", "service_role")], grants
