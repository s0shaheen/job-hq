-- P9 — Import: the spreadsheet people arrive with, and the one they take away.
--
-- Reading order: 0003_write_path.sql, then 0010_pipeline.sql. Every function
-- here follows both exactly and for the same reasons — `security definer` +
-- `auth.uid()` (the caller cannot name a user), the row and its audit event in
-- one body, the stored idempotency RESULT, a post-lock re-check of that key
-- (0003:166-182 — the pre-lock check only settles SEQUENTIAL replays), ordered
-- locking so two tabs cannot deadlock (0008's row 95), a version token that
-- turns a second device into a visible conflict, and bounds on everything a
-- browser can send.
--
-- Numbered 0011 because 0010 is taken. Migrations are assigned serially AT
-- BUILD TIME; `test_migrations_are_contiguously_numbered` is the tripwire.
--
-- ------------------------------------------------------------------------
-- THREE DECISIONS THAT ARE NOT IN docs/plans/PHASE-IMPORT.md, STATED HERE
-- BECAUSE THE PLAN'S PHRASING INVITES THE OTHER READING
-- ------------------------------------------------------------------------
--
-- 1. **`job_key` is NEVER computed in SQL.** The plan says
--    `app_import_set_mapping` "recomputes mapped/job_key/key_strength". Doing
--    that here would make a THIRD implementation of the most drift-prone
--    function in the system — `core/jobkeys.py`, `webapp/lib/import/job-key.ts`
--    and this file — and the failure it produces is silent: a key that differs
--    by one character makes every re-import a duplicate. Two implementations
--    are already guarded mechanically by one golden fixture asserted from both
--    languages (`tests/fixtures/jobkeys.golden.json`); a third has no such
--    guard and would need one. So the keys arrive as data, computed once by the
--    server action, and this file only ever compares them.
--
--    What that costs: a hostile caller can post a bogus `job_key`. What it
--    buys them: nothing. Every lookup below is scoped to `auth.uid()`, so the
--    worst a fabricated key reaches is the caller's own rows — the same bound
--    `app_set_triage` already relies on.
--
-- 2. **An import is not a human status gesture — except on a round trip.**
--    0010's trigger locks `status` once a person has chosen one. If a bulk
--    import claimed that lock, importing 2,000 rows would permanently deafen
--    the engine on all 2,000: no Gmail-captured rejection, OA or interview
--    could ever advance them again. So a plain import writes
--    `status_actor = 'system'` on the rows it creates, and on a row already
--    locked it does not write `status` AT ALL — it reports the difference
--    instead (disposition `locked`). Without that skip the trigger would raise
--    and one locked row would kill a 200-row chunk.
--
--    A ROUND TRIP is different, and the difference is evidence, not taste: the
--    file carries `hq_version`, and a row is only written when that token still
--    equals the row's `updated_at`. That is precisely the proof `app_set_status`
--    demands of the pipeline UI — the person demonstrably read the current
--    value and chose another one. So a round-trip status CHANGE is a declared
--    human write and claims the lock, exactly as pressing the Select would.
--    A round-trip row whose status is unchanged declares nothing.
--
-- 3. **Chunk-atomic, batch-reversible.** G12 asks for "chunked, resumable,
--    batch-atomic", and those pull against each other. The resolution: each
--    chunk is one transaction, and the BATCH is atomic by being reversible in
--    one gesture. A single 2,000-row transaction invites a statement timeout
--    and gives back nothing when it hits one; chunks of 200 always make
--    progress, `committed_count` is the resume cursor, and `app_import_undo`
--    is what makes a half-committed batch recoverable. Undo itself is one
--    function body, so it IS atomic — all or nothing, always.

-- ============================================================ the writable set

/**
 * The columns an import may write on an EXISTING application. Everything else
 * in the file is engine-owned: compared, reported, never written (G13).
 *
 * One definition, for `hq_finished_statuses()`'s reason — this list is also
 * spelled out in `webapp/lib/import/round-trip.ts` and in spec §E, and a
 * hand-typed fourth copy is how the wrong one ships. `tests/db/test_import.py`
 * pins the two against each other.
 *
 * These are the DATABASE column names. The mapped payload uses the TypeScript
 * target-field names (`nextActionDate`), and the translation happens in exactly
 * one place — `hq_import_mapped_value()` below.
 */
create or replace function public.hq_import_writable_columns()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['status', 'notes', 'next_action', 'next_action_date', 'applied_date']::text[]
$$;

comment on function public.hq_import_writable_columns() is
  'the five human-owned columns an import may write; every other column in an imported file is engine-owned and only reported on';

/**
 * One mapped cell, by DATABASE column name, trimmed and normalised to text.
 *
 * The mapped payload is keyed by the TypeScript target-field names because
 * that is what the mapping UI binds to; this is the single place the two
 * vocabularies meet. A second translation site is a second place for
 * `next_action_date` to become `nextactiondate` and silently read as absent.
 *
 * `hq_blank_trim`, not `btrim`: bare btrim trims spaces only, so a cell holding
 * one newline reads as content (0010's lesson, in the one place a spreadsheet
 * makes it likely — Excel cells are full of stray whitespace).
 */
create or replace function public.hq_import_mapped_value(p_mapped jsonb, p_column text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select public.hq_blank_trim(p_mapped ->> (case p_column
           when 'status'           then 'status'
           when 'notes'            then 'notes'
           when 'next_action'      then 'nextAction'
           when 'next_action_date' then 'nextActionDate'
           when 'applied_date'     then 'appliedDate'
           when 'company'          then 'company'
           when 'title'            then 'title'
           when 'url'              then 'url'
           when 'location'         then 'location'
           when 'hq_id'            then 'hqId'
           when 'hq_version'       then 'hqVersion'
           else p_column
         end))
$$;

/**
 * A mapped date cell as a `date`, or null.
 *
 * The TypeScript `coerceDate()` has already refused everything it could not
 * read (an ambiguous `03/04/2026` arrives as null, not as a guess), so anything
 * reaching here is ISO or nothing. The exception block is not optimism about
 * that: this function is reachable from a browser through the mapped payload,
 * and `'garbage'::date` raises 22007 mid-chunk, which would surface to a person
 * as a wall of Postgres text about a spreadsheet cell.
 */
create or replace function public.hq_import_date(p_mapped jsonb, p_column text)
returns date
language plpgsql
-- STABLE, not IMMUTABLE: `text::date` depends on the session's DateStyle, so
-- promising immutability here would be a lie the planner is entitled to believe.
stable
set search_path = public, pg_temp
as $$
declare
  v_text text := public.hq_import_mapped_value(p_mapped, p_column);
begin
  if v_text = '' then
    return null;
  end if;
  begin
    return v_text::date;
  exception when others then
    return null;
  end;
end;
$$;

/**
 * The `hq_version` token from a round-trip file, as a timestamptz — or null.
 *
 * Compared as a TIMESTAMP and never as a string, which is the whole reason this
 * exists. The renderings are real and they differ: PostgREST answers
 * `2026-07-25T12:34:56.789012+00:00`, JavaScript's `toISOString()` — which is
 * what `hq_version` carries out of the app's own export — answers
 * `2026-07-25T12:34:56.789Z`, and `to_jsonb(timestamptz)` answers whatever the
 * session's TimeZone says. Same instant, three strings, so a string comparison
 * would report every row of every round-trip file as a conflict. Excel adds a
 * fourth if the column is ever read as a date.
 *
 * (An earlier version of this comment cited `to_char(..., 'OF')` rendering
 * `+00`. Nothing in this file calls `to_char`; the divergence is the one above.)
 *
 * Null on anything unparseable, and the caller treats null as a CONFLICT rather
 * than as a match — a token nobody can read is not proof that the user saw the
 * current value, and the safe direction is to ask.
 */
create or replace function public.hq_import_version(p_mapped jsonb)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_text text := public.hq_import_mapped_value(p_mapped, 'hq_version');
begin
  if v_text = '' then
    return null;
  end if;
  begin
    return v_text::timestamptz;
  exception when others then
    return null;
  end;
end;
$$;

-- ============================================================ the three tables

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  -- Spec A4 lists uploaded|mapped|previewed|committed|rolled_back. Two more are
  -- required by reality: a batch that is mid-commit is not "previewed", and a
  -- batch that died is not "committed". Silence about either is how a
  -- half-imported spreadsheet looks identical to a finished one.
  state text not null default 'uploaded'
        check (state in ('uploaded', 'mapped', 'previewed', 'committing',
                         'committed', 'rolled_back', 'failed')),
  filename text not null default '',
  source_kind text not null check (source_kind in ('xlsx', 'csv', 'paste')),
  -- sha-256 of the uploaded bytes. NOT the batch identity — see
  -- `app_import_create` — but the only way the preview can say "you imported
  -- this exact file on the 3rd", which is the question someone asks before
  -- clicking Commit a second time.
  content_hash text not null default '',
  row_count integer not null default 0,
  committed_count integer not null default 0,
  -- {"headers":[...], "columnMap":{...}, "statusMap":{...}, "roundTrip":bool}
  mapping jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  -- The optimistic-concurrency token. Two tabs mapping one batch conflict
  -- rather than clobber, exactly as everywhere else.
  updated_at timestamptz not null default now(),
  committed_at timestamptz,
  -- The undo window. Read from the ROW, never from the client's clock.
  undo_expires_at timestamptz,
  unique (user_id, idempotency_key)
);

-- The touch trigger every versioned table gets.
--
-- `updated_at` is a token a client holds and sends back. The functions below
-- set it themselves, so the column looks fine — right up until a backfill, a
-- psql fix or a future bot changes a row and leaves the token where it was, and
-- the next client holding the old value passes its conflict check and clobbers
-- a write it never saw. That is matrix row 96, which cost `user_companies` a
-- migration of its own; a new versioned table gets the trigger on day one.
drop trigger if exists import_batches_touch on public.import_batches;
create trigger import_batches_touch before update on public.import_batches
  for each row execute function public.touch_updated_at();

create index if not exists import_batches_by_user
  on public.import_batches (user_id, created_at desc);

create table if not exists public.import_rows (
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  -- Denormalised from the batch, like `application_notes.user_id`: it is what
  -- lets the RLS policy be a column comparison rather than a per-row EXISTS
  -- against another table's policy, and it is what makes the cross-user
  -- negative in tests/db/test_rls.py a direct assertion.
  user_id uuid not null references public.users (id) on delete cascade,
  row_number integer not null,               -- 1-based source row, for the report
  raw jsonb not null,                        -- the source cells, verbatim, forever
  mapped jsonb not null default '{}'::jsonb, -- after column + status mapping
  -- Set when the mapping has been applied to this row. A row whose `mapped` is
  -- legitimately `{}` (nothing mapped to it) is indistinguishable from one the
  -- mapping never reached, and "the mapping finished" has to be answerable.
  mapped_at timestamptz,
  -- Computed by webapp/lib/import/job-key.ts. Never computed here — see the
  -- header. `key_strength` is `isStrong()`'s answer, carried rather than
  -- re-derived so the two can be compared in a test.
  job_key text not null default '',
  key_strength text not null default 'none'
        check (key_strength in ('strong', 'weak', 'none')),
  match_kind text not null default 'new'
        check (match_kind in ('new', 'matches-existing', 'suggestion', 'unkeyable',
                              'round-trip', 'duplicate-in-file')),
  matched_application_id bigint references public.applications (id) on delete set null,
  conflict_state text not null default 'none'
        check (conflict_state in ('none', 'unresolved', 'resolved')),
  conflict jsonb not null default '{}'::jsonb,   -- per cell: {col: {mine, theirs}}
  choices  jsonb not null default '{}'::jsonb,   -- per cell: {col: 'mine'|'theirs'}
  -- The user's per-row veto, before commit. A preview you cannot act on is a
  -- progress bar with extra steps.
  included boolean not null default true,
  outcome text not null default 'pending'
        check (outcome in ('pending', 'created', 'updated', 'skipped', 'failed')),
  -- What undo needs, recorded at commit: the values as they were, and the
  -- `updated_at` this import wrote. A row whose token has moved since was
  -- edited by somebody afterwards and is KEPT rather than reverted (row 33).
  revert jsonb not null default '{}'::jsonb,
  -- Something true about this row that is not an error: "hq_id matched nothing
  -- of yours", "first occurrence won". Kept out of `error` so the report can
  -- show failures without drowning them in remarks.
  notice text not null default '',
  error text not null default '',
  primary key (batch_id, row_number)
);

create index if not exists import_rows_pending on public.import_rows (batch_id, outcome);
create index if not exists import_rows_by_user on public.import_rows (user_id);

create table if not exists public.import_column_reports (
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  column_name text not null,
  disposition text not null
        check (disposition in ('imported', 'read-only', 'locked', 'unmapped', 'unknown-column')),
  rows_affected integer not null default 0,
  sample jsonb not null default '[]'::jsonb,     -- <= 3 examples, for the report UI
  -- DISPOSITION is part of the key, and that is a correction rather than a
  -- refinement. Keyed on (batch, column) alone, one column could hold only one
  -- verdict — so the "Status" row written by the commit ("2 rows: you had
  -- chosen these by hand, left alone") was overwritten by the report pass's
  -- "Status — 38 imported", and the only line in the report that says something
  -- was NOT written vanished behind the line saying everything was. A column
  -- legitimately has several verdicts across a batch, and the report has to be
  -- able to say all of them.
  primary key (batch_id, column_name, disposition)
);

create index if not exists import_column_reports_by_user
  on public.import_column_reports (user_id);

comment on table public.import_batches is
  'one uploaded file; state machine uploaded -> mapped -> previewed -> committing -> committed, with rolled_back as the one-gesture escape';
comment on table public.import_rows is
  'every source row, verbatim in `raw` forever — the only way to answer "what did the file actually say" a month later, and it costs kilobytes';
comment on table public.import_column_reports is
  'per-column disposition: what was imported, what was compared-and-not-written because the engine owns it, and what went nowhere (G13)';
comment on column public.import_column_reports.disposition is
  'imported | read-only (engine-owned, differed, not written) | locked (a status a human had chosen, left alone) | unmapped (a header nobody mapped) | unknown-column (a header this app does not recognise)';

alter table public.applications
  add column if not exists import_batch_id uuid references public.import_batches (id) on delete set null;
create index if not exists applications_import_batch
  on public.applications (import_batch_id);

comment on column public.applications.import_batch_id is
  'the batch that CREATED this row, so undo can find exactly what it made; null for everything else. Set null rather than cascade on batch delete — losing an application because its import record was pruned is the opposite of the intent';

-- ============================================================ RLS

alter table public.import_batches        enable row level security;
alter table public.import_rows           enable row level security;
alter table public.import_column_reports enable row level security;

-- Read-only policies, scoped to the owner. No insert/update/delete policy,
-- here or ever: the browser writes through the functions below or not at all
-- (0001's closing note). The wizard READS these tables directly through
-- PostgREST — which is exactly why the select policies are load-bearing and
-- why tests/db/test_rls.py asserts both directions on all three.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'import_batches' and policyname = 'import_batches_self_read') then
    create policy import_batches_self_read on public.import_batches
      for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'import_rows' and policyname = 'import_rows_self_read') then
    create policy import_rows_self_read on public.import_rows
      for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'import_column_reports'
                  and policyname = 'import_column_reports_self_read') then
    create policy import_column_reports_self_read on public.import_column_reports
      for select using (user_id = auth.uid());
  end if;
