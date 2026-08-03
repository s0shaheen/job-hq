"""The owner lane: what happens when a statement runs AS the role that owns the table.

`enable row level security` does not bind the table's owner, and this schema has
no `force row level security` anywhere. So every policy in `test_rls.py` and every
restrictive policy 0027 added is INERT for any statement that runs as the owner —
which is every `security definer` function in `public`, because they are all owned
by the role that applied the migrations. That is the real hole, and it is the one
task #39 proposed to close with `alter table … force row level security`.

FORCING IS NOT THE FIX HERE, AND THE REASON IS MEASURED RATHER THAN ARGUED. Both
halves are asserted below rather than left in a document:

  * `FORCE` does not bind a role holding `BYPASSRLS`, and on Supabase the owning
    role — `postgres`, the one `db/apply.sh` connects as — holds exactly that
    (`rolsuper = false`, `rolbypassrls = true`, measured on `supabase/postgres`
    15.8). Locally the owner is a superuser, which bypasses for its own reason.
    So the `ALTER` would be a no-op in both places.
    → `test_force_does_not_bind_an_owner_that_bypasses_rls`

  * If it ever DID bind — the day that role attribute changed — it would deny
    every write in the product. There is no permissive `insert`/`update`/`delete`
    policy on any table in this schema: writes go through definers running as the
    owner, and an empty permissive set for a command means deny.
    → `test_forcing_a_write_path_shaped_like_this_schema_breaks_it`

What actually binds the owner lane is `hq_entitlement_guard`, because a TRIGGER
fires for the owner, for a superuser and for a `BYPASSRLS` role alike. The
boundary proof drives an owner-role statement at another tenant's row through a
`security definer` function — the path an attacker would use — and shows the
trigger is the thing that refuses, with the guard removed as the mutation that
proves the assertion is not vacuous.

Lives beside `test_default_deny.py` on purpose: that file asks whether the guard
is ATTACHED everywhere, this one asks what would happen if it were not.

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_owner_bypass.py -q
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

from tests.db.test_default_deny import (  # noqa: E402
    UNGATED_TABLES,
    browser_executable_definers,
)
from tests.db.test_write_path import (  # noqa: E402  (fixtures are shared on purpose)
    make_user,
    schema,  # noqa: F401 — session fixture
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def _system(conn) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


def _as(conn, uid: str) -> None:
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(uid),))
    conn.execute("set role authenticated")


# ═══════════════════════════════════════════════════════ the catalog enumerations


def product_tables(conn) -> dict[str, tuple[str, bool, bool, bool]]:
    """`table -> (owner, rls_enabled, forced, has_ENABLED_guard_trigger)` for `public`.

    `tgenabled <> 'D'` is load-bearing, not defensive tidiness. A trigger that is
    switched off still has its `pg_trigger` row, so an existence check cannot tell
    an enforcing guard from a disabled one — and on this schema the guard is the
    ENTIRE owner-lane control, since nothing is forced. Two ordinary operations
    switch it off across every table at once:

      * `alter table … disable trigger …`, which this very file issues to prove
        its mutation, and which leaks on a hard crash between the disable and the
        `finally`;
      * `pg_restore --disable-triggers`, which the backup/restore rehearsal runs
        as a superuser and which leaves them off if the restore dies midway.

    Measured on Postgres 16: with the guard disabled on `applications`, every
    structural sweep in this file AND in `test_default_deny.py` stayed green while
    one signed-in account wrote another account's row through a definer.

    `'D'` is the only disabled state; `'O'`, `'R'` and `'A'` all fire for an origin
    session, so they are all treated as enforcing.
    """
    return {
        r[0]: (r[1], r[2], r[3], r[4])
        for r in conn.execute(
            """
            select c.relname,
                   c.relowner::regrole::text,
                   c.relrowsecurity,
                   c.relforcerowsecurity,
                   exists (select 1 from pg_trigger tg
                             join pg_proc p on p.oid = tg.tgfoid
                            where tg.tgrelid = c.oid and not tg.tgisinternal
                              and tg.tgenabled <> 'D'
                              and p.proname = 'hq_entitlement_guard')
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'
             order by 1"""
        ).fetchall()
    }


def tables_with_a_write_policy(conn) -> set[str]:
    """Tables carrying a PERMISSIVE policy for insert, update or delete.

    `polcmd` is `a` insert, `w` update, `d` delete, `*` all. A forced table with
    no permissive policy for a command denies that command outright — an empty
    permissive set is a deny, not an absence of opinion.
    """
    return {
        r[0]
        for r in conn.execute(
            """
            select distinct c.relname
              from pg_policy p join pg_class c on c.oid = p.polrelid
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and p.polpermissive
               and p.polcmd in ('a', 'w', 'd', '*')"""
        ).fetchall()
    }


def owning_roles(conn) -> set[str]:
    """Every role owning a table or a function in `public`."""
    rows = conn.execute(
        """
        select distinct c.relowner::regrole::text
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
        union
        select distinct p.proowner::regrole::text
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f'"""
    ).fetchall()
    return {r[0] for r in rows}


