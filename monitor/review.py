"""Nightly tagging sweep (entry: python -m monitor.review).

Any open feed row still untagged — inline-cap overflow, an LLM hiccup at
discovery, or a JD source that was down — gets tags + min_yoe here. Skips
cleanly without ANTHROPIC_API_KEY (tagging is an enhancement, never a
blocker); per-job failures are quarantined, systemic failure pings ops.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from datetime import date

import requests

from core import notify
from monitor import jobcontent, tagging
from monitor.config import unconfigured_reason
from monitor.sheet import HQFeedStore, SheetStore


@dataclass
class ReviewSummary:
    tagged: int = 0
    skipped_no_jd: int = 0
    failed: int = 0
    fail_companies: list = field(default_factory=list)


def review_feed(store: SheetStore, *, today: str | None = None,
                session: requests.Session | None = None,
                fetch=None, extract=None,
                flush_every: int = 100,
                time_budget_min: float | None = None) -> ReviewSummary:
    """fetch/extract default late (None) so tests can monkeypatch the modules.

    Tags flush to the sheet every `flush_every` rows, so a big backlog makes
    durable progress even if the run is killed — tagged_at is the cursor and
    the next run simply continues. `time_budget_min` (env REVIEW_TIME_BUDGET_MIN,
    default 40) stops cleanly before the workflow timeout would kill us mid-write.
    """
    import time as _time
    today = today or date.today().isoformat()
    session = session or requests.Session()
    fetch = fetch or jobcontent.fetch_description
    extract = extract or tagging.extract_tags
    if time_budget_min is None:
        time_budget_min = float(os.environ.get("REVIEW_TIME_BUDGET_MIN", "40"))
    deadline = _time.monotonic() + time_budget_min * 60
    slug_by_company = {c.name: c.slug for c in store.read_companies()}
    summary = ReviewSummary()
    updates: dict[str, tagging.Tags] = {}

    def flush():
        if updates:
            store.write_tags(dict(updates), today)
            updates.clear()

    for rec, tagged_at in store.read_jobs_for_tagging():
        if tagged_at or rec.status == "Closed":
            continue
        if _time.monotonic() > deadline:
            print(f"[review] time budget reached — flushing and stopping; "
                  f"the next run continues from tagged_at", file=sys.stderr)
            break
        ats, _, native_id = rec.id.partition("-")   # ats has no hyphen; native_id keeps its own
        slug = slug_by_company.get(rec.company, "")
        try:
            jd = fetch(ats, native_id, slug, rec.url, session)
            if not jd or not jd.strip():
                summary.skipped_no_jd += 1
                continue
            updates[rec.id] = extract(jd, rec.title, rec.company)
            summary.tagged += 1
            if len(updates) >= flush_every:
                flush()
        except Exception as e:
            summary.failed += 1
            summary.fail_companies.append(rec.company)
            print(f"[review] {rec.id} ({rec.company}) FAILED: {str(e)[:200]}",
                  file=sys.stderr)

    flush()
    return summary


def main() -> int:
    import traceback

    if not os.environ.get("ANTHROPIC_API_KEY", ""):
        print("[review] ANTHROPIC_API_KEY not set — tagging pass skipped", file=sys.stderr)
        return 0
    reason = unconfigured_reason()
    if reason:
        print(f"[review] SKIPPED — {reason}", file=sys.stderr)
        return 1

    session = requests.Session()
    try:
        from core.sheets import HQ
        hq = HQ.open()
        store = HQFeedStore(hq)
        geo_n = store.fill_missing_geo()
        if geo_n:
            print(f"[review] geo_fill: {geo_n} rows", file=sys.stderr)
        s = review_feed(store, session=session)
        print(f"[review] tagged={s.tagged} skipped_no_jd={s.skipped_no_jd} "
              f"failed={s.failed}", file=sys.stderr)
        hq.heartbeat("review")   # liveness: the sweep ran, whatever it found
        if s.failed and not s.tagged:
            # systemic (e.g. bad/expired key fails every call) — surface it
            msg = f"tagging failed for all {s.failed} attempted job(s)"
            print(f"[review] FAILURES: {msg}", file=sys.stderr)
            notify.ops_alert("Review tagging FAILED", msg, session=session)
            return 1
        return 0
    except Exception as e:
        print(f"[review] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("Review run FAILED", str(e)[:300], session=session)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
