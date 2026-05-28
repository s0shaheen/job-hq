# AI Job Tagging — Design Spec

> Status: approved for planning · Date: 2026-05-27 · Owner: Salman

## 1. Problem

The monitor surfaces *that* a PM role is new, but nothing about *what it is*. To triage a
growing Jobs tab you currently have to open each link and read the JD. We want each role
auto-enriched with structured, filterable tags — years of experience, the company's
industry/products, the specific product/domain/team of the role, condensed requirement
bullets, comp, work model, and seniority — so the Sheet itself becomes the triage surface.

This deliberately reverses a v1 non-goal. The original spec (`2026-05-26-...`, §3) deferred
"LLM job scoring" indefinitely because it adds an Anthropic key, per-run cost, and a "credits
ran out" failure mode. That reasoning still holds for the **core**, so the resolution is
architectural: the tagger is a fully **isolated, decoupled enrichment layer** that can fail,
run out of credits, or be turned off entirely without ever touching discovery or the morning
push. The invariant is preserved by quarantine, not by abstention.

## 2. Core principle (inherited invariant)

**The daily discovery core stays zero-rotating-secret and fails loud. The tagger is fragile
by nature (external API, cost, key) and is therefore quarantined so it can never affect the
core.** Concretely:

- The tagger runs in its **own GitHub Actions workflow** on its **own schedule**, separate
  from discovery. If it breaks, the morning new-jobs push is unaffected.
- It only ever **reads rows discovery already wrote** and **writes new columns** — it never
  fetches boards, never dedupes, never notifies you about new jobs.
- A missing `ANTHROPIC_API_KEY` is a **clean skip with a loud stderr message** (the
  `unconfigured_reason` pattern), not a crash. The feature is safe to leave off.
- One bad job (unreachable JD, malformed LLM output) is **quarantined**: logged, left
  untagged, retried next night. One job never kills the pass — same discipline as `run.py`.
- The only new secret is one more static API key, used by one isolated step.

## 3. Scope

**In:** nightly tagging pass; per-ATS JD fetch (Greenhouse, Ashby, Lever, SmartRecruiters,
Workday); LLM tag extraction; 8 new Jobs columns; self-migrating Sheet header; new workflow;
docs + `.env.example` + requirements.

**Out (explicit non-goals):**
- **`fit_score` / candidate matching** — needs a maintained background blurb and is
  subjective; deferred until requested.
- **`tldr` / free-text summary** and **split required/preferred skills** — considered, cut for
  simplicity. Skills is one semicolon-joined cell.
- **Re-tagging** existing tagged rows (no model-version migration, no refresh). `tagged_at`
  presence means "done, never touch again."
- **Notifying about tags.** Discovery owns the morning push; the tagger is silent except for
  ops failure alerts.
- **Tagging Closed roles** — don't pay to enrich dead listings.

## 4. Architecture

```
GitHub Actions  (review.yml — nightly cron, offset a few hours after discovery)
   │
   └─ python -m src.review   (one pass per profile)
        ├─ guard: ANTHROPIC_API_KEY set?  no → loud skip, exit 0 for this profile
        ├─ store.ensure_tag_columns()        # self-migrate header if needed
        ├─ read Companies (name→slug map) + all Jobs rows (with row numbers)
        ├─ select rows where tagged_at == "" AND status != "Closed"   (NO cap — drain fully)
        ├─ for each selected row  (continue-on-error per job):
        │     ├─ jobcontent.fetch_description(ats, native_id, slug, url, session)
        │     │       ATS detail API (Greenhouse/Ashby/Lever/SR/Workday)  →  "" (skip if empty or unknown ATS)
        │     ├─ tagging.extract_tags(jd_text, title, company)  → Tags   (Anthropic, tool-use)
        │     └─ collect {id: Tags}
        ├─ store.write_tags({id: Tags})       # batch update tag cells, stamp tagged_at
        └─ on failures → ops ntfy alert (best-effort); otherwise silent
```

### Module boundaries

