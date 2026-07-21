# Phase 6 — Import, column mapping, batch undo, and the Excel round trip

Covers `docs/PRODUCT-SPEC.md` **B2** (import), **E** (round-trip re-import),
**G12** (2,000 rows: chunked, resumable, batch-atomic), **G13** (engine-owned
columns re-import as a report, never a silent drop).
Discharges acceptance criteria **20, 21, 23**.

Read `docs/WEBAPP-BUILD.md` first. Everything there is settled; this plan adds
to it and does not re-open it.

---

## 0. Ledger: what exists, what does not

Verified by reading the files on 2026-07-21. Nothing below is assumed.

**Exists and will be built on:**

| Thing | Path | Note |
|---|---|---|
| `DataSource` interface | `webapp/lib/data/source.ts` | 5 methods; import adds to it |
| Fixture implementation | `webapp/lib/data/fixture-source.ts` | models conflict, idempotency, `failNextWrite()` |
| Supabase implementation | `webapp/lib/data/supabase-source.ts` | `setTriage` calls `rpc("app_set_triage", …)` |
| View models | `webapp/lib/data/view-models.ts` | `ApplicationView` is the import target shape |
| Export columns / CSV writer | `webapp/lib/export/columns.ts`, `webapp/lib/export/delimited.ts` | `APPLICATION_COLUMNS` is the round-trip base |
| Canonical key logic | `core/jobkeys.py` | `job_key()`, `is_strong()` — Python only |
| Status vocabulary | `core/schema.py:103-150` (`STATUS_ORDER`, `STATUS_TERMINAL`, `status_rank`) | duplicated already in `webapp/lib/queries.ts:63` |
| Foreign-vocabulary precedent | `tracker/simplify.py:40-46` (`STATUS_NAMES`/`CREATE_STATUS`/`SUGGEST_STATUS`) | the existing "their words → ours" table |
| Schema + RLS | `db/migrations/0001_init.sql`, `0002_invariants.sql` | browser has **no** insert/update policy |
| Manual-row dedup index | `db/migrations/0002_invariants.sql:54-56` | unique on `(user_id, lower(company), lower(title)) where posting_key is null` |

**Does not exist — must be created:**

- `import_batches`, `import_rows`, `import_column_reports` tables, and every
  `app_import_*` function. → migration `db/migrations/0003_import.sql`.
- Any `/import` route. `webapp/app/(app)/nav-links.tsx:8-18` links `/jobs`,
  `/add`, `/settings` — **none of those directories exist either**; only
  `queue/`, `pipeline/`, `health/` do. Import adds `/import`.
- Any TypeScript port of `job_key` / `is_strong`. **This is the load-bearing
  gap**: the whole dedup story keys on it.
- Any XLSX *reader*. `write-excel-file` 4.1.1 is a writer only.
- **`app_set_triage` itself does not exist in `db/migrations/`** —
  `supabase-source.ts:161` calls an RPC that no migration creates. Do not
  repeat that: migration 0003 must ship every function this phase calls, and
  the reviewer should grep for `rpc("` vs `create function` before merging.

---

## 1. Library decision — the XLSX reader

**Chosen: `read-excel-file@9.3.4`, pinned exactly. Plus `papaparse@5.5.4` for
CSV/paste.**

`xlsx` (SheetJS) is banned by `docs/WEBAPP-BUILD.md` and stays banned. Verified
live on npm **2026-07-21**: `npm view xlsx version` → `0.18.5`, unchanged since
2022, CVE-2023-30533 (prototype pollution). `node-xlsx@0.24.0` is disqualified
by transitivity — it depends on an off-registry tarball,
`https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz`, which is both SheetJS
and un-auditable by `npm audit`.

What was verified, and how, on 2026-07-21 (probe under `/tmp/xlsxprobe`, all
run against a real install):

| Check | Result |
|---|---|
| `npm view read-excel-file version time` | `9.3.4`, published 2026-07-21T12:48Z; 7 releases since 2026-06-07 |
| Author | `catamphetamine` — **the same author as `write-excel-file` 4.1.1**, already in `webapp/package.json:39` |
| License / deps | MIT; `fflate`, `unzipper-esm`, `saxen` (3 deps, no SheetJS) |
| `npm audit` on a clean install of reader + writer + papaparse | **0 vulnerabilities**, 8 packages |
| Round trip | wrote a sheet with the writer, read it back with `read-excel-file/node` — values, embedded comma, and a `type: Date` cell all survived |
| Input types | `string | Stream | Blob | Buffer` (`node/input.d.ts`) — a `Buffer` from a `FormData` upload works |

