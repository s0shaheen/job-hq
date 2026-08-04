-- 20260803_105951_notification_outbox.sql
--
-- WHAT THIS CHANGES and WHY. Migrations are append-only: this file will run
-- exactly once against production and can never be edited afterwards.
--
-- RM-12: the quiet-hours outbox, off the Google Sheet. `core/outbox.py:1` states
-- what it is for — "suppressed is not dropped". A push held at 22:00 has to go
-- SOMEWHERE, or quiet hours is a nicer name for losing notifications, and a
-- dropped notification is indistinguishable from a broken system.
--
-- Of the four facilities in `docs/plans/SHEET-FACILITIES.md` this is the one
-- with real durable state and a real reader. `core.channels.allow()` returns a
-- wake time, `core.notify.push()` writes a row here instead of sending, and
-- `tracker.outbox` delivers whatever is due on the 2-hourly tracker chain.
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE THING THIS TABLE IS PROTECTING, stated once so nobody softens it later.
--
-- `monitor/run.py` stamps `pushed_at` on a role the moment its push is durably
-- QUEUED — not when it is sent (core/notify.py documents that trade). Nothing
-- ever un-stamps it. So a queue write that fails QUIETLY does not lose a
-- notification; it loses the ROLE. The user is never told, and the system's own
-- records say they were.
--
-- That is why `core/outbox.py:88` raises on a write failure and why
-- `core/notify.py:168` turns a refusing sink into an ops page, and it is the
-- opposite of the correct answer for `HQ.log` and `core/runlog.py`, which
-- swallow because a missing audit line is recoverable and a job killed by its
-- own telemetry is not. Two doctrines, both right, and this table is on the
-- raising side.
-- ══════════════════════════════════════════════════════════════════════════

-- ============================================================ the table

create table public.notification_outbox (
  id            bigint generated always as identity primary key,

  -- PER USER — and this column is NEW RISK, not a formality. `core/outbox.py:17`
  -- records that isolation used to be STRUCTURAL: each user's queue lived in
  -- their own spreadsheet, "so there is no user column to get wrong". One table
  -- for every tenant introduces exactly that column for the first time, which is
  -- why it is `not null` and why the open-row index below is scoped by it.
  --
  -- `on delete cascade`: a held push carries rendered notification text about a
  -- person's job search and must not outlive their account. Retention at the
  -- only boundary that can enforce it.
  user_id       uuid not null references public.users (id) on delete cascade,

  -- `core.outbox.record_key`: sha1 of (user, event, title, body, deliver_after),
  -- truncated to 16 hex chars. Content-addressed on purpose — two sweeps inside
  -- one quiet window that found the same roles produce the same push, and
  -- queueing it twice buzzes the phone twice at 06:30 for one piece of news.
  dedupe_key    text not null,

  event         text not null,               -- core.channels event name
  urgency       text not null default 'normal',
  channel       text not null default '',
  priority      text not null default 'default',
  tags          text not null default '',
  click         text not null default '',
  title         text not null default '',
  body          text not null default '',

  -- NULLABLE, and NULL means DUE NOW. `core/outbox.py:143`: a row whose wake
  -- time cannot be read is treated as due, because "between 'send it late' and
  -- 'never send it', late wins — that is the whole premise of the tab". A
  -- `not null` column would force a caller to invent a timestamp for a row that
  -- has no wake time, and the next caller to fail parsing it would face exactly
  -- the choice this type is removing.
  deliver_after timestamptz,

  created_at    timestamptz not null default now(),

  -- NULL = OPEN. The latch, exactly as the Sheet's blank `delivered_at` cell.
  -- "Delivered" here means CLOSED, not necessarily sent: `tracker/outbox.py`
  -- closes rows as sent, dropped, requeued and abandoned, and the outcome says
  -- which.
  delivered_at  timestamptz,

  attempts      integer not null default 0,
  outcome       text not null default '',

  -- A row is OPEN (no close time, no outcome) or CLOSED (both). The third
  -- combination — closed, outcome unknown — is the one no reader can act on and
  -- no writer produces, so the constraint costs nothing and makes the flush
  -- loop's state machine TOTAL rather than merely conventional. Same move as
  -- `bot_runs_outcome_matches_finish` (0023), for the same reason.
  --
  -- `tracker/outbox.py:30` is the stronger version of the rule this enforces:
  -- "every outcome string names what actually occurred. 'abandoned after 3
  -- failed sends' on a row where no send was attempted is worse than no outcome
  -- at all: it sends the operator looking for a network fault."
  constraint notification_outbox_closed_has_outcome
    check ((delivered_at is null) = (outcome = ''))
);

