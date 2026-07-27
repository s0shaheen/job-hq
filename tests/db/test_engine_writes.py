"""0015's engine write path, executed against real Postgres.

`tests/core/test_migrations.py` reads the SQL as text: it proves the function
exists with the parameters `tracker/join.py` passes, and it cannot prove that a
rejection at 0.99 confidence leaves somebody's Offer alone. Everything here RUNS.

What it proves that reading the migration cannot:

    * a bot advance is FORWARD ONLY, and a human-claimed row is untouchable —
      the two rules `core/sheets.py:advance_status` enforces in the spreadsheet,
      now enforced for the store by the store;
    * the branch ORDER (lock before rank) — a locked row gets a suggestion even
      when the move would have been backward, which is acceptance criterion 14's
      second half and is invisible if the two answers are collapsed;
    * replaying one email event applies it once, under concurrency as well as
      sequentially — `join` replays every event whose sheet cell is still blank;
    * a pass that changes nothing writes nothing, so the web app's concurrency
      token is not invalidated twice an hour by an activity stamp;
    * `hq_status_rank` agrees with `core/schema.py:status_rank`, which is the
      only thing standing between the third copy of that ladder and drift.

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q

MUTATION TARGETS this file is meant to catch (each was run red before green):
  * delete the `status_actor = 'user'` branch -> the lock test's rejection lands
    on the Offer (the original defect, at the new writer);
  * swap the lock and rank branches -> the stale-email-on-a-locked-row test loses
    its suggestion;
  * flip `<=` to `<` in the rank compare -> a re-sent confirmation "advances"
    Applied to Applied and stamps an event about a non-event;
  * drop the post-lock idempotency re-check -> the concurrent-replay test writes
    two events for one email;
  * drop the no-op guard -> the unchanged-row test sees `updated_at` move;
  * drop `jsonb_typeof(p_create) <> 'null'` -> PostgREST's JSON null creates a
    blank application (the shape the caller passes for "never create");
  * grant it to `authenticated` -> the browser test advances another user's row.
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

from tests.db.test_pipeline import (  # noqa: E402
    app_row, as_user, conn, events_of, make_app, make_posting, make_user,
    schema, set_status,
)

__all__ = ["conn", "schema"]     # re-exported fixtures; flake8 would call them unused


# ------------------------------------------------------------------ helpers

def apply_event(conn, user, key, *, event_id=None, event_type="received",
                status="Applied", hard=True, evidence="", on=None, create=None,
                sheet_status=None, sheet_actor=None):
    """`tracker.join._pg_apply`'s call, made the way `core.pg.rpc` makes it.

    `event_id` defaults to a fresh uuid: an idempotency key that repeated by
    accident would make every test in this file silently a replay test.

    `sheet_status`/`sheet_actor` default to None — "no second store" — because most
    tests here are about pg's own rules. The tests that are about the OTHER store
    pass them, and `test_join.py` pins that the real caller always does.
    """
    return conn.execute(
        "select public.hq_apply_email_event(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)",
        (user, key, event_id or str(uuid.uuid4()), event_type, status, hard,
         evidence, on, json.dumps(create) if create is not None else None,
         sheet_status, sheet_actor),
    ).fetchone()[0]


def app_of(conn, user, key):
    row = conn.execute(
        """select id, status, status_actor, suggested_status, evidence,
                  last_activity, applied_date, source, updated_at, status_set_at
             from public.applications where user_id = %s and posting_key = %s""",
        (user, key),
    ).fetchone()
    if row is None:
        return None
    cols = ("id", "status", "status_actor", "suggested_status", "evidence",
            "last_activity", "applied_date", "source", "updated_at", "status_set_at")
    return dict(zip(cols, row))


def gated_app(conn, *, status="Applied", actor="system", suggested="", evidence=""):
    """A user + a mirrored posting + the application the sheet lane already has."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    app = make_app(conn, user, status=status, posting_key=key,
                   suggested=suggested, actor=actor)
    if evidence:
        conn.execute("update public.applications set evidence = %s where id = %s",
                     (evidence, app))
    return user, key, app


# ------------------------------------------------------------- the ladder

