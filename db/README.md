# HQ v2 store — Postgres (Supabase) provisioning & operations

The decided v2 architecture (review doc, decision log 2026-07-19): **one
Postgres store, one write path** — the engine writes with the service role,
humans read/act through the web app (`webapp/`) under RLS, and each user's
Google Sheet becomes a generated read-only export. Strangler migration: the
sheet stays the system of record until stage 3 flips triage writes to the app.

## One-time provisioning (operator, ~20 min, no laptop needed beyond a browser)

1. **Supabase project** — supabase.com → New project (free tier is fine: the
   whole workload is well under 500 MB; daily engine writes keep the free
   project from pausing). Region: us-central.
2. **Run every file in `db/migrations/`, in filename order** — from a laptop:
   `DATABASE_URL='postgresql://…' db/apply.sh` (applies each file exactly once,
   recorded in `public.schema_migrations`; fails loud, prints the ledger and
   app_* function counts as a sanity check — see the script header for the
   one-time `SEED_THROUGH` adoption of a database provisioned before the
   ledger existed). In CI this is the dispatch-only `DB apply` workflow. The
   browser-only fallback is the SQL editor → paste one, run, next. The rule is the directory listing, not the list
   below: this step used to name 0001 and 0002 and stayed that way after 0003
   shipped, so an operator who followed it provisioned a database with no
   `app_set_triage` — the exact state where every human triage fails at the
   first keystroke. What exists today:
   - `0001_init.sql` — the INIT script (once per project): tables, RLS, the
     auth trigger that enforces the allowlist.
   - `0002_invariants.sql` — closes the gaps 0001 left. Notably 0001 let ANY
     authenticated user read EVERY posting, and called `events` append-only in
     a comment; a comment is not a permission.
   - `0003_write_path.sql` — `app_set_triage`, the only way a human gesture
     reaches the database, plus the `command_idempotency` table behind it. The
     web app has called this function since it was written; without this file
     the app fails on its first keystroke, not its hundredth.
   - `0004_audit_hardening.sql` — revokes the privileges RLS does not reach.
     Without it a signed-in browser session can `truncate public.events` and
     empty the append-only trail, for every user, in one statement.
   Adding a migration: run **`scripts/new-migration.sh <name>`**. It creates
   `db/migrations/YYYYMMDD_HHMMSS_<name>.sql` stamped in UTC. Do not hand-format
   the filename, and do not add a new serial number — see below.

   ### Filenames: `0001`–`0028` are serial, everything after is a timestamp

   Migrations used to be numbered `0001`, `0002`, … assigned serially at build
   time. That made the filename a **shared resource**: two branches cut from the
   same commit both wanted the next number, so every parallel branch had to edit
   one global `RESERVED_MIGRATION_NUMBERS` list in `tests/core/test_migrations.py`
   declaring which number it had claimed — and every merge invalidated the next
   branch's copy of that list. It was hand-resolved four times in one session
   and never caught a real defect, because the defect it was designed to catch
   (a migration that never got committed) is now recorded for real in
   `public.schema_migrations`.

   So new migrations are stamped `YYYYMMDD_HHMMSS_name.sql` in UTC, which is
   unique without anyone coordinating. **The serial-integrator rule is
   unchanged** — one person still integrates and reviews migrations, in order.
   What went away is the mechanical renumbering, not the review.

   **`0001`–`0028` are never renamed.** They are recorded in the production
   ledger by filename. Rename one and `apply.sh` sees a file it has no row for
   and runs it again — against a live database, where `0001_init.sql` alone is
   an unguarded `create table allowed_emails`.

   The two schemes sort correctly together, which matters because `apply.sh`
   applies in `ls *.sql | sort` order: every serial name begins with `0` and
   every stamped name begins with `2`, so the legacy files always apply first.
   Verified in C, POSIX and en_US.UTF-8 collations, and asserted in
   `tests/core/test_migrations.py` and `tests/db/test_migration_ledger.py`.

   **Do not create the `resumes` storage bucket by hand.** `20260802_084857_resume_storage.sql`
   creates it private and attaches the four owner-scoped policies over
   `storage.objects`, so a fresh project provisions identically to the live one.
   A bucket made in the dashboard has no policies on it and no record of that
   anywhere — which is the state PR #104 shipped into and this migration closes.
   If it refuses, it names the grant to issue: the applying role has to hold
   ownership privileges on `storage.objects`, which on Supabase means membership
   of `supabase_storage_admin` **with inherit**.

3. **Allowlist the family** — SQL editor:
   ```sql
   insert into allowed_emails (email, name, is_operator) values
     ('<salman gmail>', 'Salman', true),
     ('<dad gmail>',    'Dad',    false),
     ('<roommate gmail>', 'Roommate', false);
   ```
   Anyone else who signs in with Google is refused at the door (auth trigger).
4. **Google sign-in** — Supabase Dashboard → Authentication → Providers →
   Google. Create the OAuth client in Google Cloud Console (External, the 3
   Gmail addresses as test users is sufficient), paste client id/secret,
   add the Supabase callback URL shown in the dashboard.
5. **Secrets**
   - GitHub repo secrets (engine + dumps): `SUPABASE_URL`,
     `SUPABASE_SERVICE_KEY` (Dashboard → Settings → API → service_role), and
     `SUPABASE_DB_URL` for pg_dump — **use the Session-pooler URI**
     (Settings → Database → Connection string → Session pooler, port 5432).
     The "direct connection" host is IPv6-only and GitHub-hosted runners have
     no IPv6, so the direct URI cannot work from Actions.
   - Vercel (webapp): `NEXT_PUBLIC_SUPABASE_URL`,
     `NEXT_PUBLIC_SUPABASE_ANON_KEY` — anon key only; the browser app never
     sees the service key.
   - Repo **variable** (not secret) `PGDUMP_ENABLED=true` once the project
     exists — gates the nightly dump workflow so it doesn't warn before
     provisioning.
