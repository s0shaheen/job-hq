# HQ v2 — master build tracker & execution contract

**This is the resumable map for the full HQ v2 build.** A fresh session — after a
`/clear`, a context compaction, or a new background job — reads **this file + the
referenced phase plans** and continues from the current checkpoint without needing the
originating conversation. **State lives here, not in chat.** Every increment updates the
Checkpoint Log at the bottom before its PR is opened.

Companion living logs: `docs/WEBAPP-BUILD.md` (webapp-phase detail, "don't re-litigate"
rules), `docs/plans/README.md` (the phase punch-list + conflict resolutions),
`docs/plans/COMPANY-DISCOVERY.md` + `COMPANY-DISCOVERY-RESEARCH.md` (the discovery design +
grounded findings).

---

## 1. What we're building (the wider puzzle)

**End state:** a self-serve, *multi-user* job-search product where non-operators (Salman's
dad, roommate, later friends) each onboard, get their company universe populated
automatically, and run their whole search in the app — the spreadsheet closes.

Company discovery is the organ that **fills the shelves**; the webapp phases are **the
store**; multi-user is what makes it a **product, not a personal tool**; OSS opens it up.
All four are the build. Mapped to a new person's journey:

| Journey step | Component | Track | Status |
|---|---|---|---|
| Onboard ("who am I, what I want") | Profile wizard | 2 | not built (stub) |
| Get my universe populated | Discovery infra (engine + agent + oracle) | 1 | designed, building |
| Pull the jobs reliably, day-of | Resolution engine + adapters + Tier-2 | 1 | 12 adapters; +3 in scope |
| See & triage | Grid (`/jobs`) | — | ✅ done (PRs #31–34) |
| Manage status (human-wins) | Pipeline | 2 | partial (read-only) |
| Import my existing tracker | Import | 2 | not built |
| Get notified, act in one tap | Digest | 2 | not built (legacy markdown) |
| …all per-user, shared universe | Multi-user / RLS / subscriptions | 3 | partial |
| …eventually open to the world | OSS + security | 4 | not started |

---

## 2. Operating contract (how the autonomous loop runs)

Each phase → its own branch → draft PR → gates → **merge on green** → checkpoint → next
phase, continuously, until token budget or a real blocker (money / history-purge / a genuine
fork). Salman authorized autonomous build + merge (2026-07-23).

**The per-phase gate stack (all must pass before merge):**
1. **Test-first** — each failure-mode gets a test that **fails before the fix**, then goes
   green ("a test that cannot fail is worse than no test").
2. **CI green** — full suite: `pytest` + webapp `vitest` + Playwright + `db` migration job.
   Never merge red.
3. **Adversarial review** — a review-agent (or `/code-review`) skeptical pass on the diff.
4. **Merge** — squash via `gh pr merge`, **never** direct-push to `main`, **never**
   force-push, **never** touch `resume/` (a push there publishes a resume to Drive).
5. **Durability tripwire** — any change to `core/schema.py`, `core/sheets.py`, or a
   migration is surfaced explicitly, stays single-threaded, and never fans out.

**What needs the human (I pause and ask; I do not preempt):**
- Spending money (paid sources: Coresignal etc.).
- Rewriting git history (E17 / `git filter-repo`).
- A genuine product fork not resolved in the plans.
(Password rotation E16 = done 2026-07-23. Merges = authorized. Key plumbing = §3.)

**Context management (why long runs stay coherent):**
- Token-heavy work (research, audits, broad reads) runs in **subagents/workflows** — their
  volume never enters the main thread; only distilled results return.
- **Delegate self-contained BUILD units too, not just research.** A spec'd, independent module
  ("build `X` per its spec, test it, live-verify, open a draft PR") goes to a subagent so the
  build's file-reads / test-output / diffs never bloat this loop; independent units parallelize.
  The main loop keeps only: exploratory loops (each step informs the next), judgment-dense design,
  the durability contract, and orchestration. *(Learned the hard way 2026-07-24: hand-coding P1–P6
  in-chat bloated context and forced an early /clear. Memory: `feedback-delegate-builds-to-subagents`.)*
- Every increment **checkpoints to this doc** → a clear/compaction loses nothing.
- **Small PRs**, one concern each → independently reviewable + revertable.

**Landmines (from the repo audit — honor these):**
- Durability contract is **single-threaded**: `sheets.py` is the only sheet write path;
  new columns go through `schema.py` + bootstrap/self-heal, never positional; migrations are
  **append-only, serially numbered** (five plans once all collided on `0003`).
- Webapp "don't re-litigate": no `revalidatePath("/queue")`; demo stores keyed by cookie;
  **`npm install` not `npm ci`** (Tailwind v4 oxide binary); visual snapshots are
  **linux-only / opt-in** (separate CI job); undeliverable notifications are *kept* not
  reverted; **server-side export only**.
- The globalThis-store bug class: every new persistence E2E must **reload** (133 green tests
  once missed a triple-instantiated store). jsdom has no layout engine → virtualization /
  overflow asserts run in Playwright only.
- Cross-language parity (Python↔TS) uses a **golden fixture** asserted by both suites
  (pattern: `tests/fixtures/jobkeys.golden.json`).

---

## 3. Key / secret plumbing (current blocker for 2 phases)

`THEIRSTACK_API_KEY` and `ANTHROPIC_API_KEY` are **GitHub Actions secrets** (correct for the
cron) but are **not in the local shell/subagent env**, and shell exports don't persist
between commands here. So keyed/LLM work can't run locally as-is. **Unblock path (pick one):**
- **(a) Local `.env`** — drop both keys into `.env` at repo root (gitignored per
  `.gitignore`); keyed commands run `set -a; source .env; set +a` first. Fastest for
  iterative dev.
- **(b) Actions dispatch** — run the keyed validation as a `workflow_dispatch` job on the
  secrets already set. Slower loop, zero secrets on disk.

Affected: **P3** (coverage oracle — TheirStack), **P6** (discovery agent — LLM recall + oracle
scoring). Both are **built keyless-first against fixtures**; live validation waits on (a) or
(b). Nothing else is blocked.

---

## 4. The phases

Migration numbers are assigned **serially at build time** (durability rule); penciled numbers
below are the current expectation (next free = **0007**).

### Track 1 — The universe engine (discovery infra, leads)

- **P0 · Build-tracker doc** — *this doc.* The map + operating contract. **← in progress**
- **P1 · Resolution engine** — harden `monitor/discover.py`: more slug candidates (grounded
  miss: DRW = greenhouse `drweng`), a company-name/location **sanity check** before accepting
  a board (grounded false-positive: ADM → `archer` = a vet clinic), fail-loud on ambiguous +
  a verify harness/corpus. Files: `monitor/discover.py`, `monitor/tests/`. *keyless.*
- **P2 · Universe schema** — add `source`, `reliability_tier`, `resolution_method`, `enabled`
  to `companies`/`user_companies`; migration **0007**. Durability-contract: goes through
  `core/schema.py` + bootstrap/self-heal, not ad-hoc. Files: `core/schema.py`,
  `db/migrations/0007_*.sql`.
- **P3 · Coverage oracle** — `POST /v1/companies/search` denominator + recall-diff into
  `monitor/wide.py`. **Corrected by research:** free blur+exclusion is contradicted by
  `wide.py:241` (blur strips company-identifier filters) → recall via paid exclusion **or**
  client-side diff of the blurred set. *needs key (§3).*
- **P4 · New adapters** — spec: **[COMPANY-DISCOVERY-ADAPTERS.md](COMPANY-DISCOVERY-ADAPTERS.md)**
  (grounded recon done 2026-07-24, all endpoints live-`curl`-verified). Refined scope:
  **build `icims.py`** (clean keyless JSON — Aon/Exelon) and **`successfactors.py`** (keyless
  CSB HTML, token `sfsf` — Grainger/SAP); **enhance `discover.py`** with Workday slug discovery
  (redirect→dork→verify-by-CXS-POST). **Taleo stays Tier-2** — no stateless public endpoint;
  aggregator already covers it (don't build a fragile JSF/HTML scraper). Build order:
  iCIMS → SuccessFactors → Workday discovery, each its own PR + golden fixture. *keyless.*
- **P5 · Free-source ingestion** — ATS dorking, Common Crawl slug mining, SEC EDGAR
  (IL filers), Form ADV (IL RIAs) → the resolver. Each validated free in the research pass.
  *keyless.*
- **P6 · Discovery agent** — the generate→ground→verify→expand workflow: LLM = recall only,
  every name grounded by the P1 waterfall, oracle (P3) scores coverage, gap list = next work
  queue. *needs LLM to run live; built against fixtures.*
- **P7 · `/companies` review grid** — clone `/jobs` primitives: streaming NL "add" bar,
  provenance popover (reuse `why-popover.tsx`), bulk approve/reject (reuse `selection.ts` +
  `bulk-actions.ts`), coverage meter (**must distinguish grounded vs estimated tiers** —
  research caveat), + sweep integration honoring `enabled`/`priority`. Files: `webapp/app/(app)/companies/*`.

### Track 2 — The surfaces (consume the universe)

- **P8 · `lib/status.ts` + Pipeline** (0008) — shared status vocab (blocks Pipeline+Import) +
  human-wins status editing, notes entity, confirm/reject suggestions, delisted badge. Plan:
  `PHASE-PIPELINE.md`.
- **P9 · Profile wizard** (0009) — self-serve onboarding + **preview-before-commit**; pairs
  with discovery = full onboarding. Plan: `PHASE-PROFILE.md`. (Ordered before Import: a new
  user onboards before they import.)
- **P10 · Import** (0010) — xlsx/csv, column mapping, dedup preview, batch commit + 24h undo,
  Excel round-trip. Plan: `PHASE-IMPORT.md`.
- **P11 · Digest** (0011) — signed one-click Interested/Not-for-me links, per-channel
  notifications, quiet hours + the independent Python increments 1–2 (AC24/25). Plan:
  `PHASE-DIGEST.md`.

### Track 3 — Hardening & multi-user (makes it a product)

- **P12 · Orphans** — snooze-wake (AC17, exists nowhere), Gmail-capture silent>24h banner
  (G10 — bites *now* at N=1), scout identity (G15), G6 per-posting override, G3-reopen.
- **P13 · Multi-user** — per-user subscription/budget, RLS across all per-user tables,
  "new user = profile + subscribe" path, digest recipient isolation.

### Track 4 — Open-source & security (gated on the human)

- **P14 · Externalize IDs** — `hq.config.yaml` live IDs → env + example template.
- **P15 · Public/private split** — engine (`core`/`monitor`/`tracker`/`webapp`) vs private
  overlay (`resume`/`applications`/`interview-prep`/`snapshots`) + seed data + README/LICENSE.
- **P16 · History purge** — E17 `git filter-repo` (the leaked-CSV history). **Human go
  required**; isolated; before any public exposure.

---

## 5. Parallelization map

**Fan out as read-only workflows** (independent, no shared-file writes):
- P4 adapter research (one agent per ATS family) — **running now**.
- P3/P6 keyed oracle validation (once §3 is unblocked).
- P5 free-source ingestion recon (per source).
- P12 spec-hardening of the 4 webapp phase plans (independent docs).
- P15/P16 secret+PII history audit.

**Strictly serial** (shared files / durability contract): every phase *implementation*,
all migrations, anything touching `core/schema.py` / `core/sheets.py` / the grid primitives.

---

## 6. Checkpoint Log (the resume pointer — newest first)

- **2026-07-25** — **BLOCKER: GitHub Actions billing** (payment failed / spending-limit) halts CI
  *and* the production cron bots. Salman chose to migrate the **cron off Actions → AWS Lambda +
  EventBridge**. Built in `infra/` (this PR): `app/handler.py` (dispatches `{"job"}` → the exact
  `python -m` sequences; SSM secrets), `Dockerfile` (Lambda container), `terraform/` (ECR + Lambda
  + least-priv IAM + one EventBridge schedule per bot; 8 live bots ported 1:1), `README.md`
  (5-command runbook). Handler unit-tested (6) + full suite green; Terraform validated by the user's
  `terraform plan`. **Follow-ons:** backups (snapshot/pgdump)→S3; trim/self-host CI. **Salman must:**
  AWS account → SSM secrets → build+push image → `terraform apply` (runbook). Stopgap: fixing Actions
  billing restarts the bots today.
- **Discovery P5 integration (#51) + ATS-dork (#52)** — built + LOCALLY-verified green, **unmerged
  because CI can't run (billing)**. `discover_universe.py` (ingest→resolve→pg upsert) + `ingest_dork.py`
  (found DRW/`drweng` live). Merge both once Actions is back (or `--admin`).
- **2026-07-24** — **P5 free-source ingestion (3 sources) DONE — via delegated build-agents**
  (first use of the delegate-builds rule; worked cleanly: 319k tokens in subagents, ~2k in the
  main loop). Merged: `monitor/scripts/ingest_edgar.py` (#49, 300 IL public filers live),
  `ingest_formadv.py` (#47, 672 IL RIAs), `ingest_commoncrawl.py` (#48, 412 Greenhouse slugs).
  Each: own module + fixture + mocked-HTTP tests, live-verified, file-scoped.
  **Follow-ons (delegate these too):** (a) **ATS-dorking** ingestion (4th source, needs WebSearch);
  (b) **INTEGRATION** — a thin combiner that feeds the per-source candidates into `bulk_discover`
  (resolve plain names via `monitor.discover`; Common Crawl slugs are pre-resolved greenhouse) →
  the shared universe (P2 columns: source/tier/resolution_method). Then **P7 `/companies` grid**
  (spec it, delegate to a build-agent; clone the `/jobs` primitives + `why-popover` per
  `COMPANY-DISCOVERY-ADAPTERS`/the UX teardown). **Resume: delegate P5-integration + ATS-dork, or
  spec+delegate P7.** Track-1 discovery infra is otherwise complete (resolver P1, adapters P4,
  schema P2, oracle P3, agent P6, ingestion P5). Keys live in `.env`.
- **2026-07-24** — **P6 discovery agent (generate→ground core) DONE.** `monitor/discovery_agent.py`:
  `discover_companies(facet)` → LLM (Haiku) proposes company names = recall-only; every name is
  discarded unless `monitor.discover` grounds it to a pullable board. 4 unit tests (fake LLM +
  fake resolver, key-free) + **live: "US fintech" → 8/12 grounded** (Stripe/Robinhood/SoFi/Chime/
  Block/Affirm/Upstart→greenhouse, Wise→smartrec; PayPal/Klarna/etc.→aggregator) + full suite green.
  One Haiku call/facet (cents). Follow-ons (compose on this): facet decomposition into categories,
  "find more like these" expansion, oracle-guided gap-filling, and writing proposals to the review
  grid. **The discovery brain is functional end-to-end** (NL → names → grounded Tier-1 companies).
  **Next: P5 free-source ingestion** or **P7 `/companies` review grid** (both keyless).
- **2026-07-24** — **P3 coverage oracle DONE** (keys now live in `.env`). `monitor/oracle.py`:
  `denominator(facet)` and `coverage(facet, universe)` → recall = 1 − gap_D/D, **all free (blurred
  jobs/search)**. **Settled the research's #1 open question empirically:** exclusion filters
  (`company_name_not`/`company_domain_not`) DO apply under blur (D 1405→1395 excluding big
  employers) — `wide.py:241` only strips the *inclusion* fence, so the free recall-diff is real.
  Also corrected: the denominator is **jobs/search** `metadata.total_companies`, NOT companies/search
  (which filters firmographics, rejects `job_title_or`). 6 unit tests (fake session, key-free) +
  **live: TECH facet D=12110 (our universe ≈4.1%), FINANCE D=1405 (≈1.6%)**, 644-name exclusion ran
  fine + full suite green. Research doc corrected. **Next: P6 discovery agent** (ANTHROPIC now live)
  or P5/P7. Running continuously — surfacing only for spend/forks.
- **2026-07-24** — **P2 universe schema DONE** — merged (PR #43, review-gated). (durability
  contract). `db/migrations/0007_universe_metadata.sql` adds `source`, `reliability_tier`
  (smallint, CHECK null|1|2|3), `resolution_method` to the shared `public.companies` — all
  additive/nullable so the sheet→pg mirror (name/ats/slug only) is unaffected. No per-user
  column: `user_companies.monitor` is already the on/off toggle. **Scope call: Postgres-only** —
  discovery is webapp-native (the `/companies` grid + agent write pg); the *sheet* Companies-tab
  columns + the sweep honoring tier/enabled move to **P7** (sweep integration). Validated on
  **real Postgres via docker** (0007 applies clean, columns/types/CHECK/defaults correct, all
  existing db tests pass) + regular suite green; `tests/db/test_universe_schema.py` pins it.
  **Next (after P2 merges): P5 free-source ingestion** or **P7 `/companies` grid** — both keyless;
  P3/P6 need §3 keys.
- **2026-07-24** — **P4 Workday slug discovery DONE → P4 COMPLETE** — merged (PR #42). Added a Workday
  branch to `monitor/discover.py`: `resolve_workday(careers_url)` (redirect-follow + embedded-link)
  and `discover_workday(name, domain=)`, both gated by `_verify_workday` (CXS POST is the single
  source of truth — never DNS/pod-guessing; status ladder 200/404/422/401). Name-based guessing
  uses STRONG candidates only (full/hyphenated — never the lone first word), so it fails closed.
  Wired as a second pass in `bulk_discover.py` + the CLI. 7 new tests + **live end-to-end: name →
  verified slug `ntrs.wd1…/northerntrust` → existing fetcher pulled 40 jobs**. Full suite green.
  Web-search dork (CME/Allstate/Abbott, non-redirecting front doors) is the documented follow-on.
  **P4 adapters COMPLETE:** iCIMS ✅ (#40), SuccessFactors ✅ (#41), Workday discovery ✅, Taleo →
  Tier-2. **Next: P2 — universe schema** (migration 0007) — gets the full review-agent gate
  (durability contract). §3 key plumbing still pending (P3/P6 live validation only).
- **2026-07-24** — **P4 SuccessFactors adapter DONE** — merged (PR #41). `monitor/fetchers/successfactors.py`
  (keyless CSB HTML tiles, regex-parsed — no new dep; `search=`-based, registered in `_REGISTRY`
  + `_SEARCH_ATS`, token `sfsf`). Added an `sfsf` pattern to `core/jobkeys.py` (LAST position —
  keys CSB's vanity-host `/job/<slug>/<10-digit id>` URLs so `Job.id == job_key(url)`, the fetcher
  contract; non-collision proven vs radancy/oraclehcm/url-fallback). Dedups mobile/desktop tile
  variants, pairs+cleans location. Verified: unit tests + fixture + **live 195-job Grainger fetch
  with jobkeys parity holding on real data** + full suite green. Akamai tenants (McDonald's) →
  Tier-2 by design. **Next: P4 Workday slug discovery** (`discover.py` branch), then P2 schema.
- **2026-07-24** — **P4 iCIMS adapter DONE** — merged (PR #40). `monitor/fetchers/icims.py` (keyless
  careers-home/jibeapply JSON, paginated); registered slug-only in `_REGISTRY`. `native_id`
  derived from the classic `apply_url` so `Job.id` matches `core.jobkeys` → Gmail auto-advance
  aligns (parity-tested); correctly distinguishes sibling tenants (comed/peco/exeloncorp) that
  reuse slug numbers. 5 unit tests + golden fixture + **live 99-job Exelon fetch** + full suite
  green. Gate rule logged: review-agent gate is for durability-contract/large/UI changes; a small
  isolated additive module (a fetcher) gets self-review + full-suite + live-verify.
  **Next: P4 SuccessFactors** (`successfactors.py`), then Workday slug discovery.
- **2026-07-24** — **P4 recon DONE** → spec in `COMPANY-DISCOVERY-ADAPTERS.md`. All endpoints
  live-verified. Refined scope: build **iCIMS** + **SuccessFactors** adapters, **enhance
  `discover.py`** for Workday slug discovery, **Taleo → Tier-2** (no clean public endpoint).
  (Recon workflow `wf_96848a0e-8fe`: 4/4 recon agents high-confidence; synthesis agent hit a
  schema retry-cap and died — synthesized by hand from `journal.jsonl` instead. Lesson: keep
  synthesis-agent schemas loose / synthesize inline.) **Next: build P4 iCIMS** (cleanest —
  keyless JSON), then SuccessFactors, then Workday discovery; P2 schema interleaves. Still
  keyless. §3 key plumbing still pending (P3/P6 only).
- **2026-07-24** — **P1 DONE** (`discover.py` hardening) — merged (PR #38, `503ba50`). Fixed the grounded
  false-positive (ADM→greenhouse `archer`=a vet clinic) via board-name verification
  (`_name_plausible` + `_greenhouse_board_name`); `discover()` now rejects a slug that
  resolves to an unrelated company's board instead of guessing. 13 new unit tests + full
  suite green + live-verified (ADM→unresolved, Stripe→greenhouse). The DRW `drweng` *miss* is
  intentionally out of scope (unguessable slug → the web-search waterfall stage owns it).
  Gate note: P1 is a ~40-line isolated, thrice-verified change → self-review + full suite +
  live check; the adversarial review-agent gate applies from **P2** onward (schema/migrations/UI).
  **Next: P2 — universe schema** (`companies`/`user_companies` columns, migration 0007) once
  P1 merges. P4 adapter recon still running in background.
- **2026-07-23** — P0 done: tracker doc **merged** (PR #37, `7aaa608`); research pass merged
  (PR #36, `afb56e4`). Branch cleanup done (→ clean 4/4). Password rotated (E16 ✓). Blocked-
  pending-human: §3 key plumbing (for P3/P6 live validation only).
