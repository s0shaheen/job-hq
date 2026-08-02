-- 0027 — the entitlement record: an account may now EXIST without being turned on.
--
-- The owner's launch decision, verbatim: "use invite-code + sign-up for the first
-- users (who will have all access but for free); build out open email/password or
-- google signup for any other users but open users like this won't be allowed or
-- able to use the site until I say so" … "invites will have to create an account
-- regardless, but any other users should be able to sign up but they won't have
-- any features or anything they could use until I say so."
--
-- Today that is not expressible. `0001_init.sql`'s `handle_new_auth_user` RAISES
-- on any signup whose address is not in `allowed_emails`, so a stranger cannot
-- create an account at all — the door refuses before a `users` row exists. The
-- owner's model needs the opposite front door and a second, softer gate behind
-- it: anyone may create an account; an invited address is active immediately;
-- everyone else lands in a holding state and reaches nothing until the owner
-- flips them on.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY A TABLE AND NOT A COLUMN ON `users`
--
-- The cheap version is `users.status text not null default 'pending'`. Rejected
-- for three reasons, none of them stylistic:
--
--   1. `public.users` is the IDENTITY row and it is what every RLS policy in this
--      schema keys off (`auth.uid()` → `users.id`, `users.is_operator` in
--      `channel_runs_read`). It is written once, by a trigger, and then never
--      again. Activation is the opposite: a mutable operational state the owner
--      flips by hand, with its own stamps and its own audit events. Putting a
--      hand-flipped column on the row every policy reads is how an operator
--      mistake becomes an identity mistake.
--
--   2. The record has to CARRY A PLAN LATER without a rewrite (pack H: Free/Pro,
--      a Stripe customer id, a period end). Those are commerce columns. A
--      separate table is where they belong; bolting them onto `users` puts
--      billing in the identity table forever, and every future billing column
--      widens the row that `users_self_read` exposes to the browser.
--
--   3. Privileges. `entitlements` can be revoked from `authenticated` outright
--      (the `capture_tokens` pattern, 0018) while `users` keeps its self-read.
--      "A user may read their own entitlement and may never write it" is one
--      REVOKE on a table of its own; on `users` it would be a column-level grant,
--      which is exactly the kind of thing that reads closed and is not.
--
-- The forward seam is `plan`, and it deliberately carries NO check constraint.
-- The plan vocabulary belongs to the billing phase, which has not happened; a
-- CHECK naming tiers that do not exist yet is a guess, and this file does not
-- guess. `status` DOES carry one — it is a closed three-value vocabulary this
-- migration owns end to end, and it is the value the whole gate reads.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE INVITE-CODE DECISION: NO CODE TABLE. THE EMAIL ALLOWLIST STAYS.
--
-- The owner said "invite-code + sign-up". Today an invitation IS a row in
-- `allowed_emails`, which requires him to know the address in advance. A
-- redeemable code would not require that. It is still the wrong thing to build
-- in this migration, and the reason is concrete rather than budgetary:
--
--   * A code needs a FIELD TO BE TYPED INTO, and that field lives on the signup
--     form — part of the designed Auth surface (06 §C), which is explicitly not
--     built on this branch. A code table shipped now is a credential nothing can
--     redeem: dead schema, dead RLS, dead tests, and a second way to be wrong
--     about who is invited while the first one still runs.
--   * The entitlement model makes the code UNNECESSARY for launch. "Redeem a
--     code and be active" and "sign up, then the owner activates you" have the
--     same user-visible outcome. The code saves the owner one `hq_activate_user`
--     call. He has two real users.
--   * Both invite cases are already covered TODAY: he knows the address → seed
--     `allowed_emails` and they are active on first sign-in; he does not know it
--     → they sign up, land pending, and he activates them from the list.
--
-- The seam is kept open rather than closed off: `entitlements.invite_ref` is free
-- text already carrying `'allowlist'`, so a future `'code:<label>'` needs no
-- schema change, and `handle_new_auth_user` has exactly one marked branch point
-- where a redemption would be checked. When the Auth surface lands with a signup
-- form, the code table lands with it.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE EXISTING USERS MUST NOT NOTICE THIS MIGRATION
--
-- The owner and his dad are signed in right now. The backfill at the bottom
-- gives every `public.users` row that exists an ACTIVE, invited entitlement — and
-- it is `on conflict (user_id) do nothing`, not `do update`, which matters
-- because `db/apply.sh` re-applies every migration every time. A `do update set
-- status = 'active'` backfill would silently resurrect a suspended account on the
-- next provisioning run, which is the one thing an operator control must never do
-- behind the operator's back.

