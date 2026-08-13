# application

The application lifecycle. The one rule everything else serves: manual application
status is authoritative — no bot, capture lane, or suggestion may overwrite what the
user set (`docs/pilot-launch/09-full-product-contract-v2.md` §1, §5; CLAUDE.md).

## What it is

An application is a user's pursuit of one job: a status on a ladder, notes, evidence,
and next actions. It may point at a shared posting (`posting_key`) or stand alone as a
manual row. Gmail-derived automatic status is the launch exclusion: capture lanes may
*suggest*, never set.

## Where it is stored

- `public.applications` — `db/migrations/0001_init.sql`, extended by
  `0010_pipeline.sql`. Ownership is `user_id`; dedup is `unique (user_id, posting_key)`
  plus the partial unique index `applications_manual_dedup` on
  `(user_id, lower(company), lower(title))` for rows with no posting.
- `status` has deliberately no CHECK. The vocabulary is machine-readable as functions,
  not constraints: `hq_status_order()` (`Inbox → … → Offer`), `hq_status_terminal()`,
  `hq_status_resolved()`, `hq_finished_statuses()` — all in
  `0015_engine_writes.sql`. Suggestion state lives in `suggested_status`.
- `status_actor` (`system | user`) and `status_set_at` — `0010_pipeline.sql`. Once
  `status_actor = 'user'`, the trigger `applications_human_status_lock` refuses any
  status change unless the session flag `hq.status_write = 'human'` is set; only
  `app_set_status` sets it.
- Notes are history, not a text column: `public.application_notes`
  (`0010_pipeline.sql`), append-only for browser roles.
- Audit: `public.events` (`0001_init.sql`), update/delete revoked from browser roles
  (`0002_invariants.sql`). Every write RPC appends its event in the same transaction.
- Capture: `public.email_events` and `public.capture_tokens` (`0018_capture.sql`).
- Autopilot staging hangs off applications via the composite owner FK added by
  `db/migrations/20260802_094615_autopilot_staging.sql`; an ambiguous post-submit result
  is the `outcome_unknown` state there, never a status guess here.

## Who reads and writes it

- **Browser** — `/pipeline` and `/apply/[applicationId]` read via `getDataSource()` →
  `webapp/lib/data/supabase-source.ts`; notes load on demand through `loadNotesAction`
  (`webapp/app/(app)/pipeline/actions.ts`). Writes are the security-definer RPCs from
  `0010_pipeline.sql`: `app_set_status` (reopening a finished application requires a
  note saying why), `app_resolve_suggestion` (accept or dismiss a `suggested_status` —
  the only door a suggestion has), `app_add_note`, `app_set_next_action`. Rows are also
  born and buried by triage: `app_set_triage` (`0003_write_path.sql`) creates a `Queued`
  application on `interested` and removes it only while still `Queued`.
- **Import** — the wizard (`webapp/app/(app)/import/**`) writes through the
  security-definer functions of `0011_import.sql` as amended by
  `20260813_011502_import_unset_marker.sql`. An import may write only the five
  columns of `hq_import_writable_columns()`; a blank cell preserves the stored
  value; a cell holding exactly the explicit-unset marker
  (`hq_import_unset_marker()`, mirrored byte-identically as `UNSET_MARKER` in
  `webapp/lib/import/round-trip.ts`) clears its field on the clearable subset
  (`hq_import_clearable_columns()`: `next_action`, `next_action_date`,
  `applied_date`) and is refused by name anywhere else. Clears are reported per
  column (disposition `cleared`), restored by `app_import_undo`, and idempotent
  on replay.
  (`webapp/app/api/capture/route.ts`, bearer token), which calls
  `hq_capture_email_events` via the server-only service client
  (`webapp/lib/supabase/service.ts`). This writes `email_events` and suggestions; it
  cannot set status (the human-status lock is trigger-enforced, not convention).
- **Engine (transitional)** — the tracker lanes (`tracker/promote.py`,
  `tracker/quickadd.py`, `tracker/stale.py`, `tracker/join.py`) still operate on the
  Sheet Pipeline tab, which remains their store; `docs/plans/SHEET-INVENTORY.md` is the
  fact table. Postgres dual-write edges: `hq_apply_email_event`
  (`0015_engine_writes.sql`, called from `tracker/join.py` under
  `HQ_PG_WRITES=first_class`), `hq_upsert_sheet_application` (`tracker/pgseed.py`,
  dispatch-only seed), `hq_note_unapplied_event`. Per `docs/plans/SHEET-SUNSET.md`,
  nothing reads the pg `email_events` copy yet — the joiner still reads the tab.

## Invariants

- Manual status is authoritative, enforced by `applications_human_status_lock`
  (`0010_pipeline.sql`) — a machine check, not a review rule.
- Gmail cannot mutate status at launch; the suggestion seam
  (`suggested_status` + `app_resolve_suggestion`) is the only path from email to status,
  and the user is the actor.
- One application per user per posting; manual duplicates blocked case-insensitively.
- Reopening a finished application demands a reason (`app_set_status` raises without a
  note).
- `events` is append-only for every non-service role; each write RPC records exactly one
  logical effect with idempotent replay (see `docs/specs/write-path.md`).
- Concurrent edits surface as errcode `40001` conflicts against `updated_at`; the UI
  re-reads and shows the server's row rather than guessing.
- An imported blank never erases; only the explicit-unset marker clears, only on
  the clearable columns, and never silently — refusals are per-row and named,
  clears are per-column report lines.
- All tables here are behind the entitlement pair from `0027_entitlement.sql`.
