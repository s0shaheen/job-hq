# PM Job Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-secret, profile-based daily job monitor that polls public ATS APIs (Greenhouse/Ashby/Lever/SmartRecruiters/Workday), surfaces only new PM roles into a Google Sheet, pushes them to my phone via ntfy, and tracks status + contacts — built so the fragile parts can never take down the reliable core.

**Architecture:** Pure-logic core (`filtering`, `dedup`) with zero I/O is unit-tested exhaustively. Fetchers split into pure `parse()` + thin HTTP `fetch()`. The Google Sheet sits behind a `SheetStore` protocol with an in-memory fake, so `run.py` (the orchestrator) is testable end-to-end offline. Apify and the daily run itself are wrapped so any failure is logged to a Health tab and/or pushed as an alert, never silent. GitHub Actions runs it on cron with only a static service-account key as a secret.

**Tech Stack:** Python 3.11+, `requests`, `gspread` + `google-auth`, `PyYAML`, `pytest`. GitHub Actions cron. ntfy.sh.

---

## File Structure

```
job-monitor/
├── profiles/
│   └── pm.yaml                      # the only profile wired in v1
├── src/
│   ├── __init__.py
│   ├── models.py                    # Job, Company, JobRecord, Profile, ReconcileResult
│   ├── filtering.py                 # title include/exclude (pure)
│   ├── dedup.py                     # reconcile_company: seed/new/reopen/touch/close (pure)
│   ├── config.py                    # load profile YAML
│   ├── fetchers/
│   │   ├── __init__.py              # ats -> get_jobs registry
│   │   ├── greenhouse.py
│   │   ├── ashby.py
│   │   ├── lever.py
│   │   ├── smartrecruiters.py
│   │   └── workday.py
│   ├── sheet.py                     # SheetStore protocol, FakeSheetStore, GspreadSheetStore
│   ├── notify.py                    # ntfy push / heartbeat / failure / digest (format = pure)
│   ├── snapshot.py                  # write-only JSON backup
│   ├── apify.py                     # quarantined long-tail fetch
│   ├── discover.py                  # CLI: probe endpoints to find ats+slug
│   └── run.py                       # orchestrate one profile end-to-end
├── tests/
│   ├── fixtures/                    # sample ATS JSON payloads
│   └── test_*.py
├── .github/workflows/monitor.yml
├── companies.seed.csv               # 131 zero-secret companies to bootstrap the Sheet
├── requirements.txt
├── .env.example
└── README.md
```

**Status values:** `New · Seen · Reviewing · Applied · Interviewing · Offer · Rejected · Skip · Closed`.
**System statuses** (auto-transitionable): `New`, `Seen`, `Closed`. Everything else is user-owned and never overwritten.

**Sheet tabs / columns:**
- `Companies`: `name, ats, slug, monitor, seeded`  (user fills first four; `seeded` is system-managed)
- `Jobs`: `id, company, title, location, url, status, first_seen, last_seen, posted`  (`id` immutable, do not edit)
- `Contacts`: `company, name, title, linkedin_url, source, priority, status, next_action, last_touch, notes`
- `Health`: `company, ats, result, count, message, checked_at`  (overwritten each run)

---

## Task 0: Project scaffolding

**Files:**
- Create: `requirements.txt`, `.env.example`, `pytest.ini`, `src/__init__.py`, `src/fetchers/__init__.py` (empty for now), `tests/__init__.py`

- [ ] **Step 1: Create `requirements.txt`**

```
requests==2.32.3
gspread==6.1.4
google-auth==2.35.0
PyYAML==6.0.2
pytest==8.3.3
```

- [ ] **Step 2: Create `.env.example`**

```
# JSON contents of the Google service-account key (single line)
GOOGLE_SERVICE_ACCOUNT_JSON=
# ntfy topic for ops/failure alerts (the daily run uses each profile's own topic)
MONITOR_OPS_NTFY_TOPIC=salman-monitor-ops-CHANGEME
# Optional: only needed once Apify companies are added
APIFY_TOKEN=
```

- [ ] **Step 3: Create `pytest.ini`**

```ini
[pytest]
testpaths = tests
python_files = test_*.py
addopts = -q
```

- [ ] **Step 4: Create empty package files**

Create `src/__init__.py`, `src/fetchers/__init__.py`, `tests/__init__.py` as empty files.

- [ ] **Step 5: Create venv and install**

Run: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
Expected: installs without error.

- [ ] **Step 6: Commit**

```bash
git add requirements.txt .env.example pytest.ini src/ tests/
git commit -m "chore: project scaffolding"
```

---

## Task 1: Data models

**Files:**
- Create: `src/models.py`
- Test: `tests/test_models.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_models.py
from src.models import Job, JobRecord


def test_job_id_combines_ats_and_native_id():
    job = Job(ats="greenhouse", native_id="123", company="Stripe",
              title="PM", location="NYC", url="http://x", posted="2026-05-01")
    assert job.id == "greenhouse-123"


def test_job_to_record_sets_dates_and_status():
    job = Job(ats="ashby", native_id="abc", company="Ramp",
              title="Sr PM", location="NY", url="http://y", posted="2026-05-20")
    rec = job.to_record(status="New", today="2026-05-26")
    assert rec.id == "ashby-abc"
    assert rec.status == "New"
    assert rec.first_seen == "2026-05-26"
    assert rec.last_seen == "2026-05-26"
    assert rec.company == "Ramp"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.models'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/models.py
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class Job:
    ats: str
    native_id: str
    company: str
    title: str
    location: str
    url: str
    posted: str = ""

    @property
    def id(self) -> str:
        return f"{self.ats}-{self.native_id}"

    def to_record(self, status: str, today: str) -> "JobRecord":
        return JobRecord(
            id=self.id, company=self.company, title=self.title,
            location=self.location, url=self.url, status=status,
            first_seen=today, last_seen=today, posted=self.posted,
        )


@dataclass
class JobRecord:
    id: str
    company: str
    title: str
    location: str
    url: str
    status: str
    first_seen: str
    last_seen: str
    posted: str = ""


@dataclass
class Company:
    name: str
    ats: str
    slug: str
    monitor: bool = True
    seeded: bool = False


@dataclass
class Profile:
    name: str
    sheet_id: str
    ntfy_topic: str
    include: list[str]
    exclude: list[str]
    workday_search: str = "product"
    digest_weekday: int = 0  # Monday


@dataclass
class ReconcileResult:
    new_records: list[JobRecord] = field(default_factory=list)
    seed_records: list[JobRecord] = field(default_factory=list)
    reopened_ids: list[str] = field(default_factory=list)
    touched_ids: list[str] = field(default_factory=list)
    closed_ids: list[str] = field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_models.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/models.py tests/test_models.py
git commit -m "feat: data models (Job, JobRecord, Company, Profile, ReconcileResult)"
```

---

## Task 2: Title filtering

**Files:**
- Create: `src/filtering.py`
- Test: `tests/test_filtering.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_filtering.py
from src.filtering import title_matches

INCLUDE = ["product manager", "head of product", "technical product manager"]
EXCLUDE = ["product marketing", "product design", "program manager"]


def test_matches_basic_pm_title():
    assert title_matches("Senior Product Manager", INCLUDE, EXCLUDE) is True


def test_case_insensitive():
    assert title_matches("HEAD OF PRODUCT", INCLUDE, EXCLUDE) is True


def test_exclude_wins_over_include():
    # contains "product manager" (include) AND "product marketing" (exclude)
    assert title_matches("Product Manager, Product Marketing", INCLUDE, EXCLUDE) is False


def test_program_manager_excluded():
    assert title_matches("Technical Program Manager", INCLUDE, EXCLUDE) is False


def test_unrelated_title_not_matched():
    assert title_matches("Staff Software Engineer", INCLUDE, EXCLUDE) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_filtering.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/filtering.py
from __future__ import annotations


def title_matches(title: str, include: list[str], exclude: list[str]) -> bool:
    t = title.lower()
    if any(term.lower() in t for term in exclude):
        return False
    return any(term.lower() in t for term in include)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_filtering.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add src/filtering.py tests/test_filtering.py
git commit -m "feat: title include/exclude filtering (exclude wins)"
```

---

## Task 3: Reconcile (seed / new / reopen / touch / stale-close) — the core logic

