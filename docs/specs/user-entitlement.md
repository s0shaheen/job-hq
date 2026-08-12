# user-entitlement

Identity, activation states, and default-deny ownership. This spec is the current truth;
the identity-state table and commercial promise live in
`docs/pilot-launch/09-full-product-contract-v2.md` §2 and §6.

## What it is

A user is a row in `public.users` mapped 1:1 from the auth provider's `auth.users` row.
Entitlement is a separate row in `public.entitlements` that says whether that identity may
use the product at all. The two are distinct on purpose: signup is open, product access
is not. Ownership of every other row in the schema is derived from `auth.uid()` at the
database boundary — no client-selected `user_id` is ever authoritative.

## Where it is stored

- `public.users` — `db/migrations/0001_init.sql`: `id` (FK to `auth.users`), unique
  `email`, `name`, `is_operator`.
- `public.allowed_emails` — `0001_init.sql`: the invite allowlist. RLS enabled with no
  policy at all, so nothing reads it from the browser.
- `public.entitlements` — `db/migrations/0027_entitlement.sql`: `status` in exactly
  `pending | active | suspended` (default `pending` — a row arriving without an explicit
  status is not entitled), `invited` (the founding free-forever flag), `invite_ref`,
  `plan` (deliberately no CHECK; the billing seam), `activated_at` (stamped once, never
  restamped on re-activation), `suspended_at`, `reason`.

## Who reads and writes it

- **Signup** — trigger `on_auth_user_created` runs `public.handle_new_auth_user()`
  (replaced in `0027_entitlement.sql`): creates the `users` row, then an `entitlements`
  row that is `active`/`invited` when the email is on `allowed_emails`, else `pending`.
  Inserts are `on conflict do nothing`, never `do update` — a replay must not downgrade.
  It refuses to merge identities when another `users` row already holds the email.
- **Browser** — may read only its own rows: `users_self_read`, `entitlements_self_read`.
  It cannot write either table (all DML revoked in `0001`/`0027`). Identity in the webapp
  comes from JWT claims (`supabase.auth.getClaims()` in `webapp/lib/data/get-source.ts`),
  never from a client-supplied id. The entitlement read lives in
  `webapp/lib/auth/entitlement.ts` (`readEntitlement`, `NOT_ENTITLED` — absence is never
  permission).
- **Webapp gates, layered** — the middleware (`webapp/lib/supabase/middleware.ts`)
  redirects a non-active session to `/pending` and, being a redirect surface only, fails
  open when the entitlement row is unreadable (documented in the file). The data choke
  point `getDataSource()` (`webapp/lib/data/get-source.ts`) fails closed: any non-`ok`
  read or non-active status throws `NotEntitledError`, which the `(app)` layout turns
  into a `/pending` redirect and `webapp/lib/auth/api-guard.ts` turns into a 403.
  `webapp/tests/unit/entitlement-default-deny.test.ts` requires every `app/api/**`
  handler to reach one of those gates. The holding page is `webapp/app/pending/page.tsx`,
  deliberately outside the `(app)` group.
- **Operator** — three functions in `0027_entitlement.sql`, executable by `service_role`
  only and deliberately not security definer: `hq_activate_user` (idempotent; writes an
  `entitlement.activated` event), `hq_suspend_user` (stamps `suspended`, writes an event,
  and revokes the user's capture tokens so suspension reaches lanes with no browser
  session), `hq_pending_users`. Founding-user status is assigned by this audited
  activation path, never inferred from signup date or client input (contract v2 §6).

## The default-deny mechanism

`public.hq_is_entitled()` (`0027_entitlement.sql`) is the single predicate: no arguments
(an argument would let a caller name someone else), `stable`, not security definer,
true only for `auth.uid()` with an `active` entitlement row. Absence of a row is never
permission. It is granted to `anon` so policies calling it return zero rows instead of
erroring.

Enforcement is a pair applied to every product table (22 tables in `0027`'s array;
`0028_resume_entitlement.sql`, `20260802_094615_autopilot_staging.sql`,
`20260803_090223_sweep_state.sql`, `20260803_105950_engine_cursors.sql`, and
`20260803_105951_notification_outbox.sql` each attach their own):

1. a **restrictive** policy `<table>_entitled`, ANDed with every permissive policy,
   closing the direct PostgREST surface; and
2. a BEFORE-row trigger `<table>_entitlement_guard` running
   `public.hq_entitlement_guard()`, which is the only check that reaches inside
   security-definer RPCs. It also enforces generic ownership: any row with a `user_id`
   column must carry `auth.uid()`. Sessions with no `auth.uid()` pass only as
   `service_role` (the engine hatch); an anonymous browser session is refused with
   `42501`.

Three tables are deliberately outside the gate (`0027_entitlement.sql`): `users` (the
holding surface must be able to name a pending user), `allowed_emails` (no policy at
all), and `entitlements` itself (gating it on `hq_is_entitled()` would recurse).

The storage bucket takes the same predicate inline in each policy instead of a
restrictive policy, because `storage.objects` is shared across buckets
(`20260802_084857_resume_storage.sql`).

## Invariants

- Unknown, pending, suspended, removed, or wrong-owner access defaults to deny
  (CLAUDE.md). The mechanism is the pair above, not reviewer vigilance; the
  cross-check lives in `tests/db/test_default_deny.py`.
- Exactly three entitlement states. New access tiers are new `plan`/`invite_ref` values,
  not new statuses.
- `invited` (founding free-forever) removes commercial quotas and charges only — never
  security, abuse, concurrency, provider, or reliability limits (contract v2 §6).
- Google authentication must not request Gmail mail scopes (CLAUDE.md, contract v2 §2).
- Suspension revokes machine credentials too (`hq_suspend_user` calls
  `hq_revoke_capture_tokens`), because a suspended user's Apps Script lane must stop
  writing.
- Every entitlement change is an `events` row with `actor='operator'`; signup itself
  writes no event (explicit in `0027`).
