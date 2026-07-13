"""Daily wide sweep — whole-market safety net via hiring.cafe (Apify actor).

WHY this shape (research/aggregator-apis.md, re-verified live 2026-07-13):
the self-hosted fetchers are free and real-time for known boards but cannot
economically cover Workday/Eightfold/iCIMS tenants or the custom big-tech
boards; hiring.cafe crawls all of those (46 ATS families incl. Microsoft/
Google/Amazon/Apple), and the memo23 pay-per-result actor turns it into JSON.
Budget: MAX_TERMS x MAX_PER_TERM results/day at $1.25/1k ≈ $4.50/mo worst
case — inside Apify's free $5/mo credit.

Actor contract (input schema fetched 2026-07-13): when startUrls is set the
keyword/location inputs are ignored, and startUrls is the only way to reach
searchState, whose honoured keys are searchQuery + sortBy:"date" (probe-
verified; page/date params are NOT honoured server-side — hence one small
newest-first pull per term + the client-side cursor). Location keys in
searchState are ignored too, but the SSR default is already US-centric
(probe: 115/128 US items). Item fields, probe-verified against the live SSR
payload: apply_url, job_information.title, v5_processed_company_data.name,
v5_processed_job_data.{core_job_title, formatted_workplace_location,
workplace_type, estimated_publish_date, seniority_level,
min_industry_and_role_yoe, is_min_industry_and_role_yoe_not_mentioned,
yearly_min/max_compensation}.

Incremental = Feed/Pipeline key dedupe (primary) + estimated_publish_date >
Config[wide_cursor] (belt+braces; undated items pass and rely on keys).
Weak (non-ATS) keys are skipped — wide rows must be safe to auto-merge on.
No per-item pushes: YoE-gated matches go out as ONE summary push, everything
else waits for Feed triage/digest. Rows land untagged (tagged_at="") so the
nightly review LLM-tags them like any other Feed row.

TheirStack (optional second source, THEIRSTACK_API_KEY): contractual API,
free tier 200 credits/mo, 1 credit per job RETURNED — so the query is fenced
to priority companies + title terms with limit 25, cursored server-side by
discovered_at_gte (Config[wide_theirstack_cursor]). Verified against their
OpenAPI spec 2026-07-13: POST /v1/jobs/search, Bearer auth, filters
company_name_case_insensitive_or/job_title_or/discovered_at_gte, response
{"data": [...]} with job_title/final_url/discovered_at/salary_string/remote/
seniority (no numeric YoE field — min_yoe stays "" for review to fill).
TheirStack failure logs and continues; it is never fatal.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from datetime import date, timedelta
from urllib.parse import quote

import requests

from core import notify
from core.jobkeys import is_strong, job_key
from core.sheets import HQ, RowNotFound, today as _today
from monitor.filtering import title_matches
from monitor.priority import known_keys, min_yoe_of, priority_companies

ACTOR_ID = "memo23/apify-hiring-cafe-scraper"
MAX_TERMS = 6
MAX_PER_TERM = 20            # 6x20/day ≈ $4.50/mo worst case — tune here, dedupe makes any cap safe
CAFE_CURSOR = "wide_cursor"
TS_CURSOR = "wide_theirstack_cursor"
TS_URL = "https://api.theirstack.com/v1/jobs/search"
TS_LIMIT = 25
PUSH_MAX_LINES = 12


def search_terms(include: list[str], cap: int = MAX_TERMS) -> list[str]:
    """Top query terms. A term containing an already-kept term is subsumed by
    it in a keyword engine ('senior product manager' ⊂ 'product manager'), so
    dropping it buys the result budget for genuinely distinct phrases."""
    kept: list[str] = []
    for t in (x.strip().lower() for x in include):
        if len(kept) >= cap:
            break
        if not t or any(k in t for k in kept):
            continue
        kept.append(t)
    return kept


def search_url(term: str) -> str:
    state = {"searchQuery": term, "sortBy": "date"}
    return "https://hiring.cafe/?searchState=" + quote(json.dumps(state, separators=(",", ":")))


def _comp_range(proc: dict) -> str:
    def k(v) -> str:
        return f"${round(v / 1000)}k"
    lo, hi = proc.get("yearly_min_compensation"), proc.get("yearly_max_compensation")
    if lo and hi:
        return f"{k(lo)}-{k(hi)}"
    if lo:
        return f"{k(lo)}+"
    if hi:
        return f"up to {k(hi)}"
    return ""


def _cafe_min_yoe(proc: dict) -> str:
    if proc.get("is_min_industry_and_role_yoe_not_mentioned"):
        return ""
    v = proc.get("min_industry_and_role_yoe")
    try:
        return "" if v in (None, "") else str(int(v))
    except (TypeError, ValueError):
        return ""


def map_cafe_item(item: dict, today: str) -> tuple[dict, str] | None:
    """Actor item -> (feed record, full publish iso for the cursor).
    None when there is no strong ATS key or no title — wide rows must be
    safe to dedupe/auto-merge on, so weak keys never enter the Feed."""
    info = item.get("job_information") or {}
    proc = item.get("v5_processed_job_data") or {}
    url = str(item.get("apply_url") or "").strip()
    key = job_key(url)
    if not key or not is_strong(key):
        return None
    title = str(info.get("title") or proc.get("core_job_title") or "").strip()
    if not title:
        return None
    posted_full = str(proc.get("estimated_publish_date") or "").strip()
    rec = {
        "key": key,
        "company": str((item.get("v5_processed_company_data") or {}).get("name") or "").strip(),
        "title": title,
        "location": str(proc.get("formatted_workplace_location") or "").strip(),
        "url": url, "status": "New",
        "first_seen": today, "last_seen": today,
        "posted": posted_full[:10],
        "comp_range": _comp_range(proc),
        "work_model": str(proc.get("workplace_type") or "").strip(),
        "seniority": str(proc.get("seniority_level") or "").strip(),
        "min_yoe": _cafe_min_yoe(proc),
    }
    return rec, posted_full


def map_theirstack_job(job: dict, today: str) -> tuple[dict, str] | None:
    """TheirStack job -> (feed record, discovered_at for the cursor)."""
    url = str(job.get("final_url") or job.get("url") or "").strip()
    key = job_key(url)
    if not key or not is_strong(key):
        return None
    title = str(job.get("job_title") or "").strip()
    if not title:
        return None
    company = job.get("company")
    if isinstance(company, dict):
        company = company.get("name")
    rec = {
        "key": key,
        "company": str(company or "").strip(),
        "title": title,
        "location": str(job.get("short_location") or job.get("location") or "").strip(),
        "url": url, "status": "New",
        "first_seen": today, "last_seen": today,
        "posted": str(job.get("date_posted") or "")[:10],
        "comp_range": str(job.get("salary_string") or "").strip(),
        "work_model": "Remote" if job.get("remote") else "",
        "seniority": str(job.get("seniority") or "").strip(),
        "min_yoe": "",   # no numeric YoE in TheirStack's schema — review fills it
    }
    return rec, str(job.get("discovered_at") or "").strip()


# ---------------------------------------------------------------- config IO

def _config_value(hq: HQ, key: str) -> str:
    for r in hq.tab("config").records():
        if (r.get("key") or "").strip() == key:
            return (r.get("value") or "").strip()
    return ""


def _upsert_config(hq: HQ, key: str, value: str, description: str) -> None:
    t = hq.tab("config")
    try:
        t.set_by_key(key, {"value": value}, key_header="key")
    except RowNotFound:
        t.append_records([{"key": key, "value": value, "description": description}])


def _default_cursor(today: str) -> str:
    """First activation bound: only the last 2 days, so turning the token on
    seeds a manageable batch instead of the whole newest page."""
    d = date.fromisoformat(today) - timedelta(days=2)
    return f"{d.isoformat()}T00:00:00Z"


def _theirstack_fetch(session: requests.Session, api_key: str, cursor: str,
                      companies: list[str], terms: list[str]) -> list[dict]:
    r = session.post(TS_URL, json={
        "limit": TS_LIMIT, "offset": 0,
        "discovered_at_gte": cursor,
        "company_name_case_insensitive_or": companies,
        "job_title_or": terms,
    }, headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        timeout=60)
    r.raise_for_status()
    return (r.json() or {}).get("data") or []


def _default_client_factory(token: str):
    from apify_client import ApifyClient   # lazy — tests inject fakes
    return ApifyClient(token)


@dataclass
class WideSummary:
    skipped: bool = False        # wide layer not activated (no APIFY_TOKEN)
    ok: bool = False             # at least one source swept successfully
    fetched: int = 0             # hiring.cafe items returned by the actor
    ts_fetched: int = 0
    appended: int = 0
    pushed: int = 0
    cursor: str = ""
    errors: list[str] = field(default_factory=list)


def run(hq: HQ, *, session: requests.Session | None = None, client_factory=None,
        push=notify.push, today: str | None = None) -> WideSummary:
    today = today or _today()
    s = WideSummary()

    token = os.environ.get("APIFY_TOKEN", "")
    if not token:  # system must be healthy before activation — skip is a clean state
        print("[wide] APIFY_TOKEN unset — wide layer not activated; skipping", file=sys.stderr)
        hq.log("wide", "skip", detail="APIFY_TOKEN unset — sweep not activated")
        hq.heartbeat("wide")
        s.skipped = True
        return s

    session = session or requests.Session()
    cfg = hq.user_config()
    if cfg.problems:
        hq.log("wide", "config_problem", detail="; ".join(cfg.problems)[:450])
    include, exclude = cfg["titles_include"], cfg["titles_exclude"]
    terms = search_terms(include)
    if not terms:
        hq.log("wide", "skip", detail="titles_include empty — nothing to sweep")
        hq.heartbeat("wide")
        s.skipped = True
        return s

    known = known_keys(hq)
    cursor = _config_value(hq, CAFE_CURSOR) or _default_cursor(today)
    s.cursor = cursor

    # -- hiring.cafe via the actor: one small newest-first run per term
    client = (client_factory or _default_client_factory)(token)
    items: list[dict] = []
    cafe_failed = 0
    for term in terms:
        try:
            info = client.actor(ACTOR_ID).call(run_input={
                "startUrls": [{"url": search_url(term)}],
                "maxItems": MAX_PER_TERM,
                "enrichDescription": False,   # feed rows don't need JD HTML; review tags via ATS APIs
            })
            items.extend(client.dataset(info["defaultDatasetId"]).iterate_items())
        except Exception as e:  # per-term quarantine
            cafe_failed += 1
            s.errors.append(f"cafe[{term}]: {e}")
            hq.log("wide", "cafe_error", detail=f"{term}: {str(e)[:200]}")
    cafe_ok = cafe_failed < len(terms)

    new_records: list[dict] = []
    max_seen = cursor
    for it in items:
        s.fetched += 1
        mapped = map_cafe_item(it, today)
        if mapped is None:
            continue
        rec, posted_full = mapped
        if posted_full > max_seen:
            max_seen = posted_full
        if not title_matches(rec["title"], include, exclude):
            continue
        if posted_full and posted_full <= cursor:   # belt+braces; keys are the real dedupe
            continue
        if rec["key"] in known:
            continue
        known.add(rec["key"])
        new_records.append(rec)

    # -- TheirStack: priority companies only (free tier = 200 credits/mo)
    ts_ok = False
    ts_cursor = ts_max = ""
    ts_key = os.environ.get("THEIRSTACK_API_KEY", "")
    if ts_key:
        names = [c.get("name", "") for c in priority_companies(hq) if c.get("name")]
        if not names:
            hq.log("wide", "theirstack_skip",
                   detail="no priority companies — not spending credits market-wide")
        else:
            ts_cursor = _config_value(hq, TS_CURSOR) or _default_cursor(today)
            try:
                jobs = _theirstack_fetch(session, ts_key, ts_cursor, names, terms)
                ts_ok = True
                ts_max = ts_cursor
                for job in jobs:
                    s.ts_fetched += 1
                    mapped = map_theirstack_job(job, today)
                    if mapped is None:
                        continue
                    rec, discovered = mapped
                    if discovered > ts_max:
                        ts_max = discovered
                    if not title_matches(rec["title"], include, exclude):
                        continue
                    if rec["key"] in known:
                        continue
                    known.add(rec["key"])
                    new_records.append(rec)
            except Exception as e:  # optional source — log + continue, never fatal
                s.errors.append(f"theirstack: {e}")
                hq.log("wide", "theirstack_error", detail=str(e)[:200])

    if not cafe_ok and not ts_ok:
        return s   # nothing swept: no heartbeat, so the watchdog fires; main ops-alerts

    if new_records:
        hq.tab("feed").append_records(new_records)
        s.appended = len(new_records)

    try:
        if max_seen != cursor:
            _upsert_config(hq, CAFE_CURSOR, max_seen,
                           "(auto) wide sweep — newest hiring.cafe publish date ingested")
            s.cursor = max_seen
        if ts_ok and ts_max and ts_max != ts_cursor:
            _upsert_config(hq, TS_CURSOR, ts_max,
                           "(auto) wide sweep — TheirStack discovered_at cursor")
    except Exception as e:  # cursor is an optimization; next run re-pulls, keys dedupe
        hq.log("wide", "cursor_write_failed", detail=str(e)[:200])

    pushable = [r for r in new_records
                if r["min_yoe"] and int(r["min_yoe"]) <= cfg["yoe_push_max"]]
    if pushable and cfg["push_new_jobs"]:   # same YoE gate as the daily monitor, ONE summary push
        lines = [f"• {r['title']} — {r['company']}" if r["company"] else f"• {r['title']}"
                 for r in pushable[:PUSH_MAX_LINES]]
        if len(pushable) > PUSH_MAX_LINES:
            lines.append(f"…and {len(pushable) - PUSH_MAX_LINES} more")
        push(f"Wide sweep: {len(pushable)} matching role(s)", "\n".join(lines),
             kind="jobs", tags=["telescope"], click=pushable[0]["url"], session=session)
        s.pushed = len(pushable)

    hq.log("wide", "sweep", detail=f"cafe={s.fetched} theirstack={s.ts_fetched} "
                                   f"appended={s.appended} pushed={s.pushed}")
    hq.heartbeat("wide")
    s.ok = True
    return s


def main() -> int:
    session = requests.Session()
    try:
        hq = HQ.open()
        s = run(hq, session=session)
    except Exception as e:
        print(f"[wide] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert("Wide sweep failed", str(e)[:250], session=session)
        return 1
    print(f"[wide] skipped={s.skipped} cafe={s.fetched} theirstack={s.ts_fetched} "
          f"appended={s.appended} pushed={s.pushed} errors={len(s.errors)}", file=sys.stderr)
    if s.errors:
        print(f"[wide] errors: {'; '.join(s.errors)}", file=sys.stderr)
    if s.skipped or s.ok:
        return 0
    notify.ops_alert("Wide sweep failed",
                     "; ".join(s.errors)[:250] or "no source succeeded", session=session)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
