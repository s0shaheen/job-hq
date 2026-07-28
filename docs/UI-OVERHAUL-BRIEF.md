# UI overhaul — what exists today, and what a ground-up redesign has to answer

**Purpose.** This is the input packet for a design pass (Claude Design + a
research/guidelines pass). It is an inventory and a diagnosis, not a proposal.
It answers three questions: *what did we actually build*, *why is it hard to
read*, and *what breaks in the backend if we simplify it*.

**Audience.** Whoever writes the design guidelines, and whoever implements them.
Read `docs/PRODUCT-SPEC.md` for intent and `docs/WEBAPP-BUILD.md` for the
149-row failure matrix that the redesign must not regress.

**Standing constraint.** The engine is correct and heavily tested. This is a
**presentation-layer overhaul with a small, named set of backend consequences**
(§7). Nothing here justifies touching `core/sheets.py`, the write path, or the
status vocabulary without going through §7 first.

---

## 1. What the product actually is

Strip the personal history out and the product is one sentence:

> **A job search runs itself in the background; you spend five minutes a day
> deciding, and the system keeps the record straight.**

Three jobs, in the order a user values them:

| # | Job | Today's surface | Can a spreadsheet do it? |
|---|---|---|---|
| 1 | **Decide** — one role at a time, with pay, seniority, location and work model in front of you | `/queue` | No |
| 2 | **Track** — applications whose status a robot also writes, from your email, without ever overwriting you | `/pipeline` | Badly |
| 3 | **Leave** — take everything out as CSV/XLSX and keep working the way you already work | Export dialog, `/import` | It *is* the spreadsheet |

Everything else in the app — company universe, LinkedIn connections, health,
answer library — is **machinery that makes 1–3 work**. Today it is presented as
peer destinations, which is the single biggest structural reason the app reads
as complicated.

### The framing problem to fix first

The product was built for three known humans. That is still visible in the code
as shipped:

- `webapp/lib/grid/presets.ts` ships persona presets with the ids
  **`owner` / `dad` / `roommate`**.
- `docs/PRODUCT-SPEC.md` §D specifies defaults per named person.
- Copy and empty states assume a user who knows how the engine works.

A generic product has **roles and preferences**, not named people. That
substitution is the spine of the redesign, and it has real backend consequences
(§7.4).

---

## 2. Scale of what exists

| Thing | Count | Where |
|---|---|---|
| Top-level nav destinations | **9** (7 primary + 2 account) | `app/(app)/nav-links.tsx` |
| Routes with a real UI | 14 | `app/(app)/*`, `app/onboarding`, `app/login`, `app/setup` |
| TypeScript in `webapp/` | ~39,400 lines | `app/`, `components/`, `lib/` |
| Design tokens | 24 colour + type scale (`text-2xs`…`text-2xl`, 13px base), light + dark | `app/globals.css` |
| Shared UI primitives | 6 (`Badge`, `Button`, `DialogContent`, `EmptyState`, `Kbd`, `Toaster`) | `components/ui/` |
| Components synced to Claude Design | **14**, 55 authored preview cells, all graded | `.design-sync/` → project `5dab7624` |
| Jobs grid columns | 10 | `lib/grid/columns.tsx` |
| Jobs **export** columns | 16 | `lib/export/columns.ts` |
| Applications export columns | 8 | same |
| Grid view presets | 5 sets × 3 persona display presets | `lib/grid/presets.ts` |
| Filter operators | 11 across 4 field kinds | `lib/grid/filter.ts` |
| Search-profile criteria fields | **13** | `lib/profile/criteria.ts` |
| Application-form topics (auto-apply) | **16** | `lib/apply/topics.ts` |
| Distinct "why we couldn't answer" reasons | **12** | same |
| Application statuses | 11 canonical + human-invented allowed | `core/schema.py` → `lib/status.ts` |
| Named frontend failure modes under test | **149** | `docs/WEBAPP-BUILD.md` |

The last row matters: **this is not an unpolished app, it is an over-specified
one.** Nearly every oddity in the UI is a defended answer to a real bug. The
redesign's job is not to fix defects, it is to *reduce what the user is asked to
hold in their head* without discarding the guarantees.

---

## 3. Surface-by-surface inventory

Ordered by the nav as it ships today.

### 3.1 `/queue` — Triage · **the product**
- **Header:** "Today's queue" / "Roles that match your search and haven't been
  decided yet." + Export.
