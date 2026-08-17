"""Default deny, cross-checked against pg_catalog rather than against a list.

`test_entitlement.py` proves the gate works on the surfaces that exist today. It
cannot prove anything about the table or the RPC somebody adds in six weeks, and
that is the failure mode this model is actually exposed to: the gate is correct,
and one new surface quietly sits outside it. `/api/capture` is the precedent in
this repo — a route shipped outside a list it needed to be on, green through
every suite, wrong from day one. `webapp/tests/unit/entitlement-default-deny.test.ts`
does this over the app's file tree; this file does it over the STORE, which is the
boundary that matters, because the browser holds the anon key and can drive
`/rest/v1/**` without the app being involved at all.

So nothing here is hand-listed except the exemptions, and the exemptions are
asserted EXACT in both directions: a table that stops needing its exemption fails
until the line is deleted, and a new one cannot join the set silently.

WHAT IT ENUMERATES, ALL OF IT OUT OF pg_catalog

  * every table a browser role holds any privilege on  → must carry the
    restrictive entitlement policy AND the guard trigger;
  * every table written by a browser-executable `security definer` function
    (found by scanning `pg_proc.prosrc`, the body Postgres actually stored)
    → must carry the guard trigger, because a definer bypasses RLS;
  * every `security definer` function reachable from a browser → must refuse an
    anonymous caller in its own body, since the guard's engine escape hatch is
    `auth.uid() is null`;
  * every function in `public` → must pin `search_path`.

WHAT PROVES THE CROSS-CHECK IS CAPABLE OF FAILING

`test_the_cross_check_catches_an_unprotected_surface` builds the exact mistake —
a table with browser grants and a `security definer` RPC that writes it, neither
gated — inside the live schema, re-runs the SAME functions the assertions above
call, and asserts they report it. Then drops it. A structural test nobody has
watched fail is a structural test that passes because it looks at nothing.

Run it the way the rest of this directory runs:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_default_deny.py -q
"""
from __future__ import annotations