# ══════════════════════════════════════════════ the population the sweeps walk
#
# Every sweep below reports an OFFENDER LIST and passes when it is empty. That is
# green when the invariant holds and equally green when the query is wrong, scoped
# to a schema that does not exist, or returning nothing at all — "no table
# violates this" and "no table was examined" are the same assertion otherwise.
# This is not hypothetical on this file: review measured a disabled guard staying
# invisible to every structural sweep here while a cross-tenant write landed.
#
# So each sweep first states, positively, what it looked at. The count is checked
# against `information_schema` — a genuinely separate view over the catalog rather
# than the same `pg_class` walk rephrased — so a narrowed `product_tables` query
# reddens on the population rather than passing on an empty offender list.

#: The floor is a real number, not a placeholder: 31 tables in `public` at the time
#: DEC-013 was measured. It only ever moves UP as migrations land, and a run that
#: sees fewer is looking at a partial schema.
EXPECTED_MIN_PRODUCT_TABLES = 31

#: 31 minus the three `UNGATED_TABLES`. Guarding is what makes not forcing safe, so
#: "every unforced table is covered" needs to be false of a schema where nothing is
#: covered — which it is, trivially, if the guarded population is zero.
EXPECTED_MIN_GUARDED_TABLES = 28

#: Named anchors. A query that silently starts matching the wrong relkind or the
#: wrong schema returns a plausible-looking set with none of these in it.
POPULATION_ANCHORS = ("saved_views", "applications", "user_postings", "users")


def catalog_table_count(conn) -> int:
    """`public` base tables, counted through `information_schema`.

    Deliberately NOT `pg_class`: the point is to check the sweeps' own walk against
    a source that does not share its bugs. A `pg_class` count rephrased would agree
    with a broken `pg_class` query for exactly the reasons that made it broken.
    """
    return conn.execute(
        "select count(*) from information_schema.tables"
        " where table_schema = 'public' and table_type = 'BASE TABLE'"
    ).fetchone()[0]


def assert_the_sweep_saw_the_schema(conn, examined: dict) -> None:
    """The positive claim every offender-list sweep makes before reporting nothing.

    Three separate ways a walk can be blind, because they fail differently: it can
    return nothing at all, it can return a subset, and it can return the wrong
    KIND of thing while counting correctly.
    """
    from_information_schema = catalog_table_count(conn)
    assert len(examined) == from_information_schema, (
        f"the sweep examined {len(examined)} tables but information_schema counts "
        f"{from_information_schema} base tables in public — the walk is not looking "
        "at the whole schema, so an empty offender list means nothing. Missing: "
        f"{sorted(set(_information_schema_tables(conn)) - set(examined))}"
    )
    assert len(examined) >= EXPECTED_MIN_PRODUCT_TABLES, (
        f"the sweep examined {len(examined)} tables; this schema had "
        f"{EXPECTED_MIN_PRODUCT_TABLES} when DEC-013 was measured and migrations "
        "only add. A smaller number is a partial schema, not a smaller product"
    )
    missing_anchors = [t for t in POPULATION_ANCHORS if t not in examined]
    assert not missing_anchors, (
        f"the sweep counted enough tables but did not see {missing_anchors} — it is "
        "walking something other than the product tables"
    )


def _information_schema_tables(conn) -> list[str]:
    return [
        r[0]
        for r in conn.execute(
            "select table_name from information_schema.tables"
            " where table_schema = 'public' and table_type = 'BASE TABLE'"
        ).fetchall()
    ]


# ═══════════════════════════════════════════════════════════════ the sanity floor


def test_the_enumeration_found_a_real_schema(conn):
    tables = product_tables(conn)
    assert len(tables) >= 25, sorted(tables)
    assert "saved_views" in tables and "user_postings" in tables
    assert all(rls for _, rls, _, _ in tables.values()), (
        "a public table with RLS switched off entirely: "
        f"{[t for t, v in tables.items() if not v[1]]}"
    )


# ═════════════════════════════════════════════════ the structure, from pg_catalog


def test_one_role_owns_every_product_table_and_every_definer(conn):
    """Mixed ownership is what would make this file's reasoning quietly wrong.

    Every conclusion here rests on "a definer runs as the owner of the table it
    writes". A function owned by role A writing a table owned by role B is a
    statement where RLS DOES apply — so a policy set nobody has tested against
    would start deciding, and a definer that works today would begin returning
    empty. One owner, asserted, keeps the model and the schema in step.

    KILLED BY: `alter table public.saved_views owner to <anyone else>`.
    """
    assert len(owning_roles(conn)) == 1, (
        "public is owned by more than one role, so 'a definer runs as the table "
        f"owner' is no longer true of every pair: {sorted(owning_roles(conn))}"
    )


