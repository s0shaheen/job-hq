"""The manual-handoff terminus (#206, T3 half), executed against Postgres.

`20260814_030545_autopilot_handoff.sql` adds one state (`handed_off`), one RPC
(`app_settle_autopilot_handoff`) and one precondition (the per-posting sibling
guard). Everything here RUNS, and the guards that matter carry a MUTATION test
showing the suite going red when the guard is removed.

WHAT IS BEING PROVEN, in the order the sections appear:

    the settle flow    'submitted' settles approved→handed_off AND writes manual
                       status 'Applied' through app_set_status, in one
                       transaction; 'abandoned' cancels, releases the slot, and
                       keeps the recorded approval
    status authority   the settle write lands with the same lock/actor semantics
                       app_set_status enforces: status_actor='user', the human
                       lock stamped, a reopen still demanding a note
    no receipts        settling writes zero rows to autopilot_receipts, ever,
                       and handed_off on top of a receipt is refused
    approval integrity entering handed_off re-checks the approval against the
                       stored package — the trigger-disabled service_role edit
                       is caught at the settling transition
    the terminus       handed_off is terminal, slot-occupying, and not retryable
    the sibling guard  a keyed row and a manual row for one posting cannot BOTH
                       hold a live attempt through any sequential path — and the
                       race window that remains is documented, not denied
    authority          wrong owner P0002, anonymous 28000, pending/suspended
                       refused by the entitlement guard BY NAME
    idempotency        replay returns the first answer; a reused key with
                       different arguments is 22023
    concurrency        a stale updated_at is a 40001 naming `conflict`

The same caution as the staging suite: these RPCs also write `public.events`
and `public.applications`, both gated, so refusal assertions read
`diag.message_primary` (via `refusal()`) or assert a state the wrong mechanism
could not have produced.

Run it the way the rest of this directory runs:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55444:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55444/postgres HQ_REQUIRE_DB=1 \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q
"""
from __future__ import annotations

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

from tests.db.test_autopilot_staging import (  # noqa: E402  (harness shared on purpose)
    _as,
    _system,
    approved_stage,
    make_application,
    make_artifact,
    new_user,
    refusal,
    review,
    row,
    stage,
)
from tests.db.test_write_path import (  # noqa: E402
    as_definer,
    guard_verdict,
    make_posting,
    schema,  # noqa: F401 — session fixture
)

ROOT = Path(__file__).resolve().parents[2]

#: Both autopilot migrations, in filename order. `_restore` re-applies BOTH:
#: the staging file `create or replace`s the shared functions with its
#: eleven-state versions, so re-applying it alone would revert the handoff
#: migration and every later test would run against a schema production will
#: never have.
AUTOPILOT_MIGRATIONS = sorted(
    p for p in (ROOT / "db" / "migrations").glob("*.sql")
    if p.name.endswith("_autopilot_staging.sql") or p.name.endswith("_autopilot_handoff.sql")
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def _restore(conn) -> None:
    """Re-apply both autopilot migrations, in order — see AUTOPILOT_MIGRATIONS."""
    _system(conn)
    for m in AUTOPILOT_MIGRATIONS:
        conn.execute(m.read_text())


@pytest.fixture
def actor(conn):
    """One entitled user with an application and an artifact to attach."""
    uid = new_user(conn, "handoff")
    app_id = make_application(conn, uid, company="HandoffCo")
    art_id, sha = make_artifact(conn, uid)
    return {"uid": uid, "app": app_id, "artifact": art_id, "sha": sha}


def settle(conn, actor, stage_id, outcome, *, reason="", idem=None, expected=None):
    """Drive `app_settle_autopilot_handoff` as the owner's browser session."""
    _as(conn, actor["uid"])
    return conn.execute(
        "select public.app_settle_autopilot_handoff(%s, %s, %s, %s, %s)",
        (stage_id, outcome, reason, idem or str(uuid.uuid4()), expected),
    ).fetchone()[0]


def application_row(conn, app_id) -> dict:
    _system(conn)
    r = conn.execute(
        "select status, status_actor, suggested_status from public.applications where id = %s",
        (app_id,)).fetchone()
    return dict(zip("status status_actor suggested_status".split(), r))


def receipt_count(conn, *, user_id=None) -> int:
    _system(conn)
    if user_id is None:
        return conn.execute("select count(*) from public.autopilot_receipts").fetchone()[0]
    return conn.execute(
        "select count(*) from public.autopilot_receipts where user_id = %s",
        (user_id,)).fetchone()[0]


def events_of(conn, user_id, kind) -> list[dict]:
    _system(conn)
    return [
        json.loads(r[0]) if isinstance(r[0], str) else r[0]
        for r in conn.execute(
            "select payload from public.events where user_id = %s and kind = %s "
            "order by id", (user_id, kind)).fetchall()
    ]


def keyed_sibling(conn, actor, company="HandoffCo", title="Product Manager") -> int:
    """The OTHER half of #207 blocker #1's coexisting pair. Two MANUAL rows for
    one posting cannot exist — 0002's `applications_manual_dedup` refuses them —
    and two KEYED rows cannot either (`unique (user_id, posting_key)`). What CAN
    exist is a KEYED row beside the actor's manual row: the unique constraint
    ignores nulls and the dedup index covers only the null-key side. That pair
    is exactly the shape the sibling guard exists to see."""
    _system(conn)
    key = f"greenhouse-{uuid.uuid4().hex[:10]}"
    make_posting(conn, key, company)
    return conn.execute(
        "insert into public.applications (user_id, posting_key, company, title, status) "
        "values (%s, %s, %s, %s, 'Queued') returning id",
        (actor["uid"], key, company, title)).fetchone()[0]


# ══════════════════════════════════════════════════════════════ the settle flow

def test_settling_submitted_is_the_terminus_and_the_manual_status_in_one_gesture(conn, actor):
    """The end-to-end flow the issue exists for: stage → approve → the user
    submits on the provider's own form → reports it. The stage settles
    `handed_off` with its approval intact, and the application's status becomes
    'Applied' AS A MANUAL STATUS — `status_actor = 'user'`, the suggestion
    cleared — because the settle RPC calls `app_set_status` rather than touching
    `applications` itself.

    KILLED BY: removing the `app_set_status` call from the settle RPC (the
    status assertions fail — the mutation test below drives exactly that), or
    removing `approved>handed_off` from the transition array (the settle raises).
    """
    s = stage(conn, actor)["stage"]
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])
    before = row(conn, s["id"])

    out = settle(conn, actor, s["id"], "submitted")

    assert out["outcome"] == "submitted"
    assert out["stage"]["state"] == "handed_off"
    assert out["application"]["status"] == "Applied"

    after = row(conn, s["id"])
    assert after["state"] == "handed_off"
    # The approval SURVIVES: who authorised it, and against what, stays true.
    assert after["approved_hash"] == before["approved_hash"] == before["payload_hash"]
    assert str(after["approved_by"]) == actor["uid"]

    app = application_row(conn, actor["app"])
    assert app["status"] == "Applied"
    assert app["status_actor"] == "user", (
        "the settle write did not land as a MANUAL status — it bypassed app_set_status")
    assert app["suggested_status"] == ""

    # The settle's own audit row, shape only.
    handed = events_of(conn, actor["uid"], "autopilot.handed_off")
    assert len(handed) == 1
    assert handed[0]["stageId"] == s["id"]
    assert handed[0]["outcome"] == "submitted"
    # And app_set_status's own event — the same one every human status write makes.
    assert len(events_of(conn, actor["uid"], "action.status")) == 1


