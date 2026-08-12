# write-path

How anything gets written: the RPC command pattern with idempotency, compare-and-set,
durable results, and audit — and no direct browser DML anywhere. This is the pattern
every other capability's writes instantiate.

## What it is

A write is a command: one security-definer RPC that validates, checks the caller's
version token, performs the row change, and appends its audit event in a single
transaction, then durably records its result under the caller's idempotency key.
Repeating the key returns the first result instead of applying twice. The browser holds
no insert, update, or delete privilege on any product table; it can only ask the
database to run a command as the authenticated owner.

## Where it is stored

- `public.command_idempotency` — `db/migrations/0003_write_path.sql`: PK
  `(user_id, idem_key)`, the command name, and `result jsonb` — the durable result, not
  just the key. `request_hash` was added by `0026_resume.sql`. RLS is enabled with no
  policies at all: only security-definer functions reach it.
- `public.events` — the audit ledger (`0001_init.sql`), written in the same transaction
  as the row change; update/delete revoked from browser roles (`0002_invariants.sql`).
- Version tokens are plain `updated_at` columns on the written rows.

## Who reads and writes it

The browser chain is fixed: client component → server action (`"use server"`) →
`getDataSource()` (`webapp/lib/data/get-source.ts`, server-only, fails closed on
entitlement) → `SupabaseDataSource` (`webapp/lib/data/supabase-source.ts`, the only
module that calls `.rpc("app_*")` for product writes) → the security-definer RPC. The
only browser Supabase client (`webapp/lib/supabase/client.ts`) does auth, never data. A
grep of `webapp/` finds zero Supabase table DML in product code; the only real DML lives
in the test harness `webapp/tests/live/admin.ts`. Every server action answers an expired
session with `{ ok: false, kind: "auth" }` instead of a redirect. The fixture twin
(`webapp/lib/data/fixture-source.ts`) implements the same `DataSource` interface.

The engine's lane is separate: `hq_*` RPCs granted to `service_role` only (e.g.
`0015_engine_writes.sql`), passing the guard hatch in `hq_entitlement_guard()`
(`0027_entitlement.sql`). The webapp's service client (`webapp/lib/supabase/service.ts`)
is server-only and used by the capture and digest handlers alone.

## The command contract

- **Idempotency** — the client mints `crypto.randomUUID()` per gesture and holds it
  stable across retries (ref-held keys, e.g. `webapp/app/(app)/import/upload-panel.tsx`;
  bulk fan-out derives sub-keys `${idem}:${i}` in `webapp/app/(app)/jobs/decisions.ts`).
  Server actions validate the key (non-empty, ≤200 chars) at the boundary. RPCs written
  before `0026` re-check the stored result before and after taking the row lock
  (`0003_write_path.sql`); later RPCs call `hq_command_replay`, which also compares
  `request_hash` (via `hq_command_fingerprint`, values-only sha256) and raises `22023`
  when the same key arrives with a different command or arguments.
- **Compare-and-set** — each single-row write takes `p_expected_updated_at`; bulk writes
  take a parallel array that must match the id list one-for-one. A mismatch raises
  errcode `40001` with a message containing `conflict`, which the data layer matches
  (`/conflict|stale/i`), re-reads the row, and returns a discriminated
  `{ ok: false, kind: "conflict", current }` so the UI shows the server's row and
  reverts every optimistic patch in the batch. A null expectation is allowed and means
  last-write-wins knowingly.
- **Audit** — the RPC appends the `events` row inside the write transaction; there is no
  client-side audit or telemetry (verified absent).
- **Result shapes** — `app_*_row()` helpers (`0003`, `0008`, `0010`, `0021`, `0026`)
  keep RPC results and reads byte-compatible; they are deliberately not security
  definer.

## Hardening around the pattern

- `0004_audit_hardening.sql` revokes TRUNCATE, TRIGGER, and REFERENCES from browser
  roles schema-wide, including default privileges.
- `20260802_205716_anon_select_revoke.sql` revokes SELECT from `anon` schema-wide.
- The entitlement pair (`docs/specs/user-entitlement.md`) closes both the PostgREST
  surface and the inside of security-definer RPCs.

## Invariants

- No browser DML, no browser-chosen owner: ownership is `auth.uid()` inside the RPC.
- One command, one logical effect, one audit event, one durable result. A replayed key
  must return the first result, never apply twice.
- Conflicts are surfaced, never silently merged; the server's row wins the screen.
- Offline: writes are refused and nothing is queued (DEC-011; stated in
  `webapp/app/(app)/settings/preferences-form.tsx` and followed by the companies
  surface). One pre-DEC-011 exception survives: `webapp/lib/outbox.ts`, a
  localStorage outbox for single-posting triage only, flushed by
  `webapp/components/pending-work.tsx`. It contradicts CLAUDE.md's "no browser offline
  mutation queue" rule; treat it as legacy to remove, not a pattern to copy.
- Fail loud: missing identity, malformed input, and unknown state raise; nothing guesses.
