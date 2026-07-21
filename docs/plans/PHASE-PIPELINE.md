# Phase 5 — Pipeline

Build order step 5 (`docs/PRODUCT-SPEC.md` §J). This is the phase that lets the
spreadsheet be closed: status editing where a human always wins, suggested-status
confirm/reject, notes with history, next actions, withdraw/reopen, and the
delisted badge.

Discharges acceptance criteria **11, 12, 13, 14, 15, 26**.

---

## 1. What exists today (read before planning anything)

| Thing | Path | State |
|---|---|---|
| Pipeline page | `webapp/app/(app)/pipeline/page.tsx` | read-only table, 5 columns, sorted by a local `ORDER` array |
| Application row type | `webapp/lib/types.ts:60` | mirrors the table; has `notes` as one flat `string \| null` |
| Application view model | `webapp/lib/data/view-models.ts:66` | `ApplicationView`; no posting status, no note history, no actor |
| Data boundary | `webapp/lib/data/source.ts:48` | `DataSource` has `applications()` **read-only**; the only write is `setTriage` |
| Fake | `webapp/lib/data/fixture-source.ts` | models conflict + idempotency + `failNextWrite()` for triage only |
| Real source | `webapp/lib/data/supabase-source.ts:157` | `setTriage` calls `rpc("app_set_triage", …)` |
| Schema | `db/migrations/0001_init.sql`, `0002_invariants.sql` | `applications`, `events` (append-only), RLS read-only for browsers |
| Status ladder (engine) | `core/schema.py:103-150` | `STATUS_ORDER`, `STATUS_TERMINAL`, `status_rank` |
| Bot status writes | `tracker/join.py:68-90`, `core/sheets.py:232-248` | `advance_status`, forward-only by rank |

### Four things that are broken or missing and this phase must own

1. **`app_set_triage` does not exist.** `supabase-source.ts:161` calls it;
   `grep "create.*function" db/migrations/*.sql` returns only
   `handle_new_auth_user` and `touch_updated_at`. Every write path in this
   phase depends on the same pattern, so the function family gets written
   here, `app_set_triage` included.
2. **Matrix rows 8, 9, 10 are marked ✅ with no test driving them.**
   `failNextWrite()` is defined at `fixture-source.ts:43` and called from
   nowhere; no test ever produces a `kind: "conflict"` result. The mechanisms
   exist, nothing exercises them. This phase adds the harness (§5) and the
   tests, and downgrades those rows until they are green.
3. **AC 14 does not hold in the engine.** `status_rank("Rejected")` is 9
   (`STATUS_TERMINAL` → `len(STATUS_ORDER)+1`), `status_rank("Offer")` is 7.
   `advance_status` (`core/sheets.py:242`) moves on rank alone, so a 0.99
   rejection **overwrites a human-set `Offer`**. "Human wins" is enforced today
   only for statuses a human *invented* (rank 10). A canonical status a human
   chose has no protection. Fixing this needs a stored actor, not a rank.
4. **`Offer` is a dead end** — `STATUS_ORDER` ends there
   (`core/schema.py:103`), so a finished search cannot be represented.

### Duplicated constants that will drift

`STATUS_ORDER` exists three times in the webapp alone:
`webapp/app/(app)/pipeline/page.tsx:11`, `webapp/lib/queries.ts:63`, and
`core/schema.py:103`. This phase collapses the TS copies into
`webapp/lib/pipeline/statuses.ts` (**does not exist — must be created**) and
adds a parity test against the Python list.

---

## 2. Model changes

### 2.1 Status vocabulary

`core/schema.py` gains a third tier. The existing two are unchanged so no bot
behaviour shifts:

```
STATUS_ORDER    = [Inbox … Offer]        # bot-advanceable, forward only
STATUS_TERMINAL = [Rejected, Withdrawn, Closed]
STATUS_RESOLVED = [Offer-Accepted, Offer-Declined]   # NEW — human-only
```

`status_rank` ranks `STATUS_RESOLVED` above `STATUS_TERMINAL` and below an
invented status. **No bot may ever write a `STATUS_RESOLVED` value** — enforce
in `_apply_rules` (`tracker/join.py:68`) by asserting the target is in
`EVENT_STATUS_RULES`, which structurally cannot name these. Reachable only from
`Offer` in the UI; reachable from anywhere by typing an invented status, which
stays legal.

There is no `CHECK` on `applications.status` (`0001_init.sql:153` explains
why — a mirrored human cell must never fail a 500-row upsert chunk). Keep it
that way. Nothing about this change touches the DB column.

