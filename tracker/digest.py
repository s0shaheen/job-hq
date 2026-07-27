"""Daily digest (~7am CT): one markdown briefing row + a short phone ping.

    python -m tracker.digest

Composes the day's picture from the tabs the other bots maintain, writes it to
the digest tab ({date, body, sent_at:""} — Apps Script mails it and stamps
sent_at), and pushes a one-line ntfy summary. Sections with nothing to say are
skipped; Automation health always prints so silence is visible.

Watchdog duty: this is the one job guaranteed to run daily, so it also checks
heartbeat_capture (the Apps Script Gmail tripwire) and ops-alerts if that has
been silent >3h — the mutual-monitoring leg from research/gmail-tracking.md.
The backup heartbeats page the same way — one beat per lane (`snapshot` = the
git/Actions CSV copy, `snapshot_s3` = the S3/Lambda copy, `selfheal` = the schema
re-assert + commit), because a dead backup is the one failure you discover on the
day you need it, and printing it in a briefing nobody re-reads is not enough.

SHEET-SUNSET Phase C1: under `HQ_PG_WRITES=first_class` the beats live in TWO
stores (Config rows and `channel_runs`, per core/beats.py) and the watchdog holds
each store to the cadence separately. Neither may vouch for the other — see
`_sec_health`.
"""
from __future__ import annotations

import datetime as _dt

from core import beats, config, notify, outbox, pgwrites
from core.profile import Profile
from core.sheets import HQ, RowNotFound

# Expected run cadence per heartbeat, in hours; a heartbeat older than 2x its
# cadence is flagged. capture=1.5 so 2x aligns with the 3h ops watchdog.
# monitor=12 since the sweep runs twice daily (07:00 and 18:00 CT).
# `priority` and `simplify` are deliberately ABSENT: both are dispatch-only now, so
# watching their heartbeats would print a stale warning every single day — and a
# briefing that cries wolf daily is one you stop reading.
# Keep in sync with the schedules: infra/terraform/variables.tf `jobs` (Lambda) plus selfheal.yml,
# the only cron left on GitHub Actions (pgdump.yml was deleted 2026-07-25 — gated off, no database).
CADENCE_HOURS = {
    "monitor": 12, "review": 24, "tracker": 2,
    # cafe and theirstack are SEPARATE channels, not one "wide": they are
    # separate vendors in separate jobs, and a dead TheirStack must not hide
    # behind a healthy hiring.cafe.
    "cafe": 24, "theirstack": 24,
    "selfheal": 24, "snapshot": 24, "snapshot_s3": 24, "capture": 1.5,
}
CAPTURE_ALERT_HOURS = 3

#: The pg store's own cadence table — deliberately NOT a slice of CADENCE_HOURS.
#:
#: The two stores hold different lanes. `pgdump` has no sheet beat at all (its product is a
#: pg dump, and nothing writes a Config row for it), while `monitor`, `tracker` and `capture`
#: have no pg beat: their writers are jobs that would have to be taught one, and a watchdog
#: that demanded a beat nobody writes pages every morning about a job that is running fine.
#: That is not hypothetical — it is exactly what this branch shipped for `snapshot`, whose
#: Actions lane had no pg credentials (fixed in selfheal.yml alongside this table).
#:
#: Pinned equal to `core.beats.LANES` by tests/tracker/test_digest.py: a lane may not write a
#: beat nobody watches, and the watchdog may not expect a beat nobody writes. Both directions,
#: because each one alone has already been shipped broken.
PG_CADENCE_HOURS = {
    "snapshot": 24, "snapshot_s3": 24, "digest": 24,
    # The store's backup. `pgdump.yml` is gated on the PGDUMP_ENABLED repo variable, so
    # until that is turned on this lane reads "no heartbeat yet" — under `first_class`,
    # and only under it. That page is CORRECT: it says pg is the store whose success counts
    # and it has no backup, which is the precondition SHEET-SUNSET puts in Phase A. It is
    # silent for every Phase-A run, because pg beats are not read at all with the flag unset.
    "pgdump": 24,
}
# The three heartbeats that mean "the sheet is backed up somewhere": selfheal re-asserts
# the schema and commits from Actions, `snapshot` is the git/Actions CSV copy, and
# `snapshot_s3` is the S3/Lambda CSV copy (tracker.snapshot picks its beat by mode —
# HEARTBEAT_GIT vs HEARTBEAT_S3 there). One beat per LANE, never one shared: the same
# module writing one beat from both schedulers would let the Actions run refresh it
# nightly while the Lambda copy has been dead for a week, which is the silent-death
# failure the S3 lane was built to remove. Unlike the rest of the health section, these page.
#: `pgdump` joins them for Phase C: once HQ_PG_WRITES=first_class the store is what the
#: system depends on, and a store with no watched backup is the sheet's 2026-07-24 outage
#: waiting to happen in the substrate that replaced it.
BACKUP_BEATS = ("selfheal", "snapshot", "snapshot_s3", "pgdump")
_HB_FMT = "%Y-%m-%d %H:%M:%SZ"      # core.sheets._now()

