/**
 * The cell declarations (`17-ui-verification-standard.md` §3).
 *
 * One cell per (surface, state, mode). A cell not declared here is `missing`,
 * which is the point: a new surface, or a new state row in
 * `04-design-parity-standard.md §5`, arrives red rather than silently absent.
 *
 * Seeded by opening the specs, not by asking what would make the run green. A
 * `covered` verdict names a spec file and an exact test title, and the renderer
 * refuses to accept a citation it cannot resolve.
 */
import type { Mode } from "./sources";
import type { Citation } from "./spec-titles";

export type Cell =
  | { readonly verdict: "covered"; readonly cites: readonly Citation[] }
  | { readonly verdict: "n/a"; readonly reason: string }
  | { readonly verdict: "blocked"; readonly reason: string; readonly add: string }
  | { readonly verdict: "missing" };

export type Verdict = Cell["verdict"];

/**
 * Cite one or more Playwright tests in one spec file.
 *
 * More than one title is for a cell that genuinely takes two journeys to state —
 * the holding surface has to be right for a pending account AND for a suspended
 * one, and citing only the first would credit the cell with half its claim. It is
 * not a place to pile up loosely related titles: every citation is resolved, so a
 * long list is a long list of things that must stay named exactly as written.
 */
export function e2e(file: string, ...titles: readonly string[]): Cell {
  return {
    verdict: "covered",
    cites: titles.map((title) => ({ spec: `tests/e2e/${file}.spec.ts`, title })),
  };
}

export function na(reason: string): Cell {
  return { verdict: "n/a", reason };
}

export function blocked(add: string, reason: string): Cell {
  return { verdict: "blocked", add, reason };
}

export const MISSING: Cell = { verdict: "missing" };

/**
 * Short keys for the §5 state names. The names are the authority; these
 * constants exist only so a typo is a compile error. `assertStatesMatch` in
 * `report.ts` fails loudly if §5 and this list ever diverge.
 */
export const ST = {
  loading: "Loading",
  populated: "Populated",
  naturalEmpty: "Natural empty",
  filterEmpty: "Filter empty",
  missingFact: "Missing optional fact",
  degraded: "Partial/degraded",
  validation: "Validation error",
  writePending: "Write pending",
  offline: "Offline write disabled",
  conflict: "Conflict",
  permission: "Permission/holding",
  sessionExpired: "Session expired",
  fatal: "Fatal route error",
  detail: "Selected/detail",
  longStrings: "Long strings",
  highVolume: "High volume",
  largeType: "Large type",
  zoom: "200% zoom",
  narrow: "Narrow viewport",
  reducedMotion: "Reduced motion",
  providerImage: "Provider image failure",
} as const;

export interface SurfaceLedger {
  /** Routes this surface owns. Empty means unbuilt: listed, never enforced. */
  readonly routes: readonly string[];
  /** Anything a reader of the rendered ledger would otherwise get wrong. */
  readonly note?: string;
  /** Applied to every state, for a surface that is one verdict end to end. */
  readonly all?: Cell;
  /** Per-state verdicts in `fixture` mode. */
  readonly fixture?: Readonly<Record<string, Cell>>;
  /** Per-state verdicts in `live` mode. Empty today; see the baseline. */
  readonly live?: Readonly<Record<string, Cell>>;
}

