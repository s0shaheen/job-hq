"""The warm-referral finder (layer 1), executed against real Postgres (0020).

`tests/core/test_migrations.py` reads the SQL as text: it proves the seven
`app_*_warm_*` functions are revoked from every browser role, never take a
`p_user_id`, read `auth.uid()`, and pin their search_path. It cannot prove that
the cap is charged at INSERT and holds under a concurrent burst, that a
completion racing a cancel loses, that a pin SET keeps two people while replacing
one, or that a stranger who names another user's search id is told nothing.
Everything here RUNS.

What it proves that reading the migration cannot:

    the reservation   the daily cap is charged at INSERT (the row IS the
                       reservation), so a replayed idem does not spend a second
                       slot and a breach raises SQLSTATE 'HQCAP';
    the burst (C1)     N starts fired from N connections at once, cap=1, admit
                       EXACTLY ONE — the rest raise 'HQCAP' — because
                       `app_start_warm_search` takes `pg_advisory_xact_lock` on
                       the user before the rolling-24h count. This is the mutation
                       pin: drop the lock and all N land (measured);
    cancel wins        a `complete` that lands after a `cancel` returns
                       'cancelled' with the fetched results DROPPED, because the
                       status is re-checked under the row lock and the
                       transition is one-way;
    the pin SET        pins are a SET per (target_kind, posting_key, company):
                       two DIFFERENT people coexist, re-pinning the SAME person
                       (same `pin_identity`) UPDATES only their row, and a no-op
                       re-pin does not bump `updated_at`;
    persona persists   `vendor_runs` round-trips `[{run_id, persona}]` so the
                       stateless poll route can re-attribute each candidate, and a
                       bad persona / missing run_id is refused with 22023;
    the closed door    a non-linkedin profile_url and an unknown source are
                       refused with a sentence, not a 23514, at the function;
    owner-only reads   the browser READS both tables through PostgREST, so the
                       select policy is load-bearing — A reads its own, B reads
                       zero, and a stranger naming A's id gets P0002 (which
                       reveals nothing) or deletes nothing.

Run locally with a throwaway Postgres (the invocation test_write_path.py names):

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      HQ_REQUIRE_DB=1 uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_warm.py -q

Without DATABASE_URL every test here skips; HQ_REQUIRE_DB=1 turns that silent
skip into a loud failure so a misconfigured CI job cannot report green.
"""
from __future__ import annotations

import json
import os
import threading
import uuid

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError(
        "HQ_REQUIRE_DB=1 but DATABASE_URL is unset — the db suite would have "
        "skipped every test and reported success"
    )
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from tests.db.test_write_path import (  # noqa: E402  (fixtures are shared on purpose)
    as_user,
    gate,  # noqa: F401 — imported with the rest of the shared set
    make_posting,  # noqa: F401 — imported with the rest of the shared set
    make_user,
    schema,  # noqa: F401 — session fixture
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def user(conn):
    # A fresh address per test: the signup trigger enforces uniqueness, so the
    # `make_user` default would make every test after the first fail on a
    # UniqueViolation that says nothing about warm referrals.
    u = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, u)
    return u


#: `idem=AUTO` means "mint one"; anything else reaches the function verbatim.
AUTO = object()


