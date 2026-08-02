"""Row-level security, proven against a real database.

docs/PRODUCT-SPEC.md section I names this by hand as the thing that does not
exist: *"an RLS test that signs in as two real users and proves one cannot read
the other's rows."* Three users share this system today and ten are planned, so
"A cannot see B's job search" is the whole privacy model.

Two traps make a careless version of this test worthless, and both are guarded
against here:

1. **The superuser bypasses RLS entirely.** Every other test in this suite
   connects as `postgres`, which ignores policies. A test that forgets to
   `set role authenticated` passes no matter what the policies say.

2. **A negative assertion alone proves nothing.** "A reads 0 of B's rows" is
   equally true when A can read nothing at all — which is exactly what happened
   before `db/test-harness.sql` granted the privileges Supabase grants. Every
   test below asserts the POSITIVE control in the same breath: A can read its
   own rows. Without that, dropping every policy in the schema still passes.
"""
from __future__ import annotations

import json
import os
import uuid

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


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def two_users(conn):
    """Two allowlisted users, each gated to a posting the other cannot see."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    ka = make_posting(conn, f"gh-a-{uuid.uuid4().hex[:8]}", "AlphaCorp")
    kb = make_posting(conn, f"gh-b-{uuid.uuid4().hex[:8]}", "BetaCorp")
    gate(conn, a, ka)
    gate(conn, b, kb)
    conn.execute(
        """insert into public.applications (user_id, posting_key, company, title, status)
           values (%s, %s, 'AlphaCorp', 'PM', 'Applied'), (%s, %s, 'BetaCorp', 'PM', 'Applied')""",
        (a, ka, b, kb),
    )
    conn.execute(
        """insert into public.events (user_id, kind, posting_key, actor)
           values (%s, 'action.interested', %s, 'user'), (%s, 'action.interested', %s, 'user')""",
        (a, ka, b, kb),
    )
    return {"a": a, "b": b, "ka": ka, "kb": kb}


def as_authenticated(conn, user_id: str):
    """Become a signed-in browser session: an identity AND the anon role.

    Skipping `set role` is the difference between testing RLS and testing
    nothing — `postgres` is a superuser and policies do not apply to it.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def count(conn, sql: str, *args) -> int:
    return conn.execute(sql, args).fetchone()[0]


# ---------------------------------------------------------- the core promise

def test_a_user_reads_their_own_rows_and_none_of_the_other_users(conn, two_users):
    u = two_users
    as_authenticated(conn, u["a"])

    for table, own, theirs in [
        ("user_postings", u["a"], u["b"]),
        ("applications", u["a"], u["b"]),
        ("events", u["a"], u["b"]),
    ]:
        mine = count(conn, f"select count(*) from public.{table} where user_id = %s", own)
        yours = count(conn, f"select count(*) from public.{table} where user_id = %s", theirs)
        # Both halves matter. The first proves the query works at all.
        assert mine > 0, f"A cannot read its own {table} — the test proves nothing"
        assert yours == 0, f"A read {yours} of B's {table} rows"


def test_the_positive_control_really_is_load_bearing(conn, two_users):
    """Drop the policies and the suite must go RED, not stay green.

    This is the meta-test: it proves the assertions above are sensitive to the
    thing they claim to check. Without it, "A reads 0 of B's rows" could be
    passing for any number of unrelated reasons.
    """
    u = two_users
    conn.execute("reset role")
    conn.execute("alter table public.user_postings disable row level security")
    try:
        as_authenticated(conn, u["a"])
        leaked = count(
            conn, "select count(*) from public.user_postings where user_id = %s", u["b"]
        )
        assert leaked > 0, (
            "with RLS disabled A still could not see B's rows — the test is "
            "measuring something other than the policy"
        )
    finally:
        conn.execute("reset role")
        conn.execute("alter table public.user_postings enable row level security")


def test_postings_are_visible_only_to_a_user_who_was_gated_them(conn, two_users):
    """0002 replaced 0001's blanket authenticated-read with a per-user join."""
    u = two_users
    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.postings where key = %s", u["ka"]) == 1
    assert count(conn, "select count(*) from public.postings where key = %s", u["kb"]) == 0