end
$$;

revoke insert, update, delete, truncate
  on public.import_batches, public.import_rows, public.import_column_reports
  from anon, authenticated;

-- ============================================================ shared shapes

/** The batch as the wizard renders it. One builder, five callers. */
create or replace function public.app_import_batch_row(b public.import_batches)
returns jsonb
language sql
stable
-- Deliberately NOT security definer: only ever called from inside the definer
-- functions below, so it already runs with the rights it needs (0003's
-- app_triage_row, same call).
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id',              b.id,
           'state',           b.state,
           'filename',        b.filename,
           'source_kind',     b.source_kind,
           'content_hash',    b.content_hash,
           'row_count',       b.row_count,
           'committed_count', b.committed_count,
           'mapping',         b.mapping,
           'created_at',      b.created_at,
           'updated_at',      b.updated_at,
           'committed_at',    b.committed_at,
           'undo_expires_at', b.undo_expires_at,
           'staged_count',    (select count(*) from public.import_rows r where r.batch_id = b.id)
         )
$$;

revoke all on function public.app_import_batch_row(public.import_batches) from public;

/**
 * A batch this user owns, locked.
 *
 * Every mutating function starts here, and that single `for update` is what
 * serialises two commit chunks of the same batch. Without it, two tabs (or a
 * retry racing its own timed-out predecessor) each read `committed_count`,
 * each commit the same 200 pending rows, and the resume cursor goes backwards.
 */