def test_no_table_is_forced_without_a_permissive_write_policy(conn):
    """The landmine guard, and the reason this branch shipped no migration.

    Forcing a table whose only permissive policy is a `select` denies every
    insert, update and delete that reaches it as the owner — which in this schema
    is all of them, since every write goes through a `security definer` RPC. On
    Supabase the damage is deferred rather than avoided: the owning role holds
    `BYPASSRLS`, so a forced table behaves normally until the day it does not.

    A future migration that adds `force row level security` therefore has to add
    the write policies in the same file, or fail here.

    KILLED BY: `alter table public.saved_views force row level security`, and by
    narrowing the walk — the population is asserted before the offender list is,
    so "nothing is forced" cannot be satisfied by looking at nothing.
    """
    examined = product_tables(conn)
    assert_the_sweep_saw_the_schema(conn, examined)

    writable = tables_with_a_write_policy(conn)
    forced_and_unwritable = sorted(
        t for t, (_, _, forced, _) in examined.items()
        if forced and t not in writable
    )
    assert not forced_and_unwritable, (
        "tables forced with no permissive insert/update/delete policy — every "
        "write through a security-definer RPC is denied the moment the owning "
        f"role stops holding BYPASSRLS: {forced_and_unwritable}"
    )


def test_every_unforced_table_is_covered_by_the_guard_trigger(conn):
    """The compensating control, asserted exactly where forcing would have gone.

    Not forced means the owner lane is unpoliced by RLS. `hq_entitlement_guard`
    is what polices it instead, and unlike a policy it fires for the owner, for a
    superuser and for a `BYPASSRLS` role. Exemptions come from
    `test_default_deny.py` so there is one list, not two that drift apart.

    KILLED BY: dropping the guard trigger from any gated table, disabling one
    (`tgenabled = 'D'`), or narrowing the walk — "every unforced table is covered"
    is trivially true of zero unforced tables, so the covered population is
    asserted as a number before the offender list is asserted empty.
    """
    examined = product_tables(conn)
    assert_the_sweep_saw_the_schema(conn, examined)

    covered = sorted(
        t
        for t, (_, rls, forced, guard) in examined.items()
        if rls and not forced and guard and t not in UNGATED_TABLES
    )
    assert len(covered) >= EXPECTED_MIN_GUARDED_TABLES, (
        f"the sweep verified only {len(covered)} guarded tables, below the "
        f"{EXPECTED_MIN_GUARDED_TABLES} this schema had when DEC-013 was measured. "
        "An empty offender list below is worthless if the guarded population "
        f"collapsed: {covered}"
    )

    naked = sorted(
        t
        for t, (_, rls, forced, guard) in examined.items()
        if rls and not forced and not guard and t not in UNGATED_TABLES
    )
    assert not naked, (
        "tables where RLS is the only control and RLS does not bind the owner — "
        f"any security-definer statement reaches every tenant's rows: {naked}"
    )


# ═══════════════════════ the three tables where RLS is the ONLY control, and why
#
# `users`, `entitlements` and `allowed_emails` carry no guard trigger — the
# exemptions `test_default_deny.py` records and explains. For them the owner lane
# is genuinely unpoliced: any statement running as the owner sees and writes every
# account's row. So "nothing reaches them" cannot be an argument about how careful
# the RPCs are; it has to be a property something checks.
#
# It is a narrow one. `handle_new_auth_user` is the ONLY security-definer function
# a browser role can execute that touches any of the three, it takes no arguments,
# and Postgres refuses to call a trigger function directly at all. Both halves are
# asserted, so a new RPC that starts touching these tables fails here on the day it
# is written rather than on the day somebody audits it.

#: `table -> {browser-executable security-definer functions that name it}`.
#: Asserted EXACT in both directions: a function that stops touching one of these
#: fails until the line is deleted, and a new one cannot join silently.
UNGATED_TABLE_DEFINERS: dict[str, set[str]] = {
    "users": {"handle_new_auth_user"},
    "entitlements": {"handle_new_auth_user"},
    "allowed_emails": {"handle_new_auth_user"},
}

#: `insert into x`, `update x`, `delete from x`, `from x`, `join x` — reads too,
#: not only writes. RLS is what stops one account READING another's row here, and
#: RLS is exactly what the owner lane switches off.
_TOUCH_TEMPLATE = (
    r"\b(?:insert\s+into|update|delete\s+from|from|join)\s+(?:public\.)?\"?{}\"?\b"
)


def definers_touching(conn, table: str) -> set[str]:
    import re

    pattern = re.compile(_TOUCH_TEMPLATE.format(re.escape(table)), re.IGNORECASE)
    return {
        name
        for name, body in browser_executable_definers(conn)
        if pattern.search(body or "")
    }


