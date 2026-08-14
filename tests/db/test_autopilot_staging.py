"""Autopilot staging, executed against Postgres.

`tests/core/test_migrations.py` reads this migration as text — it catches an
unpinned `search_path`, a definer taking a `p_user_id`, a missing revoke. It
cannot catch a state machine that lets `outcome_unknown` back into `submitting`.
Everything here RUNS, and every guard in the migration has a test here plus a
MUTATION that shows the test going red when the guard is removed.

WHAT IS BEING PROVEN, in the order the sections appear:

    the package hash   is generated, unforgeable, and covers exactly the seven
                       package columns and nothing else
    transitions        every one of the 144 (state, state) pairs is driven, and
                       the legal set is exactly the declared one
    approval integrity a package cannot change between approval and submission,
                       and an approval taken against an older package is refused
    outcome_unknown    has two exits, neither of which is a retry, and a retry
                       stage cannot even be CREATED while it stands
    duplicates         one live attempt per application, keyed on the durable row
    authority          wrong owner, suspended account, anonymous session
    idempotency        replay returns the first answer; a reused key with a
                       different payload is refused
    concurrency        a stale `updated_at` is a 40001
    sensitive answers  an inferred work-authorization answer is refused by the
                       database, for every writer
    the trail          every transition is recorded with a server-derived actor,
                       and the trail cannot be rewritten

A CAUTION THAT COST TIME ELSEWHERE IN THIS SESSION: several of these RPCs also
write `public.events`, which is already entitlement-gated. A refusal assertion
that only checks "it raised" can therefore pass on the WRONG mechanism. Every
refusal below is asserted against the message naming `autopilot_stages`, or
against a state the wrong mechanism could not have produced.

Run it the way the rest of this directory runs:

    scripts/verify.sh --image db/migrations tests/db
"""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path

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

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = next((ROOT / "db" / "migrations").glob("*_autopilot_staging.sql"))

#: The handoff migration (#206) `create or replace`s several of this file's
#: functions — the states, the transition map, the state machine, two RPCs — so
#: a `_restore` that re-applied THIS migration alone would revert them to their
#: eleven-state versions and every later test would run against a schema
#: production will never have. Both files, in filename order, are the unit of
#: restoration.
AUTOPILOT_MIGRATIONS = sorted(
    p for p in (ROOT / "db" / "migrations").glob("*.sql")
    if p.name.endswith("_autopilot_staging.sql") or p.name.endswith("_autopilot_handoff.sql")
)

STATES = [
    "preparing", "needs_input", "ready_for_review", "changes_requested",
    "approved", "submitting", "submitted", "outcome_unknown",
    "failed_retryable", "failed_terminal", "cancelled", "handed_off",
]

#: The transition table, restated INDEPENDENTLY of the SQL.
#:
#: Copying `hq_autopilot_transition_allowed`'s array out of the migration would
#: make this file a mirror rather than a check: a mutation to the SQL would be
#: matched by the same mutation here and nothing would fail. So this is written
#: from the two packet documents (06's preparation table, 07's execution table)
#: plus the work packet and the handoff spec (#206), and the test below drives all
#: 144 pairs against the
#: database and asserts the two sets are equal.
LEGAL: set[tuple[str, str]] = {
    ("preparing", "needs_input"), ("preparing", "ready_for_review"),
    ("preparing", "cancelled"),
    ("needs_input", "preparing"), ("needs_input", "ready_for_review"),
    ("needs_input", "cancelled"),
    ("ready_for_review", "preparing"), ("ready_for_review", "needs_input"),
    ("ready_for_review", "changes_requested"), ("ready_for_review", "approved"),
    ("ready_for_review", "cancelled"),
    ("changes_requested", "preparing"), ("changes_requested", "needs_input"),
    ("changes_requested", "ready_for_review"), ("changes_requested", "cancelled"),
    ("approved", "submitting"), ("approved", "changes_requested"),
    ("approved", "ready_for_review"), ("approved", "cancelled"),
    # The manual-handoff terminus (#206): the user submitted the approved
    # package themselves and said so. handed_off appears on the LEFT zero times.
    ("approved", "handed_off"),
    ("submitting", "submitted"), ("submitting", "outcome_unknown"),
    ("submitting", "failed_retryable"), ("submitting", "failed_terminal"),
    ("submitting", "cancelled"),
    ("outcome_unknown", "submitted"), ("outcome_unknown", "failed_terminal"),
    ("failed_retryable", "approved"), ("failed_retryable", "changes_requested"),
    ("failed_retryable", "ready_for_review"), ("failed_retryable", "cancelled"),
}


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


# ══════════════════════════════════════════════════════════════════ the harness

def refusal(exc) -> str:
    """The database's OWN message, with nothing psycopg added around it.

    `str(psycopg_error)` is not evidence about which check fired. It appends the
    server's `CONTEXT:` block, and that block echoes the failing SQL — so inside a
    definer RPC it carries the RPC's `insert into public.autopilot_stages …`
    verbatim. Review T3/B4 proved the cost: with ONLY
    `autopilot_stages_entitlement_guard` dropped, the refusal came from the
    neighbouring `autopilot_transitions` and

        message_primary = 'account … is not entitled to write public.autopilot_transitions'
        "autopilot_stages" in str(exc.value)  →  True

    because the CONTEXT echoed the statement, not the message. Every assertion in
    this file that is about WHICH GUARD ANSWERED reads `diag.message_primary`.

    The two deliberate exceptions are the LEAK assertions — "the value is not in
    the exception" — which stay on `str(exc.value)` on purpose, because there the
    wider string is the stronger claim.
    """
    return (exc.value.diag.message_primary or "") if exc.value.diag else ""


def _system(conn) -> None:
    """No browser identity: `auth.uid()` is null and the role is a superuser.

    This is the engine/operator lane — `hq_entitlement_guard`'s hatch — and it is
    how the tests drive the execution transitions that will belong to the
    executor when PKT-07A is signed. It is NOT how a browser reaches anything.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


def _as(conn, uid: str | None) -> None:
    """A browser session for `uid`, under the `authenticated` role."""
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(uid or ""),))
    conn.execute("set role authenticated")


def _restore(conn) -> None:
    """Re-apply the migration.

    Every mutation test below breaks the schema on purpose and calls this in a
    `finally`. The migration is written to be re-appliable (`create or replace`,
    `drop … if exists`, `if not exists`), which `db/apply.sh` requires anyway, so
    this is the same operation production performs on every provisioning run.
    """
    _system(conn)
    for m in AUTOPILOT_MIGRATIONS:
        conn.execute(m.read_text())


def new_user(conn, tag: str) -> str:
    """`make_user` under the system lane.

    It inserts into `allowed_emails`, which has no browser write policy, so
    calling it while a helper has left `set role authenticated` in place fails
    with an RLS error that reads like a bug in the thing under test.
    """
    _system(conn)
    return make_user(conn, f"{tag}-{uuid.uuid4()}@example.com")


def make_application(conn, user_id: str, company: str = "DuplicateCo") -> int:
    _system(conn)
    return conn.execute(
        "insert into public.applications (user_id, company, title, status) "
        "values (%s, %s, 'Product Manager', 'Queued') returning id",
        (user_id, company),
    ).fetchone()[0]


def make_artifact(conn, user_id: str, body: bytes = b"resume-pdf") -> tuple[int, str]:
    """One résumé artifact, so an attachment can name something real.

    `resume_artifacts` is immutable evidence (0026), which is exactly why the
    package guard checks attachments against it: an approved attachment cannot
    become different bytes under the same id.
    """
    _system(conn)
    sha = hashlib.sha256(body + uuid.uuid4().bytes).hexdigest()
    path = f"{user_id}/{uuid.uuid4()}.pdf"
    rid = conn.execute(
        "insert into public.resume_artifacts "
        "  (user_id, origin, kind, storage_path, filename, byte_size, sha256, retention) "
        "values (%s, 'uploaded', 'pdf', %s, 'resume.pdf', %s, %s, 'permanent') returning id",
        (user_id, path, len(body), sha),
    ).fetchone()[0]
    return rid, sha


@pytest.fixture
def actor(conn):
    """One entitled user with an application and an artifact to attach."""
    uid = new_user(conn, "pilot")
    app_id = make_application(conn, uid)
    art_id, sha = make_artifact(conn, uid)
    return {"uid": uid, "app": app_id, "artifact": art_id, "sha": sha}


def stage(conn, actor, *, state="ready_for_review", answers=None, attachments=None,
          payload=None, version="v1", idem=None, expected=None, reason=""):
    """Drive `app_stage_autopilot_application` as the owner's browser session."""
    _as(conn, actor["uid"])
    return conn.execute(
        "select public.app_stage_autopilot_application("
        "  %s, 'greenhouse', %s, 'board-1', 'sch-1', %s::jsonb, %s::jsonb, %s::jsonb, "
        "  '[]'::jsonb, %s, %s, %s, %s)",
        (actor["app"], version,
         json.dumps(payload if payload is not None else {"first_name": "A"}),
         json.dumps(attachments if attachments is not None
                    else [{"artifactId": actor["artifact"], "sha256": actor["sha"],
                           "filename": "resume.pdf", "kind": "pdf"}]),
         json.dumps(answers if answers is not None else {}),
         state, reason, idem or str(uuid.uuid4()), expected),
    ).fetchone()[0]


def review(conn, actor, stage_id, decision, *, package_hash=None, idem=None,
           expected=None, reason=""):
    _as(conn, actor["uid"])
    return conn.execute(
        "select public.app_review_autopilot_stage(%s, %s, %s, %s, %s, %s)",
        (stage_id, decision, package_hash, reason, idem or str(uuid.uuid4()), expected),
    ).fetchone()[0]


def row(conn, stage_id) -> dict:
    _system(conn)
    r = conn.execute(
        "select state, payload_hash, approved_hash, approved_by, updated_at, "
        "       application_id, user_id, retry_of_stage_id "
        "  from public.autopilot_stages where id = %s", (stage_id,)).fetchone()
    return dict(zip(
        "state payload_hash approved_hash approved_by updated_at application_id "
        "user_id retry_of_stage_id".split(), r))


def force_state(conn, stage_id, state, *, reason="test") -> None:
    """An engine-lane transition: no browser identity, superuser role.

    This is the lane the executor will use. It is subject to every trigger in the
    migration — which is the point of putting the machine in triggers rather than
    in the RPC bodies.
    """
    _system(conn)
    conn.execute(
        "update public.autopilot_stages set state = %s, transition_reason = %s where id = %s",
        (state, reason, stage_id))


def file_receipt(conn, actor, stage_id, *, cls=1, ref=None) -> int:
    _system(conn)
    return conn.execute(
        "insert into public.autopilot_receipts "
        "  (user_id, stage_id, evidence_class, provider_reference, evidence) "
        "values (%s, %s, %s, %s, '{}'::jsonb) returning id",
        (actor["uid"], stage_id, cls, ref or f"GH-{uuid.uuid4().hex[:10]}")).fetchone()[0]


def approved_stage(conn, actor) -> int:
    """A stage sitting in `approved`, the way the product would get there."""
    s = stage(conn, actor)["stage"]
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])
    return s["id"]


def fresh_actor(conn, tag: str) -> dict:
    """A second entitled user with their own application and artifact.

    The `actor` fixture is shared, and a mutation test that has to erase its user
    to clean up must not erase the one the rest of the test is using.
    """
    uid = new_user(conn, tag)
    art_id, sha = make_artifact(conn, uid)
    return {"uid": uid, "app": make_application(conn, uid), "artifact": art_id, "sha": sha}


def triaged_application(conn, actor) -> tuple[str, dict]:
    """An application created THE WAY THE PRODUCT CREATES ONE, so the real
    un-triage gestures can be driven against it.

    `make_application` inserts a row with no `posting_key`, which `app_set_triage`
    cannot reach. The cascade under review is the one a person actually triggers:
    posting → gated `user_postings` row → `app_set_triage(interested)` → a
    `Queued` application → un-triage deletes it. Returns the posting key and an
    actor dict pointing at that application, so `stage()` and friends work
    unchanged.
    """
    key = f"greenhouse-{uuid.uuid4().hex[:10]}"
    _system(conn)
    make_posting(conn, key, "UndoCo")
    gate(conn, actor["uid"], key)
    _as(conn, actor["uid"])
    conn.execute("select public.app_set_triage(%s, 'interested', null, '', %s, null)",
                 (key, str(uuid.uuid4())))
    _system(conn)
    app_id = conn.execute(
        "select id from public.applications where user_id = %s and posting_key = %s",
        (actor["uid"], key)).fetchone()[0]
    return key, {**actor, "app": app_id}


