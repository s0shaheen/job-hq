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
    # cafe and theirstack are separate channels: a dead TheirStack must not
    # hide behind a healthy hiring.cafe
    assert "⚠ cafe: no heartbeat yet" in body
    assert "⚠ theirstack: no heartbeat yet" in body
    assert "✅" not in body

    rows = [r for r in hq.tab("digest").records() if r["date"] == TODAY]
    assert len(rows) == 1
    assert rows[0]["sent_at"] == ""         # Apps Script's field, untouched

    title, _body, kw = pushes[0]
    assert title == "HQ digest — 3 new roles, 3 updates"
    assert kw["click"].endswith("/TESTID")

    assert s["capture_silent"] is True
    assert any(t == "Gmail capture silent" for t, _ in alerts)

    # no backup lane has ever beaten in this fixture — that pages too
    assert s["backups_stale"] is True
    backup = [b for t, b in alerts if t == "HQ backups stale"]
    assert len(backup) == 1
    assert "⚠ selfheal" in backup[0]
    assert "⚠ snapshot:" in backup[0] and "⚠ snapshot_s3:" in backup[0]   # both copies named

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
    # the sweep runs twice daily (cadence 12h): a beat from this morning's run
    # is healthy at midday, not a warning
    hq.tab("config").set_by_key(
        "heartbeat_monitor", {"value": "2026-07-13 01:00:00Z"}, key_header="key")
    s = digest.run(hq, now=NOW)
    assert "✅ all systems ran on schedule" in s["body"]
    assert "⚠" not in s["body"]
    assert s["capture_silent"] is False
    assert s["backups_stale"] is False
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
    from tracker.digest import _md_new_roles, _new_roles
    hq = fake_hq()
    hq.tab("companies").append_records(
        [{"name": "Acme", "ats": "greenhouse", "slug": "a",
          "monitor": "TRUE", "priority": "TRUE"}])
    hq.tab("feed").append_records([_feed_row()])
    roles, n = _new_roles(hq, {"yoe_push_max": 4}, "2026-07-20")
    lines = _md_new_roles(roles, n)
    assert n == 0 and lines == []          # handpicked employer, wrong continent


def test_priority_company_still_exempts_the_yoe_bar_but_says_so():
    from core.fakes import fake_hq
    from tracker.digest import _md_new_roles, _new_roles
    hq = fake_hq()
    hq.tab("companies").append_records(
        [{"name": "Acme", "ats": "greenhouse", "slug": "a",
          "monitor": "TRUE", "priority": "TRUE"}])
    hq.tab("feed").append_records(
        [_feed_row(location="Chicago, IL", min_yoe="9",
                   disposition="filtered", disposition_reason="yoe:9>4")])
    roles, n = _new_roles(hq, {"yoe_push_max": 4}, "2026-07-20")
    lines = _md_new_roles(roles, n)
    assert n == 1
    assert "outside your filters" in lines[0]   # visible, not silent


def test_qualified_rows_are_unlabelled():
    from core.fakes import fake_hq
    from tracker.digest import _md_new_roles, _new_roles
    hq = fake_hq()
    hq.tab("feed").append_records(
        [_feed_row(location="Chicago, IL", disposition="qualified",
                   disposition_reason="")])
    roles, n = _new_roles(hq, {"yoe_push_max": 4}, "2026-07-20")
    lines = _md_new_roles(roles, n)
    assert n == 1 and "outside your filters" not in lines[0]


def test_retired_priority_watch_is_not_watched(spies):
    """A dispatch-only job must not be in CADENCE_HOURS: watching a heartbeat
    that will never be written again means a stale warning every single day,
    and a briefing that cries wolf daily is one you stop reading."""
    assert "priority" not in digest.CADENCE_HOURS
    hq = fake_hq()
    hq.registry["sheet_id"] = "TESTID"
    fresh = "2026-07-13 11:45:00Z"
    hq.tab("config").append_records(
        [{"key": f"heartbeat_{n}", "value": fresh} for n in digest.CADENCE_HOURS])
    # a long-dead priority heartbeat must not produce a warning
    hq.tab("config").append_records(
        [{"key": "heartbeat_priority", "value": "2026-01-01 00:00:00Z"}])
    s = digest.run(hq, now=NOW)
    assert "⚠" not in s["body"] and "priority" not in s["body"]