@pytest.mark.parametrize("table", sorted(UNGATED_TABLE_DEFINERS))
def test_only_the_signup_trigger_reaches_an_ungated_table_from_a_browser_role(
    conn, table
):
    """The reviewer's question, answered from the catalog rather than by reading.

    `hq_is_entitled()` reads `entitlements` and is deliberately NOT counted: it is
    `security invoker`, so it runs as the CALLER and `entitlements_self_read`
    applies to it. Only `prosecdef` functions take the owner's rights with them,
    and that is what this enumerates.

    KILLED BY: writing any browser-executable definer that selects from or writes
    `public.users`, `public.entitlements` or `public.allowed_emails`.
    """
    assert table in UNGATED_TABLES, (
        f"{table} is no longer exempt from the guard, so this file's premise about "
        "it is stale — either it now has the trigger, or the exemption moved"
    )
    assert definers_touching(conn, table) == UNGATED_TABLE_DEFINERS[table]


def test_the_signup_trigger_takes_no_argument_a_caller_could_aim(conn):
    """Reachability, not just inventory.

    `handle_new_auth_user` writes `users` and `entitlements` with RLS inert and no
    guard trigger, which is the most privileged statement in the schema. What makes
    it safe is that a caller cannot aim it: it takes zero arguments and reads its
    identity from the `auth.users` NEW row that GoTrue supplies. A future version
    that accepted a `p_user_id` would be a cross-tenant write primitive, and this
    is what would notice.

    KILLED BY: adding any parameter to `handle_new_auth_user`, or declaring an
    OVERLOAD that takes one — which is why every signature of that name is
    enumerated rather than the first row fetched.
    """
    assert set(
        conn.execute(
            "select p.pronargs, t.typname"
            "  from pg_proc p join pg_type t on t.oid = p.prorettype"
            "  join pg_namespace n on n.oid = p.pronamespace"
            " where n.nspname = 'public' and p.proname = 'handle_new_auth_user'"
        ).fetchall()
    ) == {(0, "trigger")}


def test_a_browser_role_cannot_call_the_signup_trigger_directly(conn):
    """And the grant is not what stops it.

    `handle_new_auth_user` is executable by `anon` and `authenticated` — Supabase's
    default grants reach it like everything else in `public`. The refusal comes from
    Postgres itself: a function returning `trigger` cannot be invoked by a plain
    `select`, so the most privileged definer in the schema has no browser call site
    at all. Asserted rather than assumed, because "it is only granted to the
    platform" would have been the wrong reason and would have aged badly.
    """
    _system(conn)
    conn.execute("set role authenticated")
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("select public.handle_new_auth_user()")
    _system(conn)
    assert "trigger" in exc.value.diag.message_primary.lower(), (
        exc.value.diag.message_primary
    )


# ══════════════════════════════════ measurement 1: FORCE is not the control here


def test_force_does_not_bind_an_owner_that_bypasses_rls(conn):
    """Supabase's owning role, reproduced, with the strictest policy possible.

    `postgres` on a real project is `rolsuper = false`, `rolbypassrls = true`. A
    role with those attributes is built here, given a table it owns, RLS enabled
    AND forced, and a policy that denies everything to everyone — and it still
    reads every row. `BYPASSRLS` outranks `FORCE`; the migration task #39 asked
    for would have changed nothing in production.

    KILLED BY: nothing in this repo — it is a property of Postgres, asserted so
    that a future reader does not have to take the claim on trust. If a Postgres
    release changed it, this test would be the thing that noticed.
    """
    _system(conn)
    conn.execute("drop table if exists public.hq_bypass_probe cascade")
    conn.execute("drop role if exists hq_bypass_owner")
    conn.execute("drop role if exists hq_plain_reader")
    conn.execute("create role hq_bypass_owner nologin bypassrls")
    conn.execute("create role hq_plain_reader nologin")
    conn.execute("grant usage on schema public to hq_bypass_owner, hq_plain_reader")
    try:
        conn.execute("create table public.hq_bypass_probe (id int, note text)")
        conn.execute("insert into public.hq_bypass_probe values (1, 'a'), (2, 'b')")
        conn.execute("alter table public.hq_bypass_probe owner to hq_bypass_owner")
        conn.execute("alter table public.hq_bypass_probe enable row level security")
        conn.execute("alter table public.hq_bypass_probe force row level security")
        conn.execute(
            "create policy deny_everything on public.hq_bypass_probe "
            "for all using (false) with check (false)"
        )

        conn.execute("set role hq_bypass_owner")
        seen = conn.execute("select count(*) from public.hq_bypass_probe").fetchone()[0]
        _system(conn)
        assert seen == 2, (
            "BYPASSRLS no longer outranks FORCE — DEC-013 rests on it doing so, "
            "and forcing RLS may now be the real hardening it was proposed as"
        )

        # The control: a role WITHOUT the attribute is bound by the same table,
        # so the assertion above is about BYPASSRLS and not about a broken policy.
        conn.execute("grant select on public.hq_bypass_probe to hq_plain_reader")
        conn.execute("set role hq_plain_reader")
        assert conn.execute(
            "select count(*) from public.hq_bypass_probe"
        ).fetchone()[0] == 0
        _system(conn)
    finally:
        _system(conn)
        conn.execute("drop table if exists public.hq_bypass_probe cascade")
        conn.execute("drop owned by hq_bypass_owner")
        conn.execute("drop role if exists hq_bypass_owner")
        conn.execute("drop owned by hq_plain_reader")
        conn.execute("drop role if exists hq_plain_reader")