def test_the_rank_matches_the_python_original(conn):
    """One ladder, three languages, and this is the third — so it is pinned to the
    authority rather than trusted to stay in step. A rank that drifts by one turns
    "Offer" into a status a rejection may overwrite.

    Compared against `core.schema.status_rank` ITSELF rather than against a
    re-derivation of its rules here. The first draft of this test re-implemented
    the ladder from the parsed lists, forgot the `.strip()`, and reported the
    correct SQL as wrong — a fourth copy of the thing the test exists to stop
    there being copies of.
    """
    from core import schema

    cases = list(schema.STATUSES) + [
        "", "   ", "\t", "waiting on referral", "applied", "Applied ", " Offer"]
    for s in cases:
        got = conn.execute("select public.hq_status_rank(%s)", (s,)).fetchone()[0]
        assert got == schema.status_rank(s), (
            f"{s!r}: sql {got} vs core/schema.py {schema.status_rank(s)}")
    # Non-vacuous: the cases really do cover every rank the function can return.
    assert {schema.status_rank(s) for s in cases} == {-1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11}


#: Written as codepoints, never typed in — an invisible character in a test file is
#: a test nobody can read (0008 and 0010 both say so about their own files).
ZWSP, ZWNJ, ZWJ, BOM = chr(0x200B), chr(0x200C), chr(0x200D), chr(0xFEFF)
NEL, NBSP, FS, US = chr(0x85), chr(0xA0), chr(0x1C), chr(0x1F)
IDEOGRAPHIC_SPACE, LINE_SEP = chr(0x3000), chr(0x2028)


def test_the_rank_agrees_with_python_on_the_invisible_characters_too(conn):
    """The six divergences the review found, and the class around them.

    `hq_blank_trim` strips zero-width characters; Python's `str.strip()` does not,
    because they are not whitespace. So a status pasted out of a web page —
    ZWSP + 'Applied' — ranked 2 in SQL and 11 in Python: the STORE would advance
    over it and the sheet would treat it as a human-invented status and leave it
    alone. Wrong way round, and `p_current_status` made it reachable from a
    hand-edited cell. The other direction (NEL, the C1 separators) had SQL ranking
    11 where Python ranked 2 — safe, but still a disagreement between two things
    the migration claims are pinned to each other.

    MUTATION: point `hq_status_rank` back at `hq_blank_trim` -> the zero-width
    cases go red; drop U+0085 or the U+001C-U+001F range from HQ_PY_STRIP_CLASS ->
    the control-character cases go red.
    """
    from core import schema

    cases = [
        ZWSP + "Applied", "Applied" + BOM, ZWJ, ZWNJ + "Offer", "Offer" + ZWSP,
        "Applied" + NEL, NEL + "Applied", NEL, FS + "Offer", "Offer" + US, US,
        NBSP + "Applied", "Applied" + NBSP, IDEOGRAPHIC_SPACE + "Offer",
        LINE_SEP, NBSP,
    ]
    bad = []
    for s in cases:
        got = conn.execute("select public.hq_status_rank(%s)", (s,)).fetchone()[0]
        if got != schema.status_rank(s):
            bad.append((repr(s), got, schema.status_rank(s)))
    assert not bad, f"sql/python rank divergences (case, sql, python): {bad}"


def test_a_zero_width_status_is_untouchable_in_both_languages(conn):
    """The behaviour that divergence produced, at the layer that matters: a status
    carrying an invisible character is a status this function does not recognise,
    and an unrecognised status is a human's, so nothing advances over it."""
    from core import schema
    pasted = ZWSP + "Applied"
    assert schema.status_rank(pasted) == 11
    user, key, _app = gated_app(conn, status="Queued")
    res = apply_event(conn, user, key, status="Interview",
                      sheet_status=pasted, sheet_actor="")
    assert res["outcome"] == "kept"
    assert app_of(conn, user, key)["status"] == "Queued"


def test_a_status_of_pure_whitespace_ranks_as_blank_not_as_invented(conn):
    """`hq_blank_trim`, not bare btrim. A tab-only cell ranking 11 (invented)
    would make the row untouchable by every bot forever — the exact silent
    lockout 0010's blank_trim comment was written about."""
    for blank in ("", " ", "\t", "\n", " "):
        assert conn.execute("select public.hq_status_rank(%s)", (blank,)).fetchone()[0] == -1


def test_the_finished_list_survived_being_split(conn):
    """0015 redefines 0010's function over two new lists. Same values, same order
    — asserted here as well as in test_pipeline's three-language check, because
    that one sorts both sides and would not see a reordering."""
    assert conn.execute("select public.hq_finished_statuses()").fetchone()[0] == [
        "Rejected", "Withdrawn", "Closed", "Offer-Accepted", "Offer-Declined"]


# --------------------------------------------------------- the two rules

