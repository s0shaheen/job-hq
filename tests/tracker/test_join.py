import pytest

from core.fakes import fake_hq
from tracker import join

GH = "https://boards.greenhouse.io/acme/jobs/123"      # -> greenhouse-123
GH2 = "https://boards.greenhouse.io/acme/jobs/500"     # -> greenhouse-500
THREAD = "https://mail.google.com/mail/u/0/#inbox/abc"


def _event(hq, **kw):
    ev = {
        "event_id": "ev1", "account": "main",
        "received_at": "2026-07-10 14:22:00Z",
        "from": "no-reply@greenhouse.io", "subject": "update", "snippet": "",
        "event_type": "received", "company": "", "title": "", "ats": "",
        "job_url": "", "confidence": "0.95", "evidence": "", "thread_link": THREAD,
    }
    ev.update(kw)
    hq.tab("email_events").append_records([ev])
    return ev


def _pipe(hq, **kw):
    rec = {"key": "greenhouse-123", "company": "Acme", "title": "Product Manager",
           "status": "Queued"}
    rec.update(kw)
    hq.tab("pipeline").append_records([rec])


def _ev_row(hq, event_id="ev1"):
    return [r for r in hq.tab("email_events").records() if r["event_id"] == event_id][0]


def _pipe_row(hq, key):
    return [r for r in hq.tab("pipeline").records() if r["key"] == key][0]


# ---------------------------------------------------------- strong-key ladder

def test_strong_key_hard_rule_high_confidence_advances():
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95")
    counts = join.run(hq)
    # pg/pg_skipped are zero because HQ_PG_WRITES is unset: Phase A counts the
    # store lane and never runs it.
    assert counts == {"matched": 1, "created": 0, "needs_review": 0,
                      "pg": 0, "pg_skipped": 0}
    row = _pipe_row(hq, "greenhouse-123")
    assert row["status"] == "Applied"
    assert row["evidence"] == THREAD
    assert row["last_activity"] != ""
    ev = _ev_row(hq)
    assert ev["matched_key"] == "greenhouse-123"
    assert ev["applied_status"] == "advanced:Applied"


def test_forward_only_never_downgrades_but_bumps_activity():
    hq = fake_hq()
    _pipe(hq, status="Interview")
    _event(hq, job_url=GH, event_type="received", confidence="0.99")
    join.run(hq)
    row = _pipe_row(hq, "greenhouse-123")
    assert row["status"] == "Interview"          # advance_status kept it
    assert row["last_activity"] != ""            # but the event is still activity
    assert _ev_row(hq)["applied_status"] == "kept:Applied"


def test_human_owned_status_survives_a_099_rejection():
    """Acceptance criterion 14, the whole of it.

    This was a LIVE DEFECT: `status_rank("Rejected")` is above
    `status_rank("Offer")`, so a rejection classified at 0.99 overwrote an
    Offer a human had chosen. Rank protected an INVENTED status and nothing
    protected a canonical one somebody picked on purpose.

    Both halves matter. The human keeps their Offer, AND the bot\'s opinion is
    visible as a suggestion with its evidence link — a lock that silently
    swallowed the rejection would trade one wrong answer for another.
    """
    hq = fake_hq()
    _pipe(hq, status="Offer", status_actor="user")
    _event(hq, job_url=GH, event_type="rejection", confidence="0.99")
    join.run(hq)
    row = _pipe_row(hq, "greenhouse-123")
    assert row["status"] == "Offer"
    assert row["suggested_status"] == "Rejected"
    assert row["evidence"] == THREAD
    assert row["last_activity"] != ""
    assert _ev_row(hq)["applied_status"] == "locked:Rejected"


def test_an_unclaimed_row_is_still_advanced_by_the_same_email():
    """The positive control for the test above: with `status_actor` left at its
    default, the identical event still advances the row. Without this, the lock
    could be hardcoded to fire on every row and both tests would pass."""
    hq = fake_hq()
    _pipe(hq, status="Offer")
    _event(hq, job_url=GH, event_type="rejection", confidence="0.99")
    join.run(hq)
    row = _pipe_row(hq, "greenhouse-123")
    assert row["status"] == "Rejected"
    assert _ev_row(hq)["applied_status"] == "advanced:Rejected"


