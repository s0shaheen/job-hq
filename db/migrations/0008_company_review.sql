-- The company-universe review path — P7's write half.
--
-- 0007 added the discovery metadata (`source`, `reliability_tier`,
-- `resolution_method`) to the SHARED `public.companies` table: how a company was
-- found and how reliably its jobs can be pulled. Those are properties of the
-- company, resolved once, read by everyone.
--
-- What was missing is the human half of fork #2 in docs/plans/COMPANY-DISCOVERY.md
-- ("review & bulk-approve, Clay/Origami style"): a discovery agent PROPOSES a
-- company into somebody's universe, and a person decides. That decision is
-- per-user by construction — dad approving Northern Trust says nothing about
-- whether the roommate wants it — so it lives on `user_companies`, beside the
-- `monitor`/`priority` toggles that are already per-user.
--
--   review_state = 'proposed'  → awaiting a human; the sweep must NOT pull it
--   review_state = 'approved'  → in this user's universe; `monitor` decides pulling
--   review_state = 'dismissed' → the human said no; kept, so the agent does not re-propose
--
-- `default 'approved'` is deliberate and is the only safe default: every existing
-- row was seeded from the sheet's Companies tab by a human, and defaulting them to
-- 'proposed' would silently empty every live universe on the day this applies. New
-- rows written by the discovery agent pass 'proposed' explicitly.
--
-- `updated_at` arrives here too, because it does not exist yet on this table and
-- every write path in this system is optimistic-concurrency checked: without a
-- version token, two devices reviewing the same proposal silently clobber each
-- other (matrix row 9). It defaults to now(), so existing rows get a token
-- immediately rather than a null that skips every check forever.
--
-- The three functions below follow 0003/0006 exactly, and for the same reasons:
-- security definer + `auth.uid()` (the caller cannot name a user), row + audit
-- event in one body, stored idempotency result, a post-lock re-check of the
-- idempotency key (0003:166-182 — the pre-lock check only settles SEQUENTIAL
-- replays), and a bound on anything that fans out. Behaviour is pinned in
-- tests/db/test_company_review.py against real Postgres — reading this SQL cannot
-- prove atomicity, running it can.

-- ============================================================ schema

alter table public.user_companies
  add column if not exists review_state text        not null default 'approved',
  add column if not exists updated_at   timestamptz not null default now();

alter table public.user_companies
  drop constraint if exists user_companies_review_state_check;
alter table public.user_companies
  add constraint user_companies_review_state_check
  check (review_state in ('proposed', 'approved', 'dismissed'));

-- The review gate, as a CONSTRAINT rather than only as a rule inside a function.
--
-- `app_set_company_flags` refuses to flip `monitor` on an unapproved row, and that
-- is the enforcement the UI meets. It is not the enforcement a bare INSERT meets:
-- `monitor` defaults to true (0001), so any writer that inserts a proposal without
-- naming `monitor` lands a row that is swept but unreviewed — fail-OPEN, on the one
-- flag whose whole purpose is that a human said yes first. A future seeder, a
-- migration backfill or a hand-written row cannot get this wrong now.
alter table public.user_companies
  drop constraint if exists user_companies_monitor_needs_approval;
alter table public.user_companies
  add constraint user_companies_monitor_needs_approval
  check (monitor = false or review_state = 'approved');

comment on column public.user_companies.review_state is
  'proposed = awaiting review (never swept) | approved = in this user''s universe | dismissed = declined';
comment on column public.user_companies.updated_at is
  'optimistic-concurrency token for the review/flag write path (0008)';

-- The review grid's default working set is "everything this user has proposed",
-- so that filter is the one query shape guaranteed to run on every page load.
create index if not exists user_companies_review_idx
  on public.user_companies (user_id, review_state);

-- Every other versioned table in this schema has this trigger (0001 ends with five
-- of them, 0005 adds a sixth). Without it `updated_at` only moves when a writer
-- remembers to set it — the three functions below do, and anything else that ever
-- updates this table (a backfill, a psql fix, a future bot) would freeze the token
-- while changing the row, which is precisely how a stale client clobbers a write it
-- never saw.
drop trigger if exists user_companies_touch on public.user_companies;
create trigger user_companies_touch before update on public.user_companies
  for each row execute function public.touch_updated_at();

