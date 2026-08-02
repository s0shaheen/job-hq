#!/usr/bin/env bash
# Apply db/migrations to a database, in filename order, each file exactly once,
# recorded in public.schema_migrations. The first live db-apply run proved the
# old replay-the-whole-directory model wrong: 0001_init.sql is unguarded
# (`create table allowed_emails`) and aborts on any already-provisioned
# database, so "idempotent replay" only ever worked on a fresh one. The ledger
# makes both cases boring: fresh database → every file applies; provisioned
# database → only files the ledger has not recorded.
#
#   DATABASE_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres' db/apply.sh
#
# One-time adoption of a database provisioned BEFORE the ledger existed:
#   SEED_THROUGH=0020_warm_referral.sql DATABASE_URL=... db/apply.sh
# marks every file up to and including that one as applied WITHOUT executing it
# (recorded with seeded=true so the ledger never lies about what it ran), then
# applies the rest normally. Seeding is only honest when the target really has
# that schema — verify against a current dump first.
#
# A crash between "file applied" and "ledger row written" re-runs that one file
# on the next invocation: guarded migrations no-op, unguarded ones fail loudly
# and a human looks. That is the fail-loud side of the bargain, not a bug.
#
# Needs psql 15+. Fails loud on the first error; nothing here swallows.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to the connection string}"
cd "$(dirname "$0")/migrations"

# RLS on with no policies: the applying role owns the table (owners bypass
# RLS), while Supabase's default grants to anon/authenticated hit a wall.
# The revoke is guarded because plain CI Postgres has no such roles.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
  create table if not exists public.schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now(),
    seeded     boolean not null default false
  );
  alter table public.schema_migrations enable row level security;
  do \$\$ begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on public.schema_migrations from anon, authenticated;
    end if;
  end \$\$;"

if [ -n "${SEED_THROUGH:-}" ]; then
  [[ "$SEED_THROUGH" =~ ^[0-9A-Za-z_]+\.sql$ ]] || { echo "refusing SEED_THROUGH '$SEED_THROUGH': not a plain migration filename" >&2; exit 1; }
  [ -f "$SEED_THROUGH" ] || { echo "SEED_THROUGH file not found: $SEED_THROUGH" >&2; exit 1; }
  for f in $(ls *.sql | sort); do
    echo "── seeding $f (marked applied, not executed)"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
      "insert into public.schema_migrations (filename, seeded) values ('$f', true) on conflict (filename) do nothing;"
    [ "$f" = "$SEED_THROUGH" ] && break
  done
fi

applied=$(psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -c "select filename from public.schema_migrations")
ran=0
for f in $(ls *.sql | sort); do
  if grep -qxF "$f" <<<"$applied"; then continue; fi
  echo "── applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "insert into public.schema_migrations (filename) values ('$f');"
  ran=$((ran+1))
done

echo "── done: $ran applied this run; ledger + sanity:"
psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -c \
  "select count(*) || ' in ledger (' || count(*) filter (where seeded) || ' seeded)' from public.schema_migrations" | xargs echo "migrations:"
psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -c \
  "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'app_%'" | xargs echo "app_* functions:"