def test_a_locked_row_keeps_its_evidence_when_the_event_has_none():
    """The suggestion must not cost the row its only actionable link.

    `evidence` was written unconditionally on the locked branch, so an event with
    no `thread_link` — a classifier that read a forwarded mail, a capture that
    lost the id — BLANKED the link a human had. `advance_status` has always
    guarded that same field (`if evidence and "evidence" in hmap`); this branch
    did not.
    """
    hq = fake_hq()
    _pipe(hq, status="Offer", status_actor="user", evidence="https://mail/keepme")
    _event(hq, job_url=GH, event_type="rejection", confidence="0.99", thread_link="")
    join.run(hq)
    row = _pipe_row(hq, "greenhouse-123")
    assert row["evidence"] == "https://mail/keepme"
    assert row["suggested_status"] == "Rejected"     # the opinion still lands


def test_a_locked_row_takes_a_better_evidence_link_when_there_is_one():
    """The positive control: guarding the write must not stop a real link
    arriving, or the suggestion becomes unactionable in the other direction."""
    hq = fake_hq()
    _pipe(hq, status="Offer", status_actor="user", evidence="https://mail/old")
    _event(hq, job_url=GH, event_type="rejection", confidence="0.99")
    join.run(hq)
    assert _pipe_row(hq, "greenhouse-123")["evidence"] == THREAD


def test_a_below_gate_suggestion_also_keeps_an_existing_link():
    hq = fake_hq()
    _pipe(hq, evidence="https://mail/keepme")
    _event(hq, job_url=GH, event_type="rejection", confidence="0.5", thread_link="")
    join.run(hq)
    assert _pipe_row(hq, "greenhouse-123")["evidence"] == "https://mail/keepme"


def test_a_rank_kept_move_does_not_become_a_suggestion():
    """`locked` and `kept` are different answers and must stay so. A stale
    confirmation email arriving at an Interview row is not an opinion worth
    recording — "suggests Applied" there is noise that teaches people to ignore
    the column."""
    hq = fake_hq()
    _pipe(hq, status="Interview")
    _event(hq, job_url=GH, event_type="received", confidence="0.99")
    join.run(hq)
    assert _pipe_row(hq, "greenhouse-123")["suggested_status"] == ""


def test_low_confidence_hard_rule_lands_in_suggested():
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="rejection", confidence="0.5")
    join.run(hq)
    row = _pipe_row(hq, "greenhouse-123")
    assert row["status"] == "Queued"
    assert row["suggested_status"] == "Rejected"
    assert row["evidence"] == THREAD
    assert row["last_activity"] != ""
    assert _ev_row(hq)["applied_status"] == "suggested:Rejected"


def test_soft_rule_always_suggested_even_at_high_confidence():
    hq = fake_hq()
    _pipe(hq, status="Final")
    _event(hq, job_url=GH, event_type="offer", confidence="0.99")
    join.run(hq)
    row = _pipe_row(hq, "greenhouse-123")
    assert row["status"] == "Final"
    assert row["suggested_status"] == "Offer"
    assert _ev_row(hq)["applied_status"] == "suggested:Offer"


def test_unparseable_confidence_never_clears_the_gate():
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="high")
    join.run(hq)
    assert _pipe_row(hq, "greenhouse-123")["status"] == "Queued"
    assert _ev_row(hq)["applied_status"] == "suggested:Applied"


def test_matched_received_does_not_create_duplicate_row():
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received")
    join.run(hq)
    assert len([r for r in hq.tab("pipeline").records() if r["key"]]) == 1


# --------------------------------------------------------------- row creation

def test_strong_key_unknown_received_creates_pipeline_row():
    hq = fake_hq()
    _event(hq, job_url=GH, event_type="received", confidence="0.9",
           account="alt", company="Acme", title="Product Manager")
    counts = join.run(hq)
    assert counts["created"] == 1
    row = _pipe_row(hq, "greenhouse-123")
    assert row["source"] == "gmail"
    assert row["status"] == "Applied"
    assert row["applied_date"] == "2026-07-10"
    assert row["applied_via"] == "scout"        # alt account = the scout applied
    assert row["applied_email"] == "alt"
    assert row["company"] == "Acme" and row["url"] == GH
    ev = _ev_row(hq)
    assert ev["matched_key"] == "greenhouse-123"
    assert ev["applied_status"] == "created"


