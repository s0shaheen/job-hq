# Packet family 01 — Integration and access control

## Outcome

One release line has a coherent schema and every unknown, pending, suspended, removed, or
wrong-owner identity is denied at all authoritative boundaries.

## Atomic packets

### PKT-01A Branch and migration ledger

Map base commits, diffs, migrations, shared files, tests, known defects, and merge order
for dictionary/anti-slop, Jobs, `0021`, `0023`, missing `0024`, `0025`, `0026`, and
`0027`. Record `0022` as explicitly excluded future work. Reserve migration numbers
serially.

### PKT-01B Empty/install and upgrade harness

Prove empty install and production-like upgrade yield the same expected schema. Audit
owners, grants, RLS enable/force, functions/search paths, indexes, constraints, storage
policies, comments, and rollback compatibility.

### PKT-01C Identity states

Implement email/password and Google auth plus anonymous, pending, active, suspended,
deleted, operator, and service identities. Provisioning/activation/re-invitation are
idempotent and audited. Google auth requests no Gmail mail scope.

### PKT-01D Founding-free entitlement

Assign activated first users an uncapped, all-capability, free-forever entitlement.
Unknown plan/capability values default deny. UI visibility is not authorization.

### PKT-01E Default-deny matrix

Real-boundary tests cover DB tables/views/RPCs, object storage, cached reads, exports,
events, background jobs, admin/support tools, and feature flags with two users. A policy
mutation from deny to allow must fail.

### PKT-01F Revocation

Suspension/deletion stops sessions, tokens, pending commands, schedules, notifications,
provider work, and submissions. Narrow archive/delete access remains where contracted.

### PKT-01G Authentication abuse hardening

Email verification, password recovery, account linking/collision, invite/account
enumeration, credential stuffing, brute force, bot signup, activation-request abuse,
rate limits, recovery-token expiry/replay, device/session listing, and device revocation.
Security email is required account infrastructure and is distinct from opted-in product
email.

### PKT-01H Operator controls

Owner activation, founding-free assignment, suspension, consented support access,
session/provider revocation, and kill switches use least privilege, recent auth, reason
codes, audit, and dual confirmation for high-impact actions. Private-content access
requires a user consent grant with scope, expiry, revocation, and no impersonation.

## Known hazards

- `0022` must not enter the launch artifact; if a future dependency forces its inclusion,
  a replacement packet must prove ownership/locking and complete unreachability.
- `0027` must enforce default deny in database/RPC, not only middleware/corpus.
- Migration-local green results are invalid after integration until rerun.

## Escalate

Any new service-role use, direct browser DML, migration collision, cross-user cache, or
authorization rule not enforceable below the UI.
