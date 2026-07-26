"""The quiet-hours outbox (AC25, matrix rows 35 + 36) — the delivery half.

Row 35 is not "quiet hours works", it is **"quiet hours does not silently
drop"**. So the tests here assert the row exists at suppress time, that the
flush delivers it exactly once, and that the one code path with nowhere to
queue is loud rather than quiet.
"""
import datetime as dt

import pytest

from core import channels, notify, outbox
from core.fakes import fake_hq
from tracker import outbox as flush

UTC = dt.timezone.utc


def _local(y, mo, d, h, mi=0, zone="America/Chicago"):
    from zoneinfo import ZoneInfo
    return dt.datetime(y, mo, d, h, mi, tzinfo=ZoneInfo(zone)).astimezone(UTC)


NIGHT = _local(2026, 7, 20, 22, 0)          # inside the default 21:00-06:30
WAKE = _local(2026, 7, 21, 6, 30)
BEFORE_WAKE = _local(2026, 7, 21, 6, 0)
AFTER_WAKE = _local(2026, 7, 21, 7, 31)     # the real tracker-chain slot


@pytest.fixture
def hq(monkeypatch):
    h = fake_hq()
    h.user = "salman"
    return h


@pytest.fixture
def night(monkeypatch):
    """Pin the wall clock inside quiet hours (conftest pins it to midday)."""
    monkeypatch.setattr(channels, "_now", lambda: NIGHT)


def _queue(hq, blocked_ntfy, *, event="new_roles", title="2 new roles",
           body="• PM — Acme"):
    return notify.push(title, body, event=event, user="salman",
                       session=blocked_ntfy, outbox=outbox.sink(hq))


# ------------------------------------------------------- suppressed != dropped

def test_a_deferred_push_writes_an_outbox_row_and_sends_nothing(hq, night, blocked_ntfy):
    """Row 35. The queue row IS the difference between late and lost."""
    assert _queue(hq, blocked_ntfy) is True      # handled, not refused
    assert blocked_ntfy.posts == []
    (row,) = hq.tab("outbox").records()
    assert row["event"] == "new_roles"
    assert row["title"] == "2 new roles"
    assert outbox.parse_ts(row["deliver_after"]) == WAKE
    assert row["delivered_at"] == ""


def test_the_flush_delivers_exactly_once_at_the_wake_time(hq, night, blocked_ntfy):
    """AC25. Nothing before the wake time, exactly one send after it, and the
    third call is a no-op — a flush that re-sends is as bad as one that never
    does."""
    _queue(hq, blocked_ntfy)
    assert flush.run(hq, now=BEFORE_WAKE, session=blocked_ntfy)["sent"] == 0
    assert blocked_ntfy.posts == []

    assert flush.run(hq, now=AFTER_WAKE, session=blocked_ntfy)["sent"] == 1
    assert len(blocked_ntfy.posts) == 1
    (url, kwargs), = blocked_ntfy.posts
    assert kwargs["headers"]["Title"] == "2 new roles"

    assert flush.run(hq, now=AFTER_WAKE, session=blocked_ntfy)["sent"] == 0
    assert len(blocked_ntfy.posts) == 1
    assert hq.tab("outbox").records()[0]["delivered_at"] != ""


def test_a_deferred_push_with_nowhere_to_queue_pages_instead_of_vanishing(
        hq, night, blocked_ntfy):
    """The one path that could reintroduce a silent drop: a caller that forgot
    the sink. It must fail loudly, not quietly."""
    assert notify.push("t", "b", event="new_roles", user="salman") is False
    assert [p for p in blocked_ntfy.posts
            if "outbox" in str(p[1]["headers"]["Title"]).casefold()
            or b"outbox" in p[1]["data"].lower()], "no ops alert for a lost notification"


def test_the_same_notification_in_one_window_queues_once(hq, night, blocked_ntfy):
    _queue(hq, blocked_ntfy)
    _queue(hq, blocked_ntfy)
    assert len(hq.tab("outbox").records()) == 1
    assert flush.run(hq, now=AFTER_WAKE, session=blocked_ntfy)["sent"] == 1


def test_a_different_notification_queues_separately(hq, night, blocked_ntfy):
    _queue(hq, blocked_ntfy, title="2 new roles")
    _queue(hq, blocked_ntfy, title="3 new roles")
    assert len(hq.tab("outbox").records()) == 2


