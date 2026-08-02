# Postgres-only data authority and cutover contract

## 1. Final authority

| Data class | Authority | Ownership | Notes |
|---|---|---|---|
| Auth identity | Auth provider plus mapped `users` record | user | External identity never chooses internal owner |
| Entitlement/activation | Postgres | user/operator decision | Default deny |
| Profile/preferences/answers | Postgres | user | Versioned commands |
| Canonical company/posting | Postgres | shared catalog with provenance | User association remains private |
| User company/job state | Postgres | user | Subscription, decision, view, freshness |
| Application/status/notes | Postgres | user | Manual status authoritative |
| Autopilot stage/approval/outcome | Postgres event/state records | user | Immutable approval/receipt linkage |
| Resume/receipt files | Encrypted object storage plus Postgres manifest | user | Immutable checksum/version |
| Connections/referral funnel | Postgres | user | Third-party provenance and retention |
| Worker/run health | Postgres telemetry ledger | user/global safe metadata | Successful completion, not invocation |
| Audit/idempotency | Postgres append-only records | user/system | Redacted, one logical effect |
| Backup | Encrypted versioned DB/object backup | operations | Separate access/key, 35-day lifecycle |
| Import/export files | Ephemeral input or user download | user | File interoperability only |

Google Sheets are not an authority, mirror, fallback, control plane, registry, backup,
or recovery mechanism. Production MUST not require Sheet IDs, gids, service-account
credentials, Apps Script, tab headers, row keys, or reconciliation.

## 2. Shared versus tenant-owned data

ADR-005 freezes the exact model. Minimum invariants:

- canonical public facts may be shared only when their source/provenance permits;
- a user’s subscription, criteria, decision, application, answer, resume, connection,
  referral activity, and provider action are private;
- shared fetch does not expose which users watch a company/job;
- tenant deletion removes private associations/content without corrupting canonical
  public facts;
- user corrections are tenant-scoped unless independently validated for the catalog;
- every shared-to-private fan-out is deterministic, auditable, and owner-filtered.

## 3. One-time legacy treatment

There is no continuing Sheet correlation. ADR-004 chooses:

- clean start; or
- one explicit, rehearsed, owner-authorized import that maps Sheet rows to Postgres,
  reports every accepted/skipped/conflicting row, and ends with no persistent Sheet
  identifier or sync relationship except inert provenance text where legally useful.

After the import decision:

1. export/archive the legacy source;
2. reconcile counts and sampled records once;
3. obtain owner acceptance;
4. revoke runtime Sheet credentials;
5. disable/remove runtime Sheet code/schedules;
6. add a production tripwire for attempted Sheet access;
7. update system/runbook/config/secret inventories.

## 4. Runtime cutover gates

- all company/discovery inputs come from Postgres user state;
- all job/application/decision/status writes use Postgres commands;
- all schedules are jobs × active users and fail before access on unknown user;
- health, alerting, digest/notifications, and backups use Postgres/object state;
- no dual-write, read fallback, mirror, or reconciliation process runs;
- production boots and completes every critical journey without a Google credential;
- rollback uses compatible Postgres code/flags and encrypted restore, never Sheets.

## 5. Deletion and restore

Deletion first revokes processing, then removes active data and records a minimized
deletion ledger. Restoring an older snapshot MUST consult that ledger before enabling
sessions, workers, notifications, provider calls, or submissions. Shared catalog facts
remain only if they are not private user content.

Already transmitted employer/ATS applications cannot be recalled by deleting Job HQ.
The product deletes local copies/tokens according to contract and explains the external
irreversibility before submission and deletion.

## 6. Cutover evidence

- dependency and secret scan;
- production runtime tripwire;
- exact command/read inventory before and after;
- two-user worker/read/write tests;
- optional one-time import report;
- service-account revocation proof;
- encrypted restore and deleted-user suppression;
- no-Sheet source/config/system documentation diff;
- owner sign-off that the legacy Sheet is archival only.