- **Card** (`queue/triage-card.tsx`): company + industry badge + posted/open
  link; title; a **fixed 4-tile fact bar** (Comp · Min YoE · Work model ·
  Location) that always renders, showing "Not listed" rather than collapsing;
  optional mismatch warning; Focus paragraph; skill chips.
- **Actions:** `i` interested · `x` pass · `s` later · `o` open · `j`/`k` move.
  Undo toast for 10s. Bulk triage via selection.
- **Assessment:** this is the best screen in the app and closest to shippable.
  The 4-tile bar is a genuinely good decision-support pattern. Problems are
  local: the skills chip row and Focus paragraph add length without adding
  decision value, and the hint footer restates the buttons.

### 3.2 `/jobs` — the grid · **the density problem**
- 1,422 lines. Virtualized (5k rows tested), sticky header + first column.
- **10 columns:** Company · Title · Warm · Comp · Min YoE · Work model ·
  Location · Posted · Decision · Why.
- **Controls stacked above the table:** view switcher (5 sets + saved views +
  Save as…) · filter bar (11 operators × 4 field kinds, AND-of-OR, depth 2) ·
  sort · group · quick search · density · type scale · keyboard hints toggle ·
  selection bar · export menu · why-popover. **~12 concurrent controls.**
- **Assessment:** this is "looks like Airtable" taken literally. Airtable earns
  that chrome because its users build databases; here the grid's real job is
  *find a row I half-remember* and *pull a subset out*. See §5.3.

### 3.3 `/pipeline` — applications
- 977 lines. Grouped by status, collapsible, group state in the URL.
- Per row: company/title, status `Select` (11 canonical + invented), suggested
  status confirm/reject, evidence link, delisted badge, next-action text +
  date (blur-committed), notes dialog (append-only history), withdraw, reopen
  (requires a written reason).
- Plus a **"Needs review"** section for emails that matched two applications.
- **Assessment:** the row carries 7 interactive affordances. Status, suggestion
  and next-action are three different mental models occupying one line.

### 3.4 `/companies` — the watch universe
- Grid: Company · Resolution · Board · Found via · Review · Sweep flag.
- A **coverage meter** with verified / inferred / asserted / unresolved
  confidence, reliability **Tier 1/2/3**, a provenance popover, bulk approve /
  dismiss, a paste-a-list add flow with parse preview.
- **Assessment:** intellectually the most careful screen in the app (it exists
  to stop a tier being read as a measurement) and the most impenetrable to
  anyone who does not know what an ATS adapter is. This is *configuration*
  wearing the clothes of a *workspace*.

### 3.5 `/import` — 4-step wizard
Upload → map columns → preview (dedup: new / matches / unkeyable) → commit,
with 24h batch undo and a per-column report. 10 mappable fields including the
hidden `hq_id` / `hq_version` round-trip columns. Seven batch states with their
own copy (`Not imported yet` / `Part-imported` / `Undone` / `Stopped`…).
- **Assessment:** correct, and correctly the most complex thing here. Its
  problem is placement (top-level nav) not construction.

### 3.6 `/connections` — LinkedIn CSV → warm intros
Upload `Connections.csv`, map columns, coverage band, per-connection list,
feeds the **Warm** column on `/jobs`.
- **Assessment:** a one-time setup task with permanent nav real estate.

### 3.7 `/settings` + `/settings/answers`
- **Search profile:** 8 sections over 13 criteria fields, including three
  *unknown-handling policies* (`geo_unknown`, `yoe_unknown`, `comp_unknown`),
  `seniority_exclude`, `work_model_exclude`, `titles_exclude`, plus a dry-run
  preview panel before save.
- **Answers (auto-apply library):** 1,122 lines. Three layers — facts about
  you, previously-typed answers, per-company exceptions — over **16 topics**
  (work authorization, visa sponsorship, criminal history, relocation…) with
  knockout flags and provenance.
- **Assessment:** the answer library is a **second product** (application
  autofill) sharing the first's chrome. §5.8.

### 3.8 `/apply/[id]` — prepare & review a staged application
Gaps rendered first as work, **12 distinct gap reasons**, per-field source
attribution (`policy:<topic>@<company>/<direction>`), a readiness banner, a
save-back-to-library scope checkbox per card. Nothing submits.

### 3.9 `/health`, `/add`, `/onboarding`
- **Health:** a table of automation freshness. Ops instrumentation in the
  product nav.