create or replace function public.hq_import_lock_batch(p_batch uuid)
returns public.import_batches
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.import_batches;
begin
  select * into v_row from public.import_batches
   where id = p_batch and user_id = v_user
     for update;
  if not found then
    raise exception 'no such import for this user: %', p_batch using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

revoke all on function public.hq_import_lock_batch(uuid) from public;

-- ============================================================ create a batch

/**
 * Open a batch. The upload route calls this before it stages a single row.
 *
 * `p_idem` is the batch identity, NOT the content hash, and that distinction is
 * deliberate. Content-addressing the batch would make re-importing the same
 * file impossible — and re-importing the same file is a first-class flow here:
 * spec AC 20 says it must show 40 `matches-existing` rows and add zero. The
 * idempotency that AC 20 asks for lives at the ROW level (strong-key match plus
 * `on conflict do nothing`), which is where it belongs. What `p_idem` prevents
 * is the other thing: a double-submitted upload becoming two batches.
 *
 * The hash is still recorded, because "you imported this exact file already"
 * is worth saying out loud before somebody commits it twice.
 */
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

  select result into v_result from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_import_create(text, text, text, text, integer) from public;
grant execute on function public.app_import_create(text, text, text, text, integer) to authenticated;

-- ============================================================ stage raw rows

/**
 * Bulk-insert source rows, verbatim. Called in chunks by the upload route.
 *
 * Idempotent on `(batch, row_number)` rather than on an idempotency key,
 * because a retried chunk is the same rows and `on conflict do nothing` is a
 * more honest answer than a stored result: the caller wants to know how many
 * rows the batch now HAS, which is what it returns.
 *
 * Raw is kept forever (decision 6 in the plan). It is the only way to answer
 * "what did the file actually say" a month later, and it costs kilobytes.
 */