def as_authenticated(conn, user_id):
    """Become a signed-in browser session: an identity AND the `authenticated`
    role. Skipping `set role` is the difference between testing RLS and testing
    nothing — `postgres` is a superuser and policies do not apply to it
    (test_rls.py's `as_authenticated`, verbatim, because these two tables are
    read directly through PostgREST)."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def count(conn, sql, *args):
    return conn.execute(sql, args).fetchone()[0]


# ---------------------------------------------------------------- RPC helpers

def start(conn, *, target_kind="posting", posting_key="", company="Acme",
          params=None, overlays=None, daily_cap=20, idem=AUTO):
    # The 7-arg shape (0020, amended): `p_overlays` jsonb sits between params and
    # the daily cap.
    return conn.execute(
        "select public.app_start_warm_search(%s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)",
        (target_kind, posting_key, company,
         json.dumps({} if params is None else params),
         json.dumps({} if overlays is None else overlays),
         daily_cap, uuid.uuid4().hex if idem is AUTO else idem),
    ).fetchone()[0]


def attach(conn, sid, runs):
    # `p_runs` is an ARRAY of {"run_id","persona"} (0020, amended) — no longer a
    # bare id array.
    return conn.execute(
        "select public.app_attach_warm_run(%s, %s::jsonb)", (sid, json.dumps(runs))
    ).fetchone()[0]


def complete(conn, sid, results):
    return conn.execute(
        "select public.app_complete_warm_search(%s, %s::jsonb)", (sid, json.dumps(results))
    ).fetchone()[0]


def fail(conn, sid, error):
    return conn.execute(
        "select public.app_fail_warm_search(%s, %s)", (sid, error)
    ).fetchone()[0]


def cancel(conn, sid):
    return conn.execute("select public.app_cancel_warm_search(%s)", (sid,)).fetchone()[0]


def pin(conn, *, target_kind="posting", posting_key="", company="Acme",
        full_name="Ada Lovelace", profile_url="", headline="", source="warm", idem=AUTO):
    return conn.execute(
        "select public.app_pin_warm_intro(%s, %s, %s, %s, %s, %s, %s, %s)",
        (target_kind, posting_key, company, full_name, profile_url, headline, source,
         uuid.uuid4().hex if idem is AUTO else idem),
    ).fetchone()[0]


def unpin(conn, pin_id, *, idem=AUTO):
    return conn.execute(
        "select public.app_unpin_warm_intro(%s, %s)",
        (pin_id, uuid.uuid4().hex if idem is AUTO else idem),
    ).fetchone()[0]


# ------------------------------------------------------------- direct reads

def db_search(conn, sid):
    """A search row read directly (bypassing the app projection), as (status,
    vendor_runs, results, error, company)."""
    return conn.execute(
        "select status, vendor_runs, results, error, company"
        " from public.warm_searches where id = %s", (sid,),
    ).fetchone()


def db_overlays(conn, sid):
    return conn.execute(
        "select overlays from public.warm_searches where id = %s", (sid,)
    ).fetchone()[0]


def n_searches(conn, user_id):
    return count(conn, "select count(*) from public.warm_searches where user_id = %s", user_id)


def n_pins(conn, user_id):
    return count(conn, "select count(*) from public.warm_pins where user_id = %s", user_id)


def db_pin(conn, pin_id):
    return conn.execute(
        "select target_kind, posting_key, company, company_key, full_name,"
        "       profile_url, headline, source"
        " from public.warm_pins where id = %s", (pin_id,),
    ).fetchone()


def pin_updated_at(conn, pin_id):
    return conn.execute(
        "select updated_at from public.warm_pins where id = %s", (pin_id,)
    ).fetchone()[0]


def events(conn, user_id, kind=None):
    if kind is None:
        return conn.execute(
            "select kind, payload from public.events where user_id = %s order by id", (user_id,)
        ).fetchall()
    return conn.execute(
        "select payload from public.events where user_id = %s and kind = %s order by id",
        (user_id, kind),
    ).fetchall()


SEARCH_ROW_KEYS = {
    "id", "target_kind", "posting_key", "company", "params", "overlays", "status",
    "vendor_runs", "results", "error", "created_at", "updated_at",
}
PIN_ROW_KEYS = {
    "id", "target_kind", "posting_key", "company", "company_key", "full_name",
    "profile_url", "headline", "source", "updated_at",
}


# ================================================================= app_start

def test_start_inserts_a_running_row_and_returns_the_app_search_shape(conn, user):
    """The reservation is a ROW, and the client renders the jsonb the write
    returned rather than a second read — so the shape is part of the contract."""
    row = start(conn, company="AlphaCorp", posting_key="greenhouse-1",
                params={"role": "Product Manager"})

    # The shape `toWarmView` unwraps: exactly these keys, no company_key (the
    # search row builder deliberately omits it). `vendor_runs`/`overlays` are the
    # amended-0020 keys — `apify_run_ids` is gone.
    assert set(row) == SEARCH_ROW_KEYS, set(row) ^ SEARCH_ROW_KEYS
    assert row["status"] == "running"
    assert row["results"] == []
    assert row["vendor_runs"] == []
    assert row["overlays"] == {}
    assert row["error"] == ""
    assert row["company"] == "AlphaCorp"
    assert row["posting_key"] == "greenhouse-1"
    assert row["params"] == {"role": "Product Manager"}
    assert row["created_at"] and row["updated_at"]

    # …and the row really landed running, with empty jsonb defaults.
    status, vendor_runs, results, error, company = db_search(conn, row["id"])
    assert (status, vendor_runs, results, error) == ("running", [], [], "")

    # The spend record: "why was I charged for a run" answered in the same body.
    (payload,), = events(conn, user, "warm.search_started")
    assert payload == {"search_id": row["id"], "company": "AlphaCorp",
                       "target_kind": "posting"}


def test_overlays_round_trip_through_start_and_the_row(conn, user):
    """The user's warm signals are persisted so the stateless poll route can
    rebuild each persona's vendor query and stamp the matched school / past
    employer — so overlays must survive start unchanged, in the row and the
    column."""
    ov = {"schools": ["MIT", "Georgia Tech"], "pastCompanies": ["Stripe"]}
    row = start(conn, company="AlphaCorp", overlays=ov)
    assert row["overlays"] == ov
    assert db_overlays(conn, row["id"]) == ov


def test_start_is_idempotent_same_idem_returns_the_same_id_and_writes_once(conn, user):
    """A double-clicked "Search" under one idem key returns the first row and
    does not insert a second reservation or a second event."""
    idem = uuid.uuid4().hex
    first = start(conn, company="AlphaCorp", idem=idem)
    # A DIFFERENT company under the SAME key: the key names the gesture, not its
    # arguments, so the stored result comes back untouched.
    second = start(conn, company="Somewhere Else", idem=idem)

    assert second == first
    assert second["id"] == first["id"]
    assert n_searches(conn, user) == 1, "a replayed idem inserted a second row"
    assert len(events(conn, user, "warm.search_started")) == 1


# ===================================================================== the cap

def test_the_daily_cap_refuses_the_third_start_within_24h(conn, user):
    """The cap is charged at INSERT, before a cent is spent, and a breach raises
    SQLSTATE 'HQCAP' — the sentinel the route maps to "you have used your N
    searches for today"."""
    start(conn, daily_cap=2, idem=uuid.uuid4().hex)
    start(conn, daily_cap=2, idem=uuid.uuid4().hex)

    with pytest.raises(psycopg.Error) as exc:
        start(conn, daily_cap=2, idem=uuid.uuid4().hex)
    assert exc.value.sqlstate == "HQCAP"
    # The refusal wrote nothing: still exactly two rows.
    assert n_searches(conn, user) == 2