- **`src/jobcontent.py`** — `fetch_description(ats, native_id, slug, url, session) -> str`.
  Per-ATS detail endpoints (Greenhouse/Ashby/Lever/SmartRecruiters/Workday) return HTML/JSON →
  stripped to text. Amazon and unknown ATS types return `""` immediately with no network I/O.
  Returns `""` on any failure; never raises to the caller. Pure functions for each ATS's parse
  step → unit-testable on fixtures.
- **`src/tagging.py`** — `extract_tags(jd_text, title, company, *, client=None) -> Tags`.
  One Anthropic Messages call with a **forced tool-use** schema for the 8 fields (guarantees
  strict JSON, no parsing). Low temperature. Empty/short JD → mostly-blank `Tags`, never
  hallucinated. `client` is injectable for tests.
- **`src/review.py`** — orchestration + `main()`. Holds the quarantine/guard/loop logic,
  mirroring `run.py`'s structure. No HTTP or LLM specifics leak in here.
- **`src/sheet.py`** — extended store (see §6).
- **`src/models.py`** — new `Tags` dataclass.

## 5. Tag schema (8 new Jobs columns, appended right of `posted`)

| column            | meaning / example                                                        |
|-------------------|--------------------------------------------------------------------------|
| `yoe`             | years of experience requested — `"5+"`, `"3-5"`, `""` if unstated        |
| `seniority`       | normalized level — APM / PM / Senior / Staff / GPM / Director / VP        |
| `company_industry`| industry + main products — `"Fintech — payments/cards"`                  |
| `role_focus`      | the specific product/domain/team of THIS role — `"Checkout platform"`    |
| `skills`          | condensed requirement/qual bullets, one cell, `"; "`-joined              |
| `comp_range`      | salary range from JD when present — `"$160k–$190k"`, `""` if absent       |
| `work_model`      | normalized — `"Remote (US)"`, `"Hybrid — NYC"`, `"Onsite"`               |
| `tagged_at`       | ISO date stamp. `""` = needs tagging (the work queue); set = done forever |

`Tags` dataclass carries the first 7 (tagged_at is set by the store at write time).

## 6. Storage changes (`src/sheet.py`)

- `JOBS_HEADER` extended with the 8 columns (order above).
- **`ensure_tag_columns()`** — reads the live header row; if any tag column is missing,
  appends it (and the header cell) so your **existing Sheet self-migrates** on first run. No
  manual column surgery. Idempotent.
- **`read_jobs_for_tagging() -> list[(JobRecord, row_number, tagged_at)]`** — or equivalent —
  so the pass knows which rows need work and where to write. Reused company→slug map comes
  from `read_companies()`.
- **`write_tags(id_to_tags: dict[str, Tags], today: str)`** — batch `batch_update` of the tag
  cells keyed by row (same mechanism as `set_status`), stamping `tagged_at = today`.
- `FakeSheetStore` gains matching in-memory behavior (tag storage, header migration no-op,
  selection) for tests.

Column-position safety: new columns are appended to the **right**, so existing tabs, formulas,
and any user-built filtered view referencing current column letters keep working.

## 7. JD fetch detail (`src/jobcontent.py`)

> **Implementation note:** the original design described an "ATS APIs + URL fallback" strategy.
> During implementation the URL-scrape fallback was dropped after probing live APIs — see the
> end of this section for the rationale.

- **Greenhouse:** `/v1/boards/{slug}/jobs/{native_id}` (content=true) — `content` is
  double-escaped HTML → unescape + strip.
- **Ashby:** `/posting-api/job-board/{slug}?includeCompensation=true` — find job by id,
  extract `descriptionPlain`.
- **Lever:** `/v0/postings/{slug}/{native_id}?mode=json` — `descriptionPlain` + lists +
  `additionalPlain`.
- **SmartRecruiters:** `/v1/companies/{slug}/postings/{native_id}` — `jobAd.sections` text.
- **Workday:** reconstruct the CXS detail URL from the stored job URL
  (`https://{host}/en-US/{site}{externalPath}` → `https://{host}/wday/cxs/{tenant}/{site}{externalPath}`)
  → `jobPostingInfo.jobDescription`.
