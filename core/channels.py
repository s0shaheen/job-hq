"""Notification policy — the ONE place that decides whether a push may go out.

Three people share one engine and one of them does not want a phone push at
all: Dad's profile says `notify_channel: email`. Before this module that
decision lived at the CALL SITES — `monitor/run.py` and `monitor/priority.py`
each checked `notify_channel == "ntfy"` themselves, `monitor/wide.py` and
`tracker/digest.py` never learned to, and so both pushed unconditionally. That
is the failure a call-site check always eventually has: a future caller forgets
one. The pattern, not the two modules, was the bug.

So the check lives in `core.notify.push()`, which calls `allow()` here before it
resolves a topic. There is exactly ONE enforcement point. Do not add a second
one at a call site — that is how wide.py ended up broken.

The policy, coarse to fine:

  notify_channel    ntfy | email | none — the per-user CEILING, from
                    users/<name>/profile.yaml. `email` means no ntfy push for
                    that user, ever, whatever the matrix underneath says.
  notify_<event>    push | email | both | none, per event type — a Config-tab
                    cell (phone-editable) or a profile.yaml key, defaulting to
                    core/config_defaults.yaml. Refines WITHIN the ceiling.
  quiet_hours       a local wall-clock window (no window by default) in which a
                    non-urgent push is DEFERRED — never dropped. `urgency` and
                    the urgent events (an OA or interview invite) ignore it.
  timezone          which local day and clock the window is read on. Computed
                    with `zoneinfo`; there is no offset arithmetic anywhere here,
                    because "now + 8h30m" is wrong twice a year.

Ops alerts bypass all of it: they page the OPERATOR about a broken system, not
the user about a job — every user's ops topic points at the operator
(docs/MULTIUSER.md). AC24 is about `kind="jobs"`.

**The bypass keys on `kind`, never on the event name.** It has to: `kind` also
picks the TOPIC, so a bypass keyed on `event == "ops"` would let any jobs
caller write `event="ops"` and get a decision of SEND on the JOBS topic —
skipping an email-only user's ceiling and their quiet hours in one move.
Naming the ops event under `kind="jobs"` is therefore a hard error, not a
quieter path.

Nothing here talks to a sheet or a network. `allow()` is a pure function of a
Profile and a clock, which is what makes the quiet-hours arithmetic testable —
and what keeps the *queueing* of a deferred push out of the policy: the caller
owns the outbox row (core/outbox.py), the policy only says "not until 06:30".
"""
from __future__ import annotations

import datetime as _dt
import sys
from dataclasses import dataclass
from zoneinfo import ZoneInfo

# Every event type a push may carry. An unregistered event is a code bug, and
# `allow()` raises on it rather than guessing: guess "send" and somebody gets
# spammed, guess "drop" and a notification vanishes silently.
EVENTS = ("digest", "new_roles", "status_change", "oa_interview", "stale_nudge")

# Not an event a user can tune — ops alerts are the operator's, not theirs.
OPS_EVENT = "ops"

CHANNELS = ("push", "email", "both", "none")

# Events that are worth a buzz at 22:00. An OA or interview invite is the whole
# reason the phone is in the loop at all; holding one until morning (row 36) is
# a worse failure than the 3am push quiet hours exists to stop.
URGENT_EVENTS = frozenset({"oa_interview"})

SEND, DROP, DEFER = "send", "drop", "defer"

# The floor when a profile names no zone: UTC needs no tz database and belongs
# to nobody — a person's real clock comes from their profile/Config tab, never
# from a committed default (RM-40 vault audit §9 Step 4).
DEFAULT_TIMEZONE = "UTC"

# notify_channel (the coarse ceiling) -> the channel it seeds for an event the
# user never itemized.
_SEED = {"ntfy": "push", "email": "email", "none": "none"}

# Spellings that mean "I have no quiet hours".
_QUIET_OFF = ("", "off", "none", "-")


@dataclass(frozen=True)
class Decision:
    """What the policy decided, and why. The reason is carried so a suppressed
    notification prints a line naming the rule that suppressed it — silence
    whose cause you cannot read is indistinguishable from a broken system."""
    verdict: str                          # SEND | DROP | DEFER
    channel: str                          # the resolved channel for this event
    reason: str
    until: _dt.datetime | None = None     # DEFER only: the UTC instant to retry

    @property
    def may_push(self) -> bool:
        return self.verdict == SEND

    @property
    def deferred(self) -> bool:
        return self.verdict == DEFER


