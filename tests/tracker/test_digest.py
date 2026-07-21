import datetime as dt

import pytest

from core.fakes import fake_hq
from tracker import digest

NOW = dt.datetime(2026, 7, 13, 12, 0, tzinfo=dt.timezone.utc)
TODAY = "2026-07-13"
YESTERDAY = "2026-07-12"


@pytest.fixture
def spies(monkeypatch):
    pushes, alerts = [], []
    monkeypatch.setattr("core.notify.push",
                        lambda title, body, **kw: pushes.append((title, body, kw)) or True)
    monkeypatch.setattr("core.notify.ops_alert",
                        lambda title, body, **kw: alerts.append((title, body)) or True)
    return pushes, alerts


def _seeded_hq():
    hq = fake_hq()
    hq.registry["sheet_id"] = "TESTID"
    hq.tab("companies").append_records([
        {"name": "BigCo", "priority": "TRUE"}, {"name": "SmallCo"}])
    hq.tab("feed").append_records([
        {"key": "greenhouse-1", "company": "BigCo", "title": "Staff PM",
         "url": "u1", "first_seen": TODAY, "min_yoe": "9"},        # priority overrides YoE
        {"key": "greenhouse-2", "company": "SmallCo", "title": "PM",
         "url": "u2", "first_seen": TODAY, "min_yoe": "2", "location": "Remote"},
        {"key": "greenhouse-3", "company": "SmallCo", "title": "GPM",
         "url": "u3", "first_seen": TODAY, "min_yoe": "9"},        # over the YoE gate
        {"key": "greenhouse-4", "company": "SmallCo", "title": "APM",
         "url": "u4", "first_seen": YESTERDAY, "min_yoe": "1"},    # not today
        {"key": "greenhouse-5", "company": "SmallCo", "title": "PM Core",
         "url": "u5", "first_seen": TODAY, "min_yoe": ""}])        # unknown YoE passes
    hq.tab("log").append_records([
        {"ts": "2026-07-13 11:00:00Z", "actor": "join", "action": "advanced_status",
         "key": "greenhouse-2", "detail": "Applied -> Screen"},
        {"ts": "2026-07-13 09:00:00Z", "actor": "scout", "action": "applied_created",
         "key": "greenhouse-7", "detail": "ScoutCo"},
        {"ts": "2026-07-13 08:00:00Z", "actor": "simplify", "action": "suggested",
         "key": "greenhouse-8", "detail": "GoneCo -> Rejected"},
        {"ts": "2026-07-13 08:30:00Z", "actor": "join", "action": "kept_status",
         "key": "greenhouse-2", "detail": "human status wins"},
        {"ts": "2026-07-13 08:30:00Z", "actor": "simplify", "action": "sync",
         "key": "", "detail": "counts summary, not a status event"},
        {"ts": "2026-07-11 11:00:00Z", "actor": "join", "action": "advanced_status",
         "key": "greenhouse-2", "detail": "old"},
        {"ts": "2026-07-13 10:00:00Z", "actor": "monitor", "action": "append",
         "key": "greenhouse-9", "detail": "not a status event"}])
    hq.tab("email_events").append_records([
        {"event_id": "e1", "subject": "Thanks for applying", "matched_key": "NEEDS_REVIEW"},
        {"event_id": "e2", "subject": "Interview invite", "matched_key": "NEEDS_REVIEW"},
        {"event_id": "e3", "subject": "matched fine", "matched_key": "greenhouse-2"}])
    hq.tab("pipeline").append_records([
        {"key": "greenhouse-2", "company": "SmallCo", "title": "PM",
         "applied_date": "2026-06-01", "stale": "31d silent"},
        {"key": "greenhouse-1", "company": "BigCo", "title": "Staff PM", "stale": ""}])
    hq.tab("scout_daily").append_records([
        {"date": YESTERDAY, "jobs_added": "7", "applied": "3", "duplicates_flagged": "1"}])
    hq.tab("config").append_records([
        {"key": "heartbeat_monitor", "value": "2026-07-13 11:30:00Z"},
        {"key": "heartbeat_capture", "value": "2026-07-13 07:00:00Z"}])   # 5h silent
    return hq


def test_digest_sections_and_row(spies):
    pushes, alerts = spies
    hq = _seeded_hq()
    s = digest.run(hq, now=NOW)
    body = s["body"]

    assert s["new"] == 3                    # BigCo(priority) + min_yoe 2 + blank yoe
    assert "greenhouse-3" not in body and "u3" not in body
    assert "u4" not in body
    assert body.index("BigCo") < body.index("SmallCo")     # priority-first
    assert "★" in body

    assert s["changes"] == 3                # join advance + scout create + simplify suggest
    assert "Applied -> Screen" in body and "old" not in body
    assert "applied_created" in body and "greenhouse-7" in body
    assert "GoneCo -> Rejected" in body
    assert "kept_status" not in body and "human status wins" not in body
    assert "counts summary" not in body     # simplify's sync roll-up stays out

    assert s["needs_review"] == 2
    assert "Thanks for applying" in body and "matched fine" not in body

    assert s["followups"] == 1
    assert "31d silent" in body and "Staff PM (" not in body

    assert "Added 7 job(s), applied 3, 1 duplicate(s) flagged." in body

    assert "⚠ capture" in body              # 5h > 2 x 1.5h cadence
    assert "⚠ wide: no heartbeat yet" in body
    assert "✅" not in body

    rows = [r for r in hq.tab("digest").records() if r["date"] == TODAY]
    assert len(rows) == 1
    assert rows[0]["sent_at"] == ""         # Apps Script's field, untouched

    title, _body, kw = pushes[0]
    assert title == "HQ digest — 3 new roles, 3 updates"
    assert kw["click"].endswith("/TESTID")

    assert s["capture_silent"] is True
    assert any(t == "Gmail capture silent" for t, _ in alerts)

    assert any(r["key"] == "heartbeat_digest" for r in hq.tab("config").records())


