# design-sync notes — hq-webapp → claude.ai/design

Repo-specific gotchas for whoever runs the next sync. Read this before touching
`config.json`. Project: `https://claude.ai/design/p/5dab7624-ca55-433e-a6e1-c9d074c93668`.

## What this DS is

`webapp/` — a Next.js 15 App Router app, not a published component library. There
is no `dist/`, no `.d.ts` tree, no Storybook. The converter runs in **synth-entry
mode**: it star-exports every file under `cfg.srcDir` and bundles that.

## The four non-obvious wiring decisions

- **`webapp/node_modules/hq-webapp` is a symlink to `..` (i.e. to `webapp/`), and
  the build does not work without it.** `package-build.mjs` computes
  `PKG_DIR = join(--node-modules, cfg.pkg)`, and npm never self-installs, so that
  path is missing in the app's own repo. The symlink makes `PKG_DIR` resolve to
  `webapp/`, which is what makes every package-relative config path
  (`srcDir`, `cssEntry`, `componentSrcMap`) read naturally. Recreate after any
  `npm ci` in `webapp/`:
  `ln -sfn .. webapp/node_modules/hq-webapp`
  One consequence: `resolve()` is textual, so paths that must ESCAPE the package
  need three `../` hops, not one — hence `"../../../.design-sync/…"` for
  `extraEntries` and `tsconfig`. Anything INSIDE webapp is written normally,
  because the symlink makes the subpaths equivalent.

- **`cfg.srcDir` is `components/ui`, not `components` or `.`.** The synth entry
  star-exports every file in that directory, so the directory must contain
  browser-safe files only. `components/` also holds `export-dialog.tsx`,
  `pending-work.tsx` and `warm-cell.tsx`, each of which imports a `"use server"`
  module (→ `next/headers`); `app/` is worse. `components/ui/` is exactly the six
  primitives, so it is the only clean synth root in the repo.

- **The app-level composites come in through `cfg.extraEntries` →
  `.design-sync/ds-entry.tsx`** (a committed file in this directory). It names
  them explicitly because they are mostly `export default` and a star-export entry
  drops defaults, and because no directory holds composites and nothing else. Add
  or remove a composite in TWO places: `ds-entry.tsx` and `cfg.componentSrcMap`.