`exceljs@4.4.0` was the alternative: MIT, no advisories, but last published
2024-12-20 and pulls 9 dependencies including `unzipper@0.10` and `archiver`.
Rejected on surface area — we need a reader, not a workbook engine.

**API facts that will bite whoever writes the code (v9 is not the v5 the
internet remembers):**

- Default export returns **all sheets**: `[{ sheet: "Sheet1", data: Row[][] }]`
  — not `Row[][]`. `getSheets: true` no longer means anything different.
- `readSheet(input, { sheet })` is the named export returning `Row[][]`.
- `parseSheetData(data, schema)` returns `{ objects }` or `{ errors }`, and
  `schema` is an **object keyed by output property** (`{ company: { column:
  "Company", type: String } }`). An array-of-entries schema silently produces
  index-keyed objects — observed in the probe. **We will not use it.** Our
  mapping is user-chosen at runtime, so we map raw `Row[][]` ourselves and keep
  every coercion in our own tested code.

**Writer limits, verified by unzipping the emitted `.xlsx`** — these constrain
section E:

- `stickyRowsCount: 1` → real `<pane state="frozen">`. Frozen header ✅.
- `SheetOptionsColumn` (`types/SheetOptions.d.ts`) has **only `width`**. There
  is no `hidden` and no autofilter option. `{ width: 0 }` is *silently
  dropped* — the emitted `<cols>` contained no entry for that column at all.
- Therefore **"hidden `hq_id`/`hq_version`" is not achievable** with this
  writer. Decision: emit them as the **last two columns**, always, with a
  header comment row nowhere (flat data stays flat). Section E's word "hidden"
  becomes "trailing and machine-owned". If a user deletes them, re-import
  degrades to `job_key` matching instead of failing — and that degradation is
  matrix row 40, with a test.

Add to `webapp/package.json`: `"read-excel-file": "9.3.4"`,
`"papaparse": "5.5.4"`, `"@types/papaparse": "5.3.16"` (dev). Exact pins, no
caret: the reader shipped 7 releases in 6 weeks, which is healthy maintenance
and an unpinned range waiting to break a build.

---

## 2. Where the work happens

**Upload is a Route Handler, not a server action.** Verified in the installed
Next 15.5.20: `node_modules/next/dist/server/app-render/action-handler.js:531`
defaults `bodySizeLimit` to 1 MB and throws `ApiError(413)` past it. A 2,000-row
xlsx exceeds that. New file: `webapp/app/api/import/upload/route.ts`.

**Parsing happens on the server, once.** The browser never parses the file and
never holds the working set. Bytes land in `import_rows` on upload; every later
step (mapping, preview, commit, resume) reads from Postgres. That is what makes
G12 "resumable" true rather than aspirational — close the tab mid-import and the
batch is still there.

**Writes still never come from the browser.** Every mutating step is a server
action calling exactly one Postgres function that writes rows *and* their
`events` in one transaction, carrying an idempotency key and the
`expectedUpdatedAt` it read — identical contract to
`webapp/app/(app)/queue/actions.ts`.

---

## 3. Migration `db/migrations/0003_import.sql`

