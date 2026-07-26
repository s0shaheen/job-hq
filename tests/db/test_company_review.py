"""The company-universe review path (0008), executed against real Postgres.

`tests/core/test_migrations.py` reads the SQL as text — enough to catch an RPC the
web app calls that nobody defined, and blind to every logic error in the body.
Everything here RUNS, and the properties it proves are the ones only a real
database can:

  * atomicity — a conflict on one row of a bulk review leaves NONE of the batch
    applied, not the rows the loop happened to reach first (0006's shape);
  * the review gate — `app_set_company_flags` refuses to put a company the human
    has not approved into the sweep;
  * the tier-3 floor — a pasted name is written as tier 3 / `manual` and never
    demotes a company the resolver has already grounded to tier 1;
  * idempotent replay and optimistic concurrency, per gesture.

Run locally with a throwaway Postgres — see tests/db/test_write_path.py's
docstring. Without DATABASE_URL every test here skips.
"""
from __future__ import annotations

import os
import threading
import time
import uuid

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from tests.db.test_write_path import make_user, schema  # noqa: E402,F401


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def as_user(conn, user_id):
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))


def as_authenticated(conn, user_id):
    """Become a signed-in BROWSER session: an identity AND the `authenticated` role.

    tests/db/test_rls.py:71-79's helper, repeated here on purpose. Every other test
    in this file connects as `postgres`, which is a superuser and ignores RLS
    entirely — so a security-definer function that only works because the caller
    could read every table would pass all of them. `set role authenticated` is the
    difference between exercising the write path and exercising a superuser.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


# ------------------------------------------------------------------ helpers

_UNSET = object()


def make_company(conn, name=None, ats="greenhouse", slug=_UNSET, tier=1, method="discover-greenhouse"):
    """A resolved shared-universe company row, as monitor.discover_universe writes one.

    `slug` defaults to a random one but an explicitly-passed "" STAYS "". The first
    version of this helper wrote `slug or uuid4().hex[:8]`, which quietly turned
    `slug=""` into a random slug — so the one test that meant to build an
    UNRESOLVED-key row (ats='', slug='') built a grounded one instead and asserted
    against a key the paste path never touches.
    """
    name = name or f"Co {uuid.uuid4().hex[:8]}"
    if slug is _UNSET:
        slug = uuid.uuid4().hex[:8]
    return conn.execute(
        """insert into public.companies (name, ats, slug, source, reliability_tier, resolution_method)
           values (%s, %s, %s, 'test', %s, %s) returning id""",
        (name, ats, slug, tier, method),
    ).fetchone()[0]


def subscribe(conn, user, company_id, review_state="proposed", monitor=False, priority=False):
    conn.execute(
        """insert into public.user_companies (user_id, company_id, monitor, priority, review_state)
           values (%s, %s, %s, %s, %s)
           on conflict (user_id, company_id) do nothing""",
        (user, company_id, monitor, priority, review_state),
    )


def seed(conn, n=3, review_state="proposed"):
    """A user with n proposed companies in their universe; returns (user, [company_ids])."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    ids = []
    for _ in range(n):
        cid = make_company(conn)
        subscribe(conn, user, cid, review_state=review_state)
        ids.append(cid)
    as_user(conn, user)
    return user, ids


def review(conn, ids, state, *, idem=None, expected=None):
    return conn.execute(
        "select public.app_set_company_review_bulk(%s,%s,%s,%s)",
        (ids, state, idem or str(uuid.uuid4()), expected),
    ).fetchone()[0]


def flags(conn, cid, monitor, priority, *, idem=None, expected=None):
    return conn.execute(
        "select public.app_set_company_flags(%s,%s,%s,%s,%s)",
        (cid, monitor, priority, idem or str(uuid.uuid4()), expected),
    ).fetchone()[0]


def propose(conn, names, source="paste", *, idem=None):
    return conn.execute(
        "select public.app_propose_companies(%s,%s,%s)",
        (names, source, idem or str(uuid.uuid4())),
    ).fetchone()[0]


def row_of(conn, user, cid):
    return conn.execute(
        "select review_state, monitor, priority, updated_at from public.user_companies "
        "where user_id=%s and company_id=%s",
        (user, cid),
    ).fetchone()


# ------------------------------------------------------------------ schema shape


