-- 0025 — display preferences become a PROPERTY OF THE PERSON, not of the browser
-- they happen to be sitting at (design doc 07 §4, prerequisite E5).
--
-- NUMBERING. This file is 0025 and 0021–0024 are holes on this branch (0020
-- landed on main as `0020_warm_referral.sql` and its reservation came out on the
-- rebase, which is the mechanism working rather than a courtesy). Five
-- parallel branches were cut from the same commit and each claimed a number up
-- front; the reservations are DECLARED in `tests/core/test_migrations.py`'s
-- `RESERVED_MIGRATION_NUMBERS` and asserted in both directions, so an
-- UNDECLARED gap still fails and the day one of them lands its reservation goes
-- red until the line is deleted. 0014 and 0017 opened with the same paragraph;
-- the mechanism worked, so it is used again rather than re-litigated.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY: THE C6 FORK, STATED AS THE TWO BUGS IT ACTUALLY IS
--
-- Today the five knobs a person turns to make this app readable live in three
-- different stores, and none of them is the person:
--
--   * type scale + density  → the `hq_display` COOKIE, read by an inline script
--     in `app/layout.tsx` before first paint. Per-browser. Sign in from the
--     phone and the app forgets that you need 16px type.
--   * type scale + density + keyboard hints → ALSO `saved_views.state` on
--     /jobs, per view. So the same person carries two answers to one question,
--     and `webapp/app/globals.css` has a 30-line comment plus a whole CSS block
--     (`data-type-scale-scope="own"`) standing between them to stop the two
--     scales COMPOUNDING — which they did, clipping 15 of 19 comp cells.
--   * theme → `localStorage`, which the server cannot read at all.
--
-- `docs/WEBAPP-BUILD.md` records this honestly as "two mechanisms across two
-- surfaces, which is exactly what C6 exists to collapse", and names P9 as the
-- phase that finishes it "when the values move to `profiles`". This is that.
--
-- What this file owns is the STORE. The Display popover that turns the knobs
-- lands with the Jobs surface build, from the owner's design; /jobs keeps its
-- per-view scale and its `data-type-scale-scope="own"` opt-out untouched until
-- then, because deleting a mechanism before its replacement's control exists is
-- how a surface ships with no way to reach a setting at all.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY COLUMNS AND NOT A `display` JSONB
--
-- `criteria` and `notify` are jsonb for a stated reason (0001): the engine's
-- `gates.GateConfig` owns their schema and validates on read, so a bad phone
-- edit can never poison a column type. Neither half of that applies here. These
-- five values have closed sets, no engine owns them, and NOTHING validates them
-- on read — the CSS simply ignores an attribute value it has no rule for, which
-- is silence rather than a fallback. A jsonb blob would make `density:
-- "cozy"` a legal row that renders as dense forever with no error anywhere.
--
-- So: typed columns with CHECK constraints, which is the fail-loud door. The
-- price is a migration per new knob, and that is the correct price for a set
-- that has grown by two values in a year.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY THERE IS NO NOTIFICATION COLUMN HERE
--
-- 06 §A lists "notification preferences" beside these five in the same
-- autosaved Preferences section. `profiles.notify` has held them since 0001
-- ("digest email, ntfy topic, push preferences") and `app_commit_profile`
-- already carries it opaquely so a profile save cannot blank it. A second store
-- for the same fact is the C6 fork arriving again on a different column, so
-- this file adds nothing for it and the popover writes `notify` through the
-- existing path.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE DEFAULTS ARE TODAY'S RENDERING, EXACTLY
--
-- dense / default / hints-on / no landing view / theme=system. Every one is
-- what an account with no cookie and no localStorage renders right now, which
-- is what lets this land without re-recording a single visual baseline.
--
-- `theme` defaults to `system` and NOT to the design's "light default", and the
-- deviation is deliberate rather than an oversight: `tests/e2e/theme.spec.ts`
-- pins "a dark OS preference is honoured on first paint" on five routes, and a
-- stored `light` default would silently overrule the operating system for every
-- existing account. The design's phrase describes which palette the popover
-- shows as the unstyled choice; it is not a decision to stop following the OS.
-- Flagged for the owner rather than decided here.

-- ============================================================ the columns