def test_a_missed_second_sweep_is_still_healthy_but_a_missed_day_warns(spies):
    hq = fake_hq()
    hq.registry["sheet_id"] = "TESTID"
    fresh = "2026-07-13 11:45:00Z"
    hq.tab("config").append_records(
        [{"key": f"heartbeat_{n}", "value": fresh} for n in digest.CADENCE_HOURS])
    # 18h old: one sweep missed, within 2x the 12h cadence -> quiet
    hq.tab("config").set_by_key(
        "heartbeat_monitor", {"value": "2026-07-12 18:00:00Z"}, key_header="key")
    assert "⚠ monitor" not in digest.run(hq, now=NOW)["body"]
    # 30h old: more than a full day of sweeps missed -> warn
    hq.tab("config").set_by_key(
        "heartbeat_monitor", {"value": "2026-07-12 06:00:00Z"}, key_header="key")
    assert "⚠ monitor" in digest.run(hq, now=NOW)["body"]


# ---- a dead backup pages; every other stale heartbeat only prints

def _all_fresh_hq():
    hq = fake_hq()
    hq.registry["sheet_id"] = "TESTID"
    hq.tab("config").append_records(
        [{"key": f"heartbeat_{n}", "value": "2026-07-13 11:45:00Z"}
         for n in digest.CADENCE_HOURS])
    return hq


def test_stale_snapshot_heartbeat_pages_ops(spies):
    """The git copy silently stopping is the failure you only find out about on
    restore day — so it is an ops push, not a line in a briefing."""
    _pushes, alerts = spies
    hq = _all_fresh_hq()
    hq.tab("config").set_by_key(                    # 3 days old vs a 24h cadence
        "heartbeat_snapshot", {"value": "2026-07-10 08:53:00Z"}, key_header="key")
    s = digest.run(hq, now=NOW)

    assert s["backups_stale"] is True
    title, body = next((t, b) for t, b in alerts if t == "HQ backups stale")
    assert title == "HQ backups stale"
    assert "⚠ snapshot:" in body and "2026-07-10 08:53:00Z" in body
    assert "⚠ selfheal" not in body                 # only the lane that died
    assert "⚠ snapshot_s3" not in body              # the S3 copy is fine, don't implicate it
    assert "⚠ snapshot" in s["body"]                # still visible in the briefing
    assert not any(t == "Gmail capture silent" for t, _ in alerts)


def test_a_dead_s3_lane_pages_even_though_the_git_lane_is_fresh(spies):
    """The whole point of two beats. Actions commits `snapshot` nightly; if that one beat
    also stood for the Lambda→S3 copy, this exact state (git fine, S3 dead for days) would
    read as healthy — the silent-death bug, rebuilt in the watchdog."""
    _pushes, alerts = spies
    hq = _all_fresh_hq()
    hq.tab("config").set_by_key(
        "heartbeat_snapshot_s3", {"value": "2026-07-10 08:53:00Z"}, key_header="key")
    s = digest.run(hq, now=NOW)

    assert s["backups_stale"] is True
    body = next(b for t, b in alerts if t == "HQ backups stale")
    assert "⚠ snapshot_s3:" in body and "2026-07-10 08:53:00Z" in body
    assert "⚠ snapshot:" not in body                # the git copy is healthy
    assert "⚠ selfheal" not in body


def test_a_never_written_s3_lane_pages(spies):
    """Until the Lambda lane's first run there is no beat at all — and "no backup yet" is
    exactly as much data on disk as "backup stopped", so it pages the same way."""
    _pushes, alerts = spies
    hq = _all_fresh_hq()
    hq.tab("config").set_by_key("heartbeat_snapshot_s3", {"value": ""}, key_header="key")
    s = digest.run(hq, now=NOW)

    assert s["backups_stale"] is True
    body = next(b for t, b in alerts if t == "HQ backups stale")
    assert "⚠ snapshot_s3: no heartbeat yet" in body


def test_backup_and_capture_pushes_name_the_instance_when_multi_user(spies):
    """One ops topic carries every instance's failures (MULTIUSER.md points every user's ops
    topic at the operator), so an unattributed page sends them to the wrong spreadsheet."""
    _pushes, alerts = spies
    hq = _all_fresh_hq()
    hq.user = "dad"
    hq.tab("config").set_by_key("heartbeat_snapshot_s3", {"value": ""}, key_header="key")
    hq.tab("config").set_by_key(                    # 5h silent vs the 3h capture bar
        "heartbeat_capture", {"value": "2026-07-13 07:00:00Z"}, key_header="key")
    digest.run(hq, now=NOW)

    titles = [t for t, _ in alerts]
    assert "[dad] HQ backups stale" in titles
    assert "[dad] Gmail capture silent" in titles


def test_single_user_push_titles_are_unprefixed(spies):
    """No user, no bracket: the existing single-user pages must not gain noise."""
    _pushes, alerts = spies
    hq = _all_fresh_hq()
    hq.tab("config").set_by_key("heartbeat_snapshot_s3", {"value": ""}, key_header="key")
    digest.run(hq, now=NOW)
    assert [t for t, _ in alerts] == ["HQ backups stale"]


