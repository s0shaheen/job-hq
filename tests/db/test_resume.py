"""Resume documents/versions/artifacts, actually executed against Postgres (0026).

`tests/core/test_migrations.py` reads the SQL as text; everything here RUNS.
What it proves that reading the migration cannot:

    privacy    B cannot read A's documents, versions, or artifacts — with the
               positive control in the same breath (tests/db/test_rls.py's rule)
    no-op      a save that changes no field moves no version token: an idle
               autosave cannot make every other open tab raise a phantom conflict
    append     versions and artifacts refuse UPDATE and DELETE for a living user
               — including from a definer helper, which is what the trigger is for
    erasure    deleting the user really deletes: the cascade is the ONE path
               through the append-only triggers, so GDPR erasure cannot hard-fail
    replay     a double-submitted save is one write, one event, same result

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_resume.py -q
"""
from __future__ import annotations

import json
import os
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

from tests.db.test_rls import as_authenticated  # noqa: E402
from tests.db.test_write_path import (  # noqa: E402  (fixtures are shared on purpose)
    as_definer,
    as_user,
    guard_verdict,
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


def save_doc(conn, name="Base", *, content=None, theme="harvard",
             page_target=1, idem=None, expected=None):
    return conn.execute(
        "select public.app_save_resume_document(%s, 'resume', %s, %s::jsonb,"
        " '{}'::jsonb, %s::smallint, %s, %s)",
        (
            name,
            theme,
            json.dumps(content if content is not None else {"name": "Fixture Person"}),
            page_target,
            idem or uuid.uuid4().hex,
            expected,
        ),
    ).fetchone()[0]


def save_version(conn, document_id, *, label="v1", idem=None):
    return conn.execute(
        "select public.app_save_resume_version(%s, %s, '{}'::jsonb,"
        " 1::smallint, %s, %s)",
        (document_id, "a" * 64, label, idem or uuid.uuid4().hex),
    ).fetchone()[0]


def as_engine(conn):
    """Drop the browser identity as well as the role — the ENGINE's context.

    `reset role` alone leaves `hq.test_user` set, so `auth.uid()` still answers
    and 0028's `hq_entitlement_guard` reads the session as a signed-in browser.
    That matters for the three ownership-FK tests below: the writer they model is
    `service_role` (a backfill, a psql fix — the writer that keeps INSERT and
    bypasses RLS, which is what makes the denormalised `user_id` a habit rather
    than a fact), and the engine has no `auth.uid()`. Without this the guard
    refuses the cross-owner insert BEFORE the foreign key is consulted, and the
    test would pass on the wrong mechanism — green while asserting nothing about
    the constraint it exists to prove.

    The browser-session half of the same hole is covered by
    `test_default_deny.py::test_an_entitled_session_cannot_write_a_row_it_does_not_own`.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


def record_artifact(conn, user_id, version_id, *, idem=None):
    path = f"{user_id}/renders/{uuid.uuid4().hex}.pdf"
    return conn.execute(
        "select public.app_record_resume_artifact(%s, 'rendered', 'pdf', %s,"
        " 'resume.pdf', 1234, %s, 'permanent', %s)",
        (version_id, path, "b" * 64, idem or uuid.uuid4().hex),
    ).fetchone()[0]


# ---------------------------------------------------------------- privacy

def test_another_user_cannot_read_resume_rows(conn, user):
    """RLS on all three tables, read as a real signed-in session (`set role
    authenticated` — a superuser read tests nothing), with the positive
    control in the same test."""
    doc = save_doc(conn)["document"]
    version_id = save_version(conn, doc["id"])["version"]["id"]
    record_artifact(conn, user, version_id)
    other = make_user(conn, f"{uuid.uuid4()}@example.com")

    as_authenticated(conn, user)
    for table in ("resume_documents", "resume_versions", "resume_artifacts"):
        n = conn.execute(f"select count(*) from public.{table}").fetchone()[0]
        assert n >= 1, f"positive control failed: owner sees no {table} rows"

    as_authenticated(conn, other)
    for table in ("resume_documents", "resume_versions", "resume_artifacts"):
        n = conn.execute(f"select count(*) from public.{table}").fetchone()[0]
        assert n == 0, f"user B can read user A's {table} rows through RLS"
    conn.execute("reset role")
    as_user(conn, user)


# ---------------------------------------------------------------- no-op save

def test_a_save_that_changes_nothing_moves_no_version_token(conn, user):
    """An idle autosave must not invalidate every other open tab."""
    first = save_doc(conn, content={"name": "Same"})["document"]
    again = save_doc(conn, content={"name": "Same"})["document"]
    assert again["updatedAt"] == first["updatedAt"], (
        "a no-op save bumped updated_at — every other tab's version token "
        "was invalidated by a write that changed no field"
    )
    changed = save_doc(conn, content={"name": "Different"})["document"]
    assert changed["updatedAt"] != first["updatedAt"], (
        "positive control failed: a real change did not move the token"
    )


def test_a_replayed_save_returns_the_first_result_and_writes_once(conn, user):
    """A REPLAY is the same gesture sent twice — same command, same payload."""
    key = uuid.uuid4().hex
    first = save_doc(conn, content={"name": "One"}, idem=key)
    replay = save_doc(conn, content={"name": "One"}, idem=key)
    assert replay == first, "a replayed key applied a second time"
    events = conn.execute(
        "select count(*) from public.events"
        " where kind = 'resume.document_saved' and user_id = %s",
        (user,),
    ).fetchone()[0]
    assert events == 1, "one gesture, two audit rows"


def test_a_key_reused_for_a_DIFFERENT_command_is_refused(conn, user):
    """The blocker this replaces the old silence with.

    `command_idempotency.command` was written by every RPC and read by none, so
    a key minted for a save and reused by `app_set_default_resume` returned the
    SAVE's result verbatim — a payload with a `created` key the default lane can
    never produce — while setting no default at all. The caller was told a write
    it never did had succeeded. Two different gestures are not a replay of each
    other, and the only safe answer is to refuse.
    """
    key = uuid.uuid4().hex
    doc = save_doc(conn, idem=key)["document"]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        conn.execute("select public.app_set_default_resume(%s, %s)", (doc["id"], key))
    is_default = conn.execute(
        "select is_default from public.resume_documents where id = %s", (doc["id"],)
    ).fetchone()[0]
    assert is_default is False, "the default was set by a call that should have refused"

    # Positive control: a FRESH key does the write the refused call claimed.
    conn.execute(
        "select public.app_set_default_resume(%s, %s)", (doc["id"], uuid.uuid4().hex)
    )
    assert conn.execute(
        "select is_default from public.resume_documents where id = %s", (doc["id"],)
    ).fetchone()[0] is True, "positive control failed: a fresh key did not set the default"


def test_a_key_reused_with_a_DIFFERENT_payload_is_refused(conn, user):
    """Same command, different arguments: the second write was silently discarded
    and the caller was handed the first one's result as if it were its own."""
    key = uuid.uuid4().hex
    save_doc(conn, name="Base", content={"name": "One"}, idem=key)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        save_doc(conn, name="Base", content={"name": "Two"}, idem=key)
    stored = conn.execute(
        "select content->>'name' from public.resume_documents"
        " where user_id = %s and name = 'Base'",
        (user,),
    ).fetchone()[0]
    assert stored == "One", "the refused call wrote anyway"


def test_every_resume_command_scopes_its_own_replay_lookup(conn, user):
    """All four RPCs, not just the one that was easiest to demonstrate."""
    doc = save_doc(conn)["document"]
    vid = save_version(conn, doc["id"])["version"]["id"]
    path = f"{user}/renders/{uuid.uuid4().hex}.pdf"

    calls = {
        "app_save_resume_version": (
            "select public.app_save_resume_version(%s, %s, '{}'::jsonb,"
            " 1::smallint, 'v', %s)",
            (doc["id"], "a" * 64),
        ),
        "app_record_resume_artifact": (
            "select public.app_record_resume_artifact(%s, 'rendered', 'pdf', %s,"
            " 'resume.pdf', 1234, %s, 'permanent', %s)",
            (vid, path, "b" * 64),
        ),
        "app_set_default_resume": (
            "select public.app_set_default_resume(%s, %s)",
            (doc["id"],),
        ),
    }
    for name, (sql, args) in calls.items():
        key = uuid.uuid4().hex
        save_doc(conn, idem=key)                      # the key now belongs to the save
        with pytest.raises(psycopg.errors.InvalidParameterValue,
                           match="idempotency key"):
            conn.execute(sql, (*args, key))
        # And the reverse direction: a key minted by THIS command is not a save.
        conn.execute(sql, (*args, (key2 := uuid.uuid4().hex)))
        with pytest.raises(psycopg.errors.InvalidParameterValue,
                           match="idempotency key"):
            save_doc(conn, idem=key2)
        assert name  # names the failing iteration in the traceback


# ---------------------------------------------------------------- append-only

def test_versions_refuse_update_and_delete_for_a_living_user(conn, user):
    doc = save_doc(conn)["document"]
    vid = save_version(conn, doc["id"])["version"]["id"]
    conn.execute("reset role")  # the trigger must hold even against the owner role
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("update public.resume_versions set page_count = 9 where id = %s", (vid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("delete from public.resume_versions where id = %s", (vid,))
    as_user(conn, user)


def test_artifacts_refuse_update_and_delete_for_a_living_user(conn, user):
    doc = save_doc(conn)["document"]
    vid = save_version(conn, doc["id"])["version"]["id"]
    aid = record_artifact(conn, user, vid)["artifact"]["id"]
    conn.execute("reset role")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "update public.resume_artifacts set sha256 = %s where id = %s",
            ("c" * 64, aid),
        )
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("delete from public.resume_artifacts where id = %s", (aid,))
    as_user(conn, user)


# ---------------------------------------------------------------- erasure

def _live(conn, ids: dict[str, int], user: str) -> dict[str, tuple[int, int]]:
    """For each résumé table: (rows the OWNER has, rows THIS id has).

    Both, because each catches what the other cannot. The owner-scoped count
    alone is satisfied by a user who never had a row; the id-scoped count alone
    is satisfied by a delete that took the one row this test made and left the
    rest of the owner's history standing.
    """
    return {
        table: (
            conn.execute(
                f"select count(*) from public.{table} where user_id = %s", (user,)
            ).fetchone()[0],
            conn.execute(
                f"select count(*) from public.{table} where id = %s", (row_id,)
            ).fetchone()[0],
        )
        for table, row_id in ids.items()
    }


def test_deleting_the_user_erases_versions_and_artifacts(conn, user):
    """The ONE path through the append-only triggers: the owner's erasure.

    Before the exception existed, this cascade raised and user deletion was
    impossible while a single version row existed — GDPR erasure hard-failed.

    THE PRECONDITION IS ASSERTED, and that is the point of the first `assert`.
    Shipped, this test only checked that the three tables hold no row for the
    owner AFTER the delete. Absence is a STATE, not a behaviour: the identical
    block passes for a user who never saved a résumé at all — measured, by
    running exactly those assertions against a fresh `user` fixture with no
    document, no version and no artifact, which came up green. So the test could
    not tell "erasure works" from "there was nothing there", and it would have
    stayed green if `app_record_resume_artifact` had quietly stopped writing.
    Establishing the precondition here is what makes the second `assert` a
    statement about the cascade.
    """
    doc = save_doc(conn)["document"]
    vid = save_version(conn, doc["id"])["version"]["id"]
    aid = record_artifact(conn, user, vid)["artifact"]["id"]
    ids = {
        "resume_documents": doc["id"],
        "resume_versions": vid,
        "resume_artifacts": aid,
    }
    conn.execute("reset role")

    before = _live(conn, ids, user)
    assert before == {t: (1, 1) for t in ids}, (
        f"the erasure had nothing to erase — preconditions were not established: {before}"
    )

    conn.execute("delete from public.users where id = %s", (user,))

    after = _live(conn, ids, user)
    assert after == {t: (0, 0) for t in ids}, f"erasure left rows behind: {after}"


def test_service_role_cannot_truncate_any_resume_table(conn, user):
    """The append-only trigger is a ROW trigger, and TRUNCATE does not fire one.

    `truncate public.resume_versions cascade` as `service_role` took all three
    tables with it — every user's résumés, version log and evidence — with no
    trigger, no audit and no cascade the erasure carve-out could recognise.
    `truncate` was revoked from `public, anon, authenticated`; the one role that
    could actually reach it was the one left out, and 0004's `alter default
    privileges` deliberately keeps TRUNCATE for `service_role` (it prunes and
    restores elsewhere), so nothing upstream covered this.
    """
    doc = save_doc(conn)["document"]
    vid = save_version(conn, doc["id"])["version"]["id"]
    record_artifact(conn, user, vid)
    conn.execute("reset role")

    for table in ("resume_versions", "resume_documents", "resume_artifacts"):
        conn.execute("set role service_role")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(f"truncate public.{table} cascade")
        conn.execute("reset role")
        n = conn.execute(f"select count(*) from public.{table}").fetchone()[0]
        assert n >= 1, f"{table} was emptied by a TRUNCATE that should have been refused"
    as_user(conn, user)


def test_the_writer_that_bypasses_rls_holds_no_rewriting_privilege(conn, user):
    """Asserted as a PRIVILEGE and not as a refusal, because the refusal is the
    trigger's and the trigger is the layer under this one.

    `resume_artifacts` is documented as immutable evidence and `resume_versions`
    as append-only, and the revoke reached exactly one of the two — and TRUNCATE
    on neither. A trigger that refuses UPDATE is not a reason to leave the
    privilege granted; it is the reason a missing revoke goes unnoticed.
    """
    conn.execute("reset role")
    held = {
        (table, priv): conn.execute(
            "select has_table_privilege('service_role', %s, %s)",
            (f"public.{table}", priv),
        ).fetchone()[0]
        for table in ("resume_documents", "resume_versions", "resume_artifacts")
        for priv in ("TRUNCATE", "UPDATE", "DELETE")
    }
    forbidden = [
        ("resume_documents", "TRUNCATE"),
        ("resume_versions", "TRUNCATE"),
        ("resume_versions", "UPDATE"),
        ("resume_versions", "DELETE"),
        ("resume_artifacts", "TRUNCATE"),
        ("resume_artifacts", "UPDATE"),
        ("resume_artifacts", "DELETE"),
    ]
    assert [k for k in forbidden if held[k]] == [], (
        "service_role still holds privileges that rewrite or erase history"
    )
    # Positive control, so this is a statement about SOME privileges and not a
    # test that would pass against a role with no grants at all: the engine still
    # updates documents (that is what a document is for) and still deletes users,
    # which is what erases all three by cascade.
    assert held[("resume_documents", "UPDATE")], "the engine lost its ordinary write"
    assert held[("resume_documents", "DELETE")], "the engine lost the erasure cascade"
    as_user(conn, user)


# ---------------------------------------------------------------- cross-owner rows

def test_a_version_cannot_belong_to_another_users_document(conn, user):
    """`resume_versions.user_id` is denormalised from the document, and nothing
    tied the two together. A row carrying A's `document_id` and B's `user_id`
    does two things at once: B reads a version of A's document through the
    single-predicate RLS policy, and A's erasure hard-fails FOREVER — the cascade
    from `resume_documents` deletes by `document_id` while the append-only
    carve-out asks whether `old.user_id` still exists, and B does.

    The comment justifying the denormalisation says "the write function is the
    only writer"; `service_role` retains INSERT, so that is a habit, not a fact.
    """
    doc = save_doc(conn)["document"]
    other = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_engine(conn)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute(
            "insert into public.resume_versions"
            " (document_id, user_id, content, design, theme, content_hash)"
            " values (%s, %s, '{}'::jsonb, '{}'::jsonb, 'harvard', %s)",
            (doc["id"], other, "a" * 64),
        )
    # Positive control: the SAME insert with the true owner is accepted, so the
    # constraint refuses a mismatch and not the shape.
    conn.execute(
        "insert into public.resume_versions"
        " (document_id, user_id, content, design, theme, content_hash)"
        " values (%s, %s, '{}'::jsonb, '{}'::jsonb, 'harvard', %s)",
        (doc["id"], user, "a" * 64),
    )
    as_user(conn, user)


def test_an_artifact_cannot_point_at_another_users_version(conn, user):
    """Same hole, one table over: `resume_artifacts.version_id` is checked
    against the caller in the RPC, and by nothing at all in the schema."""
    doc = save_doc(conn)["document"]
    vid = save_version(conn, doc["id"])["version"]["id"]
    other = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_engine(conn)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute(
            "insert into public.resume_artifacts"
            " (user_id, version_id, origin, kind, storage_path, filename,"
            "  byte_size, sha256, retention)"
            " values (%s, %s, 'rendered', 'pdf', %s, 'steal.pdf', 10, %s, 'permanent')",
            (other, vid, f"{other}/renders/steal.pdf", "d" * 64),
        )
    as_user(conn, user)


def test_a_cross_owner_version_cannot_make_erasure_hard_fail(conn, user):
    """The consequence, executed end to end: with the mismatched row in place,
    `delete from users` where A is the owner raises forever and A's account can
    never be erased. This is the failure
    `test_deleting_the_user_erases_versions_and_artifacts` exists to prevent and
    cannot see, because it never creates a mismatched row."""
    doc = save_doc(conn)["document"]
    other = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_engine(conn)
    try:
        conn.execute(
            "insert into public.resume_versions"
            " (document_id, user_id, content, design, theme, content_hash)"
            " values (%s, %s, '{}'::jsonb, '{}'::jsonb, 'harvard', %s)",
            (doc["id"], other, "a" * 64),
        )
    except psycopg.errors.ForeignKeyViolation:
        pass          # the fix: the row cannot exist, so the erasure cannot break
    conn.execute("delete from public.users where id = %s", (user,))
    n = conn.execute(
        "select count(*) from public.resume_documents where user_id = %s", (user,)
    ).fetchone()[0]
    assert n == 0, "erasure left the owner's documents behind"


def test_erasure_is_the_only_delete_path_not_a_general_hole(conn, user):
    """The counterexample for the exception itself: a direct DELETE against a
    LIVING user's history must still refuse — the erasure carve-out checks that
    the owner is gone, not that the caller is powerful."""
    doc = save_doc(conn)["document"]
    vid = save_version(conn, doc["id"])["version"]["id"]
    conn.execute("reset role")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("delete from public.resume_versions where id = %s", (vid,))
    as_user(conn, user)


# ------------------------------------------------- the entitlement gate (0028)

def test_a_suspended_session_can_neither_read_nor_write_a_resume(conn, user):
    """0028, driven for real: an account the owner turned OFF, with a live session.

    This is the state the gate exists for and the one a structural sweep cannot
    reach. Suspension flips a row in `public.entitlements`; it does not and cannot
    invalidate a JWT that is already in a browser. So the person keeps a working
    session, keeps the public anon key, and — until 0028 — kept full access to the
    most private table in the product, over `/rest/v1/resume_documents` with the
    web app nowhere in the path.

    Both halves are asserted because 0028 attaches two different mechanisms and
    each covers a path the other cannot:

      READ   the RESTRICTIVE policy. ANDed with 0026's permissive
             `user_id = auth.uid()` select policy, so the owner-scoped read still
             has to clear `hq_is_entitled()` as well.
      WRITE  the GUARD TRIGGER. All four résumé RPCs are `security definer`, which
             bypasses RLS by construction — the policy above is not even consulted
             inside them, and the trigger is the entire boundary.

    The ACTIVE session is the positive control on both halves, in the same test:
    "a suspended session reads 0 rows" is equally true of a database with no rows
    in it, and "the RPC raised" is equally true of an RPC that raises for
    everybody.

    KILLED BY (both mutations executed, see the PR evidence):
      * dropping the three `*_entitlement_guard` triggers → every RPC below
        succeeds for the suspended account and the four write assertions fail;
      * dropping the three `*_entitled` restrictive policies → the read assertion
        fails, the suspended account reading its own résumé content back.
    """
    doc = save_doc(conn)["document"]
    version_id = save_version(conn, doc["id"])["version"]["id"]
    record_artifact(conn, user, version_id)

    # Positive control, as a real signed-in session rather than as postgres.
    as_authenticated(conn, user)
    for table in ("resume_documents", "resume_versions", "resume_artifacts"):
        assert conn.execute(
            f"select count(*) from public.{table}"
        ).fetchone()[0] >= 1, f"positive control: an ACTIVE session must read its own {table}"

    as_engine(conn)
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (user,))

    # READ — the restrictive policy.
    as_authenticated(conn, user)
    leaked = {
        t: n
        for t in ("resume_documents", "resume_versions", "resume_artifacts")
        if (n := conn.execute(f"select count(*) from public.{t}").fetchone()[0])
    }
    assert not leaked, (
        f"a SUSPENDED session read its own résumé rows over /rest/v1: {leaked}"
    )

    # WRITE — the guard trigger, once per résumé RPC, because each is a separate
    # `security definer` and a gate attached to three tables but missed by one
    # function is not a gate.
    as_authenticated(conn, user)
    for table, call, args in (
        ("resume_documents",
         "select public.app_save_resume_document('Sneak','resume','harvard',"
         " '{}'::jsonb, '{}'::jsonb, 1::smallint, %s, null)", (uuid.uuid4().hex,)),
        ("resume_versions",
         "select public.app_save_resume_version(%s, %s, '{}'::jsonb, 1::smallint,"
         " 'v', %s)", (doc["id"], "a" * 64, uuid.uuid4().hex)),
        ("resume_artifacts",
         "select public.app_record_resume_artifact(%s, 'rendered', 'pdf', %s,"
         " 'r.pdf', 12, %s, 'permanent', %s)",
         (version_id, f"{user}/renders/sneak.pdf", "c" * 64, uuid.uuid4().hex)),
        ("resume_documents",
         "select public.app_set_default_resume(%s, %s)", (doc["id"], uuid.uuid4().hex)),
    ):
        command = call.split("(")[0].split(".")[-1].strip()
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(call, args)
        # SINCE #256 the refusal arrives one layer higher: `hq_command_replay`
        # checks entitlement before it reads the idempotency key, so none of these
        # four RPCs reaches its own write and the sentence names the COMMAND. The
        # command is asserted here — a bare "not entitled" would also match the
        # events row one statement later, which is the mutation this test has
        # always existed to kill, now stated against the new boundary.
        assert f"not entitled to replay {command}" in exc.value.diag.message_primary, (
            f"a SUSPENDED session got past the replay lookup in {command} — "
            f"{exc.value}"
        )

    # THE PER-TABLE HALF, which the RPCs no longer carry. The TABLE is named, not
    # merely "not entitled", and that is what makes it specific to 0028: every one
    # of those RPCs also writes `public.events`, which 0027 already gates, so with
    # 0028's triggers dropped all four still raised — on the events row, one
    # statement later. Measured, both ways: with the triggers attached the message
    # names `public.resume_documents` / `_versions` / `_artifacts`; with them
    # dropped it names `public.events`. `guard_verdict` writes under table-owner
    # rights with the suspended account's `auth.uid()`, which is the context the
    # RPC's own write ran in — RLS off, trigger on — and rolls the probe back.
    #
    # `resume_versions` is probed with an INSERT rather than the no-op UPDATE the
    # other two use: the table is APPEND-ONLY and its own trigger refuses an
    # UPDATE before the entitlement guard is reached, which would have proved the
    # append-only rule twice and the gate not at all.
    probes = {
        "resume_documents":
            ("update public.resume_documents set user_id = user_id where user_id = %s",
             (user,)),
        "resume_versions":
            ("insert into public.resume_versions "
             "  (document_id, user_id, content, design, theme, content_hash) "
             "values (%s, %s, '{}'::jsonb, '{}'::jsonb, 'harvard', %s)",
             (doc["id"], user, "d" * 64)),
        "resume_artifacts":
            ("update public.resume_artifacts set user_id = user_id where user_id = %s",
             (user,)),
    }
    for table, (sql, params) in probes.items():
        as_definer(conn, user)
        verdict = guard_verdict(conn, sql, params)
        assert f"not entitled to write public.{table}" in verdict, (
            f"a SUSPENDED session was not refused AT {table}: {verdict}")
    as_authenticated(conn, user)

    # And nothing landed: the refusals are refusals, not partial writes.
    as_engine(conn)
    assert conn.execute(
        "select count(*) from public.resume_documents where user_id = %s and name = 'Sneak'",
        (user,),
    ).fetchone()[0] == 0
    assert conn.execute(
        "select count(*) from public.resume_versions where user_id = %s", (user,)
    ).fetchone()[0] == 1, "the suspended session appended to the version log"
    assert conn.execute(
        "select count(*) from public.resume_artifacts where user_id = %s", (user,)
    ).fetchone()[0] == 1, "the suspended session recorded an artifact"

    # Reactivation restores both halves — the gate is a switch, not a one-way door.
    conn.execute("select public.hq_activate_user(%s, 'reinstated')", (user,))
    as_authenticated(conn, user)
    assert conn.execute(
        "select count(*) from public.resume_documents").fetchone()[0] >= 1
    as_user(conn, user)
