-- 0013 — the referral finder, layer 0: deep links the user clicks, and the
-- connections export they already own.
--
-- Migration number note: **0013 here, 0014 is reserved for auto-apply.** Both
-- were designed in parallel from `docs/plans/`; the numbers were assigned up
-- front so the two branches cannot collide the way P8's did
-- (`test_migrations_are_contiguously_numbered` caught that one after a clean
-- rebase, which is the only reason it was caught at all).
--
-- WHY THIS EXISTS
--
-- `docs/plans/REFERRAL-FINDER.md`: the measured funnel is 61 applications → 1
-- interview → 0 referrals, which is the cold-apply base rate. The binding
-- constraint is conversion, and the highest-leverage unbuilt capability is
-- warm-intro pathing.
--
-- THE HARD LINE, WHICH THIS FILE IS SHAPED BY
--
-- Connection degree exists only inside the user's own logged-in LinkedIn view
-- plus their officially-exportable 1st-degree CSV. No compliant API sells it,
-- and enforcement is suspension-first (hiQ: ToS held enforceable; Proxycurl: a
-- $10M-ARR vendor chose shutdown; HeyReach: the vendor AND its users' accounts
-- banned). The account is the delivery channel for the whole play, so:
--
--   layer 0  deep links the person clicks in their own session, plus the
--            official export — zero risk. **This migration is layer 0 only.**
--   layer 1  vendor APIs that never touch their session — later, if ever.
--   layer ∞  their `li_at` cookie, a page-reading extension, messaging-as-them
--            — never built, permanently. Not a v2.
--
-- Nothing here fetches anything. `linkedin_company_id` is a number a person
-- pastes off a URL bar; `connections` is a CSV they downloaded from LinkedIn
-- and uploaded here. There is no code path in this schema that talks to
-- linkedin.com, and there must never be one.
--
-- TWO TRADEOFFS, STATED RATHER THAN BURIED
--
-- 1. `linkedin_company_id` lives on the SHARED `public.companies` table, not on
--    the per-user `user_companies` row. It is a fact about the company (the same
--    kind of fact as `ats`/`slug`), so per-user copies would mean three people
--    pasting the same number three times and two of them getting it wrong. The
--    cost is that one user's paste is visible to — and overwritable by — every
--    other watcher of that company. Fair at allowlist scale (0012's widening
--    makes the identical argument about `company` on the preview corpus, and
--    names the identical trigger: it stops being fair the day the allowlist
--    holds strangers). Mitigated rather than ignored: the write is
--    optimistic-concurrency checked against the COMPANY row's own token, it
--    writes an `events` row naming the before and after, and only somebody who
--    already watches the company may write it at all.
--
-- 2. The COLUMN is free-vocab; the BROWSER DOOR is a closed set. This is 0008's
--    precedent for `source` applied verbatim, including its reason: a table-wide
--    CHECK on a column the Python mirror bulk-upserts lets one unrecognised
--    value fail a 500-row chunk and wedge the mirror, so the closed set lives in
--    the function that `authenticated` can call. `app_set_linkedin_company_id`
--    accepts digits or nothing; anything else is refused by name.
--
--    The consequence is that a reader cannot assume the column holds digits, and
--    `webapp/lib/referral/linkedin.ts` refuses to build a URL out of anything
--    else. A free-vocab column whose only consumer is a URL builder needs the
--    guard at BOTH ends or the day the engine backfills it is the day somebody's
--    company cell renders a link nobody wrote.

-- ============================================================ company identity

/**
 * The LinkedIn numeric company id, and a version token for the shared row.
 *
 * The id is the number in `f_C=<id>` on a company's "See all employees" URL —
 * permanent, free to obtain, and the only thing that makes a people-search deep
 * link land on the right company (a `keywords=Ramp` search returns everybody who
 * has ever typed the word).
 *
 * `updated_at` arrives here for `user_companies`' reason in 0008: every write
 * path in this system is optimistic-concurrency checked, and a table with no
 * version token means two devices editing one row silently clobber each other
 * (matrix row 9). It defaults to now(), so existing rows get a token immediately
 * rather than a null that skips every check forever.
 */
