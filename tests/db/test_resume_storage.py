"""The `resumes` bucket and its owner-scoped policy, actually executed (0029).

Three merged components asserted this boundary as fact and nothing created it.
`tests/core/test_migrations.py` could not have caught that: it reads SQL as text,
and text that describes a policy in a comment looks exactly like text that
creates one. So every assertion here RUNS, against `storage.objects` with RLS on,
under `set role authenticated` — because `postgres` is a superuser and a test
that forgets the role change passes with every policy dropped.

    prefix       the owner writes and reads under their own uuid, and a second
                 user is refused BOTH — with the positive control in the same
                 test, tests/db/test_rls.py's rule: "A reads 0 of B's rows" is
                 equally true when A can read nothing at all
    shape        the path rule is enforced at the STORAGE layer, not only by
                 app_record_resume_artifact — a bare filename, a foreign uuid,
                 a uuid buried mid-path and a prefix that merely starts with one
                 are each refused by the policy with the RPC nowhere in the call
    anonymous    `set role anon` matches no policy at all, in either direction
    rename       WITH CHECK on UPDATE: an object cannot be moved out of its
                 owner's prefix, which USING alone would have permitted
    entitlement  a suspended account with a live session loses its own files,
                 the storage half of what 0028 did for the artifact rows
    engine       service_role still writes — the render Lambda's path, and the
                 thing an over-tight policy would break silently

MUTATION EVIDENCE. Each policy was dropped in turn and the matching test went
red; see the PR body. `test_every_policy_on_the_resumes_bucket_carries_the_
entitlement_conjunct` re-derives the policy set from `pg_catalog` so a FIFTH
policy added later without the conjunct fails here rather than reopening the
bucket quietly.

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55505:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55505/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_resume_storage.py -q
"""
from __future__ import annotations

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
    make_user,
    schema,  # noqa: F401 — session fixture
)

BUCKET = "resumes"


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def two_users(conn):
    """Two allowlisted users, both entitled — 0027's signup trigger does that."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    return {"a": a, "b": b}


def as_engine(conn):
    """The service role: no browser identity, `bypassrls`, the render Lambda."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("set role service_role")