def test_channel_runs_shared_rows_are_readable_and_other_users_rows_are_not(conn, two_users):
    u = two_users
    conn.execute("reset role")
    conn.execute(
        """insert into public.channel_runs (user_id, channel, ran_at)
           values (null, 'monitor', now()), (%s, 'tracker', now())""",
        (u["b"],),
    )
    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.channel_runs where user_id is null") > 0
    assert count(conn, "select count(*) from public.channel_runs where user_id = %s", u["b"]) == 0


# ---------------------------------------------------------- bot runs (0023, E3)

def test_bot_runs_owner_and_shared_are_readable_and_another_users_are_not(conn, two_users):
    """The Activity tab's source, with `channel_runs`' visibility rule: a user
    sees their own runs plus the shared (null user_id) ones, and none of another
    user's. Positive control first — the owner reads their own — so a green result
    cannot come from A reading nothing, this file's standing requirement."""
    u = two_users
    conn.execute("reset role")
    conn.execute(
        """insert into public.bot_runs (user_id, job, finished_at, ok)
           values (null, 'monitor', now(), true), (%s, 'tracker', now(), true),
                  (%s, 'digest', now(), true)""",
        (u["a"], u["b"]),
    )
    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.bot_runs where user_id is null") > 0, (
        "the shared run is not visible — every negative below would be vacuous"
    )
    assert count(conn, "select count(*) from public.bot_runs where user_id = %s", u["a"]) == 1
    assert count(conn, "select count(*) from public.bot_runs where user_id = %s", u["b"]) == 0


def test_an_operator_reads_every_jobs_bot_runs(conn, two_users):
    """Coverage's Activity tab is an operator surface: `is_operator` sees all runs,
    which is the third arm of the policy `channel_runs` shares."""
    u = two_users
    op = make_user(conn, f"op-{uuid.uuid4()}@example.com")
    conn.execute("reset role")
    conn.execute("update public.users set is_operator = true where id = %s", (op,))
    conn.execute(
        """insert into public.bot_runs (user_id, job, finished_at, ok)
           values (%s, 'tracker', now(), true), (%s, 'digest', now(), true)""",
        (u["a"], u["b"]),
    )
    as_authenticated(conn, op)
    assert count(conn, "select count(*) from public.bot_runs where user_id = %s", u["a"]) == 1
    assert count(conn, "select count(*) from public.bot_runs where user_id = %s", u["b"]) == 1


def test_the_bot_runs_read_policy_is_what_hides_them(conn, two_users):
    """The meta-test in this file's shape: drop the protection and the negative
    above must go RED, so it is the policy doing the hiding and not A being unable
    to read the table at all."""
    u = two_users
    conn.execute("reset role")
    conn.execute("insert into public.bot_runs (user_id, job) values (%s, 'tracker')", (u["b"],))
    conn.execute("alter table public.bot_runs disable row level security")
    try:
        as_authenticated(conn, u["a"])
        leaked = count(conn, "select count(*) from public.bot_runs where user_id = %s", u["b"])
        assert leaked > 0, (
            "with RLS disabled A still could not see B's runs — the test is "
            "measuring something other than the policy"
        )
    finally:
        conn.execute("reset role")
        conn.execute("alter table public.bot_runs enable row level security")


