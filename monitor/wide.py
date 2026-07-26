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
Every request must satisfy TheirStack's mandatory-filter rule (E-024) with a
date or company identifier — see theirstack_body. TheirStack failure logs and
continues; it is never fatal.
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

from core import notify, outbox
from core.jobkeys import is_strong, job_key
from core.sheets import HQ, RowNotFound, today as _today
from monitor import gates, geo
from monitor.filtering import title_matches
from monitor.priority import known_keys, priority_companies

ACTOR_ID = "memo23/apify-hiring-cafe-scraper"
MAX_TERMS = 6
MAX_PER_TERM = 20            # 6x20/day ≈ $4.50/mo worst case — tune here, dedupe makes any cap safe
CAFE_CURSOR = "wide_cursor"
TS_CURSOR = "wide_theirstack_cursor"
TS_URL = "https://api.theirstack.com/v1/jobs/search"
TS_LIMIT = 25
TS_TIMEOUT = 30      # per-request seconds; TheirStack is optional and must never hang the sweep
# Rolling posted-date window for bodies with no company fence — see
# theirstack_body for WHY it is a fixed window and NOT derived from the cursor.
TS_UNFENCED_MAX_AGE_DAYS = 30
# Apify's .call() BLOCKS until the actor run finishes. On the free tier a run
# can sit QUEUED indefinitely waiting for memory or credit — which is exactly
# how this sweep went from 2-4 minutes to hitting the 15-minute workflow
# timeout with no output. Both bounds are needed: timeout_secs stops the run
# server-side, wait_secs stops us waiting for it.
CAFE_RUN_TIMEOUT = 120      # seconds the actor run may take, server-side
CAFE_WAIT = 150             # seconds we will wait for it before giving up
PUSH_MAX_LINES = 12


def _beat(sources: tuple[str, ...]) -> str:
    """Heartbeat name per source, so a dead cafe and a dead TheirStack are
    distinguishable in the digest instead of one ambiguous `wide` gap."""
    if tuple(sources) == ("cafe",):
        return "cafe"
    if tuple(sources) == ("theirstack",):
        return "theirstack"
    return "wide"


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
    rec.update(geo.enrich(rec["location"], rec["work_model"]))
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
    rec.update(geo.enrich(rec["location"], rec["work_model"]))
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


def theirstack_body(cursor: str, terms: list[str], *,
                    companies: list[str] | None = None,
                    company_domains: list[str] | None = None,
                    location_ids: list[int] | None = None,
                    limit: int = TS_LIMIT, preview: bool = False) -> dict:
    """Request body for either search shape.

    company-fenced (the original): "new jobs at these N employers".
    geo-first (a local search like Chicagoland FP&A): "every matching job in
    this metro, ANY employer" — `job_location_or` takes structured catalog IDs
    (the older location *pattern* params are deprecated).

    MANDATORY FILTER (E-024, keyed probe 2026-07-26): every jobs/search request
    must carry at least one of
      ['posted_at_max_age_days', 'posted_at_gte', 'posted_at_lte', 'job_id_or',
       'job_export_key_or', 'company_name_or', 'company_name_case_insensitive_or',
       'company_name_partial_match_or', 'company_id_or', 'company_domain_or',
       'company_linkedin_url_or']
    and `discovered_at_gte` is NOT on that list — a discovered_at-only query
    422s. So any body without a company fence also carries a posted-date bound:
    a FIXED rolling window (`posted_at_max_age_days = TS_UNFENCED_MAX_AGE_DAYS`),
    deliberately DECOUPLED from the discovered_at cursor.

    WHY decoupled: deriving the posted floor FROM the cursor ANDs an unrelated
    bound onto every query — the cursor is a *discovered_at* high-water mark, so
    a job posted before the last run but discovered after it fails the posted
    floor and is dropped PERMANENTLY (the cursor only moves forward). ~14% of
    this repo's rows carry >=1 day of discovery lag
    (docs/research/aggregator-apis.md:32), so that is a real, silent, recurring
    loss. Every posted_at bound loses *something* (E-024 forces one on unfenced
    queries); a wide rolling window loses only jobs posted >30d before they were
    discovered — rare and stale — instead of everything since the last run.
    discovered_at_gte stays alongside it as the incremental/dedup filter: a
    valid *narrowing* filter, just not a mandatory-satisfying one. Prior art:
    monitor/oracle.py:51 (build_body already sends posted_at_max_age_days for
    exactly this reason); probe-verified free under blur (2026-07-26).
    The company-fenced production shape is exempt (its fence satisfies the
    rule) and stays byte-identical — the nightly wide_theirstack job runs it.

    The cursor is also what stops us re-buying yesterday's rows: billing is
    1 credit per job RETURNED, and a repeat pull is charged again.

    Fencing prefers domains: the 2026-07-26 probe showed name fences are
    unreliable ("Kraft Heinz" matched 3 companies, "Allstate" 6), while
    company_domain_or is exact. Names stay the fallback for universes that
    have no domain yet.

    preview=True asks for blurred company data, which the API serves WITHOUT
    consuming credits. NOT yet a sizing call: nothing here sets
    include_total_results, _theirstack_fetch discards `metadata`, and
    map_theirstack_job has no has_blurred_data guard — so a preview today yields
    blurred rows and no count. Free sizing works in monitor/oracle.py; see
    docs/plans/COMPANY-DISCOVERY-RESEARCH.md → "Geo-lane activation gaps".
    """
    body: dict = {"limit": limit, "offset": 0,
                  "discovered_at_gte": cursor,
                  "job_title_or": list(terms)}
    if company_domains:
        body["company_domain_or"] = list(company_domains)
    elif companies:
        body["company_name_case_insensitive_or"] = list(companies)
    if location_ids:
        body["job_location_or"] = [{"id": int(i)} for i in location_ids]
    if preview:
        # blur is incompatible with company-identifier filters (vendor docs)
        body.pop("company_name_case_insensitive_or", None)
        body.pop("company_domain_or", None)
        body["blur_company_data"] = True
    if not (body.get("company_domain_or") or body.get("company_name_case_insensitive_or")):
        body["posted_at_max_age_days"] = TS_UNFENCED_MAX_AGE_DAYS   # E-024 — see above
    return body


