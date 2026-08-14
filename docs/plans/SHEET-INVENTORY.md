# RM-12 inventory — every place the running product still touches a Sheet

Status: inventory only. No behaviour changed by the commit that introduces this file.
Method: read the code, not the plan. `docs/plans/SHEET-SUNSET.md` is the older map and
several of its rows are now stale; where the two disagree, this file is the fact and
that one is the intent.

**A grep-built inventory is not an inventory, and this one proved it twice.** The first
draft of the table below was assembled from `grep -rl core.sheets`. It was wrong in both
directions. It listed `monitor/priority.py` as dead code safe to delete — deleting it
broke `monitor/wide.py`, which imported two helpers from it, because a module can be
unreachable as a *lane* and load-bearing as a *library*. And it missed `core/outbox.py`,
`core/config.py:226` and `monitor/config.py:31` entirely, because each takes an `hq`
handle and drives tabs without ever naming `core.sheets`. Three false negatives and one
false positive in a list short enough to read in a minute. Anyone extending this file
should reach for the AST sweep in §7 rather than a pattern, and should treat "no
scheduled lane reaches it" as a statement about lanes, not about callers.

**And a deletion is not finished when the tests pass.** Moving those two helpers into
`monitor/wide.py`, the commit called it verbatim. It was not: `_TRUEISH` arrived as
`{"TRUE", "YES", "Y", "1", "X", "ON", "✓", "✔"}` where `monitor/priority.py` had
`("TRUE", "1", "YES")` — the wider set copied from `tracker/promote.py`, a different
module with a different truth question. `monitor/wide.py:578` builds the TheirStack
company fence from `priority_companies`, and with `wide_location_ids` unset an EMPTY
fence is the only thing that produces the `theirstack_skip` that buys nothing. So a
Companies row a human ticked `Y` or `✓` by hand would have turned a free skip into a
budgeted query, twice a day, unattended, on a 200-credit tier.

The whole `wide` suite stayed green, because its fixtures only ever use `"TRUE"` and
`""` — the truth-set axis was invisible, so correct and incorrect were the same colour.
An independent reviewer found it by mutation: restoring the ORIGINAL value left the
suite green, which is the signature of a test that cannot see the thing it covers.
`tests/monitor/test_wide.py::test_the_priority_flag_parse_is_the_monitors_and_only_the_monitors`
now pins the parse on both sides and drives the real sweep asserting no provider call.
When a helper moves, diff its constants, and check that something fails if you put the
old value back.

Classification used throughout:

- **(a) runtime** — a lane the running product executes; must be replaced before the
  credential can be revoked.
- **(b) historical** — one-time import/migration/bootstrap tooling; may remain, must be
  unreachable from any scheduled lane.
- **(c) dead** — nothing reaches it; delete.

## 1. The credential, and everything that holds it

There is exactly one Google credential in the system: `GOOGLE_SERVICE_ACCOUNT_JSON`,
read in one place — `core/sheets.py:55`, inside `_client()`. Every Sheet access in the
repository funnels through `core.sheets.HQ.open()`, which builds that client. There is
no second path, no cached token, no per-user Google credential.

Holders:

| Holder | Where | Class |
|---|---|---|
| AWS SSM `/job-hq/*` | loaded by `infra/app/handler.py:70 _load_secrets()` into the Lambda env | runtime |
| GitHub Actions secret | `.github/workflows/run-bot.yml:80` | runtime (dispatch only) |
| GitHub Actions secret | `.github/workflows/selfheal.yml:39,44` | runtime (the ONLY GitHub cron) |
| GitHub Actions secret | `.github/workflows/ci.yml:287,290,305,307,315,337,355,360` | operator dispatch — live-Sheet smoke/whoami/bootstrap/migrate/seed jobs, all `workflow_dispatch`-gated |
| `requirements.txt` | `gspread==6.2.1`, `google-auth==2.35.0` | runtime dependency |

The sheet id is separate and not a secret: `HQ_SHEET_ID` / `hq.config.yaml:sheet_id`,
resolved in `core/config.py:243` and validated in `monitor/config.py:51`.

