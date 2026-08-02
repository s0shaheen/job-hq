# Strict design-parity standard

Scope authority: `full-product-pilot-v2`. Any conditional/unavailable Autopilot or
offline-queue language retained from the earlier narrow pilot is superseded by the
full-product rules below.

## 1. Objective

The pilot UI MUST reproduce the supplied Job HQ design system exactly for every
in-scope surface and state. Implementation preferences, framework defaults, and
“improvements” do not override the design.

Parity is a contract over:

- information architecture;
- component composition;
- geometry and responsive behavior;
- design tokens and computed styles;
- typography and numeric treatment;
- exact user-facing copy;
- interaction, focus, keyboard, URL, and history behavior;
- data mapping and missing/uncertain states;
- loading, empty, error, conflict, offline, and permission behavior;
- accessibility.

A screenshot that looks close on one machine is not sufficient.

## 2. Authoritative inputs and precedence

### 2.1 Source set

The implementation MUST read and cite the relevant portions of:

1. `/Users/s0shaheen/Downloads/job-hq-design-system/README.md`
2. `/Users/s0shaheen/Downloads/job-hq-design-system/project/README.md`
3. `/Users/s0shaheen/Downloads/job-hq-design-system/project/styles.css`
4. `/Users/s0shaheen/Downloads/job-hq-design-system/project/_ds_bundle.css`
5. `/Users/s0shaheen/Downloads/job-hq-design-system/project/_ds_manifest.json`
6. Relevant
   `project/components/general/<Component>/<Component>.prompt.md`, `.d.ts`, and `.html`
7. Relevant `project/templates/<surface>/*.dc.html` plus `support.js` and `ds-base.js`
8. `/Users/s0shaheen/job-hq-design-context/design-mirror/README.md`
9. `/Users/s0shaheen/job-hq-design-context/01-design-foundations.md`
10. `/Users/s0shaheen/job-hq-design-context/02-terminology-and-copy.md`
11. `/Users/s0shaheen/job-hq-design-context/03-ia-and-surfaces.md`
12. Relevant prompt pack and handoff for the surface.

The HTML prototypes express intended output, not required production architecture.
Production components MUST preserve repository security, data-source, and write
contracts.

Before release, the source set MUST be copied or published as a versioned,
access-controlled design-bundle artifact with a SHA-256 digest. Machine-local absolute
paths are discovery locations, not a reproducible release reference.

Downloaded reference digests observed 2026-07-28:

- `_ds_manifest.json`:
  `1934e04038c9654f6d3aab5863f266dd44577aa7e9927284609a411a6022c350`
- `_ds_bundle.js`:
  `baefa8270fc1f9dedb16da0194c4dd5241002e19b8fa36381df33e39e2bccc91`
- `_ds_bundle.css`:
  `47c8e3132b842182d8b51cd4896cd47759a319f6e59781e91cb034c37df9adb4`
- `styles.css`:
  `e28cb90814637581f6afbcf901abf4ac06c1d976084c662c46cd603d0ccfdb83`

### 2.2 Conflict order

When design inputs conflict:

1. owner decision recorded in an approved decision record;
2. accessibility, security, data-integrity, and RPC-write invariants;
3. `01-design-foundations.md` and `02-terminology-and-copy.md`;
4. the latest `.dc.html` surface composition and downloaded component contract;
5. design mirror recovery notes;
6. older handoff prose.

An accessibility or safety conflict does not authorize a silent redesign. Record the
conflict, implement the smallest safe deviation, and obtain owner approval.

### 2.3 Design-input checksum

Each surface specification MUST record:

- authoritative files;
- file digest or design-bundle version;
- date reviewed;
- implementation commit;
- approved exceptions.

If an authoritative file changes after acceptance, the surface returns to `needs
parity review`.

## 3. Global design contract

### 3.1 App frame

- Fixed 224px navigation rail.
- Destinations: Today, Jobs, Applications, Autopilot, Coverage; Settings separated.
- Today is the only destination with a badge.
- Content gutter 24px; 16px below 768px.
- Light theme is the release reference.
- System font stack only.
- Runtime large type and density must survive independently.
- Page-level horizontal scrolling is forbidden.

### 3.2 Typography

- Page title: 20/28, weight 600.
- Pane/dialog title: 16/24, weight 600.
- Primary row: 13/20, weight 500.
- Body: 13/20, weight 400.
- Prose: 14/20, weight 400.
- Meta: 12/16, weight 400.
- Section label: 12/16, weight 500, muted, sentence case.
- Allowed weights: 400, 500, 600.
- No italics, uppercase transform, positive letter spacing, title-case chrome, or
  webfont.
- Every element containing a digit uses tabular figures.

### 3.3 Spacing, shape, and depth

- Spacing uses the 4px grid: 4, 8, 12, 16, 24, 32, 48, 64.
- Controls: 6px radius.
- Cards/panes/dialogs: 8px radius.
- Badges and avatars MAY be full round as specified.
- Nothing exceeds 12px radius.
- One-pixel semantic borders.
- No resting shadows; overlay shadow only.
- No gradients, glows, glass, texture, colored edge accents, or decorative semantic
  color.