def test_a_replayed_idem_does_not_count_against_the_cap(conn, user):
    """The replay short-circuits BEFORE the cap check, so a retried "Search"
    returns the first row without spending a second slot. If it counted, the
    fresh third start below would be refused."""
    a = uuid.uuid4().hex
    start(conn, daily_cap=2, idem=a)      # slot 1
    start(conn, daily_cap=2, idem=a)      # replay — must NOT consume a slot
    start(conn, daily_cap=2, idem=uuid.uuid4().hex)  # slot 2, only reachable if replay was free

    assert n_searches(conn, user) == 2
    # …and slot 3 is where the cap actually bites.
    with pytest.raises(psycopg.Error) as exc:
        start(conn, daily_cap=2, idem=uuid.uuid4().hex)
    assert exc.value.sqlstate == "HQCAP"


def test_a_zero_cap_is_clamped_up_and_does_not_wedge_every_search(conn, user):
    """`p_daily_cap` is clamped to >= 1, so a caller passing 0 (which would wedge
    every search) still gets one — the clamp is `greatest(coalesce(cap,20),1)`."""
    row = start(conn, daily_cap=0, idem=uuid.uuid4().hex)
    assert row["status"] == "running", "a 0 cap wedged the first search"

    # Clamped to 1, not to something huge: the SECOND start is where 0-as-1 bites.
    with pytest.raises(psycopg.Error) as exc:
        start(conn, daily_cap=0, idem=uuid.uuid4().hex)
    assert exc.value.sqlstate == "HQCAP"


# ============================================== the cap under a concurrent burst

