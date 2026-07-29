# Pilot launch control

Status: proposed launch standard
Audience: product owner, engineering, design, operations, and any implementation agent
Normative vocabulary: RFC 2119 and RFC 8174 (`MUST`, `MUST NOT`, `SHOULD`, `MAY`)

This directory is the control plane for moving Job Search HQ from an owner-operated
system to an invite-only pilot. It distinguishes work that blocks a responsible pilot
from work that belongs to the broader product roadmap.

The documents are deliberately model- and harness-agnostic. They specify observable
outcomes, evidence, and release decisions. An implementation can use any language,
test runner, CI provider, hosting platform, or agent as long as it produces the required
evidence.

## Recommended pilot promise

Launch a closed pilot to 3–5 known users, with a hard cap of 10, around three complete
verbs:

1. **Decide** — discover and review relevant roles in Today and Jobs.
2. **Track** — manage Applications and understand Coverage.
3. **Leave** — export data, stop notifications, and request account deletion without
   losing control of personal information.

The core pilot SHOULD include Profile and Settings because those surfaces make the
other three verbs truthful. It SHOULD include human-reviewed application preparation
only if the stage/review persistence gap is closed. It MUST NOT imply that the product
submits applications automatically when it does not.

The initial pilot SHOULD NOT include open signup, billing, automated application
submission, unsupported ATS automation, or referral outreach automation. Gmail
auto-status MAY be included only after the per-user OAuth, revocation, freshness, and
reconciliation gates in this package pass.

## What is already real

The following foundations exist on `main` or on active feature branches. Their
existence is not the same as release acceptance.

- Durable sheet operations, AWS-scheduled discovery and tracker jobs, alerting, and
  nightly backups exist.
- The web app has an injectable data layer, fixture mode, authenticated server reads,
  RPC-only writes, idempotency keys, optimistic updates, undo, offline handling, and
  broad automated coverage.
- The database has user-scoped jobs, applications, profiles, saved views, answers,
  company review, warm-introduction data, email capture foundations, and append-only
  events through migrations `0001`–`0020` on `main`.
- Jobs redesign and the display dictionary / anti-slop checks have been implemented on
  separate pushed branches.
- Active branches cover company domains (`0021`), email review (`0022`), bot activity
  (`0023`), display preferences (`0025`), resume productization (`0026`), and
  entitlements (`0027`).
- Application preparation and review logic exists, but its durable stage/review queue
  and migration `0024` do not.

## What blocks the pilot

These are launch blockers, not optional polish:

1. **Freeze the pilot contract.** Decide who is invited, which promises are in scope,
   whether Gmail auto-status is included, what support is offered, and what happens to
   pilot data at exit.
2. **Integrate the migration spine.** Rebase and land `0021`–`0027` in one serial,
   conflict-free order; resolve `0024` by implementation, an immutable no-op
   reservation, or one-time renumbering of still-unreleased migrations; run forward
   migration and restoration rehearsals against production-like data.
3. **Fix security boundaries.** The email-review status lock MUST NOT accept a
   user-supplied identifier across the lock boundary. Entitlements MUST default-deny in
   the database and RPC layer, not only in routes.
4. **Complete multi-user isolation.** Every read, write, job, export, email event,
   notification, and support tool MUST be proven owner-scoped with a two-user negative
   test.
5. **Make the core journeys complete.** Today, Jobs, Applications, Coverage, Profile,
   Settings, import, export, notification controls, and account exit MUST have honest
   loading, empty, error, degraded, and permission states.
6. **Prove design parity.** All visible pilot routes MUST match the supplied design
   system and copy dictionary under the deterministic parity standard in
   `04-design-parity-standard.md`.
7. **Prove operations.** Production deployment, configuration, backups, restore,
   alerting, auditability, rollback / feature disablement, pilot provisioning, support,
   and incident response MUST be rehearsed.
8. **Run a staged release.** Owner dogfood, one external pilot user, then 3–5 users.
   Expansion MUST stop automatically when a stop condition is met.

## Launch gates at a glance