import os
import re
import uuid

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from tests.db.test_write_path import (  # noqa: E402  (fixtures are shared on purpose)
    make_posting,
    make_user,
    schema,  # noqa: F401 — session fixture
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


# ═══════════════════════════════════════════════════ the exemptions, with reasons

#: Tables a browser can reach that deliberately carry NO entitlement gate.
#: Asserted exact in both directions by `test_the_exemptions_are_exact`.
UNGATED_TABLES: dict[str, str] = {
    "users":
        "identity. A pending account's holding surface has to be able to name the "
        "person it is holding, and every RLS policy in the schema keys off this row",
    "entitlements":
        "the holding surface reads its own status to choose which sentence to show — "
        "and a restrictive policy calling hq_is_entitled() on the table hq_is_entitled() "
        "reads is infinite recursion",
    "allowed_emails":
        "the invite list. No policy grants a browser session any row of it, and the "
        "signup trigger reads it BEFORE an entitlement can exist",
}

#: `security definer` functions reachable from a browser that legitimately do not
#: refuse an anonymous caller.
DEFINERS_WITHOUT_IDENTITY_CHECK: dict[str, str] = {
    "handle_new_auth_user":
        "the signup trigger. It runs inside GoTrue's transaction BEFORE any session "
        "exists, so auth.uid() is null by construction every single time",
}


# ═══════════════════════════════════════════════════════ the catalog enumerations
#
# Every one of these is a plain query against pg_catalog, and every assertion in
# the file goes through one of them. The counterexample test calls the same
# functions, which is what makes it a real proof rather than a second opinion.

def browser_reachable_tables(conn) -> list[str]:
    """Tables `anon` or `authenticated` holds ANY privilege on.

    Privilege rather than policy: on Supabase the platform grants
    INSERT/UPDATE/DELETE on every new table in `public` so that RLS can be the
    decider, so "has a policy" is the wrong question and "is reachable" is the
    right one.
    """
    return [
        r[0]
        for r in conn.execute(
            """
            select c.relname
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'
               and (   has_table_privilege('anon', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('authenticated', c.oid,
                                           'select, insert, update, delete'))
             order by c.relname"""
        ).fetchall()
    ]


def browser_executable_definers(conn) -> list[tuple[str, str]]:
    """`(name, body)` for every `security definer` function a browser can execute.

    These are the ones that matter: a definer bypasses RLS by construction, so a
    restrictive policy says nothing about them and the trigger is the only thing
    between them and the store.
    """
    return [
        (r[0], r[1])
        for r in conn.execute(
            """
            select p.proname, p.prosrc
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.prosecdef
               and (   has_function_privilege('anon', p.oid, 'execute')
                    or has_function_privilege('authenticated', p.oid, 'execute'))
             order by p.proname"""
        ).fetchall()
    ]


#: `insert into public.x`, `update public.x`, `delete from public.x` — over the
#: body Postgres stored, not over a file somebody might not have committed.
_WRITE = re.compile(
    r"\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?\"?([a-z_][a-z0-9_]*)\"?",
    re.IGNORECASE,
)


def tables_written_by_browser_definers(conn) -> dict[str, set[str]]:
    """`table -> {functions that write it}`, for browser-executable definers."""
    known = set(
        r[0]
        for r in conn.execute(
            "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace "
            "where n.nspname = 'public' and c.relkind = 'r'"
        ).fetchall()
    )
    out: dict[str, set[str]] = {}
    for name, body in browser_executable_definers(conn):
        for table in set(_WRITE.findall(body or "")):
            t = table.lower()
            if t in known:
                out.setdefault(t, set()).add(name)
    return out


def gated_tables(conn) -> dict[str, tuple[bool, bool, bool]]:
    """`table -> (rls_enabled, has_restrictive_entitlement_policy, has_ENABLED_guard_trigger)`.

    `tgenabled <> 'D'` IS THE LOAD-BEARING CLAUSE, and it was not here.

    `alter table ... disable trigger` does not delete the `pg_trigger` row. It
    flips `tgenabled` from 'O' to 'D' and leaves everything else — name, function,
    timing, table — exactly as it was. So a bare `exists (select 1 from pg_trigger
    ...)` reports a switched-off guard as attached, and every sweep built on this
    helper reports a schema whose entitlement boundary is off as fully gated.

    Measured, by driving it: with the guard disabled on `applications`, the three
    sweeps below stayed GREEN. The pinned mutant
    `applications-entitlement-trigger-disabled` (tests/mutants/) is that exact
    statement, committed, and it now requires all three to redden.

    'D' is the only value that means off. 'O' is the default; 'R' and 'A' are
    replica-role settings that still fire for the ORIGIN role a browser session
    uses, so treating those as off would fail a correctly configured schema.
    """
    rows = conn.execute(
        """
        select c.relname,
               c.relrowsecurity,
               exists (select 1 from pg_policy pol
                        where pol.polrelid = c.oid
                          and not pol.polpermissive
                          and pg_get_expr(pol.polqual, pol.polrelid) ilike '%hq_is_entitled%'),
               exists (select 1 from pg_trigger tg
                         join pg_proc p on p.oid = tg.tgfoid
                        where tg.tgrelid = c.oid and not tg.tgisinternal
                          and tg.tgenabled <> 'D'
                          and p.proname = 'hq_entitlement_guard')
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'"""
    ).fetchall()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


# ═══════════════════════════════════════════════════════════ the sanity floor
#
# Every case below is `it.each`-shaped over a catalog query. A query that returns
# nothing makes all of them pass while proving nothing, which is the one way a
# test like this dies silently.

def test_the_enumerations_found_a_real_schema(conn):
    tables = browser_reachable_tables(conn)
    definers = browser_executable_definers(conn)
    assert len(tables) >= 20, tables
    assert len(definers) >= 30, [d[0] for d in definers]
    # Named anchors, so a query that silently starts matching the wrong thing —
    # a changed relkind, a renamed schema — fails here rather than passing empty.
    assert "warm_searches" in tables
    assert "app_start_warm_search" in [d[0] for d in definers]
    assert "warm_searches" in tables_written_by_browser_definers(conn)


# ══════════════════════════════════════════════════ the cross-check, on the schema

def test_every_browser_reachable_table_is_gated(conn):
    """The direct `/rest/v1/<table>` surface.

    A browser holds the anon key. It does not have to go through the web app, the
    middleware, or `getDataSource()` to reach a table it has a privilege on — so
    the app-side gate proved in `webapp/tests/unit/entitlement-default-deny.test.ts`
    says nothing at all about this path, and this is the assertion that does.

    KILLED BY: deleting any table from the `gated` array in 0027, or dropping the
    restrictive policy loop.
    """
    state = gated_tables(conn)
    missing: list[str] = []
    for t in browser_reachable_tables(conn):
        if t in UNGATED_TABLES:
            continue
        rls, policy, trigger = state[t]
        if not (rls and policy and trigger):
            missing.append(
                f"{t}: rls={rls} restrictive-entitlement-policy={policy} guard-trigger={trigger}"
            )
    assert not missing, (
        "browser-reachable tables with no entitlement gate — a pending, suspended, "
        "unknown or removed account reaches them over /rest/v1:\n  " + "\n  ".join(missing)
    )


def test_every_table_a_browser_rpc_writes_carries_the_guard_trigger(conn):
    """The `security definer` surface, which the policy above cannot reach.

    A definer bypasses RLS — that is what it is for — so the restrictive policy is
    invisible to `app_start_warm_search` and the trigger is the entire boundary.
    This is the assertion that would have caught the three holes 0027's closing
    section documents, and it is derived from the stored function bodies rather
    than from a list, so the 38th RPC is covered on the day it is written.

    KILLED BY: dropping the trigger loop from 0027 while keeping the policies.
    """
    state = gated_tables(conn)
    missing = {
        t: sorted(fns)
        for t, fns in tables_written_by_browser_definers(conn).items()
        if t not in UNGATED_TABLES and not state[t][2]
    }
    assert not missing, (
        "tables written by a browser-executable SECURITY DEFINER function with no "
        f"hq_entitlement_guard trigger — RLS does not apply inside a definer: {missing}"
    )


def test_every_browser_definer_refuses_an_anonymous_caller_in_its_own_body(conn):
    """The guard's engine escape hatch is `auth.uid() is null`, so a definer that
    would act for a null identity turns that hatch into the hole.

    Nothing today does — every `app_*` function opens with `if v_user is null then
    raise 'not authenticated'` — and this pins the convention rather than trusting
    it, because it is the one property the store-wide guard cannot enforce itself.

    KILLED BY: writing a new definer RPC that does not check identity, or deleting
    the check from an existing one.
    """
    offenders = [
        name
        for name, body in browser_executable_definers(conn)
        if name not in DEFINERS_WITHOUT_IDENTITY_CHECK
        and not re.search(r"auth\.uid\(\)", body or "")
    ]
    assert not offenders, (
        "browser-executable SECURITY DEFINER functions that never read auth.uid(): "
        f"{offenders}. hq_entitlement_guard lets a null identity through as the "
        "engine, so a definer that acts without one acts as the engine."
    )


def test_every_function_in_public_pins_its_search_path(conn):
    """A `security definer` with a mutable search_path is resolvable to a caller's
    own schema, which is the classic Postgres privilege escalation. Asserted over
    ALL of `public` and not only the definers: a plain function called from inside
    a definer inherits the definer's rights.

    KILLED BY: a new function declared without `set search_path`.
    """
    loose = [
        r[0]
        for r in conn.execute(
            """
            select p.proname
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.prokind = 'f'
               and (p.proconfig is null
                    or not exists (select 1 from unnest(p.proconfig) cfg
                                    where cfg like 'search_path=%'))
             order by 1"""
        ).fetchall()
    ]
    assert not loose, f"functions in public with an unpinned search_path: {loose}"


def test_the_exemptions_are_exact(conn):
    """A drifting exemption list is a list that hides the next offender.

    Both directions: a table that stops needing its exemption fails until the line
    is deleted, and a table that lost its gate cannot hide inside the set.
    """
    state = gated_tables(conn)
    actually_ungated = sorted(
        t for t in browser_reachable_tables(conn)
        if not (state[t][1] and state[t][2])
    )
    assert actually_ungated == sorted(UNGATED_TABLES)

    definers = dict(browser_executable_definers(conn))
    actually_unchecked = sorted(
        n for n, body in definers.items() if not re.search(r"auth\.uid\(\)", body or "")
    )
    assert actually_unchecked == sorted(DEFINERS_WITHOUT_IDENTITY_CHECK)


# ══════════════════════════════════════════════ the states, driven for real
#
# The structural sweep above proves the mechanism is ATTACHED everywhere. These
# prove the mechanism REFUSES, once per non-entitled state, with the active
# account as the positive control in every case — "a pending user reads 0 rows"
# is equally true of a user who can read nothing at all, and would stay green with
# the entire gate deleted.

def _signup(conn, email: str) -> str:
    uid = str(uuid.uuid4())
    conn.execute("insert into auth.users (id, email) values (%s, %s)", (uid, email))
    return uid


def _as(conn, uid: str | None) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(uid or ""),))
    conn.execute("set role authenticated")