create or replace function public.app_import_stage(
  p_batch uuid,
  p_rows  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_batch   public.import_batches;
  v_staged  integer;
  v_total   integer;
  MAX_CHUNK constant integer := 1000;
  MAX_ROWS  constant integer := 5000;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > MAX_CHUNK then
    raise exception 'too many rows in one staging call (limit %)', MAX_CHUNK
      using errcode = '22023';
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);
  if v_batch.state <> 'uploaded' then
    raise exception 'this import is already past staging (state %)', v_batch.state
      using errcode = '22023';
  end if;

  select count(*) into v_total from public.import_rows where batch_id = p_batch;
  if v_total + jsonb_array_length(p_rows) > MAX_ROWS then
    raise exception 'that import would hold more than % rows', MAX_ROWS
      using errcode = '22023';
  end if;

  with incoming as (
    select (e ->> 'row_number')::integer as row_number,
           coalesce(e -> 'raw', '{}'::jsonb) as raw
      from jsonb_array_elements(p_rows) as e
  )
  insert into public.import_rows (batch_id, user_id, row_number, raw)
  select p_batch, v_user, i.row_number, i.raw
    from incoming i
   where i.row_number is not null and i.row_number > 0
  on conflict (batch_id, row_number) do nothing;
  get diagnostics v_staged = row_count;

  select count(*) into v_total from public.import_rows where batch_id = p_batch;
  -- The declared row count is what the resume view and the progress bar divide
  -- by; a short last chunk must not leave it lying.
  update public.import_batches set row_count = v_total where id = p_batch;

  return jsonb_build_object('staged', v_staged, 'total', v_total);
