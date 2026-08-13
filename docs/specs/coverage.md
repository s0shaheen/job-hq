# coverage

The company coverage model: which companies a user's discovery watches, how review and
sweep gating work, and what the Coverage surface truthfully claims. The contract row
promises "company universe, monitoring, sources, freshness, gaps, activity, no Sheet
claims" (`docs/pilot-launch/09-full-product-contract-v2.md` §3).

## What it is

Coverage is a per-user answer to "which companies is the system scanning for you, and
how good is each company's source". A company is a shared catalog row; whether a user
watches it — and whether they have even approved it into their universe — is private
per-user state. Coverage numbers are counts, never percentages: recall against the real
world is explicitly unmeasured (`ORACLE_UNMEASURED` in `webapp/lib/grid/coverage.ts`).

## Where it is stored

- `public.companies` — `db/migrations/0001_init.sql`, extended by
  `0007_universe_metadata.sql` (`source`, `reliability_tier` 1–3 or null=unresolved,
  `resolution_method`), `0016_linkedin_fill.sql`, and `0021_company_domain.sql`
  (canonical `domain` with a CHECK; a human-set blank domain is a tombstone no bot may
  refill). Canonical identity: at most one unresolved placeholder per normalized name
  (`company_name_key`, `0008_company_review.sql`) and one row per board
  (`companies_board_identity_key`, `0009_universe_reconcile.sql`).
- `public.user_companies` — `0001_init.sql` (`monitor`, `priority`, `seeded`) plus
  `0008_company_review.sql`: `review_state` in `proposed | approved | dismissed` and the
  fail-closed constraint `user_companies_monitor_needs_approval` — an unapproved company
  cannot be swept.
- Sweep bookkeeping: `public.monitor_sweep_state` (per-user cursor,
  `20260803_090223_sweep_state.sql`), `public.engine_cursors` (closed lane set
  `wide_cafe | wide_theirstack | linkedin_backfill`, `20260803_105950`),
  `public.user_postings.pushed_at`, and `public.bot_runs` (`0023_bot_runs.sql`) behind
  the Activity tab.

## Who reads and writes it

- **Browser reads** — `/companies` (`webapp/app/(app)/companies/page.tsx`, titled
  "Coverage") reads once: `getDataSource().companies()` →
  `user_companies` joined to `companies` in `webapp/lib/data/supabase-source.ts`. All
  coverage numbers are client-side arithmetic over those rows: `computeCoverage` in
  `webapp/lib/grid/coverage.ts`, keyed off `sourceQuality()`
  (`webapp/lib/data/view-models.ts`) — a row whose resolution method is unreadable
  counts as unresolved even if it has a tier. `coverage-summary.tsx` renders the result
  as a sentence ("Watching N of M companies", plus how many have no readable board) with
  no meter and no division. Working sets are `review | universe | unresolved | dismissed
  | all` (`webapp/lib/grid/company-presets.ts`); the Activity tab is `/health` reading
  `bot_runs`. `webapp/app/(app)/coverage/page.tsx` is a nav destination with no surface
  behind it yet; it points readers at `/companies` and `/connections`.
- **Browser writes** — server actions in `webapp/app/(app)/companies/actions.ts` call
  `app_set_company_review_bulk` and `app_set_company_flags`
  (`0008_company_review.sql`), `app_propose_companies` (user-added companies enter as
  tier 3, source `manual`), and `app_set_linkedin_company_id`. The add form takes names
  by paste or by CSV file (#202): the file is decoded in the browser with the import
  wizard's own byte machinery (`webapp/lib/import/bytes.ts` — caps, magic-byte sniff,
  strict-UTF-8-then-cp1252) and its text lands in the same box, so one splitter
  (`paste.ts`), one preview, and one write path (`proposeCompaniesAction`, source
  `import`) serve both doors; an over-length row fails alone, named by line number. The sweep toggle
  (`sweep-toggle.tsx`) writes `monitor` only and renders `Not listed` for a non-approved
  row because the database would refuse the write; states are
  `Not listed | Paused | Watching | In scans` (`webapp/lib/grid/company-columns.tsx`).
- **Engine writes** — grounding upgrades a placeholder through
  `reconcile_grounded_company` (`0009_universe_reconcile.sql`; collision is an explicit
  outcome, recorded via `note_grounding_blocked`), driven by
  `monitor/discover_universe.py` (dispatch, not scheduled). `hq_fill_domain`
  (`0021`) and `hq_fill_linkedin_company_id` (`0016`) are fill-blank-only, fed by
  `monitor/linkedin_backfill.py` and `monitor/wide.py`.
- **Transitional read side** — the deployed sweeps do not yet honor these flags: the
  engine's company list still defaults to the Sheet Companies tab
  (`HQ_COMPANIES_SOURCE=sheet` in `monitor/companysource.py`), and the sweep cursors and
  budgets for the wide lanes still live on the Sheet Config tab.
  `docs/plans/SHEET-INVENTORY.md` is the fact table. The UI states this honestly: the
  page ships "Your decisions and scan choices are recorded here. Discovery reads them
  later." — the flag is recorded, not yet consumed.

## Invariants

- Sweeping requires approval: `user_companies_monitor_needs_approval` is a CHECK, so no
  writer — browser or engine — can watch an unapproved company.
- Review state is a closed set; dismissed rows are kept, not deleted, so "Passed" is a
  recoverable answer.
- One board, one row; one unresolved placeholder per normalized name. Grounding may
  upgrade a placeholder but a collision never silently merges.
- A human-set domain (including blank-as-tombstone) is never overwritten by a bot
  (`0021_company_domain.sql`).
- Coverage claims are truthful counts over readable sources; no percentage, no recall
  claim, and no Sheet-derived number appears in the product.
- Who watches a company is private: `companies_visible_to_watchers`
  (`0002_invariants.sql`) shows catalog rows only to watchers, and shared facts carry no
  user association (`docs/pilot-launch/10-data-authority-and-transition.md` §2).