- **Add:** flagged `Soon`, ships a 404-shaped placeholder deliberately.
- **Onboarding:** 2 steps (was more), with an inline preview — *"this profile
  would have qualified N of the last 30 days"*. **This is the single best
  onboarding idea in the app** and should survive the redesign untouched in
  substance.

---

## 4. The design system as it stands

Already real, already synced — **do not restart from zero.**

- **Tokens** (`app/globals.css`): surfaces `bg` / `surface` / `raised` /
  `selected`; text `text` / `text-2` / `muted`; `border` / `border-strong`;
  semantic `ok` / `warn` / `danger` / `info` / `accent`, each as `text-X` on
  `bg-X-subtle`. Accent is a muted green (`#3f5f4b` light, `#8fb79c` dark).
  Dark mode is a `.dark` class; **tokens flip themselves, never `dark:`
  utilities.**
- **Type:** 13px base, `text-2xs`…`text-2xl`, **user-adjustable at runtime**
  (large-type cookie). Never hard-code px.
- **Fonts:** system stack only, on purpose — no webfont means no per-machine
  fallback drift.
- **Rules already written down** (`.design-sync/conventions.md`): colour never
  travels alone (always paired with a word or icon); never de-emphasise with
  `opacity-*` (contrast failure — it is in the matrix twice); every
  user-or-ATS-sourced string needs `min-w-0` + `break-words`; empty states are
  **three different things** (finished / nothing matches / nothing yet) and you
  pick the true one.
- **Synced to Claude Design** (`5dab7624`): 6 primitives + `TriageCard`,
  `CoverageMeter`, `ProvenanceChip`, `ReviewBar`, `SelectionBar`,
  `StatusSelect`, `StepHeader`, `PreviewPanel`.
- **Standing offer for the next sync** (browser-safe, deliberately deferred):
  `FilterBar`, `ExportMenu`, `SweepToggle`, and the settings field primitives
  (`Section` / `ChipList` / `MoneyField` / `NumberField`).

**Verdict:** the *system* is sound and enterprise-credible. The failure is at
the **composition and information-architecture layer** — too many rooms, too
many fields per room, engine vocabulary in the labels.

---

## 5. Diagnosis — the eight things making it hard to read

### 5.1 Nine destinations, and none of them is the product
Triage · Jobs · Pipeline · Companies · Import · Connections · Add · Health ·
Search profile. Four of those are **plumbing** (Companies, Connections, Import,
Health) and one is a placeholder. Notion, Linear, Asana and Google Workspace
apps all hold the top level to **3–5** and push everything else into settings,
a command palette, or a contextual entry point.

> **Target: 3 primary destinations + settings + a command palette.**

### 5.2 The labels are the database's vocabulary
Words currently on screen: *disposition · triage · gate · sweep flag ·
reliability tier · resolution method · verified/inferred/asserted/unresolved ·
provenance · binding constraint · needs-info · awaiting-tags · `geo:India` ·
`yoe:6>4` · `comp:<120k` · job_key · hq_id · hq_version · knockout · polarity ·
layer 1 / layer 2 · batchApprovable · situation fact.*

Every one is a correct internal concept and a wrong user-facing word. Crucially
**these are display strings, not schema** — the fix is a presentation-layer
dictionary, not a migration (§7.1).

### 5.3 Grid chrome outweighs grid content
~12 concurrent controls over 10 columns for a dataset that is tens-to-hundreds
of rows for a real user. The grid is doing three unrelated jobs at once:
browse, filter-and-export, and bulk-decide.

### 5.4 Fields exist because the schema has them
Location is represented **six ways** on `JobView` (`location`, `metro`,
`market`, `country`, `remote`, `workModel`). Compensation **three** (`compRange`
string, `compMinK`, `compMaxK`). The grid shows 10 columns, the export ships 16,
the triage card shows 4 + 3. No single question in the product needs all of it.

### 5.5 The user is asked to make the system's decisions
Onboarding and settings ask for **three separate unknown-handling policies**
(what to do when pay / location / experience is unstated), plus exclusion lists
for titles, seniority levels and work models, plus a `tag_domain` and a
`board_search_term`. A first-time user cannot possibly have opinions about
these, and a wrong answer silently starves their queue — which the app already
knows, because it built an entire preview panel to compensate.

> The right move is fewer questions with better defaults, and keep the preview.