def test_settling_writes_no_receipt_ever(conn, actor):
    """ZERO rows in `autopilot_receipts`, from either outcome. The evidence for
    handed_off is the user's word, recorded as manual status and an events row —
    never provider evidence this half cannot have.

    Counted across the WHOLE table, not just this stage: a mutated settle that
    filed a receipt against any row would fail here (the receipt guard would
    raise first — which also fails this test — and a guard-evading insert would
    move the count).

    KILLED BY: any insert into autopilot_receipts reachable from
    `app_settle_autopilot_handoff`.
    """
    total_before = receipt_count(conn)

    s = stage(conn, actor)["stage"]
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])
    settle(conn, actor, s["id"], "submitted")

    s2 = stage(conn, {**actor, "app": make_application(conn, actor["uid"], "OtherCo")})["stage"]
    review(conn, actor, s2["id"], "approve", package_hash=s2["packageHash"])
    settle(conn, actor, s2["id"], "abandoned")

    assert receipt_count(conn, user_id=actor["uid"]) == 0
    assert receipt_count(conn) == total_before


def test_settling_abandoned_cancels_releases_the_slot_and_keeps_the_approval(conn, actor):
    """'I didn't submit it' is a cancel: the stage settles `cancelled` THROUGH
    `app_review_autopilot_stage`, the one_live_attempt slot releases so a fresh
    attempt can be staged, and the recorded approval survives on the cancelled
    row — "who authorised this, and against what" does not depend on how the
    story ended. The application's status is untouched: nothing was submitted,
    so there is nothing to record.

    KILLED BY: clearing the approval columns in the cancel path, or leaving
    `handed_off`/`approved` in place so the slot never releases.
    """
    s = stage(conn, actor)["stage"]
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])
    out = settle(conn, actor, s["id"], "abandoned", reason="form was gone")

    assert out["outcome"] == "abandoned"
    assert out["stage"]["state"] == "cancelled"
    assert out["application"] is None

    after = row(conn, s["id"])
    assert after["state"] == "cancelled"
    assert after["approved_hash"] is not None
    assert str(after["approved_by"]) == actor["uid"]

    app = application_row(conn, actor["app"])
    assert app["status"] == "Queued"
    assert app["status_actor"] == "system"

    # The slot released: staging the same application again succeeds and CREATES.
    again = stage(conn, actor)
    assert again["created"] is True

    # The review RPC's own audit row is the cancel's record.
    assert len(events_of(conn, actor["uid"], "autopilot.cancelled")) == 1
    assert events_of(conn, actor["uid"], "autopilot.handed_off") == []