alter table public.profiles
  -- The repo's own vocabulary, not the design brief's. 01 §3 and 06 §A say
  -- "compact"/"normal"; `webapp/lib/grid/view-state.ts` has said
  -- `dense | comfortable` and `default | large` since P8, `globals.css` keys
  -- `:root[data-density="comfortable"]` off it, and four e2e specs assert the
  -- attribute values. Renaming the wire format to match prose would mean a
  -- translation layer between the column and the attribute, which is a place
  -- for the two to disagree. The dictionary owns the LABEL a person reads; this
  -- column owns the token the CSS matches.
  add column if not exists display_density text not null default 'dense',
  add column if not exists display_type_scale text not null default 'default',
  add column if not exists display_keyboard_hints boolean not null default true,
  -- '' is "wherever the app would send you anyway" — the anchored empty value,
  -- not null. Bounded text rather than a CHECK over a closed set on purpose:
  -- the redesign renames every surface (Today / Jobs / Applications / Autopilot
  -- / Coverage), so a CHECK here would make a cosmetic preference block a
  -- surface rename behind a migration. The TypeScript parser resolves an
  -- unknown value to the app default, the same way `parseViewState` already
  -- resolves an unknown density — a preference saved by a future version must
  -- still open in this one.
  add column if not exists display_landing_view text not null default '',
  add column if not exists display_theme text not null default 'system',
  -- The display lane's OWN optimistic-concurrency token. See the trigger below
  -- for why it cannot be `updated_at`.
  add column if not exists display_updated_at timestamptz not null default now();

do $$
begin
  -- Idempotent the way 0007/0008 do it: drop then add, so re-running the file
  -- against a database that already has the constraint is not an error.
  alter table public.profiles drop constraint if exists profiles_display_density_is_known;
  alter table public.profiles drop constraint if exists profiles_display_type_scale_is_known;
  alter table public.profiles drop constraint if exists profiles_display_theme_is_known;
  alter table public.profiles drop constraint if exists profiles_display_landing_view_is_bounded;
end $$;

alter table public.profiles
  add constraint profiles_display_density_is_known
    check (display_density in ('dense', 'comfortable')),
  add constraint profiles_display_type_scale_is_known
    check (display_type_scale in ('default', 'large')),
  add constraint profiles_display_theme_is_known
    check (display_theme in ('light', 'dark', 'system')),
  -- A bound, not a vocabulary. `authenticated` cannot reach this column except
  -- through the function below, which bounds it too; the constraint is the door
  -- that stays shut if a later writer forgets.
  add constraint profiles_display_landing_view_is_bounded
    check (length(display_landing_view) <= 64);

-- ============================================================ the touch trigger

/*
 * `profiles_touch` stops firing for a display-only write, and that is a BUG FIX
 * rather than a tidy-up.
 *
 * 0001 attaches `touch_updated_at()` to every update on `profiles`, so any
 * write moves `updated_at`. `updated_at` is also the Search Profile's
 * optimistic-concurrency token: `app_commit_profile` refuses a save whose
 * `p_expected_updated_at` no longer matches, `settings/page.tsx` renders it as
 * `data-profile-version`, and the form sends it back.
 *
 * Preferences AUTOSAVE (06 §A, and the reason the write below is built to be
 * cheap). So without this change, the sequence
 *
 *     open /settings  →  tick "Larger text"  →  press Save changes
 *
 * raises `conflict: this profile changed since you read it` over a gesture that
 * touched nothing the form edits. Guaranteed, on the one page that carries both
 * controls, and it would have shipped as "saving my profile randomly fails".
 *
 * The WHEN clause is written as "the display tuple did NOT change", not as "a
 * non-display column DID", and the difference is what makes it non-regressive:
 * every writer that exists today leaves the display columns alone, so the
 * predicate is true for all of them and `updated_at` behaves exactly as it did
 * before — including for a save that rewrites `criteria` to the same value,
 * which several tests depend on moving the token.
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
  )
  execute function public.touch_updated_at();

-- ============================================================ the row shape

/**
 * One profiles row's DISPLAY half, shaped for `toDisplayPrefsView`.
 *
 * Extracted for `app_profile_row`'s reason, which is the same reason here: two
 * paths return it (a write, and a replay of one), and a replay that answers a
 * differently-shaped object than the original write is the kind of difference
 * nothing catches until the UI renders blanks.
 *
 * Deliberately NOT security definer — it is only ever called from inside
 * `app_set_display_prefs`, which already runs as the definer and so inherits
 * the rights it needs. Marking it definer would hand a standalone caller a read
 * of anybody's preferences.
 *
 * THE KEYS ARE THE COLUMN NAMES, `display_` prefix and all, which reads
 * redundant inside an object already called "display" and is deliberate:
 * `toDisplayPrefsView` in `supabase-source.ts` then serves BOTH the plain
 * select and this jsonb with one mapper. A shortened key here would need a
 * second mapper for the write path, and two mappers for one row is how a replay
 * ends up answering a differently-shaped object than the original write did —
 * which `app_profile_row`'s header calls out as the difference nothing catches
 * until the UI renders blanks. Same call 0010's row builder made.
 */
