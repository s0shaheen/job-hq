"""Hourly discovery run over the HQ spreadsheet (entry: python -m monitor.run).

Flow: Config tab -> fetch every monitored company's board -> title filter ->
reconcile against feed history (seed silently, surface new, reopen, close
stale) -> inline-tag NEW roles at discovery (capped; review.py sweeps the
rest nightly) -> ONE push for roles within the YoE bar -> health snapshot,
git snapshot, heartbeat.

Failure posture: one company never kills the run (quarantined to Health);
notification failure never fails the pipeline (core.notify swallows); no new
roles means silence — Config-tab heartbeats + the digest replaced ntfy
heartbeat pushes.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from datetime import date

import requests

from core import notify
from monitor import jobcontent, snapshot, tagging, tagworker
from monitor.config import RuntimeConfig, get_runtime_config, unconfigured_reason
from monitor.dedup import reconcile_company
from monitor.fetchers import get_jobs_for
from monitor.filtering import title_matches
from monitor.models import JobRecord
from monitor.notify import format_new_jobs
from monitor.sheet import HQFeedStore, SheetStore

INLINE_TAG_MAX_ENV = "MONITOR_INLINE_TAG_MAX"    # env override of the Config-tab inline_tag_max
STALE_DAYS = 14                      # board days-missing before a role is Closed
SNAPSHOT_PATH = "monitor/snapshots/hq.json"


@dataclass
class RunSummary:
    new_count: int = 0
    ok: int = 0
    zero: int = 0
    errored: int = 0
    error_companies: list[str] = field(default_factory=list)
    tagged: int = 0
    tag_failed: int = 0
    pushed: int = 0


def _inline_tag_max(cfg_default: int) -> int:
    """Env override wins (ops escape hatch); else the Config-tab knob."""
    raw = os.environ.get(INLINE_TAG_MAX_ENV)
    if raw is None:
        return max(0, cfg_default)
    try:
        return max(0, int(raw))
    except ValueError:
        return max(0, cfg_default)


def make_tagger(session_factory=requests.Session, *, jd_fetch=None, extract=None):
    """(JobRecord, slug) -> Tags|None. None = no JD source (stays untagged;
    review.py retries nightly). Raises on fetch/LLM failure so the caller can
    count it and move on — a tag failure never blocks the append. Runs under a
    thread pool at discovery, so each worker thread gets its own session
    (requests.Session is not thread-safe)."""
    jd_fetch = jd_fetch or jobcontent.fetch_description
    extract = extract or tagging.extract_tags
    get_session = tagworker.session_pool(session_factory)

    def tag(rec: JobRecord, slug: str):
        ats, _, native_id = rec.id.partition("-")
        jd = jd_fetch(ats, native_id, slug, rec.url, get_session())
        if not jd or not jd.strip():
            return None
        return extract(jd, rec.title, rec.company)
    return tag


def run_monitor(store: SheetStore, cfg: RuntimeConfig, *, fetch=get_jobs_for,
                tagger=None, today: str | None = None,
                session: requests.Session | None = None,
                pusher=None, inline_tag_max: int | None = None,
                inline_tag_workers: int | None = None) -> RunSummary:
    """One reconcile pass. tagger=None disables inline tagging (no
    ANTHROPIC_API_KEY, or tests) — review.py catches untagged rows nightly.
    pusher defaults late to core.notify.push so monkeypatching works."""
    today = today or date.today().isoformat()
    session = session or requests.Session()
    pusher = pusher or notify.push
    cap = _inline_tag_max(cfg.inline_tag_max) if inline_tag_max is None else inline_tag_max
    workers = cfg.inline_tag_workers if inline_tag_workers is None else inline_tag_workers

    companies = store.read_companies()
    history = store.read_history()
    known_min_yoe = store.read_min_yoe()   # for reopened roles tagged in a past run
    slugs = {c.name: c.slug for c in companies}
    summary = RunSummary()
    health: list[dict] = []

    all_new: list[JobRecord] = []          # fresh + reopened, discovery order
    append_records: list[JobRecord] = []
    status_changes: dict[str, str] = {}
    last_seen_ids: list[str] = []
    newly_seeded: list[str] = []

    for c in companies:
        chist = {jid: r for jid, r in history.items() if r.company == c.name}
        try:
            jobs = fetch(c.ats, c.slug, c.name, session, workday_search=cfg.workday_search)
        except Exception as e:   # quarantine: one company never kills the run
            summary.errored += 1
            summary.error_companies.append(c.name)
            health.append({"company": c.name, "ats": c.ats, "result": "ERROR",
                           "count": 0, "message": str(e)[:200], "checked_at": today})
            continue

        jobs = [j for j in jobs if title_matches(j.title, cfg.include, cfg.exclude)]
        result = reconcile_company(chist, jobs, seeded=c.seeded, today=today,
                                   stale_days=STALE_DAYS)

        append_records.extend(result.seed_records)
        append_records.extend(result.new_records)
        all_new.extend(result.new_records)
        # new records carry last_seen=today in the append itself — no re-touch
        last_seen_ids.extend(result.touched_ids)
        last_seen_ids.extend(result.reopened_ids)
        for rid in result.reopened_ids:
            status_changes[rid] = "New"
            all_new.append(history[rid])   # reopened roles surface in the push too
        for rid in result.closed_ids:
            status_changes[rid] = "Closed"
        if not c.seeded:
            newly_seeded.append(c.name)

        label = "ZERO" if not jobs else "OK"
        if label == "ZERO":
            summary.zero += 1
        else:
            summary.ok += 1
        health.append({"company": c.name, "ats": c.ats, "result": label,
                       "count": len(jobs), "message": "", "checked_at": today})

    # inline tagging at discovery: NEW roles only (never silent seeds), capped,
    # fanned across a thread pool. Overflow beyond the cap stays untagged for the
    # nightly review sweep, which now drains reliably. A tag failure never blocks
    # the append. Seeds are the batch driver — they go straight to review.
    tags_by_id: dict[str, tagging.Tags] = {}
    if tagger is not None:
        new_recs = [r for r in append_records if r.status == "New"][:cap]

        def _safe_tag(rec):
            try:
                return ("ok", tagger(rec, slugs.get(rec.company, "")))
            except Exception as e:
                return ("fail", str(e)[:200])

        results = tagworker.map_concurrent(new_recs, _safe_tag, workers=workers)
        for i, rec in enumerate(new_recs):
            out = results.get(i)
            if out is None:
                continue
            kind, val = out
            if kind == "fail":
                summary.tag_failed += 1
                print(f"[monitor] inline tag {rec.id} FAILED: {val}", file=sys.stderr)
            elif val is not None:
                tags_by_id[rec.id] = val
                summary.tagged += 1
            # val is None → no JD source; left for review.py

    # writes
    if append_records:
        store.append_jobs(append_records, tags=tags_by_id, today=today)
    if status_changes:
        store.set_status(status_changes)
    if last_seen_ids:
        store.set_last_seen(last_seen_ids, today)
    if newly_seeded:
        store.mark_seeded(newly_seeded)
    store.write_health(health)
    summary.new_count = len(all_new)

    # push policy: one push, only roles whose min required YoE clears the bar;
    # untagged/over-bar roles are a Feed count. Nothing new -> silence.
    if all_new and cfg.push_new_jobs:
        def yoe_of(rec: JobRecord) -> int | str:
            t = tags_by_id.get(rec.id)
            if t is not None:
                return t.min_yoe
            return tagging.min_yoe_from(known_min_yoe.get(rec.id, ""))

        matched = [r for r in all_new
                   if (y := yoe_of(r)) != "" and y <= cfg.yoe_push_max]
        if matched:
            comp = {r.id: tags_by_id[r.id].comp_range
                    for r in matched if r.id in tags_by_id}
            title, body = format_new_jobs(matched, comp,
                                          more_in_feed=len(all_new) - len(matched))
            if pusher(title, body, tags=["briefcase"], click=matched[0].url,
                      session=session):
                store.mark_pushed([r.id for r in matched], today)
                summary.pushed = len(matched)

    return summary


def main() -> int:
    import traceback

    reason = unconfigured_reason()
    if reason:
        print(f"[monitor] SKIPPED — {reason}", file=sys.stderr)
        return 1

    session = requests.Session()
    try:
        from core.sheets import HQ
        hq = HQ.open()
        cfg = get_runtime_config(hq)
        if cfg.problems:
            notify.ops_alert("HQ config problems",
                             "\n".join(cfg.problems)[:1500], session=session)
        store = HQFeedStore(hq)
        tagger = make_tagger() if os.environ.get("ANTHROPIC_API_KEY") else None
        s = run_monitor(store, cfg, session=session, tagger=tagger)
        print(f"[monitor] new={s.new_count} pushed={s.pushed} tagged={s.tagged} "
              f"ok={s.ok} zero={s.zero} errored={s.errored}", file=sys.stderr)
        snapshot.write_snapshot(SNAPSHOT_PATH, "hq", store.read_history())
        hq.heartbeat("monitor")
        return 0
    except Exception as e:   # whole-run failure: real cause to the log, ping ops
        print(f"[monitor] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("Monitor run FAILED", str(e)[:300], session=session)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
