/**
 * The data boundary. One interface, two implementations.
 *
 * Everything the UI needs comes through `DataSource`, so the app can run
 * against Postgres in production and against deterministic fixtures in tests
 * and demo mode. Two things fall out of that, and both are load-bearing:
 *
 *   1. End-to-end tests need no database. Playwright drives the real UI over
 *      known data, which is what makes visual-regression snapshots stable and
 *      lets CI run without a Supabase project.
 *   2. The app can be looked at before anything is provisioned. Demo mode is
 *      a working preview rather than a mockup.
 *
 * The Python side has the same shape (`core/fakes.py`), and it has already
 * paid for itself — including the time the fake was MORE FORGIVING than the
 * real API (it grew a spreadsheet grid that Google refuses to grow), so the
 * whole suite passed while production could not write a column. A fake earns
 * its keep by reproducing failure modes, not just happy paths.
 */
import type {
  ApplicationView,
  ChannelHealthView,
  CompanyView,
  JobView,
  NoteView,
  ReviewState,
  SavedView,
  Triage,
} from "./view-models";

export type QueueOptions = {
  /** Hard cap. A queue that cannot be finished is just another inbox. */
  limit?: number;
};

export type TriageInput = {
  postingKey: string;
  triage: Triage;
  snoozeUntil?: string | null;
  reason?: string;
  /** Client-generated; makes a double-tap or a retry free. */
  idempotencyKey: string;
  /** The value the client last read. A mismatch is a conflict, not a clobber. */
  expectedUpdatedAt: string | null;
};

/**
 * `auth` is separated from `error` deliberately, because the two demand
 * opposite responses. A rejected write is final — revert the row and say so. A
 * write refused because the session expired is not a rejection at all: the
 * decision was valid, it simply could not be delivered yet. Collapsing them
 * means an expired session silently throws away the last thing the user did,
 * which is the version of this bug people actually notice.
 */
export type WriteResult =
  | { ok: true; job: JobView }
  | { ok: false; kind: "conflict"; current: JobView }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * One triage decision applied to many postings, atomically. `postingKeys` and
 * `expectedUpdatedAt` are parallel — index i's expected version guards key i,
 * and a null element skips that row's check. A conflict on ANY row applies
 * NONE of the batch, so the result is all-or-nothing: there is no partial
 * outcome to reconcile.
 */
export type BulkTriageInput = {
  postingKeys: string[];
  triage: Triage;
  snoozeUntil?: string | null;
  reason?: string;
  idempotencyKey: string;
  expectedUpdatedAt: (string | null)[];
};

export type BulkWriteResult =
  | { ok: true; jobs: JobView[] }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * Saving a view. `id` is null to create, or an existing id to update in place;
 * `expectedUpdatedAt` is the version the client last read, so a second device
 * editing the same view conflicts rather than clobbers. `state` is opaque to
 * the store — filters, sort, group, column layout and density all ride inside
 * it, and the database never looks in.
 */