def untriage(conn, actor, key, triage=""):
    """0003's shipped gesture, as the owner's browser session. `''` is undo and
    `'dismissed'` is "no thanks"; both delete the `Queued` application and both
    cascade into this migration's tables."""
    _as(conn, actor["uid"])
    return conn.execute("select public.app_set_triage(%s, %s, null, '', %s, null)",
                        (key, triage, str(uuid.uuid4()))).fetchone()[0]


def evidence_counts(conn, actor) -> tuple[int, int, int]:
    """(stages, transitions, receipts) for this user — the three numbers the
    erasure findings are about."""
    _system(conn)
    return tuple(
        conn.execute(f"select count(*) from public.{t} where user_id = %s",
                     (actor["uid"],)).fetchone()[0]
        for t in ("autopilot_stages", "autopilot_transitions", "autopilot_receipts"))


# ═══════════════════════════════════════════════════════ the package hash

def test_the_package_hash_is_generated_and_cannot_be_written(conn, actor):
    """`payload_hash` is GENERATED ALWAYS, so the approval binds to content.

    Driven through the lane an attacker actually has — `service_role`, which
    holds INSERT and UPDATE on this table and bypasses RLS. If the column were
    trigger-maintained instead, this write would succeed.

    KILLED BY: declaring `payload_hash` as an ordinary column.
    """
    s = stage(conn, actor)["stage"]
    _system(conn)
    conn.execute("set role service_role")
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("update public.autopilot_stages set payload_hash = %s where id = %s",
                     ("0" * 64, s["id"]))
    _system(conn)
    # Postgres's own refusal, and the phrase that identifies the MECHANISM is in
    # the detail rather than the primary message. Both are read explicitly, for
    # `refusal()`'s reason: `str(exc.value)` would also match the word "generated"
    # appearing anywhere in the echoed statement.
    assert isinstance(exc.value, psycopg.errors.GeneratedAlways), exc.value
    assert "can only be updated to default" in refusal(exc).lower(), exc.value
    assert "generated column" in (exc.value.diag.message_detail or "").lower(), exc.value
    assert row(conn, s["id"])["payload_hash"] == s["packageHash"]


def test_the_hash_covers_the_package_and_nothing_else(conn, actor):
    """Exactly the seven package columns move it, and the rest do not.

    This is the assertion that keeps `hq_autopilot_package_hash`'s argument list
    and the state machine's `v_package_changed` tuple from drifting apart: if
    somebody adds a column to one and not the other, the two halves of "the
    package is frozen" stop meaning the same thing.

    `gaps` is asserted NOT to move it, deliberately — rewording the explanation
    of an already-answered question must not invalidate a human's approval.
    """
    s = stage(conn, actor)["stage"]
    base = row(conn, s["id"])["payload_hash"]

    # a package column moves it
    stage(conn, actor, version="v2")
    assert row(conn, s["id"])["payload_hash"] != base

    stage(conn, actor, version="v1")
    assert row(conn, s["id"])["payload_hash"] == base, "the hash is not a function of content"

    # a non-package column does not
    _system(conn)
    conn.execute("update public.autopilot_stages set gaps = %s::jsonb where id = %s",
                 (json.dumps([{"fieldId": "x", "reason": "ask"}]), s["id"]))
    assert row(conn, s["id"])["payload_hash"] == base, (
        "`gaps` changed the package hash — an approval would now be invalidated by "
        "rewording an explanation")


def test_the_hash_encoding_is_injective(conn, actor):
    """`('ab','c')` and `('a','bc')` must not hash the same.

    Concatenation without length prefixes is the classic way a content hash stops
    proving anything, and it fails silently: two different packages agree, so an
    approval taken against one validates the other.

    KILLED BY: dropping the `length(x)||':'` framing from
    `hq_autopilot_package_hash`.
    """
    _system(conn)
    a, b = conn.execute(
        "select public.hq_autopilot_package_hash('ab', 'c', '', '', "
        "         '{}'::jsonb, '[]'::jsonb, '{}'::jsonb), "
        "       public.hq_autopilot_package_hash('a', 'bc', '', '', "
        "         '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)").fetchone()
    assert a != b


# ═════════════════════════════════════════════════════════ the state machine

def test_every_state_pair_agrees_with_the_declared_machine(conn):
    """All 144 pairs, against a table written from the packets rather than copied
    from the SQL.

    A test that re-listed the migration's own array would go green on any mutation
    that changed both. This one disagrees with the database if a single arrow is
    added or removed.

    KILLED BY: adding or deleting any entry in
    `hq_autopilot_transition_allowed`'s array — including
    `outcome_unknown>submitting`, which is the one that matters.
    """
    _system(conn)
    actual = {
        (f, t)
        for f in STATES for t in STATES
        if conn.execute("select public.hq_autopilot_transition_allowed(%s, %s)",
                        (f, t)).fetchone()[0]
    }
    assert actual == LEGAL, {
        "allowed but should not be": sorted(actual - LEGAL),
        "declared but refused": sorted(LEGAL - actual),
    }


def test_a_stage_is_born_preparing(conn, actor):
    """The INSERT half. Without it, a writer creates a row already `submitted` and
    skips every rule the UPDATE trigger enforces.

    Driven as `service_role`, which is the writer that can actually attempt it.

    KILLED BY: dropping `autopilot_stages_birth`.
    """
    _system(conn)
    conn.execute("set role service_role")
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "insert into public.autopilot_stages "
            "  (user_id, application_id, provider, state, approved_hash, approved_at) "
            "values (%s, %s, 'greenhouse', 'approved', %s, now())",
            (actor["uid"], actor["app"], "0" * 64))
    _system(conn)
    assert "born preparing" in refusal(exc), exc.value


@pytest.mark.parametrize("target", ["submitting", "submitted", "approved", "failed_retryable"])
def test_an_illegal_transition_is_refused_and_names_the_stage(conn, actor, target):
    """A `preparing` stage cannot jump anywhere interesting.

    The message is asserted, not merely the raise: these RPCs and this table's
    triggers also touch `public.events`, which is entitlement-gated, so "it
    raised" is compatible with the wrong mechanism having fired.

    KILLED BY: dropping the `hq_autopilot_transition_allowed` check from
    `hq_autopilot_state_machine`.
    """
    s = stage(conn, actor, state="preparing")["stage"]
    with pytest.raises(psycopg.errors.Error) as exc:
        force_state(conn, s["id"], target)
    assert "not a legal transition from preparing" in refusal(exc), exc.value
    assert row(conn, s["id"])["state"] == "preparing"


def test_a_terminal_state_is_terminal(conn, actor):
    """`submitted` has no outbound arrow at all. A finished stage cannot be
    revived into a second submission; a new attempt is a new row.

    KILLED BY: adding any `submitted>…` entry to the transition array.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    file_receipt(conn, actor, sid)
    force_state(conn, sid, "submitted")
    for target in ("submitting", "approved", "failed_retryable", "cancelled"):
        with pytest.raises(psycopg.errors.Error) as exc:
            force_state(conn, sid, target)
        assert "not a legal transition from submitted" in refusal(exc), exc.value


def test_submitted_requires_a_receipt(conn, actor):
    """Packet 07's receipt contract, as a refusal.

    "`submitted` requires durable reviewed payload plus provider confirmation …
    otherwise use `outcome_unknown`." Nothing else in the system checks that
    claim, so if this trigger branch goes, `submitted` becomes an opinion.

    KILLED BY: deleting the receipt existence check from
    `hq_autopilot_state_machine`.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    with pytest.raises(psycopg.errors.Error) as exc:
        force_state(conn, sid, "submitted")
    assert "without a receipt" in refusal(exc), exc.value
    assert row(conn, sid)["state"] == "submitting"

    file_receipt(conn, actor, sid)
    force_state(conn, sid, "submitted")
    assert row(conn, sid)["state"] == "submitted"


def test_a_receipt_cannot_be_filed_against_a_stage_that_is_not_submitting(conn, actor):
    """Otherwise the receipt check above is walked backwards: file the evidence
    first, then transition into `submitted` with it already waiting.

    KILLED BY: dropping `autopilot_receipts_guard`.
    """
    sid = approved_stage(conn, actor)
    with pytest.raises(psycopg.errors.Error) as exc:
        file_receipt(conn, actor, sid)
    assert "a receipt belongs to a submission in flight" in refusal(exc), exc.value


# ═══════════════════════════════════════════════════════ approval integrity

def test_the_package_is_frozen_once_it_leaves_the_editable_states(conn, actor):
    """The core safety property: between approval and submission there is no
    legal write that could change what gets submitted.

    Driven through `service_role` — the lane that bypasses RLS and holds UPDATE,
    i.e. the one a compromised engine or a helpful script would use. The browser
    is refused one layer earlier (no privilege, and the RPC refuses too), which is
    asserted separately below.

    KILLED BY: deleting the `v_package_changed and not editable` branch from
    `hq_autopilot_state_machine`.
    """
    sid = approved_stage(conn, actor)
    before = row(conn, sid)["payload_hash"]
    _system(conn)
    conn.execute("set role service_role")
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("update public.autopilot_stages set payload = %s::jsonb where id = %s",
                     (json.dumps({"first_name": "Mallory"}), sid))
    _system(conn)
    assert "the reviewed package is frozen" in refusal(exc), exc.value
    assert row(conn, sid)["payload_hash"] == before


def test_the_freeze_covers_gaps_and_the_transition_reason(conn, actor):
    """Review T3/F5: `gaps` is outside the hash — rewording an explanation must
    not invalidate an approval — but "not hashed" and "rewritable while approved"
    are two decisions and only the first was made. The executor will read `gaps`
    to decide whether required questions are still open, so a writer that can
    empty it between approval and submission makes an incomplete package look
    complete without touching a hashed byte.

    `transition_reason` is the different case in the same finding: its durable
    form is the append-only audit row, so it is not material to a submission — but
    it may not be rewritten on a settled stage either, because a reason belongs to
    the transition that carried it.

    KILLED BY: dropping `new.gaps is distinct from old.gaps` from the freeze
    branch, or the `transition_reason` branch, in `hq_autopilot_state_machine`.
    """
    sid = approved_stage(conn, actor)
    before = row(conn, sid)["payload_hash"]
    _system(conn)
    conn.execute("set role service_role")
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "update public.autopilot_stages set gaps = %s::jsonb where id = %s",
            (json.dumps([{"fieldId": "cover_letter", "kind": "text",
                          "reason": "not answered", "required": True}]), sid))
    _system(conn)
    assert "the reviewed package is frozen" in refusal(exc), exc.value

    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "update public.autopilot_stages set transition_reason = 'looks fine to me' "
            " where id = %s", (sid,))
    assert "a transition reason belongs to a transition" in refusal(exc), exc.value

    # The hash is untouched by either attempt, which is the point: neither is
    # visible to `payload_hash`, so neither would have been caught by it.
    assert row(conn, sid)["payload_hash"] == before

    # And both are still writable where they belong — while the package is
    # editable, and on the statement that makes a transition.
    review(conn, actor, sid, "request_changes", reason="add the cover letter")
    out = stage(conn, actor, state="ready_for_review", reason="gaps closed")
    assert out["stage"]["state"] == "ready_for_review"


def test_the_staging_rpc_refuses_to_edit_an_approved_stage(conn, actor):
    """The same property at the browser door, where it produces a 40001 the client
    knows how to render. The word "conflict" is load-bearing —
    `supabase-source.ts` matches on it.
    """
    sid = approved_stage(conn, actor)
    with pytest.raises(psycopg.errors.Error) as exc:
        stage(conn, actor, version="v9")
    assert "conflict" in refusal(exc) and "frozen" in refusal(exc), exc.value
    assert row(conn, sid)["state"] == "approved"