end;
$$;

revoke all on function public.app_import_stage(uuid, jsonb) from public;
grant execute on function public.app_import_stage(uuid, jsonb) to authenticated;

-- ============================================================ apply a mapping

/**
 * Write the mapped values (and the keys computed from them) onto staged rows.
 *
 * Chunked for the same reason the commit is: 5,000 rows of mapped jsonb in one
 * PostgREST body is a request nobody can retry. `p_final` is the last chunk and
 * is what stores the mapping itself, writes the per-column report for the
 * headers that went nowhere, and moves the batch to `mapped`.
 *
 * `p_expected_updated_at` guards the batch the way every other surface guards
 * its row: two tabs mapping one import conflict rather than silently taking
 * turns. It is checked only on the final call — the chunks in between are one
 * gesture, and re-checking each would turn a 10-chunk mapping into 10 chances
 * to lose a race with yourself.
 */
create or replace function public.app_import_set_mapping(
  p_batch               uuid,
  p_rows                jsonb,
  p_mapping             jsonb,
  p_final               boolean,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_batch     public.import_batches;
  v_unmapped  integer;
  v_touched   integer;
  MAX_CHUNK   constant integer := 1000;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > MAX_CHUNK then
    raise exception 'too many rows in one mapping call (limit %)', MAX_CHUNK
      using errcode = '22023';
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);
  -- Re-mapping after a preview is legal (the user pressed Back). Re-mapping a
  -- batch that has started committing is not: half its rows would then have
  -- been written under a mapping that no longer exists, and nothing on screen
  -- could ever explain the result.
  if v_batch.state not in ('uploaded', 'mapped', 'previewed') then
    raise exception 'this import can no longer be re-mapped (state %)', v_batch.state
      using errcode = '22023';
  end if;

  with incoming as (
    select (e ->> 'row_number')::integer as row_number,
           coalesce(e -> 'mapped', '{}'::jsonb) as mapped,
           coalesce(e ->> 'job_key', '') as job_key,
           coalesce(e ->> 'key_strength', 'none') as key_strength
      from jsonb_array_elements(p_rows) as e
  )
  update public.import_rows r
     set mapped       = i.mapped,
         mapped_at    = now(),
         job_key      = left(i.job_key, 400),
         key_strength = case when i.key_strength in ('strong', 'weak', 'none')
                             then i.key_strength else 'none' end,
         -- A new mapping invalidates every conclusion drawn from the old one.
         -- Leaving `match_kind` behind is how a preview describes a mapping the
         -- user has already replaced.
         match_kind             = 'new',
         matched_application_id = null,
         conflict_state         = 'none',
         conflict               = '{}'::jsonb,
         choices                = '{}'::jsonb,
         notice                 = ''
    from incoming i
   where r.batch_id = p_batch and r.row_number = i.row_number;
  get diagnostics v_touched = row_count;

  if p_final then
    if p_expected_updated_at is not null
       and v_batch.updated_at is distinct from p_expected_updated_at then
      raise exception 'conflict: this import changed since you read it'
        using errcode = '40001';
    end if;

    select count(*) into v_unmapped
      from public.import_rows where batch_id = p_batch and mapped_at is null;
    if v_unmapped > 0 then
      raise exception '% staged rows never got a mapping — the import would commit blanks', v_unmapped
        using errcode = '22023';
    end if;

    -- The headers that went nowhere, recorded BEFORE anything is written, so
    -- the report exists even if the commit never runs (G13). Refreshed whole on
    -- every mapping, because a re-map changes which headers are unmapped.
    delete from public.import_column_reports
     where batch_id = p_batch and disposition in ('unmapped', 'unknown-column');

    insert into public.import_column_reports
      (batch_id, user_id, column_name, disposition, rows_affected, sample)
    select p_batch, v_user, c.name, c.disposition, v_batch.row_count, '[]'::jsonb
      from jsonb_to_recordset(coalesce(p_mapping -> 'unmapped', '[]'::jsonb))
             as c(name text, disposition text)
     where c.name is not null
       and c.disposition in ('unmapped', 'unknown-column')
    on conflict (batch_id, column_name, disposition) do update
      set rows_affected = excluded.rows_affected;

    update public.import_batches
       set mapping = coalesce(p_mapping, '{}'::jsonb),
           state   = 'mapped'
     where id = p_batch
     returning * into v_batch;
  end if;

  return jsonb_build_object('mapped', v_touched,
                            'batch', public.app_import_batch_row(v_batch));