def test_a_hard_event_advances_an_unclaimed_row(conn):
    user, key, app = gated_app(conn, status="Queued")
    res = apply_event(conn, user, key, status="Applied", evidence="https://mail/1")
    assert res["outcome"] == "advanced" and res["application_id"] == app
    row = app_of(conn, user, key)
    assert row["status"] == "Applied" and row["evidence"] == "https://mail/1"
    assert row["last_activity"] is not None
    # the engine never claims the row, and never stamps the human-gesture clock
    assert row["status_actor"] == "system" and row["status_set_at"] is None
    assert ("email.received", "gmail-capture") in events_of(conn, app)


def test_a_backward_event_is_kept_and_leaves_no_suggestion(conn):
    """A delayed confirmation arriving after a screen was booked. "suggests
    Applied" on an Interview row is noise that teaches people to ignore the
    column, so the answer is an activity stamp and nothing else."""
    user, key, app = gated_app(conn, status="Interview")
    res = apply_event(conn, user, key, status="Applied")
    assert res["outcome"] == "kept"
    row = app_of(conn, user, key)
    assert row["status"] == "Interview" and row["suggested_status"] == ""


def test_the_same_status_twice_is_kept_not_advanced(conn):
    """`<=`, not `<`. A re-sent confirmation must not 'advance' Applied to
    Applied and file an audit event about a non-event."""
    user, key, _app = gated_app(conn, status="Applied")
    assert apply_event(conn, user, key, status="Applied")["outcome"] == "kept"


def test_a_human_claimed_row_gets_a_suggestion_and_keeps_its_status(conn):
    """Acceptance criterion 14, at the writer that broke it. `Rejected` outranks
    `Offer`, so rank alone is no protection at all — only `status_actor` is."""
    user, key, app = gated_app(conn)
    as_user(conn, user)
    set_status(conn, app, "Offer")                    # the human claims the row
    assert app_row(conn, app)["status_actor"] == "user"

    res = apply_event(conn, user, key, event_type="rejection", status="Rejected",
                      hard=True, evidence="https://mail/2")
    assert res["outcome"] == "locked"
    row = app_of(conn, user, key)
    assert row["status"] == "Offer", "a bot overwrote a status a human chose"
    assert row["suggested_status"] == "Rejected" and row["evidence"] == "https://mail/2"


