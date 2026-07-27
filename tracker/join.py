"""Join classified email events to Pipeline rows — last step of the 2-hourly run.

Matching ladder (research gmail-tracking.md §6): ATS-strong URL key first;
strong-but-unknown "received" events CREATE the row (the application predates
the sheet); weak/no key falls back to normalized company + fuzzy title, and
anything ambiguous parks as NEEDS_REVIEW — the joiner never guesses. Status
moves obey schema.EVENT_STATUS_RULES: a hard rule at/above the confidence gate
advances status forward-only (humans win via advance_status); everything else
lands in suggested_status, which is bot-owned and safe to overwrite.

Runs LAST in the tracker workflow (promote -> quickadd -> scout -> stale ->
join), so its heartbeat("tracker") vouches for the whole chain.

SHEET-SUNSET Phase C1: under `HQ_PG_WRITES=first_class` every match is ALSO
applied to `applications` in Postgres, through 0015's `hq_apply_email_event` —
one locked step that owns the same two rules this module obeys in the sheet
(forward-only, humans win). The sheet writes are unchanged; the store is a
second lane, not a replacement, until Phase D.
"""
from __future__ import annotations

import datetime as _dt
import difflib
import re
import sys

from core import jobkeys, pgwrites, schema
from core.sheets import HQ, RowNotFound, today

NEEDS_REVIEW = "NEEDS_REVIEW"
TITLE_RATIO = 0.6

#: 0015. Named here rather than inlined so `tests/core/test_migrations.py` can
#: prove the function exists with these parameters — a typo in an RPC name is a
#: 404 at 02:31 and nothing else (the same guard `monitor.discover_universe`
#: earned the hard way).
PG_APPLY_FN = "hq_apply_email_event"