end;
$$;

revoke all on function public.app_import_set_mapping(uuid, jsonb, jsonb, boolean, timestamptz) from public;
grant execute on function public.app_import_set_mapping(uuid, jsonb, jsonb, boolean, timestamptz) to authenticated;

-- ============================================================ preview

/**
 * Decide, for every row, what committing it would DO. Writes nothing outside
 * the import tables — `applications` is read here and only read.
 *
 * THE MATCHING RULES, and the one that matters most:
 *
 *   `isStrong()` is the ONLY thing that authorises a merge. An ATS-derived key
 *   identifies one posting; a `norm-`/`url-` key is a normalised guess at a
 *   company and a title, and two people at one company with the same title is
 *   not a hypothetical. So a weak key produces a SUGGESTION — the row is
 *   inserted separately and flagged — and never an update to somebody's real
 *   application. That is `core/jobkeys.py:79-82`'s contract, enforced here.
 *
 * A strong key is looked up by `posting_key` first and by normalised name
 * second, and the second lookup is restricted to rows with NO posting_key.
 * The reason is concrete: most imported rows describe postings this system has
 * never swept, so the application they create carries no `posting_key` at all
 * (the FK would refuse) — and the second import of the same file has to find
 * the row the first one made. Restricting the fallback to posting_key-null rows
 * is what stops it reaching a row that came from a real triage decision.
 *
 * Name comparison goes through `company_name_key()` (0008), not `lower()`:
 * a name copied out of a web page carries a trailing NBSP, which is not
 * whitespace to `btrim`, and 'Aon ' vs 'Aon' being two companies is a bug this
 * repo has already paid for once.
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
  --
  --    Written as a CTE with a correlated scalar subquery rather than the
  --    obvious `from lateral (...)`: an UPDATE's FROM list cannot contain a
  --    LATERAL that references the UPDATE TARGET, which is exactly what the
  --    obvious form needs (`r.mapped` inside the lookup). Postgres refuses it
  --    with "invalid reference to FROM-clause entry".
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

  -- 8. Round-trip conflicts, per changed cell. `hq_version` is the `updated_at`
  --    the export read — the same token every other write on this system uses,
  --    so there is one concurrency concept here, not two.
  --
  --    A row whose token still matches is applied silently. A row whose token
  --    has moved is UNRESOLVED, and `app_import_commit_chunk` refuses to run
  --    while any unresolved row remains. AC 23 is therefore enforced by the
  --    database; a UI-only guard is one bad deploy from writing anyway.
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
             -- it is not a conflict to resolve.
             where d.theirs <> '' and d.theirs is distinct from d.mine) as diff
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

revoke all on function public.app_import_preview(uuid) from public;
grant execute on function public.app_import_preview(uuid) to authenticated;

-- ============================================================ resolve / exclude

/** Record the per-cell answers to one conflicted round-trip row. */
create or replace function public.app_import_resolve(
  p_batch   uuid,
  p_row     integer,
  p_choices jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_batch public.import_batches;
  v_row   public.import_rows;
  v_key   text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_choices is null or jsonb_typeof(p_choices) <> 'object' then
    raise exception 'choices must be an object' using errcode = '22023';
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);
  if v_batch.state not in ('previewed', 'mapped') then
    raise exception 'this import is not open for conflict resolution (state %)', v_batch.state
      using errcode = '22023';
  end if;

  -- A closed set, checked here rather than in the wizard: this function is
  -- granted to `authenticated`, so the TypeScript validator is advisory.
  for v_key in select jsonb_object_keys(p_choices) loop
    if not (v_key = any (public.hq_import_writable_columns())) then
      raise exception 'column % is not one an import may write', v_key using errcode = '22023';
    end if;
    if p_choices ->> v_key not in ('mine', 'theirs') then
      raise exception 'choice for % must be mine or theirs', v_key using errcode = '22023';
    end if;
  end loop;

  update public.import_rows
     set choices = p_choices,
         conflict_state = 'resolved'
   where batch_id = p_batch and row_number = p_row and conflict_state = 'unresolved'
   returning * into v_row;
  if not found then
    raise exception 'row % of this import has no unresolved conflict', p_row
      using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'row', p_row,
    'unresolved', (select count(*) from public.import_rows
                    where batch_id = p_batch and conflict_state = 'unresolved'));
end;
$$;

revoke all on function public.app_import_resolve(uuid, integer, jsonb) from public;
grant execute on function public.app_import_resolve(uuid, integer, jsonb) to authenticated;

