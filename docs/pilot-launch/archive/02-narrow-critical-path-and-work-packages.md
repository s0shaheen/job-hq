# Archived narrow-pilot critical path and work packages

> **Superseded execution notice (2026-07-28):** The priority model and conditional/
> post-pilot classifications below were written for a narrow product slice. They are not
> the current roadmap. Use [`13-full-product-roadmap.md`](13-full-product-roadmap.md) and
> [`packets/`](packets/) for execution. The containment and security findings below
> remain valid unless a newer packet explicitly replaces them.

## 1. How to use this plan

This is a dependency graph, not a feature wishlist. Work packages may run in parallel
only when they do not share a migration number, security boundary, design primitive, or
release artifact. A package exits only when its evidence is accepted.

Priority classes:

- **P0** — blocks any external pilot.
- **P1** — blocks a named pilot capability; may be removed from scope instead.
- **P2** — improves the pilot but does not block the recommended core promise.
- **Post-pilot** — intentionally deferred until pilot evidence changes the decision.

## 2. Critical path

```text
Owner decisions and incident containment
  ├─> private-data backup remediation
  ├─> release boundary and allowlist contract
  └─> pilot consent/support/retention contract
       |
       v
Serial migration integration (0021, 0022, 0023, 0024 if in scope, 0025, 0026, 0027)
       |
       +--> auth + owner isolation + default deny
       +--> email review + status-lock safety
       +--> per-user jobs/heartbeat/reconciliation
       |
       v
Core surface completion + strict design parity
       |
       v
Production configuration + migration + restore + alert + exit rehearsals
       |
       v
Owner soak --> one-user canary --> bounded cohort
```

## 3. Immediate containment

### WP-000 — Stop committing private database dumps

Priority: P0
Owner: product owner + repository administrator + operations
Dependencies: none
Blocks: all external access

Verified current condition:

- `.github/workflows/pgdump.yml` creates a full plain SQL dump of the `public` schema,
  compresses it, and commits it to Git.
- `snapshots/pg/hq.sql.gz` is tracked and has multiple commits.
- The dump includes `users`, `allowed_emails`, `profiles`, `applications`,
  `application_notes`, `connections`, `email_events`, `events`, `answers`,
  `capture_tokens`, imports, and other user-scoped data.

This is a potential data incident even if the repository is private. Git is not an
appropriate encrypted backup boundary, repository clones preserve history, and access
may be broader or longer-lived than database access.

Required actions:

1. Disable the workflow’s ability to create or push new dumps.
2. Revoke or restrict any repository automation credential that no longer needs write
   access.
3. Identify every remote, fork, cache, artifact, clone, and person or service that could
   access the commits.
4. Determine whether the dump contains real personal data or usable token material.
   Stored hashes are still sensitive metadata.
5. Decide whether this meets the applicable notification threshold. This is an owner /
   legal decision, not an engineering guess.
6. Replace it with encrypted, access-controlled, versioned backup storage using a
   separately managed key, retention policy, deletion policy, access logging, and
   restore testing.
7. Prepare and execute a coordinated history purge if approved. History rewriting MUST
   not happen casually: all collaborators, deployments, automations, and protected
   references must be coordinated.
8. Rotate exposed secrets or tokens when the incident review cannot prove they are
   non-usable.
9. Record the timeline, scope, decisions, corrective controls, and proof that a fresh
   clone does not contain the dump.

Acceptance:

- No current or scheduled workflow can write a database dump to Git.
- A repository-wide and history-aware scan finds no recoverable pilot dump in the
  approved canonical references after the remediation plan is executed.
- An encrypted backup can restore a production-like database into an isolated project.
- Backup access, restore access, and key access are separately reviewable.
- The owner signs the incident classification and any retention/notification decision.

### WP-001 — Freeze the pilot contract

Priority: P0
Owner: product owner
Dependencies: none

Resolve every decision marked launch-blocking or made applicable by the signed scope
matrix in `07-decisions-assumptions-risks.md`. Publish one scope label such as
`pilot-contract-v1`. Any later scope addition becomes a change request with its own
requirements and gates.

Acceptance:

- Cohort, duration, geography, supported devices, support hours, consent, retention,
  notifications, Gmail, Autopilot, and warm-introduction scope are explicit.
- Every pilot invitation uses the same promise.
- Out-of-scope routes are hidden or honest and inaccessible.

## 4. Integration spine

### WP-010 — Establish one release integration branch

Priority: P0
Owner: release integrator
Dependencies: WP-000 containment, WP-001

Required:

- Start from the current reviewed base.
- Inventory all active branches by base commit, migration number, schema changes, shared
  files, and test evidence.
- Rebase or replay one concern at a time. Do not merge migration branches in parallel.
- Resolve migration `0024` explicitly. If human-reviewed preparation is in scope,
  implement it. If it is excluded, the release integrator MUST either land an immutable
  documented no-op reservation as `0024` or renumber the still-unreleased `0025`–`0027`
  files once before any shared environment applies them. The final ledger is then
  immutable.
- Re-run evidence after integration; branch-local green results are not transferable.
- Generate one schema from empty and one upgrade from a recent production-like snapshot.
- Keep migrations append-only. A production rollback SHOULD disable features and deploy
  a compatible prior application before attempting destructive schema reversal.

Recommended order:

1. Display dictionary and anti-slop enforcement.
2. Company domains/logos (`0021`).
3. Ambiguous email review (`0022`) after the security correction in WP-012.
4. Bot/activity events (`0023`).
5. Application staging (`0024`) only if included.
6. Display preference consolidation (`0025`).
7. Resume productization (`0026`) only if included.
8. Entitlements (`0027`) if used for allowlisting/feature access; otherwise implement a
   smaller, independently proven default-deny pilot gate.
9. Jobs and shared-shell redesign, resolving shared component and warm-indicator
   conflicts against the integrated schema.

Acceptance:

- Migration identifiers are contiguous and unique.
- An empty database and an upgraded database produce the same expected schema.
- All new tables/functions have explicit ownership, privileges, RLS, and comments.
- No browser write bypasses approved RPCs.
- All fixture interfaces match the production data-source interface.
- `git diff --check`, all repository gates, migration verification, and traceability are
  green on the exact integration commit.

### WP-011 — Company domains and logo fallback

Priority: P1 for strict Jobs parity
Dependencies: WP-010 sequencing

Requirements:

- Company domains MUST be canonicalized and validated server-side.
- SSRF and private-address rejection MUST cover IPv4, IPv6, DNS rebinding, link-local,
  loopback, reserved, multicast, and alternate numeric encodings.
- `169.254.169.254` and IPv4-mapped IPv6 MUST be negative cases.
- No-domain MUST be a normal state.
- Logo resolution order MUST be logo.dev(domain), Google favicon, deterministic monogram.
- Image failures MUST never reveal a broken-image icon or block the company name.
- Third-party image requests MUST disclose the hostname to that provider and follow the
  approved privacy decision.

Evidence:

- Table-driven address corpus with a mutant that would accept link-local metadata
  addresses and is proven to fail.
- Two different company names with the same initials produce deterministic, documented
  monograms.
- Browser tests run with both image providers unavailable.

### WP-012 — Secure ambiguous email review

Priority: P0 if email auto-status is enabled; otherwise feature MUST be disabled
Dependencies: `0022` integration

Known defect:

- A user-supplied candidate identifier currently crosses the status-lock boundary. A
  plausible test can pass while still allowing a candidate outside the server-derived
  set.

Required:

- The server MUST derive eligible candidates after authenticating the user and locking
  the event.
- The selected candidate MUST be a member of that locked, owner-scoped set.
- Resolution MUST use compare-and-swap semantics so two tabs cannot resolve one event
  differently.
- The status human-wins lock MUST be enforced by the database write path.
- Evidence MUST remain linked after resolution; undo/reopen semantics MUST be explicit.
- A client-supplied `user_id`, application owner, status actor, or candidate list MUST
  be ignored or rejected.

Acceptance:

```gherkin
Scenario: A valid-looking application outside the candidate set is rejected
  Given the user owns applications A and B
  And the locked event has only A in its server-derived candidate set
  When the client submits B as the resolution
  Then no application changes
  And the event remains unresolved
  And the attempt is auditable without exposing email content
```

### WP-013 — Per-user activity and stale-lane health

Priority: P0
Dependencies: `0023`, production scheduling model

Requirements:

- Every scheduled or externally triggered lane MUST include an unambiguous user owner.
- Heartbeats MUST represent successful completion, not invocation.
- Shared success MUST NOT mask one user’s failure.
- The product MUST distinguish never run, running, succeeded, partially failed, failed,
  and stale.
- Error details exposed to users MUST be safe and actionable; operator detail stays in
  restricted logs.
- Freshness thresholds MUST be tied to the lane cadence plus documented grace.
- The owner MUST receive an alert for global failures and per-user critical staleness.

Evidence:

- A fixture where one of two users is stale and shared infrastructure is healthy.
- A schedule invocation with missing/unknown user fails before reads or writes.
- An alert injection and recovery notification rehearsal.

### WP-014 — Durable preparation review queue

Priority: P1 only if preparation is in scope; otherwise post-pilot
Dependencies: reserved migration `0024`, existing `0014`/`0017`

Required persistence:

- An owner-scoped preparation record containing the application reference, ATS/form
  identity, schema hash, prepared snapshot, parsed snapshot, readiness/gap counts,
  state, and timestamps.
- At most one active stage per user/application or another explicitly defined invariant.
- Approved snapshots are immutable.
- RLS permits owner reads and revokes direct browser DML.

Required commands:

- stage, review/approve, and discard;
- idempotency key on every command;
- compare-and-swap version;
- authenticated ownership derived inside the lock;
- limits for JSON size, fields, strings, and unknown provider shapes;
- audit event on every transition.

Explicitly absent:

- submission;
- external receipt;
- inferred human approval;
- resume attachment unless `0026` is integrated and separately accepted.

### WP-015 — Consolidate display preferences

Priority: P1 for coherent redesigned surfaces
Dependencies: `0025`

Requirements:

- Each preference has one scope: user, device, or saved view.
- Precedence is explicit and deterministic.
- Legacy cookie/view mechanisms are migrated or retired without compounding scale or
  density.
- Large text does not clip, overlap, or horizontally hide primary actions.
- Fixture and production implementations return identical defaults.

### WP-016 — Default-deny access control

Priority: P0
Dependencies: allowlist/entitlement decision; `0027` if selected

Known defect:

- Route and corpus checks do not substitute for database/RPC default deny.

Requirements:

- Unknown, uninvited, disabled, or removed identities MUST have no access to
  user-scoped reads or commands, even when calling database interfaces directly.
- The database MUST derive the user from authentication, never a client-selected owner.
- Provisioning, suspension, revocation, and re-invitation MUST be idempotent and audited.
- Entitlement caching MUST have a bounded lifetime and an immediate revocation path.
- Service-role paths MUST be narrowly contained, named, monitored, and unavailable to
  browser bundles.
- Removing a pilot user MUST stop scheduled lanes, notifications, captures, and active
  sessions.

Evidence:

- An authorization matrix over anonymous, invited-unprovisioned, active, suspended,
  removed, operator, and service identities.
- Direct table read/write and RPC negative tests.
- Two-user horizontal and one-user privilege-escalation tests.
- A mutant that changes the default from deny to allow and is proven to fail.

## 5. Core product surfaces

### WP-020 — Shared application shell and system states

Priority: P0
Dependencies: dictionary, preference, and Jobs integration decisions

Deliver:

- Five primary rail destinations: Today, Jobs, Applications, Autopilot, Coverage, plus
  a separate Settings destination.
- Today badge only.
- Honest placeholders for excluded destinations.
- Global session-expired, offline, conflict, error, not-found, and permission states.
- Consistent toasts, undo, dialogs, focus restoration, and keyboard behavior.
- Route aliases or redirects for retired internal route names.
- No route exposes old engine vocabulary.

### WP-021 — Today

Priority: P0
Dependencies: WP-020, owner-scoped data/health