alter table public.companies
  add column if not exists linkedin_company_id text        not null default '',
  add column if not exists updated_at          timestamptz not null default now();

comment on column public.companies.linkedin_company_id is
  'LinkedIn numeric company id (the f_C= value), pasted once per company; free-vocab at the column, digits-only at the browser door (app_set_linkedin_company_id)';
comment on column public.companies.updated_at is
  'optimistic-concurrency token for the shared company row (0013)';

-- Matrix row 96, which cost `user_companies` a migration of its own: the three
-- RPCs set `updated_at` themselves, so the column LOOKS fine — right up until a
-- backfill, a psql fix or the Python mirror changes a row and leaves the token
-- where it was, and the next client holding the old value passes its conflict
-- check and clobbers a write it never saw. A new versioned column gets the
-- trigger in the same statement that creates it.
--
-- `when (old.* is distinct from new.*)` — and this table is the one that needs
-- it, unlike the six unconditional triggers beside it.
--
-- `public.companies` is the only versioned table in this schema that a BULK
-- MIRROR rewrites wholesale. `monitor/discover_universe.upsert_universe` posts
-- the entire ~640-row universe through PostgREST with
-- `resolution=merge-duplicates`, which is `on conflict … do update` — and that
-- fires a BEFORE UPDATE trigger on every row, including the overwhelming
-- majority where every value is byte-identical to what is already stored.
-- Measured against real Postgres: a no-op upsert moved the token by 3ms of
-- wall clock and nothing else.
--
-- Unconditional, the token is therefore a MIRROR-ACTIVITY TIMESTAMP rather than
-- a content version, and the sequence that follows is a user-visible lie: the
-- page renders and captures the token, the universe sweep runs, the paste 409s,
-- and `warm-cell.tsx` says "Somebody set this on another device. Reload to see
-- their value." Nobody did, and the reload shows the same empty cell.
--
-- The other tables do not have this problem for a structural reason rather than
-- by luck: every writer they have is an RPC that already decided the row
-- changed. This clause is the narrowest fix — the token still moves for every
-- real edit, from any writer, which is the whole point of matrix row 96.
drop trigger if exists companies_touch on public.companies;
create trigger companies_touch before update on public.companies
  for each row
  when (old.* is distinct from new.*)
  execute function public.touch_updated_at();

