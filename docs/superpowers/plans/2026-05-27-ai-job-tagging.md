# AI Job Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nightly, fully-isolated pass that enriches each open PM role in the Google Sheet with LLM-extracted tags (YOE, seniority, company industry, role focus, condensed skills, comp, work model).

**Architecture:** A new GitHub Actions workflow runs `python -m src.review` on its own schedule, decoupled from discovery. It reads untagged open rows from the Jobs tab, fetches each job's description from its ATS's JSON detail endpoint, asks Claude Haiku (forced tool-use → strict JSON) for the tags, and batch-writes them back into 8 new Jobs columns. Per-job failures are quarantined and retried next night; a missing API key is a loud skip. Nothing here can affect the zero-secret discovery core.

**Tech Stack:** Python 3.11, `requests`, `gspread`, `anthropic` (new), `pytest`. Claude model `claude-haiku-4-5`.

---

## ⚠️ Deviation from spec (decided during planning — flag to user before/at execution)

Investigation of the live APIs changed one decision:

- **All five real ATSes (Greenhouse, Ashby, Lever, SmartRecruiters, Workday) have clean JSON detail endpoints** — Workday via a CXS detail URL reconstructed from the stored job URL. These are reliable and structured; no scraping needed.
- **Amazon's job page is a JS-rendered shell with no description in the HTML** (verified: the `.json` variant returns HTTP 406; the HTML page contains no `DESCRIPTION`/`BASIC QUALIFICATIONS` text). The spec's "URL-scrape fallback" would therefore *only* ever run for Amazon and would feed nav/footer garbage (or nothing) to the LLM.
- **Resolution:** drop the generic URL-scrape fallback (YAGNI — it has no working target). `fetch_description` returns `""` for `amazon`/unknown ATS *without any network call*. Amazon rows simply stay untagged and are re-evaluated nightly at ~zero cost (no HTTP, no LLM); they self-heal if Amazon ever exposes a usable API. This is documented in the README. Task 6 updates the spec to match.

If the user wants Amazon tagged badly enough, that's a separate effort (headless browser or a secret-bearing API) and explicitly out of scope here.

---

## File Structure

- **Create `src/tagging.py`** — `Tags` dataclass + `extract_tags()` (the Anthropic call, forced tool-use). One responsibility: text → structured tags.
- **Create `src/jobcontent.py`** — `fetch_description()` + per-ATS pure text extractors + `html_to_text()`. One responsibility: a job's identity → its description text.
- **Create `src/review.py`** — `review_profile()` orchestration + `main()`. One responsibility: wire the Sheet, fetcher, and tagger together with quarantine/guards.
- **Modify `src/models.py`** — add nothing to `JobRecord`; `Tags` lives in `tagging.py` (keeps the storage model untouched).
- **Modify `src/sheet.py`** — extend `JOBS_HEADER`; add `ensure_tag_columns()`, `read_jobs_for_tagging()`, `write_tags()`; refactor row→record into a shared helper; extend `FakeSheetStore`.
- **Create `.github/workflows/review.yml`** — nightly cron, offset from discovery.
- **Modify** `requirements.txt`, `.env.example`, `README.md`, and the spec doc.
- **Create** `tests/test_tagging.py`, `tests/test_jobcontent.py`, `tests/test_review.py`, and extend `tests/test_sheet_fake.py`.

---

## Task 1: `Tags` dataclass + `extract_tags()` (the LLM call)

