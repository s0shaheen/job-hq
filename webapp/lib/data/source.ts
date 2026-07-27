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
import type { ProfileCriteria } from "@/lib/profile/criteria";
import type { PreviewResult } from "@/lib/profile/preview";
import type { RegateEntry } from "@/lib/profile/regate";
import type {
  ImportBatchView,
  ImportColumnReportView,
  ImportCounts,
  ImportMapping,
  ImportRowView,
  ImportSourceKind,
} from "@/lib/import/views";

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

// ---- import (P9) ----------------------------------------------------------
//
// Ten methods, which is more than any other feature here, and the reason is the
// state machine: an import is the one gesture in this app that cannot be one
// call. It parses on the server into Postgres and then reads back — so closing
// the tab loses nothing, which is what G12's "resumable" actually requires.
//
// Every mutating one carries an idempotency key, exactly as the triage and
// pipeline writes do, because every one of them is retried by something: the
// upload route chunks, the commit loop chunks, and the outbox replays.

export type CreateImportInput = {
  filename: string;
  sourceKind: ImportSourceKind;
  /**
   * sha-256 of the uploaded bytes. NOT the batch identity — re-importing the
   * same file is a first-class flow (AC 20), and content-addressing the batch
   * would make it impossible to perform. It is here so the preview can say
   * "you imported this exact file on the 3rd" before somebody commits it twice.
   */
  contentHash: string;
  rowCount: number;
  idempotencyKey: string;
};

export type ImportBatchResult =
  | { ok: true; batch: ImportBatchView }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type StageImportInput = {
  batchId: string;
  rows: { rowNumber: number; raw: Record<string, string> }[];
};

export type StageImportResult =
  | { ok: true; staged: number; total: number }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * One row's mapped values, plus the key computed FROM them.
 *
 * `jobKey`/`keyStrength` are computed by `lib/import/job-key.ts` and travel as
 * data because the alternative is a third implementation of `job_key` — one in
 * Python, one here, one in SQL — and a key that differs by a character makes
 * every re-import a silent duplicate. Two implementations are pinned to one
 * golden fixture from both languages; a third would need its own.
 */
/**
 * How many import batches the landing list shows, newest first.
 *
 * One constant because two implementations ask for it: `SupabaseDataSource`
 * passes it to PostgREST and `FixtureDataSource` slices by it. Unbounded in the
 * fake, a demo with 60 batches rendered a list production truncates — a screen
 * nobody could reproduce against the real store.
 */
export const IMPORT_LIST_LIMIT = 25;

export type MappedImportRow = {
  rowNumber: number;
  mapped: Record<string, string>;
  jobKey: string;
  keyStrength: "strong" | "weak" | "none";
};

export type SetImportMappingInput = {
  batchId: string;
  rows: MappedImportRow[];
  mapping: ImportMapping;
  /** The last chunk: stores the mapping and moves the batch on. */
  final: boolean;
  /** Checked on the final call only — two tabs mapping one import conflict. */
  expectedUpdatedAt: string | null;
};

export type ImportPreviewResult =
  | { ok: true; batch: ImportBatchView; counts: ImportCounts; unresolved: number }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type ResolveImportRowInput = {
  batchId: string;
  rowNumber: number;
  choices: Record<string, "mine" | "theirs">;
};

export type ResolveImportRowResult =
  | { ok: true; unresolved: number }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type IncludeImportRowsInput = {
  batchId: string;
  rowNumbers: number[];
  included: boolean;
};

export type CommitImportInput = {
  batchId: string;
  /** Rows per transaction. Bounded server-side to 500 whatever is sent. */
  limit: number;
  idempotencyKey: string;
};

export type ImportCommitResult =
  | {
      ok: true;
      batch: ImportBatchView;
      created: number;
      updated: number;
      skipped: number;
      failed: number;
      /** Rows still pending. The resume cursor, and the loop's exit condition. */
      remaining: number;
    }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type UndoImportInput = { batchId: string; idempotencyKey: string };

/**
 * Throwing away an import that never committed.
 *
 * It exists because of a sentence: `createImport` refuses a 21st unfinished
 * batch with "finish or discard one first", and without this that message named
 * a gesture nobody implemented — after twenty abandoned uploads a person could
 * never import again. A refusal that tells someone to do something the system
 * does not offer is the same defect as a button that does nothing.
 */
export type DiscardImportInput = { batchId: string; idempotencyKey: string };