def test_settling_needs_an_approved_stage(conn, actor):
    """Only an approved package was handed off. Every other state — including a
    stage already settled — is a client that lost track of the row, answered
    with a sentence naming the state rather than a guess.

    KILLED BY: deleting the state check from the settle RPC (the state machine
    would still refuse the transition, but with its own message — the assertion
    on THIS sentence goes red).
    """
    s = stage(conn, actor)["stage"]
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        settle(conn, actor, s["id"], "submitted")
    assert "has no manual handoff to settle" in refusal(exc), exc.value
    assert "ready_for_review" in refusal(exc)
    assert row(conn, s["id"])["state"] == "ready_for_review"

    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])
    settle(conn, actor, s["id"], "submitted")
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        settle(conn, actor, s["id"], "abandoned")
    assert "has no manual handoff to settle" in refusal(exc), exc.value
    assert "handed_off" in refusal(exc)


def test_an_unknown_outcome_is_refused(conn, actor):
    """The outcome vocabulary is closed: submitted or abandoned, nothing else —
    not 'submitting', not 'yes', not ''.

    KILLED BY: widening the outcome check.
    """
    sid = approved_stage(conn, actor)
    for bad in ("maybe", "", "submitting"):
        with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
            settle(conn, actor, sid, bad)
        assert "unknown handoff outcome" in refusal(exc), exc.value
    assert row(conn, sid)["state"] == "approved"


# ═══════════════════════════════════════════════════════════ status authority

def test_reopening_a_finished_application_still_demands_a_note(conn, actor):
    """`app_set_status`'s reopen rule holds INSIDE the settle, which is the
    proof the settle goes through the manual-status machinery rather than
    around it: an application the user had finished ('Rejected') being marked
    submitted is a reopen, and a reopen needs a note saying why. The refusal is
    app_set_status's own sentence, and the whole settle rolls back with it —
    the stage stays approved.

    KILLED BY: the settle RPC writing `applications.status` directly (no reopen
    rule would fire), or passing a fabricated note.
    """
    sid = approved_stage(conn, actor)
    _as(conn, actor["uid"])
    conn.execute("select public.app_set_status(%s, 'Rejected', '', %s, null)",
                 (actor["app"], str(uuid.uuid4())))

    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        settle(conn, actor, sid, "submitted")
    assert "reopening needs a note saying why" in refusal(exc), exc.value
    assert row(conn, sid)["state"] == "approved", "the refused settle must roll back whole"
    assert application_row(conn, actor["app"])["status"] == "Rejected"

    out = settle(conn, actor, sid, "submitted", reason="applied on the form after all")
    assert out["application"]["status"] == "Applied"
    assert row(conn, sid)["state"] == "handed_off"


def test_the_human_status_lock_is_stamped_by_the_settle(conn, actor):
    """After a settle, the status is LOCKED the way every human status write
    locks it: an engine write cannot move it. This is `status_actor = 'user'`
    proven by its consequence rather than read back — the lock trigger is the
    enforcement CLAUDE.md names for "manual application status is
    authoritative".

    KILLED BY: the settle stamping the status without the lock (a direct UPDATE
    leaves status_actor = 'system' and the engine write below succeeds).
    """
    sid = approved_stage(conn, actor)
    settle(conn, actor, sid, "submitted")

    _system(conn)
    conn.execute("set role service_role")
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute("update public.applications set status = 'Rejected' where id = %s",
                     (actor["app"],))
    _system(conn)
    assert "status is locked to the human choice" in refusal(exc), exc.value
    assert application_row(conn, actor["app"])["status"] == "Applied"


def test_a_pre_seeded_inner_key_cannot_swallow_the_status_write(conn, actor):
    """THE SECURITY REVIEW'S EXACT SCENARIO (finding 1).

    `app_set_status` (0010) predates 0026 and matches a replay on the KEY ALONE
    — no command name, no `request_hash`. A browser may send any string as
    `p_idem` to any RPC, so a caller who has once used the string the settle
    derives leaves a row the inner call would find and return, writing NOTHING:
    the reviewer landed `handed_off` on top of a `Rejected`/`user` application
    with zero `action.status` events.

    Here the caller poisons BOTH the old deterministic spelling and a plausible
    neighbour, then settles. The settle must either write the status or refuse
    — never report success with no write.

    KILLED BY: reverting the inner key to `autopilot-handoff-status:<id>` (the
    mutation transcript below drives exactly that and shows this test red).
    """
    sid = approved_stage(conn, actor)
    other = make_application(conn, actor["uid"], "PoisonCo")

    # The poisoning gesture: a REAL status write on a DIFFERENT application,
    # under the key the old code derived. Nothing here is privileged — it is one
    # ordinary RPC call with a caller-chosen key.
    _as(conn, actor["uid"])
    conn.execute("select public.app_set_status(%s, 'Rejected', 'poison', %s, null)",
                 (other, f"autopilot-handoff-status:{sid}"))

    out = settle(conn, actor, sid, "submitted")

    assert out["outcome"] == "submitted"
    app = application_row(conn, actor["app"])
    assert app["status"] == "Applied", (
        "the settle reported success while the inner status write was swallowed "
        "by a caller-seeded idempotency row")
    assert app["status_actor"] == "user"
    # The write really happened, not just the row happening to read right.
    assert len(events_of(conn, actor["uid"], "action.status")) >= 1
    assert receipt_count(conn, user_id=actor["uid"]) == 0