def test_existing_rows_default_to_approved_not_proposed(conn):
    """The only safe default. Every pre-0008 row was seeded from the sheet by a
    human; defaulting them to 'proposed' would empty every live universe on the
    day this migration applies — a data-loss bug wearing a schema change."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    cid = make_company(conn)
    conn.execute(
        "insert into public.user_companies (user_id, company_id) values (%s, %s)",
        (user, cid),
    )
    state, monitor, _priority, updated = row_of(conn, user, cid)
    assert state == "approved"
    assert monitor is True                 # 0001's own default, untouched
    assert updated is not None             # a version token from the first moment, never null


def test_review_state_check_admits_only_the_three_states(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    for state in ("proposed", "approved", "dismissed"):
        subscribe(conn, user, make_company(conn), review_state=state)
    for bad in ("Approved", "pending", "", "rejected"):
        with pytest.raises(psycopg.errors.CheckViolation):
            subscribe(conn, user, make_company(conn), review_state=bad)


def test_a_bare_insert_cannot_land_a_swept_but_unreviewed_row(conn):
    """The review gate as a CONSTRAINT, not only as a rule inside a function.

    `monitor` defaults to true (0001), so any writer that inserts a proposal without
    naming it lands a row that is swept and unreviewed — fail-OPEN on the one flag
    whose entire purpose is that a human said yes first. `app_set_company_flags`
    guards the UI's door; this guards every other one.
    """
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    cid = make_company(conn)
    for state in ("proposed", "dismissed"):
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute(
                "insert into public.user_companies (user_id, company_id, review_state) "
                "values (%s, %s, %s)",
                (user, make_company(conn), state),
            )
    # The same row is legal the moment it is honest about not being swept.
    conn.execute(
        "insert into public.user_companies (user_id, company_id, monitor, review_state) "
        "values (%s, %s, false, 'proposed')",
        (user, cid),
    )
    # And an approved row may be swept, which is the whole point of approving.
    conn.execute(
        "update public.user_companies set review_state='approved', monitor=true "
        "where user_id=%s and company_id=%s",
        (user, cid),
    )


def test_a_non_rpc_update_still_moves_the_version_token(conn):
    """`touch_updated_at`, which every other versioned table has had since 0001.

    The three RPCs set `updated_at` themselves, so the column looked fine. Anything
    ELSE that ever updates this table — a backfill, a psql fix, a future bot —
    changed the row and froze the token, and the next client holding the old value
    passed its conflict check and clobbered a write it never saw.
    """
    user, ids = seed(conn, 1)
    before = row_of(conn, user, ids[0])[3]
    conn.execute(
        "update public.user_companies set priority = true where user_id=%s and company_id=%s",
        (user, ids[0]),
    )
    assert row_of(conn, user, ids[0])[3] > before, "a non-RPC update left the version token frozen"


def test_an_unresolved_name_cannot_exist_twice(conn):
    """The partial unique index on the NORMALIZED name.

    The lookup inside app_propose_companies is what normally prevents a duplicate
    placeholder; this is what prevents two concurrent pastes from both losing that
    lookup's race. Partial on purpose: a grounded row for the same name is a second
    real fact (a company can have both a Greenhouse site and a Workday tenant), and
    only the ungrounded placeholder is a duplicate of the same nothing.
    """
    name = f"Dup {uuid.uuid4().hex[:6]} Co"
    conn.execute("insert into public.companies (name, ats, slug) values (%s, '', '')", (name,))
    # The third variant is the real-world one: a name copied out of a web page
    # arrives with a trailing NBSP, which btrim() does not strip.
    for variant in (name.lower(), f"  {name}  ", name + "\u00a0"):
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(
                "insert into public.companies (name, ats, slug) values (%s, '', '')", (variant,)
            )
    conn.execute(
        "insert into public.companies (name, ats, slug) values (%s, 'greenhouse', 'dupco')", (name,)
    )


# ------------------------------------------------------------------ bulk review


def test_one_gesture_approves_the_whole_selection(conn):
    user, ids = seed(conn, 4)
    result = review(conn, ids, "approved")
    assert len(result["rows"]) == 4
    for cid in ids:
        state, monitor, _p, _u = row_of(conn, user, cid)
        assert (state, monitor) == ("approved", True)


def test_approving_turns_the_sweep_on_and_dismissing_turns_it_off(conn):
    """An approval that does not put the company in the sweep did nothing; a
    dismissal that leaves it in the sweep keeps costing a fetch forever."""
    user, ids = seed(conn, 2)
    review(conn, ids, "approved")
    assert all(row_of(conn, user, c)[1] is True for c in ids)
    review(conn, ids, "dismissed")
    for cid in ids:
        state, monitor, _p, _u = row_of(conn, user, cid)
        assert (state, monitor) == ("dismissed", False)


def test_the_returned_row_is_shaped_for_the_grid(conn):
    user, ids = seed(conn, 1)
    row = review(conn, ids, "approved")["rows"][0]
    assert row["company_id"] == ids[0]
    assert row["review_state"] == "approved"
    # Nested exactly as toCompanyView() unwraps it — the write's own row is what
    # the client renders, so a shape change here breaks the grid silently.
    assert row["companies"]["id"] == ids[0]
    assert row["companies"]["reliability_tier"] == 1
    assert row["companies"]["resolution_method"] == "discover-greenhouse"


def test_one_event_per_reviewed_company(conn):
    user, ids = seed(conn, 3)
    review(conn, ids, "approved")
    n = conn.execute(
        "select count(*) from public.events where user_id=%s and kind='company.approved'", (user,)
    ).fetchone()[0]
    assert n == 3
    # events has no company column; the id rides in the payload, and the trail
    # must carry the name too so a later rename does not orphan the record.
    payload = conn.execute(
        "select payload from public.events where user_id=%s and kind='company.approved' limit 1",
        (user,),
    ).fetchone()[0]
    assert payload["company_id"] in ids
    assert payload["company"]


# ------------------------------------------------------------------ atomicity


def test_a_conflict_on_one_row_rolls_back_the_whole_batch(conn):
    """The property only a real database proves: one stale row leaves NONE applied,
    though the loop already wrote every row ahead of it."""
    user, ids = seed(conn, 4)
    expected = [str(row_of(conn, user, c)[3]) for c in ids]
    # Another device reviews the last company, invalidating its expected version.
    review(conn, [ids[-1]], "dismissed")

    with pytest.raises(psycopg.errors.Error) as exc:
        review(conn, ids, "approved", expected=expected)
    assert "conflict" in str(exc.value).lower()

    for cid in ids[:-1]:
        assert row_of(conn, user, cid)[0] == "proposed", f"{cid} was left written after a conflict"


def test_an_unknown_company_in_the_batch_rolls_it_all_back(conn):
    user, ids = seed(conn, 2)
    with pytest.raises(psycopg.errors.Error) as exc:
        review(conn, ids + [999_999_999], "approved")
    assert "no such company" in str(exc.value).lower()
    for cid in ids:
        assert row_of(conn, user, cid)[0] == "proposed"


def test_another_users_company_is_not_reviewable(conn):
    """auth.uid() scoping, from the inside: the batch names a company id that
    exists but belongs to someone else, and gets 'no such company for this user'
    rather than writing their row."""
    other = make_user(conn, f"{uuid.uuid4()}@example.com")
    other_cid = make_company(conn)
    subscribe(conn, other, other_cid, review_state="proposed")

    user, ids = seed(conn, 1)
    with pytest.raises(psycopg.errors.Error) as exc:
        review(conn, ids + [other_cid], "approved")
    assert "no such company" in str(exc.value).lower()
    assert row_of(conn, other, other_cid)[0] == "proposed"
    assert row_of(conn, user, ids[0])[0] == "proposed"


def test_a_bulk_review_never_touches_another_users_row(conn):
    """`user_id = v_user` in the UPDATE is the tenant predicate, and it is the ONLY
    thing standing between this and a cross-user write.

    Two people watching the same shared company is the normal case — that is what
    `companies` being shared means. `company_id` alone matches both subscriptions,
    and the function is security definer so RLS does not save it: dropping the
    predicate turned one person's approval into everybody's. Reviewing an id you do
    not hold is refused (above); this is the other half — reviewing one you DO hold
    must not carry the neighbour along.
    """
    shared = make_company(conn)
    victim = make_user(conn, f"{uuid.uuid4()}@example.com")
    subscribe(conn, victim, shared, review_state="proposed")

    actor = make_user(conn, f"{uuid.uuid4()}@example.com")
    subscribe(conn, actor, shared, review_state="proposed")
    as_user(conn, actor)

    review(conn, [shared], "approved")
    assert row_of(conn, actor, shared)[:2] == ("approved", True)
    assert row_of(conn, victim, shared)[:2] == ("proposed", False), (
        "a bulk review wrote another user's subscription to the same company"
    )
    # The audit trail says the same thing: one event, for one person.
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and kind='company.approved'", (victim,)
    ).fetchone()[0] == 0


def test_flags_never_touch_another_users_row(conn):
    """The same tenant predicate, on the flags path. Dropping `user_id = v_user`
    there turned one person's pause switch into everybody's — and silently, because
    the caller's own row changes exactly as expected."""
    shared = make_company(conn)
    victim = make_user(conn, f"{uuid.uuid4()}@example.com")
    subscribe(conn, victim, shared, review_state="approved", monitor=True, priority=False)

    actor = make_user(conn, f"{uuid.uuid4()}@example.com")
    subscribe(conn, actor, shared, review_state="approved", monitor=True, priority=False)
    as_user(conn, actor)

    flags(conn, shared, False, False)
    assert row_of(conn, actor, shared)[1:3] == (False, False)
    assert row_of(conn, victim, shared)[1:3] == (True, False), (
        "a flag write paused another user's sweep for the same company"
    )
    assert conn.execute(
        "select count(*) from public.events where user_id=%s", (victim,)
    ).fetchone()[0] == 0


