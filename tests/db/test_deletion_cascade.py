"""What `delete from auth.users` ACTUALLY does today — the groundwork for #204.

No deletion flow exists yet; the settings controls are deliberately inert
(`webapp/app/(app)/settings/data/page.tsx` says so beside them). Before one is
designed, the design has to start from measured behaviour rather than from the
issue's beliefs about the schema — and one of those beliefs is wrong in a way
that changes the design (see the self-reference test below). Everything here
pins CURRENT behaviour: when #204's deletion path lands, the tests that pin a
gap (the pseudonymization refusals, the surviving storage row) are the ones it
must revise — deliberately, with the owner ruling from
`docs/pilot-launch/21-deletion-owner-rulings.md` cited in the diff.

What this file proves, each with a fully-populated account (a row in every
user-owned table pg_catalog knows about, so a table added next month cannot
sit outside the proof silently):

  1. One `auth.users` delete empties EVERY user-owned product table — including
     the autopilot audit trail and a class-1 provider receipt, because
     `hq_autopilot_committed_stages_are_kept` steps aside once the owner row is
     gone ("The owner's erasure takes everything, as it must").
  2. The user's `events` rows go with the account, so deletion itself cannot be
     audited by the mechanism the contract assumes audits everything (#204's
     ledger exists precisely because of this).
  3. Exactly two row classes survive, found by sweeping every table for the
     account's identifiers rather than by trusting a list: the `allowed_emails`
     invite row (the email — PII) and the `storage.objects` row under the
     user's prefix (the résumé object — PII, now orphaned: nothing in `public`
     names it anymore).
  4. The two no-cascade FKs (`approved_by`, `actor_user_id` —
     `20260802_094615_autopilot_staging.sql`) block a hard delete ONLY when the
     reference is cross-account, and the block is atomic: the account comes out
     fully alive, not half-deleted. A self-reference — the only shape any
     shipped write path can produce, since approving is owner-only and the
     ownership guard refuses cross-account transitions — cascades away in the
     same statement and does not block. The issue text believed otherwise.
  5. The contract's pseudonymize-within-30-days step (contract v2 §8) cannot be
     a plain UPDATE today: the state machine refuses `approved_by := null` and
     the append-only trail refuses `actor_user_id := null`. The deletion path
     needs a migration-level carve-out, which is an owner ruling, not a patch.

A second fully-populated account rides through every destructive test as the
isolation control: its per-table counts are snapshotted before and compared
exactly after.

Run it the way the rest of this directory runs:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_deletion_cascade.py -q
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
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


# ══════════════════════════════════════════════════════════════════ the harness

def _system(conn) -> None:
    """The operator lane: superuser role, no browser identity."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