**Files:**
- Create: `src/tagging.py`
- Test: `tests/test_tagging.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_tagging.py
from src.tagging import extract_tags, Tags


class _FakeBlock:
    def __init__(self, input):
        self.type = "tool_use"
        self.name = "emit_tags"
        self.input = input


class _FakeMessage:
    def __init__(self, input):
        self.content = [_FakeBlock(input)]


class _FakeClient:
    """Captures the create() kwargs and returns a canned tool_use block."""
    def __init__(self, input):
        self._input = input
        self.calls = []
        self.messages = self  # so client.messages.create works

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeMessage(self._input)


def test_extract_tags_maps_tool_input_to_tags():
    client = _FakeClient({
        "yoe": "5+", "seniority": "Senior",
        "company_industry": "Fintech — payments",
        "role_focus": "Checkout platform",
        "skills": ["SQL", "A/B testing", "B2B SaaS"],
        "comp_range": "$160k-$190k", "work_model": "Remote (US)",
    })
    tags = extract_tags("Lead the checkout team...", "Senior PM", "Acme", client=client)
    assert tags == Tags(
        yoe="5+", seniority="Senior", company_industry="Fintech — payments",
        role_focus="Checkout platform", skills="SQL; A/B testing; B2B SaaS",
        comp_range="$160k-$190k", work_model="Remote (US)",
    )
    # forced tool-use was requested
    kw = client.calls[0]
    assert kw["tool_choice"] == {"type": "tool", "name": "emit_tags"}
    assert kw["model"] == "claude-haiku-4-5"


def test_extract_tags_empty_jd_returns_blank_without_calling_llm():
    client = _FakeClient({"yoe": "SHOULD NOT BE USED"})
    tags = extract_tags("   ", "PM", "Acme", client=client)
    assert tags == Tags()
    assert client.calls == []  # never hit the model on empty JD


def test_extract_tags_blank_skills_list_yields_empty_cell():
    client = _FakeClient({
        "yoe": "", "seniority": "PM", "company_industry": "", "role_focus": "",
        "skills": [], "comp_range": "", "work_model": "",
    })
    tags = extract_tags("real jd text", "PM", "Acme", client=client)
    assert tags.skills == ""
    assert tags.seniority == "PM"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_tagging.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.tagging'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/tagging.py
from __future__ import annotations
from dataclasses import dataclass

MODEL = "claude-haiku-4-5"

SYSTEM = (
    "You tag product-manager job postings for a job seeker. "
    "Extract ONLY what the posting actually states. When a field is not stated, "
    "return an empty string (or an empty list for skills) — never guess or invent. "
    "Condense each requirement/qualification to at most 5 words. "
    "Normalize seniority to exactly one of: APM, PM, Senior, Staff, GPM, Director, VP."
)

_TAG_TOOL = {
    "name": "emit_tags",
    "description": "Emit structured tags extracted from a product-manager job description.",
    "input_schema": {
        "type": "object",
        "properties": {
            "yoe": {"type": "string",
                    "description": "Years of experience requested, e.g. '5+' or '3-5'. Empty if unstated."},
            "seniority": {"type": "string",
                          "description": "One of APM, PM, Senior, Staff, GPM, Director, VP. Empty if unclear."},
            "company_industry": {"type": "string",
                                 "description": "Industry + main products, e.g. 'Fintech — payments/cards'."},
            "role_focus": {"type": "string",
                           "description": "The specific product/domain/team of THIS role."},
            "skills": {"type": "array", "items": {"type": "string"},
                       "description": "Each required/preferred qualification, condensed to <=5 words."},
            "comp_range": {"type": "string",
                           "description": "Salary range if stated, e.g. '$160k-$190k'. Empty if absent."},
            "work_model": {"type": "string",
                           "description": "Remote / Hybrid / Onsite plus geo, e.g. 'Remote (US)' or 'Hybrid — NYC'."},
        },
        "required": ["yoe", "seniority", "company_industry", "role_focus",
                     "skills", "comp_range", "work_model"],
    },
    # Best-effort prompt caching of the static tool schema (no-op if below the model's
    # min cacheable size; harmless).
    "cache_control": {"type": "ephemeral"},
}


@dataclass
class Tags:
    yoe: str = ""
    seniority: str = ""
    company_industry: str = ""
    role_focus: str = ""
    skills: str = ""          # semicolon-joined for the single Sheet cell
    comp_range: str = ""
    work_model: str = ""


def _default_client():
    import anthropic
    return anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment


def _tool_input(message) -> dict:
    for block in message.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "emit_tags":
            return block.input or {}
    return {}


def extract_tags(jd_text: str, title: str, company: str, *, client=None) -> Tags:
    if not jd_text or not jd_text.strip():
        return Tags()
    client = client or _default_client()
    message = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        temperature=0,
        system=SYSTEM,
        tools=[_TAG_TOOL],
        tool_choice={"type": "tool", "name": "emit_tags"},
        messages=[{"role": "user",
                   "content": f"Company: {company}\nTitle: {title}\n\nJob description:\n{jd_text}"}],
    )
    data = _tool_input(message)
    skills = data.get("skills") or []
    return Tags(
        yoe=str(data.get("yoe", "")).strip(),
        seniority=str(data.get("seniority", "")).strip(),
        company_industry=str(data.get("company_industry", "")).strip(),
        role_focus=str(data.get("role_focus", "")).strip(),
        skills="; ".join(s.strip() for s in skills if str(s).strip()),
        comp_range=str(data.get("comp_range", "")).strip(),
        work_model=str(data.get("work_model", "")).strip(),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_tagging.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tagging.py tests/test_tagging.py
git commit -m "feat: Tags model + extract_tags LLM tagger (forced tool-use)"
```

---

## Task 2: JD description fetching (`src/jobcontent.py`)

**Files:**
- Create: `src/jobcontent.py`
- Test: `tests/test_jobcontent.py`

Real response shapes verified against live APIs:
- **Greenhouse** `GET /v1/boards/{slug}/jobs/{id}` → `content` is **double-escaped** HTML (`&lt;p&gt;`).
- **Ashby** `GET /posting-api/job-board/{slug}?includeCompensation=true` → `{"jobs": [{"id", "descriptionPlain", "descriptionHtml", ...}]}` — find by id, prefer `descriptionPlain` (already plain text).
- **Lever** `GET /v0/postings/{slug}/{id}?mode=json` → `descriptionPlain` + `lists[].text`/`lists[].content` + `additionalPlain`.
- **SmartRecruiters** `GET /v1/companies/{slug}/postings/{id}` → `jobAd.sections.{companyDescription,jobDescription,qualifications,additionalInformation}`, each `{"title","text"}` with HTML `text`.
- **Workday** stored URL is `https://{host}/en-US/{site}{externalPath}`; detail = `https://{host}/wday/cxs/{tenant}/{site}{externalPath}` (tenant = first host label) → `jobPostingInfo.jobDescription` (HTML).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_jobcontent.py
from src.jobcontent import (
    html_to_text, _greenhouse_text, _ashby_text, _lever_text,
    _smartrec_text, _workday_text, _workday_detail_url, fetch_description,
)