def test_concurrent_starts_at_cap_one_admit_exactly_one(conn, user):
    """The C1 blocker pin, and the whole feature's only spend control.

    The cap WAS a check-then-insert with no lock: N `/api/warm/start` calls
    racing under READ COMMITTED each read the same pre-insert count, all pass
    `>= v_cap`, and all insert (measured: 6 concurrent starts at cap=1 → 6 rows).
    A burst of clicks bypasses the cap entirely.

    `app_start_warm_search` now takes `pg_advisory_xact_lock` on the user id
    before the rolling-24h count, serializing every start FOR ONE USER: the
    second racer blocks until the first commits, then sees the true count and is
    refused with 'HQCAP'. So EXACTLY ONE of N barrier-synchronized starts lands
    and the rest raise 'HQCAP', and exactly one row exists afterwards.

    This is the mutation pin: with the `pg_advisory_xact_lock` line deleted this
    goes red (all N succeed, N rows) — verified against this same database. Each
    connection carries the SAME identity via `as_user`, committed first so a
    per-thread rollback cannot take it (test_write_path.py's concurrency note)."""
    N = 6
    conns = [psycopg.connect(DATABASE_URL) for _ in range(N)]
    try:
        for c in conns:
            as_user(c, user)   # same auth.uid() on every connection
            # Commit the identity: it is session-scoped but set inside an implicit
            # transaction, and a per-thread rollback below would otherwise take it.
            c.commit()

        barrier = threading.Barrier(N)
        oks: list = []
        caps: list = []
        others: list = []
        guard = threading.Lock()

        def fire(c, i):
            barrier.wait()   # release all N into the function at once
            try:
                # Distinct idem + distinct company per caller, so nothing collapses
                # on the idempotency short-circuit — the cap is the only thing that
                # can refuse them.
                row = start(c, company=f"Co {i:02d}", daily_cap=1, idem=uuid.uuid4().hex)
                c.commit()
                with guard:
                    oks.append(row)
            except psycopg.Error as exc:
                c.rollback()
                with guard:
                    (caps if exc.sqlstate == "HQCAP" else others).append(exc.sqlstate)

        threads = [threading.Thread(target=fire, args=(conns[i], i)) for i in range(N)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        assert all(not t.is_alive() for t in threads), "a concurrent start never returned"
    finally:
        for c in conns:
            c.close()

    assert others == [], f"a start raised something other than HQCAP: {others}"
    assert len(oks) == 1, f"expected exactly one winner, got {len(oks)}"
    assert len(caps) == N - 1, f"expected {N - 1} HQCAP refusals, got {len(caps)}"
    # The reservation held: exactly one row landed. Dropping the advisory lock
    # makes this N.
    assert n_searches(conn, user) == 1


# ============================================================ the transitions

def test_attach_sets_vendor_runs_only_while_running(conn, user):
    """Only a running search takes the vendor handle. A search cancelled between
    start and attach keeps its 'cancelled' status — overwriting would reanimate a
    run the user already gave up on. `p_runs` is `[{run_id, persona}]`."""
    runs = [{"run_id": "run-a", "persona": "role"},
            {"run_id": "run-b", "persona": "recruiter"}]
    s1 = start(conn, idem=uuid.uuid4().hex)["id"]
    attached = attach(conn, s1, runs)
    assert attached["status"] == "running"
    assert attached["vendor_runs"] == runs
    assert db_search(conn, s1)[1] == runs

    # The not-running path: cancel first, then a late attach changes nothing.
    s2 = start(conn, idem=uuid.uuid4().hex)["id"]
    cancel(conn, s2)
    row = attach(conn, s2, [{"run_id": "run-c", "persona": "senior"}])
    assert row["status"] == "cancelled"
    assert row["vendor_runs"] == [], "a late attach reanimated a cancelled run"


def test_attach_persists_persona_per_run_and_round_trips(conn, user):
    """The persona is the whole point of `vendor_runs`: the stateless poll route
    re-attributes each candidate to its persona from the row, firing the recruiter
    guarantee and the persona rank weights. So the persona must round-trip through
    attach into the column, per entry, unmangled."""
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    runs = [{"run_id": "r1", "persona": "recruiter"},
            {"run_id": "r2", "persona": "senior"}]
    row = attach(conn, s, runs)
    assert row["status"] == "running"
    assert row["vendor_runs"] == runs
    # …persisted in the column, not merely echoed back.
    assert db_search(conn, s)[1] == runs


@pytest.mark.parametrize("runs", [
    pytest.param([{"run_id": "r1", "persona": "ceo"}], id="persona-not-a-known-value"),
    pytest.param([{"persona": "role"}], id="run_id-missing"),
    pytest.param([{"run_id": "", "persona": "role"}], id="run_id-blank"),
    pytest.param([{"run_id": "r1", "persona": "role"},
                  {"run_id": "r2", "persona": "nope"}], id="one-bad-entry-fails-the-batch"),
    pytest.param({"run_id": "r1", "persona": "role"}, id="not-an-array"),
])
def test_attach_refuses_a_malformed_run_list(conn, user, runs):
    """Each entry is shape-checked (run_id present + a known persona), and the
    whole list must be an array — a bad handle would resurrect the 'everything is
    role' bug one layer down. Refused with 22023, a sentence, not a store."""
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        attach(conn, s, runs)
    assert "run_id" in str(exc.value).lower() or "array" in str(exc.value).lower()
    # Nothing attached: the search kept its empty default.
    assert db_search(conn, s)[1] == []


@pytest.mark.parametrize("entry", [
    pytest.param({"run_id": "r1"}, id="persona-key-absent"),
    pytest.param({"run_id": "r1", "persona": None}, id="persona-null"),
])
def test_attach_rejects_a_missing_or_null_persona(conn, user, entry):
    """A run with NO persona is refused, not stored persona-less.

    MUTATION: drop either `coalesce` from the guard in `app_attach_warm_run` and
    this goes red. `x not in (...)` is SQL NULL when `x` is NULL, and `false OR
    NULL` is NULL — so an absent/null `persona` silently passed the RAISE and was
    stored, which is exactly the "everything is role" hole the validation exists to
    close (only a present-but-wrong value like 'ceo' was caught). Found by this
    test against a real Postgres; the guard now coalesces both reads."""
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        attach(conn, s, [entry])
    # And nothing landed: the search kept its empty default.
    assert db_search(conn, s)[1] == []


def test_complete_lands_the_results_and_marks_done(conn, user):
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    results = [{"full_name": "Ada", "profile_url": "https://www.linkedin.com/in/ada"}]
    row = complete(conn, s, results)
    assert row["status"] == "done"
    assert row["results"] == results
    assert db_search(conn, s)[0] == "done"


def test_complete_accepts_up_to_sixty_results_and_refuses_sixty_one(conn, user):
    """The results ceiling rose 10 → 60 (a generous headroom above the merged
    cap): sixty land, sixty-one is a caller that skipped the merge and is refused
    with 22023."""
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    sixty = [{"full_name": f"P{i:02d}"} for i in range(60)]
    row = complete(conn, s, sixty)
    assert row["status"] == "done"
    assert len(row["results"]) == 60

    s2 = start(conn, idem=uuid.uuid4().hex)["id"]
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        complete(conn, s2, [{"full_name": f"P{i:02d}"} for i in range(61)])
    assert "at most 60" in str(exc.value).lower()
    assert db_search(conn, s2)[0] == "running", "an over-cap complete moved the row anyway"


def test_a_complete_after_a_cancel_loses_and_drops_its_results(conn, user):
    """Status is re-checked under the row lock and the transition is one-way: a
    completion racing a cancel finds 'cancelled' and the fetched results are
    dropped rather than written over a decision the user already made."""
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    cancel(conn, s)
    row = complete(conn, s, [{"full_name": "Too Late"}])
    assert row["status"] == "cancelled", "complete overrode a cancel"
    assert row["results"] == [], "cancel won but the results were written anyway"
    assert db_search(conn, s)[2] == []


def test_a_second_complete_on_a_done_row_is_a_noop(conn, user):
    """The poller is at-least-once; a second completion must be a no-op that
    returns the stored row, not a second overwrite."""
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    first = complete(conn, s, [{"full_name": "First"}])
    second = complete(conn, s, [{"full_name": "Second"}])
    assert second["status"] == "done"
    assert second["results"] == [{"full_name": "First"}], "a second complete overwrote results"
    assert second == first


def test_fail_marks_failed_and_carries_the_error(conn, user):
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    row = fail(conn, s, "vendor 500")
    assert row["status"] == "failed"
    assert row["error"] == "vendor 500"
    assert db_search(conn, s)[3] == "vendor 500"


def test_cancel_of_a_running_search_flips_it_and_writes_an_event(conn, user):
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    row = cancel(conn, s)
    assert row["status"] == "cancelled"
    assert db_search(conn, s)[0] == "cancelled"

    (payload,), = events(conn, user, "warm.search_cancelled")
    assert payload == {"search_id": s}


@pytest.mark.parametrize("terminal", ["done", "failed", "cancelled"])
def test_cancel_of_a_terminal_search_is_an_idempotent_noop(conn, user, terminal):
    """The route aborts the vendor run first and then calls this, and a user
    tapping X twice — or after the poll already finished — must get the current
    status back, never a failure page. So a cancel of a terminal search is a
    no-op returning the current status, and it does not emit a second event."""
    s = start(conn, idem=uuid.uuid4().hex)["id"]
    if terminal == "done":
        complete(conn, s, [{"full_name": "Ada"}])
    elif terminal == "failed":
        fail(conn, s, "boom")
    else:
        cancel(conn, s)

    before = len(events(conn, user, "warm.search_cancelled"))
    row = cancel(conn, s)
    assert row["status"] == terminal, "a cancel changed a terminal search's status"
    assert db_search(conn, s)[0] == terminal
    # No stray cancel event: a 'cancelled' row already logged one, the others none.
    assert len(events(conn, user, "warm.search_cancelled")) == before


# ===================================================================== the pins

def test_pin_inserts_and_returns_the_app_pin_shape(conn, user):
    row = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
              full_name="Ada Lovelace", profile_url="https://www.linkedin.com/in/ada",
              headline="Staff PM", source="warm")

    assert set(row) == PIN_ROW_KEYS, set(row) ^ PIN_ROW_KEYS
    assert row["full_name"] == "Ada Lovelace"
    assert row["profile_url"] == "https://www.linkedin.com/in/ada"
    assert row["company_key"] == "alphacorp"       # generated, normalized
    assert row["source"] == "warm"
    assert n_pins(conn, user) == 1

    (payload,), = events(conn, user, "warm.intro_pinned")
    assert payload["pin_id"] == row["id"]
    assert payload["full_name"] == "Ada Lovelace"
    assert payload["source"] == "warm"


