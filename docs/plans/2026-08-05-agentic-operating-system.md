# The agentic operating system: research-grounded reset

Status: proposal for owner decision, 2026-08-05. Supersedes the scope-cut framing (D1)
of `2026-08-04-development-reset.md`; D2–D7 of that document stand and are absorbed
below. This version is grounded in a field survey of spec-driven development tooling,
Next.js+Supabase reference architectures, and agent project-state systems as of
mid-2026 (sources at the end of each section).

## 0. The verdict in one paragraph

The full product is buildable from day one — Anthropic's own long-running-agent
harness demonstrates exactly that shape (a 200+ feature app driven to completion by
agents). The binding constraint in this repo was never product scope or the model. It
was that the "everything is already solved" thesis was applied to the product stack
and *not* to the development process: the stack is standard, but the verification
image, land.sh, verify.sh, the packet standard, the tier system, and the 88-document
governance corpus are all hand-rolled — invented incident-by-incident instead of
downloaded from the field, which has published, convergent solutions for every one of
those functions. The second constraint is memory architecture: agents have none across
sessions; this repo's memory layer (README, docs, live legacy code) contradicts its
own decisions, so sessions resurrect dead ones. Both constraints have standard fixes.

## 1. Memory architecture (fixes the "Sheets came back" class)

Documented failure class with named mitigations (Columbia DAPLab; Anthropic docs):
agents treat everything greppable as trustworthy; a stale doc is worse than no doc.
This repo's README literally opens by calling the product "one Google Sheet (the
cockpit)"; 61 of 88 docs mention Sheets; `tracker/` and `appsscript/` are live-looking
code. Mitigations, in field-proven order:

1. **Delete dead code; git history is the archive.** `tracker/`, `appsscript/`, Sheet
   paths in `core/`/`monitor/`. Where deletion is truly impossible (historical import
   tools), quarantine mechanically: separate top-level dir, a path-scoped
   `.claude/rules/` file that fires "LEGACY — do not extend or import" on read, and a
   CI check that fails if live code imports from it.
2. **README and CLAUDE.md describe only the present.** CLAUDE.md ≤200 lines
   (Anthropic guidance; adherence degrades beyond that): invariants, commands,
   conventions, and explicit negative invariants ("Sheets is dead; never revive").
   Project status is explicitly on Anthropic's exclude list for CLAUDE.md.
3. **State lives in a system with a state machine, not prose.** "Done" and
   "canceled" must be machine-readable fields. Chosen system below.
4. **Per-task plans are disposable** — deleted on merge or pasted into the issue/PR
   as a comment. A plans/ directory that accretes is the failure mode returning.
5. **Session bootstrap ritual**: first action of any session is to pull live state
   (open issues, branch, migration ledger) — never trust a plan document's snapshot.

## 2. State system of record

Field consensus for a solo founder on GitHub using Claude Code terminal + web:
**GitHub Issues as the task database** — zero cost, no new auth surface, readable
from web sessions and CI, no MCP context tax (driven via `gh` locally, the GitHub MCP
in hosted sessions). Projects v2 optional as a human-only view. Loop: issue → plan as
issue comment → branch/PR referencing it → CI green → merge closes issue.
Upgrade path if product-shaped planning is wanted later: Linear (free–$10/mo, mature
MCP, agent-assignable issues). Notion is a spec archive at best — pages have no
workflow states, which is precisely the missing property. Dark horse worth a one-day
trial: Beads (git-native issue graph, state travels with the repo into web sessions).

## 3. Spec architecture (answers "what is a feature")

The field converged on a **two-tier** decomposition (Kiro, GitHub Spec Kit, OpenSpec,
BMAD all implement it):

- **Tier 1 — product level, always loaded, small.** Constitution/steering:
  principles, stack, structure, conventions. This is CLAUDE.md plus a short
  `product.md`. NOT requirements, NOT status.
