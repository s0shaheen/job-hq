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
  policies at all: only security-definer functions reach it. **It is never pruned** — see
  the retention invariant below.
- `public.events` — the audit ledger (`0001_init.sql`), written in the same transaction
  as the row change; update/delete revoked from browser roles (`0002_invariants.sql`).
- Version tokens are plain `updated_at` columns on the written rows.
- `public.rate_bounds` / `public.usage_counters` —
  `20260817_011844_per_user_rate_bounds.sql` (#261): the bound catalog and the
  durable per-user meter. No browser role holds any privilege on either.
  `usage_counters` carries the entitlement pair (its rows are owned, and the guard
  is the entire boundary inside a definer, where RLS does not apply);
  `rate_bounds` deliberately does not (no `user_id`, so the guard's ownership half
  is inexpressible, so a future write grant plus a permissive write policy would
  let any entitled account raise its own limits — `allowed_emails`' situation, and
  the grant system is the answer). Counters cascade with the account. Not every
  bound is a counter: `rate_bounds.is_chargeable = false` marks a bound enforced
  from live state (`warm.concurrent` reads `warm_searches.status`), and the charge
  refuses it with `22023` — without that flag a catalogued short-window meter is a
  browser-reachable way to mint durable counter rows for a bound that refuses
  nothing. Retiring a meter deletes its counters first; the FK is `RESTRICT`.

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
  when the same key arrives with a different command or arguments. **A replay is an
  entitled caller's read of its own result, and the lookup enforces both halves**
  (`20260817_051941_replay_respects_entitlement.sql`, #256): before it reads
  `command_idempotency` it refuses a caller who is not entitled and a caller whose
  `p_user` is not `auth.uid()`, `42501`. The guard trigger cannot do this — a replay
  returns above every write, so no trigger fires — and `docs/specs/user-entitlement.md`
  §"The third mechanism" carries the reasoning and what is left of the pre-0026
  residual. **The pre-0026 lookup now compares the command too**
  (`20260820_013851_replay_compares_the_command.sql`, #288): it still keys on
  `(user_id, idem_key)` and still has no `request_hash` and no entitlement check, but a
  key that belongs to another command raises `22023` with the same wording
  `hq_command_replay` uses, rather than answering with that command's stored result. That
  closes the bypass — a suspended account can no longer reach a post-0026 result through
  a pre-0026 sibling — and closes the same confusion for entitled callers, who could get
  an unrelated command's payload reported as this command's answer. **What is left is
  narrower and is still open**: those 29 lookups return above every write, so no trigger
  fires, so a suspended account replaying its OWN key against the SAME pre-0026 command
  still receives its own stored result. That closes per function as each adopts
  `hq_command_replay`; `tests/db/test_replay_command_scope.py` holds the set as a
  baseline that may only shrink.
- **Compare-and-set** — each single-row write takes `p_expected_updated_at`; bulk writes
  take a parallel array that must match the id list one-for-one. A mismatch raises
  errcode `40001` with a message containing `conflict`, which the data layer matches
  (`/conflict|stale/i`), re-reads the row, and returns a discriminated
  `{ ok: false, kind: "conflict", current }` so the UI shows the server's row and
  reverts every optimistic patch in the batch. A null expectation is allowed and means
  last-write-wins knowingly.
- **Audit** — the RPC appends the `events` row inside the write transaction; there is no
  client-side audit or telemetry (verified absent).
- **Composition** — a command that must land two recorded acts atomically calls the
  other command's RPC inside its own transaction (`app_settle_autopilot_handoff` →
  `app_set_status`, `20260814_030545_autopilot_handoff.sql`). The composed command's
  rules (the human-status lock, reopen-needs-a-note) hold inside the composition —
  that is the point of composing instead of copying. Two rules, both learned from a
  security review that demonstrated the defect:
  - **The inner idempotency key must be unguessable, never derived from row
    identity.** Any browser may send any string as `p_idem` to any RPC, and the
    pre-0026 callees (`app_set_status`, `0010_pipeline.sql`) match a replay on the
    KEY ALONE — no command name, no `request_hash`. A deterministic inner key is
    therefore a key the caller can pre-seed, after which the callee returns a stored
    result and writes nothing. The outer command's own key is what provides replay
    safety, so the inner one only has to be unique: derive it with
    `gen_random_uuid()`. Post-0026 callees (via `hq_command_replay`) raise on a
    command/fingerprint mismatch instead of answering silently — safer, but not a
    reason to skip this.
  - **Authorization is inherited from the shared primitive, not re-typed.** The
    entitlement and own-account checks live inside `hq_command_replay` (#256), which
    every post-0026 command calls above its first write — so a composed command gets
    them without a line, and so does the inner call, which does its own lookup. The
    third rule is therefore a prohibition: do not re-implement the check at a call
    site and do not skip the lookup to "save a round trip". A command that reads a
    stored result without going through that function is outside the boundary, which
    is exactly the state the 27 pre-0026 commands are in.
  - **The composition must verify its postcondition.** After the inner call, re-read
    the row and require it to actually say what the composition claims, raising and
    rolling back if it does not; build the returned object from that re-read rather
    than from the callee's return value. Key scoping is a probability argument; this
    is the one that holds. A composed command that cannot see whether its callee
    wrote is a command that reports success for a write that never happened —
    exactly what shipped in the first draft of the autopilot handoff, where
    `handed_off` landed on an application still reading `Rejected` with no
    `action.status` event (`tests/db/test_autopilot_handoff.py`, the pre-seeded-key
    and postcondition tests).
- **Result shapes** — `app_*_row()` helpers (`0003`, `0008`, `0010`, `0021`, `0025`,
  `0026`, `20260814_021627`) keep RPC results and reads byte-compatible; they are
  deliberately not security definer.
- **Bounds** — a command may be metered. The durable surface is
  `public.rate_bounds` (the catalog) and `public.usage_counters`
  (`(user_id, meter, window_start)`), `20260817_011844_per_user_rate_bounds.sql`.
  The charge is `hq_charge_rate_bound(user, meter)` called explicitly from inside
  the RPC — not a trigger, because a trigger fires per ROW (a bulk gesture writing
  40 rows would pay 40) and cannot meter work that happens outside the database at
  all. **The one ordering rule: the charge sits strictly BELOW every replay check
  and strictly ABOVE the write.** A bound at the route, or at RPC entry above
  `hq_command_replay`, makes a retried gesture pay twice for work performed once,
  which the emailed-link lane does by design. If a command re-checks the replay
  under a row lock (the `0003`/`0026` double-check shape), the charge moves below
  that check too. **#256 puts the entitlement denial inside that replay check**, so
  it is above the charge as well: a non-entitled caller — replay or first call — is
  refused before any unit is spent and before any row is written. Nothing in the
  replay family is metered today, so the property is held structurally
  (`tests/db/test_default_deny.py::test_the_replay_denial_sits_above_the_charge_and_the_write`,
  derived from `pg_proc.prosrc`) and executed against a metered command built for
  the purpose in `test_the_replay_denial_and_the_rate_charge_compose`, which also
  builds the mistake: the same retry that costs one unit with the charge below the
  replay costs two with it above. **A transaction charging more than one meter must charge them in
  ascending `meter` order** — the increment holds a row lock to commit, and two
  meters charged in opposite orders deadlock (measured: 17 of 20 with `40P01`).
  Nothing does that today; the rule is written before the second meter exists
  because afterwards it is an intermittent production `40P01`. Nothing leases a
  slot either: concurrency is live in-flight state or
  `pg_advisory_xact_lock`, both of which release on the replay-return path as well
  as on commit, so there is nothing to leak. The charge is in the write's
  transaction, so a raise anywhere below it un-charges — including the raise that
  trips the bound, which is why `units` rests at the bound rather than climbing
  while refused. Over the bound raises SQLSTATE `HQBND` with the meter in `DETAIL`
  and the retry horizon in `HINT`; `supabase-source.ts` matches the code, never the
  message, and the route answers 429. **Not every metered path is a command:**
  quick-add's resolve (a server action) reads pages and `/api/export` (a route)
  rebuilds a whole file, both writing nothing — so the app-side seam is
  `DataSource.chargeRateBound(meter)` → `app_charge_rate_bound`, which is what
  lets the mechanism reach server actions and route handlers as well as RPCs. The
  fixture twin always allows and says why (no network, no vendor, no shared
  capacity — `lib/quickadd/rate.ts`'s asymmetry, generalised).

## Hardening around the pattern

- `0004_audit_hardening.sql` revokes TRUNCATE, TRIGGER, and REFERENCES from browser
  roles schema-wide, including default privileges.
- `20260802_205716_anon_select_revoke.sql` revokes SELECT from `anon` schema-wide.
- The entitlement pair (`docs/specs/user-entitlement.md`) closes both the PostgREST
  surface and the inside of security-definer RPCs.

## Invariants

- No browser DML, no browser-chosen owner: ownership is `auth.uid()` inside the RPC.
- One command, one logical effect, one audit event, one durable result. A replayed key
  must return the first result, never apply twice — **to the entitled account that stored
  it, and to nobody else.** A durable result is product state; the lookup refuses a
  pending, suspended, removed or unknown caller, and refuses a `p_user` that is not
  `auth.uid()` (#256). **The "and to nobody else" half now holds; "to the entitled
  account" holds only through the ten post-0026 commands.** #288 taught the 29 pre-0026
  lookups to compare the command, so one key no longer reaches a DIFFERENT command's
  stored result through a sibling — the bypass that made #256's fix one call away from
  being no fix. Those 29 still carry no entitlement check of their own, so a suspended
  account replaying its own key against its own pre-0026 command is still answered; that
  closes per function as each adopts `hq_command_replay` (`docs/specs/user-entitlement.md`
  §"The third mechanism").
- Conflicts are surfaced, never silently merged; the server's row wins the screen.
- A bound is charged once per GESTURE, never per retry and never per row. Which
  commands are bounded today is asserted exact in both directions by
  `tests/db/test_rate_bounds.py::test_the_bounded_command_set_is_exact`, derived
  from `pg_proc.prosrc` — that test is what pays for choosing an explicit call
  over a trigger, which could not have been forgotten. The values are
  PLACEHOLDERS pending an owner decision (#261): `rate_bounds.is_placeholder`
  says so per row. The CLASS is not pending and never was open here —
  `bound_class` cannot hold `commercial`, which is the only class founding users
  are exempt from, and ADR-015 Q2 (owner ruling, 2026-08-18) ratified that for
  every bound at once.
- **`command_idempotency` rows are never deleted on a schedule.** A digest email's
  one-click link has no revocation table: the row IS its single-use guarantee, keyed on
  the token's `jti` (`0019_digest_action.sql`, `core/digest_links.py`). Pruning by age
  therefore re-arms every link still sitting in an inbox, silently and with nothing
  erroring — for `undo`, a Saturday re-tap reverses Monday's decision.
  `tests/core/test_idempotency_retention.py` forbids a deletion of this table anywhere
  that can run unattended against production Postgres (issue #265). Two things in the
  shipped tree still read as an invitation and are deliberately left alone, because
  migrations are append-only: 0003's comment at `0003_write_path.sql:45-48`, "Keys are
  only useful while a client might still retry", which 0019 falsified; and
  `command_idempotency_age_idx`, the `created_at` index a retention job would reach for.
  The referential `on delete cascade` from `users` is not a retention path — losing a
  user's keys with the user is correct.
- Offline: writes are refused and nothing is queued (DEC-011), on every surface.
  The one pre-DEC-011 exception — `webapp/lib/outbox.ts`, a localStorage outbox
  for single-posting triage flushed by `webapp/components/pending-work.tsx` —
  was removed by #222; jobs/queue triage now refuses and reverts like everything
  else, and leftover pre-removal localStorage entries are dropped on load
  (`webapp/components/outbox-cleanup.tsx` records why drop beat flush).
- Fail loud: missing identity, malformed input, and unknown state raise; nothing guesses.
