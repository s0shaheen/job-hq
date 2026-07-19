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
"""
from __future__ import annotations

import datetime as _dt
import difflib
import re
import sys

from core import jobkeys, schema
from core.sheets import HQ, RowNotFound, today

NEEDS_REVIEW = "NEEDS_REVIEW"
TITLE_RATIO = 0.6


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
    if status is None:
        pipeline.set_by_key(key, {"last_activity": today()})
        hq.log("join", "matched", key, etype)
        return "matched"
    if hard and _confidence(ev.get("confidence")) >= schema.HARD_WRITE_MIN_CONFIDENCE:
        res = pipeline.advance_status(key, status, evidence=evid)
        if res == "kept":   # advance_status only stamps activity when it moves
            pipeline.set_by_key(key, {"last_activity": today()})
        hq.log("join", f"{res}_status", key, f"{etype} -> {status}")
        return f"{res}:{status}"
    pipeline.set_by_key(key, {"suggested_status": status, "evidence": evid,
                              "last_activity": today()})
    hq.log("join", "suggested_status", key, f"{etype} -> {status}")
    return f"suggested:{status}"


def _create_row(hq: HQ, pipeline, key: str, ev: dict) -> None:
    """A confirmed application we never tracked: strong key + 'received'.
    Below the confidence gate the status stays a suggestion even at birth."""
    status, _hard = schema.EVENT_STATUS_RULES["received"]
    rec = {
        "key": key,
        "company": ev.get("company", ""),
        "title": ev.get("title", ""),
        "url": ev.get("job_url", ""),
        "source": "gmail",
        "applied_date": _date_part(ev.get("received_at", "")),
        "applied_via": "scout" if (ev.get("account") or "").strip() == "alt" else "self",
        "applied_email": ev.get("account", ""),
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


def run(hq: HQ) -> dict:
    events = hq.tab("email_events")
    pipeline = hq.tab("pipeline")
    counts = {"matched": 0, "created": 0, "needs_review": 0}
    pending = [r for r in events.records()
               if (r.get("event_id") or "").strip() and not (r.get("matched_key") or "").strip()]
    for ev in pending:
        matched_key, applied = _match_event(hq, pipeline, ev)
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
        counts = run(hq)
        capture = check_capture_liveness(hq)
        hq.heartbeat("tracker")   # join runs last: this vouches for the whole chain
    except Exception as e:
        print(f"[join] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("tracker/join failed", str(e)[:300])
        return 1
    print(f"[join] {counts} capture={capture}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