def _system(conn) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


@pytest.fixture
def states(conn) -> dict[str, str]:
    """One account per non-entitled state, plus the active control.

    `removed` is a user_id whose `public.users` row is gone — the shape a deleted
    account leaves behind in a stale JWT that has not expired yet, which is the
    only way this state is ever reached in production. `unknown` is a well-formed
    uuid that was never an account at all.
    """
    active = make_user(conn, f"active-{uuid.uuid4()}@example.com")
    pending = _signup(conn, f"pending-{uuid.uuid4()}@example.com")
    suspended = make_user(conn, f"susp-{uuid.uuid4()}@example.com")
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (suspended,))
    removed = make_user(conn, f"removed-{uuid.uuid4()}@example.com")
    conn.execute("delete from public.users where id = %s", (removed,))
    return {
        "active": active,
        "pending": pending,
        "suspended": suspended,
        "removed": removed,
        "unknown": str(uuid.uuid4()),
    }


NON_ENTITLED = ("pending", "suspended", "removed", "unknown")


@pytest.mark.parametrize("state", NON_ENTITLED)
def test_a_non_entitled_session_reads_no_row_of_any_gated_table(conn, states, state):
    """Every gated table, every non-entitled state, one sweep.

    The active session is the positive control and it is not decorative: it is
    given a real row in `user_postings`, `applications` and `saved_views` first, so
    "0 rows" is a refusal rather than an empty database.

    KILLED BY: dropping the restrictive policy loop from 0027 — `applications`,
    `saved_views`, `user_postings` and `events` all go from 0 to 1 for a suspended
    account, which is a person the owner turned OFF still reading their store.
    """
    active = states["active"]
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", "DenyCorp")
    _system(conn)
    conn.execute(
        "insert into public.user_postings (user_id, posting_key, disposition) "
        "values (%s, %s, 'qualified') on conflict do nothing", (active, key))
    conn.execute(
        "insert into public.saved_views (user_id, name, surface, state) "
        "values (%s, 'v', 'queue', '{}'::jsonb)", (active,))
    conn.execute(
        "insert into public.events (user_id, kind, payload, actor) "
        "values (%s, 'test.control', '{}'::jsonb, 'system')", (active,))

    tables = [t for t in browser_reachable_tables(conn) if t not in UNGATED_TABLES]

    _as(conn, active)
    seen = {t: conn.execute(f"select count(*) from public.{t}").fetchone()[0] for t in tables}
    assert seen["user_postings"] >= 1 and seen["saved_views"] >= 1 and seen["events"] >= 1, (
        f"positive control: an ACTIVE session must actually reach its own rows, got {seen}")

    _as(conn, states[state])
    leaked = {
        t: n
        for t in tables
        if (n := conn.execute(f"select count(*) from public.{t}").fetchone()[0])
    }
    _system(conn)
    assert not leaked, f"a {state} session read rows from {leaked}"


@pytest.mark.parametrize("state", NON_ENTITLED)
def test_a_non_entitled_session_cannot_write_through_the_definer_rpcs(conn, states, state):
    """The path the restrictive policies do not cover, driven for real.

    These three are not a sample: they are the three that COMPLETED for a pending
    session before this migration's closing section existed (measured, psycopg,
    this harness). `app_start_warm_search` is the expensive one — it reserves a
    harvestapi search, so an account the owner has never turned on was able to
    spend his vendor credits over `/rest/v1/rpc`.

    KILLED BY: dropping the guard-trigger loop from 0027. The restrictive policies
    stay, every other test in this file stays green, and these three succeed again.
    """
    _as(conn, states["active"])
    idem = str(uuid.uuid4())
    conn.execute(
        "select public.app_save_view(null, 'control', 'queue', '{}'::jsonb, false, %s, null)",
        (idem,))  # positive control: the RPC works for an entitled account

    _as(conn, states[state])
    for call, args in (
        ("select public.app_save_view(null,'v','queue','{}'::jsonb,false,%s,null)",
         (str(uuid.uuid4()),)),
        ("select public.app_propose_companies(array['DenyCo'],'paste',%s)",
         (str(uuid.uuid4()),)),
        ("select public.app_start_warm_search('company',null,'DenyCo','{}'::jsonb,"
         "'{}'::jsonb,20,%s)", (str(uuid.uuid4()),)),
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(call, args)
        assert "not entitled" in exc.value.diag.message_primary or "not authenticated" in exc.value.diag.message_primary, (
            f"{state}: {call.split('(')[0]} was not refused — {exc.value}")
    _system(conn)


def test_an_entitled_session_cannot_write_a_row_it_does_not_own(conn, states):
    """Wrong-owner, at the DEFINER layer.

    Today this is closed 37 separate times, once per RPC, by each one's own
    `where user_id = v_user` — 37 correct decisions, none of them enforced by
    anything. The guard makes it a property of the store: an ACTIVE session (so the
    entitlement half cannot be what refuses) writing somebody else's row is refused
    by the same trigger, with the ownership message rather than the entitlement one.

    KILLED BY: deleting the `to_jsonb(v_rec) ? 'user_id'` half of the guard.
    """
    a, b = states["active"], make_user(conn, f"other-{uuid.uuid4()}@example.com")
    _as(conn, a)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "insert into public.saved_views (user_id, name, surface, state) "
            "values (%s, 'stolen', 'queue', '{}'::jsonb)", (b,))
    assert "may not write" in exc.value.diag.message_primary
    _system(conn)
    assert conn.execute(
        "select count(*) from public.saved_views where user_id = %s and name = 'stolen'",
        (b,)).fetchone()[0] == 0


