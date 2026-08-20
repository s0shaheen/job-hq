-- 20260820_013851_replay_compares_the_command.sql
--
-- WHAT THIS CHANGES: the 29 functions that carry the PRE-0026 inline replay
-- lookup now compare the command that owns the idempotency key, and refuse the
-- key when it belongs to a different one. Twenty-nine functions are re-declared
-- with `create or replace`; every body is otherwise byte-identical to what is
-- live today. NO table, column, index, policy, trigger, grant, comment or
-- function signature changes, and no data is read or written by this file.
--
-- Issue #288, coordinator decision of 2026-08-19: route (d), the narrow fix.
--
-- ─────────────────────────────────────────────────────────────── THE DEFECT
--
-- `command_idempotency` has had a `command text not null` column since the day
-- it was created (`0003_write_path.sql:36`), and every command RPC in the repo
-- WRITES it. The primary key is `(user_id, idem_key)`, and the inline lookup
-- 0003 established selects on those two columns alone:
--
--     select result into v_result
--       from public.command_idempotency
--      where user_id = v_user and idem_key = p_idem;
--     if found then
--       return v_result;
--     end if;
--
-- It never READ the command. 0026 said so in as many words when it built the
-- shared primitive ("not one of the twenty-five lookups before this file READ
-- it"), and 49 lookups across 29 functions still do not.
--
-- ───────────────────────────────────────────────────── THE TWO CONSEQUENCES
--
-- 1. A CORRECTNESS BUG FOR ENTITLED USERS, independent of suspension. Any
--    caller reusing one idempotency key across two different commands gets the
--    FIRST command's stored result back from the second — a payload of an
--    unrelated shape, reported as that second command's answer. Nobody has hit
--    it because keys are minted per gesture in practice, and nothing enforced
--    that.
--
-- 2. A BYPASS OF #256's FIX, not a parallel gap. `20260817_051941_replay_
--    respects_entitlement.sql` put the entitlement check inside
--    `hq_command_replay`, so the ten post-0026 commands refuse a suspended,
--    pending or removed account. But a suspended account could send THE SAME
--    KEY to any of the 29 siblings below and receive the protected command's
--    stored result verbatim — demonstrated by the #287 security review against
--    `app_save_view` and `app_clear_connections`, each of which returned an
--    `app_add_job` result to a suspended caller. The fix was one call away from
--    being no fix at all.
--
-- ──────────────────────────────────────── THE SET, ENUMERATED NOT LISTED
--
-- Against a database with every migration applied, the functions whose stored
-- body reads `public.command_idempotency` WITHOUT going through
-- `hq_command_replay` are exactly TWENTY-NINE — 27 `app_*` browser commands and
-- 2 `hq_*` engine lanes — carrying 49 lookups between them (20 functions check
-- twice, once before the row lock and once behind it, 0003:166-182's reason):
--
--     app_add_note                  2   0010_pipeline.sql
--     app_clear_connections         1   0013_referral.sql
--     app_commit_profile            2   0012_profile.sql
--     app_delete_answer             2   0017_answer_scope.sql
--     app_delete_policy_rule        2   0014_apply_answers.sql
--     app_delete_view               1   0005_saved_views.sql
--     app_import_commit_chunk       2   20260813_011502_import_unset_marker.sql
--     app_import_connections        1   0013_referral.sql
--     app_import_create             1   0011_import.sql
--     app_import_discard            2   0011_import.sql
--     app_import_undo               2   0011_import.sql
--     app_pin_warm_intro            1   0020_warm_referral.sql
--     app_propose_companies         2   0008_company_review.sql
--     app_resolve_suggestion        2   0010_pipeline.sql
--     app_save_view                 1   0005_saved_views.sql
--     app_set_company_flags         2   0008_company_review.sql
--     app_set_company_review_bulk   2   0008_company_review.sql
--     app_set_display_prefs         2   0025_display_prefs.sql
--     app_set_linkedin_company_id   2   0016_linkedin_fill.sql
--     app_set_next_action           2   0010_pipeline.sql
--     app_set_policy_rule           2   0014_apply_answers.sql
--     app_set_status                2   0010_pipeline.sql
--     app_set_triage                2   0003_write_path.sql
--     app_set_triage_bulk           1   0006_bulk_triage.sql
--     app_start_warm_search         1   20260817_011844_per_user_rate_bounds.sql
--     app_unpin_warm_intro          1   0020_warm_referral.sql
--     app_upsert_answer             2   0017_answer_scope.sql
--     hq_apply_email_event          2   0015_engine_writes.sql
--     hq_digest_set_triage          2   0019_digest_action.sql
--
-- The issue's headcount was right, and it is asserted from `pg_proc` in both
-- directions by `tests/db/test_replay_command_scope.py` rather than trusted
-- here — see THE TRIPWIRE below. The migration named against each function is
-- the one that LAST declared it, which is where its prose lives; the body
-- reproduced below is the one Postgres actually has.
--
-- ─────────────────────────────── WHAT A MISMATCHED KEY DOES NOW, AND WHY
--
-- It RAISES `22023`, with `hq_command_replay`'s message verbatim:
--
--     idempotency key already used by <that command> — <this command> cannot
--     replay it
--
-- The alternative was to add `and command = '<this command>'` to the WHERE
-- clause and let a mismatch fall through to a fresh execution. That reads
-- smaller and it is WRONG, for a reason that is in the bodies below rather than
-- in theory: every one of these functions ends by storing its result with
--
--     insert into public.command_idempotency (user_id, idem_key, command, result)
--     values (v_user, p_idem, '<this command>', v_result)
--     on conflict (user_id, idem_key) do nothing;
--
-- and the primary key is `(user_id, idem_key)`. A second command falling
-- through would therefore WRITE and then silently fail to record its result, so
-- the next retry of that same command would apply a SECOND time — a duplicate
-- `application_notes` row, a duplicate audit event, a bumped `updated_at` that
-- invalidates every other tab's version token. Trading "the wrong result" for
-- "a command that accepts an idempotency key and does not honour it" is not a
-- fix. `0026_resume.sql` already settled the question for the family it built:
-- "REFUSE, do not silently re-key. A key reused for another command or another
-- payload is a client bug." This makes the older family say the same sentence.
--
-- Refusing also makes the eventual adoption of `hq_command_replay` (route (c),
-- opportunistic, per function) a pure refactor rather than a second behaviour
-- change on the same code path.
--
-- Both halves of the shape matter and only one of them is new: a key reused for
-- the SAME command still replays exactly as it did, which is every idempotency
-- test in `tests/db` and the entire reason `p_idem` exists.
--
-- ──────────────────────────── THE CALLER HUNT, BEFORE THE PREDICATE LANDED
--
-- The decision required this and it is the reason the change is safe: a lane
-- that DELIBERATELY mints one key per user-gesture and routes it through two
-- different commands would be broken by this file, and finding it afterwards is
-- finding it in production. Swept, before writing a line:
--
--   * CLIENT KEY DERIVATION. Every minting site in `webapp/` is one of three
--     shapes and all three are one-key-to-one-RPC: a fresh `crypto.randomUUID()`
--     per gesture; a ref-held key nulled on success; or a key SELECTED by a
--     stable gesture identity but still a fresh UUID
--     (`settings/preferences-form.tsx` `keyFor`). The closest thing to a
--     crossing is `jobs/save-view-dialog.tsx`, which shares one ref between
--     create and update — both of which are `app_save_view`. Two warm actions
--     (`pinWarmIntroAction`, `addWarmIntroAction`) share `app_pin_warm_intro`:
--     same command, different arguments, unaffected here (they WOULD need
--     distinct keys if that function ever gained a `request_hash`).
--
--   * THE OUTBOX. There is none: #222 deleted the localStorage mutation queue,
--     CLAUDE.md forbids a new one, and what remains is a janitor that clears
--     what it left behind. No retry wrapper falls back from one command to
--     another; `import/run.ts` rotates its key per chunk and mints a fresh one
--     for undo.
--
--   * THE DIGEST AND EMAIL LANES. The digest key is the signed token's `jti`
--     and reaches exactly one RPC, `hq_digest_set_triage`; undo mints a FRESH
--     token with a fresh `jti` rather than replaying the original inverted
--     (`webapp/lib/digest/handler.ts`). `hq_apply_email_event` derives its own
--     namespaced `'join:'` key, used by nothing else in the repo.
--     `20260813_055534_email_sends.sql` does not touch `command_idempotency` at
--     all — its latch is its own `send_key`.
--
--   * SERVER-SIDE COMPOSITION. One composed command exists,
--     `app_settle_autopilot_handoff`, and it deliberately does NOT pass its
--     `p_idem` down: both inner calls mint `gen_random_uuid()` keys, for the
--     pre-seeding reason `20260814_030545` writes out at length. The only other
--     `p_idem` pass-through, `hq_note_unapplied_event`, writes the key into an
--     `events` payload and never into `command_idempotency`.
--
--   * TESTS. Every replay test in `tests/db` reuses its key against the SAME
--     command. Three tests already assert the REFUSAL this file generalises —
--     `test_add_job.py::test_a_key_minted_by_another_command_is_refused`,
--     `test_autopilot_staging.py::test_a_key_reused_across_commands_is_refused`,
--     and the handoff suite's cross-command case — all against post-0026
--     commands. Not one test asserts the behaviour this file removes.
--
-- VERDICT: no caller relies on cross-command replay. The bug is reachable and
-- unclaimed.
--
-- ──────────────────────────────────────── WHY ROUTE (d), NOT (a) OR (b)
--
-- (a) FULL — re-declare all 29 onto `hq_command_replay`. Closes more: it would
--     bring the entitlement gate and the `request_hash` comparison with it. It
--     is also the blast radius `0027_entitlement.sql` rejected by name, it
--     requires each function to compute a fingerprint over its own arguments
--     (29 new decisions about what is IN the fingerprint, each of which can be
--     wrong in a way that raises on a legitimate retry), and it is not needed to
--     stop the bypass. Kept as route (c): adopt the primitive opportunistically,
--     one function at a time, now that doing so is a pure refactor.
--
-- (b) `FORCE ROW LEVEL SECURITY` on `command_idempotency`. Rejected and staying
--     rejected: it reaches the digest and email lanes and every command's own
--     idempotency insert, and it is SILENTLY INERT if the owning role holds
--     `BYPASSRLS`. A control that can be green and off is the worst kind.
--
-- (d) is one predicate's worth of behaviour per lookup, against a column that
--     is already `not null` and already populated — no schema change, no
--     backfill, no nullable-transition window.
--
-- ────────────────────────────────── BYTE-IDENTICAL, AND HOW THAT IS KNOWN
--
-- Reviewing 29 re-declared bodies by eye is how a second change rides in
-- unnoticed, so the claim is mechanical rather than assured. Each body below was
-- extracted from the migration that last declared it, transformed by one script,
-- applied to a database carrying every migration, and its `pg_proc.prosrc`
-- diffed against the definition that was live a moment earlier. The only
-- permitted diff lines are the ones this file adds; anything else fails the
-- comparison. `pg_proc.prosecdef`, `provolatile`, `proconfig`, the argument
-- list, the result type, `proacl` and the catalog comment were compared too, and
-- are unchanged for all 39 functions that touch the table.
--
-- Per lookup the edit is exactly this, and nothing else in the body moves:
--
--     -  select result into v_result
--     +  select result, command into v_result, v_replay_command
--          from public.command_idempotency
--         where <the predicate this function already had, verbatim>;
--        if found then
--     +    -- #288: a key owned by another command is not this command's replay.
--     +    if v_replay_command is distinct from '<this command>' then
--     +      raise exception
--     +        'idempotency key already used by % — % cannot replay it',
--     +        v_replay_command, '<this command>'
--     +        using errcode = '22023';
--     +    end if;
--          return v_result;
--        end if;
--
-- plus one declaration, `v_replay_command text`, above each body's `begin`.
--
-- The comparison is a SELECT and a raise, not an extra WHERE predicate, for one
-- reason worth naming: `hq_digest_set_triage` already carries a THIRD predicate,
-- `result->>'posting_key' = p_posting_key` (0019, review m1), whose documented
-- behaviour on a mismatch is to fall through rather than raise. Putting the
-- command comparison after the lookup leaves that predicate and that
-- fall-through untouched, and gives every one of the 49 sites the same shape.
--
-- `create or replace function` preserves the ACL and the catalog comment, so
-- neither is restated here: browser grants are exactly what each declaring
-- migration set, and the comments still describe these functions correctly
-- ("idempotent on p_idem" was always meant per command; it is now true).
--
-- ─────────────────────────────────────────────────── ORDER, AND THE METERS
--
-- `20260817_011844_per_user_rate_bounds.sql` decision 4 fixes the order every
-- command preserves: validate, lock, THE LAST REPLAY CHECK, charge the meter,
-- then the guarded write. This change is strictly inside the replay check, so a
-- refused key is refused above every charge and every write: it consumes no
-- rate-bound unit and leaves no counter row. `app_start_warm_search` is the one
-- function in this set that charges a meter today, and it keeps that order.
--
-- ───────────────────────────────────────── WHAT THIS CLOSES, AND WHAT IT DOES NOT
--
-- CLOSED, and #256's residual with it: a suspended account can no longer reach a
-- POST-0026 command's stored result through a pre-0026 sibling. The key it holds
-- belongs to `app_add_job`; `app_save_view` now refuses it instead of answering
-- with it. `docs/specs/user-entitlement.md`'s "does not hold yet" and
-- `docs/specs/write-path.md`'s "aspirational until #288" are retired in this
-- commit.
--
-- CLOSED: the correctness half, for everybody. One key, one command.
--
-- NOT CLOSED, and stated plainly so nobody quotes the paragraph above as more
-- than it is: these 29 functions still do not check ENTITLEMENT in their replay
-- path. A suspended account replaying its OWN key against the SAME pre-0026
-- command still receives its own stored result, because the lookup returns above
-- every write and no trigger fires on a read. That is the ordinary shape #288
-- was originally about, it is bounded to the account's own prior results, and it
-- closes for good as these functions adopt `hq_command_replay` (route (c)).
-- `tests/db/test_replay_command_scope.py` asserts the boundary in both
-- directions so the difference cannot be mistaken for the guarantee.
--
-- ─────────────────────────────────────────────────────────────── THE TRIPWIRE
--
-- `tests/db/test_replay_command_scope.py` derives BOTH families from `pg_proc` —
-- the callers of `hq_command_replay` and the carriers of the inline shape — and
-- holds the 29 as a baseline that may only SHRINK, the
-- `scripts/assertion_lint_baseline.json` precedent. A NEW command written in the
-- inline shape fails immediately; a function that leaves the set fails until its
-- entry is deleted in the same commit. That is what makes route (c) safe to do
-- opportunistically: the set cannot grow behind anybody's back.

-- ============================================================== the 29 bodies

-- ── app_add_note — 0010_pipeline.sql ───────────────────────────────────
-- 2 lookups. Body verbatim from 0010_pipeline.sql; the prose that
-- explains this function lives there.
create or replace function public.app_add_note(
  p_application_id bigint,
  p_body           text,
  p_idem           text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.applications;
  v_result jsonb;
  v_body   text := public.hq_blank_trim(p_body);
  v_id     bigint;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  -- Refused BEFORE any write. The table's CHECK would catch it too, but as a
  -- constraint violation rendered to a person as a wall of Postgres text.
  if v_body = '' then
    raise exception 'a note needs something in it' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception 'note is too long (max 4000 characters)' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_add_note' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_add_note'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Locked even though nothing on the row is updated: it is what serialises two
  -- concurrent notes on one application so the post-lock replay check below can
  -- do its job, and it proves the application exists and is this user's.
  select * into v_row
    from public.applications
   where user_id = v_user and id = p_application_id
     for update;
  if not found then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_add_note' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_add_note'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  insert into public.application_notes (user_id, application_id, body, author)
  values (v_user, p_application_id, v_body, 'user')
  returning id into v_id;

  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user, 'action.note', v_row.posting_key, v_row.id,
    jsonb_build_object('note_id', v_id, 'idem', p_idem),
    'user'
  );

  v_result := public.app_application_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_add_note', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_clear_connections — 0013_referral.sql ──────────────────────────
-- 1 lookup. Body verbatim from 0013_referral.sql; the prose that
-- explains this function lives there.
create or replace function public.app_clear_connections(p_idem text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_result  jsonb;
  v_deleted int;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_clear_connections' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_clear_connections'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  delete from public.connections where user_id = v_user;
  get diagnostics v_deleted = row_count;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'connections.cleared',
          jsonb_build_object('deleted', v_deleted), 'user');

  v_result := jsonb_build_object('deleted', v_deleted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_clear_connections', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_commit_profile — 0012_profile.sql ──────────────────────────────
-- 2 lookups. Body verbatim from 0012_profile.sql; the prose that
-- explains this function lives there.
create or replace function public.app_commit_profile(
  p_criteria            jsonb,
  p_notify              jsonb,
  p_regate              jsonb,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_row       public.profiles;
  v_before    jsonb;
  v_result    jsonb;
  v_plan      jsonb := coalesce(p_regate, '[]'::jsonb);
  v_restamped int := 0;
  v_newly     text[] := array[]::text[];
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  -- Unreachable through the app and kept anyway: `authenticated` is the only
  -- role granted execute, so `auth.uid()` is non-null for every caller that can
  -- get this far. Removing it therefore breaks nothing TODAY, which is exactly
  -- why it is here — the day a service-role path or a new grant appears, this is
  -- the line that refuses to write a row with a null `user_id`. Pinned textually
  -- by `test_definer_functions_never_take_a_user_id`, which requires every
  -- callable definer to read `auth.uid()`.
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- The blank key matters as much as the missing one: `command_idempotency`'s
  -- primary key is (user_id, idem_key) and `''` is a perfectly legal text value,
  -- so one caller sending an empty key would have every LATER empty key replay
  -- the first gesture's result forever. The client mints a uuid; this is the
  -- door, not the convention.
  -- `hq_blank_trim`, not `length(p_idem) = 0`. A key of one space is blank to a
  -- person and length 1 to Postgres, and it is the same shape 0010 shipped a bug
  -- on: `btrim()` with no argument trims spaces only, so a key of one NEWLINE
  -- reads as content everywhere it is compared (matrix rows 110, 129). The other
  -- write functions still use the bare length check; this is the tighter door and
  -- the one worth copying outward.
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if p_criteria is null or jsonb_typeof(p_criteria) <> 'object' then
    raise exception 'criteria must be an object' using errcode = '22023';
  end if;

  -- Bounded, because this is stored VERBATIM and the function is granted to
  -- `authenticated`. `parseCriteria` caps every field on the way through the
  -- server action, but the action is one caller: anyone with a session can post
  -- straight to /rest/v1/rpc, and an unbounded jsonb column write is a row a
  -- browser can make arbitrarily large. Both dimensions are checked, because
  -- either alone is trivially avoided — 100k one-byte keys, or one 10 MB string.
  -- The generous numbers are deliberate: a real profile is ~1 kB across 15 keys,
  -- so nothing legitimate is anywhere near these.
  if pg_column_size(p_criteria) > 65536 then
    raise exception 'criteria too large: % bytes', pg_column_size(p_criteria)
      using errcode = '22023';
  end if;

  if (select count(*) from jsonb_object_keys(p_criteria)) > 200 then
    raise exception 'criteria has too many keys' using errcode = '22023';
  end if;

  -- An empty object is the NEVER-ONBOARDED sentinel the middleware redirect
  -- reads. Writing one would send a user who has just finished the wizard
  -- straight back into it, forever, with nothing on screen to explain why.
  if p_criteria = '{}'::jsonb then
    raise exception 'criteria must not be empty' using errcode = '22023';
  end if;

  if p_notify is not null and jsonb_typeof(p_notify) <> 'object' then
    raise exception 'notify must be an object' using errcode = '22023';
  end if;

  -- Same reasoning, same door. `notify` is not edited by this phase at all, which
  -- makes it the easier one to forget.
  if p_notify is not null and pg_column_size(p_notify) > 65536 then
    raise exception 'notify too large: % bytes', pg_column_size(p_notify)
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_plan) <> 'array' then
    raise exception 'regate must be an array' using errcode = '22023';
  end if;

  -- A bound on a public endpoint. One user's whole set is a few thousand rows;
  -- 20,000 is generous and finite, which an unbounded array is not.
  if jsonb_array_length(v_plan) > 20000 then
    raise exception 'regate plan too large: %', jsonb_array_length(v_plan)
      using errcode = '22023';
  end if;

  -- Replay: return the first result rather than applying twice.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_commit_profile' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_commit_profile'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- No row is created at signup (`handle_new_auth_user` writes `users` only),
  -- so materialise one before locking it. `do nothing` rather than an existence
  -- check: two first-time commits racing must not both insert.
  insert into public.profiles (user_id, criteria, notify)
  values (v_user, '{}'::jsonb, '{}'::jsonb)
  on conflict (user_id) do nothing;

  select * into v_row from public.profiles where user_id = v_user for update;

  -- Re-check the key with the row LOCKED. The check above only settles
  -- sequential replays; two tabs flushing one outbox on the same 'online' event
  -- both pass it before either writes, and the loser would otherwise raise a
  -- phantom conflict or apply a second time against an append-only trail.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_commit_profile' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_commit_profile'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Optimistic concurrency, checked INSIDE the transaction that writes.
  --
  -- This compares INSTANTS, which is what matters: PostgREST renders `+00:00`,
  -- JavaScript's toISOString() renders `Z`, and `to_jsonb` renders whatever the
  -- session's TimeZone says — one moment, three strings, and comparing them as
  -- TEXT reports every save as a conflict (matrix rows 146, 168).
  --
  -- The `::timestamptz` casts are DECORATION and this comment used to imply they
  -- were the mechanism. They are not: `p_expected_updated_at` is DECLARED
  -- `timestamptz` and `profiles.updated_at` is a `timestamptz` column, so
  -- Postgres has already parsed both by the time this line runs and removing the
  -- casts changes nothing (the reviewer's `::text` mutant survives, correctly).
  -- What actually protects this is the PARAMETER TYPE — a `text` parameter here
  -- would reintroduce 0011's bug — and `test_the_version_token_is_declared_as_an_instant`
  -- pins that. The casts stay because they read as intent at the comparison site.
  --
  -- The word "conflict" is load-bearing: supabase-source.ts matches on it.
  if p_expected_updated_at is not null
     and v_row.updated_at::timestamptz is distinct from p_expected_updated_at::timestamptz then
    raise exception 'conflict: this profile changed since you read it'
      using errcode = '40001';
  end if;

  v_before := to_jsonb(v_row.criteria);

  -- Lock every row the plan touches, in ASCENDING KEY ORDER, before any of them
  -- is written. Two tabs saving different profiles hand this function the same
  -- keys in whatever order their own reads produced, and each holding the row
  -- the other wants next is a 40P01 deadlock surfaced to a person as a generic
  -- failure for a perfectly valid gesture (matrix row 95).
  perform 1
     from public.user_postings up
    where up.user_id = v_user
      and up.posting_key in (
        select jsonb_array_elements(v_plan) ->> 'key'
      )
    order by up.posting_key
      for update;

  with plan as (
    select e ->> 'key'                     as key,
           e ->> 'disposition'             as disposition,
           coalesce(e ->> 'reason', '')    as reason
      from jsonb_array_elements(v_plan) e
  ),
  -- Read the BEFORE state in the same statement, so it comes from the same
  -- snapshot the UPDATE started from. Reading it afterwards would report every
  -- row as unchanged.
  before as (
    select up.posting_key, up.disposition as was
      from public.user_postings up
      join plan pl on pl.key = up.posting_key
     where up.user_id = v_user
  ),
  applied as (
    update public.user_postings up
       set disposition        = pl.disposition,
           disposition_reason = pl.reason,
           updated_at         = now()
      from plan pl
     where up.user_id = v_user
       and up.posting_key = pl.key
       -- G8. The whole mechanism, and the reason it is here and not only in the
       -- client: a decided row is the user's.
       and up.triage = ''
       -- The plan was built against a read; only apply what still differs.
       and (up.disposition, up.disposition_reason)
             is distinct from (pl.disposition, pl.reason)
       and pl.disposition in ('qualified', 'filtered', 'needs-info')
       -- 0002's `filtered_rows_state_a_reason`, checked rather than tripped.
       and (pl.disposition <> 'filtered' or pl.reason <> '')
    returning up.posting_key, up.disposition
  )
  select count(*)::int,
         coalesce(
           array_agg(a.posting_key order by a.posting_key)
             filter (where a.disposition = 'qualified' and b.was <> 'qualified'),
           array[]::text[])
    into v_restamped, v_newly
    from applied a
    join before b on b.posting_key = a.posting_key;

  update public.profiles
     set criteria = p_criteria,
         notify   = coalesce(p_notify, notify)
   where user_id = v_user
  returning * into v_row;

  -- ONE event for the save, whatever it touched. The row and its audit event go
  -- in the same function body or the trail has holes in it.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'profile.changed',
          jsonb_build_object(
            'before',               v_before,
            'after',                p_criteria,
            'restamped_n',          v_restamped,
            'newly_qualified_keys', to_jsonb(v_newly)),
          'user');

  v_result := jsonb_build_object(
                'profile',              public.app_profile_row(v_row),
                'restamped',            v_restamped,
                'newly_qualified_keys', to_jsonb(v_newly));

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_commit_profile', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_delete_answer — 0017_answer_scope.sql ──────────────────────────
-- 2 lookups. Body verbatim from 0017_answer_scope.sql; the prose that
-- explains this function lives there.
create or replace function public.app_delete_answer(
  p_question text,
  p_company  text,
  p_idem     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_company text := public.company_name_key(coalesce(p_company, ''));
  v_key     text := public.hq_question_key(coalesce(p_question, ''));
  v_result  jsonb;
  v_deleted boolean := false;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if v_key = '' then
    raise exception 'question must contain letters or digits' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_delete_answer' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_delete_answer'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Lock the row (if any) before re-checking the key, so two tabs replaying one
  -- outbox serialise here rather than both deciding they are the first.
  perform 1 from public.answers
    where user_id = v_user and question_key = v_key and company_key = v_company
      for update;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_delete_answer' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_delete_answer'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  delete from public.answers
   where user_id = v_user and question_key = v_key and company_key = v_company;
  v_deleted := found;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.answer_deleted',
          jsonb_build_object('questionKey', v_key, 'companyKey', v_company,
                             'deleted', v_deleted),
          'user');

  v_result := jsonb_build_object('deleted', v_deleted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_delete_answer', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_delete_policy_rule — 0014_apply_answers.sql ────────────────────
-- 2 lookups. Body verbatim from 0014_apply_answers.sql; the prose that
-- explains this function lives there.
create or replace function public.app_delete_policy_rule(
  p_topic   text,
  p_company text,
  p_idem    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_company text := public.company_name_key(coalesce(p_company, ''));
  v_topic   text := public.hq_blank_trim(coalesce(p_topic, ''));
  v_result  jsonb;
  v_deleted boolean := false;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_delete_policy_rule' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_delete_policy_rule'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Lock the row (if any) before re-checking the key, so two tabs replaying one
  -- outbox serialise here rather than both deciding they are the first.
  perform 1 from public.answer_policies
    where user_id = v_user and topic = v_topic and company_key = v_company
      for update;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_delete_policy_rule' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_delete_policy_rule'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  delete from public.answer_policies
   where user_id = v_user and topic = v_topic and company_key = v_company;
  v_deleted := found;

  -- An event even when nothing was deleted. "Somebody asked to remove a rule
  -- that was not there" is a real thing to be able to read afterwards.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.policy_deleted',
          jsonb_build_object('topic', v_topic, 'companyKey', v_company, 'deleted', v_deleted),
          'user');

  v_result := jsonb_build_object('deleted', v_deleted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_delete_policy_rule', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_delete_view — 0005_saved_views.sql ─────────────────────────────
-- 1 lookup. Body verbatim from 0005_saved_views.sql; the prose that
-- explains this function lives there.
create or replace function public.app_delete_view(
  p_id   uuid,
  p_idem text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_name   text;
  v_result jsonb;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_delete_view' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_delete_view'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  delete from public.saved_views
   where id = p_id and user_id = v_user
   returning name into v_name;
  if not found then
    raise exception 'no such view for this user: %', p_id using errcode = 'P0002';
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'view.deleted',
          jsonb_build_object('view_id', p_id, 'name', v_name, 'idem', p_idem),
          'user');

  v_result := jsonb_build_object('deleted', p_id);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_delete_view', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_import_commit_chunk — 20260813_011502_import_unset_marker.sql ───
-- 2 lookups. Body verbatim from 20260813_011502_import_unset_marker.sql; the prose that
-- explains this function lives there.
create or replace function public.app_import_commit_chunk(
  p_batch uuid,
  p_limit integer,
  p_idem  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user       uuid := auth.uid();
  v_batch      public.import_batches;
  v_result     jsonb;
  v_row        public.import_rows;
  v_app        public.applications;
  v_limit      integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_unresolved integer;
  v_created    integer := 0;
  v_updated    integer := 0;
  v_skipped    integer := 0;
  v_failed     integer := 0;
  v_remaining  integer;
  v_company    text;
  v_title      text;
  v_url        text;
  v_status     text;
  v_note       text;
  v_next       text;
  v_next_date  date;
  v_applied    date;
  v_before     jsonb;
  v_new_id     bigint;
  v_roundtrip  boolean;
  v_write_stat boolean;
  v_ids        bigint[];
  v_id         bigint;
  v_locked     text[] := '{}';
  -- The columns this row actually wrote, so the report counts what landed
  -- rather than what the file offered.
  v_wrote      text[];
  -- The marker: columns it was refused on, whether each clearable one carries
  -- it, and the columns a row actually cleared.
  v_marked      text[];
  v_clear_next  boolean;
  v_clear_ndate boolean;
  v_clear_adate boolean;
  v_cleared     text[];
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_import_commit_chunk' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_import_commit_chunk'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);

  -- Re-check behind the lock (0003:166-182). A chunk that times out on the
  -- client and is retried arrives while the original is still running; without
  -- this the retry commits the same 200 rows a second time.
  select result, command into v_result, v_replay_command from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_import_commit_chunk' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_import_commit_chunk'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- A chunk arriving after the batch already finished is "already done", not an
  -- error. It is what a lost response, a double-click on Commit, or a second tab
  -- unblocking behind the batch lock all look like, and answering a gesture that
  -- worked with a red toast is the version of this people notice. 0010's
  -- app_resolve_suggestion settles the same question the same way.
  if v_batch.state = 'committed' then
    v_result := jsonb_build_object(
      'batch', public.app_import_batch_row(v_batch),
      'created', 0, 'updated', 0, 'skipped', 0, 'failed', 0, 'remaining', 0);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_import_commit_chunk', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;
  if v_batch.state not in ('previewed', 'committing') then
    raise exception 'this import is not ready to commit (state %)', v_batch.state
      using errcode = '22023';
  end if;

  select count(*) into v_unresolved from public.import_rows
   where batch_id = p_batch and conflict_state = 'unresolved' and included;
  if v_unresolved > 0 then
    raise exception '% rows still have unresolved conflicts — resolve them before committing', v_unresolved
      using errcode = '22023';
  end if;

  if v_batch.state = 'previewed' then
    update public.import_batches
       set state = 'committing',
           committed_at = coalesce(committed_at, now()),
           -- The undo window opens when the first chunk lands, and is read from
           -- THIS ROW forever after. A client clock is not evidence of anything.
           undo_expires_at = coalesce(undo_expires_at, now() + interval '24 hours')
     where id = p_batch
     returning * into v_batch;
  end if;

  -- Pre-lock every application this chunk will touch, in ascending id order.
  --
  -- Two batches committing concurrently and touching the same applications in
  -- different orders is a 40P01 deadlock, surfaced to a person as a generic
  -- failure on a perfectly valid gesture (matrix row 95, which cost /companies
  -- a fix pass). Ordering the locks removes the cycle by construction.
  select array_agg(distinct matched_application_id order by matched_application_id)
    into v_ids
    from (select matched_application_id from public.import_rows
           where batch_id = p_batch and outcome = 'pending' and included
             and matched_application_id is not null
           order by row_number limit v_limit) s;
  if v_ids is not null then
    foreach v_id in array v_ids loop
      perform 1 from public.applications where id = v_id and user_id = v_user for update;
    end loop;
  end if;

  for v_row in
    select * from public.import_rows
     where batch_id = p_batch and outcome = 'pending' and included
     order by row_number
     limit v_limit
  loop
    v_company   := public.hq_import_mapped_value(v_row.mapped, 'company');
    v_title     := public.hq_import_mapped_value(v_row.mapped, 'title');
    v_url       := left(public.hq_import_mapped_value(v_row.mapped, 'url'), 2000);
    v_status    := left(public.hq_import_mapped_value(v_row.mapped, 'status'), 80);
    v_note      := left(public.hq_import_mapped_value(v_row.mapped, 'notes'), 4000);
    v_next      := left(public.hq_import_mapped_value(v_row.mapped, 'next_action'), 500);
    v_next_date := public.hq_import_date(v_row.mapped, 'next_action_date');
    v_applied   := public.hq_import_date(v_row.mapped, 'applied_date');

    -- The refusal scan (marker contract, part 3). The column list is the whole
    -- vocabulary `hq_import_mapped_value` translates — a marker in any of them
    -- that is not clearable is refused BY NAME. A marker in a column the
    -- mapping never reached does not exist here: an unmapped cell never enters
    -- `mapped`, and the mapping step already reported its column as going
    -- nowhere.
    select array_agg(col order by col) into v_marked
      from unnest(array['company', 'title', 'url', 'location', 'status', 'notes',
                        'next_action', 'next_action_date', 'applied_date',
                        'hq_id', 'hq_version']) as col
     where public.hq_import_mapped_value(v_row.mapped, col) = public.hq_import_unset_marker()
       and not (col = any (public.hq_import_clearable_columns()));

    -- The clear flags (marker contract, part 2) — read from the RAW mapped
    -- text, because `hq_import_date` reads the marker as null and a null date
    -- is exactly what a blank cell produces. The text one is blanked
    -- immediately so no later branch can write the literal.
    v_clear_next  := v_next = public.hq_import_unset_marker();
    v_clear_ndate := public.hq_import_mapped_value(v_row.mapped, 'next_action_date')
                     = public.hq_import_unset_marker();
    v_clear_adate := public.hq_import_mapped_value(v_row.mapped, 'applied_date')
                     = public.hq_import_unset_marker();
    if v_clear_next then v_next := ''; end if;

    -- A round trip is only a human gesture while it carries the PROOF that
    -- makes it one: this row's own version token, either matching (no conflict
    -- was raised) or explicitly answered in the resolver. A file whose
    -- `hq_version` column was deleted still matches by `hq_id`, but it is no
    -- longer evidence that anybody read the current value — so it writes like a
    -- plain import and claims nothing.
    v_roundtrip := v_row.match_kind = 'round-trip'
                   and (public.hq_import_mapped_value(v_row.mapped, 'hq_version') <> ''
                        or v_row.conflict_state = 'resolved');

    -- Per-cell choices from the resolver, FAIL CLOSED (the #236 security
    -- review's finding, closed here).
    --
    -- A resolved row is exempt from the version re-check below — the raised
    -- conflict is WHY the resolver ran — so for a resolved row, THIS block is
    -- the only thing standing between the file and a value somebody edited
    -- after the export. The first version keyed on an explicit 'mine' answer,
    -- which meant a PARTIAL resolve (app_import_resolve accepts any subset of
    -- the writable columns, including '{}') flipped the row to 'resolved' and
    -- every UNANSWERED conflicted cell then wrote through the exemption: stale
    -- typed text overwrote a newer edit, and an unanswered marker cell ERASED
    -- one. Silent destruction through the guard built to prevent it.
    --
    -- So the rule is now: a conflicted cell writes ONLY on an explicit
    -- 'theirs'. Unanswered means 'mine' — the value is kept, the clear is
    -- cancelled — and 'mine' still means 'mine'. A choice for a cell that was
    -- never in conflict keeps its old meaning (an explicit 'mine' discards a
    -- value that agreed anyway; harmless), so this is strictly narrower in the
    -- direction that writes.
    --
    -- `app_import_resolve` deliberately still ACCEPTS a partial set rather
    -- than rejecting one: the write-side guarantee has to live in the commit
    -- regardless (the resolve function cannot know what a later re-preview
    -- will find), and a second enforcement site is a second thing to drift.
    -- A bare '{}' therefore now means "keep every cell as it is", which is the
    -- safe reading of an empty answer.
    if v_row.conflict_state = 'resolved' then
      if ((v_row.conflict ? 'status')
          and (v_row.choices ->> 'status') is distinct from 'theirs')
         or v_row.choices ->> 'status' = 'mine' then
        v_status := '';
      end if;
      if ((v_row.conflict ? 'notes')
          and (v_row.choices ->> 'notes') is distinct from 'theirs')
         or v_row.choices ->> 'notes' = 'mine' then
        v_note := '';
      end if;
      if ((v_row.conflict ? 'next_action')
          and (v_row.choices ->> 'next_action') is distinct from 'theirs')
         or v_row.choices ->> 'next_action' = 'mine' then
        v_next := ''; v_clear_next := false;
      end if;
      if ((v_row.conflict ? 'next_action_date')
          and (v_row.choices ->> 'next_action_date') is distinct from 'theirs')
         or v_row.choices ->> 'next_action_date' = 'mine' then
        v_next_date := null; v_clear_ndate := false;
      end if;
      if ((v_row.conflict ? 'applied_date')
          and (v_row.choices ->> 'applied_date') is distinct from 'theirs')
         or v_row.choices ->> 'applied_date' = 'mine' then
        v_applied := null; v_clear_adate := false;
      end if;
    end if;

    if v_row.match_kind = 'duplicate-in-file' then
      update public.import_rows set outcome = 'skipped',
             error = 'skipped: an earlier row in this file is the same job'
       where batch_id = p_batch and row_number = v_row.row_number;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- The refusal lands AFTER the duplicate skip — a row that writes nothing
    -- has nothing to refuse — and BEFORE either write path, so a marker in the
    -- wrong column can neither create nor update anything.
    if v_marked is not null then
      update public.import_rows set outcome = 'failed',
             error = format('the unset marker can only clear %s — not %s',
                            array_to_string(public.hq_import_clearable_columns(), ', '),
                            array_to_string(v_marked, ', '))
       where batch_id = p_batch and row_number = v_row.row_number;
      v_failed := v_failed + 1;
      continue;
    end if;

    -- ---------------------------------------------------------- update path
    if v_row.matched_application_id is not null
       and v_row.match_kind in ('matches-existing', 'round-trip') then
      select * into v_app from public.applications
       where id = v_row.matched_application_id and user_id = v_user;
      if not found then
        update public.import_rows set outcome = 'failed',
               error = 'the application this row matched no longer exists'
         where batch_id = p_batch and row_number = v_row.row_number;
        v_failed := v_failed + 1;
        continue;
      end if;

      -- RE-CHECK THE VERSION TOKEN, HERE, INSIDE THE TRANSACTION THAT WRITES.
      -- 0011 explains the corruption this prevents (preview passes, a human
      -- edits, commit writes stale); the shape is app_set_status's. A RESOLVED
      -- row is exempt: its token is stale by definition — the raised conflict
      -- is WHY the resolver ran — and the resolution is a human gesture made
      -- against the current value, newer than any token in the file. The
      -- exemption is only safe because the choices block above FAILS CLOSED:
      -- a resolved row writes exactly the cells a person explicitly answered
      -- 'theirs', and nothing else rides through on the row's exemption.
      if v_roundtrip
         and v_row.conflict_state is distinct from 'resolved'
         and v_app.updated_at is distinct from public.hq_import_version(v_row.mapped) then
        update public.import_rows
           set outcome = 'failed',
               conflict_state = 'unresolved',
               error = 'this row changed after the preview and before this import '
                       || 'committed, so it was not written — re-import the file to '
                       || 'see the difference'
         where batch_id = p_batch and row_number = v_row.row_number;
        v_failed := v_failed + 1;
        continue;
      end if;

      -- The status question — 0011's rule, unchanged. A locked row
      -- (`status_actor='user'`) may only have its status changed by a declared
      -- human write; a round trip carrying this row's own token is one, a bulk
      -- import is not and reports the skip instead.
      v_write_stat := v_status <> '' and v_status is distinct from v_app.status;
      if v_write_stat and v_app.status_actor = 'user' and not v_roundtrip then
        v_write_stat := false;
        v_locked := v_locked || format('%s -> %s', v_app.status, v_status);
      end if;

      v_before := jsonb_build_object(
        'status', v_app.status, 'status_actor', v_app.status_actor,
        'next_action', v_app.next_action,
        'next_action_date', v_app.next_action_date,
        'applied_date', v_app.applied_date);

      -- What this row ACTUALLY cleared: marker present AND a live value
      -- erased. Clearing an already-empty field is a no-op, not a line in the
      -- report — the report counts what happened, not what the file offered.
      v_cleared := array_remove(array[
        case when v_clear_next  and v_app.next_action <> ''          then 'next_action' end,
        case when v_clear_ndate and v_app.next_action_date is not null then 'next_action_date' end,
        case when v_clear_adate and v_app.applied_date is not null     then 'applied_date' end
      ], null);

      if v_write_stat then
        perform set_config('hq.status_write', 'human', true);
      end if;
      update public.applications
         set status        = case when v_write_stat then v_status else status end,
             -- A round-trip status change IS a human gesture and claims the row,
             -- exactly as pressing the Select in the pipeline does. A bulk
             -- import never claims it: locking 2,000 rows against the engine is
             -- how an imported user stops receiving news about their own
             -- applications.
             status_actor  = case when v_write_stat and v_roundtrip then 'user' else status_actor end,
             status_set_at = case when v_write_stat and v_roundtrip then now() else status_set_at end,
             -- The marker clears; a blank preserves; text lands. In that order,
             -- because the marker was blanked out of `v_next` above and only
             -- the flag remembers it.
             next_action      = case when v_clear_next then ''
                                     when v_next <> '' then v_next
                                     else next_action end,
             next_action_date = case when v_clear_ndate then null
                                     else coalesce(v_next_date, next_action_date) end,
             applied_date     = case when v_clear_adate then null
                                     else coalesce(v_applied, applied_date) end,
             updated_at       = now()
       where id = v_app.id and user_id = v_user
       returning * into v_app;
      if v_write_stat then
        perform set_config('hq.status_write', '', true);
      end if;

      if v_note <> '' then
        insert into public.application_notes (user_id, application_id, body, author)
        values (v_user, v_app.id, v_note, 'import');
      end if;

      -- WHICH COLUMNS ACTUALLY LANDED, recorded per row. A cleared column is
      -- deliberately NOT in `wrote` — nothing was imported into it; the
      -- `cleared` list is its account.
      v_wrote := array_remove(array[
        case when v_write_stat then 'status' end,
        case when v_note <> '' then 'notes' end,
        case when v_next <> '' then 'next_action' end,
        case when v_next_date is not null then 'next_action_date' end,
        case when v_applied is not null then 'applied_date' end
      ], null);

      update public.import_rows
         set outcome = 'updated',
             revert = jsonb_build_object('before', v_before,
                                         'wrote', to_jsonb(v_wrote),
                                         'cleared', to_jsonb(v_cleared),
                                         'wrote_updated_at', v_app.updated_at)
       where batch_id = p_batch and row_number = v_row.row_number;
      v_updated := v_updated + 1;
      continue;
    end if;

    -- ---------------------------------------------------------- insert path
    if v_company = '' or v_title = '' then
      update public.import_rows set outcome = 'failed',
             error = 'a row needs both a company and a title'
       where batch_id = p_batch and row_number = v_row.row_number;
      v_failed := v_failed + 1;
      continue;
    end if;

    -- A marker on a NEW row clears nothing — there is nothing to clear — and
    -- lands as absent, which is what the flags already produced: `v_next` was
    -- blanked and the marker never parsed as a date. FP-SET-001's rule holds:
    -- absent imports as absent, and nothing is filled from a default.

    -- Reset before the insert. `INSERT ... RETURNING INTO` assigns nulls when
    -- nothing is inserted, but leaving that to the docs means the previous
    -- iteration's row is one behaviour change away from being counted as this
    -- one's — and the failure would be an application silently attributed to
    -- the wrong source row.
    v_app := null;
    insert into public.applications
      (user_id, posting_key, company, title, url, source, status, status_actor,
       applied_date, next_action, next_action_date, import_batch_id)
    values (
      v_user,
      -- Only when the sweep has actually seen this posting: the FK refuses
      -- anything else, and a failed FK would take the chunk down.
      (select p.key from public.postings p where p.key = v_row.job_key),
      left(v_company, 200), left(v_title, 200), v_url, 'import',
      -- An unmapped/unknown status has already become 'Inbox' in TypeScript
      -- (matrix row 43); a blank one here means the file had no status column.
      case when v_status <> '' then v_status else 'Inbox' end,
      -- NOT 'user'. An import is not a human status gesture; see 0011's header.
      'system',
      v_applied, v_next, v_next_date, p_batch)
    on conflict do nothing
    returning * into v_app;

    if v_app.id is null then
      update public.import_rows set outcome = 'skipped',
             error = 'skipped: you already have this company and title'
       where batch_id = p_batch and row_number = v_row.row_number;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_new_id := v_app.id;
    if v_note <> '' then
      insert into public.application_notes (user_id, application_id, body, author)
      values (v_user, v_new_id, v_note, 'import');
    end if;

    -- On the insert path every non-blank value went in by construction, so this
    -- is the same list read a different way rather than a second rule. A blank
    -- status became 'Inbox', which the file did not say, so it is not counted.
    v_wrote := array_remove(array[
      case when v_status <> '' then 'status' end,
      case when v_note <> '' then 'notes' end,
      case when v_next <> '' then 'next_action' end,
      case when v_next_date is not null then 'next_action_date' end,
      case when v_applied is not null then 'applied_date' end
    ], null);

    update public.import_rows
       set outcome = 'created',
           matched_application_id = v_new_id,
           revert = jsonb_build_object('created', v_new_id,
                                       'wrote', to_jsonb(v_wrote),
                                       'wrote_updated_at', v_app.updated_at)
     where batch_id = p_batch and row_number = v_row.row_number;
    v_created := v_created + 1;
  end loop;

  -- Rows the user excluded are settled here rather than left `pending` forever,
  -- or the batch could never reach `committed` and would show as half-done.
  update public.import_rows set outcome = 'skipped', error = 'excluded by you'
   where batch_id = p_batch and outcome = 'pending' and not included;

  select count(*) into v_remaining from public.import_rows
   where batch_id = p_batch and outcome = 'pending';

  -- A status somebody had chosen by hand, left alone and reported. Merged into
  -- whatever earlier chunks recorded, because the report is per BATCH.
  if array_length(v_locked, 1) is not null then
    insert into public.import_column_reports
      (batch_id, user_id, column_name, disposition, rows_affected, sample)
    values (p_batch, v_user, 'Status', 'locked', array_length(v_locked, 1),
            to_jsonb(v_locked[1:3]))
    -- Accumulated across chunks, because the report is per BATCH and a locked
    -- row in chunk 7 must not erase the count from chunk 1.
    on conflict (batch_id, column_name, disposition) do update
      set rows_affected = import_column_reports.rows_affected + excluded.rows_affected,
          sample        = case when jsonb_array_length(import_column_reports.sample) >= 3
                               then import_column_reports.sample
                               else excluded.sample end;
  end if;

  update public.import_batches
     set committed_count = (select count(*) from public.import_rows
                             where batch_id = p_batch and outcome <> 'pending'),
         state = case when v_remaining = 0 then 'committed' else 'committing' end
   where id = p_batch
   returning * into v_batch;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'import.committed',
          jsonb_build_object('batch', p_batch, 'created', v_created, 'updated', v_updated,
                             'skipped', v_skipped, 'failed', v_failed,
                             'remaining', v_remaining, 'idem', p_idem),
          'user');

  v_result := jsonb_build_object(
    'batch', public.app_import_batch_row(v_batch),
    'created', v_created, 'updated', v_updated, 'skipped', v_skipped,
    'failed', v_failed, 'remaining', v_remaining);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_import_commit_chunk', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_import_connections — 0013_referral.sql ─────────────────────────
-- 1 lookup. Body verbatim from 0013_referral.sql; the prose that
-- explains this function lives there.
create or replace function public.app_import_connections(
  p_rows   jsonb,
  p_source text,
  p_idem   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_result    jsonb;
  v_source    text;
  v_named     int;
  v_inserted  int := 0;
  v_updated   int := 0;
  v_ins2      int := 0;
  v_upd2      int := 0;
  v_total     int;
  MAX_CHUNK   constant int := 1000;
  --: The provenance tags this door accepts. Closed for `ALLOWED_SOURCES`' reason
  --: in 0008: `source` is a reporting dimension, and a function granted to
  --: `authenticated` with an unbounded string writes a novel into a group-by.
  ALLOWED_SOURCES constant text[] := array['linkedin-export', 'manual', 'import'];
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- `hq_blank_trim`, not `length() = 0`: `command_idempotency`'s primary key is
  -- (user_id, idem_key) and a key of one space is blank to a person and length 1
  -- to Postgres, so one caller sending it would have every LATER blank key
  -- replay this gesture's result forever (matrix row 218).
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;

  v_total := jsonb_array_length(p_rows);
  if v_total > MAX_CHUNK then
    raise exception 'too many connections in one call (limit %)', MAX_CHUNK
      using errcode = '22023';
  end if;

  v_source := lower(public.hq_blank_trim(coalesce(p_source, '')));
  if v_source = '' then
    v_source := 'linkedin-export';
  end if;
  if not (v_source = any (ALLOWED_SOURCES)) then
    raise exception 'unknown source tag: %', left(v_source, 60) using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_import_connections' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_import_connections'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Lines that name somebody. The difference from `v_total` is the nameless
  -- ones, and it is a separate number from the duplicates because the two mean
  -- different things to the person reading the report.
  select count(*) into v_named from public.hq_connection_rows(p_rows) r;

  -- Take every lock this chunk needs FIRST, in identity order, before anything
  -- is written. Two tabs replaying one outbox hand this function overlapping
  -- chunks in whatever order their own reads produced, and each holding the row
  -- the other wants next is a 40P01 deadlock surfaced to a person as a generic
  -- failure for a perfectly valid gesture (matrix rows 95, 191).
  --
  -- `for update of c`: FOR UPDATE cannot be applied to a function scan, so
  -- leaving the target off would try to lock `hq_connection_rows`' output too.
  --
  -- The second branch is NOT gated on `i.profile_url = ''`, and that widening is
  -- the promotion below's lock: a URL-bearing line can match a URL-LESS row held
  -- for the same person, and a row that is about to be updated has to be locked
  -- with the rest of the chunk.
  perform 1
     from public.connections c
     join public.hq_connection_rows(p_rows) i
       on (i.profile_url <> '' and lower(c.profile_url) = lower(i.profile_url))
       or (c.profile_url = ''
           and lower(public.hq_blank_trim(c.full_name)) = lower(i.full_name)
           and c.company_key = public.company_name_key(i.company))
    where c.user_id = v_user
      and not i.is_dupe
    order by c.id
      for update of c;

  -- PROMOTION: a row this person already has under no URL, matched by a line
  -- that now carries one.
  --
  -- The two partial indexes leave a gap between them in BOTH directions and the
  -- first version of this function closed only one. LinkedIn withholds a
  -- connection's URL while they have it restricted; they un-restrict it; next
  -- month's export carries the URL — and `connections_by_profile` sees no
  -- conflict with a row whose `profile_url` is `''`, so the same human lands
  -- twice and can never merge again. Both reports say `deduped: 0`, so nothing
  -- on screen says anything went wrong and the person is double-counted in every
  -- warm-path popover from then on.
  --
  -- Promoted rather than deleted-and-reinserted: the stored row may hold a
  -- `connected_on` this line does not, and the whole point of the blank rule is
  -- that an import never destroys what the file did not say.
  --
  -- The `not exists` is the collision this creates: if a URL-bearing row for
  -- that same URL ALREADY exists, promoting would violate `connections_by_profile`
  -- and abort the chunk. That case leaves the URL-less row alone; it is then a
  -- genuine duplicate the person can clear and re-import.
  --
  -- `distinct on` is what makes the JOIN PARTNER deterministic. One chunk can
  -- legitimately carry two lines with two different URLs whose (name, company)
  -- normalize the same — two people with one name at one employer, which is why
  -- `connections_by_name` is documented as the weaker identity. A plain
  -- UPDATE … FROM would then have two candidate rows for one target and Postgres
  -- picks one arbitrarily, so the same file could promote to a different URL on
  -- two runs. Unreachable through the RPC as the wizard drives it and pinned
  -- anyway: the lowest URL wins, every time.
  update public.connections c
     set profile_url = i.profile_url
    from (
      select distinct on (lower(r.full_name), public.company_name_key(r.company))
             r.full_name, r.company, r.profile_url
        from public.hq_connection_rows(p_rows) r
       where r.profile_url <> '' and not r.is_dupe
       order by lower(r.full_name), public.company_name_key(r.company), lower(r.profile_url)
    ) i
   where c.user_id = v_user
     and c.profile_url = ''
     and lower(public.hq_blank_trim(c.full_name)) = lower(i.full_name)
     and c.company_key = public.company_name_key(i.company)
     and not exists (
           select 1 from public.connections x
            where x.user_id = v_user
              and x.profile_url <> ''
              and lower(x.profile_url) = lower(i.profile_url));

  -- Rows the export gave a profile URL: the URL is the person's identity.
  with upserted as (
    insert into public.connections
      (user_id, full_name, first_name, last_name, company, title, profile_url,
       connected_on, source)
    select v_user, i.full_name, i.first_name, i.last_name, i.company, i.title,
           i.profile_url, i.connected_on, v_source
      from public.hq_connection_rows(p_rows) i
     where i.profile_url <> '' and not i.is_dupe
     order by lower(i.profile_url)
    on conflict (user_id, lower(profile_url)) where profile_url <> ''
    do update set
      full_name    = case when excluded.full_name  <> '' then excluded.full_name
                          else connections.full_name end,
      first_name   = case when excluded.first_name <> '' then excluded.first_name
                          else connections.first_name end,
      last_name    = case when excluded.last_name  <> '' then excluded.last_name
                          else connections.last_name end,
      company      = case when excluded.company    <> '' then excluded.company
                          else connections.company end,
      title        = case when excluded.title      <> '' then excluded.title
                          else connections.title end,
      connected_on = coalesce(excluded.connected_on, connections.connected_on)
    returning (xmax = 0) as was_insert
  )
  select count(*) filter (where was_insert),
         count(*) filter (where not was_insert)
    into v_inserted, v_updated
    from upserted;

  -- Rows LinkedIn withheld a URL for. (name, company) is the best identity
  -- available, and the merge risk that carries is stated on the index.
  --
  -- The `not exists` closes the one gap the two partial indexes leave between
  -- them: `connections_by_name` is predicated on `profile_url = ''`, so a row
  -- this person ALREADY has with a URL cannot conflict with a URL-less line for
  -- the same human — and a person who removes their public URL between two
  -- monthly exports would otherwise arrive as a second row that never merges
  -- again. Skipped rather than merged: the row with the URL is the better
  -- record, and it is the one the deep link needs.
  with upserted as (
    insert into public.connections
      (user_id, full_name, first_name, last_name, company, title, profile_url,
       connected_on, source)
    select v_user, i.full_name, i.first_name, i.last_name, i.company, i.title,
           '', i.connected_on, v_source
      from public.hq_connection_rows(p_rows) i
     where i.profile_url = '' and not i.is_dupe
       and not exists (
             select 1 from public.connections x
              where x.user_id = v_user
                and x.profile_url <> ''
                and lower(public.hq_blank_trim(x.full_name)) = lower(i.full_name)
                and x.company_key = public.company_name_key(i.company))
     order by lower(i.full_name), public.company_name_key(i.company)
    on conflict (user_id, lower(public.hq_blank_trim(full_name)), company_key)
      where profile_url = ''
    do update set
      first_name   = case when excluded.first_name <> '' then excluded.first_name
                          else connections.first_name end,
      last_name    = case when excluded.last_name  <> '' then excluded.last_name
                          else connections.last_name end,
      title        = case when excluded.title      <> '' then excluded.title
                          else connections.title end,
      connected_on = coalesce(excluded.connected_on, connections.connected_on)
    returning (xmax = 0) as was_insert
  )
  select count(*) filter (where was_insert),
         count(*) filter (where not was_insert)
    into v_ins2, v_upd2
    from upserted;

  v_inserted := v_inserted + v_ins2;
  v_updated  := v_updated  + v_upd2;

  -- The row and its audit event in one body, or the trail has holes in it.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'connections.imported',
          jsonb_build_object('inserted', v_inserted,
                             'updated',  v_updated,
                             'skipped',  v_total - v_named,
                             'deduped',  v_named - v_inserted - v_updated,
                             'source',   v_source),
          'user');

  -- The four numbers add up to the file, on purpose: inserted + updated +
  -- skipped + deduped = rows in. A report that does not close is one nobody can
  -- check afterwards, because only the commit knows which bucket a line went to
  -- (matrix row 169).
  --
  -- `deduped` is derived by SUBTRACTION rather than counted, and that is what
  -- makes it close: it absorbs both ways a named line can land nowhere — the
  -- same person listed twice in this chunk, and a URL-less line shadowed by a
  -- record that already has the URL. Counting the first and forgetting the
  -- second is exactly how a report starts adding up to less than the file.
  v_result := jsonb_build_object('inserted', v_inserted,
                                 'updated',  v_updated,
                                 'skipped',  v_total - v_named,
                                 'deduped',  v_named - v_inserted - v_updated);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_import_connections', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_import_create — 0011_import.sql ────────────────────────────────
-- 1 lookup. Body verbatim from 0011_import.sql; the prose that
-- explains this function lives there.
create or replace function public.app_import_create(
  p_idem         text,
  p_filename     text,
  p_source_kind  text,
  p_content_hash text,
  p_row_count    integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_result   jsonb;
  v_row      public.import_batches;
  v_open     integer;
  v_name     text := public.hq_blank_trim(p_filename);
  MAX_ROWS   constant integer := 5000;
  MAX_OPEN   constant integer := 20;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_source_kind is null or p_source_kind not in ('xlsx', 'csv', 'paste') then
    raise exception 'unsupported import source: %', p_source_kind using errcode = '22023';
  end if;
  if length(v_name) > 300 then
    raise exception 'filename is too long' using errcode = '22023';
  end if;
  if length(coalesce(p_content_hash, '')) > 128 then
    raise exception 'content hash is too long' using errcode = '22023';
  end if;
  if coalesce(p_row_count, 0) < 0 then
    raise exception 'row count cannot be negative' using errcode = '22023';
  end if;
  -- The ROW cap, which the route also enforces — there, after parsing, because
  -- nothing can count a workbook's rows without opening it (the route's own
  -- inflated-size guard is what bounds that parse). Both, because the route is
  -- one caller and this function is granted to `authenticated`. Note this
  -- function sees only the count the caller declares: it re-enforces the row cap
  -- and nothing else, so the byte caps live entirely in the route.
  if coalesce(p_row_count, 0) > MAX_ROWS then
    raise exception 'that file has % rows; the limit is % — split it and import in parts',
      p_row_count, MAX_ROWS using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_import_create' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_import_create'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- The bound every fan-out gets. Twenty unfinished imports is not a workflow,
  -- it is a stuck user or a loop, and either is better answered than absorbed.
  select count(*) into v_open from public.import_batches
   where user_id = v_user and state in ('uploaded', 'mapped', 'previewed', 'committing');
  if v_open >= MAX_OPEN then
    raise exception 'you have % imports still in progress (limit %) — finish or discard one first',
      v_open, MAX_OPEN using errcode = '22023';
  end if;

  insert into public.import_batches
    (user_id, filename, source_kind, content_hash, row_count, idempotency_key)
  values (v_user, v_name, p_source_kind, coalesce(p_content_hash, ''),
          coalesce(p_row_count, 0), p_idem)
  returning * into v_row;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'import.created',
          jsonb_build_object('batch', v_row.id, 'filename', v_name,
                             'source_kind', p_source_kind, 'rows', v_row.row_count,
                             'content_hash', coalesce(p_content_hash, ''), 'idem', p_idem),
          'user');

  v_result := public.app_import_batch_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_import_create', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_import_discard — 0011_import.sql ───────────────────────────────
-- 2 lookups. Body verbatim from 0011_import.sql; the prose that
-- explains this function lives there.
create or replace function public.app_import_discard(
  p_batch uuid,
  p_idem  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_batch  public.import_batches;
  v_result jsonb;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_import_discard' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_import_discard'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);

  select result, command into v_result, v_replay_command from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_import_discard' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_import_discard'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  if v_batch.state in ('committing', 'committed', 'rolled_back') then
    raise exception 'this import has already written rows — undo it instead of discarding it'
      using errcode = '22023';
  end if;

  -- The event goes in BEFORE the delete: `events.application_id` is the only FK
  -- here and the payload carries the batch id as data, so the trail outlives the
  -- row. A discarded import still happened.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'import.discarded',
          jsonb_build_object('batch', p_batch, 'filename', v_batch.filename,
                             'state', v_batch.state, 'rows', v_batch.row_count,
                             'idem', p_idem),
          'user');

  delete from public.import_batches where id = p_batch and user_id = v_user;

  v_result := jsonb_build_object('discarded', p_batch);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_import_discard', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_import_undo — 0011_import.sql ──────────────────────────────────
-- 2 lookups. Body verbatim from 0011_import.sql; the prose that
-- explains this function lives there.
create or replace function public.app_import_undo(
  p_batch uuid,
  p_idem  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_batch    public.import_batches;
  v_result   jsonb;
  v_row      public.import_rows;
  v_app      public.applications;
  v_deleted  integer := 0;
  v_reverted integer := 0;
  v_kept     integer := 0;
  v_kept_ids bigint[] := '{}';
  v_notes    integer := 0;
  v_before   jsonb;
  v_ids      bigint[];
  v_id       bigint;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_import_undo' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_import_undo'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);

  select result, command into v_result, v_replay_command from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_import_undo' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_import_undo'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  if v_batch.state = 'rolled_back' then
    raise exception 'this import has already been undone' using errcode = '22023';
  end if;
  if v_batch.state not in ('committing', 'committed') then
    raise exception 'this import has not written anything to undo (state %)', v_batch.state
      using errcode = '22023';
  end if;
  -- Read from the ROW. A client that believes it is still Tuesday is not
  -- evidence, and the button being on screen is not authorisation.
  if v_batch.undo_expires_at is not null and now() > v_batch.undo_expires_at then
    raise exception 'the 24-hour undo window for this import closed at %', v_batch.undo_expires_at
      using errcode = '22023';
  end if;

  -- Ordered locking again: two undos, or an undo racing a commit chunk of
  -- another batch over the same applications, must not deadlock.
  select array_agg(distinct matched_application_id order by matched_application_id)
    into v_ids
    from public.import_rows
   where batch_id = p_batch and outcome in ('created', 'updated')
     and matched_application_id is not null;
  if v_ids is not null then
    foreach v_id in array v_ids loop
      perform 1 from public.applications where id = v_id and user_id = v_user for update;
    end loop;
  end if;

  for v_row in
    select * from public.import_rows
     where batch_id = p_batch and outcome in ('created', 'updated')
     order by row_number
  loop
    select * into v_app from public.applications
     where id = v_row.matched_application_id and user_id = v_user;
    if not found then
      -- Already gone. Nothing to revert, and nothing to complain about.
      continue;
    end if;

    -- Compared as an INSTANT, never as two rendered strings.
    --
    -- `to_jsonb(timestamptz)` renders with the SESSION's TimeZone, so a commit
    -- made under UTC stores `...+00:00` and an undo run under America/Chicago
    -- renders `...-05:00` for the same moment. The strings differ, every row is
    -- reported as "edited since", nothing is reverted, and the batch is still
    -- marked rolled_back — the undo is spent and did nothing. Same failure
    -- `hq_import_version` already exists to prevent on the round-trip token
    -- (matrix row 146), one function further down.
    if v_app.updated_at
       is distinct from (v_row.revert ->> 'wrote_updated_at')::timestamptz then
      v_kept := v_kept + 1;
      v_kept_ids := v_kept_ids || v_app.id;
      continue;
    end if;

    if v_row.outcome = 'created' then
      delete from public.applications where id = v_app.id and user_id = v_user;
      v_deleted := v_deleted + 1;
    else
      v_before := v_row.revert -> 'before';
      -- Declared, unconditionally: restoring a status is putting back what a
      -- person had, and on a row this import locked (a round trip) an
      -- undeclared write would be refused by 0010's trigger — the undo would
      -- fail on exactly the rows it most needs to reach.
      perform set_config('hq.status_write', 'human', true);
      update public.applications
         set status           = v_before ->> 'status',
             status_actor     = v_before ->> 'status_actor',
             next_action      = coalesce(v_before ->> 'next_action', ''),
             next_action_date = nullif(v_before ->> 'next_action_date', '')::date,
             applied_date     = nullif(v_before ->> 'applied_date', '')::date,
             updated_at       = now()
       where id = v_app.id and user_id = v_user;
      perform set_config('hq.status_write', '', true);
      v_reverted := v_reverted + 1;
      -- Imported notes on a surviving row stay. ACCUMULATED, not assigned: the
      -- first version overwrote the count each iteration, so a 200-row undo
      -- reported however many notes the last row happened to have.
      select v_notes + count(*) into v_notes from public.application_notes
       where application_id = v_app.id and author = 'import';
    end if;
  end loop;

  update public.import_batches set state = 'rolled_back' where id = p_batch
   returning * into v_batch;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'import.rolled_back',
          jsonb_build_object('batch', p_batch, 'deleted', v_deleted,
                             'reverted', v_reverted, 'kept', v_kept,
                             'kept_ids', to_jsonb(v_kept_ids[1:20]), 'idem', p_idem),
          'user');

  v_result := jsonb_build_object(
    'batch', public.app_import_batch_row(v_batch),
    'deleted', v_deleted, 'reverted', v_reverted, 'kept', v_kept,
    'kept_ids', to_jsonb(v_kept_ids[1:20]), 'notes_kept', v_notes);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_import_undo', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_pin_warm_intro — 0020_warm_referral.sql ────────────────────────
-- 1 lookup. Body verbatim from 0020_warm_referral.sql; the prose that
-- explains this function lives there.
create or replace function public.app_pin_warm_intro(
  p_target_kind text,
  p_posting_key text,
  p_company     text,
  p_full_name   text,
  p_profile_url text,
  p_headline    text,
  p_source      text,
  p_idem        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_kind   text := coalesce(p_target_kind, 'posting');
  v_name   text := public.hq_blank_trim(coalesce(p_full_name, ''));
  v_url    text := public.hq_blank_trim(coalesce(p_profile_url, ''));
  v_source text := lower(public.hq_blank_trim(coalesce(p_source, 'warm')));
  v_row    public.warm_pins;
  v_result jsonb;
  ALLOWED_SOURCES constant text[] := array['warm', 'manual'];
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
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
  if v_name = '' then
    raise exception 'a pin needs a name' using errcode = '22023';
  end if;
  -- The closed set at the browser door, so a bad URL is a sentence not a 23514.
  if v_url <> '' and v_url !~* '^https://([a-z0-9-]+\.)*linkedin\.com/' then
    raise exception 'a profile link must be a LinkedIn address' using errcode = '22023';
  end if;
  if v_source = '' then v_source := 'warm'; end if;
  if not (v_source = any (ALLOWED_SOURCES)) then
    raise exception 'unknown pin source: %', left(v_source, 40) using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_pin_warm_intro' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_pin_warm_intro'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  insert into public.warm_pins
    (user_id, target_kind, posting_key, company, full_name, profile_url, headline, source)
  values
    (v_user, v_kind, left(coalesce(p_posting_key, ''), 200),
     left(coalesce(p_company, ''), 200),
     left(v_name, 200), left(v_url, 500), left(coalesce(p_headline, ''), 300), v_source)
  -- Per PERSON per target (the multi-pin key), not per target — a posting holds a set.
  on conflict (user_id, target_kind, posting_key, company_key, pin_identity)
  do update set
    full_name   = excluded.full_name,
    profile_url = excluded.profile_url,
    headline    = excluded.headline,
    source      = excluded.source
  -- Guarded so a no-op re-pin (same values) does NOT fire the unconditional touch
  -- trigger (n1). `profile_url` is not compared — a URL change IS an identity change,
  -- so it lands as a new row, not a conflict here.
  where (public.warm_pins.full_name, public.warm_pins.headline, public.warm_pins.source)
        is distinct from (excluded.full_name, excluded.headline, excluded.source)
  returning * into v_row;

  -- A no-op re-pin skips the UPDATE and returns no row; fetch the existing one so the
  -- caller still gets the pin it named.
  if v_row.id is null then
    select * into v_row from public.warm_pins
     where user_id = v_user and target_kind = v_kind
       and posting_key = left(coalesce(p_posting_key, ''), 200)
       and company_key = public.company_name_key(left(coalesce(p_company, ''), 200))
       and pin_identity = case when v_url <> '' then lower(v_url) else lower(v_name) end;
  end if;

  insert into public.events (user_id, kind, posting_key, payload, actor)
  values (v_user, 'warm.intro_pinned', v_row.posting_key,
          jsonb_build_object('pin_id', v_row.id, 'company', v_row.company,
                             'full_name', v_row.full_name, 'source', v_row.source),
          'user');

  v_result := public.app_warm_pin_row(v_row);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_pin_warm_intro', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_propose_companies — 0008_company_review.sql ────────────────────
-- 2 lookups. Body verbatim from 0008_company_review.sql; the prose that
-- explains this function lives there.
create or replace function public.app_propose_companies(
  p_names  text[],
  p_source text,
  p_idem   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- The provenance tags the coverage meter's "Found via" column can name.
  --
  -- Closed, for 0007's reliability_tier reason: `source` is a REPORTING dimension,
  -- and this function is granted to `authenticated`, so an unbounded string from a
  -- browser writes a novel into a group-by. Deliberately scoped to this function
  -- rather than added as a CHECK on `companies.source`: that column is also written
  -- by the Python ingesters through one bulk upsert, and a table-wide closed set
  -- would let one unknown tag fail a 500-row chunk and wedge the mirror — which is
  -- exactly why 0001 refuses a CHECK on `postings.status`. Engine tags stay free;
  -- the browser-callable door is the one that gets the vocabulary.
  ALLOWED_SOURCES constant text[] := array[
    'manual', 'paste', 'api', 'import', 'seed', 'agent',
    'dork', 'commoncrawl', 'common-crawl', 'edgar', 'formadv', 'form-adv', 'theirstack'
  ];
  -- A ceiling on the review pile itself, not just on one paste.
  --
  -- 500 per paste bounds a single gesture; nothing bounded the total, so a scripted
  -- caller (or a person pasting all afternoon) could grow one user's review set
  -- without limit — every page load reads it, every coverage tally walks it, and
  -- the person who has to review it is the same person either way. Refusing with a
  -- countable reason is recoverable; an unbounded table is not.
  MAX_PENDING constant int := 2000;
  v_user    uuid := auth.uid();
  v_result  jsonb;
  v_rows    jsonb := '[]'::jsonb;
  v_row     public.user_companies;
  v_name    text;
  v_key     text;
  v_id      bigint;
  v_source  text;
  v_added   int := 0;
  v_pending int;
  v_seen    text[] := '{}';
  i         int;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_names is null or array_length(p_names, 1) is null then
    raise exception 'no company names given' using errcode = '22023';
  end if;
  -- The bound every fan-out gets. A paste past this is a mis-paste, not a list.
  if array_length(p_names, 1) > 500 then
    raise exception 'too many companies in one paste (limit 500)' using errcode = '22023';
  end if;

  v_source := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'manual');
  if length(v_source) > 40 then
    raise exception 'source tag too long' using errcode = '22023';
  end if;
  if not (lower(v_source) = any (ALLOWED_SOURCES)) then
    raise exception 'unknown source tag: %', v_source using errcode = '22023';
  end if;
  v_source := lower(v_source);

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_propose_companies' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_propose_companies'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- One paste at a time, per user.
  --
  -- There is no single row to lock here — this function INSERTS — so the serial
  -- point is an advisory lock keyed to the caller. It buys two things a bare
  -- function body cannot have: the post-lock idempotency re-check below actually
  -- means something (two tabs flushing one outbox send the same key at once, and
  -- the loser must replay rather than die on a duplicate key), and the backlog
  -- count cannot be read stale by two concurrent pastes that then both write.
  -- Transaction-scoped, so it is released on commit or rollback either way, and it
  -- touches no table — a `FOR UPDATE` on the users row would have blocked every
  -- unrelated FK insert that needs KEY SHARE on it.
  perform pg_advisory_xact_lock(hashtext('app_propose_companies'), hashtext(v_user::text));

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_propose_companies' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_propose_companies'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  select count(*) into v_pending
    from public.user_companies
   where user_id = v_user and review_state = 'proposed';
  if v_pending >= MAX_PENDING then
    raise exception
      'review backlog is full: % companies already await review (limit %) — review or dismiss some first',
      v_pending, MAX_PENDING using errcode = '22023';
  end if;

  for i in 1 .. array_length(p_names, 1) loop
    v_name := btrim(coalesce(p_names[i], ''));
    if v_name = '' or length(v_name) > 200 then
      continue;                       -- a blank line in a paste is not an error
    end if;
    -- Normalized identity, so 'Aon', 'aon' and 'Aon<NBSP>' are one company both
    -- WITHIN this paste and against everything already in the table.
    v_key := public.company_name_key(v_name);
    if v_key = '' then
      continue;
    end if;
    if v_key = any (v_seen) then
      continue;                       -- the same name twice in one paste is one company
    end if;
    v_seen := v_seen || v_key;

    -- Bind to whatever already represents this name, GROUNDED row first: a real
    -- board beats a placeholder, a stronger tier beats a weaker one, and the
    -- lowest id breaks the remaining tie so the choice is deterministic.
    select id into v_id
      from public.companies
     where public.company_name_key(name) = v_key
     order by (ats <> '' and slug <> '') desc, reliability_tier nulls last, id
     limit 1;

    if v_id is null then
      insert into public.companies (name, ats, slug, source, reliability_tier, resolution_method)
      values (v_name, '', '', v_source, 3, 'manual')
      -- No conflict TARGET: two unique constraints can reject this row — the
      -- original (name, ats, slug) and the normalized-name index — and naming one
      -- would let the other raise a raw duplicate-key error that takes the whole
      -- paste down. `do nothing` then re-read is the same shape 0003 uses for the
      -- application insert, for the same reason.
      on conflict do nothing
      returning id into v_id;

      if v_id is null then
        -- Lost the race to a concurrent paste of the same normalized name (a
        -- different user's, since ours holds the advisory lock). Its row is the
        -- one to bind to.
        select id into v_id
          from public.companies
         where public.company_name_key(name) = v_key
         order by (ats <> '' and slug <> '') desc, reliability_tier nulls last, id
         limit 1;
      end if;
    end if;

    if v_id is null then
      raise exception 'could not resolve the company row for %', v_name using errcode = 'P0002';
    end if;

    -- Already in this user's universe (approved, or a proposal they have not got
    -- to yet)? Leave it exactly as it is. Re-proposing an approved company would
    -- pull it back out of the swept set, which is a silent regression of a
    -- decision the human already made.
    select * into v_row
      from public.user_companies
     where user_id = v_user and company_id = v_id;
    if not found then
      insert into public.user_companies (user_id, company_id, monitor, priority, seeded, review_state)
      values (v_user, v_id, false, false, false, 'proposed')
      -- Two names in one paste can normalize to the same company only if the
      -- v_seen guard above missed them, and two users' pastes cannot collide on
      -- this key at all — but the row is inserted from a read that is not the
      -- lock's, so `do nothing` is what keeps a raw duplicate-key error from
      -- taking the batch down instead of skipping one row.
      on conflict (user_id, company_id) do nothing
      returning * into v_row;

      if v_row.company_id is null then
        select * into v_row
          from public.user_companies
         where user_id = v_user and company_id = v_id;
      else
        v_added := v_added + 1;

        insert into public.events (user_id, kind, payload, actor)
        values (v_user, 'company.proposed',
                jsonb_build_object('company_id', v_id, 'company', v_name,
                                   'source', v_source, 'idem', p_idem),
                'user');
      end if;
    end if;

    v_rows := v_rows || public.app_company_row(v_row);
  end loop;

  v_result := jsonb_build_object('rows', v_rows, 'added', v_added);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_propose_companies', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_resolve_suggestion — 0010_pipeline.sql ─────────────────────────
-- 2 lookups. Body verbatim from 0010_pipeline.sql; the prose that
-- explains this function lives there.
create or replace function public.app_resolve_suggestion(
  p_application_id      bigint,
  p_decision            text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_row       public.applications;
  v_result    jsonb;
  v_suggested text;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_decision is null or p_decision not in ('confirm', 'reject') then
    raise exception 'invalid decision: %', p_decision using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_resolve_suggestion' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_resolve_suggestion'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  select * into v_row
    from public.applications
   where user_id = v_user and id = p_application_id
     for update;
  if not found then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_resolve_suggestion' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_resolve_suggestion'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  v_suggested := public.hq_blank_trim(v_row.suggested_status);

  -- Nothing to resolve. Returned as the row rather than raised: the honest
  -- reading of a second Confirm arriving after the first is "already done",
  -- and a double-tap on a slow connection produces exactly that. Raising would
  -- turn a free gesture into a red toast about a thing that worked.
  if v_suggested = '' then
    v_result := public.app_application_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_resolve_suggestion', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this application changed since you read it'
      using errcode = '40001';
  end if;

  if p_decision = 'confirm' then
    perform set_config('hq.status_write', 'human', true);
    update public.applications
       set status           = v_suggested,
           status_actor     = 'user',   -- confirming IS a human decision
           status_set_at    = now(),
           suggested_status = '',
           updated_at       = now()
     where user_id = v_user and id = p_application_id
     returning * into v_row;
    perform set_config('hq.status_write', '', true);
  else
    update public.applications
       set suggested_status = '',
           -- status and status_actor deliberately untouched. Rejecting a
           -- suggestion is not a claim over the row: a later, better-evidenced
           -- email should still be able to advance it.
           updated_at       = now()
     where user_id = v_user and id = p_application_id
     returning * into v_row;
  end if;

  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user,
    case p_decision when 'confirm' then 'action.status.confirmed'
                    else                 'action.status.rejected' end,
    v_row.posting_key, v_row.id,
    jsonb_build_object('suggested', v_suggested, 'idem', p_idem),
    'user'
  );

  v_result := public.app_application_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_resolve_suggestion', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_save_view — 0005_saved_views.sql ───────────────────────────────
-- 1 lookup. Body verbatim from 0005_saved_views.sql; the prose that
-- explains this function lives there.
create or replace function public.app_save_view(
  p_id                  uuid,      -- null to create, an id to update in place
  p_name                text,
  p_surface             text,
  p_state               jsonb,
  p_is_default          boolean,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.saved_views;
  v_result jsonb;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_name is null or length(btrim(p_name)) = 0 or length(p_name) > 120 then
    raise exception 'a view needs a name' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_save_view' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_save_view'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Setting this view as the default clears any other default FIRST, or the
  -- partial unique index rejects the write. Scoped to the acting user and the
  -- surface, and it never touches the row we are about to write.
  if p_is_default then
    update public.saved_views
       set is_default = false
     where user_id = v_user
       and surface = coalesce(p_surface, 'jobs')
       and is_default
       and (p_id is null or id <> p_id);
  end if;

  if p_id is null then
    insert into public.saved_views (user_id, surface, name, state, is_default)
    values (v_user, coalesce(p_surface, 'jobs'), btrim(p_name),
            coalesce(p_state, '{}'::jsonb), coalesce(p_is_default, false))
    returning * into v_row;
  else
    -- Lock, then check the version, then write — the same order 0003 uses so
    -- two devices editing one view cannot both pass the conflict check.
    select * into v_row from public.saved_views
     where id = p_id and user_id = v_user
       for update;
    if not found then
      raise exception 'no such view for this user: %', p_id using errcode = 'P0002';
    end if;
    if p_expected_updated_at is not null
       and v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'conflict: this view changed since you read it'
        using errcode = '40001';
    end if;
    update public.saved_views
       set name = btrim(p_name),
           surface = coalesce(p_surface, v_row.surface),
           state = coalesce(p_state, v_row.state),
           is_default = coalesce(p_is_default, v_row.is_default)
     where id = p_id and user_id = v_user
     returning * into v_row;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (
    v_user, 'view.saved',
    jsonb_build_object('view_id', v_row.id, 'name', v_row.name,
                       'is_default', v_row.is_default, 'idem', p_idem),
    'user'
  );

  v_result := public.app_view_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_save_view', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_set_company_flags — 0008_company_review.sql ────────────────────
-- 2 lookups. Body verbatim from 0008_company_review.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_company_flags(
  p_company_id          bigint,
  p_monitor             boolean,
  p_priority            boolean,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_result jsonb;
  v_row    public.user_companies;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_monitor is null or p_priority is null then
    raise exception 'monitor and priority are required' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_company_flags' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_company_flags'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  select * into v_row
    from public.user_companies
   where user_id = v_user and company_id = p_company_id
     for update;
  if not found then
    raise exception 'no such company for this user: %', p_company_id using errcode = 'P0002';
  end if;

  -- The post-lock re-check (0003:166-182). Two tabs flushing one outbox send this
  -- key concurrently; both cleared the check above before either wrote, and
  -- without this the loser died on the duplicate key at the bottom instead of
  -- replaying the first result.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_company_flags' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_company_flags'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  if p_expected_updated_at is not null and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: company % changed since you read it', p_company_id
      using errcode = '40001';
  end if;

  if v_row.review_state <> 'approved' then
    raise exception 'company % is not approved; review it first', p_company_id
      using errcode = '22023';
  end if;

  if v_row.monitor = p_monitor and v_row.priority = p_priority then
    -- No-op: no write, no event, no version bump (0006's rule).
    v_result := public.app_company_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_set_company_flags', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  -- `user_id = v_user` is the tenant predicate, and it is the only thing standing
  -- between this and a cross-user write: `company_id` alone matches every other
  -- user's subscription to the same shared company, and this function runs as the
  -- definer so RLS does not save it. Dropping it turned one person's pause switch
  -- into everybody's. tests/db/test_company_review.py asserts the neighbour's row
  -- is untouched, which is what makes that mutation red.
  update public.user_companies
     set monitor    = p_monitor,
         priority   = p_priority,
         updated_at = now()
   where user_id = v_user and company_id = p_company_id
   returning * into v_row;

  insert into public.events (user_id, kind, payload, actor)
  values (
    v_user, 'company.flags',
    jsonb_build_object(
      'company_id', p_company_id,
      'company', (select c.name from public.companies c where c.id = p_company_id),
      'monitor', p_monitor,
      'priority', p_priority,
      'idem', p_idem
    ),
    'user'
  );

  v_result := public.app_company_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_company_flags', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_set_company_review_bulk — 0008_company_review.sql ──────────────
-- 2 lookups. Body verbatim from 0008_company_review.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_company_review_bulk(
  p_company_ids         bigint[],
  p_review_state        text,
  p_idem                text,
  p_expected_updated_at text[]   -- parallel to p_company_ids; a null element skips the check
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_result jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_row    public.user_companies;
  v_exps   timestamptz[];
  v_done   bigint[] := '{}';
  v_id     bigint;
  v_exp    timestamptz;
  v_mon    boolean;
  i        int;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_review_state is null or p_review_state not in ('proposed', 'approved', 'dismissed') then
    raise exception 'invalid review state: %', p_review_state using errcode = '22023';
  end if;
  if p_company_ids is null or array_length(p_company_ids, 1) is null then
    raise exception 'no companies selected' using errcode = '22023';
  end if;
  -- A bound, because everything that fans out gets one (0006's rule).
  if array_length(p_company_ids, 1) > 1000 then
    raise exception 'too many companies in one batch' using errcode = '22023';
  end if;

  -- The parallel-array contract, asserted HERE and not only in the server action.
  --
  -- This function is granted to `authenticated`, so the browser can call it
  -- directly and the TypeScript validator is advisory at best. A token array
  -- SHORTER than the selection silently skipped the conflict check on every row
  -- past its end — the exact clobber the tokens exist to prevent, arriving through
  -- the one door that bypasses every check written in TypeScript.
  if p_expected_updated_at is not null
     and coalesce(array_length(p_expected_updated_at, 1), 0)
         <> array_length(p_company_ids, 1) then
    raise exception 'version tokens must match the selection row for row'
      using errcode = '22023';
  end if;

  -- Cast the whole token array ONCE, inside a handler.
  --
  -- `'not-a-date'::timestamptz` raises 22007 InvalidDatetimeFormat, whose message
  -- the client cannot classify — so a malformed token (a stale client, a
  -- hand-written call) surfaced as "Couldn't save that: invalid input syntax for
  -- type timestamp with time zone". Answering with a conflict-classified error
  -- instead tells the client the truthful thing: the version you hold is not one
  -- this row can have, re-read it. One block for the array rather than one per
  -- element, so the happy path opens no subtransaction at all.
  if p_expected_updated_at is not null then
    begin
      v_exps := p_expected_updated_at::timestamptz[];
    exception when others then
      raise exception 'conflict: a version token in this batch is unreadable'
        using errcode = '40001';
    end;
  end if;

  -- The whole batch replays as a unit under one key.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_company_review_bulk' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_company_review_bulk'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Take every row lock FIRST, in ascending id order, before any write.
  --
  -- Two tabs sending overlapping selections in different orders deadlocked: the
  -- grid's payload is in DISPLAY order, so one tab sorted by name and another by
  -- tier hand this function the same ids in opposite sequences, each holding the
  -- row the other wants next. Postgres kills one with 40P01, which the client
  -- reports as a generic failure for a gesture that was perfectly valid. A total
  -- order over the ids removes the cycle by construction.
  --
  -- Missing rows are NOT diagnosed here — the write loop below raises P0002 with
  -- the offending id, and duplicating that check would let the two messages drift.
  for v_id in select distinct u from unnest(p_company_ids) as t(u) where u is not null order by u
  loop
    perform 1 from public.user_companies
     where user_id = v_user and company_id = v_id
       for update;
  end loop;

  -- Check the idempotency key AGAIN, now that the locks are held (0003:166-182).
  --
  -- The check above the locks only settles sequential replays. Two tabs share one
  -- localStorage outbox and both flush it on the same 'online' event, so the same
  -- key arrives twice CONCURRENTLY: both passed the first check before either
  -- wrote. Without this the loser raised a duplicate-key error out of the
  -- `command_idempotency` insert at the end and took the whole batch down — a
  -- replay is supposed to be free.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_company_review_bulk' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_company_review_bulk'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  v_mon := (p_review_state = 'approved');

  for i in 1 .. array_length(p_company_ids, 1) loop
    v_id := p_company_ids[i];
    if v_id is null then
      raise exception 'invalid company id in the selection' using errcode = '22023';
    end if;
    -- The same company twice in one batch is ONE decision, and the first
    -- occurrence's token is the one that counts. Iterating it twice used to write
    -- the row, bump its version, then fail its own second pass on a token that was
    -- current when the caller read it — a phantom conflict the user could do
    -- nothing about, reported as "changed on another device".
    if v_id = any (v_done) then
      continue;
    end if;
    v_done := v_done || v_id;

    v_exp := case when v_exps is null then null else v_exps[i] end;

    select * into v_row
      from public.user_companies
     where user_id = v_user and company_id = v_id
       for update;
    if not found then
      raise exception 'no such company for this user: %', v_id using errcode = 'P0002';
    end if;

    -- Any single conflict fails the whole transaction — the batch is atomic.
    if v_exp is not null and v_row.updated_at is distinct from v_exp then
      raise exception 'conflict: company % changed since you read it', v_id
        using errcode = '40001';
    end if;

    -- A no-op row contributes nothing: no write, no event, no version bump — so
    -- a bulk gesture landing on rows already in that state does not invalidate
    -- every other tab's tokens for them (0006's lesson, unchanged).
    if v_row.review_state = p_review_state and v_row.monitor = v_mon then
      v_rows := v_rows || public.app_company_row(v_row);
      continue;
    end if;

    update public.user_companies
       set review_state = p_review_state,
           monitor      = v_mon,
           updated_at   = now()
     where user_id = v_user and company_id = v_id
     returning * into v_row;

    insert into public.events (user_id, kind, payload, actor)
    values (
      v_user,
      case p_review_state
        when 'approved'  then 'company.approved'
        when 'dismissed' then 'company.dismissed'
        else                  'company.proposed'
      end,
      -- events has no company column (0001) and this migration does not add one:
      -- the audit payload is jsonb precisely so a new entity does not need a new
      -- column. The company id and name are both recorded, because a company row
      -- can be renamed and the trail must still read.
      jsonb_build_object(
        'company_id', v_id,
        'company', (select c.name from public.companies c where c.id = v_id),
        'review_state', p_review_state,
        'monitor', v_mon,
        'idem', p_idem,
        'bulk', true
      ),
      'user'
    );

    v_rows := v_rows || public.app_company_row(v_row);
  end loop;

  v_result := jsonb_build_object('rows', v_rows);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_company_review_bulk', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_set_display_prefs — 0025_display_prefs.sql ─────────────────────
-- 2 lookups. Body verbatim from 0025_display_prefs.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_display_prefs(
  p_density             text,
  p_type_scale          text,
  p_keyboard_hints      boolean,
  p_landing_view        text,
  p_theme               text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.profiles;
  v_before jsonb;
  v_result jsonb;
  v_wrote  boolean := false;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  -- Unreachable through the app and kept anyway, for 0012's stated reason:
  -- `authenticated` is the only role granted execute, so `auth.uid()` is
  -- non-null for every caller that can get this far. The day a service-role
  -- path or a new grant appears, this is the line that refuses to write a row
  -- with a null `user_id`. Pinned textually by
  -- `test_definer_functions_never_take_a_user_id`.
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- `hq_blank_trim`, not `length(p_idem) = 0` — 0012's tighter door, copied
  -- outward as its comment asked. A key of one NEWLINE reads as content to
  -- `btrim()` with no argument and as blank to a person (matrix rows 110, 129),
  -- and one caller sending a blank key would have every LATER blank key replay
  -- the first gesture's result forever.
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Validated HERE as well as by the CHECK constraints, and the duplication is
  -- the point: a CHECK violation is errcode 23514 with a constraint name in it,
  -- which `supabase-source.ts` classifies as a generic error and shows as
  -- "Couldn't save that". These raise 22023 with the offending value named, so
  -- the failure says which knob and what was sent. The constraints remain the
  -- door that stays shut if a later writer forgets this one.
  if p_density is not null and p_density not in ('dense', 'comfortable') then
    raise exception 'unknown density: %', p_density using errcode = '22023';
  end if;
  if p_type_scale is not null and p_type_scale not in ('default', 'large') then
    raise exception 'unknown type scale: %', p_type_scale using errcode = '22023';
  end if;
  if p_theme is not null and p_theme not in ('light', 'dark', 'system') then
    raise exception 'unknown theme: %', p_theme using errcode = '22023';
  end if;
  if p_landing_view is not null and length(p_landing_view) > 64 then
    raise exception 'landing view too long: % chars', length(p_landing_view)
      using errcode = '22023';
  end if;

  -- Replay: return the first result rather than applying twice.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_display_prefs' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_display_prefs'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- No row is created at signup (`handle_new_auth_user` writes `users` only),
  -- and a person can legitimately set their type scale before they ever finish
  -- the wizard — the wizard is the surface they need to READ. So materialise
  -- the row with the never-onboarded `'{}'` criteria sentinel, which is exactly
  -- what `app_commit_profile` does and what the onboarding redirect reads.
  -- `do nothing` rather than an existence check: two first-time gestures racing
  -- must not both insert.
  insert into public.profiles (user_id, criteria, notify)
  values (v_user, '{}'::jsonb, '{}'::jsonb)
  on conflict (user_id) do nothing;

  select * into v_row from public.profiles where user_id = v_user for update;

  -- Re-check the key with the row LOCKED. The check above only settles
  -- sequential replays; two tabs flushing one outbox on the same 'online' event
  -- both pass it before either writes.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_display_prefs' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_display_prefs'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Optimistic concurrency, checked INSIDE the transaction that writes.
  -- `p_expected_updated_at` is DECLARED `timestamptz` and `display_updated_at`
  -- IS one, so Postgres has parsed both instants before this line runs; the
  -- casts read as intent at the comparison site and are not the mechanism (the
  -- parameter type is — `test_the_version_token_is_declared_as_an_instant`
  -- pins it). Comparing the two RENDERINGS as text is matrix rows 146 and 168.
  --
  -- The word "conflict" is load-bearing: supabase-source.ts matches on it.
  if p_expected_updated_at is not null
     and v_row.display_updated_at::timestamptz is distinct from p_expected_updated_at::timestamptz then
    raise exception 'conflict: your display preferences changed since you read them'
      using errcode = '40001';
  end if;

  v_before := public.app_display_prefs_row(v_row);

  update public.profiles
     set display_density        = coalesce(p_density, display_density),
         display_type_scale     = coalesce(p_type_scale, display_type_scale),
         display_keyboard_hints = coalesce(p_keyboard_hints, display_keyboard_hints),
         display_landing_view   = coalesce(p_landing_view, display_landing_view),
         display_theme          = coalesce(p_theme, display_theme),
         display_updated_at     = now()
   where user_id = v_user
     -- The no-op guard. Everything below it — the token bump and the event —
     -- happens only when a value really moved.
     and (display_density, display_type_scale, display_keyboard_hints,
          display_landing_view, display_theme)
         is distinct from
         (coalesce(p_density, display_density),
          coalesce(p_type_scale, display_type_scale),
          coalesce(p_keyboard_hints, display_keyboard_hints),
          coalesce(p_landing_view, display_landing_view),
          coalesce(p_theme, display_theme))
  returning * into v_row;

  v_wrote := found;

  if not v_wrote then
    -- Nothing moved. Re-read rather than reusing the locked snapshot, so the
    -- answer is the row as it stands and not the row as it was before a
    -- concurrent writer we have already released.
    select * into v_row from public.profiles where user_id = v_user;
  else
    -- ONE event for the change, the row and its audit entry in the same
    -- function body. Bounded by the no-op guard above: an autosave storm of
    -- identical values appends nothing, so the append-only trail records the
    -- handful of times a person actually changed their mind rather than every
    -- render that re-sent the same five values.
    insert into public.events (user_id, kind, payload, actor)
    values (v_user, 'profile.display_changed',
            jsonb_build_object(
              'before', v_before,
              'after',  public.app_display_prefs_row(v_row)),
            'user');
  end if;

  v_result := jsonb_build_object(
                'display', public.app_display_prefs_row(v_row),
                'changed', v_wrote);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_display_prefs', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_set_linkedin_company_id — 0016_linkedin_fill.sql ───────────────
-- 2 lookups. Body verbatim from 0016_linkedin_fill.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_linkedin_company_id(
  p_company_id          bigint,
  p_linkedin_id         text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_uc     public.user_companies;
  v_row    public.companies;
  v_id     text;
  v_before text;
  v_result jsonb;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- `hq_blank_trim`, not `length() = 0`: a key of one space is blank to a person
  -- and length 1 to Postgres, and `command_idempotency`'s primary key is
  -- (user_id, idem_key) — so one caller sending an empty key would have every
  -- LATER empty key replay this gesture's result forever (matrix rows 110, 129, 218).
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_id := public.hq_blank_trim(coalesce(p_linkedin_id, ''));

  -- The closed set. Anchored on both ends: an unanchored `~ '[0-9]{1,20}'` matches
  -- the digits INSIDE `javascript:1` and would let the whole string through, which
  -- is the same anchoring bug 0010's blank-trim paid for from the other direction.
  if v_id <> '' and v_id !~ '^[0-9]{1,20}$' then
    raise exception 'a LinkedIn company id is digits only (got %)', left(v_id, 60)
      using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_linkedin_company_id' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_linkedin_company_id'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- The door, checked before the company row is locked: a caller who does not watch
  -- this company learns nothing and waits on nothing.
  select * into v_uc
    from public.user_companies
   where user_id = v_user and company_id = p_company_id;
  if not found then
    raise exception 'no such company for this user: %', p_company_id
      using errcode = '22023';
  end if;

  select * into v_row from public.companies where id = p_company_id for update;
  if not found then
    raise exception 'no such company: %', p_company_id using errcode = '22023';
  end if;

  -- Re-check the key with the row LOCKED. The check above only settles SEQUENTIAL
  -- replays; two tabs flushing one outbox on the same 'online' event both pass it
  -- before either writes (0003:166-182).
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_linkedin_company_id' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_linkedin_company_id'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Optimistic concurrency, checked INSIDE the transaction that writes, against the
  -- COMPANY row's token rather than the subscription's. The word "conflict" is
  -- load-bearing: `supabase-source.ts` matches /conflict|stale/i on it.
  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this company changed since you read it'
      using errcode = '40001';
  end if;

  v_before := v_row.linkedin_company_id;

  -- The `or` half is 0016's addition: a person re-pasting the id a bot found is
  -- claiming it, and without this the row would stay engine-owned forever.
  if v_before is distinct from v_id or v_row.linkedin_id_source <> 'human' then
    update public.companies
       set linkedin_company_id = v_id,
           linkedin_id_source  = 'human'
     where id = p_company_id
    returning * into v_row;
  end if;

  -- The row and its audit event in one body, or the trail has holes in it. This one
  -- earns its keep more than most: the column is shared, so "who put 1035 on Ramp
  -- and when" is a question somebody will ask.
  --
  -- Written even when the value did not CHANGE, which diverges from 0006/0008 (where
  -- a no-op review deliberately writes nothing). The divergence is deliberate: on a
  -- shared column, "somebody looked this up again and it is still 1035" is
  -- information the trail should hold, and unlike a review it gates no sweep.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'company.linkedin_id.set',
          jsonb_build_object('company_id', p_company_id,
                             'before',     v_before,
                             'after',      v_id),
          'user');

  select public.app_company_row(v_uc) into v_result;

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_linkedin_company_id', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_set_next_action — 0010_pipeline.sql ────────────────────────────
-- 2 lookups. Body verbatim from 0010_pipeline.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_next_action(
  p_application_id      bigint,
  p_next_action         text,
  p_next_action_date    date,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.applications;
  v_result jsonb;
  v_text   text := public.hq_blank_trim(p_next_action);
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if length(v_text) > 500 then
    raise exception 'next action is too long (max 500 characters)' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_next_action' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_next_action'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  select * into v_row
    from public.applications
   where user_id = v_user and id = p_application_id
     for update;
  if not found then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_next_action' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_next_action'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Saved on blur, so this fires constantly on a field nobody edited. Without
  -- the short circuit, tabbing through the pipeline would bump every row's
  -- version token and fill the audit trail with non-events.
  if v_row.next_action = v_text
     and v_row.next_action_date is not distinct from p_next_action_date then
    v_result := public.app_application_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_set_next_action', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this application changed since you read it'
      using errcode = '40001';
  end if;

  update public.applications
     set next_action      = v_text,
         next_action_date = p_next_action_date,
         updated_at       = now()
   where user_id = v_user and id = p_application_id
   returning * into v_row;

  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user, 'action.next_action', v_row.posting_key, v_row.id,
    jsonb_strip_nulls(jsonb_build_object(
      'next_action',      nullif(v_text, ''),
      'next_action_date', p_next_action_date,
      'idem',             p_idem
    )),
    'user'
  );

  v_result := public.app_application_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_next_action', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_set_policy_rule — 0014_apply_answers.sql ───────────────────────
-- 2 lookups. Body verbatim from 0014_apply_answers.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_policy_rule(
  p_topic               text,
  p_company             text,
  p_fact                jsonb,
  p_provenance          text,
  p_note                text,
  p_enabled             boolean,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_company  text := public.company_name_key(coalesce(p_company, ''));
  v_topic    text := public.hq_blank_trim(coalesce(p_topic, ''));
  v_prov     text := coalesce(nullif(public.hq_blank_trim(p_provenance), ''), 'user-entered');
  v_note     text := coalesce(p_note, '');
  v_enabled  boolean := coalesce(p_enabled, true);
  v_row      public.answer_policies;
  v_result   jsonb;
  v_inserted boolean := false;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if p_fact is null or jsonb_typeof(p_fact) <> 'object' then
    raise exception 'fact must be an object' using errcode = '22023';
  end if;

  -- Bounded, because this is stored VERBATIM and granted to `authenticated`.
  -- A country list is a handful of short strings; 8 kB is generous and finite.
  if pg_column_size(p_fact) > 8192 then
    raise exception 'fact too large: % bytes', pg_column_size(p_fact)
      using errcode = '22023';
  end if;

  if length(v_note) > 2000 then
    raise exception 'note too long: % characters', length(v_note)
      using errcode = '22023';
  end if;
  if length(v_company) > 200 then
    raise exception 'company too long: % characters', length(v_company)
      using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_policy_rule' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_policy_rule'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  insert into public.answer_policies
    (user_id, topic, company_key, fact, provenance, note, enabled)
  values
    (v_user, v_topic, v_company, p_fact, v_prov, v_note, v_enabled)
  on conflict (user_id, topic, company_key) do nothing;
  v_inserted := found;

  select * into v_row
    from public.answer_policies
   where user_id = v_user and topic = v_topic and company_key = v_company
     for update;

  -- The post-lock re-check. Two tabs flushing one outbox on the same 'online'
  -- event both pass the check above before either writes.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_policy_rule' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_policy_rule'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  if not v_inserted
     and p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this rule changed since you read it'
      using errcode = '40001';
  end if;

  if not v_inserted then
    update public.answer_policies
       set fact       = p_fact,
           provenance = v_prov,
           note       = v_note,
           enabled    = v_enabled
     where user_id = v_user and topic = v_topic and company_key = v_company
    returning * into v_row;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.policy_saved',
          jsonb_build_object('topic',      v_topic,
                             'companyKey', v_company,
                             'factKind',   p_fact ->> 'kind',
                             'provenance', v_prov,
                             'authoredBy', v_row.authored_by,
                             'enabled',    v_enabled,
                             'created',    v_inserted),
          case when v_row.authored_by = 'user' then 'user' else 'system' end);

  v_result := jsonb_build_object('rule', public.app_policy_row(v_row),
                                 'created', v_inserted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_policy_rule', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_set_status — 0010_pipeline.sql ─────────────────────────────────
-- 2 lookups. Body verbatim from 0010_pipeline.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_status(
  p_application_id      bigint,
  p_status              text,
  p_note                text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_row       public.applications;
  v_result    jsonb;
  v_status    text := public.hq_blank_trim(p_status);
  v_note      text := public.hq_blank_trim(p_note);
  v_reopening boolean;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if v_status = '' then
    raise exception 'a status is required' using errcode = '22023';
  end if;
  -- A bound, because everything a browser can send gets one. The sheet's own
  -- column is not this wide and a status is a label, not a note.
  if length(v_status) > 80 then
    raise exception 'status is too long (max 80 characters)' using errcode = '22023';
  end if;
  if length(v_note) > 4000 then
    raise exception 'note is too long (max 4000 characters)' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_status' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_status'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  select * into v_row
    from public.applications
   where user_id = v_user and id = p_application_id
     for update;
  if not found then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  -- Re-check behind the lock (0003:166-182). Two tabs flushing one outbox on
  -- the same 'online' event send the same key concurrently; both cleared the
  -- check above before either wrote, and without this the loser either raises a
  -- phantom conflict or applies a second time against an append-only trail.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_status' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_status'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Reopen: leaving a FINISHED state for a live one. Checked against the row we
  -- just locked rather than against anything the client said, because the
  -- client's idea of the current status is exactly what may be stale.
  --
  -- `hq_finished_statuses()` and not a hand-typed tuple. This was the fourth copy
  -- of that list in the repo, and it was also the WRONG list: it named only the
  -- three terminal states, so `Offer-Accepted -> Applied` with no note went
  -- straight through — reachable from the shipped Select, which offers every
  -- STATUS_ORDER value while only the Reopen BUTTON is gated on terminality.
  -- Un-ending a finished search is the most consequential reopen there is.
  v_reopening := v_row.status = any (public.hq_finished_statuses())
                 and not (v_status = any (public.hq_finished_statuses()));
  if v_reopening and v_note = '' then
    raise exception 'reopening needs a note saying why' using errcode = '22023';
  end if;

  -- A gesture that changes nothing writes nothing (0003's rule). Re-selecting
  -- the status a row already has would otherwise bump updated_at, invalidate
  -- every other tab's token, and append an audit event about a non-event.
  -- A note ALWAYS counts as a change, so it is excluded from this branch.
  if v_row.status = v_status and v_row.status_actor = 'user' and v_note = '' then
    v_result := public.app_application_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_set_status', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this application changed since you read it'
      using errcode = '40001';
  end if;

  -- Declare the write, for the duration of this one statement. See the trigger.
  perform set_config('hq.status_write', 'human', true);
  update public.applications
     set status           = v_status,
         -- The lock. Set on EVERY status write from this function, because
         -- every one of them came from a person pressing something.
         status_actor     = 'user',
         status_set_at    = now(),
         -- A human choosing a status answers the bot's suggestion by making it
         -- moot. Leaving it would render "Applied · suggests Rejected" beside a
         -- status the human just set to Rejected themselves.
         suggested_status = '',
         updated_at       = now()
   where user_id = v_user and id = p_application_id
   returning * into v_row;
  perform set_config('hq.status_write', '', true);

  if v_note <> '' then
    insert into public.application_notes (user_id, application_id, body, author)
    values (v_user, p_application_id, v_note, 'user');
  end if;

  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user, 'action.status', v_row.posting_key, v_row.id,
    jsonb_strip_nulls(jsonb_build_object(
      'status',   v_status,
      'reopened', nullif(v_reopening, false),
      'note',     nullif(v_note, ''),
      'idem',     p_idem
    )),
    'user'
  );

  -- Re-read: the note just inserted has to be in the row the client renders,
  -- and `v_row` was captured before the insert.
  select * into v_row from public.applications
   where user_id = v_user and id = p_application_id;
  v_result := public.app_application_row(v_row);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_status', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_set_triage — 0003_write_path.sql ───────────────────────────────
-- 2 lookups. Body verbatim from 0003_write_path.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_triage(
  p_posting_key         text,
  p_triage              text,
  p_snooze_until        date,
  p_reason              text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
-- Pinned: a security-definer function that inherits the caller's search_path
-- can be made to call a shadowed function. This is the standard hardening and
-- it is not optional.
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.user_postings;
  v_result jsonb;
  v_app_id bigint;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- The CHECK on user_postings would catch this too, but a named error beats a
  -- constraint violation surfacing to a user as a wall of Postgres text.
  if p_triage is null or p_triage not in ('', 'interested', 'dismissed', 'snoozed') then
    raise exception 'invalid triage value: %', p_triage using errcode = '22023';
  end if;

  -- A snooze with no wake date is a row that leaves the queue and never comes
  -- back — the spec makes the date mandatory for exactly that reason.
  if p_triage = 'snoozed' and p_snooze_until is null then
    raise exception 'snoozed requires a wake date' using errcode = '22023';
  end if;

  -- Replay: return the first result rather than applying twice.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_triage' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_triage'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- Lock the row for the duration. Without this, two concurrent gestures can
  -- both read the same updated_at, both pass the conflict check, and both
  -- write — which is the exact race acceptance criterion 26 is about.
  select * into v_row
    from public.user_postings
   where user_id = v_user and posting_key = p_posting_key
     for update;

  if not found then
    raise exception 'no such posting for this user: %', p_posting_key
      using errcode = 'P0002';
  end if;

  -- Check the idempotency key AGAIN, now that the row is locked.
  --
  -- The check above the lock only settles sequential replays. Two tabs share
  -- one localStorage outbox and both flush it on the same 'online' event, so
  -- the same key arrives twice CONCURRENTLY: both passed the first check
  -- before either wrote. Without this, one call wins and the other either
  -- raises a phantom conflict — which the banner reports as "changed on
  -- another device first" about a decision nobody else touched — or, with a
  -- null expectation, applies a second time and appends a duplicate event to
  -- an append-only trail. Re-reading behind the lock makes the loser a replay,
  -- which is what it always was.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_triage' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_triage'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- A gesture that changes nothing writes nothing.
  --
  -- The UPDATE below bumps updated_at unconditionally, and updated_at is the
  -- version token every other open tab holds. Re-sending the triage a row
  -- already has therefore invalidated every other device's token and appended
  -- an audit event, so the next legitimate gesture anywhere else got a
  -- conflict banner caused by a write that changed nothing.
  if v_row.triage = p_triage
     and v_row.triage_reason is not distinct from coalesce(p_reason, '')
     and v_row.snooze_until is not distinct from
         (case when p_triage = 'snoozed' then p_snooze_until else null end)
  then
    v_result := public.app_triage_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_set_triage', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  -- Optimistic concurrency. A null expectation means "I did not read a value",
  -- which is allowed — the client is then trusting last-write-wins knowingly.
  -- The word "conflict" in the message is load-bearing: supabase-source.ts
  -- matches on it to produce the conflict path rather than a generic error.
  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this row changed since you read it'
      using errcode = '40001';
  end if;

  update public.user_postings
     set triage        = p_triage,
         triage_reason = coalesce(p_reason, ''),
         -- Clearing the triage clears the wake date with it; a dismissed row
         -- carrying a stale snooze date is a row that reanimates itself.
         snooze_until  = case when p_triage = 'snoozed' then p_snooze_until else null end,
         updated_at    = now()
   where user_id = v_user and posting_key = p_posting_key
   returning * into v_row;

  -- Marking a posting interesting creates the application the pipeline shows.
  -- `on conflict do nothing` rather than an existence check: two gestures that
  -- slip past the row lock must not produce two applications.
  if p_triage = 'interested' then
    insert into public.applications (user_id, posting_key, company, title, url, status)
    select v_user, p.key, p.company, p.title, p.url, 'Queued'
      from public.postings p
     where p.key = p_posting_key
       and not exists (
         select 1 from public.applications a
          where a.user_id = v_user and a.posting_key = p_posting_key)
    returning id into v_app_id;
  end if;

  -- Moving AWAY from interested removes the application it created — but only
  -- while it is still bot-untouched.
  --
  -- Acceptance criterion 11: once a bot has advanced it (a confirmation email
  -- arrived, or a human moved it) the application is evidence of something that
  -- really happened, and it must survive.
  --
  -- This used to fire only on `''`, the undo path, so changing your mind from
  -- interested to dismissed left a live `Queued` row in the pipeline for a job
  -- you had explicitly rejected — permanently, since a triaged posting leaves
  -- the queue and no gesture reaches it again. Spec section A2's transition
  -- table never defined `interested -> dismissed`; the rule it does define for
  -- undo is the right one and generalises to every move off `interested`.
  if p_triage <> 'interested' then
    delete from public.applications
     where user_id = v_user
       and posting_key = p_posting_key
       and status = 'Queued';
  end if;

  -- The audit event. Append-only: an undo appends a compensating event, it
  -- never deletes the original (acceptance criterion 10).
  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user,
    case p_triage
      when 'interested' then 'action.interested'
      when 'dismissed'  then 'action.dismissed'
      when 'snoozed'    then 'action.snoozed'
      else                   'action.untriage'
    end,
    p_posting_key,
    v_app_id,
    jsonb_strip_nulls(jsonb_build_object(
      'triage',       p_triage,
      'reason',       nullif(coalesce(p_reason, ''), ''),
      'snooze_until', p_snooze_until,
      'idem',         p_idem
    )),
    'user'
  );

  -- Returning the row the client will render, from inside the same transaction
  -- that wrote it, is what lets the UI settle without a refetch.
  v_result := public.app_triage_row(v_row);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_triage', v_result)
  -- Two racing calls with the same key: whichever lost still returns the same
  -- shape, and the row it wrote is identical.
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_set_triage_bulk — 0006_bulk_triage.sql ─────────────────────────
-- 1 lookup. Body verbatim from 0006_bulk_triage.sql; the prose that
-- explains this function lives there.
create or replace function public.app_set_triage_bulk(
  p_keys                text[],
  p_triage              text,
  p_snooze_until        date,
  p_reason              text,
  p_idem                text,
  p_expected_updated_at text[]   -- parallel to p_keys; a null element skips the check
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_result jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_row    public.user_postings;
  v_key    text;
  v_exp    timestamptz;
  v_app_id bigint;
  i        int;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_triage is null or p_triage not in ('', 'interested', 'dismissed', 'snoozed') then
    raise exception 'invalid triage value: %', p_triage using errcode = '22023';
  end if;
  if p_triage = 'snoozed' and p_snooze_until is null then
    raise exception 'snoozed requires a wake date' using errcode = '22023';
  end if;
  if p_keys is null or array_length(p_keys, 1) is null then
    raise exception 'no postings selected' using errcode = '22023';
  end if;
  -- A bound, because everything that fans out gets one. A single gesture over
  -- more than this is a bug or an accident, not a decision, and a runaway batch
  -- should fail fast rather than lock a thousand rows.
  if array_length(p_keys, 1) > 1000 then
    raise exception 'too many postings in one batch' using errcode = '22023';
  end if;

  -- The whole batch replays as a unit under one key.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_set_triage_bulk' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_set_triage_bulk'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  for i in 1 .. array_length(p_keys, 1) loop
    v_key := p_keys[i];
    v_exp := case
               when p_expected_updated_at is null then null
               when p_expected_updated_at[i] is null then null
               else p_expected_updated_at[i]::timestamptz
             end;
    v_app_id := null;

    select * into v_row
      from public.user_postings
     where user_id = v_user and posting_key = v_key
       for update;
    if not found then
      raise exception 'no such posting for this user: %', v_key using errcode = 'P0002';
    end if;

    -- Any single conflict fails the whole transaction — the batch is atomic.
    if v_exp is not null and v_row.updated_at is distinct from v_exp then
      raise exception 'conflict: % changed since you read it', v_key
        using errcode = '40001';
    end if;

    -- A no-op row contributes nothing: no write, no event, no version bump —
    -- so a bulk gesture that lands on rows already in that state does not
    -- invalidate every other tab's tokens for them (0003's lesson, at scale).
    if v_row.triage = p_triage
       and v_row.triage_reason is not distinct from coalesce(p_reason, '')
       and v_row.snooze_until is not distinct from
           (case when p_triage = 'snoozed' then p_snooze_until else null end)
    then
      v_rows := v_rows || public.app_triage_row(v_row);
      continue;
    end if;

    update public.user_postings
       set triage        = p_triage,
           triage_reason = coalesce(p_reason, ''),
           snooze_until  = case when p_triage = 'snoozed' then p_snooze_until else null end,
           updated_at    = now()
     where user_id = v_user and posting_key = v_key
     returning * into v_row;

    if p_triage = 'interested' then
      insert into public.applications (user_id, posting_key, company, title, url, status)
      select v_user, p.key, p.company, p.title, p.url, 'Queued'
        from public.postings p
       where p.key = v_key
         and not exists (
           select 1 from public.applications a
            where a.user_id = v_user and a.posting_key = v_key)
      returning id into v_app_id;
    end if;

    if p_triage <> 'interested' then
      delete from public.applications
       where user_id = v_user and posting_key = v_key and status = 'Queued';
    end if;

    insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
    values (
      v_user,
      case p_triage
        when 'interested' then 'action.interested'
        when 'dismissed'  then 'action.dismissed'
        when 'snoozed'    then 'action.snoozed'
        else                   'action.untriage'
      end,
      v_key, v_app_id,
      jsonb_strip_nulls(jsonb_build_object(
        'triage', p_triage,
        'reason', nullif(coalesce(p_reason, ''), ''),
        'snooze_until', p_snooze_until,
        'idem', p_idem,
        'bulk', true
      )),
      'user'
    );

    v_rows := v_rows || public.app_triage_row(v_row);
  end loop;

  v_result := jsonb_build_object('rows', v_rows);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_triage_bulk', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ── app_start_warm_search — 20260817_011844_per_user_rate_bounds.sql ───
-- 1 lookup. Body verbatim from 20260817_011844_per_user_rate_bounds.sql; the prose that
-- explains this function lives there.
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
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
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
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_start_warm_search' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_start_warm_search'
        using errcode = '22023';
    end if;
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

-- ── app_unpin_warm_intro — 0020_warm_referral.sql ──────────────────────
-- 1 lookup. Body verbatim from 0020_warm_referral.sql; the prose that
-- explains this function lives there.
create or replace function public.app_unpin_warm_intro(p_id bigint, p_idem text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_result  jsonb;
  v_deleted int;
  v_key     text;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_unpin_warm_intro' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_unpin_warm_intro'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  delete from public.warm_pins where id = p_id and user_id = v_user
    returning posting_key into v_key;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    insert into public.events (user_id, kind, posting_key, payload, actor)
    values (v_user, 'warm.intro_unpinned', coalesce(v_key, ''),
            jsonb_build_object('pin_id', p_id), 'user');
  end if;

  v_result := jsonb_build_object('deleted', v_deleted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_unpin_warm_intro', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── app_upsert_answer — 0017_answer_scope.sql ──────────────────────────
-- 2 lookups. Body verbatim from 0017_answer_scope.sql; the prose that
-- explains this function lives there.
create or replace function public.app_upsert_answer(
  p_question            text,
  p_answer              text,
  p_kind                text,
  p_provenance          text,
  p_idem                text,
  p_expected_updated_at timestamptz,
  p_company             text default '',
  p_declined            boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_key      text;
  v_row      public.answers;
  v_result   jsonb;
  v_inserted boolean := false;
  v_kind     text := coalesce(nullif(public.hq_blank_trim(p_kind), ''), 'freeform');
  v_prov     text := coalesce(nullif(public.hq_blank_trim(p_provenance), ''), 'user-entered');
  v_answer   text := coalesce(p_answer, '');
  v_question text := coalesce(p_question, '');
  v_company  text := public.company_name_key(coalesce(p_company, ''));
  v_declined boolean := coalesce(p_declined, false);
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if length(v_question) > 2000 then
    raise exception 'question too long: % characters', length(v_question)
      using errcode = '22023';
  end if;
  if length(v_answer) > 8000 then
    raise exception 'answer too long: % characters', length(v_answer)
      using errcode = '22023';
  end if;
  if length(v_company) > 200 then
    raise exception 'company too long: % characters', length(v_company)
      using errcode = '22023';
  end if;

  if public.hq_blank_trim(v_answer) = '' then
    raise exception 'answer must not be blank' using errcode = '22023';
  end if;

  v_key := public.hq_question_key(v_question);
  if v_key = '' then
    raise exception 'question must contain letters or digits' using errcode = '22023';
  end if;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_upsert_answer' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_upsert_answer'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  insert into public.answers
    (user_id, question, company_key, answer, declined, kind, provenance, confirmed_at)
  values (v_user, v_question, v_company, v_answer, v_declined, v_kind, v_prov,
          case when v_prov = 'confirmed' then now() else null end)
  on conflict (user_id, question_key, company_key) do nothing;
  v_inserted := found;

  select * into v_row
    from public.answers
   where user_id = v_user and question_key = v_key and company_key = v_company
     for update;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'app_upsert_answer' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'app_upsert_answer'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  if not v_inserted
     and p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this answer changed since you read it'
      using errcode = '40001';
  end if;

  if not v_inserted then
    update public.answers
       set question    = v_question,
           answer      = v_answer,
           declined    = v_declined,
           kind        = v_kind,
           provenance  = v_prov,
           confirmed_at = case when v_prov = 'confirmed' then now() else confirmed_at end
     where user_id = v_user and question_key = v_key and company_key = v_company
    returning * into v_row;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.answer_saved',
          jsonb_build_object('questionKey', v_key,
                             'companyKey',  v_company,
                             'kind',        v_kind,
                             'declined',    v_declined,
                             'provenance',  v_prov,
                             'authoredBy',  v_row.authored_by,
                             'created',     v_inserted),
          case when v_row.authored_by = 'user' then 'user' else 'system' end);

  v_result := jsonb_build_object('answer', public.app_answer_row(v_row),
                                 'created', v_inserted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_upsert_answer', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── hq_apply_email_event — 0015_engine_writes.sql ──────────────────────
-- 2 lookups. Body verbatim from 0015_engine_writes.sql; the prose that
-- explains this function lives there.
create or replace function public.hq_apply_email_event(
  p_user_id        uuid,
  p_posting_key    text,
  p_event_id       text,
  p_event_type     text,
  p_status         text,
  p_hard           boolean,
  p_evidence       text,
  p_activity_on    date,
  p_create         jsonb,
  -- REQUIRED, deliberately without defaults. A default would make "I forgot to pass
  -- the sheet's truth" and "I have no second store" the same call, and the first of
  -- those silently restores the defect the pair exists to close. Post-Phase-D callers
  -- pass NULL and mean it; `tests/core/test_migrations.py` asserts `join` passes every
  -- parameter this function declares, so a future argument cannot be forgotten either.
  p_current_status text,
  p_current_actor  text
)
returns jsonb
language plpgsql
-- Pinned for 0009's reason: this body calls `public.hq_status_rank` and
-- `public.hq_blank_trim`, and a shadowed resolution of either decides whether
-- somebody's Offer survives.
set search_path = public, pg_temp
as $$
declare
  v_idem          text;
  v_row           public.applications;
  v_result        jsonb;
  v_status        text := public.hq_blank_trim(p_status);
  v_evidence      text := public.hq_blank_trim(p_evidence);
  v_key           text := public.hq_blank_trim(p_posting_key);
  v_on            date := coalesce(p_activity_on, current_date);
  v_created       boolean := false;
  v_outcome       text;
  v_new_status    text;
  v_new_suggested text;
  v_new_evidence  text;
  v_creating      boolean;
  v_other_actor   text := lower(public.hq_blank_trim(p_current_actor));
  v_other_locked  boolean;
  v_known_rank    int;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if p_user_id is null then
    raise exception 'hq_apply_email_event needs the user whose lanes it writes'
      using errcode = '22023';
  end if;
  if v_key = '' then
    raise exception 'hq_apply_email_event needs a posting key' using errcode = '22023';
  end if;
  -- The idempotency key IS the classifier's event id, so a missing one means the
  -- caller cannot promise replay safety and this must not pretend otherwise.
  if public.hq_blank_trim(p_event_id) = '' then
    raise exception 'idempotency key required (the email event id)'
      using errcode = '22023';
  end if;
  -- No bot may end a search. The engine structurally cannot name these
  -- (`EVENT_STATUS_RULES` has no entry that maps to one, and `tracker/join.py`
  -- asserts it), which is exactly why the refusal is repeated at the other end
  -- of the wire: the engine's guarantee is about today's table, and this one
  -- holds for whatever calls it next.
  if v_status = any (public.hq_status_resolved()) then
    raise exception '% is a human-only ending; no bot may write it', v_status
      using errcode = '42501';
  end if;

  -- The idempotency key names the event AND what was concluded about it, not the
  -- event alone. Two reachable bugs came out of the shorter version:
  --
  --   * the fuzzy branch of `join`'s ladder resolves one event to a DIFFERENT
  --     Pipeline row when the candidate set changes between runs (`promote` adds
  --     rows every two hours), and the replay then returned the first row's answer
  --     while writing nothing — reported to the caller as success, on a row that
  --     never moved. `posting_key` in the key makes those two different commands.
  --   * a re-classified message (0.6 'received' on Monday, 0.99 'interview' on
  --     Tuesday — the classifier is an LLM and its output is not stable) replayed
  --     Monday's conclusion forever. Including the conclusion lets Tuesday apply,
  --     and the forward-only ladder is what keeps that monotonic: a classifier
  --     that changes its mind can move the row on, never back.
  v_idem := 'join:' || public.hq_blank_trim(p_event_id) || ':' || v_key
            || ':' || v_status || ':' || case when coalesce(p_hard, false) then 'h' else 's' end;

  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = p_user_id and idem_key = v_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'hq_apply_email_event' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'hq_apply_email_event'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- The posting first. `applications.posting_key` references `postings (key)`,
  -- so an event whose jobkey the sweep has not mirrored yet cannot produce a row
  -- here — and MUST NOT produce a guessed one. Answered rather than raised: this
  -- is a gap to be drained (`tracker.pgseed`, or the next sweep mirroring the
  -- posting), not a failure to page somebody about at 02:31.
  if not exists (select 1 from public.postings where key = v_key) then
    perform public.hq_note_unapplied_event(
      p_user_id, v_key, p_event_id, p_event_type, v_idem, 'no_posting');
    return jsonb_build_object('outcome', 'no_posting', 'posting_key', v_key,
                              'created', false);
  end if;

  select * into v_row
    from public.applications
   where user_id = p_user_id and posting_key = v_key
     for update;

  if not found then
    -- `jsonb_typeof` as well as `is null`: PostgREST sends a JSON `null` for an
    -- absent argument, and `jsonb 'null'` is a VALUE, not NULL — without this
    -- the caller's "do not create" would create a row with every field blank.
    v_creating := p_create is not null and jsonb_typeof(p_create) <> 'null';
    if not v_creating then
      perform public.hq_note_unapplied_event(
        p_user_id, v_key, p_event_id, p_event_type, v_idem, 'no_application');
      return jsonb_build_object('outcome', 'no_application', 'posting_key', v_key,
                                'created', false);
    end if;
    insert into public.applications
      (user_id, posting_key, company, title, url, source, status,
       applied_date, applied_via, applied_email, evidence, last_activity)
    values (
      p_user_id, v_key,
      coalesce(p_create ->> 'company', ''),
      coalesce(p_create ->> 'title', ''),
      coalesce(p_create ->> 'url', ''),
      coalesce(nullif(public.hq_blank_trim(p_create ->> 'source'), ''), 'gmail'),
      'Inbox',
      -- `hq_iso_date` (0013): NULL for anything that is not an ISO date, never a
      -- rolled-over neighbour and never a raise. A received_at the classifier
      -- could not parse must not fail the whole event.
      public.hq_iso_date(p_create ->> 'applied_date'),
      coalesce(p_create ->> 'applied_via', ''),
      coalesce(p_create ->> 'applied_email', ''),
      v_evidence, v_on)
    on conflict (user_id, posting_key) do nothing
    returning * into v_row;

    if found then
      v_created := true;
    else
      -- Lost the insert race to a concurrent lane. The winner's row is the row;
      -- take the lock on it and carry on as if it had been there all along.
      select * into v_row
        from public.applications
       where user_id = p_user_id and posting_key = v_key
         for update;
    end if;
  end if;

  -- Behind the lock (0003:166-182). The pre-lock check settles SEQUENTIAL
  -- replays only: two tracker runs overlapping on one event both clear it before
  -- either writes, and without this the loser applies a second time against an
  -- append-only trail.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = p_user_id and idem_key = v_idem;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'hq_apply_email_event' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'hq_apply_email_event'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  if v_created then
    insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
    values (p_user_id, 'email.application_created', v_key, v_row.id,
            jsonb_build_object('event_id', p_event_id, 'event_type', p_event_type,
                               'idem', v_idem),
            'gmail-capture');
  end if;

  -- ---------------------------------------------------------------- sheet truth
  --
  -- During dual-write the human's editing surface is the SPREADSHEET, and pg's own
  -- `status_actor` is written by exactly one thing: `app_set_status`, the web app.
  -- So a person who types Offer into the Pipeline tab claims the sheet row and
  -- claims nothing here — pg's twin still says 'Queued' with actor 'system', and
  -- deciding against it re-created the defect 0010 exists to prevent, in the store
  -- Phase C is promoting to system of record. Executed, before this: sheet said
  -- Offer/'user' and `join` recorded a suggestion, while the SAME event advanced pg
  -- to Rejected.
  --
  -- The fix is not a smarter guess about pg's own row; it is that the caller already
  -- HAS the authoritative pair and can hand it over. `p_current_status` /
  -- `p_current_actor` are the sheet Pipeline row's `status` and `status_actor` as the
  -- sheet lane saw them, and the two rules below are then evaluated against BOTH
  -- stores at once. The result is that the two lanes reach the same verdict by
  -- construction, which is what dual-write is supposed to mean.
  --
  -- NULL means "this caller has no second store to reconcile against" — a future
  -- `/api/capture` writing pg directly, and every caller after Phase D. It decides on
  -- pg alone, which is correct exactly then and wrong exactly now, so `join` always
  -- passes both (pinned in tests/core/test_migrations.py).
  --
  -- UNKNOWN ACTOR LOCKS. The sheet's cell is a two-value dropdown a human edits, so
  -- '' and 'system' mean unclaimed and 'user' means claimed — and anything else means
  -- this function does not understand what it is looking at. The safe reading of an
  -- unknown value is the one that does not lose somebody's Offer (0010's own comment
  -- makes the same argument for the column, in the other direction). Case-folded
  -- because `advance_status` reads the same cell with `.casefold()`.
  v_other_locked := v_other_actor not in ('', 'system');

  -- Forward-only against the FURTHEST either store has got. max(), never the pg row
  -- alone: a sheet at `Offer-Accepted` (rank 10, typed by hand, no dropdown needed)
  -- and a pg twin at `Queued` (rank 1) is a real pairing today, and rank 9 `Rejected`
  -- must lose to it exactly the way it loses in the sheet lane.
  v_known_rank := greatest(
    public.hq_status_rank(v_row.status),
    case when p_current_status is null then -1
         else public.hq_status_rank(p_current_status) end);

  if v_status = '' then
    v_outcome := 'matched';
  elsif not coalesce(p_hard, false) then
    v_outcome := 'suggested';
  -- The lock, from EITHER store, and before the rank — `core/sheets.py`'s
  -- `advance_status` checks them in this order for a reason that survives the port:
  -- "a person owns this row" and "this email is stale" call for different answers,
  -- and collapsing them loses the half of criterion 14 where the human keeps their
  -- Offer AND sees that a rejection came in.
  elsif v_row.status_actor = 'user' or v_other_locked then
    v_outcome := 'locked';
  elsif public.hq_status_rank(v_status) <= v_known_rank then
    v_outcome := 'kept';
  else
    v_outcome := 'advanced';
  end if;

  v_new_status    := v_row.status;
  v_new_suggested := v_row.suggested_status;
  -- Evidence is written on the two paths that record an opinion, and only when
  -- there IS one: writing it unconditionally blanked the existing deep link
  -- whenever an event arrived with no thread_link, and that link is the one
  -- field on the row a person actually needs to act on. `advance_status` has
  -- always guarded it the same way.
  v_new_evidence  := case when v_outcome in ('advanced', 'locked', 'suggested')
                           and v_evidence <> '' then v_evidence
                     else v_row.evidence end;
  if v_outcome = 'advanced' then
    v_new_status := v_status;
  elsif v_outcome in ('locked', 'suggested') then
    v_new_suggested := v_status;
  end if;

  -- A pass that changes nothing writes nothing. `applications_touch` bumps
  -- `updated_at` on every UPDATE and `updated_at` is the web app's concurrency
  -- token, so an unguarded activity stamp would invalidate every open tab's
  -- token twice an hour and turn the next real gesture into a phantom conflict
  -- (0010's rule, and 0003's before it).
  if v_new_status is distinct from v_row.status
     or v_new_suggested is distinct from v_row.suggested_status
     or v_new_evidence is distinct from v_row.evidence
     or v_row.last_activity is distinct from v_on then
    update public.applications
       set status           = v_new_status,
           suggested_status = v_new_suggested,
           evidence         = v_new_evidence,
           last_activity    = v_on
     where id = v_row.id
     returning * into v_row;
  end if;

  -- `status_actor` and `status_set_at` are NOT written, on any path. 0010's
  -- column comment is the specification: `status_set_at` is a human-gesture
  -- timestamp, and a bot advance that stamped `status_actor = 'system'` on a row
  -- that already said 'system' would be harmless the day it shipped and a
  -- one-statement unlock the day somebody generalises it.

  -- The state change and its audit event in one body, or the trail has holes in
  -- it. `kind` carries the classifier's own event type verbatim rather than a
  -- mapping table nobody maintains; `actor` is the writer, which is the Gmail
  -- capture pipeline and not a person.
  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    p_user_id,
    'email.' || coalesce(nullif(public.hq_blank_trim(p_event_type), ''), 'unclassified'),
    v_key, v_row.id,
    jsonb_strip_nulls(jsonb_build_object(
      'outcome',  v_outcome,
      'status',   nullif(v_status, ''),
      'hard',     coalesce(p_hard, false),
      'created',  nullif(v_created, false),
      'event_id', p_event_id,
      'idem',     v_idem
    )),
    'gmail-capture');

  v_result := jsonb_build_object(
    'outcome',          v_outcome,
    'created',          v_created,
    'application_id',   v_row.id,
    'posting_key',      v_key,
    'status',           v_row.status,
    'suggested_status', v_row.suggested_status);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (p_user_id, v_idem, 'hq_apply_email_event', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- ── hq_digest_set_triage — 0019_digest_action.sql ──────────────────────
-- 2 lookups. Body verbatim from 0019_digest_action.sql; the prose that
-- explains this function lives there.
create or replace function public.hq_digest_set_triage(
  p_user_id     uuid,
  p_posting_key text,
  p_triage      text,
  p_idem        text
)
returns jsonb
language plpgsql
-- Pinned even without `security definer`: a shadowed `app_triage_row` in a
-- caller's search_path is still a function this body did not mean to call.
set search_path = public, pg_temp
as $$
declare
  v_row    public.user_postings;
  v_status text;
  v_result jsonb;
  v_app_id bigint;
  -- #288: the command that already owns this key, compared below.
  v_replay_command text;
begin
  if p_user_id is null then
    raise exception 'hq_digest_set_triage needs the user the link was minted for'
      using errcode = '22023';
  end if;

  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- The CHECK on user_postings would catch a bad value too, and 'snoozed' would
  -- pass it — so the closed set is named here. `''` is in it on purpose: that is
  -- the Undo.
  if p_triage is null or p_triage not in ('', 'interested', 'dismissed') then
    raise exception 'invalid triage value: %', p_triage using errcode = '22023';
  end if;

  -- Replay, before anything is locked. The `jti` inside the signed token is the
  -- key, so the same emailed link tapped twice next week returns the answer the
  -- first tap produced rather than applying a second time.
  --
  -- Scoped to the POSTING too (C3 review m1). The key is `(user_id, idem_key)` and
  -- a `jti` is 128 random bits minted per (user, posting, action), so a collision
  -- across two of one user's postings is not reachable — but a replay that
  -- returned a row the caller never named would let the success page put the
  -- wrong company on "Saved …", and the guard is one predicate. A stored result
  -- for a different posting is treated as no replay: the call falls through to the
  -- row lookup for `p_posting_key`, which is the posting the token actually signs.
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = p_user_id and idem_key = p_idem
     and result->>'posting_key' = p_posting_key;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'hq_digest_set_triage' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'hq_digest_set_triage'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  select * into v_row
    from public.user_postings
   where user_id = p_user_id and posting_key = p_posting_key
     for update;

  -- The row belongs to a user, and the user came out of the signature. A token
  -- for one person against a posting only another person was gated therefore
  -- lands here and reveals nothing about it (matrix row 40). The route renders
  -- this as "no longer listed", the same page a closed posting gets.
  if not found then
    raise exception 'no such posting for this user: %', p_posting_key
      using errcode = 'P0002';
  end if;

  -- A CLOSED board listing is refused here, not just at the route (C3 review M1).
  -- `digestGet` renders "no longer listed" for a closed posting; a POST that then
  -- wrote a triage and minted a `Queued` application for a dead listing (row 41's
  -- exact scenario: Safe Links GETs, the human taps hours later, the board has
  -- closed it) would contradict the page they saw. The route checks first; this
  -- is the layer that also closes the race where it closes between GET and POST,
  -- and the guard against a direct RPC call. Same errcode as not-found, because
  -- the user-facing answer is the same "no longer listed" and the store maps both
  -- to the `gone` page — a first tap only; a REPLAY was already answered above,
  -- so a decision made before the board closed still renders its recorded result.
  select status into v_status from public.postings where key = p_posting_key;
  if v_status = 'Closed' then
    raise exception 'posting no longer open: %', p_posting_key
      using errcode = 'P0002';
  end if;

  -- Again, behind the lock. 0003's reason, and it applies harder to this caller:
  -- a mail gateway that prefetches links can fire two requests for one token
  -- within milliseconds of each other, so both pass the check above before either
  -- writes. Re-reading here makes the loser a replay, which is what it always was.
  -- Scoped to the posting for the same reason as the pre-lock read (m1).
  select result, command into v_result, v_replay_command
    from public.command_idempotency
   where user_id = p_user_id and idem_key = p_idem
     and result->>'posting_key' = p_posting_key;
  if found then
    -- #288: a key owned by another command is not this command's replay.
    if v_replay_command is distinct from 'hq_digest_set_triage' then
      raise exception
        'idempotency key already used by % — % cannot replay it',
        v_replay_command, 'hq_digest_set_triage'
        using errcode = '22023';
    end if;
    return v_result;
  end if;

  -- A gesture that changes nothing writes nothing.
  --
  -- The UPDATE below bumps `updated_at` unconditionally, and `updated_at` is the
  -- version token every open tab in the app is holding. Re-tapping a link for the
  -- decision the row already carries would invalidate all of them and append a
  -- second audit event about a write that changed nothing.
  --
  -- `snooze_until is null` is part of "unchanged" because none of the three legal
  -- values here is `snoozed`: a row that still carries a wake date is a row this
  -- gesture really does alter, and treating it as a no-op would leave a dismissed
  -- posting that reanimates itself.
  if v_row.triage = p_triage and v_row.snooze_until is null then
    v_result := public.app_triage_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (p_user_id, p_idem, 'hq_digest_set_triage', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  update public.user_postings
     set triage        = p_triage,
         -- Cleared on a real change: a reason typed for the decision this one
         -- replaces is stale, and the link carries none to put in its place.
         triage_reason = '',
         -- Clearing or flipping the triage clears the wake date with it; a
         -- dismissed row carrying a stale snooze date is a row that comes back.
         snooze_until  = null,
         updated_at    = now()
   where user_id = p_user_id and posting_key = p_posting_key
   returning * into v_row;

  if p_triage = 'interested' then
    -- `not exists` rather than an existence check in the route: two taps that
    -- somehow slip past the row lock must not produce two applications.
    insert into public.applications (user_id, posting_key, company, title, url, status)
    select p_user_id, p.key, p.company, p.title, p.url, 'Queued'
      from public.postings p
     where p.key = p_posting_key
       and not exists (
         select 1 from public.applications a
          where a.user_id = p_user_id and a.posting_key = p_posting_key)
    returning id into v_app_id;
  else
    -- Moving away from interested removes the application it created, but only
    -- while it is still bot-untouched (acceptance criterion 11): once a
    -- confirmation email has advanced it, the row is evidence of something that
    -- really happened. Undo (`''`) and a change of mind take the same path, which
    -- is 0003's rule generalised the same way.
    delete from public.applications
     where user_id = p_user_id
       and posting_key = p_posting_key
       and status = 'Queued';
  end if;

  -- Append-only: an undo appends a compensating event and never deletes the
  -- original (acceptance criterion 10). `actor` is `'user'` because a person
  -- tapped a link in their own mail; `via` records WHICH door, which is the
  -- question an incident asks and the one the actor column cannot answer.
  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    p_user_id,
    case p_triage
      when 'interested' then 'action.interested'
      when 'dismissed'  then 'action.dismissed'
      else                   'action.untriage'
    end,
    p_posting_key,
    v_app_id,
    jsonb_build_object('triage', p_triage, 'idem', p_idem, 'via', 'digest'),
    'user'
  );

  v_result := public.app_triage_row(v_row);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (p_user_id, p_idem, 'hq_digest_set_triage', v_result)
  -- Two racing taps under one key: the loser returns the same shape, and the row
  -- it would have written is identical.
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