# ------------------------------------------------------------------ bounds


def test_a_batch_past_the_bound_is_refused(conn):
    """The fan-out bound, asserted in SQL rather than trusted to the server action.
    This function is granted to `authenticated`, so the browser can call it with
    whatever array it likes and a TypeScript check is advisory."""
    user, ids = seed(conn, 1)
    with pytest.raises(psycopg.errors.Error) as exc:
        review(conn, ids * 1001, "approved")
    assert "too many companies in one batch" in str(exc.value).lower()
    assert row_of(conn, user, ids[0])[0] == "proposed"


def test_a_short_token_array_is_refused_rather_than_skipping_the_tail(conn):
    """The parallel-array contract, enforced SQL-side.

    A token array shorter than the selection silently skipped the conflict check on
    every row past its end — the exact clobber the tokens exist to prevent, arriving
    through the one door (a direct RPC call) that bypasses every check written in
    TypeScript. Proven: a two-id batch with one token wrote the second row against
    no expectation at all.
    """
    user, ids = seed(conn, 3)
    tokens = [str(row_of(conn, user, c)[3]) for c in ids]

    for bad in (tokens[:1], tokens + [tokens[0]], []):
        with pytest.raises(psycopg.errors.Error) as exc:
            review(conn, ids, "approved", expected=bad)
        assert "row for row" in str(exc.value).lower(), bad
    for cid in ids:
        assert row_of(conn, user, cid)[0] == "proposed"

    # The matched array is accepted, so the refusal above is about the LENGTH.
    review(conn, ids, "approved", expected=tokens)
    assert row_of(conn, user, ids[0])[0] == "approved"


