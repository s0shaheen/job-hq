"""The per-user rate and concurrency bounds (#261), against real Postgres.

`tests/core/test_migrations.py` reads the SQL as text and can prove the new
definer is revoked, pins its search_path and never takes a user id. It cannot
prove any of the things this issue is actually about — that the bound HOLDS, that
a retry does not pay twice, that a burst does not walk through it, that deleting
the metered rows does not hand the budget back — so everything here RUNS.

WHAT IT PROVES, and each line maps to one of #261's acceptance criteria or one
entry on its attack list:

    the bound holds        N+1 charges in one window raise SQLSTATE 'HQBND', and
                            the refusal names the meter in DETAIL;
    per user, not global    A at its bound does not refuse B, and B's counter is
                            its own row;
    THE RETRY (AC / the     N replays of one idem key consume ONE unit and hold
    load-bearing one)       ZERO slots afterwards — proved by driving the real
                            `app_start_warm_search` and reading
                            `usage_counters.units`, not by reading the SQL;
    the burst               N barrier-synchronised charges at max=1 admit EXACTLY
                            one; the rest raise 'HQBND'. The `insert … on conflict
                            do update … returning` is what serialises them, and
                            the mutation pin is check-then-increment, which lets
                            all N through;
    a refusal costs nothing the raise rolls its own increment back, so `units`
                            rests AT the bound rather than climbing while refused;
    DURABLE, not derived    purging every `warm_searches` row returns the DAILY
                            CAP's budget (it is a count over those rows) and does
                            NOT return the rate bound's. That contrast is the
                            entire reason the counter table exists;
    the database's clock    a session an hour off in its timezone lands in the
                            same bucket, and no function in the lane accepts an
                            instant at all;
    a restore              `window_start` is stored, so stale rows restored under
                            a current clock are stale rows, not a current window —
                            neither returning budget nor locking anyone out;
    default deny           anon cannot execute the RPC, a null identity raises
                            28000, a SUSPENDED account is refused at the counter,
                            and a definer passing somebody else's uuid is stopped
                            by the store rather than by good manners;
    the set is exact       the charging commands are derived from `pg_proc.prosrc`
                            and asserted in BOTH directions, which is what pays
                            for choosing an explicit call over a trigger;
    the numbers are        every seeded bound still says `is_placeholder`, and no
    placeholders           bound is classified `commercial` — founding users are
                            exempt from that and from nothing here;
    THE CLASS IS DECIDED   ADR-015 Q2 (owner ruling on #210, 2026-08-18) classed
                            every per-user limit here as provider-spend and abuse
                            protection. The four shipped classes are pinned one by
                            one, and no seeded note may still call the question
                            open. The VALUES stay placeholders: the ruling decided
                            the class, and nobody has picked 60, 10, 3 or 30.

Run it the way the rest of this directory runs:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55450:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55450/postgres HQ_REQUIRE_DB=1 \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_rate_bounds.py -q
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
    make_user,
    schema,  # noqa: F401 — session fixture
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def user(conn):
    u = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, u)
    return u


@pytest.fixture(autouse=True)
def restore_catalog(schema):  # noqa: F811
    """Put the seeded catalog back after each test — see `SEEDED_BOUNDS`.

    On its own connection so it cannot be defeated by whatever session state the
    test left behind, and in a `finally` position (post-yield) so it runs after a
    FAILING test too: a failure that also poisons the next file is two failures
    reported as one confusing one.
    """
    yield
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        for meter, (max_units, window) in SEEDED_BOUNDS.items():
            c.execute(
                "update public.rate_bounds "
                "   set max_units = %s, window_seconds = %s "
                " where meter = %s",
                (max_units, window, meter),
            )


# ---------------------------------------------------------------- harness

#: A meter nothing else in the suite touches, so a test can own its own budget.
SCRATCH = "test.scratch"

#: The catalog exactly as the migration seeds it: `meter -> (max, window, chargeable)`.
#:
#: Restored after EVERY test in this file, and that is not tidiness. The `schema`
#: fixture is SESSION-scoped, so a test here that tunes `warm.concurrent` down to
#: 2 and walks away changes what `tests/db/test_warm.py` means three files later
#: — its daily-cap cases start a third search that would then be refused by the
#: in-flight bound with HQBND instead of reaching HQCAP. A suite whose result
#: depends on file order is a suite that will eventually disagree with CI for a
#: reason nobody can see from the failure.
#: `is_chargeable` is DELIBERATELY NOT RESTORED here, and that is not an omission.
#: No test tunes it, so restoring it would only ever mean one thing: repairing a
#: mutated seed. Measured — with `is_chargeable` in this dict, seeding
#: `warm.concurrent` as chargeable (the exact defect the flag exists to prevent)
#: left the whole file GREEN, because the first test's teardown put the flag back
#: before the test that checks it ever ran. A restore fixture that also fixes the
#: schema is a restore fixture that hides the schema.
SEEDED_BOUNDS = {
    "quickadd.resolve": (60, 600),
    "warm.start": (10, 600),
    "warm.concurrent": (3, 1),
    "export.build": (30, 600),
}


def _system(conn) -> None:
    """The operator lane: superuser role, no browser identity."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


