# Current decisions, blocking ADRs, and design addenda

Contract: `full-product-pilot-v2`

## 1. Locked decisions

| ID | Decision |
|---|---|
| DEC-001 | Activated pilot users receive the complete product, not a slice |
| DEC-002 | Gmail automatic status and mailbox ingestion are excluded |
| DEC-003 | Autopilot includes real provider-qualified submission and receipts |
| DEC-004 | Postgres/object storage are authoritative; Google Sheets have no runtime role |
| DEC-005 | Founding users are owner-assigned, free forever, and exempt from commercial quotas/charges |
| DEC-006 | Commercial exemption does not remove abuse, security, concurrency, provider, or infrastructure safety limits |
| DEC-007 | United States, any job family/seniority/work model |
| DEC-008 | Laptop and phone are supported; hosted product work cannot depend on the owner laptop |
| DEC-009 | Warm introductions use provider search without user LinkedIn session/cookie; outreach remains human-sent |
| DEC-010 | Resume/application/interview content specific to Salman leaves the product boundary |
| DEC-011 | True offline disables writes; no browser mutation queue |
| DEC-012 | Strict parity uses the owner’s read-only design bundle; agents do not invent UI |

## 2. Launch-blocking ADRs

Each ADR MUST record owner, options, recommendation, decision, date, affected interfaces,
security/privacy analysis, rollout, reversibility, and evidence.

| ADR | Decision required | Must precede |
|---|---|---|
| ADR-001 | Autopilot execution host: hosted, user-owned agent, hybrid, or another architecture | Executor protocol/adapters |
| ADR-002 | Autopilot autonomy: review every application versus policy-authorized unattended execution; eligibility and trust reset | Rules/consent/release claim |
| ADR-003 | Per-ATS launch support and provider policy/terms approval | Each adapter implementation/live test |
| ADR-004 | One-time legacy owner data: clean start or explicit one-time import with no continuing correlation | Sheet decommission |
| ADR-005 | Shared versus tenant-owned catalog: companies/postings, provenance, corrections, deletion effects, fetch-once/fan-out | Discovery/Postgres schema |
| ADR-006 | Object storage, encrypted backup, and KMS/key provider | Resume, receipts, restore |
| ADR-007 | Upload malware/quarantine/fail-closed policy | Resume upload |
| ADR-008 | Hosted uptime and application observability vendors | Production qualification |
| ADR-009 | Logo privacy: direct browser request or proxy/cache | Logo production release |
| ADR-010 | Named physical test devices and ownership for the browser policy in the contract | UI release qualification |
| ADR-011 | Notification sender/domain, support identity, deliverability provider, and staffed hours | Auth recovery/product email |
| ADR-012 | Privacy/terms, processor list, AI no-training/data-use posture, consent versioning | Invitations |
| ADR-013 | Submission receipt evidence classes, screenshot prohibition/redaction, access, retention | Receipt storage/classification |
| ADR-014 | Resume feature matrix: imports, RenderCV schema/themes/fonts, job-specific AI tailoring, lossy behavior | Resume design/build |
| ADR-015 | Stripe test ownership and later commercialization policy | Billing integration |
| ADR-017 | ntfy topic rotation: the committed topic literals are live credentials and one of them is the `resume.yml` fallback that broadcasts rendered resumes to a public broker. Owner must create replacements, and decide whether already-broadcast material is treated as exposed | RM-40 Step 1; any public repository visibility |
| ADR-018 | Third-party personal data: `users/dad/` and `users/roommate/` are two other people's job-search profiles, in history and in every clone. Deletion does not retract them. Decide whether those individuals are notified | RM-40 Step 6 |
| ADR-019 | Legacy resume pipeline disposition: vaulting `resume/base.yaml` breaks the single-tenant `editor/` app, `resume.yml`, and `scripts/publish_to_drive.py`. Retire, repoint, or keep them outside the product repository | RM-40 Step 5 |
| ADR-020 | Migration comments name individuals (`0010_pipeline.sql:557`, `0013_referral.sql:323`). Migrations are append-only and keyed by filename; editing re-runs them. Accept the deviation or fold into the history packet | RM-40 Step 4 |

RM-40 findings, classification, and the sequenced split are in
`20-personal-vault-audit.md`. ADR-004 additionally blocks RM-40 Step 5: vaulting
`users/*/profile.yaml` destroys the input to the one-time import path if the owner
chooses import over a clean start.

Unattended Autopilot is not silently deferred or silently included. Until ADR-002 is
signed, implementation may build exact Prepare/Review and explicit-approval submission
contracts, but the launch scope decision remains blocked.

## 3. Resolved ADRs

| ADR | Resolution |
|---|---|
| ADR-016 | Resolved 2026-07-29. Root `AGENTS.md` and `CLAUDE.md` now define the Postgres-only product model and retain narrowly scoped safety rules for historical Sheet code. |

## 4. Required design addenda

Visible implementation is blocked until every state maps to an owner artifact:

| ADD | Missing/changed design | Dependency |
|---|---|---|
| ADD-001 | Warm-intro multi-select, deterministic 40-total default across three searches, result shortfall, fit explanation | PKT-08B–D |
| ADD-002 | Full generic resume editor/import/render/version/attachment flows | PKT-05D–F |
| ADD-003 | Executor health/offline/update, provider manual handoff, outcome unknown, receipt redaction | PKT-07B–I |
| ADD-004 | Operator activation/suspension/consented support access/kill switches | identity/operator packets |
| ADD-005 | Responsive phone behavior for every template, including file upload/download/preview | UI qualification |
| ADD-006 | Billing lifecycle states beyond founding-free view | PKT-09A/B |
| ADD-007 | Account deletion irreversibility: already submitted employer applications cannot be recalled | PKT-09F |
| ADD-008 | Whether the Jobs Display popover WRITES its four knobs to `profiles`, or is per-session only. Migration 0025 made density, type size and keyboard hints a durable per-user record, and Settings persists them; `DisplayPopover.d.ts` carries no save affordance, no dirty state and no "applies to this session" line, and 04 §3 lists the control without saying which it is. The two readings are visibly different products — change density in Jobs, reload, and the row height either holds or reverts — so the surface keeps today's per-session behavior until the owner says | Jobs surface build |
| ADD-011 | Un-triage, bulk un-triage, import undo and digest undo against a job autopilot has already submitted: the gesture is refused, and no authored state shows a refused undo | PKT-07 autopilot surface |

No implementation worker may fill these gaps from taste.

### ADD-009 — an undo that is refused, and why it is a design gap and not a bug

`20260802_094615_autopilot_staging.sql` makes a stage that holds provider evidence
undeletable while its owner exists. That is the correct refusal — the alternative is
"undo" erasing the only proof an application was submitted — but it is a **user-visible
behaviour change to four shipped gestures**: `app_set_triage`, `app_set_triage_bulk`,
`app_import_undo` and `hq_digest_set_triage` all reach `delete from public.applications`.

What ships in the database now, so the refusal is not raw:

- both refusals lead with a sentence a person can read — "this application was already
  submitted by autopilot, so it cannot be removed" — with the stage id and state moved
  into the error's `DETAIL`, where PostgREST does not put them in `error.message`;
- the existing `{ ok: false, kind: "error", message }` path in `supabase-source.ts`
  therefore surfaces that sentence rather than a table name or a `42501`.

What is NOT decided, and is why this is an addendum rather than a fix: there is no
authored state for "this gesture is refused because the job was applied to". The honest
product answer is probably not an error banner at all — it is the row telling the user it
was submitted, with the undo affordance absent. That is a design question, and no worker
may invent it.

Not urgent in the ordering sense: no stage can reach `submitted` or hold a receipt until
the executor exists, and PKT-07A (execution host) is unsigned. It must be answered before
the executor ships, not before this migration lands.

### Recorded deviations

A deviation is a place where the implementation knowingly differs from an authored design
instruction. It is not a gap and must not be filed as one: an addendum asks the owner to
author something, a deviation asks them to accept something they already authored. Each
one names the assertion in the suite that keeps it visible.

### DEV-001 — default row density, a deviation rather than an addendum

**Not an addendum, and the distinction is the point.** An addendum asks the owner to
author something that does not exist. This asks them to accept something they already
authored: 01 §8 says "comfortable 40px (default)" and `jobs-handoff.md` says "and flip the
default". The source answers it twice. Filing it as a gap would have quietly converted a
known deviation into an open question, which is how a deviation stops being tracked.

So: the app currently renders 32px rows at defaults against a composition that draws 40px.
Design sign-off stays blocked on it. What is disputed is only **when** the app matches the
instruction, and that is a cutover question.

`data-density` is a single attribute on `<html>`. `/pipeline` and `/connections` honour it
and have not cut over to the authored design, so flipping the default today moves two
surfaces whose composition is still the old one, and invalidates a `main`-owned test whose
whole point is that migration 0025 moved no pixels. Both heights are built and the popover
reaches either; only the default is in question.

**Position: keep `dense` until the shared-shell cutover moves every surface together, then
flip to comfortable as part of that change.** Until then the deviation is asserted in the
suite naming this deviation, so it is visible rather than hidden — which is the only
property that makes deferring it honest. The owner may overrule at any time; nothing here is
expensive to reverse.

### DEV-002 — the live lane's seam refusals are not in the pinned-mutant ledger

**The instruction.** The coordinator asked, on the live-data lane's review round, that the
`fixtureSeamCookies` refusals be added to `tests/mutants/manifest.toml` — the pinned-mutant
ledger being the right home for exactly this defect class.

**Why they are not.** Three independent blockers, none of which the author can clear from a
`main`-based branch:

1. **The ledger is not on `main`.** It lives on `feat/mutant-ledger` (unmerged as of
   2026-08-02). Adding a `[[mutant]]` from here means either rebasing onto an unmerged
   branch or writing a file that does not exist in this branch's base.