def test_html_to_text_unescapes_double_escaped_and_strips_tags():
    raw = "&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;Build &amp; ship&lt;/p&gt;"
    assert html_to_text(raw) == "About Build & ship"


def test_html_to_text_handles_plain_html_and_collapses_whitespace():
    assert html_to_text("<p>Hello   world</p>\n\n<p>Again</p>") == "Hello world\n\nAgain"


def test_html_to_text_empty():
    assert html_to_text("") == ""


def test_greenhouse_text():
    payload = {"content": "&lt;p&gt;Lead the roadmap&lt;/p&gt;"}
    assert _greenhouse_text(payload) == "Lead the roadmap"


def test_ashby_text_finds_job_by_id_prefers_plain():
    payload = {"jobs": [
        {"id": "abc", "descriptionPlain": "Plain desc", "descriptionHtml": "<p>x</p>"},
        {"id": "def", "descriptionPlain": "Other"},
    ]}
    assert _ashby_text(payload, "abc") == "Plain desc"


def test_ashby_text_missing_id_returns_empty():
    assert _ashby_text({"jobs": [{"id": "abc", "descriptionPlain": "x"}]}, "zzz") == ""


def test_lever_text_joins_description_lists_and_additional():
    payload = {
        "descriptionPlain": "We are hiring a PM.",
        "lists": [{"text": "Requirements", "content": "<li>SQL</li><li>5 yrs</li>"}],
        "additionalPlain": "Equal opportunity.",
    }
    out = _lever_text(payload)
    assert "We are hiring a PM." in out
    assert "Requirements" in out and "SQL" in out and "5 yrs" in out
    assert "Equal opportunity." in out


def test_smartrec_text_concatenates_sections_in_order():
    payload = {"jobAd": {"sections": {
        "companyDescription": {"title": "Company", "text": "<p>About us</p>"},
        "jobDescription": {"title": "Role", "text": "<p>Own the roadmap</p>"},
        "qualifications": {"title": "Quals", "text": "<p>5 years</p>"},
        "additionalInformation": {"title": "More", "text": "<p>Perks</p>"},
    }}}
    out = _smartrec_text(payload)
    assert out.index("About us") < out.index("Own the roadmap") < out.index("5 years")


def test_workday_text():
    payload = {"jobPostingInfo": {"jobDescription": "<p>Build NPI products</p>"}}
    assert _workday_text(payload) == "Build NPI products"


def test_workday_detail_url_reconstructs_cxs_endpoint():
    url = "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Remote/Senior-PM_JR1"
    assert _workday_detail_url(url) == (
        "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/"
        "NVIDIAExternalCareerSite/job/Remote/Senior-PM_JR1"
    )


def test_workday_detail_url_bad_input_returns_empty():
    assert _workday_detail_url("https://example.com/whatever") == ""


def test_fetch_description_unknown_or_amazon_ats_returns_empty_without_network():
    # session is None on purpose: must not be used for unsupported ATSes.
    assert fetch_description("amazon", "1", "amazon", "http://x", None) == ""
    assert fetch_description("nope", "1", "s", "http://x", None) == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_jobcontent.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.jobcontent'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/jobcontent.py
from __future__ import annotations
import html
import re
from urllib.parse import urlparse

import requests

TIMEOUT = 30
MAX_CHARS = 12000          # truncate before sending to the LLM
_WORKDAY_LOCALE = "/en-US/"

_TAG_RE = re.compile(r"<[^>]+>")


def html_to_text(raw: str) -> str:
    """Turn ATS HTML (sometimes double-escaped) into clean plain text."""
    if not raw:
        return ""
    text = html.unescape(raw)            # &lt;p&gt; -> <p>
    text = _TAG_RE.sub(" ", text)        # strip tags
    text = html.unescape(text)           # decode any remaining entities (&amp; -> &)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _clip(text: str) -> str:
    return text[:MAX_CHARS]


# --- pure per-ATS extractors (unit-tested) ---

def _greenhouse_text(payload: dict) -> str:
    return html_to_text(payload.get("content", "") or "")


def _ashby_text(payload: dict, native_id: str) -> str:
    for j in payload.get("jobs", []) or []:
        if str(j.get("id")) == str(native_id):
            return html_to_text(j.get("descriptionPlain") or j.get("descriptionHtml", "") or "")
    return ""


def _lever_text(payload: dict) -> str:
    parts = [payload.get("descriptionPlain", "") or ""]
    for lst in payload.get("lists", []) or []:
        parts.append(lst.get("text", "") or "")
        parts.append(html_to_text(lst.get("content", "") or ""))
    parts.append(payload.get("additionalPlain", "") or "")
    return html_to_text("\n".join(p for p in parts if p))


