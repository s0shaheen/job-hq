"""Deliver whatever quiet hours held back.

    python -m tracker.outbox

Last step of the 2-hourly tracker chain, which is what makes deferral honest: a
push suppressed at 22:00 sits in the Outbox tab with the wake time the policy
computed, and the next chain run past that time sends it. Nothing here decides
policy — it re-asks `core.channels.allow()` and does what it says, so a
preference the user changed overnight is honoured rather than overridden by a
decision made hours ago.

Three outcomes other than a send, all recorded on the row rather than implied:

  dropped    the user's channel changed (they moved to email, or turned the
             event off). Their newer answer wins; the row closes with a reason.
  requeued   still inside a quiet window — the wake time moves forward. This is
             what stops the "widened my quiet hours" case from becoming either a
             tight retry loop or a lost notification.
  abandoned  MAX_ATTEMPTS reached. Closed with an honest outcome AND an ops page,
             never stamped "delivered" as though it had gone out.

Two rules make those outcomes trustworthy rather than decorative:

  * `push()` is handed the SAME overlaid profile and the SAME sink this loop
    used. It re-decides — that is the point — but it must re-decide against the
    same inputs, or the two policies disagree and the row records the
    disagreement as a send failure that never happened.
  * every outcome string names what actually occurred. "abandoned after 3
    failed sends" on a row where no send was attempted is worse than no outcome
    at all: it sends the operator looking for a network fault.
"""
from __future__ import annotations

import datetime as _dt
import sys

from core import channels, notify, outbox
from core.profile import Profile
from core.sheets import HQ

#: Requeue budget before a row is closed as undeliverable. Small on purpose: a
#: notification that has missed three flush windows is stale news, and a queue
#: that retries forever is a bill.
MAX_ATTEMPTS = 3


def _abandoned_page(row: dict, user: str, why: str, session=None) -> None:
    """Page ops for a notification that will never be delivered.

    It names the outbox row key and repeats the notification's own text on
    purpose. `monitor.run` stamps `pushed_at` on the Feed rows the moment a push
    is durably QUEUED (core/notify.py documents that trade), and nothing
    un-stamps them when the queue gives up — so this alert is the only place the
    affected roles are ever named again. An alert that just said "a row was
    abandoned" would leave the human with nothing to act on.
    """
    body = str(row.get("body", ""))
    notify.ops_alert(
        "HQ outbox row abandoned",
        f"{row.get('event', '')} for {user or 'the default user'} was never "
        f"delivered — {why}.\n"
        f"Outbox row key: {row.get('key', '')} (held until "
        f"{row.get('deliver_after', '?')})\n"
        f"{row.get('title', '')}\n{body[:600]}\n"
        "Feed rows for these were already marked pushed and will not be "
        "re-pushed; act on them from this message or the Outbox tab.",
        session=session)


def run(hq: HQ, *, now: _dt.datetime | None = None, pusher=None,
        session=None, force_due: bool = False) -> dict:
    now = now or _dt.datetime.now(_dt.timezone.utc)
    pusher = pusher or notify.push
    user = getattr(hq, "user", "")
    cfg = hq.user_config()          # one read: Config-tab edits win, as everywhere
    prof = Profile.load(user, cfg=cfg)

    out = {"due": 0, "sent": 0, "dropped": 0, "requeued": 0, "abandoned": 0,
           "errors": 0}
    if not outbox.exists(hq):
        # the tab ships before self-heal has created it in a live sheet; nothing
        # can be queued yet either (enqueue pages ops if it fails), so this is a
        # warning and not the 2-hourly cry-wolf an ops push would be
        print("::warning title=Outbox tab missing::run tracker.selfheal to create "
              "the Outbox tab; nothing to flush until then")
        return out
    for row in outbox.due(hq, now, force=force_due):
        out["due"] += 1
        # One bad row must not kill the batch. The tab is bot-owned, but the
        # owner is an editor of their own spreadsheet and a hand-typed
        # `attempts` cell (or a half-finished paste) would otherwise abort the
        # flush for every OTHER queued notification too. Loud per row, and the
        # run continues.
        try:
            _flush_row(hq, row, out, user=user, prof=prof, now=now,
                       pusher=pusher, session=session)
        except Exception as e:
            out["errors"] += 1
            print(f"::error title=Outbox row failed::{row.get('key', '?')}: "
                  f"{e}", file=sys.stderr)
            notify.ops_alert(
                "HQ outbox row failed",
                f"outbox row {row.get('key', '?')} could not be processed "
                f"({str(e)[:200]}); the rest of the batch continued. The row is "
                "untouched and will be retried next flush.", session=session)
    return out


