"""The entitlement record, executed (migration 0027).

`tests/core/test_migrations.py` reads this migration as text: it proves the
operator functions exist, are revoked from every browser-reachable role, and pin
their search_path. It cannot prove the thing the whole model is FOR — that an
uninvited signup lands inert and stays inert. That is logic, and logic is what
looks right when you read it and is wrong when you run it.

Run it the way the rest of this directory runs:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_entitlement.py -q

Every negative here carries its positive control in the same test, for
`test_rls.py`'s reason: "a pending user reads 0 rows" is equally true of a user
who can read nothing at all, and would stay green with the entire gate deleted.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

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

ROOT = Path(__file__).resolve().parents[2]
MIGRATION_0027 = ROOT / "db" / "migrations" / "0027_entitlement.sql"


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


# ------------------------------------------------------------------ helpers

def signup(conn, email: str) -> str:
    """One real signup: insert into auth.users and let the trigger do the rest."""
    uid = str(uuid.uuid4())
    conn.execute("insert into auth.users (id, email) values (%s, %s)", (uid, email))
    return uid


def invite(conn, email: str, *, name: str = "", operator: bool = False) -> None:
    conn.execute(
        """insert into public.allowed_emails (email, name, is_operator)
           values (%s, %s, %s) on conflict (email) do nothing""",
        (email.lower(), name, operator),
    )


def ent(conn, uid: str) -> dict:
    row = conn.execute(
        """select status, invited, invite_ref, plan, activated_at, suspended_at, reason
             from public.entitlements where user_id = %s""",
        (uid,),
    ).fetchone()
    if row is None:
        return {}
    keys = ("status", "invited", "invite_ref", "plan", "activated_at", "suspended_at", "reason")
    return dict(zip(keys, row))


def as_authenticated(conn, user_id: str) -> None:
    """Become a signed-in browser session: an identity AND the anon-key role.

    Skipping `set role` is the difference between testing RLS and testing
    nothing — `postgres` is a superuser and policies do not apply to it.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def as_operator(conn) -> None:
    conn.execute("reset role")


def events_of(conn, uid: str) -> list[tuple[str, str]]:
    return [
        (r[0], r[1])
        for r in conn.execute(
            "select kind, actor from public.events where user_id = %s order by id", (uid,)
        ).fetchall()
    ]


# ------------------------------------------------------------ the front door

def test_an_invited_signup_is_active_immediately(conn):
    """The owner's "invites will have to create an account regardless" half, and
    the free-forever flag that pack H will read.

    KILLED BY: dropping the `allowed_emails` lookup from the trigger (everyone
    lands pending, including the owner), or stamping `activated_at` for the
    pending branch too.
    """
    email = f"invited-{uuid.uuid4()}@example.com"
    invite(conn, email, name="Invited Person", operator=True)
    uid = signup(conn, email)

    e = ent(conn, uid)
    assert e["status"] == "active"
    assert e["invited"] is True
    assert e["invite_ref"] == "allowlist"
    assert e["plan"] == "free"
    assert e["activated_at"] is not None
    # The allowlist row still carries identity, unchanged by 0027.
    assert conn.execute(
        "select name, is_operator from public.users where id = %s", (uid,)
    ).fetchone() == ("Invited Person", True)


def test_an_uninvited_signup_creates_a_pending_account_and_does_not_raise(conn):
    """The load-bearing reversal. Before 0027 this insert raised and no account
    existed; the owner's model needs it to succeed and be inert.

    KILLED BY: restoring 0001's `raise exception 'email % is not allowlisted'`
    (the insert throws), or defaulting `entitlements.status` to `'active'`.
    """
    uid = signup(conn, f"stranger-{uuid.uuid4()}@example.com")

    e = ent(conn, uid)
    assert e["status"] == "pending"
    assert e["invited"] is False
    assert e["invite_ref"] == ""
    assert e["activated_at"] is None
    assert e["suspended_at"] is None