def test_two_different_people_coexist_as_a_pin_set(conn, user):
    """Pins are a SET per (target_kind, posting_key, company): the owner
    multi-selects several contacts as intros for one posting, so two DIFFERENT
    people (different `pin_identity`) must both land rather than one replacing the
    other. The grid cell shows the count + names."""
    a = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
            full_name="Ada Lovelace", profile_url="https://www.linkedin.com/in/ada")
    b = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
            full_name="Grace Hopper", profile_url="https://www.linkedin.com/in/grace")

    assert a["id"] != b["id"], "a second DIFFERENT person overwrote the first"
    assert n_pins(conn, user) == 2


def test_re_pinning_the_same_person_updates_only_their_row(conn, user):
    """Re-pinning the SAME person (same `pin_identity` = same profile_url) UPDATES
    that person's single row rather than duplicating — replace-per-person, so a
    corrected headline lands without piling up a second intro."""
    first = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
                full_name="Ada Lovelace", profile_url="https://www.linkedin.com/in/ada",
                headline="Staff PM", source="warm")
    second = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
                 full_name="Ada L.", profile_url="https://www.linkedin.com/in/ada",
                 headline="Principal PM", source="manual")

    assert second["id"] == first["id"], "a re-pin of one person created a second row"
    assert n_pins(conn, user) == 1
    _, _, _, _, name, url, headline, source = db_pin(conn, first["id"])
    assert (name, headline, source) == ("Ada L.", "Principal PM", "manual")
    assert url == "https://www.linkedin.com/in/ada"