NEW_ROLES_CAP = 15
SUBJECT_CAP = 5
FOLLOWUP_CAP = 5


def _parse_ts(s: str) -> _dt.datetime | None:
    try:
        return _dt.datetime.strptime(s.strip(), _HB_FMT).replace(tzinfo=_dt.timezone.utc)
    except (ValueError, AttributeError):
        return None


def _truthy(s: str) -> bool:
    return str(s or "").strip().upper() not in ("", "FALSE", "0", "NO")


def _sec_new_roles(hq: HQ, cfg, today_s: str) -> tuple[list[str], int]:
    priority = {r["name"].casefold() for r in hq.tab("companies").records()
                if r.get("name") and _truthy(r.get("priority", ""))}
    yoe_max = int(cfg.get("yoe_push_max", 4))
    rows = []
    for r in hq.tab("feed").records():
        if r.get("first_seen", "") != today_s:
            continue
        pri = r.get("company", "").casefold() in priority
        reason = r.get("disposition_reason", "")
        # "Handpicked beats the profile" is about WHICH EMPLOYERS, not which
        # continent. A priority company may exempt a row from the seniority
        # and YoE bars; it must never exempt geo. The unsplit version put
        # Hyderabad, Stockholm and Taipei roles in a US-only daily briefing —
        # the most expensive kind of bug, because it degrades the one surface
        # that gets read every day, and a briefing you learn to distrust is
        # worth less than no briefing.
        if r.get("disposition", "") == "filtered":
            if reason.startswith(("geo", "metro")) or not pri:
                continue
        my = r.get("min_yoe", "").strip()
        # blank min_yoe = unknown; never hide a role for a number we don't have
        if my.isdigit() and int(my) > yoe_max and not pri:
            continue
        rows.append((pri, r))
    rows.sort(key=lambda pr: (not pr[0], pr[1].get("company", ""), pr[1].get("title", "")))
    lines = []
    for pri, r in rows[:NEW_ROLES_CAP]:
        star = "★ " if pri else ""
        loc = f" — {r['location']}" if r.get("location") else ""
        # an off-profile row that survived only because the company is
        # handpicked must SAY so, or it reads as a filtering failure
        why = (f" · outside your filters ({r.get('disposition_reason','')})"
               if r.get("disposition", "") == "filtered" else "")
        lines.append(f"- {star}[{r.get('company', '?')} — {r.get('title', '?')}]"
                     f"({r.get('url', '')}){loc}{why}")
    if len(rows) > NEW_ROLES_CAP:
        lines.append(f"- +{len(rows) - NEW_ROLES_CAP} more in the Feed tab")
    return lines, len(rows)


def _sec_status_changes(hq: HQ, now: _dt.datetime) -> list[str]:
    """Substring (not prefix) match: the live actions are join's
    advanced_status/suggested_status/created_from_email, scout's
    applied_created, simplify's created/suggested — while kept_status,
    matched, applied_backfilled and sync summaries stay out."""
    cutoff = now - _dt.timedelta(hours=24)
    lines = []
    for r in hq.tab("log").records():
        ts = _parse_ts(r.get("ts", ""))
        if ts is None or ts < cutoff:
            continue
        if r.get("actor", "") not in ("join", "scout", "simplify"):
            continue
        action = r.get("action", "")
        if not any(tok in action for tok in ("advance", "suggest", "create")):
            continue
        key = f" `{r['key']}`" if r.get("key") else ""
        detail = r.get("detail", "").strip()
        lines.append(f"- {r['actor']} {r['action']}{key}" + (f": {detail}" if detail else ""))
    return lines


def _sec_needs_review(hq: HQ) -> tuple[list[str], int]:
    rows = [r for r in hq.tab("email_events").records()
            if r.get("matched_key", "") == "NEEDS_REVIEW"]
    if not rows:
        return [], 0
    lines = [f"{len(rows)} email event(s) need a human match:"]
    lines += [f"- {r.get('subject', '(no subject)')}" for r in rows[:SUBJECT_CAP]]
    if len(rows) > SUBJECT_CAP:
        lines.append(f"- +{len(rows) - SUBJECT_CAP} more in Email Events")
    return lines, len(rows)


