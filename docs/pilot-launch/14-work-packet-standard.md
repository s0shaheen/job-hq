# Launch work packet standard

Schema: `job-hq-launch-packet/v1`
Purpose: bounded, model- and harness-agnostic implementation handoff

## 1. Why packets exist

A work packet gives an implementation worker one observable outcome without asking it to
reconstruct the product, choose architecture, or silently expand scope. Lower-cost
models MAY implement packets after the coordinator has frozen their inputs. They MUST
NOT decide migrations, authority, retention, credentials, provider policy, or release
acceptance unless the packet is explicitly a decision packet owned by the product owner.

## 2. Required packet fields

```yaml
schema_version: job-hq-launch-packet/v1
id: PKT-AREA-NN
title: ""
kind: build | test | integration | decision | release
priority: P0 | P1 | P2
review_tier: T0 | T1 | T2 | T3 | T4

baseline:
  ref: ""
  commit: ""
  migration_ledger_digest: ""
  design_bundle_digest: ""
  config_manifest_digest: ""

ownership:
  coordinator: ""
  implementer: ""
  acceptance_owner: ""

outcome:
  user_problem: ""
  observable_result: ""
  requirement_ids: []
  authoritative_sources: []
  in_scope: []
  out_of_scope: []
  non_goals: []

boundaries:
  read_allowlist: []
  write_allowlist: []
  forbidden_paths: []
  maximum_changed_files: 7
  maximum_net_lines: 600
  expansion_rule: >
    Stop and request a replacement packet before exceeding a boundary.

dependencies:
  decisions: []
  packets: []
  artifacts: []
  credentials_or_external_state: []

contract:
  actors_and_permissions: []
  data_classification: []
  state_machine:
    states: []
    transitions: []
  interfaces:
    inputs: []
    outputs: []
    stable_errors: []
  invariants:
    - id: ""
      statement: ""
      boundary: database | rpc | worker | provider | ui | restore
  writes:
    idempotency: ""
    version_or_cas: ""
    retry_and_timeout: ""
    audit: ""
    undo_or_irreversibility: ""
  observability:
    events: []
    metrics: []
    redaction: []
  rollout:
    flag: ""
    default: off | deny | not_applicable
    disable_path: ""
    rollback_or_compensation: ""

acceptance:
  scenarios:
    - id: AC-1
      given: []
      when: []
      then: []
  negative_cases: []
  boundary_cases: []
  concurrency_and_recovery: []

verification:
  tests:
    - id: VT-1
      layer: unit | property | database | contract | integration | browser | accessibility | restore
      controlled_input: ""
      oracle: ""
      authoritative_readback: ""
  fixture_live_parity: ""
  counterexample:
    violating_variant: ""
    expected_failure: ""
    evidence: ""
  commands_or_equivalents: []
  evidence_bundle: []

escalate_if: []

handoff:
  summary: ""
  changed_files: []
  requirements_to_evidence: []
  test_results: []
  counterexample_result: ""
  risks_and_deferrals: []
  follow_on_packets: []
```

Markdown MAY be used instead of YAML if it preserves every field and stable identifier.

### 2.1 Lightweight read-only profile

A T0 read-only audit or documentation-generation packet MAY omit mutating-state fields
only when it explicitly declares `profile: lightweight-readonly` and includes:

- exact baseline/definition digest;
- named coordinator/acceptance owner or `coordinator_assignment_required`;
- one outcome and requirement IDs;
- exact read/write/forbidden paths;
- data classification and redaction;
- dependencies and external-side-effect prohibition;
- acceptance, negative/completeness counterexample, verification, evidence destination;
- escalation and handoff fields.

Any code/config change, external mutation, credential/provider access beyond read-only,
or T1–T4 concern requires the full schema. `not_applicable` must be explicit where a
required field does not apply.

## 3. Packet size and split rules

A normal implementation packet:

- has one user-observable or authoritative-boundary outcome;
- changes 2–5 product files and 1–3 test files;
- changes no more than one persistence state machine;
- does not combine a migration with its full UI;
- does not combine two provider adapters;
- does not modify a shared shell and a surface at once;
- does not contain both architecture choice and implementation; and
- can be reviewed and reverted independently.

Split the packet if:

- the read/write allowlist must expand;
- a new migration/RLS/RPC is discovered;
- a second external provider is needed;
- a second independent state machine appears;
- the expected change exceeds seven files or 600 net lines;
- an owner decision or credential is missing; or
- a severity 0/1 security, privacy, data-integrity, or false-submission risk appears.

## 4. Review tiers

| Tier | Scope | Required acceptance |
|---|---|---|
| T0 | Documentation or test-only, no behavior | Coordinator review |
| T1 | Pure isolated logic, no persistence/external effect | Independent implementation review |
| T2 | UI over frozen commands/interfaces | Independent review plus design, browser, accessibility, fixture proof |
| T3 | Migration, RLS, RPC, storage, shared interface, worker, external provider | Serial integrator plus independent security/data review and real-boundary mutation proof |
| T4 | Backup, deletion, notifications, billing, submission, production/release | T3 plus owner/operations acceptance and rehearsal |

