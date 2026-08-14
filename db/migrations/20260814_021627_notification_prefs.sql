-- 20260814_021627_notification_prefs.sql
--
-- WHAT THIS CHANGES and WHY. Migrations are append-only: this file will run
-- exactly once against production and can never be edited afterwards.
--
-- RE-STAMPED from PR #181 (closed-deferred 2026-08-13, serial-migration rule).
-- The donor branch authored this as `20260804_192208_notification_prefs.sql`;
-- by the time the notifications lane resumed, main had applied `20260813_*`
-- migrations that sort after that stamp, and the append-only ledger applies in
-- filename order — so the disposition ordered a fresh `scripts/new-migration.sh`
-- stamp with the SQL carried over. Two things changed beyond the name, both to
-- meet the bar that landed while the branch was parked:
--
--   * idempotency is the post-0026 shape (`hq_command_replay` + `request_hash`,
--     the 20260813_025743 `app_add_job` pattern), not 0003's manual replay the
--     donor copied from 0025 — so a key reused with different arguments is
--     refused with 22023 instead of silently answering the first gesture's
--     result;
--   * both functions carry `comment on function` (the 20260813_055534 bar).
--
-- RM-12: the notification half of the Config tab gets a home. This is the first
-- of the three items `SHEET-INVENTORY.md` §"Three things land BEFORE the Config
-- tab is retired" gates; the other two (an SSM override for the two spend
-- budgets, and a decision on the `heartbeat_capture` tripwire) are not touched
-- here and are not made easier by this file.
--
-- The failure this prevents is silent. `20260803_105951_notification_outbox.sql`
-- added the quiet-hours queue and `core.channels.allow()` decides what goes into
-- it — from `notify_quiet_hours` and `notify_timezone`, two Config cells with
-- nowhere in Postgres to live. Retire the tab first and the engine keeps running
-- on committed defaults: quiet hours engages against a zone nobody chose, or the
-- user's push kill switch turns itself back on, and nothing anywhere goes red.
-- A build that breaks is cheap. This one would not have broken.
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE COUNT IS 13 AND THE COLUMN COUNT IS 10. Both numbers are load-bearing.
--
-- `SHEET-FACILITIES.md` §1.2(a2′) re-measured the group key by key, by opening
-- each reader rather than grepping each name. Ten are preferences with a live
-- reader and are below. Three are not:
--
--   `push_status_events`  RETIRED. `monitor/config.py:39` parses it onto
--                         `RuntimeConfig` and NOTHING reads the attribute — not
--                         in `core`, not in `monitor`, not in `tracker`. Its
--                         Config-tab help text (`tracker/bootstrap.py:90`) says
--                         it turns status pushes off. It does not. The switch
--                         that works is `notify_status_change = none`, enforced
--                         at `core.channels.allow`, the one choke point. A
--                         column here would make a broken switch look homed,
--                         which is worse than the Sheet — the Sheet never
--                         claimed to be authoritative.
--   `digest_hour_ct`      RETIRED. No reader anywhere. The digest hour is
--                         `infra/terraform/variables.tf:92`,
--                         `cron(40 11 * * ? *)` on EventBridge.
--   `dna_companies`       NOT A NOTIFICATION PREFERENCE. It is the scout's
--                         do-not-apply guard (`tracker/scout.py:86`, a live
--                         reader on the 2-hourly chain) and its home is the
--                         search-profile half, `profiles.criteria` — which
--                         needs a `parseCriteria` whitelist entry and no
--                         migration at all. §1.2(a1) is now 13 keys, not 12,
--                         and the Config-tab gate is satisfied when THAT packet
--                         lands. Recorded so this file cannot be read as having
--                         homed it.
--
-- Carrying dead configuration into the new schema is how the Sheet's mess
-- outlives the Sheet.
--
-- ══════════════════════════════════════════════════════════════════════════
-- WHY COLUMNS ON `profiles`, AND NOT A SECOND PREFERENCES TABLE
--
-- `0025_display_prefs.sql` fought this exact argument and its header names the
-- cost: display preferences lived in three stores and none of them was the
-- person, `globals.css` grew a 30-line comment plus a CSS block to stop two of
-- them compounding, and 15 of 19 comp cells were clipped by the collision. A
-- second preferences mechanism, one table over, is that fork arriving again. One
-- person has one preferences row.
--
-- 0025 also asked the jsonb-versus-columns question and answered it for its own
-- five values. The answer here is the same and the REASONS are different, so it
-- is re-derived rather than cited:
--
--   * 0025 chose columns because nothing validated its values on read — CSS
--     ignores an attribute it has no rule for, so `density: "cozy"` would render
--     as dense forever with no error. Here the engine DOES validate on read
--     (`core/config.py:156 VALIDATORS`), which is 0001's stated reason for
--     `criteria` being jsonb. That argument genuinely points the other way.
--   * It loses anyway, on `notify_timezone` and the quiet window. Read-time
--     validation means the bad value is already stored and the engine copes:
--     `core/channels.py:_zone` falls back to America/Chicago and prints, and
--     `quiet_window` treats an unreadable spec as NO quiet hours. Both are the
--     right behaviour for a bot that must not die of a preference — and both
--     mean a browser can persist a value the user will never be told was
--     rejected. A CHECK constraint is the door that shuts at WRITE time, where
--     the person is still standing there to be told.
--
-- So: typed columns with CHECK constraints, on `profiles`, keyed by the Config
-- tab's own key names.
--
-- WHY THE COLUMN NAMES ARE THE CONFIG KEY NAMES. `core/profile.py:133` keeps one
-- spelling across three layers on purpose — "same key name on both sides, so the
-- Config tab, profile.yaml and the committed defaults all spell it identically".
-- A fourth spelling here would need a translation layer, which is 0025's own
-- argument for `display_` staying on its jsonb keys. The one deliberate
-- divergence is the quiet window, below.
--
-- WHY `profiles.notify` IS NOT THE HOME. It is `jsonb not null default '{}'`
-- from `0001_init.sql:65`, carried opaquely by `app_commit_profile`, and in five
-- years of this schema no writer has ever put one of these keys in it. A prose
-- comment reserving a column is not a home; that mistake is what made the
-- original "already homed" verdict look defensible. The column is left in place
-- (append-only; `app_commit_profile` still carries it) and its comment is
-- rewritten below to say so.
--
-- ══════════════════════════════════════════════════════════════════════════
-- SCOPE: THE STORE AND ITS WRITE PATH. NOT THE ENGINE READER.
--
-- Stated plainly because the omission is a decision. Teaching `UserConfig.load`
-- or `Profile.load` to read these columns TODAY would create a second read path
-- while the Sheet is still authoritative — a dual read, which
-- `SHEET-INVENTORY.md` §4 lists as exactly what the cutover criteria forbid and
-- §6 orders against. The reader lands in the commit that flips the authority,
-- with the Sheet reader coming out in the same change. There is no UI here
-- either: the Preferences surface is the owner's design to draw, and 0025 landed
-- its store before its popover for the same reason.
--
-- What that means for anyone reading this file in a hurry: after it runs, these
-- columns exist, a signed-in browser can write them through one RPC, and NOTHING
-- READS THEM YET. That is not the Config tab retired.
--
-- THIS FILE IS ALSO TYPESCRIPT INPUT. webapp/tests/unit/types-contract.test.ts
-- parses these `alter table … add column` statements. `profiles` is not a
-- contracted table (no browser surface reads it through PostgREST), so no
-- webapp/lib/types.ts edit rides this commit — but the parser throws on an SQL
-- type it has no mapping for, and `time` was not in its map, so the `time:
-- "string"` SQL_KIND entry lands in the same commit as this file.