export type SaveViewInput = {
  id: string | null;
  name: string;
  surface: string;
  state: unknown;
  isDefault: boolean;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type SaveViewResult =
  | { ok: true; view: SavedView }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type DeleteViewInput = {
  id: string;
  idempotencyKey: string;
};

export type DeleteViewResult =
  | { ok: true }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * One review decision applied to many companies, atomically — the /companies
 * grid's two verbs. Parallel arrays, exactly as BulkTriageInput: index i's
 * expected version guards company i, and a null element skips that row's check.
 * A conflict on ANY row applies NONE of the batch.
 */
export type BulkReviewInput = {
  companyIds: number[];
  reviewState: ReviewState;
  idempotencyKey: string;
  expectedUpdatedAt: (string | null)[];
};

export type BulkReviewResult =
  | { ok: true; companies: CompanyView[] }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/** The per-row sweep toggles an approved company shows. */
export type CompanyFlagsInput = {
  companyId: number;
  enabled: boolean;
  priority: boolean;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type CompanyFlagsResult =
  | { ok: true; company: CompanyView }
  | { ok: false; kind: "conflict"; current: CompanyView }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * A pasted list of company names → proposed rows.
 *
 * Deliberately names only. Nothing in the web app can resolve a board — the
 * waterfall is `monitor/discover.py`, runs in Python, and is not reachable from
 * here — so this input carries no ats/slug/tier for a caller to assert. The
 * store writes tier 3 / `manual`, which is the truthful description of a name
 * nobody has probed.
 */
export type ProposeCompaniesInput = {
  names: string[];
  /** Provenance tag for the coverage meter's source breakdown. */
  source: string;
  idempotencyKey: string;
};

export type ProposeCompaniesResult =
  | { ok: true; companies: CompanyView[]; added: number }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * A human choosing a status. `status` is free text on purpose: the sheet allows
 * an invented status and `statusRank` ranks one highest by construction, so
 * refusing it here would make the app strictly less capable than the
 * spreadsheet it replaces.
 *
 * `note` is REQUIRED when the move is a reopen (terminal → live). The database
 * enforces that, not this type — `app_set_status` refuses an empty body, so the
 * rule holds for a replayed outbox gesture and for any other caller.
 */
export type StatusInput = {
  applicationId: number;
  status: string;
  note?: string | null;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type SuggestionInput = {
  applicationId: number;
  decision: "confirm" | "reject";
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * Appending a note. No `expectedUpdatedAt`, deliberately: a note cannot
 * conflict with anything, because it overwrites no value. "Somebody else wrote
 * one first" is not an error, it is two notes — and demanding a version token
 * would reject a good comment because an unrelated status changed while it was
 * being typed, which is how people learn to keep their notes somewhere else.
 */
export type NoteInput = {
  applicationId: number;
  body: string;
  idempotencyKey: string;
};

export type NextActionInput = {
  applicationId: number;
  nextAction: string;
  nextActionDate: string | null;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * The result of a pipeline write.
 *
 * Same four-way shape as `WriteResult` and for the same reasons — `auth` is
 * separate from `error` because an expired session is a deferral, not a
 * rejection, and collapsing them throws away the last thing the user did.
 */
export type AppWriteResult =
  | { ok: true; application: ApplicationView }
  | { ok: false; kind: "conflict"; current: ApplicationView }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export interface DataSource {
  /** Qualified, untriaged, freshest first. */
  queue(opts?: QueueOptions): Promise<JobView[]>;
  /** Everything, for the grid — filtering happens client-side over this. */
  jobs(): Promise<JobView[]>;
  applications(): Promise<ApplicationView[]>;
  health(): Promise<ChannelHealthView[]>;
  setTriage(input: TriageInput): Promise<WriteResult>;
  /** One triage applied to N postings in one transaction — all or nothing. */
  setTriageBulk(input: BulkTriageInput): Promise<BulkWriteResult>;

  // ---- the pipeline (P8) --------------------------------------------------

  /** A human sets a status. Always claims the row against later bot writes. */
  setStatus(input: StatusInput): Promise<AppWriteResult>;
  /** Confirm or reject a bot's `suggestedStatus`. Reject touches status not at all. */
  resolveSuggestion(input: SuggestionInput): Promise<AppWriteResult>;
  /** Append a note. Never overwrites — there is no edit. */
  addNote(input: NoteInput): Promise<AppWriteResult>;
  setNextAction(input: NextActionInput): Promise<AppWriteResult>;
  /** One application's note history, newest first. */
  notes(applicationId: number): Promise<NoteView[]>;

  /**
   * The user's slice of the shared company universe — proposals included.
   * Filtering by review state happens client-side over this, like `jobs()`.
   */
  companies(): Promise<CompanyView[]>;
  /** One review decision applied to N companies in one transaction. */
  setCompanyReviewBulk(input: BulkReviewInput): Promise<BulkReviewResult>;
  /** The sweep toggles on one approved company. */
  setCompanyFlags(input: CompanyFlagsInput): Promise<CompanyFlagsResult>;
  /** A pasted list of names → tier-3 proposals awaiting review. */
  proposeCompanies(input: ProposeCompaniesInput): Promise<ProposeCompaniesResult>;

  /** A user's saved grid states for a surface. Built-in presets live in code. */
  savedViews(surface: string): Promise<SavedView[]>;
  saveView(input: SaveViewInput): Promise<SaveViewResult>;
  deleteView(input: DeleteViewInput): Promise<DeleteViewResult>;
}

/**
 * Demo mode is opt-in and never the default: a production deployment that
 * silently served fixtures would be indistinguishable from a working app
 * while showing invented jobs, which is worse than an error page.
 */
export function isDemoMode(): boolean {
  // Both arms are deliberate and they answer different questions. `HQ_DEMO` is
  // read at request time on the server, which is what every caller here needs.
  // `NEXT_PUBLIC_HQ_DEMO` is inlined at BUILD time — useless for a server-side
  // decision, and kept because `playwright.config.ts` sets it and a future client
  // component that has to know (a demo banner, a seam control) can only see the
  // public one. If no such component exists by P11, drop it.
  return process.env.HQ_DEMO === "1" || process.env.NEXT_PUBLIC_HQ_DEMO === "1";
}