**The web app holds nothing.** Every `sheet` hit under `webapp/` is either an XLSX
export sheet name (`webapp/app/api/export/route.ts:14,113`) or a comment explaining that
free-text statuses exist because the spreadsheet allowed them
(`webapp/lib/queries.ts:87`, `webapp/app/(app)/pipeline/actions.ts:104`). Revoking the
credential is invisible to the web app today.

## 2. Scheduled dispatch — what actually runs

`infra/app/handler.py:31 JOBS` is the one job registry; `infra/terraform/variables.tf:84
var.jobs` is the one schedule table. Eight lanes fire on EventBridge; a ninth,
`selfheal`, is the last GitHub Actions cron. Nine in total, on two schedulers.

| Schedule | Cron (UTC) | Modules | Touches Sheet | Class |
|---|---|---|---|---|
| `monitor` | `0 12,23 * * ?` | `monitor.run` → `monitor.pgmirror` | yes — `HQFeedStore` is the store | a |
| `review` | `0 15 * * ?` | `monitor.regate`, `monitor.review` | yes — `HQFeedStore` | a |
| `tracker` | `31 0/2 * * ?` | `tracker.promote`, `.quickadd`, `.scout`, `.stale`, `.join`, `.outbox` | yes — all six | a |
| `digest` | `40 11 * * ?` | `tracker.digest` | yes — Digest tab `sent_at` interlock, Config heartbeats | a |
| `snapshot` | `53 8 * * ?` | `tracker.snapshot` | yes — its entire product is tab CSVs | a, then c |
| `pgdump` | `13 9 * * ?` | `tracker.pgdump` | no — `pg_dump` of the public schema to S3; its beat lands in Postgres (`core.beats`) | — (sheet-free; survives revocation) |
| `wide_cafe` | `30 13 * * ?` | `monitor.wide --source cafe` | yes | a |
| `wide_theirstack` | `50 13 * * ?` | `monitor.wide --source theirstack` | yes | a |
| `selfheal` | `23 8 * * *` (GitHub Actions, `selfheal.yml`) | `tracker.selfheal` | yes — it re-asserts the Sheet schema | c after cutover |

Dispatch-only, never scheduled (`handler.JOBS`, no `var.jobs` entry): `seed_universe`,
`seed_pipeline`, `simplify`, `linkedin_backfill`. The first two are Sheet→Postgres
seeds — class (b) by intent, but they are reachable from the same Lambda as every
scheduled lane, which is the isolation gap RM-12's fourth exit criterion names.

**Every scheduled entrypoint except `pgdump` reaches a Sheet. `pgdump` is the one
sheet-free scheduled lane.**

A tenth clock exists outside AWS and Actions: the Gmail Apps Script's own triggers,
`appsscript/capture/Code.gs:107-111` — `runCapture` every 15 minutes, `sendDigest` daily
at 07:00, and an `onEdit` spreadsheet trigger. These write the Sheet through
`SpreadsheetApp` under Apps Script authorization, **not** the service account, so
revoking `GOOGLE_SERVICE_ACCOUNT_JSON` does not stop them. They are a separate
decommission.

`.github/workflows/pgdump.yml` is hard-disabled (the job unconditionally `exit 1`s,
`:32-35`; `PGDUMP_ENABLED` is deliberately ignored) per
`docs/pilot-launch/instances/PKT-DUMP-DISABLE.md`. `docs/SYSTEM.md:245` still describes
it as a nightly job gated on that variable, which is stale and contradicts the file —
one of the doc rows exit criterion five has to fix.

## 3. Per-module classification

### The seam that matters

`monitor/sheet.py:43` declares `SheetStore`, a 16-method `Protocol`. `HQFeedStore`
(`:64`) is the Sheet implementation and `FakeSheetStore` (`:365`) is the fixture
implementation the tests already run against. `monitor/run.py:120 run_monitor(store,
...)` is written entirely against the protocol. **This is the cutover seam for
discovery**: a `PgFeedStore` satisfying the same protocol replaces the Sheet for
`monitor.run`, `monitor.regate`, and `monitor.review` in one move, and the existing
fixture implementation already proves the protocol is substitutable.