def test_a_replayed_signup_neither_duplicates_the_account_nor_downgrades_it(conn):
    """A second fire of the trigger for the SAME auth id must change nothing.

    Fired for real rather than asserted from the SQL text: the same trigger
    function is attached to a scratch table with the same two columns it reads
    (`new.id`, `new.email`), which is the only way to make Postgres run it twice
    against one identity — `auth.users` will not take the same primary key twice,
    which is exactly why the replay looked untestable and went untested.

    KILLED BY: either `on conflict … do nothing` becoming `do update` (the
    entitlement drops back to pending, and an account the owner turned on turns
    itself off the next time GoTrue re-provisions), or being dropped entirely
    (the insert raises on the primary key and signup breaks).
    """
    email = f"invited-{uuid.uuid4()}@example.com"
    invite(conn, email)
    uid = signup(conn, email)
    conn.execute("select public.hq_activate_user(%s, 'first activation')", (uid,))
    first = ent(conn, uid)

    conn.execute("create temp table refire_users (id uuid, email text)")
    conn.execute(
        """create trigger refire_t after insert on refire_users
             for each row execute function public.handle_new_auth_user()"""
    )
    conn.execute("insert into refire_users (id, email) values (%s, %s)", (uid, email))

    assert conn.execute(
        "select count(*) from public.entitlements where user_id = %s", (uid,)
    ).fetchone()[0] == 1
    assert conn.execute(
        "select count(*) from public.users where id = %s", (uid,)
    ).fetchone()[0] == 1
    after = ent(conn, uid)
    assert after["status"] == "active"
    assert after["activated_at"] == first["activated_at"]


def test_a_second_identity_claiming_a_taken_email_is_refused_and_changes_nothing(conn):
    """Fail loud on genuinely broken input, and prove the refusal is total.

    Merging two auth identities onto one account is a decision no trigger should
    make silently. Because the trigger runs inside the signup's own transaction,
    the raise rolls the whole thing back — so the assertion that matters is not
    just "it raised" but "the existing account is untouched".

    KILLED BY: deleting the `id <> new.id` pre-check (Postgres still raises on
    `users_email_key`, but with an unnamed constraint message the operator cannot
    act on), or changing the users insert to `on conflict (email) do update`,
    which would hand a stranger's auth id the owner's account.
    """
    email = f"invited-{uuid.uuid4()}@example.com"
    invite(conn, email)
    first = signup(conn, email)
    before = ent(conn, first)

    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "insert into auth.users (id, email) values (%s, %s)", (str(uuid.uuid4()), email)
        )
    assert "refusing to merge" in exc.value.diag.message_primary.lower()

    assert ent(conn, first) == before
    assert conn.execute(
        "select count(*) from public.users where email = %s", (email,)
    ).fetchone()[0] == 1


def test_an_auth_user_with_no_email_is_refused(conn):
    """This schema keys every user on an address; a blank one is not a signup to
    guess at. KILLED BY: dropping the `v_email = ''` guard — the row lands with an
    empty-string email and `users.email unique` makes the SECOND such account the
    one that fails, at a point nobody can trace back."""
    for blank in (None, "", "   "):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(
                "insert into auth.users (id, email) values (%s, %s)", (str(uuid.uuid4()), blank)
            )
        assert "no email" in exc.value.diag.message_primary.lower(), blank