def test_the_engine_still_writes_everything(conn, states):
    """The other direction, and the one a too-strict gate breaks silently at 03:00.

    `auth.uid() is null` is the guard's escape hatch for the engine (service key,
    no JWT subject) and the operator. It has to hold for a row owned by a PENDING
    account too: the engine mirrors postings for every user regardless of whether
    the owner has turned them on, and a gate that stopped that would quietly empty
    a person's queue before they were ever activated.

    KILLED BY: rewriting the guard as "deny unless entitled" — every engine write
    in the system fails on the next deploy.
    """
    _system(conn)
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", "EngineCorp")
    conn.execute(
        "insert into public.user_postings (user_id, posting_key, disposition) "
        "values (%s, %s, 'qualified')", (states["pending"], key))
    assert conn.execute(
        "select count(*) from public.user_postings where user_id = %s", (states["pending"],)
    ).fetchone()[0] == 1


# ═══════════════════════════════════════════════ `anon` holds no read privilege

#: Every relation kind PostgREST can serve a GET from. `p` (partitioned) is here
#: because a partitioned parent is what a browser would actually query.
_READABLE_RELKINDS = ("r", "v", "m", "p")

#: Relations `authenticated` cannot read EITHER, with the reason. Asserted exact
#: in both directions by the differential in
#: `test_anon_holds_select_on_nothing_in_public`, like `UNGATED_TABLES` above: a
#: table that stops needing its entry fails until the line is deleted, and a new
#: one cannot join the set silently. That second direction is the important one —
#: it is what stops somebody quieting a failed differential by adding a name here.
AUTHENTICATED_CANNOT_READ: dict[str, str] = {
    "capture_tokens":
        "credential material. 0018 revokes ALL from `public, anon, authenticated` "
        "and gives the table no policy of any kind: a token digest is a bearer "
        "secret and the browser has no question that needs it. Only the service "
        "role reads it, through `security definer` minting and verification.",
    "notification_outbox":
        "private user content. 20260803_105951 revokes select as well as write from "
        "`public, anon, authenticated`: `title` and `body` are rendered notification "
        "text naming companies and roles, and no design state exists for a "
        "held-notifications surface. The owner-read policy is written but has no "
        "grant behind it, so a later `grant select` arrives already gated.",
    "email_sends":
        "server lane only. 20260813_055534 (#203) revokes select as well as write "
        "from `public, anon, authenticated`: the transactional-mail ledger carries "
        "addresses and send outcomes, and no design state exists for a mail-history "
        "surface. The owner-read policy is written but has no grant behind it, the "
        "notification_outbox shape verbatim.",
    "email_suppressions":
        "server lane only. 20260813_055534 (#203), same posture: the bounce/"
        "complaint list is consulted inside hq_email_claim_send by the service "
        "role, and a browser session has no question that needs it.",
    "rate_bounds":
        "the operator's bound catalog (#261, 20260817_011844). `revoke all` from "
        "`public, anon, authenticated`, and the grant system is the PRIMARY "
        "control — `allowed_emails`' answer. The entitlement pair is armed anyway "
        "(the notification_outbox shape, and what test_owner_bypass.py requires of "
        "every unforced table), with one honest caveat recorded in the migration: "
        "the rows have no `user_id`, so the guard's ownership half passes "
        "vacuously and only its entitlement half does work. That is additive on "
        "top of an RLS-denies-everything table, not a substitute for the revoke. "
        "tests/db/test_rate_bounds.py asserts the zero-privilege property "
        "directly, in both directions.",
    "usage_counters":
        "the durable per-user meter (#261, 20260817_011844). `revoke all` from "
        "`public, anon, authenticated`: nothing in the approved design shows a "
        "user their usage — the usage surface is ADD-006 and unbuilt (#210) — and "
        "a table a browser cannot reach is one fewer surface to gate. The "
        "self-read policy AND the entitlement pair are both written with no grant "
        "behind them, the notification_outbox shape verbatim, so a later "
        "`grant select` arrives already gated. Unlike rate_bounds the guard "
        "trigger also does real work TODAY: the charge runs inside a security "
        "definer where RLS does not apply, so a suspended account is refused at "
        "the counter before the command it was driving reaches its own write.",
}


def relations_in_public(conn) -> list[str]:
    """Every relation in `public`, with NO privilege filter.

    The population the privilege walk below runs over. Kept as its own query with
    the identical FROM/WHERE so the two cannot drift: if this returns the schema
    and that returns nothing, the difference is the privilege, which is the only
    thing the test is entitled to conclude.
    """
    return [
        r[0]
        for r in conn.execute(
            """
            select c.relname
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = any(%s)
             order by c.relname""",
            (list(_READABLE_RELKINDS),),
        ).fetchall()
    ]


def relations_role_can_read(conn, role: str) -> list[str]:
    """Every relation in `public` that `role` holds SELECT on, out of pg_catalog.

    Derived, not listed, for the same reason as everything else in this file: a
    hand-maintained list of ~27 tables is a list somebody forgets to append to,
    and the table it does not mention is exactly the one that ships wrong.

    Parametrised by role so the SAME query can be pointed at `authenticated`,
    which still holds the grant. An assertion that `anon` reads nothing is worth
    very little on its own — it is equally true of a query that is broken, scoped
    to the wrong schema, or run against a database where nothing exists. Pointing
    the identical query at a role that DOES hold the privilege is what turns
    "empty" into a measurement.

    COLUMN privileges, not table privileges, and this is the whole correctness of
    the helper. `has_table_privilege(role, oid, 'select')` is true only when the
    role may select EVERY column, so a `grant select (email) on public.users to
    anon` reports FALSE there — while anon can read that column over
    `/rest/v1/users?select=email` perfectly well. Measured, on this schema:

        grant select (secret) on t to anon
        has_table_privilege ('select')          -> False   <- what a table check asks
        has_column_privilege('secret','select') -> True
        anon actually SELECTs the column        -> yes

    That is the same shape #149 fixed in `gated_tables`, where a bare
    `exists (select 1 from pg_trigger …)` could not tell an attached guard from a
    disabled one: the catalog answered yes and the mechanism answered no. Here it
    is the other way round and leaks rather than over-reports, which is worse.
    `has_column_privilege` subsumes the table-level check — a table-wide grant
    makes every column readable — so this one condition is strictly stronger and
    there is nothing left for a separate `has_table_privilege` call to add.
    """
    return [
        r[0]
        for r in conn.execute(
            """
            select c.relname
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = any(%s)
               and exists (
                     select 1
                       from pg_attribute a
                      where a.attrelid = c.oid
                        and a.attnum > 0
                        and not a.attisdropped
                        and has_column_privilege(%s, c.oid, a.attnum, 'select'))
             order by c.relname""",
            (list(_READABLE_RELKINDS), role),
        ).fetchall()
    ]