**Files:**
- Create: `src/dedup.py`
- Test: `tests/test_dedup.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_dedup.py
from src.models import Job, JobRecord
from src.dedup import reconcile_company

TODAY = "2026-05-26"


def _job(nid, title="PM"):
    return Job(ats="greenhouse", native_id=nid, company="Stripe",
               title=title, location="NYC", url="http://x", posted="")


def _rec(nid, status, last_seen):
    return JobRecord(id=f"greenhouse-{nid}", company="Stripe", title="PM",
                     location="NYC", url="http://x", status=status,
                     first_seen="2026-01-01", last_seen=last_seen)


def test_unseeded_company_seeds_all_without_new():
    r = reconcile_company({}, [_job("1"), _job("2")], seeded=False, today=TODAY, stale_days=14)
    assert {rec.id for rec in r.seed_records} == {"greenhouse-1", "greenhouse-2"}
    assert all(rec.status == "Seen" for rec in r.seed_records)
    assert r.new_records == []


def test_seeded_brand_new_job_is_new():
    r = reconcile_company({}, [_job("9")], seeded=True, today=TODAY, stale_days=14)
    assert [rec.id for rec in r.new_records] == ["greenhouse-9"]


def test_seeded_existing_new_job_seen_again_is_touched_only():
    history = {"greenhouse-1": _rec("1", "New", "2026-05-20")}
    r = reconcile_company(history, [_job("1")], seeded=True, today=TODAY, stale_days=14)
    assert r.new_records == []
    assert r.touched_ids == ["greenhouse-1"]


def test_closed_job_reappears_is_reopened():
    history = {"greenhouse-1": _rec("1", "Closed", "2026-04-01")}
    r = reconcile_company(history, [_job("1")], seeded=True, today=TODAY, stale_days=14)
    assert r.reopened_ids == ["greenhouse-1"]
    assert r.new_records == []


def test_user_status_job_missing_and_stale_is_not_closed():
    history = {"greenhouse-1": _rec("1", "Applied", "2026-01-01")}
    r = reconcile_company(history, [], seeded=True, today=TODAY, stale_days=14)
    assert r.closed_ids == []


def test_new_job_missing_and_stale_is_closed():
    history = {"greenhouse-1": _rec("1", "New", "2026-05-01")}  # 25 days ago
    r = reconcile_company(history, [], seeded=True, today=TODAY, stale_days=14)
    assert r.closed_ids == ["greenhouse-1"]


def test_new_job_missing_but_not_yet_stale_is_left_alone():
    history = {"greenhouse-1": _rec("1", "New", "2026-05-20")}  # 6 days ago
    r = reconcile_company(history, [], seeded=True, today=TODAY, stale_days=14)
    assert r.closed_ids == []
    assert r.touched_ids == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_dedup.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/dedup.py
from __future__ import annotations
from datetime import date

from src.models import Job, JobRecord, ReconcileResult

SYSTEM_STATUSES = {"New", "Seen", "Closed"}


def _days_between(earlier_iso: str, today_iso: str) -> int | None:
    try:
        return (date.fromisoformat(today_iso) - date.fromisoformat(earlier_iso)).days
    except (ValueError, TypeError):
        return None


def reconcile_company(
    history: dict[str, JobRecord],
    fetched: list[Job],
    seeded: bool,
    today: str,
    stale_days: int = 14,
) -> ReconcileResult:
    """Pure: compute what to write for ONE company. No I/O.

    history: existing JobRecords for this company keyed by id.
    fetched: jobs currently on this company's board (already title-filtered).
    seeded: whether this company has been observed before.
    """
    result = ReconcileResult()
    fetched_ids = {j.id for j in fetched}

    if not seeded:
        for j in fetched:
            if j.id not in history:
                result.seed_records.append(j.to_record(status="Seen", today=today))
        return result

    for j in fetched:
        rec = history.get(j.id)
        if rec is None:
            result.new_records.append(j.to_record(status="New", today=today))
        elif rec.status == "Closed":
            result.reopened_ids.append(j.id)
        else:
            result.touched_ids.append(j.id)

    for rid, rec in history.items():
        if rid in fetched_ids:
            continue
        if rec.status in ("New", "Seen"):
            age = _days_between(rec.last_seen, today)
            if age is not None and age >= stale_days:
                result.closed_ids.append(rid)

    return result
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_dedup.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add src/dedup.py tests/test_dedup.py
git commit -m "feat: reconcile_company core logic (seed/new/reopen/touch/stale-close)"
```

---

## Task 4: Profile config loading

**Files:**
- Create: `src/config.py`
- Test: `tests/test_config.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_config.py
from src.config import load_profile


def test_load_profile(tmp_path):
    p = tmp_path / "pm.yaml"
    p.write_text(
        "name: pm\n"
        "sheet_id: SHEET123\n"
        "ntfy_topic: topic-x7f2\n"
        "include: ['product manager']\n"
        "exclude: ['product marketing']\n"
        "workday_search: product\n"
        "digest_weekday: 0\n"
    )
    prof = load_profile(str(p))
    assert prof.name == "pm"
    assert prof.sheet_id == "SHEET123"
    assert prof.ntfy_topic == "topic-x7f2"
    assert prof.include == ["product manager"]
    assert prof.exclude == ["product marketing"]
    assert prof.workday_search == "product"
    assert prof.digest_weekday == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/config.py
from __future__ import annotations
import glob
import os

import yaml

from src.models import Profile


def load_profile(path: str) -> Profile:
    with open(path) as f:
        data = yaml.safe_load(f)
    return Profile(
        name=data["name"],
        sheet_id=data["sheet_id"],
        ntfy_topic=data["ntfy_topic"],
        include=list(data["include"]),
        exclude=list(data["exclude"]),
        workday_search=data.get("workday_search", "product"),
        digest_weekday=int(data.get("digest_weekday", 0)),
    )


def list_profiles(profiles_dir: str = "profiles") -> list[Profile]:
    return [load_profile(p) for p in sorted(glob.glob(os.path.join(profiles_dir, "*.yaml")))]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_config.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add src/config.py tests/test_config.py
git commit -m "feat: profile YAML loading"
```

---

## Task 5: Greenhouse fetcher

**Files:**
- Create: `src/fetchers/greenhouse.py`, `tests/fixtures/greenhouse.json`
- Test: `tests/test_fetcher_greenhouse.py`

- [ ] **Step 1: Create the fixture**

```json
// tests/fixtures/greenhouse.json
{"jobs": [
  {"id": 401, "title": "Senior Product Manager", "absolute_url": "https://boards.greenhouse.io/stripe/jobs/401",
   "location": {"name": "New York"}, "updated_at": "2026-05-20T10:00:00-04:00"},
  {"id": 402, "title": "Staff Software Engineer", "absolute_url": "https://boards.greenhouse.io/stripe/jobs/402",
   "location": {"name": "Remote"}, "updated_at": "2026-05-19T10:00:00-04:00"}
]}
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_fetcher_greenhouse.py
import json
from pathlib import Path
from src.fetchers.greenhouse import parse

FIX = json.loads((Path(__file__).parent / "fixtures/greenhouse.json").read_text())


def test_parse_greenhouse():
    jobs = parse(FIX, company="Stripe")
    assert len(jobs) == 2
    j = jobs[0]
    assert j.ats == "greenhouse"
    assert j.native_id == "401"
    assert j.title == "Senior Product Manager"
    assert j.location == "New York"
    assert j.url == "https://boards.greenhouse.io/stripe/jobs/401"
    assert j.posted == "2026-05-20T10:00:00-04:00"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fetcher_greenhouse.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 4: Write minimal implementation**

```python
# src/fetchers/greenhouse.py
from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30


