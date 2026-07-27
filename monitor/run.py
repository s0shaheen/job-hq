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

from core import notify, outbox as core_outbox, pgwrites
from core.profile import Profile
from monitor import companysource, gates, geo, jobcontent, snapshot, tagging, tagworker
from monitor.config import RuntimeConfig, get_runtime_config, unconfigured_reason
from monitor.dedup import reconcile_company
from monitor.fetchers import get_jobs_for
from monitor.filtering import title_matches
from monitor.models import JobRecord
from monitor.notify import format_new_jobs
from monitor.sheet import HQFeedStore, SheetStore

INLINE_TAG_MAX_ENV = "MONITOR_INLINE_TAG_MAX"    # env override of the Config-tab inline_tag_max
STALE_DAYS = 14                      # board days-missing before a role is Closed
def snapshot_path(user: str = "") -> str:
    """Per-user snapshot file. A shared path would have three matrix legs
    overwriting each other's history every morning."""
    return f"monitor/snapshots/{user or 'hq'}.json"


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
    boards_done: int = 0
    boards_total: int = 0
    partial: bool = False    # budget hit: unvisited boards resume next run


def _inline_tag_max(cfg_default: int) -> int:
    """Env override wins (ops escape hatch); else the Config-tab knob."""
    raw = os.environ.get(INLINE_TAG_MAX_ENV)
    if raw is None:
        return max(0, cfg_default)
    try:
        return max(0, int(raw))
    except ValueError:
        return max(0, cfg_default)


def make_tagger(session_factory=requests.Session, *, jd_fetch=None, extract=None,
                domain: str = tagging.DEFAULT_DOMAIN):
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
        return extract(jd, rec.title, rec.company, domain=domain)
    return tag


FETCH_CHUNK = 120        # boards per fetch-flush cycle; writes land per chunk
RUNTIME_DEADLINE_ENV = "HQ_RUNTIME_DEADLINE_TS"   # wall-clock ts the runtime kills us (set by the Lambda shim)


def _clamp_deadline(started: float, deadline: float, budget: int) -> float:
    """Never let the sweep believe it has more time than the runtime will give it.

    run_budget_min is a Config-tab knob (up to 120m); Lambda's hard timeout is 900s. Past that
    the process is killed mid-flight and the end-of-run flush, feed snapshot and heartbeat are
    lost — strictly worse than the budget stop this clamp buys. `started` is monotonic and the
    exported deadline is wall-clock, so convert by remaining-seconds. Sooner wins, never later.
    """
    raw = os.environ.get(RUNTIME_DEADLINE_ENV)
    if not raw:
        return deadline
    import math
    import time as _time
    try:
        ts = float(raw)
        if not math.isfinite(ts):
            raise ValueError(raw)
    except ValueError:                   # a malformed hint is not a reason to skip the sweep
        print(f"[monitor] ignoring malformed {RUNTIME_DEADLINE_ENV}={raw!r}", file=sys.stderr)
        return deadline
    clamped = started + max(ts - _time.time(), 60.0)   # floor: a stop still needs room to flush
    if clamped >= deadline:
        return deadline
    print(f"[monitor] run_budget_min={budget}m outlives the runtime deadline — clamping to "
          f"{(clamped - started) / 60:.1f}m; lower run_budget_min in Config", file=sys.stderr)
    return clamped