# ------------------------------------------------------------- urgency + churn

def test_an_urgent_event_never_reaches_the_outbox(hq, night, blocked_ntfy):
    """Row 36 through the real push path: an OA invite at 22:00 goes out now."""
    assert _queue(hq, blocked_ntfy, event="oa_interview", title="OA from Acme") is True
    assert len(blocked_ntfy.posts) == 1
    assert hq.tab("outbox").records() == []


def test_a_channel_switched_to_email_after_queueing_is_recorded_not_sent(
        hq, night, blocked_ntfy, monkeypatch):
    """He queued as a push user and became an email user overnight. The flush
    must honour the newer preference and say so on the row, rather than
    delivering a push he no longer wants or leaving the row to retry forever."""
    _queue(hq, blocked_ntfy)
    monkeypatch.setattr(channels, "channel_for", lambda prof, event: "email")
    out = flush.run(hq, now=AFTER_WAKE, session=blocked_ntfy)
    assert out["sent"] == 0 and out["dropped"] == 1
    assert blocked_ntfy.posts == []
    row = hq.tab("outbox").records()[0]
    assert row["delivered_at"] != "" and "email" in row["outcome"]


def test_a_row_still_inside_quiet_hours_is_requeued_not_abandoned(
        hq, night, blocked_ntfy):
    """A row that comes due while the window still covers it (the user widened
    their quiet hours) moves its wake time forward instead of being dropped or
    retried in a tight loop."""
    _queue(hq, blocked_ntfy)
    out = flush.run(hq, now=_local(2026, 7, 21, 3, 0), session=blocked_ntfy,
                    force_due=True)
    assert out["sent"] == 0 and out["requeued"] == 1
    row = hq.tab("outbox").records()[0]
    assert row["delivered_at"] == "" and row["attempts"] == "1"
    assert outbox.parse_ts(row["deliver_after"]) == _local(2026, 7, 21, 6, 30)


def test_the_retry_cap_is_three_and_the_row_closes_exactly_there(hq, night, blocked_ntfy):
    """Retrying forever is how a queue turns into a bill. After the cap the row
    is closed with an honest outcome and an ops page — never marked delivered
    as if it had been.

    The cap is asserted BY VALUE and the boundary walked one flush at a time. A
    `for _ in range(MAX_ATTEMPTS)` loop cannot fail: change the constant and the
    loop changes with it, so it pins the name and not the number."""
    assert flush.MAX_ATTEMPTS == 3
    _queue(hq, blocked_ntfy)
    inside = _local(2026, 7, 21, 3, 0)

    for n in (1, 2):
        out = flush.run(hq, now=inside, session=blocked_ntfy, force_due=True)
        assert (out["requeued"], out["abandoned"]) == (1, 0), f"flush {n} closed early"
        row = hq.tab("outbox").records()[0]
        assert row["attempts"] == str(n) and row["delivered_at"] == ""

    out = flush.run(hq, now=inside, session=blocked_ntfy, force_due=True)
    assert (out["requeued"], out["abandoned"]) == (0, 1)
    row = hq.tab("outbox").records()[0]
    assert row["attempts"] == "3"
    assert "abandoned" in row["outcome"]
    assert row["delivered_at"] != ""            # closed, but the outcome says why


def test_abandoning_pages_ops_with_enough_to_act_on(hq, night, blocked_ntfy):
    """`monitor.run` stamps `pushed_at` on the Feed rows the moment a push is
    QUEUED, and nothing un-stamps them when the queue gives up (the trade is
    written down in core/notify.push). So this alert is the last time those
    roles are ever named — "a row was abandoned" would leave the human with
    nothing to act on."""
    _queue(hq, blocked_ntfy)
    key = hq.tab("outbox").records()[0]["key"]
    for _ in (1, 2, 3):
        flush.run(hq, now=_local(2026, 7, 21, 3, 0), session=blocked_ntfy,
                  force_due=True)
    pages = [p for p in blocked_ntfy.posts
             if p[1]["headers"]["Title"] == "HQ outbox row abandoned"]
    assert pages, "abandoning a notification did not page"
    text = pages[-1][1]["data"].decode()
    assert key in text, "the ops page does not name the outbox row"
    assert "PM — Acme" in text, "the ops page does not name the affected roles"
    assert "marked pushed" in text, "the page does not say the Feed rows will not retry"


