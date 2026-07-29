# Packet family 00 — Baseline and containment

## Outcome

The coordinator has one verified baseline, new Postgres dumps cannot enter Git, and an
encrypted replacement backup restores successfully before history remediation.

## Atomic packets

### PKT-00A Baseline reconciliation

Read-only. Record base/deployment commits, active branches/worktrees/PRs, applied and
file migrations, schema digest, routes, flags, schedules, providers, secrets by name,
design digest, and unrelated dirty files. Compare repository claims to deployed probes.

Acceptance:

- every later packet names this base and ledger;
- `0021`–`0027` status is evidence-backed, not inferred from branch names;
- stale docs are listed with a replacement authority.

### PKT-00B Disable Git dump writer

Stop `.github/workflows/pgdump.yml` from creating/pushing dumps and protect the replacement
from reactivation. Preserve incident evidence; do not erase history yet.

Negative cases: schedule, manual dispatch, reused credential, fork/default branch, and a
configuration toggle cannot silently resume Git dumps.

### PKT-00C Incident/access inventory

Determine dump contents and every known/platform-visible copy, actor, token, cache,
artifact, fork, clone, and deployment. Document unknowable external clones, assume
published material cannot be recalled, record timeline/owner/legal classification, and
rotate anything usable or unprovably safe.

### PKT-00D Encrypted backup

Create encrypted database and object-storage backups with separate key/access controls,
versioning, 35-day lifecycle, audit logs, alerting, and deletion-ledger compatibility.

### PKT-00E Restore drill

Restore to an isolated environment. Verify schema, constraints, RLS, ownership, object
checksums, row counts, and deleted-user suppression with two-user probes.

### PKT-00F History remediation

Only after PKT-00D/E: owner-approved coordinated history rewrite, collaborator/automation
coordination, protected-reference cleanup, fresh-clone scan, and incident closure.

## Escalate

If real secrets, third-party access, public reachability, notification obligations, or
an inability to restore is found. This family is T4 and may not be delegated as one
combined cheap-model task.