def run_monitor(store: SheetStore, cfg: RuntimeConfig, *, fetch=get_jobs_for,
                tagger=None, today: str | None = None,
                session: requests.Session | None = None,
                pusher=None, inline_tag_max: int | None = None,
                inline_tag_workers: int | None = None,
                fetch_workers: int | None = None,
                budget_min: int | None = None,
                user: str = "", outbox=None, profile=None) -> RunSummary:
    """One reconcile pass, chunked: fetch FETCH_CHUNK boards concurrently
    (network only — every sheet write stays on this thread, per the core.sheets
    contract), reconcile serially, flush that chunk's writes, print progress,
    repeat. A killed or budget-stopped run keeps every flushed chunk; unvisited
    boards simply wait for the next run (reconcile is per-company, so partial
    runs never mis-close anything).

    tagger=None disables inline tagging (no ANTHROPIC_API_KEY, or tests) —
    review.py catches untagged rows nightly. pusher defaults late to
    core.notify.push so monkeypatching works.

    `user` decides WHOSE notification policy the push is judged against,
    `profile` is that user's Profile *with their Config-tab overlay applied*
    (without it the policy re-reads profile.yaml alone and every notify_* cell
    in the sheet is inert), and `outbox` (core.outbox.sink(hq)) is where a push
    suppressed by that user's quiet hours is held. None of the three is a
    channel check: this function no longer has one (core/channels.py owns it)."""
    import time as _time

    today = today or date.today().isoformat()
    session = session or requests.Session()
    pusher = pusher or notify.push
    cap = _inline_tag_max(cfg.inline_tag_max) if inline_tag_max is None else inline_tag_max
    workers = cfg.inline_tag_workers if inline_tag_workers is None else inline_tag_workers
    fworkers = cfg.fetch_workers if fetch_workers is None else fetch_workers
    budget = cfg.run_budget_min if budget_min is None else budget_min
    started = _time.monotonic()
    deadline = _clamp_deadline(started, started + budget * 60, budget)

    # SHEET-SUNSET Phase B: which store feeds the list is an env switch, with a
    # per-sweep sheet-vs-pg delta logged during the soak (monitor/companysource.py).
    companies = companysource.resolve(store)
    # Resume rotation: a budget-stopped run parks a cursor; the next run
    # starts there and wraps, so tail-of-sheet boards can never starve.
    cursor = store.read_sweep_cursor()
    if cursor:
        names = [c.name for c in companies]
        if cursor in names:
            i = names.index(cursor)
            companies = companies[i:] + companies[:i]
    history = store.read_history()
    known_min_yoe = store.read_min_yoe()   # for reopened roles tagged in a past run
    slugs = {c.name: c.slug for c in companies}
    summary = RunSummary(boards_total=len(companies))
    health: list[dict] = []
    next_cursor = ""

    all_new: list[JobRecord] = []          # fresh + reopened, discovery order
    tags_by_id: dict[str, tagging.Tags] = {}
    remaining_cap = cap

    get_session = tagworker.session_pool(requests.Session)

    def _fetch_one(c):
        s = session if fworkers <= 1 else get_session()
        try:
            jobs = fetch(c.ats, c.slug, c.name, s, workday_search=cfg.workday_search)
            return ("ok", [j for j in jobs
                           if title_matches(j.title, cfg.include, cfg.exclude)])
        except Exception as e:   # quarantine: one company never kills the run
            return ("err", str(e)[:200])

    def _inline_tag(new_recs):
        nonlocal remaining_cap
        take = new_recs[:max(0, remaining_cap)]
        remaining_cap -= len(take)
        if not take:
            return
        def _safe_tag(rec):
            try:
                return ("ok", tagger(rec, slugs.get(rec.company, "")))
            except Exception as e:
                return ("fail", str(e)[:200])
        results = tagworker.map_concurrent(take, _safe_tag, workers=workers)
        for i, rec in enumerate(take):
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

    for start in range(0, len(companies), FETCH_CHUNK):
        chunk = companies[start:start + FETCH_CHUNK]
        if _time.monotonic() > deadline:
            summary.partial = True
            next_cursor = chunk[0].name
            print(f"[monitor] budget {budget}m hit after "
                  f"{summary.boards_done}/{summary.boards_total} boards — "
                  f"flushed work is safe; next run resumes at {next_cursor!r}",
                  file=sys.stderr)
            break
        # deadline passed through: past it the pool stops STARTING boards, so
        # overshoot is bounded by the in-flight fetches, not a whole chunk
        fetched = tagworker.map_concurrent(chunk, _fetch_one, workers=fworkers,
                                           deadline=deadline)

        append_records: list[JobRecord] = []
        status_changes: dict[str, str] = {}
        last_seen_ids: list[str] = []
        newly_seeded: list[str] = []

        for i, c in enumerate(chunk):
            out = fetched.get(i)
            if out is None:      # deadline inside map_concurrent: unvisited
                continue
            summary.boards_done += 1
            kind, val = out
            if kind == "err":
                summary.errored += 1
                summary.error_companies.append(c.name)
                print(f"[monitor] {c.name} ({c.ats}) ERROR: {val}", file=sys.stderr)
                health.append({"company": c.name, "ats": c.ats, "result": "ERROR",
                               "count": 0, "message": val, "checked_at": today})
                continue
            jobs = val
            chist = {jid: r for jid, r in history.items() if r.company == c.name}
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

        # inline tagging BEFORE the append so tags (and the disposition they
        # unlock) ride the append itself. NEW roles only — never silent seeds.
        if tagger is not None and remaining_cap > 0:
            _inline_tag([r for r in append_records if r.status == "New"])

        # chunk flush: a timeout past this point can no longer lose this chunk
        if append_records:
            store.append_jobs(append_records, tags=tags_by_id, today=today)
        if status_changes:
            store.set_status(status_changes)
        if last_seen_ids:
            store.set_last_seen(last_seen_ids, today)
        if newly_seeded:
            store.mark_seeded(newly_seeded)
        elapsed = int(_time.monotonic() - started)
        print(f"[monitor] {summary.boards_done}/{summary.boards_total} boards · "
              f"new={len(all_new)} err={summary.errored} · {elapsed}s", file=sys.stderr)

        if len(fetched) < len(chunk):   # deadline hit inside the pool
            summary.partial = True
            missing = next(i for i in range(len(chunk)) if i not in fetched)
            next_cursor = chunk[missing].name
            print(f"[monitor] budget {budget}m hit mid-chunk — flushed work is "
                  f"safe; next run resumes at {next_cursor!r}", file=sys.stderr)
            break

    # park/clear the resume cursor (write only on change: no-op runs stay free)
    if summary.partial and next_cursor:
        store.write_sweep_cursor(next_cursor)
    elif cursor and not summary.partial:
        store.write_sweep_cursor("")

    # health is a full-tab rewrite: only safe when every board was visited,
    # else yesterday's rows for unvisited boards would be blanked away.
    if not summary.partial and summary.boards_done == summary.boards_total:
        store.write_health(health)
    summary.new_count = len(all_new)

    # push policy: one push, only QUALIFIED roles (gates: geo + YoE) whose min
    # required YoE also clears the tighter push bar; untagged/over-bar roles
    # are a Feed count. Nothing new -> silence.
    #
    # WHICH CHANNEL is not decided here. It used to be (`push_channel == "ntfy"`),
    # and the same check copied into priority.py while wide.py and digest.py
    # never got one is why it now lives in core.notify.push -> core.channels
    # (one enforcement point; see core/channels.py). An email-only user's
    # pusher call simply returns False, so nothing is marked pushed.
    if all_new and cfg.push_new_jobs:
        def yoe_of(rec: JobRecord) -> int | str:
            t = tags_by_id.get(rec.id)
            if t is not None:
                return t.min_yoe
            return tagging.min_yoe_from(known_min_yoe.get(rec.id, ""))

        def push_ok(rec: JobRecord, y) -> bool:
            if cfg.gates is None:
                return True
            t = tags_by_id.get(rec.id)
            row = dict(geo.enrich(rec.location, t.work_model if t else ""))
            row.update({"min_yoe": y, "seniority": t.seniority if t else "",
                        "tagged_at": today})
            return gates.dispose(row, cfg.gates)[0] == gates.QUALIFIED

        matched = [r for r in all_new
                   if (y := yoe_of(r)) != "" and y <= cfg.yoe_push_max
                   and push_ok(r, y)]
        if matched:
            comp = {r.id: tags_by_id[r.id].comp_range
                    for r in matched if r.id in tags_by_id}
            title, body = format_new_jobs(matched, comp,
                                          more_in_feed=len(all_new) - len(matched))
            if pusher(title, body, event="new_roles", tags=["briefcase"],
                      click=matched[0].url, session=session, user=user,
                      outbox=outbox, profile=profile):
                store.mark_pushed([r.id for r in matched], today)
                summary.pushed = len(matched)

    return summary