def test_mutation_a_deterministic_inner_key_reproduces_the_swallowed_status_write(conn, actor):
    """The transcript for the test above: with the inner key put back to its
    deterministic spelling, the reviewer's scenario reproduces exactly — the
    settle answers `submitted`, the stage reads `handed_off`, and the
    application is still `Rejected` with no `action.status` event.

    Then the real function refuses to produce that state.
    """
    sid = approved_stage(conn, actor)
    other = make_application(conn, actor["uid"], "PoisonCo")
    _as(conn, actor["uid"])
    conn.execute("select public.app_set_status(%s, 'Rejected', 'poison', %s, null)",
                 (other, f"autopilot-handoff-status:{sid}"))
    before = len(events_of(conn, actor["uid"], "action.status"))

    try:
        _system(conn)
        conn.execute("""
            create or replace function public.app_settle_autopilot_handoff(
              p_stage_id bigint, p_outcome text, p_reason text, p_idem text,
              p_expected_updated_at timestamptz)
            returns jsonb language plpgsql security definer
            set search_path = public, pg_temp
            as $mut$
            declare v_row public.autopilot_stages; v_app jsonb;
            begin
              update public.autopilot_stages set state = 'handed_off'
               where id = p_stage_id and user_id = auth.uid()
              returning * into v_row;
              -- the deterministic key, as the first draft had it
              v_app := public.app_set_status(
                         v_row.application_id, 'Applied', p_reason,
                         'autopilot-handoff-status:' || v_row.id::text, null);
              return jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                        'outcome', 'submitted', 'application', v_app);
            end $mut$""")
        out = settle(conn, actor, sid, "submitted")
        assert out["outcome"] == "submitted", "the mutation did not run"
        assert row(conn, sid)["state"] == "handed_off"
        app = application_row(conn, actor["app"])
        assert app["status"] != "Applied", "the mutation did not reproduce the bug"
        assert len(events_of(conn, actor["uid"], "action.status")) == before, (
            "the mutation did not reproduce the bug — a status event was written")
    finally:
        _system(conn)
        conn.execute("delete from public.autopilot_stages where user_id = %s", (actor["uid"],))
        _restore(conn)

    # The real function, same poisoning, on a fresh stage: the status lands.
    app2 = make_application(conn, actor["uid"], "AfterPoisonCo")
    s = stage(conn, {**actor, "app": app2})["stage"]
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])
    _as(conn, actor["uid"])
    conn.execute("select public.app_set_status(%s, 'Rejected', 'poison', %s, null)",
                 (other, f"autopilot-handoff-status:{s['id']}"))
    settle(conn, actor, s["id"], "submitted")
    assert application_row(conn, app2)["status"] == "Applied"


def test_the_settle_refuses_when_the_status_write_does_not_land(conn, actor):
    """THE POSTCONDITION BELT, driven directly: with `app_set_status` replaced by
    a function that writes nothing and returns a plausible object, the settle
    must RAISE and roll back rather than report a submission nobody recorded.

    Key scoping is a probability argument; this is not. It is what makes "the
    stage says handed_off but no status was written" a state this RPC cannot
    produce, whatever the callee does.

    KILLED BY: deleting the re-read and its raise from the settle RPC.
    """
    sid = approved_stage(conn, actor)
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.app_set_status(
              p_application_id bigint, p_status text, p_note text, p_idem text,
              p_expected_updated_at timestamptz)
            returns jsonb language plpgsql security definer
            set search_path = public, pg_temp
            as $mut$ begin
              return jsonb_build_object('id', p_application_id, 'status', p_status);
            end $mut$""")
        with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
            settle(conn, actor, sid, "submitted")
        assert "the manual status write did not land" in refusal(exc), exc.value
    finally:
        # 0010 is the ONLY definer of `app_set_status` (no later migration
        # replaces it), so re-applying that file is the exact restore — the
        # same re-appliability `db/apply.sh` requires of every migration.
        _system(conn)
        conn.execute((ROOT / "db" / "migrations" / "0010_pipeline.sql").read_text())
        _restore(conn)

    # Rolled back whole: the stage never settled, and no status was recorded.
    assert row(conn, sid)["state"] == "approved"
    assert application_row(conn, actor["app"])["status"] == "Queued"
    # …and the real pair works.
    settle(conn, actor, sid, "submitted")
    assert application_row(conn, actor["app"])["status"] == "Applied"


def test_mutation_a_settle_that_skips_app_set_status_leaves_no_manual_status(conn, actor):
    """The counterexample for the two tests above, as a transcript: replace the
    settle RPC with one that transitions the stage and never writes the status.
    The flow test's status assertions are red under it — proving they are
    capable of failing — and restoring the migration turns them green again.
    """
    sid = approved_stage(conn, actor)
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.app_settle_autopilot_handoff(
              p_stage_id bigint, p_outcome text, p_reason text, p_idem text,
              p_expected_updated_at timestamptz)
            returns jsonb language plpgsql security definer
            set search_path = public, pg_temp
            as $mut$
            declare v_row public.autopilot_stages;
            begin
              update public.autopilot_stages set state = 'handed_off'
               where id = p_stage_id and user_id = auth.uid()
              returning * into v_row;
              return jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                        'outcome', p_outcome, 'application', null);
            end $mut$""")
        out = settle(conn, actor, sid, "submitted")
        assert out["stage"]["state"] == "handed_off", "the mutation did not run"
        app = application_row(conn, actor["app"])
        assert app["status"] == "Queued" and app["status_actor"] == "system", (
            "the mutation did not reproduce the bug — the status moved without "
            "app_set_status, so the assertions this transcript exists for prove nothing")
    finally:
        _system(conn)
        conn.execute("delete from public.autopilot_stages where user_id = %s", (actor["uid"],))
        _restore(conn)

    # And the real function, on a fresh stage, does write it.
    app2 = make_application(conn, actor["uid"], "AfterRestoreCo")
    s = stage(conn, {**actor, "app": app2})["stage"]
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])
    out = settle(conn, actor, s["id"], "submitted")
    assert out["application"]["status"] == "Applied"
    assert application_row(conn, app2)["status_actor"] == "user"


