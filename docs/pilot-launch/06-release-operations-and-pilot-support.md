# Release operations and pilot support

Scope authority: `full-product-pilot-v2`. Cohort-size, conditional-feature, Gmail, and
Sheet-fallback language from the earlier narrow plan is superseded below.

## 1. Operating model

The pilot is a managed service with named users, named operators, declared coverage
hours, and an immediate stop path. No capability is released without an owner who can
observe it and disable it.

Recommended roles:

| Role | Accountability |
|---|---|
| Release owner | Approves artifact, configuration, rollout, hold, rollback |
| Data/security owner | Isolation, incident review, backup, restore, retention, deletion |
| Product/design owner | Scope, copy, design parity, user promise, exceptions |
| Support owner | Intake, acknowledgement, user communication, escalation |
| Verification owner | Traceability and independent release evidence |

One person MAY hold several roles in a small pilot. Every role still needs an explicit
name and backup contact for planned absence.

## 2. Environments

### Local/test

- Synthetic data only.
- Fixture and live-interface contract testing.
- No production secrets.
- No outbound message to real users.

### Staging

- Separate auth, database, storage, email/test recipient, and scheduled-worker boundary.
- Same migration and deployment mechanism as production.
- Real signed sessions for distinct test users.
- Scrubbed/synthetic production-shape data.
- Destructive and failure-injection tests allowed.

### Production

- Named pilot users only.
- Production feature allowlist.
- Real user data never flows down to lower environments.
- Operator access least-privilege and audited.
- Startup/configuration failure displays unhealthy and fails closed; it never enables
  demo/fixture data.

## 3. Configuration and secret control

Maintain a configuration register:

| Field | Required |
|---|---|
| Key | Stable name |
| Purpose | Behavior controlled |
| Environment | Where present |
| Sensitivity | Public, internal, secret |
| Owner | Who may change it |
| Default | Must be safe |
| Allowed values | Validated |
| Change procedure | Review and deployment |
| Rollback value | Known safe state |
| Rotation/expiry | For secrets |
| Telemetry | How current effective state is known |

Requirements:

- Risky features default off.
- Missing, malformed, or unknown security configuration defaults to deny.
- Configuration changes are reviewed and attributable.
- Secrets are injected from approved secret stores and are never printed.
- Preview deployments cannot use production service credentials.
- The release evidence records effective non-secret configuration and secret versions,
  not secret values.

## 4. Pre-release sequence

### Phase 0 — Contain the database-dump incident

1. Disable future Git dumps.
2. Preserve only the evidence needed for incident assessment.
3. Identify affected commits, references, clones, forks, artifacts, and access.
4. Create an encrypted replacement backup and verify restoration.
5. Classify the data and potential credentials in the dump.
6. Decide rotations, collaborator notification, user/regulatory notification, and
   repository-history purge with appropriate advice.
7. Coordinate any purge across protected branches, tags, clones, caches, and deployment
   systems.
8. Verify from a fresh clone and hosting interface that the approved canonical history
   no longer exposes the dump.
9. Record lessons and prevention controls.

The full dump MUST NOT be attached to an issue, copied into a support system, or
re-uploaded as evidence.

### Phase 1 — Qualify release candidate

1. Freeze requirements and design-input versions.
2. Integrate migration and shared-shell branches.
3. Build immutable application/worker artifacts.
4. Apply migrations in staging.
5. Run the complete evidence matrix.
6. Rehearse backup/restore and deletion reconciliation.
7. Rehearse each kill switch and rollback.
8. Resolve or accept defects under the severity policy.
9. Obtain product/design/security/release sign-off.

### Phase 2 — Production deploy with capabilities disabled

1. Confirm recent valid restore point.
2. Stop or drain affected writers when required by migration.
3. Apply additive migrations.
4. Deploy backward-compatible readers/writers.
5. Run schema, privilege, RLS, configuration, and health invariants.
6. Enable reads for the canary owner.
7. Enable one write capability at a time.
8. Reconcile state and audit events.
9. Start soak clock only when all required health signals are green.

## 5. Rollout

### Stage A — Owner soak

Recommended minimum: seven consecutive days and at least one full weekly behavior cycle.

The owner:

- completes every critical journey through the pilot UI;
- uses an independent second account for isolation;
- verifies Google authentication without Gmail mail scope and verifies Gmail status
  processing remains disabled;
- imports and exports;
- triggers a recoverable conflict, true-offline disabled-write state, and server command
  timeout reconciliation;
- creates/renders/selects a resume and attachment;
- prepares, reviews, and submits one supported ATS application plus one manual handoff;
- completes warm-introduction search, multi-pin, and a human outreach-funnel update;
- rehearses notification preference and unsubscribe;
- completes a support-assisted account close in staging;
- records every operator fallback.

Exit:

- no S0/S1;
- no unexplained data divergence;
- no stale critical lane;
- backup/restore and alerts remain healthy;
- all fallbacks have owner disposition.

### Stage B — One external canary

Recommended minimum: 48 hours and one complete scheduled-run/digest cycle.

Rules:

- live onboarding call or concierge support;
- no new feature toggles during first journey unless needed to stop harm;
- daily review of command failures, status corrections, stale lanes, notifications, and
  support;
- explicit canary consent to rapid contact;
- complete export and preference-control rehearsal.

### Stage C — Invited cohort waves

- Invite in waves, not all at once.
- Expand only after prior wave passes.
- The owner approves each wave; no automatic cohort expansion.
- Evaluate stop conditions daily.
- Release changes through the same canary path; do not patch production manually.

### Stage D — Decision

At the agreed duration:

- compare product outcomes and quality thresholds;
- review incidents, support, and privacy;
- decide expand, continue, narrow, or stop;
- update the pilot contract before any cohort or promise expansion.

## 6. Feature kill switches

At minimum, operations MUST be able to disable independently:

- new invitations/provisioning;
- all user writes while retaining safe reads/export;
- discovery jobs;
- Gmail capture acceptance and status mutation, which remain disabled for this launch;
- product emails/digests;
- email action links;
- imports;
- resume uploads/renders;
- application preparation/review;
- submission globally, per user, and per ATS provider;
- execution hosts/agents;
- Stripe checkout and billing webhooks;
- third-party enrichment/logo requests if needed.

Kill switches MUST:

- be server-side;
- default to the safer state when configuration is missing;
- have clear user-facing degraded copy;
- be testable in staging;
- record who changed them and when;
- preserve export/deletion access where safe;
- have a defined recovery check before re-enable.

## 7. Rollback strategy

Order:

1. stop the affected writer/external side effect;
2. preserve evidence;
3. assess whether a compatible prior application can serve the expanded schema;
4. deploy the trusted application artifact or disable the feature;
5. reconcile ambiguous commands using idempotency/audit identifiers;
6. restore data only when corruption/loss requires it;
7. verify ownership, counts, status invariants, and critical journeys;
8. notify affected users;
9. re-enable only after the failed control is corrected and regression evidence passes.

Rules:

- Never drop additive schema to roll back application code.
- Never overwrite a human status to make stores agree.
- Never resolve dual-write divergence by guessing.
- Never declare rollback complete because pages load.
- A failed migration is repaired forward unless a proven non-destructive reversal exists.
- Google Sheets are never a rollback or recovery path. Rollback uses compatible
  Postgres/object-storage code, flags, backups, and restored infrastructure.

## 8. Backup and restore runbook requirements

### Backup

- Managed database backup plus independent encrypted versioned backup.
- Object storage backup for resumes/uploads when introduced.
- Encryption key managed separately from stored data.
- Least-privilege writer and separate restore role.
- Access logs and alerts for unusual backup access/deletion.
- Retention and lifecycle aligned with user deletion policy.
- Per-lane success means verified complete artifact, not process invocation.

### Restore drill

1. Select a backup without changing production.
2. Create an isolated recovery environment.
3. Restore database and objects.
4. Apply only required compatible configuration.
5. Verify checksums/integrity.
6. Verify migration ledger and schema.
7. Verify row counts and sampled relations.
8. Verify RLS/privileges with two users.
9. Complete auth, Today, Jobs, Applications, Coverage, resume, Autopilot, referral,
   export, deletion-safe restore, and support lookup journeys.
10. Reconcile deletions that occurred after the backup according to the deletion ledger.
11. Measure RPO and RTO.
12. Destroy the isolated recovery environment securely.

The drill report MUST not include personal content.

## 9. Health and alerting

### Health dimensions

- web availability;
- auth success;
- command success/conflict/rejection/unknown;
- database latency/errors/connections;
- scheduled invocation and per-user useful completion;
- proof that Gmail capture/status lanes remain disabled;
- discovery freshness;
- Autopilot executor/provider health, unknown outcomes, drift, duplicates, and pauses;
- resume render/storage health;
- warm-introduction provider/funnel health;
- outbound acceptance/bounce/complaint/suppression;
- backup freshness and restore-test age;
- attempted runtime Sheet access after cutover;
- Stripe webhook/entitlement consistency;
- feature-flag/config drift;
- support volume and open incident age.

### Alert record

Every alert has:

- exact condition and evaluation window;
- severity;
- affected user/global scope;
- owner and backup;
- safe diagnostic links;
- runbook;
- kill switch;
- test cadence;
- recovery condition and notification.

An alert that has never been test-fired is not launch evidence.

## 10. Support workflow

### Intake

Use one declared channel. Ask for:

- account identifier;
- approximate time/timezone;
- page and action;
- expected vs observed;
- whether retry/reload occurred;
- safe correlation reference;
- screenshot only after warning against credentials/private email content.

Never ask for passwords, magic links, capture tokens, recovery codes, API keys, full
inbox export, or an unredacted database dump.

### Triage

1. Acknowledge under the declared support target.
2. Assign severity from user impact.
3. Determine whether the user should stop/retry/use a workaround.
4. Use correlation/audit metadata before requesting content.
5. Obtain explicit, time-bounded consent before viewing user content.
6. Escalate S0/S1 to the incident workflow.
7. Record resolution and convert recurrence into a regression requirement.