def _theirstack_fetch(session: requests.Session, api_key: str, cursor: str,
                      companies: list[str], terms: list[str],
                      location_ids: list[int] | None = None,
                      limit: int = TS_LIMIT, preview: bool = False,
                      company_domains: list[str] | None = None) -> list[dict]:
    body = theirstack_body(cursor, terms, companies=companies,
                           company_domains=company_domains,
                           location_ids=location_ids, limit=limit, preview=preview)
    r = session.post(TS_URL, json=body,
                     headers={"Authorization": f"Bearer {api_key}",
                              "Accept": "application/json"},
                     timeout=TS_TIMEOUT)
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
    ts_mode: str = ""            # "geo" | "companies" | "" (not run)
    ts_truncated: bool = False   # budget capped the window; cursor held back
    appended: int = 0
    pushed: int = 0
    cursor: str = ""
    errors: list[str] = field(default_factory=list)


SOURCES = ("cafe", "theirstack")


def run(hq: HQ, *, session: requests.Session | None = None, client_factory=None,
        push=notify.push, today: str | None = None,
        sources: tuple[str, ...] = SOURCES) -> WideSummary:
    """Sweep the aggregator layer.

    `sources` selects which to run. They are scheduled as SEPARATE workflows
    on purpose: hiring.cafe (a blocking Apify actor run) and TheirStack (a
    plain HTTP API) have nothing in common but a destination — different
    vendors, cost models, failure modes and latencies. Sharing one process
    meant a queued Apify run consumed the whole workflow budget and TheirStack
    never got called at all. Independent sources get independent jobs,
    independent timeouts and independent alerts; they share only the feed
    concurrency lane, so their appends still serialize.
    """
    today = today or _today()
    s = WideSummary()
    want_cafe = "cafe" in sources
    want_ts = "theirstack" in sources

    token = os.environ.get("APIFY_TOKEN", "") if want_cafe else "skip"
    if want_cafe and not token:  # healthy pre-activation state, not a failure
        print("[wide] APIFY_TOKEN unset — cafe not activated; skipping", file=sys.stderr)
        hq.log("wide", "skip", detail="APIFY_TOKEN unset — sweep not activated")
        hq.heartbeat(_beat(sources))
        s.skipped = True
        return s

    session = session or requests.Session()
    cfg = hq.user_config()
    if cfg.problems:
        hq.log("wide", "config_problem", detail="; ".join(cfg.problems)[:450])
    from core.profile import Profile
    prof = Profile.load(getattr(hq, "user", ""), cfg=cfg)
    include, exclude = prof.titles_include, prof.titles_exclude
    gate_cfg = prof.gate_config()
    terms = search_terms(include)
    if not terms:
        hq.log("wide", "skip", detail="titles_include empty — nothing to sweep")
        hq.heartbeat(_beat(sources))
        s.skipped = True
        return s

    known = known_keys(hq)
    cursor = _config_value(hq, CAFE_CURSOR) or _default_cursor(today)
    s.cursor = cursor

    # -- hiring.cafe via the actor: one small newest-first run per term
    client = (client_factory or _default_client_factory)(token)
    items: list[dict] = []
    cafe_failed = 0
    for term in (terms if want_cafe else []):
        print(f"[wide] cafe: querying {term!r}", file=sys.stderr)
        try:
            info = client.actor(ACTOR_ID).call(
                run_input={
                    "startUrls": [{"url": search_url(term)}],
                    "maxItems": MAX_PER_TERM,
                    "enrichDescription": False,   # feed rows don't need JD HTML; review tags via ATS APIs
                },
                timeout_secs=CAFE_RUN_TIMEOUT, wait_secs=CAFE_WAIT)
            if not info or not info.get("defaultDatasetId"):
                # queued-but-never-started, or killed by timeout_secs. An
                # optional source must degrade to a logged miss, never a hang.
                raise RuntimeError(
                    f"actor did not finish within {CAFE_WAIT}s "
                    f"(status={(info or {}).get('status', 'no run')}) — "
                    f"usually an exhausted Apify credit or memory queue")
            items.extend(client.dataset(info["defaultDatasetId"]).iterate_items())
        except Exception as e:  # per-term quarantine
            cafe_failed += 1
            s.errors.append(f"cafe[{term}]: {e}")
            print(f"[wide] cafe[{term}] FAILED: {str(e)[:200]}", file=sys.stderr)
            hq.log("wide", "cafe_error", detail=f"{term}: {str(e)[:200]}")
    cafe_ok = (cafe_failed < len(terms)) if want_cafe else False

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

    # -- TheirStack: geo-first when the profile names location IDs (a local
    # search: "any employer in this metro"), else fenced to priority companies.
    ts_ok = False
    ts_cursor = ts_max = ""
    ts_key = os.environ.get("THEIRSTACK_API_KEY", "") if want_ts else ""
    if want_ts and not ts_key:
        # green-but-dead is banned: an unconfigured channel must say so in CI,
        # not just in the sheet's Log tab
        print("::warning title=TheirStack skipped::THEIRSTACK_API_KEY unset — "
              "channel contributing 0 jobs (add the repo secret to activate)")
        hq.log("wide", "theirstack_skip", detail="THEIRSTACK_API_KEY unset")
    if ts_key:
        raw_ids = list(cfg.get("wide_location_ids") or [])
        loc_ids = [int(x) for x in raw_ids if str(x).strip().isdigit()]
        if raw_ids and not loc_ids:
            # silently falling back to a company-fenced query would spend
            # credits on the wrong search and look healthy doing it
            print("::warning title=wide_location_ids invalid::"
                  f"{raw_ids!r} are not numeric TheirStack catalog IDs — "
                  f"geo-first sweep NOT active (GET /v0/catalog/locations)")
            hq.log("wide", "bad_location_ids", detail=str(raw_ids)[:200])
        budget = int(cfg.get("wide_credit_budget", TS_LIMIT) or 0)
        names = [c.get("name", "") for c in priority_companies(hq) if c.get("name")]
        if not loc_ids and not names:
            hq.log("wide", "theirstack_skip",
                   detail="no location ids and no priority companies — "
                          "not spending credits market-wide")
        elif budget <= 0:
            hq.log("wide", "theirstack_skip", detail="wide_credit_budget is 0")
        else:
            ts_cursor = _config_value(hq, TS_CURSOR) or _default_cursor(today)
            print(f"[wide] theirstack: mode={'geo' if loc_ids else 'companies'} "
                  f"budget={budget} companies={len(names)} since={ts_cursor}",
                  file=sys.stderr)
            try:
                # 1 credit per job RETURNED, so the budget is enforced as the
                # request limit — the API can never hand back more than we
                # agreed to pay for. Geo-first drops the company fence.
                jobs = _theirstack_fetch(
                    session, ts_key, ts_cursor,
                    [] if loc_ids else names, terms,
                    location_ids=loc_ids or None, limit=min(budget, 500))
                s.ts_mode = "geo" if loc_ids else "companies"
                # A FULL page means the window held more than the budget
                # bought. The API does not promise an order, so advancing the
                # cursor past a truncated page would skip the remainder
                # forever — a metro-wide query routinely matches far more than
                # one page. Keep the cursor; the next run re-reads the same
                # window (bounded, deduped by key) instead of losing jobs.
                s.ts_truncated = len(jobs) >= min(budget, 500)
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
                print(f"[wide] theirstack FAILED (non-fatal): {str(e)[:200]}",
                      file=sys.stderr)
                hq.log("wide", "theirstack_error", detail=str(e)[:200])

    # failure = NONE of the sources we were asked to run succeeded. No
    # heartbeat, so the watchdog fires and main() ops-alerts.
    attempted = [ok for want, ok in ((want_cafe, cafe_ok), (want_ts, ts_ok)) if want]
    if attempted and not any(attempted):
        return s

    if new_records:
        for rec in new_records:   # gates at append (cafe rows often carry min_yoe)
            d, r = gates.dispose(rec, gate_cfg)
            rec["disposition"], rec["disposition_reason"] = d, r
        hq.tab("feed").append_records(new_records)
        s.appended = len(new_records)

    try:
        if max_seen != cursor:
            _upsert_config(hq, CAFE_CURSOR, max_seen,
                           "(auto) wide sweep — newest hiring.cafe publish date ingested")
            s.cursor = max_seen
        if ts_ok and ts_max and ts_max != ts_cursor and not s.ts_truncated:
            _upsert_config(hq, TS_CURSOR, ts_max,
                           "(auto) wide sweep — TheirStack discovered_at cursor")
        elif s.ts_truncated:
            print(f"::warning title=TheirStack window truncated::the budget "
                  f"({s.ts_fetched} jobs) filled the page, so more matched than "
                  f"was fetched; cursor held so nothing is skipped. Raise "
                  f"wide_credit_budget or narrow the query.")
            hq.log("wide", "theirstack_truncated",
                   detail=f"{s.ts_fetched} returned = budget; cursor held")
    except Exception as e:  # cursor is an optimization; next run re-pulls, keys dedupe
        hq.log("wide", "cursor_write_failed", detail=str(e)[:200])

    pushable = [r for r in new_records
                if r.get("disposition") != gates.FILTERED   # qualified-only pushes (WS1)
                and r["min_yoe"] and int(r["min_yoe"]) <= cfg["yoe_push_max"]]
    if pushable and cfg["push_new_jobs"]:   # same YoE gate as the daily monitor, ONE summary push
        lines = [f"• {r['title']} — {r['company']}" if r["company"] else f"• {r['title']}"
                 for r in pushable[:PUSH_MAX_LINES]]
        if len(pushable) > PUSH_MAX_LINES:
            lines.append(f"…and {len(pushable) - PUSH_MAX_LINES} more")
        # this call had NO channel check at all until the policy moved into
        # core.notify.push (core/channels.py) — an email-only user got swept
        # roles pushed to a topic they never watch. `profile=prof` carries the
        # Config-tab overlay loaded above; without it the notify_* cells are inert.
        push(f"Wide sweep: {len(pushable)} matching role(s)", "\n".join(lines),
             event="new_roles", kind="jobs", tags=["telescope"],
             click=pushable[0]["url"], session=session,
             user=getattr(hq, "user", ""), outbox=outbox.sink(hq), profile=prof)
        s.pushed = len(pushable)

    hq.log("wide", "sweep", detail=f"cafe={s.fetched} theirstack={s.ts_fetched} "
                                   f"appended={s.appended} pushed={s.pushed}")
    hq.heartbeat(_beat(sources))
    s.ok = True
    return s


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m monitor.wide")
    ap.add_argument("--source", choices=[*SOURCES, "all"], default="all",
                    help="run ONE aggregator; they are scheduled separately so "
                         "one vendor stalling cannot starve the other")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)
    sources = SOURCES if a.source == "all" else (a.source,)

    session = requests.Session()
    try:
        hq = HQ.open()
        s = run(hq, session=session, sources=sources)
    except Exception as e:
        print(f"[wide] FAILED:\n{traceback.format_exc()}", file=sys.stderr)
        notify.ops_alert(f"Wide sweep failed ({a.source})", str(e)[:250], session=session)
        return 1
    print(f"[wide] skipped={s.skipped} cafe={s.fetched} theirstack={s.ts_fetched} "
          f"appended={s.appended} pushed={s.pushed} errors={len(s.errors)}", file=sys.stderr)
    if s.errors:
        print(f"[wide] errors: {'; '.join(s.errors)}", file=sys.stderr)
    if s.skipped or s.ok:
        return 0
    notify.ops_alert(f"Wide sweep failed ({a.source})",
                     "; ".join(s.errors)[:250] or "no source succeeded", session=session)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
