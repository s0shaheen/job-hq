"""Daily digest (~7am CT): one markdown briefing row + a short phone ping.

    python -m tracker.digest

Composes the day's picture from the tabs the other bots maintain, writes it to
the digest tab ({date, body, sent_at:""} — Apps Script mails it and stamps
sent_at), and pushes a one-line ntfy summary. Sections with nothing to say are
skipped; Automation health always prints so silence is visible.

Watchdog duty: this is the one job guaranteed to run daily, so it also checks
heartbeat_capture (the Apps Script Gmail tripwire) and ops-alerts if that has
been silent >3h — the mutual-monitoring leg from research/gmail-tracking.md.
"""
from __future__ import annotations

import datetime as _dt

from core import config, notify
from core.sheets import HQ, RowNotFound

# Expected run cadence per heartbeat, in hours; a heartbeat older than 2x its
# cadence is flagged. capture=1.5 so 2x aligns with the 3h ops watchdog.
# Keep in sync with .github/workflows cron schedules.
CADENCE_HOURS = {
    "monitor": 2, "review": 24, "priority": 2, "tracker": 2, "wide": 24,
    "simplify": 24, "selfheal": 24, "snapshot": 24, "capture": 1.5,
}
CAPTURE_ALERT_HOURS = 3
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
        lines.append(f"- {star}[{r.get('company', '?')} — {r.get('title', '?')}]"
                     f"({r.get('url', '')}){loc}")
    if len(rows) > NEW_ROLES_CAP:
        lines.append(f"- +{len(rows) - NEW_ROLES_CAP} more in the Feed tab")
    return lines, len(rows)


def _sec_status_changes(hq: HQ, now: _dt.datetime) -> list[str]:
    cutoff = now - _dt.timedelta(hours=24)
    lines = []
    for r in hq.tab("log").records():
        ts = _parse_ts(r.get("ts", ""))
        if ts is None or ts < cutoff:
            continue
        if r.get("actor", "") not in ("join", "scout", "simplify"):
            continue
        if not r.get("action", "").startswith(("advance", "suggest", "create")):
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


def _sec_health(hq: HQ, now: _dt.datetime) -> tuple[list[str], bool]:
    """⚠ any heartbeat older than 2x cadence (or never written — a job that
    never ran is exactly what this section exists to surface). Returns
    (lines, capture_silent_beyond_3h)."""
    beats = {r["key"][len("heartbeat_"):]: r.get("value", "")
             for r in hq.tab("config").records()
             if r.get("key", "").startswith("heartbeat_")}
    warn, capture_silent = [], False
    for name, cadence in CADENCE_HOURS.items():
        ts = _parse_ts(beats.get(name, ""))
        if ts is None:
            warn.append(f"⚠ {name}: no heartbeat yet")
            continue
        age_h = (now - ts).total_seconds() / 3600
        if age_h > cadence * 2:
            warn.append(f"⚠ {name}: last ran {beats[name]} (~{age_h:.0f}h ago, "
                        f"expected every ~{cadence:g}h)")
        if name == "capture" and age_h > CAPTURE_ALERT_HOURS:
            capture_silent = True
    return (warn or ["✅ all systems ran on schedule"]), capture_silent


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
    health_lines, capture_silent = _sec_health(hq, now)

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
    notify.push(f"HQ digest — {n_new} new roles, {len(change_lines)} updates",
                f"{n_review} to review · {len(follow_lines)} follow-ups",
                kind="jobs", tags=["newspaper"],
                click=f"https://docs.google.com/spreadsheets/d/{sheet_id}" if sheet_id else "")

    if capture_silent:
        notify.ops_alert("Gmail capture silent",
                         f"heartbeat_capture older than {CAPTURE_ALERT_HOURS}h — check the "
                         "Apps Script trigger (Executions page) before email events go missing.")

    hq.heartbeat("digest")
    return {"new": n_new, "changes": len(change_lines), "needs_review": n_review,
            "followups": len(follow_lines), "capture_silent": capture_silent,
            "body": body}


def main() -> int:
    s = run(HQ.open())
    print(f"[digest] new={s['new']} changes={s['changes']} "
          f"review={s['needs_review']} followups={s['followups']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