def mirror_pg(hq, *, session=None) -> str:
    """Phase C's promotion: the store is written BY the sweep, not after it.

    Returns a one-word status for the run log ('skipped' in Phase A). Raises on
    any store failure, which is the entire point of the flag — see
    `core/pgwrites.py`.

    WRITE ORDER, and why it is sheet-lane-first-then-pg rather than interleaved:

    the sheet lane has no transaction and flushes every FETCH_CHUNK boards, so a
    pg write placed inside that loop turns a store outage into a Feed that is
    mirrored for the first N chunks and not the rest, with nothing recording
    where the boundary fell. Run last, over the FINISHED Feed, the failure is
    atomic in the only sense available here: the sheet is complete and correct,
    the store is untouched-or-stale, and the NEXT sweep replays the whole Feed
    through the same idempotent upsert and converges. The sheet lane is also the
    one a human is reading this morning; it must never be the lane a pg outage
    leaves half written.

    Placed before `hq.heartbeat("monitor")` for the same reason: under
    first_class a sweep that could not write the store did not finish, and the
    beat is what the digest's watchdog reads to say so.
    """
    if not pgwrites.first_class():
        return "skipped"
    from monitor import pgmirror
    n1, n2, _dropped = pgmirror.mirror(hq, pgwrites.user_id(), session=session)
    return f"postings={n1} user_postings={n2}"


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
        prof = Profile.load(hq.user, cfg=hq.user_config())
        if cfg.problems:
            notify.ops_alert("HQ config problems",
                             "\n".join(cfg.problems)[:1500], session=session)
        disposer = gates.make_disposer(cfg.gates) if cfg.gates else None
        store = HQFeedStore(hq, disposer=disposer)
        tagger = (make_tagger(domain=prof.tag_domain)
                  if os.environ.get("ANTHROPIC_API_KEY") else None)
        if tagger is None:
            print("::warning title=Monitor tagging skipped::ANTHROPIC_API_KEY unset — "
                  "new rows land untagged (review.py will drain them if the key "
                  "exists there)")
        s = run_monitor(store, cfg, session=session, tagger=tagger, user=hq.user,
                        outbox=core_outbox.sink(hq), profile=prof)
        print(f"[monitor] boards={s.boards_done}/{s.boards_total} new={s.new_count} "
              f"pushed={s.pushed} tagged={s.tagged} ok={s.ok} zero={s.zero} "
              f"errored={s.errored} partial={s.partial}", file=sys.stderr)
        if s.partial:
            print(f"::warning title=Monitor partial run::budget hit at "
                  f"{s.boards_done}/{s.boards_total} boards — flushed work kept; "
                  f"rest resumes next run")
        snapshot.write_snapshot(snapshot_path(hq.user), hq.user or "hq",
                                store.read_history())
        # SHEET-SUNSET Phase C. Sheet lane complete (flushed, snapshotted) before
        # the store is touched, and the store before the heartbeat: see mirror_pg.
        pg_status = mirror_pg(hq, session=session)
        print(f"[monitor] pg={pg_status}", file=sys.stderr)
        hq.heartbeat("monitor")
        return 0
    except Exception as e:   # whole-run failure: real cause to the log, ping ops
        print(f"[monitor] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("Monitor run FAILED", str(e)[:300], session=session)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