-- ============================================================ the columns

alter table public.profiles
  -- The per-event matrix. `core/channels.py:56 EVENTS` is the closed set of five
  -- and `CHANNELS` the closed set of four; `tests/core/test_channels.py` pins
  -- both so they cannot drift from `core/config.py:192`.
  --
  -- `''` IS A FIFTH LEGAL VALUE AND IT IS NOT A BLANK. `core/profile.py:62`
  -- declares these five as `""` and `core/channels.py:74 _SEED` resolves an
  -- un-itemized event from the coarse ceiling (`notify_channel`). Refusing `''`
  -- would delete the inherit state and force every row to restate a decision the
  -- user never made.
  --
  -- The DEFAULTS are today's rendering, exactly — `core/config_defaults.yaml:47`
  -- through `:51`, copied as literals on 2026-08-04 and re-checked against main
  -- on 2026-08-14. Not `''`: with a `ntfy` ceiling, inherit resolves to `push`
  -- for all five, which would start pushing stale nudges (committed default
  -- `none`) and stop mailing the digest (committed default `both`). A default
  -- that changes behaviour is not a default.
  add column if not exists notify_digest        text not null default 'both',
  add column if not exists notify_new_roles     text not null default 'push',
  add column if not exists notify_status_change text not null default 'push',
  add column if not exists notify_oa_interview  text not null default 'push',
  add column if not exists notify_stale_nudge   text not null default 'none',

  -- THE QUIET WINDOW, AS TWO `time` COLUMNS. The one place this file does not
  -- keep the Config key's name, and the reason is that `notify_quiet_hours` is a
  -- STRING THAT MUST BE PARSED: `"21:00-06:30"`, read by
  -- `core/channels.py:_hhmm` via `split(":")`. A text column would move that
  -- parser to read time, where `"9pm-6am"` is stored happily and
  -- `quiet_window()` answers None — no quiet hours, silently, for as long as
  -- nobody looks. `time` is the type Postgres already has for this; `25:00` and
  -- `07:61` are refused by the input function before any constraint runs.
  --
  -- NULL/NULL IS `off`. `core/channels.py:79 _QUIET_OFF` spells it four ways
  -- (`''`, `off`, `none`, `-`); one absent window has one representation here.
  -- Defaults 21:00 / 06:30 are `core/config_defaults.yaml:56`.
  --
  -- CROSSING MIDNIGHT IS NORMAL AND IS THE READER'S JOB, not a constraint's:
  -- `wake_time()` computes `wraps = start > end` and the default window IS a
  -- wrapping one. A CHECK requiring start < end would refuse the value the
  -- product ships with.
  --
  -- NULLABLE WITH A NON-NULL DEFAULT, and the combination is the point: a new
  -- row ships with the window the product ships with, and `off` remains
  -- expressible. Written without the defaults first, and
  -- `test_the_defaults_are_the_committed_defaults_the_engine_runs_today` went
  -- red naming the one key that differed — a new account would have had quiet
  -- hours OFF, which is the exact class of silent behaviour change this whole
  -- migration exists to prevent, arriving inside it.
  add column if not exists notify_quiet_start time default '21:00',
  add column if not exists notify_quiet_end   time default '06:30',

  -- An IANA zone NAME, never an offset. `core/channels.py:wake_time` resolves
  -- the wake instant on the user's local CALENDAR DAY with `zoneinfo`, and its
  -- header says why: "06:30 wall clock tomorrow" is 7h30m away on most nights
  -- and 8h30m the night the clocks go back. An offset stored as a number is
  -- wrong twice a year, in the direction that wakes somebody at 05:30.
  -- Membership in the tz database is checked by the RPC below against
  -- `pg_timezone_names`; the constraint here is a bound, because that view is
  -- not immutable and cannot appear in a CHECK.
  add column if not exists notify_timezone text not null default 'America/Chicago',

  -- The call-site kill switch, distinct from `notify_new_roles` and not
  -- redundant with it: `monitor/run.py:321` and `monitor/wide.py:681` consult
  -- this BEFORE composing a push, where the policy consults the matrix after.
  -- Both readers are live.
  add column if not exists push_new_jobs boolean not null default true,

  -- `monitor/config.py:37` → `monitor/run.py:338`, `monitor/wide.py:680`,
  -- `tracker/digest.py:142`. Range is `core/config.py:157 _int(0, 30)`; default
  -- 3 is `core/config_defaults.yaml:4`.
  add column if not exists yoe_push_max integer not null default 3,

  -- `tracker/stale.py:30`. Range `core/config.py:182 _int(3, 365)`, default 30
  -- from `core/config_defaults.yaml:33`.
  --
  -- NOT `monitor/run.py:36 STALE_DAYS`, which is a hardcoded 14 meaning "board
  -- days-missing before a role is Closed". Two different questions wearing one
  -- word; only the tracker's is a user preference, and only it is here.
  add column if not exists stale_days integer not null default 30,

  -- This lane's OWN concurrency token, for 0025's reason verbatim: `updated_at`
  -- is the Search Profile form's token, and a preference autosave that moved it
  -- would make an open profile form raise a phantom conflict over a gesture that
  -- touched nothing it edits. The trigger below is what keeps the two apart.
  add column if not exists notify_updated_at timestamptz not null default now();