/**
 * The /companies grid row, re-declared to carry the two new company fields.
 *
 * Replaced rather than wrapped: 0008 extracted this precisely so that the three
 * write paths and their replays cannot answer differently-shaped objects, and a
 * second builder for "the same row plus two fields" is that divergence with a
 * different name.
 *
 * TWO TOKENS NOW RIDE ON ONE PAYLOAD and they guard different writes: the
 * subscription's `updated_at` at the top level, and the shared company row's
 * INSIDE the nested `companies` object. Nesting is what keeps them apart on the
 * wire; `toCompanyView` in supabase-source.ts lifts the inner one out under the
 * distinct name `companyUpdatedAt`, so a caller cannot pick up the wrong one by
 * accident and get a conflict on a row nobody touched. (An earlier version of
 * this comment said the SQL emitted a `company_updated_at` key. It does not, and
 * never did — the TypeScript is where the renaming happens.)
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
             'updated_at',          c.updated_at
           )
         )
    from public.companies c
   where c.id = uc.company_id
$$;

revoke all on function public.app_company_row(public.user_companies) from public;

/**
 * Paste a LinkedIn company id onto a company this user watches.
 *
 * THE CLOSED SET, and why it is here rather than on the column: `^[0-9]{1,20}$`
 * or the empty string, which clears it. LinkedIn ids are integers; anything else
 * arriving from a browser is either a mistake or an attempt to get arbitrary
 * text into a string this app concatenates into a URL. 20 digits is well past
 * any real id (they are ~8) and finite, which an unbounded text write from a
 * function granted to `authenticated` is not.
 *
 * THE DOOR: a `user_companies` row must exist for this caller. Not
 * `review_state = 'approved'` — `app_set_company_flags` demands that because
 * flipping `monitor` on an unreviewed row is the one thing the proposal state
 * exists to prevent, and pasting an id is the opposite gesture: it is research
 * somebody does BEFORE deciding, on a row they are looking at in the review
 * grid. Requiring approval would mean the id can only be added after the
 * decision it helps make.
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
  -- LATER empty key replay this gesture's result forever (matrix rows 110, 129,
  -- 218).
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_id := public.hq_blank_trim(coalesce(p_linkedin_id, ''));

  -- The closed set. Anchored on both ends: an unanchored `~ '[0-9]{1,20}'`
  -- matches the digits INSIDE `javascript:1` and would let the whole string
  -- through, which is the same anchoring bug 0010's blank-trim paid for from the
  -- other direction.
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

  -- The door, checked before the company row is locked: a caller who does not
  -- watch this company learns nothing and waits on nothing.
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

  -- Re-check the key with the row LOCKED. The check above only settles
  -- SEQUENTIAL replays; two tabs flushing one outbox on the same 'online' event
  -- both pass it before either writes (0003:166-182).
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Optimistic concurrency, checked INSIDE the transaction that writes, against
  -- the COMPANY row's token rather than the subscription's. The word "conflict"
  -- is load-bearing: `supabase-source.ts` matches /conflict|stale/i on it.
  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this company changed since you read it'
      using errcode = '40001';
  end if;

  v_before := v_row.linkedin_company_id;

  if v_before is distinct from v_id then
    update public.companies
       set linkedin_company_id = v_id
     where id = p_company_id
    returning * into v_row;
  end if;

  -- The row and its audit event in one body, or the trail has holes in it. This
  -- one earns its keep more than most: the column is shared, so "who put 1035
  -- on Ramp and when" is a question somebody will ask.
  --
  -- Written even when the value did not CHANGE, which diverges from 0006/0008
  -- (where a no-op review deliberately writes nothing and does not bump the
  -- token). The divergence is deliberate: on a shared column, "somebody looked
  -- this up again and it is still 1035" is information the trail should hold,
  -- and unlike a review it gates no sweep. The row itself is still left alone,
  -- so the version token does not move under another tab.
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

-- ============================================================ connections

/**
 * One row of LinkedIn's own `Connections.csv` export — the 1st-degree half of
 * layer 0.
 *
 * PER-USER BY CONSTRUCTION. Salman's connections say nothing about whose
 * universe the roommate is looking at, and there is no shared-table version of
 * this that is not a privacy incident.
 *
 * `company_key` is GENERATED, not written. The match this table exists for —
 * "does this connection work at the company on this posting" — is a comparison
 * of normalized names, and 0008 already paid for the alternative twice: 'Aon'
 * and 'aon' pasted in two sessions became two companies, and a name copied out
 * of a web page carries a trailing NBSP that `btrim()` does not strip. A
 * generated column means the normalization CANNOT drift from the one the
 * universe uses, because there is no writer that could get it wrong.
 *
 * `full_name` is the one required field. A connection with no name is not a
 * person you can ask for anything, and the CHECK uses `hq_blank_trim` rather
 * than `btrim` for 0010's reason: bare btrim trims spaces ONLY, so a name of one
 * newline is content to Postgres and blank to everybody else.
 */
