# job

The job posting entity: where postings come from, how they deduplicate, and who may see
and act on them. This spec is the current truth, including the transitional fact that
the discovery feed's system of record is still the Google Sheet;
`docs/plans/SHEET-INVENTORY.md` is the fact table for that era.

## What it is

A posting is one job at one company from one source, shared across users. What a user
thinks about a posting — qualified or filtered, interested or dismissed — is a separate
per-user row. The split exists so canonical facts can be shared while every decision
stays private (`docs/pilot-launch/10-data-authority-and-transition.md` §2).

## Where it is stored

- `public.postings` — `db/migrations/0001_init.sql`. Primary key `key` is the natural
  key `{ats}-{native_id}` computed by `core.jobkeys`; there is no hash column and no
  other unique constraint — dedup is entirely "the natural key is the primary key".
  `status` has deliberately no CHECK (documented values `New | Seen | Closed`; a human
  may invent one). `posted` is null when the source date is unparseable, rather than a
  guess.
- `public.user_postings` — `0001_init.sql` plus `0002_invariants.sql`: PK
  `(user_id, posting_key)`, `disposition` in `qualified | filtered | needs-info`,
  `triage` in `'' | interested | dismissed | snoozed` with the constraint
  `snooze_has_a_date`, `score`, `updated_at` (the CAS token), and `pushed_at`
  (`20260803_090223_sweep_state.sql`, a fill-blank-only latch).
- Engine bookkeeping: `public.monitor_sweep_state` (per-user sweep cursor,
  `20260803_090223`), `public.engine_cursors` (per-lane budget cursors,
  `20260803_105950`), `public.bot_runs` (per-run telemetry, `0023_bot_runs.sql`).

## Who reads and writes it

- **Discovery engine (transitional)** — the Sheet Feed tab is still the feed's system of
  record. Board adapters under `monitor/fetchers/` feed `monitor/run.py`, and the wide
  sweeps `monitor/wide.py` (`wide_cafe`, `wide_theirstack` on EventBridge,
  `infra/terraform/variables.tf`) append to the Feed tab. Postgres gets the copy:
  `monitor/pgmirror.py` upserts `postings` and `user_postings` from the whole tab as the
  tail step of the scheduled `monitor` job (`infra/app/handler.py`). The switches exist
  but are not flipped: `HQ_PG_WRITES` defaults to `mirror` (`core/pgwrites.py`) and
  `monitor/feedstore.py` states `HQ_FEED_STORE=pg` is not a deployable configuration yet.
  Do not add a new Sheet dependency; the transition only shrinks (CLAUDE.md).
- **Browser** — reads go through `getDataSource()` →
  `webapp/lib/data/supabase-source.ts`, which selects from `user_postings` for `/jobs`,
  `/queue`, the layout badge, `/apply/[applicationId]`, and `/api/export`. Visibility of
  the shared row is ownership-derived: policy `postings_visible_to_gated_users`
  (`0002_invariants.sql`) shows a posting only to users holding a `user_postings` row,
  so a shared fetch never exposes who watches what. Writes are two RPCs only:
  `app_set_triage` (`0003_write_path.sql`) and `app_set_triage_bulk`
  (`0006_bulk_triage.sql`). Triage has side effects on the pipeline: `interested`
  inserts a `Queued` application; leaving `interested` deletes it only while it is still
  `Queued`.
- **Digest links** — `/d/[token]` (`webapp/app/d/[token]/route.ts`, HMAC) calls
  `hq_digest_set_triage` (`0019_digest_action.sql`, service_role) so an email action
  needs no browser session.
- **Profile preview** — `app_preview_corpus` (`0012_profile.sql`, entitlement re-check in
  `0027_entitlement.sql`) serves a capped, column-limited sample for criteria preview.

## Invariants

- No browser DML on `postings`, ever: no insert/update/delete policy exists on it (or on
  any `public` table — `0001_init.sql`'s closing note), and the entitlement pair from
  `0027_entitlement.sql` gates both tables.
- A posting is visible only through ownership; there is no "browse all postings" read.
- Disposition and triage are closed sets enforced by CHECK constraints; a snoozed row
  must carry a date and only a snoozed row may.
- The engine writes as `service_role` only, through the guard hatch in
  `hq_entitlement_guard()` (`0027_entitlement.sql`).
- While the mirror era lasts, Postgres postings are derived data: fixing feed content
  means fixing the writer, not hand-editing rows. The cutover gates are in
  `docs/pilot-launch/10-data-authority-and-transition.md` §4.