create or replace function public.app_display_prefs_row(pr public.profiles)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'display_density',        pr.display_density,
           'display_type_scale',     pr.display_type_scale,
           'display_keyboard_hints', pr.display_keyboard_hints,
           'display_landing_view',   pr.display_landing_view,
           'display_theme',          pr.display_theme,
           'display_updated_at',     pr.display_updated_at
         );
$$;

revoke all on function public.app_display_prefs_row(public.profiles) from public;

-- ============================================================ the write

/**
 * Save one or more display preferences. Autosave's write path.
 *
 * EVERY VALUE PARAMETER IS NULLABLE AND NULL MEANS "LEAVE IT". That is not
 * politeness, it is what makes autosave correct: the popover flips one switch
 * at a time, and a call that had to restate all five would replay whatever the
 * tab last READ into the other four — so flipping density on the phone would
 * quietly revert the type scale the laptop set thirty seconds earlier. A
 * single-field call cannot lose a field it never mentions.
 *
 * A write that changes nothing writes NOTHING: no row update, no bumped token,
 * no event. Autosave fires on gestures that are frequently no-ops (a control
 * re-rendering, an outbox replaying, a double tap), and the version token
 * staying still across them is what stops a tab invalidating its own token.
 *
 * The token compared is `display_updated_at`, never `updated_at` — see the
 * trigger above. The two lanes are independent on purpose: a preference change
 * must not make a half-finished Search Profile edit un-saveable, and vice
 * versa.
 */