| Gate | Exit evidence | Owner sign-off |
|---|---|---|
| G0 Pilot contract | Approved scope, cohort, consent, support, data-exit decisions | Required |
| G1 Integrated build | One release candidate, contiguous migrations, no critical branch drift | Engineering |
| G2 Security and privacy | Threat model, tenant-isolation proof, auth/entitlement matrix, deletion/export drill | Owner + engineering |
| G3 Product completeness | Every launch-critical journey passes acceptance and degraded-state tests | Product + engineering |
| G4 Design and accessibility | Strict parity manifest, state matrix, keyboard/manual accessibility evidence | Design owner |
| G5 Data and operations | Migration, backup/restore, alert, kill-switch, and reconciliation rehearsals | Operations |
| G6 Release candidate | Full traceability matrix; zero unresolved launch blockers | Cross-functional |
| G7 Staged pilot | Owner soak, one-user canary, then cohort; metrics and support running | Owner |

## Release rule

A pilot release is allowed only when all of the following are true:

- 100% of launch-critical requirements have passing evidence.
- There are zero open severity 0 or severity 1 defects.
- Any accepted severity 2 defect has an owner, a user-visible workaround, a bounded
  blast radius, and written owner acceptance.
- Every state-changing operation is retry-safe, owner-scoped, auditable, and recoverable
  or explicitly irreversible with confirmation.
- Backup restoration and account export/deletion have been exercised, not merely
  documented.
- The exact release artifact and configuration tested are the ones deployed.
- The owner has approved the remaining assumptions and accepted risks in
  `07-decisions-assumptions-risks.md`.

## Document map

1. [`01-pilot-scope-and-journeys.md`](01-pilot-scope-and-journeys.md) — pilot promise,
   actors, journeys, scope, and product acceptance.
2. [`02-critical-path-and-work-packages.md`](02-critical-path-and-work-packages.md) —
   dependency-ordered work packages and the broader roadmap.
3. [`03-engineering-quality-standard.md`](03-engineering-quality-standard.md) —
   deterministic standards across frontend, backend, database, API, security,
   reliability, accessibility, performance, and operations.
4. [`04-design-parity-standard.md`](04-design-parity-standard.md) — authoritative design
   inputs, exact parity protocol, and state inventory.
5. [`05-verification-and-traceability.md`](05-verification-and-traceability.md) —
   evidence model, acceptance templates, release checklist, and traceability rules.
6. [`06-release-operations-and-pilot-support.md`](06-release-operations-and-pilot-support.md)
   — environment promotion, rollout, rollback, incidents, support, feedback, and pilot
   measurement.
7. [`07-decisions-assumptions-risks.md`](07-decisions-assumptions-risks.md) — owner
   decisions, recommended defaults, assumptions, risk register, and open questions.
8. [`08-roadmap-ledger.md`](08-roadmap-ledger.md) — reconciled current status, pilot
   critical path, and the full outlined roadmap beyond the pilot.
9. [`09-pilot-contract-v1.md`](09-pilot-contract-v1.md) — single proposed first-wave
   scope matrix and sign-off artifact.
10. [`10-data-authority-and-transition.md`](10-data-authority-and-transition.md) —
    per-data-class authority, reconciliation, rollback, deletion, and sunset contract.
11. [`11-metric-dictionary-and-slos.md`](11-metric-dictionary-and-slos.md) — measurable
    reliability, safety, email, performance, product, alert, and stop definitions.
12. [`12-requirements-register.md`](12-requirements-register.md) — atomic pilot
    requirements, acceptance oracles, owners, status, and evidence placeholders.

## Source precedence

Where sources disagree, use this order:

1. Security, privacy, data-integrity, and repository durability invariants.
2. Owner decisions recorded in this package.
3. The current implementation and migrations.
4. The downloaded design system and design mirror for visible behavior and copy.
5. Current build plans and handoffs.
6. Older roadmap prose.

No document may declare a feature built merely because an older plan predicted it.
Release evidence MUST identify the commit and deployed configuration actually verified.

## External standards

This package adapts established, implementation-neutral standards:

- RFC 2119 and RFC 8174 for normative requirements.
- Given/When/Then examples for observable acceptance behavior.
- OpenAPI and JSON Schema for interface and payload contracts.
- RFC 9457 for machine-readable API errors.
- WCAG 2.2 Level AA for accessibility.
- OWASP ASVS 5.0 for application security verification.
- NIST Secure Software Development Framework for release-process controls.
- OpenTelemetry semantic conventions for portable telemetry meaning.

The exact standard references and required application are defined in
`03-engineering-quality-standard.md`.