### 3.4 Color

Use the supplied semantic tokens exactly. No raw color may be added without an approved
design-system change. Accent is limited to the primary action, selection, focus, and
links. Semantic color always travels with a word or accessible icon.

### 3.5 Copy

- Exact dictionary terms and template strings.
- Sentence case.
- Straight quotes.
- No exclamation points, em dashes, interpuncts, bullets, pipes, or similar text glue.
- No decorative subtitle.
- Missing fact: `Not listed`.
- Counts state scope and equal the action scope.
- Buttons carry count when specified, such as `Export 47 roles`.
- No engine vocabulary, invented header, or improvised empty-state promise.

### 3.6 Motion

- 120–180ms ease-out only for state feedback.
- Reduced motion is respected.
- No staggered reveal, scroll animation, hover lift, bounce, ambient spinner, or
  decorative movement.

## 4. Surface contracts

The exact templates remain authoritative. This section is a release checklist, not a
replacement for them.

### 4.1 Today

Required:

- maximum inner width 760px;
- PageHeader with no decorative subtitle;
- sections only when non-empty;
- New roles, Ready to review, Suggested updates;
- section labels/counts and top-divider row structure;
- selection bar centered against the content area with the 224px rail offset;
- all-clear and first-run states exactly mapped;
- badge equals actionable items across all rendered sections;
- no overnight-submission message unless a real, auditable submission occurred; and
- Suggested updates may contain only product-derived manual follow-ups at launch, not
  Gmail-derived status suggestions.

### 4.2 Jobs

Required:

- Header, toolbar, six visible data columns under the accepted redesign budget, footer,
  and optional 420px detail pane.
- Four toolbar controls plus Display at the right end.
- Search, saved views, plain-language chips, `Export N roles`, Display.
- Warm is an indicator in Company under the accepted redesign, not a dedicated column.
- No Why column and no persona controls.
- Detail decision block is unlabeled, followed by exactly Details, About the role,
  Activity.
- Escape closes the pane, restores focus, and removes only the selected-detail URL
  state.
- A shared link restores the pane and selection.
- Footer count uses the actual view/selection/filter scope.
- Logo fallback and `Not listed` behavior are exact.

If the original template still contains the retired eight-track layout, the approved
Jobs handoff and owner decision govern the six-column redesign. Record this as a
source-resolution note, not a visual exception.

### 4.3 Applications

Required:

- Content plus optional 400px ApplicationPane.
- Bands in order: Needs review, Active, Offers, Closed.
- Empty bands are hidden.
- Row tracks: identity, age, status, next action.
- Conflict strip appears under the affected row.
- Pane: header; status/age; optional suggestion; Activity with add-note; Withdraw and
  reasoned Reopen.
- User-typed statuses receive the neutral fallback tone.
- Nothing-yet and loading states match the template.

### 4.4 Coverage

Required:

- Use the latest Coverage template and handoff as the exact surface contract.
- Every monitoring/source/freshness statement maps to real data.
- Activity distinguishes successful, partial, failed, and stale.
- Missing domain/source is ordinary.
- No control promises that a database decision changed the Python scan unless the
  authoritative-store bridge is active.

### 4.5 Settings, onboarding, and auth

Required:

- Form content is left-aligned with maximum 640px width.
- Labels are above fields; help and validation text are below.
- Placeholder is never a label.
- One primary action per view.
- Pending, uninvited, suspended, session-expired, connected, revoked, stale, and
  connection-error states use the exact approved copy.
- No auth state reveals whether an arbitrary email has an account beyond the invite
  flow’s approved message.
- Account export/delete is findable and fully operable.

### 4.6 Autopilot

Autopilot is required. Use the downloaded Autopilot template after the durable
Prepare/Review state machine and submission contracts pass. Every visible staged item,
answer, rule, receipt, count, and throughput statement MUST map to owner-scoped durable
state. The surface MUST include:

- Review, Answers, and Rules;
- exact reviewed payload and attachment version;
- explicit approval before the first production submission mode;
- provider capability and paused/manual states;
- confirmed, outcome-unknown, retryable, terminal, and cancelled outcomes;
- immutable receipt/activity access; and
- user, provider, and global pause/kill controls.

No fixture/demo submission may appear in production. An unsupported provider receives
the approved complete manual handoff, not an unavailable product room or a false submit
control.

## 5. Required state inventory

For each route, create a state manifest. Every applicable row requires an owned fixture
and evidence.