def test_low_confidence_creation_stays_a_suggestion():
    hq = fake_hq()
    _event(hq, job_url=GH, event_type="received", confidence="0.4", account="main")
    join.run(hq)
    row = _pipe_row(hq, "greenhouse-123")
    assert row["status"] == "Inbox"
    assert row["suggested_status"] == "Applied"
    assert row["applied_via"] == "self"


def test_strong_key_unknown_non_received_parks_for_review():
    hq = fake_hq()
    _event(hq, job_url=GH, event_type="rejection")
    counts = join.run(hq)
    assert counts["needs_review"] == 1
    assert _ev_row(hq)["matched_key"] == join.NEEDS_REVIEW
    assert all(not r["key"] for r in hq.tab("pipeline").records())   # nothing created


# --------------------------------------------------------------- fuzzy ladder

def test_fuzzy_single_candidate_matches():
    hq = fake_hq()
    _pipe(hq, key="norm-x", company="Plaid", title="Product Manager - Core")
    _event(hq, event_type="interview", confidence="0.9",
           company="plaid.", title="Product Manager, Core")
    join.run(hq)
    row = _pipe_row(hq, "norm-x")
    assert row["status"] == "Interview"
    assert _ev_row(hq)["matched_key"] == "norm-x"


def test_fuzzy_ambiguous_parks_for_review_and_touches_nothing():
    hq = fake_hq()
    _pipe(hq, key="k1", company="Acme", title="Product Manager - Payments")
    _pipe(hq, key="k2", company="Acme", title="Product Manager - Platform")
    _event(hq, event_type="rejection", confidence="0.99",
           company="Acme", title="Product Manager")
    join.run(hq)
    assert _ev_row(hq)["matched_key"] == join.NEEDS_REVIEW
    for key in ("k1", "k2"):
        row = _pipe_row(hq, key)
        assert row["status"] == "Queued" and row["suggested_status"] == ""


def test_fuzzy_zero_candidates_parks_for_review():
    hq = fake_hq()
    _pipe(hq, key="k1", company="Acme")
    _event(hq, event_type="rejection", company="Stripe", title="Product Manager")
    join.run(hq)
    assert _ev_row(hq)["matched_key"] == join.NEEDS_REVIEW


def test_fuzzy_ignores_terminal_rows():
    hq = fake_hq()
    _pipe(hq, key="k1", company="Acme", title="Product Manager", status="Rejected")
    _event(hq, event_type="interview", company="Acme", title="Product Manager")
    join.run(hq)
    assert _ev_row(hq)["matched_key"] == join.NEEDS_REVIEW


def test_fuzzy_dissimilar_title_is_no_candidate():
    hq = fake_hq()
    _pipe(hq, key="k1", company="Acme", title="Staff Software Engineer")
    _event(hq, event_type="interview", company="Acme", title="Product Manager")
    join.run(hq)
    assert _ev_row(hq)["matched_key"] == join.NEEDS_REVIEW


# ------------------------------------------------------------------ non-moves

def test_recruiter_outreach_bumps_activity_only():
    hq = fake_hq()
    _pipe(hq, key="greenhouse-500", status="Screen")
    _event(hq, job_url=GH2, event_type="recruiter_outreach", confidence="0.99")
    join.run(hq)
    row = _pipe_row(hq, "greenhouse-500")
    assert row["status"] == "Screen"
    assert row["suggested_status"] == ""
    assert row["last_activity"] != ""
    assert _ev_row(hq)["applied_status"] == "matched"


def test_already_matched_events_are_skipped():
    hq = fake_hq()
    _pipe(hq)
    _event(hq, event_id="done", job_url=GH, matched_key="greenhouse-123",
           applied_status="advanced:Applied")
    counts = join.run(hq)
    assert counts == {"matched": 0, "created": 0, "needs_review": 0,
                      "pg": 0, "pg_skipped": 0}
    assert _pipe_row(hq, "greenhouse-123")["status"] == "Queued"


# ---- capture liveness watchdog (WS0): heartbeat_capture staleness

def _cfg_vals(hq):
    return {r.get("key", ""): r.get("value", "") for r in hq.tab("config").records()}