def test_approving_a_package_you_did_not_read_is_refused(conn, actor):
    """The window between "the review screen rendered" and "the button was
    pressed".

    A background re-stage lands in between; the hash the browser holds is now
    stale; the approval must be refused rather than silently authorising a package
    nobody read. This is the whole reason `p_package_hash` exists.

    KILLED BY: deleting the `v_hash <> v_row.payload_hash` check from
    `app_review_autopilot_stage` — the stale hash is then accepted and
    `approved_hash` is set from the CURRENT package, which is the exact bug.
    """
    s = stage(conn, actor)["stage"]
    stale = s["packageHash"]
    stage(conn, actor, version="v2")          # the background re-stage
    assert row(conn, s["id"])["payload_hash"] != stale

    with pytest.raises(psycopg.errors.Error) as exc:
        review(conn, actor, s["id"], "approve", package_hash=stale)
    assert "changed since you reviewed it" in refusal(exc), exc.value
    assert row(conn, s["id"])["state"] == "ready_for_review"
    assert row(conn, s["id"])["approved_hash"] is None


def test_a_forged_approval_cannot_start_a_submission(conn, actor):
    """The illegal path, which is what the trigger's hash check is FOR.

    Rule "the package is frozen" makes a mismatched approval unreachable through
    legal writes. So this test manufactures one the only way it can be
    manufactured — a restore, or a session that disabled a trigger — and shows the
    check still standing between it and an external side effect.

    KILLED BY: deleting the `new.approved_hash <> old.payload_hash` branch from
    `hq_autopilot_state_machine`.
    """
    sid = approved_stage(conn, actor)
    _system(conn)
    # The only way to get a mismatched approval into the row: turn the machine off,
    # write it, turn the machine back on. That IS the threat model.
    conn.execute("alter table public.autopilot_stages disable trigger autopilot_stages_state_machine")
    conn.execute("update public.autopilot_stages set approved_hash = %s where id = %s",
                 ("f" * 64, sid))
    conn.execute("alter table public.autopilot_stages enable trigger autopilot_stages_state_machine")

    with pytest.raises(psycopg.errors.Error) as exc:
        force_state(conn, sid, "submitting")
    assert "the approval does not match the package" in refusal(exc), exc.value
    assert row(conn, sid)["state"] == "approved"


# ═══════════════════════════ B2: an approval names the person who made it
#
# Review T3/B2: with no `auth.uid()` at all — the operator/engine lane the
# executor will run in — `state='approved'` with a matching hash succeeded with
# `approved_by = NULL`, and `approved → submitting` succeeded after it. The audit
# row said `actor = 'engine'`, so it was detectable; detection is not the
# contract. Approving is the one act in this schema with no engine lane.

def test_the_engine_lane_cannot_approve_anything(conn, actor):
    """The exact write the reviewer ran, refused.

    KILLED BY: deleting the `new.state = 'approved'` identity branch from
    `hq_autopilot_state_machine`. The constraint then answers instead, with a
    constraint name rather than a sentence — which is why both layers are here
    and why this asserts the sentence.
    """
    s = stage(conn, actor)["stage"]
    _system(conn)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "update public.autopilot_stages "
            "   set state = 'approved', approved_hash = %s, approved_at = now() "
            " where id = %s", (s["packageHash"], s["id"]))
    assert "without a signed-in reviewer" in refusal(exc), exc.value
    assert row(conn, s["id"])["state"] == "ready_for_review"

    # Naming the user does not help: the approver is the SESSION, not a value a
    # writer may choose. This is the impersonation half of the same rule.
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "update public.autopilot_stages "
            "   set state = 'approved', approved_hash = %s, approved_at = now(), "
            "       approved_by = %s where id = %s",
            (s["packageHash"], actor["uid"], s["id"]))
    assert "without a signed-in reviewer" in refusal(exc), exc.value

    # A signed-in session approving as SOMEBODY ELSE is refused by the other
    # branch. Driven through the engine lane's privileges with a browser identity
    # set, because `authenticated` holds no UPDATE on this table at all.
    other = new_user(conn, "not-the-reviewer")
    conn.execute("reset role")          # the privileges of the operator lane…
    conn.execute("select set_config('hq.test_user', %s, false)", (actor["uid"],))
    try:                                # …with a browser identity behind it
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
            conn.execute(
                "update public.autopilot_stages "
                "   set state = 'approved', approved_hash = %s, approved_at = now(), "
                "       approved_by = %s where id = %s",
                (s["packageHash"], other, s["id"]))
        assert "records the reviewer who made it" in refusal(exc), exc.value
    finally:
        _system(conn)
    assert row(conn, s["id"])["state"] == "ready_for_review"

    # And the real gesture still works, so this is a gate and not a wall.
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])
    assert row(conn, s["id"])["approved_by"] == uuid.UUID(actor["uid"])


def test_the_constraint_refuses_an_approval_with_no_approver(conn, actor):
    """The layer under the trigger, for the writer that turned the trigger off.

    KILLED BY: dropping `approved_by is not null` from
    `autopilot_stages_approval_matches_state`'s authorised branch — which is what
    the reviewer's probe exploited, since a `service_role` session or a restore
    reaches the row with no browser identity at all.
    """
    s = stage(conn, actor)["stage"]
    _system(conn)
    conn.execute("alter table public.autopilot_stages "
                 "disable trigger autopilot_stages_state_machine")
    try:
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            conn.execute(
                "update public.autopilot_stages "
                "   set state = 'approved', approved_hash = %s, approved_at = now() "
                " where id = %s", (s["packageHash"], s["id"]))
        assert "autopilot_stages_approval_matches_state" in (
            exc.value.diag.constraint_name or ""), exc.value
    finally:
        _system(conn)
        conn.execute("alter table public.autopilot_stages "
                     "enable trigger autopilot_stages_state_machine")
    assert row(conn, s["id"])["state"] == "ready_for_review"


def test_a_submission_cannot_start_without_a_recorded_reviewer(conn, actor):
    """The way OUT of `approved`, checked separately.

    Starting a submission is the moment "who authorised this" stops being
    fixable. The row here is manufactured the only way it can be — the constraint
    dropped and the machine turned off — which is exactly the writer this branch
    exists for: a restore, or an approval written before the reviewer requirement.

    KILLED BY: deleting the `new.state = 'submitting' and old.approved_by is null`
    branch from `hq_autopilot_state_machine`.
    """
    sid = approved_stage(conn, actor)
    _system(conn)
    conn.execute("alter table public.autopilot_stages "
                 "drop constraint autopilot_stages_approval_matches_state")
    conn.execute("alter table public.autopilot_stages "
                 "disable trigger autopilot_stages_state_machine")
    conn.execute("update public.autopilot_stages set approved_by = null where id = %s", (sid,))
    conn.execute("alter table public.autopilot_stages "
                 "enable trigger autopilot_stages_state_machine")
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
            force_state(conn, sid, "submitting")
        assert "no recorded reviewer" in refusal(exc), exc.value
        assert row(conn, sid)["state"] == "approved"
    finally:
        # Put the reviewer back before the constraint returns: re-adding it
        # VALIDATES the stored rows, which is the property that makes it worth
        # having, and a test must not leave the session schema unable to converge.
        _system(conn)
        conn.execute("alter table public.autopilot_stages "
                     "disable trigger autopilot_stages_state_machine")
        conn.execute("update public.autopilot_stages set approved_by = %s where id = %s",
                     (actor["uid"], sid))
        conn.execute("alter table public.autopilot_stages "
                     "enable trigger autopilot_stages_state_machine")
        _restore(conn)


def test_sending_a_stage_back_clears_the_approval(conn, actor):
    """Packet 06's `approved → ready_for_review` arrow. An approval that survived
    it would be an approval of a package nobody re-read.

    KILLED BY: deleting the "entering an editable state clears the approval"
    branch — the constraint `autopilot_stages_approval_matches_state` then raises
    instead, which is a second layer and is asserted by the alternative message.
    """
    sid = approved_stage(conn, actor)
    review(conn, actor, sid, "request_changes", reason="wrong résumé")
    r = row(conn, sid)
    assert r["state"] == "changes_requested"
    assert r["approved_hash"] is None and r["approved_by"] is None


def test_an_approval_cannot_be_written_without_a_transition(conn, actor):
    """Backdating an authorisation onto a stage that is not moving.

    KILLED BY: deleting the final `not v_state_changed` branch of
    `hq_autopilot_state_machine`.
    """
    s = stage(conn, actor)["stage"]
    _system(conn)
    conn.execute("set role service_role")
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "update public.autopilot_stages set approved_hash = %s, approved_at = now() "
            " where id = %s", (s["packageHash"], s["id"]))
    _system(conn)
    assert "an approval is a transition, not a field edit" in refusal(exc), exc.value


def test_an_edit_and_a_transition_cannot_share_one_statement(conn, actor):
    """The rule that makes `old.payload_hash` trustworthy inside the trigger.

    Postgres computes GENERATED columns AFTER before-row triggers, so
    `new.payload_hash` is null in there. If one statement could do both, the
    trigger would be judging an approval against a package that no longer exists.

    KILLED BY: deleting the `v_package_changed and v_state_changed` branch.
    """
    s = stage(conn, actor, state="preparing")["stage"]
    _system(conn)
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "update public.autopilot_stages set payload = %s::jsonb, state = 'ready_for_review' "
            " where id = %s", (json.dumps({"first_name": "B"}), s["id"]))
    assert "an edit is not a transition" in refusal(exc), exc.value


# ══════════════════════════════════════════════ outcome_unknown never retries

def test_outcome_unknown_has_exactly_two_exits(conn, actor):
    """The contract sentence, as a refusal per illegal target.

    "An ambiguous post-submit result is `outcome_unknown` and is never blindly
    retried." Packet 07: it "never transitions directly to `executing` or
    `failed_retryable`".

    KILLED BY: adding `outcome_unknown>submitting` (or `>failed_retryable`, or
    `>approved`) to the transition array.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    force_state(conn, sid, "outcome_unknown", reason="timed out after posting")

    for target in ("submitting", "approved", "failed_retryable", "preparing",
                   "ready_for_review", "changes_requested", "cancelled",
                   "needs_input"):
        with pytest.raises(psycopg.errors.Error) as exc:
            force_state(conn, sid, target)
        assert "not a legal transition from outcome_unknown" in refusal(exc), (
            f"{target}: {exc.value}")
        assert row(conn, sid)["state"] == "outcome_unknown"

    # And the two that ARE legal both work — a set of exits nothing can leave is
    # not a state, it is a leak.
    file_receipt(conn, actor, sid, cls=2, ref="APP-77")
    force_state(conn, sid, "submitted")
    assert row(conn, sid)["state"] == "submitted"


def test_a_retry_cannot_be_staged_while_the_outcome_is_unknown(conn, actor):
    """The mechanism that stops a retry LOOP, not just a retry transition.

    A retry is a new row, so blocking the transition alone would leave the obvious
    workaround open: stage it again. `autopilot_stages_one_live_attempt` covers
    `outcome_unknown`, so the insert raises — for the RPC, for the engine, and for
    a script nobody reviewed.

    KILLED BY: removing `outcome_unknown` from the index predicate. The retry then
    succeeds and the employer may receive two applications.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    force_state(conn, sid, "outcome_unknown")

    # 1. the deliberate retry RPC refuses, by name
    with pytest.raises(psycopg.errors.Error) as exc:
        _as(conn, actor["uid"])
        conn.execute("select public.app_retry_autopilot_stage(%s, 'try again', %s)",
                     (sid, str(uuid.uuid4())))
    assert "outcome_unknown and may not be retried" in refusal(exc), exc.value

    # 2. and so does staging a fresh package for the same application — the
    #    workaround somebody reaches for when the retry button is greyed out.
    #    THIS IS THE ONE THAT CAUGHT A REAL HOLE: with the duplicate index split
    #    into "one open stage" and "one live attempt", a brand new `preparing` row
    #    matched neither predicate and this call SUCCEEDED. A partial unique index
    #    does not index rows outside its predicate.
    with pytest.raises(psycopg.errors.Error) as exc:
        stage(conn, actor)
    assert "no open autopilot stage" in refusal(exc), exc.value

    # 3. the engine cannot do it either — no browser identity, same index.
    _system(conn)
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "insert into public.autopilot_stages (user_id, application_id, provider, state) "
            "values (%s, %s, 'greenhouse', 'preparing')", (actor["uid"], actor["app"]))

    _system(conn)
    assert conn.execute(
        "select count(*) from public.autopilot_stages where application_id = %s",
        (actor["app"],)).fetchone()[0] == 1


