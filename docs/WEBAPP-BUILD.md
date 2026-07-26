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
- [ ] **Next up — the rest of Track 2** (`docs/plans/HQ-V2-BUILD.md`): P9 profile
      wizard, P10 import, P11 digest.
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