### Already Postgres-only — nothing to do

`core/pg.py` (the PostgREST client), `core/pgwrites.py` (the switch), `core/beats.py`
(`channel_runs`, append-only, `LANES = snapshot|snapshot_s3|digest|pgdump`), and
`monitor/tagworker.py` (never touched a Sheet; store-agnostic plumbing). Each mentions
`core.sheets` in a docstring only.

### Class (c) — dead, delete

| Module | Why |
|---|---|
| `monitor/priority.py` | the retired hourly watch. No EventBridge schedule, no `handler.JOBS` entry, no `run-bot.yml` input. `infra/terraform/variables.tf:87` records that the second daily sweep replaced it. It still opened the spreadsheet at `:207` for anyone who ran it by hand. **Deleted on this branch**, with `tests/monitor/test_priority.py`. Its two helpers moved to `monitor/wide.py` — see the caution below, because that move went wrong. |
| `tracker/selfheal.py` | re-asserts tabs, headers, protections and re-pins gids. Migrations are the schema; this is meaningless without the spreadsheet. It is also the only GitHub cron left. |
| `tracker/bootstrap.py` | creates the spreadsheet. CI-dispatch only (`ci.yml:311`), never in `handler.JOBS`. `selfheal.py` imports its `assert_*` helpers, so the two die together. |

### Class (b) — historical, isolate

All three read the Sheet and write only Postgres. The Sheet is their input, never their
output, so each is a run-once-then-retire tool rather than a port.

| Module | Direction |
|---|---|
| `monitor/seed_universe.py:77` | Companies tab → `user_companies` |
| `tracker/pgseed.py:121` | Pipeline tab → `applications` via `hq_upsert_sheet_application` |
| `tracker/migrate.py` | legacy sheet / scout XLSX / applog → tabs. Sheet-era history import, hardcoded owner path at `:31-33`. This one writes the Sheet, so it is (b) only in the sense that its whole world disappears. |

The isolation gap: `seed_universe` and `seed_pipeline` are entries in `handler.JOBS`
(`:51`, `:56`), reachable by dispatching the same Lambda that runs every scheduled lane.
Exit criterion four is not met while that is true.

### Class (a) — runtime, must be replaced

**The seam.** `monitor/sheet.py` is the storage layer for the three discovery lanes.
Replacing it replaces `monitor/run.py`, `monitor/regate.py` and `monitor/review.py` at
once. Every one of those imports `core.sheets` lazily, inside `main()` — the sweep logic
is already store-agnostic.

