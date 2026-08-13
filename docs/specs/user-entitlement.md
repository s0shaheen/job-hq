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
  open when the entitlement row is unreadable (a decision, not a leftover — §"The
  middleware fail-open decision" below). It redirects a claims-less GET to `/login` and
  passes a claims-less POST through, so a session that expires mid-gesture is answered
  in-band: `{ ok: false, kind: "auth" }` from the server action, 401 from the route
  handler, never a 307 re-issuing the POST at a page (#196). The data choke point
  `getDataSource()` (`webapp/lib/data/get-source.ts`) fails closed: any non-`ok`
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
- **Lifecycle email (#203)** — the `events` rows those operator RPCs write are consumed by
  `POST /api/email/dispatch` (bearer `CRON_SECRET`; `webapp/lib/email/`), which sends the
  activation/suspension notice through Resend at most once per event:
  `public.email_sends` (`20260813_055534_email_sends.sql`) is claimed before any provider
  call and its unique `send_key` (`evt:<events.id>`) is the dedupe, so an RPC replay —
  which writes no second event — sends nothing. `public.email_suppressions` is consulted
  inside the claim. Both tables are server-lane only (browser roles hold nothing) and
  cascade with the account. With no `RESEND_API_KEY`/`EMAIL_SENDER` the send is recorded
  as a named `skipped` row, never dropped silently, and mail failure never costs the
  activation itself (`tests/db/test_email_sends.py`; RUNBOOK § Turning a new signup on).

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

## The middleware fail-open decision (#223)

Decided 2026-08-12, by the #196 implementer, recorded here because #196's acceptance
criteria require the posture to read as chosen: **middleware KEEPS failing open on an
unreadable entitlement row.**

The rationale is layered defense, and it is specific rather than general. Middleware
runs on every request — the holding page, the login page, the RSC payloads one
navigation fans out into — so failing closed there turns any transient Supabase read
blip into a lockout of the very surfaces that exist to explain a lockout: every
signed-in user herded to `/pending`, including the ones the blip has nothing to do
with. That is an outage the product would inflict on itself, and it buys nothing,
because middleware was never the boundary. The deny already holds at every layer that
is:

- `getDataSource()` fails closed on the same `unreadable` signal — the request
  middleware waves through arrives at a throw
  (`webapp/tests/unit/entitlement-boundary.test.ts`);
- `webapp/lib/auth/api-guard.ts` fails closed for the store-less routes, 403;
- the database refuses regardless of what any app layer believes: `hq_is_entitled()`
  answers false on an absent row, and a row the caller's role cannot read denies by
  error rather than by leaking (`tests/db/test_default_deny.py`, the two #223 tests,
  both pinned in `tests/mutants/manifest.toml` —
  `entitlement-absence-becomes-permission`, `entitlement-predicate-security-definer`).

The conditions the decision was granted on, all three delivered by #196: this record;
the real-Postgres proof named above; and the middleware comment citing #223 so the
posture cannot be re-read as an accident. If the #196 independent security review
refutes the rationale, the decision reverses there.

## The denial matrix (#196)

Every identity state against every layer, each cell either a citation or a named
proof. `webapp/tests/unit/` paths are relative to `webapp/`; the middleware column's
behavioural tests are `tests/unit/entitlement-gate.test.ts` and
`tests/unit/auth-gate.test.ts`; the browser-level journeys are
`tests/e2e/entry-path.spec.ts` and `tests/e2e/entry-journey.spec.ts` (holding-page
copy per status via `data-status`).

| State | middleware (routing) | `getDataSource()` | api-guard | database (0027 pair) |
|---|---|---|---|---|
| anonymous | GET → `/login`; a POST passes through to be answered in-band (`auth-gate.test.ts`) | throws (`entitlement-boundary.test.ts`) | 403 (`entitlement-boundary.test.ts`) | `anon` holds SELECT on nothing; no engine hatch for a null uid (`test_default_deny.py`) |
| expired mid-gesture | never a 307 on the POST (`auth-gate.test.ts`); action answers `{ok:false, kind:"auth"}`, routes 401 (`import-upload-route.test.ts`, `entry-path.spec.ts`) | throws — no claims resolve to `NOT_ENTITLED` | 403 | same as anonymous: no `auth.uid()`, no rows, no hatch |
| pending | → `/pending` from every surface (`entitlement-gate.test.ts`; e2e both specs) | throws `pending` | 403 "not active yet" | zero rows on every gated table, every definer RPC refused (`test_default_deny.py` state sweep; `test_entitlement.py` corpus preview) |
| active (control) | reaches every surface | resolves the real source | `null` — request continues | positive controls throughout both db suites |
| suspended | → `/pending`, suspended copy (`entitlement-gate.test.ts`; e2e) | throws `suspended` on the NEXT resolve after `hq_suspend_user` — no sign-out needed (`entitlement-boundary.test.ts`) | 403 "suspended" | state sweep; capture tokens revoked inside `hq_suspend_user` (`test_suspension_revokes_the_capture_tokens_too`) |
| unknown — absent row | → `/pending` ("no row at all", `entitlement-gate.test.ts`) | throws — absence is never permission | 403 | users row present, entitlements row deleted: predicate false, reads 0, writes refused (`test_an_absent_entitlement_row_is_denied…`, mutant-pinned) |
| unknown — unreadable | FAILS OPEN, by decision #223 above | throws — closed on the same signal | 403 | deny-by-error: the invoker-rights predicate raises and every gated query raises with it (`test_an_unreadable_entitlement_row_denies_by_error…`, mutant-pinned) |
| removed — stale session | treated as signed out when the auth server refuses the stale session; a cryptographically-live JWT reads the cascade-deleted row as absent → `/pending`. Either way, never a data surface | throws — the absent-row shape | 403 | `removed` state in the sweep: reads 0, RPCs refused (`test_default_deny.py`) |

## Invariants

- Unknown, pending, suspended, removed, or wrong-owner access defaults to deny
  (CLAUDE.md). The mechanism is the pair above, not reviewer vigilance; the
  cross-check lives in `tests/db/test_default_deny.py`.
- Exactly three entitlement states. New access tiers are new `plan`/`invite_ref` values,
  not new statuses.
- `invited` (founding free-forever) removes commercial quotas and charges only — never
  security, abuse, concurrency, provider, or reliability limits (contract v2 §6).
- Google authentication must not request Gmail mail scopes (CLAUDE.md, contract v2 §2).
  The in-repo half is pinned: exactly one `signInWithOAuth` call site, carrying no
  `scopes` and no `queryParams`, and no Gmail scope URL anywhere in product source
  (`webapp/tests/unit/oauth-scope.test.ts`). The hosted half — the Supabase Google
  provider config and the consent screen it produces — is owner-gated audit evidence
  (FP-ID-009) and is not claimed by the test.
- Suspension revokes machine credentials too (`hq_suspend_user` calls
  `hq_revoke_capture_tokens`), because a suspended user's Apps Script lane must stop
  writing.
- Every entitlement change is an `events` row with `actor='operator'`; signup itself
  writes no event (explicit in `0027`).