Deliver the design-system Today surface and all state variants. Correct the known
binding-constraint logic: guidance MUST be based on deterministic relaxation, not a
short-circuit reason histogram. Counts, queue membership, badge, and deep links MUST
share one query contract.

### WP-022 — Jobs

Priority: P0
Dependencies: WP-011, WP-015, WP-020

Integrate the completed redesign rather than re-inventing it. Preserve the RPC write
contract, fixture mode, warm indicator, six-column budget, toolbar-control budget,
detail-pane URL state, export scope, and exact copy. Re-run every gate on the integrated
branch and production-like data volume.

### WP-023 — Applications

Priority: P0
Dependencies: WP-012 when email is enabled, WP-020

Deliver the design-system Applications surface with:

- grouped and ungrouped states required by the design;
- manual status editing;
- evidence and activity;
- Needs review;
- add/import/export;
- optimistic/conflict/undo behavior;
- `Not listed` for absent facts;
- human-wins enforcement;
- truthful Prepare link only when that capability is enabled.

### WP-024 — Coverage

Priority: P0
Dependencies: WP-011, WP-013, authoritative-store decision

Resolve the store fork before copy claims that approving a company changes discovery.
Coverage MUST show per-user source support, resolution status, monitoring decision,
last successful check, failures, and next action. The Python discovery lane MUST consume
the same approved state the UI changes, or the control must say it is preparatory only.

### WP-025 — Settings, connected accounts, and account exit

Priority: P0
Dependencies: WP-015, WP-016, retention decision

Deliver:

- profile;
- display;
- notifications and unsubscribe;
- connected accounts with consent, scopes, freshness, revocation, and errors;
- data export;
- account closure;
- support and product information.

No save control may be decorative. Destructive operations require recent
authentication, exact scope, confirmation, and completion evidence.

### WP-026 — Import/export hardening

Priority: P0
Dependencies: account ownership and retention model

Required:

- Exact supported formats, encodings, limits, formulas, dates, and duplicate rules.
- Import preview with row-level outcomes and recovery.
- Formula-injection protection for exported spreadsheet-compatible files.
- Export scope equality between visible count, server selection, and file.
- A complete account archive, not only a visible-table export.
- Archive schema version and readable manifest.
- Cross-user absence and deletion-after-export tests.

## 6. Email and notifications

### WP-030 — Per-user Gmail setup and revocation

Priority: P0 only if email tracking is in the core promise
Dependencies: owner decision, WP-016

Choose and document one pilot setup:

- manual per-user Apps Script with a supported setup/revoke runbook; or
- product-managed OAuth with verified app/scopes/token lifecycle.

Either path MUST:

- use least privilege;
- bind events to one user;
- disclose captured fields;
- surface the last successful capture;
- tolerate duplicates;
- reconcile capture vs processing;
- stop after revocation;
- delete or retain tokens according to policy;
- have a complete manual tracking fallback.

### WP-031 — Notification consent and deliverability

Priority: P0 if any pilot email is sent
Dependencies: Settings, sender identity

Required:

- explicit opt-in;
- verified sender/domain and reply path;
- per-user quiet hours/timezone;
- unsubscribe/preferences link;
- suppression and bounce handling;
- rate and duplicate protection;
- signed, expiring, replay-safe action links;
- safe previews and no secret data in URLs;
- content generated from the same versioned state used by actions.

Operational alerts MUST use a separate channel and MUST NOT be disabled by a user’s
product-email preference.

## 7. Production readiness

### WP-040 — Environment and configuration control

Priority: P0

Required:

- Separate local/test, staging, and production projects or equivalent isolation.
- Configuration inventory with owner, sensitivity, default, allowed values, and
  rotation procedure.
- Secrets only in approved secret stores; no secrets in code, logs, URLs, fixtures, or
  client bundles.
- Production feature allowlist; risky capabilities default off.
- Immutable build identification exposed to operations.
- Environment drift report before release.
- Seed/fixture data clearly separated from real user data.

### WP-041 — Data migration, reconciliation, backup, and restore

Priority: P0
Dependencies: WP-000, migration integration

Required rehearsals:

1. create from empty;
2. upgrade from current production-like schema;
3. upgrade with maximum/edge-case data;
4. interrupted migration;
5. application version skew during deployment;
6. backup creation and integrity verification;
7. isolated restore;
8. point-in-time or version restore, if promised;
9. Sheet/Postgres reconciliation while dual-write exists;
10. user export and deletion across live, mirror, and backup retention.

Recommended pilot objectives:

- recovery point objective: no more than 24 hours;
- recovery time objective: no more than 4 hours during declared support coverage.

The owner MUST approve these numbers or replace them.

### WP-042 — Observability and incident readiness

Priority: P0

Required:

- request, command, scheduled-run, provider-call, and notification correlation;
- pseudonymous user/lane identifiers;
- structured error classes;
- success, latency, retry, conflict, duplicate, stale, and rejection metrics;
- audit trail for security- and status-sensitive changes;
- alerts with owner, threshold, runbook, and tested recovery;
- redaction tests for email bodies, snippets, application notes, answers, tokens, URLs
  with secrets, and provider payloads;
- kill switches for writes, email capture processing, digests, discovery, and any
  conditional automation.

### WP-043 — Support, privacy, and legal minimum

Priority: P0

Required:

- pilot notice explaining experimental status, data categories, processors, limitations,
  contact, retention, export, deletion, and incident contact;
- explicit Gmail and notification consent where applicable;
- support channel and sustainable coverage hours;
- data access and deletion runbook;
- incident communication templates;
- provider/subprocessor inventory;
- user-facing limitations: discovery is not exhaustive; tracking depends on evidence;
  no application is submitted unless a future explicit capability says so.

This package is not legal advice. The owner MUST obtain appropriate review for the
jurisdictions and data involved.

## 8. Verification and rollout

### WP-050 — Release-candidate verification

Priority: P0
Dependencies: all in-scope P0/P1 packages

Run the verification standard in `05-verification-and-traceability.md` against:

- the exact commit;
- production-equivalent schema and configuration;
- two real distinct test identities;
- fixture and live data modes;
- supported browsers/viewports;
- empty, realistic, and high-volume datasets;
- dependency failure injection;
- offline/retry/concurrency scenarios.

### WP-051 — Owner soak

Priority: P0

Recommended seven days after the P0 backup incident is contained and the release
candidate is stable. The owner MUST use only the pilot UI for pilot journeys. Operator
fallback is allowed for recovery but every fallback is recorded as a product gap.

### WP-052 — One-user canary

Priority: P0

Invite one external user. Rehearse onboarding, support, one failure, export, notification
control, and exit. Observe for at least 48 hours and one complete scheduled-run cycle.

### WP-053 — Bounded cohort

Priority: P0

Invite remaining users in waves. Evaluate stop conditions daily. Do not expand beyond
the approved hard cap without a new decision record and a scaling review.

## 9. Work that is not on the core-pilot critical path

These remain legitimate roadmap items but SHOULD NOT delay the recommended narrow
pilot:

- automated application submission and receipts;
- resume artifact productization if preparation is excluded;
- billing, trials, quotas, and public plan surfaces;
- public landing and open signup;
- referral outreach tracking;
- Sheet sunset;
- model-generated application answers;
- Tier-C ATS automation;
- generalized multi-tenant scheduling beyond the capped pilot;
- command palette and broad “add anything” system features;
- large-scale shared fetch and caching optimization.

They move onto the critical path only through an explicit pilot-scope change.

## 10. Parallel execution lanes

After WP-000 and WP-001, use these lanes:

| Lane | Work | Shared-boundary rule |
|---|---|---|
| Security/data | WP-010–016, WP-041 | One migration integrator; security review independent of implementer |
| Product surfaces | WP-020–026 | Shared shell/design components land before surface branches rebase |
| Email/operations | WP-030–043 | No production sends until consent and kill switch are accepted |
| Verification | WP-050 + traceability | Independent reader/tester consumes artifacts, not implementation narrative |

Parallel lanes MUST synchronize on the release contract, schema version, data-source
interface, design manifest, and error taxonomy. They MUST NOT edit the same migration or
silently duplicate an interface.