Recommended targets, subject to owner approval:

| Severity | Example | Target |
|---|---|---|
| S0 | data exposure, unauthorized external action | immediate during declared coverage; stop affected lane |
| S1 | sign-in/write/recovery critical failure | acknowledge within 4 support hours |
| S2 | one-user degradation with workaround | 1 business day |
| S3/S4 | minor defect/feedback | 2 business days |

Do not promise 24/7 support without staffing it.

## 11. Incident workflow

For S0/S1:

1. timestamp detection and appoint incident lead;
2. stop the affected lane and new invitations;
3. preserve relevant evidence with minimal access;
4. establish known facts, hypotheses, user/data scope, and external effects;
5. communicate affected users: facts, impact, immediate action, workaround, next update;
6. contain credentials/tokens/providers;
7. repair, roll back, or restore;
8. verify invariants independently;
9. communicate resolution and remaining risk;
10. complete blameless review with corrective owners/dates and regression evidence.

Incident communication MUST distinguish:

- what is known;
- what is suspected;
- what has been contained;
- what the user should do;
- when the next update will arrive.

A public status page is optional for the invited pilot; direct cohort communication,
hosted uptime monitoring, and an internal incident log are required.

## 12. Privacy and data-request operations

Before launch, maintain procedures for:

- access/export;
- correction;
- notification opt-out;
- connected-account revocation;
- account suspension;
- deletion;
- restoration involving previously deleted accounts;
- security incident;
- provider/subprocessor change.

Deletion procedure MUST inventory:

- auth identity/session;
- allowlist/entitlement;
- profile/preferences;
- jobs/decisions;
- applications/notes/evidence;
- disabled/future email events/tokens, if any remain;
- connections/warm data;
- answers/policies;
- imports;
- saved views;
- staged applications, submission receipts, executor commands, resumes, and artifacts;
- scheduled lanes;
- digests/action links;
- logs/audit;
- deletion-ledger entries and any archived legacy import source;
- live database;
- backups and their expiry/reconciliation.

If an immutable audit tombstone remains, it MUST be minimized and non-identifying unless
a documented obligation requires otherwise.

## 13. Pilot communications

### Invitation must state

- experimental invite-only status;
- exact product promise and exclusions;
- required setup and permissions;
- supported devices;
- data categories/providers at a useful level;
- support channel/hours;
- feedback expectations;
- duration;
- export/delete path;
- supported ATS submission behavior, explicit approval and irreversibility, receipt
  evidence, unknown/manual outcomes, and global/provider/user pause controls;
- Gmail automatic status is excluded.

### Release note must state

- user-observable changes;
- changed permissions/data handling;
- known limitations and workarounds;
- action required;
- rollback/degraded state if relevant.

### Incident update must state

- affected capability and timeframe;
- known impact;
- containment;
- user action;
- next update.

## 14. Feedback and learning

Separate:

- defect: observed result violates promise;
- comprehension: behavior may be correct but unclear;
- data-quality correction;
- missing capability;
- workflow friction;
- trust concern;
- value signal.

Recommended cadence:

- short baseline interview before onboarding;
- observation during onboarding;
- in-product or direct issue channel;
- weekly 15-minute check-in;
- exit interview and export rehearsal.

Do not turn a feature request into a production behavior during support. Route it to an
explicit product decision and design/contract update.

## 15. Pilot dashboard

The owner needs a privacy-minimal operational view:

- active/invited/suspended users;
- last successful critical lane per user;
- command success/conflict/error/unknown;
- confirmed/unknown/failed/manual submission outcomes and duplicate/drift guards;
- proof that Gmail capture/status lanes are disabled;
- discovery freshness/failures;
- resume render/storage and warm-introduction provider health;
- notification outcomes;
- backup freshness and last successful restore drill;
- open incidents/support cases;
- release artifact/configuration;
- current kill-switch state.

The dashboard MUST not expose full email bodies, application notes, answers, resumes, or
tokens.

## 16. Launch-day checklist

- [ ] Incident containment and backup replacement accepted
- [ ] Release artifact/configuration/evidence approved
- [ ] Restore point confirmed
- [ ] On-call/support owners available
- [ ] Kill switches tested and access confirmed
- [ ] Canary account health green
- [ ] Invitations exactly match approved cohort
- [ ] Consent/invitation copy current
- [ ] Monitoring and alert routes live
- [ ] No S0/S1 and accepted S2 list reviewed
- [ ] Rollback artifact known
- [ ] First review time scheduled

## 17. Stop/close checklist

- [ ] Stop new invitations and risky scheduled work
- [ ] Tell users what is changing and when
- [ ] Offer/export user data
- [ ] Process deletion/retention choice
- [ ] Revoke sessions, tokens, emails, and future jobs
- [ ] Reconcile stores and backup deletion ledger
- [ ] Close provider access/costs no longer needed
- [ ] Preserve minimized operational lessons
- [ ] Conduct exit interviews and incident review
- [ ] Record expand/continue/narrow/stop decision
