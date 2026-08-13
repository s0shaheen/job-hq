-- 20260813_011502_import_unset_marker.sql
--
-- The explicit-unset marker: the one way an import can CLEAR a stored value
-- (issue #202, the T3 half).
--
-- 0011 settled the blank rule and it stands unchanged: an empty spreadsheet
-- cell means "I did not fill this in", never "delete what you have". What 0011
-- left out is any way to delete at all — a person who wants an import to erase
-- a stale next action has no cell they can type. This migration gives them one:
-- a cell holding EXACTLY the marker `[unset]` clears its field, and the report
-- says so per column (disposition `cleared`).
--
-- THE MARKER IS A CLOSED CONTRACT, in three parts:
--
--   1. **The literal.** `hq_import_unset_marker()` returns it, and it is
--      spelled once more as `UNSET_MARKER` in `webapp/lib/import/round-trip.ts`.
--      `tests/db/test_import.py` parses the TypeScript and compares BYTE FOR
--      BYTE, the same mechanism that already pins the writable-column list. It
--      deliberately does not begin with `= + - @ TAB CR`: `escapeField`
--      neutralises a formula lead with an apostrophe on CSV export, and a
--      marker in that set would come back as `'[unset]` — matching nothing —
--      the first time a file round-tripped without passing through Excel.
--   2. **Exact match only, after `hq_blank_trim`.** The marker inside a longer
--      string is content, not a gesture; ` [unset] ` with stray spreadsheet
--      whitespace is still the marker, exactly as a padded blank is still
--      blank.
--   3. **Only the clearable columns accept it.** `hq_import_clearable_columns()`
--      is `next_action`, `next_action_date`, `applied_date` — the writable set
--      MINUS `status` (an application always has a status; there is no empty
--      rung to clear to) and MINUS `notes` (`application_notes` is append-only
--      by GRANT, 0010 — an import may add history, never erase it). A marker
--      anywhere else — status, notes, or an engine-owned column like company —
--      is a gesture this system cannot honour, and per the attack list it is
--      REFUSED BY NAME (the row fails, the report says which column), never
--      ignored: silently importing the literal text `[unset]` as somebody's
--      status is how a person learns the feature does not exist by finding the
--      marker in their pipeline.
--
-- Everything below is `create or replace` of 0011's functions plus one
-- constraint swap; no new tables, no new columns, no RLS or grant changes.
-- The audit rule's answers, stated rather than implied:
--   * ownership     — functions replaced under the same owner; no table changes
--   * grants        — unchanged; the two new helpers are IMMUTABLE constants,
--                     granted like `hq_import_writable_columns()` before them
--   * RLS           — untouched; no policy reads the marker
--   * constraints   — `import_column_reports_disposition_check` gains 'cleared'
--   * search_path   — pinned on every function below, definer or not

-- ============================================================ the two constants

/**
 * The explicit-unset marker, verbatim.
 *
 * One definition here, one in `webapp/lib/import/round-trip.ts`, pinned against
 * each other by `tests/db/test_import.py` — `hq_finished_statuses()`'s reason:
 * a hand-typed third copy is how the wrong one ships.
 */
create or replace function public.hq_import_unset_marker()
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select '[unset]'::text
$$;

comment on function public.hq_import_unset_marker() is
  'the one cell value that means "clear this field" on import; byte-identical to UNSET_MARKER in webapp/lib/import/round-trip.ts, and it must never begin with a formula-lead character or the CSV export would neutralise it';

/**
 * The columns the marker may clear: the writable set minus `status` (no empty
 * rung exists) and minus `notes` (append-only history). A subset of
 * `hq_import_writable_columns()` by construction, and `tests/db/test_import.py`
 * pins it against `CLEARABLE_COLUMNS` in round-trip.ts.
 */
create or replace function public.hq_import_clearable_columns()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['next_action', 'next_action_date', 'applied_date']::text[]
$$;

comment on function public.hq_import_clearable_columns() is
  'the writable columns an explicit [unset] marker may clear; status has no empty value and notes are append-only, so the marker on either is refused by name';

-- ============================================================ the report gains a verdict

-- `cleared` joins the disposition vocabulary: a value that was ERASED on
-- purpose is neither `imported` (nothing landed) nor a silent drop (G13's
-- enemy). The check constraint was declared inline on the `disposition` column
-- in 0011, so it carries the default name `<table>_<column>_check`.
alter table public.import_column_reports
  drop constraint if exists import_column_reports_disposition_check;
alter table public.import_column_reports
  add constraint import_column_reports_disposition_check
  check (disposition in ('imported', 'read-only', 'locked', 'unmapped',
                         'unknown-column', 'cleared'));

comment on column public.import_column_reports.disposition is
  'imported | read-only (engine-owned, differed, not written) | locked (a status a human had chosen, left alone) | unmapped (a header nobody mapped) | unknown-column (a header this app does not recognise) | cleared (the file carried the explicit unset marker and the value was erased)';

-- ============================================================ preview

/**
 * 0011's `app_import_preview`, replaced whole for one change: the round-trip
 * conflict diff compares the marker by its EFFECT. A marker in a clearable
 * column means "make this empty", so against an already-empty field it is no
 * conflict at all — asking a person to adjudicate between nothing and nothing
 * is noise — while against a live value it conflicts exactly as typed text
 * would, and the diff carries the RAW marker as `theirs` so the resolver can
 * present the gesture ("Clear this field") rather than the spelling.
 *
 * Everything else is 0011 verbatim, comments included; see that file for the
 * matching rules and the reasons.
 */
create or replace function public.app_import_preview(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_batch public.import_batches;
  v_counts jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);
  if v_batch.state not in ('mapped', 'previewed') then
    raise exception 'this import is not ready to preview (state %)', v_batch.state
      using errcode = '22023';
  end if;

  -- 1. Everything starts from a clean slate: a second preview after an edit
  --    must not inherit the first one's conclusions.
  update public.import_rows
     set match_kind = 'new', matched_application_id = null,
         conflict_state = 'none', conflict = '{}'::jsonb, notice = ''
   where batch_id = p_batch;

  -- 2. Duplicates WITHIN the file, computed first so the first occurrence keeps
  --    whatever the rules below decide and the rest are simply skipped. Blank
  --    keys are not duplicates of each other — an unkeyable row is unkeyable,
  --    not a copy of the next unkeyable row.
  with ranked as (
    select batch_id, row_number,
           row_number() over (partition by job_key order by row_number) as n
      from public.import_rows
     where batch_id = p_batch and job_key <> ''
  )
  update public.import_rows r
     set match_kind = 'duplicate-in-file',
         notice = 'the same job appears earlier in this file; the first row wins'
    from ranked
   where r.batch_id = ranked.batch_id and r.row_number = ranked.row_number
     and ranked.n > 1;

  -- 3. Round trip: an `hq_id` this user owns.
  update public.import_rows r
     set match_kind = 'round-trip',
         matched_application_id = a.id
    from public.applications a
   where r.batch_id = p_batch
     and r.match_kind <> 'duplicate-in-file'
     and a.user_id = v_user
     and public.hq_import_mapped_value(r.mapped, 'hq_id') <> ''
     and a.id::text = public.hq_import_mapped_value(r.mapped, 'hq_id');

  -- An `hq_id` that resolves to nothing must resolve to NOTHING — never to
  -- another row. Somebody else's export, or a row deleted since, lands here.
  update public.import_rows r
     set notice = 'the hq_id in this row matched none of your applications, so it was treated as a new row'
   where r.batch_id = p_batch
     and r.match_kind = 'new'
     and public.hq_import_mapped_value(r.mapped, 'hq_id') <> '';

  -- 4. Strong key -> the posting it names.
  update public.import_rows r
     set match_kind = 'matches-existing', matched_application_id = a.id
    from public.applications a
   where r.batch_id = p_batch
     and r.match_kind = 'new'
     and r.key_strength = 'strong' and r.job_key <> ''
     and a.user_id = v_user and a.posting_key = r.job_key;

  -- 5. Strong key -> a manually-added row with the same normalised name. This
  --    is the second import of the same file finding the rows the first made.
  with cand as (
    select r.row_number,
           (select a.id from public.applications a
             where a.user_id = v_user
               and a.posting_key is null
               and public.company_name_key(a.company)
                   = public.company_name_key(public.hq_import_mapped_value(r.mapped, 'company'))
               and public.company_name_key(a.title)
                   = public.company_name_key(public.hq_import_mapped_value(r.mapped, 'title'))
             order by a.id limit 1) as app_id
      from public.import_rows r
     where r.batch_id = p_batch
       and r.match_kind = 'new'
       and r.key_strength = 'strong'
       and public.hq_import_mapped_value(r.mapped, 'company') <> ''
       and public.hq_import_mapped_value(r.mapped, 'title') <> ''
  )
  update public.import_rows r
     set match_kind = 'matches-existing', matched_application_id = cand.app_id
    from cand
   where r.batch_id = p_batch and r.row_number = cand.row_number
     and cand.app_id is not null;

  -- 6. Weak key with a look-alike -> a SUGGESTION. Inserted separately, flagged,
  --    never merged. This is the rule the whole preview exists to protect.
  with cand as (
    select r.row_number,
           (select a.id from public.applications a
             where a.user_id = v_user
               and public.company_name_key(a.company)
                   = public.company_name_key(public.hq_import_mapped_value(r.mapped, 'company'))
               and public.company_name_key(a.title)
                   = public.company_name_key(public.hq_import_mapped_value(r.mapped, 'title'))
             order by a.id limit 1) as app_id
      from public.import_rows r
     where r.batch_id = p_batch
       and r.match_kind = 'new'
       and r.key_strength = 'weak'
       and public.hq_import_mapped_value(r.mapped, 'company') <> ''
       and public.hq_import_mapped_value(r.mapped, 'title') <> ''
  )
  update public.import_rows r
     set match_kind = 'suggestion', matched_application_id = cand.app_id,
         notice = 'looks like an application you already have, but the file gives no way to prove it — imported separately and flagged'
    from cand
   where r.batch_id = p_batch and r.row_number = cand.row_number
     and cand.app_id is not null;

  -- 7. Weak key with nothing to match, or no key at all.
  update public.import_rows
     set match_kind = 'unkeyable'
   where batch_id = p_batch and match_kind = 'new' and key_strength <> 'strong';

  -- 8. Round-trip conflicts, per changed cell — 0011's rule, with the marker
  --    compared by EFFECT (see the function header). `theirs` keeps the RAW
  --    marker so the resolver shows the gesture, not the spelling.
  with stale as (
    select r.row_number,
           (select jsonb_object_agg(d.col, jsonb_build_object('mine', d.mine, 'theirs', d.theirs))
              from (
                select col,
                       case col
                         when 'status'           then a.status
                         when 'notes'            then coalesce(a.notes, '')
                         when 'next_action'      then a.next_action
                         when 'next_action_date' then coalesce(a.next_action_date::text, '')
                         when 'applied_date'     then coalesce(a.applied_date::text, '')
                       end as mine,
                       public.hq_import_mapped_value(r.mapped, col) as theirs
                  from unnest(public.hq_import_writable_columns()) as col
              ) d
             -- Only cells the file actually states, and only where they differ.
             -- A blank cell is "I did not fill this in", never "delete it", so
             -- it is not a conflict to resolve. The marker in a clearable
             -- column states "make this empty", so it differs when the field
             -- is not empty and agrees when it already is.
             where d.theirs <> ''
               and (case when d.theirs = public.hq_import_unset_marker()
                          and d.col = any (public.hq_import_clearable_columns())
                     then '' else d.theirs end) is distinct from d.mine) as diff
      from public.import_rows r
      join public.applications a
        on a.id = r.matched_application_id and a.user_id = v_user
     where r.batch_id = p_batch
       and r.match_kind = 'round-trip'
       and public.hq_import_mapped_value(r.mapped, 'hq_version') <> ''
       -- Compared as an INSTANT. See hq_import_version: an unreadable token is
       -- null, and null is distinct from any real timestamp, so it lands here —
       -- as a conflict the person is asked about, which is the safe direction.
       and a.updated_at is distinct from public.hq_import_version(r.mapped)
  )
  update public.import_rows r
     set conflict_state = 'unresolved', conflict = stale.diff
    from stale
   where r.batch_id = p_batch and r.row_number = stale.row_number
     and stale.diff is not null;

  update public.import_batches set state = 'previewed' where id = p_batch
   returning * into v_batch;

  select jsonb_object_agg(match_kind, n) into v_counts
    from (select match_kind, count(*) as n from public.import_rows
           where batch_id = p_batch group by match_kind) k;

  return jsonb_build_object(
    'batch', public.app_import_batch_row(v_batch),
    'counts', coalesce(v_counts, '{}'::jsonb),
    'unresolved', (select count(*) from public.import_rows
                    where batch_id = p_batch and conflict_state = 'unresolved'));
end;
$$;

-- ============================================================ commit a chunk

/**
 * 0011's `app_import_commit_chunk`, replaced whole for the marker. Four
 * additions, everything else verbatim (see 0011 for the version-token re-check,
 * the human-status lock, the ordered locking, and the idempotency shape):
 *
 *   1. **The refusal scan.** Before a row writes anything, every column the
 *      mapped payload can name is checked for the marker; one in a
 *      non-clearable column fails the ROW with the columns named, and the
 *      chunk carries on — one bad gesture must not take 199 good rows down,
 *      exactly the stale-token rule's shape.
 *   2. **The clear flags.** A marker in a clearable column clears it: text to
 *      `''`, dates to null. `hq_import_date` already reads the marker as null
 *      (it is not a date), so the flag is computed on the RAW mapped text
 *      before the coercion that would erase the evidence. A resolver answer of
 *      'mine' cancels the clear for that cell, exactly as it discards typed
 *      text.
 *   3. **`revert.cleared`.** The columns a row ACTUALLY cleared — marker
 *      present AND a live value erased — recorded next to `revert.wrote`, so
 *      the report can count what happened rather than what the file offered
 *      (the `wrote` lesson, same paragraph of history). Clearing an
 *      already-empty field is a no-op and is not counted. `revert.before`
 *      already restores cleared values on undo; nothing there changes.
 *   4. **Fail-closed resolver answers.** A conflicted cell writes only on an
 *      explicit 'theirs'; unanswered means 'mine'. Closes the #236 security
 *      finding — a partial resolve writing every unanswered cell (stale text
 *      overwriting, a marker erasing) through the resolved-row exemption of
 *      the version re-check. The full account sits on the choices block below.
 */
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
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result into v_result from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);

  -- Re-check behind the lock (0003:166-182). A chunk that times out on the
  -- client and is retried arrives while the original is still running; without
  -- this the retry commits the same 200 rows a second time.
  select result into v_result from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

