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
2. **Run the migration** — SQL editor → paste `db/migrations/0001_init.sql`
   → run. Idempotence: it is an INIT script; run once per project.
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
   insert/update policies in v1.
2. Engine writes go through `core/pg.py` (PostgREST, service role) — loud
   `PgError` on any non-2xx, chunked payloads, idempotent upserts keyed on
   primary keys. No other Python module talks to Postgres directly.
3. Human gestures (stage 3) become server-side command endpoints in the web
   app that write `events` (append-only) + the affected row — never raw
   table edits from a client.
4. `events` is append-only forever: capture emails, gestures, bot
   transitions. Debugging starts there, like the sheet's Log tab.

## Backups

- Nightly `pg_dump --schema=public` → gzipped SQL committed to
  `snapshots/pg/` by `.github/workflows/pgdump.yml` (same ritual as the sheet
  CSV snapshots; single-digit MB gzipped at this scale for years). The dump is
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
  The dump carries the `public` schema **and** its data, so do NOT run
  `0001_init.sql` first — it would conflict. Afterwards re-point
  `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`SUPABASE_DB_URL` and re-add the
  Google provider. Note `auth.users` is not in the dump: each family member
  signs in with Google again and the allowlist trigger recreates their row —
  but their `users.id` changes, so re-run the mirror rather than expecting
  old per-user rows to match. (Keeping identities out of git is worth that.)
- Upgrade to Supabase Pro ($25/mo, managed daily backups + no pause risk)
  when the app carries daily triage — the decided budget ceiling covers it.

## Schema map (0001_init.sql)

| Table | What | Written by |
|---|---|---|
| `allowed_emails` | family allowlist | operator (SQL) |
| `users` / `profiles` | identities + Search Profile / notify prefs | auth trigger / engine |
| `companies` / `user_companies` | canonical universe + per-user monitor flags | engine |
| `postings` | canonical postings (shared; jobkey pk) | engine |
| `user_postings` | per-user disposition + triage state | engine (stage 3: + app commands) |
| `applications` | per-user pipeline (same status enum as the sheet) | engine (stage 3: + app commands) |
| `events` | append-only audit: emails, gestures, bot transitions | engine / capture / app commands |
| `channel_runs` | health ledger (per run, per channel, with denominators) | engine |
| `answers` | own-Simplify substrate: canonical Q→A per user | future |