export type DiscardImportResult =
  | { ok: true }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type ImportUndoResult =
  | {
      ok: true;
      batch: ImportBatchView;
      deleted: number;
      reverted: number;
      /** Rows edited since the import, deliberately left alone (matrix row 33). */
      kept: number;
      keptIds: number[];
      /** Imported notes on surviving rows. Append-only means they stay. */
      notesKept: number;
    }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

// ---- the search profile (P10) ----------------------------------------------

/**
 * One user's Search Profile.
 *
 * `criteria` is NULL when the row holds `'{}'` — never onboarded — and that is
 * distinct from a profile whose every setting happens to be a default. The
 * middleware redirect turns on exactly that difference, so collapsing them
 * would either trap a finished user in the wizard forever or drop a new one
 * into an empty queue with no explanation.
 *
 * `notify` is carried opaquely: the digest phase owns its shape, and this
 * phase's commit must not blank a column it does not edit.
 */
export type ProfileView = {
  criteria: ProfileCriteria | null;
  notify: Record<string, unknown>;
  /** Optimistic-concurrency token: sent back with the commit. */
  updatedAt: string | null;
};

export type PreviewProfileInput = {
  criteria: ProfileCriteria;
  /** Clamped to 1..90 server-side whatever is sent. */
  windowDays?: number;
};

export type PreviewProfileResult =
  | { ok: true; preview: PreviewResult }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * Saving a profile, with what it does to the rows the user already has.
 *
 * `regate` is computed in TypeScript by the caller and travels as data, for
 * matrix row 141's reason: the gate is already implemented twice and pinned to
 * one corpus, and a third copy in PL/pgSQL would need its own guard while
 * failing silently. SQL only APPLIES the plan — and re-checks every promise in
 * it under the row lock, because a plan built against a read is not evidence
 * about the state at write time.
 */
export type CommitProfileInput = {
  criteria: ProfileCriteria;
  notify?: Record<string, unknown> | null;
  regate: RegateEntry[];
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type CommitProfileResult =
  | {
      ok: true;
      profile: ProfileView;
      /** Rows the SERVER actually restamped, not the number the plan hoped for. */
      restamped: number;
      /** …of those, the ones that newly qualify. What the review banner links to. */
      newlyQualifiedKeys: string[];
    }
  | { ok: false; kind: "conflict"; current: ProfileView }
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

  // ---- import (P9) --------------------------------------------------------

  /** Recent imports, newest first — the `/import` landing list. */
  imports(): Promise<ImportBatchView[]>;
  /** One batch and its rows, for `/import/[batchId]`. Null when it is not yours. */
  importBatch(batchId: string): Promise<{ batch: ImportBatchView; rows: ImportRowView[] } | null>;
  /** Open a batch before a single row is staged. */
  createImport(input: CreateImportInput): Promise<ImportBatchResult>;
  /** Bulk-insert source rows verbatim, in chunks. Idempotent per row number. */
  stageImportRows(input: StageImportInput): Promise<StageImportResult>;
  /** Apply the chosen mapping to staged rows, in chunks. */
  setImportMapping(input: SetImportMappingInput): Promise<ImportBatchResult>;
  /** Decide what committing each row would do. Writes nothing to applications. */
  previewImport(batchId: string): Promise<ImportPreviewResult>;
  /** Answer one conflicted round-trip row, cell by cell. */
  resolveImportRow(input: ResolveImportRowInput): Promise<ResolveImportRowResult>;
  /** The preview's veto: exclude rows before they are written. */
  setImportRowsIncluded(input: IncludeImportRowsInput): Promise<StageImportResult>;
  /** Commit one chunk. Called in a loop until `remaining` is 0. */
  commitImportChunk(input: CommitImportInput): Promise<ImportCommitResult>;
  /** The per-column account of what landed and what did not (G13). */
  importReport(batchId: string): Promise<ImportColumnReportView[]>;
  /** Put the whole batch back, in one transaction (AC 21). */
  undoImport(input: UndoImportInput): Promise<ImportUndoResult>;
  /** Bin an import that never wrote anything. Refuses one that did. */
  discardImport(input: DiscardImportInput): Promise<DiscardImportResult>;

  // ---- the search profile (P10) -------------------------------------------

  /** This user's Search Profile. `criteria: null` means the wizard never ran. */
  profile(): Promise<ProfileView>;
  /**
   * What a profile WOULD let through. Writes nothing — `app_preview_corpus` is
   * `stable`, so Postgres refuses a write from inside it rather than trusting
   * this contract to be honoured.
   */
  previewProfile(input: PreviewProfileInput): Promise<PreviewProfileResult>;
  /** Save the profile and restamp the untriaged rows it moves, in one transaction. */
  commitProfile(input: CommitProfileInput): Promise<CommitProfileResult>;

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
