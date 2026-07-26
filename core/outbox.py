"""The quiet-hours outbox: suppressed is not dropped.

A push held at 22:00 has to go SOMEWHERE, or "quiet hours" is just a nicer name
for losing notifications — and a dropped notification is indistinguishable from
a broken system, which is the failure mode that makes people stop trusting the
whole thing (matrix row 35).

So `core.channels.allow()` returns a wake time, `core.notify.push()` writes a
row here instead of sending, and `tracker.outbox` delivers whatever is due on
the 2-hourly tracker chain. This module is only the storage half: keying,
dedupe, and the two timestamps. The policy lives in core/channels.py; the
delivery loop in tracker/outbox.py.

Storage is the Outbox tab of the user's own spreadsheet, through
`core.sheets.Tab` like everything else — keyed rows, headers resolved at write
time, appends only. Per-user isolation is structural: each user's queue is in
their own sheet, so there is no user column to get wrong.
"""
from __future__ import annotations

import datetime as _dt
import hashlib

TAB = "outbox"

#: Same timestamp shape as core.sheets._now() and the Config heartbeats — one
#: format across the sheet means one parser and no ambiguity in a CSV backup.
TS_FMT = "%Y-%m-%d %H:%M:%SZ"


def fmt_ts(when: _dt.datetime) -> str:
    return when.astimezone(_dt.timezone.utc).strftime(TS_FMT)


def parse_ts(raw: str) -> _dt.datetime | None:
    try:
        return _dt.datetime.strptime(str(raw).strip(), TS_FMT).replace(
            tzinfo=_dt.timezone.utc)
    except (ValueError, AttributeError):
        return None


def record_key(rec: dict) -> str:
    """Identity of a queued notification: whose, which event, what it says, and
    when it may go out.

    Content-addressed on purpose. Two sweeps inside one quiet window that found
    the same roles produce the same push, and queueing it twice would buzz the
    phone twice at 06:30 for one piece of news. Different content, or a
    different wake time, is a different row.

    All five dimensions are load-bearing and pinned by tests: `user` (two
    instances must never collapse into one row), `deliver_after` (the same news
    held for a different morning is a different notification), `event`, and the
    rendered `title`/`body`.
    """
    parts = [str(rec.get(k, "")) for k in
             ("user", "event", "title", "body", "deliver_after")]
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


def _free_key(key: str, taken: set[str]) -> str:
    """`key`, or the first `key-N` nobody is using.

    Only reached when a CLOSED row already holds this key. Appending the key
    verbatim would put two rows with one key in a keyed tab, and
    `core.sheets.Tab.key_index` aborts on duplicates — every later read, write
    and flush of the tab, not just this row.
    """
    if key not in taken:
        return key
    n = 2
    while f"{key}-{n}" in taken:
        n += 1
    return f"{key}-{n}"


def enqueue(hq, rec: dict) -> bool:
    """Append a suppressed push. Returns True when the notification is durably
    queued — including when an identical one is already queued and OPEN.

    Dedup is against OPEN rows only. Matching a delivered or abandoned row would
    make this return True — "durably queued" — for a notification that was never
    written down, which is the silent drop the tab exists to prevent, wearing a
    success return value. A closed row is history; the same news raised again is
    news again.

    Raises on a sheet failure rather than swallowing it: the caller
    (core.notify.push) turns that into an ops page, because a queue write that
    fails quietly is the silent drop by another route.
    """
    tab = hq.tab(TAB)
    key = record_key(rec)
    existing = [r for r in tab.records() if r.get("key", "").strip()]
    for r in existing:
        if r["key"].strip() == key and not r.get("delivered_at", "").strip():
            return True                   # already queued, still open
    key = _free_key(key, {r["key"].strip() for r in existing})
    row = {
        "key": key,
        "user": rec.get("user", "") or getattr(hq, "user", ""),
        "event": rec.get("event", ""),
        "urgency": rec.get("urgency", "normal"),
        "channel": rec.get("channel", ""),
        "priority": rec.get("priority", "default"),
        "tags": rec.get("tags", ""),
        "click": rec.get("click", ""),
        "title": rec.get("title", ""),
        "body": rec.get("body", ""),
        "deliver_after": rec.get("deliver_after", ""),
        "created_at": fmt_ts(_dt.datetime.now(_dt.timezone.utc)),
        "delivered_at": "",
        "attempts": "0",
        "outcome": "",
    }
    tab.append_records([row])
    hq.log("outbox", "queued", key=key,
           detail=f"{row['event']} held until {row['deliver_after']}")
    return True


def exists(hq) -> bool:
    """Is the Outbox tab there yet?

    A newly shipped tab does not exist in a live spreadsheet until self-heal
    runs (nightly), and the flush must not page ops every two hours in that gap.
    Only the FLUSH side may use this: with no tab there is provably nothing to
    deliver, because `enqueue` on a missing tab raises and `core.notify._hold`
    turns that into an ops page. `hq.tab()` does not read headers, so a header
    anomaly on an existing tab still surfaces (loudly) on the first read.
    """
    try:
        hq.tab(TAB)
        return True
    except Exception:
        return False


def due(hq, now: _dt.datetime, *, force: bool = False) -> list[dict]:
    """Undelivered rows whose wake time has passed.

    A row with an unreadable `deliver_after` is treated as DUE. Between "send it
    late" and "never send it", late wins — that is the whole premise of the tab.
    """
    out = []
    for rec in hq.tab(TAB).records():
        if not rec.get("key", "").strip() or rec.get("delivered_at", "").strip():
            continue
        when = parse_ts(rec.get("deliver_after", ""))
        if force or when is None or when <= now:
            out.append(rec)
    return out


def mark(hq, key: str, *, delivered_at: str = "", attempts: str | int | None = None,
         outcome: str = "", deliver_after: str = "") -> None:
    """Cell-targeted update on one keyed row (core.sheets contract: located at
    write time, read back and verified)."""
    vals: dict[str, str] = {}
    if delivered_at:
        vals["delivered_at"] = delivered_at
    if attempts is not None:
        vals["attempts"] = str(attempts)
    if outcome:
        vals["outcome"] = outcome
    if deliver_after:
        vals["deliver_after"] = deliver_after
    if vals:
        hq.tab(TAB).set_by_key(key, vals)


def sink(hq):
    """The callable `core.notify.push(outbox=...)` wants. Injected rather than
    resolved inside core.notify, which must never open a spreadsheet of its
    own — the notification layer stays free of the sheet, and the bot that
    already holds an HQ hands its own."""
    def _put(rec: dict) -> bool:
        return enqueue(hq, rec)
    return _put