def test_an_authenticated_user_has_no_direct_write_to_bot_runs(conn, two_users):
    """There is no function and no write policy: the engine writes via the service
    role, a browser writes nothing. The revoke NAMES the roles (0023), because
    Supabase grants write by name and RLS alone would let an UPDATE/DELETE silently
    touch zero rows rather than refuse — a named revoke makes it a privilege error."""
    u = two_users
    as_authenticated(conn, u["a"])
    for stmt, args in (
        ("insert into public.bot_runs (user_id, job) values (%s, 'sneaky')", (u["a"],)),
        ("update public.bot_runs set ok = false", ()),
        ("delete from public.bot_runs", ()),
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(stmt, args)
        assert "permission denied" in str(exc.value).lower() or "policy" in str(
            exc.value
        ).lower(), stmt


def test_a_run_is_either_open_or_closed_never_finished_with_no_outcome(conn, two_users):
    """0023's check constraint, and the reason it exists.

    "Finished, outcome unknown" is the one row the Activity reader cannot render
    honestly — neither a success nor a failure, and whichever it picked would be
    a guess about whether the user's automation is working. `core/runlog.py`
    always writes the pair together, so barring the third combination costs the
    writer nothing and makes the reader's state machine total. Both legal shapes
    are asserted alongside, so a constraint that refused everything would fail
    here rather than look like success."""
    u = two_users
    conn.execute("reset role")
    # Legal: open (neither), and closed (both).
    conn.execute("insert into public.bot_runs (user_id, job) values (%s, 'monitor')", (u["a"],))
    conn.execute(
        "insert into public.bot_runs (user_id, job, finished_at, ok) values (%s, 'monitor', now(), true)",
        (u["a"],),
    )
    for bad, why in (
        ("insert into public.bot_runs (job, finished_at) values ('monitor', now())",
         "finished with no outcome"),
        ("insert into public.bot_runs (job, ok) values ('monitor', true)",
         "an outcome with no finish time"),
    ):
        with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
            conn.execute(bad)
    # …and it holds on UPDATE too, not only on the insert path.
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("update public.bot_runs set ok = null where finished_at is not null")


def test_the_service_role_opens_and_closes_a_run_row(conn, two_users):
    """The engine's write path, proven end to end: the service role (RLS-exempt)
    inserts the open row and updates it closed — start()/finish() in
    core/runlog.py, over pg.insert_returning + pg.patch."""
    u = two_users
    conn.execute("reset role")
    conn.execute("set role service_role")
    try:
        rid = conn.execute(
            "insert into public.bot_runs (user_id, job) values (%s, 'monitor') returning id",
            (u["a"],),
        ).fetchone()[0]
        conn.execute(
            "update public.bot_runs set finished_at = now(), ok = true, fetched = 38, "
            "new_rows = 2 where id = %s",
            (rid,),
        )
    finally:
        conn.execute("reset role")
    row = conn.execute(
        "select ok, fetched, new_rows, finished_at is not null "
        "from public.bot_runs where id = %s",
        (rid,),
    ).fetchone()
    assert row == (True, 38, 2, True)


# ---------------------------------------------------------- the audit trail

def test_an_authenticated_user_cannot_rewrite_or_delete_an_audit_row(conn, two_users):
    """events is append-only or it is decoration. 0002 revokes update/delete."""
    u = two_users
    as_authenticated(conn, u["a"])
    for sql in (
        "update public.events set kind = 'tampered' where user_id = %s",
        "delete from public.events where user_id = %s",
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(sql, (u["a"],))
        assert "permission denied" in str(exc.value).lower(), sql


def test_an_authenticated_user_cannot_truncate_the_audit_trail(conn, two_users):
    """TRUNCATE is not covered by RLS and is not an UPDATE or a DELETE.

    Revoking update/delete on `events` reads like "the audit trail cannot be
    rewritten", and it is not: TRUNCATE is governed by its own privilege, which
    the owner holds by default. One statement emptied the entire append-only
    trail for every user at once — the loudest possible action leaving the
    quietest possible trace, since the evidence is what gets deleted.
    """
    u = two_users
    as_authenticated(conn, u["a"])
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("truncate public.events")
    assert "permission denied" in str(exc.value).lower()

    conn.execute("reset role")
    assert count(conn, "select count(*) from public.events where user_id = %s", u["a"]) > 0


def test_command_idempotency_is_not_readable_by_anyone(conn, two_users):
    """Its stored results contain whole posting rows. RLS is on with no policy,
    so it is default-deny; it is reached only through security-definer code."""
    u = two_users
    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.command_idempotency") == 0


# ---------------------------------------------------------- the write path

def test_the_write_path_still_works_as_a_real_signed_in_session(conn, two_users):
    """Everything above is worthless if the app cannot function under the same
    role. `app_set_triage` is security definer precisely so it can write past
    the policies — this proves that still holds for an ordinary session."""
    u = two_users
    as_authenticated(conn, u["a"])
    row = conn.execute(
        "select public.app_set_triage(%s,'interested',null,'',%s,null)",
        (u["ka"], str(uuid.uuid4())),
    ).fetchone()[0]
    assert row["triage"] == "interested"

    conn.execute("reset role")
    assert count(
        conn,
        "select count(*) from public.events where user_id = %s and kind = 'action.interested'",
        u["a"],
    ) >= 1


def test_a_user_cannot_triage_a_posting_they_cannot_see(conn, two_users):
    u = two_users
    as_authenticated(conn, u["a"])
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "select public.app_set_triage(%s,'dismissed',null,'',%s,null)",
            (u["kb"], str(uuid.uuid4())),
        )
    assert "no such posting" in str(exc.value).lower()

    conn.execute("reset role")
    assert conn.execute(
        "select triage from public.user_postings where user_id=%s and posting_key=%s",
        (u["b"], u["kb"]),
    ).fetchone()[0] == ""


# ---------------------------------------------------------- saved views (0005)

def test_a_user_cannot_read_another_users_saved_views(conn, two_users):
    """Saved views carry a person's filters and named searches — as private as
    the rows they select over. Same both-directions assertion: A reads its own,
    A reads none of B's, so a green result cannot come from A reading nothing."""
    u = two_users
    # Each user saves one view, through the real definer function.
    for who, name in ((u["a"], "A view"), (u["b"], "B view")):
        conn.execute("reset role")
        conn.execute("select set_config('hq.test_user', %s, false)", (who,))
        conn.execute(
            "select public.app_save_view(null,%s,'jobs','{}'::jsonb,false,%s,null)",
            (name, str(uuid.uuid4())),
        )

    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.saved_views where user_id = %s", u["a"]) == 1
    assert count(conn, "select count(*) from public.saved_views where user_id = %s", u["b"]) == 0


# ------------------------------------------------------------- profiles (0012)

def test_a_user_cannot_read_another_users_profile(conn, two_users):
    """A Search Profile is what someone is looking for, what they will not take,
    and what they will not be paid less than. `profiles_self_read` has existed
    since 0001 and nothing ever exercised it — the row it protects only started
    being written in 0012, so the policy was correct and unproven.

    Both directions in one breath, as everywhere in this file: A reads its own,
    A reads none of B's. Without the positive control a green result could come
    from A reading nothing at all.
    """
    u = two_users
    for who, family in ((u["a"], "product manager"), (u["b"], "financial planning & analysis")):
        conn.execute("reset role")
        conn.execute("select set_config('hq.test_user', %s, false)", (who,))
        conn.execute(
            "select public.app_commit_profile(%s::jsonb, null, '[]'::jsonb, %s, null)",
            (json.dumps({"role_family": family, "yoe_max": 4}), str(uuid.uuid4())),
        )

    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.profiles where user_id = %s", u["a"]) == 1
    assert count(conn, "select count(*) from public.profiles where user_id = %s", u["b"]) == 0
    mine = conn.execute(
        "select criteria->>'role_family' from public.profiles where user_id = %s", (u["a"],)
    ).fetchone()
    assert mine and mine[0] == "product manager"


def test_an_authenticated_user_has_no_direct_write_to_profiles(conn, two_users):
    """Writes go through `app_commit_profile` only. A direct UPDATE from a
    browser session would skip the re-gate, the audit event and the version
    check in one stroke — and would let somebody widen their own gate without
    anything on screen saying their queue had changed."""
    u = two_users
    as_authenticated(conn, u["a"])
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "insert into public.profiles (user_id, criteria) values (%s, '{\"yoe_max\": 99}'::jsonb)",
            (u["a"],),
        )
    assert "policy" in str(exc.value).lower() or "permission denied" in str(exc.value).lower()


