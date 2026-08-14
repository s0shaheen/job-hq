"""Quiet hours (AC25, matrix rows 35 + 36) — the policy half.

Two failures are being designed out here, and they are opposites:

  * a 3am push at all (row 35's first half);
  * a quiet-hours rule that silently DROPS the notification instead of holding
    it — "suppressed" and "lost" look identical from the outside, and a
    notification system you cannot trust to be late-but-there is one you stop
    reading. So the decision carries a wake time, and the caller queues.

Everything is computed on the user's LOCAL calendar day with `zoneinfo`. The
DST and midnight-in-UTC cases below are the ones offset arithmetic gets wrong
(the same trap as edge case G14, snooze at 23:50), so they assert exact UTC
instants rather than "roughly the morning".
"""
import datetime as dt

import pytest

from core import channels
from core.profile import Profile

UTC = dt.timezone.utc
CT = "America/Chicago"


def _prof(**kw):
    p = Profile.load("salman")
    # The committed defaults carry NO quiet window and read UTC since RM-40
    # Step 4. These tests exercise the WINDOW MECHANISM, so the fixture states
    # a window the way a real user would — their own hours on their own clock.
    base = {"timezone": CT, "quiet_hours": "21:00-06:30"}
    base.update(kw)
    for k, v in base.items():
        setattr(p, k, v)
    return p


def _at(y, mo, d, h, mi=0):
    """A UTC instant."""
    return dt.datetime(y, mo, d, h, mi, tzinfo=UTC)


def _local(y, mo, d, h, mi=0, zone=CT):
    """A LOCAL wall-clock instant, as UTC — how the assertions are written."""
    from zoneinfo import ZoneInfo
    return dt.datetime(y, mo, d, h, mi, tzinfo=ZoneInfo(zone)).astimezone(UTC)


# ------------------------------------------------------------ defer, not drop

def test_non_urgent_push_inside_quiet_hours_defers_to_the_window_end():
    d = channels.allow("salman", event="new_roles", profile=_prof(),
                       now=_local(2026, 7, 20, 22, 0))
    assert d.verdict == channels.DEFER
    assert d.until == _local(2026, 7, 21, 6, 30)     # tomorrow morning, local
    assert not d.may_push


def test_early_morning_inside_the_window_wakes_the_same_local_day():
    d = channels.allow("salman", event="digest", profile=_prof(),
                       now=_local(2026, 7, 20, 2, 0))
    assert d.verdict == channels.DEFER
    assert d.until == _local(2026, 7, 20, 6, 30)


def test_outside_the_window_sends_immediately():
    d = channels.allow("salman", event="new_roles", profile=_prof(),
                       now=_local(2026, 7, 20, 12, 0))
    assert d.verdict == channels.SEND and d.until is None


def test_the_committed_default_is_no_quiet_window():
    """RM-40 vault audit §9 Step 4: a committed sleep window is one person's
    clock imposed on everyone else's, so the default is OFF — a user who never
    stated a window is never deferred."""
    from core.config import defaults
    assert defaults()["notify_quiet_hours"] == "off"
    d = channels.allow("salman", event="new_roles",
                       profile=_prof(quiet_hours="off"),
                       now=_local(2026, 7, 20, 22, 0))
    assert d.verdict == channels.SEND


def test_the_digest_ping_clears_a_0630_window():
    """The digest job composes at 06:40 CT. A user window ending at 07:00 would
    hold the daily briefing until the next 2-hourly flush (07:31 CT) — which is
    why the runbook's suggested window ends 06:30. Change one, check the other."""
    d = channels.allow("salman", event="digest", profile=_prof(),
                       now=_local(2026, 7, 20, 6, 40))
    assert d.verdict == channels.SEND


# ---------------------------------------------------------- urgency overrides

def test_an_oa_or_interview_invite_ignores_quiet_hours():
    """AC25's second half / row 36. An interview invite at 22:00 is exactly the
    notification worth a buzz."""
    d = channels.allow("salman", event="oa_interview", profile=_prof(),
                       now=_local(2026, 7, 20, 22, 0))
    assert d.verdict == channels.SEND


def test_an_explicit_urgent_flag_also_overrides():
    d = channels.allow("salman", event="new_roles", urgency="urgent",
                       profile=_prof(), now=_local(2026, 7, 20, 22, 0))
    assert d.verdict == channels.SEND


def test_a_channel_drop_beats_a_defer():
    """An email-only user has nothing to queue: there is no push to hold. The
    order matters — deferring here would fill his outbox with rows that can
    never be delivered."""
    d = channels.allow("dad", event="new_roles", now=_local(2026, 7, 20, 22, 0))
    assert d.verdict == channels.DROP


def test_ops_alerts_ignore_quiet_hours():
    d = channels.allow("salman", event=channels.OPS_EVENT, kind="ops",
                       now=_local(2026, 7, 20, 3, 0))
    assert d.verdict == channels.SEND