-- ============================================================ per-column report

/**
 * 0011's `app_import_report`, replaced whole for one addition: the `cleared`
 * lines. Counted from `revert.cleared` — recorded by the commit, which is the
 * only place that knows what actually happened — for exactly the reason
 * `imported` counts `revert.wrote`: a marker the resolver answered 'mine', or
 * one that found the field already empty, cleared nothing and must not be
 * reported as if it had.
 */
create or replace function public.app_import_report(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_batch  public.import_batches;
  v_rows   jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  v_batch := public.hq_import_lock_batch(p_batch);

  delete from public.import_column_reports
   where batch_id = p_batch and disposition in ('imported', 'read-only', 'cleared');

  -- Engine-owned columns whose imported value differed from the live one. Only
  -- the columns an export actually carries are checked: an unrecognised header
  -- is already an `unknown-column` row from the mapping step.
  insert into public.import_column_reports
    (batch_id, user_id, column_name, disposition, rows_affected, sample)
  select p_batch, v_user, d.label, 'read-only', count(*),
         to_jsonb((array_agg(d.theirs order by d.row_number))[1:3])
    from (
      select r.row_number, x.label, x.theirs
        from public.import_rows r
        join public.applications a on a.id = r.matched_application_id and a.user_id = v_user
        -- `unnest` of three parallel arrays rather than a correlated VALUES
        -- list: VALUES in a LATERAL cannot reference the outer rows on every
        -- supported server, and a construct that works on one minor version is
        -- not a mechanism.
        cross join lateral unnest(
            array['Company', 'Title', 'URL'],
            array[public.hq_import_mapped_value(r.mapped, 'company'),
                  public.hq_import_mapped_value(r.mapped, 'title'),
                  public.hq_import_mapped_value(r.mapped, 'url')],
            array[a.company, a.title, coalesce(a.url, '')]
          ) as x(label, theirs, mine)
       where r.batch_id = p_batch
         and r.outcome in ('updated', 'skipped')
         and x.theirs <> ''
         -- Normalised, so a difference of case or of a pasted NBSP is not
         -- reported as a difference. What the report is for is the value that
         -- genuinely disagrees and was not written.
         and public.company_name_key(x.theirs) is distinct from public.company_name_key(x.mine)
    ) d
   group by d.label
  on conflict (batch_id, column_name, disposition) do update
    set rows_affected = excluded.rows_affected, sample = excluded.sample;

  -- The columns that WERE written, so the report is a full account rather than
  -- a list of disappointments. `revert.wrote` is recorded by the commit itself,
  -- which is the only place that knows what landed (0011's lesson).
  insert into public.import_column_reports
    (batch_id, user_id, column_name, disposition, rows_affected, sample)
  select p_batch, v_user, w.label, 'imported', w.n, '[]'::jsonb
    from (
      select label, count(*) as n from (
        select case col when 'status' then 'Status'
                        when 'notes' then 'Notes'
                        when 'next_action' then 'Next action'
                        when 'next_action_date' then 'Next action date'
                        when 'applied_date' then 'Applied' end as label
          from public.import_rows r
         cross join unnest(public.hq_import_writable_columns()) as col
         where r.batch_id = p_batch and r.outcome in ('created', 'updated')
           and r.revert -> 'wrote' @> to_jsonb(col)
      ) c group by label
    ) w
   where w.label is not null
  on conflict (batch_id, column_name, disposition) do update
    set rows_affected = excluded.rows_affected;

  -- The columns the marker ERASED — the report saying so is half the feature
  -- (the acceptance criterion is "clear that field and say so in the report").
  insert into public.import_column_reports
    (batch_id, user_id, column_name, disposition, rows_affected, sample)
  select p_batch, v_user, w.label, 'cleared', w.n, '[]'::jsonb
    from (
      select label, count(*) as n from (
        select case col when 'next_action' then 'Next action'
                        when 'next_action_date' then 'Next action date'
                        when 'applied_date' then 'Applied' end as label
          from public.import_rows r
         cross join unnest(public.hq_import_clearable_columns()) as col
         where r.batch_id = p_batch and r.outcome = 'updated'
           and r.revert -> 'cleared' @> to_jsonb(col)
      ) c group by label
    ) w
   where w.label is not null
  on conflict (batch_id, column_name, disposition) do update
    set rows_affected = excluded.rows_affected;

  select jsonb_agg(jsonb_build_object('column', column_name, 'disposition', disposition,
                                      'rows', rows_affected, 'sample', sample)
                   order by disposition, column_name)
    into v_rows
    from public.import_column_reports where batch_id = p_batch;

  return jsonb_build_object('batch', public.app_import_batch_row(v_batch),
                            'columns', coalesce(v_rows, '[]'::jsonb));
end;
$$;

-- ============================================================ grants, restated

-- `create or replace` keeps the ACLs and the owner of an existing function, so
-- the three replaced app_* functions keep 0011's `revoke all from public` +
-- `grant execute to authenticated` exactly. Restated here for the two NEW
-- helpers only, matching how 0011 treats its own immutable constants
-- (`hq_import_writable_columns` is callable by default — it is a constant, and
-- the default execute grant to public is the pattern this file inherits).
comment on function public.app_import_preview(uuid) is
  'preview with marker-aware conflicts; replaced by 20260813_011502_import_unset_marker.sql, grants unchanged from 0011';
comment on function public.app_import_commit_chunk(uuid, integer, text) is
  'commit with explicit-unset clears and the marker refusal; replaced by 20260813_011502_import_unset_marker.sql, grants unchanged from 0011';
comment on function public.app_import_report(uuid) is
  'per-column report including cleared; replaced by 20260813_011502_import_unset_marker.sql, grants unchanged from 0011';