```sql
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  -- A4 lists uploaded|mapped|previewed|committed|rolled_back. Two more are
  -- required by reality: a batch that is mid-commit is not "previewed", and a
  -- batch that died is not "committed". Silence about either is how a
  -- half-imported spreadsheet looks identical to a finished one.
  state text not null default 'uploaded'
        check (state in ('uploaded','mapped','previewed','committing',
                         'committed','rolled_back','failed')),
  filename text not null default '',
  source_kind text not null check (source_kind in ('xlsx','csv','paste')),
  row_count integer not null default 0,
  committed_count integer not null default 0,
  -- {"headers":[...], "columnMap":{...}, "statusMap":{...}, "roundTrip":bool}
  mapping jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  -- Undo window. Read from the row, never from the client's clock.
  undo_expires_at timestamptz,
  unique (user_id, idempotency_key)
);

create table public.import_rows (
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  row_number integer not null,              -- 1-based source row, for the report
  raw jsonb not null,                       -- the source cells, verbatim, forever
  mapped jsonb not null default '{}'::jsonb,-- after column + status mapping
  job_key text not null default '',
  key_strength text not null default 'none'
        check (key_strength in ('strong','weak','none')),
  match_kind text not null default 'new'
        check (match_kind in ('new','matches-existing','suggestion','unkeyable',
                              'round-trip','duplicate-in-file')),
  matched_application_id bigint references public.applications (id) on delete set null,
  conflict_state text not null default 'none'
        check (conflict_state in ('none','unresolved','resolved')),
  conflict jsonb not null default '{}'::jsonb,   -- per-cell {col:{mine,theirs,chosen}}
  outcome text not null default 'pending'
        check (outcome in ('pending','created','updated','skipped','failed')),
  error text not null default '',
  primary key (batch_id, row_number)
);

create table public.import_column_reports (
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  column_name text not null,
  disposition text not null
        check (disposition in ('imported','read-only','unmapped','unknown-column')),
  rows_affected integer not null default 0,
  sample jsonb not null default '[]'::jsonb,     -- ≤3 examples, for the report UI
  primary key (batch_id, column_name)
);

create index import_rows_pending on public.import_rows (batch_id, outcome);
alter table public.applications
  add column if not exists import_batch_id uuid references public.import_batches (id);
create index applications_import_batch on public.applications (import_batch_id);
```

RLS: `select` policies scoped `user_id = auth.uid()` on all three, matching
`0002`. **No insert/update/delete policies**, same as every other table.

Functions (all `security definer`, all append to `events`):

| Function | Contract |
|---|---|
| `app_import_stage(p_batch, p_rows jsonb, p_idem)` | bulk-inserts `import_rows`; idempotent on `(batch, row_number)` |
| `app_import_set_mapping(p_batch, p_mapping, p_expected_updated_at)` | writes `mapping`, recomputes `mapped`/`job_key`/`key_strength`, state → `mapped` |
| `app_import_preview(p_batch)` | computes `match_kind` + `conflict_state` for every row against live `applications`; state → `previewed`. Read-only w.r.t. `applications` |
| `app_import_commit_chunk(p_batch, p_limit int default 200, p_idem)` | commits ≤N `pending` rows in **one transaction**; returns `{committed, remaining}`; **raises if any row in the batch has `conflict_state='unresolved'`** (AC 23) |
| `app_import_resolve(p_batch, p_row, p_choices jsonb)` | records per-cell choices, `conflict_state` → `resolved` |
| `app_import_undo(p_batch, p_idem)` | deletes rows this batch created, reverts rows it updated from the `events` payload, state → `rolled_back`. Refuses past `undo_expires_at` |

**Atomicity, stated precisely** (G12 says "chunked, resumable, batch-atomic" —
those pull against each other, so pick and write down the resolution):
*each chunk is a transaction; the batch is atomic by virtue of being
reversible.* A single 2,000-row transaction invites a statement timeout and
gives back nothing when it hits one. Chunks of 200 always make progress,
`committed_count` is the resume cursor, and `app_import_undo` is what makes a
half-committed batch recoverable in one gesture. Say this in the UI too: the
progress bar shows `committed_count / row_count` and the Undo button is live
from the first committed chunk.

`app_import_commit_chunk` must `insert … on conflict do nothing` and count the
misses as `outcome='skipped'`. Reason: `0002_invariants.sql:54-56` puts a unique
index on `(user_id, lower(company), lower(title)) where posting_key is null`,
and most imported rows have no `posting_key`. Without `on conflict`, one
repeated company+title aborts a 200-row chunk and wedges the batch. This is the
mechanism behind AC 20 (re-run adds zero) as much as the key matching is.

---

## 4. The pipeline, stage by stage

### 4.1 `job_key` in TypeScript — do this first

New: `webapp/lib/import/job-key.ts`, a direct port of `core/jobkeys.py`
(14 ATS patterns, the icims two-group case, the `norm-`/`url-` fallbacks,
`isStrong()`).