def test_an_entitlement_row_that_arrives_without_a_status_is_not_entitled(conn):
    """The column default, asserted directly because nothing else reaches it.

    `hq_activate_user` and `hq_suspend_user` both `insert … (user_id) values (…)`
    to cover an account whose row is missing, and both then set the status they
    were called for — so the default is invisible through every path that exists
    today. It is still the rule the table is built on ("absence is never
    permission"), and the next writer of a bare row is who it protects.

    KILLED BY: `default 'pending'` → `default 'active'`.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("delete from public.entitlements where user_id = %s", (uid,))
    conn.execute("insert into public.entitlements (user_id) values (%s)", (uid,))
    assert ent(conn, uid)["status"] == "pending"


# ------------------------------------------------------------- the backfill

def test_the_backfill_activates_every_account_that_predates_this_migration(conn):
    """The owner and his dad are signed in while 0027 runs. A migration that put
    them in the holding state is an outage they discover by opening the app.

    The pre-0027 world is reproduced exactly: an account in `public.users` with
    no entitlement row at all. (`public.users.id` references `auth.users`, so the
    account has to be made the real way and its entitlement removed afterwards —
    inserting a bare `users` row is not a state this schema can hold.) Then the
    REAL migration file is re-applied: `db/apply.sh` re-applies the whole
    directory on every provisioning run, so this is the actual code path rather
    than a hand-copied approximation of it.

    KILLED BY: deleting the backfill (the existing users read as pending and the
    gate locks the owner out of his own product on deploy).
    """
    email = f"legacy-{uuid.uuid4()}@example.com"
    invite(conn, email)
    uid = signup(conn, email)
    conn.execute("delete from public.entitlements where user_id = %s", (uid,))
    assert ent(conn, uid) == {}, "precondition: the pre-0027 world has no entitlement row"

    conn.execute(MIGRATION_0027.read_text())

    e = ent(conn, uid)
    assert e["status"] == "active"
    assert e["invited"] is True
    assert e["invite_ref"] == "allowlist"
    assert e["activated_at"] is not None


def test_re_applying_the_migration_never_resurrects_a_pending_or_suspended_account(conn):
    """The other half, and the one an operator control must never get wrong.

    `db/apply.sh` re-runs every migration every time. A backfill written
    `on conflict (user_id) do update set status = 'active'` would turn every
    suspended account back on — and undo every deliberate pending state — behind
    the operator's back, on a run he thinks is a no-op.

    KILLED BY: exactly that `do nothing` → `do update` change.
    """
    pending = signup(conn, f"stranger-{uuid.uuid4()}@example.com")
    suspended = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (suspended,))

    conn.execute(MIGRATION_0027.read_text())

    assert ent(conn, pending)["status"] == "pending"
    assert ent(conn, suspended)["status"] == "suspended"


# ------------------------------------------------------- the operator controls

def test_activating_turns_the_account_on_and_leaves_the_trail(conn):
    """KILLED BY: dropping the `events` insert — the one record of who was granted
    access and when disappears, and every other assertion here still passes."""
    uid = signup(conn, f"stranger-{uuid.uuid4()}@example.com")

    result = conn.execute(
        "select public.hq_activate_user(%s, 'owner said so')", (uid,)
    ).fetchone()[0]
    assert result["changed"] is True
    assert result["status"] == "active"

    e = ent(conn, uid)
    assert e["status"] == "active"
    assert e["activated_at"] is not None
    assert e["reason"] == "owner said so"
    assert ("entitlement.activated", "operator") in events_of(conn, uid)


def test_activating_twice_changes_nothing_and_restamps_nothing(conn):
    """Idempotence stated in the answer, not just in the row.

    An operator who runs the statement twice — because the first tab was still
    open, because he was not sure it landed — must not move the date the account
    was granted, and must not write a second grant event into a table that is the
    audit trail.

    KILLED BY: removing the `v_before = 'active'` early return, or writing
    `activated_at = now()` instead of `coalesce(activated_at, now())`.
    """
    uid = signup(conn, f"stranger-{uuid.uuid4()}@example.com")
    conn.execute("select public.hq_activate_user(%s, 'first')", (uid,))
    first = ent(conn, uid)

    result = conn.execute("select public.hq_activate_user(%s, 'second')", (uid,)).fetchone()[0]

    assert result["changed"] is False
    after = ent(conn, uid)
    assert after["activated_at"] == first["activated_at"]
    assert after["reason"] == "first", "an idempotent call must not overwrite the note either"
    assert [k for k, _ in events_of(conn, uid)].count("entitlement.activated") == 1


def test_suspending_stamps_the_row_and_keeps_everything_else(conn):
    """A status change, never a delete: suspension is reversible and this system
    does not delete somebody's job search to express "not right now".

    KILLED BY: implementing suspend as `delete from public.entitlements` — the
    account would read as missing, `hq_is_entitled` would still answer false, and
    only the row-count and event assertions here notice.
    """
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, uid, key)

    result = conn.execute("select public.hq_suspend_user(%s, 'chargeback')", (uid,)).fetchone()[0]
    assert result["changed"] is True

    e = ent(conn, uid)
    assert e["status"] == "suspended"
    assert e["suspended_at"] is not None
    assert e["reason"] == "chargeback"
    assert ("entitlement.suspended", "operator") in events_of(conn, uid)
    assert conn.execute(
        "select count(*) from public.user_postings where user_id = %s", (uid,)
    ).fetchone()[0] == 1, "suspension must not touch the person's rows"


def test_reactivating_after_a_suspension_keeps_the_original_grant_date(conn):
    """`activated_at` answers "when did this person get in", which a suspension
    does not change. KILLED BY: `activated_at = now()` in `hq_activate_user`."""
    email = f"invited-{uuid.uuid4()}@example.com"
    invite(conn, email)
    uid = signup(conn, email)
    granted = ent(conn, uid)["activated_at"]

    conn.execute("select public.hq_suspend_user(%s, 'pause')", (uid,))
    conn.execute("select public.hq_activate_user(%s, 'resolved')", (uid,))

    e = ent(conn, uid)
    assert e["status"] == "active"
    assert e["activated_at"] == granted
    assert e["suspended_at"] is None


def test_the_pending_list_answers_the_day_one_question(conn):
    """"Somebody signed up, who?" — with its positive control: an ACTIVE account
    must not be in the list, or the owner works a queue that never empties.

    KILLED BY: `where e.status <> 'active'` becoming `where true` (the active
    accounts appear), or `= 'pending'` (a suspended account becomes invisible and
    the owner cannot find the person he turned off).
    """
    active = make_user(conn, f"{uuid.uuid4()}@example.com")
    waiting = signup(conn, f"stranger-{uuid.uuid4()}@example.com")
    off = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("select public.hq_suspend_user(%s, '')", (off,))

    listed = {
        str(r[0]): r[3]
        for r in conn.execute("select * from public.hq_pending_users()").fetchall()
    }
    assert listed.get(waiting) == "pending"
    assert listed.get(off) == "suspended"
    assert active not in listed


# -------------------------------------------------------------------- the gate

def test_hq_is_entitled_answers_for_the_session_and_only_the_session(conn):
    """The predicate the whole gate hangs off, with both controls.

    KILLED BY: `status = 'active'` becoming `status is not null` (a pending
    session reads as entitled), or the `user_id = auth.uid()` scope going away
    (any one active account in the deployment entitles everybody).
    """
    active = make_user(conn, f"{uuid.uuid4()}@example.com")
    pending = signup(conn, f"stranger-{uuid.uuid4()}@example.com")

    as_authenticated(conn, active)
    assert conn.execute("select public.hq_is_entitled()").fetchone()[0] is True

    as_authenticated(conn, pending)
    assert conn.execute("select public.hq_is_entitled()").fetchone()[0] is False

    # No identity at all.
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("set role authenticated")
    assert conn.execute("select public.hq_is_entitled()").fetchone()[0] is False
    as_operator(conn)


def test_a_pending_session_cannot_preview_the_shared_corpus(conn):
    """`app_preview_corpus` is the ONE read in this schema that a pending account
    could otherwise reach.

    0002 already narrows `postings` to rows the caller was gated on and
    `companies` to companies the caller watches, so a pending account — which has
    neither — sees zero rows on both by policies that predate this branch. This
    function is the deliberate exception: it is `security definer` precisely so a
    user with no gated rows can still preview a profile, which is the state a
    pending account is permanently in. Left alone it hands a stranger 5,000 rows
    of the shared feed over `/rest/v1/rpc/app_preview_corpus`.

    KILLED BY: dropping `and public.hq_is_entitled()` from the WHERE — the pending
    count goes from 0 to the same number the active session sees.
    """
    active = make_user(conn, f"{uuid.uuid4()}@example.com")
    pending = signup(conn, f"stranger-{uuid.uuid4()}@example.com")
    make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", "PreviewCorp")

    as_authenticated(conn, active)
    seen = conn.execute("select count(*) from public.app_preview_corpus(30)").fetchone()[0]
    assert seen > 0, "positive control: an active session DOES get a corpus"

    as_authenticated(conn, pending)
    assert conn.execute("select count(*) from public.app_preview_corpus(30)").fetchone()[0] == 0
    as_operator(conn)


def test_a_pending_session_reads_no_postings_and_no_companies(conn):
    """The rest of "reaches nothing", with the active session as the control.

    This is inherited behaviour rather than new (0002's two policies), and it is
    asserted here anyway: it is the half of the claim that a reader of 0027 would
    otherwise have to take on trust, and a future policy widened back to
    `auth.role() = 'authenticated'` would open it with nothing else complaining.
    """
    active = make_user(conn, f"{uuid.uuid4()}@example.com")
    pending = signup(conn, f"stranger-{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", "GatedCorp")
    gate(conn, active, key)

    as_authenticated(conn, active)
    assert conn.execute("select count(*) from public.postings").fetchone()[0] >= 1

    as_authenticated(conn, pending)
    assert conn.execute("select count(*) from public.postings").fetchone()[0] == 0
    assert conn.execute("select count(*) from public.companies").fetchone()[0] == 0
    as_operator(conn)


# --------------------------------------------------------------------- the RLS

def test_a_user_reads_their_own_entitlement_and_nobody_elses(conn):
    """The holding surface has to be able to say which state the person is in, so
    the self-read exists; it stops exactly there.

    KILLED BY: `using (user_id = auth.uid())` becoming `using (true)` — the
    cross-user count goes from 0 to 1 while the positive control stays green.
    """
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = signup(conn, f"stranger-{uuid.uuid4()}@example.com")

    as_authenticated(conn, a)
    assert conn.execute(
        "select count(*) from public.entitlements where user_id = %s", (a,)
    ).fetchone()[0] == 1
    assert conn.execute(
        "select count(*) from public.entitlements where user_id = %s", (b,)
    ).fetchone()[0] == 0
    as_operator(conn)


@pytest.mark.parametrize(
    "sql",
    [
        "update public.entitlements set status = 'active' where user_id = %s",
        "delete from public.entitlements where user_id = %s",
        "insert into public.entitlements (user_id, status) values (%s, 'active')",
    ],
    ids=("update", "delete", "insert"),
)
def test_a_user_can_never_write_their_own_entitlement(conn, sql):
    """The privileges go, not just the absence of a policy.

    The three cases are refused by two different mechanisms and that is the point.
    INSERT is stopped by RLS-with-no-insert-policy (42501, "new row violates
    row-level security policy"). UPDATE and DELETE are stopped ONLY by the revoke:
    with the privilege present and no policy, they do not error — they silently
    match zero rows, and the day somebody adds a plausible
    `for all using (user_id = auth.uid())` policy to this table they become a
    pending user activating themselves. Supabase's bootstrap grants
    `authenticated` INSERT/UPDATE/DELETE on every new table in `public` so that
    RLS can be the decider, which is why the grant has to be taken away by name.

    KILLED BY: deleting the `revoke insert, update, delete, truncate` line — the
    update and delete cases stop raising (measured; they turn into silent
    no-ops, which is exactly the shape that goes unnoticed).
    """
    uid = signup(conn, f"stranger-{uuid.uuid4()}@example.com")
    as_authenticated(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(sql, (uid,))
    as_operator(conn)
    assert ent(conn, uid)["status"] == "pending"


@pytest.mark.parametrize(
    "call",
    [
        "select public.hq_activate_user(%s, '')",
        "select public.hq_suspend_user(%s, '')",
    ],
    ids=("activate", "suspend"),
)
def test_the_operator_controls_are_unreachable_from_a_browser_session(conn, call):
    """The worst hole this schema could have: a pending account calling
    `hq_activate_user(own id)` from `/rest/v1/rpc` and walking past the entire
    gate. Supabase grants execute on new functions to `anon` and `authenticated`
    BY NAME, so `revoke … from public` alone leaves the door open.

    KILLED BY: dropping `anon, authenticated` from the revoke, or re-granting
    execute to `authenticated`.
    """
    uid = signup(conn, f"stranger-{uuid.uuid4()}@example.com")
    as_authenticated(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(call, (uid,))
    as_operator(conn)
    assert ent(conn, uid)["status"] == "pending"


def test_the_pending_list_is_unreachable_from_a_browser_session(conn):
    """Every other account's address, in one call. KILLED BY: the same missing
    revoke."""
    uid = signup(conn, f"stranger-{uuid.uuid4()}@example.com")
    as_authenticated(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("select * from public.hq_pending_users()")
    as_operator(conn)