def _now() -> _dt.datetime:
    """The wall clock, isolated so tests can pin it. They must: quiet hours are
    real policy, and a suite that read datetime.now() directly would pass by
    day and fail at 22:00 (see tests/conftest.py)."""
    return _dt.datetime.now(_dt.timezone.utc)


def _profile(user: str):
    """Last-resort profile load, for a caller that passed none.

    It reads `users/<name>/profile.yaml` and the committed defaults but NOT the
    user's Config tab — this module never opens a spreadsheet. So every
    `notify_*` knob a human edited in the sheet is invisible on this path. Any
    caller that already holds a `Profile.load(user, cfg=hq.user_config())`
    must pass it through `push(profile=...)`; this is the fallback, not the
    intended route.
    """
    from core.profile import Profile
    return Profile.load(user or "")


def _hhmm(raw: str) -> _dt.time:
    h, m = str(raw).strip().split(":")
    return _dt.time(int(h), int(m))       # raises on 25:00 / 07:61


def quiet_window(spec) -> tuple[_dt.time, _dt.time] | None:
    """`"21:00-06:30"` -> (21:00, 06:30). None when there is no window.

    An unreadable value means NO quiet hours, deliberately: a typo that muted a
    person's notifications all day would be invisible for weeks. The Config
    validator rejects bad values up front; this is the second line, for a
    hand-edited profile.yaml.
    """
    s = str(spec or "").strip().casefold()
    if s in _QUIET_OFF:
        return None
    try:
        a, b = s.split("-", 1)
        start, end = _hhmm(a), _hhmm(b)
    except Exception:
        print(f"[channels] unreadable quiet_hours={spec!r} — treating as no quiet "
              "hours (expected HH:MM-HH:MM, or 'off')", file=sys.stderr)
        return None
    if start == end:
        return None                       # zero-length window = off, not all day
    return start, end


def _zone(name: str) -> _dt.tzinfo:
    """The user's zone, with two fallbacks — because a tz-db fault must not be
    able to fail a BOT.

    The obvious version (`except: return ZoneInfo(DEFAULT_TIMEZONE)`) raises the
    same error it just caught when the fault is the tz database itself rather
    than the name: no `tzdata` wheel in the image, an unreadable
    `/usr/share/zoneinfo`. That turns a notification-layer problem into a failed
    monitor sweep, which is exactly backwards. UTC is the floor: it needs no
    database, and reading quiet hours on the wrong clock is a far smaller
    failure than not running.
    """
    try:
        return ZoneInfo(str(name or DEFAULT_TIMEZONE))
    except Exception:
        print(f"[channels] unknown timezone {name!r} — using {DEFAULT_TIMEZONE}",
              file=sys.stderr)
    try:
        return ZoneInfo(DEFAULT_TIMEZONE)
    except Exception as e:
        print(f"::error title=Timezone database unavailable::{DEFAULT_TIMEZONE} could "
              f"not be loaded either ({e}) — reading quiet hours on UTC. Install the "
              f"tzdata package; until then windows are off by the local offset.",
              file=sys.stderr)
        return _dt.timezone.utc


def wake_time(now: _dt.datetime, zone: _dt.tzinfo,
              window: tuple[_dt.time, _dt.time]) -> _dt.datetime | None:
    """None when `now` is outside the window; otherwise the UTC instant the
    window ends.

    Resolved on the user's LOCAL calendar day. Both halves matter: the *local*
    part, because 03:00 UTC is still yesterday evening in Chicago; and the
    *calendar day* part, because the wake instant is "06:30 wall clock
    tomorrow", which is 7h30m away on most nights and 8h30m the night the
    clocks go back. Advancing a date and re-attaching the zone gets that right;
    adding a timedelta to an instant does not.

    `fold=1` picks the LATER of a repeated wall clock. On the fall-back night an
    end time inside the repeated hour (a `…-01:30` window, say) happens twice;
    the default fold=0 resolves to the first one and wakes the user an hour
    early — inside the quiet hours the window exists to protect. The window is
    only truly over at the second occurrence.
    """
    start, end = window
    local = now.astimezone(zone)
    t = local.time()
    wraps = start > end                                  # the window spans midnight
    inside = (t >= start or t < end) if wraps else (start <= t < end)
    if not inside:
        return None
    day = local.date()
    if wraps and t >= start:
        day = day + _dt.timedelta(days=1)                # tomorrow LOCALLY
    wake = _dt.datetime.combine(day, end).replace(tzinfo=zone, fold=1)
    return wake.astimezone(_dt.timezone.utc)