- **Tier 2 — feature level, the working unit.** A feature is **user-story to small
  epic sized — implementable in one to a few agent sessions**. Not "the Jobs page"
  (an epic to decompose), not a table cell (below spec granularity; that detail
  belongs inside a surface spec's state table). Each feature carries the uniform
  triplet: `requirements.md` (behavioral acceptance criteria, EARS-style "WHEN X THE
  SYSTEM SHALL Y") → `design.md` (architecture, data model, contracts) → `tasks.md`
  (atomic, dependency-ordered).

The owner's instinct that a page can be written about the `job` entity (source,
format, storage, consumers) is **correct and standard**: that is a capability/domain
spec. The methodology that keeps such specs true over time is **OpenSpec**
(brownfield-first): `openspec/specs/` holds living capability specs — the current
truth of the system — and `openspec/changes/` holds per-change packages whose delta
specs merge into the living specs on approval. This fixes the known Spec Kit flaw
that specs die on their feature branch. This repo already owns the raw material: the
data dictionary, contract v2, and design-parity docs distill into capability specs;
the rest of the 88-doc corpus is archived.

**The acceptance ledger.** Anthropic's harness finding: the artifact that most
improves long-horizon agent work is a machine-checkable feature list — JSON, one
entry per testable behavior, `"passes": false` until proven, deliberately not
markdown (models tamper with checklists more readily than JSON). This repo already
wrote it: the 112-MUST requirements register IS that artifact, in the wrong format.
Convert register rows to `acceptance/register.json` entries with id, requirement,
oracle, status, evidence link. That file — not any narrative doc — defines done.

## 4. Verification diet (field norms vs this repo)

Endorsed unreservedly by the field, keep: the DB/RLS test layer (pgTAP /
supabase-test-helpers norms — cross-user denial per table, blanket RLS-enabled
assertion; this repo's tests/db is the equivalent and is its crown jewel), typecheck,
vitest unit layer, and 10–30 critical-path Playwright tests (auth, core loop, money
path).

Above field norms pre-launch, demote to a pre-release lane or delete: visual pixel
baselines (flake-prone; even proponents scope them to design systems, not app pages),
mutation testing (absent from solo-SaaS practice), anti-slop sweeps beyond a copy
lint, cross-browser beyond Chromium + one WebKit pass. The verification image then
shrinks or disappears from the daily loop entirely.

Merge gate: buy GitHub Pro (~$4/mo), turn on branch protection with required checks —
the platform now enforces what `land.sh` was built to enforce; land.sh shrinks to a
convenience wrapper or retires.

## 5. Product stack (settled; two simplifications)

Keep: Next.js 15 + React 19 + Supabase (Auth, Postgres, RLS, Storage) + Vercel +
Tailwind/Radix. The 2026 survey confirms nothing on the market ships this repo's
write-path rigor (idempotent RPC commands, CAS, audit, default-deny) — the kits are
behind on the hard parts. Do not migrate onto a starter kit (community consensus is
unambiguous for an already-built app); strip-mine patterns instead: Basejump's RLS
account schema + pgTAP suite, Makerkit's RLS best-practices, next-forge's monorepo
boundaries. Two consolidations to schedule (not urgent):

- **Background jobs**: the AWS Lambda/EventBridge/Terraform lane is the odd system
  out. Field default for this stack: pg_cron + pgmq (Supabase Queues) + Edge
  Functions for minimal-vendor, or Trigger.dev (~$10/mo) for long-running work.
  Migrate discovery/monitor lanes when they next need real work anyway.
- **Email**: Resend over raw SES until ~100k emails/mo (it runs on SES; pays for the
  DX and suppression handling).

## 6. Execution harness (per-feature loop)

Derived from Anthropic's harness + GSD + this repo's own validated rules (the
30–45-minute packet rule independently matches the field's one-feature-per-session
finding — keep it):

1. Pick the next issue; orchestrator session stays lean.
2. Fresh-context implementation session per feature: read constitution + the
   feature's spec triplet + relevant capability specs; nothing else.
3. Commit and push per task; leave main-mergeable state always.
4. Separate verifier (subagent or fresh session) checks acceptance entries
   end-to-end — the implementer never grades itself; flip register.json entries only
   with evidence.
5. ≤3 concurrent agents (existing rule, matches field consensus of 3–5).
6. Adversarial multi-round review only at the security boundary (migrations, RLS,
   RPC, storage, submission) — T3+ in the existing tier table.

## 7. Order of execution

**Reset week (before any new feature work):**
- Day 1: Purge — delete `tracker/`, `appsscript/`, dead Sheet paths; rewrite README
  to describe the web product; move personal vault out (RM-40). One PR each.
- Day 2: CLAUDE.md diet to ≤200 lines; archive docs corpus to `docs/archive/`;
  distill data dictionary + contract into `openspec/specs/` capability specs.
- Day 3: Convert the requirements register to `acceptance/register.json`; convert RM
  roadmap items to GitHub Issues with dependencies noted.
- Day 4: Verification diet — retag suites into daily lane vs pre-release lane;
  branch protection on; land.sh demoted.
- Day 5: First feature through the new loop end-to-end as the proving run.

**Then:** execute the roadmap DAG unchanged in its own stated order (auth/entitlement
→ surfaces → autopilot → billing/ops/release), one feature spec at a time, register
entries flipping to passing as the progress display. The full-product contract stays;
its sequencing already defers billing/ops to late waves.

**Future greenfield projects, day-zero checklist:** pick the boring stack; start from
a pattern-rich starter or reference architecture rather than empty dirs; write the
constitution (≤200 lines) and product.md first; set up the state system (issues) and
acceptance ledger (JSON) before the first feature; branch protection + CI from
commit one; two-tier specs from the start; one feature per fresh session; delete
what dies, immediately.

## Key sources

Anthropic, "Effective harnesses for long-running agents" and Claude Code best
practices · GitHub Spec Kit + its criticism threads (#1784, #152) · Kiro spec docs
(requirements/design/tasks, EARS) · OpenSpec (living capability specs + change
deltas) · GSD, Ralph (filesystem-as-memory principle) · Böckeler, martinfowler.com
SDD tool analysis · Basejump / supabase-test-helpers / Makerkit RLS guides ·
Supabase Queues/pg_cron docs · Columbia DAPLab on agents vs stale docs · Linear MCP
and GitHub-native agent loop write-ups.
