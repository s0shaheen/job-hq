"""`app_add_job`, executed (migration 20260813_025743).

`tests/core/test_migrations.py` reads the migration as text: the function
exists, pins its search_path, takes no user-id parameter, and is revoked from
every browser-reachable role by name. What text cannot prove is the logic this
suite runs:

  * the natural key IS the dedup — the shared posting is inserted once and
    NEVER updated, whatever a later caller claims about it;
  * a replayed idempotency key returns the first result and applies once, and
    the SAME key with DIFFERENT arguments (or another command's key) is refused
    with 22023, the post-0026 contract;
  * ownership is `auth.uid()` alone — a second user adding the same key gets
    their own row and touches nobody else's;
  * anonymous, pending, and suspended callers are refused, and a refused call
    writes NOTHING — the 0027 entitlement guard fires inside this definer;
  * the audit event lands in the same transaction, once per gesture.

Run it the way the rest of this directory runs (any free port; CI uses its own):

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55436:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55436/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_add_job.py -q

Every negative carries its positive control in the same test where the negative
would otherwise be satisfied by a function that always raises (test_rls.py's
reason).
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
    as_user,
    make_user,
    schema,  # noqa: F401 — session fixture
    set_triage,
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


# ------------------------------------------------------------------ helpers

def add_job(conn, key, url="https://boards.greenhouse.io/ramp/jobs/1", company="Ramp",
            title="Product Manager", idem=None):
    return conn.execute(
        "select public.app_add_job(%s, %s, %s, %s, %s)",
        # `is None`, not `or`: the empty string is a deliberate test payload.
        (key, url, company, title, str(uuid.uuid4()) if idem is None else idem),
    ).fetchone()[0]


def fresh_key() -> str:
    return f"greenhouse-{uuid.uuid4().hex[:10]}"


def posting_row(conn, key):
    return conn.execute(
        "select company, title, url, location, status, source, posted from public.postings where key=%s",
        (key,),
    ).fetchone()


def user_rows(conn, user, key):
    return conn.execute(
        """select disposition, disposition_reason, triage
             from public.user_postings where user_id=%s and posting_key=%s""",
        (user, key),
    ).fetchall()


def events(conn, user, key):
    return conn.execute(
        """select kind, actor, payload from public.events
            where user_id=%s and posting_key=%s order by id""",
        (user, key),
    ).fetchall()


def signup_pending(conn) -> str:
    """A real uninvited signup: the 0027 trigger lands it PENDING."""
    uid = str(uuid.uuid4())
    conn.execute(
        "insert into auth.users (id, email) values (%s, %s)",
        (uid, f"stranger-{uid[:8]}@example.com"),
    )
    return uid


# ------------------------------------------------------------------ the write

def test_add_creates_the_posting_the_gate_the_event_and_the_result(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = fresh_key()
    as_user(conn, user)

    result = add_job(conn, key)

    assert result["outcome"] == "added"
    # The nested shape is app_triage_row's — exactly what toJobView unwraps.
    posting = result["posting"]
    assert posting["posting_key"] == key
    assert posting["disposition"] == "qualified"
    assert posting["disposition_reason"] == "added:you"
    assert posting["triage"] == ""
    assert posting["updated_at"]
    assert posting["postings"]["key"] == key
    assert posting["postings"]["company"] == "Ramp"
    assert posting["postings"]["title"] == "Product Manager"
    assert posting["postings"]["source"] == "quickadd"

    assert posting_row(conn, key) == (
        "Ramp", "Product Manager", "https://boards.greenhouse.io/ramp/jobs/1",
        "", "New", "quickadd",
        # `posted` stays null: this surface does not know the posting date, and
        # 0001's rule is null over a guess.
        None,
    )
    assert user_rows(conn, user, key) == [("qualified", "added:you", "")]

    evs = events(conn, user, key)
    assert [(k, a) for k, a, _ in evs] == [("action.add_job", "user")]
    assert evs[0][2]["outcome"] == "added"
    assert evs[0][2]["key"] == key
    assert evs[0][2]["url"] == "https://boards.greenhouse.io/ramp/jobs/1"


def test_a_typed_in_row_with_no_link_is_a_row(conn):
    """The action sends url='' for a typed-in entry (`norm-…` key); the RPC must
    not demand a link the user never had."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = f"norm-ramp|product-manager|{uuid.uuid4().hex[:6]}"
    as_user(conn, user)

    result = add_job(conn, key, url="", company="Ramp", title="Product Manager")

    assert result["outcome"] == "added"
    assert posting_row(conn, key)[2] == ""  # url stored as the empty it was
    # The event payload carries no url line rather than an empty one.
    assert "url" not in events(conn, user, key)[0][2]