# ═══════════════════════ measurement 2: and if it did bind, it would break writes


def test_forcing_a_write_path_shaped_like_this_schema_breaks_it(conn):
    """The other half of DEC-013, built to the schema's actual shape.

    A table with the policy set every product table has — one permissive `select`
    for the owner of the row, one restrictive entitlement policy, and NO
    permissive write policy — plus a `security definer` RPC that writes it, both
    owned by a role WITHOUT `BYPASSRLS`. Unforced, an entitled session's write
    completes. Forced, the identical call raises. That is the production write
    path the day Supabase stops granting the owning role `BYPASSRLS`, measured
    rather than predicted, and it is why this branch shipped no migration.

    KILLED BY: adding a permissive `for all` policy to the probe table — the
    write then survives forcing, and the reason for DEC-013 is gone with it.
    """
    _system(conn)
    user = make_user(conn, f"forceprobe-{uuid.uuid4()}@example.com")
    conn.execute("drop table if exists public.hq_force_probe cascade")
    conn.execute("drop role if exists hq_plain_owner")
    conn.execute("create role hq_plain_owner nologin")
    try:
        conn.execute(
            "create table public.hq_force_probe ("
            "  id bigserial primary key,"
            "  user_id uuid not null references public.users (id),"
            "  body text not null default '')"
        )
        conn.execute("alter table public.hq_force_probe enable row level security")
        conn.execute(
            "create policy hq_force_probe_self on public.hq_force_probe "
            "for select using (user_id = auth.uid())"
        )
        conn.execute(
            "create policy hq_force_probe_entitled on public.hq_force_probe "
            "as restrictive for all using (public.hq_is_entitled()) "
            "with check (public.hq_is_entitled())"
        )
        conn.execute("grant select, insert on public.hq_force_probe to authenticated")
        conn.execute(
            "create function public.hq_force_probe_write(p_body text) returns bigint "
            "language plpgsql security definer set search_path = public, pg_temp as $fn$ "
            "declare v_id bigint; begin "
            "  if auth.uid() is null then raise exception 'not authenticated'; end if; "
            "  insert into public.hq_force_probe (user_id, body) "
            "  values (auth.uid(), p_body) returning id into v_id; return v_id; end $fn$"
        )
        conn.execute(
            "grant execute on function public.hq_force_probe_write(text) to authenticated"
        )
        # The definer must run as a NON-bypassrls owner, or the experiment measures
        # the superuser hatch instead of FORCE.
        conn.execute("grant usage on schema public, auth to hq_plain_owner")
        conn.execute("grant select on public.users, public.entitlements to hq_plain_owner")
        conn.execute(
            "grant execute on function public.hq_is_entitled() to hq_plain_owner"
        )
        conn.execute("alter table public.hq_force_probe owner to hq_plain_owner")
        conn.execute(
            "alter function public.hq_force_probe_write(text) owner to hq_plain_owner"
        )

        _as(conn, user)
        assert conn.execute(
            "select public.hq_force_probe_write('before-force')"
        ).fetchone()[0] is not None, (
            "positive control: the write path must work before forcing, or the "
            "failure after it proves nothing"
        )

        _system(conn)
        conn.execute("alter table public.hq_force_probe force row level security")

        _as(conn, user)
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute("select public.hq_force_probe_write('after-force')")
        _system(conn)
        assert "violates row-level security policy" in exc.value.diag.message_primary, (
            f"expected the forced table to deny the definer's insert, got "
            f"{exc.value.diag.message_primary!r}"
        )
        assert conn.execute(
            "select count(*) from public.hq_force_probe"
        ).fetchone()[0] == 1, "only the pre-force row survives"
    finally:
        _system(conn)
        conn.execute("drop function if exists public.hq_force_probe_write(text)")
        conn.execute("drop table if exists public.hq_force_probe cascade")
        conn.execute("drop owned by hq_plain_owner")
        conn.execute("drop role if exists hq_plain_owner")