def _smartrec_text(payload: dict) -> str:
    sections = ((payload.get("jobAd") or {}).get("sections") or {})
    order = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
    parts = [(sections.get(k) or {}).get("text", "") or "" for k in order]
    return html_to_text("\n".join(p for p in parts if p))


def _workday_text(payload: dict) -> str:
    info = payload.get("jobPostingInfo") or {}
    return html_to_text(info.get("jobDescription", "") or "")


def _workday_detail_url(url: str) -> str:
    """Reconstruct the CXS detail endpoint from a stored Workday job URL.
    https://{host}/en-US/{site}{externalPath} -> https://{host}/wday/cxs/{tenant}/{site}{externalPath}
    """
    p = urlparse(url)
    if not p.netloc or _WORKDAY_LOCALE not in p.path:
        return ""
    host = p.netloc
    tenant = host.split(".")[0]
    after = p.path.split(_WORKDAY_LOCALE, 1)[1]   # "{site}{externalPath}"
    site, sep, tail = after.partition("/")
    if not sep:
        return ""
    return f"https://{host}/wday/cxs/{tenant}/{site}/{tail}"


# --- HTTP entrypoint (routing; not unit-tested, mirrors fetchers' get_jobs) ---

def fetch_description(ats: str, native_id: str, slug: str, url: str,
                      session: requests.Session | None) -> str:
    """Return clean JD text, or "" when no zero-secret source exists.
    May raise on transient HTTP errors — the caller quarantines per-job failures.
    """
    if ats == "greenhouse":
        r = session.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{native_id}",
                        timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_greenhouse_text(r.json()))
    if ats == "ashby":
        r = session.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
                        f"?includeCompensation=true", timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_ashby_text(r.json(), native_id))
    if ats == "lever":
        r = session.get(f"https://api.lever.co/v0/postings/{slug}/{native_id}?mode=json",
                        timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_lever_text(r.json()))
    if ats == "smartrec":
        r = session.get(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{native_id}",
                        timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_smartrec_text(r.json()))
    if ats == "workday":
        detail = _workday_detail_url(url)
        if not detail:
            return ""
        r = session.get(detail, headers={"Accept": "application/json"}, timeout=TIMEOUT)
        r.raise_for_status()
        return _clip(_workday_text(r.json()))
    # amazon (JS SPA, no JD in HTML) and any unknown ATS: no zero-secret source.
    return ""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_jobcontent.py -v`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/jobcontent.py tests/test_jobcontent.py
git commit -m "feat: per-ATS JD description fetch (greenhouse/ashby/lever/smartrec/workday)"
```

---

## Task 3: Sheet storage — tag columns, read, write, migration

**Files:**
- Modify: `src/sheet.py`
- Test: `tests/test_sheet_fake.py` (extend) and add `tests/test_sheet_gspread.py`

### 3a — header constant + shared row→record helper + FakeSheetStore tagging

- [ ] **Step 1: Write the failing test (FakeSheetStore tagging behavior)**

```python
# tests/test_sheet_fake.py  (append these tests)
from src.models import Company, JobRecord
from src.sheet import FakeSheetStore, TAG_COLUMNS, JOBS_HEADER
from src.tagging import Tags


def _store_with(records):
    history = {r.id: r for r in records}
    return FakeSheetStore([], history, {})


def test_jobs_header_ends_with_tag_columns():
    assert JOBS_HEADER[-len(TAG_COLUMNS):] == TAG_COLUMNS
    assert TAG_COLUMNS == ["yoe", "seniority", "company_industry", "role_focus",
                           "skills", "comp_range", "work_model", "tagged_at"]


def _rec(jid, status="New"):
    return JobRecord(id=jid, company="Acme", title="PM", location="NYC",
                     url="http://x", status=status, first_seen="2026-05-27",
                     last_seen="2026-05-27", posted="")


def test_read_jobs_for_tagging_returns_record_and_blank_tagged_at():
    store = _store_with([_rec("greenhouse-1")])
    rows = store.read_jobs_for_tagging()
    assert len(rows) == 1
    rec, tagged_at = rows[0]
    assert rec.id == "greenhouse-1"
    assert tagged_at == ""


def test_write_tags_records_tags_and_stamps_tagged_at():
    store = _store_with([_rec("greenhouse-1")])
    store.write_tags({"greenhouse-1": Tags(yoe="5+", seniority="Senior", skills="SQL; AB")}, "2026-05-27")
    rows = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert rows["greenhouse-1"] == "2026-05-27"
    assert store.tags_for("greenhouse-1").yoe == "5+"
    assert store.tags_for("greenhouse-1").skills == "SQL; AB"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_sheet_fake.py -v`
Expected: FAIL with `ImportError: cannot import name 'TAG_COLUMNS'`

- [ ] **Step 3: Implement in `src/sheet.py`**

Replace the header block at the top:

```python
# src/sheet.py  (near the top, replacing the JOBS_HEADER line)
TAG_COLUMNS = ["yoe", "seniority", "company_industry", "role_focus",
               "skills", "comp_range", "work_model", "tagged_at"]
BASE_JOBS_HEADER = ["id", "company", "title", "location", "url", "status",
                    "first_seen", "last_seen", "posted"]
JOBS_HEADER = BASE_JOBS_HEADER + TAG_COLUMNS
HEALTH_HEADER = ["company", "ats", "result", "count", "message", "checked_at"]
```

Add to the `SheetStore` Protocol:

```python
    def ensure_tag_columns(self) -> None: ...
    def read_jobs_for_tagging(self) -> list: ...
    def write_tags(self, id_to_tags: dict, today: str) -> None: ...
```

Add a module-level helper (used by both stores):

```python
def _row_to_record(r: dict) -> JobRecord:
    return JobRecord(
        id=str(r.get("id", "")).strip(), company=str(r.get("company", "")),
        title=str(r.get("title", "")), location=str(r.get("location", "")),
        url=str(r.get("url", "")), status=str(r.get("status", "")) or "New",
        first_seen=str(r.get("first_seen", "")), last_seen=str(r.get("last_seen", "")),
        posted=str(r.get("posted", "")),
    )
```

Extend `FakeSheetStore.__init__` and add methods:

```python
    # in FakeSheetStore.__init__, after self.seeded_marks = []:
        self._tags: dict = {}
        self._tagged_at: dict = {}

    def ensure_tag_columns(self):  # no-op for the in-memory store
        return

    def read_jobs_for_tagging(self):
        return [(r, self._tagged_at.get(r.id, "")) for r in self._history.values()]

    def write_tags(self, id_to_tags, today):
        for jid, tags in id_to_tags.items():
            self._tags[jid] = tags
            self._tagged_at[jid] = today

    def tags_for(self, jid):
        return self._tags.get(jid)
```

Refactor `GspreadSheetStore.read_history` to reuse the helper:

```python
    def read_history(self):
        rows = self._ws("Jobs").get_all_records()
        out = {}
        for r in rows:
            rec = _row_to_record(r)
            if not rec.id:
                continue
            out[rec.id] = rec
        return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_sheet_fake.py -v`
Expected: PASS (new tests + existing still green)

- [ ] **Step 5: Commit**

```bash
git add src/sheet.py tests/test_sheet_fake.py
git commit -m "feat: tag columns + FakeSheetStore tagging support"
```

### 3b — GspreadSheetStore migration + read + write (stub-backed test)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_sheet_gspread.py
from src.sheet import GspreadSheetStore, BASE_JOBS_HEADER, TAG_COLUMNS
from src.tagging import Tags


class FakeWS:
    def __init__(self, header, records=None, ids_col=None):
        self._header = header
        self._records = records or []
        self._ids_col = ids_col or []
        self.batch_calls = []

    def row_values(self, n):
        return list(self._header)

    def get_all_records(self):
        return [dict(r) for r in self._records]

    def col_values(self, n):
        return ["id"] + self._ids_col   # header + ids

    def batch_update(self, updates, value_input_option=None):
        self.batch_calls.append(updates)


class FakeSheet:
    def __init__(self, ws):
        self._ws = ws

    def worksheet(self, title):
        return self._ws


def _store(ws):
    s = GspreadSheetStore.__new__(GspreadSheetStore)   # bypass __init__ (needs creds)
    s._sh = FakeSheet(ws)
    return s


def test_ensure_tag_columns_appends_missing_block_when_absent():
    ws = FakeWS(header=list(BASE_JOBS_HEADER))
    _store(ws).ensure_tag_columns()
    assert len(ws.batch_calls) == 1
    upd = ws.batch_calls[0][0]
    # 9 base cols -> tags start at column 10 (J), end at column 17 (Q), header row 1
    assert upd["range"] == "J1:Q1"
    assert upd["values"] == [TAG_COLUMNS]


def test_ensure_tag_columns_noop_when_present():
    ws = FakeWS(header=list(BASE_JOBS_HEADER) + list(TAG_COLUMNS))
    _store(ws).ensure_tag_columns()
    assert ws.batch_calls == []


def test_read_jobs_for_tagging_reads_record_and_tagged_at():
    ws = FakeWS(
        header=list(BASE_JOBS_HEADER) + list(TAG_COLUMNS),
        records=[{"id": "greenhouse-1", "company": "Acme", "title": "PM",
                  "status": "New", "tagged_at": ""},
                 {"id": "lever-2", "company": "B", "title": "PM",
                  "status": "Closed", "tagged_at": "2026-05-26"}],
    )
    rows = _store(ws).read_jobs_for_tagging()
    by_id = {rec.id: (rec, t) for rec, t in rows}
    assert by_id["greenhouse-1"][1] == ""
    assert by_id["lever-2"][0].status == "Closed"
    assert by_id["lever-2"][1] == "2026-05-26"