def test_the_lock_is_checked_before_the_rank(conn):
    """A stale email on a claimed row. Unlocked, this move is `kept` (no
    suggestion); locked, it is a suggestion — the two answers are not
    interchangeable, and the branch order is what tells them apart."""
    user, key, app = gated_app(conn, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Interview")
    res = apply_event(conn, user, key, status="Applied", hard=True)
    assert res["outcome"] == "locked"
    assert app_of(conn, user, key)["suggested_status"] == "Applied"


# ---------------------------------------- the OTHER store's truth (review C-1)
#
# During dual-write the human edits the SHEET, and pg's `status_actor` is written
# only by the web app. So pg's twin says 'Queued'/'system' for a row whose sheet
# cell says 'Offer'/'user', and deciding against the twin rebuilt 0010's defect in
# the store Phase C promotes to system of record. These are that hole, closed.

def test_a_human_claim_in_the_sheet_locks_the_store_row_too(conn):
    """The measured defect: sheet said Offer/'user' and `join` recorded a
    suggestion, while the SAME event advanced pg to Rejected (Rejected outranks
    Offer, so rank was never going to stop it)."""
    user, key, _app = gated_app(conn, status="Queued")     # the stale twin
    res = apply_event(conn, user, key, event_type="rejection", status="Rejected",
                      sheet_status="Offer", sheet_actor="user")
    assert res["outcome"] == "locked"
    row = app_of(conn, user, key)
    assert row["status"] == "Queued", "the store advanced over a status a human chose"
    assert row["suggested_status"] == "Rejected"


def test_the_sheets_actor_cell_is_read_case_insensitively(conn):
    """`core/sheets.py:advance_status` compares it with `.casefold()`; a dropdown
    a human retyped as 'User' must not silently unlock the row."""
    user, key, _app = gated_app(conn, status="Queued")
    assert apply_event(conn, user, key, sheet_status="Applied",
                       sheet_actor="  USER ")["outcome"] == "locked"


def test_an_actor_value_nobody_recognises_locks(conn):
    """When in doubt, lock. The cell is hand-editable, so 'salman', 'bot' or a
    stray paste all mean this function does not know what it is looking at — and
    the safe reading of an unknown value is the one that keeps the Offer."""
    for weird in ("salman", "bot", "yes", "u"):
        user, key, _app = gated_app(conn, status="Queued")
        res = apply_event(conn, user, key, sheet_status="Queued", sheet_actor=weird)
        assert res["outcome"] == "locked", weird
        assert app_of(conn, user, key)["status"] == "Queued"


def test_the_two_unclaimed_spellings_do_not_lock(conn):
    """The control. '' (the usual state of the cell) and 'system' mean unclaimed,
    and a rule that locked on those would make the store lane inert — every row in
    the live sheet has an empty actor cell."""
    for unclaimed in ("", "   ", "system", "System"):
        user, key, _app = gated_app(conn, status="Queued")
        res = apply_event(conn, user, key, sheet_status="Queued", sheet_actor=unclaimed)
        assert res["outcome"] == "advanced", repr(unclaimed)
        assert app_of(conn, user, key)["status"] == "Applied"


def test_forward_only_is_judged_against_the_furthest_store(conn):
    """D2 from the review: `Offer-Accepted` typed straight into the sheet needs no
    dropdown — rank alone protects it there, and pg had no idea. `greatest()` is
    what makes the store's answer the sheet's answer ('kept')."""
    user, key, _app = gated_app(conn, status="Queued")
    res = apply_event(conn, user, key, event_type="rejection", status="Rejected",
                      sheet_status="Offer-Accepted", sheet_actor="")
    assert res["outcome"] == "kept"
    row = app_of(conn, user, key)
    assert row["status"] == "Queued" and row["suggested_status"] == ""


def test_the_store_still_wins_when_it_is_the_one_that_is_ahead(conn):
    """The other direction, so `greatest` is not just "trust the sheet": a webapp
    triage that moved pg to Interview must not be walked back by a sheet row the
    engine has not mirrored yet."""
    user, key, _app = gated_app(conn, status="Interview")
    res = apply_event(conn, user, key, status="Applied",
                      sheet_status="Queued", sheet_actor="")
    assert res["outcome"] == "kept"
    assert app_of(conn, user, key)["status"] == "Interview"


def test_no_sheet_truth_decides_on_pg_alone(conn):
    """The post-Phase-D contract, and every non-`join` caller: NULL means "I have
    no second store", not "the second store says nothing is there"."""
    user, key, _app = gated_app(conn, status="Queued")
    res = apply_event(conn, user, key, sheet_status=None, sheet_actor=None)
    assert res["outcome"] == "advanced"
    assert app_of(conn, user, key)["status"] == "Applied"


def test_a_soft_rule_suggests_even_on_an_unclaimed_row(conn):
    """`p_hard=false` is "below the gate, or a soft rule" — an offer email at 0.7
    is an opinion, not a stage change, whoever owns the row."""
    user, key, _app = gated_app(conn, status="Interview")
    res = apply_event(conn, user, key, event_type="offer", status="Offer", hard=False)
    assert res["outcome"] == "suggested"
    row = app_of(conn, user, key)
    assert row["status"] == "Interview" and row["suggested_status"] == "Offer"


def test_an_event_with_no_status_rule_only_stamps_activity(conn):
    """A recruiter cold email is activity, not a stage."""
    user, key, _app = gated_app(conn, status="Applied")
    res = apply_event(conn, user, key, event_type="recruiter_outreach", status="",
                      hard=False, evidence="https://mail/3")
    assert res["outcome"] == "matched"
    row = app_of(conn, user, key)
    assert row["status"] == "Applied" and row["suggested_status"] == ""
    # and it did NOT rewrite evidence: a matched event has no opinion to evidence
    assert row["evidence"] == ""


def test_an_event_with_no_thread_link_never_blanks_the_evidence(conn):
    """The link is the one field on the row a person needs to act on. A
    suggestion that destroyed it is worse than the status it was reporting."""
    user, key, _app = gated_app(conn, status="Queued", evidence="https://mail/keepme")
    apply_event(conn, user, key, status="Applied", evidence="")
    assert app_of(conn, user, key)["evidence"] == "https://mail/keepme"


def test_no_bot_may_write_a_human_only_ending(conn):
    """`EVENT_STATUS_RULES` structurally cannot name these, which is a promise
    about today's table. The refusal is repeated at this end of the wire because
    the next caller has not been written yet."""
    user, key, _app = gated_app(conn, status="Offer")
    for ending in ("Offer-Accepted", "Offer-Declined"):
        with pytest.raises(psycopg.errors.Error) as exc:
            apply_event(conn, user, key, status=ending)
        assert "human-only" in str(exc.value)
    assert app_of(conn, user, key)["status"] == "Offer"


# ------------------------------------------------------- nothing to apply to

def unapplied_events(conn, user) -> list[dict]:
    return [r[0] for r in conn.execute(
        """select payload from public.events
            where user_id = %s and kind = 'email.unapplied' order by id""",
        (user,)).fetchall()]


def test_an_event_for_an_unmirrored_posting_is_answered_not_guessed(conn):
    """`applications.posting_key` is a foreign key, so this row cannot be invented."""
    user = make_user(conn)
    res = apply_event(conn, user, "greenhouse-never-swept")
    assert res == {"outcome": "no_posting", "posting_key": "greenhouse-never-swept",
                   "created": False}
    assert conn.execute("select count(*) from public.applications where user_id=%s",
                        (user,)).fetchone()[0] == 0


def test_without_a_create_payload_a_missing_application_is_skipped(conn):
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    assert apply_event(conn, user, key)["outcome"] == "no_application"
    assert app_of(conn, user, key) is None


@pytest.mark.parametrize("with_posting", [False, True], ids=["no_posting", "no_application"])
def test_an_event_that_landed_nowhere_leaves_a_durable_trace(conn, with_posting):
    """`join` retires the email in the sheet whatever the store answered — that cell
    means "the SHEET lane processed this", and it did. So the fact that pg had
    nothing to apply it to has to survive HERE, or the divergence is invisible and
    permanent (the review measured both: idempotency rows=0, audit events=0).

    MUTATION: delete either `perform hq_note_unapplied_event` -> this goes red for
    that half, and the residue becomes undrainable because nothing recorded it.
    """
    user = make_user(conn)
    key = (make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}") if with_posting
           else "greenhouse-never-swept")
    apply_event(conn, user, key, event_id="ev-x", event_type="rejection",
                status="Rejected")
    trace = unapplied_events(conn, user)
    assert len(trace) == 1, "an event the store dropped left no trace"
    assert trace[0]["reason"] == ("no_application" if with_posting else "no_posting")
    assert trace[0]["posting_key"] == key and trace[0]["event_id"] == "ev-x"
    assert trace[0]["event_type"] == "rejection"


