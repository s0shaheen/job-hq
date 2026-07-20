-- Job Search HQ v2 — initial Postgres schema (Supabase).
-- Design contract (docs: db/README.md, decision log in the v2 review doc):
--   * ONE store, one write path: the engine (GitHub Actions) writes with the
--     service role; the web app reads with the user's session (anon key +
--     RLS); v1 app is read-only — human writes arrive in Phase-2 stage 3 as
--     server-side API commands, never direct table writes from a browser.
--   * postings are CANONICAL and shared (two users watching the same company
--     never duplicate a posting); everything per-user hangs off user_postings
--     / applications / events keyed by user_id.
--   * events is append-only: every capture email, human gesture, and bot
--     transition lands there — the audit trail the sheet never had.
--   * The per-user Google Sheet becomes a generated read-only export; nothing
--     in this schema ever syncs FROM the sheet.

-- ============================================================ identities

-- Only allowlisted Gmail addresses may become users: the operator seeds this
-- table; the auth trigger below refuses everyone else.
create table public.allowed_emails (
  email text primary key,
  name  text not null default '',
  is_operator boolean not null default false
);

create table public.users (
  id    uuid primary key references auth.users (id) on delete cascade,
  email text unique not null,
  name  text not null default '',
  is_operator boolean not null default false,
  created_at timestamptz not null default now()
);