def relations_anon_can_read(conn) -> list[str]:
    """The `anon` case, which is the one the guard is about."""
    return relations_role_can_read(conn, "anon")


def test_anon_holds_select_on_nothing_in_public(conn):
    """`anon` — the signed-out role — can read no relation in `public`.

    Supabase's bootstrap grants `anon` full table privileges on every relation in
    `public` so that RLS is the decider rather than the privilege system. That is
    a reasonable platform default and a poor final answer: it means one policy
    authored `using (true)`, or one policy dropped mid-debug and not restored, is
    immediately a world-readable table over `/rest/v1/**`. The browser holds the
    anon key and never has to involve the web app.

    Nothing legitimately depends on it. Every read the product performs runs as
    `authenticated` (server-side, with the user's session cookie) or as
    `service_role`; the only browser-side Supabase call in the app is an OAuth
    redirect. So the grant is pure surface, and this asserts it is gone —
    schema-wide and derived, so a table added next month is covered without
    anyone remembering this file exists.

    WHY THIS IS NOT `assert readable == []` AND NOTHING ELSE. An empty set is the
    weakest evidence in the repo: it is equally produced by a working revoke, by a
    query scoped to the wrong schema, by a typo in the relkind filter, and by a
    database where `public` is empty because the migrations never ran. Every one
    of those reads as a pass. So the absence is bracketed by three positives, and
    each one fails on a different way of being wrong:

      1. POPULATION — the walk sees the schema at all, and sees all of it.
      2. DIFFERENTIAL — the identical query, pointed at `authenticated`, returns
         essentially the whole schema. This is the one that matters: it proves
         the mechanism `anon` lost is a mechanism that still demonstrably exists,
         so "anon: nothing" is a measured difference between two roles rather
         than a fact about a query that finds nothing for anybody.
      3. DETECTOR — a control relation with the grant deliberately restored is
         FOUND, and stops being found when it is revoked. That is the direct
         proof that this query can report a violation, built the way
         `test_the_cross_check_catches_an_unprotected_surface` builds its own.
    """
    population = relations_in_public(conn)
    readable = relations_anon_can_read(conn)
    by_authenticated = relations_role_can_read(conn, "authenticated")

    # 1. POPULATION. Bound low but not at zero: the exact table count changes with
    #    every migration and pinning it would make this test a chore, but "the
    #    schema has at least twenty relations" fails loudly on an empty or
    #    wrong-schema walk, which is the failure mode being excluded.
    assert len(population) >= 20, (
        f"the walk found only {len(population)} relation(s) in public "
        f"({', '.join(population) or 'none at all'}). The emptiness assertion below "
        "would pass trivially on this database, so it is not evidence about the "
        "revoke — it is evidence the schema is not there."
    )

    # 2. DIFFERENTIAL. `authenticated` is the role every real read runs as and it
    #    keeps the bootstrap grant, so the same query must find the whole schema
    #    for it apart from the named carve-outs. If BOTH roles came back empty,
    #    the query is broken and the assertion in (4) would be meaningless.
    #    A carve-out naming a relation that no longer exists subtracts nothing and
    #    would sit here forever, so the set is pinned to the live schema first.
    stale = set(AUTHENTICATED_CANNOT_READ) - set(population)
    assert not stale, (
        f"AUTHENTICATED_CANNOT_READ names {', '.join(sorted(stale))}, which is not a "
        "relation in public. Delete the entry — a carve-out for something that does "
        "not exist silently weakens the differential below."
    )
    expected_authenticated = set(population) - set(AUTHENTICATED_CANNOT_READ)
    assert set(by_authenticated) == expected_authenticated, (
        "the identical privilege query returns "
        f"{len(by_authenticated)} of an expected {len(expected_authenticated)} relations "
        "for `authenticated`, which is the role EVERY product read runs as. Either a "
        "revoke hit the wrong role — which breaks the app — or this query does not "
        "measure what it claims, in which case the anon result below means nothing.\n"
        f"  unexpectedly unreadable: "
        f"{', '.join(sorted(expected_authenticated - set(by_authenticated))) or 'none'}\n"
        f"  readable but listed in AUTHENTICATED_CANNOT_READ (delete the entry): "
        f"{', '.join(sorted(set(by_authenticated) & set(AUTHENTICATED_CANNOT_READ))) or 'none'}"
    )

    # 3. DETECTOR. Restore the grant on a control relation through the real path
    #    and require this query to say so. An assertion that never reports a
    #    violation is an assertion nobody has watched work.
    conn.execute(
        "create table public.hq_anon_grant_detector (id bigserial primary key, secret text)")
    try:
        conn.execute("revoke select on public.hq_anon_grant_detector from anon")

        conn.execute("grant select on public.hq_anon_grant_detector to anon")
        assert "hq_anon_grant_detector" in relations_anon_can_read(conn), (
            "the query did NOT report a table that anon demonstrably holds SELECT "
            "on, so it cannot report a real violation either and the emptiness "
            "assertion below is vacuous."
        )
        conn.execute("revoke select on public.hq_anon_grant_detector from anon")
        assert "hq_anon_grant_detector" not in relations_anon_can_read(conn), (
            "the query still reports a table whose grant was revoked, so it is "
            "reading something other than the live privilege."
        )

        # The COLUMN case, which a table-level check cannot see and which leaks a
        # real column over /rest/v1. This is the detector that would have been
        # missing if this helper had asked `has_table_privilege`.
        conn.execute("grant select (secret) on public.hq_anon_grant_detector to anon")
        assert "hq_anon_grant_detector" in relations_anon_can_read(conn), (
            "a COLUMN-level grant to anon was not reported. `has_table_privilege` "
            "is false whenever one column is unreadable, so a table check reads "
            "clean while anon selects that column over /rest/v1 — the leaking "
            "direction of the same catalog-vs-mechanism gap #149 closed in "
            "gated_tables. This helper must ask has_column_privilege."
        )
    finally:
        conn.execute("drop table if exists public.hq_anon_grant_detector")

    # 4. And now the property itself, which the three above have earned.
    assert readable == [], (
        "anon (the signed-out role) holds SELECT on: "
        + ", ".join(readable)
        + ". Supabase's bootstrap grants this by default; 20260802_205716_anon_select_revoke"
        " takes it back for existing relations AND alters the default privileges so new"
        " ones never carry it. A relation here means one of those two halves missed it."
    )