### 2.2 The human-wins lock — `applications.status_actor`

**Does not exist — must be created.** Migration `db/migrations/0003_pipeline.sql`:

```sql
alter table public.applications
  add column status_actor text not null default 'system'
      check (status_actor in ('system','user')),
  add column status_set_at timestamptz;
```

Rule, stated once and enforced in two places because there are two writers:

> When `status_actor = 'user'`, any non-human write to `status` is refused and
> lands in `suggested_status` instead — regardless of rank, regardless of
> confidence.

- **Postgres trigger** `applications_human_status_lock` (before update): if
  `status_actor = 'user'` and `new.status <> old.status` and the session is not
  setting `status_actor` to `'user'` in the same statement, raise. This is the
  only place both writers converge, so it is the durable enforcement point.
- **Sheet path** (still live during dual-write): `core/sheets.advance_status`
  gains a `locked_header="status_actor"` check that returns `"kept"` when the
  cell reads `user`. Mirrored rule, mirrored test.

A human clearing the lock is a real gesture ("let the bots drive this one
again") but is **not** in this phase's scope. Do not build a UI for it.

### 2.3 Notes as an entity

`applications.notes` is one text column with no history (spec A4 names `note` as
an entity that must exist). **`public.application_notes` does not exist — must
be created:**

```sql
create table public.application_notes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  application_id bigint not null references public.applications(id) on delete cascade,
  body text not null check (body <> ''),
  author text not null default 'user',   -- user|scout|system|import
  created_at timestamptz not null default now()
);
create index application_notes_by_app on public.application_notes (application_id, created_at desc);
alter table public.application_notes enable row level security;
create policy application_notes_self_read on public.application_notes
  for select using (user_id = auth.uid());
revoke update, delete on public.application_notes from anon, authenticated;
```

Append-only for the same reason `events` is (`0002_invariants.sql:37-43`): a
comment is not a permission. Editing a note means appending a correction.

**Backfill, non-destructively.** 0003 inserts one row per non-empty
`applications.notes`, `author='import'`, `created_at = applications.created_at`,
and **leaves the column in place**. Spec §E round-trips `notes`, and the export
column (`webapp/lib/export/columns.ts:52`) reads it. New rule: export writes the
**newest** note's body; re-import **appends** a note rather than overwriting the
column. Never a destructive migration on a column another surface reads.

### 2.4 Delisted (G2) — derived, never stored

A stored `delisted` flag drifts the moment the posting reopens. Derive it:
`ApplicationView` gains `postingStatus: string \| null`, filled from a
`postings(status)` embed on the applications select in
`supabase-source.ts:104`. `delisted = postingStatus === "Closed"`.

Honest limitation to write in the code comment: the `postings` RLS policy
(`0002_invariants.sql:16`) only exposes a posting to a user who has a
`user_postings` row for it. An application created from an `interested` posting
always has one. A manually-added application whose `posting_key` points at a
posting the user was never gated returns `null` from the embed and renders as
not-delisted. That is a false negative, not a false positive, and it is the
right way round.

### 2.5 The write functions

All four are new. Each writes the row **and** its `events` row in one
transaction, takes `p_idem` and `p_expected_updated_at`, and raises
`'conflict'` on a stale token — the shape `supabase-source.ts:170` already
pattern-matches on.

| Function | Gesture | Event kind | Sets `status_actor` |
|---|---|---|---|
| `app_set_triage` | (backfill of the existing gap) | `action.interested` / `.dismissed` / `.snoozed` | — |
| `app_set_status` | change status, withdraw, reopen | `action.status` | `'user'` |
| `app_resolve_suggestion` | confirm / reject a `suggested_status` | `action.status.confirmed` / `.rejected` | `'user'` on confirm only |
| `app_add_note` | append a note | `action.note` | no |
| `app_set_next_action` | next action + date | `action.next_action` | no |

Idempotency: a `unique (user_id, idem_key)` index on `events` (**does not
exist — must be created**) plus `on conflict do nothing`; a replay returns the
row unchanged. This is what makes "exactly one event" in AC 26 an assertion
about the database rather than about the client.

**Confirm vs reject.** Confirm copies `suggested_status → status`, clears
`suggested_status`, stamps `status_actor='user'`. Reject clears
`suggested_status` and touches `status` not at all. Both append an event, so
"the bot suggested Rejected and Salman said no" survives in history — which is
the whole point of the suggestion mechanism existing below 0.85.

---

## 3. `DataSource` additions

`webapp/lib/data/source.ts` gains, alongside the existing `setTriage`:

```ts
export type StatusInput = {
  applicationId: number;
  status: string;                 // free text — an invented status is legal
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};
export type SuggestionInput = {
  applicationId: number; decision: "confirm" | "reject";
  idempotencyKey: string; expectedUpdatedAt: string | null;
};
export type NoteInput = {
  applicationId: number; body: string;
  idempotencyKey: string;                    // no expectedUpdatedAt: append-only
};
export type NextActionInput = {
  applicationId: number; nextAction: string; nextActionDate: string | null;
  idempotencyKey: string; expectedUpdatedAt: string | null;
};

export type AppWriteResult =
  | { ok: true; application: ApplicationView }
  | { ok: false; kind: "conflict"; current: ApplicationView }
  | { ok: false; kind: "error"; message: string };
```

Interface: `setStatus`, `resolveSuggestion`, `addNote`, `setNextAction`,
`notes(applicationId): Promise<NoteView[]>`. `NoteView` is
`{ id, body, author, createdAt }`.

`ApplicationView` (`view-models.ts:66`) gains `postingStatus`, `statusActor`,
`noteCount`, `latestNote: NoteView | null`. It keeps `notes` so nothing in
export breaks.

Server actions live in `webapp/app/(app)/pipeline/actions.ts` (**does not
exist**), one per gesture, mirroring `queue/actions.ts` exactly — including its
revalidation discipline. `revalidatePath("/pipeline")` is correct here (unlike
the queue, per WEBAPP-BUILD "design decisions" #1): the pipeline is a list you
edit in place, not a working set you walk, so a re-read does not move anything
under the cursor.

---

## 4. UI

### 4.1 Grouped by status (§D)

`@tanstack/react-table` 8.21.3 with `getGroupedRowModel`, grouped on `status`,
group order from `statuses.ts`. Not virtualized: the pipeline is tens of rows,
not thousands, and `@tanstack/react-virtual` inside collapsible groups is
complexity bought for a load that does not exist. **If a group ever exceeds 200
rows, revisit** — and the render-budget assertion in §6 is what will tell you.

Groups collapse. Collapsed state is URL state (`?open=Applied,Interview`) so
back/forward works and a link is shareable — this is also the first payment on
matrix row 19.

### 4.2 Density and the large-type persona

Two knobs on `<html>`, read server-side from the profile, defaulted per persona
(§D: owner dense + hints on, Dad comfortable + large type + hints off):

- `data-density="dense|comfortable"` → row padding token
- `data-type-scale="normal|large"` → sets `--text-sm`/`--text-base`/`--text-lg`
  in a `:root[data-type-scale="large"]` block in `app/globals.css`

Scale the **tokens**, not a `zoom` or a root `font-size` multiplier. The token
scale in `globals.css:@theme inline` is already the single source of type size,
so nothing else changes, and the existing 200%-zoom overflow test
(`resilience.spec.ts`) still means what it meant.

Persona default comes from `profiles.notify`/`criteria` jsonb (`0001_init.sql:63`)
— no new column. In demo mode it comes from a cookie so Playwright can drive
both.

### 4.3 The row

Status cell is a Radix `Select` (from the unified `radix-ui` 1.6.4 package —
nothing here is hand-rolled) listing `STATUS_ORDER` + `STATUS_TERMINAL`, plus
`STATUS_RESOLVED` **only when current status is `Offer`**, plus a "Custom…"
item that opens a text input for an invented status.

- **Suggested status** renders as the existing warn `Badge`
  (`pipeline/page.tsx:88` already does this) with two buttons: `Confirm` /
  `Not this`. Keyboard: `y` / `n` on the focused row.
- **Evidence** — an `Open email` link when `evidence` is set, `target="_blank"
  rel="noopener noreferrer"` (same as the title link at `page.tsx:79`).
- **Delisted** — a neutral `Badge` reading "Posting closed" with a `title`
  explaining it. Never removes the row; §G2 is explicit that the application
  survives.
- **Withdraw** sets status `Withdrawn`. **Reopen** appears only on
  `Rejected|Withdrawn|Closed` and returns the row to `Applied` with a required
  note ("why is this alive again") — the note is what makes a reopen auditable
  instead of mysterious.
- **Notes** open a detail panel (Radix `Dialog`) listing notes newest-first with
  `fmtStamp` (`lib/format.ts`) and a compose box. Never an editable textarea over
  the old value — the append-only model must be visible in the UI or people will
  expect editing.
- **Next action** — inline text + date, saved on blur.

---

## 5. Testing the conflict path with no database

The fake must model this or the UI's 409 branch is decoration. `FixtureDataSource`
gains two test seams:

```ts
/** Simulate the other device: bump updatedAt without the client knowing. */
simulateExternalEdit(applicationId: number, patch?: Partial<ApplicationView>): void
/** Already exists at fixture-source.ts:43; extend to cover app writes. */
failNextWrite(message?: string): void
```

Playwright cannot call a method on a server-side object, and server actions
cannot be invoked from `page.evaluate`. The seam is a **demo-only search param**
read in `pipeline/page.tsx`:

```
/pipeline?demo=conflict:2     → simulateExternalEdit(2) before render
/pipeline?demo=failnext       → failNextWrite() before render
```

Guarded by `isDemoMode()` (`source.ts:63`) and a no-op otherwise. Chosen over a
hidden test-only button because a button in the DOM changes the visual baseline;
a search param does not, and `visual.spec.ts` simply never passes one.

The conflict copy is fixed by §I of the spec:
**"Salman changed this a moment ago — showing the latest."** The name is the
signed-in user's own display name when the last writer was them, and the actor
recorded on the event otherwise. Not "This was changed somewhere else", which is
what `triage-queue.tsx:100` says today — that string should be brought in line
in the same increment, and the conflicting row must **visibly refresh to the
server's value**, not merely toast.

---

## 6. Test plan — written before the code

Layer rule from WEBAPP-BUILD, unchanged: **Vitest for logic, Playwright for
anything with layout.** jsdom has no layout engine, so nothing about grouping,
density, or the dialog is asserted in Vitest.

### Vitest — `webapp/tests/unit/`

| File | Asserts |
|---|---|
| `statuses.test.ts` | `STATUS_ORDER`+`TERMINAL`+`RESOLVED` and `statusRank` match `core/schema.py` (parsed from the file, so drift fails the build); `Offer-Accepted` outranks `Rejected`; an invented status outranks everything |
| `pipeline-source.test.ts` | over `FixtureDataSource`: confirm/reject semantics; stale `expectedUpdatedAt` → `kind:"conflict"` with the *current* row attached; replayed idem key returns the first result and does **not** apply twice; `failNextWrite` → `kind:"error"` |
| `notes.test.ts` | `addNote` appends; existing notes never mutate; empty body rejected before any write |
| `delisted.test.ts` | `postingStatus:"Closed"` → delisted true; `null` → false |

### Python — `tests/tracker/`, `tests/core/`

| File | Asserts |
|---|---|
| `test_join.py` (extend) | **AC 14**: row at `Offer` with `status_actor='user'`, rejection event at 0.99 → status still `Offer`, `suggested_status='Rejected'`, event appended |
| `test_sheets.py` (extend) | `advance_status` returns `"kept"` when the lock cell reads `user`, for every canonical target |
| `test_schema.py` | no `EVENT_STATUS_RULES` value names a `STATUS_RESOLVED` status |

### Playwright — `webapp/tests/e2e/pipeline.spec.ts` (new)

Runs in demo mode with a per-test `hq_demo_id` cookie and a pinned clock, same
`beforeEach` as `triage.spec.ts:6-17`.

| Test | Asserts |
|---|---|
| grouped presentation | one group header per present status, in ladder order, `Inbox` before `Applied` |
| status change wins | set `Offer` on the Plaid row (fixture has `suggestedStatus:"Rejected"`); badge shows `Offer`, suggestion is gone |
| confirm a suggestion | `Confirm` on Plaid → status becomes `Rejected`, suggestion badge gone |
| reject a suggestion | `Not this` → status **unchanged** at `Applied`, suggestion badge gone |
| note history | add two notes → both visible newest-first, the first still verbatim |
| next action | set text + date → persists across reload |
| evidence | `Open email` has the fixture's `mail.google.com` href, `rel="noopener noreferrer"` |
| withdraw + reopen | Datadog (`Rejected`) → Reopen requires a note, lands `Applied`, note present |
| delisted badge | fixture app whose posting is `Closed` shows "Posting closed" and stays in its group |
| **conflict** | `/pipeline?demo=conflict:2`, change status → toast reads "changed this a moment ago", the row shows the server value, and exactly one status remains |
| **failed write** | `/pipeline?demo=failnext` → row reverts, error toast with Retry, retry succeeds |
| large type | `data-type-scale="large"` → computed `font-size` of a row cell is larger than in `normal`, and `layout.spec.ts` widths still pass |
| empty pipeline | zero rows → `EmptyState`, not a bare table head (matrix row 15) |

`layout.spec.ts` `PAGES` already includes `/pipeline`; add the two demo-param
URLs and `?open=` to that list so the grouped/collapsed states are checked at
all six widths. `resilience.spec.ts` `PAGES` likewise — axe must pass in both
themes with a group collapsed and with the notes dialog open.

### Acceptance criteria — exactly how each is discharged

| AC | Statement | Discharged by |
|---|---|---|
| **11** | bot-advanced application survives un-triage | `pipeline-source.test.ts` — an app at `Applied` is retained when its posting is un-triaged (the filter at `fixture-source.ts:121` only removes `status === "Queued"`; today that is untested); plus a Playwright pass: `i` then Undo on a posting whose app is already `Applied` leaves the pipeline row |
| **12** | rejection at 0.90 → `Rejected` with evidence | already green in `tests/tracker/test_join.py:41`; **new** Playwright assertion that the resulting row renders `Rejected` **and** an `Open email` link — a status with no reachable evidence fails the criterion in spirit |
| **13** | same email at 0.60 → status unchanged, `suggested_status` set | already green in `test_join.py:67`; **new** Playwright: the fixture Plaid row (`Applied` + `suggestedStatus:"Rejected"`) renders both badges and offers Confirm/Not-this |
| **14** | human `Offer` + rejection at 0.99 → human wins | **currently fails.** New: `status_actor` column + trigger + `advance_status` lock; `test_join.py` case above; Vitest asserts the fake refuses a system status write when `statusActor === "user"`; Playwright asserts the UI shows `Offer` with `Rejected` as a *suggestion* |
| **15** | email matching two applications → neither changes, one review item | engine side already green (`test_join.py:160`); **new** — the review item has no surface. Add a "Needs review" group at the top of the pipeline fed by `events` of kind `email.unmatched`/`email.ambiguous`, with the two candidate rows named and no write until a human picks one. Playwright asserts both candidates are unchanged and exactly one review item is listed |
| **26** | two concurrent triage writes → one succeeds, one 409s, exactly one event | Vitest over the fake (two `setTriage` calls sharing `expectedUpdatedAt`, different idem keys → one `ok`, one `conflict`); **plus** a real-Postgres test in `db/tests/concurrency.sql` run by `psql` against a local Supabase, asserting `select count(*) from events where …` is 1. The fake alone cannot prove this — it is single-threaded, and a fake more forgiving than the real thing is the exact failure WEBAPP-BUILD:61 warns about |

AC 26 is the one criterion that needs a database. Gate it behind a CI job that
skips cleanly when no `SUPABASE_DB_URL` is present, rather than failing red — a
permanently red check teaches people to ignore checks (WEBAPP-BUILD, design
decision #4).

---

## 7. New failure-mode matrix rows

Append to the table in `docs/WEBAPP-BUILD.md` (continuing from 24). These are
the ways *this* surface breaks.

| # | Failure mode | Enforced by | Status |
|---|---|---|---|
| 25 | Bot overwrites a status a human chose (AC 14 — **live defect** today) | `status_actor` + Postgres trigger + `advance_status` lock; `test_join.py` Offer-vs-0.99-rejection case | ⬜ |
| 26 | Confirming a suggestion twice applies twice | `unique (user_id, idem_key)` on `events`; Vitest replay case | ⬜ |
| 27 | Rejecting a suggestion silently also changes the status | Playwright: status asserted **unchanged** after "Not this" | ⬜ |
| 28 | A note is lost because the flat column was overwritten | `application_notes` is append-only (`revoke update, delete`); Vitest asserts note #1 verbatim after note #2 | ⬜ |
| 29 | Backfill migration destroys `applications.notes` that export reads | 0003 copies, never clears; unit test on `APPLICATION_COLUMNS` output before/after | ⬜ |
| 30 | Second device silently clobbers a status | `/pipeline?demo=conflict:N` + Playwright asserting the toast **and** the refreshed value | ⬜ |
| 31 | Conflict toast fires but the row keeps the stale value on screen | same test asserts the rendered cell equals the server value, not just that a toast appeared | ⬜ |
| 32 | Failed write leaves the new status on screen | `?demo=failnext` + revert-and-retry assertion (finally exercises `failNextWrite`, unused since it was written) | ⬜ |
| 33 | Status `Select` popover renders off-screen or is unreachable by keyboard | Radix `Select` (not hand-rolled) + the existing tab-walk in `resilience.spec.ts` extended to `/pipeline` with the popover open | ⬜ |
| 34 | Notes dialog traps focus or loses the restore target | Radix `Dialog` + Playwright: open, Escape, focus returns to the trigger | ⬜ |
| 35 | A group with many rows collapses the frame rate | render-budget assertion: 200-row fixture group must paint under a fixed budget; the trigger to virtualize | ⬜ |
| 36 | Collapsed-group state lost on back/forward | `?open=` is URL state; Playwright back/forward assertion | ⬜ |
| 37 | Large type (Dad) overflows the page or clips the status pill | `layout.spec.ts` re-run at all six widths with `data-type-scale="large"` | ⬜ |
| 38 | An invented status vanishes from the grouped view | grouping falls back to an "Other" group; Vitest on `statusRank`, Playwright asserts a custom status renders | ⬜ |
| 39 | Delisted badge lies (posting reopened, badge sticks) | `delisted` derived from the embed each read, never stored; Vitest both directions | ⬜ |
| 40 | Status list drifts from `core/schema.py` | `statuses.test.ts` parses the Python file and compares | ⬜ |
| 41 | Ambiguous-email review item is invisible, so two rows stay silently wrong (AC 15) | "Needs review" group rendered from `events`; Playwright asserts exactly one item and two untouched rows | ⬜ |
| 42 | A reopen leaves no trace of why | reopen requires a note; the function refuses an empty body | ⬜ |

Also **downgrade rows 8, 9, 10 from ✅ to ◐** in the same edit, with a one-line
note: the mechanism exists in the fake, nothing calls it. They return to ✅ when
rows 30–32 are green.

---

## 8. Increments

Each ships, each is verifiable on its own.

### 5a — Status vocabulary and the human-wins lock (~1 day)
`core/schema.py` three-tier ladder + `status_rank`; `core/sheets.advance_status`
lock; `tracker/join.py` guard; migration `0003_pipeline.sql` (`status_actor`,
`status_set_at`, trigger); `webapp/lib/pipeline/statuses.ts` + parity test.
Python tests first. **No UI.** Discharges AC 14; closes matrix rows 25, 40.
Verifiable: `pytest` green with the new Offer-vs-rejection case, which is red
before this lands.

### 5b — The write functions and the fake (~1–2 days)
`app_set_triage` (the missing one), `app_set_status`, `app_resolve_suggestion`,
`app_add_note`, `app_set_next_action`; the `events` idem unique index;
`DataSource` additions; `FixtureDataSource` implementations plus
`simulateExternalEdit`; `pipeline/actions.ts`. Vitest suite first. **Still no
UI.** Closes matrix rows 26, 32 (fake side). Verifiable: `npm test`.

### 5c — Notes as an entity (~1 day)
`application_notes` table + policies + non-destructive backfill; `notes()` /
`addNote`; export rule change (newest note); Vitest. Closes 28, 29.

### 5d — The pipeline surface (~2–3 days)
`@tanstack/react-table` grouping, Radix `Select` + `Dialog`, suggestion
confirm/reject, evidence link, withdraw/reopen, next action, delisted badge,
`?open=` URL state, the demo-param seam. Full `pipeline.spec.ts`. Discharges
AC 11, 12, 13 (render side); closes 27, 30, 31, 33, 34, 36, 38, 39, 42.

### 5e — Density, large type, needs-review (~1 day)
`data-density` / `data-type-scale`, persona defaults from `profiles`, the
"Needs review" group from ambiguous email events. Discharges AC 15; closes 37,
41.

### 5f — Real-database concurrency proof (~half day)
`db/tests/concurrency.sql`, CI job that skips without `SUPABASE_DB_URL`.
Discharges AC 26 properly. Closes 35 alongside the render-budget assertion.

---

## 9. Explicit non-goals

Do not build here: import (phase 6), the profile wizard (7), the digest (8),
saved views or the filter vocabulary (phase 4 — the grid), contacts, the scout
role and its permission model (§B5), or unlocking `status_actor`. The pipeline
becoming a second grid is the way this phase overruns.

## 10. Open questions for the owner

1. Does `Offer-Accepted` end the search — do other in-flight applications get
   offered a bulk `Withdrawn`? Currently planned as: no automatic action, a
   toast offering it, nothing implicit.
2. Should a reopen restore the pre-terminal status or always land on `Applied`?
   Planned: always `Applied`, because the intermediate history is in `events`
   and guessing is worse than a known starting point.