2. **The runner refuses the patch by design.** `scripts/mutants.py`'s `_is_test_path`
   returns true for any path with `tests` in its parts, and the guard lives at
   `webapp/tests/e2e/support/mode.ts`. The manifest's own rule — "a patch touching
   `tests/**` is REFUSED at load time" — exists because the cheapest way to satisfy the
   ledger is to break a test file, which proves nothing. The rule is right; this guard is
   simply not the kind of thing it can host.
3. **There is no `vitest` runner.** The manifest accepts `pytest`, `pytest312` and
   `playwright`. The killing test is a vitest case, because that is the layer at which the
   refusal is reachable at all.

**What was done instead, so the substance is not lost.** The refusal was extracted from
`becomeAccount` into the pure `fixtureSeamCookies`, which is what made it drivable, and
`webapp/tests/unit/live-lane.test.ts` kills it: deleting the refusal reddens two cases,
demonstrated. The review's own mutation — fall through to `active` — was run and is red.
So the guard is proven; only its *registration* in the ledger is outstanding.

**What the integrator should do.** When `feat/mutant-ledger` lands, either add a `vitest`
runner and register these, or record here that vitest guards are proven in-suite and stay
out of the ledger by design. This deviation is the tracking record either way.

## 5. Discovery and general-market validity decision

The architecture packet MUST define:

- shared canonical companies/postings and tenant-owned subscriptions/decisions/apps;
- user/agent/provider provenance and correction semantics;
- fetch-once/fan-out where it preserves isolation;
- canonical job dedupe and provider-native identity;
- expiry/delisting/reopen rules;
- arbitrary company/board intake and grounding;
- general job-family taxonomy without hard-coded PM/finance defaults;
- deterministic profile gates versus learned ranking;
- salary/location/work-model normalization;
- a human-reviewed golden corpus across engineering, healthcare, sales, operations,
  finance, education, skilled trades, creative, entry-level, executive, remote, hybrid,
  and on-site roles.

Acceptance needs relevance/freshness/normalization measures and explicit “not enough
data,” never claims of exhaustive US coverage.

## 6. AI behavior contract

Any model-assisted answer draft, profile compilation, relevance explanation, or
candidate-fit analysis MUST:

- use versioned structured inputs/outputs;
- validate schema and reject extra/untrusted instructions from job/provider content;
- cite source facts/evidence where a factual claim appears;
- never convert missing evidence into a fact;
- degrade to a gap/manual review on timeout, refusal, malformed output, or low confidence;
- record model/prompt/evaluation versions without private content in telemetry;
- have adversarial prompt-injection, hallucination, polarity, job-family, latency, and
  provider-outage cases;
- comply with the approved no-training/data-use processor posture.

## 7. Current risks

| Risk | Stop/mitigation |
|---|---|
| Git contains a Postgres dump | Stop writer, incident inventory, encrypted restore, coordinated history decision |
| Live ntfy topics committed in seven files, one as a workflow fallback that attaches rendered resumes | ADR-017; rotate to secrets and delete the literal fallback. Already-broadcast material is irreversibly exposed |
| Untracked `interview-prep/` and a recruiter-screen audio file sit in the working tree uncovered by `.gitignore` | RM-40 Step 0: one `git add -A` commits them permanently |
| Owner role defaults are the silent fallback for every profile write and every worker sweep | RM-40 Step 4; the fix is an explicit unset state, not a different default |
| Demo fixtures carry the owner's identity and a compensation figure | RM-40 Step 3; demo mode is the surface a prospective user is shown |
| Third-party personal data is in history and in every clone | ADR-018; deletion does not retract it |
| Repository visibility is the only control holding most findings shut | Treat any visibility change, transfer, or fork as requiring RM-40 Steps 1–5 complete first |
| `0021` address validation misses link-local/alternate forms | Table-driven SSRF corpus and mutation proof |
| `0022` unsafe Gmail review enters launch | Exclude branch/migration from launch unless a hard dependency and complete unreachable proof exist |
| `0027` defaults allow below middleware | Database/RPC/storage/worker default-deny mutation |
| Executor causes duplicate/false application | At-most-once controls, unknown outcome, provider pause, receipt proof |
| Provider terms or anti-abuse controls conflict | ADR-003; no bypass; manual handoff |
| Design missing for promised behavior | ADD register blocks visible packet |
| Existing PM/finance bias survives generic copy | Discovery golden corpus and diverse-user canary |
| Third-party people data is inaccurate/unlawful | Vendor/processor terms/privacy review, provenance, correction/removal, minimal retention |
| Account deletion appears to retract employer application | Explicit irreversibility before submit/deletion |

## 8. Owner inputs before invitation

- resolve ADR-001 through ADR-015;
- approve the SLO revision/digest;
- name primary/backup support operators and define out-of-hours S0 paging;
- approve design addenda;
- provide public product/operator/support/legal identities;
- sign the provider/processors/privacy register and accepted residual risks.