def test_write_tags_writes_contiguous_block_per_row():
    ws = FakeWS(
        header=list(BASE_JOBS_HEADER) + list(TAG_COLUMNS),
        ids_col=["greenhouse-1"],   # row 2
    )
    tags = Tags(yoe="5+", seniority="Senior", company_industry="Fintech",
                role_focus="Checkout", skills="SQL; AB", comp_range="$1", work_model="Remote")
    _store(ws).write_tags({"greenhouse-1": tags}, "2026-05-27")
    upd = ws.batch_calls[0][0]
    assert upd["range"] == "J2:Q2"
    assert upd["values"] == [["5+", "Senior", "Fintech", "Checkout",
                              "SQL; AB", "$1", "Remote", "2026-05-27"]]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_sheet_gspread.py -v`
Expected: FAIL with `AttributeError: 'GspreadSheetStore' object has no attribute 'ensure_tag_columns'`

- [ ] **Step 3: Implement the three methods in `GspreadSheetStore`**

```python
    # src/sheet.py  — add inside GspreadSheetStore
    def ensure_tag_columns(self):
        from gspread.utils import rowcol_to_a1
        ws = self._ws("Jobs")
        header = ws.row_values(1)
        if all(c in header for c in TAG_COLUMNS):
            return
        # Append the full tag block as one contiguous run to the right of existing columns.
        start = len(header) + 1
        end = start + len(TAG_COLUMNS) - 1
        rng = f"{rowcol_to_a1(1, start)}:{rowcol_to_a1(1, end)}"
        ws.batch_update([{"range": rng, "values": [TAG_COLUMNS]}], value_input_option="RAW")

    def read_jobs_for_tagging(self):
        rows = self._ws("Jobs").get_all_records()
        out = []
        for r in rows:
            rec = _row_to_record(r)
            if not rec.id:
                continue
            out.append((rec, str(r.get("tagged_at", "")).strip()))
        return out

    def write_tags(self, id_to_tags, today):
        if not id_to_tags:
            return
        from gspread.utils import rowcol_to_a1
        ws = self._ws("Jobs")
        header = ws.row_values(1)
        start = header.index("yoe") + 1            # tag block is contiguous, yoe..tagged_at
        mapping = self._id_to_row()
        updates = []
        for jid, tags in id_to_tags.items():
            row = mapping.get(jid)
            if not row:
                continue
            values = [tags.yoe, tags.seniority, tags.company_industry, tags.role_focus,
                      tags.skills, tags.comp_range, tags.work_model, today]
            rng = f"{rowcol_to_a1(row, start)}:{rowcol_to_a1(row, start + len(values) - 1)}"
            updates.append({"range": rng, "values": [values]})
        if updates:
            ws.batch_update(updates, value_input_option="RAW")
```

Note: `ensure_tag_columns` always appends the **whole** `TAG_COLUMNS` block when any are missing, guaranteeing the columns are contiguous and in order — which `write_tags` relies on (`header.index("yoe")` + fixed offsets). Our live Sheet has none of these columns today, so first run appends all 8 as block `J1:Q1`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_sheet_gspread.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/sheet.py tests/test_sheet_gspread.py
git commit -m "feat: GspreadSheetStore tag migration + read/write tags"
```

---

## Task 4: Review orchestration (`src/review.py`)

**Files:**
- Create: `src/review.py`
- Test: `tests/test_review.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_review.py
from src.models import Company, JobRecord
from src.sheet import FakeSheetStore
from src.tagging import Tags
from src.review import review_profile


def _rec(jid, company="Acme", status="New", url="http://x"):
    return JobRecord(id=jid, company=company, title="PM", location="NYC",
                     url=url, status=status, first_seen="2026-05-27",
                     last_seen="2026-05-27", posted="")


def _store(records, companies=None):
    history = {r.id: r for r in records}
    return FakeSheetStore(companies or [Company("Acme", "greenhouse", "acme")], history, {})


def _fetch_const(text):
    def fetch(ats, native_id, slug, url, session):
        return text
    return fetch


def _extract_echo(jd, title, company, *, client=None):
    return Tags(yoe="5+", role_focus=jd[:10])


def test_tags_open_untagged_job():
    store = _store([_rec("greenhouse-1", status="Seen")])
    summary = review_profile(_PROFILE(), store, today="2026-05-27",
                             fetch=_fetch_const("Own the roadmap end to end"),
                             extract=_extract_echo)
    assert summary.tagged == 1
    assert store.tags_for("greenhouse-1").yoe == "5+"
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-1"] == "2026-05-27"   # stamped


def test_skips_closed_jobs():
    store = _store([_rec("greenhouse-1", status="Closed")])
    summary = review_profile(_PROFILE(), store, today="2026-05-27",
                             fetch=_fetch_const("text"), extract=_extract_echo)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1") is None


def test_skips_already_tagged_without_calling_fetch():
    store = _store([_rec("greenhouse-1")])
    store.write_tags({"greenhouse-1": Tags(yoe="old")}, "2026-05-20")

    def boom(*a, **k):
        raise AssertionError("must not fetch an already-tagged row")

    summary = review_profile(_PROFILE(), store, today="2026-05-27",
                             fetch=boom, extract=_extract_echo)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1").yoe == "old"


def test_empty_jd_is_skipped_not_tagged():
    store = _store([_rec("amazon-1")])
    summary = review_profile(_PROFILE(), store, today="2026-05-27",
                             fetch=_fetch_const(""), extract=_extract_echo)
    assert summary.tagged == 0
    assert summary.skipped_no_jd == 1
    assert store.tags_for("amazon-1") is None   # left untagged → retried next night


def test_per_job_failure_is_isolated():
    store = _store(
        [_rec("greenhouse-1", company="Good"), _rec("greenhouse-2", company="Bad")],
        companies=[Company("Good", "greenhouse", "good"), Company("Bad", "greenhouse", "bad")],
    )

    def fetch(ats, native_id, slug, url, session):
        if slug == "bad":
            raise RuntimeError("boom")
        return "real jd"

    summary = review_profile(_PROFILE(), store, today="2026-05-27",
                             fetch=fetch, extract=_extract_echo)
    assert summary.tagged == 1
    assert summary.failed == 1
    assert store.tags_for("greenhouse-1") is not None
    assert store.tags_for("greenhouse-2") is None


def test_id_with_hyphenated_native_id_parses_ats_and_full_id():
    seen = {}

    def fetch(ats, native_id, slug, url, session):
        seen["ats"] = ats
        seen["native_id"] = native_id
        return "jd"

    store = _store([_rec("lever-618c-cb22-baca")], companies=[Company("Acme", "lever", "acme")])
    review_profile(_PROFILE(), store, today="2026-05-27", fetch=fetch, extract=_extract_echo)
    assert seen["ats"] == "lever"
    assert seen["native_id"] == "618c-cb22-baca"


def _PROFILE():
    from src.models import Profile
    return Profile(name="pm", sheet_id="S", ntfy_topic="t", include=[], exclude=[])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_review.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.review'`

