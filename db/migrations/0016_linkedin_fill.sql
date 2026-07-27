-- 0016 — the engine fills the LinkedIn company id, and only where no person has
-- ever answered.
--
-- Reading order: 0013_referral.sql first. That migration put
-- `companies.linkedin_company_id` on the shared company row, gave it a version
-- token and a conditional touch trigger, and left it with exactly ONE writer — a
-- person pasting a number off their own URL bar. Its header says what happens next
-- in so many words: *"the day the engine backfills it is the day somebody's company
-- cell renders a link nobody wrote."* This is that day, arriving with the guards
-- 0013 asked for.
--
-- WHY THE ENGINE IS WRITING THIS AT ALL. The referral finder's deep links need a
-- numeric company id per company, and the only source was a per-company paste box —
-- 640 companies, one number at a time, by hand. Meanwhile `monitor/wide.py` already
-- hits TheirStack every morning and every job row it buys carries a
-- `company_object` whose firmographics include the LinkedIn id (probe #2,
-- 2026-07-26; the field measured numeric 2026-07-27). We were parsing that payload
-- and throwing the id away. The harvest costs ZERO extra API credits; this function
-- is where it lands.
--
-- WHY A FUNCTION AND NOT A PATCH THROUGH `core/pg.py`. 0015's answer, unchanged:
-- the shape the engine could not otherwise have is read-decide-write with nothing
-- able to slip in between. The decision here is "has anybody answered this company
-- yet", the competing writer is a HUMAN pressing save in the web app, and split
-- across REST calls that question is answered a network round trip before the write
-- that depends on it.
--
-- ============================================================================
-- WHAT THE FIRST VERSION OF THIS FILE GOT WRONG. Both defects were found by
-- executing it rather than by reading it, and both are the same mistake in
-- different clothes: **"blank" is not the same question as "unanswered".**
--
-- 1. A HUMAN'S DELIBERATE CLEAR WAS UNDONE THE NEXT MORNING. 0013 accepts `''` as a
--    legal paste (`if v_id <> '' and v_id !~ …`), so blanking the cell is how a
--    person says *"the id in here is wrong and I do not have the right one."* The
--    first version read blank as *fill me*, and the harvest rides the DAILY
--    `wide_theirstack` cron — so the correction survived until 08:50 CT and then
--    reverted, forever, on a lane that spends nothing and therefore throttles
--    nothing. Executed: `after the clear, the harvest says: filled`.
--
-- 2. "HUMANS WIN" WAS ENFORCED PER ROW WHILE THE CLAIM WAS PER COMPANY.
--    `app_set_linkedin_company_id` writes ONE `p_company_id`; this function matches
--    every row whose `company_name_key(name)` matches, and 0008's own reading is
--    that one company legitimately holds several rows (one per board). So a person
--    pasting on the row they could see left the sibling blank, and the engine filled
--    that sibling with a DIFFERENT id and reported `filled`. Executed: `outcome:
--    filled  a = 2077  b = 1035` — one employer, two ids, no divergence signal
--    anywhere.
--
-- The fix for both is one column and one lock. `linkedin_id_source` is the
-- `status_actor` pattern from 0010 applied to a single field: it records WHO last
-- answered, so a blank cell carrying `'human'` is a tombstone rather than an
-- invitation. And the whole company — every board row — is locked and judged
-- together, so the two doors stop having different granularity.
-- ============================================================================
--
-- NOT SECURITY DEFINER, and it takes `p_user_id`. Those two facts belong together
-- (0015's note, and `tests/core/test_migrations.py::
-- test_definer_functions_never_take_a_user_id` is what makes it a rule): a definer
-- function accepting the acting user as an argument is an authorization bypass with
-- extra steps. This runs with the CALLER's rights, and the only caller is the
-- engine's service role.
--
-- THE COLUMN IS SHARED AND SO IS THE FILL. 0013 chose to keep
-- `linkedin_company_id` on `public.companies` rather than per-subscription, and
-- accepted the consequence: one person's value is visible to every other watcher.
-- This function does NOT require the acting user to watch the company. Requiring it
-- would mean the harvest silently dropping an id for a company somebody ELSE
-- watches — `public.companies` is the design's monotonically-growing shared asset
-- (0008/0009's phrase), and one lane's subscription list must not decide what is
-- true about a company for everybody. `p_user_id` names whose LANE did the work,
-- which is what the audit event records; it is not an authorization argument.

-- ============================================================ provenance

/**
 * WHO last answered this company's LinkedIn id: '' (nobody), 'human', or 'engine'.
 *
 * 0010's `status_actor` for a single field, and for the reason that column exists:
 * two writers with different authority need the row to remember which one spoke,
 * because the VALUE alone cannot distinguish "nobody has looked" from "somebody
 * looked and the answer is none of the ones on offer".
 *
 * Free-vocab text with no CHECK, 0008's precedent: `public.companies` is
 * bulk-upserted by `monitor/discover_universe.upsert_universe` through PostgREST,
 * and a table-wide CHECK on a column a 500-row chunk touches lets one unrecognised
 * value wedge the whole mirror. The closed set lives in the two functions that write
 * it. Readers treat anything that is not exactly 'human' as not-human, which is the
 * safe direction for this guard: an unrecognised value means the engine may write,
 * and an engine write is recoverable where overwriting a person is not.
 *
 * IT IS ALSO WHAT THE WEB APP GATES ITS CORRECTION CONTROL ON, which is the other
 * half of this migration's reason to exist. `warm-cell.tsx` renders the paste box in
 * exactly one branch — when there are no links to render — so a valid id REMOVED the
 * only writer surface in the product. That was tolerable while the only writer was
 * the person who pasted it; making a bot the first writer for hundreds of companies
 * turns it into a lock-out. The control appears when `linkedin_id_source = 'engine'`:
 * exactly where the bot answered, which is exactly where somebody may need to
 * disagree. A human-pasted id keeps the surface it always had, unchanged.
 */
alter table public.companies
  add column if not exists linkedin_id_source text not null default '';

comment on column public.companies.linkedin_id_source is
  'who last answered linkedin_company_id: human | engine | '''' (nobody). A BLANK id with source=''human'' is a deliberate clear and no bot may refill it (0016)';

/**
 * Every id that exists TODAY was pasted by a person, so say so.
 *
 * Before this migration the only writer was `app_set_linkedin_company_id`. Leaving
 * those rows at `''` would classify a human's existing research as unowned, and the
 * first thing that reads the column alone would get it wrong. Marking them is one
 * statement and makes the column's meaning true for the whole table rather than only
 * for rows written after today.
 *
 * Idempotent (`and linkedin_id_source = ''`), so re-running the directory is free —
 * `db/apply.sh` re-runs every file, and this must not relabel an engine fill as
 * human on the second pass.
 */
update public.companies
   set linkedin_id_source = 'human'
 where public.hq_blank_trim(linkedin_company_id) <> ''
   and linkedin_id_source = '';

/**
 * The /companies grid row, re-declared to carry the provenance with the id.
 *
 * REPLACED, NOT WRAPPED — 0013's own words when it did this to 0008's version: the
 * three write paths and their replays must not answer differently-shaped objects, and
 * a second builder for "the same row plus one field" is that divergence with a
 * different name. ADDITIVE: one key, nothing reordered, nothing renamed.
 *
 * The field rides INSIDE the nested `companies` object because that is what it is a
 * fact about — the shared company row, not the subscription — and `toCompanyView` in
 * supabase-source.ts already unwraps that object. It travels with
 * `linkedin_company_id` for the reason `match.ts` states about its own three fields:
 * a cell needs the id and its provenance at the same instant, and two lookups over
 * one key is two chances to answer for different companies.
 */
create or replace function public.app_company_row(uc public.user_companies)
returns jsonb
language sql
stable
-- Deliberately NOT security definer: only ever called from inside the definer
-- functions, so it already runs with the rights it needs (0008's note).
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'company_id',   uc.company_id,
           'monitor',      uc.monitor,
           'priority',     uc.priority,
           'seeded',       uc.seeded,
           'review_state', uc.review_state,
           'updated_at',   uc.updated_at,
           'companies', jsonb_build_object(
             'id',                  c.id,
             'name',                c.name,
             'ats',                 c.ats,
             'slug',                c.slug,
             'source',              c.source,
             'reliability_tier',    c.reliability_tier,
             'resolution_method',   c.resolution_method,
             'linkedin_company_id', c.linkedin_company_id,
             'linkedin_id_source',  c.linkedin_id_source,
             'updated_at',          c.updated_at
           )
         )
    from public.companies c
   where c.id = uc.company_id
$$;

revoke all on function public.app_company_row(public.user_companies) from public;

-- ============================================================ the human door, again

/**
 * `app_set_linkedin_company_id`, re-declared to stamp the provenance it now owns.
 *
 * REPLACED, NOT WRAPPED, and the signature is byte-identical — 0015 redefines
 * `hq_finished_statuses` and 0013 redefines `app_company_row` for exactly this
 * reason. PostgREST resolves overloads by argument NAME, so a second copy with a
 * different parameter list would make every call from the web app ambiguous; and a
 * list that exists twice is a list that will disagree with itself.
 *
 * TWO CHANGES, both in the same direction: a person's gesture is always recorded as
 * a person's.
 *
 *   * `linkedin_id_source = 'human'` on every write, INCLUDING a clear. The clear is
 *     the whole point — it is how somebody says "not this id" — and without the stamp
 *     the next morning's harvest undoes it.
 *   * the write now also fires when the VALUE is unchanged but the source is not
 *     'human': a person confirming the id a bot found is a person claiming it. 0013's
 *     version skipped an unchanged value, which would have left a bot-provenance row
 *     bot-owned no matter how many times somebody re-pasted the same number.
 *
 * That second change moves the version token where 0013's comment says it would not
 * ("The row itself is still left alone, so the version token does not move under
 * another tab"). The comment stays true for its case — a no-op paste on an
 * ALREADY-human row still writes nothing — and the new case is a real state change,
 * so the token moving is correct and the conflict another tab then sees is truthful.
 */
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

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_set_linkedin_company_id(bigint, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_set_linkedin_company_id(bigint, text, text, timestamptz)
  to authenticated;

-- ============================================================ the engine door

/**
 * Fill a company's LinkedIn id from a provider payload — where nobody has answered.
 *
 * MATCHED BY NORMALIZED NAME, never raw equality. `company_name_key` (0008) is what
 * the unresolved-name index, the paste path and the resolver all match on, and it
 * exists because 'Aon', 'aon' and a name carrying a trailing NBSP off a web page are
 * one company. A provider's spelling is exactly the kind of string that arrives
 * folded differently from ours, so `= p_name` would miss the row it was aiming at
 * and report `no_company` on a company we are watching.
 *
 * THE WHOLE COMPANY IS LOCKED BEFORE ANYTHING IS DECIDED, in `id` order.
 *
 * Not a nicety — it is what makes the per-company judgement true under concurrency.
 * A guard expressed only in the UPDATE's WHERE clause is re-evaluated per TARGETED
 * ROW (read-committed's EvalPlanQual), so a paste landing on row B mid-statement
 * could still leave row A already written with the bot's id. Taking `for update` on
 * every row of the name key FIRST means a paste anywhere in the company blocks this
 * function before it has decided anything, and the counts read afterwards are the
 * post-commit truth. `order by id` because two engine lanes can reach the same
 * company at once and an undefined lock order is a deadlock.
 *
 * EVERY row sharing the key is filled, together or not at all. 0008's reading is
 * that one company legitimately holds more than one row when it has more than one
 * board, and a LinkedIn company id is a fact about the COMPANY. Filling one and
 * leaving its sibling blank renders a paste prompt next to a working link for the
 * same employer; filling a sibling a person answered differently puts two ids on one
 * employer.
 *
 * THE CLOSED SET, repeated from `app_set_linkedin_company_id` rather than
 * referenced. Same regexp, same anchors, same reason: the column is free-vocab by
 * 0008's precedent, so the guard lives at every door instead. An unanchored
 * `~ '[0-9]{1,20}'` matches the digits inside `javascript:1` and would let the whole
 * string into a value the web app concatenates into a URL — the engine door is the
 * one a provider's payload arrives at, so it is the one that most needs the anchors.
 *
 * `hq_blank_trim` (0010) for the emptiness test, never bare `btrim`. `btrim(x)` with
 * no second argument trims SPACES ONLY, so a cell holding one tab, one NBSP or one
 * zero-width space reads as ALREADY SET, and that company never gets an id again
 * from any run. Those are precisely the cells a paste out of a browser produces.
 * `core.linkedinids.is_blank` is the Python mirror and
 * `tests/db/test_linkedin_fill.py` runs the two over one corpus.
 *
 * THE TOUCH TRIGGER IS RESPECTED BY CONSTRUCTION. 0013's `companies_touch` fires
 * `when (old.* is distinct from new.*)` precisely so a bulk mirror cannot turn the
 * version token into a mirror-activity timestamp and make an open tab's paste 409
 * against a change nobody made. Every path that writes nothing here returns BEFORE
 * the UPDATE, so a no-op fill never reaches the trigger. A row that IS filled moves
 * its token, which is correct — the value a tab is holding really did change, and
 * the conflict the web app then reports is truthful (reloading shows the id).
 *
 * OUTCOMES, returned rather than raised, because each is a thing the caller reports
 * differently and none of them is an error:
 *
 *   filled       nobody had answered this company; every row took the id.
 *   already_set  the company carries an id no human has claimed — an earlier engine
 *                fill, on any of its rows.
 *   human_owned  a person has answered this company, INCLUDING by clearing it. The
 *                tombstone, and the divergence signal: it also fires when the person
 *                answered a sibling board this payload did not name. Never collapsed
 *                into `already_set`, because the two call for opposite reactions —
 *                one is "the store is ahead of the provider", the other is "stop
 *                asking".
 *   no_company   nothing in the universe normalizes to this name. Not invented —
 *                `public.companies` rows are minted by the resolver and the review
 *                grid, and a provider's job payload is recall, not grounding.
 *
 * NO `command_idempotency` ROW, deliberately, diverging from the browser doors. The
 * guards already make a replay a no-op, and storing a command result would answer
 * "already applied" for a company a human may have answered in the meantime — the
 * same reason 0015's `hq_note_unapplied_event` keeps its paths retryable. There is
 * also no client rendering this answer: the callers count it.
 */
create or replace function public.hq_fill_linkedin_company_id(
  p_user_id     uuid,
  p_name        text,
  p_linkedin_id text,
  p_source      text
)
returns jsonb
language plpgsql
-- Pinned for 0009's reason: this body calls `public.company_name_key` and
-- `public.hq_blank_trim`, and a shadowed resolution of either decides whether
-- somebody's pasted id survives.
set search_path = public, pg_temp
as $$
declare
  v_key     text := public.company_name_key(p_name);
  v_id      text := public.hq_blank_trim(coalesce(p_linkedin_id, ''));
  v_ids     bigint[];
  v_matched int;
  v_valued  int;
  v_human   int;
begin
  if p_user_id is null then
    raise exception 'hq_fill_linkedin_company_id needs the user whose lane it writes'
      using errcode = '22023';
  end if;
  -- A nameless company is a caller bug, not an outcome: there is nothing to match
  -- on, and answering `no_company` would let a payload whose name field is empty
  -- look exactly like a company we simply do not watch.
  if v_key = '' then
    raise exception 'hq_fill_linkedin_company_id needs a company name'
      using errcode = '22023';
  end if;
  if v_id !~ '^[0-9]{1,20}$' then
    raise exception 'a LinkedIn company id is digits only (got %)',
      left(coalesce(p_linkedin_id, ''), 60) using errcode = '22023';
  end if;

  -- Lock the whole company first. See the header: this is what makes the decision
  -- below per-COMPANY under concurrency rather than per-row-as-it-was-reached.
  perform 1 from public.companies
   where public.company_name_key(name) = v_key
   order by id
     for update;

  select count(*),
         count(*) filter (where public.hq_blank_trim(linkedin_company_id) <> ''),
         -- Anything that is not exactly 'human' counts as not-human: an
         -- unrecognised provenance must not lock the column against every future
         -- run, and an engine write is recoverable where overwriting a person is not.
         count(*) filter (where linkedin_id_source = 'human')
    into v_matched, v_valued, v_human
    from public.companies
   where public.company_name_key(name) = v_key;

  if v_matched = 0 then
    return jsonb_build_object('outcome', 'no_company', 'company_ids', '[]'::jsonb,
                              'matched', 0, 'linkedin_company_id', v_id);
  end if;
  -- Checked BEFORE `already_set`, and the order is the rule: a person who cleared
  -- the cell leaves it blank, so a check asking "is there a value" first would read
  -- the tombstone as an invitation and re-fill it every morning.
  if v_human > 0 then
    return jsonb_build_object('outcome', 'human_owned', 'company_ids', '[]'::jsonb,
                              'matched', v_matched, 'linkedin_company_id', v_id);
  end if;
  if v_valued > 0 then
    return jsonb_build_object('outcome', 'already_set', 'company_ids', '[]'::jsonb,
                              'matched', v_matched, 'linkedin_company_id', v_id);
  end if;

  update public.companies
     set linkedin_company_id = v_id,
         linkedin_id_source  = 'engine'
   where public.company_name_key(name) = v_key
     -- Redundant against the counts above while the lock holds, and KEPT: these are
     -- the predicates that would still stand if the lock were ever removed, and a
     -- guard whose last line of defence is a comment is not a guard.
     and public.hq_blank_trim(linkedin_company_id) = ''
     and linkedin_id_source <> 'human';

  -- Re-read rather than `returning … into`, which keeps only the last row of a
  -- multi-row UPDATE. The event payload names every row this wrote.
  select coalesce(array_agg(id order by id), '{}'::bigint[]) into v_ids
    from public.companies
   where public.company_name_key(name) = v_key
     and linkedin_id_source = 'engine'
     and linkedin_company_id = v_id;

  -- The state change and its audit event in one body, or the trail has holes in it.
  -- This column earns the trail more than most: it is SHARED, so "who put 1035 on
  -- Ramp and when" is a question somebody will ask, and after this migration the
  -- answer is sometimes "a bot did, off a TheirStack row, on Tuesday".
  -- `company.linkedin_id.filled` is deliberately a DIFFERENT kind from 0013's
  -- `company.linkedin_id.set`: one is a person's gesture and the other is a harvest,
  -- and collapsing them would make the human trail unreadable.
  --
  -- Written only on `filled` — every other path has already returned. The divergence
  -- from 0013 (where a no-op paste still writes an event) is the difference between
  -- the writers: a person re-confirming a value is information, and a bot re-reading
  -- the same TheirStack payload every morning for a year is 365 identical rows in an
  -- append-only table.
  insert into public.events (user_id, kind, payload, actor)
  values (p_user_id, 'company.linkedin_id.filled',
          jsonb_build_object(
            'company_ids',         to_jsonb(v_ids),
            'name',                p_name,
            'name_key',            v_key,
            'linkedin_company_id', v_id,
            'source', coalesce(nullif(public.hq_blank_trim(p_source), ''), 'engine')),
          'system');

  return jsonb_build_object(
    'outcome',             'filled',
    'company_ids',         to_jsonb(v_ids),
    'matched',             v_matched,
    'linkedin_company_id', v_id);
end;
$$;

comment on function public.hq_fill_linkedin_company_id(uuid, text, text, text) is
  'engine-only: fill a company''s linkedin_company_id from a provider payload — matched on company_name_key, digits-only, the whole company judged under one lock, and never where a person has answered (including a deliberate clear)';

-- `public` is the pseudo-role; `anon` and `authenticated` hold their own grants from
-- Supabase's default privileges and would keep them. All three are revoked by name,
-- because this function takes the acting user as an argument and writes a column
-- every watcher of that company reads.
revoke all on function public.hq_fill_linkedin_company_id(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_fill_linkedin_company_id(uuid, text, text, text)
  to service_role;
