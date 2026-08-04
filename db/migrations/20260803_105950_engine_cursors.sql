-- 20260803_105950_engine_cursors.sql
--
-- WHAT THIS CHANGES and WHY. Migrations are append-only: this file will run
-- exactly once against production and can never be edited afterwards.
--
-- RM-12 takes the Google Sheet away from the engine. The Config tab is one of
-- the four cross-cutting facilities with no Postgres home
-- (`docs/plans/SHEET-INVENTORY.md` §3), and reading it end to end showed it is
-- several authorities wearing one costume, not one thing to port
-- (`docs/plans/SHEET-FACILITIES.md` §1.2). `core/config.py:156` holds 38
-- validated keys; 13 are operator tuning and 25 are per-user preferences:
--
--   search profile   `titles_include`, `titles_exclude`, `filter_countries`,
--                    `filter_metros` and 8 more. 12 of the 25. Home already
--                    exists: `profiles.criteria` (0001), which the web app
--                    reads and writes. A READER gap. No table.
--   notification     `notify_quiet_hours`, `notify_timezone`, the five
--                    per-event `notify_*` channels, `push_new_jobs`,
--                    `push_status_events`, `yoe_push_max`, `stale_days`,
--                    `digest_hour_ct`, `dna_companies`. 13 of the 25, and
--                    **NONE of them has a Postgres home today** — no column, no
--                    jsonb key, no reader, no writer. That is a SCHEMA gap and
--                    it is NOT resolved by this migration or any other on this
--                    branch. It is blocking work, gated in SHEET-FACILITIES §5
--                    and in SHEET-INVENTORY §8: it lands BEFORE the Config tab
--                    is retired, or quiet hours loses its window and its zone
--                    and the push kill switches silently flip back on.
--                    An earlier revision of this header called this half a
--                    reader gap. It was wrong, an independent review caught it,
--                    and it is corrected here rather than in the document alone
--                    because this file becomes uneditable the moment it runs.
--   tuning knobs     worker counts, retry caps. `core/config_defaults.yaml` is
--                    already the committed home and already the fallback when
--                    the tab is unreadable (`core/config.py:228`). No table.
--   spend budgets    `wide_credit_budget`, `linkedin_backfill_budget`. Owner
--                    decision, recorded in SHEET-FACILITIES §1.2(c): they stay
--                    operator-owned, with an SSM override so the TheirStack
--                    kill switch does not need a deploy. No table.
--   cursors          THIS FILE.
--
-- What this file claims, and all it claims: the three cursors below have a home
-- now. Nothing here should be read as saying the Config tab is ready to retire.
--
-- Three engine-written resume points, today Config cells:
--
--   wide_cursor               `monitor/wide.py:647`  — newest hiring.cafe
--                             publish date ingested
--   wide_theirstack_cursor    `monitor/wide.py:651`  — TheirStack
--                             discovered_at high-water mark
--   linkedin_backfill_cursor  `monitor/linkedin_backfill.py:668` — last
--                             company id probed (0 = start over)
--
-- The fourth, `monitor_sweep_cursor`, is NOT homed here. It lives in
-- `public.monitor_sweep_state`, added by `20260803_090223_sweep_state.sql`, which
-- landed in `3e20aba` (#163) alongside the PgFeedStore cutover.
--
-- (Two earlier revisions of this comment were wrong about that table in opposite
-- directions — the first said it existed when it was only on an unmerged branch,
-- the second said it might never land, after that branch was rejected. It was
-- reworked and merged. Recorded because this file cannot be edited once it runs,
-- and a reader who finds a confident claim here should know its history.)
--
-- This file deliberately does not absorb that cursor. Migrations are append-only,
-- so moving its column would leave a second home for one cursor; two tables for
-- four cursors costs nothing at read time. SHEET-FACILITIES §6 is the full
-- argument and records the runner-up shape.

-- ============================================================ the table

-- PER USER, and substantively so rather than by symmetry. `monitor/wide.py:578`
-- builds the TheirStack company fence from THAT user's priority companies, so
-- two users sweep different windows. A shared cursor would let one tenant's
-- completed sweep advance the mark past another tenant's unfetched jobs — a
-- silent loss of postings, indistinguishable from nobody hiring.
--
-- CURRENT STATE, not history. A cursor is a high-water mark; the previous value
-- has no reader and no meaning. `updated_at` exists for the operator's "is this
-- lane stuck" question and nothing else. (Contrast `core/beats.py:15`, which
-- appends for the opposite reason: "how often did it run last week" is not
-- answerable from an upserted cell, and "where does the sweep resume" is not
-- answerable from a log.)
create table public.engine_cursors (
  user_id    uuid not null references public.users (id) on delete cascade,

  -- WHY A CHECKED ENUMERATION AND NOT A FREE `key` COLUMN.
  --
  -- `monitor_sweep_state` (20260803_090223) refused a `(user_id, key, value)`
  -- table on the ground that it would BE the Config tab: machine state and
  -- user-editable preferences under one grant, with the authority question
  -- decided as a side effect of shipping a cursor. That reasoning is right and
  -- this file keeps it.
  --
  -- Note what that does NOT mean. The 13 notification preferences above still
  -- have no home anywhere, so "there is nowhere left for a preference to go" —
  -- which an earlier revision of this comment asserted — is false. The point of
  -- the check constraint is precisely that their homelessness cannot be resolved
  -- by quietly adding rows HERE. Whoever homes them designs that table on its
  -- own merits, with its own grant decision, which is the conversation this
  -- constraint refuses to let a cursor migration pre-empt.
  --
  -- A lane column looks like the key column that decision refused. The check is
  -- what makes it not one: `insert ... values (uid, 'titles_include', ...)` is a
  -- constraint violation, not a row, so the next person who needs a knob still
  -- has to go and design the knobs table. Adding a lane costs a migration that
  -- names it, which is the same cost as adding a column and produces the same
  -- conversation.
  --
  -- What it buys over three named columns: the three cursors really are the
  -- same kind of thing, and the reader is one function instead of three. The
  -- Sheet already paid for that duplication twice — `monitor/wide.py:236` and
  -- `monitor/linkedin_backfill.py:683` are acknowledged twin accessors, kept
  -- separate only to avoid an import cycle (`monitor/linkedin_backfill.py:677`).
  lane       text not null
    constraint engine_cursors_lane_is_a_closed_set
      check (lane in ('wide_cafe', 'wide_theirstack', 'linkedin_backfill')),

  -- NOT NULL DEFAULT '', and both halves are load-bearing. `monitor/wide.py:505`
  -- reads `_config_value(...) or _default_cursor(today)`: a missing cell falls
  -- back to a two-day window, so an absent row and a blank one must mean the
  -- same thing. A nullable cursor gives the reader a third state it has no
  -- branch for, and the branch it would fall into — comparing a timestamp
  -- against NULL — is the one that silently skips the window forever instead of
  -- re-sweeping it. Costing a re-sweep is the safe direction; skipping is not.
  cursor     text not null default '',

  updated_at timestamptz not null default now(),

  -- One resume point per (user, lane). Two rows is two runs disagreeing about
  -- where the sweep is, and the loser is whichever the reader saw first.
  primary key (user_id, lane)
);