- [ ] **Step 3: Write the implementation**

```python
# src/review.py
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import date
import os
import sys
import traceback

import requests

from src.config import list_profiles, unconfigured_reason
from src.sheet import GspreadSheetStore, SheetStore
from src.models import Profile
from src import jobcontent, tagging, notify


@dataclass
class ReviewSummary:
    tagged: int = 0
    skipped_no_jd: int = 0
    failed: int = 0
    fail_companies: list = field(default_factory=list)


def review_profile(profile: Profile, store: SheetStore, *, today: str | None = None,
                   session: requests.Session | None = None,
                   fetch=jobcontent.fetch_description,
                   extract=tagging.extract_tags) -> ReviewSummary:
    today = today or date.today().isoformat()
    session = session or requests.Session()
    store.ensure_tag_columns()
    slug_by_company = {c.name: c.slug for c in store.read_companies()}
    summary = ReviewSummary()
    updates: dict = {}

    for rec, tagged_at in store.read_jobs_for_tagging():
        if tagged_at or rec.status == "Closed":
            continue
        ats, _, native_id = rec.id.partition("-")   # ats has no hyphen; native_id keeps its own
        slug = slug_by_company.get(rec.company, "")
        try:
            jd = fetch(ats, native_id, slug, rec.url, session)
            if not jd or not jd.strip():
                summary.skipped_no_jd += 1
                continue
            updates[rec.id] = extract(jd, rec.title, rec.company)
            summary.tagged += 1
        except Exception as e:
            summary.failed += 1
            summary.fail_companies.append(rec.company)
            print(f"[review] {rec.id} ({rec.company}) FAILED: {str(e)[:200]}", file=sys.stderr)
            continue

    if updates:
        store.write_tags(updates, today)
    return summary


def main() -> int:
    session = requests.Session()
    failures = []
    for profile in list_profiles():
        if not os.environ.get("ANTHROPIC_API_KEY", ""):
            print(f"[review] profile '{profile.name}' SKIPPED — ANTHROPIC_API_KEY not set",
                  file=sys.stderr)
            continue
        reason = unconfigured_reason(profile)
        if reason:
            print(f"[review] profile '{profile.name}' SKIPPED — {reason}", file=sys.stderr)
            continue
        try:
            store = GspreadSheetStore(profile.sheet_id)
            s = review_profile(profile, store, session=session)
            print(f"[review] {profile.name}: tagged={s.tagged} "
                  f"skipped_no_jd={s.skipped_no_jd} failed={s.failed}", file=sys.stderr)
            # Systemic failure (e.g. bad/expired key fails every call) — surface it.
            if s.failed and not s.tagged:
                failures.append(f"{profile.name}: tagging failed for all {s.failed} attempted job(s)")
        except Exception as e:
            failures.append(f"{profile.name}: {e}")
            print(f"[review] profile '{profile.name}' FAILED:\n{traceback.format_exc()}",
                  file=sys.stderr)

    if failures:
        msg = "; ".join(failures)
        print(f"[review] FAILURES: {msg}", file=sys.stderr)
        ops = os.environ.get("MONITOR_OPS_NTFY_TOPIC", "")
        if ops:
            try:
                notify.failure_alert(session, ops, msg[:300])
            except Exception as alert_err:
                print(f"[review] failure_alert itself errored: {alert_err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_review.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite**

Run: `pytest -q`
Expected: all tests pass (existing 52 + new).

- [ ] **Step 6: Commit**

```bash
git add src/review.py tests/test_review.py
git commit -m "feat: nightly review pass (quarantined, decoupled tagging orchestration)"
```

---

## Task 5: Workflow + config + dependency

**Files:**
- Create: `.github/workflows/review.yml`
- Modify: `requirements.txt`, `.env.example`

- [ ] **Step 1: Add the dependency**

Edit `requirements.txt`, add after `PyYAML==6.0.2`:

```
anthropic==0.40.0
```

- [ ] **Step 2: Verify it installs and imports**

Run: `.venv/bin/pip install -r requirements.txt && .venv/bin/python -c "import anthropic; print(anthropic.__version__)"`
Expected: prints a version, no error. (If `0.40.0` is unavailable in the environment, pin to the latest installable `0.x` and note it.)

- [ ] **Step 3: Add the secret to `.env.example`**

Append to `.env.example`:

```
# Required only for the nightly AI tagging pass (src.review). Safe to leave blank to disable.
ANTHROPIC_API_KEY=
```

- [ ] **Step 4: Create the workflow**

```yaml
# .github/workflows/review.yml
name: PM Job Tagging