def channel_for(prof, event: str) -> str:
    """The effective channel for one event: the per-event knob CLAMPED by the
    user's coarse ceiling.

    Clamping rather than merging is the whole point. The committed default for
    `digest` is `both`; if the matrix could raise the ceiling, that default
    alone would land a phone push on somebody who said email-only — which is
    precisely the AC24 regression. So `email` can only ever narrow to `email`
    or `none`, never widen to `push`.
    """
    ceiling = str(getattr(prof, "notify_channel", "ntfy") or "ntfy").strip().casefold()
    raw = str(getattr(prof, f"notify_{event}", "") or "").strip().casefold()
    if raw not in CHANNELS:
        if raw:
            print(f"[channels] ignoring unreadable notify_{event}={raw!r}", file=sys.stderr)
        raw = _SEED.get(ceiling, "none")
    if ceiling == "ntfy":
        return raw
    if ceiling == "email":
        return "none" if raw == "none" else "email"
    if ceiling != "none":
        # an unreadable ceiling resolves to SILENCE, never to yes: a typo in a
        # profile must not be able to start pushing to somebody
        print(f"[channels] unreadable notify_channel={ceiling!r} — treating as none",
              file=sys.stderr)
    return "none"


def allow(user: str = "", *, event: str, kind: str = "jobs",
          urgency: str = "normal", now=None, profile=None) -> Decision:
    """May a phone push for `event` go out to `user` right now?

    `kind` is the TOPIC class the caller is posting to (`jobs` | `ops`) and it,
    not the event name, is what opens the ops bypass — see the module docstring.
    An `ops` event under `kind="jobs"` is a caller bug and raises, because the
    quiet alternative is a jobs push that skipped every check.

    `profile` is injectable so callers that already loaded one (and the tests)
    do not re-read the YAML — which matters beyond speed: a profile loaded here
    has no Config-tab overlay, so a caller holding an overlaid one must pass it
    or the user's own knobs are ignored. `now` is injectable for the same reason.
    """
    if kind == "ops":
        return Decision(SEND, "push", "ops alert — pages the operator, not the user")
    if event == OPS_EVENT:
        raise ValueError(
            f"event={OPS_EVENT!r} is only valid with kind='ops' — the ops bypass "
            "is not borrowable. A jobs caller naming it would skip the user's "
            "channel ceiling and quiet hours and post to their jobs topic.")
    if event not in EVENTS:
        raise ValueError(
            f"unknown notification event {event!r} — register it in "
            f"core.channels.EVENTS (known: {', '.join(EVENTS)})")
    prof = profile if profile is not None else _profile(user)
    channel = channel_for(prof, event)
    who = user or "the default user"
    # the ceiling is checked BEFORE quiet hours on purpose: an email-only user
    # has no push to hold, and deferring here would fill his outbox with rows
    # that can never be delivered
    if channel not in ("push", "both"):
        return Decision(DROP, channel, f"{who} routes {event} to {channel!r}")
    if urgency == "urgent" or event in URGENT_EVENTS:
        return Decision(SEND, channel, f"{event} is urgent — quiet hours do not apply")
    window = quiet_window(getattr(prof, "quiet_hours", ""))
    if window is None:
        return Decision(SEND, channel, f"{who} has no quiet hours")
    wake = wake_time(now or _now(), _zone(getattr(prof, "timezone", "")), window)
    if wake is None:
        return Decision(SEND, channel, f"{who} routes {event} to {channel!r}")
    return Decision(DEFER, channel,
                    f"{who}'s quiet hours — held until {wake:%Y-%m-%d %H:%M}Z",
                    until=wake)