def _as(conn, uid: str) -> None:
    """A browser session for `uid`, under the `authenticated` role."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(uid),))
    conn.execute("set role authenticated")


def refusal(exc) -> str:
    """The database's own message — `str(exc)` appends CONTEXT, which echoes the
    failing SQL and matches the wrong substring (test_autopilot_staging.py's
    lesson, kept)."""
    return (exc.value.diag.message_primary or "") if exc.value.diag else ""


def user_owned_tables(conn) -> list[str]:
    """Every table in `public` with a `user_id` column, out of pg_catalog.

    Derived rather than listed, for `test_default_deny.py`'s reason: the table
    somebody adds in six weeks must be inside this proof on the day it is
    written, or the fixture sanity test below goes red and names it.
    """
    return [
        r[0]
        for r in conn.execute(
            """
            select c.relname
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'
               and exists (select 1 from pg_attribute a
                            where a.attrelid = c.oid and a.attname = 'user_id'
                              and not a.attisdropped)
             order by 1"""
        ).fetchall()
    ]


def counts_for(conn, uid: str) -> dict[str, int]:
    """Rows this account owns, per table — plus the three identity/storage rows
    that are keyed differently."""
    _system(conn)
    out = {
        t: conn.execute(
            f"select count(*) from public.{t} where user_id = %s", (uid,)
        ).fetchone()[0]
        for t in user_owned_tables(conn)
    }
    out["users"] = conn.execute(
        "select count(*) from public.users where id = %s", (uid,)).fetchone()[0]
    out["auth.users"] = conn.execute(
        "select count(*) from auth.users where id = %s", (uid,)).fetchone()[0]
    out["storage.objects"] = conn.execute(
        "select count(*) from storage.objects where owner = %s::uuid", (uid,)
    ).fetchone()[0]
    return out


def all_tables(conn) -> list[tuple[str, str]]:
    """`(schema, table)` for every ordinary table in public, auth and storage."""
    return [
        (r[0], r[1])
        for r in conn.execute(
            """
            select n.nspname, c.relname
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname in ('public', 'auth', 'storage') and c.relkind = 'r'
             order by 1, 2"""
        ).fetchall()
    ]


def tables_mentioning(conn, needle: str) -> dict[str, int]:
    """Every table holding a row whose TEXT RENDERING contains `needle`.

    This is the sweep that makes "what survives" an exact answer in both
    directions: it does not trust anyone's idea of which columns can carry an
    identifier — it renders whole rows and looks. A surviving row class nobody
    predicted shows up here by name.
    """
    _system(conn)
    out: dict[str, int] = {}
    for schema_name, table in all_tables(conn):
        n = conn.execute(
            f"select count(*) from {schema_name}.{table} t "
            "where position(%s in lower(t::text)) > 0",
            (needle.lower(),),
        ).fetchone()[0]
        if n:
            out[f"{schema_name}.{table}"] = n
    return out


def full_user(conn, tag: str) -> dict:
    """One account with a row in EVERY user-owned table the schema has today.

    Signup runs the real trigger (`make_user`), the application and its event
    come from the real triage gesture, and the autopilot chain is driven through
    the shipped RPCs as the owner's browser session — so the approval and the
    audit trail carry exactly the self-references the product actually writes
    (`approved_by` = the owner, `actor_user_id` = the owner). Everything else is
    operator-lane inserts, which face the same constraints and triggers any
    engine writer faces.

    `test_the_fixture_reaches_every_user_owned_table` is the sanity floor: a new
    user-owned table makes it fail until this fixture learns the table.
    """
    _system(conn)
    uid = make_user(conn, f"{tag}-{uuid.uuid4()}@example.com")
    email = conn.execute(
        "select email from public.users where id = %s", (uid,)).fetchone()[0]

    # ---- shared catalog rows the account hangs off
    key = f"gh-{uuid.uuid4().hex[:10]}"
    make_posting(conn, key, "CascadeCo")
    company_id = conn.execute(
        "insert into public.companies (name, ats, slug) values (%s, 'greenhouse', %s) "
        "returning id",
        (f"Co-{uuid.uuid4().hex[:8]}", f"co-{uuid.uuid4().hex[:8]}"),
    ).fetchone()[0]
    conn.execute(
        "insert into public.user_companies (user_id, company_id) values (%s, %s)",
        (uid, company_id))
    conn.execute(
        "insert into public.user_postings (user_id, posting_key, disposition) "
        "values (%s, %s, 'qualified')", (uid, key))

    # ---- the real triage gesture: an application, an events row, idempotency
    _as(conn, uid)
    conn.execute(
        "select public.app_set_triage(%s, 'interested', null, '', %s, null)",
        (key, str(uuid.uuid4())))
    _system(conn)
    app_id = conn.execute(
        "select id from public.applications where user_id = %s", (uid,)).fetchone()[0]

    conn.execute("insert into public.profiles (user_id) values (%s)", (uid,))
    conn.execute(
        "insert into public.answers (user_id, question, answer) values (%s, 'q', 'a')",
        (uid,))
    conn.execute(
        "insert into public.answer_policies (user_id, topic, fact) "
        """values (%s, 'relocation', '{"kind": "boolean", "value": true}'::jsonb)""",
        (uid,))
    conn.execute(
        "insert into public.application_notes (user_id, application_id, body) "
        "values (%s, %s, 'note')", (uid, app_id))
    conn.execute("insert into public.saved_views (user_id, name) values (%s, 'v')", (uid,))
    conn.execute(
        "insert into public.connections (user_id, full_name) values (%s, 'A Person')",
        (uid,))
    conn.execute("insert into public.warm_searches (user_id) values (%s)", (uid,))
    conn.execute(
        "insert into public.warm_pins (user_id, full_name) values (%s, 'B Person')",
        (uid,))
    conn.execute(
        "insert into public.email_events (user_id, event_id) values (%s, %s)",
        (uid, f"<{uuid.uuid4()}@mail.example>"))
    conn.execute(
        "insert into public.capture_tokens (user_id, selector, secret_sha256) "
        "values (%s, %s, %s)",
        (uid, secrets.token_hex(8), hashlib.sha256(b"not-a-real-secret").hexdigest()))
    batch_id = conn.execute(
        "insert into public.import_batches (user_id, source_kind, idempotency_key) "
        "values (%s, 'csv', %s) returning id", (uid, str(uuid.uuid4()))).fetchone()[0]
    conn.execute(
        "insert into public.import_rows (batch_id, user_id, row_number, raw) "
        "values (%s, %s, 1, '{}'::jsonb)", (batch_id, uid))
    conn.execute(
        "insert into public.import_column_reports "
        "(batch_id, user_id, column_name, disposition) "
        "values (%s, %s, 'Company', 'imported')", (batch_id, uid))
    conn.execute("insert into public.monitor_sweep_state (user_id) values (%s)", (uid,))
    conn.execute(
        "insert into public.engine_cursors (user_id, lane) values (%s, 'wide_cafe')",
        (uid,))
    conn.execute(
        "insert into public.notification_outbox (user_id, dedupe_key, event) "
        "values (%s, %s, 'digest')", (uid, str(uuid.uuid4())))
    conn.execute(
        "insert into public.channel_runs (user_id, channel) values (%s, 'monitor')",
        (uid,))
    conn.execute(
        "insert into public.bot_runs (user_id, job) values (%s, 'discovery')", (uid,))

    # ---- résumé chain, through to the storage row the bucket policies govern
    doc_id = conn.execute(
        "insert into public.resume_documents (user_id, name) values (%s, 'Resume') "
        "returning id", (uid,)).fetchone()[0]
    body = b"pdf-bytes"
    sha = hashlib.sha256(body + uuid.uuid4().bytes).hexdigest()
    conn.execute(
        "insert into public.resume_versions "
        "(document_id, user_id, content, design, theme, content_hash) "
        "values (%s, %s, '{}'::jsonb, '{}'::jsonb, 'classic', %s)", (doc_id, uid, sha))
    storage_path = f"{uid}/{uuid.uuid4()}/resume.pdf"
    art_id = conn.execute(
        "insert into public.resume_artifacts "
        "(user_id, origin, kind, storage_path, filename, byte_size, sha256, retention) "
        "values (%s, 'uploaded', 'pdf', %s, 'resume.pdf', %s, %s, 'permanent') "
        "returning id", (uid, storage_path, len(body), sha)).fetchone()[0]
    conn.execute(
        "insert into storage.objects (bucket_id, name, owner) values ('resumes', %s, %s)",
        (storage_path, uid))

    # ---- autopilot, all the way to a submitting stage holding a class-1 receipt,
    # driven exactly the way the product drives it
    _as(conn, uid)
    r = conn.execute(
        "select public.app_stage_autopilot_application("
        "  %s, 'greenhouse', 'v1', 'board-1', 'sch-1', %s::jsonb, %s::jsonb, "
        "  '{}'::jsonb, '[]'::jsonb, 'ready_for_review', '', %s, null)",
        (app_id, json.dumps({"first_name": "A"}),
         json.dumps([{"artifactId": art_id, "sha256": sha,
                      "filename": "resume.pdf", "kind": "pdf"}]),
         str(uuid.uuid4()))).fetchone()[0]
    stage_id = r["stage"]["id"]
    conn.execute(
        "select public.app_review_autopilot_stage(%s, 'approve', %s, '', %s, null)",
        (stage_id, r["stage"]["packageHash"], str(uuid.uuid4())))
    _system(conn)
    conn.execute(
        "update public.autopilot_stages "
        "   set state = 'submitting', transition_reason = 'executor start' "
        " where id = %s", (stage_id,))
    conn.execute(
        "insert into public.autopilot_receipts "
        "(user_id, stage_id, evidence_class, provider_reference, evidence) "
        "values (%s, %s, 1, %s, '{}'::jsonb)",
        (uid, stage_id, f"GH-{uuid.uuid4().hex[:10]}"))

    return {"uid": uid, "email": email, "app": app_id, "stage": stage_id,
            "posting": key, "company": company_id, "storage_path": storage_path}


def hard_delete(conn, uid: str) -> None:
    """The operation #204 will eventually perform last: the auth-provider row
    goes, and everything else is whatever the schema does about it."""
    _system(conn)
    conn.execute("delete from auth.users where id = %s", (uid,))


# ══════════════════════════════════════════════════════════ the sanity floor

def test_the_fixture_reaches_every_user_owned_table(conn):
    """A cascade proof over an unpopulated table proves nothing about it.

    Exhaustive by construction: the table list comes out of pg_catalog, so a
    migration adding a user-owned table turns this red until `full_user` learns
    to populate it — which is what keeps the cascade map below honest as the
    schema grows.

    KILLED BY: deleting any populate statement from `full_user`, or a new
    migration shipping a user-owned table this fixture has never heard of.
    """
    a = full_user(conn, "floor")
    tables = user_owned_tables(conn)
    assert len(tables) >= 30, tables          # the schema this file was written against
    counts = counts_for(conn, a["uid"])
    empty = sorted(t for t in tables if counts[t] == 0)
    assert not empty, (
        "user-owned tables the fixture did not reach — the cascade proof is "
        f"silent about these: {empty}"
    )
    # Named anchors, so the catalog query failing over to the wrong schema shows
    # up as a missing name rather than as a quietly smaller set.
    for anchor in ("applications", "events", "autopilot_receipts", "capture_tokens",
                   "entitlements", "resume_artifacts", "notification_outbox"):
        assert anchor in tables, tables


# ═══════════════════════════════════════════ the cascade, measured end to end

def test_a_hard_delete_empties_every_user_owned_table(conn):
    """One `auth.users` delete, and every product row the account owned is gone
    — including the autopilot stage, its audit trail, and its class-1 provider
    receipt, because `hq_autopilot_committed_stages_are_kept` steps aside once
    the owner row is gone. A second fully-populated account is untouched.

    Three findings for #204's design, pinned here:

      * `entitlements` goes with the account, so "removed" IS row absence —
        exactly the shape `docs/specs/user-entitlement.md`'s three-status
        invariant and denial matrix already treat as removed. No fourth status
        exists or is needed (owner ruling (a)).
      * The receipt and trail are ERASED, not retained: contract v2 §8's
        "retain minimum security record 90 days" has no mechanism today
        (owner ruling (c)).
      * `capture_tokens` rows vanish rather than being revoked — the credential
        dies by row absence, with no `revoked_at` audit that it did.

    KILLED BY: pointing any user-owned table's FK chain away from
    `public.users`, or dropping `on delete cascade` from any of them — the
    orphaned rows then show up in the post-delete counts (or the delete blocks).
    """
    a = full_user(conn, "erase")
    b = full_user(conn, "bystander")

    before_a = counts_for(conn, a["uid"])
    before_b = counts_for(conn, b["uid"])
    assert all(before_a[t] > 0 for t in user_owned_tables(conn))
    assert before_a["autopilot_receipts"] == 1     # provider evidence, present

    hard_delete(conn, a["uid"])

    after_a = counts_for(conn, a["uid"])
    survivors = {t: n for t, n in after_a.items() if n}
    # storage.objects is asserted BY NAME in the survivor test below; here the
    # claim is that nothing else — no product table, no identity row — kept
    # anything for the deleted account.
    assert survivors == {"storage.objects": 1}, survivors
    assert after_a["entitlements"] == 0            # "removed" is row absence
    assert after_a["autopilot_receipts"] == 0      # provider evidence, erased
    assert after_a["capture_tokens"] == 0          # credential dead by absence

    # The bystander's account is byte-for-byte where it was, table by table.
    assert counts_for(conn, b["uid"]) == before_b


def test_the_deletion_itself_cannot_be_audited_by_events(conn):
    """`events` is the audit ledger everywhere else in this schema, and it
    cascades away with its owner — so the one lifecycle change `events` cannot
    record is the account's own deletion. This is the measured fact behind
    #204's deletion ledger (owner ruling (b)): FP-ID-006's "audited" cannot be
    satisfied by `events` for this operation, and the user-entitlement spec's
    "every lifecycle change is an events row" invariant is unsatisfiable for it.

    The shared row (`user_id is null` — the engine's lane) survives, which is
    the positive control: the cascade took the user's history, not the table.

    KILLED BY: dropping `on delete cascade` from `events.user_id` — the user's
    rows would then survive and the zero-count assertion fails (as does the
    FK itself, differently).
    """
    a = full_user(conn, "audit")
    _system(conn)
    events_before = conn.execute(
        "select count(*) from public.events where user_id = %s", (a["uid"],)
    ).fetchone()[0]
    assert events_before > 0                       # the trail existed
    shared_id = conn.execute(
        "insert into public.events (user_id, kind, actor) "
        "values (null, 'bot.closed', 'system') returning id"
    ).fetchone()[0]

    hard_delete(conn, a["uid"])

    assert conn.execute(
        "select count(*) from public.events where user_id = %s", (a["uid"],)
    ).fetchone()[0] == 0
    assert conn.execute(
        "select count(*) from public.events where id = %s", (shared_id,)
    ).fetchone()[0] == 1


def test_what_survives_is_exactly_the_invite_row_and_the_storage_object(conn):
    """Every table in public/auth/storage, swept for the account's identifiers
    AFTER the delete — rows rendered whole, so a column nobody thought of
    cannot hide a survivor. Exact in both directions, like the exemption lists
    in test_default_deny.py: a new survivor class fails this test by name, and
    a survivor that stops surviving fails it too.

    The two survivors, and why each matters to #204:

      * `public.allowed_emails` still holds the EMAIL. The invite list is
        operator-owned and browser-invisible, but it is PII that outlives the
        account, and it is also what would re-activate a same-email re-signup
        instantly. Whether it should survive is owner ruling territory, not an
        accident to preserve.
      * `storage.objects` still holds the résumé object row under the user's
        prefix — and the `resume_artifacts` row that named it is gone, so the
        object is now ORPHANED: unreachable through any product surface,
        undeletable through any product surface, bytes still in the bucket.
        This proves the harness half (the DB cascade does not reach
        `storage.objects`); that the hosted service keeps the S3 bytes too is
        Supabase behaviour, unverifiable locally — the production check is in
        docs/pilot-launch/21-deletion-owner-rulings.md §(d).

    KILLED BY: teaching the deletion path to purge either row without updating
    this test — which is exactly the conversation the test exists to force.
    """
    a = full_user(conn, "survive")

    hard_delete(conn, a["uid"])

    assert tables_mentioning(conn, a["uid"]) == {"storage.objects": 1}
    assert tables_mentioning(conn, a["email"]) == {"public.allowed_emails": 1}

    # The surviving object row is orphaned: the pointer row cascaded away.
    _system(conn)
    assert conn.execute(
        "select count(*) from public.resume_artifacts where storage_path = %s",
        (a["storage_path"],)).fetchone()[0] == 0
    assert conn.execute(
        "select count(*) from storage.objects where bucket_id = 'resumes' and name = %s",
        (a["storage_path"],)).fetchone()[0] == 1

    # Shared catalog rows are not the account's data and stay: the posting and
    # company it watched serve every other account.
    assert conn.execute(
        "select count(*) from public.postings where key = %s", (a["posting"],)
    ).fetchone()[0] == 1
    assert conn.execute(
        "select count(*) from public.companies where id = %s", (a["company"],)
    ).fetchone()[0] == 1


# ═══════════════════════════ the two no-cascade FKs, same-account and cross-account

def test_a_self_referencing_approval_does_not_block_the_delete(conn):
    """The issue text says "a hard delete of a user who ever approved or acted
    on a submission will fail on those FKs". MEASURED: it does not — not for
    the only reference shape any shipped write path can produce.

    Approving is owner-only (`app_review_autopilot_stage` refuses another
    account's stage) and the ownership guard refuses cross-account transitions,
    so today `approved_by` and `actor_user_id` always equal the row's own
    `user_id`. Both FKs are plain NO ACTION, checked at end of statement — and
    by then the referencing rows have cascaded away with the same account. The
    fixture's user has an approved-then-submitting stage (approved_by = self)
    and a user-actor audit trail (actor_user_id = self), and the delete
    SUCCEEDS.

    Design consequence for #204: the pseudonymization step exists for restored
    or cross-account rows, not for the ordinary account — ordinary deletion
    never trips these FKs. The counterexample lives in the two tests below:
    make the reference cross-account and the same statement is refused.

    KILLED BY: changing either FK to RESTRICT — the check then runs before the
    cascade and every populated account becomes undeletable, which is precisely
    the difference between RESTRICT and NO ACTION this test documents.
    """
    a = full_user(conn, "selfref")
    _system(conn)
    approved_by, = conn.execute(
        "select approved_by from public.autopilot_stages where id = %s",
        (a["stage"],)).fetchone()
    assert str(approved_by) == a["uid"]            # the reference is real and self
    assert conn.execute(
        "select count(*) from public.autopilot_transitions "
        " where stage_id = %s and actor_user_id = %s", (a["stage"], a["uid"])
    ).fetchone()[0] > 0

    hard_delete(conn, a["uid"])                    # no raise — the finding

    assert counts_for(conn, a["uid"])["auth.users"] == 0


def test_a_cross_account_approval_reference_blocks_the_whole_delete(conn):
    """`approved_by` pointing at ANOTHER account is the shape the FK comment
    wrote itself for ("must not be erasable by deleting some other account"),
    and no shipped write path produces it — so it is manufactured here the way
    it would actually arrive: as restored/legacy data, written with the state
    machine trigger off (the same manufacture test_autopilot_staging.py uses
    for pre-rule rows).

    Two facts, both load-bearing for #204:

      * The delete is REFUSED with the FK's own name — so a deletion flow that
        reaches the `auth.users` delete with such a reference standing does not
        half-delete anything…
      * …because the refusal is ATOMIC: every one of the account's rows is
        still there afterwards, counts identical. The failure mode is "fully
        alive", never "looks deleted, is not".

    The counterexample is in-test: point the approval back at the stage's own
    owner (the safe mutation — deleting the blocking reference) and the same
    delete goes green.

    KILLED BY: adding `on delete cascade` or `set null` to `approved_by` — the
    blocked case then succeeds and the ForeignKeyViolation never raises.
    """
    victim = full_user(conn, "approver")
    holder = full_user(conn, "holder")

    _system(conn)
    conn.execute("alter table public.autopilot_stages "
                 "disable trigger autopilot_stages_state_machine")
    try:
        conn.execute(
            "update public.autopilot_stages set approved_by = %s where id = %s",
            (victim["uid"], holder["stage"]))
    finally:
        conn.execute("alter table public.autopilot_stages "
                     "enable trigger autopilot_stages_state_machine")

    before = counts_for(conn, victim["uid"])
    with pytest.raises(psycopg.errors.ForeignKeyViolation) as exc:
        hard_delete(conn, victim["uid"])
    assert (exc.value.diag.constraint_name or "") == "autopilot_stages_approved_by_fkey"

    # Atomic: the blocked account is fully alive, not half-deleted.
    assert counts_for(conn, victim["uid"]) == before
    assert before["auth.users"] == 1

    # The counterexample: clear the cross-account reference, the block lifts.
    conn.execute("alter table public.autopilot_stages "
                 "disable trigger autopilot_stages_state_machine")
    try:
        conn.execute(
            "update public.autopilot_stages set approved_by = %s where id = %s",
            (holder["uid"], holder["stage"]))
    finally:
        conn.execute("alter table public.autopilot_stages "
                     "enable trigger autopilot_stages_state_machine")
    hard_delete(conn, victim["uid"])               # now succeeds
    assert counts_for(conn, victim["uid"])["auth.users"] == 0


def test_a_cross_account_actor_reference_blocks_the_whole_delete(conn):
    """The trail's `actor_user_id`, same shape: a cross-account reference can
    only arrive as restored/legacy data (the audit trigger derives the actor
    from `auth.uid()`, and the ownership guard refuses a session writing
    another account's rows), and once it exists the referenced account cannot
    be hard-deleted while the trail row's own account lives.

    The manufacture is a direct operator-lane insert — the trail refuses
    UPDATE and DELETE, not INSERT, because the audit trigger is its writer.
    The counterexample removes the manufactured row with the append-only
    trigger off, which is itself part of the evidence: nothing short of a
    schema-level carve-out can clear such a reference (see the refusal test
    below).

    KILLED BY: adding `on delete cascade`/`set null` to `actor_user_id`.
    """
    victim = full_user(conn, "actor")
    holder = full_user(conn, "trailholder")

    _system(conn)
    conn.execute(
        "insert into public.autopilot_transitions "
        "(user_id, stage_id, from_state, to_state, actor, actor_user_id, package_hash) "
        "values (%s, %s, 'submitting', 'outcome_unknown', 'user', %s, '')",
        (holder["uid"], holder["stage"], victim["uid"]))

    before = counts_for(conn, victim["uid"])
    with pytest.raises(psycopg.errors.ForeignKeyViolation) as exc:
        hard_delete(conn, victim["uid"])
    assert (exc.value.diag.constraint_name or "") == \
        "autopilot_transitions_actor_user_id_fkey"
    assert counts_for(conn, victim["uid"]) == before

    # Counterexample: the blocking row goes (append-only trigger off — the only
    # way, which is the point), and the same delete goes green.
    conn.execute("alter table public.autopilot_transitions "
                 "disable trigger autopilot_transitions_append_only")
    try:
        conn.execute(
            "delete from public.autopilot_transitions "
            " where stage_id = %s and actor_user_id = %s",
            (holder["stage"], victim["uid"]))
    finally:
        conn.execute("alter table public.autopilot_transitions "
                     "enable trigger autopilot_transitions_append_only")
    hard_delete(conn, victim["uid"])
    assert counts_for(conn, victim["uid"])["auth.users"] == 0


def test_pseudonymizing_the_evidence_references_is_refused_today(conn):
    """Contract v2 §8 says submission receipts/audit records are pseudonymized
    within 30 days of a verified deletion request. MEASURED: both writes that
    step would perform are refused by shipped triggers, by design —

      * `approved_by := null` on a stage that is not changing state is "an
        approval is a transition, not a field edit" (the state machine);
      * `actor_user_id := null` on a trail row is "append-only evidence" (the
        trail trigger), while the stage's owner lives.

    So #204's pseudonymization step cannot be an UPDATE anyone can run today —
    it requires a migration-level carve-out, and the shape of that carve-out
    (what may be nulled, by whom, leaving what behind) is owner ruling (c) in
    docs/pilot-launch/21-deletion-owner-rulings.md. When that carve-out lands,
    THIS test is the one it must revise, citing the ruling.

    Driven from the operator lane — the most privileged non-superuser-hostile
    writer a deletion job could realistically run as. The positive control is
    the pair of cross-account tests above: the references are real, the FKs
    fire, and yet the references cannot be cleared.

    KILLED BY: shipping the carve-out (intended), or deleting either guard
    branch from the autopilot migration (the erasure hole the guards exist for).
    """
    a = full_user(conn, "pseudo")
    _system(conn)

    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "update public.autopilot_stages set approved_by = null where id = %s",
            (a["stage"],))
    assert "an approval is a transition, not a field edit" in refusal(exc), exc.value

    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "update public.autopilot_transitions set actor_user_id = null "
            " where stage_id = %s", (a["stage"],))
    assert "append-only evidence" in refusal(exc), exc.value

    # Still standing after both refusals: the references, and the account.
    row = conn.execute(
        "select approved_by from public.autopilot_stages where id = %s",
        (a["stage"],)).fetchone()
    assert str(row[0]) == a["uid"]