def test_a_bare_name_and_a_url_pin_are_distinct_identities(conn, user):
    """`pin_identity` is the profile URL when there is one, else the normalized
    name — so a bare-name pin and a URL pin for the same human are DIFFERENT
    identities and coexist as two rows. That is expected: without a URL the two
    cannot be proven the same person."""
    named = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
                full_name="Ada Lovelace")
    urled = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
                full_name="Ada Lovelace", profile_url="https://www.linkedin.com/in/ada")

    assert named["id"] != urled["id"]
    assert n_pins(conn, user) == 2


def test_a_noop_re_pin_does_not_bump_updated_at(conn, user):
    """The do-update is guarded (n1): re-pinning a person with IDENTICAL
    name/headline/source does NOT fire the unconditional touch trigger, so
    `updated_at` does not advance. A fresh idem is used so the idempotency
    short-circuit does not hide the guard being what holds the stamp."""
    first = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
                full_name="Ada Lovelace", profile_url="https://www.linkedin.com/in/ada",
                headline="Staff PM", source="warm")
    before = pin_updated_at(conn, first["id"])

    again = pin(conn, company="AlphaCorp", posting_key="greenhouse-1",
                full_name="Ada Lovelace", profile_url="https://www.linkedin.com/in/ada",
                headline="Staff PM", source="warm", idem=uuid.uuid4().hex)

    assert again["id"] == first["id"]
    assert n_pins(conn, user) == 1
    assert pin_updated_at(conn, first["id"]) == before, "a no-op re-pin bumped updated_at"


