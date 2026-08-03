#!/usr/bin/env bash
# Create the next migration file with a UTC timestamp prefix.
#
#   scripts/new-migration.sh company_domain   → db/migrations/20260802_051200_company_domain.sql
#   scripts/new-migration.sh --print rename    → prints the filename, creates nothing
#
# WHY a timestamp and not the next number. The serial scheme made the FILENAME a
# shared resource: two branches cut from the same commit both wanted `0022`, so
# every parallel branch had to touch one hand-maintained list to declare which
# number it had claimed, and every merge invalidated the next branch's copy of
# that list. Four hand-resolved conflicts in one session bought nothing — the
# ledger in `public.schema_migrations` (db/apply.sh) already records what really
# applied, which is the only defect the list was catching. A timestamp is unique
# without coordination, so branches stop colliding on a number.
#
# The SERIAL-INTEGRATOR RULE IS UNCHANGED: one person still integrates migrations
# and reviews them serially. What went away is the mechanical renumbering, not
# the review.
#
# `0001`–`0028` keep their numbers forever. They are recorded in the production
# ledger BY FILENAME; renaming one would make apply.sh see an unknown file and
# re-run it against a live database.
set -euo pipefail

PRINT_ONLY=0
if [ "${1:-}" = "--print" ]; then
  PRINT_ONLY=1
  shift
fi

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: scripts/new-migration.sh [--print] <name>" >&2
  echo "       <name> is snake_case, e.g. 'company_domain'" >&2
  exit 2
fi

# Fail loud on a name that would not survive the filename assertions in
# tests/core/test_migrations.py, rather than creating a file that goes red later.
if ! [[ "$NAME" =~ ^[a-z0-9]+(_[a-z0-9]+)*$ ]]; then
  echo "refusing name '$NAME': use lowercase snake_case ([a-z0-9] joined by single underscores)" >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%d_%H%M%S)"
FILENAME="${STAMP}_${NAME}.sql"
DIR="$(cd "$(dirname "$0")/../db/migrations" && pwd)"
TARGET="$DIR/$FILENAME"

if [ "$PRINT_ONLY" = "1" ]; then
  echo "$TARGET"
  exit 0
fi

# A collision needs a whole second of two people running this at once in the same
# checkout. It is still a refusal and not an overwrite: silently clobbering an
# unapplied migration is the one failure this script must never cause.
[ -e "$TARGET" ] && { echo "refusing: $TARGET already exists" >&2; exit 1; }

cat >"$TARGET" <<EOF
-- ${FILENAME}
--
-- WHAT THIS CHANGES and WHY. Migrations are append-only: this file will run
-- exactly once against production and can never be edited afterwards.
--
-- Before merging, audit: ownership, grants, RLS policies, constraints, and the
-- search_path on any security-definer function.
--
-- THIS FILE IS ALSO TYPESCRIPT INPUT. webapp/tests/unit/types-contract.test.ts
-- parses these CREATE TABLE bodies AND these \`alter table … add column\`
-- statements, and asserts the matching type in webapp/lib/types.ts declares
-- exactly the columns the table has. So adding a column to a table that type
-- covers means editing webapp/lib/types.ts in THIS commit, even though nothing
-- in the web app writes it — the contract is "the type matches the table", not
-- "the type matches what the app uses". Adding \`user_postings.pushed_at\`
-- without it turned that guard red on a branch whose author reported the gate
-- green twice; the coupling was real and written down nowhere an author meets.
--
-- \`scripts/verify.sh --image\` runs vitest for any change under db/migrations,
-- so the guard will catch it — READ THE VERDICT LINE AT THE END, not the stage
-- output.
EOF

echo "$TARGET"
echo "note: if this adds a column to a table webapp/lib/types.ts covers, update" >&2
echo "      that type in the same commit — types-contract.test.ts parses this file." >&2