def as_anon(conn):
    """A caller holding the anon key and no session — no `hq.test_user` either.

    Both halves on purpose. Setting the role without clearing the identity would
    test a role that the policies exclude while `auth.uid()` still answered,
    which is not a state any real caller is in.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("set role anon")


def key(user_id: str, filename: str = "resume.pdf", artifact: int = 1) -> str:
    """The layout `artifactStoragePath()` builds, spelled once here too."""
    return f"{user_id}/{artifact}/{filename}"


def put(conn, name: str, *, bucket: str = BUCKET):
    """Write one object the way storage-api would: an INSERT under the caller."""
    return conn.execute(
        "insert into storage.objects (bucket_id, name) values (%s, %s) returning id",
        (bucket, name),
    ).fetchone()


def visible(conn, name: str) -> int:
    return conn.execute(
        "select count(*) from storage.objects where bucket_id = %s and name = %s",
        (BUCKET, name),
    ).fetchone()[0]


def seed_as_engine(conn, name: str) -> None:
    """Put an object there without going through the policy under test.

    The negative tests need a row to exist that the caller must not see, and
    creating it AS the victim would make the test depend on the insert policy to
    prove something about the read policy. `service_role` has `bypassrls`, so
    this writes the row and asserts nothing.
    """
    as_engine(conn)
    put(conn, name)


# ----------------------------------------------------------------- the owner

def test_the_owner_writes_and_reads_their_own_prefix(conn, two_users):
    a = two_users["a"]
    as_authenticated(conn, a)

    assert put(conn, key(a)) is not None
    assert visible(conn, key(a)) == 1


def test_the_owner_deletes_their_own_object(conn, two_users):
    a = two_users["a"]
    as_authenticated(conn, a)
    put(conn, key(a, "old.pdf"))

    conn.execute(
        "delete from storage.objects where bucket_id = %s and name = %s", (BUCKET, key(a, "old.pdf"))
    )
    assert visible(conn, key(a, "old.pdf")) == 0


# ------------------------------------------------------------- the second user

def test_a_second_user_is_refused_both_read_and_write(conn, two_users):
    """The whole point of the file. Positive control in the same breath."""
    a, b = two_users["a"], two_users["b"]
    seed_as_engine(conn, key(a, "private.pdf"))

    as_authenticated(conn, b)

    # Positive control FIRST: without it, "B sees 0 of A's objects" is equally
    # true when B has been refused the table outright, and the test stays green
    # with every policy dropped.
    assert put(conn, key(b, "mine.pdf")) is not None
    assert visible(conn, key(b, "mine.pdf")) == 1

    # READ refused. Not an error — RLS filters, so the row is simply not there.
    assert visible(conn, key(a, "private.pdf")) == 0

    # WRITE refused, and this one IS an error: a policy violation on INSERT.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        put(conn, key(a, "planted.pdf"))


def test_a_second_user_cannot_delete_or_rename_the_owners_object(conn, two_users):
    """Deletion and update filter rather than raise, so count the damage.

    A `delete` that matches no row is a successful statement affecting zero rows.
    Asserting "it did not raise" would assert nothing; asserting the object is
    still there is the claim that matters.
    """
    a, b = two_users["a"], two_users["b"]
    seed_as_engine(conn, key(a, "target.pdf"))

    as_authenticated(conn, b)
    cur = conn.execute(
        "delete from storage.objects where bucket_id = %s and name = %s", (BUCKET, key(a, "target.pdf"))
    )
    assert cur.rowcount == 0

    cur = conn.execute(
        "update storage.objects set name = %s where bucket_id = %s and name = %s",
        (key(b, "stolen.pdf"), BUCKET, key(a, "target.pdf")),
    )
    assert cur.rowcount == 0

    as_engine(conn)
    assert visible(conn, key(a, "target.pdf")) == 1


# ------------------------------------------------------------------ anonymous

def test_an_anonymous_caller_is_refused_both(conn, two_users):
    a = two_users["a"]
    seed_as_engine(conn, key(a, "secret.pdf"))

    as_anon(conn)
    assert visible(conn, key(a, "secret.pdf")) == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        put(conn, f"{uuid.uuid4()}/1/anon.pdf")


def test_anon_has_no_policy_on_the_bucket_at_all(conn):
    """The stronger statement, and the one a reader should be able to check.

    The test above proves anon is refused; this proves WHY — the four policies
    are `to authenticated`, so anon does not match a policy that merely evaluates
    false. A future policy added `to public` would be caught here and nowhere
    else, because it would still refuse an anon caller whose `auth.uid()` is null
    while quietly widening the role set.
    """
    roles = conn.execute(
        """select p.polname, p.polroles::regrole[]::text[]
             from pg_policy p
            where p.polrelid = 'storage.objects'::regclass
            order by p.polname"""
    ).fetchall()
    assert roles, "no policies on storage.objects — 0029 did not apply"
    for name, granted in roles:
        assert granted == ["authenticated"], (name, granted)


# ------------------------------------------------- the path shape, at the layer

@pytest.mark.parametrize(
    "make_name,why",
    [
        (lambda a, b: "resume.pdf", "a bare filename, no prefix at all"),
        (lambda a, b: f"{b}/1/resume.pdf", "another user's uuid"),
        (lambda a, b: f"renders/{a}/1/resume.pdf", "the caller's uuid, buried one level down"),
        (lambda a, b: f"{a}-archive/1/resume.pdf", "starts with the uuid but the 37th char is not /"),
        (lambda a, b: f"{a}", "the uuid alone, with no trailing slash"),
        (lambda a, b: f"{a.upper()}/1/resume.pdf", "the uuid, uppercased"),
    ],
)
def test_the_path_shape_is_enforced_at_the_storage_layer(conn, two_users, make_name, why):
    """Not by `app_record_resume_artifact`. The RPC is not in this call at all.

    That distinction is the reason 0029 exists: the RPC guards the ledger ROW,
    and a caller posting straight to /storage/v1 never touches it. Every name
    below is one the RPC would also refuse, which is the point — the two layers
    now refuse the same set, and this test proves the lower one does it alone.

    The uppercase case is not pedantry: `auth.uid()::text` renders lowercase, so
    an uppercased uuid is a DIFFERENT prefix, and a policy written with a
    case-insensitive compare would hand a user a second folder that the CHECK
    constraint on `resume_artifacts.storage_path` (`^[0-9a-f-]{36}/`) forbids —
    files with no row that can describe them.
    """
    a, b = two_users["a"], two_users["b"]
    as_authenticated(conn, a)

    # The control: the well-formed name works for this same caller, right here.
    assert put(conn, key(a, "control.pdf")) is not None

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        put(conn, make_name(a, b))


def test_an_object_cannot_be_renamed_out_of_its_owners_prefix(conn, two_users):
    """A file cannot be moved into somebody else's folder, where their own read
    policy would then serve it to them.

    WHAT THIS DOES NOT PROVE, stated because the first version of it claimed the
    opposite: it does not prove `with check` is doing the work. Dropping that
    clause from 0029 leaves this test green, because Postgres reuses an UPDATE
    policy's USING expression as its WITH CHECK when none is written. The refusal
    is real; the clause is explicitness, not the mechanism. Removing
    `resumes_update_own` altogether is the mutation that turns this red.
    """
    a, b = two_users["a"], two_users["b"]
    as_authenticated(conn, a)
    put(conn, key(a, "move-me.pdf"))

    # `InsufficientPrivilege`, not `CheckViolation`: a WITH CHECK on an RLS
    # policy raises "new row violates row-level security policy", which is 42501
    # like every other policy refusal. A table CHECK constraint would be 23514.
    # Worth naming, because the wrong expectation here is a test that passes on
    # the right error for the wrong reason.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "update storage.objects set name = %s where bucket_id = %s and name = %s",
            (key(b, "move-me.pdf"), BUCKET, key(a, "move-me.pdf")),
        )


# ---------------------------------------------------------------- entitlement

def test_a_suspended_account_loses_its_own_stored_files(conn, two_users):
    """0028 did this for the artifact ROWS; a boundary that stops at the index
    and serves the document is not a boundary. The JWT does not expire when the
    operator flips the switch, so the session below is exactly the real one."""
    a = two_users["a"]
    as_authenticated(conn, a)
    put(conn, key(a, "still-mine.pdf"))
    assert visible(conn, key(a, "still-mine.pdf")) == 1  # the positive control

    # The operator acts, and the operator is not this browser session. `reset
    # role` alone leaves `hq.test_user` set, so `hq_entitlement_guard` reads the
    # suspension's own audit INSERT as a write by the account being suspended and
    # refuses it — the guard working correctly on a fixture holding it wrong.
    as_engine(conn)
    conn.execute("reset role")
    conn.execute("select public.hq_suspend_user(%s, 'test')", (a,))

    as_authenticated(conn, a)
    assert visible(conn, key(a, "still-mine.pdf")) == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        put(conn, key(a, "after-suspension.pdf"))


def test_a_pending_account_never_had_them(conn):
    """The uninvited signup: an account exists, is not turned on, and reaches
    nothing. 0027's front door creates it `pending`, so no operator action is
    needed to produce this state — it is the default one."""
    uid = str(uuid.uuid4())
    conn.execute("reset role")
    conn.execute(
        "insert into auth.users (id, email) values (%s, %s)", (uid, f"{uuid.uuid4()}@stranger.test")
    )
    status = conn.execute(
        "select status from public.entitlements where user_id = %s", (uid,)
    ).fetchone()[0]
    assert status == "pending", "0027's front door changed; this test is testing the wrong state"

    as_authenticated(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        put(conn, key(uid))


def test_every_policy_on_the_resumes_bucket_carries_the_entitlement_conjunct(conn):
    """The cost of choosing a conjunct over 0028's restrictive policy, paid here.

    A restrictive policy is ANDed with policies that do not exist yet; a conjunct
    is not, so a fifth policy written next quarter without it reopens the bucket
    for suspended accounts. The set is re-derived from `pg_catalog` rather than
    listed, for the reason 0028's own test gives: a human list is what goes stale.
    """
    rows = conn.execute(
        """select p.polname,
                  pg_get_expr(p.polqual, p.polrelid)      as using_expr,
                  pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
             from pg_policy p
            where p.polrelid = 'storage.objects'::regclass
            order by p.polname"""
    ).fetchall()
    assert len(rows) == 4, [r[0] for r in rows]

    for name, using_expr, check_expr in rows:
        for label, expr in (("using", using_expr), ("with check", check_expr)):
            if expr is None:
                continue
            assert "'resumes'" in expr, f"{name} {label} is not scoped to the bucket: {expr}"
            assert "hq_is_entitled" in expr, f"{name} {label} skips the entitlement gate: {expr}"
            assert "uid()" in expr, f"{name} {label} does not scope to the caller: {expr}"

    # Names, so the mutation experiments in the PR body point at something real.
    assert [r[0] for r in rows] == [
        "resumes_delete_own",
        "resumes_insert_own",
        "resumes_read_own",
        "resumes_update_own",
    ]


# --------------------------------------------------------------- the engine

def test_the_service_role_still_writes(conn, two_users):
    """The render Lambda stores a PDF on a user's behalf and has no `auth.uid()`.

    `service_role` holds `bypassrls`, the same hatch `hq_entitlement_guard` opens
    for the engine. Asserted rather than assumed, because the failure mode of an
    over-tight storage policy is a render that produces bytes nobody can store —
    silent, and only visible when a user asks where their PDF went.
    """
    a = two_users["a"]
    as_engine(conn)
    assert put(conn, key(a, "rendered.pdf")) is not None
    assert visible(conn, key(a, "rendered.pdf")) == 1


# ----------------------------------------------------------------- the bucket

def test_the_bucket_exists_and_is_private(conn):
    """Configuration, not enforcement — and the difference is the whole comment.

    `public = false` is what withholds the unauthenticated `/object/public/…`
    route, and STORAGE-API is what reads it. Postgres cannot demonstrate that
    here. What this asserts is that the migration wrote the value, so a fresh
    project provisions private instead of depending on somebody remembering a
    dashboard toggle.
    """
    row = conn.execute(
        "select public, file_size_limit, allowed_mime_types from storage.buckets where id = %s",
        (BUCKET,),
    ).fetchone()
    assert row is not None, "0029 did not create the bucket"
    is_public, size_limit, mimes = row
    assert is_public is False
    assert size_limit == 10485760
    assert "application/pdf" in mimes


def test_row_level_security_is_on(conn):
    """The stub shipped with RLS off for a release. Without this, every negative
    above would be a statement about a table nobody had locked."""
    assert conn.execute(
        "select relrowsecurity from pg_class where oid = 'storage.objects'::regclass"
    ).fetchone()[0] is True
