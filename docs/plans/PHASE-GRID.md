# Phase plan — GRID (build order step 4)

The "looks like Airtable" surface: `/jobs`, a dense virtualized grid over every
posting the user has been gated on, with filters, saved views, selection, and
the why-filtered escape hatch. Companion docs: `docs/PRODUCT-SPEC.md` (D, C, E,
G, H), `docs/WEBAPP-BUILD.md` (matrix rows 18 and 19 are owed by this phase).

## 0. Ground truth — what exists vs. what must be created

**Exists (read before touching):**
- `webapp/lib/data/source.ts` — `DataSource.jobs(): Promise<JobView[]>` is
  already declared and implemented in both sources ("filtering happens
  client-side over this"). Supabase caps at 5000 (`supabase-source.ts:100`).
- `webapp/lib/data/view-models.ts` — `JobView` (incl. `compMinK/compMaxK`,
  `disposition`, `dispositionReason`, `triage`, `updatedAt`),
  `explainReason()`, `reasonSetting()` (reason token → profile field name).
- `webapp/lib/export/columns.ts` (`JOB_COLUMNS`) + `lib/export/delimited.ts`
  (`toCsv`/`toTsv`, RFC-4180, BOM) — the copy/export payload builders.
- `webapp/app/(app)/queue/actions.ts` — `setTriageAction` server action; the
  only write path. `webapp/app/(app)/nav-links.tsx` already links `/jobs`
  (currently a 404) and `/settings` (also a 404).
- Test scaffolding: `tests/e2e/layout.spec.ts` (PAGES × 6 widths overflow),
  `resilience.spec.ts` (console errors, axe both themes, tab-walk, 200% zoom),
  `triage.spec.ts` (clock pinning + per-test `hq_demo_id` cookie pattern),
  `visual.spec.ts` (opt-in snapshots). Playwright runs demo mode on port 3210,
  chromium desktop 1280×900 + Pixel 7.
- Tokens: `app/globals.css` — 13px body (`--text-sm`), `.tabular`, html/body
  `overflow-x: hidden` already enforced.
- `db/migrations/0001_init.sql` + `0002_invariants.sql` — read-only RLS, no
  browser write policies.

**Does not exist — must be created:**
- `webapp/app/(app)/jobs/` — page, grid client component, loading skeleton.
- `webapp/lib/grid/` — `url-state.ts`, `filter.ts`, `columns.tsx`,
  `presets.ts`, `selection.ts`, `comp.ts`, `binding-constraint.ts`.
- `db/migrations/0003_saved_views.sql` — `saved_views` table + write function.
- `lib/data/perf-fixtures.ts` — deterministic 5k-row generator.
- `DataSource.savedViews()/saveView()/deleteView()` methods + fixture and
  Supabase implementations + a `views/actions.ts` server action.
- A `/settings` stub page (the why-filtered link target; nav already 404s).
- Unit tests `tests/unit/{url-state,filter,comp,selection,presets,reasons}.test.ts`
  and e2e `tests/e2e/{grid,grid-perf,grid-url,grid-views,grid-selection}.spec.ts`.

**Pre-existing gap to resolve first (flag, do not silently absorb):**
`supabase-source.ts:161` calls `rpc("app_set_triage", …)` but no migration in
`db/migrations/` defines it — it was evidently applied to Supabase out of band.
`0003_saved_views.sql` must also bring the canonical `app_set_triage` DDL into
the repo (or a `0003a` doing only that), so the repo is again the source of
truth before a second write function is stacked on the same pattern.

## 1. Design (the part that must not be a component checklist)

Reference points, and what is actually being copied from each:
- **Airtable**: 32px dense rows, sticky header, sticky first column, a view
  switcher that is the primary nav within the surface, filters as chips.
- **Linear**: keyboard-first — `j`/`k` active row, `x`/`Space` select, actions
  operate on selection; density toggle; zero decoration, color = state only.
- **Superhuman**: the grid owns the whole viewport below the toolbar; no cards,
  no padding theater; counts in the toolbar ("312 of 340 · 12 selected").
- **Stripe/Vercel consoles**: right-aligned tabular numerics, `fmtDay` dates,
  single-line truncation with `title=` hover, hover row tint, border-separated
  rows (no zebra — zebra fights the selection tint).

**Density and type.** Two densities, fixed row heights (this is what makes
virtualization exact — `estimateSize` is a constant, no measurement pass):
- `dense`: 32px rows, `text-sm` (13px) — owner default.
- `comfortable`: 44px rows, `text-base` — Dad. His "large type" is a third
  knob, `typeScale: "large"`, which bumps the grid container to 16px via a
  CSS var — never `html { font-size }`, which would fight the 200%-zoom test.
Density/typeScale/hints live in view state (see §4), not the URL.

**Column plan** (initial widths in px; react-table columnSizing, min 60):

| Column | Width | Align | Notes |
|---|---|---|---|
| Company | 160, **sticky left** | left | `bg-surface`, right border, z above cells |
| Title | 300 (min 220) | left | the one truncating flex column; link, `noopener` |
| Comp | 130 | right | renders `compRange` verbatim; sorts on `compMaxK` |
| Min YoE | 70 | right | `minYoe ?? "—"` |
| Work model | 110 | left | |
| Location | 150 | left | |
| Metro | 120 | left | hidden in default view |
| Posted | 90 | right | `fmtDay` |
| First seen | 90 | right | `fmtDay`, hidden by default |
| Decision | 110 | left | triage as `Badge` (`undecided`/`interested`/…) |
| Why | 220 | left | **only in "All postings"**: `explainReason()` chip → link |

Total ≈ 1450px: horizontally scrolls **inside the grid container** at 1280.
The container is the only scroller (both axes): `overflow: auto` div with
`tabIndex={0} role="region"` exactly like the pipeline table's, plus
`role="grid"`/`aria-rowcount`/`aria-rowindex` because virtualization removes
rows from the DOM. Header is `position: sticky; top: 0` *inside* that
container; company cells `position: sticky; left: 0`. The page body never
scrolls sideways — `/jobs` joins `PAGES` in `layout.spec.ts` on day one.

**Selected** row: `bg-accent-subtle`; **active** (keyboard cursor) row: inset
ring. Both, together, must remain distinguishable — visual snapshot covers it.

**Empty states** (three, per `components/ui/empty.tsx` doctrine): no rows at
all ("nothing gated yet"); filters hide everything — names the binding
constraint with counts, per spec G9 ("comp ≥ $150k hides 312 of 340") and
offers one-click "clear filters" + a link to All postings; and All-postings
empty (engine has never run).

## 2. Architecture

**Data flow.** Server component `app/(app)/jobs/page.tsx` calls
`(await getDataSource()).jobs()` and passes rows to a `"use client"` grid —
same shape as `/queue`. At the 5000-row cap the RSC payload is ~2MB raw,
roughly 250–400KB gzipped; acceptable at 3 users, revisit before 10k (noted in
§7). Like the queue, the grid owns its working set: no `revalidatePath`
mid-session; writes update local rows optimistically.

**Column model.** `lib/grid/columns.tsx` exports `ColumnDef<JobView>[]` for
@tanstack/react-table 8.21.3 (`getCoreRowModel` + `getSortedRowModel` +
`getGroupedRowModel`/`getExpandedRowModel` for grouping). Filtering does NOT
use react-table's filter models: our vocabulary (§3) is compiled to a
predicate by `lib/grid/filter.ts` and applied to the array *before* it enters
the table, so the entire filter engine is pure and Vitest-testable. Sorting:
custom `sortingFn`s where null must lose — nulls sort last in **both**
directions (comp, minYoe, posted); unit-tested.

**Virtualization.** `useVirtualizer` from @tanstack/react-virtual 3.14.7,
`getScrollElement: () => containerRef.current`, `estimateSize: () => rowHeight`
(constant per density), `overscan: 10`. Row virtualization only — 11 columns
does not need column virtualization. Group headers are rows in the flattened
model (react-table grouping emits them in `getRowModel().rows`), so the
virtualizer sees one flat list. Density switch calls `virtualizer.measure()`
and re-anchors scroll to keep the active row in view.

**Writes.** Unchanged doctrine: every gesture is a server action → one
Postgres function → row + event in one transaction, idempotency key +
`expectedUpdatedAt`. The grid adds two:
1. Triage from the grid (single + bulk) — single reuses `setTriageAction`
   as-is. Bulk (spec C: "one transaction, N events, one undo") needs
   `app_set_triage_bulk(p_items jsonb, p_idem text)` — does not exist, must be
   created in 0003 — plus `DataSource.setTriageBulk()` in both sources. The
   fixture models per-row conflict inside the batch (one stale row fails the
   whole batch, matching the transaction semantics).
2. Saved-view writes — `app_save_view` (§4).

**Inline editing: where it is NOT allowed — everywhere on this surface.**
Every `JobView` field is engine-owned (company/title/comp/tags/geo/
disposition) except `triage`, and triage is a *decision*, not a text edit — it
happens through the triage gestures only. The grid ships with **zero editable
cells**; there is no edit affordance to suppress because none is rendered.
The editable-cell pattern (status, next_action, notes — human-owned columns)
arrives with the Pipeline phase (build order 5), which is the first surface
that has any business editing inline. This is stated here so a future session
does not "helpfully" add a text input to a grid of engine-owned data.

## 3. Filters and the URL (matrix row 19)

**Vocabulary** (spec D, verbatim): text `has`/`is`/`empty`; enum `in`/`notin`
(is-any-of / is-none-of, `|`-joined values); number + parsed comp `gte`/`lte`/
`between`; date `before`/`after`/`inlast` (days); tri-state remote
`remote`/`onsite-hybrid`/absent=any. Compound: **AND-groups of OR-clauses,
max depth 2** — enforced by the parser type, not by convention.

**Serialization** (`lib/grid/url-state.ts`, pure, no React): each `f=` param
is one AND-group; OR-clauses within a group join on `,`; a clause is
`field.op.value` split on the **first two** dots so values may contain dots.
PostgREST-style, human-readable, diffable:

```
/jobs?view=b2c4…&f=workModel.in.Remote|Hybrid&f=compMax.gte.150,compRange.empty.true
      &sort=posted.desc&q=payments&group=company
```

reads: (work model any of Remote, Hybrid) AND (comp top ≥ $150k OR comp
unstated) — sorted by posted desc, quick-search "payments", grouped by company.

**What lives where** (the row-19 contract):

| State | Lives in | Why |
|---|---|---|
| view id (`view=`) | URL | deep-linkable identity |
| filters, sort, quick search, grouping | URL (as deltas over the view) | back/forward must replay them; shareable |
| column order/widths/hidden, density, typeScale, hints | `saved_views.state` | display prefs; URL-encoding widths is noise |
| selection, active row, scroll offset | memory only | never navigational state |

URL updates use `router.replace` with shallow semantics debounced 300ms while
typing, but `router.push` on discrete changes (add/remove a filter chip, change
view) so Back steps through *decisions*, not keystrokes. Loading `/jobs?view=X`
with no other params renders exactly the saved state; extra params are deltas
and the toolbar shows "edited — Save / Save as / Reset".

**Comp semantics.** Comp clauses compare against the *top* of the band
(`compMaxK`), matching gate rule H7. Per edge case G16, a comp clause **keeps**
`compRange === null` rows by default; the chip states "incl. 12 unstated" and
excluding them is an explicit second clause (`compRange.empty.false`), never a
silent side effect. `supabase-source.ts` currently hard-nulls
`compMinK/compMaxK` ("parsed server-side… not needed to render") — that was
true for the card, false for the grid. `lib/grid/comp.ts` (must be created)
parses `"$110,000 - $160,000"`/`"$175k+"` → `[110,160]`, returns null for
"DOE"/"£90k" (non-USD stays unparsed by design), and `toJobView` calls it.
Unit-fixed against the real strings in `lib/data/fixtures.ts`.

## 4. Saved views (entity does not exist — created here)

`db/migrations/0003_saved_views.sql`:

```sql
create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  surface text not null default 'jobs',
  name text not null,
  state jsonb not null default '{}'::jsonb,  -- {filters, sort, group, q,
                                             --  columns:{order,widths,hidden},
                                             --  density, typeScale, hints}
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index saved_views_one_default
  on public.saved_views (user_id, surface) where is_default;
create unique index saved_views_name
  on public.saved_views (user_id, surface, lower(name));
alter table public.saved_views enable row level security;
create policy saved_views_self_read on public.saved_views
  for select using (user_id = auth.uid());
-- writes ONLY via app_save_view / app_delete_view (security definer):
-- upsert + events row ('view.saved' | 'view.deleted', payload carries view id
-- and idem key) in one transaction; p_expected_updated_at mismatch raises
-- 'conflict'; replayed idem key returns the stored result.
create trigger saved_views_touch before update on public.saved_views
  for each row execute function public.touch_updated_at();
```

Idempotency storage: a unique partial index on
`events ((payload->>'idem')) where payload ? 'idem'` gives every write
function the same replay guard; 0003 creates it and `app_save_view` uses it
(and `app_set_triage`'s repo-canonical DDL adopts it — see §0 flag).

**Built-in presets** (`lib/grid/presets.ts`, code not DB — they must exist
with zero setup and are not deletable): `Queue` (qualified + untriaged +
posting not Closed — the H16 predicate), `All postings incl. filtered`
(no disposition filter, Why column visible), `Snoozed`, `Dismissed`,
`Needs review` (`disposition = needs-info`). Editing a preset and saving
creates a real `saved_views` row ("Save as…"). Per-persona defaults from spec
D are presets + state: owner → Queue/dense/hints-on; Dad →
comfortable/large/hints-off (his landing default is Pipeline, wired when the
pipeline grid lands in phase 5 — this phase stores `is_default` faithfully);
roommate → Queue + `firstSeen.inlast.7` + `group=company`. Until the profile
wizard exists there is no per-persona provisioning UI; the defaults ship as
presets anyone can pick and set default ("Use as my landing view").

## 5. Selection, copy, export scope

`lib/grid/selection.ts` (pure): `Set<postingKey>` + anchor index over the
**current filtered+sorted flat row order**. Click = select-only; ⌘/Ctrl-click
= toggle; **shift-click = contiguous range from anchor** (group-header rows
are skipped, never selected); `Space` toggles the active row; `Shift+j/k`
extends; `Escape` clears. Rule: selection persists across filter changes **by
key, minus rows the new filter hides** — "export selection" must never emit an
invisible row (spec E: silent scope surprise is a top-tier trust bug). The
pruning rule is a pure function with unit tests.

- `⌘C` → `toTsv(selectedRows, JOB_COLUMNS)` → clipboard, toast "Copied 12 rows".
- Export: the Export phase's core (`lib/export/delimited.ts`) is done but the
  dialog is still unshipped (WEBAPP-BUILD "Current state"). The grid toolbar
  gets an Export menu (radix DropdownMenu) with explicit scope lines —
  "Current view (312 rows)" / "Selection (12)" / "All (340)" — feeding
  `toCsv`; when the Export dialog lands it consumes the same
  `{scope, rows}` contract. Column set for "current view" = visible columns
  in view order, mapped through `JOB_COLUMNS` by key; hidden columns are
  excluded and the menu says so. Discharges **H22**.

Bulk triage: selection + `i`/`x`/`s` → one `setTriageBulkAction` → one
transaction, N events, **one undo** (toast action replays the inverse batch
with a fresh idem key). Grid keyboard handlers use the same
`INPUT|TEXTAREA|SELECT` guard as `triage-queue.tsx` so typing in a filter
input can never triage rows.

## 6. Why-filtered and the escape hatch (spec C)

In All postings, the Why column renders `explainReason(dispositionReason)` as
a chip; clicking it (or pressing `?` on the active row, opening a radix
Popover) shows the sentence **and the profile field that caused it** via
`reasonSetting()` — "Located in India, outside your **countries** → change" —
linking to `/settings#countries`. `reasonSetting` returns
`countries|metros|yoeMax|seniorityExclude|compMin|workModelExclude`; those are
the anchor ids. `/settings` does not exist and nav already dead-links it, so
this phase ships a stub page with those anchors as headings and "editing
arrives with the profile wizard" copy — an affordance must not 404. The
`Queue → nothing?` empty state links to All postings (spec D's "why am I
seeing nothing?" hatch), and All postings is always present in the switcher.

## 7. Failure-mode matrix — NEW rows (append to docs/WEBAPP-BUILD.md)

| # | Failure mode | Enforced by |
|---|---|---|
| 25 | Virtualization silently off — 5k rows in the DOM, tab crawls | `grid-perf.spec.ts`: with the `perf-5000` store, rendered `[role="row"]` count ≤ 80 at top, middle, bottom scroll positions |
| 26 | Scroll jank at 5k rows (perf collapse, matrix row 18) | same spec: 4× CPU throttle via CDP; PerformanceObserver `longtask` buffer empty of tasks > 200ms across a scripted 30-viewport scroll; `j`-held row advance keydown→paint (double-rAF) p95 < 120ms |
| 27 | Sticky header or first column drifts under diagonal scroll | scroll container to (800, 4000); header bbox `y` unchanged, company-cell bbox `x` unchanged, header/body column edges align within 1px |
| 28 | The grid overflows the PAGE instead of its container | `/jobs` added to `PAGES` in `layout.spec.ts` (6 widths) + assert container `scrollWidth > clientWidth` while `document` does not |
| 29 | Back/forward loses filters; deep link renders a different grid (row 19) | `grid-url.spec.ts`: apply 2 filters + sort → navigate away → Back → same URL, same first-row key, same count; fresh `page.goto(fullUrl)` renders identical state |
| 30 | URL round-trip drops or reorders a clause | Vitest: `parse(serialize(s)) === s` across generated filter states (every op × field type, incl. values containing `.` `,` `|` and unicode) |
| 31 | Comp filter silently drops "DOE"/unparsed comp (G16) | Vitest: comp clause keeps `compRange:null` rows; e2e: chip shows "incl. N unstated" against fixtures |
| 32 | Two tabs editing one saved view → silent clobber | fixture models `expectedUpdatedAt` conflict on `saveView`; e2e second save shows conflict toast, view state not overwritten |
| 33 | Export/copy scope includes rows the filter has hidden | Vitest: selection pruning on filter change; e2e: select 3 → tighten filter to hide 1 → copy → clipboard has exactly 2 data rows |
| 34 | Shift-click range wrong across sort/group boundaries | e2e: group by company, sort desc, shift-click across a group header → exact expected key set, header not selected |
| 35 | Nulls sort as 0 — no-comp rows jump to the top of "comp desc" | Vitest sortingFn tests: null last in asc AND desc for comp/minYoe/posted |
| 36 | Density/type-size switch mid-scroll → blank viewport or lost cursor | e2e: scroll to row ~2500, toggle comfortable → active row still visible, no empty gap (a `[role=row]` intersects viewport center) |
| 37 | Why-filtered names the wrong profile field | Vitest: `reasonSetting`/`explainReason` exercised over every token in the A2 closed set; e2e: chip on the `geo:India` fixture links to `/settings#countries` |
| 38 | Typing in a filter input triggers triage shortcuts | e2e: focus quick-search, type "jxi" → row count unchanged, no toast |
| 39 | Zero-result filter renders a blank grid, not the named constraint (G9) | e2e: apply an impossible comp floor → empty state names the binding filter + counts, "Clear filters" restores |

Rows 25–27 replace the hand-wave in matrix row 18 with the actual budget; row
29 discharges matrix row 19. On landing, edit rows 18/19 in WEBAPP-BUILD.md to
✅ with pointers to these rows.

**Row 26 measurement, precisely** (this is the render-budget assertion):
`tests/e2e/grid-perf.spec.ts` sets cookie `hq_demo_id=perf-5000` —
`get-source.ts` gains: a demo id with prefix `perf-` seeds
`new FixtureDataSource(makePerfJobs(N))` from `lib/data/perf-fixtures.ts`
(deterministic mulberry32-style seeded generator, no `Math.random`, dates
relative to `FIXTURE_NOW`). Then:

```ts
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await page.evaluate(() => {
  (window as any).__longTasks = [];
  new PerformanceObserver((l) => (window as any).__longTasks.push(
    ...l.getEntries().map((e) => e.duration),
  )).observe({ type: "longtask", buffered: true });
});
// scripted scroll: 30 steps of one viewport height, rAF-awaited between steps
// then: expect(longTasks.filter(d => d > 200)).toEqual([])
// and at each sampled position: expect(rowLocator.count()).toBeLessThan(80)
```

80 = ceil(900px viewport / 32px rows) ≈ 28 visible + 2×10 overscan + group
headers, with ~1.6× headroom. Chromium-only API — both Playwright projects are
chromium, per `playwright.config.ts`.

## 8. Increments — each shippable, tests written first

**G1 — Read-only virtualized grid at `/jobs`** (~1 session, M)
Tests first: `/jobs` into `layout.spec.ts` PAGES and `resilience.spec.ts`
PAGES (they fail: route 404s); `grid.spec.ts` (renders all 18 fixture rows,
Not-listed comp renders "—"/verbatim, long Northwestern-Mutual fixture row
truncates not wraps); `grid-perf.spec.ts` rows 25–27 (fail: no perf store).
Then: `perf-fixtures.ts`, `get-source.ts` perf hook, `lib/grid/columns.tsx`,
`jobs/page.tsx` + `jobs-grid.tsx` + `loading.tsx` skeleton (same dimensions),
sticky header + company column, dense density only, hardcoded Queue preset as
the working set plus an "All postings" toggle so the surface is honest from
day one. Kills the `/jobs` dead nav link. Discharges matrix row 18; supports
H16 (Queue preset excludes `postings.status === "Closed"` — asserted in
`grid.spec.ts` against the fixture set).

**G2 — Filter engine + URL state** (~1–1.5 sessions, L)
Tests first: `tests/unit/url-state.test.ts` (row 30 round-trips, depth-2
enforcement, malformed-param fallback → clause dropped loudly with a toast,
never a crash), `tests/unit/filter.test.ts` (every op; G16 comp-null rule;
depth-2 AND-of-OR truth table), `tests/unit/comp.test.ts` (real fixture
strings + "DOE", "£90k", "$175k+"), `grid-url.spec.ts` (row 29),
`grid.spec.ts` additions (rows 31, 38, 39). Then: `comp.ts` (+ `toJobView`
wiring), `filter.ts`, `url-state.ts`, `binding-constraint.ts` (drop each
AND-group, count recovered rows, name the max), filter bar UI: chips +
radix Popover clause builder, quick-search input, sort headers (row 35 unit
tests), `group=` support. Discharges matrix row 19.

**G3 — Saved views + personas** (~1 session, L; includes the migration)
Tests first: `tests/unit/presets.test.ts` (preset predicates: Queue ≡ H16
semantics, roommate 7-day window against pinned clock), fixture-level
`saveView` conflict/idempotency unit tests, `grid-views.spec.ts` (create from
edited state, switch, set default → landing view, rename collision rejected,
row 32 conflict). Then: `0003_saved_views.sql` (incl. canonical
`app_set_triage` DDL + events idem index — §0 flag), `DataSource`
additions in `source.ts` + both implementations, `views/actions.ts` server
action, view switcher + density/typeScale/hints controls (row 36 e2e),
persona presets. `/settings` stub page with anchors ships here (row 37 e2e).

**G4 — Selection, copy, export scope, bulk triage** (~1 session, M)
Tests first: `tests/unit/selection.test.ts` (range/anchor/prune rules, group
headers skipped), `grid-selection.spec.ts` (rows 33, 34; ⌘C clipboard content
byte-asserted TSV; bulk `i` on 3 rows → 3 applications in fixture store, one
undo reverts all; conflict inside batch → whole batch reverts + toast). Then:
`selection.ts`, toolbar counts, Export menu wired to `toCsv`/`toTsv` scope
contract, `app_set_triage_bulk` in a `0004` migration + `setTriageBulk` on
both sources + action. Discharges **H22** (e2e: filter to a subset, export
current view, assert header + exactly-N rows) and exercises **H26**'s 409
path from a second surface; H9/H10 semantics are inherited by reusing
`setTriageAction` unchanged.

**G5 — Polish gate** (~0.5 session, S)
Visual snapshots for `/jobs` both themes × both densities (opt-in per
WEBAPP-BUILD decision 4), axe re-run (grid roles are easy to get wrong:
`role=grid`>`row`>`gridcell`, `aria-rowcount`/`aria-rowindex` on virtualized
rows, `aria-multiselectable`), **open the app and look at it** (the rows-22–24
lesson) — then update WEBAPP-BUILD.md: matrix rows 18/19 → ✅, new rows 25–39
appended, "Current state" updated.

Ship order is strict: G2 depends on G1's DOM, G3 on G2's url-state shape,
G4 on G2's row order. Nothing in G1–G4 blocks the Export-dialog or Pipeline
phases; the pipeline grid (phase 5) reuses `columns.tsx` patterns, the
selection model, and `saved_views.surface = 'pipeline'` unchanged.

## 9. Decisions logged here so they are not re-litigated

1. **Fixed row heights per density.** No dynamic measurement, no
   `measureElement`: constant `estimateSize` is what makes rows 25–27
   assertable and scroll math exact. A future "wrap long titles" request is
   answered with the comfortable density or a detail panel, not variable rows.
2. **Filtering is ours, table is TanStack's.** react-table does columns,
   sorting, grouping, sizing, selection plumbing; the filter language never
   enters react-table state, so the vocabulary stays a pure, unit-tested
   module that the export scope and the empty state reuse.
3. **URL carries decisions, view rows carry preferences.** The split in §3's
   table is the row-19 contract; do not move widths into the URL or filters
   out of it.
4. **No inline editing on engine-owned data — no exceptions.** §2. The first
   editable cell in this app appears on the Pipeline surface.
5. **Comp filters keep unknowns by default** (G16) and compare on the band
   top (H7). Excluding unknowns is an explicit clause the user can see.
6. **Server-fetched rows, client-side filtering** up to the existing 5000-row
   cap. If real data approaches the cap, the revisit is server-side filtering
   behind `DataSource.jobs(opts)` — the interface already isolates it.

## 10. Flags for the owner / next session

- `app_set_triage` has no migration in the repo (§0). 0003 fixes this; if the
  deployed function differs from what 0003 writes, reconcile before applying.
- Dad's landing default is Pipeline-grouped (spec D) but the pipeline grid is
  phase 5; until then his default points at the comfortable Queue preset and
  the `is_default` row carries the real target for phase 5 to honor.
- The RSC payload at 5k rows (~250–400KB gzipped) is fine for 3 users; noted
  as the first thing to change on the way to 10 users (§9.6).
- `visual.spec.ts` baselines are still macOS-only/opt-in; G5 adds grid
  snapshots under the same `PLAYWRIGHT_VISUAL=1` gate, not a new mechanism.