# ------------------------------------- the flush and push must agree on inputs

def test_the_flush_judges_a_row_against_the_users_own_config(hq, night, blocked_ntfy):
    """Two policies, one row. The flush loads `Profile.load(user, cfg=…)` — the
    Config-overlaid one — and then `push` re-asks; if push reloads the profile
    itself it gets the un-overlaid version and the two disagree.

    Here the user turned quiet hours OFF in their sheet after the row was
    queued. The overlaid answer is "send now"; the profile.yaml answer is "still
    21:00-06:30, defer". Divergence cost the notification: push deferred with no
    outbox to hold it, paged ops, returned False, and the flush recorded a
    failed send that was never attempted."""
    _queue(hq, blocked_ntfy)
    hq.tab("config").append_records([{"key": "notify_quiet_hours", "value": "off"}])

    out = flush.run(hq, now=_local(2026, 7, 21, 3, 0), session=blocked_ntfy,
                    force_due=True)

    assert out["sent"] == 1, "the Config cell the flush read did not reach push"
    assert hq.tab("outbox").records()[0]["outcome"] == "sent"
    ops = notify._topic("ops")
    assert [p for p in blocked_ntfy.posts if p[0].endswith(ops)] == [], \
        "a notification was paged as lost while being delivered"


def test_a_re_deferral_at_delivery_requeues_instead_of_vanishing(hq, night, blocked_ntfy):
    """The flush hands push its own sink, so if the two ever DO disagree the
    notification survives the disagreement.

    Without the sink, a re-deferral inside push takes the "nowhere to hold it"
    path: ops paged, False returned, and the row closed as "abandoned after 3
    failed sends" — an outcome naming a network fault for a row where no send
    was ever attempted, which sends the operator looking in the wrong place."""
    _queue(hq, blocked_ntfy)
    later = outbox.fmt_ts(_local(2026, 7, 22, 6, 30))

    def redeferring_push(title, body, *, outbox=None, event="", user="", **kw):
        assert outbox is not None, "the flush gave push nowhere to requeue"
        return outbox({"user": user, "event": event, "title": title, "body": body,
                       "urgency": "normal", "channel": "push", "priority": "default",
                       "tags": "", "click": "", "deliver_after": later})

    out = flush.run(hq, now=AFTER_WAKE, session=blocked_ntfy, pusher=redeferring_push)

    assert out == {"due": 1, "sent": 0, "dropped": 0, "requeued": 1,
                   "abandoned": 0, "errors": 0}
    rows = hq.tab("outbox").records()
    assert len(rows) == 2, "the re-deferred notification was not carried forward"
    old = [r for r in rows if r["delivered_at"]][0]
    new = [r for r in rows if not r["delivered_at"]][0]
    assert "deferred again" in old["outcome"]
    assert "failed send" not in old["outcome"], "outcome names a send that never happened"
    assert new["deliver_after"] == later


def test_one_unreadable_row_cannot_kill_the_batch(hq, night, blocked_ntfy):
    """The tab is bot-owned, but its owner is an editor of their own
    spreadsheet. A hand-typed `attempts` cell used to abort the flush for every
    OTHER queued notification too — one fat finger, nobody's phone rings."""
    _queue(hq, blocked_ntfy, title="2 new roles")
    _queue(hq, blocked_ntfy, title="3 new roles")
    tab = hq.tab("outbox")
    bad = tab.records()[0]["key"]
    tab.set_by_key(bad, {"attempts": "twice"})

    out = flush.run(hq, now=AFTER_WAKE, session=blocked_ntfy)

    assert out["errors"] == 1 and out["sent"] == 1
    rows = {r["key"]: r for r in hq.tab("outbox").records()}
    assert rows[bad]["delivered_at"] == "", "a row that failed was closed anyway"
    pages = [p for p in blocked_ntfy.posts
             if p[1]["headers"]["Title"] == "HQ outbox row failed"]
    assert pages and bad in pages[-1][1]["data"].decode()


# --------------------------------------------------------------- dedup identity