on:
  schedule:
    - cron: "0 15 * * *"   # ~10:00 America/Chicago — ~3h after the discovery run
  workflow_dispatch: {}

permissions:
  contents: read

concurrency:
  group: job-tagging
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-python@v6
        with:
          python-version: "3.11"
          cache: pip

      - name: Install deps
        run: pip install -r requirements.txt

      - name: Run tagger
        env:
          GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          MONITOR_OPS_NTFY_TOPIC: ${{ secrets.MONITOR_OPS_NTFY_TOPIC }}
        run: python -m src.review

      - name: Alert on failure
        if: failure()
        env:
          OPS: ${{ secrets.MONITOR_OPS_NTFY_TOPIC }}
        run: |
          curl -s -H "Title: Job tagging workflow failed" -H "Priority: high" -H "Tags: warning" \
            -d "GitHub Actions run failed: ${{ github.run_id }}" "https://ntfy.sh/${OPS}" || true
```

- [ ] **Step 5: Validate the workflow YAML parses**

Run: `.venv/bin/python -c "import yaml; yaml.safe_load(open('.github/workflows/review.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add requirements.txt .env.example .github/workflows/review.yml
git commit -m "chore: anthropic dep + nightly tagging workflow + env example"
```

---

## Task 6: Docs + spec reconciliation

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-05-27-ai-job-tagging-design.md`

- [ ] **Step 1: Add a README section**

Insert after the "Adding another person" section in `README.md`:

```markdown
## AI tagging (optional)
A second nightly workflow (`review.yml`) enriches each open PM role with tags:
`yoe`, `seniority`, `company_industry`, `role_focus`, `skills`, `comp_range`, `work_model`.
It runs `python -m src.review`, reads untagged open rows from `Jobs`, fetches each job's
description from its ATS's JSON detail endpoint, and asks Claude Haiku for the tags.

- **Enable:** set the `ANTHROPIC_API_KEY` repo secret. Leave it unset to keep tagging off —
  the pass logs a clear skip and the discovery core is unaffected either way.
- **Self-migrating:** the 8 tag columns are appended to the `Jobs` tab automatically on the
  first run; no manual column setup.
- **Backfill:** there is no per-run cap — the first run tags the whole existing backlog, then
  it idles. New rows are tagged the next night.
- **Coverage:** Greenhouse, Ashby, Lever, SmartRecruiters, and Workday roles get tagged.
  Amazon roles are **not** tagged — amazon.jobs is a JS app with no machine-readable
  description; those rows are skipped at zero cost and left untagged.
- **Cost:** Claude Haiku, ~a fraction of a cent per role.
```

- [ ] **Step 2: Reconcile the spec**

In `docs/superpowers/specs/2026-05-27-ai-job-tagging-design.md`, update §4/§7 to record the planning-time decision: the generic URL-scrape fallback is dropped because Amazon (its only target) is a JS SPA with no JD in the HTML; `fetch_description` returns `""` for amazon/unknown ATS without network I/O, and such rows stay untagged and are re-evaluated cheaply each night. Add Workday's CXS detail-URL reconstruction to the JD-source list.

- [ ] **Step 3: Run the full suite once more**

Run: `pytest -q`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-05-27-ai-job-tagging-design.md
git commit -m "docs: AI tagging README section + spec reconciliation"
```

---

## Manual verification (after merge, before relying on it)

These can't be unit-tested (they need the live Sheet + a real key):

1. Set `ANTHROPIC_API_KEY` as a repo secret.
2. Trigger `review.yml` via **workflow_dispatch**.
3. Confirm the `Jobs` tab gained the 8 columns (J–Q) and that previously-untagged open rows now show plausible `yoe`/`seniority`/`skills`/etc.
4. Confirm Amazon rows remain blank (expected) and that re-running does **not** re-tag already-tagged rows (`tagged_at` set).
5. Temporarily unset the secret and dispatch again → the run logs `SKIPPED — ANTHROPIC_API_KEY not set` and exits 0 (core unaffected).
```