/** Include or exclude rows before commit — the preview's veto. */
create or replace function public.app_import_set_included(
  p_batch    uuid,
  p_rows     integer[],
  p_included boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid := auth.uid();
  v_batch public.import_batches;
  v_n     integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_rows is null or array_length(p_rows, 1) is null then
    raise exception 'no rows selected' using errcode = '22023';
  end if;
  -- The bound every fan-out gets (0006's rule).
  if array_length(p_rows, 1) > 5000 then
    raise exception 'too many rows in one call' using errcode = '22023';
  end if;

  v_batch := public.hq_import_lock_batch(p_batch);
  if v_batch.state not in ('mapped', 'previewed') then
    raise exception 'rows can no longer be excluded (state %)', v_batch.state
      using errcode = '22023';
  end if;

  update public.import_rows
     set included = coalesce(p_included, true)
   where batch_id = p_batch and row_number = any (p_rows) and outcome = 'pending';
  get diagnostics v_n = row_count;

  return jsonb_build_object('rows', v_n, 'included', coalesce(p_included, true));
end;
$$;

revoke all on function public.app_import_set_included(uuid, integer[], boolean) from public;
grant execute on function public.app_import_set_included(uuid, integer[], boolean) to authenticated;

-- ============================================================ commit a chunk

/**
 * Commit up to `p_limit` pending rows, in one transaction.
 *
 * WHAT IT WILL NOT DO, in order of how much it would cost to get wrong:
 *
 *   * Run at all while any row is `conflict_state = 'unresolved'` (AC 23).
 *   * Change a `status` on a row whose `status_actor` is 'user', unless this is
 *     a round trip carrying that row's own version token. See the header.
 *   * Overwrite a value with a BLANK. An empty cell in a spreadsheet means "I
 *     did not fill this in", not "delete what you have" — and an import that
 *     erases a next action nobody typed over is unrecoverable.
 *   * Overwrite a note. `application_notes` is append-only (0010, matrix row
 *     108) and plans/README C5 settles it: the import APPENDS, author `import`.
 *   * Write any column outside `hq_import_writable_columns()`. Everything else
 *     in the file is engine-owned: compared, counted, reported (G13).
 *
 * `on conflict do nothing` on the insert is load-bearing, not defensive.
 * `0002_invariants.sql:54-56` puts a unique index on
 * `(user_id, lower(company), lower(title)) where posting_key is null`, and most
 * imported rows have no posting_key — so one repeated company+title would abort
 * a 200-row chunk and wedge the batch. It is also half the mechanism behind
 * AC 20 (a re-run adds zero).
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
    -- A round trip is only a human gesture while it carries the PROOF that
    -- makes it one: this row's own version token, either matching (no conflict
    -- was raised) or explicitly answered in the resolver. A file whose
    -- `hq_version` column was deleted still matches by `hq_id`, but it is no
    -- longer evidence that anybody read the current value — so it writes like a
    -- plain import and claims nothing.
    v_roundtrip := v_row.match_kind = 'round-trip'
                   and (public.hq_import_mapped_value(v_row.mapped, 'hq_version') <> ''
                        or v_row.conflict_state = 'resolved');

    -- Per-cell choices from the resolver. 'mine' means the file's value is
    -- discarded for that column, which is expressed by blanking it here — the
    -- writes below already treat blank as "leave what is there".
    if v_row.conflict_state = 'resolved' then
      if v_row.choices ->> 'status' = 'mine' then v_status := ''; end if;
      if v_row.choices ->> 'notes' = 'mine' then v_note := ''; end if;
      if v_row.choices ->> 'next_action' = 'mine' then v_next := ''; end if;
      if v_row.choices ->> 'next_action_date' = 'mine' then v_next_date := null; end if;
      if v_row.choices ->> 'applied_date' = 'mine' then v_applied := null; end if;
    end if;

    if v_row.match_kind = 'duplicate-in-file' then
      update public.import_rows set outcome = 'skipped',
             error = 'skipped: an earlier row in this file is the same job'
       where batch_id = p_batch and row_number = v_row.row_number;
      v_skipped := v_skipped + 1;
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

      /*
       * RE-CHECK THE VERSION TOKEN, HERE, INSIDE THE TRANSACTION THAT WRITES.
       *
       * `app_import_preview` compares `hq_version` against `updated_at` and
       * raises the conflict — and that comparison is worth nothing by itself,
       * because preview and commit are two separate gestures with a human-shaped
       * gap between them. The sequence that corrupted data:
       *
       *   1. preview: the file's token matches, no conflict, Commit lights up
       *   2. the person (or the engine, or another tab) sets the row to Offer
       *      and claims it — `status_actor` becomes 'user'
       *   3. commit: the token is never looked at again, so the file's stale
       *      "Interview" overwrites the Offer AND, because this is a round trip,
       *      stamps `status_actor='user'` on top — locking the clobbered value
       *      against the engine that could have corrected it
       *
       * AC 23 says a stale round-trip version must not overwrite a newer edit.
       * Enforcing that at preview time enforces it at the wrong time. This is
       * `app_set_status`'s shape (0010:485-489): the row is locked, and the token
       * is compared against the value on the LOCKED row.
       *
       * The answer is `failed` rather than a raise: one stale row must not take
       * 199 innocent ones down with it, and rather than a wedged batch the person
       * gets a report line naming the row and what happened to it. Their edits
       * are not lost — `import_rows.raw` keeps the file verbatim forever — and
       * re-importing it re-previews against the row as it is now.
       */
      -- A RESOLVED row is exempt: its token is stale by definition — the raised
      -- conflict is WHY the resolver ran — and the resolution is a human gesture
      -- made against the current value, newer than any token in the file. The
      -- re-check below is for rows whose only proof is the token itself.
      -- (Resolve-then-edit inside one wizard session is the residual race; the
      -- 24h undo covers it, and the report names every written row.)
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

      -- The status question, and the whole reason this branch is not two lines.
      --
      -- A locked row (`status_actor='user'`) may only have its status changed by
      -- a declared human write. A ROUND TRIP is one — the file carried this
      -- row's own version token, so the person read the current value before
      -- choosing another. A bulk import is not, and on a locked row it leaves
      -- the status entirely alone and says so in the report.
      --
      -- Skipping rather than letting the trigger raise is not politeness: the
      -- trigger raises 42501, which would abort the whole chunk and wedge the
      -- batch on one row somebody had claimed by hand.
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
             next_action      = case when v_next <> '' then v_next else next_action end,
             next_action_date = coalesce(v_next_date, next_action_date),
             applied_date     = coalesce(v_applied, applied_date),
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

      -- WHICH COLUMNS ACTUALLY LANDED, recorded per row.
      --
      -- The report pass cannot re-derive this and was not trying to: it counted
      -- every row whose file value was non-empty, so a Status that was skipped
      -- for the human lock was reported as `locked` AND as `imported` — the same
      -- row on both lines, and the account of a batch adding up to more than the
      -- batch. Same for a cell the resolver answered "keep mine", where the
      -- file's value is non-empty and was deliberately discarded.
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
      -- NOT 'user'. An import is not a human status gesture; see the header.
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

revoke all on function public.app_import_commit_chunk(uuid, integer, text) from public;
grant execute on function public.app_import_commit_chunk(uuid, integer, text) to authenticated;

-- ============================================================ per-column report

/**
 * The engine-owned columns the file disagreed with, counted and sampled.
 *
 * G13: "engine-owned columns re-import as a report, never a silent drop."
 * Called once after the last chunk. Separate from the commit because it is a
 * whole-batch question — a per-chunk count would report the same column five
 * times — and because a report that fails must not roll back a commit that
 * worked.
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
   where batch_id = p_batch and disposition in ('imported', 'read-only');

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
  -- a list of disappointments.
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
           -- WHAT LANDED, not what the file offered. `revert.wrote` is recorded
           -- by the commit itself, which is the only place that knows: a Status
           -- skipped for the human lock and a cell the resolver answered "keep
           -- mine" both have a non-empty file value and both wrote nothing, so
           -- counting the file's value put the same row on the `imported` line
           -- AND the `locked` one and made the report add up to more than the
           -- batch.
           and r.revert -> 'wrote' @> to_jsonb(col)
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

revoke all on function public.app_import_report(uuid) from public;
grant execute on function public.app_import_report(uuid) to authenticated;

-- ============================================================ undo

/**
 * Put everything back, in one gesture, in one transaction.
 *
 * This is what makes "chunk-atomic" honest: a batch that died halfway is not a
 * mess to reconcile by hand, it is one button. Because the whole revert is one
 * function body, it is atomic by construction — a failure anywhere leaves the
 * database exactly as it was, which `tests/db/test_import.py` proves by making
 * the second delete raise and then asserting the first row is still there.
 *
 * WHAT IT REFUSES TO TOUCH, and why each matters more than tidiness:
 *
 *   * A row somebody EDITED after the import. `revert.wrote_updated_at` is the
 *     token this import left behind; if the row's `updated_at` has moved since,
 *     a person or a bot has acted on it, and reverting would throw away work
 *     nobody asked to lose. Those rows are KEPT and listed in the report.
 *   * Notes. `application_notes` is append-only by GRANT (0010), and undoing an
 *     import is not a licence to delete history. An imported note on a row that
 *     survives stays, and the report says how many. (A note on a row the import
 *     CREATED goes with it, by FK cascade — the row it belonged to is gone.)
 *   * A batch past its 24-hour window, read from `undo_expires_at` on the row.
 */
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

  select result into v_result from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_import_undo(uuid, text) from public;
grant execute on function public.app_import_undo(uuid, text) to authenticated;

-- ============================================================ discard

/**
 * Throw away an import that never committed anything.
 *
 * It exists because of a sentence. `app_import_create` refuses a 21st unfinished
 * batch with "finish or discard one first" — and there was no discard, so after
 * twenty abandoned uploads a person could never import again, told to do
 * something the system did not offer. A message that names a gesture nobody
 * implemented is the same defect as a button that does nothing.
 *
 * It refuses anything that has WRITTEN: `committing`, `committed` and
 * `rolled_back` are history, and the way to reverse a commit is
 * `app_import_undo`, which leaves a trail. Delete would leave none — and it
 * would take `import_rows` with it, which is the only record of what the file
 * actually said.
 */
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

  select result into v_result from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_import_discard(uuid, text) from public;
grant execute on function public.app_import_discard(uuid, text) to authenticated;