def parse(payload: dict, company: str) -> list[Job]:
    jobs = []
    for j in payload.get("jobs", []):
        loc = (j.get("location") or {}).get("name", "") or ""
        jobs.append(Job(
            ats="greenhouse", native_id=str(j["id"]), company=company,
            title=j.get("title", ""), location=loc,
            url=j.get("absolute_url", ""), posted=j.get("updated_at", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false"
    resp = session.get(url, timeout=TIMEOUT)
    resp.raise_for_status()
    return parse(resp.json(), company)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_fetcher_greenhouse.py -v`
Expected: PASS (1 passed)

- [ ] **Step 6: Commit**

```bash
git add src/fetchers/greenhouse.py tests/fixtures/greenhouse.json tests/test_fetcher_greenhouse.py
git commit -m "feat: greenhouse fetcher"
```

---

## Task 6: Ashby fetcher

**Files:**
- Create: `src/fetchers/ashby.py`, `tests/fixtures/ashby.json`
- Test: `tests/test_fetcher_ashby.py`

- [ ] **Step 1: Create the fixture**

```json
// tests/fixtures/ashby.json
{"jobs": [
  {"id": "uuid-aaa", "title": "Product Manager", "location": "San Francisco",
   "jobUrl": "https://jobs.ashbyhq.com/ramp/uuid-aaa", "publishedDate": "2026-05-22"},
  {"id": "uuid-bbb", "title": "Product Designer", "location": "Remote",
   "jobUrl": "https://jobs.ashbyhq.com/ramp/uuid-bbb", "publishedDate": "2026-05-21"}
]}
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_fetcher_ashby.py
import json
from pathlib import Path
from src.fetchers.ashby import parse

FIX = json.loads((Path(__file__).parent / "fixtures/ashby.json").read_text())


def test_parse_ashby():
    jobs = parse(FIX, company="Ramp")
    assert len(jobs) == 2
    j = jobs[0]
    assert j.ats == "ashby"
    assert j.native_id == "uuid-aaa"
    assert j.title == "Product Manager"
    assert j.location == "San Francisco"
    assert j.url == "https://jobs.ashbyhq.com/ramp/uuid-aaa"
    assert j.posted == "2026-05-22"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fetcher_ashby.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 4: Write minimal implementation**

```python
# src/fetchers/ashby.py
from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30


def parse(payload: dict, company: str) -> list[Job]:
    jobs = []
    for j in payload.get("jobs", []):
        jobs.append(Job(
            ats="ashby", native_id=str(j["id"]), company=company,
            title=j.get("title", ""), location=j.get("location", "") or "",
            url=j.get("jobUrl") or j.get("applyUrl", "") or "",
            posted=j.get("publishedDate", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false"
    resp = session.get(url, timeout=TIMEOUT)
    resp.raise_for_status()
    return parse(resp.json(), company)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_fetcher_ashby.py -v`
Expected: PASS (1 passed)

- [ ] **Step 6: Commit**

```bash
git add src/fetchers/ashby.py tests/fixtures/ashby.json tests/test_fetcher_ashby.py
git commit -m "feat: ashby fetcher"
```

---

## Task 7: Lever fetcher

**Files:**
- Create: `src/fetchers/lever.py`, `tests/fixtures/lever.json`
- Test: `tests/test_fetcher_lever.py`

- [ ] **Step 1: Create the fixture**

```json
// tests/fixtures/lever.json
[
  {"id": "lev-1", "text": "Group Product Manager", "hostedUrl": "https://jobs.lever.co/spotify/lev-1",
   "categories": {"location": "New York"}, "createdAt": 1747000000000},
  {"id": "lev-2", "text": "Backend Engineer", "hostedUrl": "https://jobs.lever.co/spotify/lev-2",
   "categories": {"location": "Stockholm"}, "createdAt": 1746000000000}
]
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_fetcher_lever.py
import json
from pathlib import Path
from src.fetchers.lever import parse

FIX = json.loads((Path(__file__).parent / "fixtures/lever.json").read_text())


def test_parse_lever():
    jobs = parse(FIX, company="Spotify")
    assert len(jobs) == 2
    j = jobs[0]
    assert j.ats == "lever"
    assert j.native_id == "lev-1"
    assert j.title == "Group Product Manager"
    assert j.location == "New York"
    assert j.url == "https://jobs.lever.co/spotify/lev-1"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fetcher_lever.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 4: Write minimal implementation**

```python
# src/fetchers/lever.py
from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30


def parse(payload: list, company: str) -> list[Job]:
    jobs = []
    for j in payload:
        loc = (j.get("categories") or {}).get("location", "") or ""
        jobs.append(Job(
            ats="lever", native_id=str(j["id"]), company=company,
            title=j.get("text", ""), location=loc,
            url=j.get("hostedUrl", "") or "", posted=str(j.get("createdAt", "")),
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    resp = session.get(url, timeout=TIMEOUT)
    resp.raise_for_status()
    return parse(resp.json(), company)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_fetcher_lever.py -v`
Expected: PASS (1 passed)

- [ ] **Step 6: Commit**

```bash
git add src/fetchers/lever.py tests/fixtures/lever.json tests/test_fetcher_lever.py
git commit -m "feat: lever fetcher"
```

---

## Task 8: SmartRecruiters fetcher (with pagination)

**Files:**
- Create: `src/fetchers/smartrecruiters.py`, `tests/fixtures/smartrec_page1.json`, `tests/fixtures/smartrec_page2.json`
- Test: `tests/test_fetcher_smartrec.py`

- [ ] **Step 1: Create the fixtures**

```json
// tests/fixtures/smartrec_page1.json
{"totalFound": 3, "content": [
  {"id": "sr-1", "name": "Product Manager", "location": {"city": "Sydney", "country": "au"}},
  {"id": "sr-2", "name": "Data Scientist", "location": {"city": "Remote", "country": "us"}}
]}
```

```json
// tests/fixtures/smartrec_page2.json
{"totalFound": 3, "content": [
  {"id": "sr-3", "name": "Head of Product", "location": {"city": "New York", "country": "us"}}
]}
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_fetcher_smartrec.py
import json
from pathlib import Path
from unittest.mock import MagicMock
from src.fetchers.smartrecruiters import parse, get_jobs

P1 = json.loads((Path(__file__).parent / "fixtures/smartrec_page1.json").read_text())
P2 = json.loads((Path(__file__).parent / "fixtures/smartrec_page2.json").read_text())


def test_parse_smartrec():
    jobs = parse(P1, company="Canva", slug="canva")
    j = jobs[0]
    assert j.ats == "smartrec"
    assert j.native_id == "sr-1"
    assert j.title == "Product Manager"
    assert j.location == "Sydney"
    assert j.url == "https://jobs.smartrecruiters.com/canva/sr-1"


def test_get_jobs_paginates_until_total():
    session = MagicMock()
    r1, r2 = MagicMock(), MagicMock()
    r1.json.return_value, r2.json.return_value = P1, P2
    r1.raise_for_status, r2.raise_for_status = (lambda: None), (lambda: None)
    session.get.side_effect = [r1, r2]
    jobs = get_jobs("canva", "Canva", session)
    assert [j.native_id for j in jobs] == ["sr-1", "sr-2", "sr-3"]
    assert session.get.call_count == 2
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fetcher_smartrec.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 4: Write minimal implementation**

```python
# src/fetchers/smartrecruiters.py
from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30
PAGE = 100


def parse(payload: dict, company: str, slug: str) -> list[Job]:
    jobs = []
    for j in payload.get("content", []):
        loc = (j.get("location") or {}).get("city", "") or ""
        jobs.append(Job(
            ats="smartrec", native_id=str(j["id"]), company=company,
            title=j.get("name", ""), location=loc,
            url=f"https://jobs.smartrecruiters.com/{slug}/{j['id']}",
            posted=j.get("releasedDate", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session) -> list[Job]:
    out: list[Job] = []
    offset = 0
    while True:
        url = (f"https://api.smartrecruiters.com/v1/companies/{slug}/postings"
               f"?limit={PAGE}&offset={offset}")
        resp = session.get(url, timeout=TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
        content = payload.get("content") or []
        out.extend(parse(payload, company, slug))
        total = payload.get("totalFound", len(out))
        offset += len(content)  # advance by items actually returned (robust to short final page)
        if offset >= total or not content:
            break
    return out
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_fetcher_smartrec.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
git add src/fetchers/smartrecruiters.py tests/fixtures/smartrec_page1.json tests/fixtures/smartrec_page2.json tests/test_fetcher_smartrec.py
git commit -m "feat: smartrecruiters fetcher with pagination"
```

---

## Task 9: Workday fetcher (CXS JSON, with pagination)

**Files:**
- Create: `src/fetchers/workday.py`, `tests/fixtures/workday.json`
- Test: `tests/test_fetcher_workday.py`

Workday slug format in the Companies tab: `<host>/<site>`, e.g. `nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite`. The tenant is the first label of the host.

- [ ] **Step 1: Create the fixture**

```json
// tests/fixtures/workday.json
{"total": 2, "jobPostings": [
  {"title": "Principal Product Manager", "externalPath": "/job/US-CA-Santa-Clara/Principal-PM_JR2018040",
   "locationsText": "US, CA, Santa Clara", "bulletFields": ["JR2018040"]},
  {"title": "Senior Product Architect", "externalPath": "/job/US-CA/Architect_JR2018146",
   "locationsText": "2 Locations", "bulletFields": ["JR2018146"]}
]}
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_fetcher_workday.py
import json
from pathlib import Path
from unittest.mock import MagicMock
from src.fetchers.workday import parse, get_jobs

FIX = json.loads((Path(__file__).parent / "fixtures/workday.json").read_text())
SLUG = "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"


def test_parse_workday_builds_id_and_url():
    jobs = parse(FIX, company="Nvidia", slug=SLUG)
    j = jobs[0]
    assert j.ats == "workday"
    assert j.native_id == "JR2018040"
    assert j.title == "Principal Product Manager"
    assert j.location == "US, CA, Santa Clara"
    assert j.url == ("https://nvidia.wd5.myworkdayjobs.com/en-US/"
                     "NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Principal-PM_JR2018040")


def test_get_jobs_stops_when_total_reached():
    session = MagicMock()
    resp = MagicMock()
    resp.json.return_value = FIX
    resp.raise_for_status = lambda: None
    session.post.return_value = resp
    jobs = get_jobs(SLUG, "Nvidia", session, search="product")
    assert len(jobs) == 2
    assert session.post.call_count == 1  # total=2, one page of 20 covers it
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fetcher_workday.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 4: Write minimal implementation**

```python
# src/fetchers/workday.py
from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 30
PAGE = 20


def _split_slug(slug: str) -> tuple[str, str, str]:
    host, site = slug.split("/", 1)
    tenant = host.split(".", 1)[0]
    return host, tenant, site


def parse(payload: dict, company: str, slug: str) -> list[Job]:
    host, _, site = _split_slug(slug)
    jobs = []
    for j in payload.get("jobPostings", []):
        bullets = j.get("bulletFields") or [""]
        native_id = bullets[0] or j.get("externalPath", "")
        path = j.get("externalPath", "")
        jobs.append(Job(
            ats="workday", native_id=str(native_id), company=company,
            title=j.get("title", ""), location=j.get("locationsText", "") or "",
            url=f"https://{host}/en-US/{site}{path}",
            posted=j.get("postedOn", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, search: str = "product") -> list[Job]:
    host, tenant, site = _split_slug(slug)
    endpoint = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    out: list[Job] = []
    offset = 0
    while True:
        body = {"appliedFacets": {}, "limit": PAGE, "offset": offset, "searchText": search}
        resp = session.post(endpoint, json=body, timeout=TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
        page_jobs = parse(payload, company, slug)
        out.extend(page_jobs)
        total = payload.get("total", len(out))
        offset += PAGE
        if offset >= total or not page_jobs:
            break
    return out
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_fetcher_workday.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
git add src/fetchers/workday.py tests/fixtures/workday.json tests/test_fetcher_workday.py
git commit -m "feat: workday CXS fetcher with pagination"
```

---

## Task 10: Fetcher registry

**Files:**
- Modify: `src/fetchers/__init__.py`
- Test: `tests/test_fetcher_registry.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_fetcher_registry.py
import pytest
from src.fetchers import get_jobs_for


def test_registry_routes_greenhouse(monkeypatch):
    called = {}
    def fake(slug, company, session, **kw):
        called["slug"] = slug
        return []
    import src.fetchers as f
    monkeypatch.setitem(f._REGISTRY, "greenhouse", fake)
    get_jobs_for("greenhouse", "stripe", "Stripe", session=None, workday_search="product")
    assert called["slug"] == "stripe"


def test_registry_unknown_ats_raises():
    with pytest.raises(ValueError):
        get_jobs_for("bogus", "x", "X", session=None, workday_search="product")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_fetcher_registry.py -v`
Expected: FAIL — `ImportError: cannot import name 'get_jobs_for'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/fetchers/__init__.py
from __future__ import annotations
import requests

from src.fetchers import greenhouse, ashby, lever, smartrecruiters, workday
from src.models import Job

_REGISTRY = {
    "greenhouse": greenhouse.get_jobs,
    "ashby": ashby.get_jobs,
    "lever": lever.get_jobs,
    "smartrec": smartrecruiters.get_jobs,
    "workday": workday.get_jobs,
}


def get_jobs_for(ats: str, slug: str, company: str, session: requests.Session,
                 workday_search: str = "product") -> list[Job]:
    fn = _REGISTRY.get(ats)
    if fn is None:
        raise ValueError(f"Unknown ATS: {ats}")
    if ats == "workday":
        return fn(slug, company, session, search=workday_search)
    return fn(slug, company, session)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_fetcher_registry.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/fetchers/__init__.py tests/test_fetcher_registry.py
git commit -m "feat: fetcher registry routing by ats"
```

---

## Task 11: SheetStore protocol + in-memory fake + gspread impl

**Files:**
- Create: `src/sheet.py`
- Test: `tests/test_sheet_fake.py`

The orchestrator depends only on the `SheetStore` protocol. `FakeSheetStore` powers offline tests. `GspreadSheetStore` is the real impl (smoke-tested manually in Task 19).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sheet_fake.py
from src.models import Company, JobRecord
from src.sheet import FakeSheetStore


def test_fake_read_companies_filters_monitor_false():
    store = FakeSheetStore(
        companies=[
            Company("Stripe", "greenhouse", "stripe", monitor=True, seeded=False),
            Company("Old", "lever", "old", monitor=False, seeded=True),
        ],
        history={}, contacts_by_company={},
    )
    active = store.read_companies()
    assert [c.name for c in active] == ["Stripe"]


def test_fake_append_and_read_history():
    store = FakeSheetStore(companies=[], history={}, contacts_by_company={})
    rec = JobRecord("greenhouse-1", "Stripe", "PM", "NYC", "http://x", "New", "2026-05-26", "2026-05-26")
    store.append_jobs([rec])
    assert store.read_history()["greenhouse-1"].title == "PM"


def test_fake_set_status_and_last_seen():
    rec = JobRecord("greenhouse-1", "Stripe", "PM", "NYC", "http://x", "Closed", "2026-01-01", "2026-01-01")
    store = FakeSheetStore(companies=[], history={"greenhouse-1": rec}, contacts_by_company={})
    store.set_status({"greenhouse-1": "New"})
    store.set_last_seen(["greenhouse-1"], "2026-05-26")
    h = store.read_history()
    assert h["greenhouse-1"].status == "New"
    assert h["greenhouse-1"].last_seen == "2026-05-26"


def test_fake_contact_count():
    store = FakeSheetStore(companies=[], history={}, contacts_by_company={"ramp": 2})
    assert store.contact_count("Ramp") == 2
    assert store.contact_count("Unknown") == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_sheet_fake.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/sheet.py
from __future__ import annotations
import json
import os
from typing import Protocol

from src.models import Company, JobRecord

JOBS_HEADER = ["id", "company", "title", "location", "url", "status", "first_seen", "last_seen", "posted"]
HEALTH_HEADER = ["company", "ats", "result", "count", "message", "checked_at"]


class SheetStore(Protocol):
    def read_companies(self) -> list[Company]: ...
    def read_history(self) -> dict[str, JobRecord]: ...
    def contact_count(self, company: str) -> int: ...
    def append_jobs(self, records: list[JobRecord]) -> None: ...
    def set_status(self, id_to_status: dict[str, str]) -> None: ...
    def set_last_seen(self, ids: list[str], today: str) -> None: ...
    def mark_seeded(self, company_names: list[str]) -> None: ...
    def write_health(self, rows: list[list]) -> None: ...


class FakeSheetStore:
    """In-memory SheetStore for tests."""

    def __init__(self, companies, history, contacts_by_company):
        self._companies = companies
        self._history = dict(history)
        self._contacts = {k.lower(): v for k, v in contacts_by_company.items()}
        self.health_rows: list[list] = []
        self.seeded_marks: list[str] = []

    def read_companies(self):
        return [c for c in self._companies if c.monitor]

    def read_history(self):
        return dict(self._history)

    def contact_count(self, company):
        return self._contacts.get(company.lower(), 0)

    def append_jobs(self, records):
        for r in records:
            self._history[r.id] = r

    def set_status(self, id_to_status):
        for jid, status in id_to_status.items():
            if jid in self._history:
                self._history[jid].status = status

    def set_last_seen(self, ids, today):
        for jid in ids:
            if jid in self._history:
                self._history[jid].last_seen = today

    def mark_seeded(self, company_names):
        self.seeded_marks.extend(company_names)
        for c in self._companies:
            if c.name in company_names:
                c.seeded = True

    def write_health(self, rows):
        self.health_rows = rows


class GspreadSheetStore:
    """Real SheetStore backed by a Google Sheet via gspread."""

    def __init__(self, sheet_id: str):
        import gspread
        creds = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
        gc = gspread.service_account_from_dict(creds)
        self._sh = gc.open_by_key(sheet_id)

    def _ws(self, title: str):
        return self._sh.worksheet(title)

    def read_companies(self):
        rows = self._ws("Companies").get_all_records()
        out = []
        for r in rows:
            out.append(Company(
                name=str(r.get("name", "")).strip(),
                ats=str(r.get("ats", "")).strip(),
                slug=str(r.get("slug", "")).strip(),
                monitor=str(r.get("monitor", "")).strip().upper() in ("TRUE", "1", "YES"),
                seeded=str(r.get("seeded", "")).strip().upper() in ("TRUE", "1", "YES"),
            ))
        return [c for c in out if c.monitor]

    def read_history(self):
        rows = self._ws("Jobs").get_all_records()
        out = {}
        for r in rows:
            jid = str(r.get("id", "")).strip()
            if not jid:
                continue
            out[jid] = JobRecord(
                id=jid, company=str(r.get("company", "")), title=str(r.get("title", "")),
                location=str(r.get("location", "")), url=str(r.get("url", "")),
                status=str(r.get("status", "")) or "New",
                first_seen=str(r.get("first_seen", "")), last_seen=str(r.get("last_seen", "")),
                posted=str(r.get("posted", "")),
            )
        return out

    def contact_count(self, company):
        try:
            rows = self._ws("Contacts").get_all_records()
        except Exception:
            return 0
        return sum(1 for r in rows if str(r.get("company", "")).strip().lower() == company.lower())

    def _id_to_row(self) -> dict[str, int]:
        ids = self._ws("Jobs").col_values(1)  # includes header at row 1
        return {v: i + 1 for i, v in enumerate(ids) if i > 0}

    def append_jobs(self, records):
        if not records:
            return
        rows = [[r.id, r.company, r.title, r.location, r.url, r.status,
                 r.first_seen, r.last_seen, r.posted] for r in records]
        self._ws("Jobs").append_rows(rows, value_input_option="RAW")

    def set_status(self, id_to_status):
        if not id_to_status:
            return
        ws, mapping = self._ws("Jobs"), self._id_to_row()
        updates = [{"range": f"F{mapping[jid]}", "values": [[st]]}
                   for jid, st in id_to_status.items() if jid in mapping]
        if updates:
            ws.batch_update(updates, value_input_option="RAW")

    def set_last_seen(self, ids, today):
        if not ids:
            return
        ws, mapping = self._ws("Jobs"), self._id_to_row()
        updates = [{"range": f"H{mapping[jid]}", "values": [[today]]}
                   for jid in ids if jid in mapping]
        if updates:
            ws.batch_update(updates, value_input_option="RAW")

    def mark_seeded(self, company_names):
        if not company_names:
            return
        ws = self._ws("Companies")
        records = ws.get_all_records()
        names = {n for n in company_names}
        updates = []
        for i, r in enumerate(records):
            if str(r.get("name", "")).strip() in names:
                updates.append({"range": f"E{i + 2}", "values": [["TRUE"]]})
        if updates:
            ws.batch_update(updates, value_input_option="RAW")

    def write_health(self, rows):
        ws = self._ws("Health")
        ws.clear()
        ws.update([HEALTH_HEADER] + rows, value_input_option="RAW")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_sheet_fake.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add src/sheet.py tests/test_sheet_fake.py
git commit -m "feat: SheetStore protocol, in-memory fake, gspread impl"
```

---

## Task 12: Notifications (ntfy)

**Files:**
- Create: `src/notify.py`
- Test: `tests/test_notify.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_notify.py
from unittest.mock import MagicMock
from src.models import JobRecord
from src.notify import format_new_jobs, push


def _rec(company, title):
    return JobRecord(f"gh-{title}", company, title, "NYC", "http://x", "New", "2026-05-26", "2026-05-26")


def test_format_new_jobs_includes_count_and_contact_hint():
    recs = [_rec("Ramp", "Sr PM"), _rec("Glean", "PM, Platform")]
    contact_counts = {"Ramp": 2}
    title, body = format_new_jobs(recs, contact_counts, preview=5)
    assert "2 new" in title
    assert "Ramp" in body and "Sr PM" in body
    assert "(2 contacts at Ramp)" in body
    assert "Glean" in body


def test_format_truncates_to_preview():
    recs = [_rec("C", f"PM {i}") for i in range(10)]
    title, body = format_new_jobs(recs, {}, preview=3)
    assert "10 new" in title
    assert body.count("PM ") <= 4  # 3 shown + possible "+7 more"


def test_push_posts_to_ntfy():
    session = MagicMock()
    push(session, "topic-x", "Title", "Body", tags=["briefcase"])
    args, kwargs = session.post.call_args
    assert args[0] == "https://ntfy.sh/topic-x"
    assert kwargs["data"].encode if isinstance(kwargs["data"], str) else True
    assert kwargs["headers"]["Title"] == "Title"
    assert kwargs["headers"]["Tags"] == "briefcase"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_notify.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/notify.py
from __future__ import annotations
import requests

from src.models import JobRecord

TIMEOUT = 15


def format_new_jobs(records: list[JobRecord], contact_counts: dict[str, int],
                    preview: int = 5) -> tuple[str, str]:
    title = f"{len(records)} new PM role{'s' if len(records) != 1 else ''}"
    lines = []
    for r in records[:preview]:
        hint = ""
        n = contact_counts.get(r.company, 0)
        if n:
            hint = f" ({n} contacts at {r.company})"
        lines.append(f"• {r.company} — {r.title}{hint}")
    if len(records) > preview:
        lines.append(f"+{len(records) - preview} more")
    return title, "\n".join(lines)


def push(session: requests.Session, topic: str, title: str, body: str,
         tags: list[str] | None = None, priority: str = "default") -> None:
    headers = {"Title": title, "Priority": priority}
    if tags:
        headers["Tags"] = ",".join(tags)
    session.post(f"https://ntfy.sh/{topic}", data=body.encode("utf-8"),
                 headers=headers, timeout=TIMEOUT)


def heartbeat(session: requests.Session, topic: str, ok: int, zero: int, errored: int) -> None:
    push(session, topic, "Job monitor ran (no new roles)",
         f"{ok} ok · {zero} returned zero · {errored} errored",
         tags=["heartbeat"], priority="min")


def failure_alert(session: requests.Session, topic: str, message: str) -> None:
    push(session, topic, "⚠ Job monitor FAILED", message, tags=["warning"], priority="high")


def weekly_digest(session: requests.Session, topic: str, ok: int, zero: int,
                  errored: list[str]) -> None:
    body = f"{ok} ok · {zero} returned zero · {len(errored)} errored"
    if errored:
        body += "\nErrors: " + ", ".join(errored[:10])
    push(session, topic, "Weekly monitor health", body, tags=["bar_chart"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_notify.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/notify.py tests/test_notify.py
git commit -m "feat: ntfy notifications (new-jobs, heartbeat, failure, digest)"
```

---

## Task 13: Snapshot backup

**Files:**
- Create: `src/snapshot.py`
- Test: `tests/test_snapshot.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_snapshot.py
import json
from src.models import JobRecord
from src.snapshot import write_snapshot


def test_write_snapshot(tmp_path):
    history = {"gh-1": JobRecord("gh-1", "Stripe", "PM", "NYC", "http://x", "New", "2026-05-26", "2026-05-26")}
    path = tmp_path / "snap.json"
    write_snapshot(str(path), "pm", history)
    data = json.loads(path.read_text())
    assert data["profile"] == "pm"
    assert data["count"] == 1
    assert data["jobs"][0]["id"] == "gh-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_snapshot.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/snapshot.py
from __future__ import annotations
import json
from dataclasses import asdict

from src.models import JobRecord


def write_snapshot(path: str, profile_name: str, history: dict[str, JobRecord]) -> None:
    jobs = [asdict(r) for r in sorted(history.values(), key=lambda r: r.id)]
    data = {"profile": profile_name, "count": len(jobs), "jobs": jobs}
    with open(path, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_snapshot.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.py tests/test_snapshot.py
git commit -m "feat: write-only JSON snapshot backup"
```

---

## Task 14: Apify quarantined fetcher

**Files:**
- Create: `src/apify.py`
- Test: `tests/test_apify.py`

The orchestrator (Task 16) calls `apify.get_jobs` only inside a try/except, so a failure here is recorded to Health and never propagates. Apify companies use `ats=apify` and `slug=<actor_id>:<careers_url>` in the Companies tab.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_apify.py
from unittest.mock import MagicMock
from src.apify import parse, get_jobs


SAMPLE = [
    {"title": "Product Manager", "location": "Remote", "url": "https://x/job/1", "id": "a1"},
    {"title": "Engineer", "location": "NYC", "url": "https://x/job/2", "id": "a2"},
]


def test_parse_apify():
    jobs = parse(SAMPLE, company="Meta")
    assert jobs[0].ats == "apify"
    assert jobs[0].native_id == "a1"
    assert jobs[0].title == "Product Manager"
    assert jobs[0].url == "https://x/job/1"


def test_get_jobs_calls_run_actor_sync(monkeypatch):
    session = MagicMock()
    resp = MagicMock()
    resp.json.return_value = SAMPLE
    resp.raise_for_status = lambda: None
    session.post.return_value = resp
    jobs = get_jobs("actor123:https://careers.meta.com", "Meta", session, token="TOK")
    assert len(jobs) == 2
    url = session.post.call_args[0][0]
    assert "actor123" in url and "TOK" in url
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_apify.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/apify.py
from __future__ import annotations
import requests

from src.models import Job

TIMEOUT = 120


def parse(items: list, company: str) -> list[Job]:
    jobs = []
    for it in items:
        nid = str(it.get("id") or it.get("url", ""))
        jobs.append(Job(
            ats="apify", native_id=nid, company=company,
            title=it.get("title", ""), location=it.get("location", "") or "",
            url=it.get("url", "") or "", posted=it.get("postedAt", "") or "",
        ))
    return jobs


def get_jobs(slug: str, company: str, session: requests.Session, token: str) -> list[Job]:
    """slug = '<actor_id>:<careers_url>'. Runs the actor synchronously and returns items."""
    actor_id, _, careers_url = slug.partition(":")
    url = (f"https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items"
           f"?token={token}")
    resp = session.post(url, json={"startUrls": [{"url": careers_url}]}, timeout=TIMEOUT)
    resp.raise_for_status()
    return parse(resp.json(), company)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_apify.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/apify.py tests/test_apify.py
git commit -m "feat: quarantined apify long-tail fetcher"
```

---

## Task 15: Slug discovery CLI

**Files:**
- Create: `src/discover.py`
- Test: `tests/test_discover.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_discover.py
from src.discover import candidate_slugs, interpret


def test_candidate_slugs_generates_variants():
    cands = candidate_slugs("Cerebras Systems")
    assert "cerebras" in cands
    assert "cerebrassystems" in cands
    assert "cerebras-systems" in cands


def test_interpret_picks_first_hit():
    probes = {"greenhouse:cerebras": False, "ashby:cerebras": True, "lever:cerebras": False}
    ats, slug = interpret(probes)
    assert ats == "ashby"
    assert slug == "cerebras"


def test_interpret_returns_none_when_no_hit():
    assert interpret({"greenhouse:x": False}) == (None, None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_discover.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/discover.py
from __future__ import annotations
import re
import sys

import requests

TIMEOUT = 15


def candidate_slugs(name: str) -> list[str]:
    base = re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()
    words = base.split()
    cands = [
        "".join(words),            # cerebrassystems
        words[0] if words else "", # cerebras
        "-".join(words),           # cerebras-systems
    ]
    seen, out = set(), []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _probe(ats: str, slug: str, session: requests.Session) -> bool:
    urls = {
        "greenhouse": f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false",
        "ashby": f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false",
        "lever": f"https://api.lever.co/v0/postings/{slug}?mode=json",
        "smartrec": f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=1",
    }
    try:
        r = session.get(urls[ats], timeout=TIMEOUT)
        return r.status_code == 200
    except requests.RequestException:
        return False


def interpret(probes: dict[str, bool]) -> tuple[str | None, str | None]:
    for key, ok in probes.items():
        if ok:
            ats, slug = key.split(":", 1)
            return ats, slug
    return None, None


def discover(name: str) -> tuple[str | None, str | None]:
    session = requests.Session()
    probes = {}
    for slug in candidate_slugs(name):
        for ats in ("greenhouse", "ashby", "lever", "smartrec"):
            probes[f"{ats}:{slug}"] = _probe(ats, slug, session)
    return interpret(probes)


if __name__ == "__main__":
    company = " ".join(sys.argv[1:])
    ats, slug = discover(company)
    if ats:
        print(f"{company}: ats={ats} slug={slug}")
    else:
        print(f"{company}: no standard ATS found — likely Workday or custom (use Apify)")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_discover.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/discover.py tests/test_discover.py
git commit -m "feat: slug discovery CLI helper"
```

---

## Task 16: Orchestrator (run one profile end-to-end)

**Files:**
- Create: `src/run.py`
- Test: `tests/test_run.py`

This wires everything via the `SheetStore` protocol and an injected fetch function, so the whole pipeline is tested offline with fakes. Covers Flows 1, 2, 3, 5, 7.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_run.py
from src.models import Company, JobRecord, Profile
from src.sheet import FakeSheetStore
from src.run import run_profile

PROFILE = Profile(name="pm", sheet_id="S", ntfy_topic="t",
                  include=["product manager"], exclude=["engineer"])


def _profile_store(companies, history, contacts=None):
    return FakeSheetStore(companies, history, contacts or {})


def _fetch_returns(mapping):
    # mapping: company name -> list[Job]
    def fake(ats, slug, company, session, workday_search="product"):
        return mapping.get(company, [])
    return fake


def test_first_run_seeds_without_notifying():
    from src.models import Job
    store = _profile_store(
        [Company("Stripe", "greenhouse", "stripe", monitor=True, seeded=False)], {})
    jobs = [Job("greenhouse", "1", "Stripe", "Product Manager", "NYC", "http://x")]
    pushed = []
    summary = run_profile(
        PROFILE, store, fetch=_fetch_returns({"Stripe": jobs}),
        today="2026-05-26", notifier=lambda *a, **k: pushed.append(a))
    assert summary.new_count == 0          # seeded silently
    assert "greenhouse-1" in store.read_history()
    assert store.read_history()["greenhouse-1"].status == "Seen"
    assert "Stripe" in store.seeded_marks
    assert pushed == []                    # no new-jobs push on seed run


def test_second_run_surfaces_new_job_and_filters_non_pm():
    from src.models import Job
    store = _profile_store(
        [Company("Stripe", "greenhouse", "stripe", monitor=True, seeded=True)], {})
    jobs = [
        Job("greenhouse", "9", "Stripe", "Senior Product Manager", "NYC", "http://9"),
        Job("greenhouse", "10", "Stripe", "Staff Engineer", "NYC", "http://10"),  # filtered out
    ]
    pushed = []
    summary = run_profile(
        PROFILE, store, fetch=_fetch_returns({"Stripe": jobs}),
        today="2026-05-26", notifier=lambda *a, **k: pushed.append(a))
    assert summary.new_count == 1
    assert "greenhouse-9" in store.read_history()
    assert "greenhouse-10" not in store.read_history()
    assert len(pushed) == 1                # new-jobs push fired


def test_zero_new_sends_heartbeat_not_silence():
    store = _profile_store(
        [Company("Stripe", "greenhouse", "stripe", monitor=True, seeded=True)], {})
    beats = []
    run_profile(PROFILE, store, fetch=_fetch_returns({"Stripe": []}),
                today="2026-05-26", notifier=lambda *a, **k: None,
                heartbeater=lambda *a, **k: beats.append(a))
    assert len(beats) == 1


def test_fetch_error_recorded_to_health_and_continues():
    def boom(ats, slug, company, session, workday_search="product"):
        raise RuntimeError("404")
    store = _profile_store(
        [Company("Bad", "greenhouse", "bad", monitor=True, seeded=True)], {})
    summary = run_profile(PROFILE, store, fetch=boom, today="2026-05-26",
                          notifier=lambda *a, **k: None, heartbeater=lambda *a, **k: None)
    assert summary.errored == 1
    assert any(row[2] == "ERROR" for row in store.health_rows)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/test_run.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# src/run.py
from __future__ import annotations
from dataclasses import dataclass
from datetime import date

import requests

from src.config import list_profiles
from src.dedup import reconcile_company
from src.fetchers import get_jobs_for
from src.filtering import title_matches
from src.models import Profile
from src.sheet import GspreadSheetStore, SheetStore
from src import notify, snapshot


@dataclass
class RunSummary:
    new_count: int = 0
    ok: int = 0
    zero: int = 0
    errored: int = 0
    error_companies: list[str] = None

    def __post_init__(self):
        if self.error_companies is None:
            self.error_companies = []


def run_profile(profile: Profile, store: SheetStore, fetch=get_jobs_for,
                today: str | None = None, session: requests.Session | None = None,
                notifier=None, heartbeater=None) -> RunSummary:
    today = today or date.today().isoformat()
    session = session or requests.Session()
    notifier = notifier or (lambda *a, **k: notify.push(*a, **k))
    heartbeater = heartbeater or (lambda *a, **k: notify.heartbeat(*a, **k))

    companies = store.read_companies()
    history = store.read_history()
    summary = RunSummary()
    health_rows: list[list] = []

    all_new = []
    append_records = []
    reopen_status = {}
    last_seen_ids = []
    newly_seeded = []

    for c in companies:
        # history scoped to this company
        chist = {jid: r for jid, r in history.items() if r.company == c.name}
        try:
            jobs = fetch(c.ats, c.slug, c.name, session, workday_search=profile.workday_search)
        except Exception as e:  # quarantine: one company never kills the run
            summary.errored += 1
            summary.error_companies.append(c.name)
            health_rows.append([c.name, c.ats, "ERROR", 0, str(e)[:200], today])
            continue

        jobs = [j for j in jobs if title_matches(j.title, profile.include, profile.exclude)]
        result = reconcile_company(chist, jobs, seeded=c.seeded, today=today,
                                   stale_days=14)

        append_records.extend(result.seed_records)
        append_records.extend(result.new_records)
        all_new.extend(result.new_records)
        last_seen_ids.extend(result.touched_ids)
        last_seen_ids.extend(result.reopened_ids)
        last_seen_ids.extend([r.id for r in result.new_records])
        for rid in result.reopened_ids:
            reopen_status[rid] = "New"
            # surface reopened roles in the push too
            all_new.append(history[rid])
        for rid in result.closed_ids:
            reopen_status[rid] = "Closed"

        if not c.seeded:
            newly_seeded.append(c.name)

        result_label = "ZERO" if not jobs else "OK"
        if result_label == "ZERO":
            summary.zero += 1
        else:
            summary.ok += 1
        health_rows.append([c.name, c.ats, result_label, len(jobs), "", today])

    # writes
    if append_records:
        store.append_jobs(append_records)
    if reopen_status:
        store.set_status(reopen_status)
    if last_seen_ids:
        store.set_last_seen(last_seen_ids, today)
    if newly_seeded:
        store.mark_seeded(newly_seeded)
    store.write_health(health_rows)

    summary.new_count = len(all_new)

    # notify (never silent)
    contact_counts = {r.company: store.contact_count(r.company) for r in all_new}
    if all_new:
        title, body = notify.format_new_jobs(all_new, contact_counts)
        notifier(session, profile.ntfy_topic, title, body, tags=["briefcase"])
    else:
        heartbeater(session, profile.ntfy_topic, summary.ok, summary.zero, summary.errored)

    return summary


def main() -> int:
    session = requests.Session()
    profiles = list_profiles()
    failures = []
    for profile in profiles:
        try:
            store = GspreadSheetStore(profile.sheet_id)
            summary = run_profile(profile, store, session=session)
            snapshot.write_snapshot(f"snapshots/{profile.name}.json",
                                    profile.name, store.read_history())
            if summary.errored:
                # weekly digest is gated in the workflow; per-run errors still logged to Health
                pass
        except Exception as e:  # whole-profile failure
            failures.append(f"{profile.name}: {e}")

    if failures:
        import os
        ops = os.environ.get("MONITOR_OPS_NTFY_TOPIC", "")
        if ops:
            notify.failure_alert(session, ops, "; ".join(failures)[:300])
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/test_run.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Run the full suite**

Run: `.venv/bin/pytest -v`
Expected: PASS (all tests green)

- [ ] **Step 6: Commit**

```bash
git add src/run.py tests/test_run.py
git commit -m "feat: orchestrator run_profile + main (zero-secret core, never-silent)"
```

---

## Task 17: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/monitor.yml`

No automated test; verified via `workflow_dispatch` in Task 19.

- [ ] **Step 1: Create the workflow**

```yaml
# .github/workflows/monitor.yml
name: PM Job Monitor

on:
  schedule:
    - cron: "0 12 * * *"   # ~07:00 America/Chicago (CDT). Adjust for CST if needed.
  workflow_dispatch: {}

permissions:
  contents: write          # to commit the daily snapshot (no PAT needed)

concurrency:
  group: job-monitor
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip

      - name: Install deps
        run: pip install -r requirements.txt

      - name: Run monitor
        env:
          GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
          MONITOR_OPS_NTFY_TOPIC: ${{ secrets.MONITOR_OPS_NTFY_TOPIC }}
          APIFY_TOKEN: ${{ secrets.APIFY_TOKEN }}
        run: |
          mkdir -p snapshots
          python -m src.run

      - name: Commit snapshot (keeps repo active so cron isn't auto-disabled)
        run: |
          git config user.name "job-monitor-bot"
          git config user.email "bot@users.noreply.github.com"
          git add snapshots/ || true
          git commit -m "chore: daily snapshot $(date -u +%Y-%m-%d)" || echo "no changes"
          git push || echo "nothing to push"

      - name: Alert on failure
        if: failure()
        env:
          OPS: ${{ secrets.MONITOR_OPS_NTFY_TOPIC }}
        run: |
          curl -s -H "Title: ⚠ Job monitor workflow failed" -H "Priority: high" -H "Tags: warning" \
            -d "GitHub Actions run failed: ${{ github.run_id }}" "https://ntfy.sh/${OPS}" || true
```

- [ ] **Step 2: Verify YAML parses**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/monitor.yml'))"`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/monitor.yml
git commit -m "ci: daily GitHub Actions workflow with snapshot commit + failure alert"
```

---

## Task 18: Seed data, profile, and docs

**Files:**
- Create: `companies.seed.csv`, `profiles/pm.yaml`, `README.md`

- [ ] **Step 1: Create `profiles/pm.yaml`**

```yaml
# profiles/pm.yaml
name: pm
sheet_id: "REPLACE_WITH_GOOGLE_SHEET_ID"
ntfy_topic: "salman-pm-jobs-REPLACE-WITH-RANDOM-SUFFIX"
workday_search: "product"
digest_weekday: 0   # 0 = Monday
include:
  - "product manager"
  - "associate product manager"
  - "senior product manager"
  - "group product manager"
  - "principal product manager"
  - "head of product"
  - "director of product"
  - "vp of product"
  - "technical product manager"
exclude:
  - "product marketing"
  - "product designer"
  - "product design"
  - "product analyst"
  - "data analyst"
  - "program manager"
  - "marketing manager"
  - "pmm"
```

- [ ] **Step 2: Create `companies.seed.csv`** with the 131 zero-secret companies (header `name,ats,slug,monitor,seeded`). Use the Public-API table from the handoff doc for the 125 standard ATS rows (e.g. `1Password,ashby,1password,TRUE,FALSE`), then append the 6 Workday rows using the `<host>/<site>` slug format:

```csv
name,ats,slug,monitor,seeded
Adobe,workday,adobe.wd5.myworkdayjobs.com/external_experienced,TRUE,FALSE
Atlassian,workday,atlassian.wd5.myworkdayjobs.com/Atlassian,TRUE,FALSE
CrowdStrike,workday,crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers,TRUE,FALSE
Nvidia,workday,nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite,TRUE,FALSE
Salesforce,workday,salesforce.wd12.myworkdayjobs.com/External_Career_Site,TRUE,FALSE
ServiceNow,workday,servicenow.wd1.myworkdayjobs.com/ServiceNowCareers,TRUE,FALSE
```

(Engineer transcribes the 125 standard-ATS rows from `background-context/grok-exported-chat-open-source-tools/pm-job-monitor-handoff-doc.md` §"Public API (125)" into the same CSV, mapping the doc's `smartrec` value to ats `smartrec`.)

- [ ] **Step 3: Create `README.md`**

````markdown
# PM Job Monitor

Zero-secret daily monitor for new PM roles across ~131 companies' public ATS APIs
(Greenhouse, Ashby, Lever, SmartRecruiters, Workday). New roles land in a Google Sheet
and get pushed to your phone via ntfy. Status + contacts are tracked in the same Sheet.

## How it works
GitHub Actions runs `python -m src.run` daily. For each profile it reads the Companies
tab, fetches each board, filters to PM titles, dedupes against history on
`{ats}-{native_id}`, appends new roles, auto-closes stale ones, writes a Health tab,
commits a JSON snapshot, and pushes new roles (or a heartbeat if none) to ntfy.

## One-time setup
1. Create a Google Sheet with tabs `Companies`, `Jobs`, `Contacts`, `Health` and the
   headers in `docs/superpowers/specs/2026-05-26-pm-job-monitor-design.md` §7.
2. Import `companies.seed.csv` into the `Companies` tab.
3. Create a Google Cloud service account, download its JSON key, share the Sheet with
   the service-account email (Editor).
4. Set repo secrets: `GOOGLE_SERVICE_ACCOUNT_JSON` (the key's JSON),
   `MONITOR_OPS_NTFY_TOPIC` (an ntfy topic for failure alerts). `APIFY_TOKEN` optional.
5. Edit `profiles/pm.yaml`: set `sheet_id` and a private `ntfy_topic`. Keep the repo private.
6. Subscribe to your `ntfy_topic` and the ops topic in the ntfy phone app.

## Adding a company
Add a row to the `Companies` tab (`name, ats, slug, monitor=TRUE`). Unsure of the slug?
Run `python -m src.discover "Company Name"`. The next run seeds it silently, then notifies
only on genuinely new roles.

## Removing a company
Set its `monitor` cell to `FALSE`. History is preserved (never delete rows).

## Adding another person (e.g. a finance analyst)
Drop `profiles/finance.yaml` (own `sheet_id`, `ntfy_topic`, include/exclude keywords) and
create their Sheet. No code changes.

## Troubleshooting
- No notification at all → the run failed; check the ops ntfy topic and the Actions log.
- A company shows ERROR/ZERO in the Health tab for days → likely a dead slug; re-run
  `discover.py` for it.
````

- [ ] **Step 4: Commit**

```bash
git add companies.seed.csv profiles/pm.yaml README.md
git commit -m "docs: seed companies, pm profile, README"
```

---

## Task 19: End-to-end verification runbook

**Files:** none (manual verification). Record results in the PR description.

- [ ] **Step 1: Full test suite green**

Run: `.venv/bin/pytest -v`
Expected: all tests pass.

- [ ] **Step 2: Live dry-run against one real company (no Sheet, no secrets)**

Run:
```bash
.venv/bin/python -c "
import requests
from src.fetchers import get_jobs_for
from src.filtering import title_matches
s = requests.Session()
jobs = get_jobs_for('greenhouse', 'stripe', 'Stripe', s)
pm = [j for j in jobs if title_matches(j.title, ['product manager','head of product'], ['product marketing','engineer'])]
print(f'{len(jobs)} total, {len(pm)} PM roles'); [print('-', j.title) for j in pm[:5]]
"
```
Expected: prints a non-zero total and a handful of PM titles. Confirms the public API + parse + filter path works end-to-end with no auth.

- [ ] **Step 3: Live Workday dry-run**

Run:
```bash
.venv/bin/python -c "
import requests
from src.fetchers import get_jobs_for
s = requests.Session()
jobs = get_jobs_for('workday', 'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', 'Nvidia', s, workday_search='product manager')
print(f'{len(jobs)} jobs'); [print('-', j.title, '|', j.url) for j in jobs[:3]]
"
```
Expected: prints jobs with valid URLs. Confirms the CXS endpoint + pagination + URL construction.

- [ ] **Step 4: Real Sheet smoke test (after Task 18 setup)**

With `GOOGLE_SERVICE_ACCOUNT_JSON` exported and `profiles/pm.yaml` pointed at a test Sheet seeded with 2-3 companies:
Run: `.venv/bin/python -m src.run`
Expected: first run seeds silently (Jobs tab fills with status `Seen`, no push beyond heartbeat, Companies `seeded`→TRUE, Health tab populated, `snapshots/pm.json` written).

- [ ] **Step 5: Trigger the workflow**

Push the branch, open the PR, then run the workflow via `workflow_dispatch` from the Actions tab.
Expected: green run, snapshot commit appears, heartbeat/new-jobs push received on phone.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "test: e2e verification runbook complete" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Zero-secret core (Greenhouse/Ashby/Lever/SmartRec/Workday) → Tasks 5–10. ✓
- Workday-as-API → Task 9. ✓
- Profiles / multi-user → Tasks 4, 18; orchestrator iterates profiles in `main()` (Task 16). ✓
- Google Sheet triage + service-account key → Task 11. ✓
- Dedup on `{ats}-{native_id}`, seed, reopen, user-status-sacred, stale-close → Task 3, exercised in Task 16. ✓
- Silence-is-never-success (heartbeat, failure alert, Health tab) → Tasks 12, 16, 17. ✓
- GitHub 60-day disable mitigation (snapshot commit) → Tasks 13, 17. ✓
- Quarantined Apify → Task 14 + try/except in Task 16. ✓
- Slug discovery → Task 15. ✓
- Manual contacts + new-job contact tie-in → Sheet `Contacts` (Task 11 `contact_count`) + push hint (Task 12). Phase 2 LinkedIn deferred per spec §3/§8. ✓
- Large-response safety → Greenhouse `content=false` (Task 5); pagination (Tasks 8, 9). ✓
- Portfolio README → Task 18. ✓

**Placeholder scan:** No "TBD/TODO"; every code step has complete code. `companies.seed.csv` Step 2 references the handoff doc for the 125-row transcription rather than inlining 125 lines — the 6 Workday rows are given in full and the format is explicit, so this is a mechanical transcription, not a design gap.

**Type consistency:** `Job.to_record(status, today)`, `reconcile_company(...) -> ReconcileResult` with fields `new_records/seed_records/reopened_ids/touched_ids/closed_ids`, `SheetStore` methods (`read_companies/read_history/contact_count/append_jobs/set_status/set_last_seen/mark_seeded/write_health`), and `get_jobs_for(ats, slug, company, session, workday_search)` are used consistently across Tasks 1, 3, 10, 11, 16. ✓

## Notes / deferred (per spec §12)
- Exact Apify actor id + free-tier headroom: decided when the first bespoke company is added (Task 14 leaves `actor_id` pluggable via the slug).
- Weekly-digest scheduling cadence: `notify.weekly_digest` exists (Task 12); wiring it to `digest_weekday` is a small follow-up once daily runs are proven.
- Keyword tuning (TPM = Product vs Program): default set in `pm.yaml` excludes "program manager"; tune in the Sheet/profile after observing real results.