-- ============================================================ the record

create table if not exists public.entitlements (
  user_id uuid primary key references public.users (id) on delete cascade,

  -- pending   — the account exists and reaches nothing. The default, on purpose:
  --             a row that arrives without an explicit status is not entitled.
  -- active    — full access.
  -- suspended — access was turned off after the fact. Distinct from `pending`
  --             because "never turned on" and "turned back off" are different
  --             facts about a person, and the holding surface says different
  --             things about them.
  status text not null default 'pending'
         check (status in ('pending', 'active', 'suspended')),

  -- The owner's "all access but for free". Invited accounts are free forever;
  -- when `plan` starts meaning something, this is the flag that exempts them.
  invited boolean not null default false,

  -- WHAT proved the invite: 'allowlist' today, 'code:<label>' the day codes
  -- exist, '' for an open signup. Free text rather than an enum for that reason.
  invite_ref text not null default '',

  -- The forward seam for pack H. No CHECK — see the header.
  plan text not null default 'free',

  -- NULL while pending. Stamped once, by the activation that first turned the
  -- account on; a re-activation after a suspension does not restamp it, because
  -- "when did this person get in" is the question it answers.
  activated_at  timestamptz,
  suspended_at  timestamptz,

  -- The operator's note, carried on the row the holding surface reads. Not shown
  -- to the user today; it exists so a suspension is never unexplained in the
  -- store, which is where the explanation is looked for six months later.
  reason text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.entitlements is
  'per-user activation state for the invite-only launch: pending|active|suspended, flipped ONLY by the hq_activate_user / hq_suspend_user operator functions (docs/RUNBOOK.md § Turning a new signup on). Carries the plan seam for billing.';

comment on column public.entitlements.plan is
  'billing seam, deliberately unconstrained: the plan vocabulary belongs to the billing phase and a CHECK naming tiers that do not exist yet would be a guess';

drop trigger if exists entitlements_touch on public.entitlements;
create trigger entitlements_touch before update on public.entitlements
  for each row execute function public.touch_updated_at();

-- ============================================================ RLS

alter table public.entitlements enable row level security;

-- A user may READ their own entitlement, because the holding surface has to be
-- able to say which state they are in — "not turned on yet" and "turned off" are
-- different sentences and the page must not guess between them.
drop policy if exists entitlements_self_read on public.entitlements;
create policy entitlements_self_read on public.entitlements
  for select using (user_id = auth.uid());

-- And the write PRIVILEGES go, not just the absence of a write policy. 0018's
-- lesson on `email_events`, applied at the point where it matters most: Supabase
-- grants `authenticated` INSERT/UPDATE/DELETE on every new table in `public` so
-- that RLS can be the decider, so without this the door is shut by the absence of
-- a rule rather than by the absence of a privilege — and one plausible future
-- `for all using (user_id = auth.uid())` policy would let a pending user activate
-- themselves. `public` is named alongside the two roles because it is a distinct
-- grantee and leaving it out is how a revoke reads closed and is not.
revoke insert, update, delete, truncate on public.entitlements
  from public, anon, authenticated;

-- ============================================================ the predicate

/**
 * Is the CURRENT session's account turned on?
 *
 * Deliberately NOT `security definer` and deliberately takes no argument. Both
 * follow from where it is called:
 *
 *   * from an RLS policy / a definer function's WHERE clause, it must answer for
 *     the CALLER, and the caller is `auth.uid()`. An argument would let a caller
 *     name somebody else's entitlement, which is the shape
 *     `test_definer_functions_never_take_a_user_id` exists to refuse.
 *   * as a plain function it runs with the caller's rights, so from a policy it
 *     reads `entitlements` under `entitlements_self_read` (own row, permitted)
 *     and from inside a definer it inherits that definer's rights and is scoped
 *     by its own WHERE. Either way it can only ever see one row: the caller's.
 *
 * Answers FALSE for an anonymous caller (`auth.uid()` is null → no row), and
 * false for a user whose entitlement row is missing. Missing means not entitled;
 * a gate that reads absence as permission is not a gate.
 *
 * `stable`, so Postgres may evaluate it once per statement rather than per row
 * inside a policy.
 */
create or replace function public.hq_is_entitled()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.entitlements e
     where e.user_id = auth.uid()
       and e.status = 'active');