# ═══════════════════════════════════════════════════════ approval integrity

def test_a_package_altered_behind_a_disabled_trigger_cannot_settle(conn, actor):
    """#206's attack, verbatim: a `service_role` write alters a FROZEN package
    with the state machine disabled — the only way to alter one at all — and
    the payload_hash regenerates while approved_hash keeps the old value. Rule
    4, now covering `handed_off`, catches the mismatch at the settling
    transition: the thing the user would be reporting as submitted is not the
    thing anybody approved.

    KILLED BY: leaving `handed_off` out of the state machine's
    approved/submitting hash re-check.
    """
    sid = approved_stage(conn, actor)
    _system(conn)
    conn.execute("alter table public.autopilot_stages disable trigger autopilot_stages_state_machine")
    try:
        conn.execute(
            "update public.autopilot_stages set payload = '{\"first_name\": \"Mallory\"}'::jsonb "
            "where id = %s", (sid,))
    finally:
        conn.execute("alter table public.autopilot_stages enable trigger autopilot_stages_state_machine")

    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        settle(conn, actor, sid, "submitted")
    assert "the approval does not match the package" in refusal(exc), exc.value
    assert row(conn, sid)["state"] == "approved"
    assert application_row(conn, actor["app"])["status"] == "Queued"


def test_a_receipt_bearing_stage_cannot_become_handed_off(conn, actor):
    """`handed_off` claims "the user's word is all there is"; a provider receipt
    contradicts that claim, so the state machine refuses the pair — the arm for
    a restore or a trigger-disabled writer, since no legal write sequence can
    produce it (receipts are filed only in submitting/outcome_unknown, and
    handed_off is entered only from approved).

    Driven exactly as the illegal writer would: triggers off, receipt filed
    against an approved stage, triggers on, settle.

    KILLED BY: leaving `handed_off` out of the receipt-contradiction set.
    """
    sid = approved_stage(conn, actor)
    _system(conn)
    conn.execute("alter table public.autopilot_stages disable trigger autopilot_stages_state_machine")
    conn.execute("alter table public.autopilot_receipts disable trigger autopilot_receipts_guard")
    try:
        conn.execute(
            "insert into public.autopilot_receipts "
            "  (user_id, stage_id, evidence_class, provider_reference, evidence) "
            "values (%s, %s, 1, 'GH-ILLEGAL', '{}'::jsonb)", (actor["uid"], sid))
    finally:
        conn.execute("alter table public.autopilot_receipts enable trigger autopilot_receipts_guard")
        conn.execute("alter table public.autopilot_stages enable trigger autopilot_stages_state_machine")

    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        settle(conn, actor, sid, "submitted")
    assert "holds a provider receipt and cannot become handed_off" in refusal(exc), exc.value
    assert row(conn, sid)["state"] == "approved"


def test_the_constraint_holds_handed_off_to_the_approval_shape(conn, actor):
    """A handed-off row with no recorded approval cannot EXIST, whatever wrote
    it: the CHECK constraint is the layer that survives
    `alter table … disable trigger`, a restore, and a superuser session.

    KILLED BY: leaving `handed_off` out of
    `autopilot_stages_approval_matches_state`'s authorised branch.
    """
    s = stage(conn, actor)["stage"]
    _system(conn)
    conn.execute("alter table public.autopilot_stages disable trigger user")
    try:
        with pytest.raises(psycopg.errors.CheckViolation) as exc:
            conn.execute(
                "update public.autopilot_stages set state = 'handed_off' where id = %s",
                (s["id"],))
    finally:
        conn.execute("alter table public.autopilot_stages enable trigger user")
    assert "autopilot_stages_approval_matches_state" in str(exc.value)
    assert row(conn, s["id"])["state"] == "ready_for_review"