| Module | What it needs from the Sheet | Postgres equivalent today |
|---|---|---|
| `monitor/sheet.py` | the whole 16-method protocol: feed history, companies, min_yoe, sweep cursor, health, tags, disposition, `seeded`, `pushed_at` | `monitor/pgstore.py:PgFeedStore` covers 15 of the 16; `write_health` has no Postgres home and persists nothing |
| `monitor/feedstore.py` | nothing directly — but its `HQ_FEED_STORE=sheet` arm (the DEFAULT) constructs `HQFeedStore`, so it is a Sheet dependency until the default flips | `HQ_FEED_STORE=pg` selects `PgFeedStore` and never opens the spreadsheet for the sweep's data |
| `monitor/run.py` | via `HQFeedStore`; also `hq.user_config()` `:396`, `hq.heartbeat("monitor")` `:423` | **dual write** — `mirror_pg` `:353-381` under `first_class` |
| `monitor/review.py` | tag writes, `mark_untaggable`, `set_disposition`, `fill_missing_geo` | none; tags reach pg only as the `postings.tags` blob on the next mirror |
| `monitor/regate.py` | `fill_missing_geo`, `set_disposition` | none; `user_postings.disposition` is echoed, never computed, pg-side |
| `monitor/wide.py` | Config cursors/budgets `:207-218`, Feed append `:612`, ~15 `hq.log` calls, heartbeats | partial — LinkedIn/domain enrichment already goes to pg `:363-397` |
| `monitor/linkedin_backfill.py` | Config cursor + budget cell, `hq.log` | **payload already pg-only** (`pg.rpc` `:332`, `:365`); only the cursor is stranded |
| `monitor/companysource.py` | `HQ_COMPANIES_SOURCE`, default `sheet`; the `pg` branch still calls `store.read_companies()` on its empty-universe guard | the switch itself is the mirror path. Coupled to the `SheetStore` *protocol*, never to `HQ` — so the containment guard in §7 does not see it, which is called out there rather than papered over |
| `core/outbox.py` + `tracker/outbox.py` | the Outbox tab is the quiet-hours queue | **none** — no queue table or RPC exists |
| `tracker/join.py` | Email Events + Pipeline tabs, Config `heartbeat_capture` latch | **dual write** — `hq_apply_email_event` `:271-287`, passing the Sheet's `status`/`status_actor` as `p_current_*` so pg's lock honours the Sheet's human claim |
| `tracker/digest.py` | six tab reads for content, Digest tab `sent_at`, Config beats | **CORRECTED — see §3.1.** Four of the six reads need no migration; `scout_daily` stays a Sheet read while its writer runs; only the `sent_at` latch needs schema |
| `tracker/snapshot.py` | every tab via `hq.tab(l).ws.get_all_values()` `:78` | **dual write on beats only** `:119`; the CSVs' replacement is the EventBridge `pgdump` lane (`tracker.pgdump`, daily to the versioned S3 bucket, #148) — live. Only the Actions workflow `pgdump.yml` is disabled, by design, as incident evidence (`PKT-DUMP-DISABLE.md`); do not touch it |
| `tracker/promote.py` | Feed `interested` → Pipeline, `promoted_at` latch | none engine-side; the web app's triage is the analogue |
| `tracker/quickadd.py` | Quick Add tab → Pipeline | none engine-side; the web app's add/paste is the analogue |
| `tracker/stale.py` | Pipeline `stale` flag | **CORRECTED — see §3.1.** `stale` is a derivation, not a fact; `applications` already holds both its inputs and must NOT get a column |
| `tracker/scout.py` | the scout's own tabs | none — no scout tables in `db/migrations`. **It still RUNS and still writes `scout_daily` nightly**, which is why `tracker/digest.py` keeps reading that tab rather than dropping the section: parking a reader while its writer runs is §6's ordering rule backwards, and costs the owner information that still exists |
| `tracker/simplify.py` | Config alert latch, Pipeline writes | none. Dispatch-only and currently unusable (cookies not in SSM) |
| `core/fakes.py` | fakes the gspread layer under a real `HQ`/`Tab` | test-only; dies with `core/sheets.py`, and ~25 test files with it |
| `core/config.py:243`, `monitor/config.py:51` | `sheet_id` resolution and its fail-loud refusal | — |

### 3.1 Corrections — two rows above overstated the remaining work

Measured by reading `tracker/digest.py` against `db/migrations/**` rather than by
reading this file. The full workings are in `docs/plans/DIGEST-PG-SOURCES.md`; both
corrections are recorded HERE because this is the document the next agent budgets from,
and in both places it was budgeting for schema that does not need to exist.

**Correction 1 — `stale` is a derivation, not a fact, and must not become a column.**

The row above read "none — no `stale` column pg-side", which is true and is not a gap.
`tracker/stale.py` does not *store* staleness; it recomputes it every two hours from
`status` and `last_activity` and writes the result into a cell. Both inputs are already
columns on `applications` (`0001_init.sql:153`, `:159`), and `core.schema.STATUS_ORDER`
supplies the scope. A reader recomputes the flag in four lines.

Recomputing is not merely *adequate*, it is better than the column would be: the cell is
only as fresh as the last `tracker.stale` run, while a computed flag is correct at digest
time. And adding `applications.stale` would create **a second writer of a derived value**
— re-importing, into the store meant to fix it, exactly the staleness the cell has. So
this is a schema item that should be struck rather than scheduled.