def test_missing_selfheal_heartbeat_pages_ops(spies):
    """Never-written counts as stale: a backup that has not run yet and a backup
    that stopped running are the same amount of data on disk."""
    _pushes, alerts = spies
    hq = _all_fresh_hq()
    hq.tab("config").set_by_key("heartbeat_selfheal", {"value": ""}, key_header="key")
    s = digest.run(hq, now=NOW)

    assert s["backups_stale"] is True
    body = next(b for t, b in alerts if t == "HQ backups stale")
    assert "⚠ selfheal: no heartbeat yet" in body


def test_other_stale_heartbeats_do_not_page_backups(spies):
    """A dead sweep is a bad day; a dead backup is an unrecoverable one. Only
    the second escalates past the briefing."""
    _pushes, alerts = spies
    hq = _all_fresh_hq()
    hq.tab("config").set_by_key(
        "heartbeat_review", {"value": "2026-07-10 15:00:00Z"}, key_header="key")
    s = digest.run(hq, now=NOW)

    assert "⚠ review" in s["body"]
    assert s["backups_stale"] is False
    assert alerts == []


# ---- Phase C1: two stores, judged separately
#
# MUTATION TARGETS:
#   * merge the two verdicts ("alive in either store") -> both directional tests
#     go green with a lane that has been dead in one store for days;
#   * skip the pg check when the sheet beat is fresh -> the dead-pg-lane test
#     stops paging, which is the sheet vouching for a store it is about to be
#     replaced by;
#   * make `beats.last_seen` best-effort in digest.run -> the unreachable-store
#     test reports "all systems ran on schedule" while holding no beats at all.

UID = "00000000-0000-0000-0000-000000000001"
FRESH = dt.datetime(2026, 7, 13, 11, 45, tzinfo=dt.timezone.utc)
DEAD = dt.datetime(2026, 7, 10, 8, 53, tzinfo=dt.timezone.utc)


def _pg_on(monkeypatch, lanes):
    """first_class, with `channel_runs` answering exactly `lanes`."""
    from core import beats, pgwrites
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, UID)
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    monkeypatch.setattr(beats, "last_seen", lambda uid, *a, **k: dict(lanes))
    written = []
    monkeypatch.setattr(beats, "write", lambda lane, uid, **k: written.append(lane))
    return written


def test_a_dead_pg_beat_pages_even_when_the_sheet_beat_is_fresh(spies, monkeypatch):
    """The direction that matters after the cutover: the sheet lane is about to be
    decommissioned, so it must never vouch for the store that replaces it."""
    _pushes, alerts = spies
    from core import beats as beats_mod
    _pg_on(monkeypatch, {n: (DEAD if n == "snapshot_s3" else FRESH)
                         for n in beats_mod.LANES})
    hq = _all_fresh_hq()                       # every SHEET beat is fresh
    s = digest.run(hq, now=NOW)

    assert s["backups_stale"] is True
    body = next(b for t, b in alerts if t == "HQ backups stale")
    assert "⚠ snapshot_s3 (pg):" in body
    assert "⚠ snapshot_s3:" not in body        # the sheet lane really is alive


def test_a_dead_sheet_beat_still_pages_when_the_pg_beat_is_fresh(spies, monkeypatch):
    """And the reverse, which is the live risk during dual-write."""
    _pushes, alerts = spies
    from core import beats as beats_mod
    _pg_on(monkeypatch, {n: FRESH for n in beats_mod.LANES})
    hq = _all_fresh_hq()
    hq.tab("config").set_by_key(
        "heartbeat_snapshot", {"value": "2026-07-10 08:53:00Z"}, key_header="key")
    s = digest.run(hq, now=NOW)

    assert s["backups_stale"] is True
    body = next(b for t, b in alerts if t == "HQ backups stale")
    assert "⚠ snapshot:" in body
    assert "⚠ snapshot (pg):" not in body


def test_a_lane_that_never_beat_in_pg_is_a_warning_not_a_silence(spies, monkeypatch):
    _pushes, alerts = spies
    from core import beats as beats_mod
    _pg_on(monkeypatch, {n: (None if n == "snapshot" else FRESH) for n in beats_mod.LANES})
    s = digest.run(_all_fresh_hq(), now=NOW)
    assert s["backups_stale"] is True
    assert "⚠ snapshot (pg): no heartbeat yet" in s["body"]