comment on table public.notification_outbox is
  'The quiet-hours queue: notifications held by policy, and the record of what '
  'became of each one. Written only by the engine through the service role; no '
  'browser session reads or writes it. A row is OPEN until delivered_at is set.';

comment on column public.notification_outbox.deliver_after is
  'When the notification may be sent, or NULL for "now". NULL is deliberate: '
  'the Sheet treated an unreadable wake time as due, because late beats never.';

-- ============================================================ the open-row latch

-- AT MOST ONE OPEN ROW PER (user, content). This index replaces
-- `core/outbox.py:62 _free_key` entirely, and the replacement is a
-- simplification rather than a translation.
--
-- `_free_key` suffixes `-2`, `-3` onto a key when a CLOSED row already holds it.
-- It exists for exactly one reason: `core.sheets.Tab.key_index` aborts the whole
-- tab on a duplicate key, so a closed row holding a key would break every later
-- read, write and flush of the Outbox. Postgres has no such constraint. The
-- invariant `_free_key` was approximating is expressible directly, and closed
-- history may then keep as many rows with one dedupe_key as it likes — which is
-- what `core/outbox.py:83` already says it wants: "A closed row is history; the
-- same news raised again is news again."
--
-- PARTIAL, on `delivered_at is null`. A total unique index would make a
-- delivered row swallow the next identical notification: `enqueue` would return
-- True — "durably queued" — for something never written down, which is the
-- silent drop this whole facility exists to prevent, wearing a success return
-- value.
--
-- SCOPED BY user_id, and that is the tenancy guarantee. On `dedupe_key` alone,
-- two users whose identical digest hashed the same would collapse into one row
-- and exactly one of them would silently receive nothing — the facility's own
-- failure mode, arriving through its deduplication mechanism. `record_key` does
-- include `user` in the hash (`core/outbox.py:57`, "two instances must never
-- collapse into one row"), so in practice the hashes differ; the index is scoped
-- anyway, because a tenancy guarantee resting on a hash input is one refactor
-- away from gone.
create unique index notification_outbox_open_idx
  on public.notification_outbox (user_id, dedupe_key)
  where delivered_at is null;

-- The flush read, every two hours: one user's open rows whose wake time has
-- passed. Partial for the same reason — closed rows are history and the flush
-- never looks at them, so they do not belong in the index the flush uses.
create index notification_outbox_due_idx
  on public.notification_outbox (user_id, deliver_after)
  where delivered_at is null;

-- ============================================================ RLS

alter table public.notification_outbox enable row level security;

-- NO BROWSER PATH AT ALL — read or write. This is stricter than `bot_runs` and
-- `monitor_sweep_state`, which keep `select`, and the difference is the content:
-- `title` and `body` are rendered notification text naming companies and roles,
-- which is private user content under CLAUDE.md's logging rule. There is no
-- design state for a held-notifications surface anywhere in the design system,
-- and inventing one is forbidden, so the browser gets nothing.
--
-- The owner-read policy is written anyway and then revoked out from under. That
-- looks redundant and is not: it is the shape a future `grant select` would need
-- to be correct ON ARRIVAL, and the test named
-- `test_the_entitlement_gate_is_armed_for_a_grant_this_table_does_not_have_yet`
-- grants it inside the test to prove the policy and the gate work together
-- before anything depends on them.
create policy notification_outbox_read on public.notification_outbox
  for select using (user_id = auth.uid());

revoke select, insert, update, delete on public.notification_outbox
  from public, anon, authenticated;

-- ============================================================ entitlement gate
--
-- A table created after 0027 inherits nothing (see the twin migration
-- 20260803_105950_engine_cursors.sql for the full note and the check that caught
-- it). With every privilege revoked, this table may fall outside
-- `tests/db/test_default_deny.py`'s browser-reachable set — so the gate here is
-- not what that sweep is asking for. It is here so a LATER migration granting
-- `select` for some future surface cannot un-gate the table by omission: a table
-- that BECOMES browser-reachable inherits nothing either.
create policy notification_outbox_entitled on public.notification_outbox
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

create trigger notification_outbox_entitlement_guard
  before insert or update or delete on public.notification_outbox
  for each row execute function public.hq_entitlement_guard();
