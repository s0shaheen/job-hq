"""Live-endpoint smoke for every ATS family the monitor speaks.

    python -m monitor.scripts.smoke_adapters [--only ats1,ats2]

For each family: fetch one real company's list through the registry
(get_jobs_for), check job_key parity on everything fetched, then pull one
description through jobcontent.fetch_description. Prints a VERIFIED/FAIL
table and exits nonzero if any family fails — informative failures (status
code / first 120 chars) because this runs in CI from Azure datacenter IPs
where bot walls may differ from the residential IP the endpoints were
researched on (2026-07-13).

Runtime is kept under ~3 min by capping each fetcher's page loop (MAX_PAGES=2
where the module has one) — the smoke proves liveness, not corpus size.
Amazon/Google JD caches are popped first so the cold-cache fallback path
(what nightly review.py relies on) is what gets exercised.
"""
from __future__ import annotations

import argparse
import sys
import time

import requests

from core import jobkeys
from core.useragent import USER_AGENT
from monitor import jobcontent
from monitor.fetchers import _REGISTRY, get_jobs_for
from monitor.fetchers import amazon as amazon_fetcher
from monitor.fetchers import google as google_fetcher

PAGE_CAP = 2
MIN_DESC = 200     # a real JD is never shorter; a bot-wall page strips to less

# One live company per family — the smallest research-verified board of each.
# (ats, slug, company, search)
TARGETS: list[tuple[str, str, str, str]] = [
    ("greenhouse", "airbnb", "Airbnb", "product"),
    ("ashby", "openai", "OpenAI", "product"),
    ("lever", "spotify", "Spotify", "product"),
    ("smartrec", "canva", "Canva", "product"),
    ("workday", "salesforce.wd12.myworkdayjobs.com/External_Career_Site",
     "Salesforce", "product manager"),
    ("amazon", "amazon", "Amazon", "product manager"),
    ("eightfold", "paypal.eightfold.ai|paypal.com", "PayPal", "product manager"),
    ("oraclehcm", "eeho.fa.us2.oraclecloud.com|CX_45001", "Oracle", "product manager"),
    ("google", "google", "Google", "product manager"),
    ("apple", "apple", "Apple", "product manager"),
    ("goldman", "goldman", "Goldman Sachs", "product manager"),
    ("radancy", "jobs.intuit.com", "Intuit", "product manager"),
]

# job_key(url) intentionally falls back to url-… for these until
# core/jobkeys.py grows their patterns (see the fetcher docstrings).
KNOWN_KEYLESS = {"goldman", "radancy"}


def _cap_pages() -> None:
    for fn in set(_REGISTRY.values()):
        mod = sys.modules.get(fn.__module__)
        if mod is not None and hasattr(mod, "MAX_PAGES"):
            mod.MAX_PAGES = PAGE_CAP


def smoke_one(ats: str, slug: str, company: str, search: str,
              session: requests.Session) -> dict:
    row = {"ats": ats, "company": company, "jobs": 0, "parity": "-",
           "desc": 0, "secs": 0.0, "status": "FAIL", "note": ""}
    notes: list[str] = []
    t0 = time.time()
    try:
        jobs = get_jobs_for(ats, slug, company, session, workday_search=search)
        row["jobs"] = len(jobs)
        if not jobs:
            row["note"] = "0 jobs returned"
            return row
        bad = [j for j in jobs if jobkeys.job_key(j.url) != j.id]
        parity_ok = not bad
        if parity_ok:
            row["parity"] = "ok"
        elif ats in KNOWN_KEYLESS:
            parity_ok = True
            row["parity"] = "url-*"
            notes.append("keyless: jobkeys pattern pending")
        else:
            row["parity"] = f"{len(bad)}/{len(jobs)} bad"
            notes.append(f"job_key({bad[0].url}) != {bad[0].id}")
        j = jobs[0]
        # force the cold-cache path review.py depends on
        amazon_fetcher.DESCRIPTIONS.pop(j.native_id, None)
        google_fetcher.DESCRIPTIONS.pop(j.native_id, None)
        desc = jobcontent.fetch_description(ats, j.native_id, slug, j.url, session)
        row["desc"] = len(desc)
        if len(desc) < MIN_DESC:
            notes.append(f"desc too short ({len(desc)} chars) for {j.url}")
        elif parity_ok:
            row["status"] = "VERIFIED"
    except requests.HTTPError as e:
        resp = e.response
        code = resp.status_code if resp is not None else "?"
        body = (resp.text[:120].replace("\n", " ") if resp is not None else "")
        notes.append(f"HTTP {code}: {body}")
    except Exception as e:
        notes.append(f"{type(e).__name__}: {str(e)[:120]}")
    finally:
        row["note"] = "; ".join(notes)
        row["secs"] = round(time.time() - t0, 1)
    return row


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", default="", help="comma-separated ats subset")
    args = ap.parse_args()

    targets = TARGETS
    if args.only:
        want = {a.strip() for a in args.only.split(",") if a.strip()}
        unknown = want - {t[0] for t in TARGETS}
        if unknown:
            print(f"unknown ats: {', '.join(sorted(unknown))}", file=sys.stderr)
            return 2
        targets = [t for t in TARGETS if t[0] in want]

    _cap_pages()
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    rows = [smoke_one(*t, session=session) for t in targets]

    fmt = "{:<11} {:<14} {:>5} {:<7} {:>6} {:>6}  {:<8} {}"
    print(fmt.format("ats", "company", "jobs", "parity", "desc", "secs", "status", "note"))
    for r in rows:
        print(fmt.format(r["ats"], r["company"][:14], r["jobs"], r["parity"],
                         r["desc"], r["secs"], r["status"], r["note"]))
    failed = [r for r in rows if r["status"] != "VERIFIED"]
    print(f"\n{len(rows) - len(failed)}/{len(rows)} VERIFIED"
          + (f" — FAILED: {', '.join(r['ats'] for r in failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