### 5.6 Personas are compiled in
`owner` / `dad` / `roommate` as preset ids. Replace with role + preference
(density, type size, keyboard hints, landing view) — which the app already
stores per user; only the *naming and the presets* are personal.

### 5.7 Copy registers are mixed
Excellent plain-language moments ("Roles that match your search and haven't
been decided yet", "It stopped part-way. Open it to carry on") sit beside
`Sweep flag`, `Found via`, `Nobody has confirmed this`, `Not imported yet —
Waiting for you to say which column is which`. There is no copy spec: no
sentence-case rule, no button-verb list, no empty-state template, no error
template, no terminology dictionary.

### 5.8 Two products in one shell
The job tracker and the **application-autofill answer library** (16 topics, 12
gap reasons, three policy layers, ~1,700 lines across two surfaces) are
different products with different users and different risk profiles. Presented
today as a settings sub-page and a route, with no framing that says which one
you are in.

---

## 6. Reference mapping — what to take from whom

Use these as *specific borrowings*, not vibes. This is the list the guidelines
doc should expand.

| Reference | What it solves here | The specific thing to steal |
|---|---|---|
| **Linear** | 5.1, 5.3 | Three destinations, everything else behind `⌘K`. Views are *saved queries you name*, not chrome that is always on. Keyboard-first without keyboard-required. |
| **Notion** | 5.3, 5.4 | Progressive disclosure of properties: a few shown, the rest one click away, per-view. And **one object, many views** rather than many pages. |
| **Asana** | 5.1, 3.3 | Work-item detail as a right-hand pane rather than a route change — keeps the list as context. Clear separation of *my work today* from *everything*. |
| **Atlassian (Jira/Confluence)** | 5.2, 5.7 | An explicit terminology dictionary and a status-vocabulary that is small, coloured, and consistent everywhere it appears. Their design-system writing guidelines are the best public model for §8's copy spec. |
| **Google Workspace** | 5.5, 3.9 | Setup that assumes nothing and defers advanced settings until you have used the product. Empty states that teach. |
| **Stripe / Vercel consoles** | 3.4, 3.9, 5.8 | How to present *system machinery* (health, coverage, provenance) credibly without putting it in the product nav — a Settings/Status area with real depth, and confidence framed as data with a timestamp rather than as a badge. |
| **Superhuman** | 3.1 | The single-decision surface: one item, full attention, instant undo. Already the shape of `/queue` — keep and tighten. |

---

## 7. Backend consequences of simplifying

This is the section that decides whether a design idea is a week or a quarter.

### 7.1 Renaming vocabulary — **presentation only, no migration** ✅
`disposition_reason` is a closed set produced by Python and consumed by
TypeScript; `status` is parsed out of `core/schema.py` by `lib/status.ts` and
pinned by `status.test.ts`. Do **not** rename these in the database. Add a
display dictionary at the view-model edge (`lib/data/view-models.ts` already is
that edge) and make every surface read from it. One file, testable, reversible.

### 7.2 Reducing the search profile from 13 fields — **server-side defaults + a re-gate rule** ⚠️
Dropping the three `*_unknown` policies and the exclusion lists from the UI
means the server owns those defaults. Two hard rules already exist and must
hold: **a profile change never retroactively re-triages** (spec G8 — re-gate
untriaged rows only, then offer an opt-in), and changing a default changes
gating for existing users. Needs: a criteria version/default-set, a migration
that pins existing users to their current effective values, and the "N
previously-filtered postings now qualify" opt-in already specced.

### 7.3 Collapsing nav (Companies / Connections / Import / Health into setup) — **routes move, RPCs don't** ✅
`app_propose_companies`, `app_set_company_flags`, `app_set_company_review_bulk`,
the import RPC chain and the connections upload route are all unaffected by
where their UI lives. The only real work is the **entry points**: Companies and
Connections must be reachable from the moments that need them (an empty queue,
a job with no warm intro) rather than only from a nav item.

### 7.4 Replacing hardcoded personas — **small schema change** ⚠️
Persona display presets are compiled ids today. Generic form: a per-user
preferences record (density, type scale, hints, landing view, notification
channel) — most of which already exists as a cookie or as saved-view state.
Consolidating it into one stored preferences object is a small migration and
removes three named humans from the codebase.

### 7.5 Fewer visible fields — **does not reduce export** ✅⚠️
Trimming grid columns is free. **Do not trim the export column sets** — export
is a first-class product surface (spec §E) and the round-trip depends on a
narrow, stable human-owned column set plus hidden `hq_id`/`hq_version`. The
export dialog must keep stating its scope and count from a fresh server read
(matrix rows 25, 75).

### 7.6 Simplifying the status vocabulary — **Python first, then TypeScript** ⚠️⚠️
`STATUS_ORDER` and the rank rules live in `core/schema.py`; the webapp copy is
generated-and-pinned, the sheet layer and `tracker/join.py` read the same
lists, and a human-invented status is legal and outranks bots. Any change to
the vocabulary is an engine change with tests in two languages. **Recommend:
leave the vocabulary alone; change only its grouping and colour in the UI.**

### 7.7 Splitting out the answer library — **feature flag, no schema change** ✅
`lib/apply/*` and its tables are already self-contained. It can become a
separately-entered product area (or a gated feature) without touching the
tracker.

### 7.8 Anything touching writes — **the contract is fixed** 🚫
Every gesture stays: server action → one Postgres function → row + audit event
in one transaction, carrying an idempotency key and the `updated_at` that was
read. Optimistic render settles on the **server's** row, never the captured one.
No browser insert/update policy. A redesign may change what a control looks
like; it may not change how it writes.

---

## 8. What the guidelines doc must produce

The redesign is blocked on artifacts that do not exist yet. In priority order:

1. **Terminology dictionary** — every engine word in §5.2 mapped to a user word,
   with the forbidden list. This unblocks all copy work.
2. **Information architecture** — the 3 primary destinations, what moves to
   settings, what becomes contextual, what the command palette owns.
3. **Field budget per surface** — a stated maximum (e.g. *triage card: 4 facts;
   grid default: 6 columns; pipeline row: 3 affordances*) with the rest behind
   progressive disclosure.
4. **Copy spec** — sentence case; button verbs; the three empty-state templates;
   the error/conflict/offline templates (the app already has good instances of
   each — codify them); number and date formatting; how counts state their scope.
5. **Component gap list** — what the 14 synced components don't cover for the
   new IA (detail pane, command palette, settings shell, page header,
   filter/chip row, table toolbar).
6. **Onboarding spec** — how few questions, and how the preview panel survives.

## 9. Non-negotiables to hand the designer

These are the guarantees the current UI buys. A redesign that breaks one is a
regression, not a simplification.

- **System fonts only.** No webfont — the app's cross-machine stability depends
  on it.
- **Tokens flip themselves.** Light and dark are both first-class; never write
  `dark:` utilities; every screen is axe-checked `wcag2a/wcag2aa` per theme.
- **Type scale is user-adjustable at runtime**, and density with it. Every
  layout must survive the large-type setting *and* 200% browser zoom — these
  are different tests and the app has failed each separately.
- **No `opacity-*` for de-emphasis.** Use `text-muted`, or `invisible`.
- **Never truncate a user-or-ATS-supplied string into meaninglessness.**
  `min-w-0` + `break-words`; headers wrap rather than truncate.
- **Colour never travels alone** — always paired with a word or an icon.
- **Absence is information.** A value that was never stated renders as "Not
  listed" — never zero, never blank, never an invented midpoint.
- **Counts state their scope**, and the number shown must equal the number
  acted on (selection, export, bulk).
- **Every destructive or terminal gesture has an undo or a stated reason.**
- **No horizontal page scroll at any of the six tested widths**; a grid
  overflows its own container, never the page.
- **Nothing may require debugging by the user.** No stack traces, no spinner
  that never resolves, no dead link in the nav.

---

## 10. Open questions for the owner

1. **Who is the generic user?** Someone running their own search, or someone
   running a search *on behalf of* someone else (the scout pattern)? The IA
   differs materially.
2. **Is auto-apply in or out of the v1 product story?** It is the single
   largest source of surface complexity and a different risk profile.
3. **Is the company universe a user-facing concept at all**, or should
   "which companies get watched" become an invisible default with an advanced
   escape hatch?
4. **Does the grid survive?** If export is first-class and triage is the daily
   loop, the grid may be a *search + select-and-export* surface rather than an
   Airtable clone — which changes its chrome by an order of magnitude.
5. **How much visual identity do you want?** Today it is a restrained,
   near-neutral green system that reads Stripe/Linear. An "Asana/Notion" read
   implies warmer surfaces, more illustration, and more generous spacing —
   which costs density on the grid.