def test_the_trace_is_written_once_per_conclusion_not_once_per_run(conn):
    """The tracker chain runs every two hours and these paths stay RETRYABLE — the
    posting genuinely may arrive tomorrow — so the guard cannot be a stored command
    result. Without the existence check the events table grows a row per lane pass,
    forever, for every orphan."""
    user = make_user(conn)
    for _ in range(3):
        apply_event(conn, user, "greenhouse-never-swept", event_id="ev-y")
    assert len(unapplied_events(conn, user)) == 1


def test_a_retryable_skip_stores_no_command_result(conn):
    """The other half of retryable: a stored result would answer "already applied"
    for an event that was never applied at all, so the posting arriving tomorrow
    could never be picked up."""
    user = make_user(conn)
    key = "greenhouse-late"
    apply_event(conn, user, key, event_id="ev-z")
    assert conn.execute(
        "select count(*) from public.command_idempotency where user_id=%s",
        (user,)).fetchone()[0] == 0
    # the posting lands, the same event is retried, and now it applies
    make_posting(conn, key)
    res = apply_event(conn, user, key, event_id="ev-z", create={"company": "Ramp"})
    assert res["created"] is True and res["outcome"] == "advanced"


def test_a_json_null_create_payload_is_not_a_create(conn):
    """PostgREST sends a JSON `null` for an argument the caller left as None, and
    `jsonb 'null'` is a VALUE. Without the typeof guard this creates a row with
    every field blank — a phantom application from an event that said not to."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    res = conn.execute(
        "select public.hq_apply_email_event(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)",
        (user, key, str(uuid.uuid4()), "received", "Applied", True, "", None, "null",
         None, None),
    ).fetchone()[0]
    assert res["outcome"] == "no_application"
    assert app_of(conn, user, key) is None


def test_a_gmail_first_application_is_created_at_inbox_then_advanced(conn):
    """The Gmail-first case: a confirmation for something applied to before
    anything tracked it. Born at Inbox and advanced by the SAME rule that governs
    a five-week-old row, so there is one copy of the policy and not two."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    res = apply_event(conn, user, key, evidence="https://mail/4", create={
        "company": "Ramp", "title": "Product Manager", "url": "https://x/1",
        "source": "gmail", "applied_date": "2026-07-10",
        "applied_via": "scout", "applied_email": "alt"})
    assert res["created"] is True and res["outcome"] == "advanced"
    row = app_of(conn, user, key)
    assert row["status"] == "Applied" and row["status_actor"] == "system"
    assert row["source"] == "gmail" and str(row["applied_date"]) == "2026-07-10"
    assert row["evidence"] == "https://mail/4"
    kinds = [k for k, _a in events_of(conn, row["id"])]
    assert kinds == ["email.application_created", "email.received"]