-- First Google sign-in: create the users row iff the email is allowlisted.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare allowed public.allowed_emails%rowtype;
begin
  select * into allowed from public.allowed_emails
   where lower(email) = lower(new.email);
  if not found then
    raise exception 'email % is not allowlisted for Job Search HQ', new.email;
  end if;
  insert into public.users (id, email, name, is_operator)
  values (new.id, lower(new.email), allowed.name, allowed.is_operator)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create table public.profiles (
  user_id uuid primary key references public.users (id) on delete cascade,
  -- Search Profile: countries, yoe_max, titles_include/exclude,
  -- seniority_exclude, geo_unknown / yoe_unknown policies, comp_floor…
  -- JSONB on purpose: the engine's gates.GateConfig is the schema owner and
  -- validates on read; a bad phone edit can never poison a column type.
  criteria jsonb not null default '{}'::jsonb,
  -- digest email, ntfy topic, push preferences
  notify jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================ universe

create table public.companies (
  id   bigint generated always as identity primary key,
  name text not null,
  ats  text not null default '',
  slug text not null default '',
  unique (name, ats, slug)
);

create table public.user_companies (
  user_id    uuid   not null references public.users (id) on delete cascade,
  company_id bigint not null references public.companies (id) on delete cascade,
  monitor  boolean not null default true,
  priority boolean not null default false,
  seeded   boolean not null default false,
  primary key (user_id, company_id)
);

-- ============================================================ postings

create table public.postings (
  key        text primary key,              -- core.jobkeys "{ats}-{native_id}"
  company    text not null,
  title      text not null,
  location   text not null default '',
  url        text not null,
  posted     date,          -- NULL whenever the source date is unparseable
  first_seen date not null,
  last_seen  date not null,
  -- Board lifecycle: New | Seen | Closed. Deliberately NOT a CHECK — this
  -- column is mirrored from a human-editable spreadsheet cell, and the
  -- durability contract holds that a human-invented status is legal and
  -- untouchable. A CHECK here would let one fat-fingered cell fail an entire
  -- 500-row upsert chunk and wedge the mirror. Same reasoning for
  -- applications.status below. Columns written ONLY by our own code
  -- (disposition, triage) keep their CHECKs.
  status     text not null default 'New',
  -- yoe / seniority / company_industry / role_focus / skills / comp_range /
  -- work_model / min_yoe / tagged_at — written whole by the tagger
  tags jsonb not null default '{}'::jsonb,
  -- city / state / country / remote / market — deterministic geo.enrich
  geo  jsonb not null default '{}'::jsonb,
  source text not null default 'monitor',   -- monitor|priority|wide-cafe|wide-theirstack|quickadd
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index postings_last_seen_idx on public.postings (last_seen desc);
create index postings_company_idx   on public.postings (company);

-- Per-user gate outcome + triage state for a posting.
create table public.user_postings (
  user_id     uuid not null references public.users (id) on delete cascade,
  posting_key text not null references public.postings (key) on delete cascade,
  disposition text not null
              check (disposition in ('qualified', 'filtered', 'needs-info')),
  disposition_reason text not null default '',
  triage text not null default ''
         check (triage in ('', 'interested', 'dismissed', 'snoozed')),
  triage_reason text not null default '',
  snooze_until  date,
  score numeric,
  updated_at timestamptz not null default now(),
  primary key (user_id, posting_key)
);

create index user_postings_queue_idx
  on public.user_postings (user_id, disposition, triage);

-- ============================================================ pipeline

create table public.applications (
  id bigint generated always as identity primary key,
  user_id     uuid not null references public.users (id) on delete cascade,
  posting_key text references public.postings (key),
  company text not null,
  title   text not null,
  url     text not null default '',
  source  text not null default 'manual',   -- monitor|scout|simplify|manual|gmail
  -- Inbox|Queued|Applied|OA|Screen|Interview|Final|Offer|Rejected|Withdrawn|
  -- Closed — no CHECK, same reason as postings.status: mirrored from a
  -- human-editable cell, and core/schema.py:status_rank explicitly ranks
  -- unknown human statuses highest (untouchable).
  status  text not null,
  suggested_status text not null default '',
  evidence text not null default '',        -- gmail deep link etc.
  applied_date  date,
  applied_via   text not null default '',
  applied_email text not null default '',
  last_activity date,
  next_action      text not null default '',
  next_action_date date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, posting_key)
);

create index applications_user_status_idx
  on public.applications (user_id, status, updated_at desc);

-- ============================================================ events (append-only)

create table public.events (
  id bigint generated always as identity primary key,
  user_id        uuid references public.users (id) on delete cascade,
  kind           text not null,   -- email.received|email.rejection|email.oa|email.interview|email.offer|action.interested|action.dismissed|action.snoozed|action.status|bot.gated|bot.closed|…
  posting_key    text,
  application_id bigint references public.applications (id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  actor   text  not null default 'system',  -- system|gmail-capture|user|operator
  occurred_at timestamptz not null default now()
);

create index events_user_time_idx on public.events (user_id, occurred_at desc);

-- ============================================================ health ledger

create table public.channel_runs (
  id bigint generated always as identity primary key,
  user_id  uuid references public.users (id) on delete cascade,  -- null = shared channel
  channel  text not null,   -- monitor|priority|wide-cafe|theirstack|review|capture|digest|selfheal
  ran_at   timestamptz not null default now(),
  fetched  integer not null default 0,
  new_rows integer not null default 0,
  filtered integer not null default 0,
  tagged   integer not null default 0,
  errors   integer not null default 0,
  detail   jsonb not null default '{}'::jsonb
);

create index channel_runs_channel_idx on public.channel_runs (channel, ran_at desc);

-- ============================================================ own-Simplify substrate

create table public.answers (
  user_id  uuid not null references public.users (id) on delete cascade,
  question text not null,               -- canonical question text
  answer   text not null,
  kind     text not null default 'freeform',  -- identity|location|address|auth|comp|skills|freeform
  updated_at timestamptz not null default now(),
  primary key (user_id, question)
);

-- ============================================================ freshness

-- merge-duplicates upserts only write the columns in the payload, so
-- updated_at would freeze at insert time without this. Freshness is load
-- bearing during dual-write ("when did the mirror last touch this row?").
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger postings_touch      before update on public.postings
  for each row execute function public.touch_updated_at();
create trigger user_postings_touch before update on public.user_postings
  for each row execute function public.touch_updated_at();
create trigger applications_touch  before update on public.applications
  for each row execute function public.touch_updated_at();
create trigger profiles_touch      before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger answers_touch       before update on public.answers
  for each row execute function public.touch_updated_at();

-- ============================================================ RLS

-- Everything locked down; the service role (engine, server-side API routes)
-- bypasses RLS by design. Browser sessions get exactly these reads:
alter table public.allowed_emails enable row level security;
alter table public.users          enable row level security;
alter table public.profiles       enable row level security;
alter table public.companies      enable row level security;
alter table public.user_companies enable row level security;
alter table public.postings       enable row level security;
alter table public.user_postings  enable row level security;
alter table public.applications   enable row level security;
alter table public.events         enable row level security;
alter table public.channel_runs   enable row level security;
alter table public.answers        enable row level security;

create policy users_self_read on public.users
  for select using (id = auth.uid());

create policy profiles_self_read on public.profiles
  for select using (user_id = auth.uid());

-- shared reference data: any signed-in (allowlisted) user may read
create policy companies_authenticated_read on public.companies
  for select using (auth.role() = 'authenticated');

create policy postings_authenticated_read on public.postings
  for select using (auth.role() = 'authenticated');

create policy user_companies_self_read on public.user_companies
  for select using (user_id = auth.uid());

create policy user_postings_self_read on public.user_postings
  for select using (user_id = auth.uid());

create policy applications_self_read on public.applications
  for select using (user_id = auth.uid());

create policy events_self_read on public.events
  for select using (user_id = auth.uid());

-- operators see all channel health; users see their own rows + shared (null) rows
create policy channel_runs_read on public.channel_runs
  for select using (
    user_id is null
    or user_id = auth.uid()
    or exists (select 1 from public.users u
               where u.id = auth.uid() and u.is_operator));

create policy answers_self_read on public.answers
  for select using (user_id = auth.uid());

-- NO insert/update/delete policies on purpose: v1 browser sessions cannot
-- write anything. Phase-2 stage 3 adds command endpoints (server-side,
-- service role) and narrow write policies if direct writes ever make sense.
