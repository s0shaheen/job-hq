"""Nightly tagging sweep (entry: python -m monitor.review).

The catch-all that drains every open Feed row still untagged — inline-cap
overflow, an LLM hiccup at discovery, a JD source that was down, or the whole
silent backlog of a freshly-seeded company. It is a drain-the-queue worker over
the sheet: untagged-open rows are the pending set, tagged_at is the done-cursor,
so a killed run loses nothing and the next one resumes.

Three things keep the queue from clogging (the failure mode that used to leave
large batches permanently blank):
  * Concurrency — fetch+extract is network I/O, fanned across a thread pool;
    all sheet writes stay on this thread (durability contract untouched).
  * Sentinels — a permanent no-JD source (unknown ATS, missing slug, delisted
    job) is stamped "no-jd:<date>" so it stops being retried every night and
    starving the time budget.
  * Dead-letter — a row that keeps RAISING (a delisted 404, an ATS that always
    500s for one job) gets bounded in-run retries; once it has been pending for
    `deadletter_days` (i.e. survived that many nightly sweeps still failing) it
    is stamped "failed:<date>" and given up on. Age off first_seen, not a counter
    column: a required new column would abort every feed read/write until
    self-heal added it — a far worse failure than the feature is worth.

Skips cleanly without ANTHROPIC_API_KEY (tagging is an enhancement, never a
blocker); per-job failures are quarantined; a systemic failure or a high
leftover backlog pings ops.
"""
from __future__ import annotations

import os
import sys
import time as _time
from dataclasses import dataclass, field
from datetime import date

import requests

from core import notify
from monitor import gates, geo, jobcontent, tagging, tagworker
from monitor.config import unconfigured_reason
from monitor.sheet import HQFeedStore, SheetStore


@dataclass
class ReviewSummary:
    tagged: int = 0
    skipped_no_jd: int = 0
    failed: int = 0
    deadlettered: int = 0
    backlog: int = 0            # open+untagged rows still pending after this run
    fail_companies: list = field(default_factory=list)


def _int_arg(val, env: str, default: int) -> int:
    """Explicit arg wins; else env; else committed default (never crash on a
    bad env value — fall back like every other knob)."""
    if val is not None:
        return max(0, int(val))
    try:
        return max(0, int(os.environ.get(env, str(default))))
    except ValueError:
        return default


def _days_since(first_seen: str, today: str) -> int:
    """Nightly sweeps a row has survived still-untagged. Unparseable/blank
    first_seen -> 0, so a row is never dead-lettered on bad data (keep retrying,
    never wrongly give up)."""
    try:
        return (date.fromisoformat(today) - date.fromisoformat(first_seen)).days
    except (ValueError, TypeError):
        return 0