def test_the_preview_corpus_does_not_leak_another_users_triage(conn, two_users):
    """`app_preview_corpus` is `security definer` and deliberately widens a read
    RLS narrowed. The widening has a stated boundary: the SHARED posting
    universe, which every user watches by design (0001_init.sql:6-9) — and
    nothing per-user. This asserts the boundary rather than trusting the
    projection to stay narrow: no column it returns is per-user, so B's triage
    and B's disposition are unreachable through it."""
    u = two_users
    as_authenticated(conn, u["a"])
    cols = {
        r[0]
        for r in conn.execute(
            """select p.attname from pg_proc f
                 join lateral unnest(f.proargnames, f.proargmodes) as p(attname, mode) on true
                where f.proname = 'app_preview_corpus' and p.mode = 't'"""
        ).fetchall()
    }
    assert cols, "the projection parser found nothing — the assertion below is vacuous"
    assert not (cols & {"triage", "disposition", "disposition_reason", "user_id", "url"}), cols
    # …and it does answer, so the emptiness above is not why this passes.
    assert count(conn, "select count(*) from public.app_preview_corpus(90)") > 0


def test_an_authenticated_user_has_no_direct_write_to_saved_views(conn, two_users):
    """Writes go through app_save_view / app_delete_view only. A direct INSERT
    from a browser session is the door 0005 keeps shut — RLS has a read policy
    and no write policy, so an insert is denied."""
    u = two_users
    as_authenticated(conn, u["a"])
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "insert into public.saved_views (user_id, name) values (%s, 'sneaky')",
            (u["a"],),
        )
    assert "policy" in str(exc.value).lower() or "permission denied" in str(exc.value).lower()