export const LEDGER: Readonly<Record<string, SurfaceLedger>> = {
  today: {
    routes: ["/queue"],
    fixture: {
      [ST.loading]: e2e("resilience", "a slow data source shows a skeleton rather than a blank screen"),
      [ST.populated]: e2e("triage", "the four decision facts are visible without any interaction"),
      [ST.naturalEmpty]: e2e("empty", "an empty queue with nothing filtered does not invent a constraint"),
      [ST.filterEmpty]: e2e("empty", "an empty queue caused by the profile names the binding constraint"),
      [ST.missingFact]: e2e("triage", "an unstated value reads 'Not listed' rather than being hidden"),
      [ST.degraded]: MISSING,
      [ST.validation]: na("the queue takes no typed input; its only gestures are the four triage verbs"),
      [ST.writePending]: e2e("undo-delivery", "undo after the flush delivered the decision really undoes it"),
      [ST.offline]: e2e("offline", "the decision survives a reload while still offline"),
      [ST.conflict]: e2e("offline", "a conflict on replay says the decision lost, instead of pretending it landed"),
      [ST.permission]: e2e(
        "entry-path",
        "asking for the queue lands on the holding page, and the queue is not rendered on the way",
      ),
      [ST.sessionExpired]: e2e("offline", "the held decision is applied once the session is back"),
      [ST.fatal]: MISSING,
      [ST.detail]: na("the queue shows one card at a time; there is no list selection and no detail pane"),
      [ST.longStrings]: e2e("layout", "long titles and long company names do not break the triage card"),
      [ST.highVolume]: MISSING,
      [ST.largeType]: e2e("layout", "nothing paints past the edge at the large type scale"),
      [ST.zoom]: e2e("resilience", "the page survives a 200% text zoom"),
      [ST.narrow]: e2e("layout", "on a phone, the first job is on the first screen"),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: MISSING,
    },
  },

  jobs: {
    routes: ["/jobs"],
    fixture: {
      [ST.loading]: e2e("grid", "the skeleton and the loaded grid put the header rail in the same place"),
      [ST.populated]: e2e("grid", "the Queue set shows qualified, undecided rows only — and states its counts"),
      [ST.naturalEmpty]: e2e("grid", "with nothing found at all, the grid says so instead of rendering a bare header"),
      [ST.filterEmpty]: e2e(
        "grid",
        "a filter that matches nothing says so and offers one-click clear — distinct from profile gating",
      ),
      [ST.missingFact]: e2e(
        "grid",
        "a value the posting never stated renders as Not listed, never an invention",
      ),
      [ST.degraded]: e2e("grid-views", "a stale view id falls back loudly — never a 404, never a blank grid"),
      [ST.validation]: e2e("grid-views", "a name collision is rejected with the store's message, not a crash"),
      [ST.writePending]: e2e(
        "grid-selection",
        "bulk i on 3 rows creates 3 applications through one action with ONE undo toast",
      ),
      [ST.offline]: MISSING,
      [ST.conflict]: e2e(
        "grid-selection",
        "a conflict inside the batch applies NOTHING: full revert plus a changed-elsewhere toast",
      ),
      [ST.permission]: e2e(
        "entry-path",
        "asking for the jobs grid lands on the holding page with no rows anywhere",
      ),
      [ST.sessionExpired]: e2e("grid-views", "an expired session answers with the auth copy, not a crash"),
      [ST.fatal]: MISSING,
      // Two things, because the redesign split them. Selection is the checkbox
      // track; the DETAIL is a pane that opens on row click, which is the state
      // §5 names and which no selection test looks at.
      [ST.detail]: {
        verdict: "covered",
        cites: [
          {
            spec: "tests/e2e/jobs-redesign.spec.ts",
            title: "opens on row click, over a list that stays interactive",
          },
          {
            spec: "tests/e2e/grid-selection.spec.ts",
            title: "checkboxes build a selection, and Clear empties it",
          },
        ],
      },
      [ST.longStrings]: e2e("grid", "the long fixture row stays one row tall and keeps its full text reachable"),
      [ST.highVolume]: e2e("grid-perf", "row 25: the DOM holds a bounded number of rows at any scroll position"),
      [ST.largeType]: e2e("grid-polish", "the header and body columns stay aligned at large type"),
      [ST.zoom]: e2e("resilience", "the page survives a 200% text zoom"),
      [ST.narrow]: e2e("grid", "the grid, not the page, absorbs the horizontal overflow"),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: {
        verdict: "covered",
        cites: [
          {
            spec: "tests/e2e/jobs-redesign.spec.ts",
            title: "a logo host that never answers degrades to the monogram, not a broken image",
          },
          {
            spec: "tests/e2e/jobs-redesign.spec.ts",
            title: "a company the universe has no domain for is on the monogram already",
          },
          // The third rendered case. It was passing and uncited, which is the
          // one way a covered cell silently uncovers itself: the resolver only
          // protects titles it is pointed at, so a rename here would have taken
          // the branch's own accessibility fix out of the ledger without
          // failing anything.
          {
            spec: "tests/e2e/jobs-redesign.spec.ts",
            title: "the monogram is decorative, so the column does not read as 'R A Ramp'",
          },
        ],
      },
    },
  },

  applications: {
    routes: ["/pipeline", "/apply/[applicationId]"],
    fixture: {
      [ST.loading]: e2e("loading", "the skeleton and the loaded page put content in the same place"),
      [ST.populated]: e2e("pipeline", "groups render in ladder order, not alphabetically"),
      [ST.naturalEmpty]: e2e("empty", "zero rows"),
      [ST.filterEmpty]: na(
        "the pipeline has no filter clause builder; groups collapse rather than remove rows, and a collapsed group still states its count",
      ),
      [ST.missingFact]: e2e("apply", "a row whose link names no board says which half is missing"),
      [ST.degraded]: e2e("apply", "a non-Greenhouse row says what is not supported, not that something failed"),
      [ST.validation]: e2e("apply", "no gap can be saved before somebody chooses"),
      [ST.writePending]: e2e("pipeline", "a failed write reverts the row, and Retry succeeds"),
      [ST.offline]: MISSING,
      [ST.conflict]: e2e("pipeline", "a conflict toasts AND refreshes the value on screen"),
      [ST.permission]: e2e(
        "entry-path",
        "asking for the pipeline or an application lands on the holding page",
      ),
      [ST.sessionExpired]: MISSING,
      [ST.fatal]: e2e("apply", "a posting the board no longer has is a state, not an error page"),
      [ST.detail]: e2e("apply", "Prepare is reachable from the pipeline row it belongs to"),
      [ST.longStrings]: MISSING,
      [ST.highVolume]: e2e("pipeline", "a 200-row group stays LINEAR — the trigger to virtualize"),
      [ST.largeType]: e2e("pipeline", "the large type scale really grows the tokens, and the pill still fits"),
      [ST.zoom]: e2e("resilience", "the page survives a 200% text zoom"),
      [ST.narrow]: e2e("layout", "nothing paints past the page edge"),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: MISSING,
    },
  },

  coverage: {
    routes: ["/companies", "/companies/add", "/health"],
    fixture: {
      [ST.loading]: e2e("companies", "the loading skeleton carries every band the loaded page does"),
      [ST.populated]: e2e("companies", "every row's chip names a confidence — none is silently blank"),
      [ST.naturalEmpty]: e2e("empty", "zero rows"),
      [ST.filterEmpty]: e2e("companies", "a zero-result search offers a way back"),
      [ST.missingFact]: MISSING,
      [ST.degraded]: e2e("companies", "does not render NaN on an empty universe"),
      [ST.validation]: e2e("companies", "the submit button is inert until something parses"),
      [ST.writePending]: e2e("companies", "a failed write reverts the whole batch and says so"),
      [ST.offline]: MISSING,
      [ST.conflict]: MISSING,
      [ST.permission]: e2e("entry-path", "asking for companies or health lands on the holding page"),
      [ST.sessionExpired]: MISSING,
      [ST.fatal]: e2e("companies", "a bogus set or sort renders the default rather than crashing"),
      [ST.detail]: e2e("companies", "a selection stays accessible and does not shift the rows"),
      [ST.longStrings]: MISSING,
      [ST.highVolume]: MISSING,
      [ST.largeType]: e2e("layout", "nothing paints past the edge at the large type scale"),
      [ST.zoom]: e2e("resilience", "the page survives a 200% text zoom"),
      [ST.narrow]: e2e("companies", "the grid scrolls inside its own container at 280px"),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: MISSING,
    },
  },

  "shared-shell-and-components": {
    routes: ["(app) layout, nav, toasts, dialogs, the pending-work banner"],
    note: "The shell has no route of its own; it is the chrome every routed surface renders inside.",
    fixture: {
      [ST.loading]: na("the shell renders synchronously; each surface owns its own skeleton row"),
      [ST.populated]: e2e("routing", "every href in the rendered nav returns 200"),
      [ST.naturalEmpty]: e2e("empty", "the nav shows no count rather than a zero"),
      [ST.filterEmpty]: na("the shell holds no rows to filter"),
      [ST.missingFact]: na("the shell renders no posting or application facts"),
      [ST.degraded]: MISSING,
      [ST.validation]: na("the shell has no form"),
      [ST.writePending]: e2e("offline", "no banner when there is nothing pending"),
      [ST.offline]: e2e("offline", "a rejected replay leaves a visible notice, not a vanished banner"),
      [ST.conflict]: na("a conflict is reported by the surface that issued the write, never by the shell"),
      [ST.permission]: e2e(
        "entry-path",
        "the holding page carries none of the app shell a signed-in user gets",
      ),
      [ST.sessionExpired]: e2e("offline", "it is not confused with being offline"),
      [ST.fatal]: e2e("routing", "an unknown address keeps the app shell and offers a way back"),
      [ST.detail]: na("the shell selects nothing"),
      [ST.longStrings]: MISSING,
      [ST.highVolume]: na("the nav is a fixed list of surfaces; it has no unbounded collection"),
      [ST.largeType]: e2e("layout", "nothing paints past the edge at the large type scale"),
      [ST.zoom]: e2e("resilience", "the page survives a 200% text zoom"),
      [ST.narrow]: e2e("layout", "nothing paints past the page edge"),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: na("the shell renders no provider imagery"),
    },
  },

  "find-intro": {
    routes: ["/connections"],
    note: "/connections is outside the layout and resilience sweep lists; its overflow and axe runs live in referral.spec.ts instead.",
    fixture: {
      [ST.loading]: MISSING,
      [ST.populated]: e2e(
        "warm-intro",
        "results mode paints the panel, the count, the searched-for line, signals and fit",
      ),
      [ST.naturalEmpty]: e2e("warm-intro", "empty mode says so plainly and still offers the add box"),
      [ST.filterEmpty]: e2e("referral", "an empty export explains the four clicks that produce one"),
      [ST.missingFact]: e2e("referral", "a job row with no import says so, rather than saying nobody works there"),
      [ST.degraded]: e2e("referral", "with an export, a company nobody knows says the OTHER thing"),
      [ST.validation]: e2e("warm-intro", "the manual add box refuses a non-LinkedIn URL, and pins nothing"),
      [ST.writePending]: e2e("warm-intro", "pending mode shows the running state, and the Cancel X returns to idle"),
      [ST.offline]: MISSING,
      [ST.conflict]: MISSING,
      [ST.permission]: e2e(
        "entry-path",
        "asking for connections lands on the holding page, naming no one",
      ),
      [ST.sessionExpired]: MISSING,
      [ST.fatal]: MISSING,
      [ST.detail]: e2e("warm-intro", "multi-select pins both, survives a reload, and unpinning one leaves the other"),
      [ST.longStrings]: MISSING,
      [ST.highVolume]: blocked(
        "ADD-001",
        "the deterministic 40-total default across three searches and the result-shortfall presentation are unapproved design input, so there is no volume behaviour to verify against",
      ),
      [ST.largeType]: MISSING,
      [ST.zoom]: MISSING,
      [ST.narrow]: e2e("referral", "the new surface does not look broken"),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: na("the connections list renders names and links, no provider imagery"),
    },
  },

  "settings-auth-onboarding": {
    routes: ["/settings", "/settings/answers", "/onboarding/[step]", "/login", "/pending", "/setup", "/auth/*"],
    note:
      "The entry path is covered as journeys in entry-path.spec.ts: /login, /pending, /setup and /auth/* render in a browser on both projects, under the pending, suspended and active entitlements, with an axe pass on each new page state. Two things are deliberately NOT covered and are not faked. The Google button on /login renders only when getSupabaseEnv() is non-null and NEXT_PUBLIC_SUPABASE_* are inlined at build time, so under HQ_DEMO the login page is the unconfigured deployment's login page and the OAuth hand-off belongs to the live lane. And /pending is provisional by its own header comment — the designed Auth surface lands later — so it carries behaviour and data-absence assertions and no visual baseline.",
    fixture: {
      [ST.loading]: MISSING,
      [ST.populated]: e2e("profile", "the profile renders what is saved, not empty fields"),
      [ST.naturalEmpty]: e2e("answers", "with nothing saved, the surface says so instead of rendering blank cards"),
      [ST.filterEmpty]: na("neither settings surface filters a list; the answers library lists every stored rule"),
      [ST.missingFact]: e2e("answers", "an unset knockout rule reads as a question, never as an answer"),
      [ST.degraded]: e2e("answers", "a rule stored in an unreadable shape says so instead of showing an answer"),
      [ST.validation]: e2e("profile", "save is refused until the settings have been checked at least once"),
      [ST.writePending]: e2e("profile", "double-clicking Save leaves one change and no error"),
      [ST.offline]: MISSING,
      [ST.permission]: e2e(
        "entry-path",
        "asking for settings or the onboarding wizard lands on the holding page",
        "is refused in different words from a pending one, and the page does not guess",
        "the holding page's only action is a real way out, and it works without client JS",
      ),
      [ST.conflict]: e2e("profile", "an autosaved preference does not make the profile form report a conflict"),
      [ST.sessionExpired]: e2e(
        "entry-path",
        "the typed draft survives the refusal, and lands once the session is back",
      ),
      [ST.fatal]: e2e("onboarding", "an out-of-range step is a real page, not a 404"),
      [ST.detail]: e2e("answers", "a one-company answer says so, and its scope survives an edit"),
      [ST.longStrings]: e2e("onboarding", "a draft too long for a URL says so instead of losing the answers"),
      [ST.highVolume]: MISSING,
      [ST.largeType]: e2e("layout", "nothing paints past the edge at the large type scale"),
      [ST.zoom]: e2e("resilience", "the page survives a 200% text zoom"),
      [ST.narrow]: e2e("layout", "nothing paints past the page edge"),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: na("the settings surfaces render no provider imagery"),
    },
  },

  "billing-landing-email-import-export": {
    routes: ["/import", "/import/[batchId]", "/api/export"],
    note:
      "Import and export are built and covered. Billing, the landing page and the email surface have no route in this app at all, so every state that belongs to them is blocked on ADD-006 rather than merely untested.",
    fixture: {
      [ST.loading]: MISSING,
      [ST.populated]: e2e("import", "40 rows in, and a re-import adds none of them again"),
      [ST.naturalEmpty]: e2e("import", "the landing page names what to do when nothing has been imported"),
      [ST.filterEmpty]: na("the wizard shows the rows of the file that was uploaded; there is nothing to filter"),
      [ST.missingFact]: MISSING,
      [ST.degraded]: MISSING,
      [ST.validation]: e2e("import", "an .xls is refused by name rather than by stack trace"),
      [ST.writePending]: MISSING,
      [ST.offline]: MISSING,
      [ST.conflict]: e2e("import", "a stale round-trip edit blocks Commit until it is resolved"),
      [ST.permission]: blocked(
        "ADD-006",
        "the holding and refusal copy for a lapsed or over-quota account is a billing lifecycle state beyond the founding-free view, which has no approved design input",
      ),
      [ST.sessionExpired]: MISSING,
      [ST.fatal]: MISSING,
      [ST.detail]: e2e("import", "a reload mid-wizard lands on the same step"),
      [ST.longStrings]: MISSING,
      [ST.highVolume]: MISSING,
      [ST.largeType]: e2e("import-wizard", "the wizard survives the large type scale"),
      [ST.zoom]: e2e("resilience", "the page survives a 200% text zoom"),
      [ST.narrow]: e2e("import-wizard", "nothing in the wizard paints past the page edge"),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: na("neither the wizard nor the export dialog renders provider imagery"),
    },
  },

  "system-and-mobile": {
    routes: ["the 404 handler", "the offline and expired-session banners", "the mobile Playwright project"],
    note:
      "The mobile project is a Pixel 7 viewport and nothing else: the repo issues zero tap, touchscreen or gesture calls, so every phone assertion here is about composition, never about touch input.",
    fixture: {
      [ST.loading]: na("the system surface renders no data of its own"),
      [ST.populated]: e2e("routing", "every href in the rendered nav returns 200"),
      [ST.naturalEmpty]: na("the system surface has no collection"),
      [ST.filterEmpty]: na("the system surface has no collection"),
      [ST.missingFact]: na("the system surface renders no posting facts"),
      [ST.degraded]: e2e("resilience", "a slow data source shows a skeleton rather than a blank screen"),
      [ST.validation]: na("the system surface has no form"),
      [ST.writePending]: e2e("offline", "a full localStorage still holds the decision for this tab, and says so"),
      [ST.offline]: e2e("offline", "undo works offline, because nothing was ever sent"),
      [ST.conflict]: na("a conflict belongs to the surface that issued the write"),
      [ST.permission]: e2e(
        "entry-path",
        "an address that does not exist still lands on the holding page, not on a 404 with a nav",
      ),
      [ST.sessionExpired]: e2e("offline", "the decision is held and the banner offers a way back in"),
      [ST.fatal]: e2e("routing", "an unknown address keeps the app shell and offers a way back"),
      [ST.detail]: na("the system surface selects nothing"),
      [ST.longStrings]: MISSING,
      [ST.highVolume]: na("the system surface has no collection"),
      [ST.largeType]: e2e("layout", "nothing paints past the edge at the large type scale"),
      [ST.zoom]: e2e("resilience", "the page survives a 200% text zoom"),
      [ST.narrow]: blocked(
        "ADD-005",
        "phone behaviour for every template, including file upload, download and preview, is unapproved design input; the mobile project asserts overflow only",
      ),
      [ST.reducedMotion]: MISSING,
      [ST.providerImage]: na("the system surface renders no provider imagery"),
    },
  },

  autopilot: {
    routes: [],
    note: "No route exists. Listed as unbuilt; contributes no enforced cell.",
    all: blocked(
      "ADD-003",
      "executor health, offline and update, provider manual handoff, outcome unknown and receipt redaction are unapproved design input, and no route renders them",
    ),
  },

  resume: {
    routes: [],
    note: "No route exists. Listed as unbuilt; contributes no enforced cell.",
    all: blocked(
      "ADD-002",
      "the generic resume editor, import, render, version and attachment flows are unapproved design input, and no route renders them",
    ),
  },

  "operator-admin": {
    routes: [],
    note: "No route exists. Listed as unbuilt; contributes no enforced cell.",
    all: blocked(
      "ADD-004",
      "operator activation, suspension, consented support access and kill switches are unapproved design input, and no route renders them",
    ),
  },
};

