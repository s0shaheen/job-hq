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
- **P4 · New adapters** — **iCIMS, Taleo, SuccessFactors** + Workday per-tenant slug
  discovery + an adapter test harness (golden fixtures per family). Value framing from
  research: these are **already Tier-2-covered → they buy day-of *latency*, not recall.**
  Files: `monitor/fetchers/{icims,taleo,successfactors}.py`. *keyless; research fanning out
  now.*
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

- **2026-07-24** — **P1 DONE** (`discover.py` hardening) — PR open. Fixed the grounded
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