def test_rerun_same_day_updates_single_row(spies):
    hq = _seeded_hq()
    digest.run(hq, now=NOW)
    hq.tab("feed").append_records([
        {"key": "greenhouse-6", "company": "SmallCo", "title": "Sr PM",
         "url": "u6", "first_seen": TODAY, "min_yoe": "3"}])
    s2 = digest.run(hq, now=NOW)
    rows = [r for r in hq.tab("digest").records() if r["date"] == TODAY]
    assert len(rows) == 1                   # updated in place, not duplicated
    assert s2["new"] == 4


def test_all_green_health_no_capture_alert(spies):
    pushes, alerts = spies
    hq = fake_hq()
    hq.registry["sheet_id"] = "TESTID"
    fresh = "2026-07-13 11:45:00Z"
    hq.tab("config").append_records(
        [{"key": f"heartbeat_{n}", "value": fresh} for n in digest.CADENCE_HOURS])
    # daily jobs run once a day: a ~23h-old monitor beat is healthy, not a warning
    hq.tab("config").set_by_key(
        "heartbeat_monitor", {"value": "2026-07-12 13:00:00Z"}, key_header="key")
    # priority pauses overnight (~7h gap) — must not warn either
    hq.tab("config").set_by_key(
        "heartbeat_priority", {"value": "2026-07-13 04:45:00Z"}, key_header="key")
    s = digest.run(hq, now=NOW)
    assert "✅ all systems ran on schedule" in s["body"]
    assert "⚠" not in s["body"]
    assert s["capture_silent"] is False
    assert alerts == []
    assert "## New roles" not in s["body"]  # empty sections skipped


def test_new_roles_capped_with_more_line(spies):
    hq = fake_hq()
    hq.tab("feed").append_records([
        {"key": f"greenhouse-{i}", "company": f"Co{i:02d}", "title": "PM",
         "url": f"u{i}", "first_seen": TODAY, "min_yoe": "1"}
        for i in range(20)])
    s = digest.run(hq, now=NOW)
    assert s["new"] == 20
    assert "+5 more in the Feed tab" in s["body"]


# ---- the digest must never un-filter a geo violation

def _feed_row(**kw):
    base = {"key": "greenhouse-1", "company": "Acme", "title": "PM",
            "url": "http://x", "location": "Hyderabad, India",
            "first_seen": "2026-07-20", "min_yoe": "2",
            "disposition": "filtered", "disposition_reason": "geo:India"}
    base.update(kw)
    return base


def test_priority_company_never_exempts_a_geo_violation():
    from core.fakes import fake_hq
    from tracker.digest import _sec_new_roles
    hq = fake_hq()
    hq.tab("companies").append_records(
        [{"name": "Acme", "ats": "greenhouse", "slug": "a",
          "monitor": "TRUE", "priority": "TRUE"}])
    hq.tab("feed").append_records([_feed_row()])
    lines, n = _sec_new_roles(hq, {"yoe_push_max": 4}, "2026-07-20")
    assert n == 0 and lines == []          # handpicked employer, wrong continent


def test_priority_company_still_exempts_the_yoe_bar_but_says_so():
    from core.fakes import fake_hq
    from tracker.digest import _sec_new_roles
    hq = fake_hq()
    hq.tab("companies").append_records(
        [{"name": "Acme", "ats": "greenhouse", "slug": "a",
          "monitor": "TRUE", "priority": "TRUE"}])
    hq.tab("feed").append_records(
        [_feed_row(location="Chicago, IL", min_yoe="9",
                   disposition="filtered", disposition_reason="yoe:9>4")])
    lines, n = _sec_new_roles(hq, {"yoe_push_max": 4}, "2026-07-20")
    assert n == 1
    assert "outside your filters" in lines[0]   # visible, not silent


def test_qualified_rows_are_unlabelled():
    from core.fakes import fake_hq
    from tracker.digest import _sec_new_roles
    hq = fake_hq()
    hq.tab("feed").append_records(
        [_feed_row(location="Chicago, IL", disposition="qualified",
                   disposition_reason="")])
    lines, n = _sec_new_roles(hq, {"yoe_push_max": 4}, "2026-07-20")
    assert n == 1 and "outside your filters" not in lines[0]