- **URL-scrape fallback — dropped.** The only ATS lacking a clean JSON detail endpoint is
  Amazon. amazon.jobs is a JS SPA: `.json` returns 406 and the HTML contains no JD text
  (verified against live responses), so a scrape would only feed garbage to the LLM. Therefore
  `fetch_description` returns `""` for amazon/unknown ATS **without any network I/O**; those
  rows stay untagged and are re-evaluated cheaply each night (no HTTP, no LLM spend),
  self-healing if a usable source ever appears. This is a deliberate change from the original
  "ATS APIs + URL fallback" decision, made after probing the live APIs.
- **Slug source:** the `Jobs` row stores `id = {ats}-{native_id}` and `company`; slug comes
  from the Companies map.
- Any exception or empty result → return `""`; the row stays untagged and retries next night.

## 8. LLM call (`src/tagging.py`)

- **SDK:** `anthropic` (built-in retries/backoff). Model **`claude-haiku-4-5`** — cheapest,
  ample for extraction. Prompt-cache the static system/tool preamble.
- **Structured output:** a single tool (`emit_tags`) whose input_schema is the 7 fields;
  `tool_choice` forces it. We read the tool input directly — no regex/JSON-parse fragility.
- Temperature low (≈0). System prompt instructs: extract only what's stated; leave a field
  `""` rather than guessing; condense each skill bullet to ≤~5 words; normalize seniority and
  work_model to the fixed vocabularies.
- Input is `title`, `company`, and truncated `jd_text`. Cost ≈ fractions of a cent/job.

## 9. Cost & cadence (no cap)

Per explicit decision, **no per-run cap** — a cap would starve a freshly-added company that
needs many roles tagged at once. The pass drains the entire untagged-open backlog every night,
then idles. Day-one backfill of the whole sheet is a one-time bounded cost (Haiku × N rows,
cents). New companies fully catch up the very next night.

## 10. Config & deliverables

- **`.github/workflows/review.yml`** — nightly cron offset from discovery; runs
  `python -m src.review`; needs `ANTHROPIC_API_KEY` + `GOOGLE_SERVICE_ACCOUNT_JSON`.
- **`.env.example`** — add `ANTHROPIC_API_KEY`.
- **`requirements.txt`** — add `anthropic`.
- **`README.md`** — new "AI tagging (optional)" section: the secret, self-migrating columns,
  no-cap backfill behavior, and that it's safe to never enable.
- **`new_companies_to_add.csv`** (already created) — paste-ready rows for the 4 pending
  companies; unrelated to the tagger but bundled this session.

## 11. Reliability behaviors (must-haves)

- Missing key → loud skip, no crash, core unaffected.
- Per-job failure → quarantined, logged, retried next night (never re-billed once `tagged_at`
  is set).
- Whole-pass failure → ops ntfy alert + full traceback to the Actions log (mirrors `run.py`
  `main()`), never silent.
- Idempotent header migration; tagging is write-once per row.

## 12. Testing (TDD)

- `jobcontent`: each ATS detail parse on a saved fixture; URL-strip on an HTML fixture;
  failure → `""`.
- `tagging`: `extract_tags` with an **injected fake client** returning a canned tool input →
  correct `Tags`; empty JD → blank `Tags`.
- `review`: untagged-and-open selection; Closed/already-tagged skipped; per-job exception
  isolated (others still tagged); missing-key clean skip; `write_tags` stamps `tagged_at`.
- `sheet`: `ensure_tag_columns` adds only missing columns and is idempotent; `write_tags`
  targets correct cells; `FakeSheetStore` parity.

## 13. Open items for the implementation plan

- Confirm exact Ashby/Lever/SmartRecruiters detail endpoints + description field against live
  responses (capture fixtures during implementation).
- Decide `review.yml` cron offset (e.g. discovery 07:00 CT → tagger ~10:00 CT).
- JD truncation char budget for the LLM input.
