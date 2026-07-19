"""Daily Simplify.jobs tracker sync -> pipeline.

    python -m tracker.simplify

Simplify has no export/API; this uses the same private endpoint its own web
app calls, with Salman's session cookies (research/simplify-export.md). Posture:
- Skips cleanly (WITH heartbeat, so the watchdog stays quiet pre-activation)
  unless Config simplify_enabled AND both env secrets are set.
- Auth failure (the one expected fragility: JWT expiry) -> one ops alert per
  day (deduped via Config key simplify_alert_date) pointing at the RUNBOOK
  re-capture step, exit 0, NO heartbeat — the digest's health section keeps
  flagging it until the cookie is re-pasted.
- Simplify only auto-captures the "applied" event; Gmail owns downstream status
  changes. So: saved -> Inbox row; applied/screen/interview/offer -> create or
  fill-blanks; terminal states only ever SUGGEST (humans win).

Item field names are not publicly documented (the only OSS client dumps raw
JSON), so extraction is defensive: nested job_posting/company shapes with
flat fallbacks, and unmappable items are counted, never guessed.
"""
from __future__ import annotations

import os
import time

import requests

from core import notify, schema
from core.jobkeys import job_key
from core.sheets import HQ, RowNotFound, today

API = "https://api.simplify.jobs/v2"
PAGE_SIZE = 100
PAGE_DELAY = 1.0        # polite: the reference scraper sleeps 1s/page
TIMEOUT = 30
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
RUNBOOK = "docs/RUNBOOK.md — 'Simplify re-auth'"

STATUS_NAMES = {1: "saved", 2: "applied", 11: "screen", 12: "interview",
                13: "offer", 21: "withdrawn", 22: "ghosted", 23: "rejected",
                24: "accepted"}
CREATE_STATUS = {"applied": "Applied", "screen": "Screen",
                 "interview": "Interview", "offer": "Offer"}
SUGGEST_STATUS = {"rejected": "Rejected", "withdrawn": "Withdrawn",
                  "ghosted": "Closed"}


def _first(*vals) -> str:
    for v in vals:
        if v:
            return str(v)
    return ""


def _extract(item: dict) -> dict:
    jp = item.get("job_posting") or item.get("job") or {}
    if not isinstance(jp, dict):
        jp = {}
    comp = jp.get("company") or item.get("company") or {}
    company = comp.get("name", "") if isinstance(comp, dict) else str(comp)
    status = item.get("status")
    try:
        name = STATUS_NAMES.get(int(status), "")
    except (TypeError, ValueError):
        name = str(status or "").strip().lower()
    return {
        "title": _first(jp.get("title"), item.get("title"), item.get("job_title")),
        "company": _first(company, item.get("company_name")),
        "url": _first(jp.get("url"), item.get("url"), item.get("link"), item.get("job_url")),
        "date": _first(item.get("date_applied"), item.get("applied_date"),
                       item.get("created_at"), item.get("updated_at"))[:10],
        "status_name": name,
    }


def _fetch_all(session, cookies: dict, headers: dict) -> list[dict]:
    items: list[dict] = []
    page = 0
    while True:
        r = session.get(f"{API}/candidate/me/tracker/",
                        params={"size": PAGE_SIZE, "page": page,
                                "archived": "false", "value": ""},
                        cookies=cookies, headers=headers, timeout=TIMEOUT)
        if r.status_code != 200:
            print(f"[simplify] page {page} HTTP {r.status_code} — stopping with "
                  f"{len(items)} items (partial sync is safe: idempotent by key)")
            break
        data = r.json() or {}
        batch = data.get("items") or []
        items.extend(batch)
        total = data.get("total")
        if len(batch) < PAGE_SIZE or (isinstance(total, int) and len(items) >= total):
            break
        page += 1
        time.sleep(PAGE_DELAY)
    return items


def _alert_once_per_day(hq: HQ, today_s: str) -> bool:
    """Dedupe the cookie-expired alert via Config so a dead JWT nags exactly
    once a day, not on every scheduled run."""
    t = hq.tab("config")
    try:
        current = {r.get("key", ""): r.get("value", "") for r in t.records()}
    except Exception:
        current = {}
    if current.get("simplify_alert_date") == today_s:
        return False
    notify.ops_alert(
        "Simplify auth expired",
        "POST /v2/auth/validate returned non-200 — the session cookie died.\n"
        f"Re-capture SIMPLIFY_AUTH_COOKIE + SIMPLIFY_CSRF ({RUNBOOK}).")
    try:
        t.set_by_key("simplify_alert_date", {"value": today_s}, key_header="key")
    except RowNotFound:
        t.append_records([{"key": "simplify_alert_date", "value": today_s,
                           "description": "(auto) last Simplify auth-failure alert"}])
    return True