def test_a_low_confidence_birth_stays_at_inbox_with_a_suggestion(conn):
    """Below the gate the status stays a suggestion even at birth — the sheet
    lane's `_create_row` rule, reached here without a second code path."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    res = apply_event(conn, user, key, hard=False, create={"company": "Ramp"})
    assert res["created"] is True and res["outcome"] == "suggested"
    row = app_of(conn, user, key)
    assert row["status"] == "Inbox" and row["suggested_status"] == "Applied"


def test_an_unparseable_applied_date_is_null_and_not_a_raise(conn):
    """One bad cell out of the classifier must not wedge the event."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    apply_event(conn, user, key, create={"company": "Ramp",
                                         "applied_date": "Posted 30+ Days Ago"})
    assert app_of(conn, user, key)["applied_date"] is None


# ------------------------------------------------------------- replay

def test_replaying_one_event_applies_it_once(conn):
    """`join` replays every event whose sheet cell is still blank, which is what
    a run that wrote pg and then died before stamping leaves behind."""
    user, key, app = gated_app(conn, status="Queued")
    eid = str(uuid.uuid4())
    first = apply_event(conn, user, key, event_id=eid, status="Applied")
    before = app_of(conn, user, key)["updated_at"]
    second = apply_event(conn, user, key, event_id=eid, status="Applied")
    assert second == first, "a replay returned a different answer than the original"
    assert app_of(conn, user, key)["updated_at"] == before
    assert len([k for k, _ in events_of(conn, app) if k == "email.received"]) == 1


def test_one_event_resolved_to_a_different_row_is_a_different_command(conn):
    """`join`'s fuzzy branch resolves the same event to a different Pipeline row
    when the candidate set changes between runs — `promote` adds rows every two
    hours. Keyed on the event id alone, the second call replayed the FIRST row's
    answer: `advanced`, naming a posting key it was not asked about, while the row
    it WAS asked about never moved."""
    user, key_a, _a = gated_app(conn, status="Queued")
    key_b = make_posting(conn, f"ashby-{uuid.uuid4().hex[:10]}")
    make_app(conn, user, status="Queued", posting_key=key_b)
    eid = str(uuid.uuid4())

    first = apply_event(conn, user, key_a, event_id=eid, status="Applied")
    second = apply_event(conn, user, key_b, event_id=eid, status="Applied")
    assert first["posting_key"] == key_a and second["posting_key"] == key_b
    assert app_of(conn, user, key_b)["status"] == "Applied", \
        "the second row got the first row's answer and never moved"


def test_a_reclassified_event_may_apply_its_new_conclusion(conn):
    """The classifier is an LLM and its output is not stable: 0.6 'received' on
    Monday, 0.99 'interview' on Tuesday. Keyed on the event id alone, Monday's
    conclusion replayed forever. The forward-only ladder is what keeps the
    re-application monotonic — a classifier that changes its mind can move the row
    on, never back."""
    user, key, _app = gated_app(conn, status="Queued")
    eid = str(uuid.uuid4())
    assert apply_event(conn, user, key, event_id=eid, status="Applied",
                       hard=True)["outcome"] == "advanced"
    assert apply_event(conn, user, key, event_id=eid, event_type="interview",
                       status="Interview", hard=True)["outcome"] == "advanced"
    assert app_of(conn, user, key)["status"] == "Interview"

    # Re-sending Monday's conclusion is Monday's COMMAND, so it replays Monday's
    # stored answer verbatim (0003's rule) and writes nothing. The reported outcome
    # is therefore the original 'advanced' — stale as a description of this call,
    # correct as a description of that command — and the row does not move.
    assert apply_event(conn, user, key, event_id=eid, status="Applied",
                       hard=True)["outcome"] == "advanced"
    assert app_of(conn, user, key)["status"] == "Interview"

    # A genuinely new email carrying a backward conclusion is refused by RANK,
    # which is the guard that has to hold once the key stops doing it.
    assert apply_event(conn, user, key, status="Applied", hard=True)["outcome"] == "kept"
    assert app_of(conn, user, key)["status"] == "Interview"