6. **First mirror** — after PR #12's regate has stamped the feed:
   `HQ_PG_USER_ID=<users.id>` + `python -m monitor.pgmirror` (or the
   workflow_dispatch once wired). Idempotent; run as often as you like
   during the dual-write phase.

## Write-path rules (non-negotiable, mirrors the sheets contract)

1. Browser sessions hold the **anon key only**; RLS gives them reads of
   their own rows (+ shared postings/companies). There are deliberately NO
   insert/update policies — human writes go through the functions in rule 3,
   never through a policy.
2. Engine writes go through `core/pg.py` (PostgREST, service role) — loud
   `PgError` on any non-2xx, chunked payloads, idempotent upserts keyed on
   primary keys. No other Python module talks to Postgres directly.
3. Human gestures go through the security-definer functions in
   `0003_write_path.sql` — today `app_set_triage`. It writes the affected row
   and its `events` entry in one transaction, derives the acting user from
   `auth.uid()` so a caller cannot name someone else, replays a stored result
   for a repeated idempotency key, and rejects a stale `expected_updated_at`
   as a conflict. Never raw table edits from a client.
4. `events` is append-only forever: capture emails, gestures, bot
   transitions. Debugging starts there, like the sheet's Log tab.

## Backups

- Nightly `pg_dump --schema=public` → gzipped SQL committed to
  `snapshots/pg/` by `.github/workflows/pgdump.yml` — **deleted 2026-07-25** (it was gated off with
  no database behind it; restore it from git history when this schema is live, per
  `docs/RUNBOOK.md` § PG snapshot). The design below is what it did, and what to restore:
  same ritual as the sheet CSV snapshots, single-digit MB gzipped at this scale for years. The dump is
  **scoped to `public` on purpose**: Supabase's `auth` schema holds the
  family's identities, sessions, and refresh tokens — those must never land in
  git, and a restore must not collide with the managed schemas a fresh project
  already has.
- The workflow pins **postgresql-client-17** from PGDG (Ubuntu ships 16, and
  `pg_dump` aborts when the server major is newer), runs under `set -euo
  pipefail` so a failed dump can't be committed as an empty gzip, gates on a
  minimum file size, verifies gzip integrity, and retries a rejected push
  instead of swallowing it.
- Restore drill (practice once before you need it): create a fresh Supabase
  project, then
  ```sh
  gunzip -c snapshots/pg/hq.sql.gz | psql "$NEW_SUPABASE_DB_URL"
  ```
  The dump carries the `public` schema **and** its data — tables, functions and
  all — so do NOT run the migrations first; they would conflict. The one
  exception is `0004_audit_hardening.sql`: it is pure REVOKE, re-running it
  costs nothing, and it is cheaper to re-apply than to discover after an
  incident that the restored grants were wider than the originals. Afterwards
  re-point `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`SUPABASE_DB_URL` and re-add
  the Google provider. Note `auth.users` is not in the dump: each family member
  signs in with Google again and the allowlist trigger recreates their row —
  but their `users.id` changes, so re-run the mirror rather than expecting
  old per-user rows to match. (Keeping identities out of git is worth that.)
- Upgrade to Supabase Pro ($25/mo, managed daily backups + no pause risk)
  when the app carries daily triage — the decided budget ceiling covers it.

## Schema map

Tables from `0001_init.sql` unless noted.

| Table | What | Written by |
|---|---|---|
| `allowed_emails` | family allowlist | operator (SQL) |
| `users` / `profiles` | identities + Search Profile / notify prefs | auth trigger / engine |
| `companies` / `user_companies` | canonical universe + per-user monitor flags | engine |
| `postings` | canonical postings (shared; jobkey pk) | engine |
| `user_postings` | per-user disposition + triage state | engine + `app_set_triage` (0003) |
| `applications` | per-user pipeline (same status enum as the sheet) | engine + `app_set_triage` (0003) |
| `events` | append-only audit: emails, gestures, bot transitions | engine / capture / app commands |
| `channel_runs` | health ledger (per run, per channel, with denominators) | engine |
| `answers` | own-Simplify substrate: canonical Q→A per user | future |
| `command_idempotency` (0003) | the stored RESULT per (user, key), so a replay returns the first answer rather than applying twice | `app_set_triage` |

**Read policies (after 0002):** a posting is visible only to a user who has a
`user_postings` row for it; a company only to a user watching it. Everything
else is `user_id = auth.uid()`. `events` is append-only at the PERMISSION
level, not by convention — correcting history means appending a correcting
event, never updating one.

**Write path (0003):** the browser still has no insert/update/delete policy and
never gets one. `app_set_triage` is `security definer`, so a hostile client
calling it directly can at worst act as itself. `command_idempotency` carries
no policies at all: it is reachable only from inside that function.

**Privileges (0004):** RLS governs SELECT/INSERT/UPDATE/DELETE and nothing
else, while Supabase grants `authenticated` everything on every table in
`public` so RLS can be the decider. TRUNCATE, TRIGGER and REFERENCES are
decided by the privilege system alone and are revoked there — including via
`alter default privileges`, so a later migration cannot reopen the hole by
forgetting.