The Sheet writer in `tracker/stale.py` stays; §6 forbids removing it. What changes is
that nothing downstream has to wait for a migration to stop reading its output.

**Correction 2 — `bot_runs` already answers the heartbeat question, better than Config
does, and nothing reads it.**

The `HQ.heartbeat` row below says only the four lanes in `core.beats.LANES` have a
Postgres home. That undercounts. `public.bot_runs` (`0023_bot_runs.sql`) carries one row
per Lambda invocation — `job`, `started_at`, `finished_at`, `ok` — written by
`core/runlog.py` for every entry in `infra/app/handler.py:JOBS`. Five of the nine lanes
the digest watchdog watches map straight onto it:

| Watched lane | `bot_runs.job` |
|---|---|
| `monitor` | `monitor` |
| `review` | `review` |
| `tracker` | `tracker` |
| `cafe` | `wide_cafe` |
| `theirstack` | `wide_theirstack` |

It is also **stronger evidence than the cell it replaces**, which is the part worth
carrying forward: a Config stamp says something wrote a timestamp, while a `bot_runs` row
filtered on `ok = true` says the job SUCCEEDED. A lane failing on every invocation
refreshes its Config stamp each run and reads healthy on the tab; it goes stale in
`bot_runs` and warns. Widening `core.beats.LANES` would have been the wrong fix, and
`0023_bot_runs.sql` argues why at length — `channel_runs` is the discovery ledger at a
different grain, and `core.beats` already writes `digest` and `snapshot` rows into it as
heartbeats, so a job row there would collide with the lane the watchdog reads.

Four lanes stay Sheet-sourced and every one is correct: `capture` is the Apps Script
tripwire and never reaches the Lambda; `selfheal` is the Actions cron and never reaches
`handler.py` — and is one of the Sheet's only two backups, so §6 forbids dropping its
read while the Sheet is authoritative; and `snapshot`/`snapshot_s3` cannot be told apart
by `bot_runs`, which records the invocation and not the mode, so `core.beats` over
`channel_runs` remains right for that pair.

**LANDED**: `tracker/digest.py`'s watchdog now reads exactly those five from `bot_runs`
(`core.runlog.last_ok`, `ok = true` only, `JOB_BEATS` is the mapping table) under
`HQ_PG_WRITES=first_class` — the flag state under which the watchdog already reads the
store's own beats. Under `mirror` the Config stamps remain the read source, and the
stamp writers stay everywhere per §6. When the store is unreachable at digest time the
five are unwatched and the briefing's paging line names them — never stamp-judged,
because a fresh stamp vouching for a failing job is the silent green the cutover ends.

**Both corrections are the same shape, and it is now the third instance in this codebase:
the Postgres home exists and nothing reads it.** That is worth treating as the default
hypothesis rather than the surprise. Before designing schema for a Sheet read, check
whether a table already answers the question — this file has now been wrong in that
direction three times, and every time the fix was a reader.

### Cross-cutting facilities with no Postgres home

These are what make the remaining rows hard, and none of them is a single module:

- **The Config tab** — knobs, sweep cursors, spend budgets and alert latches, read by
  `wide.py`, `linkedin_backfill.py`, `sheet.py`, `join.py`, `simplify.py`, `digest.py`.
- **`HQ.log`** — the line-item audit. `bot_runs` and `channel_runs` record runs, not
  lines.
- **`HQ.heartbeat`** — roughly ten lanes beat into Config. Four have a home in
  `core.beats.LANES`, and **five more are read from `bot_runs` by the digest watchdog
  under `first_class`** — see §3.1, correction 2, LANDED. `capture` and `selfheal` are
  the two with neither, and both for reasons that are correct rather than pending.
- **The Health, Digest, Quick Add, Outbox and Scout tabs** — no table, no RPC, no
  fixture.

## 4. Dual-write, mirror and rollback paths present today

All of these are what exit criterion three forbids, and all are live code:

1. `core/pgwrites.py` — the `HQ_PG_WRITES` two-value switch. `MIRROR` (the default)
   *is* the Sheet-authoritative mode. The whole module exists to keep both stores.