Drift between the two implementations is the worst bug this phase can ship: a
key that differs by one character makes every re-import a duplicate, silently.
So it is guarded mechanically, not by care:

- New `tests/fixtures/jobkeys.golden.json` — `[{url, company, title, location,
  key, strong}]`, ≥60 cases covering all 14 patterns plus the fallbacks.
- Generated by, and asserted against, `core/jobkeys.py` in a new pytest
  (`tests/core/test_jobkeys_golden.py`).
- Asserted against the TS port in `webapp/tests/unit/job-key.test.ts`.
- Both read the same file. A change to either side that is not mirrored fails
  in one language. (Matrix row 29.)

### 4.2 Read + sniff

`webapp/lib/import/read.ts` (server-only):

- `.xlsx` → `readSheet(buffer, { sheet })`; sheet chooser if the workbook has
  more than one (the default export returns all sheets, so the names are free).
- `.csv` / paste → `Papa.parse(text, { skipEmptyLines: "greedy" })` with
  `delimiter: ""` (papaparse's auto-detect, which handles `;` exports from
  European Excel), decoded through `TextDecoder`. Sniff the BOM; if the bytes
  are not valid UTF-8, retry as `windows-1252` before giving up — Excel on
  Windows still emits it, and mangled accents are the failure people notice
  last (matrix row 36).
- Header sniffing: the first row is the header **unless** it has blank cells
  where later rows have values, or unless a later row scores better on
  header-likeness (short, non-numeric, distinct, non-date). Always show the
  guess with a "first row is data, not headers" toggle. Never guess silently.
- Excel dates arrive as JS `Date` objects from the reader (verified in the
  probe), but a CSV date is a string and an Excel *serial* pasted as text is a
  number. `coerceDate()` handles all three and returns `null` rather than a
  wrong date — the `view-models.ts` rule ("a value never stated is `null`")
  applies to imports too.

### 4.3 Column mapping with fuzzy pre-fill

`webapp/lib/import/map-columns.ts` — a **pure, deterministic** function:
`suggestMapping(headers: string[]): Record<TargetField, Suggestion | null>`.

Not an LLM. A mis-mapped column is silent corruption, and the fix must be
reproducible and unit-testable offline.

1. Normalize: lowercase, strip non-alphanumerics, collapse spaces.
2. Exact hit against an alias table (`company`: `company`, `employer`,
   `organisation`, `org`; `title`: `title`, `role`, `position`, `job title`;
   `status`: `status`, `stage`, `state`; `appliedDate`: `applied`,
   `date applied`, `application date`; …). Confidence `1.0`.
3. Otherwise token-overlap (Dice on bigrams). `≥ 0.82` pre-fills as a
   *suggestion the user can see and change*; below that stays **Unmapped**.
   A confident wrong guess is worse than no guess — matrix row 27.
4. `hq_id` / `hq_version` are matched exact-only, and their presence flips the
   batch into round-trip mode (§5).

The mapping step renders, per target field, a live 3-row sample of the values
that would land there. Mapping without seeing the data is how someone maps
"Contact Company" onto `company` and finds out in a month.

### 4.4 Status-value mapping

`webapp/lib/import/map-status.ts`. First: **extract the status vocabulary to
`webapp/lib/status.ts`** — `STATUS_ORDER` is already duplicated at
`webapp/lib/queries.ts:63`, and a third copy is drift waiting to happen.

- Collect distinct raw values from the mapped status column, with counts.
- Pre-fill from a normalized alias table seeded from `tracker/simplify.py:40-46`
  (`saved`→`Inbox`, `applied`→`Applied`, `screen`→`Screen`,
  `interview`→`Interview`, `rejected`→`Rejected`, `withdrawn`→`Withdrawn`,
  `offer`→`Offer`, `oa`/`assessment`/`take home`→`OA`).
- Anything unrecognised defaults to **`Inbox`**, the original is preserved by
  appending `Imported status: "<original>"` to `notes`, and the value is listed
  in the mapping UI so the user can override. Never invent a status — the
  system's rule is that a human-invented status outranks everything
  (`core/schema.py:150`), and inventing one from a spreadsheet cell would
  create an untouchable status nobody chose. Matrix row 43.

### 4.5 Dedup preview

Per row, in `app_import_preview`:

| Condition | `match_kind` | Commit behaviour |
|---|---|---|
| strong key, no existing application | `new` | insert |
| strong key, existing application | `matches-existing` | update the human-owned columns only |
| weak key (`norm-`/`url-`), existing look-alike | `suggestion` | **insert as a new row**, record `matched_application_id`, flag for review |
| weak key, nothing to match | `unkeyable` | insert |
| `hq_id` present | `round-trip` | §5 |
| same key twice within the file | `duplicate-in-file` | first wins, rest `skipped` |

**Weak-keyed rows never hard-merge.** `isStrong()` is the only thing allowed to
authorize a merge, exactly as `core/jobkeys.py:79-82` defines it. A weak match
produces a suggestion the user resolves later, and the preview says so in
words: *"3 rows look like applications you already have, but we can't prove it —
they'll be added separately and flagged."*

The preview screen shows counts per bucket, is sortable, and every row is
individually excludable before commit.

---

## 5. Round trip (section E, G13, AC 23)

**Export side** (extends `webapp/lib/export/columns.ts`): a
`ROUND_TRIP_COLUMNS = [...APPLICATION_COLUMNS, hqId, hqVersion]` set, used only
by the "Round-trip file" export path. `hq_id` = `applications.id`.
`hq_version` = the `updated_at` the export read, ISO-8601 — the same token
`setTriage` already uses for optimistic concurrency, so there is one concurrency
concept in the system, not two. Trailing columns, not hidden (§1).

**Import side:**

1. `hq_id` present → `match_kind = 'round-trip'`, matched by id, scoped to
   `user_id` in the function (an id from someone else's file must resolve to
   nothing, never to a row).
2. `hq_version` equals the row's current `updated_at` → the five writable
   columns (`status`, `notes`, `next_action`, `next_action_date`,
   `applied_date` — spec E) are applied.
3. `hq_version` differs → `conflict_state = 'unresolved'`, `conflict` jsonb
   holds `{column: {mine, theirs}}` **per changed cell**, and the per-cell
   resolver opens. `app_import_commit_chunk` raises if any unresolved row
   remains in the batch, so **AC 23 is enforced in the database, not by the
   UI**. A UI-only guard is one bad deploy away from writing anyway.
4. Every other column in the file — tags, geo, disposition, company, title, URL
   — is engine-owned. It is compared, never written. If the imported value
   differs from the current one, an `import_column_reports` row records the
   column, the count, and up to 3 samples, and the post-commit report says
   *"`Disposition` — 14 rows differed; not imported (set by the engine)."*
   That is G13: an explicit per-column report rather than a silent drop.
5. An unrecognised column gets `disposition = 'unknown-column'` in the same
   report. Someone who adds a "Recruiter" column deserves to be told it went
   nowhere.

---

## 6. Tests — written before the code

`jsdom` has no layout engine, so anything with virtualization, a Radix dialog,
or a file input is Playwright. Logic is Vitest.

**Vitest** (`webapp/tests/unit/`) — new files:

| File | Asserts | AC |
|---|---|---|
| `job-key.test.ts` | every case in `tests/fixtures/jobkeys.golden.json`; `isStrong` for `norm-`/`url-` | — |
| `map-columns.test.ts` | alias hits; the 0.82 floor leaves ambiguity Unmapped; `Contact Company` does **not** map to `company`; a 60-column header set | — |
| `map-status.test.ts` | simplify aliases; unknown → `Inbox` + original preserved in notes; casing/whitespace | 20 |
| `read.test.ts` | BOM'd CSV, CRLF, `;` delimiter, quoted newline, windows-1252 bytes, Excel serial vs `Date`, blank trailing rows, a header row that is actually data | — |
| `dedup.test.ts` | the six `match_kind` outcomes; weak key never yields a merge; duplicate-in-file | 20 |
| `round-trip.test.ts` | writable set is exactly the five columns; a changed engine column produces a report entry and no write | 23 |

**Playwright** (`webapp/tests/e2e/import.spec.ts`) — drives the real wizard in
demo mode against fixture files committed under
`webapp/tests/fixtures/import/`: `clean-40.xlsx`, `messy-headers.csv`,
`round-trip-conflict.xlsx`, `weak-keys.csv`, `big-2000.xlsx`,
`engine-columns.xlsx`.

