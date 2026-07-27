-- 0012 — the Search Profile: a dry run that cannot write, and a save that
-- cannot re-triage a decided row.
--
-- WHY THIS EXISTS
--
-- A wrong `metros` or `yoe_max` produces an empty queue, and an empty queue is
-- indistinguishable from "no jobs were posted". Every other mistake in this app
-- is visible on screen; this one is silent, and it is silent for weeks. So the
-- profile is never saved blind: the app runs the ported gate over a real corpus
-- first and states what the change would do.
--
-- Two functions, and each carries one uncomfortable decision stated rather than
-- buried.
--
-- 1. `app_preview_corpus` is `security definer`, which WIDENS a read that
--    `0002_invariants.sql` deliberately narrowed. That policy scopes `postings`
--    to rows the caller was already gated on — correct everywhere else, and
--    fatal here: a user onboarding has ZERO `user_postings` rows and would
--    preview their brand-new profile against an empty universe, concluding the
--    product is broken. The widening is bounded (5,000 rows, 90 days), excludes
--    `url`, refuses an unauthenticated caller, and returns only what the gate
--    reads. All users watch the same posting universe by design
--    (`0001_init.sql:6-9`), so this exposes no other person's data — what it
--    exposes is the shared feed, one page of it, to somebody the allowlist
--    already admitted.
--
--    Name the part that is easy to skip: `company` on those rows is the UNION of
--    every user's watched companies, which is precisely what 0002's
--    `companies_visible_to_watchers` policy exists to hide. A caller learns that
--    somebody in this deployment watches Guggenheim, and at allowlist scale (a
--    family of three, a ceiling of ten, every member known to every other) that
--    is a fair price for a preview that is not a lie. It stops being fair the day
--    the allowlist holds strangers — which is the trigger to replace this with a
--    per-user corpus seeded from the companies THAT user watches. A silent
--    widening is the bug; a stated one is a decision.
--
--    It is `stable`, not `volatile`, and that is a MECHANISM rather than a
--    label: Postgres refuses a write from inside a stable function, so "the dry
--    run does not write" stops being a promise this file makes.
--
-- 2. `app_commit_profile` takes the re-gate plan AS DATA. The gate is already
--    implemented twice — `monitor/gates.py` and `webapp/lib/gating/dispose.ts`,
--    pinned to `tests/fixtures/gate-corpus.json` from both languages — and a
--    third copy in PL/pgSQL would need its own guard while failing silently.
--    Same call as migration 0011 made for `job_key` (matrix row 141). What SQL
--    does instead is RE-VERIFY every promise in the plan under the row lock,
--    because a plan computed against a read is not evidence about the state at
--    write time.
--
-- G8, in one clause: `triage = ''`. A row somebody decided is theirs, whatever
-- the profile now says. That single WHERE gives acceptance criterion 18 (a
-- narrowed profile leaves an `interested` posting alone) and the dismissed half
-- of 19 (a widened profile does not reanimate a dismissed row — G3), on the
-- server, where a client bug cannot route around it.
--
-- PHASE-PROFILE's increment 3 also asks to "retrofit `app_set_triage` into the
-- same family". Nothing to do: the plan predates `0003_write_path.sql`, which
-- established that family — `command_idempotency` storing the RESULT, the
-- post-lock replay re-check, `expected_updated_at`, and the row and its event
-- in one body. This file joins it rather than defining it.

-- ============================================================ the profile row

/**
 * One profiles row, shaped for `toProfileView` in supabase-source.ts.
 *
 * Extracted for `app_triage_row`'s reason: two paths return it (a commit, and
 * a replay of one), and a replay that answers a differently-shaped object than
 * the original write is the kind of difference nothing catches until the UI
 * renders blanks.
 *
 * Deliberately NOT security definer — it is only ever called from inside
 * `app_commit_profile`, which already runs as the definer, so it inherits the
 * rights it needs. Marking it definer would hand a standalone caller a read of
 * anybody's profile.
 */
create or replace function public.app_profile_row(pr public.profiles)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'criteria',   pr.criteria,
           'notify',     pr.notify,
           'updated_at', pr.updated_at
         );
$$;

revoke all on function public.app_profile_row(public.profiles) from public;

-- ============================================================ the dry run

/**
 * The postings a profile preview is computed over.
 *
 * The projection is the narrowest thing that answers the question: the gate
 * reads `tags` (min_yoe, seniority, comp_range, work_model, tagged_at) and
 * `geo` (country, remote, metro), and the panel shows a handful of examples by
 * company and title. `url` is excluded on purpose — nothing about a dry run
 * needs a link, and a widened read should carry the minimum.
 *
 * `status <> 'Closed'` mirrors acceptance criterion 16: a dead posting is not
 * evidence about what a profile would let through tomorrow.
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
   -- The definer bypasses RLS, so authentication is checked HERE. Without this
   -- line the widening reaches anyone who can post to /rest/v1/rpc, and the
   -- grant below would be the only thing standing in front of it.
   where auth.uid() is not null
     and p.last_seen >= current_date - least(greatest(coalesce(p_days, 30), 1), 90)
     and p.status <> 'Closed'
   order by p.last_seen desc, p.key
   limit 5000;
$$;

revoke all on function public.app_preview_corpus(int) from public, anon, authenticated;
grant execute on function public.app_preview_corpus(int) to authenticated;

-- ============================================================ the save

/**
 * Save a Search Profile and restamp the untriaged rows it moves.
 *
 * `p_regate` is `[{key, disposition, reason}, …]` computed in TypeScript. Every
 * entry is re-checked here: the row must still be untriaged, the tuple must
 * really differ, and a `filtered` entry must carry a reason (0002's
 * `filtered_rows_state_a_reason` CHECK aborts the whole save otherwise, which
 * is correct and loud — and not something the plan should be able to trigger).
 *
 * `restamped` and `newly_qualified_keys` are counted from what the UPDATE
 * ACTUALLY did, never from what the plan asked for. The review banner links to
 * those keys, and a banner promising rows that were not written is the shape of
 * matrix row 169 — a report that adds up to more than the batch.
 */
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
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_commit_profile(jsonb, jsonb, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_commit_profile(jsonb, jsonb, jsonb, text, timestamptz)
  to authenticated;