2. `monitor/pgmirror.py` — the Feed→Postgres echo, run as the tail of the `monitor` job.
   Note the direction: the module named for the Postgres side is *itself a Sheet reader*
   (`:175-176` `HQ.open()`). Its input is the Sheet, so it does not survive the Sheet.
3. `monitor/companysource.py` — the `HQ_COMPANIES_SOURCE` read switch, defaulting to
   `sheet`, with a per-sweep Sheet-vs-Postgres delta log.
4. `tracker/join.py` — decides against BOTH stores' status and claim.
5. `tracker/digest.py` — the digest watchdog reads beats from both stores and holds each
   to its cadence separately.
6. `tracker/snapshot.py` — the Sheet's independent backup lane, deliberately twinned
   with the git lane.
7. `appsscript/capture` — the Gmail script appends to the tab FIRST and POSTs to
   `/api/capture` second, with a local retry queue.

## 5. Blockers that are not this branch's to remove

**Schema, and it is not one migration.** `postings` (`db/migrations/0001_init.sql:90`)
and `user_postings` (`:121`) have no home for the state `HQFeedStore` carries: the sweep
cursor (`read/write_sweep_cursor`), per-company seeded state (`mark_seeded`), the push
latch (`mark_pushed`), the per-company `min_yoe` map (`read_min_yoe`), and the Health
rows (`write_health`). Beyond that seam, the cross-cutting facilities above each need a
home too — an engine settings/cursor store, a notification queue for the Outbox, a
line-item audit for `HQ.log`, and beats for the lanes `core.beats.LANES` omits — of
which **five need no schema at all**, being answerable from `bot_runs` (§3.1), leaving
`capture` and `selfheal`, whose absence is correct rather than pending.

None of that can be written here. Migrations are append-only and integrated serially by
one integrator, and that role is held on another branch. **This is a stop-and-ask.**

**Gmail capture.** `tracker/join.py` reads the Email Events tab. The Postgres copy
(`public.email_events`, migration 0018) has no reader. Cutting `join` over is a
data-source flip that the RM-12 exclusion for Gmail ingestion does not obviously cover;
it needs a decision, not an implementation.

**The scout.** `tracker/scout.py` is a second human's entire working surface. Removing
it is an onboarding conversation, not a refactor — SHEET-SUNSET §4 already says so.

## 6. Why the cutover order is not free choice

Working from smallest blast radius upward runs into a wall almost immediately, and it
is worth naming rather than discovering twice:

- The Sheet is still authoritative for discovery (`HQ_COMPANIES_SOURCE` defaults to
  `sheet`, `HQ_PG_WRITES` defaults to `mirror`).
- Discovery cannot move until a `PgFeedStore` exists, which needs schema this branch
  may not author.