-- ============================================================ name identity

/**
 * The identity of a company NAME, for matching a pasted string against a company
 * row that already exists.
 *
 * This exists because the shared table's unique key is (name, ats, slug) and a
 * paste knows only the name. Matching on the raw string produced three failures,
 * all reproduced against real Postgres:
 *
 *   * a paste of a name the resolver had ALREADY GROUNDED ('Ramp' at
 *     ashby/ramp) did not collide with it — the conflict key was ('Ramp','',''),
 *     which no grounded row can ever hold — so it created a second, permanent
 *     tier-3 row and bound the human's subscription to that ghost instead of to
 *     the real board. The worst kind of bug this feature can have: the row looks
 *     right and is never pulled from.
 *   * 'Aon' pasted in one session and 'aon' in another became two companies.
 *   * a name copied out of a web page arrives with a trailing NBSP, which is not
 *     whitespace to `btrim()`, so it became a third.
 *
 * IMMUTABLE so a functional index can use it. It folds case, converts every
 * unicode space separator to a plain space, drops zero-width characters (invisible
 * copy-paste artefacts), collapses runs and trims.
 *
 * It is deliberately NOT a slugifier. Punctuation stays: "Guggenheim Partners,
 * LLC" and "Guggenheim Partners LLC" are different registered names, and folding
 * them together would merge two real companies — a wrong MERGE is unrecoverable
 * from inside the app, where a duplicate is merely untidy.
 */
create or replace function public.company_name_key(p_name text)
returns text
language sql
immutable
-- Pinned for the index's sake, not the caller's: an index expression that could
-- resolve to a shadowed function is an index that can silently disagree with the
-- lookups written against it.
set search_path = pg_catalog, pg_temp
as $$
  select lower(btrim(regexp_replace(
           regexp_replace(coalesce(p_name, ''), '[\u200B\u200C\u200D\uFEFF]', '', 'g'),
           '[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+', ' ', 'g')))
$$;

comment on function public.company_name_key(text) is
  'normalized company-name identity (case/whitespace folded) — the paste path matches on this, never on the raw string';

-- At most ONE unresolved row per normalized name.
--
-- PARTIAL on purpose. A grounded company keeps the (name, ats, slug) key it always
-- had, because one company legitimately has more than one board (a Greenhouse
-- careers site and a Workday tenant are two rows and both are true). What must
-- never exist twice is the ungrounded placeholder a paste creates: that is not a
-- second fact about the company, it is a duplicate of the same nothing, and two of
-- them split one human's universe across two ids.
--
-- The lookup in app_propose_companies is what normally prevents this; the index is
-- what prevents two CONCURRENT pastes from both losing that lookup's race.
create unique index if not exists companies_unresolved_name_key
  on public.companies (public.company_name_key(name))
  where ats = '' and slug = '';

-- ============================================================ result shape

/**
 * The row the /companies grid renders, shaped for `toCompanyView` in
 * webapp/lib/data/supabase-source.ts: the user_companies columns plus the
 * nested `companies` object it unwraps.
 *
 * Extracted for 0003's reason: three paths return it (a review write, a flag
 * write, and a propose), and a replay returning a differently-shaped row than
 * the original write is the kind of divergence nothing catches until the UI
 * renders blanks.
 *
 * `updated_at` is a LOAD-BEARING member of that shape, not a debugging extra: it
 * is the optimistic-concurrency token the client sends back with its next
 * gesture. Dropping it turns every write on this surface into last-writer-wins
 * silently — the whole suite stayed green when that was tried, which is why
 * test_company_review.py now pins the key by name.
 */
create or replace function public.app_company_row(uc public.user_companies)
returns jsonb
language sql
stable
-- Deliberately NOT security definer: only ever called from inside the definer
-- functions below, so it already runs with the rights it needs. Marking it
-- definer would hand a standalone caller the ability to read any company row —
-- privilege this helper has no use for (0003's app_triage_row, same call).
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
             'id',                c.id,
             'name',              c.name,
             'ats',               c.ats,
             'slug',              c.slug,
             'source',            c.source,
             'reliability_tier',  c.reliability_tier,
             'resolution_method', c.resolution_method
           )
         )
    from public.companies c
   where c.id = uc.company_id
$$;

revoke all on function public.app_company_row(public.user_companies) from public;