def test_a_closed_row_does_not_swallow_the_same_notification_later(
        hq, night, blocked_ntfy):
    """Dedup is against OPEN rows only. Matching a delivered or abandoned row
    returns True — "durably queued" — for a notification nobody wrote down: the
    silent drop this tab exists to prevent, wearing a success return value."""
    _queue(hq, blocked_ntfy)
    assert flush.run(hq, now=AFTER_WAKE, session=blocked_ntfy)["sent"] == 1

    assert _queue(hq, blocked_ntfy) is True          # identical news, raised again
    rows = hq.tab("outbox").records()
    assert len(rows) == 2, "dedup matched a DELIVERED row and swallowed the push"
    assert [r for r in rows if not r["delivered_at"]], "nothing is queued"
    # a keyed tab with two identical keys aborts every later read AND write
    assert len({r["key"] for r in rows}) == 2
    hq.tab("outbox").key_index()                     # must not raise SchemaAnomaly
    assert flush.run(hq, now=AFTER_WAKE, session=blocked_ntfy)["sent"] == 1


def test_the_dedup_key_separates_user_wake_time_and_event():
    """Each dimension pinned: two instances must never collapse into one row,
    the same news held for a different morning is a different notification, and
    the event type is part of what a row IS."""
    base = {"user": "salman", "event": "new_roles", "title": "2 new roles",
            "body": "• PM — Acme", "deliver_after": "2026-07-21 11:30:00Z"}
    key = outbox.record_key(base)
    assert outbox.record_key(dict(base)) == key      # same content, same row
    for field, other in (("user", "dad"),
                         ("event", "digest"),
                         ("deliver_after", "2026-07-22 11:30:00Z"),
                         ("title", "3 new roles"),
                         ("body", "• PM — Globex")):
        assert outbox.record_key({**base, field: other}) != key, \
            f"{field} is not part of the dedup identity"


# ------------------------------------------------ the producers' outbox= wiring
# Four push paths, four sinks. The suite's clock is midday (tests/conftest.py),
# so at that hour nothing defers and a missing `outbox=` is invisible — the push
# just goes out. These drive each producer at the only hour the argument matters.

def _open_rows(hq):
    return [r for r in hq.tab("outbox").records() if not r["delivered_at"].strip()]


def _lost(recorder):
    """What a missing sink actually produces: a page instead of a queue row."""
    return [p for p in recorder.posts if p[1]["headers"]["Title"]
            in ("HQ notification dropped", "HQ outbox write failed")]


def test_the_digest_hands_push_its_outbox(hq, night, blocked_ntfy):
    from tracker import digest
    hq.registry["sheet_id"] = "SHEETID"
    digest.run(hq, now=dt.datetime(2026, 7, 21, 3, 0, tzinfo=UTC))
    assert [r["event"] for r in _open_rows(hq)] == ["digest"]
    assert _lost(blocked_ntfy) == []


def test_the_priority_watch_hands_push_its_outbox(hq, night, blocked_ntfy):
    from monitor.models import Job
    from monitor.priority import run as priority_run

    hq.tab("companies").append_records([{"name": "Plaid", "ats": "greenhouse",
                                         "slug": "plaid", "monitor": "TRUE",
                                         "seeded": "TRUE", "priority": "TRUE"}])
    job = Job("greenhouse", "11", "Plaid", "Senior Product Manager",
              "Chicago, IL", "http://11")
    s = priority_run(hq, fetch=lambda *a, **k: [job], tagger=None,
                     today="2026-07-20", session=blocked_ntfy)
    assert s.pushes == 1, "driver produced nothing pushable — test is vacuous"
    assert [r["event"] for r in _open_rows(hq)] == ["new_roles"]
    assert _lost(blocked_ntfy) == []


def test_the_wide_sweep_hands_push_its_outbox(hq, night, blocked_ntfy, monkeypatch):
    from monitor.wide import run as wide_run
    from tests.monitor.test_wide import FakeApify, cafe_item

    monkeypatch.setenv("APIFY_TOKEN", "token")
    item = cafe_item(title="Senior Product Manager",
                     location="Chicago, Illinois, United States", yoe=2,
                     posted="2026-07-20T04:00:00.000Z")
    s = wide_run(hq, session=blocked_ntfy,
                 client_factory=lambda t: FakeApify(items=[item]),
                 today="2026-07-20", sources=("cafe",))
    assert s.pushed == 1, "driver produced nothing pushable — test is vacuous"
    assert [r["event"] for r in _open_rows(hq)] == ["new_roles"]
    assert _lost(blocked_ntfy) == []


