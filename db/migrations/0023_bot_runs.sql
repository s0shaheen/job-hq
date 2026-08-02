-- 0023 — per-run bot rows: the real source under Coverage's Activity tab (E3).
--
-- doc 07 §4 E3: "per-run rows — job, started, finished, result counts — written
-- by the Lambda handler; unblocks Coverage's Activity tab; the ops ntfy topic
-- stays as-is". The Activity tab wants to say, per job and in plain words, "Last
-- succeeded 2h ago" / "Failing since Jul 24" / "Running" — and nothing today can
-- answer that. `channel_runs` (0001) looks close, and it is the wrong table:
--
--   * It is the DISCOVERY health ledger, keyed by `channel`
--     (monitor|priority|wide-cafe|…) with per-posting counts. The handler's unit
--     is a JOB INVOCATION (monitor|review|tracker|digest|snapshot|…), which is a
--     different grain — some jobs are not channels at all (tracker, digest,
--     selfheal), and `channel_runs.errors` counts per-posting FETCH errors, not
--     whether the job itself failed. Overloading it would read a healthy sweep
--     with 8 dead adapters as a failed run.
--   * `core/beats.py` already writes `channel_runs` rows with `channel` values
--     'digest' and 'snapshot' as HEARTBEATS. A handler row with job='digest' in
--     the same table+column would collide with the heartbeat lane the digest
--     watchdog reads — two meanings, one (channel, ran_at).
--   * "Running" and "Failing since" need started_at, a nullable finished_at, and
--     a job-level ok — none of which `channel_runs` has, and bolting them onto a
--     table three other consumers depend on is riskier than a purpose-built one.
--
-- So: a new, narrow table, shaped exactly like the question the tab asks. One row
-- per invocation, opened when the run starts (finished_at null = running / died
-- mid-flight) and closed at the end with the outcome and result counts.
--
-- WRITTEN BY THE ENGINE, via the service role (which bypasses RLS), exactly as
-- `channel_runs` is. There is NO browser write path and no function: a bot_runs
-- row carries no per-user secret — a job name, a timing, a count — so it is
-- observability, not a command. `core/runlog.py` is the writer; a write failure
-- there must NEVER fail the bot job it wraps (best-effort, same envelope doctrine
-- as the handler's ops alert), because a missing Activity row is recoverable and
-- a job killed by its own telemetry is not.

create table public.bot_runs (
  id bigint generated always as identity primary key,
  user_id     uuid references public.users (id) on delete cascade,  -- null = shared / operator-wide job
  job         text not null,          -- the handler.JOBS key: monitor|review|tracker|digest|snapshot|…
  started_at  timestamptz not null default now(),
  finished_at timestamptz,            -- null = still running, or the invocation died before it could close
  ok          boolean,                -- null while running; true|false once finished
  fetched     integer not null default 0,   -- result count: items the run examined
  new_rows    integer not null default 0,   -- result count: new items it produced
  error       text,                   -- one-line failure summary; null on success
  detail      jsonb not null default '{}'::jsonb,

  -- A run is either OPEN (no finish time, no outcome) or CLOSED (both). The
  -- third combination — finished, outcome unknown — is the one the reader cannot
  -- honestly render: "it ended, nobody knows how" is neither a success nor a
  -- failure, and whichever the mapper picked would be a guess about whether the
  -- user's automation is working. `core/runlog.py` always writes the pair
  -- together, so this constraint costs nothing and makes the reader's state
  -- machine TOTAL rather than merely conventional — the fail-loud rule applied
  -- at the boundary that can actually enforce it.
  constraint bot_runs_outcome_matches_finish
    check ((finished_at is null) = (ok is null))
);

-- Two access paths, because the reader has two.
--
-- The Activity read is `order by started_at desc limit 500` over one user's rows
-- (plus the shared ones) and groups by job in application code, so the ORDER is
-- what needs an index — (job, started_at desc) alone cannot serve it and the
-- planner would sort the whole table. The per-job index stays for the targeted
-- "this job's history" lookup, the same shape as channel_runs_channel_idx.
create index bot_runs_started_idx on public.bot_runs (started_at desc);
create index bot_runs_job_idx on public.bot_runs (job, started_at desc);

-- ============================================================ RLS

alter table public.bot_runs enable row level security;

-- Same visibility rule as channel_runs (0001): operators see every job's runs;
-- a user sees their own rows plus the shared (null user_id) ones. A single-user
-- job's rows are shared and readable by any signed-in session, which is fine —
-- there is nothing private in a run row.
create policy bot_runs_read on public.bot_runs
  for select using (
    user_id is null
    or user_id = auth.uid()
    or exists (select 1 from public.users u
               where u.id = auth.uid() and u.is_operator));

-- NO insert/update/delete policy, on purpose: the engine writes through the
-- service role (RLS-exempt), and a browser session has no write path here — the
-- durability contract's "browsers write through functions or not at all", with
-- the narrowest possible surface because there is no function either.

-- Revoke the write privileges BY NAME, the shape 0010/0013 use for their
-- browser-read-only tables. Supabase grants insert/update/delete to
-- anon/authenticated by default, and RLS alone would let a browser UPDATE/DELETE
-- silently affect zero rows rather than refuse — a named revoke makes the refusal
-- a deterministic privilege error. SELECT stays (the read policy above narrows
-- it); service_role keeps everything (it bypasses RLS) and is the engine's path.
revoke insert, update, delete on public.bot_runs from public, anon, authenticated;