# ═════════════════════════════════════ the boundary proof, through a real definer


def test_an_owner_role_statement_cannot_reach_another_tenants_row(conn):
    """The exploit the owner lane makes possible, and the thing that refuses it.

    Driven through a `security definer` function, which is the path an attacker
    reaches — direct DML from `authenticated` is refused by the privilege system
    and by the policies, so a test written that way would pass with every control
    in this file removed. Inside the definer, `current_user` is the table's owner:
    RLS is inert, both policies on `saved_views` are invisible, and the ONLY thing
    standing between an entitled session and another tenant's row is
    `hq_entitlement_guard`.

    The mutation is in the test: with the trigger disabled, the same call writes
    the victim's row. So the refusal is attributable to the guard, and not to a
    policy, a grant, or a `where` clause somewhere else.
    """
    _system(conn)
    attacker = make_user(conn, f"attacker-{uuid.uuid4()}@example.com")
    victim = make_user(conn, f"victim-{uuid.uuid4()}@example.com")
    conn.execute(
        "create or replace function public.hq_owner_lane_probe(p_user uuid, p_name text) "
        "returns void language plpgsql security definer "
        "set search_path = public, pg_temp as $fn$ begin "
        "  insert into public.saved_views (user_id, name, surface, state) "
        "  values (p_user, p_name, 'queue', '{}'::jsonb); end $fn$"
    )
    conn.execute(
        "grant execute on function public.hq_owner_lane_probe(uuid, text) to authenticated"
    )
    stolen = f"stolen-{uuid.uuid4().hex[:8]}"
    try:
        # Positive control: the same RPC, the attacker's OWN row, completes. So a
        # refusal below is about ownership rather than about a broken function.
        _as(conn, attacker)
        conn.execute(
            "select public.hq_owner_lane_probe(%s, 'own-row')", (attacker,))

        # RLS really is inert here — asserted, not assumed. The definer's owner is
        # the table's owner, so `saved_views_self_read` never applies to it.
        _system(conn)
        assert conn.execute(
            "select relrowsecurity and not relforcerowsecurity from pg_class "
            "where oid = 'public.saved_views'::regclass"
        ).fetchone()[0] is True, "saved_views is no longer in the unforced state DEC-013 describes"

        _as(conn, attacker)
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
            conn.execute("select public.hq_owner_lane_probe(%s, %s)", (victim, stolen))
        # diag.message_primary, never str(exc): psycopg's CONTEXT block echoes the
        # RPC's own SQL, so `"saved_views" in str(exc)` is satisfied by the query
        # text and proves nothing about what refused.
        msg = exc.value.diag.message_primary
        assert "may not write" in msg and "saved_views" in msg, msg
        assert str(victim) in msg, msg

        _system(conn)
        assert conn.execute(
            "select count(*) from public.saved_views where name = %s", (stolen,)
        ).fetchone()[0] == 0, "the victim's row was written after all"

        # THE MUTATION. Remove the guard and the identical call succeeds, which is
        # what makes the assertion above evidence rather than decoration.
        conn.execute(
            "alter table public.saved_views disable trigger saved_views_entitlement_guard")
        try:
            _as(conn, attacker)
            conn.execute("select public.hq_owner_lane_probe(%s, %s)", (victim, stolen))
            _system(conn)
            assert conn.execute(
                "select count(*) from public.saved_views where user_id = %s and name = %s",
                (victim, stolen),
            ).fetchone()[0] == 1, (
                "with the guard disabled the write STILL did not land, so the "
                "refusal above was not the guard's doing"
            )
        finally:
            _system(conn)
            conn.execute(
                "alter table public.saved_views enable trigger saved_views_entitlement_guard")
            conn.execute("delete from public.saved_views where name = %s", (stolen,))
    finally:
        _system(conn)
        conn.execute("drop function if exists public.hq_owner_lane_probe(uuid, text)")


#: `real -> blinded`, each the shape of a query that went wrong rather than a
#: schema that did. Applied to the REAL result so the injected walk is otherwise
#: identical to the one the sweeps trust.
BLIND_WALKS = {
    # scoped to a schema that does not exist, or a relkind nothing matches
    "empty": (lambda real: {}, "examined 0 tables"),
    # silently narrowed — the shape a stray `and c.relname like …` leaves
    "subset": (
        lambda real: {t: v for t, v in real.items() if t.startswith("a")},
        "the walk is not looking at the whole schema",
    ),
    # the right NUMBER of relations, none of them the product tables. A count-only
    # check waves this one through, which is why the anchors exist.
    "wrong-relations": (
        lambda real: {
            f"not_a_product_table_{i}": v for i, v in enumerate(real.values())
        },
        "did not see",
    ),
}