def test_a_malformed_version_token_reads_as_a_conflict(conn):
    """`'yesterday-ish'::timestamptz` raises 22007 InvalidDatetimeFormat, whose
    message supabase-source.ts cannot classify — so a stale or hand-written client
    got "Couldn't save that: invalid input syntax for type timestamp with time
    zone" in a toast. A conflict-classified error says the truthful thing instead:
    the version you hold is not one this row can have, re-read it."""
    user, ids = seed(conn, 2)
    with pytest.raises(psycopg.errors.Error) as exc:
        review(conn, ids, "approved", expected=["not-a-timestamp", None])
    assert "conflict" in str(exc.value).lower()
    assert "invalid input syntax" not in str(exc.value).lower()
    for cid in ids:
        assert row_of(conn, user, cid)[0] == "proposed"


def test_the_same_company_twice_in_one_batch_is_one_decision(conn):
    """A duplicated id used to be a phantom conflict: the first pass wrote the row
    and bumped its version, and the second pass then failed the token the caller
    read before the gesture — reported to the user as "changed on another device"
    about their own click. The first occurrence's token is the one that counts."""
    user, ids = seed(conn, 1)
    token = str(row_of(conn, user, ids[0])[3])
    result = review(conn, [ids[0], ids[0], ids[0]], "approved", expected=[token, token, token])
    assert len(result["rows"]) == 1
    assert row_of(conn, user, ids[0])[:2] == ("approved", True)
    # One decision, one audit row.
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and kind='company.approved'", (user,)
    ).fetchone()[0] == 1


# ------------------------------------------------------------------ concurrency


