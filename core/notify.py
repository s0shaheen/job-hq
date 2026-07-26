"""ntfy pushes for the whole system.

Two topics, resolved from env first (Actions secrets) then hq.config.yaml:
  HQ_NTFY_TOPIC     — Salman's phone: new matching jobs, status events, digest ping
  HQ_OPS_NTFY_TOPIC — ops/failures only

Header values must be latin-1 (http.client); anything else is replaced so a
stray emoji can never crash a send. Emoji belong in the Tags header.

`push()` is the CHOKE POINT for notification policy: it asks
`core.channels.allow()` whether this user wants a phone push of this kind
before it resolves a topic, so no caller can forget to ask and none can opt
out. `_send()` is the only function in the repo that posts to ntfy.sh
(asserted statically by tests/core/test_channels.py) — that single door is what
makes the policy enforceable instead of conventional.
"""
from __future__ import annotations

import os
import sys

import requests

from core import channels

TIMEOUT = 15


def _header_safe(value: str) -> str:
    return (value or "").encode("latin-1", "replace").decode("latin-1")


def _topic(kind: str, user: str | None = None) -> str:
    """Per-user topic from the registry; env override only in single-user mode
    (a matrix leg exporting one HQ_NTFY_TOPIC would page the wrong person)."""
    from core.config import registry, users as _users
    multi = bool(_users())
    if not multi:
        env = "HQ_OPS_NTFY_TOPIC" if kind == "ops" else "HQ_NTFY_TOPIC"
        t = os.environ.get(env, "")
        if t:
            return t
    try:
        return registry(user)["ntfy"]["ops" if kind == "ops" else "jobs"]
    except Exception:
        return ""


def _current_user() -> str:
    """Whose policy applies when a caller did not say. Resolves HQ_USER /
    default_user exactly as `_topic` does, so a forgetful caller inside a
    multi-user process still gets the right person's preferences rather than
    the committed defaults (which would be a push)."""
    try:
        from core.config import current_user
        return current_user()
    except Exception:
        return ""


def _send(topic: str, title: str, body: str, *, tags: list[str] | None = None,
          priority: str = "default", click: str = "", attach: str = "",
          session: requests.Session | None = None) -> bool:
    """The ONLY place in the repo that posts to ntfy.sh. Never raises."""
    headers = {"Title": _header_safe(title), "Priority": priority, "Markdown": "yes"}
    if tags:
        headers["Tags"] = _header_safe(",".join(tags))
    if click:
        headers["Click"] = _header_safe(click)
    if attach:
        headers["Attach"] = _header_safe(attach)
    try:
        s = session or requests
        s.post(f"https://ntfy.sh/{topic}", data=(body or "").encode("utf-8"),
               headers=headers, timeout=TIMEOUT)
        return True
    except Exception:
        return False