def review_feed(store: SheetStore, *, today: str | None = None,
                session: requests.Session | None = None,
                fetch=None, extract=None,
                flush_every: int = 100,
                time_budget_min: float | None = None,
                workers: int | None = None,
                retry_max: int | None = None,
                deadletter_days: int | None = None,
                sleep=None, backoff=None, session_factory=None,
                gate_cfg=None) -> ReviewSummary:
    """Drain the untagged-open Feed rows.

    fetch/extract default late (None) so tests can monkeypatch the modules.
    Tags flush every `flush_every` rows and each chunk is bounded by the
    `time_budget_min` deadline (env REVIEW_TIME_BUDGET_MIN, default 40), so a big
    backlog makes durable progress even if the run is killed and the next run
    simply continues. `workers` fans fetch+extract concurrently (env
    REVIEW_WORKERS, default 8); every sheet write stays on this thread.
    """
    today = today or date.today().isoformat()
    session = session or requests.Session()
    fetch = fetch or jobcontent.fetch_description
    extract = extract or tagging.extract_tags
    if time_budget_min is None:
        time_budget_min = float(os.environ.get("REVIEW_TIME_BUDGET_MIN", "40"))
    workers = _int_arg(workers, "REVIEW_WORKERS", 8)
    retry_max = _int_arg(retry_max, "REVIEW_TAG_RETRY", 2)
    deadletter_days = _int_arg(deadletter_days, "REVIEW_DEADLETTER_DAYS", 4)
    sleep = sleep or _time.sleep
    backoff = backoff or tagworker.default_backoff
    deadline = _time.monotonic() + time_budget_min * 60

    slug_by_company = {c.name: c.slug for c in store.read_companies()}
    summary = ReviewSummary()

    pending = [rec for rec, tagged_at in store.read_jobs_for_tagging()
               if not tagged_at and rec.status != "Closed"]
    ctx_by_id = store.tagging_context()
    # Tag only rows that can still qualify: a row already gated out never
    # needs a Haiku call — with ~half the feed non-US this halves LLM spend
    # and the backlog drains twice as fast. The STORED disposition is the
    # authority (each producer stamped it under its own policy — priority's
    # geo-unknown benefit-of-the-doubt included); only legacy rows with no
    # stamp yet are gated here, from stored geo first, enrich as fallback.
    if gate_cfg is not None:
        skipped = 0
        kept = []
        for rec in pending:
            ctx = ctx_by_id.get(rec.id, {})
            d = (ctx.get("disposition") or "").strip()
            if d == gates.FILTERED:
                skipped += 1
                continue
            if not d:   # pre-disposition row (the legacy 4,500 until regate runs)
                g = {k: ctx.get(k, "") for k in ("country", "remote", "market")}
                if not any(v.strip() for v in g.values()):
                    g = geo.enrich(rec.location, ctx.get("work_model", ""))
                if gates.dispose({**g, "min_yoe": "", "tagged_at": ""},
                                 gate_cfg)[0] == gates.FILTERED:
                    skipped += 1
                    continue
            kept.append(rec)
        if skipped:
            print(f"[review] {skipped} filtered row(s) excluded from "
                  f"tagging (no LLM spend on filtered rows)", file=sys.stderr)
        pending = kept
    locations = {rec.id: rec.location for rec in pending}

    # One session per worker thread (requests.Session is not thread-safe); the
    # serial fast-path reuses the passed session so behaviour is identical to
    # the old single-threaded sweep and tests stay deterministic.
    get_session = tagworker.session_pool(session_factory or requests.Session)

    def _session():
        return session if workers <= 1 else get_session()

    def _work(rec):
        """Side-effect-free: returns ("ok", Tags) | ("nojd", None) | ("fail", msg).
        Bounded in-run retry-with-backoff rides out a transient 429/5xx/timeout."""
        ats, _, native_id = rec.id.partition("-")
        slug = slug_by_company.get(rec.company, "")
        last = ""
        for attempt in range(retry_max + 1):
            try:
                jd = fetch(ats, native_id, slug, rec.url, _session())
                if not jd or not jd.strip():
                    return ("nojd", None)
                return ("ok", extract(jd, rec.title, rec.company))
            except Exception as e:
                last = str(e)[:200]
                if attempt < retry_max:
                    sleep(backoff(attempt))
        return ("fail", last)

    updates: dict = {}
    no_jd_ids: list[str] = []
    deadletter_ids: list[str] = []

    def flush():
        if updates:
            store.write_tags(dict(updates), today, locations=locations)
            updates.clear()

    # Chunk so a huge backlog writes durably as it goes and the deadline is
    # re-checked between chunks; within a chunk the work fans out concurrently.
    chunk = max(flush_every, workers)
    stopped = False
    for i in range(0, len(pending), chunk):
        if _time.monotonic() > deadline:
            stopped = True
            break
        batch = pending[i:i + chunk]
        results = tagworker.map_concurrent(batch, _work, workers=workers, deadline=deadline)
        for j, rec in enumerate(batch):
            out = results.get(j)
            if out is None:          # deadline skipped it — stays pending, retried next run
                continue
            kind, val = out
            if kind == "ok":
                updates[rec.id] = val
                summary.tagged += 1
                if len(updates) >= flush_every:
                    flush()
            elif kind == "nojd":
                no_jd_ids.append(rec.id)
                summary.skipped_no_jd += 1
            else:
                summary.failed += 1
                summary.fail_companies.append(rec.company)
                # a row that keeps failing past the grace window is stuck (delisted
                # 404, dead endpoint) — give up so it stops eating the budget
                if _days_since(rec.first_seen, today) >= deadletter_days:
                    deadletter_ids.append(rec.id)
                    summary.deadlettered += 1
                # else: stays pending, retried next run
        if len(results) < len(batch):   # deadline hit mid-chunk
            stopped = True
            break

    flush()
    if no_jd_ids:
        store.mark_untaggable(no_jd_ids, today, "no-jd")
    if deadletter_ids:
        store.mark_untaggable(deadletter_ids, today, "failed")
    if gate_cfg is not None and (no_jd_ids or deadletter_ids):
        # tagging gave up on these — re-gate under the yoe-unknown policy so a
        # fetch failure never leaves a real geo-qualified posting invisible.
        # Stored geo/seniority win (append-time enrich saw work_model; wide
        # rows carry seniority without tags); enrich is only the legacy fallback.
        by_id = {rec.id: rec for rec in pending}
        dispo = {}
        for jid in no_jd_ids + deadletter_ids:
            rec = by_id.get(jid)
            if rec is None:
                continue
            stored = ctx_by_id.get(jid, {})
            g = {k: stored.get(k, "") for k in ("country", "remote", "market")}
            if not any(v.strip() for v in g.values()):
                g = dict(geo.enrich(rec.location, stored.get("work_model", "")))
            g.update({"min_yoe": "", "seniority": stored.get("seniority", ""),
                      "tagged_at": "x"})
            dispo[jid] = gates.dispose(g, gate_cfg)
        if dispo:
            store.set_disposition(dispo)

    resolved = summary.tagged + summary.skipped_no_jd + summary.deadlettered
    summary.backlog = max(0, len(pending) - resolved)
    if stopped:
        print(f"[review] time budget reached — {summary.backlog} row(s) still "
              f"pending; the next run continues from tagged_at", file=sys.stderr)
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
        cfg = hq.user_config()
        gate_cfg = gates.GateConfig.from_user_config(cfg)
        store = HQFeedStore(hq, disposer=gates.make_disposer(gate_cfg))
        geo_n = store.fill_missing_geo()
        if geo_n:
            print(f"[review] geo_fill: {geo_n} rows", file=sys.stderr)
        s = review_feed(store, session=session,
                        workers=cfg["review_workers"],
                        retry_max=cfg["tag_retry_max"],
                        deadletter_days=cfg["tag_deadletter_days"],
                        gate_cfg=gate_cfg)
        print(f"[review] tagged={s.tagged} skipped_no_jd={s.skipped_no_jd} "
              f"failed={s.failed} deadlettered={s.deadlettered} "
              f"backlog={s.backlog}", file=sys.stderr)
        hq.heartbeat("review")   # liveness: the sweep ran, whatever it found

        alert_at = cfg["untagged_backlog_alert"]
        if alert_at and s.backlog >= alert_at:
            # backlog outran the sweep for real — surface it before it compounds
            msg = (f"{s.backlog} Feed row(s) still untagged after the sweep "
                   f"(alert threshold {alert_at}). Check REVIEW_TIME_BUDGET_MIN / "
                   f"review_workers, or a systemic JD-fetch outage.")
            print(f"[review] BACKLOG: {msg}", file=sys.stderr)
            notify.ops_alert("Tagging backlog high", msg, session=session)
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