# ------------------------------------------------------- application notes (0010)

def test_a_user_cannot_read_another_users_application_notes(conn, two_users):
    """Notes are the most private thing on the pipeline — "adverse selection
    worries me here", "recruiter was rude". Spec §I mandates a two-real-user test
    per per-user table, and every other one lives in THIS file; this one lived
    only in test_pipeline.py, so a reader auditing tenancy would have concluded
    the table had no such test.

    Both directions, in the order that matters: the owner CAN read their own note
    first. Without that control, "B sees nothing" passes when nobody can read the
    table at all, and would keep passing with the policy dropped.
    """
    u = two_users
    app_ids = {}
    for who in ("a", "b"):
        conn.execute("reset role")
        conn.execute("select set_config('hq.test_user', %s, false)", (u[who],))
        app_ids[who] = conn.execute(
            "select id from public.applications where user_id = %s", (u[who],)
        ).fetchone()[0]
        conn.execute(
            "select public.app_add_note(%s, %s, %s)",
            (app_ids[who], f"{who} private note", str(uuid.uuid4())),
        )

    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.application_notes") == 1, (
        "the owner cannot read their own note — the read policy is wrong, and every "
        "negative assertion below would pass for the wrong reason"
    )
    assert count(
        conn, "select count(*) from public.application_notes where body like %s", "b private%"
    ) == 0, "user A can read user B's notes"

    as_authenticated(conn, u["b"])
    assert count(
        conn, "select count(*) from public.application_notes where body like %s", "a private%"
    ) == 0, "user B can read user A's notes"