# -------------------------------------------------- local calendar arithmetic

def test_the_wake_time_crosses_a_dst_boundary_on_the_local_day():
    """2026-11-01 is the US fall-back. 23:00 on Oct 31 is CDT (UTC-5); the
    06:30 wake next morning is CST (UTC-6), so the correct instant is 12:30
    UTC. Adding "7h30m" to the current offset gives 11:30 — an hour early,
    inside the quiet window it was supposed to respect."""
    d = channels.allow("salman", event="new_roles", profile=_prof(),
                       now=_local(2026, 10, 31, 23, 0))
    assert d.until == _at(2026, 11, 1, 12, 30)
    assert d.until != _at(2026, 11, 1, 11, 30)


def test_a_window_ending_inside_the_repeated_hour_waits_for_the_second_one():
    """The DST *fold*, which the boundary test above steps over. On 2026-11-01
    Chicago replays 01:00-01:59: first as CDT (UTC-5), then as CST (UTC-6). A
    window ending at 01:30 therefore ends twice, and `fold=0` — the default —
    picks the first, waking the phone at 01:30 CDT while it is still 00:30 CST
    and the window has an hour left to run. Only the later occurrence is the
    real end of the window."""
    p = _prof(quiet_hours="21:00-01:30")
    d = channels.allow("salman", event="new_roles", profile=p,
                       now=_local(2026, 10, 31, 23, 0))
    assert d.verdict == channels.DEFER
    assert d.until == _at(2026, 11, 1, 7, 30)        # 01:30 CST, the second one
    assert d.until != _at(2026, 11, 1, 6, 30)        # 01:30 CDT, an hour early


def test_the_wake_time_crosses_a_spring_forward_boundary():
    """2026-03-08, the other direction: 22:00 CST (UTC-6) -> 06:30 CDT (UTC-5)
    = 11:30 UTC, and the naive answer would be 12:30."""
    d = channels.allow("salman", event="new_roles", profile=_prof(),
                       now=_local(2026, 3, 7, 22, 0))
    assert d.until == _at(2026, 3, 8, 11, 30)


def test_a_utc_day_boundary_does_not_move_the_users_day():
    """03:00 UTC on the 26th is 22:00 on the 25th in Chicago. Computing the
    window on the UTC calendar day would call it 'the 26th, already past
    21:00' and wake it a day late."""
    now = _at(2026, 7, 26, 3, 0)
    d = channels.allow("salman", event="new_roles", profile=_prof(), now=now)
    assert d.verdict == channels.DEFER
    assert d.until == _local(2026, 7, 26, 6, 30)


def test_the_users_own_timezone_is_used():
    east = _prof(timezone="America/New_York")
    now = _local(2026, 7, 20, 20, 30, zone="America/New_York")   # 21:30 nowhere else
    assert channels.allow("x", event="new_roles", profile=east, now=now).verdict \
        == channels.SEND
    assert channels.allow("x", event="new_roles", profile=_prof(timezone="America/New_York"),
                          now=_local(2026, 7, 20, 21, 30, zone="America/New_York")
                          ).verdict == channels.DEFER


# ------------------------------------------------------------- window parsing

def test_a_non_wrapping_window_works_too():
    p = _prof(quiet_hours="13:00-14:00")
    assert channels.allow("x", event="new_roles", profile=p,
                          now=_local(2026, 7, 20, 13, 30)).until == \
        _local(2026, 7, 20, 14, 0)
    assert channels.allow("x", event="new_roles", profile=p,
                          now=_local(2026, 7, 20, 15, 0)).verdict == channels.SEND


@pytest.mark.parametrize("spec", ["", "off", "none", "07:00-07:00"])
def test_quiet_hours_can_be_turned_off(spec):
    d = channels.allow("x", event="new_roles", profile=_prof(quiet_hours=spec),
                       now=_local(2026, 7, 20, 3, 0))
    assert d.verdict == channels.SEND, f"{spec!r} should mean no quiet hours"


@pytest.mark.parametrize("spec", ["banana", "21:00", "25:00-07:00", "21:00-07:61"])
def test_an_unreadable_window_is_ignored_rather_than_silencing_everything(spec, capsys):
    """A typo must not become an all-day mute. The Config validator rejects
    these up front; this is the second line, for a hand-edited profile.yaml."""
    d = channels.allow("x", event="new_roles", profile=_prof(quiet_hours=spec),
                       now=_local(2026, 7, 20, 3, 0))
    assert d.verdict == channels.SEND
    assert "quiet" in capsys.readouterr().err.casefold()


def test_an_unknown_timezone_falls_back_loudly(capsys):
    d = channels.allow("x", event="new_roles", profile=_prof(timezone="Mars/Olympus"),
                       now=_at(2026, 7, 20, 22, 0))
    assert d.verdict == channels.DEFER                       # still quiet-hours aware
    assert d.until == _at(2026, 7, 21, 6, 30)                # read on UTC, the neutral floor
    assert "Mars/Olympus" in capsys.readouterr().err