create or replace function public.app_set_display_prefs(
  p_density             text,
  p_type_scale          text,
  p_keyboard_hints      boolean,
  p_landing_view        text,
  p_theme               text,
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
begin
  -- Unreachable through the app and kept anyway, for 0012's stated reason:
  -- `authenticated` is the only role granted execute, so `auth.uid()` is
  -- non-null for every caller that can get this far. The day a service-role
  -- path or a new grant appears, this is the line that refuses to write a row
  -- with a null `user_id`. Pinned textually by
  -- `test_definer_functions_never_take_a_user_id`.
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- `hq_blank_trim`, not `length(p_idem) = 0` — 0012's tighter door, copied
  -- outward as its comment asked. A key of one NEWLINE reads as content to
  -- `btrim()` with no argument and as blank to a person (matrix rows 110, 129),
  -- and one caller sending a blank key would have every LATER blank key replay
  -- the first gesture's result forever.
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Validated HERE as well as by the CHECK constraints, and the duplication is
  -- the point: a CHECK violation is errcode 23514 with a constraint name in it,
  -- which `supabase-source.ts` classifies as a generic error and shows as
  -- "Couldn't save that". These raise 22023 with the offending value named, so
  -- the failure says which knob and what was sent. The constraints remain the
  -- door that stays shut if a later writer forgets this one.
  if p_density is not null and p_density not in ('dense', 'comfortable') then
    raise exception 'unknown density: %', p_density using errcode = '22023';
  end if;
  if p_type_scale is not null and p_type_scale not in ('default', 'large') then
    raise exception 'unknown type scale: %', p_type_scale using errcode = '22023';
  end if;
  if p_theme is not null and p_theme not in ('light', 'dark', 'system') then
    raise exception 'unknown theme: %', p_theme using errcode = '22023';
  end if;
  if p_landing_view is not null and length(p_landing_view) > 64 then
    raise exception 'landing view too long: % chars', length(p_landing_view)
      using errcode = '22023';
  end if;

  -- Replay: return the first result rather than applying twice.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- No row is created at signup (`handle_new_auth_user` writes `users` only),
  -- and a person can legitimately set their type scale before they ever finish
  -- the wizard — the wizard is the surface they need to READ. So materialise
  -- the row with the never-onboarded `'{}'` criteria sentinel, which is exactly
  -- what `app_commit_profile` does and what the onboarding redirect reads.
  -- `do nothing` rather than an existence check: two first-time gestures racing
  -- must not both insert.
  insert into public.profiles (user_id, criteria, notify)
  values (v_user, '{}'::jsonb, '{}'::jsonb)
  on conflict (user_id) do nothing;

  select * into v_row from public.profiles where user_id = v_user for update;

  -- Re-check the key with the row LOCKED. The check above only settles
  -- sequential replays; two tabs flushing one outbox on the same 'online' event
  -- both pass it before either writes.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Optimistic concurrency, checked INSIDE the transaction that writes.
  -- `p_expected_updated_at` is DECLARED `timestamptz` and `display_updated_at`
  -- IS one, so Postgres has parsed both instants before this line runs; the
  -- casts read as intent at the comparison site and are not the mechanism (the
  -- parameter type is — `test_the_version_token_is_declared_as_an_instant`
  -- pins it). Comparing the two RENDERINGS as text is matrix rows 146 and 168.
  --
  -- The word "conflict" is load-bearing: supabase-source.ts matches on it.
  if p_expected_updated_at is not null
     and v_row.display_updated_at::timestamptz is distinct from p_expected_updated_at::timestamptz then
    raise exception 'conflict: your display preferences changed since you read them'
      using errcode = '40001';
  end if;

  v_before := public.app_display_prefs_row(v_row);

  update public.profiles
     set display_density        = coalesce(p_density, display_density),
         display_type_scale     = coalesce(p_type_scale, display_type_scale),
         display_keyboard_hints = coalesce(p_keyboard_hints, display_keyboard_hints),
         display_landing_view   = coalesce(p_landing_view, display_landing_view),
         display_theme          = coalesce(p_theme, display_theme),
         display_updated_at     = now()
   where user_id = v_user
     -- The no-op guard. Everything below it — the token bump and the event —
     -- happens only when a value really moved.
     and (display_density, display_type_scale, display_keyboard_hints,
          display_landing_view, display_theme)
         is distinct from
         (coalesce(p_density, display_density),
          coalesce(p_type_scale, display_type_scale),
          coalesce(p_keyboard_hints, display_keyboard_hints),
          coalesce(p_landing_view, display_landing_view),
          coalesce(p_theme, display_theme))
  returning * into v_row;

  v_wrote := found;

  if not v_wrote then
    -- Nothing moved. Re-read rather than reusing the locked snapshot, so the
    -- answer is the row as it stands and not the row as it was before a
    -- concurrent writer we have already released.
    select * into v_row from public.profiles where user_id = v_user;
  else
    -- ONE event for the change, the row and its audit entry in the same
    -- function body. Bounded by the no-op guard above: an autosave storm of
    -- identical values appends nothing, so the append-only trail records the
    -- handful of times a person actually changed their mind rather than every
    -- render that re-sent the same five values.
    insert into public.events (user_id, kind, payload, actor)
    values (v_user, 'profile.display_changed',
            jsonb_build_object(
              'before', v_before,
              'after',  public.app_display_prefs_row(v_row)),
            'user');
  end if;

  v_result := jsonb_build_object(
                'display', public.app_display_prefs_row(v_row),
                'changed', v_wrote);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_display_prefs', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

revoke all on function
  public.app_set_display_prefs(text, text, boolean, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.app_set_display_prefs(text, text, boolean, text, text, text, timestamptz)
  to authenticated;

-- ============================================================ RLS

-- Nothing to add, stated so the omission is a decision rather than a gap.
-- `profiles` has RLS enabled (0001) and exactly one policy on it,
-- `profiles_self_read … using (user_id = auth.uid())`. New COLUMNS on an
-- existing table inherit it, so these five are owner-only the moment they
-- exist, and `tests/db/test_display_prefs.py` proves it from a second user's
-- session rather than taking the inheritance on trust. There is deliberately no
-- write policy: 0001's "browsers write through functions or not at all" is
-- pinned by `test_browser_still_has_no_direct_write_policy`, and the function
-- above is this lane's door.
