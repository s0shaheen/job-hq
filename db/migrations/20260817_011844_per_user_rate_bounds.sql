-- 20260817_011844_per_user_rate_bounds.sql
--
-- WHAT THIS CHANGES and WHY. Migrations are append-only: this file will run
-- exactly once against production and can never be edited afterwards.
--
-- #261: there are no per-user rate or concurrency bounds on the command RPCs.
-- Any ACTIVE account can drive every `app_*` RPC as fast as PostgREST answers.
-- What exists today is exactly two things:
--
--   * one per-user DAILY CAP, inside `app_start_warm_search` (0020), DERIVED by
--     counting `warm_searches` rows in the last 24 hours — so anything that
--     removes those rows returns the budget;
--   * one IN-MEMORY, PER-INSTANCE gate on one route (`ResolveRateGate`,
--     webapp/lib/quickadd/rate.ts) — two Vercel instances is two times the bound,
--     and its own comment says it is "an abuse damper, not billing-grade
--     accounting".
--
-- CLAUDE.md: founding users are exempt from COMMERCIAL quotas, "not from
-- security, abuse, concurrency, provider, or reliability limits". Those limits
-- did not exist. This file builds the surface they sit on.
--
-- #210 §A defers a general per-user counter keyed `(user_id, meter,
-- window_start)` to whenever a paid tier is decided, and says in the same
-- breath that **#261 needs it now and owns it**. This is that surface. When a
-- plan quota eventually arrives it is a second METER on this table, not a
-- second table.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE SEVEN DECISIONS, each with the reason, because a bound whose shape is not
-- written down is a bound the next person re-derives differently.
--
-- 1. COUNTER HOME: a new table, not a count of existing per-gesture rows.
--
--    The shipped daily cap counts `warm_searches` (`0020_warm_referral.sql`
--    :353-356). That works for exactly one command and breaks for the general
--    case, three ways:
--
--      a. MOST COMMANDS HAVE NO PER-GESTURE ROW. Of the 42 `app_*` commands the
--         web app calls, six insert one domain row per invocation
--         (`app_start_warm_search`, `app_add_note`, `app_import_create`,
--         `app_save_resume_version`, `app_record_resume_artifact`,
--         `app_retry_autopilot_stage`). The rest UPDATE, upsert with `on
--         conflict … do nothing`, or DELETE — `app_set_triage`,
--         `app_set_status`, `app_commit_profile`, `app_upsert_answer`,
--         `app_save_resume_document`, `app_add_job`, `app_pin_warm_intro`,
--         `app_stage_autopilot_application` and the rest of them. There is no
--         row to count, and `command_idempotency` (which does get one row per
--         gesture) is the replay ledger — overloading it as the meter would tie
--         the retention of one to the other.
--      b. A DERIVED COUNT IS RETURNED BY ANYTHING THAT REMOVES THE ROWS. #209
--         adds recurring retention purge lanes over exactly this class of table;
--         a purge of old `warm_searches` hands the account its budget back, and
--         nothing in the purge is wrong. A counter that is its own fact cannot
--         be reset by deleting somebody else's history.
--      c. IT IS PER-COMMAND WORK. Forty-two bespoke count queries is
--         forty-two chances to scope one of them wrong.
--
--    The existing daily cap STAYS as it is. It is not re-plumbed here: its
--    classification (spend vs commercial quota) is the open owner question
--    #210 records, and moving it would decide that question by implementation.
--
-- 2. WINDOW SHAPE: fixed bucket, floored on the DATABASE's `now()`.
--
--    `window_start = to_timestamp(floor(extract(epoch from now()) / w) * w)`.
--
--    Fixed bucket rather than sliding, because a sliding window needs the
--    per-event rows back — which is decision 1's problem again — while a bucket
--    is ONE row per (user, meter, window) and an `insert … on conflict do update
--    set units = units + 1 returning units` is an atomic increment-and-read.
--
--    THE CLOCK IS `now()`, EVALUATED INSIDE THE TRANSACTION THAT CHARGES.
--    `now()` is `transaction_timestamp()`: it comes from the database, it is
--    stable for the whole transaction (so two statements in one charge cannot
--    straddle a boundary), and no caller supplies it. There is no parameter
--    anywhere in this file that accepts an instant, and there is no local-time
--    arithmetic — the bucket is computed from a UTC epoch. A client whose clock
--    is a year off gets exactly the same bucket as everyone else.
--
--    THE HONEST COSTS, both of them:
--      * BOUNDARY BURST. A fixed bucket admits up to 2×max across a boundary
--        (max at the end of one window, max at the start of the next). That is
--        the price of not keeping per-event rows, and for an abuse damper it is
--        the right trade: the thing being prevented is a runaway loop and a
--        vendor bill, not a precisely metered quota.
--      * A RESTORE MOVES THE COUNTS BACK, NOT THE WINDOW. `window_start` is
--        stored, so a dump restored later cannot make an old window current;
--        what a restore does return is the `units` recorded at dump time. That
--        is a real gap and it is bounded: a restore is an owner-supervised
--        operator event (`tracker/pgdump.py`, #209's restore drill), not
--        something a user can cause, and the longest bound here is measured in
--        minutes. The important difference from the derived count is that
--        NO ROUTINE OPERATION RETURNS THE BUDGET: this table is not on any
--        retention purge lane, and the constraint any future purge must respect
--        is written next to the table below.
--
-- 3. ENFORCEMENT SITE: a shared SQL helper, CALLED EXPLICITLY inside the RPC.
--
--    Three candidates, and the two rejected ones are rejected for concrete
--    reasons rather than taste:
--
--      * IN NODE MEMORY (today's `ResolveRateGate`). Rejected as the enforcement
--        point for a COMMAND: the browser holds the anon key and can POST
--        straight to `/rest/v1/rpc/app_*` without the app being involved at all,
--        so a bound that lives in Node bounds only the callers who choose to use
--        the app. It is also per-instance, which is the second AC's whole point.
--        (For the record, since #261's text says otherwise: `ResolveRateGate` is
--        a module-level singleton inside `webapp/lib/data/supabase-source.ts`,
--        consulted in `resolveJobLinks()`, and the only thing that reaches it is
--        ONE SERVER ACTION — `webapp/app/(app)/add/actions.ts`. No API route
--        touches it. So the per-instance blindness is on a server-action path.)
--        It survives here as a pre-filter in front of the durable bound, which
--        is what it is actually good at.
--
--        WHAT NODE STILL HAS TO ENFORCE, and this is the limit of "inside the
--        RPC": some expensive user-driven work IS NOT A COMMAND. Quick-add's
--        resolve reads pages and writes nothing; `/api/export` regenerates a
--        whole file and writes nothing. Neither has an RPC to charge inside, and
--        for both the capability lives ONLY in the Node process, so Node is not
--        a bypassable place to enforce it — it is the only place. That is what
--        `app_charge_rate_bound` below is for, and it is why the mechanism
--        reaches route handlers and server actions as well as RPCs.
--      * A TRIGGER — on the written table, or on `command_idempotency` (which
--        gets exactly one row per new gesture and none on a replay, so a trigger
--        there would be retry-correct by construction). Genuinely tempting, and
--        it has the one advantage this design lacks: it CANNOT BE FORGOTTEN.
--        Rejected anyway, because (a) it fires per ROW, so one bulk triage
--        gesture writing 40 rows charges 40 units — the "bound that locks a
--        legitimate bulk gesture mid-flight" failure, arriving through the
--        mechanism meant to prevent it; (b) `command_idempotency` is written at
--        the END of the command body, so a trigger there refuses AFTER the work
--        is done, which is the opposite of the reservation property that makes
--        the shipped warm cap correct; (c) it cannot charge a meter for work
--        that happens OUTSIDE the database at all — the vendor run and the
--        outbound page reads, which are the expensive things; (d) it puts the
--        bound somewhere the reviewer of the RPC does not meet it.
--      * A SHARED HELPER CALLED FROM THE RPC — chosen. One implementation, one
--        SQLSTATE, one window shape, one clock, and the call site is a position
--        the author must choose deliberately, which is exactly what decision 4
--        is about. Its cost is the trigger's advantage inverted: a new RPC that
--        forgets to charge is unbounded. That is paid for by
--        `tests/db/test_rate_bounds.py::test_the_bounded_command_set_is_exact`,
--        which derives the charging set from `pg_proc.prosrc` and asserts it in
--        BOTH directions, so a command joining or leaving the set has to say so.
--
-- 4. RETRY INTERACTION — THE LOAD-BEARING ONE.
--
--    A replayed command MUST NOT consume a second unit. The shipped ordering is
--    already correct and this file must not break it:
--
--      `0020_warm_referral.sql:346-351` — the inline replay lookup sits ABOVE
--      the cap count at `:353-356`.
--      `0026_resume.sql:919` — `hq_command_replay` sits above the write, and
--      again under the row lock at `:946`.
--
--    THE ORDERING AN IMPLEMENTER MUST PRESERVE, in full:
--
--      1  auth.uid() is null                          → 28000
--      2  cheap argument validation                   → 22023
--      3  pg_advisory_xact_lock(user)                 (serialize this user)
--      4  the LAST replay check → if it returns, RETURN
--      5  hq_charge_rate_bound(...)                   → HQBND
--      6  the guarded write + events + command_idempotency
--
--    Stated as one rule: **the charge sits strictly BELOW every replay check and
--    strictly ABOVE the write.** A command that re-checks the replay after
--    taking a row lock (the 0003/0026 double-check shape) moves the charge below
--    THAT check too — a charge above it commits on a path that returns a stored
--    result, which is a double-consume with extra steps.
--
--    THE MIRROR FAILURE — a concurrency slot taken before the replay check and
--    released only on the write path — is closed STRUCTURALLY rather than by
--    discipline: **nothing here leases a slot.** Concurrency is expressed as
--    live in-flight state (`warm_searches.status = 'running'`, decision 6) and
--    as `pg_advisory_xact_lock`, whose release is the end of the transaction and
--    therefore happens on the replay-return path, the raise path and the commit
--    path alike. There is no counter to decrement, so there is nothing to leak.
--
--    AND THE LOCK ORDER, for whoever charges TWO meters in one transaction.
--    Nothing does today — every charging function has one call site, and
--    `app_charge_rate_bound` charges one meter per request — but this file's own
--    roadmap invites it ("a plan quota arriving later is a second METER on this
--    table"), and the increment takes a row lock held to commit. So: **a
--    transaction charging more than one meter must charge them in ascending
--    `meter` order.** Measured by review: 20 transactions charging two meters in
--    opposite orders deadlocked 17 of 20 with 40P01. One sentence, written before
--    the second meter exists, because afterwards it is an intermittent 40P01 in
--    production that reads like anything else.
--
--    And because the charge is in the same transaction as the write, a command
--    that raises anywhere below it rolls the charge back: nobody pays for work
--    that did not happen. That includes the refusal itself — the increment that
--    trips the bound is rolled back by its own raise, so `units` rests AT the
--    bound and a refused call never extends the window. That is
--    `webapp/lib/quickadd/rate.ts`'s stated rule ("a refused call is counted
--    against nothing"), preserved.
--
-- 5. SQLSTATE: a new one, `HQBND`. Not `HQCAP`.
--
--    `HQCAP` is taken and it MEANS something specific: `supabase-source.ts`
--    turns it into `{kind: "over-cap"}` and renders `warmOverCapMessage(cap)` —
--    "You have used your N warm searches for today. The count resets 24 hours
--    after each search." Raising that from a rate bound would render a sentence
--    that is false about both the reason and the reset. Worse, it would fuse the
--    one refusal whose CLASS is still an open owner question (#210: is the warm
--    daily cap spend or a commercial quota?) with refusals whose class is not in
--    doubt. Two classes, two codes.
--
--    `HQBND` carries the meter in DETAIL and the retry horizon in HINT, so the
--    app matches on `error.code` and never on message text.
--
-- 6. WHAT IS BOUNDED NOW, WHAT WAITS, WHAT NEVER IS — see `public.rate_bounds`
--    below, which is the machine-readable half of this decision.
--
-- 7. CASCADE ON DELETE: yes. `user_id … on delete cascade`.
--
--    #209's ledger reasoning cuts the other way for a survivor that PROVES
--    something. This one proves nothing after the fact: `(user_id, meter,
--    window_start, units)` is behavioural telemetry about a person's activity,
--    which is PII-adjacent, and `tests/db/test_deletion_cascade.py` holds the
--    schema to exactly two documented survivors. A third survivor class is an
--    owner ruling (`docs/pilot-launch/21-deletion-owner-rulings.md`), not an
--    implementer's call.
--
--    THE TRADE, STATED: a cascading counter means a deleted-and-recreated
--    account gets a fresh budget. That is priced at this product's boundary and
--    it is expensive: account creation is gated by `allowed_emails` plus an
--    owner activation (`hq_activate_user`), so "delete and re-create" costs an
--    owner action — while the alternative, simply waiting, costs at most the
--    longest window here, which is minutes. THE DAY THAT STOPS BEING TRUE — the
--    first time a meter's window is long enough that deletion is cheaper than
--    waiting (a monthly or lifetime quota) — that meter must move to a
--    non-cascading ledger, and that is an owner decision. The window bound in
--    `rate_bounds_window_is_short` below is what makes the day arrive loudly.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE NUMBERS ARE PLACEHOLDERS AND THE SCHEMA SAYS SO.
--
-- #261 routes the VALUES to an owner question that must be answered alongside
-- #210's undecided warm-cap classification, because the CLASS decides the code
-- and the value only decides the threshold. Every row seeded below carries
-- `is_placeholder = true`, and `tests/db/test_rate_bounds.py` asserts that every
-- shipped row still does — so the flag cannot rot into a lie. Changing a number
-- is one UPDATE by the operator, with no migration and no deploy:
--
--   update public.rate_bounds
--      set max_units = 240, is_placeholder = false, note = 'owner, 2026-08-20'
--    where meter = 'quickadd.resolve';
--
-- The app may make a bound STRICTER through `p_max` (env, see
-- `webapp/lib/limits/bounds.ts`) and can never make one looser: the clamp is
-- `least(coalesce(p_max, max_units), max_units)`. That asymmetry is deliberate
-- and it is decision 3's reason again — the browser can call these RPCs without
-- the app, so a limit the caller supplies is a limit the caller chooses.
-- ════════════════════════════════════════════════════════════════════════════

-- ============================================================ the bound catalog

create table public.rate_bounds (
  -- `<surface>.<gesture>`, and it is the vocabulary: `usage_counters.meter`
  -- references it, so a caller cannot mint a meter and grow that table with
  -- rows nothing will ever read.
  meter text primary key,

  -- THE CLASS, and the CHECK is the enforcement of a CLAUDE.md sentence rather
  -- than a description of it. Founding users are exempt from COMMERCIAL quotas
  -- and from nothing else, so `commercial` is not a value this table can hold.
  -- A commercial quota arriving later is a different mechanism reading
  -- `entitlements.invited`; this one never reads it, and a test asserts that
  -- `hq_charge_rate_bound`'s body does not mention it.
  --
  --   security   — abuse and misuse. A free proxy, a scanner, a runaway client.
  --   provider   — somebody else's bill. Vendor spend, per-request pricing.
  --   reliability— our own capacity. Concurrency, in-flight work, queue depth.
  bound_class text not null
    check (bound_class in ('security', 'provider', 'reliability')),

  max_units integer not null check (max_units > 0),

  window_seconds integer not null,

  -- THE WINDOW IS SHORT ON PURPOSE, and this constraint is decision 7's
  -- tripwire. A cascading counter is safe precisely while waiting out a window
  -- is cheaper than deleting an account, and one day is the outer edge of that
  -- argument. A meter that wants a longer window is a quota, not a damper, and
  -- it needs the owner ruling this constraint forces somebody to go and get.
  constraint rate_bounds_window_is_short
    check (window_seconds between 1 and 86400),

  -- FALSE only when a human has decided the number. Seeded TRUE for every row
  -- in this file, because nobody has.
  is_placeholder boolean not null default true,

  -- DOES THIS METER HAVE A COUNTER AT ALL?
  --
  -- Not every bound is a count over a window. `warm.concurrent` is live
  -- in-flight state — `app_start_warm_search` reads `warm_searches.status`
  -- directly and never touches `usage_counters` — but it still wants a row here
  -- so it has a catalogued class, an operator-changeable limit and one refusal
  -- shape. Without this column that row is a LOADED GUN, and the security
  -- review fired it:
  --
  --   `app_charge_rate_bound` accepts ANY catalogued meter. `warm.concurrent`
  --   is catalogued with `window_seconds = 1`, and the counter's primary key is
  --   `(user_id, meter, window_start)` — so a signed-in account mints one
  --   DURABLE row PER SECOND, on a table with no purge lane. Measured: 5187
  --   calls over 6 seconds produced 7 rows; the ceiling is 86,400 rows per user
  --   per day. And it is free: the counter is INERT for this meter, so burning
  --   it to the bound denies the attacker nothing — verified, an attacker at the
  --   bound could still start 3 of 3 searches.
  --
  -- The FK on `usage_counters.meter` closed the same attack for varying the
  -- METER and missed varying the WINDOW. This closes it: `hq_charge_rate_bound`
  -- raises `22023` for a non-chargeable meter BEFORE any insert, so no row for
  -- it can exist by any path.
  is_chargeable boolean not null default true,

  note text not null default '',

  updated_at timestamptz not null default now()
);

comment on table public.rate_bounds is
  'The per-user bound catalog: one row per meter, carrying its class (security | '
  'provider | reliability — never commercial, which is what founding users are '
  'exempt from), its limit and its window. Operator-writable; no browser role '
  'holds any privilege on it. is_placeholder = true means the number is an '
  'engineering guess awaiting the owner decision #261 routes to #210.';

comment on column public.rate_bounds.bound_class is
  'security | provider | reliability. A founding user is subject to all three; '
  '"commercial" is deliberately not a value this column can hold.';

comment on column public.rate_bounds.is_placeholder is
  'true = nobody has decided this number yet. Asserted true for every seeded row '
  'by tests/db/test_rate_bounds.py, so the flag cannot quietly become a lie.';

comment on column public.rate_bounds.is_chargeable is
  'false = this bound is live state, not a window count, and hq_charge_rate_bound '
  'refuses it with 22023 before any insert. Without it a catalogued 1-second '
  'meter is a browser-reachable way to mint 86,400 durable counter rows a day '
  'for a bound that would not refuse anything.';

-- RETIRING A METER, since the file promises that changing a NUMBER is one
-- UPDATE and is silent about the other direction. `usage_counters.meter`
-- references this table with the default RESTRICT, so a `delete from
-- public.rate_bounds where meter = ...` that still has live counters fails
-- 23503. That is the correct order and not an obstacle:
--
--   delete from public.usage_counters where meter = 'x.y';
--   delete from public.rate_bounds    where meter = 'x.y';
--
-- RESTRICT rather than CASCADE deliberately: a typo'd meter name in a DELETE
-- should fail loudly, not silently take a live account's usage history with it.

create trigger rate_bounds_touch before update on public.rate_bounds
  for each row execute function public.touch_updated_at();

-- ============================================================ RLS on the catalog
--
-- NO BROWSER PATH, read or write. The numbers are not secret, but a browser has
-- no use for them: nothing in the approved design shows a user their bound (the
-- usage surface is ADD-006 and unbuilt), and a table a browser cannot reach is
-- one fewer surface to gate. `test_rate_bounds.py` asserts the zero-privilege
-- property directly, in both directions, and that is the PRIMARY control here —
-- the grant system, `allowed_emails`' answer.
--
-- The entitlement pair is armed anyway, `20260803_105951_notification_outbox.sql`'s
-- reasoning: a table created after 0027 inherits nothing, so a later migration
-- granting `select` for some future surface must not be able to un-gate it by
-- omission. It is also what `tests/db/test_owner_bypass.py` requires of every
-- unforced table — the guard is a TRIGGER, so unlike a policy it binds the owner
-- lane, which is where every `security definer` statement runs.
--
-- WHAT THE PAIR DOES AND DOES NOT DO HERE, stated rather than implied, because
-- this table is the one shape the guard was not written for. `hq_entitlement_guard`
-- has two halves: "is this account entitled" and "does this row belong to it". The
-- first half applies. The SECOND DOES NOT — the guard reads `user_id` off the row
-- and this table has none, because a bound is not owned by anybody, so the
-- ownership check passes vacuously.
--
-- NAMED RATHER THAN LEFT AS "VACUOUS", because the next author needs the case
-- and not the adjective: if some future migration granted a write privilege AND
-- added a permissive write policy, then any ENTITLED account could
-- `update public.rate_bounds set max_units = 999999` — the guard would wave it
-- through, having no owner to check it against. That is two deliberate acts away
-- and nothing today can reach it (zero privileges, no permissive policy, and
-- `test_rate_bounds.py` asserts the zero-privilege property in both directions).
-- A migration that ever grants a write here must add its own ownership or
-- operator check; the guard will not supply one.
--
-- So this is not a gap being papered over: with zero privileges and no
-- permissive policy, RLS already denies every browser statement, and the pair is
-- additive on top of it. Forcing RLS is not the
-- alternative — `test_owner_bypass.py` measured why (the owning role holds
-- BYPASSRLS on Supabase, and a forced table with no permissive write policy denies
-- every definer write the day that stops being true).
alter table public.rate_bounds enable row level security;

revoke all on public.rate_bounds from public, anon, authenticated;

create policy rate_bounds_entitled on public.rate_bounds
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

create trigger rate_bounds_entitlement_guard
  before insert or update or delete on public.rate_bounds
  for each row execute function public.hq_entitlement_guard();

-- ============================================================ the counter

create table public.usage_counters (
  -- CASCADE — decision 7. Behavioural telemetry about a person does not outlive
  -- their account, and `tests/db/test_deletion_cascade.py` is held to exactly
  -- two documented survivors.
  user_id uuid not null references public.users (id) on delete cascade,

  -- FK to the catalog, so the meter vocabulary is structurally closed. Without
  -- it, `app_charge_rate_bound` is a browser-reachable way to insert unbounded
  -- distinct rows into this table by varying one string.
  meter text not null references public.rate_bounds (meter),

  -- The floored bucket. STORED, not derived at read time: it is what makes a
  -- restore unable to move the window (decision 2), and it is what a future
  -- prune keys on.
  window_start timestamptz not null,

  units integer not null default 0 check (units >= 0),

  updated_at timestamptz not null default now(),

  primary key (user_id, meter, window_start)
);

comment on table public.usage_counters is
  'The durable per-user meter, keyed (user_id, meter, window_start) — #210 §A '
  'defers this surface and #261 owns it. One row per user per meter per fixed '
  'window; a plan quota arriving later is a second METER here, not a second table.';

comment on column public.usage_counters.window_start is
  'The fixed bucket, floored on the DATABASE clock inside the charging '
  'transaction. Never supplied by a caller and never computed from local time.';

-- THE PRUNE CONSTRAINT, written here because the lane that would violate it
-- (#209's retention purges) does not exist yet and its author will read the
-- table before the issue.
--
-- Rows for ELAPSED windows are prunable — they are pure counters with no
-- evidentiary value once their window has passed. Rows for the CURRENT window
-- are not: deleting one hands the account its budget back mid-window, which is
-- the exact defect that makes the derived count in `0020` resettable and the
-- reason this table exists. Any purge must therefore be
--
--   delete from public.usage_counters
--    where window_start < now() - interval '1 day'
--
-- — one day being `rate_bounds_window_is_short`'s ceiling, so no live window can
-- be inside the range whatever the catalog says.
create index usage_counters_window_idx on public.usage_counters (window_start);

-- ============================================================ RLS on the counter

alter table public.usage_counters enable row level security;

revoke all on public.usage_counters from public, anon, authenticated;

-- The entitlement pair, `20260803_105951_notification_outbox.sql`'s reasoning
-- verbatim: a table created after 0027 inherits nothing, and with every
-- privilege revoked this one may fall outside `test_default_deny.py`'s
-- browser-reachable sweep — so the gate here is not what that sweep is asking
-- for. It is here so a LATER migration granting `select` for some future usage
-- surface cannot un-gate the table by omission.
--
-- Unlike `rate_bounds` above, this pair is CORRECT here: the rows are owned, so
-- the guard's ownership half has a `user_id` to read and the restrictive policy
-- is ANDed with a permissive one that would have to scope to `auth.uid()`.
-- It also does real work TODAY rather than only later: the charge below runs
-- inside a `security definer`, where RLS does not apply and the trigger is the
-- entire boundary — so a suspended account is refused AT THE CHARGE, before the
-- command it was trying to drive reaches its own write.
create policy usage_counters_read on public.usage_counters
  for select using (user_id = auth.uid());

create policy usage_counters_entitled on public.usage_counters
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

create trigger usage_counters_entitlement_guard
  before insert or update or delete on public.usage_counters
  for each row execute function public.hq_entitlement_guard();

-- ============================================================ the charge

/**
 * Charge one unit against a per-user meter, or refuse with `HQBND`.
 *
 * DELIBERATELY NOT `security definer`, `hq_command_replay`'s reasoning (0026)
 * exactly: it is only ever called from inside functions that already run as the
 * definer, and marking it definer would hand a standalone caller the ability to
 * move another account's counters. It inherits whatever rights it runs under,
 * and every call site below is a definer owned by `postgres`.
 *
 * `p_user` is passed rather than read from `auth.uid()` for the same reason
 * `hq_command_replay` takes one: the caller has already established identity and
 * re-deriving it here would be a second place to get it wrong. It is safe
 * because the function is revoked from every browser role — the only way to
 * reach it is through a definer that has already refused a null identity — and
 * because the `usage_counters` guard trigger independently refuses a row whose
 * `user_id` is not `auth.uid()`. So even a future definer that passed the wrong
 * uuid would be stopped by the store, not by this function's good manners.
 *
 * THE INCREMENT IS THE READ, and that is what makes the bound hold under a
 * burst without an advisory lock of its own. `insert … on conflict do update set
 * units = units + 1 returning units` takes the row lock inside one statement, so
 * N racing charges serialize on the counter row and each sees a distinct value.
 * The check-then-increment version is the defect `test_warm.py`'s concurrent
 * case was written for, in a new place.
 *
 * A REFUSAL COSTS NOTHING. The raise rolls its own increment back, so `units`
 * rests at the bound rather than climbing while refused — refusal never extends
 * the window (webapp/lib/quickadd/rate.ts's rule, kept).
 *
 * NOTHING HERE READS `entitlements.invited`. A founding user is exempt from
 * commercial quotas and from nothing in this table; `rate_bounds.bound_class`
 * cannot even hold the value that would make an exemption meaningful.
 */
create or replace function public.hq_charge_rate_bound(
  p_user  uuid,
  p_meter text,
  p_max   integer default null
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_bound  public.rate_bounds;
  v_window timestamptz;
  v_max    integer;
  v_units  integer;
begin
  if p_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- BOUND THE ARGUMENT BEFORE IT REACHES A MESSAGE. `p_meter` arrives verbatim
  -- from a browser through `app_charge_rate_bound`, and the unknown-meter raise
  -- below echoes it — on a path that is never charged, because the raise sits
  -- ABOVE the increment. So without this an authenticated caller pushes
  -- arbitrary 100 kB strings into the Postgres server log at will, for free and
  -- as often as it likes (measured by review: a 100,000-char `p_meter` produced
  -- a 100,020-char log line). This file already bounds `p_idem` to 200 and
  -- `p_params`/`p_overlays` to 8192 for exactly this reason; the meter was the
  -- one stored-verbatim string that escaped it.
  --
  -- 64 is generous: the longest real meter is `quickadd.resolve`.
  if p_meter is null or length(p_meter) > 64 then
    raise exception 'rate meter must be 1..64 characters' using errcode = '22023';
  end if;

  select * into v_bound from public.rate_bounds where meter = p_meter;
  if not found then
    -- Fail loud. A typo'd meter must not silently mean "unbounded".
    -- `left(...)` is belt-and-braces over the length check above: a message is
    -- the one place a caller-supplied string reaches the server log.
    raise exception 'unknown rate meter: %', left(p_meter, 64)
      using errcode = '22023';
  end if;

  -- A NON-CHARGEABLE METER HAS NO COUNTER, so refuse BEFORE the insert rather
  -- than writing a row nothing will ever read. This is the `warm.concurrent`
  -- attack the column's comment records: catalogued, 1-second window, inert, and
  -- therefore a free-row primitive for any signed-in account until this line.
  --
  -- 22023 and not HQBND, deliberately: HQBND means "you are over a bound" and
  -- would tell a caller it had been refused for using too much. This is a
  -- malformed request — asking to charge something that is not a counter.
  if not v_bound.is_chargeable then
    raise exception 'rate meter % is not chargeable: it is live state, not a counter',
      left(p_meter, 64)
      using errcode = '22023',
            hint = 'this bound is enforced where the state lives, not by charging a unit';
  end if;

  -- STRICTER ONLY. An app-supplied limit may tighten the catalog's number and
  -- can never loosen it — the caller is not trusted with its own bound.
  v_max := greatest(least(coalesce(p_max, v_bound.max_units), v_bound.max_units), 1);

  -- THE DATABASE'S CLOCK, floored on the UTC epoch. `now()` is
  -- transaction_timestamp(), so both references below are the same instant and
  -- a charge cannot straddle a boundary.
  v_window := to_timestamp(
    floor(extract(epoch from now()) / v_bound.window_seconds) * v_bound.window_seconds
  );

  insert into public.usage_counters (user_id, meter, window_start, units)
  values (p_user, p_meter, v_window, 1)
  on conflict (user_id, meter, window_start) do update
     set units = public.usage_counters.units + 1,
         updated_at = now()
  returning units into v_units;

  if v_units > v_max then
    raise exception 'rate bound % exceeded: % of % in this window',
      p_meter, v_units, v_max
      using errcode = 'HQBND',
            detail  = p_meter,
            hint    = 'retry after '
                      || to_char(v_window
                                 + make_interval(secs => v_bound.window_seconds),
                                 'YYYY-MM-DD"T"HH24:MI:SSOF');
  end if;

  return v_units;
end;
$$;

comment on function public.hq_charge_rate_bound(uuid, text, integer) is
  'charge one unit against a per-user meter in the current fixed window and '
  'refuse over the bound with SQLSTATE HQBND (meter in DETAIL, retry horizon in '
  'HINT); the increment IS the read, so it holds under a burst without a lock';

revoke all on function public.hq_charge_rate_bound(uuid, text, integer)
  from public, anon, authenticated;

-- ============================================================ the route charge

/**
 * The same charge, reachable from a signed-in session.
 *
 * WHY THIS EXISTS AT ALL, given decision 3 says the enforcement point is inside
 * the RPC: the two most abusable user-driven paths in the product ARE NOT RPCs.
 * Quick-add's resolve step (`SupabaseDataSource.resolveJobLinks`, reached from
 * ONE SERVER ACTION, `webapp/app/(app)/add/actions.ts`) reads up to `MAX_LINKS`
 * (25) pages on the open internet from our server; `/api/export` regenerates the
 * caller's whole dataset into a CSV or a zip. Both write nothing, so there is no
 * command to hook a charge into — and both capabilities live ONLY in the Node
 * process, which a browser cannot reach through PostgREST at all. So Node is not
 * a bypassable place to enforce these; it is the only place.
 *
 * The seam on the app side is `DataSource.chargeRateBound(meter)`, which is why
 * the mechanism covers server actions and route handlers as well as RPCs, and
 * why the fixture twin has an honest always-allow implementation (no network, no
 * store, nothing to protect).
 *
 * THE ABUSE THIS ACCEPTS, stated so review does not have to find it: any
 * signed-in caller can invoke this directly and burn their OWN budget. That is
 * self-denial and nothing else. `p_meter` is confined to the catalog by the FK
 * and by the lookup above, `user_id` comes from `auth.uid()` and never from an
 * argument, and `p_max` can only make the bound stricter — so there is no
 * reachable state where calling this hurts a different account or raises a
 * bound. Self-denial is not a property this product owes anybody.
 *
 * NOT IDEMPOTENT, and that is correct rather than an omission. Every `p_idem`
 * command in this schema answers a replay from a stored result before it works,
 * so charging one of those twice would be the defect decision 4 exists to
 * prevent. This is not one of those: each call to it precedes real outbound
 * work that genuinely happens again on a retry. A metering call for a
 * non-idempotent capability is charged per call, because that is what it costs.
 */
create or replace function public.app_charge_rate_bound(
  p_meter text,
  p_max   integer default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  return public.hq_charge_rate_bound(v_user, p_meter, p_max);
end;
$$;

comment on function public.app_charge_rate_bound(text, integer) is
  'charge one unit against the calling account''s meter (SQLSTATE HQBND over the '
  'bound) — for user-driven work that happens OUTSIDE the database, where there '
  'is no command RPC to charge inside: quick-add resolve and /api/export';

revoke all on function public.app_charge_rate_bound(text, integer)
  from public, anon, authenticated;
grant execute on function public.app_charge_rate_bound(text, integer)
  to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- DECISION 6 — WHAT IS BOUNDED NOW, WHAT WAITS, AND WHAT NEVER IS.
--
-- NOW, and it is the outbound-fetch and vendor-spend paths first because those
-- are the ones that land on somebody's bill rather than on our CPU:
--
--   quickadd.resolve   security     the only user-driven outbound fetch in the
--                                   product. One call reads up to 25 pages, so
--                                   an unbounded resolver is a free proxy and a
--                                   scanner. Today's bound is per-instance
--                                   memory on a SERVER-ACTION path; this is the
--                                   durable one.
--   warm.start         provider     the only vendor-spend path. ~$0.30 of Apify
--                                   per search (webapp/lib/warm/config.ts). The
--                                   existing daily cap is a DAY's budget and
--                                   says nothing about a burst inside it.
--   warm.concurrent    reliability  #210 §E: "No in-flight bound on warm
--                                   searches, imports, sweeps, or renders." A
--                                   started search holds live vendor runs the
--                                   poll route advances; N at once is N times
--                                   the outstanding work.
--   export.build       reliability  `/api/export` had NEITHER a payload bound
--                                   NOR a rate bound — verified, and contrary to
--                                   #261's own text, which credits it with a
--                                   payload cap. A ~100-byte POST rebuilds the
--                                   caller's whole dataset (999 rows, a zip
--                                   writer for xlsx) as often as asked. It is
--                                   the cheapest amplification in the product,
--                                   so it joins the NOW set even though nothing
--                                   outbound and nothing vendor-billed happens.
--
-- WAITS — named, not built, so the absence is a decision and not an oversight:
--
--   * A GENERAL per-user write rate across all 42 `app_*` commands. Its class
--     is not in doubt (security). It waits on SHAPE, not on the owner: charging
--     it means re-creating 42 function bodies in one migration, which is not a
--     reviewable T3 diff, and the correct UNIT differs per command — a bulk
--     triage fanning out `${idem}:${i}` sub-keys is ONE gesture and 40 writes,
--     and a meter that cannot tell those apart is the "bound that locks a
--     legitimate bulk gesture mid-flight" attack wearing a fix's clothes.
--   * THE IMPORT LANE. `app_import_stage` is called repeatedly per batch, 1000
--     rows a chunk, and `app_import_commit_chunk` likewise. A per-call RATE
--     bound there refuses a legitimate large import halfway through and leaves
--     it half-staged. What that lane wants is a per-BATCH bound — a different
--     shape, on `import_batches`, and its own issue.
--   * RENDER. `app_record_resume_artifact` records a completed render; the
--     render itself is a Python worker behind Postgres. Bounding the record
--     bounds nothing that costs anything. The worker's own lane is where that
--     belongs.
--
-- NEVER — and these are refusals of a bound, not a backlog:
--
--   * `app_set_status`. CLAUDE.md: manual application status is authoritative
--     and nothing automated mutates it. A bound that refuses a status update
--     makes the authoritative record unrecordable, which trades a small abuse
--     margin for the one fact in the product nothing else can supply. It is
--     also composed INSIDE `app_settle_autopilot_handoff`
--     (`20260814_030545_autopilot_handoff.sql`), where a refusal would break an
--     atomic composition.
--   * ANY command reached as an INNER call of a composition. The gesture is
--     charged once, at the outer command, or the composition pays twice for one
--     act — which is decision 4's failure in the composition's clothing.
--   * `app_cancel_warm_search` and `app_fail_warm_search`. These are the paths
--     that STOP vendor spend. A rate-limited user who cannot cancel is a user
--     whose bill keeps running because we bounded them.
--   * The deny path — `hq_is_entitled`, `app_preview_corpus`, the holding
--     surface's reads. A bound on the mechanism that refuses is a denial of
--     service against the refusal.
-- ════════════════════════════════════════════════════════════════════════════

insert into public.rate_bounds
  (meter, bound_class, max_units, window_seconds, is_chargeable, note)
values
  ('quickadd.resolve', 'security', 60, 600, true,
   'PLACEHOLDER. Matched to ResolveRateGate''s shipped 60-per-10-minutes so the '
   'durable bound cannot be looser than the in-memory pre-filter it backs; with '
   'one instance the two agree exactly, and with N instances this one bites '
   'first. Worst case 60 x MAX_LINKS(25) = 1500 outbound reads per window.'),

  ('warm.start', 'provider', 10, 600, true,
   'PLACEHOLDER. A burst bound INSIDE the existing 20/day cap, not a replacement '
   'for it: ~$0.30 of vendor spend per search means ten in ten minutes is $3 and '
   'a runaway client is stopped one order of magnitude before the day''s budget. '
   'The DAILY cap''s classification is the open owner question (#210).'),

  ('warm.concurrent', 'reliability', 3, 1, false,
   'PLACEHOLDER, and NOT A WINDOW COUNTER — is_chargeable = false. This row '
   'exists so the meter has a catalogued class, a limit an operator can change, '
   'and one refusal shape. The count is live in-flight state '
   '(warm_searches.status = ''running''), read directly by app_start_warm_search; '
   'window_seconds is 1 because there is no window. usage_counters therefore '
   'holds no rows for this meter BY CONSTRUCTION rather than by convention — '
   'hq_charge_rate_bound raises 22023 before any insert, which is what stops a '
   'signed-in caller minting one durable row per second against a 1-second '
   'window on a bound that would refuse it nothing.'),

  ('export.build', 'reliability', 30, 600, true,
   'PLACEHOLDER. RELIABILITY rather than security: what an unbounded /api/export '
   'costs is our own function CPU, memory and egress — no third party is billed '
   'and no boundary is crossed — and amplification against our own capacity is '
   'what that class is for. A ~100-byte POST regenerates the caller''s whole '
   'dataset (up to 999 rows, through a zip writer for xlsx) and had NO bound of '
   'any kind before this: no payload cap, no rate. Thirty files in ten minutes '
   'is far past any human export session and far short of a loop.')
on conflict (meter) do nothing;

-- `do nothing`, never `do update`. `db/apply.sh` re-applies every migration on
-- every provisioning run (0027's backfill note), so `do update` here would
-- silently revert an operator's tuned number — and worse, would re-set
-- `is_placeholder` to true on a bound the owner had actually decided.

-- ════════════════════════════════════════════════════════════════════════════
-- WIRING THE FIRST COMMAND: `app_start_warm_search`.
--
-- Re-created verbatim from `0020_warm_referral.sql:291` with exactly three
-- additions and no other change — the signature, the validation, the advisory
-- lock, the replay lookup, the daily cap, the insert, the audit event and the
-- idempotency record are all byte-identical to what shipped.
--
-- The additions, in the order decision 4 requires:
--
--   * `warm.concurrent`, an IN-FLIGHT count, above the rate charge because it is
--     the cheaper refusal and because it is not a counter — a search that ends
--     releases its slot by changing its own status, so there is nothing to
--     decrement and nothing to leak on a replay return;
--   * `warm.start`, the rate charge, BELOW the replay lookup at `:346-351` and
--     ABOVE the daily-cap count at `:353-356`;
--   * nothing else.
--
-- WHY THE CHARGE SITS ABOVE THE DAILY CAP RATHER THAN BELOW: an over-cap request
-- raises `HQCAP`, which rolls the whole transaction back INCLUDING the charge,
-- so ordering cannot make an over-cap refusal cost a rate unit either way. Above
-- is chosen because it is the cheaper of the two checks to fail on, and because
-- it keeps every new bound in one contiguous block a reader meets before the
-- pre-existing one.
--
-- THE SIGNATURE IS UNCHANGED — no new parameter. The bound arrives from
-- `public.rate_bounds` and not from the caller, which is the opposite of
-- `p_daily_cap`'s shipped design and deliberately so (see the placeholder note
-- at the top): a security bound the browser can dial is not a bound. `p_max`
-- exists only on `app_charge_rate_bound`, where it can only tighten.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.app_start_warm_search(
  p_target_kind text,
  p_posting_key text,
  p_company     text,
  p_params      jsonb,
  p_overlays    jsonb,
  p_daily_cap   int,
  p_idem        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user       uuid  := auth.uid();
  v_kind       text  := coalesce(p_target_kind, 'posting');
  v_cap        int   := least(greatest(coalesce(p_daily_cap, 20), 1), 1000);
  v_overlays   jsonb := coalesce(p_overlays, '{}'::jsonb);
  v_count      int;
  v_running    int;
  v_max_inflight int;
  v_row        public.warm_searches;
  v_result     jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if v_kind not in ('posting', 'company') then
    raise exception 'invalid target kind: %', v_kind using errcode = '22023';
  end if;

  -- Stored verbatim and the function is granted to `authenticated`, so bound both
  -- (0012's reasoning): a real param set is a few hundred bytes across three keys, and
  -- overlays are two short arrays.
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'params must be an object' using errcode = '22023';
  end if;
  if pg_column_size(p_params) > 8192 then
    raise exception 'params too large' using errcode = '22023';
  end if;
  if jsonb_typeof(v_overlays) <> 'object' or pg_column_size(v_overlays) > 8192 then
    raise exception 'overlays must be a small object' using errcode = '22023';
  end if;

  -- Serialize concurrent starts for THIS user before the count, so the cap holds
  -- under a burst (see the header). Taken after the cheap validation so a malformed
  -- request never contends for it. It now covers the in-flight count and the rate
  -- charge as well, which is why neither needs a lock of its own.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  -- Replay BEFORE the cap check: a retried "Search" must return the first row, not
  -- spend a second reservation against the cap.
  --
  -- #261: it is also before the IN-FLIGHT check and the RATE CHARGE below, and
  -- that ordering is the whole of decision 4. A bound placed above this line —
  -- at the route, or at RPC entry — makes a client retrying one gesture pay
  -- twice for work performed once, which the outbox and the emailed-link lane
  -- both do by design.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- #261 `warm.concurrent` — a RELIABILITY bound on in-flight work, and
  -- deliberately NOT a `usage_counters` row. Concurrency is live state, not a
  -- count over a window: a search that finishes, fails or is cancelled releases
  -- its own slot by changing `status`, so there is no slot to hand back and
  -- nothing that can leak when this function returns early above. That is the
  -- structural answer to the mirror failure in #261's attack list.
  select max_units into v_max_inflight
    from public.rate_bounds where meter = 'warm.concurrent';
  if v_max_inflight is null then
    raise exception 'rate meter warm.concurrent is missing from the catalog'
      using errcode = '22023';
  end if;
  select count(*) into v_running
    from public.warm_searches
   where user_id = v_user and status = 'running';
  if v_running >= v_max_inflight then
    raise exception
      'rate bound warm.concurrent exceeded: % searches already running', v_running
      using errcode = 'HQBND',
            detail  = 'warm.concurrent',
            hint    = 'wait for a running search to finish, or cancel one';
  end if;

  -- #261 `warm.start` — the PROVIDER bound. Below the replay lookup (a retry
  -- costs nothing) and above the write (the charge is the reservation). It
  -- rolls back with the transaction, so an over-cap or failed start does not
  -- spend a unit.
  perform public.hq_charge_rate_bound(v_user, 'warm.start');

  select count(*) into v_count
    from public.warm_searches
   where user_id = v_user
     and created_at > now() - interval '24 hours';
  if v_count >= v_cap then
    raise exception 'warm search daily cap of % reached', v_cap using errcode = 'HQCAP';
  end if;

  insert into public.warm_searches (user_id, target_kind, posting_key, company, params, overlays)
  values (v_user, v_kind,
          left(coalesce(p_posting_key, ''), 200),
          left(coalesce(p_company, ''), 200),
          p_params, v_overlays)
  returning * into v_row;

  -- The spend record. `events` is where "why was I charged for a run" is answered,
  -- and the row and its audit go in one body or the trail has holes.
  insert into public.events (user_id, kind, posting_key, payload, actor)
  values (v_user, 'warm.search_started', v_row.posting_key,
          jsonb_build_object('search_id', v_row.id, 'company', v_row.company,
                             'target_kind', v_row.target_kind),
          'user');

  v_result := public.app_warm_search_row(v_row);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_start_warm_search', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.app_start_warm_search(text, text, text, jsonb, jsonb, int, text)
  from public, anon, authenticated;
grant execute on function public.app_start_warm_search(text, text, text, jsonb, jsonb, int, text)
  to authenticated;

comment on function public.app_start_warm_search(text, text, text, jsonb, jsonb, int, text) is
  'reserve one warm search under an advisory lock: the per-user in-flight bound '
  'and the warm.start rate bound (SQLSTATE HQBND) then the daily cap (HQCAP), all '
  'below the replay lookup so a retry costs nothing; idempotent (0020, #261)';