def test_a_concurrent_replay_of_one_review_key_is_a_replay_not_a_conflict(conn):
    """test_write_path.py's pattern, on the bulk review path.

    Two tabs share one localStorage outbox and both flush on the same 'online'
    event, so the same key arrives twice at once — both past the PRE-lock
    idempotency check before either wrote. Without a re-check behind the locks the
    loser hit the duplicate key on `command_idempotency` at the very end and took
    its whole batch down with a raw Postgres error, for a gesture that had already
    succeeded.

    Genuinely interleaved, not two connections used in turn: B must clear the
    pre-lock check while A still holds the row lock. Sequentially this test cannot
    fail — A commits first and B's pre-lock check finds the stored result, so the
    re-check is never reached.
    """
    user, ids = seed(conn, 2)
    tokens = [str(row_of(conn, user, c)[3]) for c in ids]
    idem = str(uuid.uuid4())

    results, errors = [], []

    def call(conn_, tag, state):
        try:
            row = conn_.execute(
                "select public.app_set_company_review_bulk(%s,%s,%s,%s)",
                (ids, state, idem, tokens),
            ).fetchone()[0]
            conn_.commit()
            results.append(row)
        except psycopg.errors.Error as exc:
            conn_.rollback()
            errors.append(f"{tag}: {exc}")

    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        for c in (a, b):
            c.execute("select set_config('hq.test_user', %s, false)", (user,))
            c.commit()
        b.execute("set lock_timeout = '20s'")

        # A takes the row lock and holds it. B enters the function, clears the
        # pre-lock idempotency check (the table is still empty for this key) and
        # blocks on the lock. A then performs the real write and commits, which both
        # stores the key and releases the lock. Only the post-lock re-check can save B.
        a.execute("begin")
        a.execute(
            "select 1 from public.user_companies where user_id=%s and company_id=%s for update",
            (user, ids[0]),
        )

        # B asks for a DIFFERENT state under the same key, which isolates the
        # re-check: with identical arguments the no-op guard would answer too.
        t = threading.Thread(target=call, args=(b, "b", "dismissed"))
        t.start()
        time.sleep(1.0)
        call(a, "a", "approved")
        t.join(timeout=30)
        assert not t.is_alive(), "the concurrent caller never returned"

    assert not errors, f"a concurrent replay of one key errored: {errors}"
    assert len(results) == 2, results
    assert results[0] == results[1], "the same key returned two different results"
    assert row_of(conn, user, ids[0])[0] == "approved"
    # One decision, one audit row per company — however many times it arrives.
    assert conn.execute(
        "select count(*) from public.events where user_id=%s", (user,)
    ).fetchone()[0] == 2


def test_two_tabs_reviewing_one_selection_in_opposite_orders_do_not_deadlock(conn):
    """The grid hands this function ids in DISPLAY order, so one tab sorted by name
    and another by tier send the same selection in opposite sequences. Locking them
    in arrival order made each hold the row the other wanted next; Postgres killed
    one with 40P01, which the client reported as a generic failure for a gesture
    that was perfectly valid.

    Forty rows rather than two, deliberately: the window between the first and last
    lock is what the race needs, and forty makes it wide enough that the unordered
    version fails on the first round instead of one round in fifty. A total order
    over the ids removes the cycle by construction, so the GREEN direction here is
    deterministic.
    """
    user, ids = seed(conn, 40)
    errors = []

    def call(conn_, order):
        try:
            conn_.execute(
                "select public.app_set_company_review_bulk(%s,'approved',%s,null)",
                (order, str(uuid.uuid4())),
            )
            conn_.commit()
        except psycopg.errors.Error as exc:
            conn_.rollback()
            errors.append(str(exc))

    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        for c in (a, b):
            c.execute("select set_config('hq.test_user', %s, false)", (user,))
            c.commit()
        start = threading.Barrier(2)

        def run(conn_, order):
            start.wait()
            call(conn_, order)

        ta = threading.Thread(target=run, args=(a, list(ids)))
        tb = threading.Thread(target=run, args=(b, list(reversed(ids))))
        ta.start()
        tb.start()
        ta.join(timeout=60)
        tb.join(timeout=60)
        assert not ta.is_alive() and not tb.is_alive(), "a caller never returned"

    assert not [e for e in errors if "deadlock" in e.lower()], errors
    for cid in ids:
        assert row_of(conn, user, cid)[:2] == ("approved", True)


# ------------------------------------------------------------------ RLS / real session


def test_the_review_path_works_as_a_real_signed_in_session(conn):
    """Everything else here runs as `postgres`, which is a superuser and ignores
    RLS. These functions are security definer precisely so they can write past the
    policies; this proves that still holds for an ordinary browser session — and
    that the reads inside them (the companies join, the events insert) are not
    quietly relying on superuser privilege."""
    user, ids = seed(conn, 2)
    as_authenticated(conn, user)
    try:
        rows = review(conn, ids, "approved")["rows"]
        assert len(rows) == 2
        assert flags(conn, ids[0], False, False)["monitor"] is False
        proposed = propose(conn, [f"Signed In {uuid.uuid4().hex[:6]}"])
        assert proposed["added"] == 1
    finally:
        conn.execute("reset role")

    assert conn.execute(
        "select count(*) from public.events where user_id=%s", (user,)
    ).fetchone()[0] >= 3