def test_the_stores_own_backup_lane_is_watched_only_in_the_store(spies, monkeypatch):
    """`pgdump` has no Config row and never will — its product is a pg dump. Watched
    in the sheet table it would page every morning of Phase A about a lane that has
    no sheet beat to give; watched nowhere, pg becomes load-bearing with an
    unmonitored backup, which is the sheet's own 2026-07-24 outage in the substrate
    that replaced it."""
    _pushes, alerts = spies
    from core import beats as beats_mod
    _pg_on(monkeypatch, {n: (None if n == "pgdump" else FRESH) for n in beats_mod.LANES})
    s = digest.run(_all_fresh_hq(), now=NOW)
    assert s["backups_stale"] is True
    body = next(b for t, b in alerts if t == "HQ backups stale")
    assert "⚠ pgdump (pg): no heartbeat yet" in body
    assert "⚠ pgdump:" not in body            # never expected from the sheet


def test_phase_a_never_mentions_the_store_only_lane(spies, monkeypatch):
    """The control for the line above: with the flag unset the pg table is not read
    at all, so `pgdump` cannot produce a warning on any of today's live runs."""
    from core import pgwrites
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    s = digest.run(_all_fresh_hq(), now=NOW)
    assert "pgdump" not in s["body"] and s["backups_stale"] is False


def test_both_stores_healthy_says_so(spies, monkeypatch):
    """The control. Without it, every assertion above is equally true of a
    watchdog that warns about everything."""
    _pushes, alerts = spies
    from core import beats as beats_mod
    _pg_on(monkeypatch, {n: FRESH for n in beats_mod.LANES})
    s = digest.run(_all_fresh_hq(), now=NOW)
    assert s["backups_stale"] is False and alerts == []
    assert "✅ all systems ran on schedule" in s["body"]


def test_the_digest_beats_in_both_stores(spies, monkeypatch):
    from core import beats as beats_mod
    written = _pg_on(monkeypatch, {n: FRESH for n in beats_mod.LANES})
    hq = _all_fresh_hq()
    digest.run(hq, now=NOW)
    assert written == ["digest"]
    assert any(r["key"] == "heartbeat_digest" for r in hq.tab("config").records())


def test_phase_a_reads_and_writes_no_pg_beats(spies, monkeypatch):
    from core import pgwrites
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.setattr("core.beats.last_seen",
                        lambda *a, **k: pytest.fail("pg read with the flag unset"))
    monkeypatch.setattr("core.beats.write",
                        lambda *a, **k: pytest.fail("pg beat with the flag unset"))
    s = digest.run(_all_fresh_hq(), now=NOW)
    assert s["backups_stale"] is False


def _pg_down(monkeypatch):
    from core import pg, pgwrites
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, UID)
    monkeypatch.setattr("core.pg.enabled", lambda: True)

    def boom(*a, **k):
        raise pg.PgError("select channel_runs -> HTTP 503")
    monkeypatch.setattr("core.beats.last_seen", boom)
    monkeypatch.setattr("core.beats.write", boom)


def test_an_unreachable_store_is_reported_and_pages(spies, monkeypatch):
    """A watchdog that shrugs it off prints "all systems ran on schedule" at exactly
    the moment it can no longer see half of what it watches."""
    _pushes, alerts = spies
    _pg_down(monkeypatch)
    s = digest.run(_all_fresh_hq(), now=NOW)
    assert s["backups_stale"] is True
    body = next(b for t, b in alerts if t == "HQ backups stale")
    assert "pg heartbeats unreadable" in body and "HTTP 503" in body
    assert "✅ all systems ran on schedule" not in s["body"]


def test_a_store_outage_does_not_blind_the_sheets_own_watchdogs(spies, monkeypatch):
    """The measured regression: raising before the sections were composed took down
    the digest row, the phone push, the capture-silent alert and the backups-stale
    alert — every one of which is about the SHEET and was working."""
    pushes, alerts = spies
    _pg_down(monkeypatch)
    hq = _all_fresh_hq()
    hq.tab("config").set_by_key(                    # genuinely dead capture (8 h)
        "heartbeat_capture", {"value": "2026-07-13 04:00:00Z"}, key_header="key")
    hq.tab("config").set_by_key(                    # genuinely dead git snapshot
        "heartbeat_snapshot", {"value": "2026-07-09 08:53:00Z"}, key_header="key")
    s = digest.run(hq, now=NOW)

    assert s["capture_silent"] is True
    assert "Gmail capture silent" in [t for t, _b in alerts]
    body = next(b for t, b in alerts if t == "HQ backups stale")
    assert "⚠ snapshot:" in body                    # the SHEET lane's own death
    assert pushes, "the daily phone ping died with the store"
    assert any(r["date"] == TODAY for r in hq.tab("digest").records())
    assert any(r["key"] == "heartbeat_digest" for r in hq.tab("config").records())