# ------------------------------------------------------------------ dedup

def test_dedup_on_the_natural_key_never_updates_the_shared_posting(conn):
    """The PK is the dedup, and the shared row keeps ITS facts: a second add of
    the same key — even claiming a different company and title — reports
    `duplicate` and rewrites nothing. `postings` has no user_id; a
    browser-reachable write that could modify an existing row would let one
    user rewrite the company and title in everyone else's queue."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = fresh_key()
    as_user(conn, user)

    add_job(conn, key, company="Ramp", title="Product Manager")
    result = add_job(conn, key, company="Evil Corp", title="Rewritten",
                     url="https://evil.example.com/x")

    assert result["outcome"] == "duplicate"
    # The shared facts survived; the caller is shown the row that exists.
    assert posting_row(conn, key)[:3] == (
        "Ramp", "Product Manager", "https://boards.greenhouse.io/ramp/jobs/1")
    assert result["posting"]["postings"]["company"] == "Ramp"
    assert len(user_rows(conn, user, key)) == 1

    # Both gestures were real and both are on the trail, with their outcomes.
    assert [e[2]["outcome"] for e in events(conn, user, key)] == ["added", "duplicate"]


def test_adding_a_posting_the_engine_already_saw_gates_without_reinserting(conn):
    """The posting exists (the sweep found it) but this user was never gated on
    it: quick add gates them, reports `added`, and leaves the engine's facts —
    including its source — alone."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = fresh_key()
    conn.execute(
        """insert into public.postings
             (key, company, title, url, status, source, first_seen, last_seen)
           values (%s, 'Ramp', 'Engineer', 'https://example.com/e', 'Seen',
                   'monitor', current_date - 7, current_date)""",
        (key,),
    )
    as_user(conn, user)

    result = add_job(conn, key, company="Ramp Inc", title="Engineer II")

    assert result["outcome"] == "added"
    row = posting_row(conn, key)
    assert row[0] == "Ramp" and row[1] == "Engineer" and row[5] == "monitor"
    assert user_rows(conn, user, key) == [("qualified", "added:you", "")]


# ------------------------------------------------------------------ idempotency