comment on table public.engine_cursors is
  'Per-user, per-lane resume points for the engine''s budgeted sweeps. Written '
  'only by the engine through the service role. Deliberately NOT a settings '
  'table: the lane domain is closed by a check constraint, so a preference '
  'cannot be parked here — its home is profiles.criteria (0001).';

comment on column public.engine_cursors.cursor is
  'The lane''s high-water mark as the lane defines it: an ISO timestamp for the '
  'two wide sweeps, a company id for the backfill. Empty means "start from the '
  'default window" — the reader coalesces, so an absent row and a blank one are '
  'the same thing.';

-- No index beyond the primary key. Every read is `where user_id = ? and lane = ?`
-- or one user's three rows, both of which the primary key serves. An index
-- chosen before a query that needs it is a write cost with no reader.

-- ============================================================ RLS

alter table public.engine_cursors enable row level security;

-- A user may read their own resume points; an operator may read any. There is
-- nothing sensitive in a publish date or a company id, but default-deny is the
-- rule and a row keyed by user_id has an obvious owner, so it gets the same
-- shape as `bot_runs` (0023).
create policy engine_cursors_read on public.engine_cursors
  for select using (
    user_id = auth.uid()
    or exists (select 1 from public.users u
               where u.id = auth.uid() and u.is_operator));

-- NO insert/update/delete policy, on purpose, matching `bot_runs` (0023) and
-- the engine writes through the service role, which is
-- RLS-exempt, and a browser has no write path here at all — not a function, not
-- direct DML.
--
-- Revoke the write privileges BY NAME as well. Supabase grants
-- insert/update/delete to anon/authenticated by default, and RLS alone would let
-- a browser UPDATE silently affect zero rows rather than refuse; a named revoke
-- makes that refusal a deterministic privilege error instead of a no-op the
-- caller reads as success.
revoke insert, update, delete on public.engine_cursors from public, anon, authenticated;

-- ============================================================ entitlement gate
--
-- The read policy above answers "is this row yours". It does NOT answer "is your
-- account turned on", and those are different questions: a pending, suspended or
-- removed account still satisfies `user_id = auth.uid()`. 0027 gates every
-- browser-reachable table with a RESTRICTIVE policy plus a definer-path trigger,
-- but it is append-only and already applied, so **a table created afterwards
-- inherits nothing and must bring its own gate.** That hole was found and closed
-- once already this week, by
-- `tests/db/test_default_deny.py::test_every_browser_reachable_table_is_gated`,
-- which noticed because it derives its table set from `pg_catalog` rather than
-- from a list.
--
-- Named `<table>_entitled` and `<table>_entitlement_guard` so that catalog sweep
-- finds them by the same convention it uses for the 0027 tables.

-- Restrictive: ANDed with every permissive policy on the table, present and
-- future. `for all` so a policy added later cannot widen the gate.
create policy engine_cursors_entitled on public.engine_cursors
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

-- And the definer path, which a policy cannot reach: a security-definer function
-- runs as its owner and is not subject to the caller's RLS, so the trigger is
-- what stops an unentitled account reaching this table through one.
create trigger engine_cursors_entitlement_guard
  before insert or update or delete on public.engine_cursors
  for each row execute function public.hq_entitlement_guard();