def _sec_followups(hq: HQ) -> list[str]:
    rows = [r for r in hq.tab("pipeline").records() if r.get("stale", "").strip()]
    rows.sort(key=lambda r: r.get("applied_date", "") or r.get("last_activity", "") or "9999")
    lines = []
    for r in rows[:FOLLOWUP_CAP]:
        applied = f"applied {r['applied_date']}" if r.get("applied_date") else "no applied date"
        lines.append(f"- {r.get('company', '?')} — {r.get('title', '?')} "
                     f"({applied}; {r.get('stale')})")
    if len(rows) > FOLLOWUP_CAP:
        lines.append(f"- +{len(rows) - FOLLOWUP_CAP} more stale rows in Pipeline")
    return lines


def _sec_scout(hq: HQ, yesterday_s: str) -> list[str]:
    for r in hq.tab("scout_daily").records():
        if r.get("date", "") == yesterday_s:
            return [f"Added {r.get('jobs_added', '0')} job(s), applied "
                    f"{r.get('applied', '0')}, {r.get('duplicates_flagged', '0')} duplicate(s) flagged."]
    return []


def _sec_health(hq: HQ, now: _dt.datetime,
                pg_beats: dict | None = None) -> tuple[list[str], bool, list[str]]:
    """⚠ any heartbeat older than 2x cadence (or never written — a job that
    never ran is exactly what this section exists to surface). Returns
    (lines, capture_silent_beyond_3h, backup_stale_lines).

    The third value is the subset of the warn lines that belong to BACKUP_BEATS
    — truthy exactly when a backup is stale-or-missing, and carrying the lines
    themselves so the ops push says which lane died instead of re-deriving it.

    TWO STORES, JUDGED SEPARATELY (Phase C1). `pg_beats` is the same lanes read
    out of `channel_runs` (core/beats.py), and each store gets its own warn line
    rather than a merged "is it alive anywhere" verdict. That is the same
    doctrine `tracker.snapshot` applies to the git and S3 backup copies one level
    down, for the same reason: a lane whose sheet beat is fresh and whose pg beat
    died a week ago must not read as healthy on the strength of the store that
    is about to be decommissioned — nor the reverse, which is how a still-live
    sheet lane would go dark unnoticed after the cutover.
    """
    stamps = {r["key"][len("heartbeat_"):]: r.get("value", "")
              for r in hq.tab("config").records()
              if r.get("key", "").startswith("heartbeat_")}
    warn, capture_silent, backup_stale = [], False, []

    def _check(name: str, cadence: float, ts: _dt.datetime | None, seen: str,
               store: str = "") -> None:
        nonlocal capture_silent
        label = f"{name} ({store})" if store else name
        if ts is None:
            warn.append(f"⚠ {label}: no heartbeat yet")
        else:
            age_h = (now - ts).total_seconds() / 3600
            if name == "capture" and age_h > CAPTURE_ALERT_HOURS:
                capture_silent = True
            if age_h <= cadence * 2:
                return
            warn.append(f"⚠ {label}: last ran {seen} (~{age_h:.0f}h ago, "
                        f"expected every ~{cadence:g}h)")
        if name in BACKUP_BEATS:
            backup_stale.append(warn[-1])

    for name, cadence in CADENCE_HOURS.items():
        _check(name, cadence, _parse_ts(stamps.get(name, "")), stamps.get(name, ""))
    if pg_beats is not None:
        for name, cadence in PG_CADENCE_HOURS.items():
            ts = pg_beats.get(name)
            _check(name, cadence, ts, ts.strftime(_HB_FMT) if ts else "", store="pg")
    return (warn or ["✅ all systems ran on schedule"]), capture_silent, backup_stale


