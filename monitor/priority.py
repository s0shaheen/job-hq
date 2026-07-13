"""Hourly priority watch — the hour-of-post signal for handpicked companies.

Scope is deliberately tiny: Companies-tab rows with monitor=TRUE AND
priority=TRUE (a handful). Each new title-matched role is appended to Feed
and pushed IMMEDIATELY, with NO YoE gate — unlike the daily monitor, these
pushes exist so Salman can apply within the hour; he triages by hand.

Division of labour with the daily monitor: it owns seeding, Health rows and
last_seen/Closed reconciliation; this watch only ever APPENDS new roles (and
back-fills tags on them). Companies not yet seeded are skipped so a freshly
added company gets its silent baseline from the daily run instead of a push
storm here. Tagging is strictly best-effort and runs AFTER every push — a
slow or failing JD fetch/LLM call must never delay the signal.
"""
from __future__ import annotations

import os
import sys
import traceback
from dataclasses import dataclass, field
from typing import Callable, Optional

import requests

from core import notify
from core.sheets import HQ, today as _today
from monitor import jobcontent, tagging
from monitor.fetchers import get_jobs_for
from monitor.filtering import title_matches
from monitor import geo
from monitor.models import Job

_TRUEISH = ("TRUE", "1", "YES")

Tagger = Callable[[Job, str], Optional[tagging.Tags]]


def truthy(v: str | None) -> bool:
    """Sheet-checkbox truth, same parse the monitor has always used."""
    return str(v or "").strip().upper() in _TRUEISH


def known_keys(hq: HQ) -> set[str]:
    """Keys already tracked anywhere — Feed ∪ Pipeline. Uses key_index so a
    duplicate key aborts loudly: dedupe is the backbone, never guess past it."""
    keys = set(hq.tab("feed").key_index())
    keys.update(hq.tab("pipeline").key_index())
    return keys


def priority_companies(hq: HQ) -> list[dict]:
    return [r for r in hq.tab("companies").records()
            if truthy(r.get("monitor")) and truthy(r.get("priority"))]


def _now() -> str:
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def _lines(jobs: list[Job]) -> str:
    lines = [f"• {j.title} — {j.location}" if j.location else f"• {j.title}"
             for j in jobs[:12]]
    if len(jobs) > 12:
        lines.append(f"…and {len(jobs) - 12} more")
    return "\n".join(lines)


def _default_tagger(session: requests.Session) -> Tagger | None:
    """Inline tagging so the Feed row lands complete; review.py sweeps rows
    without tagged_at nightly either way, so failure here costs nothing."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None

    def tag(job: Job, slug: str) -> tagging.Tags | None:
        jd = jobcontent.fetch_description(job.ats, job.native_id, slug, job.url, session)
        if not jd or not jd.strip():
            return None
        return tagging.extract_tags(jd, job.title, job.company)
    return tag


@dataclass
class PrioritySummary:
    attempted: int = 0            # seeded priority companies actually fetched
    new: int = 0
    pushes: int = 0
    tagged: int = 0
    skipped_unseeded: int = 0
    errors: list[str] = field(default_factory=list)


def run(hq: HQ, *, session: requests.Session | None = None, fetch=get_jobs_for,
        push=notify.push, tagger: Tagger | None | str = "auto",
        today: str | None = None) -> PrioritySummary:
    today = today or _today()
    session = session or requests.Session()
    s = PrioritySummary()

    cfg = hq.user_config()
    if cfg.problems:  # value already fell back to default; daily monitor ops-alerts
        hq.log("priority", "config_problem", detail="; ".join(cfg.problems)[:450])
    include, exclude = cfg["titles_include"], cfg["titles_exclude"]

    feed = hq.tab("feed")
    known = known_keys(hq)
    now = _now()
    pending: list[tuple[Job, str]] = []   # tag AFTER all pushes are out

    for c in priority_companies(hq):
        name, ats, slug = c.get("name", ""), c.get("ats", ""), c.get("slug", "")
        if not truthy(c.get("seeded")):
            s.skipped_unseeded += 1
            hq.log("priority", "skip_unseeded", detail=f"{name} — daily monitor seeds it first")
            continue
        s.attempted += 1
        try:
            jobs = fetch(ats, slug, name, session, workday_search=cfg["workday_search"])
        except Exception as e:  # quarantine: one company never kills the hourly watch
            s.errors.append(f"{name}: {e}")
            hq.log("priority", "fetch_error", detail=f"{name} ({ats}): {str(e)[:200]}")
            continue

        fresh = [j for j in jobs
                 if title_matches(j.title, include, exclude) and j.id not in known]
        if not fresh:
            continue
        known.update(j.id for j in fresh)
        feed.append_records([{
            "key": j.id, "company": j.company or name, "title": j.title,
            "location": j.location or "", "url": j.url, "status": "New",
            "first_seen": today, "last_seen": today, "posted": j.posted or "",
            "pushed_at": now, **geo.enrich(j.location or ""),
        } for j in fresh])
        for j in fresh:
            hq.log("priority", "new_role", key=j.id, detail=f"{name} — {j.title}")
        sent = push(f"Priority: {name} posted {len(fresh)} role(s)", _lines(fresh),
                    kind="jobs", tags=["dart"], priority="high",
                    click=fresh[0].url, session=session)
        if not sent:
            hq.log("priority", "push_failed", key=fresh[0].id, detail=name)
        s.pushes += 1
        s.new += len(fresh)
        pending.extend((j, slug) for j in fresh)

    tag = _default_tagger(session) if tagger == "auto" else tagger
    if tag:
        for j, slug in pending:
            try:
                t = tag(j, slug)
                if t is None:
                    continue
                feed.set_by_key(j.id, {
                    "yoe": t.yoe, "seniority": t.seniority,
                    "company_industry": t.company_industry, "role_focus": t.role_focus,
                    "skills": t.skills, "comp_range": t.comp_range,
                    "work_model": t.work_model, "min_yoe": t.min_yoe,
                    "tagged_at": today,
                })
                s.tagged += 1
            except Exception as e:  # push already went out; review retries tonight
                hq.log("priority", "tag_error", key=j.id, detail=str(e)[:200])

    all_failed = s.attempted and len(s.errors) == s.attempted
    if not all_failed:  # no heartbeat on a run that fetched nothing — watchdog must see it
        hq.heartbeat("priority")
    return s


def main() -> int:
    session = requests.Session()
    try:
        hq = HQ.open()
        s = run(hq, session=session)
    except Exception as e:
        print(f"[priority] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("Priority watch failed", str(e)[:250], session=session)
        return 1
    print(f"[priority] attempted={s.attempted} new={s.new} pushes={s.pushes} "
          f"tagged={s.tagged} skipped_unseeded={s.skipped_unseeded} "
          f"errors={len(s.errors)}", file=sys.stderr)
    if s.errors:
        print(f"[priority] errors: {'; '.join(s.errors)}", file=sys.stderr)
    if s.attempted and len(s.errors) == s.attempted:
        notify.ops_alert("Priority watch: every company failed",
                         "; ".join(s.errors)[:250], session=session)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