def test_the_daily_sweep_hands_push_its_outbox(hq, night, blocked_ntfy, monkeypatch):
    """`monitor.run` builds its sink in `main()`, so this drives main() rather
    than `run_monitor` — the wiring under test is the one the Lambda executes."""
    import monitor.run as mrun
    from core.sheets import HQ as RealHQ
    from monitor.models import Job
    from monitor.tagging import Tags

    hq.tab("companies").append_records([{"name": "Acme", "ats": "greenhouse",
                                         "slug": "acme", "monitor": "TRUE",
                                         "seeded": "TRUE"}])
    job = Job("greenhouse", "1", "Acme", "Senior Product Manager",
              "Chicago, IL", "http://x")
    monkeypatch.setattr(RealHQ, "open", lambda *a, **k: hq)
    monkeypatch.setattr(mrun.requests, "Session", lambda: blocked_ntfy)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(mrun, "make_tagger",
                        lambda **kw: (lambda rec, slug: Tags(yoe="2+ years")))
    monkeypatch.setattr(mrun.snapshot, "write_snapshot", lambda *a, **k: None)
    real = mrun.run_monitor
    monkeypatch.setattr(mrun, "run_monitor",
                        lambda store, cfg, **kw: real(store, cfg,
                                                      fetch=lambda *a, **k: [job], **kw))

    assert mrun.main() == 0
    assert [r["event"] for r in _open_rows(hq)] == ["new_roles"]
    assert _lost(blocked_ntfy) == []


# ------------------------------------------------------------------- plumbing

def test_the_outbox_is_a_bot_only_tab_in_the_schema():
    from core import schema
    assert schema.TABS["outbox"] == "Outbox"
    assert "outbox" in schema.BOT_ONLY_TABS
    for header in ("key", "event", "deliver_after", "delivered_at", "attempts"):
        assert header in schema.HEADERS["outbox"]


def test_a_missing_tab_warns_instead_of_paging_every_two_hours(capsys, blocked_ntfy):
    """The tab ships in this commit but does not exist in a live sheet until
    self-heal runs. A flush that raised would page ops twelve times a day for a
    condition it cannot fix, and cry-wolf traffic in an alert channel is a
    reliability bug. Nothing can be queued in that window either — `enqueue`
    raises and core.notify pages — so the flush has provably nothing to lose."""
    bare = fake_hq(with_tabs=["config", "log"])
    bare.user = "salman"
    out = flush.run(bare, now=AFTER_WAKE, session=blocked_ntfy)
    assert out == {"due": 0, "sent": 0, "dropped": 0, "requeued": 0,
                   "abandoned": 0, "errors": 0}
    assert "Outbox tab missing" in capsys.readouterr().out
    assert blocked_ntfy.posts == []


def test_queueing_into_a_missing_tab_pages_rather_than_swallowing(hq, night, blocked_ntfy):
    """The other half of the pair above: the ENQUEUE side must be loud, or the
    deploy gap becomes a window where notifications vanish."""
    bare = fake_hq(with_tabs=["config", "log"])
    bare.user = "salman"
    assert notify.push("2 new roles", "b", event="new_roles", user="salman",
                       session=blocked_ntfy, outbox=outbox.sink(bare)) is False
    assert any(p[1]["headers"]["Title"] == "HQ outbox write failed"
               for p in blocked_ntfy.posts)


def test_the_flush_runs_in_the_tracker_chain():
    """The decision to defer is worthless without something that flushes. Pin
    it to the chain EventBridge actually dispatches (infra/app/handler.py)."""
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[2] / "infra" / "app" / "handler.py"
    spec = importlib.util.spec_from_file_location("hq_handler_outbox", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert "tracker.outbox" in [m for m, _ in mod.JOBS["tracker"]]


def test_a_bot_only_tab_stays_out_of_nobodys_way(hq, night, blocked_ntfy):
    """Sheet writes go through core.sheets.Tab like everything else: keyed,
    header-resolved, append-only for new rows."""
    _queue(hq, blocked_ntfy)
    tab = hq.tab("outbox")
    key = tab.records()[0]["key"]
    assert tab.key_index()[key] == 2                    # located at write time
    outbox.mark(hq, key, outcome="hand-checked")
    assert tab.records()[0]["outcome"] == "hand-checked"
