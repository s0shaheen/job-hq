-- Universe discovery metadata — how each company entered the shared universe and
-- how reliably its jobs can be pulled.
--
-- The discovery system (docs/plans/COMPANY-DISCOVERY.md) turns "which companies?"
-- into two mechanical questions: can we pull this company's jobs, and how did we
-- find it. Those answers are a property of the COMPANY, not of any one user's
-- subscription, so they live on the shared `companies` table — resolved once,
-- read by everyone. (The per-user on/off toggle is already `user_companies.monitor`;
-- this migration deliberately adds no per-user column.)
--
-- All three are additive and nullable/defaulted: every existing row is unaffected,
-- and every pg write to `companies` goes through core.pg.upsert() (PostgREST, columns
-- addressed by name, on_conflict=name,ats,slug) — there is no positional or all-columns
-- insert anywhere — so unlisted new columns simply take their defaults. Any future
-- companies writer MUST keep addressing columns by name, never positionally.
-- reliability_tier is nullable because a company is "unresolved" until the resolution
-- waterfall has actually pulled its jobs; the CHECK admits only the three tiers the
-- design defines, or null.

alter table public.companies
  add column if not exists source            text     not null default '',  -- where discovered: dork / common-crawl / edgar / form-adv / theirstack / import / manual / dads-list
  add column if not exists reliability_tier  smallint,                       -- 1=direct ATS adapter (day-of) · 2=aggregator (lagged) · 3=manual/best-effort · null=unresolved
  add column if not exists resolution_method text     not null default '';   -- how resolved: slug-map / greenhouse-guess / ashby-guess / workday-redirect / aggregator / web-search

alter table public.companies
  drop constraint if exists companies_reliability_tier_check;
alter table public.companies
  add constraint companies_reliability_tier_check
  check (reliability_tier is null or reliability_tier in (1, 2, 3));

comment on column public.companies.source is 'where this company was discovered (free-text tag)';
comment on column public.companies.reliability_tier is '1=direct ATS/day-of, 2=aggregator/lagged, 3=manual; null until resolved';
comment on column public.companies.resolution_method is 'which waterfall step grounded this company';
