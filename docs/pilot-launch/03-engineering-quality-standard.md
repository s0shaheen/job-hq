# Engineering quality standard

## 1. Purpose and conformance

This standard defines what “correct,” “stable,” “comprehensive,” and “valid” mean for
pilot work. It is independent of implementation language and test harness.

A change conforms only when:

1. its requirements are uniquely identified;
2. its contracts and invariants are explicit;
3. positive, negative, boundary, concurrency, and recovery behavior are verified;
4. the implementation is observed at the narrowest authoritative boundary;
5. evidence is linked to the exact release artifact;
6. the production configuration preserves the verified behavior.

Test count, code coverage, reviewer confidence, and a green UI walkthrough are useful
signals. None is sufficient alone.

## 2. Standards baseline

Use the following authoritative references:

- Normative requirements: [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
  [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).
- HTTP API descriptions:
  [OpenAPI Specification](https://spec.openapis.org/oas/latest.html).
- Data schemas:
  [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12).
- HTTP error payloads:
  [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html).
- Accessibility:
  [WCAG 2.2](https://www.w3.org/TR/WCAG22/), target Level AA.
- Application security:
  [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/).
- Secure delivery:
  [NIST SP 800-218 Secure Software Development Framework](https://csrc.nist.gov/pubs/sp/800/218/final).
- Portable telemetry meaning:
  [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/concepts/semantic-conventions/).

Use the current supported revision at implementation time, record the revision in
release evidence, and assess compatibility before changing revisions. A standards
upgrade MUST NOT silently change public behavior.

## 3. Requirement quality

Every normative requirement MUST be:

- **Atomic:** one obligation, not several joined by vague conjunction.
- **Observable:** a verifier can distinguish pass from fail.
- **Bounded:** actor, scope, precondition, and exception are named.
- **Consistent:** no contradiction with a higher-precedence invariant.
- **Traceable:** linked to source, implementation, verification, and release.
- **Necessary:** tied to a user promise, risk, legal obligation, or operating need.
- **Unambiguous:** avoids “fast,” “secure,” “reasonable,” “seamless,” and “should work”
  without a measurable definition.

Each requirement record MUST contain:

| Field | Meaning |
|---|---|
| ID | Stable identifier, never reused |
| Statement | One RFC-style normative sentence |
| Rationale | User promise or risk controlled |
| Source | Owner decision, design contract, invariant, or standard |
| Preconditions | Required state |
| Acceptance | Observable Given/When/Then examples |
| Negative cases | What MUST not happen |
| Evidence | Artifact or result that proves it |
| Owner | Person accountable for acceptance |
| Status | Proposed, accepted, implemented, verified, released, retired |

## 4. Deterministic verification pattern

For each behavior, apply this sequence:

1. **Define the oracle.** Specify the exact expected state or relation.
2. **Choose the authoritative boundary.** Verify an RLS rule in the database, a copy rule
   in rendered UI, a retry property at the command boundary, and a restoration claim by
   performing a restore.
3. **Control inputs.** Pin time, randomness, locale, timezone, feature flags, identity,
   provider response, dataset, viewport, and network condition where relevant.
4. **Exercise equivalence classes.** Normal, empty, null, boundary, maximum, malformed,
   unauthorized, stale, duplicate, and concurrent.
5. **Prove the test can fail.** Introduce a safe fixture violation or mutation that
   breaks the controlled property and confirm the check rejects it.
6. **Verify side effects.** Read back durable state, audit state, emitted work, and
   absence of forbidden effects.
7. **Repeat at integration.** Re-run after branch integration and against a
   production-equivalent environment.
8. **Attach evidence.** Record artifact digest/commit, environment, configuration,
   dataset, timestamps, result, and exceptions.

Retries are allowed for an explicitly classified transient environment fault. A product
assertion MUST NOT be made green by retrying until it passes.

## 5. Cross-cutting invariants

The following are release invariants:

### Identity and ownership

- Every user-scoped record MUST have one authoritative owner.
- Ownership MUST be derived from authenticated server context.
- Anonymous and unknown identities MUST default to no access.
- Two-user negative tests MUST cover every read and command.
- Scheduled work MUST resolve a user before accessing user data.

### Writes

- Browser writes MUST use approved RPC/command boundaries.
- Every command MUST accept an idempotency key.
- Updates to mutable state MUST carry an expected version or equivalent compare-and-swap
  guard.
- UI MAY be optimistic only when it can reconcile, roll back, and explain failure.
- Human decisions MUST win over automation where the domain contract says so.
- Every high-value state change MUST produce an audit event.

### Missing and uncertain data

- Missing values display `Not listed`.
- `null`, unknown, not applicable, zero, and empty collection MUST remain distinct.
- The system MUST NOT invent a midpoint, source, confidence, status, or timestamp.
- Uncertain automation routes to review or fails closed.

### Fixture parity

- Every production data-source capability MUST have a deterministic fixture
  implementation.
- Fixture defaults, error classes, authorization, transformations, counts, and state
  transitions MUST match production behavior.
- Contract suites MUST run unchanged against both implementations where possible.
- A fixture MUST include failure and conflict modes; it is not only sample data.

### Client persistence and offline commands

- Every locally persisted draft, cache entry, and queued command MUST be bound to one
  authenticated owner identity and environment.
- Sign-out, account removal, or identity change on the same device MUST prevent the
  prior owner's payload from being read or dispatched by the next identity.
- Dispatch MUST re-check authentication, ownership, current entitlement, command expiry,
  and resource version.
- Sensitive drafts and cached content MUST have an explicit storage location, expiry,
  encryption/platform-protection assumption, and purge event.
- The user MUST be able to see and cancel a queued command before dispatch where the
  command remains reversible.
- A queued command whose authorization, owner, resource, or precondition changed MUST
  fail closed and retain a safe explanation; it MUST NOT be rewritten for the new state.
- Two-user, one-device-profile tests MUST cover sign-out, session expiry, suspension,
  reconnect, and replay.

## 6. Frontend standard

### 6.1 Functional behavior

- Rendered behavior MUST be derived from typed view models, not raw engine vocabulary.
- URL-addressable state MUST round-trip through parse → serialize → parse.
- Back, forward, reload, deep link, and duplicate-tab behavior MUST be defined.
- A control MUST have one complete outcome or be absent/honestly unavailable.
- Optimistic UI MUST distinguish pending, queued offline, accepted, conflicted, rejected,
  undone, and superseded.
- A component MUST not infer permission from visibility.
- Lists and tables MUST use stable semantic identifiers, not array position.

### 6.2 State coverage

Every surface MUST cover the experience-state contract in
`01-pilot-scope-and-journeys.md`. Add:

- long company/role/user strings;
- Unicode and bidirectional text safety;
- duplicate names;
- 0, 1, and many items;
- maximum supported data volume;
- slow response;
- partial provider response;
- stale cached response;
- component exception containment.

### 6.3 Accessibility

Target WCAG 2.2 AA and verify with both automation and manual checks:

- semantic landmarks and headings;
- programmatic name, role, value, description, and error association;
- full keyboard operation without traps;
- visible focus and deterministic focus movement;
- modal/pane focus containment and restoration;
- Escape behavior where the design specifies dismissal;
- logical reading and tab order;
- 200% text zoom and 400% browser zoom/reflow where applicable;
- target size, contrast, non-color cues, reduced motion, forced colors;
- live announcements for async result, error, and undo;
- table header relationships and sortable-state announcement;
- screen-reader review of one complete critical journey.

Automated accessibility checks MUST be zero critical and serious violations. Manual
critical-journey checks MUST also pass; automation does not cover usability.

### 6.4 Browser and device policy

Before launch, publish a support matrix. Recommended pilot baseline:

- current and previous major Chrome;
- current Safari on macOS and iOS;
- current Firefox for standards regression;
- widths 320, 375, 768, 1024, and 1440 CSS pixels;
- mouse, touch, and keyboard;
- standard and large text.

Unsupported combinations MUST fail gracefully and MUST NOT corrupt state.

### 6.5 Performance

Measure with representative data, production builds, cold and warm navigation, and
recorded device/network profiles.

Recommended pilot budgets:

- primary content visible within 2.5 seconds at p75 on the agreed baseline profile;
- interaction response within 200 ms at p95, excluding acknowledged network completion;
- accepted command result within 2 seconds at p95 when dependencies are healthy;
- no unbounded client fetch or render proportional to the entire user corpus;
- table scroll does not create sustained main-thread blocking or horizontal hiding;
- route JavaScript and data payload budgets are declared and regression-limited;
- images specify dimensions and failure fallback;
- no background polling faster than the freshness need.

A budget exception requires a measured cause, affected journey, user impact, owner, and
expiry.

## 7. Backend and command standard

### 7.1 Service boundaries

- A service boundary MUST have an explicit input/output contract and failure taxonomy.
- Business rules MUST be enforced server-side at the authoritative write boundary.
- Server operations MUST not trust client-supplied ownership, role, actor, status,
  candidate set, price/entitlement, or audit fields.
- External calls MUST use bounded timeouts, bounded retries with jitter where safe, and a
  circuit or disable path.
- A retry MUST be safe or explicitly prohibited before any side effect is accepted.
- Work queues MUST define uniqueness, ordering, retry, poison-item, expiry, and
  reconciliation behavior.

### 7.2 Commands

Each command contract MUST define:

- authenticated actor;
- resource owner;
- preconditions;
- idempotency scope and lifetime;
- version/conflict token;
- atomic transaction boundary;
- validation limits;
- success result;
- stable error classes;
- durable and external side effects;
- audit event;
- compensating action or irreversibility;
- behavior on timeout after the server may have committed.

The client MUST be able to query the result of an ambiguous timeout using the command or
idempotency identifier.

### 7.3 Scheduled work

- Jobs MUST be named and attributable to a user lane.
- Scheduling, invocation, successful completion, and useful output are distinct events.
- One user’s success MUST not mask another user’s stale lane.
- A run MUST be repeatable without duplicate logical effects.
- Partial batches MUST record row/item outcomes.
- Poison items MUST not block unrelated items indefinitely.
- Run duration, input count, output count, skip count, duplicate count, error count, and
  freshness MUST be observable.

## 8. Database standard

### 8.1 Schema

- Tables and columns MUST express one canonical meaning and unit.
- IDs, timezones, timestamps, optionality, defaults, and deletion behavior MUST be
  explicit.
- Constraints MUST enforce invariants that cannot safely depend on application code.
- Unicode-whitespace emptiness MUST be handled intentionally.
- Unique constraints MUST collide for the real duplicate shape they claim to prevent.
- Foreign keys MUST define update/delete action.
- JSON fields MUST have a versioned schema, size limit, and validation boundary.
- Sensitive values MUST be classified; secrets SHOULD be stored using a purpose-built
  secret mechanism, never reversible plaintext without need.

### 8.2 Row-level security and privileges

- RLS MUST be enabled and forced as appropriate on user-scoped tables.
- Policy predicates MUST be verified behaviorally, not by text search.
- Direct browser DML MUST be revoked when RPCs own writes.
- Function execution privileges and `search_path` MUST be explicit.
- Service-role exceptions MUST be isolated and tested for containment.
- Cross-tenant tests MUST use real distinct authenticated identities.

### 8.3 Transactions and concurrency

For each write, document:

- rows locked and lock order;
- isolation assumption;
- uniqueness/concurrency invariant;
- retry behavior on serialization/deadlock;
- compare-and-swap token;
- external side-effect ordering;
- audit-event atomicity.

Race tests MUST use actual concurrent transactions. Sequential calls described as
“concurrent” are insufficient.

### 8.4 Migrations

- Migration identifiers are unique, ordered, immutable after release, and checksummed.
- An empty build and an upgrade build MUST converge.
- Migrations MUST be safe under the expected data volume and lock budget.
- Destructive changes require expand → migrate → contract phases.
- A migration MUST define version-skew compatibility with old/new application code.
- Preflight checks and post-migration invariants MUST fail loud.
- Production data MUST be backed up and the restoration path proven before irreversible
  change.
- Rollback normally means application rollback plus forward schema repair; destructive
  down migrations are not presumed safe.

## 9. API and data-contract standard

Even when an interface is internal, contract it as if another implementation must
consume it.

### 9.1 Contract

- HTTP APIs SHOULD be described in OpenAPI.
- Request/response/event payloads SHOULD use JSON Schema.
- Schema versions and compatibility policy MUST be explicit.
- Unknown fields, missing fields, nulls, enums, numeric bounds, string formats, maximum
  sizes, and additional properties MUST be defined.
- Dates use a declared RFC 3339 representation and timezone behavior.
- Pagination order and cursor stability MUST be defined.
- Content type and character encoding MUST be explicit.

### 9.2 Errors

Use RFC 9457-compatible problem details for HTTP errors where practical:

- stable machine-readable type/code;
- human-safe title/detail;
- status;
- instance/correlation reference;
- invalid-field details where safe;
- retryability;
- no stack, SQL, token, email body, or sensitive provider response.

Errors MUST distinguish validation, unauthenticated, unauthorized, not found,
conflict/stale, rate-limited, dependency unavailable, timeout-unknown, and internal.

### 9.3 Compatibility

- Additive optional fields are preferred.
- Removing/renaming/changing meaning requires a version or coordinated migration.
- Consumers MUST tolerate documented additive changes.
- Producer and consumer contract suites MUST use the same examples.
- Fixtures and recorded provider payloads MUST be scrubbed of personal data.

## 10. Security and privacy standard

### 10.1 Threat modeling

Each release candidate MUST update a data-flow threat model covering:

- browser/session;
- authentication provider;
- web server and RPCs;
- database and RLS;
- scheduled workers;
- Gmail capture;
- email delivery and action links;
- ATS/provider fetches;
- logo providers;
- backups;
- logs/telemetry;
- support/operator access.

For each trust boundary, identify spoofing, tampering, repudiation/audit, information
disclosure, denial of service, and privilege escalation risks. Record treatment and
residual risk.

### 10.2 Minimum controls

- Secure, HTTP-only, same-site cookies appropriate to the flow.
- CSRF protection for cookie-authenticated state changes.
- Strict redirect and return-URL allowlists.
- Content Security Policy and safe framing policy.
- Output encoding and sanitization for untrusted content.
- SSRF defenses that resolve and re-check all address families and redirects.
- Rate limits by identity and operation, with bounded failure behavior.
- Secret rotation and revocation.
- Dependency, license, secret, and static vulnerability scanning.
- No sensitive fields in client bundles, URLs, analytics, crash reports, or notification
  previews.
- Recent authentication for account deletion and sensitive connection changes.
- Signed links have narrow purpose, expiry, replay behavior, and revocation.

### 10.3 Privacy

- Maintain a data inventory: category, purpose, source, owner, processor, sensitivity,
  location, retention, deletion, export.
- Collect the minimum content required.
- Separate operational metrics from user content.
- Consent MUST be specific, informed, revocable, and recorded.
- Disconnect and deletion MUST stop future processing.
- Backups MUST have documented expiry and restore-time deletion reconciliation.
- Operator access MUST be least-privilege, time-bounded where possible, and audited.
- New external providers require a privacy and data-transfer review before production
  data is sent.

## 11. Reliability and resilience standard

### 11.1 Failure-mode inventory

For each dependency and command, define behavior for:

- unavailable;
- slow;
- malformed response;
- partial success;
- duplicate;
- reordered;
- stale;
- rate-limited;
- credential expired/revoked;
- timeout before commit;
- timeout after commit;
- recovery after outage.

### 11.2 Data correctness

Required properties:

- no lost acknowledged write;
- at-most-once logical effect under retries;
- human-wins status protection;
- deterministic deduplication;
- reconciliation for dual writes;
- explicit source/provenance;
- monotonically meaningful version tokens;
- restoration preserves owner and integrity constraints.

Property or model-based tests SHOULD cover deduplication, status transitions, filter/URL
round trips, and import mapping. Example tests alone are weak for large state spaces.

### 11.3 Backups

- Backups MUST be encrypted at rest and in transit.
- Backup access MUST be narrower than ordinary repository access.
- Retention, immutability/versioning, key ownership, and deletion are explicit.
- Success means a usable restore, not a file creation heartbeat.
- Restore drills MUST verify schema, row counts, constraints, ownership, critical
  journeys, and deletion reconciliation.
- Backup material MUST NOT be committed to source control.

## 12. Observability standard

Telemetry MUST answer:

- What did the user/system attempt?
- Which version and environment handled it?
- Which owner lane and resource class were involved?
- Was the result successful, duplicate, conflict, rejected, partial, or unknown?
- How long did each boundary take?
- What should an operator do next?

Requirements:

- Structured events with stable semantic names.
- Correlation across request, command, database event, scheduled run, provider call, and
  notification.
- Pseudonymous identifiers; content and credentials redacted.
- Metric dimensions bounded to prevent cost/cardinality failures.
- Client and server clocks are not assumed equal for ordering.
- Alert thresholds have owners, runbooks, test cadence, and recovery notifications.
- Audit logs are distinct from debug logs and analytics.

## 13. Product and customer-interaction standard

- Claims MUST describe current behavior, scope, and limitations.
- A setup step MUST state why it is needed and how to undo it.
- Consent cannot be bundled with unrelated access.
- Errors give a next action and do not blame the user for system failure.
- Support requests use minimal necessary information.
- Incident updates separate known facts, hypotheses, mitigations, and next update time.
- User research consent and recording consent are explicit.
- Feedback, support, analytics, and marketing data are not silently combined.
- A pilot user can leave without negotiation.

## 14. Review standard

Each launch-critical change receives:

1. requirements/design review before implementation;
2. implementation review by someone other than the author;
3. security/data review when trust boundaries or sensitive data change;
4. independent acceptance against the built artifact;
5. release review against the traceability matrix.

Reviewers MUST challenge:

- tests that assert source text instead of behavior;
- fakes kinder than production;
- vacuous fixtures that never reach the boundary case;
- screenshots where the element exists but is off-screen;
- “green locally” claims without environment evidence;
- client checks standing in for database enforcement;
- a heartbeat that proves invocation rather than useful success;
- a backup that has never restored;
- a permission hidden in UI but available through an API;
- a scope or copy promise unsupported by the backend.

## 15. Defect severity

| Severity | Definition | Release treatment |
|---|---|---|
| S0 | Active/suspected data exposure, unauthorized external action, credential exposure, unrecoverable corruption | Stop affected systems; no release |
| S1 | Critical journey unavailable, lost acknowledged writes, broken isolation control, failed recovery promise | No release; immediate owner attention |
| S2 | Major degradation with bounded scope or workaround | Owner exception required |
| S3 | Minor functional, accessibility, visual, or copy defect | May schedule with owner |
| S4 | Enhancement or internal cleanup | Backlog |

Accessibility and privacy defects are classified by user impact, not automatically
downgraded as “polish.”

## 16. Definition of done

A work package is done only when:

- requirements and assumptions are accepted;
- implementation and migration are integrated;
- fixture and live implementations conform;
- positive/negative/boundary/concurrency/recovery verification passes;
- design/accessibility/copy checks pass for affected states;
- security/privacy/observability impacts are reviewed;
- operations and rollback/disablement are documented and rehearsed proportionately;
- evidence is attached to the exact artifact;
- no launch blocker is hidden in “follow-up” text;
- documentation reflects actual current behavior.