def test_an_authenticated_session_reads_only_its_own_universe(conn):
    """Both directions in one breath, test_rls.py's rule: A reads its own rows AND
    none of B's. Without the positive control, "A read 0 of B's rows" is equally
    true when A can read nothing at all — which is what happened before
    test-harness.sql granted what Supabase grants."""
    mine = make_company(conn)
    theirs = make_company(conn)
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    subscribe(conn, a, mine, review_state="approved", monitor=True)
    subscribe(conn, b, theirs, review_state="approved", monitor=True)

    as_authenticated(conn, a)
    try:
        assert conn.execute(
            "select count(*) from public.user_companies where user_id=%s", (a,)
        ).fetchone()[0] == 1, "A cannot read its own universe — the test proves nothing"
        assert conn.execute(
            "select count(*) from public.user_companies where user_id=%s", (b,)
        ).fetchone()[0] == 0, "A read B's universe"
        # 0002's companies_visible_to_watchers: a company only B watches is invisible.
        assert conn.execute(
            "select count(*) from public.companies where id=%s", (mine,)
        ).fetchone()[0] == 1
        assert conn.execute(
            "select count(*) from public.companies where id=%s", (theirs,)
        ).fetchone()[0] == 0
    finally:
        conn.execute("reset role")


def test_the_row_every_gesture_returns_carries_the_version_token(conn):
    """`updated_at` in `app_company_row` is the optimistic-concurrency token the
    client writes back, not a debugging extra. Deleting the key survived the ENTIRE
    suite: every write on this surface silently became last-writer-wins, because the
    client had nothing to send and `expectedUpdatedAt` went null everywhere."""
    user, ids = seed(conn, 1)
    reviewed = review(conn, ids, "approved")["rows"][0]
    flagged = flags(conn, ids[0], True, True)
    as_user(conn, user)
    proposed = propose(conn, [f"Token Co {uuid.uuid4().hex[:6]}"])["rows"][0]

    for label, row in (("review", reviewed), ("flags", flagged), ("propose", proposed)):
        assert "updated_at" in row, f"{label} dropped updated_at from the row it returned"
        assert row["updated_at"], f"{label} returned an empty updated_at"

    # And it is a REAL token, not a decorative string: handing the newest one back
    # is accepted, and handing back the one from before the flag write conflicts.
    flags(conn, ids[0], False, False, expected=flagged["updated_at"])
    with pytest.raises(psycopg.errors.Error) as exc:
        flags(conn, ids[0], True, False, expected=reviewed["updated_at"])
    assert "conflict" in str(exc.value).lower()


# ------------------------------------------------------------------ idempotency / no-op


def test_replaying_a_key_returns_the_first_result(conn):
    user, ids = seed(conn, 2)
    idem = str(uuid.uuid4())
    first = review(conn, ids, "approved", idem=idem)
    again = review(conn, ids, "dismissed", idem=idem)   # different intent, same key
    assert again == first
    # The replay wrote nothing: the rows still hold the FIRST decision.
    assert row_of(conn, user, ids[0])[0] == "approved"


def test_a_noop_review_does_not_bump_the_version(conn):
    """0006's rule: re-approving already-approved rows must not invalidate every
    other tab's version tokens for them."""
    user, ids = seed(conn, 2)
    review(conn, ids, "approved")
    before = [row_of(conn, user, c)[3] for c in ids]
    review(conn, ids, "approved")
    assert [row_of(conn, user, c)[3] for c in ids] == before
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and kind='company.approved'", (user,)
    ).fetchone()[0] == 2                    # from the first gesture only


# ------------------------------------------------------------------ flags


def test_flags_move_monitor_and_priority_on_an_approved_row(conn):
    user, ids = seed(conn, 1)
    review(conn, ids, "approved")
    row = flags(conn, ids[0], True, True)
    assert (row["monitor"], row["priority"]) == (True, True)
    assert row_of(conn, user, ids[0])[:3] == ("approved", True, True)


def test_flags_refuse_a_company_that_was_never_approved(conn):
    """The review gate, enforced in SQL. Turning `monitor` on for a proposed
    company would put it into the sweep behind the user's back — which is the one
    thing the proposal state exists to prevent, so the UI cannot be the only
    place it is stopped."""
    user, ids = seed(conn, 1)
    with pytest.raises(psycopg.errors.Error) as exc:
        flags(conn, ids[0], True, False)
    assert "not approved" in str(exc.value).lower()
    assert row_of(conn, user, ids[0])[1] is False


def test_flags_conflict_on_a_stale_version(conn):
    user, ids = seed(conn, 1)
    review(conn, ids, "approved")                       # leaves monitor=true, priority=false
    stale = row_of(conn, user, ids[0])[3]
    # The other device must actually CHANGE something. The first version of this
    # test sent (monitor=true, priority=false) — already the row's state — which
    # the no-op branch answers without bumping updated_at, so `stale` was still
    # current and the test passed with the conflict check removed.
    flags(conn, ids[0], True, True)
    assert row_of(conn, user, ids[0])[3] > stale
    with pytest.raises(psycopg.errors.Error) as exc:
        flags(conn, ids[0], False, False, expected=stale)
    assert "conflict" in str(exc.value).lower()