def test_replay_returns_the_first_result_and_applies_once(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = fresh_key()
    idem = str(uuid.uuid4())
    as_user(conn, user)

    first = add_job(conn, key, idem=idem)
    replay = add_job(conn, key, idem=idem)

    assert replay == first
    assert len(user_rows(conn, user, key)) == 1
    # One gesture, one event — the replay appended nothing.
    assert len(events(conn, user, key)) == 1


def test_key_reuse_with_different_arguments_is_refused(conn):
    """The post-0026 contract: a key belongs to ONE gesture. Reused with a
    different payload it is refused (22023), never answered with the first
    gesture's result — a stored result for arguments that were never applied
    reports a write that did not happen."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = fresh_key()
    idem = str(uuid.uuid4())
    as_user(conn, user)

    add_job(conn, key, idem=idem)
    with pytest.raises(psycopg.errors.InvalidParameterValue,
                       match="different arguments"):
        add_job(conn, key, title="Another Title Entirely", idem=idem)


def test_a_key_minted_by_another_command_is_refused(conn):
    """Cross-command reuse: four commands share one client outbox, so a key
    crossing lanes is a real client bug, and the refusal names both commands."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = fresh_key()
    idem = str(uuid.uuid4())
    as_user(conn, user)

    add_job(conn, key)  # the posting + gate now exist for this user
    set_triage(conn, key, "interested", idem=idem)
    with pytest.raises(psycopg.errors.InvalidParameterValue,
                       match="app_set_triage"):
        add_job(conn, fresh_key(), idem=idem)


# ------------------------------------------------------------------ ownership

def test_a_second_user_adding_the_same_key_gets_their_own_row(conn):
    """Ownership is auth.uid() and nothing else. B adding A's posting is a
    first-class `added` for B — and A's row, A's token, and the shared facts
    are exactly as A left them."""
    user_a = make_user(conn, f"{uuid.uuid4()}@example.com")
    user_b = make_user(conn, f"{uuid.uuid4()}@example.com")
    key = fresh_key()

    as_user(conn, user_a)
    add_job(conn, key)
    a_token = conn.execute(
        "select updated_at from public.user_postings where user_id=%s and posting_key=%s",
        (user_a, key),
    ).fetchone()[0]

    as_user(conn, user_b)
    result = add_job(conn, key, company="B Corp", title="B Title")

    assert result["outcome"] == "added"
    assert len(user_rows(conn, user_b, key)) == 1
    assert user_rows(conn, user_a, key) == [("qualified", "added:you", "")]
    assert conn.execute(
        "select updated_at from public.user_postings where user_id=%s and posting_key=%s",
        (user_a, key),
    ).fetchone()[0] == a_token
    assert posting_row(conn, key)[0] == "Ramp"
    # B's events are B's; nothing landed on A's trail from B's gesture.
    assert len(events(conn, user_a, key)) == 1


# ------------------------------------------------------------------ default deny

def test_an_anonymous_caller_is_refused(conn):
    as_user(conn, "")  # no session — auth.uid() is null
    with pytest.raises(psycopg.errors.InvalidAuthorizationSpecification):
        add_job(conn, fresh_key())


def test_a_pending_account_is_refused_and_writes_nothing(conn):
    """The 0027 entitlement guard FIRES inside this definer: the refusal is
    42501 from the BEFORE-ROW trigger, and because the whole call aborts, a
    pending account's attempt leaves no posting, no gate, no event, and no
    stored result. The positive control — the same account, activated, same
    call — is what proves the refusal was the entitlement and not the function."""
    uid = signup_pending(conn)
    key = fresh_key()
    as_user(conn, uid)

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        add_job(conn, key)

    assert posting_row(conn, key) is None
    assert user_rows(conn, uid, key) == []
    assert events(conn, uid, key) == []
    assert conn.execute(
        "select count(*) from public.command_idempotency where user_id=%s", (uid,)
    ).fetchone()[0] == 0

    conn.execute("select public.hq_activate_user(%s, 'test control')", (uid,))
    assert add_job(conn, key)["outcome"] == "added"


def test_a_suspended_account_is_refused(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    assert add_job(conn, fresh_key())["outcome"] == "added"  # positive control

    # Suspension is the OPERATOR's gesture: with the user's session still set,
    # the guard would (rightly) refuse hq_suspend_user's own audit event.
    as_user(conn, "")
    conn.execute("select public.hq_suspend_user(%s, 'test')", (user,))
    as_user(conn, user)
    key = fresh_key()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        add_job(conn, key)
    assert posting_row(conn, key) is None


# ------------------------------------------------------------------ validation

def test_validation_refuses_what_it_names(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)

    with pytest.raises(psycopg.errors.InvalidParameterValue, match="idempotency"):
        add_job(conn, fresh_key(), idem="")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="key"):
        add_job(conn, "")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="key"):
        add_job(conn, "   ")  # whitespace-only is blank, not a key
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="too long"):
        add_job(conn, "url-" + "a" * 2049)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="too long"):
        add_job(conn, fresh_key(), url="https://x.example/" + "a" * 2048)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="too long"):
        add_job(conn, fresh_key(), company="c" * 201)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="too long"):
        add_job(conn, fresh_key(), title="t" * 201)


def test_a_non_web_scheme_never_reaches_an_href(conn):
    """`postings.url` is rendered as an href across the app. The browser tier's
    allowlist refuses `javascript:`/`data:` before they reach the action, but a
    direct PostgREST caller skips that tier, so the boundary refusal is here —
    and the positive control is that the schemes real pastes carry still pass."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)

    for url in ("javascript:alert(1)", "data:text/html,x", "vbscript:x"):
        with pytest.raises(psycopg.errors.InvalidParameterValue, match="http"):
            add_job(conn, fresh_key(), url=url)

    # http, https, and the scheme-less bare host all store.
    assert add_job(conn, fresh_key(), url="http://example.com/j/1")["outcome"] == "added"
    assert add_job(conn, fresh_key(), url="boards.greenhouse.io/x/jobs/9")["outcome"] == "added"
