-- Test harness: the minimum Supabase surface the migrations depend on, so they
-- can be applied to a vanilla Postgres and the write path can actually be RUN.
--
-- WHY THIS IS NEEDED
--
-- Until now nothing had ever executed this schema. `tests/core/test_migrations.py`
-- reads the SQL as text, which catches a missing function and a missing revoke
-- but cannot catch a logic error, and the whole point of `app_set_triage` is
-- logic: idempotent replay, optimistic concurrency, an application created here
-- and deleted there. Those are exactly the properties that look right when you
-- read them and are wrong when you run them.
--
-- WHAT IT STUBS, AND THE RISK
--
-- `auth.uid()` here reads a session setting instead of a JWT claim. That is a
-- fake, and this project has been bitten twice by fakes that were kinder than
-- the real thing — so be precise about what is and is not being tested:
--
--   TESTED FOR REAL: every statement in the migrations, the function bodies,
--   the constraints, the indexes, the transactional behaviour, the locking, and
--   the concurrency semantics. These are plain Postgres and behave identically.
--
--   NOT TESTED HERE: that Supabase populates auth.uid() correctly from a JWT,
--   that RLS is applied to the anon key, or that GoTrue fires the signup
--   trigger. Those are Supabase's behaviour, not ours, and proving them needs a
--   real project.
--
-- The stub is deliberately STRICTER than Supabase in the one way that matters:
-- auth.uid() returns NULL unless a test explicitly sets a user, so any code
-- path that forgets to establish an identity fails loudly here rather than
-- silently acting as somebody.

create schema if not exists auth;

-- Supabase's real auth.users has ~30 columns; the migrations only reference id
-- and email, and a foreign key needs nothing more.
create table if not exists auth.users (
  id    uuid primary key,
  email text
);

-- Roles the migrations grant to. On Supabase these are created by the platform.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- The acting user, per-session. `true` on current_setting means "return NULL if
-- unset" rather than raising, which is what lets a test assert the
-- not-authenticated path.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('hq.test_user', true), '')::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('hq.test_role', true), ''), 'authenticated')
$$;