def _apply(hq: HQ, items: list[dict]) -> dict:
    pipe = hq.tab("pipeline")
    have = set(pipe.key_index())
    counts = {"saved_new": 0, "filled": 0, "created": 0, "suggested": 0,
              "skipped": 0, "unkeyed": 0}
    appends: list[dict] = []
    appended_keys: set[str] = set()
    for item in items:
        x = _extract(item)
        name = x["status_name"]
        key = job_key(url=x["url"], company=x["company"], title=x["title"])
        if not key:
            counts["unkeyed"] += 1
            continue
        exists = key in have or key in appended_keys
        if name == "saved":
            if exists:
                counts["skipped"] += 1
            else:
                appends.append({schema.KEY: key, "company": x["company"],
                                "title": x["title"], "url": x["url"],
                                "source": "simplify", "status": "Inbox"})
                appended_keys.add(key)
                counts["saved_new"] += 1
        elif name in CREATE_STATUS:
            if key in have:
                pipe.set_by_key(key, {"applied_via": "simplify",
                                      "applied_date": x["date"]},
                                only_if_blank=True)
                counts["filled"] += 1
            elif not exists:
                appends.append({schema.KEY: key, "company": x["company"],
                                "title": x["title"], "url": x["url"],
                                "source": "simplify", "status": CREATE_STATUS[name],
                                "applied_via": "simplify", "applied_date": x["date"]})
                appended_keys.add(key)
                counts["created"] += 1
                hq.log("simplify", "created", key,
                       f"{x['company']} — {CREATE_STATUS[name]}")
        elif name in SUGGEST_STATUS:
            if key in have:
                pipe.set_by_key(key, {"suggested_status": SUGGEST_STATUS[name]},
                                only_if_blank=True)
                counts["suggested"] += 1
                hq.log("simplify", "suggested", key,
                       f"{x['company']} -> {SUGGEST_STATUS[name]}")
            else:
                counts["skipped"] += 1   # never create a row just to bury it
        else:
            counts["skipped"] += 1       # accepted / unknown enum
    pipe.append_records(appends)
    return counts


def run(hq: HQ, *, session: requests.Session | None = None,
        env=None) -> dict | None:
    env = env if env is not None else os.environ
    cfg = hq.user_config()
    auth = env.get("SIMPLIFY_AUTH_COOKIE", "")
    csrf = env.get("SIMPLIFY_CSRF", "")
    if not cfg.get("simplify_enabled") or not (auth and csrf):
        why = "disabled in Config" if not cfg.get("simplify_enabled") else "secrets unset"
        print(f"[simplify] skipped ({why})")
        if why == "secrets unset":
            # a green run that did nothing must say so where the operator looks
            print("::warning title=Simplify import skipped::SIMPLIFY_AUTH_COOKIE/"
                  "SIMPLIFY_CSRF unset — channel contributing 0 rows (set the "
                  "repo secrets, or set Config simplify_enabled=false to silence)")
        hq.heartbeat("simplify")
        return None

    session = session or requests.Session()
    cookies = {"authorization": auth, "csrf": csrf}
    headers = {"x-csrf-token": csrf, "Origin": "https://simplify.jobs",
               "Accept": "application/json", "User-Agent": UA}
    r = session.post(f"{API}/auth/validate", cookies=cookies, headers=headers,
                     timeout=TIMEOUT)
    if r.status_code != 200:
        _alert_once_per_day(hq, today())
        print(f"[simplify] auth validate HTTP {r.status_code} — skipping sync")
        return None

    counts = _apply(hq, _fetch_all(session, cookies, headers))
    hq.log("simplify", "sync", detail=str(counts))
    hq.heartbeat("simplify")
    print("[simplify] " + "  ".join(f"{k}={v}" for k, v in counts.items()))
    return counts


def main() -> int:
    run(HQ.open())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