def test_a_second_event_that_changes_nothing_writes_nothing(conn):
    """A different email, same conclusion. `updated_at` is the web app's
    concurrency token: bumping it twice an hour for no change turns the next real
    gesture into a phantom conflict."""
    user, key, _app = gated_app(conn, status="Applied")
    apply_event(conn, user, key, event_type="recruiter_outreach", status="", hard=False)
    before = app_of(conn, user, key)["updated_at"]
    apply_event(conn, user, key, event_type="recruiter_outreach", status="", hard=False)
    assert app_of(conn, user, key)["updated_at"] == before


def test_two_lanes_replaying_one_event_concurrently_apply_it_once(conn):
    """The pre-lock check settles SEQUENTIAL replays only. Two tracker runs
    overlapping — the 2-hourly chain against a manual re-run — both clear it
    before either writes, and only the post-lock re-check stops the loser
    applying a second time against an append-only trail."""
    user, key, app = gated_app(conn, status="Queued")
    eid = str(uuid.uuid4())
    results, errors = [], []
    barrier = threading.Barrier(2)

    def worker():
        try:
            with psycopg.connect(DATABASE_URL, autocommit=True) as c:
                barrier.wait(timeout=10)
                results.append(apply_event(c, user, key, event_id=eid, status="Applied"))
        except Exception as e:                       # pragma: no cover - reported below
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert not errors, errors
    assert len(results) == 2 and results[0] == results[1]
    assert len([k for k, _ in events_of(conn, app) if k == "email.received"]) == 1


def test_two_lanes_creating_one_application_concurrently_make_one_row(conn):
    """Different events, same absent application. The insert race is real: both
    read "no row" before either wrote, and `on conflict do nothing` plus the
    re-select is what turns the loser into a normal apply instead of a raise."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    errors = []
    barrier = threading.Barrier(2)

    def worker():
        try:
            with psycopg.connect(DATABASE_URL, autocommit=True) as c:
                barrier.wait(timeout=10)
                apply_event(c, user, key, create={"company": "Ramp"})
        except Exception as e:                       # pragma: no cover - reported below
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert not errors, errors
    assert conn.execute(
        "select count(*) from public.applications where user_id=%s and posting_key=%s",
        (user, key)).fetchone()[0] == 1


# ------------------------------------------------- seeding the twin (review C-2)
#
# The event lane can only create an application when an email arrives about one,
# and most applications have had every email they will ever get. Without this the
# store's pipeline stays permanently empty of the 141 rows the sheet already holds.

def seed_row(conn, user, key, **cols):
    row = {"company": "Ramp", "title": "Product Manager", "url": "https://x/1",
           "source": "monitor", "status": "Applied", "status_actor": "",
           "suggested_status": "", "evidence": "", "applied_date": "",
           "applied_via": "", "applied_email": "", "last_activity": "",
           "next_action": "", "next_action_date": "", "notes": ""}
    row.update(cols)
    return conn.execute(
        "select public.hq_upsert_sheet_application(%s,%s,%s::jsonb)",
        (user, key, json.dumps(row)),
    ).fetchone()[0]


def test_a_sheet_row_becomes_its_twin(conn):
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    res = seed_row(conn, user, key, status="Interview", applied_date="2026-06-01",
                   notes="phone screen booked", evidence="https://mail/1")
    assert res["outcome"] == "created"
    row = app_of(conn, user, key)
    assert row["status"] == "Interview" and str(row["applied_date"]) == "2026-06-01"
    assert row["evidence"] == "https://mail/1" and row["status_actor"] == "system"
    assert ("application.seeded", "system") in events_of(conn, row["id"])


def test_seeding_twice_changes_nothing(conn):
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    seed_row(conn, user, key)
    before = app_of(conn, user, key)["updated_at"]
    assert seed_row(conn, user, key)["outcome"] == "unchanged"
    assert app_of(conn, user, key)["updated_at"] == before


def test_it_fills_blanks_and_never_overwrites_what_the_app_holds(conn):
    """The web app is a live editing surface and this job runs by hand at an
    arbitrary time — the sheet is the older record, not automatically the truer
    one."""
    user, key, app = gated_app(conn, status="Applied")
    conn.execute("update public.applications set notes='typed in the app' where id=%s",
                 (app,))
    res = seed_row(conn, user, key, notes="typed in the sheet",
                   evidence="https://mail/2", status="Applied")
    assert res["outcome"] == "updated"
    row = conn.execute("select notes, evidence from public.applications where id=%s",
                       (app,)).fetchone()
    assert row[0] == "typed in the app", "the seed overwrote a value the app held"
    assert row[1] == "https://mail/2", "the seed did not fill a blank"


def test_the_seed_moves_status_forward_only(conn):
    user, key, _app = gated_app(conn, status="Interview")
    assert seed_row(conn, user, key, status="Applied")["outcome"] == "unchanged"
    assert app_of(conn, user, key)["status"] == "Interview"
    assert seed_row(conn, user, key, status="Offer")["outcome"] == "updated"
    assert app_of(conn, user, key)["status"] == "Offer"


def test_the_seed_never_touches_a_row_the_app_has_claimed(conn):
    """Somebody pressed something in the web app; this job did not."""
    user, key, app = gated_app(conn, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Withdrawn", note="not for me")
    assert seed_row(conn, user, key, status="Offer")["outcome"] in ("unchanged", "updated")
    row = app_of(conn, user, key)
    assert row["status"] == "Withdrawn" and row["status_actor"] == "user"


def test_a_claim_made_in_the_sheet_crosses_over_once(conn):
    """The durable half of the dual-lock: after this, the 0010 trigger defends the
    row against every writer — including the next event, which no longer has to be
    told what the sheet thinks."""
    user, key, _app = gated_app(conn, status="Queued")
    res = seed_row(conn, user, key, status="Offer", status_actor="user")
    assert res["outcome"] == "updated"
    row = app_of(conn, user, key)
    assert row["status"] == "Offer" and row["status_actor"] == "user"
    assert row["status_set_at"] is not None

    # and now the bot lane bounces off it with no sheet truth passed at all
    assert apply_event(conn, user, key, event_type="rejection",
                       status="Rejected")["outcome"] == "locked"
    assert app_of(conn, user, key)["status"] == "Offer"


def test_a_human_only_ending_seeds_only_as_a_human_claim(conn):
    """`Offer-Accepted` in the sheet is a person's decision. It crosses over when
    the row says a human made it, and is refused when it arrives unclaimed — which
    is the shape of a bot having written it into the sheet."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    with pytest.raises(psycopg.errors.Error) as exc:
        seed_row(conn, user, key, status="Offer-Accepted", status_actor="")
    assert "human-only" in str(exc.value)
    assert app_of(conn, user, key) is None

    assert seed_row(conn, user, key, status="Offer-Accepted",
                    status_actor="user")["outcome"] == "created"
    row = app_of(conn, user, key)
    assert row["status"] == "Offer-Accepted" and row["status_actor"] == "user"