def test_capture_never_checked_in_alerts_once_and_latches(monkeypatch):
    import datetime as dt
    import core.notify
    from tracker.join import check_capture_liveness

    hq = fake_hq()
    ops = []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append(title))
    now = dt.datetime(2026, 7, 19, 12, 0, tzinfo=dt.timezone.utc)

    # first-deploy state: no heartbeat row, no latch row — the exact path
    # where an unimported RowNotFound would have crashed join
    assert check_capture_liveness(hq, now=now) == "stale (alerted)"
    assert ops == ["Gmail capture silent"]
    assert _cfg_vals(hq)["capture_alert_date"] == "2026-07-19"

    # same day: latched, no second page
    assert check_capture_liveness(hq, now=now) == "stale (already alerted today)"
    assert ops == ["Gmail capture silent"]


def test_fresh_heartbeat_is_alive_and_stale_one_realerts(monkeypatch):
    import datetime as dt
    import core.notify
    from tracker.join import check_capture_liveness

    hq = fake_hq()
    ops = []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append(title))
    now = dt.datetime(2026, 7, 19, 12, 0, tzinfo=dt.timezone.utc)

    hq.tab("config").append_records(
        [{"key": "heartbeat_capture", "value": "2026-07-19 08:00:00Z"}])
    assert check_capture_liveness(hq, now=now) == "alive" and ops == []

    hq.tab("config").set_by_key("heartbeat_capture",
                                {"value": "2026-07-16 08:00:00Z"}, key_header="key")
    assert check_capture_liveness(hq, now=now) == "stale (alerted)"
    assert ops == ["Gmail capture silent"]


# ------------------------------------------------- SHEET-SUNSET Phase C: the store lane
#
# The SQL half is exercised against real Postgres in tests/db/test_engine_writes.py.
# What is provable here is the WIRING, and the wiring has one property worth more
# than the rest: the order of the three writes per event.
#
# MUTATION TARGETS:
#   * move the `events.set_by_key` stamp above the pg call -> the ordering test
#     sees a stamped event, and with it goes the "a store failure replays the
#     event" property (a PgError would retire it from the sheet's queue forever);
#   * drop the `to_pg` guard -> the Phase-A test talks to a store nobody enabled;
#   * treat `no_posting` as a success -> the skip test's count lands in `pg`, and
#     an event that never reached the store reads as one that did;
#   * swallow the PgError -> the failure test returns counts instead of raising.

def _first_class(monkeypatch):
    from core import pgwrites
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, "11111111-1111-1111-1111-111111111111")
    monkeypatch.setattr("core.pg.enabled", lambda: True)


def _rpc(monkeypatch, handler):
    calls = []

    def fake(fn, params, *, session=None):
        calls.append((fn, params))
        return handler(params) if callable(handler) else handler
    monkeypatch.setattr("core.pg.rpc", fake)
    return calls


def test_phase_a_never_touches_the_store(monkeypatch):
    from core import pgwrites
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.setattr("core.pg.rpc",
                        lambda *a, **k: pytest.fail("join wrote pg with the flag unset"))
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95")
    assert join.run(hq)["pg"] == 0
    assert _pipe_row(hq, "greenhouse-123")["status"] == "Applied"   # sheet unchanged


def test_the_store_is_written_before_the_event_is_stamped(monkeypatch):
    """The stamp is what makes an event non-pending. Written first, a PgError
    would drop the event from BOTH queues: the sheet's (stamped) and pg's (never
    applied). Asserted from inside the RPC rather than read off the source."""
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95")
    seen = []
    _rpc(monkeypatch, lambda p: seen.append(_ev_row(hq, "ev1")["matched_key"])
         or {"outcome": "advanced", "application_id": 7})
    counts = join.run(hq)
    assert seen == [""], "the event was stamped before the store was written"
    assert counts["pg"] == 1 and counts["pg_skipped"] == 0
    assert _ev_row(hq, "ev1")["matched_key"] == "greenhouse-123"


def test_the_rpc_carries_the_classification_and_the_birth_fields(monkeypatch):
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95",
           company="Acme", title="Product Manager", account="alt")
    calls = _rpc(monkeypatch, {"outcome": "advanced"})
    join.run(hq)
    fn, p = calls[0]
    assert fn == join.PG_APPLY_FN
    assert p["p_user_id"] == "11111111-1111-1111-1111-111111111111" and p["p_posting_key"] == "greenhouse-123"
    assert p["p_event_id"] == "ev1" and p["p_event_type"] == "received"
    assert p["p_status"] == "Applied" and p["p_hard"] is True
    assert p["p_evidence"] == THREAD
    # the create payload is the sheet's own birth certificate, not a second one
    assert p["p_create"] == join._birth_fields(_ev_row(hq, "ev1"))
    assert p["p_create"]["applied_via"] == "scout" and p["p_create"]["source"] == "gmail"