def test_resolving_the_unknown_is_what_unblocks_a_retry(conn, actor):
    """The other direction, so the block above is a gate and not a wall.

    A human decides `failed_terminal` — "reconciliation proves no usable submitted
    application and blind retry remains unsafe" — and only then may a new attempt
    be prepared. It is born `preparing` and has to be reviewed and approved again,
    so the retry is a deliberate act with its own record rather than a resumption.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    force_state(conn, sid, "outcome_unknown")
    force_state(conn, sid, "failed_terminal", reason="reconciled: no application exists")

    _as(conn, actor["uid"])
    out = conn.execute("select public.app_retry_autopilot_stage(%s, 'reconciled', %s)",
                       (sid, str(uuid.uuid4()))).fetchone()[0]
    new_id = out["stage"]["id"]
    assert out["retryOfStageId"] == sid
    r = row(conn, new_id)
    assert r["state"] == "preparing", "a retry must be re-reviewed, not resumed"
    assert r["approved_hash"] is None
    assert r["retry_of_stage_id"] == sid

    _system(conn)
    kinds = [k for (k,) in conn.execute(
        "select kind from public.events where user_id = %s and kind like 'autopilot.%%' "
        "order by id", (actor["uid"],)).fetchall()]
    assert "autopilot.retry_staged" in kinds, "the deliberate act has no record"


def test_a_retry_that_collides_with_a_live_attempt_gets_a_sentence(conn, actor):
    """Review T3/F8: the collision was reaching the caller as a bare
    `23505 autopilot_stages_one_live_attempt`. Every other refusal in this file is
    a sentence; a catalog identifier is not one, and it is also the wrong error
    class — this is a conflict, and `supabase-source.ts` matches on that word.

    KILLED BY: removing the `exception when unique_violation` block from
    `app_retry_autopilot_stage`.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    force_state(conn, sid, "failed_retryable", reason="provider 500")
    newer = stage(conn, actor)["stage"]           # settled, so a fresh stage is legal
    assert newer["id"] != sid

    _as(conn, actor["uid"])
    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        conn.execute("select public.app_retry_autopilot_stage(%s, 'again', %s)",
                     (sid, str(uuid.uuid4())))
    assert "already has a newer autopilot attempt" in refusal(exc), exc.value
    assert "conflict" in refusal(exc), exc.value
    assert "autopilot_stages_one_live_attempt" not in str(exc.value), exc.value


def test_a_retry_may_not_name_an_unsettled_prior_attempt(conn, actor):
    """The birth trigger's half of the same rule, driven from the engine lane so
    the RPC's own refusal cannot be what answers.

    KILLED BY: deleting the `retry_of_stage_id` branch from
    `hq_autopilot_stage_birth`.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    force_state(conn, sid, "outcome_unknown")
    other_app = make_application(conn, actor["uid"], company="OtherCo")
    _system(conn)
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "insert into public.autopilot_stages "
            "  (user_id, application_id, provider, retry_of_stage_id) "
            "values (%s, %s, 'greenhouse', %s)", (actor["uid"], other_app, sid))
    assert "not a settled prior attempt" in refusal(exc), exc.value


# ════════════════════════════════════════════════════ duplicate prevention

def test_one_live_attempt_per_application(conn, actor):
    """Keyed on `applications.id`, which is durable: it survives a reload, a
    process restart, a second device and a fresh idempotency key.

    KILLED BY: dropping `autopilot_stages_one_live_attempt`.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    _system(conn)
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "insert into public.autopilot_stages (user_id, application_id, provider) "
            "values (%s, %s, 'greenhouse')", (actor["uid"], actor["app"]))


def test_one_open_stage_per_application(conn, actor):
    """Two review queues for one job would make the human guess which one the
    executor picks up. A re-stage edits the open row instead.
    """
    first = stage(conn, actor)["stage"]
    again = stage(conn, actor, version="v3")
    assert again["created"] is False
    assert again["stage"]["id"] == first["id"]

    _system(conn)
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "insert into public.autopilot_stages (user_id, application_id, provider) "
            "values (%s, %s, 'lever')", (actor["uid"], actor["app"]))


def test_a_settled_attempt_frees_the_application(conn, actor):
    """The index is a gate, not a wall: a cancelled or failed attempt lets the
    next one be prepared, or the product would be one-shot per job.
    """
    s = stage(conn, actor)["stage"]
    review(conn, actor, s["id"], "cancel", reason="changed my mind")
    second = stage(conn, actor, version="v4")
    assert second["created"] is True
    assert second["stage"]["id"] != s["id"]


# ══════════════════════════════════════════════════════════════ authority

def test_another_account_cannot_stage_against_your_application(conn, actor):
    """Wrong owner, through the path an attacker has: a valid session of their
    own, calling the definer RPC with somebody else's application id. A definer
    bypasses RLS, so the RPC's own ownership check is what stands here.

    KILLED BY: dropping the `applications … where user_id = v_user` check from
    `app_stage_autopilot_application`.
    """
    intruder = new_user(conn, "intruder")
    _as(conn, intruder)
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "select public.app_stage_autopilot_application("
            "  %s, 'greenhouse', 'v1', '', '', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, "
            "  '[]'::jsonb, 'preparing', '', %s, null)",
            (actor["app"], str(uuid.uuid4())))
    assert "no such application for this user" in refusal(exc), exc.value
    _system(conn)
    assert conn.execute(
        "select count(*) from public.autopilot_stages where application_id = %s",
        (actor["app"],)).fetchone()[0] == 0


def test_another_account_cannot_review_your_stage(conn, actor):
    """Same shape at the approval door — the gesture that authorises a submission.

    KILLED BY: dropping `and user_id = v_user` from the review RPC's lookup.
    """
    s = stage(conn, actor)["stage"]
    intruder = new_user(conn, "intruder")
    _as(conn, intruder)
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("select public.app_review_autopilot_stage(%s, 'approve', %s, '', %s, null)",
                     (s["id"], s["packageHash"], str(uuid.uuid4())))
    assert "no such autopilot stage for this user" in refusal(exc), exc.value
    assert row(conn, s["id"])["approved_hash"] is None


def test_a_cross_owner_stage_row_cannot_exist_at_all(conn, actor):
    """The composite FK, which is what makes the denormalised `user_id` TRUE
    rather than merely intended. `service_role` holds INSERT and bypasses RLS, so
    without it one row carrying A's application and B's user id would let B read a
    stage prepared for A.

    KILLED BY: dropping `autopilot_stages_application_owner_fk`.
    """
    other = new_user(conn, "other")
    _system(conn)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute(
            "insert into public.autopilot_stages (user_id, application_id, provider) "
            "values (%s, %s, 'greenhouse')", (other, actor["app"]))


@pytest.mark.parametrize("state", ["pending", "suspended"])
def test_a_non_entitled_account_is_refused_by_name(conn, state):
    """0027's boundary, on tables that carry it FROM BIRTH.

    THE ASSERTION IS ON THE DATABASE'S OWN MESSAGE, and the distinction is the
    whole of review T3/B4. These RPCs also write `public.events` and
    `public.autopilot_transitions`, both gated, so a bare `pytest.raises` would
    pass with the guard missing from `autopilot_stages` — a green test proving the
    wrong thing. So the refusal has to NAME the table.

    Asserting that on `str(exc.value)` did not do it. `str(psycopg_error)` appends
    the server's `CONTEXT:` block, which echoes the RPC's own
    `insert into public.autopilot_stages …` verbatim — so with ONLY
    `autopilot_stages_entitlement_guard` dropped, the refusal arrived from
    `autopilot_transitions` and the assertion matched the SQL in the traceback:

        message_primary = '… is not entitled to write public.autopilot_transitions'
        "autopilot_stages" in str(exc.value)  →  True

    `refusal()` reads `diag.message_primary`, which is the guard's sentence and
    nothing else. `test_mutation_dropping_only_the_stages_guard_is_caught` drives
    exactly that mutation and proves this test goes red under it.

    The write is driven through the definer RPC, because that is the path that
    bypasses RLS: a direct insert would be refused by the privilege system with
    the guard removed entirely, which is a vacuous test.

    KILLED BY: removing `autopilot_stages` from the entitlement loop at the bottom
    of the migration.
    """
    uid = new_user(conn, "gated")
    app_id = make_application(conn, uid)
    _system(conn)
    if state == "suspended":
        conn.execute("select public.hq_suspend_user(%s, 'abuse')", (uid,))
    else:
        conn.execute("update public.entitlements set status = 'pending' where user_id = %s", (uid,))

    _as(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "select public.app_stage_autopilot_application("
            "  %s, 'greenhouse', 'v1', '', '', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, "
            "  '[]'::jsonb, 'preparing', '', %s, null)", (app_id, str(uuid.uuid4())))
    assert "not entitled" in refusal(exc), exc.value
    assert "autopilot_stages" in refusal(exc), (
        f"the refusal did not name autopilot_stages — it may have come from another "
        f"gated table: {exc.value}")

    _system(conn)
    assert conn.execute(
        "select count(*) from public.autopilot_stages where user_id = %s", (uid,)
    ).fetchone()[0] == 0


@pytest.mark.parametrize("state", ["pending", "suspended"])
def test_a_non_entitled_account_reads_nothing(conn, actor, state):
    """The read half, over `/rest/v1/autopilot_stages` — the surface the web app
    is not in the path of. A live JWT does not expire when the operator flips the
    switch.

    KILLED BY: removing the restrictive `_entitled` policies. All three of them:
    the pinned mutant `autopilot-receipts-entitled-policy-dropped` found this test
    reading zero from `autopilot_receipts` BOTH WAYS, because the row it built was
    a bare `stage()` and a bare stage files no receipt. Two thirds of the loop
    below asserted a boundary and the last third asserted an empty table. The
    fixture now builds evidence in all three tables and the pre-condition asserts
    the account can read all three, which is what makes the post-condition mean
    anything.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    file_receipt(conn, actor, sid)
    _as(conn, actor["uid"])
    for table in ("autopilot_stages", "autopilot_transitions", "autopilot_receipts"):
        assert conn.execute(f"select count(*) from public.{table}").fetchone()[0] >= 1, (
            f"{table} holds nothing before the suspension, so reading zero after it "
            f"would prove nothing"
        )

    _system(conn)
    if state == "suspended":
        conn.execute("select public.hq_suspend_user(%s, 'abuse')", (actor["uid"],))
    else:
        conn.execute("update public.entitlements set status = 'pending' where user_id = %s",
                     (actor["uid"],))
    _as(conn, actor["uid"])
    for table in ("autopilot_stages", "autopilot_transitions", "autopilot_receipts"):
        assert conn.execute(f"select count(*) from public.{table}").fetchone()[0] == 0, table
    _system(conn)


def test_an_anonymous_caller_is_refused(conn, actor):
    """`anon` holds the public key and can post straight to `/rest/v1/rpc`.

    KILLED BY: granting these RPCs to `anon`, or deleting their `v_user is null`
    check.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("set role anon")
    with pytest.raises(psycopg.errors.Error):
        conn.execute("select public.app_review_autopilot_stage(1, 'approve', %s, '', %s, null)",
                     ("0" * 64, str(uuid.uuid4())))
    _system(conn)


# ══════════════════════════════════════════════════ idempotency and concurrency

