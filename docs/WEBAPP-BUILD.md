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
| 14 | Visual drift | `toHaveScreenshot` per theme — **needs Linux baselines recorded on a runner** | ◐ |
| 15 | Empty states unrendered | `empty.spec.ts` — per-surface zero-row test in both viewports, seeded via `hq_demo_seed`; the queue distinguishes **filtered-out from nothing-found** and names the binding constraint; axe runs on the empty page | ✅ |
| 16 | Session expires mid-action | The action answers `kind: "auth"` rather than letting middleware redirect a POST; the gesture goes to the outbox and is delivered on the next page load after sign-in | ✅ |
| 17 | Offline / flaky network | `lib/outbox.ts` — the decision is kept, not reverted; banner, auto-replay on reconnect, safe because every gesture carries its idempotency key | ✅ |
| 18 | Perf collapse at 5k rows | Virtualization + a render-budget assertion | ⬜ (grid phase) |
| 19 | Back/forward + deep links | URL-addressable views | ⬜ (grid phase) |
| 20 | Types drift from the DB | Contract test: schema ↔ `lib/types.ts` | ⬜ |
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
- [ ] Grid phase (next; `docs/plans/PHASE-GRID.md`)

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
