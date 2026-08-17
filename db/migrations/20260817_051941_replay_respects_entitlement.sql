-- 20260817_051941_replay_respects_entitlement.sql
--
-- WHAT THIS CHANGES: `public.hq_command_replay` — the post-0026 replay lookup —
-- refuses a caller whose account is not entitled, BEFORE it reads
-- `command_idempotency` at all. One function is re-declared; no table, policy,
-- grant, trigger or command signature changes.
--
-- Issue #256, coordinator decision of 2026-08-17: option (b), FAIL CLOSED.
--
-- ─────────────────────────────────────────────────────────── THE HOLE
--
-- Found by the #254 review as a family-wide observation. Every post-0026 command
-- RPC calls `hq_command_replay` at the top of its body, above every write. The
-- RPC is `security definer` and `command_idempotency` has RLS enabled with NO
-- POLICIES AT ALL, so the definer is the only thing that reads it — and it reads
-- it for whoever is calling. On a genuine replay the function returns the stored
-- result and the RPC returns early, so the write never happens, so
-- `hq_entitlement_guard()` — a BEFORE-ROW trigger, and the only entitlement
-- check that reaches inside a definer — never fires.
--
-- The consequence: an account the owner has SUSPENDED, or one that was never
-- activated, replaying an idempotency key it already used, receives its own
-- stored command result. No write occurs and the exposure is limited to the
-- account's own prior results. It is still a read of product state by an account
-- that is turned off, which is what suspension is for, and `docs/specs/
-- user-entitlement.md` states the invariant without a carve-out: unknown,
-- pending, suspended, removed or wrong-owner access defaults to deny.
--
-- The decision recorded the cost and accepted it: an in-flight retry that
-- crosses the moment of suspension now gets a denial instead of its original
-- answer. That is the correct direction — a suspended account should not be told
-- "your command succeeded" — and 42501 is a refusal every layer above already
-- produces for a suspended write.
--
-- ────────────────────────────────── WHERE THE CHECK GOES, AND WHY HERE
--
-- Inside the shared primitive, not at each of its call sites.
--
-- The alternative — one `hq_is_entitled()` line at the top of each command RPC —
-- is the shape `0027_entitlement.sql` already rejected in prose ("WHY NOT ADD
-- `hq_is_entitled()` TO ALL 37"): it protects the functions that exist today and
-- leaves the next one outside the list again, written by somebody who has not
-- read this file. The whole point of the fix is that the NEXT composed command
-- inherits it.
--
-- Centralising is safe here, and that was established by enumeration rather than
-- by reading: against a database with every migration applied,
-- `pg_proc.prosrc like '%hq_command_replay%'` returns exactly TEN functions, and
-- every one of them is an `app_*` browser command, `security definer`, granted to
-- `authenticated`, deriving `v_user := auth.uid()` in its declaration block and
-- passing that value as `p_user`:
--
--     app_add_job                       20260813_025743_app_add_job.sql
--     app_record_resume_artifact        0026_resume.sql
--     app_retry_autopilot_stage         20260814_030545_autopilot_handoff.sql
--     app_review_autopilot_stage        20260814_030545_autopilot_handoff.sql
--     app_save_resume_document          0026_resume.sql
--     app_save_resume_version           0026_resume.sql
--     app_set_default_resume            0026_resume.sql
--     app_set_notification_prefs        20260814_021627_notification_prefs.sql
--     app_settle_autopilot_handoff      20260814_030545_autopilot_handoff.sql
--     app_stage_autopilot_application   20260802_094615_autopilot_staging.sql
--
-- NO `hq_*` ENGINE FUNCTION CALLS IT. That is the property that makes a shared
-- entitlement check safe to put here: there is no service-role lane inheriting a
-- gate written for browsers. The set is asserted in both directions by
-- `tests/db/test_default_deny.py::test_the_replay_family_is_exactly_this_set`,
-- so a new caller — or an engine caller, which would be a design change — has to
-- say so.
--
-- The engine/operator hatch is kept anyway, VERBATIM from
-- `hq_entitlement_guard()`, because a shared primitive that diverges from the
-- shipped boundary's posture is how the engine breaks at 03:00: `auth.uid() is
-- null` is refused for a browser role and waved through for `service_role` and
-- for a superuser session (the migration runner, psql). "Nobody is signed in" is
-- not evidence that the engine is calling.
--
-- The `p_user <> auth.uid()` refusal is the second half and it is not
-- decoration. This function takes a user id as an argument — legitimately, since
-- it is not a definer and `test_definer_functions_never_take_a_user_id` does not
-- reach it — and an entitlement check reads `auth.uid()`. Without the
-- comparison, a future caller passing somebody else's id would have the CALLER's
-- entitlement checked while the OTHER account's stored result was returned: a
-- gate that is green and pointed at the wrong row. Nothing does that today; the
-- line is what keeps it true.
--
-- ──────────────────────────────────────── ORDERING, AND THE RATE BOUNDS
--
-- `20260817_011844_per_user_rate_bounds.sql` decision 4 fixes the order every
-- command must preserve:
--
--     1  auth.uid() is null                → 28000
--     2  cheap argument validation         → 22023
--     3  pg_advisory_xact_lock(user)
--     4  the LAST replay check → if it returns, RETURN
--     5  hq_charge_rate_bound(...)         → HQBND
--     6  the guarded write + events + command_idempotency
--
-- This change adds the denial INSIDE step 4, which is strictly above step 5. So
-- a non-entitled caller — replay or first call — is refused before any charge
-- and before any write: a suspended replay consumes no rate-bound unit and
-- leaves no counter row behind. None of the ten charges a meter today, so the
-- property is a structural one for now; it is asserted from `pg_proc.prosrc` in
-- both forms (`test_the_replay_denial_sits_above_the_charge_and_the_write`) so
-- the first metered command in this family cannot land on the wrong side of it.
--
-- Everything else about replay is untouched, and each half has its test: an
-- ENTITLED caller replaying the same key with the same arguments still gets the
-- stored result; the same key with different arguments still raises 22023; a new
-- key still returns null; no command executes twice; wrong-owner is unchanged
-- for the browser path (every caller passes its own `auth.uid()`, so another
-- account's key is simply a key this account has never used).
--
-- ───────────────────────────────────── WHAT THIS DOES NOT COVER (#256 residual)
--
-- READ THIS BEFORE QUOTING THE GUARANTEE ABOVE. The gate closes the post-0026
-- door and it does NOT make a suspended account's stored results unreachable.
--
-- The 27 PRE-0026 commands do not call this function. They carry the older
-- inline shape — `select result into v_result from public.command_idempotency
-- where user_id = v_user and idem_key = p_idem; if found then return v_result;`
-- (`0003_write_path.sql`, and e.g. `app_start_warm_search` at
-- `0020_warm_referral.sql`). That lookup keys on `(user_id, idem_key)` ALONE: it
-- never compares the command and never compares `request_hash`, both of which
-- 0026 added and only the post-0026 family uses.
--
-- The consequence, demonstrated by the #287 security review rather than reasoned
-- about: a suspended account sends THE SAME KEY to any pre-0026 sibling —
-- `app_save_view`, `app_clear_connections`, any of the 27 — and receives the
-- result stored by a command in the list above, verbatim. So the residual does
-- not merely leave a neighbouring hole open; **it defeats this migration's
-- headline property for exactly the rows this migration protects.** #256 IS NOT
-- CLOSED UNTIL THE 27 ARE. That work is #288.
--
-- Not fixed here because both routes exceed what the #256 decision authorised:
-- re-declaring 27 function bodies is exactly the shape `0027` refused by name,
-- and forcing RLS on `command_idempotency` reaches the digest and email lanes
-- and every command's own idempotency insert — a strictly larger blast radius,
-- and silently inert if the owning role holds `bypassrls`.
--
-- The exact set is derivable at any time from `pg_proc`; the derivation is in
-- `tests/db/test_default_deny.py::test_the_replay_family_is_exactly_this_set`,
-- and the post-0026 test is NAMED for the door it proves shut
-- (`…_through_a_post_0026_command`) so no reader mistakes it for the system
-- property.
--
-- No new SQLSTATE: 42501, `hq_entitlement_guard()`'s code, with its hint. A
-- suspended account already gets 42501 from every guarded write, and the webapp
-- never reaches this path at all — `getDataSource()` throws `NotEntitledError`
-- for a non-active session long before an RPC is called. This is the layer that
-- holds when an app layer is wrong, which is the only reason it exists.

-- ============================================================ the replay lookup

/**
 * The replay lookup, command- and payload-scoped, and now entitlement-scoped.
 *
 * Returns the stored result for a genuine replay by an ENTITLED caller, `null`
 * when the key is new, and RAISES when the key belongs to a different gesture,
 * to a different account, or to an account that is not turned on.
 *
 * Deliberately NOT security definer, unchanged from 0026: it is only ever called
 * from inside functions that already run as the definer, and marking it definer
 * would hand a standalone caller a read of anybody's stored command results.
 * `stable` for the same reason as before — it reads and never writes, and
 * `auth.uid()`, `hq_is_entitled()` and `current_setting` are all stable too.
 *
 * Body below the gate is byte-for-byte 0026's.
 */
create or replace function public.hq_command_replay(
  p_user         uuid,
  p_idem         text,
  p_command      text,
  p_request_hash text
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_prev public.command_idempotency;
begin
  -- ── #256: not entitled, or not yours, reads nothing ────────────────────────
  if v_uid is null then
    -- `hq_entitlement_guard()`'s hatch, as a POSITIVE assertion rather than "no
    -- uid": `current_setting('role')` still reports the request's actual role
    -- inside a definer (`current_user` does not — it is the function's owner).
    -- `service_role` is the engine; 'none' is a superuser session, the migration
    -- runner and psql. A browser role with no uid gets no hatch.
    if coalesce(current_setting('role', true), 'none') not in ('service_role', 'none') then
      raise exception
        'anonymous session may not replay %', p_command
        using errcode = '42501',
              hint = 'sign in — an unauthenticated request is not the engine';
    end if;
  else
    if p_user is distinct from v_uid then
      raise exception
        'account % may not replay a result stored for %', v_uid, p_user
        using errcode = '42501',
              hint = 'the replay lookup answers for auth.uid() and nobody else';
    end if;

    if not public.hq_is_entitled() then
      raise exception
        'account % is not entitled to replay %', v_uid, p_command
        using errcode = '42501',
              hint = 'the account is pending or suspended (public.entitlements)';
    end if;
  end if;

  select * into v_prev
    from public.command_idempotency
   where user_id = p_user and idem_key = p_idem;
  if not found then
    return null;
  end if;

  if v_prev.command is distinct from p_command then
    raise exception
      'idempotency key already used by % — % cannot replay it', v_prev.command, p_command
      using errcode = '22023';
  end if;

  if v_prev.request_hash is distinct from p_request_hash then
    raise exception
      'idempotency key already used by % with different arguments', p_command
      using errcode = '22023';
  end if;

  -- `result` is `jsonb not null`, but the JSON value `null` is not a SQL null
  -- and would be indistinguishable from "no row" on the way out. Every command
  -- in this family builds an object; one that did not would be silently treated
  -- as a first call and applied twice.
  if jsonb_typeof(v_prev.result) is distinct from 'object' then
    raise exception 'stored result for % is not an object', p_command
      using errcode = '22023';
  end if;
  return v_prev.result;
end;
$$;

comment on function public.hq_command_replay(uuid, text, text, text) is
  'the command-, payload- and entitlement-scoped replay lookup: the first result for a true replay by the entitled owner, null for a new key, and a raise when one key is reused for a different gesture, when the caller is not the account the result was stored for, or when that account is not active (#256)';

-- `create or replace` preserves the existing ACL, so this restates rather than
-- changes it: browser roles never held EXECUTE on this function and still do
-- not. `service_role` keeps what Supabase grants it — the hatch above is the
-- half that makes that harmless, and it is the posture 0026 shipped.
revoke all on function public.hq_command_replay(uuid, text, text, text)
  from public, anon, authenticated;