def test_a_replayed_key_returns_the_first_answer_and_writes_once(conn, actor):
    """The offline outbox replays gestures precisely because it does not know
    whether they landed.

    KILLED BY: deleting either `hq_command_replay` call from the RPC. The
    post-lock one is the load-bearing half — two tabs flushing one outbox both
    pass the pre-lock check before either writes.
    """
    idem = str(uuid.uuid4())
    first = stage(conn, actor, idem=idem)
    again = stage(conn, actor, idem=idem)
    assert again == first
    _system(conn)
    assert conn.execute(
        "select count(*) from public.autopilot_stages where application_id = %s",
        (actor["app"],)).fetchone()[0] == 1
    assert conn.execute(
        "select count(*) from public.events where user_id = %s and kind = 'autopilot.staged'",
        (actor["uid"],)).fetchone()[0] == 1


def test_a_key_reused_for_a_different_payload_is_refused(conn, actor):
    """0026's `request_hash`, which exists because the alternatives are worse:
    returning the stored result reports a write that did not happen, and doing the
    write anyway defeats the key.

    KILLED BY: passing a constant fingerprint, or dropping `request_hash` from the
    `command_idempotency` insert.
    """
    idem = str(uuid.uuid4())
    stage(conn, actor, idem=idem, version="v1")
    with pytest.raises(psycopg.errors.Error) as exc:
        stage(conn, actor, idem=idem, version="v2")
    assert "different arguments" in refusal(exc), exc.value


def test_a_key_reused_across_commands_is_refused(conn, actor):
    """One outbox, four commands. A key crossing lanes used to return the other
    command's result verbatim (0026's header records it happening).
    """
    idem = str(uuid.uuid4())
    s = stage(conn, actor, idem=idem)["stage"]
    with pytest.raises(psycopg.errors.Error) as exc:
        review(conn, actor, s["id"], "approve", package_hash=s["packageHash"], idem=idem)
    assert "cannot replay it" in refusal(exc), exc.value


def test_a_stale_version_token_is_refused(conn, actor):
    """Optimistic concurrency, compared as an INSTANT: `p_expected_updated_at` is
    DECLARED `timestamptz`, so two renderings of one moment are not compared as
    strings (matrix rows 146 and 168).

    KILLED BY: deleting the `v_row.updated_at is distinct from p_expected_updated_at`
    check, or the `for update` that precedes it.
    """
    s = stage(conn, actor)["stage"]
    stale = row(conn, s["id"])["updated_at"]
    stage(conn, actor, version="v5")           # somebody else moves it

    with pytest.raises(psycopg.errors.Error) as exc:
        stage(conn, actor, version="v6", expected=stale)
    assert "conflict" in refusal(exc), exc.value

    # And the review lane carries the same token, for the concurrent-decision case
    # a content hash cannot see: two reviewers hold the SAME hash.
    fresh = row(conn, s["id"])
    review(conn, actor, s["id"], "request_changes", expected=fresh["updated_at"])
    with pytest.raises(psycopg.errors.Error) as exc:
        review(conn, actor, s["id"], "cancel", expected=fresh["updated_at"])
    assert "conflict" in refusal(exc), exc.value


# ═════════════════════════════════════════════════════════ sensitive answers

@pytest.mark.parametrize("kind", ["work_authorization", "visa", "eeo", "compensation",
                                  "legal_identity", "criminal_background"])
@pytest.mark.parametrize("source", ["constant", "resume_evidence", "drafted"])
def test_an_inferred_sensitive_answer_is_refused(conn, actor, kind, source):
    """CLAUDE.md: "Never infer or submit work authorization, visa, EEO,
    compensation, legal identity, criminal/background, or unsupported factual
    answers."

    Encoded as a refusal rather than as a field: the packets treat these as GAPS
    handed to a person, so the store's job is to make the inference unstorable.
    The trigger means it holds for the engine and for the answer engine nobody has
    written yet, not only for the RPC shipped here.

    KILLED BY: deleting the sensitive branch from `hq_autopilot_package_guard`, or
    removing a kind from `hq_autopilot_sensitive_answer_kinds`.
    """
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        stage(conn, actor, answers={"q1": {"value": "Yes", "kind": kind, "source": source}})
    assert "may not store" in refusal(exc), exc.value
    # The VALUE never appears in the error. These are the most sensitive strings
    # in the system and an exception is a log line.
    assert "Yes" not in str(exc.value), exc.value


def test_a_sensitive_answer_the_user_typed_is_allowed(conn, actor):
    """The other direction, or the rule above is "autopilot cannot fill forms".

    A person may state their own work authorization. What is refused is the
    product GUESSING it.
    """
    out = stage(conn, actor, answers={
        "q1": {"value": "Yes", "kind": "work_authorization", "source": "user_fact"}})
    assert out["stage"]["state"] == "ready_for_review"


def test_an_explicitly_flagged_sensitive_field_is_refused_too(conn, actor):
    """The kind list cannot enumerate every provider's phrasing, so a preparer may
    mark a field sensitive itself. The rule then applies to it identically.
    """
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        stage(conn, actor, answers={
            "q9": {"value": "…", "sensitive": True, "source": "drafted"}})


# ═══════════ B3: sensitivity is not a claim the caller gets to make about itself
#
# Review T3/B3: the rule read the answer's own `kind` and its own `sensitive`
# flag, so an answer that omitted both was silently non-sensitive —
#
#     {"are_you_authorised_to_work_in_the_us": {"value": "Yes", "source": "drafted"}}
#
# stored cleanly from the browser lane AND from a raw service_role insert. The
# header claimed "refused by the database, for every writer". Now the database
# owns a third signal the caller does not control: the FIELD KEY.

@pytest.mark.parametrize("key", [
    "are_you_authorised_to_work_in_the_us",   # the reviewer's exact probe
    "Are You Authorized to Work in the US?",  # normalisation: casing and spaces
    "areYouAuthorizedToWorkInTheUS",
    "visa_status",
    "requires_sponsorship_now_or_in_future",
    "veteran_status",
    "eeo_race",
    "desired_salary",
    "date_of_birth",
    "have_you_ever_been_convicted_of_a_felony",
    "security_clearance_level",
])
@pytest.mark.parametrize("source", ["constant", "resume_evidence", "drafted"])
def test_a_sensitive_question_is_recognised_by_its_key_alone(conn, actor, key, source):
    """No `kind`, no `sensitive` flag: nothing but the provider's own field id,
    which the preparer read off the form rather than invented about itself.

    KILLED BY: deleting the `hq_autopilot_sensitive_answer_patterns()` branch from
    `hq_autopilot_package_guard`, or removing a pattern from the registry.
    """
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        stage(conn, actor, answers={key: {"value": "Yes", "source": source}})
    assert "may not store" in refusal(exc), exc.value
    assert "Yes" not in str(exc.value), exc.value


def test_the_key_registry_applies_to_the_engine_lane_too(conn, actor):
    """"For every writer" is the part of the claim that failed. A raw insert as
    `service_role` — no RPC, no browser — is refused by the same trigger.

    KILLED BY: the same deletion. The trigger is what makes this true of the
    executor and of the answer engine nobody has written yet.
    """
    _system(conn)
    conn.execute("set role service_role")
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
            conn.execute(
                "insert into public.autopilot_stages "
                "  (user_id, application_id, provider, answers) "
                "values (%s, %s, 'greenhouse', %s::jsonb)",
                (actor["uid"], actor["app"],
                 json.dumps({"visa_status": {"value": "F-1 OPT", "source": "resume_evidence"}})))
        assert "may not store" in refusal(exc), exc.value
        assert "F-1 OPT" not in str(exc.value), exc.value
    finally:
        _system(conn)


def test_the_key_registry_does_not_refuse_an_ordinary_question(conn, actor):
    """Over-inclusive is the deliberate tuning, but it is not "refuse
    everything": a package the product actually prepares still stores.
    """
    out = stage(conn, actor, answers={
        "first_name":            {"value": "A", "source": "user_fact"},
        "why_do_you_want_to_work_here": {"value": "…", "source": "drafted"},
        "years_of_experience":   {"value": "7", "source": "resume_evidence"},
        "linkedin_url":          {"value": "…", "source": "user_fact"},
        "start_date":            {"value": "2026-09-01", "source": "user_fact"},
    })
    assert out["stage"]["state"] == "ready_for_review"


def test_a_key_matched_sensitive_answer_the_user_typed_is_allowed(conn, actor):
    """And the escape is the right one: the person answers it themselves."""
    out = stage(conn, actor, answers={
        "are_you_authorised_to_work_in_the_us": {"value": "Yes", "source": "user_fact"}})
    assert out["stage"]["state"] == "ready_for_review"


