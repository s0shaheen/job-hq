# Verification and traceability

## 1. Evidence principle

Every release claim MUST answer:

- What exact requirement was evaluated?
- Against which exact artifact and configuration?
- With which controlled identity, data, time, and dependency state?
- What was observed?
- What safe counterexample proves the check can fail?
- Who accepted the result?

Evidence is durable release data, not a chat transcript or an implementer’s memory.

## 2. Traceability graph

Every launch-critical requirement MUST have this complete path:

```text
Source or risk
  -> requirement ID
  -> acceptance example
  -> implementation boundary
  -> verification case
  -> evidence artifact
  -> release artifact/configuration
  -> owner acceptance
```

Missing any edge means the requirement is not verified.

## 3. Requirement record

Use a portable YAML, JSON, CSV, database, or requirements-management equivalent. The
atomic register MAY begin with ID, normative statement, and acceptance oracle. Before
any mutating implementation packet is dispatched, the packet/normalized records MUST
complete every field below for its referenced requirements. Before release, every
requirement MUST have one unambiguous value and link for every field:

```yaml
id: PILOT-AREA-###
title: Concise outcome
status: proposed
priority: P0
owner: accountable person
source:
  - owner decision or file/section
statement: >
  The system MUST ...
rationale: >
  User promise or risk controlled.
scope:
  actors: []
  data: []
  environments: []
preconditions: []
assumptions: []
constraints: []
acceptance:
  - id: AC-###
    given: []
    when: []
    then: []
negative_cases: []
implementation:
  components: []
  schema: []
  interfaces: []
verification:
  - case_id: VT-###
    level: unit
    oracle: ""
    counterexample: ""
    evidence: ""
exceptions: []
release:
  artifact: ""
  configuration: ""
  accepted_by: ""
  accepted_at: ""
```

Status flow:

```text
proposed -> accepted -> implemented -> verified -> released -> retired
```

`implemented` is not `verified`. `verified` against one commit is invalidated by a
material implementation, dependency, schema, design-source, or configuration change.

## 4. Work-unit specification

Every work package MUST ship a spec containing:

1. purpose and user outcome;
2. in scope / out of scope;
3. actors and permissions;
4. dependencies;
5. assumptions and owner decisions;
6. data classification and retention;
7. state machine;
8. database contract;
9. API/event/provider contracts;
10. normative requirements;
11. Given/When/Then acceptance;
12. test matrix;
13. observability and audit;
14. migration/backfill/reconciliation;
15. rollout flags and canary;
16. rollback/disablement;
17. risks and residual risks;
18. evidence and release acceptance.

This structure is required; the serialization format is not.

## 5. Verification matrix

Select the lowest authoritative layer and add higher layers only when they prove a
different risk.

| Layer | Proves | Does not prove alone |
|---|---|---|
| Static/schema | shape, types, forbidden constructs | runtime authorization or behavior |
| Pure/unit | deterministic rule and boundaries | integration/configuration |
| Property/model | invariants across large state spaces | production wiring |
| Database | constraints, RLS, transaction, concurrency | browser experience |
| Contract | producer/consumer payload agreement | provider correctness |
| Integration | components work together | complete user journey |
| Browser/user | rendered journey and interaction | hidden DB enforcement |
| Accessibility | perceivable/operable behavior | business correctness |
| Security | abuse boundaries and containment | product usefulness |
| Performance | latency/volume budgets | correctness |
| Resilience | failure/retry/recovery | normal UX quality |
| Restore | recoverability | prevention of corruption |
| Manual exploratory | unknown interactions and comprehension | repeatable regression unless codified |

## 6. Mandatory test classes

For each state-changing command:

- valid normal request;
- minimum and maximum valid values;
- missing required value;
- unknown field;
- malformed type/encoding/Unicode whitespace;
- unauthorized and wrong-owner;
- missing/disabled entitlement;
- duplicate idempotency key with same payload;
- reused key with different command/payload;
- stale version;
- two genuinely concurrent valid requests;
- timeout before commit;
- timeout after possible commit;
- dependency partial failure;
- retry and result lookup;
- audit success and absence on rejected transaction;
- fixture/live parity;
- sensitive-log redaction.

For each read:

- owner sees owned data;
- second user cannot see it;
- anonymous/pending/suspended behavior;
- zero, one, and many;
- missing optional fields;
- stable ordering/pagination;
- large volume;
- stale/degraded source;
- safe caching and invalidation;
- fixture/live parity.