create table if not exists public.connections (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  first_name text not null default '',
  last_name  text not null default '',
  -- Stored rather than derived from first+last: LinkedIn's export writes both,
  -- but the field a person reads and searches is the whole name, and a mononym
  -- or a name whose parts the export split wrongly still has to round-trip.
  full_name text not null check (public.hq_blank_trim(full_name) <> ''),
  company text not null default '',
  company_key text not null generated always as (public.company_name_key(company)) stored,
  -- LinkedIn's header is "Position". `title` here, to agree with
  -- `applications.title` and `postings.title` — one word for one thing across
  -- the schema, and `position` is a SQL keyword that has to be quoted half the
  -- places it appears.
  title text not null default '',
  -- The public profile URL from the export. Not fetched, ever — it is what the
  -- "message them" link points AT, in the user's own browser.
  profile_url text not null default '',
  -- LinkedIn writes "21 Mar 2023". Parsed at the edge (`lib/import/read.ts`),
  -- stored as a date, and NULL when it could not be proved — never guessed.
  connected_on date,
  -- Where the row came from, for the same reporting reason `companies.source`
  -- exists. Free-vocab at the column, closed at the browser door below.
  source text not null default 'linkedin-export',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The token, and the trigger that keeps it honest (matrix row 96 again).
drop trigger if exists connections_touch on public.connections;
create trigger connections_touch before update on public.connections
  for each row execute function public.touch_updated_at();

/**
 * Re-importing the export every month must merge, never duplicate.
 *
 * Two partial indexes rather than one key, because the export has two shapes:
 *
 *   * With a profile URL — the normal case, and the URL is the person's
 *     identity. Lower-cased because LinkedIn's own export is inconsistent about
 *     the case of vanity slugs.
 *   * Without one — LinkedIn omits the URL for connections who have restricted
 *     it. Falling back to (name, company) is the best available identity, and
 *     the cost is stated rather than hidden: two people with the same name at
 *     the same company and no URL between them merge into one row. That is a
 *     wrong merge, which this repo normally refuses (0008's `company_name_key`
 *     is deliberately not a slugifier for exactly that reason) — the difference
 *     is that this table is re-imported wholesale from a file the user can
 *     re-download, so a wrong merge is recoverable by deleting and re-importing,
 *     where a wrong merge in `companies` is not recoverable from inside the app.
 */
create unique index if not exists connections_by_profile
  on public.connections (user_id, lower(profile_url))
  where profile_url <> '';

create unique index if not exists connections_by_name
  on public.connections (user_id, lower(public.hq_blank_trim(full_name)), company_key)
  where profile_url = '';

-- The one query shape every render runs: "which of my connections work at these
-- companies".
create index if not exists connections_by_company
  on public.connections (user_id, company_key);

comment on table public.connections is
  'the user''s own LinkedIn Connections.csv export — 1st-degree names, matched to the universe by company_name_key. Nothing here is fetched; it is a file the user downloaded and uploaded.';
comment on column public.connections.company_key is
  'generated: company_name_key(company). The match column compares THIS, never the raw string (0008''s NBSP lesson).';

-- ============================================================ RLS

alter table public.connections enable row level security;

-- Read-only policy, scoped to the owner. No insert/update/delete policy, here or
-- ever: the browser writes through the function below or not at all (0001's
-- closing note). The grid READS this table directly through PostgREST, which is
-- exactly why the select policy is load-bearing and why tests/db/test_rls.py
-- asserts both directions on it.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'connections' and policyname = 'connections_self_read') then
    create policy connections_self_read on public.connections
      for select using (user_id = auth.uid());
  end if;
end
$$;

-- Named roles, not `from public`. Supabase's bootstrap grants to `anon` and
-- `authenticated` BY NAME, and revoking from `public` does not touch a named
-- grant (matrix row 216).
revoke insert, update, delete, truncate on public.connections from public, anon, authenticated;


-- ============================================================ the import

/**
 * An ISO date string as a date, or NULL — and never an exception.
 *
 * This exists because a REGEXP IS A SHAPE, NOT A DATE, and the first version of
 * the import trusted one: `^\d{4}-\d{2}-\d{2}$` accepts `2026-13-45` and
 * `2026-02-31`, `::date` then raises 22008, and one malformed cell takes a
 * 1,000-row chunk down with it — the precise failure the guard was written to
 * prevent.
 *
 * `to_date(x, 'YYYY-MM-DD')` does not help. It is documented as lenient and it
 * is, for some inputs; measured on this schema's own Postgres 16, both of the
 * strings above raise `date/time field value out of range` from inside it. A
 * round trip through a function that throws is still a throw.
 *
 * So the conversion happens where a failure can be CAUGHT. plpgsql's exception
 * block is the only construct in SQL that turns a raise into a value, and the
 * subtransaction it opens is paid only by rows that actually carry a date, at a
 * bound of 1,000 per call.
 *
 * STABLE rather than immutable: `date_in` reads DateStyle. Nothing indexes this.
 */