def test_mutation_dropping_the_key_registry_stores_an_unlabelled_visa_answer(conn, actor):
    """B3, reproduced: with the registry branch gone, the reviewer's exact probe
    stores cleanly and would be submitted.
    """
    probe = {"are_you_authorised_to_work_in_the_us": {"value": "Yes", "source": "drafted"}}
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.hq_autopilot_sensitive_answer_patterns()
            returns text[] language sql immutable
            set search_path = pg_catalog, pg_temp
            as $fn$ select array[]::text[] $fn$""")
        out = stage(conn, actor, answers=probe)
        assert out["stage"]["answers"]["are_you_authorised_to_work_in_the_us"]["source"] \
            == "drafted", "the mutation did not reproduce the bug"
    finally:
        _system(conn)
        conn.execute("delete from public.autopilot_stages where user_id = %s", (actor["uid"],))
        _restore(conn)

    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        stage(conn, actor, answers=probe)
    assert "may not store" in refusal(exc), exc.value


# ═══════ B3, round 2: the two casing conventions are one question, or the
#                     registry fails open on exactly the protected characteristics
#
# The first registry normalised by collapsing every run of non-alphanumerics to
# `_`. A camelCase key has no such run, so it normalised to one unbroken word and
# the twelve `(^|_)…` patterns could only match at position 0. Ten of twenty-six
# realistic provider keys stored silently, and the ten were citizenship, gender,
# race, sex, age, date of birth, SSN, wage and work-permit document — the set the
# rule exists for. The unanchored patterns (`authoriz`, `sponsor`, `visa`,
# `crimin`) held in both conventions, which is why `workAuthorization` was caught
# and `applicantGender` was not.
#
# These are asserted as PAIRS on purpose. A single-spelling test passes while the
# other spelling leaks — that is exactly the shape the defect had. Pairing them
# means an edit that refuses one and admits the other turns the suite red.

#: (snake_case, camelCase) — the same question, written the two ways ATS vendors
#: actually write it. Every one of these was refused on the left and stored on the
#: right before `hq_autopilot_normalise_field_key()` split the case boundary.
CASING_PAIRS = [
    ("us_citizenship_status", "usCitizenshipStatus"),
    ("applicant_gender",      "applicantGender"),
    ("candidate_race",        "candidateRace"),
    ("legal_sex",             "legalSex"),
    ("ssn_last_4",            "ssnLast4"),
    ("date_of_birth",         "dateOfBirth"),
    ("applicant_age",         "applicantAge"),
    ("desired_wage",          "desiredWage"),
    ("ead_document",          "eadDocument"),
]


@pytest.mark.parametrize("snake,camel", CASING_PAIRS, ids=[p[1] for p in CASING_PAIRS])
def test_both_spellings_of_a_protected_characteristic_are_refused(conn, actor, snake, camel):
    """The pair, through the real RPC, in one case: refuse both or fail.

    KILLED BY: reverting `hq_autopilot_normalise_field_key()` to a collapse-only
    normalisation, which is what
    `test_mutation_normalising_without_the_case_boundary_lets_camelcase_through`
    does deliberately — the camelCase half stores and this assertion fails.
    """
    for key in (snake, camel):
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
            stage(conn, actor, answers={key: {"value": "Yes", "source": "drafted"}})
        assert "may not store" in refusal(exc), (key, exc.value)
        # Neither spelling may put the answer in a log line.
        assert "Yes" not in str(exc.value), (key, exc.value)


@pytest.mark.parametrize("snake,camel", CASING_PAIRS, ids=[p[1] for p in CASING_PAIRS])
def test_the_two_spellings_are_recognised_by_the_same_patterns(conn, snake, camel):
    """Why the pair above cannot drift apart again, asserted one level below the
    RPC: the two spellings are not two keys the registry happens to cover, they
    are recognised by the SAME patterns.

    A change that catches the camelCase spelling by bolting a second pattern onto
    the registry rather than by fixing the normalisation passes the test above and
    fails this one.

    The property is "the same patterns match", not "the normalised strings are
    identical", and the difference is one pair: `ssnLast4` normalises to
    `ssn_last4` while `ssn_last_4` keeps its digit as a word. Splitting letter
    from digit would make those identical AND would turn `H1B` into `h_1_b`, which
    `(^|_)h1b` does not match — see
    `test_the_case_split_does_not_walk_a_digit_bearing_pattern_past_the_registry`.
    Both spellings hit `(^|_)ssn(_|$)`, which is the thing that has to be true.
    """
    _system(conn)
    matched = {}
    for spelling in (snake, camel):
        matched[spelling] = conn.execute(
            "select array(select p from unnest("
            "         public.hq_autopilot_sensitive_answer_patterns()) as p"
            "        where public.hq_autopilot_normalise_field_key(%s) ~ p order by p)",
            (spelling,)).fetchone()[0]
    assert matched[snake], f"{snake!r} matches no pattern at all"
    assert matched[snake] == matched[camel], matched


def test_the_engine_lane_gets_the_camelcase_refusal_too(conn, actor):
    """"For every writer" again, in the convention that used to escape it. A raw
    `service_role` insert — no RPC, no browser — with the camelCase spelling.
    """
    _system(conn)
    conn.execute("set role service_role")
    try:
        for _snake, camel in CASING_PAIRS:
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
                conn.execute(
                    "insert into public.autopilot_stages "
                    "  (user_id, application_id, provider, answers) "
                    "values (%s, %s, 'greenhouse', %s::jsonb)",
                    (actor["uid"], actor["app"],
                     json.dumps({camel: {"value": "F-1 OPT", "source": "resume_evidence"}})))
            assert "may not store" in refusal(exc), (camel, exc.value)
            assert "F-1 OPT" not in str(exc.value), (camel, exc.value)
    finally:
        _system(conn)


@pytest.mark.parametrize("key", ["h1b_status", "H1B", "requiresH1BSponsorship",
                                 "ssnLast4", "SSN_LAST_4"])
def test_the_case_split_does_not_walk_a_digit_bearing_pattern_past_the_registry(
        conn, actor, key):
    """The regression the fix could have introduced, pinned.

    Splitting letter from digit as well as case from case would make `ssnLast4`
    normalise to `ssn_last_4` — tidier — and would also turn `H1B` into `h_1_b`,
    which `(^|_)h1b` does not match. That would fix camelCase by opening a visa
    hole, which is the same failure in the other direction. The normalisation
    deliberately does not touch digits, and this is what says so.
    """
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        stage(conn, actor, answers={key: {"value": "Yes", "source": "drafted"}})
    assert "may not store" in refusal(exc), (key, exc.value)


def test_the_case_split_does_not_refuse_an_ordinary_camelcase_question(conn, actor):
    """Over-inclusive is the tuning; "refuses every camelCase key" is not.

    `preferredLanguage` is the one that matters: it normalises to
    `preferred_language`, and the reason the `(^|_)age(_|$)` anchor is kept rather
    than dropped is that an unanchored `age` refuses it.
    """
    out = stage(conn, actor, answers={
        "firstName":            {"value": "A", "source": "user_fact"},
        "whyDoYouWantToWorkHere": {"value": "…", "source": "drafted"},
        "yearsOfExperience":    {"value": "7", "source": "resume_evidence"},
        "preferredLanguage":    {"value": "en", "source": "user_fact"},
        "linkedInUrl":          {"value": "…", "source": "user_fact"},
    })
    assert out["stage"]["state"] == "ready_for_review"


def test_mutation_normalising_without_the_case_boundary_lets_camelcase_through(conn, actor):
    """B3 round 2, reproduced: the reviewed normalisation, restored, and the exact
    divergence it produced — `applicant_gender` refused, `applicantGender` stored.
    """
    camel = {"applicantGender": {"value": "…", "source": "drafted"}}
    snake = {"applicant_gender": {"value": "…", "source": "drafted"}}
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.hq_autopilot_normalise_field_key(p_key text)
            returns text language sql immutable
            set search_path = pg_catalog, pg_temp
            as $fn$ select regexp_replace(lower(coalesce(p_key, '')),
                                          '[^a-z0-9]+', '_', 'g') $fn$""")
        out = stage(conn, actor, answers=camel)
        assert out["stage"]["answers"]["applicantGender"]["source"] == "drafted", \
            "the mutation did not reproduce the bug"
        _system(conn)
        conn.execute("delete from public.autopilot_stages where user_id = %s", (actor["uid"],))
        # And the divergence itself: the SAME question, spelled the other way, is
        # refused under the same registry. Two spellings, two answers.
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            stage(conn, actor, answers=snake)
    finally:
        _system(conn)
        conn.execute("delete from public.autopilot_stages where user_id = %s", (actor["uid"],))
        _restore(conn)

    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        stage(conn, actor, answers=camel)
    assert "may not store" in refusal(exc), exc.value


