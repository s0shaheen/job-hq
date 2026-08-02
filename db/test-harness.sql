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

-- Supabase grants USAGE on the auth schema to the three roles
-- (`20211115181400_update-auth-permissions.sql`), and this harness did not.
--
-- Nothing noticed for nineteen migrations, because schema usage is checked at
-- NAME RESOLUTION and every existing caller of `auth.uid()` is either a policy
-- expression (parsed once, by the superuser who created it) or a
-- `security definer` function (parsed as its owner). The first plain function to
-- call `auth.uid()` under `set role authenticated` — 0027's `hq_is_entitled`,
-- deliberately not a definer so it can only ever see the caller's own row — got
-- "permission denied for schema auth" here and works fine on Supabase.
--
-- A harness that is stricter than production in a way production is not turns a
-- correct function into a red test, which is the pressure that makes somebody
-- mark it `security definer` to get green. Closing the divergence instead.
grant usage on schema auth to anon, authenticated, service_role;

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

-- ============================================================ storage (0026)
--
-- Supabase Storage keeps its objects in a real Postgres table, `storage.objects`,
-- and access is decided by ORDINARY RLS POLICIES on that table. That is the whole
-- reason 0026 can put résumé artifacts there without inventing a second authz
-- model: the policy is `(storage.foldername(name))[1] = auth.uid()::text`, which
-- is the same `auth.uid()` predicate as every other table in this schema.
--
-- Stubbed here for the same reason `auth.users` is: a policy that is only ever
-- read as text is a policy nobody has run. With this stub, `tests/db/test_rls.py`
-- can `set role authenticated` and prove that user A cannot read user B's résumé
-- PDF — which is the single assertion standing between one person's résumé and
-- another's.
--
--   TESTED FOR REAL: the policy expression, the folder-prefix derivation, and
--   the two-user negative. Plain Postgres, identical behaviour.
--
--   NOT TESTED HERE: that Supabase's storage-api actually consults these
--   policies on an HTTP GET, that signed URLs expire, or that the bucket is
--   private. Those are Supabase's behaviour. The bucket's `public` flag in
--   particular is set by the migration's insert into `storage.buckets` and is
--   NOT proven by anything here — treat it as configuration to verify in the
--   dashboard, not as something the suite covers.
--
-- Only the columns the policies reference are stubbed. The real table has ~15.
create schema if not exists storage;

create table if not exists storage.buckets (
  id     text primary key,
  name   text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets (id),
  -- The object key, e.g. `<user_id>/<artifact_id>/resume.pdf`. Supabase calls
  -- this `name`; it is a path, not a filename.
  name      text not null,
  owner     uuid,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects to anon, authenticated, service_role;
grant all on storage.buckets to anon, authenticated, service_role;

-- Supabase's own helper: split an object key on `/` and return the segments, so
-- a policy can match on the first one. Reproduced exactly — the real one returns
-- text[] and drops the final segment (the file itself), which is what makes
-- `[1]` the owner directory rather than the whole path.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end
$$;