def test_a_new_table_cannot_arrive_carrying_the_anon_grant(conn):
    """The half that matters in six weeks: table 28.

    Revoking on the ~27 relations that exist today is the easy half and the one
    that decays — the next `create table` re-acquires the grant from the
    bootstrap's default privileges and nothing says a word. So this creates a
    table the way a migration does (same role, no explicit grants) and asserts
    the default no longer includes SELECT for `anon`.

    The `authenticated` assertion is the positive control, and it is not
    decoration: without it this test would pass just as happily in a harness
    where the bootstrap default privileges were never applied at all, i.e. where
    it is measuring nothing.
    """
    conn.execute("create table public.hq_new_table_grant_probe (id bigserial primary key)")
    try:
        anon_reads, authed_reads = conn.execute(
            """select has_table_privilege('anon', 'public.hq_new_table_grant_probe', 'select'),
                      has_table_privilege('authenticated',
                                          'public.hq_new_table_grant_probe', 'select')"""
        ).fetchone()
        assert authed_reads, (
            "positive control failed: `authenticated` did NOT inherit SELECT on a brand-new "
            "table, so the bootstrap default privileges are not in force here and the anon "
            "assertion below is vacuous. Fix db/test-harness.sql before trusting this file."
        )
        assert not anon_reads, (
            "a NEW table arrived carrying SELECT for `anon`. The schema-wide revoke covered "
            "the relations that existed when it ran; the `alter default privileges ... revoke "
            "select on tables from anon` half is what covers this one, and it did not."
        )
    finally:
        conn.execute("drop table if exists public.hq_new_table_grant_probe")


# ═══════════════════════════════════ the counterexample: can this file fail at all

def test_the_cross_check_catches_an_unprotected_surface(conn):
    """The mutation, built for real and then removed.

    A structural test nobody has watched fail is a structural test that passes
    because it looks at nothing. So the exact mistake this file exists to catch is
    committed inside the live schema — a table with browser grants and a
    `security definer` RPC that writes it, neither gated, which is precisely the
    shape `app_start_warm_search` had before 0027's closing section — and the SAME
    functions the assertions above call are re-run against it.

    Every one of the four must report it. Then it is dropped, in a `finally`, so a
    failure here cannot leave the session schema poisoned for the tests after it.
    """
    _system(conn)
    conn.execute("""
        create table public.hq_counterexample (
          id bigserial primary key,
          user_id uuid not null references public.users (id),
          body text not null default '')""")
    conn.execute("alter table public.hq_counterexample enable row level security")
    conn.execute("""
        create policy hq_counterexample_self on public.hq_counterexample
          for all using (user_id = auth.uid()) with check (user_id = auth.uid())""")
    conn.execute("grant select, insert on public.hq_counterexample to authenticated")
    conn.execute("""
        create function public.app_counterexample_write(p_body text)
        returns bigint language plpgsql security definer set search_path = public, pg_temp
        as $fn$
        declare v_id bigint;
        begin
          insert into public.hq_counterexample (user_id, body)
          values (auth.uid(), p_body) returning id into v_id;
          return v_id;
        end;
        $fn$""")
    conn.execute("grant execute on function public.app_counterexample_write(text) to authenticated")
    try:
        # 1. the catalog sees it at all
        assert "hq_counterexample" in browser_reachable_tables(conn)
        assert "app_counterexample_write" in dict(browser_executable_definers(conn))
        assert "app_counterexample_write" in tables_written_by_browser_definers(conn)[
            "hq_counterexample"]

        # 2. every assertion that should catch it, does
        with pytest.raises(AssertionError, match="hq_counterexample"):
            test_every_browser_reachable_table_is_gated(conn)
        with pytest.raises(AssertionError, match="hq_counterexample"):
            test_every_table_a_browser_rpc_writes_carries_the_guard_trigger(conn)
        with pytest.raises(AssertionError):
            test_the_exemptions_are_exact(conn)

        # 3. and the hole is real, not merely unreported: a PENDING account drives
        #    the ungated RPC to completion, which is the production consequence.
        pending = _signup(conn, f"counter-{uuid.uuid4()}@example.com")
        _as(conn, pending)
        assert conn.execute(
            "select public.app_counterexample_write('proof')").fetchone()[0] is not None
        _system(conn)

        # 4. attaching the guard is the whole fix — same functions, now silent.
        conn.execute(
            "create trigger hq_counterexample_entitlement_guard "
            "before insert or update or delete on public.hq_counterexample "
            "for each row execute function public.hq_entitlement_guard()")
        conn.execute(
            "create policy hq_counterexample_entitled on public.hq_counterexample "
            "as restrictive for all using (public.hq_is_entitled()) "
            "with check (public.hq_is_entitled())")
        test_every_browser_reachable_table_is_gated(conn)
        test_every_table_a_browser_rpc_writes_carries_the_guard_trigger(conn)
        test_the_exemptions_are_exact(conn)

        _as(conn, pending)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("select public.app_counterexample_write('refused')")
        _system(conn)
    finally:
        _system(conn)
        conn.execute("drop function if exists public.app_counterexample_write(text)")
        conn.execute("drop table if exists public.hq_counterexample cascade")


# ═════════════════════════════════════════════════════════════ founding users
#
# "Founding users are free forever and exempt from commercial quotas, not from
# security, abuse, concurrency, provider, or reliability limits." That is one
# sentence with two halves that pull in opposite directions, and the only way it
# is actually encoded rather than merely intended is if something fails when either half
# is violated.