def test_a_homoglyph_key_is_a_declared_non_goal(conn, actor):
    """Not a gap, a decision, and it is here so it is a WATCHED one.

    `аuthorization_status` with a Cyrillic `а` normalises to `_uthorization` and
    matches nothing. The keys come from a provider's own form, read by our
    preparer, so the party who would have to plant one is the employer whose form
    the user chose to apply to; the defence is Unicode confusable folding inside a
    normalisation four triggers need immutable and cheap. The reasoning is in the
    migration header. This test records the current behaviour rather than
    asserting it is right — if autopilot ever takes a field key from somewhere
    other than a parsed provider form, this test is the one that has to change,
    and changing it is the prompt to retake the decision.
    """
    out = stage(conn, actor, answers={
        "аuthorization_status": {"value": "Yes", "source": "drafted"}})
    assert out["stage"]["state"] == "ready_for_review"
    # The ASCII spelling of the same key is refused, which is what makes the line
    # above a homoglyph finding rather than a missing pattern.
    _system(conn)
    conn.execute("delete from public.autopilot_stages where user_id = %s", (actor["uid"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        stage(conn, actor, answers={"authorization_status": {"value": "Yes", "source": "drafted"}})


def test_an_unknown_answer_source_is_refused(conn, actor):
    """Packet 06B's four layers are a closed vocabulary. An answer with no source
    is an answer whose provenance nobody can audit — and would slip past the
    sensitive check, which keys on it.
    """
    with pytest.raises(psycopg.errors.Error) as exc:
        stage(conn, actor, answers={"q1": {"value": "x", "source": "vibes"}})
    assert "unknown source" in refusal(exc), exc.value
    with pytest.raises(psycopg.errors.Error):
        stage(conn, actor, answers={"q1": {"value": "x"}})


# ═══════════════════════════════════════════════════════════ the attachments

def test_an_attachment_must_be_this_users_artifact_at_that_checksum(conn, actor):
    """"A submission uses the exact approved payload and attachments." The
    checksum is what makes the second half true: `resume_artifacts` is immutable
    evidence (0026), so an approved attachment cannot become different bytes under
    the same id.

    Three ways to be wrong, all refused: a wrong checksum, somebody else's file,
    and a file that does not exist.

    KILLED BY: deleting the attachment loop from `hq_autopilot_package_guard`.
    """
    other = new_user(conn, "other")
    other_art, other_sha = make_artifact(conn, other)

    for label, atts in (
        ("wrong checksum",
         [{"artifactId": actor["artifact"], "sha256": "a" * 64}]),
        ("another account's file",
         [{"artifactId": other_art, "sha256": other_sha}]),
        ("a file that does not exist",
         [{"artifactId": 9_999_999, "sha256": "b" * 64}]),
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            stage(conn, actor, attachments=atts)
        assert "is not this user's artifact at that checksum" in refusal(exc), (
            f"{label}: {exc.value}")


# ═════════════════════════════════════════════════════════════ the audit trail

def test_every_transition_is_recorded_with_a_server_derived_actor(conn, actor):
    """The trail is written by a TRIGGER, so "the RPC forgot its audit row" has no
    expression. The actor is derived from the session, never from a parameter — a
    caller who may name the actor may name somebody else.

    KILLED BY: dropping `autopilot_stages_audit`.
    """
    s = stage(conn, actor)["stage"]
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"], reason="looks right")
    force_state(conn, s["id"], "submitting", reason="executor picked it up")

    _system(conn)
    trail = conn.execute(
        "select from_state, to_state, actor, actor_user_id, reason, package_hash "
        "  from public.autopilot_transitions where stage_id = %s order by id", (s["id"],)
    ).fetchall()
    assert [(t[0], t[1]) for t in trail] == [
        (None, "preparing"),
        ("preparing", "ready_for_review"),
        ("ready_for_review", "approved"),
        ("approved", "submitting"),
    ], trail

    # the browser gestures are attributed to the person; the engine lane is not
    assert [t[2] for t in trail] == ["user", "user", "user", "operator"], trail
    assert all(t[3] == uuid.UUID(actor["uid"]) for t in trail[:3])
    assert trail[3][3] is None, "the engine lane must not be attributed to a person"
    assert trail[2][4] == "looks right"
    assert all(t[5] == row(conn, s["id"])["payload_hash"] for t in trail)


def test_the_engine_lane_is_recorded_as_the_engine(conn, actor):
    """`operator` and `engine` are both identity-less, and telling them apart is
    what `current_setting('role')` is for — `current_user` inside a definer is the
    function's owner, so it cannot answer this.
    """
    sid = approved_stage(conn, actor)
    _system(conn)
    conn.execute("set role service_role")
    conn.execute("update public.autopilot_stages set state = 'cancelled' where id = %s", (sid,))
    _system(conn)
    assert conn.execute(
        "select actor from public.autopilot_transitions where stage_id = %s order by id desc "
        "limit 1", (sid,)).fetchone()[0] == "engine"


def test_an_edit_is_not_a_transition_in_the_trail(conn, actor):
    """A trail that recorded every save would bury the four rows that matter.
    """
    s = stage(conn, actor, state="preparing")["stage"]
    stage(conn, actor, state="preparing", version="v7")
    _system(conn)
    assert conn.execute(
        "select count(*) from public.autopilot_transitions where stage_id = %s",
        (s["id"],)).fetchone()[0] == 1


def test_the_trail_and_the_receipts_cannot_be_rewritten(conn, actor):
    """Append-only for the writer that bypasses RLS too. `service_role` loses
    UPDATE and DELETE outright, and the trigger is the layer under that.

    KILLED BY: dropping the revokes, or the append-only triggers.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    file_receipt(conn, actor, sid)

    _system(conn)
    for sql in (
        "update public.autopilot_transitions set actor = 'engine' where stage_id = %s",
        "delete from public.autopilot_transitions where stage_id = %s",
        "update public.autopilot_receipts set evidence_class = 4 where stage_id = %s",
        "delete from public.autopilot_receipts where stage_id = %s",
    ):
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(sql, (sid,))
        assert "append-only evidence" in refusal(exc), f"{sql}: {exc.value}"


def test_a_cross_owner_trail_or_receipt_row_cannot_exist(conn, actor):
    """The evidence tables denormalise `user_id` too, so they get the same FK.

    Driven as `service_role`, which holds INSERT on both and bypasses RLS — the
    writer for which "the trigger checks it" is the only other answer.

    KILLED BY: dropping `autopilot_receipts_stage_owner_fk` or
    `autopilot_transitions_stage_owner_fk`.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    other = new_user(conn, "thief")
    _system(conn)
    with pytest.raises(psycopg.errors.Error):
        conn.execute(
            "insert into public.autopilot_receipts "
            "  (user_id, stage_id, evidence_class, provider_reference) "
            "values (%s, %s, 1, 'GH-1')", (other, sid))
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute(
            "insert into public.autopilot_transitions "
            "  (user_id, stage_id, to_state, actor) values (%s, %s, 'submitted', 'engine')",
            (other, sid))


def test_the_engine_lane_is_bounded_too(conn, actor):
    """The RPCs cap what a browser sends. These caps are the ones that also apply
    to the executor, which is the only writer some of these fields will ever have.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    _system(conn)
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "insert into public.autopilot_receipts "
            "  (user_id, stage_id, evidence_class, provider_reference, evidence) "
            "values (%s, %s, 1, 'GH-1', %s::jsonb)",
            (actor["uid"], sid, json.dumps({"page": "x" * 40000})))
    assert "evidence too large" in refusal(exc), exc.value

    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "update public.autopilot_stages set transition_reason = %s where id = %s",
            ("z" * 600, sid))
    assert "reason too long" in refusal(exc), exc.value


def test_a_high_class_receipt_needs_a_provider_reference(conn, actor):
    """Class 1 and 2 ARE a provider-issued identifier. A class-1 receipt without
    one is a class-4 receipt wearing a better label, and `submitted` would then
    rest on evidence nobody can check.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    _system(conn)
    with pytest.raises(psycopg.errors.Error):
        conn.execute(
            "insert into public.autopilot_receipts (user_id, stage_id, evidence_class) "
            "values (%s, %s, 1)", (actor["uid"], sid))
    # class 3 and 4 do not carry one, and are storable
    conn.execute(
        "insert into public.autopilot_receipts (user_id, stage_id, evidence_class) "
        "values (%s, %s, 4)", (actor["uid"], sid))


def test_undoing_a_triage_still_works_when_a_stage_was_prepared(conn, actor):
    """The landmine this migration had to defuse rather than lay.

    `delete from public.applications` appears in FOUR shipped RPCs — 0003's
    un-triage, 0006's bulk un-triage, 0011's import undo, 0019's digest undo. Each
    cascades into `autopilot_stages` and then into `autopilot_transitions`. The
    first draft's append-only trigger refused that cascade, which would have made
    a brand new table silently break four existing gestures with an error about a
    table the user has never heard of.

    KILLED BY: removing the `not exists (… autopilot_stages …)` half of the
    trail's carve-out.
    """
    stage(conn, actor)
    _system(conn)
    conn.execute("delete from public.applications where id = %s", (actor["app"],))
    assert conn.execute(
        "select count(*) from public.autopilot_stages where user_id = %s", (actor["uid"],)
    ).fetchone()[0] == 0
    assert conn.execute(
        "select count(*) from public.autopilot_transitions where user_id = %s", (actor["uid"],)
    ).fetchone()[0] == 0


def test_undo_cannot_erase_a_submission(conn, actor):
    """And the other half, which is why the carve-out above is safe.

    "Undo" on a job Job HQ really did apply to must not cascade away the receipt —
    the only proof the application exists. It refuses, loudly, because the correct
    answer is to tell the person it was submitted.

    KILLED BY: dropping `autopilot_stages_keep_committed`. The receipt, the trail
    and the stage all disappear and the undo reports success.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    file_receipt(conn, actor, sid)
    force_state(conn, sid, "submitted")

    _system(conn)
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("delete from public.applications where id = %s", (actor["app"],))
    assert "cannot be removed" in refusal(exc), exc.value
    assert conn.execute(
        "select count(*) from public.autopilot_receipts where stage_id = %s", (sid,)
    ).fetchone()[0] == 1


# ══════════════════════════════ B1: a receipt is protected by its EXISTENCE
#
# The first version of both guards keyed on the STATE. Review T3/B1 showed the
# state is only a proxy: a receipt is filed while the stage is `submitting`, and
# `submitting → cancelled | failed_retryable | failed_terminal` are all legal, so
# the row walks out of `hq_autopilot_committed_states()` still holding a class-1
# provider confirmation. The reviewer then drove the real shipped
# `app_set_triage(…, 'dismissed')` and got `receipts = 0, transitions = 0`.
#
# Two closures, and both are here because they fail in different worlds:
#   the ARROW — a receipt-bearing stage cannot become cancelled or failed at all;
#   the DELETE GUARD — and if one is somehow in that state anyway (a row that
#   predates the arrow, a restore, a disabled trigger), it still cannot be
#   deleted.

def test_a_receipt_bearing_stage_cannot_settle_as_cancelled_or_failed(conn, actor):
    """The arrow. "The provider confirmed" has exactly one honest exit.

    KILLED BY: deleting the receipt-existence branch guarding
    `cancelled/failed_retryable/failed_terminal` from `hq_autopilot_state_machine`
    — the stage then leaves the committed set carrying its receipt, which is the
    precondition for the erasure below.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    file_receipt(conn, actor, sid)

    for target in ("cancelled", "failed_retryable", "failed_terminal"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
            force_state(conn, sid, target)
        assert "holds a provider receipt" in refusal(exc), f"{target}: {exc.value}"
        assert row(conn, sid)["state"] == "submitting"

    # And the honest exit is still open, so this is a gate and not a wall.
    force_state(conn, sid, "submitted")
    assert row(conn, sid)["state"] == "submitted"


def _cancelled_stage_holding_a_receipt(conn, actor) -> int:
    """A stage in `cancelled` that holds a receipt.

    The arrow above refuses to build one, so it is built with the state machine
    DISABLED — which is exactly the writer the delete guard exists to hold
    against: a restore, an operator session, a helper that turned a trigger off,
    or a row written before the arrow was closed.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    file_receipt(conn, actor, sid)
    _system(conn)
    conn.execute("alter table public.autopilot_stages "
                 "disable trigger autopilot_stages_state_machine")
    try:
        force_state(conn, sid, "cancelled")
    finally:
        _system(conn)
        conn.execute("alter table public.autopilot_stages "
                     "enable trigger autopilot_stages_state_machine")
    assert row(conn, sid)["state"] == "cancelled"
    return sid


@pytest.mark.parametrize("triage", ["dismissed", ""])
def test_the_real_untriage_gesture_cannot_erase_a_receipt_in_any_state(conn, actor, triage):
    """Review T3/B1's own probe, as a test: the SHIPPED gesture, the settled
    state, and the receipt that has to survive both.

    KILLED BY: removing the `exists (… autopilot_receipts …)` branch from
    `hq_autopilot_committed_stages_are_kept`. The mutation below drives exactly
    that and watches the receipt and the trail disappear.
    """
    key, a = triaged_application(conn, actor)
    sid = _cancelled_stage_holding_a_receipt(conn, a)

    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        untriage(conn, a, key, triage)
    assert "cannot be removed" in refusal(exc), exc.value

    stages, transitions, receipts = evidence_counts(conn, a)
    assert (stages, receipts) == (1, 1), "the evidence did not survive the gesture"
    assert transitions >= 1, "the audit trail did not survive the gesture"

    # The bulk gesture (0006) and the digest gesture (0019) reach the same
    # cascade from different lanes. Both refuse.
    _as(conn, a["uid"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute("select public.app_set_triage_bulk(%s, 'dismissed', null, '', %s, null)",
                     ([key], str(uuid.uuid4())))
    assert "cannot be removed" in refusal(exc), exc.value

    _system(conn)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute("select public.hq_digest_set_triage(%s, %s, 'dismissed', %s)",
                     (a["uid"], key, str(uuid.uuid4())))
    assert "cannot be removed" in refusal(exc), exc.value
    assert evidence_counts(conn, a)[2] == 1


def test_the_real_untriage_gesture_still_works_when_there_is_no_evidence(conn, actor):
    """The other direction, which is what makes the guard a gate.

    A prepared stage that never recorded provider evidence carries nothing worth
    keeping, and un-triage must still cascade it away cleanly — that is the
    landmine this migration had to defuse rather than lay.
    """
    key, a = triaged_application(conn, actor)
    stage(conn, a)                      # ready_for_review, no receipt
    stages, transitions, receipts = evidence_counts(conn, a)
    assert (stages, receipts) == (1, 0) and transitions >= 1

    untriage(conn, a, key, "dismissed")
    assert evidence_counts(conn, a) == (0, 0, 0)

    # And with an approval on it, which is still not evidence of a submission.
    key2, a2 = triaged_application(conn, actor)
    approved_stage(conn, a2)
    untriage(conn, a2, key2, "")
    assert evidence_counts(conn, a2) == (0, 0, 0)


def test_erasure_still_works_with_every_guard_attached(conn, actor):
    """The failure that would show up at the worst possible moment.

    `delete from public.users` cascades applications → stages → transitions and
    receipts. It runs with no browser identity, so `hq_entitlement_guard` opens
    its hatch, and the append-only triggers recognise "the owner is already gone"
    as the cascade's signature. Without those carve-outs one transition row makes
    GDPR erasure a permanent hard failure.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    file_receipt(conn, actor, sid)
    force_state(conn, sid, "submitted")

    _system(conn)
    conn.execute("delete from public.users where id = %s", (actor["uid"],))
    for table in ("autopilot_stages", "autopilot_transitions", "autopilot_receipts"):
        assert conn.execute(
            f"select count(*) from public.{table} where user_id = %s", (actor["uid"],)
        ).fetchone()[0] == 0, table


# ═══════════════════════════════════ the mutations, built for real and removed
#
# A guard nobody has watched fail is a guard that passes because it looks at
# nothing. Each of these breaks the schema exactly as a careless change would,
# re-runs the SAME test function that is supposed to catch it, asserts it goes
# red, and restores the migration in a `finally` so a failure here cannot poison
# the session schema for the tests after it.


def test_mutation_dropping_the_state_machine_lets_outcome_unknown_retry(conn, actor):
    """The most dangerous single mutation in this file.

    With the trigger gone, `outcome_unknown → submitting` succeeds: a stage whose
    submission may already have reached the employer goes back through the
    executor. The employer receives two applications.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    force_state(conn, sid, "outcome_unknown")
    try:
        _system(conn)
        conn.execute("drop trigger autopilot_stages_state_machine on public.autopilot_stages")
        force_state(conn, sid, "submitting")     # the bug, reproduced
        assert row(conn, sid)["state"] == "submitting", (
            "the mutation did not reproduce the bug, so the test below proves nothing")
    finally:
        _restore(conn)

    # and with the trigger back, the same move is refused
    force_state(conn, sid, "outcome_unknown") if row(conn, sid)["state"] != "outcome_unknown" \
        else None
    with pytest.raises(psycopg.errors.Error):
        force_state(conn, sid, "submitting")


def test_mutation_widening_the_transition_map_is_caught(conn):
    """`test_every_state_pair_agrees_with_the_declared_machine` has to fail when
    one arrow is added — otherwise it is a mirror of the SQL rather than a check
    on it.
    """
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.hq_autopilot_transition_allowed(
              p_from text, p_to text)
            returns boolean language sql immutable set search_path = pg_catalog, pg_temp
            as $fn$
              select (p_from || '>' || p_to) = any (array[
                'preparing>needs_input','preparing>ready_for_review','preparing>cancelled',
                'needs_input>preparing','needs_input>ready_for_review','needs_input>cancelled',
                'ready_for_review>preparing','ready_for_review>needs_input',
                'ready_for_review>changes_requested','ready_for_review>approved',
                'ready_for_review>cancelled',
                'changes_requested>preparing','changes_requested>needs_input',
                'changes_requested>ready_for_review','changes_requested>cancelled',
                'approved>submitting','approved>changes_requested',
                'approved>ready_for_review','approved>cancelled',
                'submitting>submitted','submitting>outcome_unknown',
                'submitting>failed_retryable','submitting>failed_terminal',
                'submitting>cancelled',
                'outcome_unknown>submitted','outcome_unknown>failed_terminal',
                'outcome_unknown>submitting',   -- THE MUTATION
                'failed_retryable>approved','failed_retryable>changes_requested',
                'failed_retryable>ready_for_review','failed_retryable>cancelled'
              ]);
            $fn$""")
        with pytest.raises(AssertionError, match="outcome_unknown"):
            test_every_state_pair_agrees_with_the_declared_machine(conn)
    finally:
        _restore(conn)
    test_every_state_pair_agrees_with_the_declared_machine(conn)


def test_mutation_dropping_the_live_attempt_index_allows_a_second_submission(conn, actor):
    """The duplicate-prevention layer, removed. A retry stage for an ambiguous
    attempt is then created — which is the production consequence: two
    applications to one employer for one job.
    """
    sid = approved_stage(conn, actor)
    force_state(conn, sid, "submitting")
    force_state(conn, sid, "outcome_unknown")
    try:
        _system(conn)
        conn.execute("drop index public.autopilot_stages_one_live_attempt")
        conn.execute(
            "insert into public.autopilot_stages (user_id, application_id, provider) "
            "values (%s, %s, 'greenhouse')", (actor["uid"], actor["app"]))
        assert conn.execute(
            "select count(*) from public.autopilot_stages where application_id = %s",
            (actor["app"],)).fetchone()[0] == 2, "the mutation did not reproduce the bug"
    finally:
        _system(conn)
        conn.execute(
            "delete from public.autopilot_stages where application_id = %s and state = 'preparing'",
            (actor["app"],))
        _restore(conn)

    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "insert into public.autopilot_stages (user_id, application_id, provider) "
            "values (%s, %s, 'greenhouse')", (actor["uid"], actor["app"]))


def test_mutation_dropping_the_approval_binding_lets_a_forged_approval_submit(conn, actor):
    """Without the hash comparison, an `approved_hash` that matches nothing starts
    a submission — the executor sends a package no human ever saw.
    """
    sid = approved_stage(conn, actor)
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.hq_autopilot_state_machine()
            returns trigger language plpgsql set search_path = public, pg_temp
            as $fn$
            begin
              -- everything except the approval binding
              if new.state is distinct from old.state
                 and not public.hq_autopilot_transition_allowed(old.state, new.state) then
                raise exception 'illegal' using errcode = '22023';
              end if;
              return new;
            end $fn$""")
        conn.execute(
            "update public.autopilot_stages set approved_hash = %s where id = %s",
            ("f" * 64, sid))
        force_state(conn, sid, "submitting")
        assert row(conn, sid)["state"] == "submitting", "the mutation did not reproduce the bug"
    finally:
        _restore(conn)

    with pytest.raises(psycopg.errors.Error) as exc:
        force_state(conn, sid, "submitted")
    assert "without a receipt" in refusal(exc)


def test_mutation_dropping_the_reviewer_requirement_lets_the_engine_submit(conn):
    """B2, reproduced as the reviewer ran it: BOTH layers removed, because both
    were absent in the version under review.

    With the constraint's `approved_by is not null` gone and the state machine's
    identity branch gone, a session with no `auth.uid()` at all mints an approval
    with `approved_by = NULL` and then starts a submission. "Who authorised this
    application" answers NULL on a row that is on its way to an employer.

    Its own user, and erased at the end: the mutated rows cannot satisfy the
    constraint the `finally` puts back, and owner erasure is the one cascade that
    is allowed to take them.
    """
    a = fresh_actor(conn, "b2-mutation")
    s = stage(conn, a)["stage"]
    try:
        _system(conn)
        conn.execute("alter table public.autopilot_stages "
                     "drop constraint autopilot_stages_approval_matches_state")
        conn.execute("""
            create or replace function public.hq_autopilot_state_machine()
            returns trigger language plpgsql set search_path = public, pg_temp
            as $fn$
            begin
              -- the reviewed file, minus the two things review B2 added
              if new.state is distinct from old.state
                 and not public.hq_autopilot_transition_allowed(old.state, new.state) then
                raise exception 'illegal' using errcode = '22023';
              end if;
              return new;
            end $fn$""")
        conn.execute(
            "update public.autopilot_stages "
            "   set state = 'approved', approved_hash = %s, approved_at = now() "
            " where id = %s", (s["packageHash"], s["id"]))
        conn.execute("update public.autopilot_stages set state = 'submitting' where id = %s",
                     (s["id"],))
        r = row(conn, s["id"])
        assert (r["state"], r["approved_by"]) == ("submitting", None), (
            "the mutation did not reproduce the bug, so the tests above prove nothing")
    finally:
        _system(conn)
        conn.execute("delete from public.users where id = %s", (a["uid"],))
        _restore(conn)

    # And with both layers back, the same two statements are refused — the first
    # by the machine, and the second is never reached.
    b = fresh_actor(conn, "b2-restored")
    s2 = stage(conn, b)["stage"]
    _system(conn)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute(
            "update public.autopilot_stages "
            "   set state = 'approved', approved_hash = %s, approved_at = now() "
            " where id = %s", (s2["packageHash"], s2["id"]))
    assert "without a signed-in reviewer" in refusal(exc), exc.value
    assert row(conn, s2["id"])["state"] == "ready_for_review"


def test_mutation_keying_the_delete_guard_on_the_state_erases_a_receipt(conn, actor):
    """B1, reproduced exactly as the reviewer found it.

    The guard is restored to its FIRST version — state only, no receipt clause —
    and the real shipped `app_set_triage(…, 'dismissed')` then erases a class-1
    provider confirmation and the entire audit trail, reporting success. That is
    the mutation `test_the_real_untriage_gesture_cannot_erase_a_receipt_in_any_state`
    has to fail on, and it is the reason receipt EXISTENCE and not the state word
    is what the guard reads.
    """
    key, a = triaged_application(conn, actor)
    sid = _cancelled_stage_holding_a_receipt(conn, a)
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.hq_autopilot_committed_stages_are_kept()
            returns trigger language plpgsql set search_path = public, pg_temp
            as $fn$
            begin
              if not exists (select 1 from public.users where id = old.user_id) then
                return old;
              end if;
              if old.state = any (public.hq_autopilot_committed_states()) then
                raise exception 'state-only guard' using errcode = '42501';
              end if;
              return old;
            end $fn$""")
        untriage(conn, a, key, "dismissed")          # the bug, reproduced
        assert evidence_counts(conn, a) == (0, 0, 0), (
            "the mutation did not reproduce the bug, so the test above proves nothing")
    finally:
        _restore(conn)

    # And with the receipt clause back, the same gesture against the same shape
    # is refused and the evidence stands.
    key2, a2 = triaged_application(conn, actor)
    _cancelled_stage_holding_a_receipt(conn, a2)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        untriage(conn, a2, key2, "dismissed")
    assert "cannot be removed" in refusal(exc), exc.value
    assert evidence_counts(conn, a2)[2] == 1


def test_mutation_dropping_the_sensitive_branch_stores_an_inferred_answer(conn, actor):
    """The product rule, removed. A model-drafted answer to "are you authorised to
    work in the US" is stored, and would be submitted.
    """
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.hq_autopilot_package_guard()
            returns trigger language plpgsql set search_path = public, pg_temp
            as $fn$ begin return new; end $fn$""")
        out = stage(conn, actor, answers={
            "q1": {"value": "Yes", "kind": "work_authorization", "source": "drafted"}})
        assert out["stage"]["answers"]["q1"]["source"] == "drafted", (
            "the mutation did not reproduce the bug")
    finally:
        _system(conn)
        conn.execute("delete from public.autopilot_stages where user_id = %s", (actor["uid"],))
        _restore(conn)

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        stage(conn, actor, answers={
            "q1": {"value": "Yes", "kind": "work_authorization", "source": "drafted"}})


def test_mutation_dropping_the_entitlement_guard_lets_a_suspended_account_write(conn):
    """0028's mistake, rehearsed on this migration's tables.

    With the trigger gone the restrictive policy is still there and still says
    nothing, because the RPC is `security definer` and a definer bypasses RLS by
    construction. A suspended account stages an application.

    THE MUTATION IS DRIVEN THROUGH A PROBE DEFINER, NOT THROUGH THE REAL RPC, and
    the reason is the single most useful thing this file found.

    Dropping the guard from `autopilot_stages` and calling
    `app_stage_autopilot_application` STILL RAISES. The RPC writes four gated
    tables in one transaction, and each one refuses in turn: first
    `autopilot_transitions` (the audit trigger fires inside the same statement),
    then `public.events`, then `public.command_idempotency` — the latter two
    belonging to 0003 and 0027, not to this migration at all.

    None of those is a substitute for the guard on `autopilot_stages`. Every one
    of them fires AFTER the stage row has been written, so they abort a
    transaction rather than prevent a write, and any of them could be moved by a
    future refactor without anybody noticing that the real gate went with it.

    It is also exactly why the non-mutation test above asserts the refusal NAMES
    `autopilot_stages`. A bare `pytest.raises` there would have stayed green with
    this migration's guard missing entirely — passing on the wrong mechanism, and
    proving nothing about the table it claims to be about.

    So the probe writes ONLY `autopilot_stages`, which strips every other layer
    away and leaves this migration's guard as the only thing standing. It is the
    same shape `test_default_deny.py::test_an_anonymous_session_gets_no_engine_hatch`
    uses, for the same reason.
    """
    uid = new_user(conn, "susp")
    app_id = make_application(conn, uid)
    _system(conn)
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (uid,))
    conn.execute("""
        create or replace function public.hq_test_autopilot_probe(p_app bigint)
        returns bigint language plpgsql security definer
        set search_path = public, pg_temp as $fn$
        declare v_id bigint;
        begin
          -- reads auth.uid() and writes ONLY the table under test
          insert into public.autopilot_stages (user_id, application_id, provider)
          values (auth.uid(), p_app, 'greenhouse') returning id into v_id;
          return v_id;
        end $fn$""")
    conn.execute("grant execute on function public.hq_test_autopilot_probe(bigint) to authenticated")
    try:
        conn.execute(
            "drop trigger autopilot_stages_entitlement_guard on public.autopilot_stages")
        conn.execute(
            "drop trigger autopilot_transitions_entitlement_guard "
            "  on public.autopilot_transitions")
        _as(conn, uid)
        assert conn.execute("select public.hq_test_autopilot_probe(%s)",
                            (app_id,)).fetchone()[0] is not None
        _system(conn)
        assert conn.execute(
            "select count(*) from public.autopilot_stages where user_id = %s", (uid,)
        ).fetchone()[0] == 1, "the mutation did not reproduce the bug"
    finally:
        _system(conn)
        conn.execute("delete from public.autopilot_stages where user_id = %s", (uid,))
        _restore(conn)

    # And with the guard back, the same probe — the same suspended session, the
    # same definer, the same statement — is refused, by name.
    _as(conn, uid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute("select public.hq_test_autopilot_probe(%s)", (app_id,))
    assert "not entitled" in refusal(exc) and "autopilot_stages" in refusal(exc), exc.value
    _system(conn)
    conn.execute("drop function if exists public.hq_test_autopilot_probe(bigint)")
    assert conn.execute(
        "select count(*) from public.autopilot_stages where user_id = %s", (uid,)
    ).fetchone()[0] == 0


def test_mutation_dropping_only_the_stages_guard_is_caught(conn):
    """B4's proof, and the point is the word ONLY.

    The reviewer dropped `autopilot_stages_entitlement_guard` and nothing else,
    and `test_a_non_entitled_account_is_refused_by_name` stayed GREEN: the refusal
    came from the neighbouring `autopilot_transitions`, and the assertion

        "autopilot_stages" in str(exc.value)

    was satisfied by psycopg's `CONTEXT:` block echoing the RPC's own
    `insert into public.autopilot_stages …`. The test was matching the SQL in the
    traceback rather than the guard's message, so both of its parametrisations
    were documented "KILLED BY: removing autopilot_stages from the entitlement
    loop" and were not.

    This runs THE SAME test function under THE SAME mutation and requires it to
    fail — on the by-name assertion specifically, not on some other error, which
    is what makes it evidence about the assertion rather than about the schema.
    """
    try:
        _system(conn)
        conn.execute(
            "drop trigger autopilot_stages_entitlement_guard on public.autopilot_stages")
        with pytest.raises(AssertionError) as exc:
            test_a_non_entitled_account_is_refused_by_name(conn, "suspended")
        # NOT `.diag.message_primary`: this `exc` is the AssertionError raised by
        # the inner test, not a psycopg error, and has no `diag`. The whole string
        # is the right target precisely because there is no CONTEXT block to be
        # fooled by — the text being matched is one this file authored.
        assert "did not name autopilot_stages" in str(exc.value), (
            f"the by-name test failed for a different reason, so this proves "
            f"nothing about the assertion: {exc.value}")
    finally:
        _restore(conn)

    # And unmutated, the same call passes — a mutation test that can only fail is
    # not a mutation test.
    test_a_non_entitled_account_is_refused_by_name(conn, "suspended")