def _norm_company(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", " ", (s or "").casefold())
    return re.sub(r"\s+", " ", s).strip()


def _confidence(raw: str) -> float:
    """Unparseable confidence must never clear the hard-write gate."""
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        return 0.0


def _date_part(received_at: str) -> str:
    s = (received_at or "").strip()[:10]
    try:
        return _dt.date.fromisoformat(s).isoformat()
    except ValueError:
        return today()


def _fuzzy_candidates(pipeline_rows: list[dict], ev: dict) -> list[str]:
    """Normalized-company equality, then title similarity, non-terminal rows
    only. An event without company or title can never match — by design."""
    co = _norm_company(ev.get("company", ""))
    ti = (ev.get("title") or "").casefold().strip()
    if not co:
        return []
    out = []
    for r in pipeline_rows:
        if (r.get("status") or "").strip() in schema.STATUS_TERMINAL:
            continue
        if not r.get("key") or _norm_company(r.get("company", "")) != co:
            continue
        rt = (r.get("title") or "").casefold().strip()
        if difflib.SequenceMatcher(None, ti, rt).ratio() >= TITLE_RATIO:
            out.append(r["key"])
    return out


def _apply_rules(hq: HQ, pipeline, key: str, ev: dict) -> str:
    """Move the matched row per EVENT_STATUS_RULES; return the applied_status
    audit string. last_activity is ALWAYS bumped — any email about a job is
    activity, even when the status itself doesn't move."""
    etype = (ev.get("event_type") or "").strip()
    status, hard = schema.EVENT_STATUS_RULES.get(etype, (None, False))
    evid = ev.get("thread_link", "")
    # A bot may only ever write a status EVENT_STATUS_RULES names, and that
    # table structurally cannot name a STATUS_RESOLVED value — "Offer-Accepted"
    # is a decision only a person can have made. Asserted rather than trusted
    # because the table is edited by hand: adding an `offer_accepted` event type
    # with a hard rule would otherwise let the classifier end someone's search
    # for them, silently, from an email it read at 0.9 confidence.
    if status is not None and status in schema.STATUS_RESOLVED:
        raise AssertionError(
            f"EVENT_STATUS_RULES[{etype!r}] names {status!r}, which is human-only "
            f"(schema.STATUS_RESOLVED) — no bot may write it")
    if status is None:
        pipeline.set_by_key(key, {"last_activity": today()})
        hq.log("join", "matched", key, etype)
        return "matched"
    if hard and _confidence(ev.get("confidence")) >= schema.HARD_WRITE_MIN_CONFIDENCE:
        res = pipeline.advance_status(key, status, evidence=evid)
        if res == "locked":
            # A human owns this row's status (status_actor = user). The bot's
            # opinion is still worth having — acceptance criterion 14 is "the
            # human keeps their Offer AND sees the rejection" — so it lands in
            # suggested_status, which is bot-owned and safe to overwrite.
            #
            # `evidence` only when there IS one. Writing it unconditionally
            # blanked an existing link whenever the incoming event had no
            # thread_link, which is the one field on the row a person actually
            # needs to act — and `advance_status` has always guarded it the same
            # way (`if evidence and "evidence" in hmap`). A suggestion with no
            # reachable email is weak; a suggestion that DESTROYED the reachable
            # email is worse than the status it was reporting.
            vals = {"suggested_status": status, "last_activity": today()}
            if evid:
                vals["evidence"] = evid
            pipeline.set_by_key(key, vals)
        elif res == "kept":   # advance_status only stamps activity when it moves
            # Deliberately NOT a suggestion. This branch is a stale or
            # out-of-order email — "suggests Applied" on an Interview row is
            # noise that trains people to ignore the column.
            pipeline.set_by_key(key, {"last_activity": today()})
        hq.log("join", f"{res}_status", key, f"{etype} -> {status}")
        return f"{res}:{status}"
    # Same rule on the below-the-gate path, for the same reason: a suggestion is
    # not worth the evidence link it overwrites.
    vals = {"suggested_status": status, "last_activity": today()}
    if evid:
        vals["evidence"] = evid
    pipeline.set_by_key(key, vals)
    hq.log("join", "suggested_status", key, f"{etype} -> {status}")
    return f"suggested:{status}"


def _birth_fields(ev: dict) -> dict:
    """The columns a Gmail-born application is created with — in BOTH stores.

    Extracted so `_create_row` (the sheet) and `_pg_apply`'s create payload (the
    store) cannot describe the same application differently. Two hand-kept copies
    of this dict is how the two lanes end up disagreeing about who applied and
    when, which is the divergence dual-write exists to make impossible."""
    return {
        "company": ev.get("company", ""),
        "title": ev.get("title", ""),
        "url": ev.get("job_url", ""),
        "source": "gmail",
        "applied_date": _date_part(ev.get("received_at", "")),
        "applied_via": "scout" if (ev.get("account") or "").strip() == "alt" else "self",
        "applied_email": ev.get("account", ""),
    }


def _birth_from(sheet_row: dict | None, ev: dict) -> dict:
    """The store's copy of an application's birth certificate.

    The SHEET's row wins every field it has a value for, and the event fills the
    blanks. It is the same "bots fill blanks; humans win" rule the sheet lane obeys,
    pointed at the other store — and it matters most for `applied_date`, which on
    the event is the date THIS email arrived. Born from a rejection notice, an
    event-only row would claim the application was submitted the day it was
    rejected.
    """
    out = _birth_fields(ev)
    for col in ("company", "title", "url", "source",
                "applied_date", "applied_via", "applied_email"):
        v = str((sheet_row or {}).get(col) or "").strip()
        if v:
            out[col] = v
    return out


def _create_row(hq: HQ, pipeline, key: str, ev: dict) -> None:
    """A confirmed application we never tracked: strong key + 'received'.
    Below the confidence gate the status stays a suggestion even at birth."""
    status, _hard = schema.EVENT_STATUS_RULES["received"]
    rec = {
        "key": key,
        **_birth_fields(ev),
        "evidence": ev.get("thread_link", ""),
        "last_activity": today(),
    }
    if _confidence(ev.get("confidence")) >= schema.HARD_WRITE_MIN_CONFIDENCE:
        rec["status"] = status
    else:
        rec["status"] = "Inbox"
        rec["suggested_status"] = status
    pipeline.append_records([rec])
    hq.log("join", "created_from_email", key, ev.get("company", ""))


def _match_event(hq: HQ, pipeline, ev: dict) -> tuple[str, str]:
    """Run the ladder; return (matched_key, applied_status) for the event row."""
    key = jobkeys.job_key(ev.get("job_url", ""))
    if key and jobkeys.is_strong(key):
        index = pipeline.key_index()
        if key in index:
            return key, _apply_rules(hq, pipeline, key, ev)
        if (ev.get("event_type") or "").strip() == "received":
            _create_row(hq, pipeline, key, ev)
            return key, "created"
        # a status email for a job we never tracked — a human must decide
        return NEEDS_REVIEW, NEEDS_REVIEW
    cands = sorted(set(_fuzzy_candidates(pipeline.records(), ev)))
    if len(cands) == 1:
        return cands[0], _apply_rules(hq, pipeline, cands[0], ev)
    return NEEDS_REVIEW, NEEDS_REVIEW


#: Outcomes that mean "the store had nothing to apply this to". Not failures — a
#: posting the sweep has not mirrored, or an application pg does not have yet — but
#: not successes either, and the difference is the only signal that the two stores
#: are drifting. Drained by `tracker.pgseed`; recorded on the pg side as an
#: `email.unapplied` event (0015) because the sheet retires the event either way.
PG_NOTHING_TO_APPLY = ("no_posting", "no_application")

#: Outcomes that mean the store applied the event.
PG_APPLIED = ("advanced", "kept", "locked", "suggested", "matched")

#: Every outcome 0015 can return. Pinned against the SQL by
#: `tests/core/test_migrations.py`, and an outcome outside it RAISES rather than
#: being counted: a future migration adding one would otherwise have it silently
#: tallied as an applied event, which is the one number telling the operator
#: whether the lanes agree.
PG_OUTCOMES = PG_NOTHING_TO_APPLY + PG_APPLIED


def _pg_apply(ev: dict, matched_key: str, sheet_row: dict, *, session=None) -> dict:
    """Apply one matched event to `applications` through 0015's locked step.

    The engine classifies (which status, and does the confidence clear the gate —
    `core/schema.py` owns both, and the sheet lane above reads the same table);
    the SQL function decides and writes (forward-only, humans win, idempotent on
    the event id). Nothing about the lock is re-implemented here, because a copy
    of it here would be a copy that disagrees with the trigger the day one of
    them is edited.

    Keyed on `matched_key`, not on the event's URL: the fuzzy branch of the
    ladder resolves to a Pipeline row's own jobkey, which is the same
    `{ats}-{native_id}` the sweep mirrored into `postings`. A weak `norm-` key
    names no posting and comes back `no_posting`, which is the honest answer.

    `sheet_row` is the Pipeline row the sheet lane just decided against, and its
    `status`/`status_actor` go over as `p_current_*`. Without them the store
    decides against a twin that nothing keeps current: pg's `status_actor` is
    written only by the web app's `app_set_status`, so during dual-write — when
    the human's editing surface IS the spreadsheet — a person who types Offer into
    the Pipeline tab claims the sheet row and claims nothing in pg. The measured
    result was `join` recording a suggestion in the sheet while the SAME event
    advanced pg to Rejected: 0010's defect, rebuilt in the store that replaces it.
    """
    from core import pg
    etype = (ev.get("event_type") or "").strip()
    status, hard = schema.EVENT_STATUS_RULES.get(etype, (None, False))
    # ANY event kind, not just 'received'. Reaching here at all means the sheet
    # lane matched or created a Pipeline row for this key, and THAT is the evidence
    # the application exists — an OA invite for something the sheet has been
    # tracking for a month is exactly as good a witness as the confirmation email
    # that arrived before the flag was ever set. Gating on 'received' meant a store
    # row could only ever be born from the one email each application receives
    # once, which for every pre-existing application was consumed years ago; the
    # docstring claiming this "fills the gap without a backfill script" was simply
    # false, and the gap stayed open. (The real drain is still `tracker.pgseed`;
    # this is what keeps the hole from reopening between seed runs.)
    #
    # `is_strong` remains the gate, because a weak `norm-` key names no posting and
    # `applications.posting_key` is a foreign key — there is nothing to create
    # against, and a guessed row is worse than none.
    create = _birth_from(sheet_row, ev) if jobkeys.is_strong(matched_key) else None
    return pg.rpc(PG_APPLY_FN, {
        "p_user_id": pgwrites.user_id(),
        "p_posting_key": matched_key,
        "p_event_id": ev.get("event_id", ""),
        "p_event_type": etype,
        "p_status": status or "",
        "p_hard": bool(hard and _confidence(ev.get("confidence"))
                       >= schema.HARD_WRITE_MIN_CONFIDENCE),
        "p_evidence": ev.get("thread_link", ""),
        "p_activity_on": today(),
        "p_create": create,
        # The sheet's own answer to "what is this row, and does a human own it".
        # A row the sheet has never seen sends nulls, which the function reads as
        # "no second store" — the honest statement, and the only one available.
        "p_current_status": (sheet_row or {}).get("status") if sheet_row else None,
        "p_current_actor": (sheet_row or {}).get("status_actor") if sheet_row else None,
    }, session=session)


def run(hq: HQ) -> dict:
    events = hq.tab("email_events")
    pipeline = hq.tab("pipeline")
    counts = {"matched": 0, "created": 0, "needs_review": 0, "pg": 0, "pg_skipped": 0}
    to_pg = pgwrites.first_class()
    # ONE snapshot of the Pipeline, taken before any event is applied, used only by
    # the store lane. It is the sheet's status/actor as the sheet lane will decide
    # against them, which is the whole point.
    #
    # Staleness WITHIN a run is safe, and is why this is a snapshot rather than a
    # re-read per event: a second event touching the same key sees a sheet status
    # one event out of date, while the store's own row has already moved — and
    # `greatest(pg, sheet)` inside the function still answers with the furthest
    # either store has got. A re-read per event would also cost a full-tab Sheets
    # call per event, on a loop that already has to watch its quota.
    sheet_rows = {r["key"]: r for r in pipeline.records()
                  if (r.get("key") or "").strip()} if to_pg else {}
    pending = [r for r in events.records()
               if (r.get("event_id") or "").strip() and not (r.get("matched_key") or "").strip()]
    for ev in pending:
        matched_key, applied = _match_event(hq, pipeline, ev)
        # ORDER: sheet row, then store, then the `matched_key` stamp — and the
        # stamp LAST is the load-bearing part. That cell is what makes an event
        # non-pending, so stamping before the store write would let one PgError
        # retire the event from the sheet's queue and drop it from pg forever.
        # Stamping last means a store failure replays the whole event next run:
        # the sheet write is re-entrant (a second 'Applied' is rank-kept, and a
        # created row is found by the index rather than duplicated) and the pg
        # write is idempotent on the event id.
        if to_pg and matched_key != NEEDS_REVIEW:
            res = _pg_apply(ev, matched_key, sheet_rows.get(matched_key)) or {}
            outcome = str(res.get("outcome", ""))
            if outcome not in PG_OUTCOMES:
                raise RuntimeError(
                    f"{PG_APPLY_FN} returned an outcome this version does not "
                    f"understand: {outcome!r} (known: {sorted(PG_OUTCOMES)}). Refusing "
                    f"to count it — an unrecognised answer is not a successful write")
            if outcome in PG_NOTHING_TO_APPLY:
                counts["pg_skipped"] += 1
                hq.log("join", f"pg_{outcome}", matched_key, ev.get("event_id", ""))
                print(f"[join] pg {outcome} for {matched_key} "
                      f"(event {ev.get('event_id', '')}) — sheet applied, store skipped",
                      file=sys.stderr)
            else:
                counts["pg"] += 1
        events.set_by_key(ev["event_id"],
                          {"matched_key": matched_key, "applied_status": applied},
                          key_header="event_id")
        if matched_key == NEEDS_REVIEW:
            counts["needs_review"] += 1
            hq.log("join", "needs_review", "", ev.get("event_id", ""))
        elif applied == "created":
            counts["created"] += 1
        else:
            counts["matched"] += 1
    if counts["pg_skipped"]:
        # The residue, said out loud. Each one is recorded pg-side as an
        # `email.unapplied` event (0015) and the sheet has retired the email, so
        # without this line the only trace is a counter nobody reads. A number that
        # does not shrink between runs means the seed has not been run — or that
        # these keys name postings the sweep will never mirror.
        print(f"::warning title=HQ store lane skipped {counts['pg_skipped']} event(s)::"
              f"the sheet applied them and pg had no row to apply them to. Drain with "
              f"`python -m tracker.pgseed` (docs/RUNBOOK.md § The store lane)")
    return counts


CAPTURE_STALE_HOURS = 48
_ALERT_LATCH = "capture_alert_date"


def check_capture_liveness(hq: HQ, *, now=None) -> str:
    """Gmail capture is the status ground truth, and its Apps Script runs in
    an account this repo can't see — the only proof of life is the
    heartbeat_capture stamp Code.gs upserts daily. Missing or >48h stale ->
    one ops alert per day (latched via Config, same pattern as simplify's
    cookie alert). Returns a status string for the run log."""
    import datetime as dt
    now = now or dt.datetime.now(dt.timezone.utc)
    t = hq.tab("config")
    vals = {r.get("key", ""): r.get("value", "") for r in t.records()}
    raw = (vals.get("heartbeat_capture") or "").strip()

    stale_reason = ""
    if not raw:
        stale_reason = ("no heartbeat_capture in Config — the capture Apps "
                        "Script has never checked in (not deployed, or the "
                        "current Code.gs predates heartbeats)")
    else:
        try:
            seen = dt.datetime.strptime(raw, "%Y-%m-%d %H:%M:%SZ").replace(
                tzinfo=dt.timezone.utc)
            age_h = (now - seen).total_seconds() / 3600
            if age_h > CAPTURE_STALE_HOURS:
                stale_reason = (f"heartbeat_capture is {age_h:.0f}h old "
                                f"(threshold {CAPTURE_STALE_HOURS}h) — the "
                                f"capture trigger has stopped firing")
        except ValueError:
            stale_reason = f"heartbeat_capture unparseable: {raw!r}"

    if not stale_reason:
        return "alive"
    today_s = now.date().isoformat()
    if vals.get(_ALERT_LATCH) == today_s:
        return "stale (already alerted today)"
    from core import notify
    notify.ops_alert("Gmail capture silent",
                     stale_reason + " — statuses are NOT auto-advancing. "
                     "Re-deploy appsscript/capture per appsscript/README.md.")
    try:
        t.set_by_key(_ALERT_LATCH, {"value": today_s}, key_header="key")
    except RowNotFound:
        t.append_records([{"key": _ALERT_LATCH, "value": today_s,
                           "description": "(auto) last capture-silent ops alert"}])
    return "stale (alerted)"


def main() -> int:
    import traceback
    from core import notify
    try:
        hq = HQ.open()
    except Exception as e:
        print(f"[join] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("tracker/join failed", str(e)[:300])
        return 1

    counts, failure = {}, None
    try:
        counts = run(hq)
    except Exception as e:                       # includes a store outage
        failure = e
        print(f"[join] FAILED:\n{traceback.format_exc()}", file=sys.stderr)

    # The Gmail tripwire runs WHATEVER run() did. It is one of the two copies of
    # the "capture has gone silent" watchdog (the other is the daily digest's), it
    # is about the SHEET, and it was working — but a PgError inside run() used to
    # skip it entirely, so one store outage blinded both copies at once. Nothing
    # here depends on the store.
    try:
        capture = check_capture_liveness(hq)
    except Exception as e:                       # a broken tripwire must not hide the real failure
        capture = f"unchecked ({type(e).__name__})"
        print(f"[join] capture liveness check failed: {e!r}", file=sys.stderr)

    if failure is not None:
        notify.ops_alert("tracker/join failed", str(failure)[:300])
        return 1
    # The chain's heartbeat means the chain finished. Only on the success path.
    hq.heartbeat("tracker")   # join runs last: this vouches for the whole chain
    print(f"[join] {counts} capture={capture}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