create or replace function public.hq_iso_date(p_text text)
returns date
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  -- The shape first, so the common refusal (an empty cell, "21 Mar 2023" from a
  -- caller that skipped the parser) costs no subtransaction at all.
  if p_text is null or p_text !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p_text::date;
exception when others then
  -- A day that does not exist. NULL, never a rolled-over neighbour: `connected_on`
  -- is display-only and a date silently a month out is worse than a blank one.
  --
  -- `when others` is DELIBERATE and not laziness. The shapes that get this far
  -- do not raise one errcode: `2026-02-31` raises 22008 (datetime_field_overflow)
  -- and `0000-00-00` raises 22007 (invalid_datetime_format) — a narrower catch
  -- leaks whichever it did not name, which is the whole bug this function exists
  -- to close. The regexp above is what keeps the block narrow: nothing that is
  -- not already shaped like an ISO date reaches the cast at all.
  return null;
end;
$$;

revoke all on function public.hq_iso_date(text) from public;

comment on function public.hq_iso_date(text) is
  'ISO date or NULL, never a raise — a regexp proves a shape and not a day, and one bad cell must not wedge a chunk';

/**
 * The rows a Connections.csv chunk really describes: normalized once, with the
 * identity everything else keys on and a flag saying whether an earlier row in
 * the same chunk already claimed it.
 *
 * Extracted for `app_company_row`'s reason (0008): four statements below need
 * this same set — the counts, the lock pass, and the two upserts — and four
 * copies of a normalization expression is four places for it to drift. It is
 * also the one piece a db test can call directly and compare against the
 * TypeScript mirror, which is what makes "the fake matches SQL on whitespace and
 * blank semantics" an assertion rather than a hope.
 *
 * `is_dupe` is returned rather than filtered, and that is not tidiness: the
 * report has to distinguish a line with no name (skipped) from the same person
 * listed twice (deduped), or `inserted + updated + skipped` does not add up to
 * the file and nobody can re-derive which it was (matrix row 169). Filtering it
 * is ALSO required rather than cosmetic — Postgres refuses an `on conflict do
 * update` that would touch one row twice in a single statement.
 *
 * `hq_blank_trim`, never bare `btrim`: an export is full of stray whitespace and
 * bare btrim trims SPACES ONLY, so a cell holding one non-breaking space (what
 * pasting out of a web page leaves) reads as content (matrix rows 110, 129, 151).
 */
create or replace function public.hq_connection_rows(p_rows jsonb)
returns table (
  ident        text,
  full_name    text,
  first_name   text,
  last_name    text,
  company      text,
  title        text,
  profile_url  text,
  connected_on date,
  is_dupe      boolean
)
language sql
-- STABLE, not immutable, and the distinction is load-bearing rather than
-- pedantic: `text::date` runs `date_in`, which is STABLE (it reads DateStyle),
-- and `to_date` is stable for the same family of reasons. Declaring immutable
-- would be a promise Postgres does not check and would become a wrong answer
-- the day this appears in an index expression. Nothing here needs immutability
-- — the function is called four times inside one plpgsql body and never indexed.
stable
set search_path = pg_catalog, public, pg_temp
as $$
  with raw as (
    select public.hq_blank_trim(coalesce(e ->> 'full_name',   '')) as full_name,
           public.hq_blank_trim(coalesce(e ->> 'first_name',  '')) as first_name,
           public.hq_blank_trim(coalesce(e ->> 'last_name',   '')) as last_name,
           public.hq_blank_trim(coalesce(e ->> 'company',     '')) as company,
           public.hq_blank_trim(coalesce(e ->> 'title',       '')) as title,
           public.hq_blank_trim(coalesce(e ->> 'profile_url', '')) as profile_url,
           public.hq_blank_trim(coalesce(e ->> 'connected_on','')) as connected_on,
           t.ordinality as n
      from jsonb_array_elements(p_rows) with ordinality as t(e, ordinality)
  ),
  bounded as (
    select left(r.full_name, 200)   as full_name,
           left(r.first_name, 100)  as first_name,
           left(r.last_name, 100)   as last_name,
           left(r.company, 200)     as company,
           left(r.title, 200)       as title,
           left(r.profile_url, 500) as profile_url,
           -- ISO or nothing. `lib/referral/connections.ts` is what turns
           -- LinkedIn's "21 Mar 2023" into a date and REFUSES an ambiguous
           -- "03/04/2026", so anything else arriving here is a malformed request
           -- rather than a reading — and nulling it cannot wedge a 1,000-row
           -- chunk the way a cast exception would. `connected_on` is
           -- display-only; the match does not read it.
           --
           -- Through `hq_iso_date`, which is where a raise becomes a NULL. An
           -- inline `case … then x::date` cannot deliver the promise above and
           -- the first version of this line claimed it did: the regexp proves a
           -- SHAPE, and `2026-13-45` has the shape.
           public.hq_iso_date(r.connected_on) as connected_on,
           r.n
      from raw r
     -- A nameless row is not a person you can ask for anything. Skipped and
     -- COUNTED rather than raised: one malformed line in a 3,000-row export must
     -- not refuse the other 2,999.
     where r.full_name <> ''
  ),
  keyed as (
    select b.*,
           case when b.profile_url <> ''
                then 'u:' || lower(b.profile_url)
                else 'n:' || lower(b.full_name) || '|' || public.company_name_key(b.company)
           end as ident
      from bounded b
  )
  -- LAST occurrence wins within a chunk, which is what a sequence of single-row
  -- writes would have left behind. The ORDER BY inside the window is spelled out
  -- because without it the winner is whatever the plan produced.
  select k.ident, k.full_name, k.first_name, k.last_name, k.company, k.title,
         k.profile_url, k.connected_on,
         row_number() over (partition by k.ident order by k.n desc) > 1 as is_dupe
    from keyed k
