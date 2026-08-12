# Job HQ

A multi-user job-search product: one web app over one Postgres. Users track companies,
jobs, and applications; discovery bots keep the job feed fresh; the app is the only
human surface. Postgres (Supabase) is authoritative for product data, object storage
for files and evidence. Manual application status is authoritative — nothing mutates
it behind the user's back.

**Stack:** Next.js 15 + React 19 (`webapp/`), Supabase (Postgres, Auth, RLS, Storage),
Vercel. Python workers for discovery, rendering, and monitoring run behind Postgres
(AWS Lambda + EventBridge, `infra/`). Migrations are append-only SQL in
`db/migrations/`, applied deliberately via the `db-apply` workflow — never on merge.

## The map

| Where | What |
|---|---|
| `webapp/` | the product — every user-facing surface |
| `db/migrations/` | the schema, append-only, stamped by `scripts/new-migration.sh` |
| `docs/specs/` | living capability specs — the current truth per entity |
| `docs/pilot-launch/` | the product contract and requirements register |
| `core/`, `monitor/`, `infra/` | Python workers: discovery adapters, render, monitor |
| `tracker/`, `appsscript/` | **legacy, quarantined** — see below |
| `.github/workflows/` | CI, deliberate DB apply, nightly ops lanes, alerts |

## Working here

Work is tracked as GitHub issues (the feature-spec template is the working unit;
tier labels `t0`–`t4` set rigor per CLAUDE.md). Branch, PR, CI. `main` is protected:
required checks must pass and nobody — admin included — merges red. Merging via
`scripts/land.sh` adds local gates and verifies the landing. Vercel deploys `main`
automatically; database changes never ride along.

The daily dev loop needs no Docker:

```sh
cd webapp && npm run demo    # the app on fixtures
npx vitest                   # unit
npx playwright test <spec>   # targeted browser proof
```

Before claiming done, run the change-scoped lane; before a release, the full one
(both run inside the prebuilt image — `infra/test-image/build.sh` once):

```sh
scripts/verify.sh --image           # suites this diff can break
scripts/verify.sh --full --image    # everything, incl. tests/db on real Postgres
```

The plain pytest line (`uv run --python 3.11 --with-requirements requirements.txt
--no-project -- pytest`) skips `tests/db/**` and says so loudly; a full-gate claim
requires the database too. See CLAUDE.md for the tier table and the merge rules.

## The legacy lane (do not extend)

Job HQ began as the owner's personal system with a Google Sheet as its cockpit. That
era is ending capability-by-capability under `docs/plans/SHEET-SUNSET.md` (owner
decision 2026-07-27: everyone runs on Postgres through the web app). Until each
capability's cutover lands, the legacy lane still runs nightly — self-heal, CSV
snapshots (to the `snapshots` branch, never `main`), digest, Gmail capture — so
`tracker/` and `appsscript/` are operational but frozen: repairs preserve the
`core.sheets.Tab` safety contract; new behavior lands in the webapp/Supabase world
only. `docs/plans/SHEET-INVENTORY.md` is the authoritative fact table for what still
reads the Sheet.

## Ops

`.github/workflows/red-main.yml` pages the ops ntfy topic when `main` concludes red —
fixing that precedes everything else. Nightly Postgres backups go to versioned S3
(`pgdump` lane). Deployment is continuous for the webapp and deliberate for the
database; both refuse to run over red CI.

## Docs

- **[CLAUDE.md](CLAUDE.md)** — the operating rules: authority, tiers, verification, safety.
- **[docs/SYSTEM.md](docs/SYSTEM.md)** — generated system map: schedules, jobs, alerts.
- **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — failure modes: symptom → cause → fix.
- **[docs/pilot-launch/README.md](docs/pilot-launch/README.md)** — the pilot contract corpus.
- **[docs/plans/SHEET-SUNSET.md](docs/plans/SHEET-SUNSET.md)** — the legacy exit map.