| State | Required proof |
|---|---|
| Loading | content-shaped skeleton; no layout jump or indefinite spinner |
| Populated | exact canonical reference data |
| Natural empty | correct first-use or finished copy |
| Filter empty | preserved filters and recovery action |
| Missing optional fact | `Not listed`, no broken layout |
| Partial/degraded | available facts remain; missing dependency named safely |
| Validation error | field association, summary on submit, focus movement |
| Write pending | stable optimistic state |
| Offline write disabled | approved reconnecting copy, disabled controls, preserved safe draft where applicable; no local mutation queue |
| Conflict | no overwrite; current state and next action |
| Permission/holding | no data leak and exact support path |
| Session expired | draft preservation and re-authentication |
| Fatal route error | actionable containment, correlation reference |
| Selected/detail | exact geometry, focus, URL restoration |
| Long strings | safe wrapping without semantic truncation |
| High volume | stable table/list geometry and performance |
| Large type | runtime large type with no clipping |
| 200% zoom | no page horizontal scroll |
| Narrow viewport | supported composition and reachable actions |
| Reduced motion | no required animation |
| Provider image failure | deterministic monogram |

## 6. Parity manifest

Every surface MUST maintain a machine-readable manifest equivalent to:

```yaml
surface: jobs
design_version: job-hq-design-seed@0.1.0
authoritative_files:
  - path: /absolute/path/to/source
    sha256: "<digest>"
implementation:
  route: /jobs
  commit: "<release sha>"
viewports:
  - {width: 1440, height: 900, type: default, density: comfortable}
  - {width: 768, height: 1024, type: large, density: comfortable}
states:
  - id: populated
    fixture: jobs-populated-v1
  - id: selected-detail
    fixture: jobs-detail-v1
interactions:
  - open detail
  - close with Escape
  - restore deep link
  - search and clear
  - remove filter
  - export visible scope
exceptions: []
```

The syntax MAY vary. The information and deterministic fixture identifiers MUST not.

## 7. Verification layers

### 7.1 Structural contract

Verify:

- route and nav composition;
- accessible landmarks/headings;
- component hierarchy where hierarchy affects behavior;
- exact column/section/control budgets;
- DOM ordering and focus targets;
- exact strings and counts;
- state manifest completeness.

### 7.2 Computed-style contract

Walk visible elements and fail on:

- any gradient;
- disallowed raw colors;
- italic font style;
- uppercase transform or visibly uppercase chrome not in data;
- nonzero letter spacing;
- font weight outside 400/500/600;
- radius above 12px or wrong component radius;
- opacity-based de-emphasis;
- non-tabular figures on numeric content;
- resting shadows;
- colored single-edge borders;
- webfont use;
- forbidden glue glyphs in UI text;
- page-level horizontal overflow.

Each rule MUST have a violating fixture and proof that the check fails.

### 7.3 Geometry contract

At controlled viewport, theme, type, density, font stack, locale, and data:

- specified fixed tracks differ by no more than 1 CSS pixel;
- alignment anchors differ by no more than 1 CSS pixel;
- row/control/pane/nav dimensions are exact;
- no element overlaps or becomes unreachable;
- table overflow is contained within the table, not the page;
- selected/detail state does not change unrelated geometry.

Geometry assertions MUST run in the pinned reference environment. Font-dependent
assertions MUST not run in an environment with unpinned metrics.

### 7.4 Visual comparison

Use deterministic screenshots as a final-output regression layer:

- same renderer, OS image, fonts, device scale, viewport, theme, data, time, and motion
  setting;
- animations disabled at stable end state;
- reference generated from the authoritative design or owner-approved implementation;
- exact changed regions reviewed;
- only documented anti-aliasing masks permitted;
- no broad threshold that allows missing or off-screen elements.

Visual comparison is secondary to structure, style, geometry, copy, and interaction.
The evidence MUST record the browser engine/version, OS image, device scale factor,
font set, locale, timezone, motion setting, and reference artifact digest.

### 7.5 Interaction contract

Verify mouse, touch, keyboard, and history:

- focus order and visible focus;
- Enter/Space semantics;
- shortcuts disabled in editable controls;
- Escape dismissal;
- focus restoration;
- hover does not reveal required information without keyboard equivalent;
- dialogs/panes trap focus only when modal;
- Back/Forward and reload restore approved state;
- optimistic, error, conflict, retry, and undo transitions.

### 7.6 Accessibility contract

Run the requirements in `03-engineering-quality-standard.md` and a manual critical
journey. A visual match that fails accessibility is not parity.

## 8. Design exception process

Every exception record MUST contain:

- surface/state;
- exact source rule;
- observed conflict;
- user impact;
- security/accessibility/data reason if applicable;
- smallest proposed deviation;
- alternatives considered;
- screenshot/geometry evidence;
- owner decision and date;
- review expiry.

Unrecorded differences are defects. A reviewer MUST NOT normalize an exception after the
fact because implementation was expensive.

## 9. Design acceptance checklist

A surface is parity-complete when:

- all authoritative files were reviewed and checksummed;
- all required states have fixtures;
- exact copy and data mapping pass;
- structural, computed-style, geometry, interaction, accessibility, and visual layers
  pass;
- large type, 200% zoom, and supported widths pass;
- fixtures include unavailable providers and missing domains/values;
- production data-source behavior matches fixture behavior;
- zero unexplained diff remains;
- every exception has explicit owner approval;
- the design owner accepts the integrated release candidate, not an isolated prototype.