@pytest.mark.parametrize("blindness", sorted(BLIND_WALKS))
def test_a_sweep_that_examined_nothing_is_not_a_sweep_that_found_nothing(
    conn, monkeypatch, blindness
):
    """The counterexample the assertion lint asked for, and it was right to.

    Both sweeps report an offender list and pass when it is empty, which is the
    same green whether the invariant holds or the query went blind. Review had
    already measured the consequence on this exact file — a disabled guard stayed
    invisible to every structural sweep while a cross-tenant write landed — so
    "the query could go wrong" is not a hypothetical here, it is the observed
    failure mode.

    Each blindness below is injected into `product_tables` and BOTH sweeps must
    redden with a message naming what they failed to look at, rather than passing
    on an empty offender list. The third case is the nastiest: the right NUMBER of
    relations with none of the real ones in it, which a count-only check waves
    through.

    KILLED BY: deleting the `assert_the_sweep_saw_the_schema` call from either
    sweep — the empty and wrong-relations cases then pass silently.
    """
    import tests.db.test_owner_bypass as module

    blind, expected = BLIND_WALKS[blindness]
    real = product_tables(conn)          # captured BEFORE the patch, or the fake
    blinded = blind(real)                # would recurse into itself
    monkeypatch.setattr(module, "product_tables", lambda _conn: blinded)

    # The sweeps pass on the real walk, so the redness below is the blindness and
    # not a schema that was broken to begin with.
    for sweep in (
        test_no_table_is_forced_without_a_permissive_write_policy,
        test_every_unforced_table_is_covered_by_the_guard_trigger,
    ):
        with pytest.raises(AssertionError, match=expected):
            sweep(conn)


def test_the_ungated_sweep_catches_a_new_definer_that_reaches_users(conn):
    """The counterexample for the three-table sweep, and the reviewer's scenario.

    A new browser-callable RPC that reads `public.users` by a caller-supplied id is
    built in the live schema. It is the exact shape that would turn the exemption
    into an account enumeration: RLS is inert inside it, `users_self_read` never
    applies, and it returns any account's email to anybody signed in. Both the
    sweep reporting it AND the leak itself are asserted — a catalog complaint with
    no demonstrated consequence is how a rule stops being believed.
    """
    _system(conn)
    victim = make_user(conn, f"enum-victim-{uuid.uuid4()}@example.com")
    attacker = make_user(conn, f"enum-attacker-{uuid.uuid4()}@example.com")
    conn.execute(
        "create or replace function public.hq_leak_probe(p_id uuid) returns text "
        "language plpgsql security definer set search_path = public, pg_temp as $fn$ "
        "declare v text; begin "
        "  select email into v from public.users where id = p_id; return v; end $fn$"
    )
    conn.execute("grant execute on function public.hq_leak_probe(uuid) to authenticated")
    try:
        assert "hq_leak_probe" in definers_touching(conn, "users")
        with pytest.raises(AssertionError):
            test_only_the_signup_trigger_reaches_an_ungated_table_from_a_browser_role(
                conn, "users")

        # The consequence, driven: one signed-in account reads another's email.
        _as(conn, attacker)
        leaked = conn.execute(
            "select public.hq_leak_probe(%s)", (victim,)).fetchone()[0]
        _system(conn)
        assert leaked is not None and "enum-victim" in leaked, (
            "the probe did not leak, so the sweep above is guarding nothing")

        # And the same call under the CALLER's rights — security invoker, where
        # users_self_read applies — returns nothing. That contrast is the whole
        # point: the definer's owner rights are what removed the policy.
        conn.execute("alter function public.hq_leak_probe(uuid) security invoker")
        conn.execute("grant select on public.users to authenticated")
        _as(conn, attacker)
        assert conn.execute(
            "select public.hq_leak_probe(%s)", (victim,)).fetchone()[0] is None
        _system(conn)
    finally:
        _system(conn)
        conn.execute("drop function if exists public.hq_leak_probe(uuid)")


def test_the_cross_check_catches_a_table_that_relies_on_rls_alone(conn):
    """The counterexample for the structural sweep above.

    A table with RLS, policies, no `force` and no guard — the exact shape whose
    tenant isolation evaporates inside any definer — is built in the live schema,
    and the same function the assertion calls is re-run against it. Then dropped.
    """
    _system(conn)
    conn.execute(
        "create table public.hq_naked_probe ("
        "  id bigserial primary key,"
        "  user_id uuid not null references public.users (id))"
    )
    conn.execute("alter table public.hq_naked_probe enable row level security")
    conn.execute(
        "create policy hq_naked_probe_self on public.hq_naked_probe "
        "for select using (user_id = auth.uid())"
    )
    try:
        assert product_tables(conn)["hq_naked_probe"][3] is False
        with pytest.raises(AssertionError, match="hq_naked_probe"):
            test_every_unforced_table_is_covered_by_the_guard_trigger(conn)

        # Attaching the guard is the whole fix — the same assertion goes quiet.
        conn.execute(
            "create trigger hq_naked_probe_entitlement_guard "
            "before insert or update or delete on public.hq_naked_probe "
            "for each row execute function public.hq_entitlement_guard()"
        )
        test_every_unforced_table_is_covered_by_the_guard_trigger(conn)

        # And the landmine guard sees a force that would deny every write.
        conn.execute("alter table public.hq_naked_probe force row level security")
        with pytest.raises(AssertionError, match="hq_naked_probe"):
            test_no_table_is_forced_without_a_permissive_write_policy(conn)
    finally:
        _system(conn)
        conn.execute("drop table if exists public.hq_naked_probe cascade")