def as_authenticated(conn, user_id) -> None:
    """A signed-in browser session: an identity AND the `authenticated` role.

    Skipping `set role` is the difference between testing the boundary and
    testing nothing — `postgres` is a superuser, policies do not apply to it, and
    `hq_entitlement_guard`'s engine hatch reads `current_setting('role')`.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def define_meter(conn, meter: str, max_units: int, window_seconds: int = 600,
                 bound_class: str = "security") -> None:
    _system(conn)
    conn.execute(
        "insert into public.rate_bounds (meter, bound_class, max_units, window_seconds, note) "
        "values (%s, %s, %s, %s, 'PLACEHOLDER: test fixture') "
        "on conflict (meter) do update set max_units = excluded.max_units, "
        "  window_seconds = excluded.window_seconds",
        (meter, bound_class, max_units, window_seconds),
    )


def charge(conn, meter: str = SCRATCH, p_max=None):
    """The browser-reachable charge, as a signed-in session calls it."""
    return conn.execute(
        "select public.app_charge_rate_bound(%s, %s)", (meter, p_max)
    ).fetchone()[0]


def _admin_read(sql: str, args: tuple):
    """Read as the superuser on a SEPARATE connection.

    Deliberately not `_system(conn)` on the test's own connection: `reset role` +
    clearing `hq.test_user` would drop the browser session the test is in the
    middle of, and the next RPC call would raise 28000 instead of the refusal
    being measured. That mistake produced a green-looking `28000 != HQCAP` in the
    first draft of this file.
    """
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        return c.execute(sql, args).fetchone()


def units(uid: str, meter: str) -> int:
    return int(_admin_read(
        "select coalesce(sum(units), 0) from public.usage_counters "
        " where user_id = %s and meter = %s", (uid, meter))[0])


def start_warm(conn, *, company="Acme", idem=None, daily_cap=20):
    return conn.execute(
        "select public.app_start_warm_search("
        "  'posting', '', %s, %s::jsonb, %s::jsonb, %s, %s)",
        (company, json.dumps({}), json.dumps({}), daily_cap,
         idem or uuid.uuid4().hex),
    ).fetchone()[0]


# ═══════════════════════════════════════════════════════════ the sanity floor

def test_the_catalog_and_the_counter_exist_and_are_wired(conn, user):
    """Guards every case below from passing against a schema that has neither.

    An empty enumeration is the cheapest way for a file like this to be green
    and mean nothing.
    """
    _system(conn)
    seeded = [r[0] for r in conn.execute(
        "select meter from public.rate_bounds order by 1").fetchall()]
    assert {"quickadd.resolve", "warm.start", "warm.concurrent",
            "export.build"} <= set(seeded), seeded

    define_meter(conn, SCRATCH, 5)
    as_authenticated(conn, user)
    assert charge(conn) == 1, "the first charge in a window is unit 1"
    assert units(user, SCRATCH) == 1


# ══════════════════════════════════════════════════════════════ the bound holds

def test_the_bound_refuses_the_call_past_it_with_HQBND(conn, user):
    """AC 1: a distinct, catalogued SQLSTATE that NAMES the bound.

    KILLED BY: raising a bare `raise exception` without `using errcode`, which
    PostgREST would carry as P0001 and the app would render as a generic error;
    or by comparing `units < v_max` instead of `> v_max`, which admits one extra.
    """
    define_meter(conn, SCRATCH, 3)
    as_authenticated(conn, user)
    assert [charge(conn) for _ in range(3)] == [1, 2, 3]

    with pytest.raises(psycopg.Error) as exc:
        charge(conn)
    assert exc.value.sqlstate == "HQBND"
    # The meter travels in DETAIL, which is what the app matches on — never the
    # message, which names numbers and would make copy load-bearing.
    assert exc.value.diag.message_detail == SCRATCH
    assert "retry after" in (exc.value.diag.message_hint or "")


def test_a_refusal_does_not_extend_the_window(conn, user):
    """The raise rolls back its own increment, so `units` rests AT the bound.

    `webapp/lib/quickadd/rate.ts`'s shipped rule — "a refused call is counted
    against nothing, so refusal never extends the window" — preserved in SQL.

    KILLED BY: committing the increment before the check (an autonomous
    transaction, or a check in a separate statement after a commit): `units`
    would then climb to 8 and the user would stay refused for the rest of the
    window no matter how long they waited.
    """
    define_meter(conn, SCRATCH, 2)
    as_authenticated(conn, user)
    charge(conn)
    charge(conn)
    for _ in range(5):
        with pytest.raises(psycopg.Error):
            charge(conn)
    assert units(user, SCRATCH) == 2


def test_an_app_supplied_max_may_only_tighten_never_loosen(conn, user):
    """`p_max` is clamped `least(coalesce(p_max, max_units), max_units)`.

    The browser holds the anon key and can call this RPC without the app, so a
    limit the caller supplies is a limit the caller chooses. Env may tighten a
    bound for a deploy; nothing outside the database may raise one.

    KILLED BY: `coalesce(p_max, max_units)` without the `least`, which is the
    shipped `p_daily_cap` shape and is exactly what this refuses to copy.
    """
    define_meter(conn, SCRATCH, 2)
    as_authenticated(conn, user)
    # Tighter wins: a max of 1 refuses the second call even though the catalog
    # allows two.
    assert charge(conn, p_max=1) == 1
    with pytest.raises(psycopg.Error) as exc:
        charge(conn, p_max=1)
    assert exc.value.sqlstate == "HQBND"
    assert units(user, SCRATCH) == 1, "the tightened refusal still moved the counter"

    # Looser is IGNORED rather than honoured, and this is the half that matters.
    # A caller asking for 1000 gets the catalog's 2: the second unit lands…
    assert charge(conn, p_max=1000) == 2
    # …and the third does not. Without the `least`, `p_max = 1000` would carry
    # this to a thousand — which is `p_daily_cap`'s shipped shape and exactly
    # what this refuses to copy.
    with pytest.raises(psycopg.Error) as exc:
        charge(conn, p_max=1000)
    assert exc.value.sqlstate == "HQBND"
    assert units(user, SCRATCH) == 2


def test_an_authenticated_caller_cannot_create_a_warm_concurrent_counter_row(conn, user):
    """The security review's MEDIUM finding, closed and pinned.

    `app_charge_rate_bound` accepts any CATALOGUED meter, and `warm.concurrent`
    is catalogued with `window_seconds = 1`. With the counter keyed
    `(user_id, meter, window_start)` that made it a free-row primitive: one
    durable row per second, 86,400 a day per account, on a table with no purge
    lane — and free, because the meter is INERT (the in-flight bound reads
    `warm_searches.status` and never the counter), so burning it to the bound
    denied the attacker nothing.

    The FK on `usage_counters.meter` closed the same attack for varying the
    METER and missed varying the WINDOW. `is_chargeable = false` closes it.

    KILLED BY: deleting the `is_chargeable` check from `hq_charge_rate_bound`, or
    seeding `warm.concurrent` with `is_chargeable = true`.
    """
    as_authenticated(conn, user)
    for _ in range(5):
        with pytest.raises(psycopg.Error) as exc:
            charge(conn, meter="warm.concurrent")
        assert exc.value.sqlstate == "22023"
        assert "not chargeable" in (exc.value.diag.message_primary or "")

    # Not one row, by any path a browser has.
    assert units(user, "warm.concurrent") == 0
    assert _admin_read(
        "select count(*) from public.usage_counters where meter = %s",
        ("warm.concurrent",))[0] == 0

    # And the bound it names still works, which is the half that proves the
    # refusal above cost the user nothing they were entitled to.
    _system(conn)
    conn.execute(
        "update public.rate_bounds set max_units = 1 where meter = 'warm.concurrent'")
    define_meter(conn, "warm.start", 50)
    as_authenticated(conn, user)
    start_warm(conn, company="One")
    with pytest.raises(psycopg.Error) as exc:
        start_warm(conn, company="Two")
    assert exc.value.sqlstate == "HQBND"
    assert exc.value.diag.message_detail == "warm.concurrent"


def test_the_catalog_says_which_meters_have_a_counter_and_which_do_not(conn):
    """Both directions, so the flag cannot drift into decoration.

    KILLED BY: flipping `is_chargeable` on any seeded row.
    """
    _system(conn)
    rows = dict(conn.execute(
        "select meter, is_chargeable from public.rate_bounds "
        " where meter not like 'test.%'").fetchall())
    assert rows == {
        "quickadd.resolve": True,
        "warm.start": True,
        "export.build": True,
        # Live in-flight state, read from `warm_searches.status`. Never a row here.
        "warm.concurrent": False,
    }, rows


def test_an_oversized_meter_never_reaches_a_log_line(conn, user):
    """The security review's LOW finding: `p_meter` was unbounded text echoed
    verbatim into an error message, on a path that is never charged — the
    unknown-meter raise sits ABOVE the increment. So a signed-in caller could
    push arbitrary 100 kB strings into the Postgres server log, for free, as
    often as it liked (measured: 100,000 chars in produced a 100,020-char line).

    This file already bounds `p_idem` to 200 and `p_params`/`p_overlays` to 8192
    citing the same reason; the meter was the one stored-verbatim string that
    escaped it.

    KILLED BY: deleting the length check — the refusal still raises 22023, so the
    assertion is on the MESSAGE LENGTH rather than on the SQLSTATE.
    """
    as_authenticated(conn, user)
    with pytest.raises(psycopg.Error) as exc:
        charge(conn, meter="x" * 100_000)
    assert exc.value.sqlstate == "22023"
    assert len(exc.value.diag.message_primary or "") < 200, (
        "the caller's string reached the message, and therefore the server log"
    )

    # An unknown meter that IS within the length bound is still truncated in the
    # message — belt and braces, and the assertion that keeps `left()` honest.
    with pytest.raises(psycopg.Error) as exc:
        charge(conn, meter="y" * 64)
    assert exc.value.sqlstate == "22023"
    assert len(exc.value.diag.message_primary or "") < 200


def test_an_unknown_meter_fails_loud_rather_than_meaning_unbounded(conn, user):
    """A typo'd meter must not silently mean "no bound".

    KILLED BY: `if not found then return; end if;` — the shape that turns every
    misspelling into an unmetered capability.
    """
    as_authenticated(conn, user)
    with pytest.raises(psycopg.Error) as exc:
        charge(conn, meter="nope.not.a.meter")
    assert exc.value.sqlstate == "22023"
    assert "unknown rate meter" in (exc.value.diag.message_primary or "")


# ═════════════════════════════════════════════════════ per user, not per system

def test_the_bound_is_per_user_and_not_global(conn):
    """AC: a per-USER bound. A at its bound does not refuse B.

    KILLED BY: dropping `user_id` from the counter's key or from the `where` — a
    global counter refuses the second user immediately, and one noisy account
    would take the product down for everybody, which is a worse failure than the
    one the bound exists to prevent.
    """
    define_meter(conn, SCRATCH, 2)
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")

    as_authenticated(conn, a)
    charge(conn)
    charge(conn)
    with pytest.raises(psycopg.Error) as exc:
        charge(conn)
    assert exc.value.sqlstate == "HQBND"

    # B is untouched, and gets its OWN two.
    as_authenticated(conn, b)
    assert charge(conn) == 1, "A's burst spent B's budget — the counter is global"
    assert charge(conn) == 2

    assert units(a, SCRATCH) == 2
    assert units(b, SCRATCH) == 2


# ══════════════════════════════════ THE RETRY — #261's load-bearing requirement

def test_n_replays_of_one_idem_key_consume_one_unit_and_hold_no_slot(conn, user):
    """The one #261 calls "the load-bearing one", proved on the real command.

    Every command RPC answers a replay from a durable result BEFORE it works
    (`0020_warm_referral.sql:346-351` above the cap count; `hq_command_replay` at
    `0026_resume.sql:919`). A rate bound placed at the route, or at RPC entry
    ABOVE that lookup, makes a client retrying one gesture pay twice for work
    performed once — which the outbox and the emailed-link lane both do by
    design.

    So: five calls with ONE key. One `warm_searches` row, one `warm.start` unit,
    and ZERO slots held afterwards — the mirror failure, a concurrency slot taken
    before the replay check and released only on the write path, is proved absent
    by the fifth call being admitted at all and by the in-flight count being 1.

    KILLED BY: moving the `hq_charge_rate_bound` call above the replay lookup in
    `app_start_warm_search` — `units` becomes 5. Measured against this database.
    """
    define_meter(conn, "warm.start", 3)
    as_authenticated(conn, user)

    key = uuid.uuid4().hex
    rows = [start_warm(conn, idem=key) for _ in range(5)]

    assert len({r["id"] for r in rows}) == 1, "a replay returned a different search"
    assert units(user, "warm.start") == 1, (
        "a replayed command consumed a second unit — the charge is above the "
        "replay lookup"
    )
    _system(conn)
    assert conn.execute(
        "select count(*) from public.warm_searches where user_id = %s", (user,)
    ).fetchone()[0] == 1
    # ZERO slots held: the in-flight count is the one real running search, not
    # one per replay. Nothing leases, so nothing leaks.
    assert conn.execute(
        "select count(*) from public.warm_searches "
        " where user_id = %s and status = 'running'", (user,)
    ).fetchone()[0] == 1


def test_a_command_that_raises_below_the_charge_does_not_spend_a_unit(conn, user):
    """The charge is in the same transaction as the write, so a rollback un-charges.

    Nobody pays for work that did not happen. Driven through the real daily cap:
    the `HQCAP` raise sits BELOW the `warm.start` charge, so an over-cap start
    rolls the unit back with it.

    KILLED BY: charging in an autonomous transaction, or at the route before the
    RPC — the over-cap refusal would then cost a rate unit too, and a user who
    hit their daily cap would also be rate-limited out of noticing.
    """
    define_meter(conn, "warm.start", 50)
    as_authenticated(conn, user)
    start_warm(conn, daily_cap=1)                       # unit 1, row 1
    assert units(user, "warm.start") == 1

    with pytest.raises(psycopg.Error) as exc:
        start_warm(conn, daily_cap=1)                   # over the daily cap
    assert exc.value.sqlstate == "HQCAP"
    assert units(user, "warm.start") == 1, (
        "an over-cap refusal spent a rate unit — the charge did not roll back"
    )


# ══════════════════════════════════════════════════════════════════ the burst

def test_concurrent_charges_at_max_one_admit_exactly_one(conn, user):
    """N racing charges, one bound, one winner.

    The `insert … on conflict do update set units = units + 1 returning units` is
    what serialises them: the ON CONFLICT arm takes the counter row's lock inside
    one statement, so each racer reads a distinct value rather than all of them
    reading the same pre-increment count.

    KILLED BY: the check-then-increment shape — `select units …; if units >= max
    then raise; end if; update … set units = units + 1` — under READ COMMITTED
    every racer reads 0, every racer passes, and all N land. That is the same
    defect `test_warm.py::test_concurrent_starts_at_cap_one_admit_exactly_one`
    was written for, in a new place, and it is why the bound cannot be a
    read-then-write.
    """
    define_meter(conn, SCRATCH, 1)
    N = 6
    conns = [psycopg.connect(DATABASE_URL) for _ in range(N)]
    try:
        for c in conns:
            as_authenticated(c, user)
            c.commit()          # session GUC + role survive a per-thread rollback

        barrier = threading.Barrier(N)
        oks: list = []
        bounded: list = []
        others: list = []
        guard = threading.Lock()

        def fire(c):
            barrier.wait()
            try:
                v = c.execute(
                    "select public.app_charge_rate_bound(%s, null)", (SCRATCH,)
                ).fetchone()[0]
                c.commit()
                with guard:
                    oks.append(v)
            except psycopg.Error as e:
                c.rollback()
                with guard:
                    (bounded if e.sqlstate == "HQBND" else others).append(e.sqlstate)

        threads = [threading.Thread(target=fire, args=(c,)) for c in conns]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        assert all(not t.is_alive() for t in threads), "a concurrent charge never returned"
    finally:
        for c in conns:
            c.close()

    assert others == [], f"a charge raised something other than HQBND: {others}"
    assert len(oks) == 1, f"expected exactly one winner, got {len(oks)}"
    assert len(bounded) == N - 1, f"expected {N - 1} HQBND refusals, got {len(bounded)}"
    assert units(user, SCRATCH) == 1


# ══════════════════════════════════════ durable, not derived from metered rows

def test_purging_the_metered_rows_returns_the_daily_caps_budget_and_not_the_rate_bounds(conn, user):
    """#261's attack list, the first entry, proved as a CONTRAST.

    The shipped daily cap is DERIVED — `count(*) from warm_searches where
    created_at > now() - interval '24 hours'` (`0020_warm_referral.sql:353-356`)
    — so anything that removes those rows returns the budget, and #209 is adding
    recurring retention purge lanes over exactly that class of table. The rate
    bound is its own fact and survives the same purge.

    Both halves are asserted, and the first half is the important one: without it
    this test would pass against a schema where nothing had been purged at all.

    KILLED BY: implementing `warm.start` as another count over `warm_searches` —
    the second half then goes green-to-red, because the purge would return that
    budget too.
    """
    define_meter(conn, "warm.start", 2)
    as_authenticated(conn, user)
    start_warm(conn, daily_cap=2)
    start_warm(conn, daily_cap=2)

    # Both bounds are now spent: the daily cap at 2, the rate bound at 2.
    with pytest.raises(psycopg.Error) as exc:
        start_warm(conn, daily_cap=2)
    assert exc.value.sqlstate == "HQBND"

    # The purge lane, exactly as a retention job would run it.
    _system(conn)
    conn.execute("delete from public.warm_searches where user_id = %s", (user,))

    # HALF ONE — the derived cap DID come back. If this fails, nothing was
    # purged and half two proves nothing.
    assert conn.execute(
        "select count(*) from public.warm_searches "
        " where user_id = %s and created_at > now() - interval '24 hours'", (user,)
    ).fetchone()[0] == 0

    # HALF TWO — the durable bound did NOT. Same purge, same user, still refused.
    as_authenticated(conn, user)
    with pytest.raises(psycopg.Error) as exc:
        start_warm(conn, daily_cap=2)
    assert exc.value.sqlstate == "HQBND", (
        "purging the metered rows returned the rate bound's budget — the counter "
        "is derived from them after all"
    )
    assert units(user, "warm.start") == 2


# ═════════════════════════════════════════════════════════════════ the clock

def test_the_window_comes_from_the_databases_clock_not_the_callers(conn, user):
    """#261's attack list: "a bound reset by … a clock".

    Two halves, because either alone is weak:

      1. STATIC — no function in this lane accepts an instant at all. A window
         boundary cannot be moved by an argument that does not exist, and this is
         the assertion that stays true when somebody adds a convenience
         parameter.
      2. LIVE — a session whose timezone is fourteen hours off lands in the same
         bucket and stays refused. `now()` is transaction_timestamp() and the
         floor is taken on the UTC epoch, so local time never enters it.

    KILLED BY: `date_trunc('hour', now())` (which IS timezone-dependent for
    anything coarser than an hour and reads as if it were not), or by adding a
    `p_now timestamptz` parameter.
    """
    _system(conn)
    instants = conn.execute(
        """
        select p.proname, unnest(coalesce(p.proargnames, array[]::text[]))
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('hq_charge_rate_bound', 'app_charge_rate_bound')
           and 'timestamptz'::regtype = any (p.proargtypes::oid[])
        """
    ).fetchall()
    assert instants == [], f"the charge lane accepts a caller-supplied instant: {instants}"

    define_meter(conn, SCRATCH, 1, window_seconds=3600)
    as_authenticated(conn, user)
    conn.execute("set timezone = 'UTC'")
    charge(conn)
    before = _admin_read(
        "select window_start from public.usage_counters "
        " where user_id = %s and meter = %s order by window_start desc limit 1",
        (user, SCRATCH))[0]

    # A caller a whole day around the world. Same bucket, same refusal.
    conn.execute("set timezone = 'Pacific/Kiritimati'")     # UTC+14
    with pytest.raises(psycopg.Error) as exc:
        charge(conn)
    assert exc.value.sqlstate == "HQBND"
    conn.execute("set timezone = 'Pacific/Niue'")           # UTC-11
    with pytest.raises(psycopg.Error) as exc:
        charge(conn)
    assert exc.value.sqlstate == "HQBND"

    conn.execute("set timezone = 'UTC'")
    after = _admin_read(
        "select window_start from public.usage_counters "
        " where user_id = %s and meter = %s order by window_start desc limit 1",
        (user, SCRATCH))[0]
    assert after == before, "the caller's timezone moved the window"


def test_a_restored_stale_row_is_a_stale_row_not_a_current_window(conn, user):
    """#261's attack list: "a bound reset by a restore".

    `window_start` is STORED, not derived at read time, and that is what bounds
    what a restore can do. A dump taken in an earlier window and restored under
    the current clock brings back rows for THAT window — which neither returns
    budget in the current one nor locks the account out of it. What a restore
    genuinely does return is the units recorded in a window that is still open at
    restore time, and that is stated honestly in the migration header rather than
    pretended away: a restore is an owner-supervised operator event, and every
    window here is at most a day (`rate_bounds_window_is_short`).

    KILLED BY: computing the bucket from `created_at` at read time, or keying the
    counter on `(user_id, meter)` alone with a "reset when stale" update — a
    restored row then either IS the current window or wipes it.
    """
    define_meter(conn, SCRATCH, 2, window_seconds=600)
    _system(conn)
    # The dump's row: a FULL bucket, two hours old. This is what a restore lays down.
    conn.execute(
        "insert into public.usage_counters (user_id, meter, window_start, units) "
        "values (%s, %s, to_timestamp(floor(extract(epoch from now() - interval '2 hours') / 600) * 600), 99)",
        (user, SCRATCH),
    )
    as_authenticated(conn, user)
    # The stale bucket does not lock the current one: the budget here is fresh.
    assert charge(conn) == 1
    assert charge(conn) == 2
    with pytest.raises(psycopg.Error) as exc:
        charge(conn)
    assert exc.value.sqlstate == "HQBND"

    _system(conn)
    windows = conn.execute(
        "select count(distinct window_start) from public.usage_counters "
        " where user_id = %s and meter = %s", (user, SCRATCH)
    ).fetchone()[0]
    assert windows == 2, "the stale row and the live one collapsed into one window"


# ════════════════════════════════════════════════════════════════ default deny

def test_anon_cannot_execute_the_charge_and_holds_nothing_on_either_table(conn):
    """The signed-out role reaches none of it — grants, not policies.

    KILLED BY: dropping either `revoke all`, or granting execute to `public`
    (which includes anon) instead of to `authenticated`.
    """
    _system(conn)
    assert conn.execute(
        "select has_function_privilege('authenticated', "
        "  'public.app_charge_rate_bound(text, integer)', 'execute')").fetchone()[0] is True
    for role in ("anon", "public"):
        assert conn.execute(
            "select has_function_privilege(%s, "
            "  'public.app_charge_rate_bound(text, integer)', 'execute')", (role,)
        ).fetchone()[0] is False, f"{role} may execute the charge"
        # The internal helper is reachable from nobody but a definer that already
        # runs as the owner — `hq_command_replay`'s posture.
        assert conn.execute(
            "select has_function_privilege(%s, "
            "  'public.hq_charge_rate_bound(uuid, text, integer)', 'execute')", (role,)
        ).fetchone()[0] is False
    assert conn.execute(
        "select has_function_privilege('authenticated', "
        "  'public.hq_charge_rate_bound(uuid, text, integer)', 'execute')"
    ).fetchone()[0] is False, (
        "a browser role may charge an arbitrary user id directly"
    )

    for table in ("public.rate_bounds", "public.usage_counters"):
        for role in ("anon", "authenticated"):
            assert conn.execute(
                "select has_table_privilege(%s, %s, 'select, insert, update, delete')",
                (role, table),
            ).fetchone()[0] is False, f"{role} holds a privilege on {table}"


def test_a_null_identity_is_refused_with_28000(conn, user):
    """The definer's own body refuses an anonymous caller, not just the grant.

    `hq_entitlement_guard` returns early on a null `auth.uid()` for the engine's
    sake, so a definer that acts without an identity acts as the engine
    (`tests/db/test_default_deny.py`'s standing assertion). This is that
    convention, exercised.

    KILLED BY: deleting the `if v_user is null` block from
    `app_charge_rate_bound`.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("set role authenticated")
    with pytest.raises(psycopg.Error) as exc:
        charge(conn, meter="quickadd.resolve")
    assert exc.value.sqlstate == "28000"


def test_a_suspended_account_is_refused_at_the_counter(conn, user):
    """CLAUDE.md: unknown, pending, suspended, removed or wrong-owner defaults to deny.

    The refusal comes from `usage_counters`' own guard trigger, which is the
    point of arming the entitlement pair on a table no browser can reach: the
    charge runs inside a `security definer`, where RLS does not apply, so the
    trigger is the entire boundary — and it stops a suspended account BEFORE the
    command it was driving reaches its own write.

    KILLED BY: dropping the `usage_counters_entitlement_guard` trigger.
    """
    define_meter(conn, SCRATCH, 10)
    as_authenticated(conn, user)
    assert charge(conn) == 1

    _system(conn)
    conn.execute("select public.hq_suspend_user(%s, 'test')", (user,))

    as_authenticated(conn, user)
    with pytest.raises(psycopg.Error) as exc:
        charge(conn)
    assert exc.value.sqlstate == "42501"
    assert "not entitled" in (exc.value.diag.message_primary or "")
    assert units(user, SCRATCH) == 1, "a suspended account moved its counter"


def test_a_definer_naming_the_wrong_owner_is_stopped_by_the_store(conn):
    """`hq_charge_rate_bound` takes `p_user`, and the store does not trust it.

    The migration claims this in prose: "even a future definer that passed the
    wrong uuid would be stopped by the store, not by this function's good
    manners". This builds that exact mistake — a definer that charges somebody
    else's meter — inside the live schema, drives it as a real session, asserts
    the refusal, and drops it. A claim about a hypothetical caller is worth
    nothing until the hypothetical caller exists.

    KILLED BY: dropping the guard trigger, or weakening its ownership half to
    `user_id is not null`.
    """
    define_meter(conn, SCRATCH, 10)
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")

    _system(conn)
    conn.execute(
        """
        create function public.zz_bad_charge(p_victim uuid) returns integer
        language plpgsql security definer set search_path = public, pg_temp as $f$
        begin
          return public.hq_charge_rate_bound(p_victim, 'test.scratch');
        end $f$;
        """
    )
    conn.execute("grant execute on function public.zz_bad_charge(uuid) to authenticated")
    try:
        as_authenticated(conn, a)
        with pytest.raises(psycopg.Error) as exc:
            conn.execute("select public.zz_bad_charge(%s)", (b,))
        assert exc.value.sqlstate == "42501"
        assert "may not write" in (exc.value.diag.message_primary or "")
        assert units(b, SCRATCH) == 0, "A charged B's meter"
    finally:
        _system(conn)
        conn.execute("drop function if exists public.zz_bad_charge(uuid)")


# ══════════════════════════════════════════════════ warm's in-flight bound

def test_the_in_flight_bound_refuses_and_a_finished_search_releases_its_slot(conn, user):
    """The CONCURRENCY half of #261's AC, and the reason it is not a counter.

    Concurrency is live state, not a count over a window: a search that finishes,
    fails or is cancelled releases its own slot by changing `status`, so there is
    nothing to hand back and nothing that can leak when the RPC returns early on
    a replay. That is the structural answer to the mirror failure on the attack
    list — "a concurrency slot taken before the replay check and released only on
    the write path".

    KILLED BY: modelling concurrency as a `usage_counters` meter with a manual
    decrement — the cancel below would then have to remember to decrement, and
    the replay in the retry test above would leak one slot per retry.
    """
    _system(conn)
    conn.execute(
        "update public.rate_bounds set max_units = 2 where meter = 'warm.concurrent'")
    define_meter(conn, "warm.start", 50)

    as_authenticated(conn, user)
    a = start_warm(conn, company="One")
    start_warm(conn, company="Two")
    with pytest.raises(psycopg.Error) as exc:
        start_warm(conn, company="Three")
    assert exc.value.sqlstate == "HQBND"
    assert exc.value.diag.message_detail == "warm.concurrent"

    # Cancelling releases the slot — by changing status, not by decrementing.
    conn.execute("select public.app_cancel_warm_search(%s)", (a["id"],))
    third = start_warm(conn, company="Three")
    assert third["status"] == "running"

    # And the in-flight refusal spent NO rate unit: it raised above the charge.
    assert units(user, "warm.start") == 3, (
        "the in-flight refusal consumed a warm.start unit"
    )


# ═══════════════════════════════════════════ the set is exact, in both directions

#: The commands that charge a bound today, and the whole of decision 6's "NOW".
#: Asserted EXACT in both directions: a command that stops charging fails until
#: the line is deleted, and a command cannot join the set silently.
#:
#: This is what pays for choosing an explicit call inside the RPC over a trigger
#: (the migration's decision 3). A trigger cannot be forgotten; an explicit call
#: can — so the thing that cannot be forgotten is this test.
CHARGING_COMMANDS = {
    "app_charge_rate_bound":
        "the not-a-command lane, reached through `DataSource.chargeRateBound`. "
        "Quick-add's resolve (a server action) reads up to 25 pages and "
        "/api/export (a route) rebuilds a whole file; both write nothing, so "
        "neither has a command RPC to charge inside.",
    "app_start_warm_search":
        "vendor spend (~$0.30 of Apify a search) plus the in-flight bound. The "
        "charge sits BELOW the replay lookup and ABOVE the daily cap.",
}


def test_the_bounded_command_set_is_exact(conn):
    """Derived from `pg_proc.prosrc`, not from a list somebody maintains.

    KILLED BY: adding a charge to a new RPC without saying so here, or deleting
    one from an RPC that still claims to have it.
    """
    _system(conn)
    charging = {
        r[0]
        for r in conn.execute(
            """
            select p.proname
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname like 'app!_%' escape '!'
               and (p.prosrc ilike '%hq_charge_rate_bound%'
                    or p.prosrc ilike '%rate_bounds%')
             order by 1"""
        ).fetchall()
    }
    assert charging == set(CHARGING_COMMANDS), (
        "the set of bounded commands changed. Add the entry with its reason, or "
        f"delete the stale one: {sorted(charging ^ set(CHARGING_COMMANDS))}"
    )


def test_every_shipped_bound_is_still_flagged_a_placeholder(conn):
    """#261 does NOT decide the values, and ADR-015 Q2 did not decide them either.

    The owner ruling on #210 (2026-08-18) answered the CLASS question this flag
    was once bundled with — the limits are provider-spend and abuse protection,
    not commercial quotas — and it left the four integers exactly where they
    were. `is_placeholder` is a fact about the NUMBER and about nothing else, so
    a ruling that decided the class must not clear it; that separation is what
    `20260818_223038_bound_class_is_decided.sql` writes into the column comment
    rather than into the data.

    So the schema still says so in a column, and this is what stops the flag
    rotting into a lie: the day the owner picks the numbers, whoever writes them
    clears the flag, and the day somebody adds a bound without asking, this goes
    red.

    KILLED BY: seeding a bound without `is_placeholder`, defaulting the column to
    false, or clearing the flag on the strength of the class ruling.
    """
    _system(conn)
    decided = conn.execute(
        "select meter, max_units, window_seconds from public.rate_bounds "
        " where not is_placeholder and meter not like 'test.%' order by 1"
    ).fetchall()
    assert decided == [], (
        "a bound claims to have been decided by a person. If that is true, say so "
        f"in the PR and update this test: {decided}"
    )
    # And the population, so the emptiness above is a measured difference rather
    # than a fact about an empty table.
    assert conn.execute(
        "select count(*) from public.rate_bounds where is_placeholder").fetchone()[0] >= 4


def test_the_class_of_every_shipped_bound_is_decided_and_named(conn):
    """ADR-015 Q2, owner ruling on #210 (2026-08-18): the per-user limits are
    PROVIDER-SPEND PROTECTION, not commercial quotas, and founding users are not
    exempt from them.

    The ruling decided the class for every meter at once, which turns the four
    classes from an implementer's judgement into the shipped contract — so they
    get pinned one by one, with the reason each was chosen. The CHECK below is
    asserted separately and is not enough on its own: it forbids `commercial`
    and permits any of the other three, so it would not notice a later branch
    quietly moving `warm.start` to `security` or seeding a fifth bound whose
    class nobody argued for.

    Deliberately NOT asserted here: that the migration reassigned something. It
    reassigned nothing, because every row already carried a decided,
    non-commercial class the day it shipped. This test is what makes that a
    measured fact rather than a claim in a PR body.

    KILLED BY: changing a seeded meter's class, or adding a bound without adding
    it here with its reason.
    """
    _system(conn)
    shipped = dict(conn.execute(
        "select meter, bound_class from public.rate_bounds "
        " where meter not like 'test.%' order by 1").fetchall())
    assert shipped == {
        # Somebody else's bill: ~$0.30 of harvestapi spend per search.
        "warm.start": "provider",
        # Abuse and misuse: a user-driven OUTBOUND fetch, up to 25 pages a call.
        "quickadd.resolve": "security",
        # Our own capacity: live in-flight work, not a window count.
        "warm.concurrent": "reliability",
        # Our own capacity again: function CPU, memory and egress, no third party.
        "export.build": "reliability",
    }, (
        "a shipped bound's class changed, or a new bound arrived unclassified. "
        "ADR-015 Q2 ruled on the class of every per-user limit in this product; "
        "a new one needs its reason here, and none of them may be commercial."
    )


def test_no_shipped_note_still_calls_the_classification_an_open_question(conn):
    """The prose half of the ruling, and the reason it is worth a test.

    `20260817_011844_per_user_rate_bounds.sql` seeded `warm.start` with a note
    ending "The DAILY cap's classification is the open owner question (#210)."
    That sentence is data an operator reads while deciding whether to touch the
    number, and it went false on 2026-08-18. A comment that describes a settled
    decision as pending is worse than no comment: the next person re-derives the
    answer, or re-asks it.

    Asserted over EVERY note rather than over `warm.start` alone, so a bound
    seeded later carrying the same stale framing is caught too.

    KILLED BY: dropping the guarded UPDATE from
    `20260818_223038_bound_class_is_decided.sql`, or seeding a new bound whose
    note calls the class an open question.
    """
    _system(conn)
    stale = conn.execute(
        "select meter, note from public.rate_bounds "
        " where meter not like 'test.%' "
        "   and (note ilike '%open owner question%' "
        "     or note ilike '%classification is%open%') order by 1").fetchall()
    assert stale == [], (
        "a bound's note still calls the classification undecided. ADR-015 Q2 was "
        f"ruled on 2026-08-18: {stale}"
    )

    # And the positive control, so the emptiness above is a rewrite rather than a
    # note somebody deleted: the row that carried the stale sentence now names
    # the ruling and still says the daily cap is enforced elsewhere.
    note = conn.execute(
        "select note from public.rate_bounds where meter = 'warm.start'").fetchone()[0]
    assert "ADR-015 Q2" in note, note
    assert "PROVIDER-SPEND" in note, note


def test_no_bound_is_a_commercial_quota_and_the_charge_never_reads_invited(conn):
    """CLAUDE.md: founding users are free forever — exempt from COMMERCIAL quotas,
    "not from security, abuse, concurrency, provider, or reliability limits".

    Two halves, and both are structural rather than conventional:

      1. `rate_bounds.bound_class`'s CHECK cannot hold 'commercial'. A commercial
         quota arriving later is a different mechanism, and it will not be able
         to hide in this table.
      2. `hq_charge_rate_bound`'s stored body never mentions `invited`. If it
         ever did, the free-forever promise and an abuse bound would be the same
         code, and neither could change without the other — which is exactly the
         failure #210 §D exists to prevent at the access boundary.

    KILLED BY: widening the CHECK, or adding an `invited` exemption to the charge.
    """
    _system(conn)
    with pytest.raises(psycopg.Error) as exc:
        conn.execute(
            "insert into public.rate_bounds (meter, bound_class, max_units, window_seconds) "
            "values ('x.commercial', 'commercial', 10, 60)")
    assert exc.value.sqlstate == "23514"

    body = conn.execute(
        "select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
        " where n.nspname = 'public' and p.proname = 'hq_charge_rate_bound'"
    ).fetchone()[0]
    assert "invited" not in body, (
        "the charge reads entitlements.invited — a founding user is exempt from "
        "commercial quotas and from nothing in this table"
    )
    assert "rate_bounds" in body, "the body no longer reads the catalog at all"