do $$
begin
  -- Idempotent the way 0007/0008/0025 do it: drop then add, so re-running the
  -- whole directory (db/apply.sh does, on every provisioning run) is not an
  -- error.
  alter table public.profiles drop constraint if exists profiles_notify_digest_is_known;
  alter table public.profiles drop constraint if exists profiles_notify_new_roles_is_known;
  alter table public.profiles drop constraint if exists profiles_notify_status_change_is_known;
  alter table public.profiles drop constraint if exists profiles_notify_oa_interview_is_known;
  alter table public.profiles drop constraint if exists profiles_notify_stale_nudge_is_known;
  alter table public.profiles drop constraint if exists profiles_quiet_hours_are_whole;
  alter table public.profiles drop constraint if exists profiles_quiet_window_is_not_empty;
  alter table public.profiles drop constraint if exists profiles_notify_timezone_is_bounded;
  alter table public.profiles drop constraint if exists profiles_yoe_push_max_in_range;
  alter table public.profiles drop constraint if exists profiles_stale_days_in_range;
end $$;

alter table public.profiles
  add constraint profiles_notify_digest_is_known
    check (notify_digest in ('push', 'email', 'both', 'none', '')),
  add constraint profiles_notify_new_roles_is_known
    check (notify_new_roles in ('push', 'email', 'both', 'none', '')),
  add constraint profiles_notify_status_change_is_known
    check (notify_status_change in ('push', 'email', 'both', 'none', '')),
  add constraint profiles_notify_oa_interview_is_known
    check (notify_oa_interview in ('push', 'email', 'both', 'none', '')),
  add constraint profiles_notify_stale_nudge_is_known
    check (notify_stale_nudge in ('push', 'email', 'both', 'none', '')),

  -- A window is BOTH ends or NEITHER. One end alone is the state no reader has a
  -- branch for: `quiet_window` would see a malformed spec, answer None, and
  -- quiet hours would be off while the settings page showed a start time.
  add constraint profiles_quiet_hours_are_whole
    check ((notify_quiet_start is null) = (notify_quiet_end is null)),

  -- `core/channels.py:139`: "zero-length window = off, not all day". If equal
  -- ends were storable, `off` would have two spellings and the second one would
  -- render in the UI as a real window that never engages. Written as a
  -- disjunction, not `is distinct from`, because with both ends null the
  -- distinct form is FALSE and would refuse the off state itself.
  add constraint profiles_quiet_window_is_not_empty
    check (notify_quiet_start is null or notify_quiet_start <> notify_quiet_end),

  -- A bound, not a vocabulary — the vocabulary is the tz database and it lives
  -- in `pg_timezone_names`, which the RPC checks. Non-empty matters on its own:
  -- `ZoneInfo("")` raises, and `_zone()` would fall back to America/Chicago
  -- while the row said the user had chosen something.
  add constraint profiles_notify_timezone_is_bounded
    check (length(notify_timezone) between 1 and 64),

  -- The engine's own ranges (`core/config.py:157`, `:182`), restated at the
  -- store. The RPC checks them too and names the value; this is the door that
  -- stays shut if a later writer forgets.
  add constraint profiles_yoe_push_max_in_range
    check (yoe_push_max between 0 and 30),
  add constraint profiles_stale_days_in_range
    check (stale_days between 3 and 365);

