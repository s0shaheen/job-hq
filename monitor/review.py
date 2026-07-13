from __future__ import annotations
from dataclasses import dataclass, field
from datetime import date
import os
import sys
import traceback

import requests

from monitor.config import list_profiles, unconfigured_reason
from monitor.sheet import GspreadSheetStore, SheetStore
from monitor.models import Profile
from monitor import jobcontent, tagging, notify


@dataclass
class ReviewSummary:
    tagged: int = 0
    skipped_no_jd: int = 0
    failed: int = 0
    fail_companies: list = field(default_factory=list)


def review_profile(profile: Profile, store: SheetStore, *, today: str | None = None,
                   session: requests.Session | None = None,
                   fetch=jobcontent.fetch_description,
                   extract=tagging.extract_tags) -> ReviewSummary:
    today = today or date.today().isoformat()
    session = session or requests.Session()
    store.ensure_tag_columns()
    slug_by_company = {c.name: c.slug for c in store.read_companies()}
    summary = ReviewSummary()
    updates: dict = {}

    for rec, tagged_at in store.read_jobs_for_tagging():
        if tagged_at or rec.status == "Closed":
            continue
        ats, _, native_id = rec.id.partition("-")   # ats has no hyphen; native_id keeps its own
        slug = slug_by_company.get(rec.company, "")
        try:
            jd = fetch(ats, native_id, slug, rec.url, session)
            if not jd or not jd.strip():
                summary.skipped_no_jd += 1
                continue
            updates[rec.id] = extract(jd, rec.title, rec.company)
            summary.tagged += 1
        except Exception as e:
            summary.failed += 1
            summary.fail_companies.append(rec.company)
            print(f"[review] {rec.id} ({rec.company}) FAILED: {str(e)[:200]}", file=sys.stderr)

    if updates:
        store.write_tags(updates, today)
    return summary


def main() -> int:
    session = requests.Session()
    if not os.environ.get("ANTHROPIC_API_KEY", ""):
        print("[review] ANTHROPIC_API_KEY not set — tagging pass skipped", file=sys.stderr)
        return 0
    failures = []
    for profile in list_profiles():
        reason = unconfigured_reason(profile)
        if reason:
            print(f"[review] profile '{profile.name}' SKIPPED — {reason}", file=sys.stderr)
            continue
        try:
            store = GspreadSheetStore(profile.sheet_id)
            s = review_profile(profile, store, session=session)
            print(f"[review] {profile.name}: tagged={s.tagged} "
                  f"skipped_no_jd={s.skipped_no_jd} failed={s.failed}", file=sys.stderr)
            # Systemic failure (e.g. bad/expired key fails every call) — surface it.
            if s.failed and not s.tagged:
                failures.append(f"{profile.name}: tagging failed for all {s.failed} attempted job(s)")
        except Exception as e:
            failures.append(f"{profile.name}: {e}")
            print(f"[review] profile '{profile.name}' FAILED:\n{traceback.format_exc()}",
                  file=sys.stderr)

    if failures:
        msg = "; ".join(failures)
        print(f"[review] FAILURES: {msg}", file=sys.stderr)
        ops = os.environ.get("MONITOR_OPS_NTFY_TOPIC", "")
        if ops:
            try:
                notify.failure_alert(session, ops, msg[:300])
            except Exception as alert_err:
                print(f"[review] failure_alert itself errored: {alert_err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