def test_a_bare_name_with_no_url_is_accepted(conn, user):
    """The add box accepts "a LinkedIn URL or a name", and a name typed off the
    top of the head is a legitimate label to keep even without a link."""
    row = pin(conn, full_name="Somebody I Met", profile_url="")
    assert row["full_name"] == "Somebody I Met"
    assert row["profile_url"] == ""


@pytest.mark.parametrize("blank", ["", " ", "\n", "\t", " ", "​"])
def test_a_nameless_pin_is_refused(conn, user, blank):
    """A pin with no name is nobody. `hq_blank_trim`, not bare `btrim`, so a name
    of one NBSP or zero-width space is blank too."""
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        pin(conn, full_name=blank)
    assert "a pin needs a name" in str(exc.value).lower()
    assert n_pins(conn, user) == 0


@pytest.mark.parametrize("bad_url", [
    "https://example.com/in/ada",
    "http://www.linkedin.com/in/ada",          # not https
    "https://linkedin.com.evil.com/in/ada",    # host is not linkedin.com
    "javascript:alert(1)",
    "https://twitter.com/ada",
])
def test_a_non_linkedin_profile_url_is_refused_at_the_door(conn, user, bad_url):
    """This column ends up in an href, so a URL that is not a linkedin.com
    address is refused with a sentence at the function, not a 23514 from the
    column CHECK."""
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        pin(conn, full_name="Ada", profile_url=bad_url)
    assert "a profile link must be a linkedin address" in str(exc.value).lower()
    assert n_pins(conn, user) == 0


def test_an_unknown_pin_source_is_refused(conn, user):
    """`source` is a reporting dimension, closed to the two tags this app writes."""
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        pin(conn, full_name="Ada", source="scraped-from-somewhere")
    assert "unknown pin source" in str(exc.value).lower()
    assert n_pins(conn, user) == 0


def test_pin_is_idempotent_on_its_idem_key(conn, user):
    """A replayed pin returns the first result and does not run the upsert, so a
    later change under the same key does not land."""
    idem = uuid.uuid4().hex
    first = pin(conn, full_name="Ada Lovelace", idem=idem)
    second = pin(conn, full_name="Grace Hopper", idem=idem)
    assert second == first
    assert db_pin(conn, first["id"])[4] == "Ada Lovelace", "a replay ran the upsert"
    assert len(events(conn, user, "warm.intro_pinned")) == 1


def test_unpin_deletes_the_owners_pin_and_is_idempotent(conn, user):
    pin_id = pin(conn, full_name="Ada Lovelace")["id"]
    assert unpin(conn, pin_id) == {"deleted": 1}
    assert n_pins(conn, user) == 0
    # A second call under a FRESH key really re-runs the delete and finds nothing.
    assert unpin(conn, pin_id, idem=uuid.uuid4().hex) == {"deleted": 0}

    # One pinned, one unpinned event — the delete that landed logged, the no-op did not.
    assert len(events(conn, user, "warm.intro_pinned")) == 1
    assert len(events(conn, user, "warm.intro_unpinned")) == 1


# ======================================================================= RLS