comment on column public.profiles.notify_timezone is
  'IANA zone name (e.g. America/Chicago), never a UTC offset: core.channels '
  'resolves the quiet-hours wake instant on this zone''s calendar day, which an '
  'offset gets wrong on the two nights the clocks move.';

comment on column public.profiles.notify_quiet_start is
  'Local wall-clock start of the quiet window, or NULL with notify_quiet_end for '
  '"no quiet hours". A window whose start is later than its end crosses midnight '
  '— that is the shipped default, not an error.';

-- Rewritten rather than left standing. The old text (digest email, ntfy topic,
-- push preferences, "carried opaquely") reads as a reservation, and a
-- reservation that no writer ever honoured is what made an earlier review
-- conclude these preferences were already homed.
comment on column public.profiles.notify is
  'SUPERSEDED and unread. The notification preferences live in the typed '
  'notify_* columns as of 20260814_021627; this jsonb has never been written '
  'with any of them. app_commit_profile still carries it opaquely so an old '
  'value cannot be blanked. Do not add a key here.';

-- ============================================================ the touch trigger

/*
 * 0025 taught `profiles_touch` to skip a display-only write. It has to skip a
 * notification-only write for exactly the same reason, and the WHEN clause is
 * REPLACED rather than added to — a second trigger with the other half of the
 * predicate would fire on every write the first one skipped, which is the bug
 * with extra steps.
 *
 * The clause stays written as "the preference tuples did NOT change", never as
 * "some other column DID". That is what makes it non-regressive: every writer
 * that exists today leaves all of these columns alone, so the predicate is true
 * for all of them and `updated_at` behaves exactly as it did before — including
 * for a save that rewrites `criteria` to the same value, which several tests
 * depend on moving the token.
 *
 * `notify_updated_at` is deliberately absent from the tuple. It is a token, not
 * a preference; including it would make the clause self-referential (the RPC
 * moves it in the same UPDATE that moves the values) and would be a second way
 * to express the same fact.
 */
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row
  when (
    (old.display_density, old.display_type_scale, old.display_keyboard_hints,
     old.display_landing_view, old.display_theme)
    is not distinct from
    (new.display_density, new.display_type_scale, new.display_keyboard_hints,
     new.display_landing_view, new.display_theme)
    and
    (old.notify_digest, old.notify_new_roles, old.notify_status_change,
     old.notify_oa_interview, old.notify_stale_nudge, old.notify_quiet_start,
     old.notify_quiet_end, old.notify_timezone, old.push_new_jobs,
     old.yoe_push_max, old.stale_days)
    is not distinct from
    (new.notify_digest, new.notify_new_roles, new.notify_status_change,
     new.notify_oa_interview, new.notify_stale_nudge, new.notify_quiet_start,
     new.notify_quiet_end, new.notify_timezone, new.push_new_jobs,
     new.yoe_push_max, new.stale_days)
  )
  execute function public.touch_updated_at();