$$;

comment on function public.hq_is_entitled() is
  'true iff the CURRENT session''s account is active; false for anonymous callers and for a missing entitlement row (absence is never permission)';

-- Granted to `anon` as well as `authenticated`, and that is not a hole: the
-- function reads `auth.uid()`, which is null for an anonymous caller, so it
-- returns false by construction. The grant exists because an RLS policy that
-- calls it is evaluated as the QUERYING role — without it an anonymous select
-- would fail with "permission denied for function" instead of returning zero
-- rows, and a gate that errors instead of refusing teaches people to route
-- around it.
revoke all on function public.hq_is_entitled() from public;
grant execute on function public.hq_is_entitled() to anon, authenticated, service_role;

-- ============================================================ the front door

/**
 * First sign-in, rewritten: create the account, entitled or not.
 *
 * The 0001 version raised for any address outside `allowed_emails`. Everything
 * else in this file is downstream of removing that raise.
 *
 * Three properties, each of which has a test:
 *
 *   INVITED  → `users` + an ACTIVE entitlement, `invited = true`, stamped.
 *   UNINVITED→ `users` + a PENDING entitlement. No raise. The account exists.
 *   REPLAY   → both inserts are `on conflict … do nothing`, so a second fire for
 *              the same auth id can neither duplicate the rows nor push an
 *              already-active account back to pending. `do update` here would be
 *              a downgrade-on-replay, and it is the mutation the replay test kills.
 *
 * Still fails loud on genuinely broken input, and there are exactly two kinds:
 * an auth user with no email (this schema keys every user on one), and a second
 * auth identity claiming an email `public.users` already holds under a different
 * id. The second raises rather than merging, because merging two identities is a
 * decision no trigger should make silently — and because it runs inside GoTrue's
 * own transaction, the raise rolls the whole signup back and leaves the existing
 * account untouched.
 */
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_email   text := lower(public.hq_blank_trim(new.email));
  allowed   public.allowed_emails%rowtype;
  v_invited boolean := false;
  v_ref     text := '';
  v_holder  uuid;
begin
  if v_email = '' then
    raise exception 'auth user % arrived with no email; every Job Search HQ user is keyed on one', new.id
      using errcode = '23502';
  end if;

  select id into v_holder from public.users
   where email = v_email and id <> new.id;
  if found then
    raise exception 'email % already belongs to user %; refusing to merge two identities', v_email, v_holder
      using errcode = '23505';
  end if;

  select * into allowed from public.allowed_emails
   where lower(email) = v_email;
  if found then
    v_invited := true;
    v_ref     := 'allowlist';
  end if;

  -- ┌─ THE INVITE BRANCH POINT ────────────────────────────────────────────────┐
  -- │ When redeemable codes land with the signup form, they are checked HERE:  │
  -- │ look the presented code up, and on a hit set v_invited := true and       │
  -- │ v_ref := 'code:<label>'. Nothing below this line needs to change.        │
  -- └──────────────────────────────────────────────────────────────────────────┘

  insert into public.users (id, email, name, is_operator)
  values (new.id, v_email,
          coalesce(allowed.name, ''), coalesce(allowed.is_operator, false))
  on conflict (id) do nothing;

  insert into public.entitlements
         (user_id, status, invited, invite_ref, activated_at)
  values (new.id,
          case when v_invited then 'active' else 'pending' end,
          v_invited,
          v_ref,
          case when v_invited then now() else null end)
  on conflict (user_id) do nothing;

  -- NO `events` row here, and that is a decision rather than an omission.
  -- `users.created_at`, `entitlements.created_at` and `entitlements.status`
  -- already state this fact completely and permanently; an event would be a
  -- second copy of it. `events` is the per-user ACTIVITY trail every surface
  -- reads, and the two things worth reading there are the state CHANGES an
  -- incident asks about — which `hq_activate_user` and `hq_suspend_user` do
  -- write, with `actor = 'operator'`.
  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'first sign-in: create public.users plus an entitlement — ACTIVE for an allowlisted address, PENDING for anyone else. Never raises for an uninvited signup (0027).';