def push(title: str, body: str, *, event: str, kind: str = "jobs",
         tags: list[str] | None = None, priority: str = "default",
         click: str = "", attach: str = "", urgency: str = "normal",
         session: requests.Session | None = None, user: str | None = None,
         outbox=None, now=None, profile=None) -> bool:
    """Send a push, subject to this user's notification policy.

    `event` is REQUIRED and names the notification TYPE (core.channels.EVENTS).
    Required rather than defaulted, because a default is exactly what a future
    caller silently inherits — an unregistered event raises here instead of
    routing somewhere nobody chose. `kind` decides both the topic and whether
    the ops bypass applies; `kind="ops"` always goes out, and a jobs caller
    cannot borrow that bypass by naming `event="ops"` — `allow()` raises,
    because the quiet alternative is a jobs push that skipped every check.

    `profile` is the caller's already-loaded `Profile`, and passing it is not an
    optimization. Loaded here it would come from `users/<name>/profile.yaml`
    alone; the seven `notify_*` Config-tab knobs only exist on a profile built
    with `cfg=hq.user_config()`. Every bot that has a spreadsheet open already
    has one — pass it, or the sheet's own settings are inert at push time.

    `now` is the instant the policy is evaluated at; the outbox flush passes the
    one it decided a row was due at, so a row cannot be judged against a
    different clock than the one that selected it.

    `outbox` is the queue a QUIET-HOURS push is held in — `core.outbox.sink(hq)`
    from any bot that has a spreadsheet open. It is injected because this module
    must never open one itself. Without it a deferred push has nowhere to go, so
    that case pages ops rather than disappearing.

    Returns True when the notification was sent OR durably queued (both mean
    the phone will hear about it, which is what a caller marking rows "pushed"
    is really asking). False when policy dropped it, the topic is unset, or the
    send failed — notification failure must never fail a pipeline.

    **Accepted trade — a queued push is marked "pushed" before it is sent.**
    `monitor.run` stamps `pushed_at` on the Feed rows the moment this returns
    True, and True includes "durably queued". If the row is later abandoned
    (`tracker.outbox`, MAX_ATTEMPTS), those Feed rows still read as pushed and
    will never be re-pushed. Deliberate: the alternative is a caller-side undo
    path that has to reach back into three different producers' sheets and
    reverse a write hours later, which is a larger correctness surface than the
    failure it fixes. The abandon path therefore pages ops with the row key and
    the notification's own text, so the human can act on the specific roles.
    """
    who = user if user is not None else _current_user()
    decision = channels.allow(who, event=event, kind=kind, urgency=urgency,
                              now=now, profile=profile)
    if decision.deferred:
        return _hold(decision, outbox, who=who, event=event, title=title, body=body,
                     tags=tags, priority=priority, click=click, urgency=urgency,
                     session=session)
    if not decision.may_push:
        # a suppressed notification says why: silence with no readable cause is
        # indistinguishable from a broken system
        print(f"[notify] {event} not pushed — {decision.reason}", file=sys.stderr)
        return False
    topic = _topic(kind, who)
    if not topic:
        return False
    return _send(topic, title, body, tags=tags, priority=priority, click=click,
                 attach=attach, session=session)


def _hold(decision, outbox, *, who: str, event: str, title: str, body: str,
          tags: list[str] | None, priority: str, click: str, urgency: str,
          session: requests.Session | None = None) -> bool:
    """Queue a quiet-hours push. Suppressed is not dropped (matrix row 35), so
    every failure to queue is LOUD: an ops page, not a log line nobody reads."""
    from core import outbox as _outbox
    print(f"[notify] {event} held — {decision.reason}", file=sys.stderr)
    rec = {"user": who, "event": event, "urgency": urgency,
           "channel": decision.channel, "priority": priority,
           "tags": ",".join(tags or []), "click": click,
           "title": title, "body": body,
           "deliver_after": _outbox.fmt_ts(decision.until)}
    if outbox is None:
        print(f"::error title=Notification dropped::{event} hit quiet hours with no "
              f"outbox to hold it — pass outbox=core.outbox.sink(hq)", file=sys.stderr)
        ops_alert("HQ notification dropped",
                  f"{event} for {who or 'the default user'} hit quiet hours with no "
                  f"outbox sink, so it was neither sent nor queued.\n{title}",
                  session=session)
        return False
    try:
        if outbox(rec):
            return True
        raise RuntimeError("outbox sink refused the row")
    except Exception as e:
        ops_alert("HQ outbox write failed",
                  f"{event} for {who or 'the default user'} could not be queued "
                  f"({str(e)[:200]}) — the notification was NOT delivered.\n{title}",
                  session=session)
        return False


def ops_alert(title: str, body: str, session: requests.Session | None = None,
              user: str | None = None) -> bool:
    """Ops alerts go to the OPERATOR's topic. In a multi-user registry that is
    still each instance's `ntfy.ops` — point every user's ops topic at the
    operator so a dad-instance failure pages the person who can fix it."""
    return push(title, body, event=channels.OPS_EVENT, kind="ops",
                tags=["warning"], priority="high", session=session, user=user)