-- ============================================================ the row shape

/**
 * One profiles row's NOTIFICATION half, as the write path and any later replay
 * of it both answer.
 *
 * Extracted for `app_display_prefs_row`'s reason, which is 0010's reason: two
 * paths return this object — a write, and an idempotent replay of that write —
 * and a replay that answers a differently-shaped object than the original is the
 * kind of difference nothing catches until a surface renders blanks.
 *
 * The quiet window is rendered as `notify_quiet_hours`, the Config tab's own
 * `HH:MM-HH:MM` spelling, with `''` for off — `core/channels.py:quiet_window`
 * parses exactly this and `_QUIET_OFF` contains `''`. The COLUMNS are two typed
 * times because that is what a store should refuse bad values with; the WIRE is
 * the string every reader in the repo already knows. `to_char` rather than a
 * cast: `time`'s default text output is `21:00:00`, and a seconds field on a
 * value the parser splits on `:` is a third component nobody wants to explain.
 *
 * Deliberately NOT security definer. It is only ever called from inside
 * `app_set_notification_prefs`, which is the definer and already holds the
 * rights; marking this one definer would hand a standalone caller a read of
 * anybody's preferences.
 */
create or replace function public.app_notification_prefs_row(pr public.profiles)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'notify_digest',        pr.notify_digest,
           'notify_new_roles',     pr.notify_new_roles,
           'notify_status_change', pr.notify_status_change,
           'notify_oa_interview',  pr.notify_oa_interview,
           'notify_stale_nudge',   pr.notify_stale_nudge,
           'notify_quiet_hours',
             case when pr.notify_quiet_start is null then ''
                  else to_char(pr.notify_quiet_start, 'HH24:MI') || '-'
                       || to_char(pr.notify_quiet_end, 'HH24:MI')
             end,
           'notify_timezone',      pr.notify_timezone,
           'push_new_jobs',        pr.push_new_jobs,
           'yoe_push_max',         pr.yoe_push_max,
           'stale_days',           pr.stale_days,
           'notify_updated_at',    pr.notify_updated_at
         );
$$;