def test_a_broken_timezone_database_cannot_fail_the_bot(monkeypatch, capsys):
    """The fallback needs a fallback. `except: ZoneInfo(DEFAULT_TIMEZONE)` raises
    the very error it just caught when the fault is the tz DATABASE rather than
    the name — no `tzdata` in the image, an unreadable /usr/share/zoneinfo — and
    that exception escapes `allow()` into whichever bot was pushing. A monitor
    sweep must not die because the notification layer cannot read a clock."""
    def _no_tzdb(name):
        raise KeyError(f"No time zone found with key {name}")
    monkeypatch.setattr(channels, "ZoneInfo", _no_tzdb)

    d = channels.allow("salman", event="new_roles", profile=_prof(),
                       now=_at(2026, 7, 20, 22, 0))          # 22:00 UTC
    assert d.verdict == channels.DEFER                       # read on UTC
    assert d.until == _at(2026, 7, 21, 6, 30)
    err = capsys.readouterr().err
    assert "UTC" in err and "tzdata" in err


# -------------------------------------------------------------- knob plumbing

def test_the_two_new_knobs_are_config_editable_and_validated():
    from core.config import VALIDATORS, defaults
    assert VALIDATORS["notify_quiet_hours"]("21:00-06:30") == "21:00-06:30"
    assert VALIDATORS["notify_quiet_hours"]("off") == "off"
    with pytest.raises(ValueError):
        VALIDATORS["notify_quiet_hours"]("bedtime")
    assert VALIDATORS["notify_timezone"]("America/New_York") == "America/New_York"
    with pytest.raises(ValueError):
        VALIDATORS["notify_timezone"]("Mars/Olympus")
    assert defaults()["notify_timezone"] == "UTC"    # nobody's clock by default
    for key, attr in (("notify_timezone", "timezone"),
                      ("notify_quiet_hours", "quiet_hours")):
        assert (key, attr) in Profile.OVERLAY


# ------------------------------------------------ the knobs, through a real job
# Golden rule 3 says behavior changes in the Config tab. That is only true if the
# PUSH PATH reads it, and a `Profile.load(cfg=…)` assertion cannot show that:
# `core.channels` loads its own profile when a caller passes none, and that load
# has no spreadsheet in it — so all seven notify_* cells can be inert at push time
# while every plumbing test stays green. These drive `tracker.digest`, a real
# scheduled push path, and assert on what reached the wire.

def _digest_with_config(cells: list[dict] | None, recorder):
    """Run the digest for a push user whose Config tab holds `cells`. Returns
    (posts to the JOBS topic, outbox rows)."""
    from core import notify
    from core.fakes import fake_hq
    from tracker import digest

    hq = fake_hq()
    hq.user = "salman"
    if cells:
        hq.tab("config").append_records(cells)
    digest.run(hq, now=dt.datetime(2026, 7, 20, 15, 0, tzinfo=UTC))
    ops = notify._topic("ops")     # the digest legitimately ops-alerts on a bare fixture
    posts = [p for p in recorder.posts if not p[0].endswith(ops)]
    return posts, hq.tab("outbox").records()


def test_the_digest_pings_a_push_user_with_an_untouched_config(blocked_ntfy):
    """The canary. Every assertion below is vacuous if the digest stopped
    pushing for its own reasons."""
    posts, rows = _digest_with_config(None, blocked_ntfy)
    assert len(posts) == 1 and rows == []


def test_a_config_quiet_hours_cell_defers_a_real_push(blocked_ntfy):
    """The suite's clock is pinned to 12:00 CT (tests/conftest.py). A window the
    human typed into their own spreadsheet has to cover it — through
    `hq.user_config()` -> `Profile.load(cfg=…)` -> `push(profile=…)` -> the
    policy — or the cell is decoration."""
    from core.outbox import parse_ts
    posts, rows = _digest_with_config([{"key": "notify_quiet_hours",
                                        "value": "11:00-13:00"},
                                       {"key": "notify_timezone",
                                        "value": "America/Chicago"}], blocked_ntfy)
    assert posts == [], "the Config-tab quiet window did not reach the push path"
    assert len(rows) == 1 and rows[0]["event"] == "digest"
    assert parse_ts(rows[0]["deliver_after"]) == _local(2026, 7, 20, 13, 0)


def test_a_config_matrix_cell_drops_a_real_push(blocked_ntfy):
    """Same route, the other knob family: `notify_digest = none` in the sheet
    must silence the daily ping without touching a line of code."""
    posts, rows = _digest_with_config([{"key": "notify_digest", "value": "none"}],
                                      blocked_ntfy)
    assert posts == [] and rows == [], "notify_digest=none did not reach the push path"
