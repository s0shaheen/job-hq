-- Saved views — a user's named grid states.
--
-- A saved view is filters + sort + group + quick-search + column layout +
-- density, stored as one opaque `state` blob the database never interprets.
-- The engine does not read it; only the web app does, to restore exactly what
-- the user was looking at. Built-in presets (Queue, All postings, Snoozed, …)
-- live in code, not here — they must exist with zero setup and cannot be
-- deleted; this table holds only what a human chose to save.
--
-- The write path mirrors 0003 exactly, because the reasons are the same: the
-- browser has no direct write policy, every mutation goes through one
-- security-definer function that derives the acting user from auth.uid() and
-- writes the row and its audit event in a single transaction, an idempotency
-- key makes a retry free, and expected_updated_at turns a second device into a
-- visible conflict rather than a silent clobber. tests/core/test_migrations.py
-- enforces those properties on every function here; tests/db/test_saved_views.py
-- and test_rls.py exercise the behaviour and the isolation against real
-- Postgres.

create table if not exists public.saved_views (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  surface    text not null default 'jobs',   -- 'jobs' | 'pipeline' (phase 5)
  name       text not null,
  state      jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one default per (user, surface). The write function clears the old
-- default before setting a new one; this index is the backstop that turns a
-- missed clear into a loud error rather than two landing pages.
create unique index if not exists saved_views_one_default
  on public.saved_views (user_id, surface) where is_default;

-- Names are unique per surface, case-insensitively: "Payments" and "payments"
-- are the same view to a human, and a switcher listing both is a bug.
create unique index if not exists saved_views_name
  on public.saved_views (user_id, surface, lower(name));

create index if not exists saved_views_by_user
  on public.saved_views (user_id, surface);

create trigger saved_views_touch before update on public.saved_views
  for each row execute function public.touch_updated_at();

-- ============================================================ RLS

alter table public.saved_views enable row level security;

-- A user reads only their own views. Writes go exclusively through the
-- functions below (security definer), never a direct policy — same rule as
-- every other per-user table.
create policy saved_views_self_read on public.saved_views
  for select using (user_id = auth.uid());

-- ============================================================ save

create or replace function public.app_save_view(
  p_id                  uuid,      -- null to create, an id to update in place
  p_name                text,
  p_surface             text,
  p_state               jsonb,
  p_is_default          boolean,
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
  v_row    public.saved_views;
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_name is null or length(btrim(p_name)) = 0 or length(p_name) > 120 then
    raise exception 'a view needs a name' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Setting this view as the default clears any other default FIRST, or the
  -- partial unique index rejects the write. Scoped to the acting user and the
  -- surface, and it never touches the row we are about to write.
  if p_is_default then
    update public.saved_views
       set is_default = false
     where user_id = v_user
       and surface = coalesce(p_surface, 'jobs')
       and is_default
       and (p_id is null or id <> p_id);
  end if;

  if p_id is null then
    insert into public.saved_views (user_id, surface, name, state, is_default)
    values (v_user, coalesce(p_surface, 'jobs'), btrim(p_name),
            coalesce(p_state, '{}'::jsonb), coalesce(p_is_default, false))
    returning * into v_row;
  else
    -- Lock, then check the version, then write — the same order 0003 uses so
    -- two devices editing one view cannot both pass the conflict check.
    select * into v_row from public.saved_views
     where id = p_id and user_id = v_user
       for update;
    if not found then
      raise exception 'no such view for this user: %', p_id using errcode = 'P0002';
    end if;
    if p_expected_updated_at is not null
       and v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'conflict: this view changed since you read it'
        using errcode = '40001';
    end if;
    update public.saved_views
       set name = btrim(p_name),
           surface = coalesce(p_surface, v_row.surface),
           state = coalesce(p_state, v_row.state),
           is_default = coalesce(p_is_default, v_row.is_default)
     where id = p_id and user_id = v_user
     returning * into v_row;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (
    v_user, 'view.saved',
    jsonb_build_object('view_id', v_row.id, 'name', v_row.name,
                       'is_default', v_row.is_default, 'idem', p_idem),
    'user'
  );

  v_result := public.app_view_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_save_view', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ============================================================ delete

create or replace function public.app_delete_view(
  p_id   uuid,
  p_idem text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_name   text;
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  delete from public.saved_views
   where id = p_id and user_id = v_user
   returning name into v_name;
  if not found then
    raise exception 'no such view for this user: %', p_id using errcode = 'P0002';
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'view.deleted',
          jsonb_build_object('view_id', p_id, 'name', v_name, 'idem', p_idem),
          'user');

  v_result := jsonb_build_object('deleted', p_id);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_delete_view', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

-- ============================================================ result shape

-- The row shape the client reads, matching toSavedView() in supabase-source.ts.
-- Not security definer — it is only called from inside the definer functions
-- above, which already run with the rights it needs. Same reasoning as
-- app_triage_row in 0003.
create or replace function public.app_view_row(v public.saved_views)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',         v.id,
    'surface',    v.surface,
    'name',       v.name,
    'state',      v.state,
    'is_default', v.is_default,
    'updated_at', v.updated_at
  )
$$;

-- ============================================================ grants

revoke all on function public.app_save_view(uuid, text, text, jsonb, boolean, text, timestamptz) from public;
revoke all on function public.app_delete_view(uuid, text) from public;
revoke all on function public.app_view_row(public.saved_views) from public;
grant execute on function public.app_save_view(uuid, text, text, jsonb, boolean, text, timestamptz) to authenticated;
grant execute on function public.app_delete_view(uuid, text) to authenticated;
