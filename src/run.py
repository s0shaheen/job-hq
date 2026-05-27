from __future__ import annotations
from dataclasses import dataclass
from datetime import date

import requests

from src.config import list_profiles, unconfigured_reason
from src.dedup import reconcile_company
from src.fetchers import get_jobs_for
from src.filtering import title_matches
from src.models import Profile
from src.sheet import GspreadSheetStore, SheetStore
from src import notify, snapshot


@dataclass
class RunSummary:
    new_count: int = 0
    ok: int = 0
    zero: int = 0
    errored: int = 0
    error_companies: list[str] = None

    def __post_init__(self):
        if self.error_companies is None:
            self.error_companies = []


def run_profile(profile: Profile, store: SheetStore, fetch=get_jobs_for,
                today: str | None = None, session: requests.Session | None = None,
                notifier=None, heartbeater=None) -> RunSummary:
    today = today or date.today().isoformat()
    session = session or requests.Session()
    notifier = notifier or (lambda *a, **k: notify.push(*a, **k))
    heartbeater = heartbeater or (lambda *a, **k: notify.heartbeat(*a, **k))

    companies = store.read_companies()
    history = store.read_history()
    summary = RunSummary()
    health_rows: list[list] = []

    all_new = []
    append_records = []
    reopen_status = {}
    last_seen_ids = []
    newly_seeded = []

    for c in companies:
        # history scoped to this company
        chist = {jid: r for jid, r in history.items() if r.company == c.name}
        try:
            jobs = fetch(c.ats, c.slug, c.name, session, workday_search=profile.workday_search)
        except Exception as e:  # quarantine: one company never kills the run
            summary.errored += 1
            summary.error_companies.append(c.name)
            health_rows.append([c.name, c.ats, "ERROR", 0, str(e)[:200], today])
            continue

        jobs = [j for j in jobs if title_matches(j.title, profile.include, profile.exclude)]
        result = reconcile_company(chist, jobs, seeded=c.seeded, today=today,
                                   stale_days=14)

        append_records.extend(result.seed_records)
        append_records.extend(result.new_records)
        all_new.extend(result.new_records)
        last_seen_ids.extend(result.touched_ids)
        last_seen_ids.extend(result.reopened_ids)
        last_seen_ids.extend([r.id for r in result.new_records])
        for rid in result.reopened_ids:
            reopen_status[rid] = "New"
            # surface reopened roles in the push too
            all_new.append(history[rid])
        for rid in result.closed_ids:
            reopen_status[rid] = "Closed"

        if not c.seeded:
            newly_seeded.append(c.name)

        result_label = "ZERO" if not jobs else "OK"
        if result_label == "ZERO":
            summary.zero += 1
        else:
            summary.ok += 1
        health_rows.append([c.name, c.ats, result_label, len(jobs), "", today])

    # writes
    if append_records:
        store.append_jobs(append_records)
    if reopen_status:
        store.set_status(reopen_status)
    if last_seen_ids:
        store.set_last_seen(last_seen_ids, today)
    if newly_seeded:
        store.mark_seeded(newly_seeded)
    store.write_health(health_rows)

    summary.new_count = len(all_new)

    # notify (never silent)
    contact_counts = {r.company: store.contact_count(r.company) for r in all_new}
    if all_new:
        title, body = notify.format_new_jobs(all_new, contact_counts)
        notifier(session, profile.ntfy_topic, title, body, tags=["briefcase"])
    else:
        heartbeater(session, profile.ntfy_topic, summary.ok, summary.zero, summary.errored)

    return summary


def main() -> int:
    import os
    import sys
    import traceback

    session = requests.Session()
    profiles = list_profiles()
    failures = []
    for profile in profiles:
        reason = unconfigured_reason(profile)
        if reason:  # clear, actionable message instead of an opaque gspread 404
            failures.append(f"{profile.name}: {reason}")
            print(f"[monitor] profile '{profile.name}' SKIPPED — {reason}", file=sys.stderr)
            continue
        try:
            store = GspreadSheetStore(profile.sheet_id)
            run_profile(profile, store, session=session)
            snapshot.write_snapshot(f"snapshots/{profile.name}.json",
                                    profile.name, store.read_history())
        except Exception as e:  # whole-profile failure
            failures.append(f"{profile.name}: {e}")
            # Full traceback to the Actions log so the REAL cause is always visible.
            print(f"[monitor] profile '{profile.name}' FAILED:\n{traceback.format_exc()}",
                  file=sys.stderr)

    if failures:
        summary_msg = "; ".join(failures)
        # Surface failures in the log unconditionally — the alert send must never
        # be the thing that hides the underlying error.
        print(f"[monitor] FAILURES: {summary_msg}", file=sys.stderr)
        ops = os.environ.get("MONITOR_OPS_NTFY_TOPIC", "")
        if ops:
            try:
                notify.failure_alert(session, ops, summary_msg[:300])
            except Exception as alert_err:  # alerting is best-effort, never fatal
                print(f"[monitor] failure_alert itself errored: {alert_err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
