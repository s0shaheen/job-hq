# PM Job Monitor — Design Spec

> Status: approved for planning · Date: 2026-05-26 · Owner: Salman

## 1. Problem

Monitor ~170 target companies' job boards daily for new Product Manager roles, surface only what's new, push it to my phone, and let me track each role's status — without manually checking boards and without having to open my laptop when something breaks.

The prior attempt (n8n + Google Sheets, Cloud Starter) failed on memory/timeout limits processing large ATS responses. A separate Modal-based voice-memo pipeline taught the real lesson: **the thing that kills these systems is operational fragility** — rotating secrets, overloaded services, race conditions, and silent failures that only surface when I notice nothing happened. This system is designed first for *operational durability*, second for features.

## 2. Core principle (the invariant)

**The daily core holds zero rotating secrets and fails loud, never silent. Everything fragile is quarantined so it can never take down the core.**

Concretely:
- The 131 zero-secret companies (4 standard ATS + Workday) are the core. They need no auth at all.
- The only secrets anywhere are a *static, non-rotating* Google service-account key and an optional Apify token — both used by isolated steps.
- Silence is never the success state: every run emits a positive signal (new-jobs push or heartbeat). No signal = something is broken, unambiguously.
- Any single company, the Apify module, or the LinkedIn module can fail without affecting anything else.

Every design decision below serves this principle.

## 3. Non-goals (explicitly out of v1)

- **LLM job scoring** (the approach `hire-signal` takes). Adds an Anthropic key, per-run cost, and a "credits ran out" failure mode. The existing scoring rubric scores *companies*, not jobs; job-level relevance is adequately handled by title keyword filtering. Deferred indefinitely.
- **Automated LinkedIn people-sourcing.** Highest-risk component (ToS violation, account-ban risk, paid + fragile third-party APIs, frequent breakage). Deferred to Phase 2 as an isolated, on-demand module. v1 ships the *manual* contact tracker it will later populate (§8).
- **Forking `hire-signal`.** It is real and validates the architecture, but it is TypeScript across four secret-holding services (Anthropic, Discord, Cloudflare Worker, Turso) — the exact multi-service fragility this project avoids. We build lean Python instead and borrow its good ideas (seed flag, staleness tiers).

## 4. Architecture

```
GitHub Actions (cron, ~07:00 CT daily)
   │
   ├─ for each PROFILE (v1: "pm" only):
   │     ├─ read Companies tab (monitor=TRUE) from the profile's Google Sheet
   │     ├─ FETCH TIER  (sequential, continue-on-error per company):
   │     │     greenhouse · ashby · lever · smartrecruiters · workday-cxs
   │     ├─ APIFY MODULE (isolated try/except — failure logged, core unaffected)
   │     ├─ filter titles (include / exclude keywords; exclude wins)
   │     ├─ dedup vs Sheet history on {ats}-{native_id}
   │     ├─ append NEW jobs · bump last_seen · stale→Closed (14d, system statuses only)
   │     ├─ write Health tab (monitored / zero / errored counts + messages)
   │     ├─ commit JSON backup snapshot to repo (write-only recovery net)
   │     └─ ntfy: count + first few new roles (+ contact tie-in), OR heartbeat if zero
   │
   └─ on workflow failure → ntfy failure alert (monitor-the-monitor)
```

### Module boundaries (Python, ~250–350 LOC)

| Module | Responsibility | Depends on |
|---|---|---|
| `fetchers/` | One function per ATS tier; input slug, output normalized job list | `requests` |
| `dedup.py` | Compute new vs. seen using `{ats}-{native_id}`; seed logic | — |
| `sheet.py` | Read Companies/Contacts; append/update Jobs & Health | `gspread` |
| `notify.py` | ntfy push, heartbeat, failure alert, weekly digest | `requests` |
| `discover.py` | Probe endpoints to find a company's ATS + slug (CLI helper) | `requests` |
| `apify.py` | Quarantined long-tail fetch via Apify actor | `requests` |
| `run.py` | Orchestrate one profile end-to-end | all above |

Each module is independently testable and small enough to debug at 7am.

## 5. Fetch tiers

