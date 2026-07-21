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

-- Supabase's bootstrap grants.
--
-- The migrations never GRANT anything to anon/authenticated, because on Supabase
-- the platform has already done it: `usage` on the schema and default
-- privileges on tables, so that RLS — not the privilege system — is what
-- decides who sees which rows. Reproducing the roles without the grants made
-- the harness useless for the one requirement docs/PRODUCT-SPEC.md section I
-- names by hand: "an RLS test that signs in as two real users and proves one
-- cannot read the other's rows".
--
-- Without these, `set role authenticated` gets "permission denied for schema
-- public" on every table, so a test asserting "A cannot read B's rows" passes
-- because A cannot read ANYTHING — and keeps passing with every policy
-- dropped. The negative assertion is only meaningful next to a positive
-- control ("A can read A's own rows"), and the positive control is exactly
-- what the missing grants made impossible to express.
--
-- These run BEFORE the migrations so the migrations' own REVOKEs (0002 takes
-- update/delete on events away again) land on real grants rather than on
-- nothing.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;

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