| Test | AC |
|---|---|
| upload → map → preview → commit `clean-40.xlsx` → 40 applications | **20** |
| re-upload the identical file → preview shows 40 `matches-existing`, commit adds **0** | **20** |
| undo within the window → exactly those 40 gone, a pre-existing row untouched, a compensating event appended | **21** |
| undo after `undo_expires_at` (clock advanced) → the button is gone and the action refuses | 21 |
| `round-trip-conflict.xlsx` → resolver opens, commit is blocked, DB unchanged; resolve → commit writes only the chosen cells | **23** |
| `engine-columns.xlsx` → report names each read-only column with counts; those columns unchanged | (G13) |
| `weak-keys.csv` → flagged as suggestions, no merge | (B2) |
| `big-2000.xlsx` → progress advances, mid-commit reload resumes, no double-commit | (G12) |
| overflow + axe + zero-console-errors on `/import` at all 6 widths, both themes | — |

Extend the existing suites rather than forking them: add `/import` to
`PAGES` in `webapp/tests/e2e/layout.spec.ts:13` and
`webapp/tests/e2e/resilience.spec.ts:4`. That is one line each and it
retro-fits six overflow checks, two axe runs, and the console-error assertion.

The fixture `DataSource` gets the import methods too, and must reproduce the
failure modes — a conflicting `hq_version`, a chunk that fails halfway, an
expired undo window. `docs/WEBAPP-BUILD.md` records what a too-forgiving fake
already cost; the same rule applies here.

---

## 7. New rows for the failure-mode matrix

Append to the table in `docs/WEBAPP-BUILD.md` (continuing from 24).

| # | Failure mode | Enforced by | Status |
|---|---|---|---|
| 25 | **A wrong column mapping commits silently** — "Contact Company" lands in `company` | Mapping step renders 3 live sample values per target; `map-columns.test.ts` asserts the near-miss header stays Unmapped | ⬜ |
| 26 | Fuzzy pre-fill guesses confidently and wrongly | Hard 0.82 similarity floor; below it the field is Unmapped, never auto-filled; unit-tested at the boundary | ⬜ |
| 27 | A 60-column spreadsheet blows out the mapping UI | Mapping list is a scrolling column, not a wide table; `layout.spec.ts` includes `/import` with a 60-header fixture at 375px | ⬜ |
| 28 | **A weak-keyed row hard-merges into someone's real application** | `isStrong()` is the only merge authorization; weak matches insert + flag; `dedup.test.ts` + the `weak-keys.csv` E2E | ⬜ |
| 29 | **`job_key` drifts between Python and TypeScript**, so every re-import duplicates | One golden fixture, `tests/fixtures/jobkeys.golden.json`, asserted by pytest *and* Vitest | ⬜ |
| 30 | Same file imported twice creates duplicates | Strong-key match + `on conflict do nothing` against `applications_manual_dedup`; E2E re-import asserts **0** added (AC 20) | ⬜ |
| 31 | **Commit dies mid-batch** (tab closed, timeout) → half-imported, looks finished | State is `committing` until `committed_count = row_count`; the batch page shows resume; E2E reloads mid-commit | ⬜ |
| 32 | Undo runs twice, or after 24h, and eats unrelated rows | `undo_expires_at` is read from the row (never the client clock); `app_import_undo` is idempotent on `p_idem` and refuses when expired | ⬜ |
| 33 | Undo reverts rows the user edited *after* the import | Undo compares `updated_at` to the value the import wrote; a changed row is kept and listed in the undo report | ⬜ |
| 34 | 2,000-row preview freezes the tab | Preview table is `@tanstack/react-virtual`; Playwright asserts a render budget and that row 1,999 is reachable | ⬜ |
| 35 | CSV dialect mis-parse — `;` delimiter, CRLF, quoted newline, BOM | papaparse auto-detect + `read.test.ts` covering all four; the parsed field count per row is asserted, not eyeballed | ⬜ |
| 36 | **Windows-1252 CSV mangles every accent, silently** | UTF-8 decode is strict; on failure retry as windows-1252; a `Zoë`/`Peña` fixture asserts the round trip | ⬜ |
| 37 | Excel serial dates import as the year 1900 | `coerceDate()` handles `Date` / ISO string / serial number, returns `null` when unsure; unit-tested per form | ⬜ |
| 38 | **A stale `hq_version` overwrites a newer edit** | `app_import_commit_chunk` raises while any row is `conflict_state='unresolved'` — enforced in the DB, not the UI (AC 23) | ⬜ |
| 39 | Engine-owned column edits vanish without a word | `import_column_reports` + a mandatory post-commit report screen; E2E asserts every read-only column is named with a count (G13) | ⬜ |
| 40 | Round-trip file with `hq_id` deleted by the user | Absence of `hq_id` falls back to `job_key` matching and the preview says which mode it is in; E2E covers both files | ⬜ |
| 41 | `.xls` / `.numbers` / password-protected upload → stack trace | Extension + magic-byte check before parse; a named error naming the format and what to do; E2E uploads a `.xls` | ⬜ |
| 42 | 40 MB file or zip bomb ties up the server | Route handler caps `Content-Length` (10 MB) and row count (5,000) before parsing, returns 413 with a readable message | ⬜ |
| 43 | An imported status string becomes an untouchable invented status | Unknown values map to `Inbox`, original preserved in notes; nothing outside `lib/status.ts` can be written | ⬜ |
| 44 | Wizard state lost on refresh mid-mapping | Every step persists to `import_batches.mapping` server-side; `/import/[batchId]` is a deep link; E2E reloads at each step | ⬜ |

