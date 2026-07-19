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
    assert counts == {"matched": 1, "created": 0, "needs_review": 0}
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
    assert counts == {"matched": 0, "created": 0, "needs_review": 0}
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