- **`cfg.tsconfig` points at `.design-sync/tsconfig.paths.json`, NOT at
  `webapp/tsconfig.json` — and that is a workaround for a converter bug, not a
  preference.** `lib/bundle.mjs`'s `tsconfigPathsPlugin` strips JSONC comments
  with `/\/\*[\s\S]*?\*\//g` before `JSON.parse`. `webapp/tsconfig.json` contains
  a `/*` inside the alias `"@/*"` and a later `*/` inside the include glob
  `"**/*.ts"`, so the stripper eats everything between them, `JSON.parse` throws,
  the plugin returns `null` **silently**, and every `@/…` import fails to resolve
  with a wall of `Could not resolve "@/…"`. The shim file carries the same alias
  with no glob after it. **If you ever see `[UNRESOLVED_IMPORT] @/…`, this is why.**
  Do not "fix" it by forking `lib/bundle.mjs` — the skill forbids forking that
  module (it defines the output contract with the app's self-check).

## Styling — Tailwind v4, compiled on purpose

The utility CSS the components reference does not exist as a file anywhere in the
repo; Tailwind v4 runs inside Next's PostCSS pipeline. `.design-sync/build-css.mjs`
compiles `webapp/app/globals.css` (tokens + `@theme` + base layer) through the
webapp's own pinned `@tailwindcss/postcss` 4.3.3 into `webapp/.ds-styles.css`
(~42 KB, gitignored), and `cfg.cssEntry` points at it.

**Run it before every build:** `node .design-sync/build-css.mjs`. It is not wired
into `package-build.mjs`, so a sync that skips it ships whatever stale file is on
disk — or none, and every card renders unstyled.

`cssEntry` is bounded to the package dir by the converter, which is why the
artifact lives under `webapp/` rather than beside this file.

Verified 2026-07-27 by rendering Badge/Button/Kbd/EmptyState/TriageCard/StepHeader
off the built bundle in headless chromium: accent `rgb(63,95,75)`, badge tone
backgrounds, `rounded-md` 6px, the system font stack — real DS styling, not
browser defaults.

## Fonts

There are none to ship, by design. `globals.css` sets `--font-sans` to the system
UI stack and `--font-mono` to `"SF Mono", ui-monospace, Menlo, Consolas` — the
comment in that file says naming a webfont the app never loads would mean silent
per-machine fallback. `cfg.runtimeFontPrefixes` lists those families so
`[FONT_MISSING]` stays quiet about fonts the host is expected to provide. No
substitutes were shipped and none should be. `app/layout.tsx` uses no `next/font`.

## Component scope — and what is deliberately out

**In (14):** the six primitives (`Badge`, `Button`, `DialogContent`, `EmptyState`,
`Kbd`, `Toaster`) plus eight composites (`TriageCard`, `CoverageMeter`,
`ProvenanceChip`, `ReviewBar`, `SelectionBar`, `StatusSelect`, `StepHeader`,
`PreviewPanel`).

**Out, and why** — the rule is *browser-safe import closure*:

| Excluded | Reason |
|---|---|
| `ExportDialog`, `PendingWork`, `NotesDialog`, `PipelineTable`, `WarmCell` | import a `"use server"` actions module → `next/headers` |
| `UploadPanel`, `MapStep`, `CommitStep`, `PreviewStep`, `ReportStep`, `JobsGrid` | `server-only`, and/or `next/navigation` |
| `NavLinks`, `WhyChip`, `CompaniesGrid`, `ViewSwitcher`, `AddForm`, `Wizard`, `ProfileForm` | `next/navigation` (`usePathname`/`useRouter`) — no router context in a preview card |
| `SetupNotice` | styled by `.setup-box`, a class no stylesheet in this repo defines |
| `FilterBar`, `ExportMenu`, `SweepToggle`, `Section`/`ChipList`/`MoneyField`/`NumberField` (settings/fields.tsx) | browser-safe and syncable — left out only to keep the first campaign's scope honest. **These are the standing offer for the next re-sync.** |

Exclusion is honest; a floor card is not a failure. Do not hand-shim a router to
get `NavLinks` in — a `cfg.provider` fix would have to be clean, and Next's app
router context is not.

`ProvenancePopoverContent` and `StepShell` are exported on `window.JobHQ` but are
NOT synced components: they exist so an authored preview can compose a leaf inside
the parent it actually needs (Radix `Popover.Root` in the first case).

## Known build/validate warns (checked every re-sync — an unrecorded warn is new)

- **`[EXPORT_COLLISION] ds-entry.tsx exports 8 name(s) the main package also
  exports`** — a **false positive**, expected on every run. In synth-entry mode
  `package-build.mjs` marks every discovered component as "exported by main"
  before comparing against `extraEntries`, so the eight composites collide with
  themselves. Verified harmless: the runtime footer merges `__dsMainNs` over the
  IIFE global, the synth entry's namespace genuinely does not contain those names,
  and `Object.keys(window.JobHQ)` lists all 23 exports with `TriageCard` rendering
  the real component. (The count grew from 21 to 23 when `toast` and `Popover`
  were added to `ds-entry.tsx` — see the same-instance section below.)
- **`[DTS] parsed 0 .d.ts files from …/hq-webapp/lib`** — expected. `findTypesRoot`
  falls through to `<pkg>/lib`, which here is TypeScript source, not a `.d.ts`
  tree. This is why `cfg.dtsPropsFor` exists (below).
- **`[NO_DIST] no built entry — synthesizing from 6 src files`** — expected, it IS
  the mode. Do not "fix" it by inventing a library build for the app.
- **`docs: 0/14 components matched`** — expected. There is no per-component doc
  tree; `webapp/README.md` is an app README. The `.prompt.md` files are synthesized
  from the props body + the component's leading JSDoc, and the JSDoc in this repo
  is unusually good, so they read well.
- **No `[RENDER_BLANK]` should fire any more.** All 14 components are authored, so
  every render is a real composition. Five components passed through this warn on
  the way (`Badge`, `Button`, `EmptyState`, `Kbd`, `StatusSelect` with empty
  crash-prevention props) and two hit it *after* authoring — `SelectionBar` and
  `ReviewBar`, which was a genuine blank card, not a heuristic misfire (see the
  fixed-position section below). Treat any new `[RENDER_BLANK]` as real and look
  at the screenshot before calling it benign.
- **`[GRID_OVERFLOW]`** fired for all six overlay/fixed components and cleared as
  soon as `cardMode: "single"` was applied. It should stay quiet; if it names a
  new component, apply the mode the warn names rather than guessing.

## `cfg.dtsPropsFor` carries every component's API — by hand

With no `.d.ts` tree there is no prop extraction: every emitted body came out as
`[key: string]: unknown`, which is a useless contract for the design agent. All 14
bodies are hand-written in `config.json`, transcribed from the component sources
on 2026-07-27.

**They do not track the source.** If a component's props change, the `.d.ts` this
DS ships silently lies. Re-read the component before trusting a body on any
re-sync that touches these files. `PreviewPanel`'s body inlines `PreviewResult`,
`BindingRelaxation` and `PreviewSample` (a `.d.ts` body cannot reference a type it
does not declare) and merges `kind: "ready" | "stale"` into one union arm — same
inhabited set, far less repetition.

## Authoring previews in this repo

What the compiler gives you, learned the first time round:

- `import { Button, Kbd, buttonClass } from "hq-webapp"` resolves to
  `window.JobHQ` through the story-import shim — **everything** on the global is
  reachable, including non-component exports like `buttonClass`, `StepShell` and
  `ProvenancePopoverContent`. Bare deps (`lucide-react`, `radix-ui`) resolve from
  `webapp/node_modules` because `buildPreviews` is handed the same `nodePaths`.
- JSX is `automatic` and React is external, so a preview needs **no** React
  import. Type-only references (`React.CSSProperties`,
  `React.ComponentProps<typeof X>["job"]`) are erased by esbuild without a
  checker, which is the cheap way to keep prop objects honest — derive the shape
  from the component instead of restating it. Import `* as React` only when a
  hook is actually called (`StatusSelect.tsx` does, for `useRef`/`useEffect`).
- **A Tailwind class that appears ONLY in a preview does not exist.**
  `build-css.mjs` scans `webapp/app`, `webapp/components` and `webapp/lib` — not
  `.design-sync/previews/`. `max-w-sm` was never used in the app, so two cards
  rendered 1200px wide with no error anywhere. Use **inline styles for preview
  scaffolding** (widths, stage boxes, flex wrappers) and reserve class names for
  utilities the app itself already uses. The alternative — adding a `@source` for
  the previews dir — would ship utilities the DS does not use, so it was not done.
- Composition sources, in the order they were used: the app's own fixture sets
  (`lib/data/fixtures.ts`, `lib/data/preview-fixtures.ts` — deliberately awkward
  rows: no comp, long titles, untagged), then the call sites
  (`queue/triage-queue.tsx`'s decision row, its `mismatchFor` copy), then
  `lib/status.ts` and `explainReason`/`FIELD_LABELS` for exact wording. Nothing
  in these cards is invented copy.

### Same-instance exports (`ds-entry.tsx`) — the trap that fails silently

Three DS pieces read a module-level context or singleton that lives **inside**
`_ds_bundle.js`. A preview that imports the underlying package itself gets a
SECOND copy, and the failure is quiet:

| Preview needs | Import from | If you import the package instead |
|---|---|---|
| `toast()` for `Toaster` | `hq-webapp` (`ds-entry.tsx` re-exports it) | the toast fires into a second sonner instance; the mounted host never hears it, card renders empty |
| `Popover.Root` for `ProvenancePopoverContent` | `hq-webapp` (re-exported) | `Popover.Portal` throws "must be used within Popover.Root" |
| `Dialog` / `DialogTrigger` / `DialogClose` | `hq-webapp` — already there | nothing to do: `components/ui/dialog.tsx` re-exports the DS's own radix |

Rule of thumb: **if a component needs a sibling to work, the sibling belongs on
`window.JobHQ`** — via `ds-entry.tsx`, never via a second npm import in the
preview. Anything added there is also reachable by the design agent, which is the
point.

### Overlays — settled on StatusSelect

Radix portals `Select.Content` to `<body>`, so an open menu escapes its grid
cell: validate fires `[GRID_OVERFLOW] … (fixed/portal)` and names the remedy.
Applied: `cfg.overrides.StatusSelect = {cardMode: "single", primaryStory:
"PipelineRows", viewport: "900x700"}`. The viewport is set explicitly even though
it equals the default — an explicit value is keyed into the grade, so the capture
geometry cannot move under a carried-forward grade.

Six components ended up on `cardMode: "single"` — `StatusSelect`, `Toaster`,
`DialogContent`, `ProvenanceChip`, `SelectionBar`, `ReviewBar` — every one of them
because validate named it, never pre-guessed. `TriageCard` is the one `column`,
chosen by judgment (below). The other seven are plain grid cards.

Consequence of `single` worth knowing: the product's card shows only
`primaryStory`. Every other export is still individually addressable
(`?story=<Export>`) and still captured and graded, so nothing goes unverified —
but pick the `primaryStory` that best represents the component, because it is the
one a browsing human sees.

Opening an overlay for a static capture, by component:

- **Dialog** — `<Dialog defaultOpen>`. Radix's root takes it; nothing else needed.
- **Popover** — `<Popover.Root defaultOpen>`, **plus an anchor** (below).
- **Select** — no `open` prop is forwarded by `StatusSelect`, so its `Open` story
  dispatches a bubbling `keydown` `{key:"Enter"}` at the trigger on mount — the
  same path a keyboard user takes, and Radix's `SelectTrigger` opens on it.
  React's root-level listener picks up the synthetic event. Do NOT use a
  synthetic `click`: Radix opens on `pointerdown`.
- **A plain onClick toggle** (CoverageMeter's "How this is counted") — a real
  `HTMLElement.click()` on its `data-testid` in a mount effect is enough.

**`ProvenanceChip` does not forward refs** — it is a plain function component
that destructures `{company, onClick}`, so React 19 drops the ref prop silently.
Wrapping it in `Popover.Trigger asChild` therefore gives Radix **no anchor
element**: Floating UI falls back to a 0×0 rect at the origin and the panel lands
off the top of the card (measured `rect.y = -386`, and the cell screenshotted as a
bare chip with no error logged anywhere). The fix is `Popover.Anchor asChild`
around a `<span>` wrapper — position went to `y=52` immediately. **Check this
before authoring any other `asChild` composition in this DS**; none of the app's
own components forward refs.

### Fixed-position components in a preview card: `transform` is the fix

The emitted card CSS puts `transform: translateZ(0)` on `.ds-cell` and
`.ds-single`, which makes each cell the containing block for `position: fixed`
descendants. For `SelectionBar` and `ReviewBar` — both `fixed bottom-4 left-1/2`
— that cell measures ~24px tall (the bar is its only content and it is out of
flow), so the bar resolved to `rect.y = -34` and both cards screenshotted
**completely blank** while still counting as "rendered". `[RENDER_BLANK]` caught
it; the byte heuristic was right and the "portals/fixed positioning can collapse
measured output" hint in that warn is the lead to follow.

The fix is in the preview, not the component: each story wraps the bar in a
`Stage` box — `position: relative; transform: translate(0); height: 190px` — so
the bar anchors to the bottom of a box the preview controls. Any non-none
transform creates the containing block. Reuse `Stage` for anything `fixed`.

Note this does NOT work for portalled content (`Popover.Portal`,
`Dialog.Portal`): those mount into `document.body`, outside any wrapper, so a
transform on an ancestor cannot reach them. Portals need the anchor fix above.

**Known, deliberate:** the open menu scrolls at its own `max-h-[20rem]` cap, so
`Custom…` sits below the fold in the `Open` cell. That is the shipped behaviour
(11 statuses + separator + Custom ≈ 360px against a 320px cap), not a broken
render — the `CustomStatus` cell covers the state it leads to. Do not "fix" it.

`TriageCard` carries `{cardMode: "column"}` by judgment, **not** because a warn
asked for it: it is a full-width surface card, and in a 3-up grid its four-tile
decision bar collapses to 2×2 and stops reading as the scan bar it is. `cardMode`
is not part of the grade key, so adding it did not clear any grade (confirmed —
the next full capture printed `carried forward` for all four).

### Rebuild paths — which one to run after a config edit

`lib/preview-rebuild.mjs --components A,B` is the cheap targeted path, and it
accepts **presentation-only** override edits. `cardMode` and `primaryStory` are
presentation. **`viewport` is part of the grade key**, so adding it in the same
edit trips `✗ [CONFIG_STALE] cfg.overrides/cfg.titleMap for a target component
changed since the stamped build` and you must run the full `package-build.mjs`
(it re-stamps the grade keys). Hit this applying the four wave-3 overlay
overrides; not a bug, just the contract. If you want the targeted path, set
`cardMode`/`primaryStory` alone and leave `viewport` off.

**A full `package-build.mjs` wipes `--out`, which deletes
`_screenshots/review/`** — and the next `package-capture.mjs` legitimately reports
`14 carried forward, 0 captured`, so it does NOT re-render them. The grades stay
valid (they key off the authored `.tsx` + preview-affecting config, not the PNGs),
but the sheets a human would look at are gone. **`package-capture.mjs --force` is NOT "re-render the sheets" — it means
"demand fresh verdicts", and it clears every grade file.** Learned the hard way:
reaching for it to get the review PNGs back wiped all 14 verdicts and cost a full
re-read of all 14 sheets to restore them honestly. If you only need the images,
`--components A,B,…` after touching nothing re-renders just those; if you need all
of them, budget the re-read, because a grade you did not look at is not a grade. Validate always regenerates the top-level card
screenshots and the contact sheet, so those survive.

A full `package-build.mjs` takes **4–6 minutes** with 14 authored previews:
`buildPreviews` runs one esbuild pass per file and the ones importing
`lucide-react` cost ~15–20 s each on their own (the icon package is huge and each
pass re-scans it for tree-shaking). Run it in the background and wait for the
notification. It prints `previews: … user-owned` *before* that loop starts, so a
log that stops on that line is still working — check
`ls ds-bundle/_preview/` to watch it tick along rather than assuming a hang.

## Preview scope

All 14 components are authored and graded `good` — 55 cells, no floor cards left.
Closing run: build + validate + capture all exit 0, validate prints **zero
warnings**, render check 14/14 clean (`bad`/`thin`/`variantsIdentical`/`blank`/
`rootEmpty`/`fallbackCard` all 0), capture reports 14 carried forward / 0 cleared.

| Component | Cells |
|---|---|
| `Badge` | Tones · SweepState · InAHeading · LongLabelWraps |
| `Button` | Variants · Sizes · TriageActions · Busy · LinkStyledAsButton |
| `CoverageMeter` | Universe · CountingExplained · EarlyDays |
| `DialogContent` | Confirm · NoteHistory · TitleOnly · ClosedWithTrigger |
| `EmptyState` | Finished · NothingMatches · NothingYet · ASettingFilteredEverything |
| `Kbd` | OnEverySurface · InHelpText · ModifiersAndNamedKeys |
| `PreviewPanel` | Idle · Running · Ready · EngineBehind · Stale · Failed |
| `ProvenanceChip` | Confidences · EvidenceForAVerifiedRow · EvidenceForAnUnprobedSlug |
| `ReviewBar` | Selected · WithUndo · Busy |
| `SelectionBar` | OneRow · ManyRows · Busy |
| `StatusSelect` | PipelineRows · EveryStage · CustomStatus · Disabled · Open |
| `StepHeader` | MapColumns · WhatThisWouldDo · Importing · Report |
| `Toaster` | UndoAfterADecision · Success · FailureWithRetry |
| `TriageCard` | Default · CompensationNotListed · AboveYourYearsLimit · LongTitleAndCompany · RemoteAndUntagged |

Grades and authored `.tsx` files carry forward, so a re-sync re-grades only what
its own sources changed.

## Raw material for `conventions.md` (do NOT treat this as the header itself)

What authoring all 14 taught, for whoever writes the conventions header:

**Tailwind class families the components actually use.** Colour is always a token
utility, never a raw palette value: `bg-surface` / `bg-raised` / `bg-bg`,
`text-text` / `text-text-2` / `text-muted`, `border-border` /
`border-border-strong`, and the state pairs `text-ok`+`bg-ok-subtle`,
`text-warn`+`bg-warn-subtle`, `text-danger`+`bg-danger-subtle`,
`text-info`+`bg-info-subtle`, `text-accent`+`bg-accent-subtle`, plus `bg-accent` /
`text-accent-fg` for the one filled surface and `bg-selected` for grid rows.
Radius is `rounded-sm|md|lg|xl` (4/6/8/12px) — never `rounded` bare. Type is
`text-2xs` through `text-2xl` off a 13px base, and those tokens are NOT `@theme
inline`, so a per-user scale can override them at runtime — never hard-code a
font size. `.tabular` on anything numeric that gets compared. Focus is always
`focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`
(or `-outline-offset-1` inside a tight cell). Dark mode needs no `dark:`
utilities anywhere: the tokens flip under `.dark`, which is why the whole
codebase has zero `dark:` classes.

**Layout idioms that exist for a reason.** `min-w-0` on every flex child that
holds arbitrary text, and `break-words` on anything from an ATS board — an
unbroken token otherwise paints past the container into `html { overflow-x:
hidden }` and is unreachable. `flex-wrap` over `truncate` in headers (a truncated
title beside a non-shrinking button is a bare ellipsis at 200% zoom on 320px).
Wide things scroll in their own `overflow-x: auto` box; the page never scrolls
sideways.

**The anchor idiom.** A navigation is an `<a>` wearing
`buttonClass({variant, size})`, never a `<button>` with an onClick router push —
that is why `buttonClass` is exported at all, and four of the authored cards use
it.

**Overlays.** Radix, always — Dialog/Select/Popover/DropdownMenu — because a focus
trap, typeahead, collision-aware positioning and focus restoration are invisible
when they work and a dead end when hand-rolled. Every one portals to `<body>`, so
in a preview: `defaultOpen` where the root accepts it (Dialog, Popover), and a
dispatched `keydown {key:"Enter"}` at the trigger where it does not (Select).
`cardMode: "single"` for all of them.

**Colour never travels alone.** Every Badge tone carries the word too; the
selected-format card in the export dialog draws a real `<Check>` element rather
than relying on a tint, because forced-colors mode strips the tint. And no
opacity multipliers on text — `opacity-70` on an 8.6:1 token measures 3.95:1 and
fails AA, so de-emphasis comes from size, border and a lighter token instead.
`invisible` (layout-preserving) is the idiom for "not yet wired", not `opacity-40`.

**Empty states are three different things** — finished / nothing-matches /
nothing-yet — and the app treats collapsing them as a bug. Finished needs no
action; the other two do.

## Re-sync risks — what can silently go stale

1. **The symlink and the compiled CSS are both regenerated artifacts that a fresh
   clone or an `npm ci` destroys.** Symptom of the first: `[ZERO_MATCH]` /
   `srcDir not found`. Symptom of the second: `! cssEntry: .ds-styles.css not
   found — skipped`, then cards that render but are unstyled — which validate
   reports only as a size warning. Re-run both before the build.
2. **`cfg.dtsPropsFor` is a hand-transcribed copy of live source** (above). The
   highest-value thing a future run can do is diff those 14 bodies against the
   components.
3. **`.design-sync/ds-entry.tsx` and `componentSrcMap` must agree.** A name in one
   and not the other is either a card with no binding (renders "Element type is
   invalid") or a bundled export nobody can see.
4. **The `tsconfig` shim rots if `webapp/tsconfig.json`'s `paths` change.** It
   duplicates one line of that file. If `@/…` starts resolving to the wrong place,
   compare the two.
5. **Only partially verified:** styling was confirmed on 6 of 14 components
   (the ones that render without required props, plus a hand-built probe). The
   other 8 sat on the floor card, so their styling is inferred from the shared
   stylesheet, not seen.
6. **Toolchain assumed:** node 24, `@tailwindcss/postcss` 4.3.3 from
   `webapp/node_modules`, chromium 1228 from `~/Library/Caches/ms-playwright`
   (matches the repo's pinned `@playwright/test` 1.61.1 — no browser was
   downloaded). `playwright` and `playwright-core` are symlinked into
   `.ds-sync/node_modules` from `webapp/node_modules`; **`npm i` inside
   `.ds-sync/` prunes those symlinks as extraneous**, and the next validate then
   fails `[RENDER_SKIPPED]`. Relink after any install there:
   `cd .ds-sync/node_modules && ln -sfn ../../webapp/node_modules/playwright playwright && ln -sfn ../../webapp/node_modules/playwright-core playwright-core`
   `typescript` must be pinned to **5.x** in `.ds-sync/` — a bare `npm i
   typescript` now installs 7.x, whose entry point `package-validate.mjs` cannot
   import, and the `.d.ts` parse check silently downgrades to "skipped".
