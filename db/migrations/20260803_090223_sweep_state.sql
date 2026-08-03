-- 20260803_090223_sweep_state.sql
--
-- WHAT THIS CHANGES and WHY. Migrations are append-only: this file will run
-- exactly once against production and can never be edited afterwards.
--
-- RM-12 cuts discovery over from the Google Sheet to Postgres. `monitor/run.py`
-- is written against the 16-method `SheetStore` protocol (`monitor/sheet.py:43`),
-- so a `PgFeedStore` can replace `HQFeedStore` without the sweep changing — but
-- two of the protocol's methods have no Postgres home. This adds exactly those
-- two and nothing else.
--
-- WHAT IT DELIBERATELY DOES NOT ADD, each proven unnecessary by reading the
-- Sheet implementation rather than assumed:
--
--   mark_seeded     `user_companies.seeded` already exists (0001_init.sql:84),
--                   with `monitor` and `priority` beside it.
--   read_min_yoe    keyed by POSTING, not by company — `monitor/sheet.py:103`
--                   populates it from `rec.id` — and `postings.tags` already
--                   carries `min_yoe` (named in the 0001 comment).
--   write_health    nothing in Python reads the Health tab; the only references
--                   are its writer, the selfheal tab list, and the schema
--                   declaration. It is a write-only human readout of one run's
--                   per-company fetch results, which is the shape of
--                   `bot_runs.detail` (0023). A table for it would be a table
--                   with no reader.
--
-- If any of those three turns out to need a column after all, it arrives in its
-- own migration with the failing test that found it. Guessing one in now would
-- be a column nobody can remove later.

-- ============================================================ the push latch

-- `mark_pushed` is fill-blank-only: "a role is pushed once; re-marks never
-- clobber" (`monitor/sheet.py:289`). The writer is therefore
-- `... where pushed_at is null`, and NULL is load-bearing — it means "never
-- pushed", which is why this is a nullable date rather than a default.
--
-- Per USER, not per posting. `postings` is shared across tenants; whether a role
-- was pushed is a fact about one person's notifications, and putting it on the
-- shared row would let one user's push suppress another's.
alter table public.user_postings
  add column pushed_at date;

comment on column public.user_postings.pushed_at is
  'Date this posting was pushed to this user, or NULL for never. Written '
  'fill-blank-only by the discovery sweep (monitor.run) so a re-run cannot '
  'notify twice; NULL is the latch, not a missing value.';

-- No index. The sweep reads the whole of one user's slice per run and filters in
-- memory, and `user_postings_queue_idx` already covers the reader's query shape.
-- An index chosen before a query that needs it is a write cost with no reader.

-- ============================================================ the sweep cursor

-- Where a budget-stopped sweep resumes, so tail boards never starve
-- (`monitor/sheet.py:151`). Machine state, not a preference: nothing in the web
-- app shows it and no human sets it.
--
-- WHY A SINGLE-PURPOSE TABLE AND NOT A KEY/VALUE ONE. The Sheet keeps this in
-- the Config tab next to the user's actual knobs, and the tempting port is a
-- `(user_id, key, value)` table that would hold this plus `wide_cursor` plus
-- `titles_include` plus everything else. That table is the Config tab, and the
-- Config tab is a separate authority question — it mixes machine state with
-- user-editable preferences under one grant, so answering it here would decide
-- who may write a user's preferences as a side effect of shipping a cursor.
--
-- A named column cannot absorb that by accident. There is no `key` column to add
-- a row to, so the next person who needs a knob has to go and design the knobs
-- table, which is the conversation this migration is refusing to pre-empt.
create table public.monitor_sweep_state (
  user_id    uuid primary key references public.users (id) on delete cascade,
  -- The company name the last budget-stopped run reached. '' means "start at the
  -- beginning" — the sweep compares this to a company name, so an absent row and
  -- an empty string must mean the same thing, and the reader coalesces.
  cursor     text not null default '',
  updated_at timestamptz not null default now()
);

comment on table public.monitor_sweep_state is
  'Per-user resume point for the discovery sweep. One row per user, written only '
  'by the engine through the service role. Deliberately single-purpose: this is '
  'not the settings table, and has no key column to become one.';

-- ============================================================ RLS

alter table public.monitor_sweep_state enable row level security;

-- A user may read their own resume point; an operator may read any. There is
-- nothing sensitive in a company name, but default-deny is the rule and a row
-- keyed by user_id has an obvious owner, so it gets the same shape as the rest.
create policy monitor_sweep_state_read on public.monitor_sweep_state
  for select using (
    user_id = auth.uid()
    or exists (select 1 from public.users u
               where u.id = auth.uid() and u.is_operator));

-- NO insert/update/delete policy, on purpose, matching bot_runs (0023): the
-- engine writes through the service role, which is RLS-exempt, and a browser has
-- no write path here at all — not a function, not direct DML. The narrowest
-- surface available.
--
-- Revoke the write privileges BY NAME as well. Supabase grants
-- insert/update/delete to anon/authenticated by default, and RLS alone would let
-- a browser UPDATE silently affect zero rows rather than refuse; a named revoke
-- makes that refusal a deterministic privilege error instead of a no-op the
-- caller reads as success.
revoke insert, update, delete on public.monitor_sweep_state from public, anon, authenticated;

-- ============================================================ entitlement gate
--
-- The read policy above answers "is this row yours". It does NOT answer "is your
-- account turned on", and those are different questions: a pending, suspended or
-- removed account still satisfies `user_id = auth.uid()`. 0027 gates every
-- browser-reachable table with a RESTRICTIVE policy plus a definer-path trigger,
-- but it is append-only and already applied, so a table created afterwards has to
-- bring its own gate — which is exactly what
-- `tests/db/test_default_deny.py::test_every_browser_reachable_table_is_gated`
-- caught when this migration first had only the read policy. The check derives
-- its table set from `pg_catalog`, not from a list, which is why it noticed.
--
-- Named `<table>_entitled` and `<table>_entitlement_guard` so that catalog sweep
-- finds them by the same convention it uses for the 0027 tables.

-- Restrictive: ANDed with every permissive policy on the table, present and
-- future. `for all` so a policy added later cannot widen the gate.
create policy monitor_sweep_state_entitled on public.monitor_sweep_state
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

-- And the definer path, which a policy cannot reach: a security-definer function
-- runs as its owner and is not subject to the caller's RLS, so the trigger is
-- what stops an unentitled account reaching this table through one.
create trigger monitor_sweep_state_entitlement_guard
  before insert or update or delete on public.monitor_sweep_state
  for each row execute function public.hq_entitlement_guard();