-- ============================================================ review, in bulk

/**
 * One review decision applied to many companies, atomically — the grid's two
 * verbs ("Add to universe" / "Dismiss") over a selection.
 *
 * Atomic for 0006's reason: N calls can fail halfway and leave half a selection
 * reviewed, and a half-approved universe is a silent partial state the user has
 * no way to see. A conflict on any single row rolls the whole batch back.
 *
 * Approving turns `monitor` ON. That is the point of approving — a company in
 * the universe that the sweep does not pull is an approval that did nothing —
 * and it is the same "one gesture, one intent" rule triage follows. Dismissing
 * turns it OFF, so a dismissed proposal cannot keep costing a fetch per sweep.
 */
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
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_set_company_review_bulk(bigint[], text, text, text[]) from public;
grant execute on function public.app_set_company_review_bulk(bigint[], text, text, text[]) to authenticated;

-- ============================================================ per-row flags

/**
 * The `monitor` / `priority` toggles an APPROVED row shows — "is the sweep
 * pulling this company for me, and is it on the hourly watch list".
 *
 * Single-row rather than bulk because it is a switch on one line, not a decision
 * over a selection; the two verbs above are the batch path. Same contract
 * otherwise: idempotent replay, a version token, an audit event.
 *
 * It deliberately refuses to flip flags on a row that is not approved. Turning
 * `monitor` on for a 'proposed' company would put it into the sweep behind the
 * user's back, which is the whole thing the review gate exists to prevent.
 */
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

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_set_company_flags(bigint, boolean, boolean, text, timestamptz) from public;
grant execute on function public.app_set_company_flags(bigint, boolean, boolean, text, timestamptz) to authenticated;

-- ============================================================ propose (paste a list)

/**
 * The honest floor of the "add companies" bar: a pasted list of names becomes
 * PROPOSED rows in the caller's universe, at Tier 3 / `manual`.
 *
 * Tier 3, not tier 1, and this is the load-bearing claim of the whole function.
 * Nothing here resolves a board or fetches a job. `reliability_tier = 3` is the
 * design's "manual link / best-effort — tracked, not auto-pulled" (the floor, not
 * the plan), and `resolution_method = 'manual'` says exactly which waterfall step
 * produced it: none. The resolution waterfall lives in `monitor/discover.py`, runs
 * in Python, and is NOT reachable from the web app — so a row inserted here that
 * claimed tier 1 would be a fabricated reliability promise, which is the corruption
 * this repo's rules exist to rule out.
 *
 * A NAME ALREADY IN THE TABLE IS NEVER RE-CREATED. The lookup is on
 * `company_name_key(name)` across every row, not on the ('name','','') conflict
 * key, and it prefers the GROUNDED row when several match. That is the fix for the
 * worst behaviour this function had: because the resolver only ever writes rows
 * with a non-empty ats+slug, ('Ramp','','') could not collide with ashby/ramp, so
 * pasting an already-resolved name minted a permanent tier-3 duplicate and bound
 * the human to it. Binding to the grounded row instead means a paste of a known
 * company is a subscription, not a downgrade.
 *
 * WHAT IT STILL DOES NOT DO, stated because the earlier version of this comment
 * claimed otherwise: nothing upgrades a tier-3 row in place. The resolver upserts
 * on (name, ats, slug), so when it later grounds a name that was pasted first it
 * writes a SECOND, grounded row and this user's subscription stays pointed at the
 * unresolved one. Reconciling those two is a job for the Python side (it owns the
 * resolution) and it is not built. Until it is, the honest description of a pasted
 * row is "tracked, and it will stay tracked" — which is what the UI now says.
 *
 * `monitor` is false: a proposal is not in the sweep until a human approves it, and
 * app_set_company_review_bulk('approved') is what turns it on.
 *
 * The shared `companies` insert is the design's monotonically-growing shared asset
 * (docs/plans/COMPANY-DISCOVERY.md) — a name added for one user is available to
 * everyone. The per-user decision is the `user_companies` row, which is what RLS
 * scopes; a company nobody watches is invisible to every browser session
 * (0002's `companies_visible_to_watchers`).
 */
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

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_propose_companies(text[], text, text) from public;
grant execute on function public.app_propose_companies(text[], text, text) to authenticated;