def test_a_disabled_guard_trigger_counts_as_no_guard_at_all(conn):
    """A guard that is switched off must not read as a guard that is attached.

    Found in review. `alter table … disable trigger` leaves the `pg_trigger` row
    in place and only flips `tgenabled` to `'D'`, so an `exists (…)` sweep reports
    a control that cannot fire. Nothing in this schema is forced, so that trigger
    is the WHOLE owner-lane control, and two ordinary operations switch it off:
    `pg_restore --disable-triggers` during a restore rehearsal, and the
    `disable trigger` this very file issues to prove its own mutation, which leaks
    if the process dies before the `finally`.

    The table is built and guarded first, so the only thing that changes between
    green and red is `tgenabled` — not the trigger's existence, not a policy, not
    a grant. The behavioural half is asserted too: while the guard is disabled a
    signed-in account really does write another account's row through a definer,
    which is what makes the catalog complaint worth making.

    KILLED BY: dropping `and tg.tgenabled <> 'D'` from `product_tables`.
    """
    _system(conn)
    attacker = make_user(conn, f"disabled-att-{uuid.uuid4()}@example.com")
    victim = make_user(conn, f"disabled-vic-{uuid.uuid4()}@example.com")
    conn.execute(
        "create table public.hq_disabled_probe ("
        "  id bigserial primary key,"
        "  user_id uuid not null references public.users (id))"
    )
    conn.execute("alter table public.hq_disabled_probe enable row level security")
    conn.execute(
        "create trigger hq_disabled_probe_entitlement_guard "
        "before insert or update or delete on public.hq_disabled_probe "
        "for each row execute function public.hq_entitlement_guard()"
    )
    conn.execute(
        "create or replace function public.hq_disabled_probe_write(p_user uuid) "
        "returns void language plpgsql security definer "
        "set search_path = public, pg_temp as $fn$ begin "
        "  insert into public.hq_disabled_probe (user_id) values (p_user); end $fn$"
    )
    conn.execute(
        "grant execute on function public.hq_disabled_probe_write(uuid) to authenticated"
    )
    try:
        # Enabled: reported as guarded, and the cross-tenant write is refused.
        assert product_tables(conn)["hq_disabled_probe"][3] is True
        test_every_unforced_table_is_covered_by_the_guard_trigger(conn)
        _as(conn, attacker)
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
            conn.execute("select public.hq_disabled_probe_write(%s)", (victim,))
        _system(conn)
        assert "hq_disabled_probe" in exc.value.diag.message_primary, (
            exc.value.diag.message_primary
        )

        # Disabled: the row still exists, so only `tgenabled` differs.
        conn.execute(
            "alter table public.hq_disabled_probe "
            "disable trigger hq_disabled_probe_entitlement_guard"
        )
        assert conn.execute(
            "select tgenabled from pg_trigger "
            "where tgname = 'hq_disabled_probe_entitlement_guard'"
        ).fetchone()[0] == "D"
        assert conn.execute(
            "select count(*) from pg_trigger "
            "where tgname = 'hq_disabled_probe_entitlement_guard'"
        ).fetchone()[0] == 1, "the trigger row must still be there, or this proves nothing"

        assert product_tables(conn)["hq_disabled_probe"][3] is False, (
            "a disabled guard is being reported as an attached one — the owner "
            "lane is unpoliced and every structural sweep in this file is green"
        )
        with pytest.raises(AssertionError, match="hq_disabled_probe"):
            test_every_unforced_table_is_covered_by_the_guard_trigger(conn)

        # The consequence, driven: the refusal above is gone.
        _as(conn, attacker)
        conn.execute("select public.hq_disabled_probe_write(%s)", (victim,))
        _system(conn)
        assert conn.execute(
            "select count(*) from public.hq_disabled_probe where user_id = %s",
            (victim,),
        ).fetchone()[0] == 1, (
            "the write did not land with the guard disabled, so the sweep above "
            "is guarding nothing"
        )
    finally:
        _system(conn)
        conn.execute("drop function if exists public.hq_disabled_probe_write(uuid)")
        conn.execute("drop table if exists public.hq_disabled_probe cascade")