def run(hq: HQ, *, now: _dt.datetime | None = None) -> dict:
    now = now or _dt.datetime.now(_dt.timezone.utc)
    today_s = now.date().isoformat()
    yesterday_s = (now.date() - _dt.timedelta(days=1)).isoformat()
    cfg = hq.user_config()

    new_lines, n_new = _sec_new_roles(hq, cfg, today_s)
    change_lines = _sec_status_changes(hq, now)
    review_lines, n_review = _sec_needs_review(hq)
    follow_lines = _sec_followups(hq)
    scout_lines = _sec_scout(hq, yesterday_s)
    # Phase C1: read the store's beats too, and judge each store on its own.
    #
    # An unreachable store is REPORTED, not raised. Raising here took down the
    # whole briefing — the digest row, the phone push, the Gmail-capture-silent
    # alert and the backups-stale alert, all of which are about the SHEET and were
    # working — so one pg outage blinded every watchdog this job owns. Measured:
    # a genuinely dead capture beat (8 h) and a genuinely dead git snapshot (4
    # days) produced zero alerts and zero digest rows with pg down.
    #
    # It is still not "best effort": the failure becomes its own warn line, and one
    # that PAGES, because the lanes behind it are backup lanes. Silence would be
    # the real bug — "all systems ran on schedule" printed at the exact moment the
    # watchdog can no longer see half of what it watches.
    pg_beats, pg_error = None, ""
    if pgwrites.first_class():
        try:
            pg_beats = beats.last_seen(pgwrites.user_id())
        except Exception as e:
            pg_error = f"{type(e).__name__}: {e}"[:200]
    health_lines, capture_silent, backup_stale = _sec_health(hq, now, pg_beats)
    if pg_error:
        line = (f"⚠ pg heartbeats unreadable ({pg_error}) — the store's lanes "
                f"({', '.join(beats.LANES)}) are unwatched this run")
        health_lines = [line] + [ln for ln in health_lines
                                 if ln != "✅ all systems ran on schedule"]
        backup_stale.append(line)

    parts = [f"# Job Search HQ — {today_s}"]
    for title, lines in [("New roles (last 24h)", new_lines),
                         ("Status changes", change_lines),
                         ("Needs review", review_lines),
                         ("Follow-ups", follow_lines),
                         ("Scout yesterday", scout_lines),
                         ("Automation health", health_lines)]:
        if lines:
            parts.append(f"\n## {title}\n" + "\n".join(lines))
    body = "\n".join(parts)

    t = hq.tab("digest")
    try:   # re-run same day = refresh body, keep sent_at (Apps Script's field)
        t.set_by_key(today_s, {"body": body}, key_header="date")
    except RowNotFound:
        t.append_records([{"date": today_s, "body": body, "sent_at": ""}])

    sheet_id = hq.registry.get("sheet_id", "") or config.sheet_id()
    # the digest row above is written for EVERY user; only the phone ping is
    # channel-gated, and that gate lives in core.notify.push (core/channels.py)
    # — this call had none until then, so an email-only user was pinged daily.
    # The profile is built from the same `cfg` read above, so the notify_* cells
    # a human edited in the Config tab are what the policy actually reads.
    prof = Profile.load(getattr(hq, "user", ""), cfg=cfg)
    notify.push(f"HQ digest — {n_new} new roles, {len(change_lines)} updates",
                f"{n_review} to review · {len(follow_lines)} follow-ups",
                event="digest", kind="jobs", tags=["newspaper"],
                user=getattr(hq, "user", ""), outbox=outbox.sink(hq), profile=prof,
                click=f"https://docs.google.com/spreadsheets/d/{sheet_id}" if sheet_id else "")

    # Whose instance died. One ops topic carries every user's failures (MULTIUSER.md:
    # point every user's ops topic at the operator), so an unattributed "HQ backups
    # stale" sends the operator to the wrong sheet. Same guard as tracker/selfheal.py.
    who = f"[{hq.user}] " if getattr(hq, "user", "") else ""

    if capture_silent:
        notify.ops_alert(f"{who}Gmail capture silent",
                         f"heartbeat_capture older than {CAPTURE_ALERT_HOURS}h — check the "
                         "Apps Script trigger (Executions page) before email events go missing.")

    # Printing this in the briefing is too quiet for a backup: Actions stopped running on a
    # billing lapse (2026-07-24) and nothing paged for 21h. Daily digest = daily dedup.
    if backup_stale:
        notify.ops_alert(f"{who}HQ backups stale", "\n".join(backup_stale) +
                         "\nselfheal = the schema re-assert + commit (Actions), snapshot = the "
                         "git/Actions CSV copy, snapshot_s3 = the S3/Lambda CSV copy. "
                         "Restore paths: docs/RUNBOOK.md.")

    # Both stores, last: the beat means "the briefing was composed and sent", and
    # this job's own beat is the one proving the watchdog itself still runs. The
    # sheet beat is written even when pg is unreachable — the sheet half of the
    # briefing really did run — and the pg beat is simply not attempted, so the
    # store's own `digest` lane goes stale and says so tomorrow.
    hq.heartbeat("digest")
    if not pg_error and pgwrites.first_class():
        beats.write("digest", pgwrites.user_id())
    return {"new": n_new, "changes": len(change_lines), "needs_review": n_review,
            "followups": len(follow_lines), "capture_silent": capture_silent,
            "backups_stale": bool(backup_stale), "body": body}


def main() -> int:
    s = run(HQ.open())
    print(f"[digest] new={s['new']} changes={s['changes']} "
          f"review={s['needs_review']} followups={s['followups']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