def _flush_row(hq: HQ, row: dict, out: dict, *, user: str, prof, now, pusher,
               session) -> None:
    key = row["key"]
    event = row.get("event", "")
    attempts = int(row.get("attempts") or 0)
    try:
        decision = channels.allow(user, event=event,
                                  urgency=row.get("urgency", "normal"),
                                  now=now, profile=prof)
    except ValueError as e:     # an event that no longer exists in the code
        outbox.mark(hq, key, delivered_at=outbox.fmt_ts(now),
                    outcome=f"abandoned: {e}")
        out["abandoned"] += 1
        notify.ops_alert("HQ outbox row undeliverable",
                         f"outbox row {key} names an unknown event {event!r}; "
                         "closed without sending.", session=session)
        return

    if decision.verdict == channels.DROP:
        outbox.mark(hq, key, delivered_at=outbox.fmt_ts(now),
                    outcome=f"dropped: {decision.reason}")
        hq.log("outbox", "dropped", key=key, detail=decision.reason)
        out["dropped"] += 1
        return

    if decision.deferred:
        attempts += 1
        if attempts >= MAX_ATTEMPTS:
            outbox.mark(hq, key, delivered_at=outbox.fmt_ts(now),
                        attempts=attempts,
                        outcome=f"abandoned after {attempts} attempts: "
                                f"{decision.reason}")
            out["abandoned"] += 1
            _abandoned_page(row, user, f"it stayed inside quiet hours for "
                                       f"{attempts} flushes", session=session)
        else:
            outbox.mark(hq, key, attempts=attempts,
                        deliver_after=outbox.fmt_ts(decision.until))
            out["requeued"] += 1
        return

    # `push` re-asks the policy. Hand it the same profile and the same clock this
    # loop decided on, so the two answers can only differ if something really
    # changed — and the same queue, so a difference REQUEUES instead of falling
    # through to the "nowhere to hold it" ops page and a lost notification.
    redeferred: list[dict] = []

    def _requeue(rec: dict) -> bool:
        redeferred.append(rec)
        return outbox.enqueue(hq, rec)

    tags = [t for t in str(row.get("tags", "")).split(",") if t]
    sent = pusher(row.get("title", ""), row.get("body", ""), event=event,
                  kind="jobs", tags=tags,
                  priority=row.get("priority") or "default",
                  click=row.get("click", ""), urgency=row.get("urgency", "normal"),
                  session=session, user=user, now=now, profile=prof,
                  outbox=_requeue)

    if redeferred:
        # no send was attempted: a fresh row with its own wake time now carries
        # the notification, so this one closes saying exactly that
        held = redeferred[0].get("deliver_after", "?")
        if sent:
            outbox.mark(hq, key, delivered_at=outbox.fmt_ts(now),
                        attempts=attempts + 1,
                        outcome=f"requeued: deferred again at delivery, "
                                f"now held until {held}")
            hq.log("outbox", "requeued", key=key, detail=f"deferred again → {held}")
            out["requeued"] += 1
        else:
            outbox.mark(hq, key, delivered_at=outbox.fmt_ts(now),
                        attempts=attempts + 1,
                        outcome="abandoned: deferred again at delivery and the "
                                "requeue write failed")
            out["abandoned"] += 1
            _abandoned_page(row, user, "it deferred again at delivery and could "
                                       "not be requeued", session=session)
        return

    if sent:
        outbox.mark(hq, key, delivered_at=outbox.fmt_ts(now), attempts=attempts + 1,
                    outcome="sent")
        hq.log("outbox", "delivered", key=key, detail=event)
        out["sent"] += 1
        return

    # the wire failed, the topic is unset, or the policy dropped it inside push
    attempts += 1
    if attempts >= MAX_ATTEMPTS:
        outbox.mark(hq, key, delivered_at=outbox.fmt_ts(now), attempts=attempts,
                    outcome=f"abandoned after {attempts} failed sends")
        out["abandoned"] += 1
        _abandoned_page(row, user, f"the send failed {attempts} times",
                        session=session)
    else:
        outbox.mark(hq, key, attempts=attempts)
        out["requeued"] += 1


def main() -> int:
    try:
        hq = HQ.open()
        s = run(hq)
        print(f"[outbox] due={s['due']} sent={s['sent']} dropped={s['dropped']} "
              f"requeued={s['requeued']} abandoned={s['abandoned']} "
              f"errors={s['errors']}", file=sys.stderr)
        return 0
    except Exception as e:
        import traceback
        print(f"[outbox] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("tracker/outbox failed", str(e)[:300])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
