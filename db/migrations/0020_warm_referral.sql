-- 0020 — the referral finder, layer 1: on-demand warm-intro search through a
-- vendor that never touches the user's LinkedIn session.
--
-- `docs/plans/REFERRAL-FINDER.md` names three layers by risk. 0013 built layer 0
-- (deep links the person clicks in their own session, plus their Connections.csv).
-- This is **layer 1**: for a starred/priority row, a people-data VENDOR is asked
-- "who is in this role / senior in this area / a recruiter, at this company", and
-- the ranked answer is written into a per-user, per-request row. The user's `li_at`
-- is never involved; the vendor supplies its own accounts and proxies and carries
-- 100% of the scraping risk. The plan's layer-∞ line (their cookie, a page-reading
-- extension, messaging-as-them) stays permanently unbuilt, by construction: there
-- is no column here that could hold a session and no code path from this schema to
-- linkedin.com at all — the fetch lives in `webapp/lib/warm/`, server-side, behind
-- the `WarmVendor` interface, and is kept out of `lib/referral/` by the hard-line
-- test that sweeps that directory for a `fetch`.
--
-- This corrects `REFERRAL-FINDER.md` line 45 ("The Apify people-search actors all
-- require the cookie; that entire category is out"). The `harvestapi/linkedin-
-- profile-search` actor is a no-cookie Apify actor — verified in the vendor brief —
-- so Apify is NOT categorically out, and harvestapi is the first layer-1 vendor.
-- It is a scraper, not a licensed DB, so it inherits Proxycurl's vendor-CONTINUITY
-- risk (its marketing domain already redirects to a for-sale page) — which is why
-- nothing in this schema, and nothing downstream of `WarmVendor`, knows the name
-- harvestapi. Swapping it is one adapter.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE ASYNC LIFECYCLE, which is what makes CANCEL real
--
-- A vendor run is start → poll → fetch, and a Vercel function must return in
-- seconds. So the request is a ROW, not a held connection:
--
--   POST /api/warm/start    inserts a `warm_searches` row (status 'running'),
--                           enforcing the per-user daily cap in the same statement,
--                           then attaches the vendor run ids and returns the id.
--   GET  /api/warm/[id]     reads the row; if it is still 'running' the route polls
--                           the vendor and, when the run finishes, calls
--                           `app_complete_warm_search` with the ranked results.
--   POST /api/warm/[id]/cancel  aborts the vendor run AND flips the row to
--                           'cancelled' — idempotent, and a cancel of an already-
--                           finished run is a no-op, not an error.
--
-- The row is the reservation: the cap is charged at INSERT, before a cent is spent,
-- so a burst of clicks cannot start 50 runs and then be rejected one at a time.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS A `security definer` / `auth.uid()` FAMILY (0013), NOT 0018's
--
-- Every caller here holds a browser session — the routes run the anon key + RLS
-- like every other surface a person drives. So this file joins 0012/0013's family:
-- `security definer`, the acting user read from `auth.uid()` and NEVER taken as an
-- argument (`test_definer_functions_never_take_a_user_id` pins that), idempotent on
-- `command_idempotency`, the row and its `events` audit in one body. 0018/0019's
-- service-role, user-as-argument shape is for the SESSIONLESS callers (an Apps
-- Script, an emailed link); nothing here is sessionless.

-- ════════════════════════════════════════════════════════════════════════════
-- the requests
-- ════════════════════════════════════════════════════════════════════════════

/**
 * One on-demand warm-intro search. Ephemeral by design — a snapshot of one
 * vendor run, read back by the poller and then left alone.
 *
 * `id` is a uuid, not a serial, because it is handed to the browser in a URL
 * (`/api/warm/<id>`). RLS already scopes every row to its owner, so a serial
 * would be safe against cross-user reads too — the uuid buys that the id leaks no
 * count and no ordering, which a serial in a URL always does.
 *
 * `results` is JSONB, not a child table, and the choice is deliberate: the
 * candidates are an ATOMIC snapshot of one run, read only as a whole with their
 * parent search and never queried, joined, or updated per-candidate. Per-contact
 * outreach tracking (identified → contacted → replied) is the plan's layer 3 and
 * lives on the `warm_pins` entity below when a person is pinned, not here. A child
 * table would buy a per-row index and a second RLS policy for a reader that does
 * not exist; jsonb keeps the snapshot atomic with the run that produced it.
 *
 * `vendor_runs` is the persisted persona↔run mapping — `[{"run_id","persona"}]`,
 * one entry per persona query. It exists BECAUSE start and poll are separate HTTP
 * requests and `getWarmVendor()` builds a fresh vendor per request: an in-memory
 * persona map would be empty by poll time, so poll would stamp every candidate
 * "role" (recruiter guarantee dead, ranking flat). Persisting persona here lets the
 * poll route re-attribute each candidate to its persona STATELESSLY, from the row.
 *
 * `overlays` = `{"schools":[…],"pastCompanies":[…]}` — the user's own warm signals,
 * persisted for the same reason: the poll route rebuilds each persona's vendor query
 * from `vendor_runs.persona` + `overlays` + `company`, so a returned row that matched
 * an INCLUDE filter (school / past employer) is stamped by construction (Short mode
 * carries no education), firing the `school:3` / `past_company:2` rank weights.
 */
create table public.warm_searches (
  id      uuid not null default gen_random_uuid() primary key,
  user_id uuid not null references public.users (id) on delete cascade,

  -- What was searched. A posting row, or a bare company (the quick-add / wide-net
  -- case where no posting is being tracked). `company` is verbatim; `company_key`
  -- is the normalized identity everything else in this repo matches on (0008).
  target_kind text not null default 'posting'
    check (target_kind in ('posting', 'company')),
  posting_key text not null default '',
  company     text not null default '',
  company_key text not null generated always as (public.company_name_key(company)) stored,

  -- The three plain-language persona strings actually used, e.g.
  -- {"role":"Product Manager","senior":"Director of Product or above",
  --  "recruiter":"Product recruiter"}. Deliberately readable strings the vendor
  -- adapter maps to its facets — not structured facets — so a human can correct
  -- them in the "Edit for this search" popover and read what they changed.
  params jsonb not null default '{}',

  -- The user's warm background this search filtered on: {schools, pastCompanies}.
  -- Persisted so the poll route can rebuild the vendor query and stamp the matched
  -- signal (see the table comment).
  overlays jsonb not null default '{}',

  status text not null default 'running'
    check (status in ('running', 'done', 'cancelled', 'failed')),

  -- The persisted persona↔run mapping: [{"run_id","persona"}]. NOT bare run ids —
  -- the persona is the whole point (see the table comment).
  vendor_runs jsonb not null default '[]',
  results     jsonb not null default '[]',
  error       text  not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The cap query ("how many did this user start in the last 24h") and the listing
-- both read this shape.
create index warm_searches_user_time_idx
  on public.warm_searches (user_id, created_at desc);

-- UNCONDITIONAL, not the `when (old.* is distinct from new.*)` guard the companies
-- table (0013) uses. Postgres refuses a BEFORE-trigger WHEN that references a
-- whole-row `new.*` on a table with a GENERATED column ("cannot reference NEW
-- generated columns"), and `company_key` is generated — the same reason 0013's
-- `connections` (also generated) uses an unconditional touch. The guard exists to
-- stop a bulk MIRROR moving the stamp on a no-op upsert (matrix row 96); nothing
-- bulk-mirrors this table, and every writer is an RPC that already changed the row,
-- so unconditional is correct here anyway.
drop trigger if exists warm_searches_touch on public.warm_searches;
create trigger warm_searches_touch before update on public.warm_searches
  for each row execute function public.touch_updated_at();

comment on table public.warm_searches is
  'one on-demand warm-intro vendor run per row, per user (0020, REFERRAL-FINDER layer 1); results are an atomic jsonb snapshot, vendor_runs persists the persona per run';
comment on column public.warm_searches.vendor_runs is
  'persona-per-run mapping [{run_id, persona}] — lets the stateless poll route re-attribute each candidate to its persona and fire the recruiter guarantee + persona weights';

-- ════════════════════════════════════════════════════════════════════════════
-- the pins
-- ════════════════════════════════════════════════════════════════════════════

/**
 * People pinned as warm intros for one row — a SET per posting, not one.
 *
 * The owner selects MULTIPLE contacts from a search's results as intros for one
 * posting (multi-select, "Pin selected (N)"), so the uniqueness is per PERSON
 * within a target, not per target: `pin_identity` (the profile URL, or the name
 * when there is none) closes it, so re-pinning the same person UPDATES their row
 * rather than duplicating, while two different people coexist on one posting. The
 * grid cell shows the count + names.
 *
 * Distinct from `connections` ON PURPOSE: a `connections` row is a 1st-degree name
 * from the user's own CSV (layer 0), and the warm cell counts those as "N
 * 1st-degree". A pin is a layer-1 vendor result or a hand-typed target the user
 * chose to keep against THIS posting; folding it into `connections` would inflate
 * the 1st-degree count with people the user has never actually connected to.
 *
 * `full_name` is the only required field. A pin can be a bare NAME with no URL (the
 * add box accepts "a LinkedIn URL or a name"). `profile_url`, when present, is
 * refused unless it is a linkedin.com address — the same closed guard
 * `lib/referral/linkedin.ts` applies at the render side, checked here too because
 * this column ends up in an `href`.
 */
create table public.warm_pins (
  id      bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,

  target_kind text not null default 'posting'
    check (target_kind in ('posting', 'company')),
  posting_key text not null default '',
  company     text not null default '',
  company_key text not null generated always as (public.company_name_key(company)) stored,

  full_name   text not null check (public.hq_blank_trim(full_name) <> ''),
  profile_url text not null default '',
  headline    text not null default '',

  -- The person's identity WITHIN a target: their profile URL when there is one, else
  -- their normalized name. Generated so it cannot drift from what the pin door
  -- computes, and the thing the per-person unique index below is built on.
  pin_identity text not null generated always as (
    case when public.hq_blank_trim(profile_url) <> ''
         then lower(public.hq_blank_trim(profile_url))
         else lower(public.hq_blank_trim(full_name)) end
  ) stored,

  -- Where the pin came from: 'warm' (pinned from a vendor result) or 'manual' (the
  -- add box). Free-vocab at the column, closed at the door below — 0008's precedent.
  source text not null default 'warm',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A LinkedIn URL or nothing — never arbitrary text in a column bound for an href.
  constraint warm_pins_profile_url_is_linkedin_or_blank
    check (profile_url = '' or profile_url ~* '^https://([a-z0-9-]+\.)*linkedin\.com/')
);

-- One pin per PERSON per target (not one per target). `posting_key` for a tracked
-- posting; `company_key` for a bare-company target (posting_key stays ''). Both in
-- the key so the two target kinds cannot collide on an empty posting_key, and
-- `pin_identity` so a posting can hold a whole set of intros while re-pinning one
-- person updates that person's row.
create unique index warm_pins_one_per_person_per_target
  on public.warm_pins (user_id, target_kind, posting_key, company_key, pin_identity);

create index warm_pins_user_company_idx
  on public.warm_pins (user_id, company_key);

-- Unconditional, for `warm_searches_touch`'s reason: `company_key` is generated,
-- so a whole-row WHEN guard is refused by Postgres (0013's connections precedent).
drop trigger if exists warm_pins_touch on public.warm_pins;
create trigger warm_pins_touch before update on public.warm_pins
  for each row execute function public.touch_updated_at();

comment on table public.warm_pins is
  'the person pinned as the warm intro for one row (0020); one per (user,target), replaced on re-pin, kept apart from layer-0 connections so the 1st-degree count stays honest';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS — owner reads directly, every write goes through a function
-- ════════════════════════════════════════════════════════════════════════════

alter table public.warm_searches enable row level security;
alter table public.warm_pins     enable row level security;

-- The browser READS both tables directly through PostgREST (the poller reads a
-- search; the grid reads its pins), so the select policy is load-bearing and
-- `tests/db/test_rls.py`-shaped assertions cover both directions. No
-- insert/update/delete policy, here or ever: writes go through the functions below
-- or not at all (0001's closing note, 0013's connections verbatim).
create policy warm_searches_self_read on public.warm_searches
  for select using (user_id = auth.uid());
create policy warm_pins_self_read on public.warm_pins
  for select using (user_id = auth.uid());

-- Named roles, not just `public`: Supabase's bootstrap grants INSERT/UPDATE/DELETE
-- to `anon` and `authenticated` BY NAME on every new table, and revoking from
-- `public` alone leaves those intact (matrix row 216). Without this a browser
-- session could update its own `status` to 'done' with invented results, or delete
-- the audit of a run it was charged for.
revoke insert, update, delete, truncate on public.warm_searches
  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.warm_pins
  from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- start — insert the request, cap-enforced, in one statement
-- ════════════════════════════════════════════════════════════════════════════

/**
 * Reserve one warm search, or refuse over the daily cap.
 *
 * THE CAP IS CHARGED HERE, at insert, before the route spends a cent starting the
 * vendor run — because the row IS the reservation. `p_daily_cap` arrives from the
 * caller (one number, in `webapp/lib/warm/config.ts`) rather than being hardcoded,
 * and is clamped to a sane range so a caller cannot pass 0 (which would wedge every
 * search) or something enormous. A cap breach raises SQLSTATE 'HQCAP', which the
 * route maps to a clear "you have used your N searches for today" — never a silent
 * drop (the whole point of a cap the user can see).
 *
 * Rolling 24h, not a calendar day: no timezone to get wrong, and "you did 20 in the
 * last day" is the honest sentence. Cancelled and failed runs COUNT — a started run
 * has usually already incurred the vendor's per-page charge, so the cap is on spend,
 * not on success.
 *
 * Idempotent: a double-clicked "Search" with one idem key returns the first row and
 * does not charge the cap twice.
 *
 * CONCURRENCY-SAFE, and it was NOT: the cap was a check-then-insert with no lock, so
 * N `/api/warm/start` calls racing under READ COMMITTED each read the same pre-insert
 * count, all passed `>= v_cap`, and all inserted (measured: 8 concurrent starts at
 * cap=1 → 8 rows). The whole feature's only spend control, bypassable by a burst. The
 * `pg_advisory_xact_lock` below serializes every start FOR ONE USER on the count, so
 * the second racer blocks until the first commits and then sees the true count. It is
 * per-user (the lock key is the user id), so one user's burst cannot slow another's,
 * and xact-scoped, so it releases on commit. `test_warm.py`'s concurrent-start case is
 * the pin: drop this line and it goes red.
 */
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
  v_user     uuid  := auth.uid();
  v_kind     text  := coalesce(p_target_kind, 'posting');
  v_cap      int   := least(greatest(coalesce(p_daily_cap, 20), 1), 1000);
  v_overlays jsonb := coalesce(p_overlays, '{}'::jsonb);
  v_count    int;
  v_row      public.warm_searches;
  v_result   jsonb;
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
  -- request never contends for it.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  -- Replay BEFORE the cap check: a retried "Search" must return the first row, not
  -- spend a second reservation against the cap.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

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
  'reserve one warm search, charging the per-user daily cap at insert under an advisory lock (SQLSTATE HQCAP over cap); idempotent, layer 1 (0020)';

-- ════════════════════════════════════════════════════════════════════════════
-- the row builder — one shape, so a replay never differs from a first write
-- ════════════════════════════════════════════════════════════════════════════

/**
 * One `warm_searches` row as the app reads it (0008/0012's `app_*_row` reason:
 * several paths return it — start, attach, complete, cancel, and their replays —
 * and a replay answering a differently-shaped object is the bug nothing catches
 * until the UI renders a blank).
 *
 * NOT security definer: only ever called from inside the definer functions below,
 * so it already runs with the rights it needs.
 */
create or replace function public.app_warm_search_row(ws public.warm_searches)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id',          ws.id,
           'target_kind', ws.target_kind,
           'posting_key', ws.posting_key,
           'company',     ws.company,
           'params',      ws.params,
           'overlays',    ws.overlays,
           'status',      ws.status,
           'vendor_runs', ws.vendor_runs,
           'results',     ws.results,
           'error',       ws.error,
           'created_at',  ws.created_at,
           'updated_at',  ws.updated_at
         );
$$;

revoke all on function public.app_warm_search_row(public.warm_searches) from public;

-- ════════════════════════════════════════════════════════════════════════════
-- the transitions — attach, complete, fail, cancel
-- ════════════════════════════════════════════════════════════════════════════

/**
 * Attach the persona-per-run mapping to a running search (called once, right after
 * start). `p_runs` is `[{run_id, persona}]` — the persona is persisted so the poll
 * route can re-attribute candidates statelessly (see the table comment). Each entry
 * is shape-checked: a run with no persona would resurrect the "everything is role"
 * bug one layer down.
 */
create or replace function public.app_attach_warm_run(
  p_id   uuid,
  p_runs jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.warm_searches;
  v_run  jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_runs is null or jsonb_typeof(p_runs) <> 'array' then
    raise exception 'runs must be an array' using errcode = '22023';
  end if;
  for v_run in select value from jsonb_array_elements(p_runs) loop
    -- `coalesce` on BOTH reads, and that is the whole guard rather than a tidy-up:
    -- a missing or null `persona` makes `x not in (...)` evaluate to SQL NULL, and
    -- `false or NULL` is NULL, so the RAISE never fires and the entry is stored
    -- persona-less — precisely the "everything is role" hole this validation exists
    -- to close. Found by `tests/db/test_warm.py`'s missing/null-persona case.
    if coalesce(v_run ->> 'run_id', '') = ''
       or coalesce(v_run ->> 'persona', '') not in ('role', 'senior', 'recruiter') then
      raise exception 'each run needs a run_id and a valid persona' using errcode = '22023';
    end if;
  end loop;

  select * into v_row from public.warm_searches
   where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'no such warm search: %', p_id using errcode = 'P0002';
  end if;

  -- Only a running search takes a handle. A search cancelled between start and
  -- attach (the user hit X immediately) keeps its 'cancelled' status; overwriting
  -- would reanimate a run the user already gave up on.
  if v_row.status = 'running' then
    update public.warm_searches set vendor_runs = p_runs
     where id = p_id returning * into v_row;
  end if;

  return public.app_warm_search_row(v_row);
end;
$$;

revoke all on function public.app_attach_warm_run(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.app_attach_warm_run(uuid, jsonb) to authenticated;

/**
 * Land the ranked results and mark the search done.
 *
 * Status re-checked UNDER THE LOCK, and the transition is one-way: only 'running'
 * becomes 'done'. A completion that races a cancel finds 'cancelled' and returns it
 * unchanged — the user's cancel wins, and the fetched results are dropped rather
 * than written over a decision they already made. Already 'done' returns the stored
 * row (the poller is at-least-once; a second completion must be a no-op).
 *
 * `results` is bounded and capped at 60 — a generous ceiling above the configurable
 * merged cap (`HQ_WARM_MAX_RESULTS`, default 40); a row carrying more is a caller
 * that skipped the merge, not data to store. The fit-analysis annotation rides
 * inside each candidate object, so the per-object size grows and `pg_column_size`
 * bounds the whole array below.
 */
create or replace function public.app_complete_warm_search(
  p_id      uuid,
  p_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.warm_searches;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'results must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_results) > 60 then
    raise exception 'a warm search returns at most 60 results' using errcode = '22023';
  end if;
  if pg_column_size(p_results) > 262144 then
    raise exception 'results too large' using errcode = '22023';
  end if;

  select * into v_row from public.warm_searches
   where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'no such warm search: %', p_id using errcode = 'P0002';
  end if;

  if v_row.status = 'running' then
    update public.warm_searches
       set status = 'done', results = p_results, error = ''
     where id = p_id returning * into v_row;
  end if;

  return public.app_warm_search_row(v_row);
end;
$$;

revoke all on function public.app_complete_warm_search(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.app_complete_warm_search(uuid, jsonb) to authenticated;

/** Mark a running search failed, with the vendor's reason. One-way, like complete. */
create or replace function public.app_fail_warm_search(
  p_id    uuid,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.warm_searches;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_row from public.warm_searches
   where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'no such warm search: %', p_id using errcode = 'P0002';
  end if;

  if v_row.status = 'running' then
    update public.warm_searches
       set status = 'failed', error = left(coalesce(p_error, ''), 500)
     where id = p_id returning * into v_row;
  end if;

  return public.app_warm_search_row(v_row);
end;
$$;

revoke all on function public.app_fail_warm_search(uuid, text) from public, anon, authenticated;
grant execute on function public.app_fail_warm_search(uuid, text) to authenticated;

/**
 * Cancel a running search. Idempotent: a cancel of an already-terminal search
 * (done / cancelled / failed) is a NO-OP that returns the current row, never an
 * error — the route aborts the vendor run first (also idempotent) and then calls
 * this, and a user tapping X twice, or tapping it after the poll already completed,
 * must get "cancelled"/"done", not a failure page.
 */
create or replace function public.app_cancel_warm_search(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.warm_searches;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_row from public.warm_searches
   where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'no such warm search: %', p_id using errcode = 'P0002';
  end if;

  if v_row.status = 'running' then
    update public.warm_searches set status = 'cancelled'
     where id = p_id returning * into v_row;

    insert into public.events (user_id, kind, posting_key, payload, actor)
    values (v_user, 'warm.search_cancelled', v_row.posting_key,
            jsonb_build_object('search_id', v_row.id), 'user');
  end if;

  return public.app_warm_search_row(v_row);
end;
$$;

revoke all on function public.app_cancel_warm_search(uuid) from public, anon, authenticated;
grant execute on function public.app_cancel_warm_search(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- pins — pin a person to a row, or remove one
-- ════════════════════════════════════════════════════════════════════════════

/** One `warm_pins` row as the app reads it. */
create or replace function public.app_warm_pin_row(wp public.warm_pins)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id',          wp.id,
           'target_kind', wp.target_kind,
           'posting_key', wp.posting_key,
           'company',     wp.company,
           'company_key', wp.company_key,
           'full_name',   wp.full_name,
           'profile_url', wp.profile_url,
           'headline',    wp.headline,
           'source',      wp.source,
           'updated_at',  wp.updated_at
         );
$$;

revoke all on function public.app_warm_pin_row(public.warm_pins) from public;

/**
 * Pin a person to a row's intro SET (from a vendor result, or hand-typed in the add
 * box). Adds them; re-pinning the SAME person (same `pin_identity`) updates that
 * person's row rather than duplicating, so one posting holds a whole set.
 *
 * `p_profile_url` is a linkedin.com URL or '' — the CHECK on the column refuses
 * anything else, and the browser door (`isLinkedinProfileUrl`) refuses it first so
 * a person gets a sentence rather than a Postgres error. A bare NAME with no URL is
 * fully legal: the add box accepts "a LinkedIn URL or a name". `source` is closed to
 * the two tags this app writes. A no-op re-pin (identical values) does NOT bump
 * `updated_at` — the do-update is guarded (n1).
 */
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

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_pin_warm_intro(text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.app_pin_warm_intro(text, text, text, text, text, text, text, text)
  to authenticated;

/** Remove a pin the caller owns. Idempotent: unpinning what is already gone is fine. */
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
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_unpin_warm_intro(bigint, text) from public, anon, authenticated;
grant execute on function public.app_unpin_warm_intro(bigint, text) to authenticated;