export interface BaselineEntry {
  /** `surface | state | mode`. `*` is allowed in any field. */
  readonly key: string;
  /** One line. Why this cell is missing, not why it is acceptable. */
  readonly reason: string;
}

export interface Baseline {
  readonly date: string;
  readonly entries: readonly BaselineEntry[];
}

/**
 * The gaps that already existed when the ledger was first rendered.
 *
 * Baselined is NOT covered. An entry here buys exactly one thing: the gate can
 * be turned on today without a twelve-surface backfill first, so any NEW
 * missing cell fails immediately instead of joining an invisible pile. Deleting
 * an entry is how a surface packet closes a gap, and an entry that no longer
 * matches a missing cell is itself a failure — the list can only shrink.
 */
export const BASELINE_MISSING: Baseline = {
  date: "2026-08-02",
  entries: [
    // Mode. Still one entry, and it stays until the lane has actually RUN.
    //
    // BOTH HALVES NOW EXIST AND THE CELLS ARE STILL NOT EARNED. The harness is
    // built — `webapp/tests/live/`, the `live-desktop`/`live-mobile` projects,
    // and `tests/e2e/entry-journey.spec.ts` running in both modes. The project
    // is provisioned too: `job-hq-e2e` (`ehpngcdtymqxmqrcfpby`), all 28
    // migrations applied from empty, `allowed_emails` deliberately empty
    // (`18-deployment-readiness.md`). What has not happened is a RUN. Not one
    // live cell has been observed green, because `.github/workflows/live-e2e.yml`
    // fires on merge to main and this work is still on a branch.
    //
    // Retiring 189 cells on the strength of a harness that has never executed
    // would be the exact vacuous coverage claim `17 §10` exists to prevent —
    // and provisioning makes that MORE tempting, not less, because it feels like
    // the blocker cleared. It did not. "Runnable" is not "run".
    //
    // WHAT UNBLOCKS IT: land this branch, let the workflow run green on main,
    // then fill the cells from that report. The evidence is a report, never an
    // intention.
    {
      key: "* | * | live",
      reason:
        "The live lane is built and its Supabase project is provisioned, but the lane has never executed: it runs on merge to main and this work is still on a branch. So RLS, entitlement, real sessions and SupabaseDataSource have no OBSERVED rendered-journey coverage.",
    },

    // Reduced motion — nothing in the estate asserts it on any surface.
    { key: "* | Reduced motion | fixture", reason: "No spec runs with prefers-reduced-motion: reduce; the only reducedMotion context option in the estate is incidental to a forced-colors run." },

    // Session expired, where no spec reaches the surface.
    { key: "applications | Session expired | fixture", reason: "Session expiry is asserted from /queue only; no spec expires a session mid-journey on /pipeline or /apply." },
    { key: "coverage | Session expired | fixture", reason: "No spec expires a session on /companies or /health." },
    { key: "find-intro | Session expired | fixture", reason: "No spec expires a session on /connections." },
    { key: "billing-landing-email-import-export | Session expired | fixture", reason: "No spec expires a session mid-import." },

    // Offline write disabled, away from the queue.
    { key: "jobs | Offline write disabled | fixture", reason: "offline.spec drives /queue; bulk triage from the grid is never exercised offline." },
    { key: "applications | Offline write disabled | fixture", reason: "A status change or note written while offline is never exercised." },
    { key: "coverage | Offline write disabled | fixture", reason: "Approve and dismiss are never exercised offline." },
    { key: "find-intro | Offline write disabled | fixture", reason: "Starting or pinning an intro is never exercised offline." },
    { key: "settings-auth-onboarding | Offline write disabled | fixture", reason: "Saving the profile or an answer is never exercised offline." },
    { key: "billing-landing-email-import-export | Offline write disabled | fixture", reason: "Commit is never exercised offline." },

    // Conflict, where no second writer is simulated.
    { key: "coverage | Conflict | fixture", reason: "No spec simulates a second device reviewing the same company batch." },
    { key: "find-intro | Conflict | fixture", reason: "No spec simulates a second device pinning the same connection." },

    // Loading skeletons.
    { key: "find-intro | Loading | fixture", reason: "/connections has no skeleton assertion." },
    { key: "settings-auth-onboarding | Loading | fixture", reason: "Neither settings surface nor the wizard has a skeleton assertion." },
    { key: "billing-landing-email-import-export | Loading | fixture", reason: "The wizard has no skeleton assertion." },

    // Degraded and missing-fact holes.
    { key: "today | Partial/degraded | fixture", reason: "A queue rendered with the engine's scoring unavailable is never exercised." },
    { key: "coverage | Missing optional fact | fixture", reason: "A company row with no domain, tier or evidence is never asserted to read Not listed." },
    { key: "shared-shell-and-components | Partial/degraded | fixture", reason: "The shell with a dependency named as unavailable is never rendered." },
    { key: "billing-landing-email-import-export | Missing optional fact | fixture", reason: "A mapped column the file never supplied is never asserted to read Not listed." },
    { key: "billing-landing-email-import-export | Partial/degraded | fixture", reason: "A partially parseable workbook is never exercised." },

    // Fatal route error.
    { key: "today | Fatal route error | fixture", reason: "No spec forces /queue to throw; only the 404 path is covered." },
    { key: "jobs | Fatal route error | fixture", reason: "A malformed view falls back loudly, but a thrown render is never exercised." },
    { key: "find-intro | Fatal route error | fixture", reason: "No spec forces /connections to throw." },
    { key: "billing-landing-email-import-export | Fatal route error | fixture", reason: "No spec forces the wizard to throw; an unknown batch id is not asserted." },

    // Write pending.
    { key: "billing-landing-email-import-export | Write pending | fixture", reason: "Commit's in-flight state is never asserted; only its result is." },

    // Long strings. Length is covered on three surfaces; script never is.
    { key: "applications | Long strings | fixture", reason: "No spec asserts a long board-written question label or note wraps rather than truncating." },
    { key: "coverage | Long strings | fixture", reason: "No spec asserts a long company name wraps inside its cell." },
    { key: "shared-shell-and-components | Long strings | fixture", reason: "No spec asserts a long toast or nav count stays inside the shell." },
    { key: "find-intro | Long strings | fixture", reason: "No spec asserts a long connection name or headline wraps." },
    { key: "billing-landing-email-import-export | Long strings | fixture", reason: "No spec asserts a long column header or cell value wraps in the mapping list." },
    { key: "system-and-mobile | Long strings | fixture", reason: "No spec anywhere renders non-Latin script, emoji, CJK or RTL text; every long-string assertion in the estate is Latin-only." },

    // High volume.
    { key: "today | High volume | fixture", reason: "No spec drives the queue at thousands of cards." },
    { key: "coverage | High volume | fixture", reason: "No spec drives /companies at thousands of rows; the perf budget covers /jobs only." },
    { key: "settings-auth-onboarding | High volume | fixture", reason: "No spec drives the answers library at hundreds of stored rules." },
    { key: "billing-landing-email-import-export | High volume | fixture", reason: "No spec drives the wizard at a workbook of thousands of rows." },

    // Large type and zoom, where the sweep lists do not reach.
    { key: "find-intro | Large type | fixture", reason: "/connections is absent from the large-type overflow sweep in layout.spec.ts." },
    { key: "find-intro | 200% zoom | fixture", reason: "/connections is absent from the 200% zoom sweep in resilience.spec.ts." },

    // Provider imagery — the monogram fallback is unit-tested only.
    { key: "today | Provider image failure | fixture", reason: "The monogram fallback for a failed company logo is asserted in unit tests only, never in a rendered page." },
    { key: "applications | Provider image failure | fixture", reason: "The monogram fallback for a failed company logo is asserted in unit tests only." },
    { key: "coverage | Provider image failure | fixture", reason: "The monogram fallback for a failed company logo is asserted in unit tests only, on the surface that shows the most logos." },
  ],
};

export type { Mode };