def test_the_rpc_carries_the_sheets_own_status_and_claim(monkeypatch):
    """The store must decide against sheet truth, not against a twin nothing keeps
    current. pg's `status_actor` is written only by the web app, so during
    dual-write — when the human's editing surface IS the spreadsheet — this pair is
    the only way the store can learn that a person claimed the row.

    MUTATION: stop passing either p_current_* -> this goes red, and so does
    test_migrations' `passed == declared` check, which is the one that catches it
    even if somebody deletes this test.
    """
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq, status="Offer", status_actor="user")
    _event(hq, job_url=GH, event_type="rejection", confidence="0.99")
    calls = _rpc(monkeypatch, {"outcome": "locked"})
    join.run(hq)
    p = calls[0][1]
    assert p["p_current_status"] == "Offer" and p["p_current_actor"] == "user"


def test_a_row_the_sheet_has_never_seen_sends_nulls_not_blanks(monkeypatch):
    """'' is a status the sheet holds; None is "there is no second store". The
    function reads them differently (blank ranks -1 and advances; null skips the
    comparison entirely), so the caller must not flatten one into the other."""
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    # a fuzzy-free strong-key event whose key is NOT in the Pipeline: join creates
    # the sheet row inside _match_event, so the pre-loop snapshot has no entry
    _event(hq, job_url=GH2, event_type="received", confidence="0.95", company="Acme")
    calls = _rpc(monkeypatch, {"outcome": "advanced"})
    join.run(hq)
    p = next(p for _fn, p in calls if p["p_posting_key"] == "greenhouse-500")
    assert p["p_current_status"] is None and p["p_current_actor"] is None


def test_below_the_gate_the_rpc_is_told_it_is_a_suggestion(monkeypatch):
    """The control for p_hard: same event type, confidence under 0.85."""
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.5")
    calls = _rpc(monkeypatch, {"outcome": "suggested"})
    join.run(hq)
    assert calls[0][1]["p_hard"] is False


def test_any_matched_event_kind_can_give_the_store_its_missing_row(monkeypatch):
    """The sheet having a Pipeline row for this key IS the evidence the application
    exists — an OA invite for something tracked for a month witnesses it exactly as
    well as the one confirmation email each application ever receives, which for
    every pre-existing row was consumed before the flag existed."""
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq, applied_date="2026-06-01", source="monitor", applied_via="self")
    _event(hq, job_url=GH, event_type="rejection", confidence="0.95")
    calls = _rpc(monkeypatch, {"outcome": "advanced"})
    join.run(hq)
    p = calls[0][1]
    assert p["p_status"] == "Rejected"
    assert p["p_create"] is not None, "a rejection for a tracked row created nothing"
    # and the birth certificate is the SHEET's, not the rejection email's: an
    # event-sourced applied_date would claim it was submitted the day it was rejected
    assert p["p_create"]["applied_date"] == "2026-06-01"
    assert p["p_create"]["source"] == "monitor"


def test_a_weak_key_still_carries_no_create_payload(monkeypatch):
    """`applications.posting_key` is a foreign key, so a `norm-` key has nothing to
    create against. The gate moved from the event KIND to the key's strength; it did
    not disappear."""
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq, key="norm-acme|product-manager")
    _event(hq, job_url="", event_type="rejection", confidence="0.95",
           company="Acme", title="Product Manager")
    calls = _rpc(monkeypatch, {"outcome": "no_posting"})
    join.run(hq)
    assert calls[0][1]["p_posting_key"] == "norm-acme|product-manager"
    assert calls[0][1]["p_create"] is None


def test_an_unmatched_event_is_never_offered_to_the_store(monkeypatch):
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url="https://example.com/careers/9", event_type="rejection")
    monkeypatch.setattr("core.pg.rpc",
                        lambda *a, **k: pytest.fail("NEEDS_REVIEW was sent to the store"))
    assert join.run(hq)["needs_review"] == 1


def test_both_unapplied_outcomes_are_in_the_skip_list():
    """Spelled out as LITERALS, never derived from the thing under test.

    The first version of the test below parametrized over `PG_NOTHING_TO_APPLY`
    itself, so the review's mutation M8 — dropping `no_application` from it — did
    not fail the test, it deleted a case from it. A test that shrinks with the
    constant it guards is not a guard.
    """
    assert set(join.PG_NOTHING_TO_APPLY) == {"no_posting", "no_application"}