# ------------------------------------------------------------------ propose (paste)


def test_a_pasted_name_lands_as_a_tier_3_manual_proposal(conn):
    """The honest floor. Nothing in the web app resolves a board, so a pasted name
    may not claim a reliability tier it has not earned — tier 3 / 'manual' is the
    design's 'tracked, not auto-pulled', and it is the only truthful value here."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    result = propose(conn, ["Northern Trust", "Cboe Global Markets"])
    assert result["added"] == 2
    for row in result["rows"]:
        assert row["review_state"] == "proposed"
        assert row["monitor"] is False               # not swept until a human approves
        assert row["companies"]["reliability_tier"] == 3
        assert row["companies"]["resolution_method"] == "manual"
        assert row["companies"]["ats"] == ""


def test_blank_lines_and_duplicates_in_a_paste_collapse(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    result = propose(conn, ["Aon", "", "  ", "aon", "Aon", "Exelon"])
    assert result["added"] == 2                      # Aon and Exelon, once each
    assert len(result["rows"]) == 2


def test_pasting_a_name_twice_does_not_duplicate_the_company(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    propose(conn, ["Grainger"])
    second = propose(conn, ["Grainger"])
    assert second["added"] == 0                      # already in this user's universe
    assert conn.execute(
        "select count(*) from public.companies where name='Grainger' and ats='' and slug=''"
    ).fetchone()[0] == 1


def test_a_paste_of_an_already_grounded_name_binds_to_that_row(conn):
    """The worst behaviour this function had, and the one the old test could not see.

    `monitor.discover_universe` only ever emits rows with a NON-EMPTY ats+slug —
    that is what grounding means. The paste path's conflict key was
    ('Ramp Grounded', '', ''), which no grounded row can hold, so pasting an
    already-resolved name created a second, permanent tier-3 row and bound the
    human's subscription to THAT: a company that reads as watched and is never
    pulled from, forever.

    The old version of this test asked `make_company` for slug="" and its
    `slug or uuid4()` handed back a random slug, so the row under test was grounded
    after all and the ('name','','') key was never exercised. It asserted the one
    thing that was already true (the row it built was not overwritten) and missed
    the ghost entirely.

    Mutation targets: reverting the lookup to the raw ('name','','') key, and
    turning the insert's `on conflict do nothing` into a `do update` that rewrites
    tier/method.
    """
    grounded = make_company(conn, name="Ramp Grounded", ats="ashby", slug="ramp",
                            tier=1, method="discover-ashby")
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)

    result = propose(conn, ["Ramp Grounded"])
    assert result["added"] == 1
    row = result["rows"][0]
    # Bound to the GROUNDED row, not to a fresh placeholder.
    assert row["company_id"] == grounded, "the paste created a tier-3 ghost beside the real board"
    assert (row["companies"]["ats"], row["companies"]["slug"]) == ("ashby", "ramp")
    # And not demoted. The resolver's tier is evidence; a paste is a name.
    assert row["companies"]["reliability_tier"] == 1
    assert row["companies"]["resolution_method"] == "discover-ashby"
    assert conn.execute(
        "select reliability_tier, resolution_method from public.companies where id=%s", (grounded,)
    ).fetchone() == (1, "discover-ashby")
    # Exactly one company row carries this name, in any capitalisation.
    assert conn.execute(
        "select count(*) from public.companies "
        "where public.company_name_key(name) = public.company_name_key('Ramp Grounded')"
    ).fetchone()[0] == 1
    # The subscription really is on the grounded row, not merely reported as such.
    assert row_of(conn, user, grounded)[0] == "proposed"


def test_a_grounded_row_is_preferred_when_both_shapes_already_exist(conn):
    """A universe that has both an old placeholder and the grounded row must bind a
    new subscriber to the board, not to the leftover. Ordering, not luck: grounded
    first, then the strongest tier, then the lowest id."""
    name = f"Both Shapes {uuid.uuid4().hex[:6]}"
    placeholder = make_company(conn, name=name, ats="", slug="", tier=3, method="manual")
    grounded = make_company(conn, name=name, ats="greenhouse", slug="bothshapes",
                            tier=1, method="discover-greenhouse")
    assert placeholder < grounded          # the placeholder is the OLDER row
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    assert propose(conn, [name])["rows"][0]["company_id"] == grounded


def test_case_and_whitespace_variants_across_pastes_are_one_company(conn):
    """Two sessions, two spellings, one company.

    'Aon' then 'aon' used to be two rows and two subscriptions, and a name copied
    out of a web page arrives with a trailing NBSP — which `btrim()` does not strip,
    so it was a third. The paste path matches on `company_name_key`, never on the
    raw string.
    """
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    stem = f"Aon {uuid.uuid4().hex[:6]}"
    assert propose(conn, [stem])["added"] == 1
    # NBSP and zero-width space written as escapes: an invisible character in a
    # test file is a test nobody can read.
    for variant in (stem.lower(), stem.upper(), f"  {stem}  ", stem + "\u00a0", stem + "\u200b"):
        assert propose(conn, [variant])["added"] == 0, f"{variant!r} became a second company"
    assert conn.execute(
        "select count(*) from public.companies where public.company_name_key(name) = %s",
        (stem.lower(),),
    ).fetchone()[0] == 1
    assert conn.execute(
        "select count(*) from public.user_companies where user_id=%s", (user,)
    ).fetchone()[0] == 1


def test_an_unknown_source_tag_is_refused(conn):
    """`source` is a reporting dimension the coverage meter groups by, and this
    function is granted to `authenticated` — so the vocabulary is closed HERE, at
    the browser-callable door, exactly as 0007 closed `reliability_tier`."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    for tag in ("paste", "manual", "api", "edgar", "PASTE"):
        assert propose(conn, [f"Src {tag} {uuid.uuid4().hex[:6]}"], source=tag)["added"] == 1
    with pytest.raises(psycopg.errors.Error) as exc:
        propose(conn, ["Novelist Co"], source="a-novel-about-provenance")
    assert "unknown source tag" in str(exc.value).lower()