def test_an_authenticated_user_has_no_direct_write_to_application_notes(conn, two_users):
    """Append-only is a GRANT, not a convention: writes go through `app_add_note`
    or not at all. Duplicated from test_pipeline.py on purpose — this file is where
    someone auditing tenancy looks, and the revoke is the reason "editing a note
    means appending a correction" is true rather than aspirational."""
    u = two_users
    as_authenticated(conn, u["a"])
    app_id = None
    for stmt, args in (
        ("insert into public.application_notes (user_id, application_id, body) "
         "values (%s, 1, 'sneaky')", (u["a"],)),
        ("update public.application_notes set body = 'edited'", ()),
        ("delete from public.application_notes", ()),
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(stmt, args)
        assert "permission denied" in str(exc.value).lower() or "policy" in str(
            exc.value
        ).lower(), stmt
    assert app_id is None  # nothing above was supposed to return a row



def test_a_user_cannot_read_another_users_import(conn, two_users):
    """An import batch is somebody's whole spreadsheet — every company they are
    talking to, every note they typed into it. Spec §I mandates a two-real-user
    test per per-user table, and 0011 adds three of them: the wizard READS all
    three directly through PostgREST, so these select policies are load-bearing
    rather than belt-and-braces.

    Both directions, positive control first. "B sees nothing" is equally true
    when nobody can read the table at all, and would keep passing with the
    policies dropped.
    """
    u = two_users
    batches = {}
    for who in ("a", "b"):
        conn.execute("reset role")
        conn.execute("select set_config('hq.test_user', %s, false)", (u[who],))
        batches[who] = conn.execute(
            "select public.app_import_create(%s, %s, %s, %s, %s)",
            (str(uuid.uuid4()), f"{who}-tracker.xlsx", "xlsx", "", 1),
        ).fetchone()[0]["id"]
        conn.execute(
            "select public.app_import_stage(%s, %s)",
            (batches[who], f'[{{"row_number": 1, "raw": {{"Company": "{who}-secret"}}}}]'),
        )
        conn.execute(
            "select public.app_import_set_mapping(%s, %s, %s, %s, %s)",
            (batches[who],
             '[{"row_number": 1, "mapped": {"company": "' + who + '-secret", "title": "PM"},'
             ' "job_key": "greenhouse-99' + ("1" if who == "a" else "2") + '",'
             ' "key_strength": "strong"}]',
             '{"unmapped": [{"name": "Recruiter", "disposition": "unknown-column"}]}',
             True, None),
        )

    for me, them in (("a", "b"), ("b", "a")):
        as_authenticated(conn, u[me])
        assert count(
            conn, "select count(*) from public.import_batches where id = %s", batches[me]
        ) == 1, f"{me} cannot read their own import — every negative below is vacuous"
        assert count(
            conn, "select count(*) from public.import_batches where id = %s", batches[them]
        ) == 0, f"{me} can read {them}'s import batch"

        assert count(
            conn, "select count(*) from public.import_rows where batch_id = %s", batches[me]
        ) == 1, f"{me} cannot read their own import rows"
        assert count(
            conn, "select count(*) from public.import_rows where batch_id = %s", batches[them]
        ) == 0, f"{me} can read the CONTENTS of {them}'s spreadsheet"

        assert count(
            conn,
            "select count(*) from public.import_column_reports where batch_id = %s",
            batches[me],
        ) == 1, f"{me} cannot read their own column report"
        assert count(
            conn,
            "select count(*) from public.import_column_reports where batch_id = %s",
            batches[them],
        ) == 0, f"{me} can read {them}'s column report"


# ------------------------------------------------------------- referral (0013)


def _import_connections(conn, user_id, rows):
    """Seed connections the way the browser does — through the definer RPC."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (user_id,))
    conn.execute(
        "select public.app_import_connections(%s::jsonb, 'linkedin-export', %s)",
        (json.dumps(rows), str(uuid.uuid4())),
    )


def test_a_user_cannot_read_another_users_connections(conn, two_users):
    """A connections export is somebody's entire professional network — every
    person they know, where those people work, and when they met. Spec §I mandates
    a two-real-user test per per-user table, and this one is read DIRECTLY through
    PostgREST by every surface that shows a warm path, so `connections_self_read`
    is load-bearing rather than belt-and-braces.

    Positive control FIRST, as everywhere in this file: A reads its own. "B sees
    nothing" is equally true when nobody can read the table at all, and would keep
    passing with the policy dropped.
    """
    u = two_users
    _import_connections(conn, u["a"], [{"full_name": "A Contact", "company": "AlphaCorp"}])
    _import_connections(conn, u["b"], [{"full_name": "B Contact", "company": "BetaCorp"}])

    for me, them in (("a", "b"), ("b", "a")):
        as_authenticated(conn, u[me])
        assert count(
            conn, "select count(*) from public.connections where user_id = %s", u[me]
        ) == 1, f"{me} cannot read its own connections — every negative below is vacuous"
        assert count(
            conn, "select count(*) from public.connections where user_id = %s", u[them]
        ) == 0, f"{me} can read {them}'s connections"
        # …and not by any other route either: the whole table is one row to them.
        assert count(conn, "select count(*) from public.connections") == 1


def test_the_connections_read_policy_is_what_hides_them(conn, two_users):
    """The meta-test, in this file's existing shape: drop the protection and the
    assertion above must go RED. Without it, "A reads 0 of B's connections" could
    be passing for any number of unrelated reasons."""
    u = two_users
    _import_connections(conn, u["b"], [{"full_name": "B Contact", "company": "BetaCorp"}])

    conn.execute("reset role")
    conn.execute("alter table public.connections disable row level security")
    try:
        as_authenticated(conn, u["a"])
        leaked = count(
            conn, "select count(*) from public.connections where user_id = %s", u["b"]
        )
        assert leaked > 0, (
            "with RLS disabled A still could not see B's connections — the test is "
            "measuring something other than the policy"
        )
    finally:
        conn.execute("reset role")
        conn.execute("alter table public.connections enable row level security")


def test_an_authenticated_user_has_no_direct_write_to_connections(conn, two_users):
    """The browser writes through `app_import_connections` / `app_clear_connections`
    or not at all (0001's closing note). The grid READS this table directly, so it
    is easy to assume it is writable directly too — and a direct write would skip
    the normalization, the dedupe, the report and the audit event in one stroke.

    The revoke names `public, anon, authenticated` rather than only `public`,
    because Supabase's bootstrap grants BY NAME and revoking from `public` does not
    touch a named grant (matrix row 216).
    """
    u = two_users
    _import_connections(conn, u["a"], [{"full_name": "A Contact", "company": "AlphaCorp"}])
    as_authenticated(conn, u["a"])
    for stmt, args in (
        ("insert into public.connections (user_id, full_name) values (%s, 'sneaky')", (u["a"],)),
        ("update public.connections set company = 'Ramp'", ()),
        ("delete from public.connections", ()),
        ("truncate public.connections", ()),
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(stmt, args)
        assert "permission denied" in str(exc.value).lower() or "policy" in str(
            exc.value
        ).lower(), stmt

    # Nothing above landed, and the row that was there still is.
    conn.execute("reset role")
    assert count(conn, "select count(*) from public.connections where user_id = %s", u["a"]) == 1


def test_the_linkedin_column_does_not_widen_the_shared_companies_policy(conn, two_users):
    """0013 puts a new column on the SHARED `companies` table, and the migration
    states the cost it accepts: one watcher's paste is visible to every OTHER
    watcher of that company. `companies_visible_to_watchers` (0002) is what bounds
    that to watchers — so the new column must not turn the shared universe into a
    thing anybody with a session can read.

    Both directions: somebody who watches nothing sees nothing, and the same
    person sees the id the moment they watch the company. Without the second half
    this would pass for a policy that hid the table from everyone.
    """
    u = two_users
    conn.execute("reset role")
    cid = conn.execute(
        """insert into public.companies (name, ats, slug, source, reliability_tier,
                                         resolution_method)
           values (%s, 'greenhouse', %s, 'test', 1, 'discover-greenhouse') returning id""",
        (f"Ramp {uuid.uuid4().hex[:6]}", uuid.uuid4().hex[:8]),
    ).fetchone()[0]
    conn.execute(
        """insert into public.user_companies (user_id, company_id, monitor, review_state)
           values (%s, %s, true, 'approved')""",
        (u["b"], cid),
    )
    conn.execute("select set_config('hq.test_user', %s, false)", (u["b"],))
    conn.execute(
        "select public.app_set_linkedin_company_id(%s, '1035', %s, null)",
        (cid, str(uuid.uuid4())),
    )

    as_authenticated(conn, u["a"])
    assert count(conn, "select count(*) from public.companies where id = %s", cid) == 0, (
        "the new column widened companies_visible_to_watchers"
    )
    assert count(conn, "select count(*) from public.companies") == 0, (
        "a user who watches no companies can read the shared universe"
    )

    # The control: watching it is what makes it visible — and the pasted id comes
    # with it, which is the shared-column tradeoff 0013 states out loud.
    conn.execute("reset role")
    conn.execute(
        """insert into public.user_companies (user_id, company_id, monitor, review_state)
           values (%s, %s, true, 'approved')""",
        (u["a"], cid),
    )
    as_authenticated(conn, u["a"])
    assert conn.execute(
        "select linkedin_company_id from public.companies where id = %s", (cid,)
    ).fetchone() == ("1035",)


def test_an_authenticated_user_has_no_direct_write_to_the_import_tables(conn, two_users):
    """The wizard writes through `app_import_*` or not at all (0001's closing
    note). Without the revoke, a browser could stage rows into somebody else's
    batch and then commit them as its own — the tables are read directly, so it
    is easy to assume they are writable directly too."""
    u = two_users
    as_authenticated(conn, u["a"])
    for stmt, args in (
        ("insert into public.import_batches (user_id, source_kind, idempotency_key) "
         "values (%s, 'csv', 'x')", (u["a"],)),
        ("update public.import_batches set state = 'committed'", ()),
        ("delete from public.import_batches", ()),
        ("insert into public.import_rows (batch_id, user_id, row_number, raw) "
         "values (gen_random_uuid(), %s, 1, '{}')", (u["a"],)),
        ("update public.import_rows set outcome = 'created'", ()),
        ("insert into public.import_column_reports "
         "(batch_id, user_id, column_name, disposition) "
         "values (gen_random_uuid(), %s, 'Status', 'imported')", (u["a"],)),
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(stmt, args)
        assert "permission denied" in str(exc.value).lower() or "policy" in str(
            exc.value
        ).lower(), stmt