# ═══════════════════════════════════════════════════════════════ the terminus

def test_handed_off_is_terminal_and_occupies_the_slot(conn, actor):
    """No arrow leaves `handed_off`; the application's slot stays held (staging
    again finds no open stage and answers the conflict sentence); and a retry is
    refused because handed_off is not a finished-and-released attempt — the
    user says the employer HAS this application.

    KILLED BY: adding any `handed_off>…` arrow; dropping `handed_off` from the
    one_live_attempt predicate (the re-stage would silently create a duplicate
    attempt); admitting `handed_off` to the retryable set.
    """
    sid = approved_stage(conn, actor)
    settle(conn, actor, sid, "submitted")

    for target in ("preparing", "ready_for_review", "approved", "submitting", "cancelled"):
        _system(conn)
        with pytest.raises(psycopg.errors.Error) as exc:
            conn.execute(
                "update public.autopilot_stages set state = %s, transition_reason = 't' "
                "where id = %s", (target, sid))
        assert "not a legal transition from handed_off" in refusal(exc), (target, exc.value)

    _as(conn, actor["uid"])
    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        stage(conn, actor)
    assert "no open autopilot stage" in refusal(exc), exc.value
    assert "handed off" in (exc.value.diag.message_hint or ""), exc.value

    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        _as(conn, actor["uid"])
        conn.execute("select public.app_retry_autopilot_stage(%s, '', %s)",
                     (sid, str(uuid.uuid4())))
    assert "not a finished attempt" in refusal(exc), exc.value


def test_the_twelfth_state_is_declared_exactly_once(conn):
    """The vocabulary function is the single authority every declaration reads;
    `handed_off` joins it once, and the transition map agrees arrow-for-arrow —
    the staging suite's full-square enumeration now covers all 144 pairs, so
    this asserts only the membership that suite's STATES list is built from.

    KILLED BY: dropping `handed_off` from `hq_autopilot_states()` while the
    check constraint or the settle RPC still name it.
    """
    _system(conn)
    states = conn.execute("select public.hq_autopilot_states()").fetchone()[0]
    assert states.count("handed_off") == 1
    assert len(states) == 12
    editable = conn.execute("select public.hq_autopilot_editable_states()").fetchone()[0]
    assert "handed_off" not in editable
    committed = conn.execute("select public.hq_autopilot_committed_states()").fetchone()[0]
    assert "handed_off" not in committed, (
        "handed_off in the committed set would put autopilot-submitted copy on a "
        "user-reported stage — the migration header records why it stays out")


# ═══════════════════════════════════════════════════════════ the sibling guard

def test_a_sibling_application_row_cannot_stage_a_second_live_attempt(conn, actor):
    """#207 blocker #1's shape, refused: two application rows for one posting —
    same owner, same (company, title), at least one keyless — cannot BOTH hold
    a live attempt through the staging path. The refusal is a conflict sentence
    naming the sibling, not an index identifier.

    KILLED BY: dropping the `hq_autopilot_sibling_live_attempt` call from
    `app_stage_autopilot_application` (the mutation test below is the
    transcript).
    """
    stage(conn, actor)  # the first attempt, live in ready_for_review
    sib = keyed_sibling(conn, actor)

    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        stage(conn, {**actor, "app": sib})
    assert "another application for this posting already has a live autopilot attempt" \
        in refusal(exc), exc.value
    assert str(actor["app"]) in (exc.value.diag.message_detail or ""), exc.value

    _system(conn)
    assert conn.execute(
        "select count(*) from public.autopilot_stages where user_id = %s",
        (actor["uid"],)).fetchone()[0] == 1


def test_the_sibling_guard_reads_identity_case_insensitively_and_both_ways(conn, actor):
    """The manual-dedup identity is `lower(company), lower(title)` — so a case
    variant is the same posting, and the guard fires whichever row staged
    first. A DIFFERENT title at the same company is a different posting and
    passes: the guard must not eat two genuinely distinct applications.

    KILLED BY: dropping the lower() from either side, or matching on company
    alone.
    """
    sib = keyed_sibling(conn, actor, company="HANDOFFCO")
    stage(conn, {**actor, "app": sib})  # the case-variant row stages FIRST

    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        stage(conn, actor)  # …and the original is the one refused
    assert "already has a live autopilot attempt" in refusal(exc), exc.value

    # A different title is a different posting: allowed.
    _system(conn)
    other = conn.execute(
        "insert into public.applications (user_id, company, title, status) "
        "values (%s, 'HandoffCo', 'Staff Engineer', 'Queued') returning id",
        (actor["uid"],)).fetchone()[0]
    assert stage(conn, {**actor, "app": other})["created"] is True