$$;

revoke all on function public.hq_connection_rows(jsonb) from public;

comment on function public.hq_connection_rows(jsonb) is
  'normalize + dedupe one import chunk; the single definition of what a connection row IS, shared by the count, the lock pass and both upserts';

/**
 * One chunk of a Connections.csv import.
 *
 * P9's philosophy — map → preview → commit — with P9's machinery deliberately
 * NOT reused, and the deviation stated where somebody will look for it. An
 * `import_rows` row carries `job_key`, `key_strength`, `match_kind`,
 * `matched_application_id`, `conflict`, `choices` and `revert`: every one of
 * those is about matching a spreadsheet row to an APPLICATION, and none of them
 * means anything for a name and a company. Staging connections through that
 * table would be seven permanently-default columns plus two new preview/commit
 * functions sharing nothing with the ones already there. What IS reused is the
 * part that carries the risk: `lib/import/read.ts` (dialect, encoding, dates,
 * header sniffing, format refusal) and `lib/import/map-columns.ts` (the 0.82
 * floor and the two-pass suggestion).
 *
 * The cost of not staging is stated on screen and here: **this import is not
 * resumable.** Closing the tab mid-mapping loses the mapping, and the fix is to
 * upload the file again. Fair for a 3,000-row file with no per-row conflict
 * resolution; it would not be for P9's 2,000-row spreadsheet where every row can
 * need an answer.
 *
 * WHAT A BLANK MEANS, which is 0011's answer verbatim: a blank cell is "the file
 * did not say", never "delete what you have". Only non-blank values are applied
 * on the update path.
 */
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

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
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

revoke all on function public.app_import_connections(jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.app_import_connections(jsonb, text, text)
  to authenticated;

/**
 * Throwing the whole import away.
 *
 * It exists for `app_import_discard`'s reason in 0011: without it, "re-import to
 * fix a wrong merge" — the argument the `connections_by_name` index leans on to
 * justify its one merge risk — names a gesture nobody implemented. A recovery
 * path that points at something the system does not offer is the same defect as
 * a button that does nothing.
 *
 * Deliberately total rather than per-batch: this table is a MIRROR of a file,
 * not an append-only trail, and "delete mine and upload again" is the whole
 * recovery story. There is no undo here and nothing a fresh export cannot
 * rebuild — which is exactly why there is no undo.
 */
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

revoke all on function public.app_clear_connections(text) from public, anon, authenticated;
grant execute on function public.app_clear_connections(text) to authenticated;