def test_a_founding_user_is_free_forever(conn):
    """The commercial half. `invited` is the flag pack H reads to exempt an account
    from a plan it never agreed to, and `plan` is the seam it will read.

    KILLED BY: `handle_new_auth_user` setting `invited := false` for an allowlisted
    address, which would make the owner's founding users indistinguishable from
    open signups the day billing lands — and silently chargeable.
    """
    email = f"founding-{uuid.uuid4()}@example.com"
    conn.execute(
        "insert into public.allowed_emails (email) values (%s) on conflict do nothing",
        (email.lower(),))
    uid = _signup(conn, email)
    row = conn.execute(
        "select status, invited, invite_ref, plan from public.entitlements where user_id = %s",
        (uid,)).fetchone()
    assert row == ("active", True, "allowlist", "free")

    # And an open signup is NOT founding, or the flag distinguishes nothing.
    open_uid = _signup(conn, f"open-{uuid.uuid4()}@example.com")
    assert conn.execute(
        "select invited from public.entitlements where user_id = %s", (open_uid,)
    ).fetchone()[0] is False


def test_a_founding_user_is_not_exempt_from_the_abuse_and_spend_limits(conn):
    """The security half, which is the one that gets forgotten.

    The warm referral daily cap (0020) is the only real spend control in the
    system: it charges at INSERT, under an advisory lock, before a cent reaches
    harvestapi. A founding account is `invited = true` and free forever, and it is
    capped exactly like everybody else — the cap is an ABUSE limit, not a
    commercial quota, and the distinction is the whole sentence.

    Asserted two ways, because the cap has two failure modes:
      * the per-user count is enforced for a founding account (SQLSTATE HQCAP);
      * the cap the CLIENT sends is clamped server-side, so "founding" cannot be
        turned into "uncapped" by the browser passing a bigger number.

    KILLED BY: adding `and not e.invited` to the cap check in `app_start_warm_search`,
    or removing the `least(greatest(...), 1000)` clamp on p_daily_cap.
    """
    email = f"founding-{uuid.uuid4()}@example.com"
    conn.execute(
        "insert into public.allowed_emails (email) values (%s) on conflict do nothing",
        (email.lower(),))
    uid = _signup(conn, email)
    assert conn.execute(
        "select invited from public.entitlements where user_id = %s", (uid,)
    ).fetchone()[0] is True, "precondition: this account IS a founding user"

    _as(conn, uid)
    conn.execute(
        "select public.app_start_warm_search('company',null,'CapCo','{}'::jsonb,'{}'::jsonb,1,%s)",
        (str(uuid.uuid4()),))
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "select public.app_start_warm_search('company',null,'CapCo2','{}'::jsonb,"
            "'{}'::jsonb,1,%s)", (str(uuid.uuid4()),))
    assert exc.value.sqlstate == "HQCAP", exc.value

    # The clamp: a client asking for a million gets 1000, founding or not.
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "select public.app_start_warm_search('company',null,'CapCo3','{}'::jsonb,"
            "'{}'::jsonb,1,%s)", (str(uuid.uuid4()),))
    assert exc.value.sqlstate == "HQCAP"
    _system(conn)


def test_a_suspended_founding_user_is_refused_like_anybody_else(conn):
    """Free forever is not the same as unstoppable. The security limits apply to a
    founding account, and suspension is the bluntest one.

    KILLED BY: any `or e.invited` shortcut in `hq_is_entitled()`.
    """
    email = f"founding-{uuid.uuid4()}@example.com"
    conn.execute(
        "insert into public.allowed_emails (email) values (%s) on conflict do nothing",
        (email.lower(),))
    uid = _signup(conn, email)
    _as(conn, uid)
    assert conn.execute("select public.hq_is_entitled()").fetchone()[0] is True

    _system(conn)
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (uid,))
    assert conn.execute(
        "select invited from public.entitlements where user_id = %s", (uid,)
    ).fetchone()[0] is True, "still a founding user — only the status changed"

    _as(conn, uid)
    assert conn.execute("select public.hq_is_entitled()").fetchone()[0] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "select public.app_save_view(null,'v','queue','{}'::jsonb,false,%s,null)",
            (str(uuid.uuid4()),))
    _system(conn)


# ═══════════════════════════════════ the hatch is a positive assertion, not a default

def test_an_anonymous_session_gets_no_engine_hatch(conn, states):
    """`anon` is not the engine, even though neither has an `auth.uid()`.

    Review broke the first version of the guard here: it returned early on
    `auth.uid() is null` alone, so a security-definer RPC that reads the uid
    without refusing a null one let a caller with NO SESSION write a row into
    somebody else's table. "Nobody is signed in" is the default state of an
    unauthenticated request, not evidence that the engine is calling.

    KILLED BY: restoring the bare `if v_uid is null then return v_rec; end if;`
    — this test writes the row and the assertion below fails.

    Written through a SECURITY DEFINER function on purpose. Direct DML from
    `anon` is refused by the privilege system, so a test that inserted straight
    into the table would pass with the guard removed entirely — vacuous, and
    the exact shape of test this suite exists to prevent. The definer runs as
    its owner, which is what strips the privilege layer away and leaves the
    guard as the only thing standing. It is the review's real exploit: a
    definer that READS auth.uid() without refusing a null one.
    """
    _system(conn)
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", "AnonCorp")
    victim = states["active"]
    conn.execute(
        """
        create or replace function public.hq_test_careless_definer(p_user uuid, p_key text)
        returns void language plpgsql security definer
        set search_path = public, pg_temp as $fn$
        declare v_uid uuid := auth.uid();  -- read, and then not acted on
        begin
          insert into public.user_postings (user_id, posting_key, disposition)
          values (p_user, p_key, 'qualified');
        end $fn$;
        """
    )
    conn.execute("grant execute on function public.hq_test_careless_definer(uuid, text) to anon")
    try:
        conn.execute("select set_config('hq.test_user', '', false)")
        conn.execute("set role anon")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "select public.hq_test_careless_definer(%s, %s)", (victim, key))
        _system(conn)
        assert conn.execute(
            "select count(*) from public.user_postings where posting_key = %s", (key,)
        ).fetchone()[0] == 0, "an anonymous session wrote a row through the engine hatch"
    finally:
        _system(conn)
        conn.execute("drop function if exists public.hq_test_careless_definer(uuid, text)")


