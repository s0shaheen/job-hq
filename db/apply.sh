#!/usr/bin/env bash
# Apply every migration to a database, in filename order, remembering nothing —
# each migration is written idempotent-or-guarded (drop-if-exists / not-exists
# patterns), so re-running the whole directory is safe and IS the provisioning
# step. Replaces db/README's copy-12-files-into-the-SQL-editor marathon, which
# is exactly the manual ritual that once shipped a database with no
# app_set_triage (see 0003's header).
#
#   DATABASE_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres' db/apply.sh
#
# Needs psql 15+. Fails loud on the first error; nothing here swallows.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to the connection string}"
cd "$(dirname "$0")/migrations"
for f in $(ls *.sql | sort); do
  echo "── applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "── all migrations applied; sanity:"
psql "$DATABASE_URL" -tA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'app_%'" | xargs echo "app_* functions:"