For each scheduled lane:

- named valid user;
- missing/unknown user;
- two users in a reused process/container;
- duplicate invocation;
- partial batch;
- poison item;
- timeout/interruption;
- stale heartbeat;
- recovery and recovery alert;
- no user content in telemetry.

For each external integration:

- valid response;
- authentication failure/revocation;
- rate limit;
- timeout;
- malformed/changed schema;
- partial data;
- redirect and unsafe URL;
- duplicate/reordered event;
- provider accepts but delivery is unknown;
- kill switch;
- no content leakage beyond the approved fields.

## 7. Test-data standard

- Synthetic data is the default.
- Production data MUST NOT be copied into fixtures, screenshots, logs, recordings, or
  source control.
- Test identities MUST be clearly non-production and use distinct owners.
- Boundary strings include Unicode whitespace, combining marks, emoji in user data,
  bidirectional controls, extremely long tokens, quotes, delimiters, and spreadsheet
  formulas.
- Time is pinned and covers timezone/DST boundaries.
- Randomness is seeded and seed is recorded on failure.
- Provider fixtures include version and source, are scrubbed, and have size limits.
- High-volume fixtures represent realistic distributions, not repeated identical rows.
- Secrets are structurally impossible in fixtures, not merely redacted by convention.

## 8. Mutation and anti-vacuity proof

Every launch-critical guard MUST demonstrate at least one controlled failing variant.
Examples:

- remove `auth.uid()` ownership from a policy;
- change entitlement default from deny to allow;
- accept `169.254.169.254`;
- rotate idempotency keys on retry;
- accept a candidate outside the locked set;
- make an optimistic version token stop changing;
- count invocation as successful completion;
- make a fixture bypass a production transform;
- introduce a gradient or interpunct in a violation fixture;
- omit an imported row outcome;
- corrupt a backup or restore with wrong ownership.

The mutation may be a dedicated violation fixture, generated variant, or isolated
temporary code mutation. It MUST be safe, reproducible, and excluded from release. The
evidence records that the expected verification failed for the expected reason.

Code coverage MAY reveal unexercised code. Mutation/counterexample evidence proves that
a check protects the intended property.

## 9. Database qualification

Run against:

- an empty database;
- upgrade from the prior production schema;
- a production-like volume/data-shape database;
- two ordinary users;
- pending, suspended, removed, operator, service, and anonymous identities;
- real concurrent sessions.

Verify:

- migration ledger/checksum/advisory locking;
- tables, types, constraints, indexes, functions, triggers;
- grants and default privileges;
- RLS enabled/forced and behavioral matrix;
- security-definer `search_path` and execute permissions;
- direct DML denial;
- idempotency, conflicts, and audit atomicity;
- query plans/latency on critical reads;
- backup and restoration.

Text searching a migration for a clause is not evidence that the database enforces it.

## 10. API contract qualification

For every API/RPC/event:

- validate examples against the declared schema;
- validate implementation responses against the same schema;
- reject unknown mutation fields;
- test maximum body/field/list/depth sizes;
- test stable error type/code and safe detail;
- test auth/authz directly, not only through page navigation;
- test idempotency/concurrency semantics;
- verify backward compatibility with supported consumers;
- test response/content type and caching;
- test correlation and redaction.

A consumer fixture and production provider SHOULD share a conformance suite.

## 11. User-journey qualification

Each launch journey MUST run:

- in fixture mode;
- against production-equivalent live services;
- as at least two different users;
- with mouse and keyboard;
- at supported desktop and narrow widths;
- with large type and zoom;
- under one relevant dependency failure;
- with a session expiring;
- with a stale/concurrent update;
- through export/leave where relevant.

The journey result MUST be verified in durable state and audit history, not only by
visible toast text.

## 12. Exploratory charters

Deterministic cases are necessary but cannot predict every interaction. Before each
pilot wave, run time-boxed exploratory charters:

1. **Trust:** try to make the UI claim an action occurred when it did not.
2. **Isolation:** navigate, deep-link, import, export, retry, and manipulate identifiers
   across two users.
3. **Recovery:** interrupt every high-value journey at its least convenient moment.
4. **Comprehension:** ask a person unfamiliar with engine vocabulary to explain each
   state and next action.