def test_suspension_revokes_the_capture_tokens_too(conn, states):
    """Suspension must reach the lanes that carry no browser identity.

    `/api/capture` and `/d/<token>` write with the service role, which the guard
    waves through by design — so an un-revoked token kept writing on a suspended
    user's behalf. Turning the account off turns its capabilities off with it.

    KILLED BY: removing the `hq_revoke_capture_tokens` call from
    `hq_suspend_user` — the token below is still live after suspension.
    """
    _system(conn)
    user = states["active"]
    conn.execute(
        "insert into public.capture_tokens (user_id, label, selector, secret_sha256) "
        "values (%s, 'main', %s, %s)", (user, "0" * 16, "d" * 64))
    live = "select count(*) from public.capture_tokens where user_id = %s and revoked_at is null"
    assert conn.execute(live, (user,)).fetchone()[0] == 1, "setup failed: no live token"

    conn.execute("select public.hq_suspend_user(%s, 'test')", (user,))
    assert conn.execute(live, (user,)).fetchone()[0] == 0, (
        "a suspended account kept a live capture token — the service-role lanes "
        "can still write on its behalf"
    )


# ═══════════════════════ the #223 decision: middleware fails open, the store does not
#
# Issue #223 (decided 2026-08-12, inside #196) keeps the middleware route gate
# failing OPEN on an entitlement row it cannot read, on one condition among
# others: a real-Postgres proof that the store denies that session anyway. These
# two tests are that proof, one per way the row can fail to answer. The webapp's
# half of the same condition — `getDataSource()` throwing on the same signals —
# is `webapp/tests/unit/entitlement-boundary.test.ts`.


def test_an_absent_entitlement_row_is_denied_at_the_store_even_when_middleware_waves_it_through(conn):
    """The #223 condition, driven: the row is GONE and the deny still holds.

    The state is precisely the one middleware cannot be trusted with: a session
    whose `public.users` row exists but whose `entitlements` row does not — a
    signup whose entitlement insert half-failed, or an account provisioned by a
    path that skipped the trigger. It differs from the sweep's `unknown` state
    (a uuid that was never an account) in that everything EXCEPT the entitlement
    row says this person is real. Middleware may wave the request through
    (`unreadable` fails open by decision, and even a clean read answers only
    with a redirect); the store answers with the boundary: `hq_is_entitled()` is
    false on absence, so the restrictive policies return zero rows and the guard
    trigger refuses the write. Absence is never permission.

    The account is proven ENTITLED first — reads its own row, writes through the
    RPC — so the denial afterwards is caused by the deletion and nothing else.

    KILLED BY: `tests/mutants/sql/entitlement-absence-becomes-permission.sql` —
    re-declaring `hq_is_entitled()` to answer true for any signed-in session
    whose row is merely missing (`coalesce(…, auth.uid() is not null)`). Pinned
    in `tests/mutants/manifest.toml`.
    """
    uid = make_user(conn, f"absent-{uuid.uuid4()}@example.com")

    _as(conn, uid)
    conn.execute(
        "select public.app_save_view(null, 'mine', 'queue', '{}'::jsonb, false, %s, null)",
        (str(uuid.uuid4()),))
    assert conn.execute("select count(*) from public.saved_views").fetchone()[0] >= 1, (
        "positive control: an entitled account must read the row it just wrote")
    assert conn.execute("select public.hq_is_entitled()").fetchone()[0] is True

    _system(conn)
    conn.execute("delete from public.entitlements where user_id = %s", (uid,))

    _as(conn, uid)
    assert conn.execute("select public.hq_is_entitled()").fetchone()[0] is False, (
        "an absent entitlement row must read as NOT entitled")
    assert conn.execute("select count(*) from public.saved_views").fetchone()[0] == 0, (
        "the session's own rows must vanish from its reads the moment the row is gone")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "select public.app_save_view(null, 'again', 'queue', '{}'::jsonb, false, %s, null)",
            (str(uuid.uuid4()),))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "insert into public.saved_views (user_id, name, surface, state) "
            "values (%s, 'direct', 'queue', '{}'::jsonb)", (uid,))
    _system(conn)


def test_an_unreadable_entitlement_row_denies_by_error_rather_than_leaking(conn):
    """The other way the row can fail to answer: the read itself is refused.

    The app-side `unreadable` is a query that errored. Its nearest store-side
    reproduction is a session whose role cannot read `entitlements` at all —
    here, SELECT revoked from `authenticated` — while the request proceeds as if
    middleware had waved it through. What must NOT happen is the leaking
    direction: policies quietly evaluating to "entitled" (or to rows) while the
    predicate's own read is broken. What does happen, and what this pins, is
    deny-by-error: `hq_is_entitled()` runs with the CALLER's rights (0027
    declares it deliberately not `security definer`), so the predicate raises,
    every query behind a policy that calls it raises with it, and zero rows are
    delivered anywhere.

    Scope, stated: the engine lane and the inside of definer RPCs read with
    OWNER rights and still see the store's truth — this breakage reaches exactly
    the browser-role surface, which is the surface the middleware decision is
    about. The grant is restored in `finally` and the positive control re-runs
    afterwards, so the denial is provably CAUSED by the revoke and the schema
    leaves this test the way it arrived.

    KILLED BY: `tests/mutants/sql/entitlement-predicate-security-definer.sql` —
    re-declaring the predicate `security definer`, which answers from the
    owner's wider rights and turns the raise into a leak. Pinned in
    `tests/mutants/manifest.toml`.
    """
    uid = make_user(conn, f"unread-{uuid.uuid4()}@example.com")
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", "UnreadableCorp")
    _system(conn)
    conn.execute(
        "insert into public.user_postings (user_id, posting_key, disposition) "
        "values (%s, %s, 'qualified') on conflict do nothing", (uid, key))

    _as(conn, uid)
    assert conn.execute("select count(*) from public.user_postings").fetchone()[0] >= 1, (
        "positive control: the account is entitled and reads its row before the revoke")

    _system(conn)
    conn.execute("revoke select on public.entitlements from authenticated")
    try:
        _as(conn, uid)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("select public.hq_is_entitled()")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("select count(*) from public.user_postings")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "insert into public.user_postings (user_id, posting_key, disposition) "
                "values (%s, %s, 'qualified')", (uid, key))
    finally:
        conn.execute("reset role")
        conn.execute("grant select on public.entitlements to authenticated")

    _as(conn, uid)
    assert conn.execute("select count(*) from public.user_postings").fetchone()[0] >= 1, (
        "the mechanism must come back when the read does — the denial above was the "
        "revoke's doing, not a broken harness")
    _system(conn)