def test_the_review_backlog_has_a_ceiling(conn):
    """500 per paste bounds one gesture; nothing bounded the TOTAL. A scripted
    caller could grow one person's review pile without limit — and every page load
    reads it, every coverage tally walks it, and the same human has to review it.
    Refusing with a countable reason is recoverable; an unbounded table is not."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    # 2000 proposals, inserted directly: driving the RPC 2000 times is the same
    # assertion at forty times the runtime.
    conn.execute(
        """insert into public.companies (name, ats, slug, source, reliability_tier, resolution_method)
           select 'Backlog ' || g || ' ' || %s, '', '', 'test', 3, 'manual'
             from generate_series(1, 2000) g""",
        (uuid.uuid4().hex[:6],),
    )
    conn.execute(
        """insert into public.user_companies (user_id, company_id, monitor, review_state)
           select %s, id, false, 'proposed' from public.companies where name like 'Backlog %%'""",
        (user,),
    )
    as_user(conn, user)
    with pytest.raises(psycopg.errors.Error) as exc:
        propose(conn, ["One More Please"])
    assert "backlog is full" in str(exc.value).lower()
    assert "2000" in str(exc.value)
    # Nothing was written: the refusal is not a partial paste.
    assert conn.execute(
        "select count(*) from public.companies where name = 'One More Please'"
    ).fetchone()[0] == 0


def test_pasting_over_an_approved_company_leaves_the_decision_alone(conn):
    """Re-proposing an approved company would pull it back out of the swept set —
    a silent regression of a decision the human already made."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    propose(conn, ["Wintrust"])
    cid = conn.execute(
        "select id from public.companies where name='Wintrust' and ats='' and slug=''"
    ).fetchone()[0]
    review(conn, [cid], "approved")
    propose(conn, ["Wintrust"])
    assert row_of(conn, user, cid)[:2] == ("approved", True)


def test_a_paste_past_the_bound_is_refused(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    with pytest.raises(psycopg.errors.Error) as exc:
        propose(conn, [f"Co {i}" for i in range(501)])
    assert "too many companies" in str(exc.value).lower()


def test_propose_replays_under_one_key(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    idem = str(uuid.uuid4())
    first = propose(conn, ["Guggenheim"], idem=idem)
    assert propose(conn, ["Guggenheim", "Nuveen"], idem=idem) == first
    assert conn.execute(
        "select count(*) from public.user_companies where user_id=%s", (user,)
    ).fetchone()[0] == 1


def test_an_unauthenticated_caller_writes_nothing(conn):
    """The harness's auth.uid() stub is deliberately stricter than Supabase: no
    identity means null, so a path that forgot to establish one fails loudly."""
    conn.execute("select set_config('hq.test_user', '', false)")
    for call in (
        lambda: propose(conn, ["Ghost Co"]),
        lambda: review(conn, [1], "approved"),
        lambda: flags(conn, 1, True, False),
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            call()
        assert "not authenticated" in str(exc.value).lower()