comment on function public.app_notification_prefs_row(public.profiles) is
  'one profiles row''s notification half as the wire answers it: the quiet '
  'window rendered HH:MM-HH:MM ('''' for off) — the spelling core.channels '
  'parses. Not security definer; only app_set_notification_prefs calls it.';

revoke all on function public.app_notification_prefs_row(public.profiles)
  from public, anon, authenticated;

-- ============================================================ the write

/**
 * Save one or more notification preferences. The browser's only door to these
 * columns; `0001`'s "browsers write through functions or not at all" is the rule
 * and there is deliberately no write policy on `profiles`.
 *
 * EVERY VALUE PARAMETER IS NULLABLE AND NULL MEANS "LEAVE IT", for 0025's
 * reason: a call that had to restate all ten would replay whatever the tab last
 * READ into the other nine, so changing the timezone on a phone would quietly
 * revert a quiet-hours edit the laptop made thirty seconds earlier.
 *
 * WHICH IS WHY TURNING QUIET HOURS OFF NEEDS ITS OWN PARAMETER. `off` is
 * `notify_quiet_start = null`, and null already means "leave it" — so `p_quiet_off`
 * carries the intent that the two value parameters cannot express. Without it,
 * the one preference a person is most likely to want back (stop holding my
 * notifications) would be the one the API cannot say. Passing `p_quiet_off` true
 * together with a start or end is refused rather than silently ordered.
 *
 * A WRITE THAT CHANGES NOTHING WRITES NOTHING: no row update, no bumped token,
 * no event. Preferences autosave, autosave fires on gestures that are frequently
 * no-ops, and a token that stays still across them is what stops a tab
 * invalidating its own token.
 *
 * The token compared is `notify_updated_at`, never `updated_at`. The two lanes
 * are independent on purpose: a preference change must not make a half-finished
 * Search Profile edit un-saveable, and vice versa.
 *
 * IDEMPOTENCY is the post-0026 shape (`hq_command_replay` + `request_hash`,
 * the `app_add_job` pattern): a genuine replay returns the first result, and a
 * key reused with a different command or different arguments is refused with
 * 22023. `p_expected_updated_at` is deliberately NOT in the fingerprint — that
 * is concurrency control rather than payload, and folding it in would refuse an
 * honest retry whose only difference is a token the client re-read in between
 * (0026's stated reason).
 */
create or replace function public.app_set_notification_prefs(
  p_digest              text,
  p_new_roles           text,
  p_status_change       text,
  p_oa_interview        text,
  p_stale_nudge         text,
  p_quiet_start         time,
  p_quiet_end           time,
  p_quiet_off           boolean,
  p_timezone            text,
  p_push_new_jobs       boolean,
  p_yoe_push_max        integer,
  p_stale_days          integer,
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
  v_row    public.profiles;
  v_before jsonb;
  v_result jsonb;
  v_wrote  boolean := false;
  v_ch     text;
  v_start  time;
  v_end    time;
  -- The payload fingerprint this key is scoped to; `hq_command_replay` refuses
  -- a second use of the key with a different one (22023). All twelve value
  -- parameters and the off-intent, in declaration order; never
  -- `p_expected_updated_at` (concurrency control, not payload) and never
  -- `p_idem` (the key is what the fingerprint is scoped to, not part of it).
  v_fp     text;
begin
  -- Unreachable through the app and kept anyway, for 0012's stated reason:
  -- `authenticated` is the only role granted execute, so `auth.uid()` is
  -- non-null for every caller that can get this far. The day a service-role path
  -- or a new grant appears, this is the line that refuses to write a row with a
  -- null `user_id`. It is also the line `tests/db/test_default_deny.py` requires
  -- of every browser-reachable definer, because `hq_entitlement_guard`'s engine
  -- escape hatch IS `auth.uid() is null`.
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- `hq_blank_trim`, not `length(p_idem) = 0` — 0012's tighter door. A key of one
  -- NEWLINE reads as content to `btrim()` and as blank to a person, and one
  -- caller sending a blank key would have every LATER blank key replay the first
  -- gesture's result forever.
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Validated HERE as well as by the CHECK constraints, and the duplication is
  -- the point: a CHECK violation is errcode 23514 with a constraint name in it,
  -- which the client classifies as a generic "Couldn't save that". These raise
  -- 22023 naming the knob and the value, so the person is told which setting was
  -- refused. The constraints remain the door that stays shut if a later writer
  -- forgets this one.
  foreach v_ch in array array[p_digest, p_new_roles, p_status_change,
                              p_oa_interview, p_stale_nudge] loop
    if v_ch is not null and v_ch not in ('push', 'email', 'both', 'none', '') then
      raise exception 'unknown notification channel: %', v_ch using errcode = '22023';
    end if;
  end loop;

  -- The tz database is the vocabulary, and this is the only place it can be
  -- consulted: `pg_timezone_names` is not immutable, so a CHECK cannot call it.
  -- Refusing here rather than storing and coping later is the whole reason these
  -- are columns — `core/channels.py:_zone` would accept the bad value, fall back
  -- to America/Chicago, print to stderr nobody reads, and hold somebody's
  -- interview notification until the wrong morning.
  if p_timezone is not null
     and not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'unknown timezone: %', p_timezone using errcode = '22023';
  end if;

  if p_quiet_off and (p_quiet_start is not null or p_quiet_end is not null) then
    raise exception 'quiet hours cannot be both off and set' using errcode = '22023';
  end if;
  -- One end alone is an intent nobody can act on. Refused rather than completed
  -- from the stored row: guessing the missing end would silently move a window
  -- the user did not touch.
  if not coalesce(p_quiet_off, false)
     and ((p_quiet_start is null) <> (p_quiet_end is null)) then
    raise exception 'quiet hours need both a start and an end' using errcode = '22023';
  end if;
  if p_quiet_start is not null and p_quiet_start = p_quiet_end then
    raise exception 'quiet hours of zero length are off, not all day'
      using errcode = '22023';
  end if;

  if p_yoe_push_max is not null and (p_yoe_push_max < 0 or p_yoe_push_max > 30) then
    raise exception 'yoe_push_max out of range: %', p_yoe_push_max using errcode = '22023';
  end if;
  if p_stale_days is not null and (p_stale_days < 3 or p_stale_days > 365) then
    raise exception 'stale_days out of range: %', p_stale_days using errcode = '22023';
  end if;

  v_fp := public.hq_command_fingerprint(
            jsonb_build_array(p_digest, p_new_roles, p_status_change,
                              p_oa_interview, p_stale_nudge,
                              p_quiet_start, p_quiet_end,
                              coalesce(p_quiet_off, false),
                              p_timezone, p_push_new_jobs,
                              p_yoe_push_max, p_stale_days));

  -- Replay: return the first result rather than applying twice. Raises 22023
  -- when this key was first used by another command or with other arguments.
  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_set_notification_prefs', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- No row is created at signup (`handle_new_auth_user` writes `users` only) and
  -- a person can legitimately set quiet hours before finishing the wizard. So
  -- materialise the row with the never-onboarded `'{}'` criteria sentinel, which
  -- is what `app_commit_profile` and `app_set_display_prefs` both do. `do
  -- nothing` rather than an existence check: two first-time gestures racing must
  -- not both insert.
  insert into public.profiles (user_id, criteria, notify)
  values (v_user, '{}'::jsonb, '{}'::jsonb)
  on conflict (user_id) do nothing;

  select * into v_row from public.profiles where user_id = v_user for update;

  -- Re-check the key with the row LOCKED. The check above only settles
  -- sequential replays; two tabs flushing one queue on the same 'online' event
  -- both pass it before either writes.
  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_set_notification_prefs', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- Optimistic concurrency, checked INSIDE the transaction that writes. The
  -- parameter is DECLARED `timestamptz`, so both sides are instants before this
  -- line runs; the casts read as intent at the comparison site and are not the
  -- mechanism. Comparing two RENDERINGS of one moment as text is matrix rows 146
  -- and 168.
  --
  -- The word "conflict" is load-bearing: the client matches on it.
  if p_expected_updated_at is not null
     and v_row.notify_updated_at::timestamptz is distinct from p_expected_updated_at::timestamptz then
    raise exception 'conflict: your notification preferences changed since you read them'
      using errcode = '40001';
  end if;

  -- Resolve the window once, so the UPDATE below reads as data rather than as
  -- three-way logic repeated twice.
  if coalesce(p_quiet_off, false) then
    v_start := null;
    v_end   := null;
  else
    v_start := coalesce(p_quiet_start, v_row.notify_quiet_start);
    v_end   := coalesce(p_quiet_end,   v_row.notify_quiet_end);
  end if;

  v_before := public.app_notification_prefs_row(v_row);

  update public.profiles
     set notify_digest        = coalesce(p_digest, notify_digest),
         notify_new_roles     = coalesce(p_new_roles, notify_new_roles),
         notify_status_change = coalesce(p_status_change, notify_status_change),
         notify_oa_interview  = coalesce(p_oa_interview, notify_oa_interview),
         notify_stale_nudge   = coalesce(p_stale_nudge, notify_stale_nudge),
         notify_quiet_start   = v_start,
         notify_quiet_end     = v_end,
         notify_timezone      = coalesce(p_timezone, notify_timezone),
         push_new_jobs        = coalesce(p_push_new_jobs, push_new_jobs),
         yoe_push_max         = coalesce(p_yoe_push_max, yoe_push_max),
         stale_days           = coalesce(p_stale_days, stale_days),
         notify_updated_at    = now()
   where user_id = v_user
     -- The no-op guard. Everything below it — the token bump and the event —
     -- happens only when a value really moved.
     and (notify_digest, notify_new_roles, notify_status_change,
          notify_oa_interview, notify_stale_nudge, notify_quiet_start,
          notify_quiet_end, notify_timezone, push_new_jobs, yoe_push_max,
          stale_days)
         is distinct from
         (coalesce(p_digest, notify_digest),
          coalesce(p_new_roles, notify_new_roles),
          coalesce(p_status_change, notify_status_change),
          coalesce(p_oa_interview, notify_oa_interview),
          coalesce(p_stale_nudge, notify_stale_nudge),
          v_start, v_end,
          coalesce(p_timezone, notify_timezone),
          coalesce(p_push_new_jobs, push_new_jobs),
          coalesce(p_yoe_push_max, yoe_push_max),
          coalesce(p_stale_days, stale_days))
  returning * into v_row;

  v_wrote := found;

  if not v_wrote then
    -- Nothing moved. Re-read rather than reusing the locked snapshot, so the
    -- answer is the row as it stands and not the row as it was before a
    -- concurrent writer we have already released.
    select * into v_row from public.profiles where user_id = v_user;
  else
    -- ONE event for the change, the row and its audit entry in the same function
    -- body. Bounded by the no-op guard: an autosave storm of identical values
    -- appends nothing.
    --
    -- The payload carries preference SETTINGS — a zone, a window, four channel
    -- words. It carries no notification text, no topic, no address: `events` is
    -- readable by the owner's browser session, and a topic in an audit row is a
    -- credential in an audit row.
    insert into public.events (user_id, kind, payload, actor)
    values (v_user, 'profile.notification_changed',
            jsonb_build_object(
              'before', v_before,
              'after',  public.app_notification_prefs_row(v_row)),
            'user');
  end if;

  v_result := jsonb_build_object(
                'notify',  public.app_notification_prefs_row(v_row),
                'changed', v_wrote);

  insert into public.command_idempotency (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_set_notification_prefs', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function
  public.app_set_notification_prefs(text, text, text, text, text, time, time,
                                    boolean, text, boolean, integer, integer,
                                    text, timestamptz) is
  'save one or more notification preferences for the calling user — null means '
  'leave it, p_quiet_off carries the off intent null cannot, a no-op writes '
  'nothing, CAS on notify_updated_at (never updated_at), idempotent on p_idem '
  'via hq_command_replay + request_hash, one audit event per real change';

-- Named revokes, not `from public` alone: Supabase's bootstrap grants execute
-- on new functions to `anon` and `authenticated` BY NAME, and revoking from
-- `public` does not touch a grant made to a named role (0026's lesson; the
-- KNOWN_UNNAMED_REVOKES debt list in tests/core/test_migrations.py is exactly
-- the set of older functions that got this wrong).
revoke all on function
  public.app_set_notification_prefs(text, text, text, text, text, time, time,
                                    boolean, text, boolean, integer, integer,
                                    text, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.app_set_notification_prefs(text, text, text, text, text, time, time,
                                    boolean, text, boolean, integer, integer,
                                    text, timestamptz)
  to authenticated;

-- ============================================================ RLS and the gate

-- NO NEW POLICY, NO NEW TRIGGER, AND THAT IS A DECISION RATHER THAN A GAP.
--
-- `20260803_105951_notification_outbox.sql` had to register its table with the
-- entitlement layer by hand, because a table created after `0027_entitlement.sql`
-- inherits NOTHING — not the restrictive policy, not `hq_entitlement_guard`. The
-- twin migration was rejected once for missing exactly that, and
-- `20260813_055534_email_sends.sql` attached its own pair for the same reason.
--
-- This file adds no table. `profiles` is named in 0027's `gated` array
-- (`0027_entitlement.sql:741`), so it already carries `profiles_entitled` (as
-- restrictive for all, `using`/`with check` on `hq_is_entitled()`) and the
-- `profiles_entitlement_guard` row trigger, and it already has exactly one
-- permissive policy — `profiles_self_read … using (user_id = auth.uid())` — with
-- no write policy at all. New COLUMNS inherit every one of those, which is the
-- substantive advantage of putting these on `profiles` rather than in a new
-- table: there is no registration step to forget.
--
-- "Inherits" is a claim about Postgres, not evidence about this schema, so
-- `tests/db/test_notification_prefs.py` proves each half from a real session
-- rather than taking it on trust: a second user cannot read or write these
-- columns, `anon` cannot, and a suspended, pending or removed account is refused
-- by the gate — with the entitled positive control in the same test, because a
-- deny that would deny everything proves nothing.
--
-- Two catalog subtleties that test has to respect, both of which have produced a
-- clean-looking wrong answer in this repo before:
--   * `exists(pg_trigger)` is TRUE for a DISABLED trigger. The assertion is on
--     `tgenabled`.
--   * `has_table_privilege(..., 'select')` is TRUE when ANY column is readable,
--     so a column-level grant on one new column would read clean and leak. The
--     assertion is per-column, via `has_column_privilege`.