- **No Sheet writer may be removed while the Sheet is authoritative**, and that
  includes the two backup lanes. `tracker/snapshot.py` and `selfheal.yml` are the only
  copies of a store the product still depends on. The Postgres backup that replaces
  them after cutover is live — the EventBridge `pgdump` lane (`tracker.pgdump`,
  daily to the versioned S3 bucket, #148); only the Actions workflow `pgdump.yml`
  is disabled, by design, as incident evidence. But that lane dumps the *store*,
  not the Sheet, so while the Sheet is authoritative it backs up the mirror and
  the constraint stands unchanged.

So the removals available before the migration lands are exactly: dead code, doc
accuracy, and enforcement. Everything else is downstream of one schema decision.

### The ordering rule, stated so it cannot be misread later

**"Cut over" does not mean "delete the writer."** A lane is cut over when the Postgres
path carries its traffic and a test proves the lane cannot silently fall back. The Sheet
writer comes out in a **later** commit, after the export in §8 step 1.

The reason is not tidiness. Until discovery moves, the Sheet is the authoritative store,
and `tracker/snapshot.py` plus `selfheal.yml` are its only two backups. The Postgres
backup lane is live (EventBridge `tracker.pgdump`, daily to the versioned S3 bucket,
#148 — the Actions `pgdump.yml` stub stays disabled by design, as incident evidence),
but it copies the store, not the Sheet. Deleting a Sheet
writer early does not just remove a legacy path; on those two modules it removes the only
copies of live data. Any future packet that proposes removing a writer must first say
which store is authoritative for that data on the day the change lands.

## 7. What is enforced by a machine

`tests/core/test_sheet_containment.py` turns this inventory into a check. It sweeps
`core`, `monitor`, `tracker`, `scripts`, `infra` and `users` with an AST walk (comments
and docstrings citing the durability contract are not dependencies) and fails when the
set of modules that import `core.sheets`/`monitor.sheet` **or** drive an `hq` handle
differs from the list in either direction:

- a new entry is a forbidden new Sheet dependency;
- a vanished entry is a cutover that must be recorded in the diff that performed it.

Two narrower guards ride along: `GOOGLE_SERVICE_ACCOUNT_JSON` is read in exactly one
place, and the web app holds no Google credential.

The `hq`-handle half is not decoration. An import-only sweep called `core/outbox.py`
clean — it takes an `hq` and drives the Outbox tab without ever naming `core.sheets` —
and it also missed `core/config.py:226` and `monitor/config.py:31`, both of which the
hand-written inventory had missed too. The check found three rows the reading did not.

Named limitation: a module coupled to the `SheetStore` protocol rather than to `HQ` is
invisible to it. `monitor/companysource.py` is the live case.

Mutations run, each observed red then restored:

| Mutation | Result |
|---|---|
| `hq.tab("feed").records()` added to `core/jobkeys.py` | fails, naming `core/jobkeys.py` as a new dependency |
| a second `GOOGLE_SERVICE_ACCOUNT_JSON` read added to `core/pg.py` | fails, naming `core/pg.py` |
| `monitor/priority.py` deleted while still listed | fails on the removal branch, demanding the inventory be updated in the same commit |

## 8. Revocation order (prepared, NOT performed)

Revoking the credential is an owner action with an external side effect. When every
runtime row above is class (b) or (c), the order is:

1. Export and archive the live Sheet — every tab to CSV, into the encrypted backup lane,
   with a recorded digest. `tracker/snapshot.py` can do this one last time before it is
   deleted.
2. Remove `snapshot` and `selfheal` from the schedules
   (`infra/terraform/variables.tf:84`, `.github/workflows/selfheal.yml`) and apply.
   These two write to the Sheet; they must stop before the credential does, or the first
   post-revocation run is a page.
3. Delete `GOOGLE_SERVICE_ACCOUNT_JSON` from the GitHub repository secrets. Confirm
   `run-bot.yml`, `selfheal.yml`, and the `ci.yml` dispatch jobs no longer reference it.
4. Delete the SSM parameter under `/job-hq/`. Confirm `_load_secrets()` no longer
   populates it and no lane reads it.
5. Watch one full cycle of every schedule in §2 — the longest is 24 h, so 48 h covers
   two of each — with the ops topic armed. A lane that needed the Sheet fails loud here,
   which is the point of doing this step before step 6.
6. Remove the service account's editor access on the spreadsheet in Google Workspace,
   then disable the service account itself. This is the irreversible step and the first
   one that cannot be undone by re-adding a secret.
7. Remove `gspread` and `google-auth` from `requirements.txt` and rebuild the image.

Steps 1–5 are reversible. Step 6 is the point of no return and is owner-performed.

### Three things land BEFORE the Config tab is retired

Ordering rules, not schema questions, and they sit here because this is what the person
doing the retiring is reading. Each is a thing the Sheet holds today that Postgres does
not, so retiring the tab first is silent data loss rather than a broken build.

**1. The 13 notification preference keys — TEN of them are now homed.**
`20260814_021627_notification_prefs.sql` (authored on #181's `feat/notification-prefs`,
re-stamped per its disposition when the notifications lane resumed) adds them as typed
columns on `profiles` with CHECK constraints and one definer RPC, and
`tests/db/test_notification_prefs.py` accepts it. `profiles.notify` was never the home it
looked like — an empty jsonb column with a prose comment and no writer — and its comment
now says so.

Three of the thirteen did not become columns, and the person retiring the tab needs both
halves of that sentence:

- `push_status_events` and `digest_hour_ct` were **retired for having no reader**.
  `push_status_events` is parsed onto `RuntimeConfig` and read by nothing, so the switch
  its help text describes has never worked; `notify_status_change = none` is the one that
  does. `digest_hour_ct` was superseded by the EventBridge cron. Carrying dead
  configuration into the new schema is how the Sheet's mess outlives the Sheet.
- **`dna_companies` IS STILL HOMELESS and it still gates this step.** It has a live reader
  (`tracker/scout.py:86`) and it is not a notification preference — it is the scout's
  do-not-apply guard, and its home is `profiles.criteria`, which needs a `parseCriteria`
  whitelist entry and no migration. Retire the tab before that lands and a user loses the
  list of companies they asked never to be applied to.

`SHEET-FACILITIES.md` §1.2(a2′) is the key-by-key enumeration all of this came from.

**What the migration deliberately does NOT do: the engine does not read these columns
yet.** While the Sheet is authoritative, a `profiles`-backed `UserConfig` would be a second
read path — the dual read §4 lists and §6 orders against. The reader lands in the commit
that flips the authority, and until it does, the columns exist and nothing consults them.

`notify_quiet_hours` and `notify_timezone` are the inputs to `core.channels.allow()`, the
function that decides what enters the quiet-hours outbox. Because the engine still reads
the SHEET, retiring the tab before the reader flips would still leave quiet hours with no
window and no zone: either it never engages and someone is buzzed at 03:00, or it engages
against a default zone and holds an interview notification until the wrong morning.
`push_new_jobs` is worse in kind — a kill switch the user set that silently turns itself
back on. (`push_status_events` used to be listed beside it; the re-measurement found that
switch has never worked at all, which is why it was retired rather than homed.)

`docs/plans/SHEET-FACILITIES.md` §1.2(a2′) has the full accounting. An earlier revision of
that document declared this half already homed; it was wrong, and this rule exists because
a wrong "already homed" verdict is exactly the failure that reaches production quietly.

**2. The two spend budgets need an override path.** `wide_credit_budget = 0` is
TheirStack's kill switch and `core/config.py` has no env-override path for a `VALIDATORS`
key — the Config tab is the only override that exists today. SHEET-FACILITIES §1.2(c).

**3. The capture tripwire — retired before the Config tab, never after**

An ordering rule, not a schema question, and it sits here because this is what the person
doing the retiring is reading.

`heartbeat_capture` is the tightest-watched beat in the system — 1.5 h cadence,
`tracker/digest.py:64`, and a 3 h ops page from `tracker/join.py:371` — because it is the
tripwire for Gmail capture having died silently. It is also the ONE beat with no Postgres
home and no route to one: `appsscript/capture/Code.gs` writes it through `SpreadsheetApp`
under Apps Script authorization, so it corresponds to no Lambda invocation and will never
have a `bot_runs` row. `docs/plans/SHEET-FACILITIES.md` §4.4 has the derivation.

So: **either `heartbeat_capture` has a replacement that a watchdog reads, or there is a
recorded, dated decision to accept the gap and stop watching. One of those two lands
BEFORE the Config tab is retired.** Neither is "we will sort it out afterwards."

The failure mode is a silent week. A tripwire that has quietly stopped being read is worse
than one that was deliberately removed, because the health section keeps looking green —
which is the same defect class as a beat nobody watches (`core/beats.py:24`, "A beat
nobody watches is worse than no beat — it looks like coverage"), arriving from the other
direction.

The cheap replacement, if it is wanted: `/api/capture` already authenticates the Apps
Script through `capture_tokens` (0018), so a beat is a field on a request that is already
being made — a `channel_runs` row with `channel = 'capture'`, which `core/beats.py` and
`tracker/digest.py` already know how to watch. A change to an endpoint's contract, not a
table.