@pytest.mark.parametrize("outcome", ["no_posting", "no_application"])
def test_an_unapplied_event_is_logged_and_skipped_not_counted_as_applied(
        monkeypatch, capsys, outcome):
    """`no_application` had no unit test at all, and mutation M8 survived the whole
    suite. That mutant counts an event the store never applied as a success, writes
    no Log row and prints no warning — deleting the one signal that the two lanes
    are drifting."""
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95")
    _rpc(monkeypatch, {"outcome": outcome, "posting_key": "greenhouse-123"})
    counts = join.run(hq)
    assert counts["pg"] == 0 and counts["pg_skipped"] == 1
    cap = capsys.readouterr()
    said = cap.out + cap.err            # the per-event line is stderr; the ::warning is stdout
    assert f"pg {outcome}" in said
    assert "tracker.pgseed" in said, "the residue was reported with no way to drain it"
    assert any(r["action"] == f"pg_{outcome}" for r in hq.tab("log").records())
    # the sheet lane is unaffected: the store missing a row is not the sheet's problem
    assert _pipe_row(hq, "greenhouse-123")["status"] == "Applied"


def test_the_event_is_retired_and_the_residue_is_recorded_rather_than_replayed(monkeypatch):
    """The retire-vs-wait contract, made explicit.

    `matched_key` means "the SHEET lane processed this event", and it did — so it
    is stamped. Leaving it blank would keep the store's queue alive at the cost of
    un-truthing the sheet's own audit and re-applying a permanently unresolvable
    event (the four weak `norm-` keys in today's Pipeline) every two hours forever,
    each pass appending a Log row and re-entering the next morning's briefing. The
    durable record lives pg-side instead (0015's `email.unapplied`), and the drain
    is `tracker.pgseed`.
    """
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95")
    _rpc(monkeypatch, {"outcome": "no_posting", "posting_key": "greenhouse-123"})
    join.run(hq)
    assert _ev_row(hq, "ev1")["matched_key"] == "greenhouse-123"
    assert _ev_row(hq, "ev1")["applied_status"] != "", "the sheet's own audit went blank"
    # and the second run has nothing to do: no re-application, no second Log row
    monkeypatch.setattr("core.pg.rpc",
                        lambda *a, **k: pytest.fail("a retired event was re-offered"))
    assert join.run(hq)["pg_skipped"] == 0


def test_an_outcome_this_version_does_not_know_is_refused(monkeypatch):
    """A future migration adding an outcome must not have it tallied as a
    successful write — `counts["pg"]` is the number that says the lanes agree."""
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95")
    _rpc(monkeypatch, {"outcome": "deferred_pending_review"})
    with pytest.raises(RuntimeError, match="does not understand"):
        join.run(hq)


def test_a_store_outage_still_runs_the_gmail_tripwire(monkeypatch):
    """`check_capture_liveness` is one of the two copies of the "capture has gone
    silent" watchdog, it is about the SHEET, and a PgError inside run() used to
    skip it — so one store outage blinded both copies at once."""
    import core.notify
    from core import pg
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95")
    ops = []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append(title))
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(lambda cls: hq))

    def boom(*a, **k):
        raise pg.PgError("rpc hq_apply_email_event -> HTTP 503")
    monkeypatch.setattr("core.pg.rpc", boom)

    assert join.main() == 1                       # the run still fails, loudly
    assert "tracker/join failed" in ops
    assert "Gmail capture silent" in ops, "a store outage silenced the sheet's tripwire"
    # and the chain's heartbeat is withheld: the chain did not finish
    assert not [r for r in hq.tab("config").records() if r["key"] == "heartbeat_tracker"]


def test_a_store_failure_fails_the_run_and_leaves_the_event_pending(monkeypatch):
    from core import pg
    _first_class(monkeypatch)
    hq = fake_hq()
    _pipe(hq)
    _event(hq, job_url=GH, event_type="received", confidence="0.95")

    def boom(*a, **k):
        raise pg.PgError("rpc hq_apply_email_event -> HTTP 503")
    monkeypatch.setattr("core.pg.rpc", boom)
    with pytest.raises(pg.PgError):
        join.run(hq)
    assert _ev_row(hq, "ev1")["matched_key"] == "", "a dead store retired the event anyway"