def test_a_row_whose_key_names_no_posting_is_refused_not_invented(conn):
    """A NULL-keyed twin is one the event lane could never match, so the next real
    email would mint a SECOND application for the same job."""
    user = make_user(conn)
    res = seed_row(conn, user, "norm-mastercard|product-manager")
    assert res["outcome"] == "no_posting"
    assert conn.execute("select count(*) from public.applications where user_id=%s",
                        (user,)).fetchone()[0] == 0


def test_the_seed_drains_what_the_event_lane_could_not_apply(conn):
    """End to end, in the order an operator would hit it: an event arrives for an
    application pg does not have, is recorded as unapplied, the seed runs, and the
    next event applies."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:10]}")
    assert apply_event(conn, user, key, event_type="oa_invite",
                       status="OA")["outcome"] == "no_application"
    assert len(unapplied_events(conn, user)) == 1

    assert seed_row(conn, user, key, status="Applied")["outcome"] == "created"
    res = apply_event(conn, user, key, event_type="oa_invite", status="OA")
    assert res["outcome"] == "advanced"
    assert app_of(conn, user, key)["status"] == "OA"


# ------------------------------------------------------------- refusals

def test_the_function_refuses_an_event_with_no_idempotency_key(conn):
    user, key, _app = gated_app(conn)
    with pytest.raises(psycopg.errors.Error) as exc:
        apply_event(conn, user, key, event_id="   ")
    assert "idempotency key required" in str(exc.value)


def test_the_function_refuses_a_blank_posting_key(conn):
    user = make_user(conn)
    with pytest.raises(psycopg.errors.Error):
        apply_event(conn, user, "  ")


def test_a_browser_session_cannot_call_it(conn):
    """It takes the acting user as an ARGUMENT. Reachable from a browser, it
    would let any session advance anybody else's pipeline — which is why it is
    revoked from `anon` and `authenticated` BY NAME, not merely from `public`."""
    user, key, _app = gated_app(conn, status="Queued")
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (user,))
    conn.execute("set role authenticated")
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            apply_event(conn, user, key, status="Applied")
    finally:
        conn.execute("reset role")
    assert app_of(conn, user, key)["status"] == "Queued"