5. **Data quality:** compare visible facts, export, audit, and source evidence.
6. **Layout:** long strings, missing values, large type, zoom, narrow widths, overlays.
7. **Provider drift:** unknown fields, stale tokens, rate limits, redirects, malformed
   responses.
8. **Exit:** disconnect, unsubscribe, export, delete, and verify no future processing.

Findings become requirements, defects, accepted risks, or explicitly rejected changes.
They MUST not remain only in notes.

## 13. Evidence bundle

Each release candidate MUST produce an immutable bundle or equivalent record containing:

- release commit and build digest;
- database migration versions and checksums;
- worker/container artifact digest;
- design-input digests;
- configuration/feature-flag manifest with secrets redacted;
- supported browser/device matrix;
- requirement traceability matrix;
- verification results by layer;
- mutation/counterexample results;
- accessibility results and manual checklist;
- design-parity manifests and approved exceptions;
- security scan/threat-model status;
- performance results and datasets;
- migration/restore/reconciliation results;
- open defects and owner exceptions;
- deployment, rollback, and canary plan;
- named approvers and timestamps.

## 14. Release-gate checklist

### Scope

- [ ] Pilot contract version approved
- [ ] In-scope and out-of-scope routes match the deployed navigation
- [ ] All assumptions have owner or expiry
- [ ] Pilot notice/support/retention decisions approved

### Repository and supply chain

- [ ] No live data, secrets, dumps, or sensitive artifacts in current source/history per
      approved incident remediation
- [ ] Dependency and secret scans accepted
- [ ] Build is reproducible enough to identify exact dependencies/artifacts
- [ ] Protected release workflow and least-privilege credentials

### Data and security

- [ ] Two-user isolation complete
- [ ] Default-deny entitlement/allowlist complete
- [ ] Direct table/RPC/storage negative tests complete
- [ ] Email-review race and status lock complete if enabled
- [ ] Threat model and high findings closed
- [ ] Export/deletion/revocation rehearsed

### Product

- [ ] J-01 through J-09 accepted for in-scope features
- [ ] No placeholder implies unavailable functionality
- [ ] Counts/actions/export scopes agree
- [ ] `Not listed` and source/confidence vocabulary correct
- [ ] Error, offline, conflict, and session-expiry paths complete

### Design and accessibility

- [ ] State manifests complete
- [ ] Structural/style/geometry/interaction/visual checks pass
- [ ] No anti-slop violation
- [ ] WCAG 2.2 AA evidence accepted
- [ ] Owner approves all visible routes and exceptions

### Reliability and operations

- [ ] Production-equivalent migration passed
- [ ] Encrypted backup and isolated restore passed
- [ ] One-time import reconciliation passed if ADR-004 chose import
- [ ] Zero-runtime-Sheet tripwire passed
- [ ] Alerts, recovery alerts, and kill switches rehearsed
- [ ] RPO/RTO accepted
- [ ] On-call/support coverage active

### Release

- [ ] Zero S0/S1 defects
- [ ] S2 exceptions signed
- [ ] Canary identity and rollback owner named
- [ ] Exact artifact/config deployed
- [ ] Post-deploy invariants pass
- [ ] Stop conditions monitored

## 15. Pilot-wave evidence

For owner soak, one-user canary, and each cohort wave, record:

```yaml
wave: canary-1
contract_version: full-product-pilot-v2
release_artifact: "<commit/build digest>"
configuration_manifest: "<artifact>"
cohort_count: 1
started_at: ""
ended_at: ""
critical_journeys:
  attempted: []
  passed: []
incidents: []
support_requests: []
reliability:
  command_success_rate: null
  stale_lanes: null
  duplicate_effects: null
  unexplained_divergence: null
product_signals: {}
privacy_or_security_findings: []
stop_condition_hit: false
decision: continue | hold | roll_back | stop
accepted_by: ""
```

## 16. Independent reader acceptance

Before the package or a release is accepted, a reviewer unfamiliar with the authoring
process MUST answer from the artifacts alone:

- What exactly can a pilot user do?
- What cannot they do?
- What blocks launch today?
- What is the next dependency-ordered action?
- What evidence would make each gate pass?
- How is a risky feature stopped?
- How does a user export and leave?
- Which owner decisions are unresolved?

Any wrong or ambiguous answer is a documentation defect.