def test_owner_reads_its_searches_and_pins_and_a_stranger_reads_zero(conn):
    """The browser READS both tables through PostgREST, so the select policy is
    the privacy model. Both directions in one breath (test_rls.py's shape): A
    reads its own, B reads zero — a green negative cannot come from A reading
    nothing at all, because the positive control proves the read works."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")

    as_user(conn, a)
    start(conn, company="AlphaCorp", idem=uuid.uuid4().hex)
    pin(conn, company="AlphaCorp", full_name="A Contact")

    # A, as a real signed-in session, sees its own — and the whole table is those.
    as_authenticated(conn, a)
    assert count(conn, "select count(*) from public.warm_searches where user_id = %s", a) == 1
    assert count(conn, "select count(*) from public.warm_pins where user_id = %s", a) == 1
    assert count(conn, "select count(*) from public.warm_searches") == 1
    assert count(conn, "select count(*) from public.warm_pins") == 1

    # B sees nothing of A's, by any route.
    as_authenticated(conn, b)
    assert count(conn, "select count(*) from public.warm_searches where user_id = %s", a) == 0
    assert count(conn, "select count(*) from public.warm_pins where user_id = %s", a) == 0
    assert count(conn, "select count(*) from public.warm_searches") == 0
    assert count(conn, "select count(*) from public.warm_pins") == 0


def test_a_stranger_cannot_cancel_complete_or_attach_anothers_search(conn):
    """The transition functions scope `where id = p_id and user_id = auth.uid()`,
    so a stranger naming A's id gets P0002 (not-found) — which reveals nothing
    about whether the id exists — and A's search is untouched."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")

    as_user(conn, a)
    sid = start(conn, idem=uuid.uuid4().hex)["id"]

    as_user(conn, b)
    for label, call in (
        ("cancel", lambda: cancel(conn, sid)),
        ("complete", lambda: complete(conn, sid, [{"full_name": "x"}])),
        ("attach", lambda: attach(conn, sid, [{"run_id": "run-x", "persona": "role"}])),
    ):
        with pytest.raises(psycopg.Error) as exc:
            call()
        assert exc.value.sqlstate == "P0002", label

    # A's search never moved off running, and B wrote no audit rows.
    assert db_search(conn, sid)[0] == "running"
    assert events(conn, b) == []


def test_a_stranger_unpinning_anothers_pin_deletes_nothing(conn):
    """`app_unpin_warm_intro` scopes its DELETE to the caller, so a stranger who
    names A's pin id deletes 0 rows — a silent no-op, not a cross-user delete."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")

    as_user(conn, a)
    pin_id = pin(conn, full_name="Ada Lovelace")["id"]

    as_user(conn, b)
    assert unpin(conn, pin_id) == {"deleted": 0}
    assert events(conn, b, "warm.intro_unpinned") == []

    # A's pin is still there.
    as_user(conn, a)
    assert n_pins(conn, a) == 1


# ==================================================================== grants

#: The seven browser-facing warm functions, by full signature. `app_start_warm_search`
#: is the amended 7-arg shape (the new `p_overlays jsonb`).
WARM_FUNCTIONS = [
    "public.app_start_warm_search(text, text, text, jsonb, jsonb, integer, text)",
    "public.app_attach_warm_run(uuid, jsonb)",
    "public.app_complete_warm_search(uuid, jsonb)",
    "public.app_fail_warm_search(uuid, text)",
    "public.app_cancel_warm_search(uuid)",
    "public.app_pin_warm_intro(text, text, text, text, text, text, text, text)",
    "public.app_unpin_warm_intro(bigint, text)",
]


@pytest.mark.parametrize("sig", WARM_FUNCTIONS, ids=lambda s: s.split("(")[0])
def test_the_warm_functions_are_executable_by_authenticated_not_anon(conn, sig):
    """Supabase grants execute on new functions to `anon` and `authenticated` by
    name, so the migration's `revoke … from public, anon, authenticated` then
    `grant execute … to authenticated` must leave the browser role able to call
    and the anonymous role unable. test_migrations.py pins the revoke as TEXT;
    this proves the resulting privilege."""
    def can(role):
        return conn.execute(
            "select has_function_privilege(%s, %s, 'EXECUTE')", (role, sig)
        ).fetchone()[0]

    assert can("authenticated") is True, f"{sig} is not callable by authenticated — app is broken"
    assert can("anon") is False, f"{sig} is callable by an anonymous session"
