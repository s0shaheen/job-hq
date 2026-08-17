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

Enforcement is a pair applied to every product table — 33 tables today. `0027`'s own
array names 22; each later migration that adds a table attaches its own pair, because a
table created after `0027` inherits nothing (`20260803_105950`'s lesson):
`0028_resume_entitlement.sql` (3), `20260802_094615_autopilot_staging.sql` (3),
`20260803_090223_sweep_state.sql` (1), `20260803_105950_engine_cursors.sql` (1),
`20260803_105951_notification_outbox.sql` (1), `20260813_055534_email_sends.sql` (2 —
`email_sends` and `email_suppressions`, gated even though every browser privilege is
revoked, so a later grant cannot un-gate them by omission). The pair is:

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

## The commercial seam (#210)

Nothing in the pilot blocks on payments. Founding users are free forever, no surface
charges, and `entitlements.plan` is `'free'` for everybody. This section is design, not a
build order: it records the seam so a paid tier is possible later without a rewrite, and
it is inert until ADR-015 names the tiers. The one thing here that is NOT billing, and
does not wait on ADR-015, is §E.

The seam already exists in the store. `plan` (`0027_entitlement.sql`) is `text not null
default 'free'` with deliberately **no CHECK** — the vocabulary belongs to the billing
phase, and a CHECK naming tiers that do not exist yet would be a guess. `invited` is the
free-forever flag. And `hq_is_entitled()` reads **neither of them**: its whole body is
`select exists (… where e.user_id = auth.uid() and e.status = 'active')`. That separation
is the seam, and everything below preserves it.

### A. A plan is not a fourth status

`status` answers *may this account act at all*, and it is the input to the entire
default-deny boundary above. A plan answers *how much*. The two must never meet in
`hq_is_entitled()`.

- The status vocabulary is exactly `pending | active | suspended` and stays closed. The
  CHECK in `0027_entitlement.sql` pins it.
- A paid tier is a `plan` value plus a quota. It is never a new status.
- The two tempting fourth statuses — a not-yet-paid state and a trial state — are both
  **plan facts**, and both are refused as statuses. Putting a billing outcome inside the
  security boundary makes a failed charge indistinguishable from a suspension: the same
  code path, the same holding page, the same refusal, for a person who has done nothing
  wrong and a person the owner turned off deliberately.
- `plan` stays unconstrained until ADR-015 names the tiers. When it does, the tier
  vocabulary becomes real in one of two ways — a `public.plans` table (key plus limit
  columns, so `plan` becomes a foreign key rather than free text), or a `limits jsonb` on
  the entitlement row. **This spec records both and picks neither**; the choice is
  ADR-015's.

**The counter surface is not this spec's to design.** A quota needs a durable per-user
count keyed by meter and window. Today the only counter in the product is derived, not
stored: `app_start_warm_search` counts `warm_searches` rows in the last 24 hours inside
the RPC that needs it. A general surface — `(user_id, meter, window_start)` — is owned by
**#261**, which needs it now for a security/abuse reason and therefore does not wait on
ADR-015. The consequence to hold on to: when a paid tier eventually lands, a plan quota is
a second **meter** on the table #261 builds, not a second table. This spec must not carry
a `usage_counters` DDL of its own.

### B. Where a quota check sits

The access boundary is enforced at two layers because a check that exists at one layer
only is a check the other layer routes around. A quota follows the same rule, with the
layers assigned differently:

- **Inside the command RPC**, in the same transaction as the row being metered. This is
  the enforcement point, and `app_start_warm_search` (`0020_warm_referral.sql`) is the
  shipped shape: an advisory lock per user, then the replay lookup, then the count, then
  the insert — so the inserted row **is** the reservation and the cap cannot race itself.
  The replay lookup sits *above* the count on purpose: a retried gesture returns the first
  result and does not spend a second reservation.
- **Never as a restrictive policy.** The `<table>_entitled` pattern answers a boolean per
  row, which is why it is cheap enough to AND onto every read of 33 tables. A quota is a
  count over a window. Writing `<table>_quota` that way puts a correlated aggregate
  subquery on every row of every read of the table — including reads that meter nothing.
  The guard trigger stays the boolean; the RPC carries the count.
- **The refusal shape already exists and is reused, not reinvented.** A custom SQLSTATE,
  raised in the RPC, matched on `error.code` and never on message text, turned into a 429
  at the route: `WARM_CAP_SQLSTATE` = `HQCAP` (`webapp/lib/warm/config.ts`) →
  `webapp/lib/warm/handler.ts`. PostgREST carries the SQLSTATE through as `error.code`.

### C. What an entitlement row would need to carry

Each of these is additive to `public.entitlements`, and — this is the property that makes
the seam a seam — **`hq_is_entitled()` reads none of them.** No column below ever reaches
that predicate. One that did would turn an unpaid invoice into a security event.

| Would-be column | Why it is needed | Read by the access predicate? |
|---|---|---|
| plan effective period (`plan_since`, `plan_until` / `current_period_end`) | Without it, "downgrade at period end" is inexpressible and a cancellation becomes an immediate revoke | No |
| provider customer reference | Opaque, server-only. `0027`'s header already anticipates it by name | No |
| plan **source** | The way `invite_ref` records what proved the invite: a plan set by a webhook and a plan set by the owner must be distinguishable in `events` six months later | No |
| not-yet-paid / grace, **as a plan-side field** | Explicitly not a `status` value — see §A | No |

None of these exists today, and this spec adds none of them. Adding a column belongs to
whoever decides the tier.

### D. The founding exemption's shape

`invited` stays the flag. `webapp/app/(app)/settings/plan/page.tsx` already reads it, and
`hq_pending_users` already selects it into the operator's list. Three properties have to
hold for the promise to survive a paid tier arriving above it:

1. **`invited` is read only at a quota check, never at an access check.** `invited = true`
   means the commercial count is skipped and nothing else. Today the accurate claim is
   that `invited` is *read*, never *gated on*: nothing in the database branches on it. The
   signup trigger **writes** it (`0027_entitlement.sql:277-284`) and `hq_pending_users`
   **selects** it (`0027_entitlement.sql:481`), so a grep for the column returns hits and
   none of them is a decision. If `invited` ever reaches `hq_is_entitled()`, the
   free-forever promise and the deny boundary become the same code and neither can be
   changed without the other.
2. **Setting it becomes an audited operator RPC** that writes an `events` row with
   `actor='operator'`, the way `hq_activate_user` already does. No such path exists today
   (contradiction 2 below).
3. **Removing it is a separate, separately-confirmed function**, per contract v2 §6. No
   such path exists today (contradiction 3 below).

The exemption covers **commercial quotas and charges only**. The security, abuse,
concurrency, provider-rate and reliability limits it is *not* exempt from are §E's, and
they belong to **#261** — this spec names them and points there rather than designing
them.

### E. The limits founding users are NOT exempt from

Contract v2 §6 and CLAUDE.md agree: "uncapped" removes commercial quotas and charges, and
does not remove security, abuse, concurrency, provider-rate, reliability, or
infrastructure-safety limits. Measured against the repo rather than reasoned:

| Limit class | What exists today |
|---|---|
| Per-user request rate | One gate, one gesture. `ResolveRateGate` (`webapp/lib/quickadd/rate.ts`) — 60 calls per user per 10-minute fixed window, **in memory, per server instance**, so two serverless instances allow 2×. It is a module-level singleton in `webapp/lib/data/supabase-source.ts` checked inside `resolveJobLinks()`, reached from one server action (`webapp/app/(app)/add/actions.ts`). Its own comment: "an abuse damper, not billing-grade accounting". Every `app_*` command RPC, `/api/import/upload`, `/api/warm/start`, `/api/connections/upload`, `/api/companies/propose` and the capture-token lane carry a payload bound and **no** rate bound; `/api/export` carries neither — it regenerates the caller's whole CSV on every request, as often as it is asked. |
| Per-user concurrency | Nothing. Every `concurren` hit across `webapp/**` and `db/migrations/**` is optimistic concurrency (an `updated_at` CAS token) or an advisory lock serialising one race — neither is an in-flight bound. `warm_searches` has a daily cap and no "one at a time". |
| Provider spend | `warmDailyCap()` only (`webapp/lib/warm/config.ts`, `HQ_WARM_DAILY_CAP`, default 20, clamped 1..1000 in the RPC) — and its classification is undecided; see contradiction 4. |
| Reliability / infrastructure | `HQ_WARM_DAILY_CAP` and the payload bounds below. That is the set. |

Payload bounds are **not** quotas and must not be counted as ones. They bound one call;
they do not bound a person: `MAX_UPLOAD_BYTES` (10 MB) and `MAX_ROWS` (5,000) in
`webapp/lib/import/bytes.ts`, `MAX_INFLATED_BYTES` (64 MB) in `webapp/lib/import/read.ts`,
`WARM_MAX_START_BYTES` (4,096) in `webapp/lib/warm/config.ts`, and the per-call chunk
raises at SQLSTATE `22023` in `0006_bulk_triage.sql`, `0008_company_review.sql` (two),
`0011_import.sql`, and `0013_referral.sql`.

The finding, stated plainly: **an active account can drive every `app_*` command RPC as
fast as PostgREST answers.** That is a pre-revenue gap, it is not billing, and it must not
wait on ADR-015. It is **#261**, at its own tier.

### Contradictions between the contract and the store

Recorded rather than resolved. Two of them are owner decisions and are in ADR-015
(`docs/pilot-launch/07-decisions-assumptions-risks.md` §2.2).

1. **`founding_free` does not exist.** Contract v2 §6 says the owner "explicitly assigns
   `founding_free` to each invited first-user account". The string appears in
   `09-full-product-contract-v2.md`, `13-full-product-roadmap.md` and
   `packets/09-commercial-notifications-exit.md`, and **nowhere** in `db/` or `webapp/`.
   The shipped column is `entitlements.invited`. They are the same thing; both names are
   written here so the next reader does not go looking for a column that is not there.
2. **Nothing assigns it through an audited activation command.** `invited` is set by the
   signup trigger `public.handle_new_auth_user()` from `public.allowed_emails`, and
   `hq_activate_user` does not touch it at all — it writes `status`, `activated_at`,
   `suspended_at`, `reason`. Two consequences. First, signup writes **no `events` row at
   all** — `0027` says so explicitly and gives its reason — so the assignment is
   unaudited, which is the half of §6 that is genuinely unmet. Second, an owner activating
   a pending, non-allowlisted account gets `invited = false` and has **no audited path to
   change it**; direct DML is the only route. (A narrower reading than the issue's is the
   correct one: `allowed_emails` is operator-written, so the assignment is *not* inferred
   from signup date, email domain, or client input, which are the three sources §6 names.
   The defect is the missing audit and the missing set path, not client inference.)
3. **Nothing removes it.** §6 requires a separately confirmed, audited removal action.
   `invited` is written in exactly two places in the whole schema — the signup trigger and
   `0027`'s backfill — and neither is a removal. No such function exists.
4. **The warm daily cap applies to founding users unconditionally, and its class is
   undecided.** `webapp/lib/warm/config.ts` documents it as a cap "on SPEND" (a
   provider-spend limit, which §6 permits). Contract §6 promises founding users "no
   company, job, **search**, referral-result, resume, or submission quota", and FP-REF-003
   (`15-full-product-requirements-register.md`) requires the 40-result target "without a
   founding-user quota". `app_start_warm_search` takes `p_daily_cap` from the app and
   branches on nothing else — not `invited`, not `plan`. Sharper than the issue recorded
   it: the shipped UI makes the promise in so many words — the founding line on
   `/settings/plan` reads "Free forever, with no usage limits on the product itself." One
   number, two readings, and a user-visible sentence on the wrong side of one of them.
   **Owner decision, ADR-015. This spec does not decide it.**
5. **Contract §3 overstates the shipped plan surface.** It rates "Plan and billing
   surfaces" as `Complete, dormant charging` with a "real plan/usage model and Stripe
   test-mode hosted integration". Shipped is `webapp/app/(app)/settings/plan/page.tsx`,
   which renders the `plan` label and one founding line, and charges nothing. This is a
   known and deliberate gap — RM-70 unbuilt, ADD-006 undesigned — but the capability
   matrix does not say so.

## Invariants

- Unknown, pending, suspended, removed, or wrong-owner access defaults to deny
  (CLAUDE.md). The mechanism is the pair above, not reviewer vigilance; the
  cross-check lives in `tests/db/test_default_deny.py`.
- Exactly three entitlement states. New access tiers are new `plan`/`invite_ref` values,
  not new statuses.
- `hq_is_entitled()` reads `status` and nothing else. No plan, quota, period, provider
  reference, or billing column may ever reach it, and `invited` may not either — the
  commercial seam and the deny boundary stay separate code (§"The commercial seam").
- `invited` (founding free-forever) removes commercial quotas and charges only — never
  security, abuse, concurrency, provider, or reliability limits (contract v2 §6). It is
  read at quota checks; nothing in the database gates on it today.
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