| Tier | Providers | Endpoint | Secrets | ~Count |
|---|---|---|---|---|
| API core | Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | none | — |
| API core | Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false` | none | — |
| API core | Lever | `api.lever.co/v0/postings/{slug}?mode=json` | none | — |
| API core | SmartRecruiters | `api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100` | none | 125 total |
| Workday-CXS | Workday | `POST {tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | none | 6 |
| Apify (quarantined) | bespoke / Cloudflare-walled | Apify actor + token | 1 token | ~10–15 |

**Verified 2026-05-26:** the Workday CXS endpoint returns clean JSON (HTTP 200, `total` + `jobPostings[]` with title/externalPath/locationsText/postedOn and a stable `JR#` id in `bulletFields`). POST body: `{"appliedFacets":{}, "limit":20, "offset":0, "searchText":"product manager"}`; paginate via `offset`.

**Native ID per tier (dedup key):** Greenhouse `job.id` · Ashby `id` (uuid) · Lever `id` · SmartRecruiters `id` · Workday `JR#` from `bulletFields`. All stable across runs.

**Large responses** (OpenAI ~677, Anduril ~1900, Databricks ~789): request without description HTML where the ATS allows; iterate, never load all descriptions into memory. Paginate Workday (`offset`) and SmartRecruiters (`limit`/`offset`); Greenhouse/Ashby/Lever return the full list in one call.

**Slug discovery:** `python discover.py "Cerebras"` probes all five tiers and prints the matching `ats` + `slug`. Used once during setup to reclaim "custom careers page" companies that are secretly Greenhouse/Ashby/Workable embeds into the zero-secret tiers, and thereafter to onboard new companies.

## 6. Profiles (multi-user backbone)

A **profile** is the unit of extensibility. One YAML file = one user's entire search:

```yaml
# profiles/pm.yaml
name: pm
sheet_id: "<google sheet id>"
ntfy_topic: "salman-pm-jobs-x7f2"     # unguessable suffix
include: ["product manager", "apm", "senior pm", "group pm", "head of product", "tpm"]
exclude: ["product marketing", "product design", "product analyst", "pmm", "engineer"]
```

Title matching is **case-insensitive substring**, with **exclude taking priority over include** (e.g. "Product Manager, Marketing" matches both and is correctly excluded).

Adding a new user (dad: financial analyst / data analyst / BI) = drop `profiles/finance.yaml` with his `sheet_id`, `ntfy_topic`, his company list (in his Sheet), and his keyword sets. **Zero code changes.** v1 wires up `pm.yaml` only.

## 7. Storage & dedup safety

**Source of truth = the profile's Google Sheet**, accessed via a **service-account key** (a static credential that does not expire on a timer — the only ways it dies are explicit deletion or org-policy disablement). Stored as a GitHub Actions secret.

Tabs:
- **`Companies`** — `name · ats · slug · monitor(TRUE/FALSE)`
- **`Jobs`** — `id ({ats}-{native_id}, immutable, do not edit) · company · title · location · url · status · first_seen · last_seen · posted`
- **`Contacts`** — see §8
- **`Health`** — `company · ats · result(OK/ZERO/ERROR) · count · message · checked_at`

**Dedup integrity rules:**
- The Action keys dedup off the immutable `id` column only.
- The Action **commits a JSON snapshot of Jobs to the repo every run** as a write-only recovery net. It is never read back during normal operation — it exists so a stray manual Sheet edit cannot permanently corrupt dedup history.
- The Action only ever writes: new rows, `last_seen`, and *system* status transitions. It never overwrites a user-set status.

**Status values:** `New · Seen · Reviewing · Applied · Interviewing · Offer · Rejected · Skip · Closed`. The system distinguishes **system-set** statuses (`New`, `Seen`, `Closed`) from **user-set** statuses (everything else). Only system-set statuses are eligible for automatic transition.

## 8. Contacts (manual in v1, enrichable in Phase 2)

**`Contacts` tab** (per profile, fully manual in v1):
`company · name · title · linkedin_url · source(manual/suggested) · priority · status · next_action · last_touch · notes`

Contact `status`: `To Reach · Reaching Out · Awaiting Reply · Connected · Meeting · Done · Pass`.

**Zero-cost tie-in (v1):** when a new job appears at a company where you have ≥1 contact row, the ntfy push appends `(N contacts at <Company>)`, nudging you toward the warm path. Pure Sheet lookup, no fragility.

**Phase 2 (isolated, on-demand, flagged risky):** a separate LinkedIn module appends `source=suggested` ranked rows into this same tab based on company + criteria. It is manually triggered, never part of the daily cron, and if it breaks the manual tracker is completely untouched. ToS/cost/ban risks to be evaluated before building.

## 9. Reliability — silence is never "success"

| Threat | Defense |
|---|---|
| Nothing new today reads as "did it even run?" | **Heartbeat:** a quiet ntfy/health update every run, even on zero new jobs. |
| Dead slug returns 0 forever, looks like "no new jobs" | **Health tab** per-run + **weekly digest** ntfy: "162 ok · 4 zero · 1 errored: Cerebras(404)". |
| One bad company kills the whole run | Per-company try/except; run continues; failure recorded in Health. |
| GitHub Actions auto-disables cron after 60 days inactivity | Daily snapshot commit keeps the repo active; workflow also self-reports. |
| The run itself crashes | Workflow-failure step sends an ntfy alert (monitor-the-monitor). |
| Manual Sheet edit corrupts dedup | Immutable `id` column + write-only repo snapshot backup. |
| Secret rotation (the Modal killer) | Core has **no** secrets; only a static service-account key + optional Apify token, both isolated. |
| Memory blowup on huge boards | Drop description HTML; iterate; paginate. |
| ntfy push missed | Non-fatal — jobs persist in the Sheet flagged `New`; the push is only a ping, not the record. |

## 10. Core user flows

**Flow 1 — First-time setup / seeding.** A company's *first* observation ingests all current jobs into history as `Seen` with **no notification**. Only jobs appearing on subsequent runs notify. Same logic applies when adding a company later — its backlog seeds silently.

**Flow 2 — New job detected.** fetch → paginate → drop descriptions → title filter (exclude wins) → dedup on `{ats}-{native_id}` → append `New` → ntfy with count + first few + contact tie-in.

**Flow 3 — Nothing new.** Still send heartbeat + write Health. No signal at all ⇒ run died (Flow 9).

**Flow 4 — Triage.** ntfy → open Sheet → change Status. The Action never overwrites a user-set status.

**Flow 5 — Stale then reappear.** Job vanishes → after 14d, if status ∈ {New, Seen} → `Closed` (user statuses untouched). If it reappears: `Closed`(system) → flip to `New` + notify (genuinely reopened); user-set status → only bump `last_seen`, never re-notify. No duplicate row is ever created.

**Flow 6 — Add / remove company.** Add: append row → seeds silently. Remove: `monitor=FALSE` → skipped, all history preserved. `discover.py` resolves unknown slugs.

**Flow 7 — Silent failure / slug death.** 404 / 0 jobs / malformed → caught per company → Health row → weekly digest surfaces it in days.

**Flow 8 — Contacts.** Manual add → status progression; new job at a company with contacts annotates the push. Phase 2 appends suggested rows to the same tab in isolation.

**Flow 9 — Run failure / monitor-the-monitor.** Workflow failure → ntfy alert. GitHub 60-day auto-disable → mitigated by daily snapshot commit.

**Flow 10 — Add a new profile (dad).** Drop `profiles/finance.yaml` + his Sheet → next run iterates his profile. Zero code change.

## 11. Tech & deliverables

- **Language/libs:** Python 3.11+, `requests`, `gspread`, `PyYAML`.
- **Schedule/infra:** GitHub Actions cron + `workflow_dispatch` for manual runs. No server.
- **Notifications:** ntfy.sh (per-profile topic with unguessable suffix).
- **Storage:** Google Sheet per profile (source of truth) + JSON snapshot committed to repo (backup).
- **Repo hygiene:** clean module boundaries (§4), a real README (setup, adding companies, adding profiles, troubleshooting), `.env.example`, and a `companies.seed.csv` to bootstrap the Sheet. Portfolio-ready.

## 12. Open items for the implementation plan

- Confirm SmartRecruiters pagination shape and Ashby `includeCompensation=false` payload fields.
- Decide the exact Apify actor(s) for the bespoke long-tail and confirm free-tier headroom for daily use.
- Finalize the weekly-digest cadence (which weekday) and heartbeat verbosity.
- Define the initial PM include/exclude keyword set precisely (TPM = Technical *Product* vs *Program* Manager disambiguation).