## 5. Deterministic evidence rules

### State-changing command

Prove:

- unauthenticated, wrong-owner, malformed, stale-version, replay-same-key,
  same-key-different-payload, duplicate concurrent request, rate limit, dependency
  failure, and timeout-after-possible-commit;
- owner identity derived at the authoritative boundary;
- exact durable readback and audit event;
- no duplicate logical effect;
- undo or explicit irreversible confirmation; and
- fixture/production parity.

### Database/RPC/storage

Use real boundary tests with two identities. Prove direct DML denial, wrong-owner object
denial, function ownership/search path, constraint behavior, and a controlled mutation
that weakens the policy or predicate and is caught.

### Scheduled worker

Prove named owner lane, missing/unknown owner rejection before access, duplicate
invocation, partial batch, poison item, provider limit, stale success, alert, recovery,
and no cross-user aggregate masking.

### UI

Prove populated, empty, loading, revalidating, degraded, validation, conflict, offline,
session-expired, permission, long-text, large-type, phone, desktop, touch, keyboard,
focus restoration, and persistence after reload where claimed. Screenshot similarity
alone is insufficient.

### Provider submission

Prove live-schema drift, sensitive unknowns, attachment mismatch, duplicate application,
provider timeout before/after possible commit, confirmation success, no confirmation,
CAPTCHA/login challenge, rate limit, circuit breaker, pause, cancellation, and immutable
review-to-receipt linkage. Never “retry until green” an unknown outcome.

### Restore/deletion

Restore to an isolated environment, verify constraints/ownership/artifacts, run
cross-user negative probes, and prove a deleted user in the restored snapshot cannot
resume sessions, workers, notifications, or submissions.

## 6. Coordinator protocol

The coordinator:

1. refreshes the base commit, migration ledger, design digest, and config digest;
2. resolves all dependency decisions;
3. leases non-overlapping paths and the single migration slot;
4. gives workers only applicable excerpts and exact allowlists;
5. rejects silent scope expansion;
6. replays each result onto the integration branch;
7. reruns packet and impacted gates on that exact commit;
8. obtains the required review tier;
9. records accepted risks and evidence in the central ledger; and
10. is the only role that marks `accepted`, `integrated`, or `released`.

Workers hand back a patch/draft PR and evidence. They do not merge, push to `main`, alter
unlisted files, renumber migrations, weaken tests, approve their own exceptions, or
declare launch readiness.

## 7. External side-effect safety

No implementation or verification packet authorizes a real-world side effect merely
because the feature handles one. Every packet involving ATSs, email, Stripe, identity
providers, people-data vendors, storage deletion, secret rotation, production
configuration, or Git history MUST declare:

- exact sandbox/test account, tenant, recipient, employer/job, payment mode, and provider;
- external-mutation allowlist;
- forbidden production targets;
- test-data cleanup/retention;
- credential owner and scope;
- dry-run/fixture path;
- separate owner confirmation required before any real submission, send, charge,
  account change, deletion, secret rotation, or history rewrite.

Counterexample/mutation/fault-injection variants run only in isolated test
infrastructure. They MUST NOT enter the release artifact or production configuration.
Unknown environment/provider identity defaults to no external mutation.

## 8. Central ledger row

```yaml
packet_id: PKT-AREA-NN
status: queued | blocked | leased | implementing | awaiting_review | accepted | integrated | released | retired
base_commit: ""
head_commit: ""
lease_holder: ""
write_paths: []
migration_number: null
dependencies: []
requirements: []
evidence:
  tests: []
  counterexample: ""
  design: []
  review: []
  artifact_digest: ""
risks:
  open: []
  accepted: []
integration:
  branch: ""
  commit: ""
  retest: ""
next_packets: []
```

The ledger is coordinator-owned and versioned/audited. Status changes append history
events; the current row is a derived projection. Completed evidence artifacts are
immutable.

## 9. Universal repository constraints

Every packet inherits:

- never push directly to `main`;
- read and verify packet-supplied digests/excerpts for `AGENTS.md`, `CLAUDE.md`,
  `docs/WEBAPP-BUILD.md`, the full-product contract, requirements register, and relevant
  plan/design sources before acting;
- never hand-edit `hq.config.yaml`;
- never touch owner/private resume content unless the packet is the approved vault split;
- never write Google Sheets in the final product;
- while transitional code exists, no Sheet write may bypass `core.sheets.Tab`;
- never invent a migration number before the serial integrator reserves it;
- never expose service credentials to browser bundles;
- never change visible design without the owner design source or an approved addendum;
- every new data-source method includes fixture behavior; and
- no completion claim without fresh evidence from the exact integrated commit.