---

## 8. Increments

Each ships on its own, is independently verifiable, and leaves the app green.

| # | Ships | Size | Verified by |
|---|---|---|---|
| **1** | `lib/import/job-key.ts` + golden fixture + both test suites. Nothing user-visible. | S (~1 day) | `job-key.test.ts`, `test_jobkeys_golden.py` |
| **2** | `lib/import/read.ts`, `map-columns.ts`, `map-status.ts`, `lib/status.ts`. Pure logic, no DB, no UI. | M (~2 days) | Vitest; every dialect/encoding case above |
| **3** | Migration `0003_import.sql` + `DataSource` import methods + fixture implementation (including its failure modes). Still no UI. | M (~2 days) | `dedup.test.ts` against the fixture source |
| **4** | `/import` wizard: upload → sniff → map → status-map → preview → commit → report. Radix `Dialog`/`Select`, virtualized preview, `sonner` for the batch toast with Undo. | L (~4 days) | the E2E journey; AC **20**, **21** |
| **5** | Round-trip export columns + per-cell conflict resolver + `import_column_reports` UI. | M (~2 days) | AC **23**, G13 |
| **6** | Scale + resume hardening: chunk loop, progress, resume-on-reload, the 5,000-row/10 MB caps, the `.xls` refusal. | M (~1.5 days) | `big-2000.xlsx` E2E; G12 |

Increment 4 is the first one a human can use. 1–3 are what make it safe, and
reordering them means writing the UI against key logic nobody has proved yet.

---

## 9. Decisions recorded so they are not re-litigated

1. **Deterministic mapping, not an LLM.** Offline, reproducible, unit-testable.
   An LLM may later *rank* ambiguous suggestions; it never picks silently.
2. **Parse on the server, once, into Postgres.** The browser holds no working
   set. This is what makes resume real.
3. **Chunk-atomic + batch-reversible**, not one 2,000-row transaction. Written
   out in §3 because the spec's phrasing invites the wrong reading.
4. **The database enforces AC 23**, not the wizard.
5. **`hq_id`/`hq_version` are trailing, not hidden** — `write-excel-file` 4.1.1
   cannot hide a column (verified by unzipping the output). Section E of
   `PRODUCT-SPEC.md` should be amended to say so rather than describing
   behaviour the writer does not have.
6. **Raw import rows are kept forever.** `import_rows.raw` is the only way to
   answer "what did the file actually say" a month later, and it costs
   kilobytes.

## 10. Open questions for the owner

- Undo window: spec says 24h. Should a batch be undoable *after* the engine has
  touched an imported row? Proposed: yes, but the undo report lists what it
  declined to revert (matrix row 33).
- Does Dad's round-trip file need the full pipeline or only his current view?
  Proposed: full pipeline, because a filtered round-trip file silently deletes
  nothing but silently *fails to update* everything absent — and that is the
  same trust bug section E warns about for export scope.