-- ============================================================ operator controls

/**
 * Turn an account on.
 *
 * NOT `security definer`, and it takes `p_user_id`: those two facts belong
 * together, and 0018's capture-token family is the precedent. A definer function
 * that entitles whoever it is asked to entitle is an access vending machine. This
 * runs with the CALLER's rights, and the only callers are the operator in the SQL
 * editor and the service role.
 *
 * WHY THE SQL EDITOR AND NOT A DISPATCHABLE JOB. Same answer 0018 gives for
 * minting tokens, one step weaker and still decisive: `handler.JOBS` + **Run a
 * bot** both print to a log (CloudWatch, the Actions run log), and "who was
 * granted access to this product and when" is an authorization decision, not a
 * line in a build log that anyone with repo read can page through. Provisioning
 * the allowlist already works this way (`db/README.md` step 3).
 *
 * Idempotent, and it says so in its answer: activating an already-active account
 * changes nothing, restamps nothing, and returns `changed: false` with no event.
 * `activated_at` is stamped only the FIRST time — reactivating after a suspension
 * clears `suspended_at` and leaves the original date alone, because "when did
 * this person get in" is what that column answers.
 */
create or replace function public.hq_activate_user(
  p_user_id uuid,
  p_reason  text default ''
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before text;
  v_row    public.entitlements%rowtype;
begin
  if p_user_id is null then
    raise exception 'hq_activate_user needs the user to activate' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'no such user: %', p_user_id using errcode = '23503';
  end if;

  -- The row is created if it is missing rather than assumed: a user provisioned
  -- before this migration, or by any path that skipped the trigger, must still
  -- be activatable. Absence is not permission (see hq_is_entitled) but it is also
  -- not a reason the operator cannot act.
  insert into public.entitlements (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select status into v_before from public.entitlements
   where user_id = p_user_id for update;

  if v_before = 'active' then
    select * into v_row from public.entitlements where user_id = p_user_id;
    return jsonb_build_object('user_id', p_user_id, 'status', 'active',
                              'changed', false, 'activated_at', v_row.activated_at);
  end if;

  update public.entitlements
     set status       = 'active',
         activated_at = coalesce(activated_at, now()),
         suspended_at = null,
         reason       = coalesce(public.hq_blank_trim(p_reason), '')
   where user_id = p_user_id
  returning * into v_row;

  insert into public.events (user_id, kind, payload, actor)
  values (p_user_id, 'entitlement.activated',
          jsonb_build_object('from', v_before, 'reason', v_row.reason), 'operator');

  return jsonb_build_object('user_id', p_user_id, 'status', 'active',
                            'changed', true, 'activated_at', v_row.activated_at);
end;
$$;

comment on function public.hq_activate_user(uuid, text) is
  'operator-only: turn one account on. Idempotent — an already-active account reports changed:false and is not restamped.';

revoke all on function public.hq_activate_user(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_activate_user(uuid, text) to service_role;

/**
 * Turn an account off.
 *
 * A status change, never a delete: the account, its pipeline and its events stay
 * exactly where they are, because suspension is reversible and deleting somebody's
 * job search to express "not right now" is not a thing this system does. Same
 * shape as `hq_revoke_capture_tokens` — stamp, do not remove.
 */
create or replace function public.hq_suspend_user(
  p_user_id uuid,
  p_reason  text default ''
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before text;
begin
  if p_user_id is null then
    raise exception 'hq_suspend_user needs the user to suspend' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'no such user: %', p_user_id using errcode = '23503';
  end if;

  insert into public.entitlements (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select status into v_before from public.entitlements
   where user_id = p_user_id for update;

  if v_before = 'suspended' then
    return jsonb_build_object('user_id', p_user_id, 'status', 'suspended',
                              'changed', false);
  end if;

  update public.entitlements
     set status       = 'suspended',
         suspended_at = now(),
         reason       = coalesce(public.hq_blank_trim(p_reason), '')
   where user_id = p_user_id;

  -- Suspension has to reach the lanes that do NOT carry a browser identity, or
  -- it only turns off the front door. `/api/capture` and `/d/<token>` write with
  -- the service role, so the entitlement guard's engine hatch lets them keep
  -- writing on a suspended user's behalf — proven in review, after suspension,
  -- with an un-revoked capture token. A capability handed to a user is part of
  -- that user's access; turning the account off turns its tokens off too.
  -- NULL label, not a describing string: the parameter FILTERS which tokens to
  -- revoke, so a label here would revoke only tokens that happened to carry it,
  -- i.e. usually none. Suspension revokes all of them.
  perform public.hq_revoke_capture_tokens(p_user_id, null);

  insert into public.events (user_id, kind, payload, actor)
  values (p_user_id, 'entitlement.suspended',
          jsonb_build_object('from', v_before,
                             'reason', coalesce(public.hq_blank_trim(p_reason), '')),
          'operator');

  return jsonb_build_object('user_id', p_user_id, 'status', 'suspended',
                            'changed', true);
end;
$$;

comment on function public.hq_suspend_user(uuid, text) is
  'operator-only: turn one account off. A stamp, never a delete — the account and its history stay.';

revoke all on function public.hq_suspend_user(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_suspend_user(uuid, text) to service_role;

/**
 * Who is waiting.
 *
 * The day-one operator question — "somebody signed up, who?" — and it has no
 * other answer: nothing pushes on a signup, and the owner is not going to poll a
 * table he has to remember the name of. `suspended` rows are included, because
 * "who is currently not able to use this" is one list, not two, and the status
 * column says which is which.
 *
 * Ordered oldest-first: the person who has been waiting longest is the one to
 * answer first, and a list that reorders itself on every call is a list nobody
 * can work down.
 */
create or replace function public.hq_pending_users()
returns table (
  user_id     uuid,
  email       text,
  name        text,
  status      text,
  invited     boolean,
  signed_up_at timestamptz
)
language sql
stable
set search_path = public, pg_temp
as $$
  select u.id, u.email, u.name, e.status, e.invited, u.created_at
    from public.users u
    join public.entitlements e on e.user_id = u.id
   where e.status <> 'active'
   order by u.created_at, u.id;
$$;

comment on function public.hq_pending_users() is
  'operator-only: every account that is not active (pending or suspended), oldest first — the "somebody signed up, who?" query';

revoke all on function public.hq_pending_users()
  from public, anon, authenticated;
grant execute on function public.hq_pending_users() to service_role;

-- ============================================================ closing the one widened read

/**
 * `app_preview_corpus`, re-declared with the entitlement in its WHERE.
 *
 * This is the ONLY read in the schema that a pending user could otherwise reach.
 * 0002 already narrowed `postings` to rows the caller was gated on and `companies`
 * to companies the caller watches, so a pending account — which has no
 * `user_postings` and no `user_companies` — sees zero rows on both by the policies
 * that already exist. This function is the deliberate exception: it is
 * `security definer` precisely so that a user with no gated rows can still preview
 * a profile, which is exactly the state a pending account is permanently in.
 *
 * Left alone it would hand a pending caller 5,000 rows of the shared feed over
 * `/rest/v1/rpc/app_preview_corpus` — the one thing the whole gate is for. The
 * body is otherwise byte-for-byte 0012's, and the change is purely ADDITIVE: one
 * more clause in the WHERE.
 *
 * `auth.uid() is not null` stays even though `hq_is_entitled()` implies it. This
 * function bypasses RLS, and a definer whose refusal of an anonymous caller can
 * only be established by opening a second function is a definer that gets
 * misread — which is the property
 * `test_definer_functions_never_take_a_user_id` pins by requiring the identity
 * check to be visible in the body it is checking.
 */
create or replace function public.app_preview_corpus(p_days int default 30)
returns table (
  key       text,
  company   text,
  title     text,
  tags      jsonb,
  geo       jsonb,
  last_seen date,
  status    text
)
language sql
-- NOT volatile. Postgres refuses a write from inside a stable function, so the
-- "dry run writes nothing" claim is enforced by the planner rather than by
-- review. Downgrading this to volatile is the mutation that matters.
stable
security definer
set search_path = public, pg_temp
as $$
  select p.key, p.company, p.title, p.tags, p.geo, p.last_seen, p.status
    from public.postings p
   -- The definer bypasses RLS, so authorization is checked HERE — and since 0027
   -- "signed in" is no longer the bar on its own, "turned on" is.
   where auth.uid() is not null
     and public.hq_is_entitled()
     and p.last_seen >= current_date - least(greatest(coalesce(p_days, 30), 1), 90)
     and p.status <> 'Closed'
   order by p.last_seen desc, p.key
   limit 5000;
$$;

revoke all on function public.app_preview_corpus(int) from public, anon, authenticated;
grant execute on function public.app_preview_corpus(int) to authenticated;

-- ============================================================ the store-wide default deny
--
-- WHAT THE SECTIONS ABOVE DO NOT COVER, MEASURED RATHER THAN REASONED
--
-- `app_preview_corpus` was described above as "the ONLY read a pending user could
-- reach". That was true of READS and it is the wrong boundary, because the thing
-- a pending account can do that costs the owner money is a WRITE. Enumerated out
-- of `pg_proc` against a database with every migration applied, `authenticated`
-- holds EXECUTE on 37 `security definer` RPCs, and a `security definer` function
-- bypasses RLS by construction. Driven from a pending session (psycopg, the same
-- harness the tests use), three of them completed:
--
--     app_save_view          → a pending account writes rows
--     app_propose_companies  → a pending account writes rows
--     app_start_warm_search  → a pending account RESERVES A HARVESTAPI SEARCH
--
-- The last one spends the owner's vendor credits from an account he has never
-- turned on, and it is reachable over `/rest/v1/rpc/app_start_warm_search` with
-- nothing but the public anon key and a signed-in session. The others failed only
-- on argument validation, not on authorization — `app_import_create` refused
-- because 'simplify' is not a source, which is not a gate.
--
-- WHY NOT "ADD `hq_is_entitled()` TO ALL 37"
--
-- Because it is 37 hand-copied function bodies re-declared in one migration, and
-- because it protects only the 37 that exist today: the 38th RPC, written next
-- month by somebody who has not read this file, is outside it again. `/api/capture`
-- is the precedent in this repo for exactly that failure — a surface shipped
-- outside a list it needed to be on, green through every suite.
--
-- So the gate goes on the STORE, at two boundaries, and the pair is what makes it
-- total:
--
--   1. A RESTRICTIVE RLS policy per table. Postgres ANDs a restrictive policy with
--      every permissive policy on the table — including permissive policies that do
--      not exist yet. This closes the direct PostgREST table surface
--      (`/rest/v1/saved_views`) for every non-entitled state without re-declaring a
--      single existing policy, and a policy widened by accident later is still
--      ANDed with it.
--
--   2. A BEFORE-ROW trigger per table. Restrictive policies do nothing about the
--      `security definer` RPCs — that is the whole point of a definer — but a
--      trigger is not bypassed by definer rights, by `bypassrls`, or by table
--      ownership. It fires inside `app_start_warm_search` just as it fires on a
--      raw insert, so the 38th RPC is gated on the day it is written.
--
-- Both are attached from ONE named list, and `tests/db/test_default_deny.py`
-- re-derives that list from `pg_catalog` and fails if the schema has grown a
-- browser-reachable table or a definer-written table the list does not name. The
-- list is explicit here because a reader of a migration must be able to see the
-- set it protects; it is mechanical in the test because a human list is exactly
-- what goes stale.

/**
 * The write boundary: not entitled, or not yours, is refused — loudly.
 *
 * `auth.uid() is null` RETURNS EARLY, and that is the one subtle line in this
 * file. It means "no browser identity", which is the engine (service role, no
 * JWT), the operator in the SQL editor, `db/apply.sh`, and GoTrue running the
 * signup trigger. None of those are governed by entitlement — they are governed
 * by the grant system, which already refuses `anon` and `authenticated`. Writing
 * this as "deny unless entitled" instead would brick every engine write on the
 * next deploy, and writing it as a role check would not work at all: inside a
 * `security definer` function `current_user` is the function's OWNER, so the
 * caller's role is not visible from here. `auth.uid()` is.
 *
 * The ownership half is generic over the row rather than over the table
 * (`to_jsonb(row) ? 'user_id'`), so a table added later is covered by attaching
 * the trigger and nothing else. It closes the wrong-owner state at the definer
 * layer, where today it is closed only by each RPC's own `where user_id = v_user`
 * — 37 separate correct decisions, none of them enforced.
 *
 * NOT `security definer`: it must read the CALLER's entitlement. It inherits
 * whatever rights it is running under, which inside a definer RPC is the
 * definer's, and `hq_is_entitled()` scopes itself to `auth.uid()` either way.
 */
create or replace function public.hq_entitlement_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_rec   record;
  v_owner text;
begin
  if tg_op = 'DELETE' then v_rec := old; else v_rec := new; end if;

  -- The engine/operator hatch, as a POSITIVE assertion rather than "no uid".
  --
  -- The first version returned early on `auth.uid() is null` alone, and review
  -- broke it: a security-definer RPC that reads auth.uid() without refusing a
  -- null one lets `anon` — no session at all — fall through this branch and
  -- write a row into another user's table. "Nobody is signed in" is not
  -- evidence that the engine is calling; it is the default state of an
  -- unauthenticated request.
  --
  -- `current_setting('role')` is the signal that survives, and it is the one
  -- the original comment wrongly dismissed: `current_user` inside a definer is
  -- the function's owner, but the ROLE setting still reports the request's
  -- actual role. `service_role` is the engine; 'none' is a superuser session —
  -- the migration runner and psql. `anon` and `authenticated` are browsers and
  -- get no hatch, so a null uid from a browser role is refused below rather
  -- than waved through.
  if v_uid is null then
    if coalesce(current_setting('role', true), 'none') in ('service_role', 'none') then
      return v_rec;
    end if;
    raise exception
      'anonymous session may not write %.%', tg_table_schema, tg_table_name
      using errcode = '42501',
            hint = 'sign in — an unauthenticated request is not the engine';
  end if;

  if not public.hq_is_entitled() then
    raise exception
      'account % is not entitled to write %.%', v_uid, tg_table_schema, tg_table_name
      using errcode = '42501',
            hint = 'the account is pending or suspended (public.entitlements)';
  end if;

  v_owner := to_jsonb(v_rec) ->> 'user_id';
  if to_jsonb(v_rec) ? 'user_id' and (v_owner is null or v_owner <> v_uid::text) then
    raise exception
      'account % may not write a %.% row owned by %',
      v_uid, tg_table_schema, tg_table_name, coalesce(v_owner, 'nobody')
      using errcode = '42501';
  end if;

  return v_rec;
end;
$$;

comment on function public.hq_entitlement_guard() is
  'BEFORE-ROW default deny for a browser session: refuses a write from an account that is not active, and a write of a row owned by somebody else. Returns early when auth.uid() is null — the engine and the operator are governed by grants, not by entitlement.';

revoke all on function public.hq_entitlement_guard() from public;

-- `touch_updated_at` (0001) is the one function in `public` with an unpinned
-- search_path, found by the sweep in `tests/db/test_default_deny.py` rather than by
-- reading. It is not `security definer`, so it is not the classic escalation on its
-- own — but it is a TRIGGER function, and a trigger fires inside whatever context
-- wrote the row, which since this migration includes 37 definer RPCs owned by
-- `postgres`. `now()` resolving through a caller-controlled schema is a small hole
-- with a large blast radius, and pinning it is one line. Body is byte-for-byte
-- 0001's; only the declaration changes.
create or replace function public.touch_updated_at()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

/**
 * The gated set: every table a browser can reach, and every table a
 * browser-reachable `security definer` RPC writes.
 *
 * NOT on this list, each for a reason a test asserts by name:
 *
 *   users        — identity. The app must be able to answer "who am I" for a
 *                  pending account; a restrictive gate here would make the
 *                  holding surface unable to name the person it is holding.
 *   entitlements — the holding surface reads its own status to decide which
 *                  sentence to show, and `hq_is_entitled()` itself reads this
 *                  table. A restrictive policy calling `hq_is_entitled()` on the
 *                  table `hq_is_entitled()` reads is infinite recursion.
 *   allowed_emails — the invite list. Written by the operator only; no policy
 *                  grants a browser session any row of it, and the signup trigger
 *                  reads it before an entitlement can exist.
 */
do $$
declare
  t text;
  gated text[] := array[
    'answer_policies', 'answers', 'application_notes', 'applications',
    -- `bot_runs` (0023) landed on main while this branch was open, and the sweep
    -- in `tests/db/test_default_deny.py` went red on the rebase that pulled it in
    -- — which is the entire point of deriving the set from `pg_catalog` instead of
    -- trusting this array. It is browser-READ-only (0023 revokes the writes), and
    -- it still belongs here: its shared rows (`user_id is null`) are readable by
    -- any signed-in session, so without the restrictive policy an account nobody
    -- has turned on watches the owner's automation run.
    'bot_runs',
    'capture_tokens', 'channel_runs', 'command_idempotency', 'companies',
    'connections', 'email_events', 'events', 'import_batches',
    'import_column_reports', 'import_rows', 'postings', 'profiles',
    'saved_views', 'user_companies', 'user_postings', 'warm_pins',
    'warm_searches'
  ];
begin
  foreach t in array gated loop
    if to_regclass('public.' || quote_ident(t)) is null then
      raise exception 'entitlement gate names a table that does not exist: public.%', t;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- Restrictive: ANDed with every permissive policy on the table, present and
    -- future. Named `<table>_entitled` so the catalog sweep can find it.
    execute format('drop policy if exists %I on public.%I', t || '_entitled', t);
    execute format(
      'create policy %I on public.%I as restrictive for all '
      'using (public.hq_is_entitled()) with check (public.hq_is_entitled())',
      t || '_entitled', t);

    -- And the definer path, which the policy above cannot reach.
    execute format('drop trigger if exists %I on public.%I', t || '_entitlement_guard', t);
    execute format(
      'create trigger %I before insert or update or delete on public.%I '
      'for each row execute function public.hq_entitlement_guard()',
      t || '_entitlement_guard', t);
  end loop;
end
$$;

-- ============================================================ the backfill

-- Every account that exists TODAY is active and invited. The owner and his dad
-- are signed in while this runs; a migration that put them in the holding state
-- would be an outage they discover by opening the app.
--
-- `do nothing`, never `do update`. `db/apply.sh` re-applies the whole directory
-- on every provisioning run, so a `do update set status = 'active'` here would
-- resurrect a suspended account behind the operator's back — and would undo a
-- deliberate pending state at the same time. The one test that kills that mutant
-- re-applies this file with a pending user and a suspended user present.
insert into public.entitlements (user_id, status, invited, invite_ref, activated_at)
select u.id, 'active', true, 'allowlist', u.created_at
  from public.users u
on conflict (user_id) do nothing;
