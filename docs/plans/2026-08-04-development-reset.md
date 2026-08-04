# Development reset: diagnosis and plan

Status: proposal for owner decision, 2026-08-04
Scope: process, verification economics, and pilot scope. No code change. This document
proposes decisions; it does not override `09-full-product-contract-v2.md` — only the
owner can. Decisions D1–D7 below each name what they would change.

## 1. The numbers this diagnosis rests on

Measured on this checkout (main at `a975835`, 2026-08-04):

- Of the last **50 commits** (all of July onward), roughly **10 are product** — the
  Today/Jobs/Applications/Coverage/Settings surfaces, the PgFeedStore cutover, Autopilot
  staging, one UI fix. The other **~40 are the machinery**: eight land.sh/merge-gate
  commits, ~12 test-infrastructure commits (slot budgets, container caps, volume
  isolation, assertion lints, mutant pins, gates for gates), ops plumbing (ntfy topics,
  backups), and docs about process.
- The webapp — the actual product — is **19 routes and 1.3 MB of app code**, carried by
  **11 MB of tests** and a verification stack of `land.sh` (796 lines) + `verify.sh`
  (598 lines) + a purpose-built Docker verification image measured in tens of GB.
- The governance corpus is **88 markdown docs**; `docs/pilot-launch/` alone is 776 KB.
  The requirements register holds **112 normative MUSTs**, each with an acceptance
  oracle, for a product with **zero external users**.
- The repo carries **two runtimes** (Next.js/TS product; Python discovery, render,
  monitor, and legacy Sheets lanes) and the owner's **personal job-search data**
  (master resume, nightly `snapshots/` commits, `users/`), so every gate defends
  private data as well as product code.

The requirements were never the problem. The ratio is: for a month, roughly four fifths
of all effort went into making it safe for agents to change the product instead of
changing the product.

## 2. Root causes, named so they are not repeated

1. **Scope inflation wearing an MVP costume.** `full-product-pilot-v2` defines the
   pilot as the complete product — entitlement lifecycle with revocation drills,
   Autopilot submission with provider evidence classes, billing seams, notification
   suppression, deletion orchestration, restore drills, WCAG 2.2 AA at five viewports
   with pixel baselines — before the first external user. That is not an MVP contract;
   it is a launch contract for a funded team, executed alone.
2. **Trauma-driven process accretion.** Every incident (dead agents on 2026-08-02, PRs
   #108/#109 merging over red, the dirty-laptop deploy) produced a new permanent,
   machine-enforced rule. Each rule is individually defensible; the sum is a system
   where the enforcement layer is the primary workstream. The repo now optimizes for
   "agents cannot break things" over "users can use things."
3. **The concurrency loop.** High agent parallelism caused the incidents (races, flaky
   timing tests, red main, lost work) that justified more gates, which made each change
   slower, which invited more parallelism. The 2026-08-02 retro already found this; the
   four rules it produced treat the symptoms while the swarm model that generates them
   stays default.
4. **Uniform maximum rigor before product-market contact.** Mutation testing, assertion-
   strength lints, anti-slop sweeps, and visual baselines are post-traction tools. Applied
   pre-launch, they tax every one-line change and have themselves become the largest
   source of red builds.
5. **One repo, three concerns.** Product, legacy personal tooling, and the owner's
   private data share a history, so a routine merge can publish a resume. Much of the
   fear the process encodes comes from this cohabitation, not from the product.

## 3. What is right and must not churn

The stack is correct and boring in the best way: **Next.js 15 + React 19 + Supabase
(Postgres, Auth, RLS, Storage) + Vercel + Tailwind/Radix**, Python confined to
discovery/render/monitor workers. This is the canonical 2026 solo-builder SaaS stack;
it scales past any pilot this product will see (Supabase Postgres to hundreds of GB and
tens of thousands of users; queues stay in Postgres; workers move to a small always-on
host only when Lambda cadence stops fitting). Changing the stack now is the one move
guaranteed to add months for zero user value. The 25 GB image is likewise not the dev
environment — daily work is `cd webapp && npm run demo` against fixtures; the image
exists only to reproduce CI exactly, pre-merge.

Also worth keeping, explicitly: append-only stamped migrations, default-deny ownership
at the DB boundary, fixture/live parity, the 30–45 minute task-sizing rule, and
`land.sh`'s existence while the plan lacks branch protection.

## 4. Proposed decisions

- **D1 — Recut the pilot (supersede `full-product-pilot-v2` with a v3).** Ship to the
  waiting users what already exists: auth + activation, Today, Jobs, Applications
  (manual status), Coverage, Settings, import/export, on Supabase + Vercel. Defer to
  post-pilot: Autopilot **submission executor and provider adapters** (keep Prepare/
  Review as a manual handoff — the contract's own manual-handoff language covers this),
  warm-introduction funnel, notifications beyond transactional email, deletion
  orchestration beyond account-delete + export, and **billing entirely** — founding
  users are free forever, so Stripe blocks nothing.
- **D2 — Process freeze.** A standing moratorium on new gates, lints, tiers, review
  standards, and process documents until the pilot has external users. The existing
  tier table stands; the default assumption becomes T0–T2, with T3+ reserved for the
  boundaries that earn it (migrations, RLS/RPC, storage, submission).
- **D3 — Serial development.** One agent (plus read-only reviewers), one task in
  flight, owner reviews each PR. The 30–45 minute sizing rule stays. Multi-round
  adversarial review below T3 ends. This dissolves the incident class that most of the
  last month's machinery exists to contain.
- **D4 — Separate the dev loop from the verification image.** Daily loop: `npm run
  demo`, `npx vitest`, targeted Playwright specs — no Docker. The image runs once,
  pre-merge, via `verify.sh --image`. Separately: branch protection (GitHub Pro/Team)
  would let CI enforce green-before-merge and retire most of `land.sh`'s reason to
  exist.
- **D5 — Execute the personal-vault split early (RM-40 exists; raise its priority).**
  Move master resume, `users/`, `snapshots/`, and nightly personal snapshots out of the
  product repo. Every merge stops being able to publish private data, and a whole class
  of enforced fear retires.
- **D6 — No new Python surface.** Python remains for the discovery adapters, the render
  worker, and the monitor, as contained workers behind Postgres. All new product
  behavior lands in the webapp/Supabase world.
- **D7 — A weekly deploy is a gate too.** `deploy.yml` runs at least weekly once D1 is
  cut. A pilot user on the real product finds what no lint can.

## 5. Agentic-workflow practices (the generic answer)

No framework is required; the practices are: a one-page spec per feature (what/why/
out-of-scope/acceptance) written before the agent starts; plan mode before mutation;
one vertical slice per task, sized to 30–45 minutes; commit and push per logical unit;
CI as the only merge gate; worktrees for isolation when parallelism is genuinely needed;
resume a stalled session rather than restarting it. This repo already discovered most
of these — the correction is to *stop adding* to them.

## 6. Order of execution, if accepted

1. Owner accepts/edits D1 scope cut; record it as a v3 contract note (an afternoon).
2. D5 vault split (one focused day; it de-risks everything after).
3. D2/D3 take effect immediately — they are stop-doing decisions, not work.
4. Resume the roadmap restricted to the D1 cut: finish auth/activation hardening
   (RM-10/11), the remaining surface states, then deploy and invite the first user.