def test_a_settled_sibling_releases_the_posting(conn, actor):
    """The guard reads LIVE attempts — the not-settled set — so cancelling the
    first row's attempt frees the posting for the sibling, and a retry of the
    cancelled attempt is then refused BY THE GUARD because the sibling now
    holds the slot.

    KILLED BY: the guard reading all states (the sibling could never stage), or
    the retry path missing the guard call (the retry would duplicate the
    posting's live attempt).
    """
    s = stage(conn, actor)["stage"]
    review(conn, actor, s["id"], "cancel")
    sib = keyed_sibling(conn, actor)
    assert stage(conn, {**actor, "app": sib})["created"] is True

    _as(conn, actor["uid"])
    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        conn.execute("select public.app_retry_autopilot_stage(%s, '', %s)",
                     (s["id"], str(uuid.uuid4())))
    assert "another application for this posting already has a live autopilot attempt" \
        in refusal(exc), exc.value
    assert "retry of stage" in (exc.value.diag.message_detail or ""), exc.value


def test_an_edit_of_the_existing_live_stage_is_not_refused(conn, actor):
    """The guard fires only when the write would CREATE an attempt. Once two
    live attempts exist — the race window's residue, driven here by disabling
    the guard the way a race would evade it — an EDIT of either stage still
    works: refusing it would brick the very stage a person is trying to fix,
    and would fix nothing.

    THE WINDOW, documented rather than denied: the check and the insert are two
    steps, so two concurrent transactions staging the two sibling rows can each
    pass the lookup before either row is visible, and both inserts succeed —
    the partial unique index keys on application_id and cannot see across rows.
    The guard closes every sequential path; the structural per-posting arbiter
    is #207's blocker and is NOT claimed here.

    KILLED BY: running the sibling check on the edit path too.
    """
    first = stage(conn, actor)["stage"]
    sib = keyed_sibling(conn, actor)
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.hq_autopilot_sibling_live_attempt(
              p_user uuid, p_application_id bigint)
            returns bigint language sql stable
            set search_path = public, pg_temp
            as $mut$ select null::bigint $mut$""")
        second = stage(conn, {**actor, "app": sib})["stage"]  # the race's residue
    finally:
        _restore(conn)

    # Both live — and both still editable through the RPC.
    edited = stage(conn, actor, payload={"first_name": "B"},
                   expected=None)["stage"]
    assert edited["id"] == first["id"]
    edited_sib = stage(conn, {**actor, "app": sib}, payload={"first_name": "C"})["stage"]
    assert edited_sib["id"] == second["id"]


def test_mutation_dropping_the_sibling_guard_stages_a_duplicate_per_posting(conn, actor):
    """The transcript: with `hq_autopilot_sibling_live_attempt` answering null,
    the exact gesture the guard exists for goes straight through and one posting
    holds two live attempts — the pre-#206 behaviour, reproduced. Restoring the
    migration turns the same gesture back into a refusal.
    """
    stage(conn, actor)
    sib = keyed_sibling(conn, actor)
    try:
        _system(conn)
        conn.execute("""
            create or replace function public.hq_autopilot_sibling_live_attempt(
              p_user uuid, p_application_id bigint)
            returns bigint language sql stable
            set search_path = public, pg_temp
            as $mut$ select null::bigint $mut$""")
        out = stage(conn, {**actor, "app": sib})
        assert out["created"] is True, "the mutation did not reproduce the bug"
        _system(conn)
        assert conn.execute(
            "select count(*) from public.autopilot_stages where user_id = %s",
            (actor["uid"],)).fetchone()[0] == 2
    finally:
        _system(conn)
        conn.execute("delete from public.autopilot_stages where user_id = %s "
                     "and application_id = %s", (actor["uid"], sib))
        _restore(conn)

    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        stage(conn, {**actor, "app": sib})
    assert "already has a live autopilot attempt" in refusal(exc), exc.value


# ═══════════════════════════════════════════════════════════════════ authority

def test_the_wrong_owner_cannot_settle_and_learns_nothing(conn, actor):
    """A cross-user probe answers P0002 — indistinguishable from a stage that
    does not exist — and the message carries the probed id and nothing else: no
    state, no owner, no package fact. The leak assertion deliberately reads the
    WHOLE exception string, CONTEXT block included.

    KILLED BY: dropping `user_id = v_user` from the settle's row lookup.
    """
    sid = approved_stage(conn, actor)
    mallory = new_user(conn, "mallory")
    _as(conn, mallory)
    with pytest.raises(psycopg.errors.NoDataFound) as exc:
        conn.execute("select public.app_settle_autopilot_handoff(%s, 'submitted', '', %s, null)",
                     (sid, str(uuid.uuid4())))
    assert f"no such autopilot stage for this user: {sid}" in refusal(exc)
    assert "approved" not in str(exc.value)
    assert actor["uid"] not in str(exc.value)
    assert row(conn, sid)["state"] == "approved"


def test_an_anonymous_caller_cannot_settle(conn, actor):
    """`anon` holds the public key and can post straight to `/rest/v1/rpc`.

    KILLED BY: granting the settle RPC to `anon`, or deleting its
    `v_user is null` check.
    """
    sid = approved_stage(conn, actor)
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("set role anon")
    with pytest.raises(psycopg.errors.Error):
        conn.execute("select public.app_settle_autopilot_handoff(%s, 'submitted', '', %s, null)",
                     (sid, str(uuid.uuid4())))
    _system(conn)
    assert row(conn, sid)["state"] == "approved"


@pytest.mark.parametrize("entitlement", ["pending", "suspended"])
def test_a_non_entitled_account_cannot_settle(conn, actor, entitlement):
    """The 0027 boundary reaches inside the settle, and since #256 it reaches it
    EARLIER: `hq_command_replay` refuses the non-entitled caller at the top of the
    command, so the settle never gets as far as its own stage UPDATE. Both halves
    are asserted — the command-level refusal by name, and then the stage table's
    own guard under definer rights, which is the staging suite's T3/B4 lesson and
    is no longer reachable through this RPC. The whole settle rolls back either
    way: no handed_off, no status write.

    KILLED BY: removing `autopilot_stages` from the entitlement loop (the second
    half), or deleting the entitlement check from `hq_command_replay` (the first).
    """
    sid = approved_stage(conn, actor)
    _system(conn)
    if entitlement == "suspended":
        conn.execute("select public.hq_suspend_user(%s, 'abuse')", (actor["uid"],))
    else:
        conn.execute("update public.entitlements set status = 'pending' where user_id = %s",
                     (actor["uid"],))

    _as(conn, actor["uid"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        conn.execute("select public.app_settle_autopilot_handoff(%s, 'submitted', '', %s, null)",
                     (sid, str(uuid.uuid4())))
    assert "not entitled" in refusal(exc), exc.value
    assert "not entitled to replay app_settle_autopilot_handoff" in refusal(exc), (
        f"the settle refused somewhere other than the replay lookup: {exc.value}")

    as_definer(conn, actor["uid"])
    verdict = guard_verdict(
        conn, "update public.autopilot_stages set state = 'handed_off' where id = %s", (sid,))
    assert "not entitled to write public.autopilot_stages" in verdict, (
        f"the refusal did not name autopilot_stages: {verdict}")

    _system(conn)
    conn.execute("update public.entitlements set status = 'active' where user_id = %s",
                 (actor["uid"],))
    assert row(conn, sid)["state"] == "approved"
    assert application_row(conn, actor["app"])["status"] == "Queued"


# ══════════════════════════════════════════════ idempotency and concurrency

def test_a_replayed_settle_returns_the_first_answer_and_writes_once(conn, actor):
    """One key, two calls, one effect: the second call returns the stored
    result byte-for-byte and appends nothing — one handed_off transition, one
    autopilot.handed_off event, one action.status event.

    KILLED BY: deleting either `hq_command_replay` call from the settle RPC.
    """
    sid = approved_stage(conn, actor)
    idem = str(uuid.uuid4())
    first = settle(conn, actor, sid, "submitted", idem=idem)
    second = settle(conn, actor, sid, "submitted", idem=idem)
    assert first == second

    _system(conn)
    assert conn.execute(
        "select count(*) from public.autopilot_transitions "
        "where stage_id = %s and to_state = 'handed_off'", (sid,)).fetchone()[0] == 1
    assert len(events_of(conn, actor["uid"], "autopilot.handed_off")) == 1
    assert len(events_of(conn, actor["uid"], "action.status")) == 1


def test_a_settle_key_reused_with_different_arguments_is_refused(conn, actor):
    """`hq_command_replay` compares the fingerprint: the same key carrying a
    DIFFERENT outcome (or reason) is not a replay, it is two gestures sharing a
    key, and answering the stored result would silently discard one of them.

    KILLED BY: dropping `request_hash` from the fingerprint comparison.
    """
    sid = approved_stage(conn, actor)
    idem = str(uuid.uuid4())
    settle(conn, actor, sid, "submitted", idem=idem)
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        settle(conn, actor, sid, "abandoned", idem=idem)
    assert "different arguments" in refusal(exc), exc.value
    assert row(conn, sid)["state"] == "handed_off"

    # And across commands: the review RPC cannot replay a settle key.
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        review(conn, actor, sid, "cancel", idem=idem)
    assert "already used by app_settle_autopilot_handoff" in refusal(exc), exc.value


def test_a_stale_version_token_is_refused(conn, actor):
    """Two tabs, one stage: the tab holding yesterday's `updated_at` is told
    `conflict` (40001 — the word is load-bearing, the data layer matches on it)
    and nothing moves.

    KILLED BY: dropping the `p_expected_updated_at` comparison from the settle.
    """
    s = stage(conn, actor)["stage"]
    stale = row(conn, s["id"])["updated_at"]
    review(conn, actor, s["id"], "approve", package_hash=s["packageHash"])  # bumps updated_at

    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        settle(conn, actor, s["id"], "submitted", expected=stale)
    assert "conflict" in refusal(exc), exc.value
    assert "changed since you read it" in refusal(exc)
    assert row(conn, s["id"])["state"] == "approved"
    assert application_row(conn, actor["app"])["status"] == "Queued"

    fresh = row(conn, s["id"])["updated_at"]
    assert settle(conn, actor, s["id"], "submitted", expected=fresh)["outcome"] == "submitted"
