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
  ActivityView,
  ApplicationView,
  ChannelHealthView,
  CompanyView,
  ConnectionView,
  JobView,
  NoteView,
  ReviewState,
  SavedView,
  Triage,
} from "./view-models";
import type { AnswerView, PolicyRuleView } from "@/lib/apply/views";
// Type-only: the persistence seam's stored shapes, so a command and the module
// that maps into it cannot drift apart.
import type { StoredAnswer, StoredGap } from "@/lib/apply/persist";
import type { Provenance, SituationFact } from "@/lib/apply/types";
import type { ProfileCriteria } from "@/lib/profile/criteria";
import type { PreviewResult } from "@/lib/profile/preview";
import type { RegateEntry } from "@/lib/profile/regate";
// Type-only: erased at build, so `lib/warm/config`'s process.env read never
// reaches a client bundle through this widely-imported module.
import type { WarmCandidate, WarmParams, WarmPersona, WarmStatus } from "@/lib/warm/types";
import type {
  Density,
  DisplayPrefs,
  TypeScale,
} from "@/lib/display/prefs";
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

// ---- quick add (RM-12: the Quick Add tab's replacement) --------------------
//
// Two capabilities, deliberately separate, because they fail differently and
// only one of them writes:
//
//   `resolveJobLink` READS. It may fail, be slow, or come back with nothing,
//   and none of that is allowed to cost the user the link they pasted.
//   `addJob` WRITES, through the sanctioned command path, and takes exactly
//   what the user confirmed on screen — never the resolver's output directly.
//
// That split is the whole safety property of this surface. The legacy lane
// (`tracker/quickadd.py`) fetched, asked a model for five fields, and appended
// the answer, so a confidently wrong extraction became a row nobody reviewed.
// Here the extraction is a proposal the user can see, correct, and overrule
// before anything is written.

/** One thing a resolver claimed, and where it read it. Null means Not listed. */
export type ResolvedFact = { value: string; from: string } | null;

export type ResolveJobLinksInput = {
  /** Exactly what the user pasted. Split and classified by the resolver. */
  pasted: string;
};

export type ResolvedLink = {
  /** The absolute URL, or the raw text when the entry was never a link. */
  url: string;
  /** What the user actually typed, echoed so the surface never rewrites it. */
  entered: string;
  /**
   * `jobKey` over the URL — the identity every funnel in this system shares.
   * "" when the entry is free text, which is why such an entry can be added
   * only by hand.
   */
  key: string;
  company: ResolvedFact;
  title: ResolvedFact;
  /**
   * Null when the page was read. Otherwise the one plain sentence the fetcher
   * produces for every refusal alike (`lib/quickadd/fetch.ts` states why).
   */
  unreadable: string | null;
  /**
   * Set when this user already tracks the posting. The surface offers to open
   * it; nothing about it is written again.
   */
  duplicate: { key: string; company: string; title: string } | null;
};

export type ResolveJobLinksResult =
  | { ok: true; links: ResolvedLink[] }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * The outcome of charging a per-user bound (#261).
 *
 * `rate-limited` carries the sentence already resolved from the meter, because
 * the database's own message names the meter and the numbers and a refusal says
 * what to do rather than what said no. `error` is deliberately NOT a pass: an
 * unreachable meter is not permission to spend the capacity it was bounding.
 */
export type ChargeRateBoundResult =
  | { ok: true }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "rate-limited"; message: string }
  | { ok: false; kind: "error"; message: string };

/**
 * One confirmed job, as the user left it on screen.
 *
 * `company` and `title` may both be empty, and that is the point the legacy
 * lane and this surface agree on: the URL is the valuable part, so a posting
 * nobody could read is still a row. What is NOT allowed is inventing them —
 * an empty field renders `Not listed` and the next engine scan fills it in.
 */
export type AddJobInput = {
  url: string;
  key: string;
  company: string;
  title: string;
  idempotencyKey: string;
};

export type AddJobResult =
  | { ok: true; outcome: "added" | "duplicate"; job: JobView }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

// ---- the referral finder (0013) --------------------------------------------

/**
 * Pasting a LinkedIn company id onto a company in the user's universe.
 *
 * `linkedinId` is digits or "" (which clears it) — refused by
 * `app_set_linkedin_company_id` otherwise, and by `lib/referral/linkedin.ts`
 * before it ever reaches a URL. Three layers agreeing on one closed set, because
 * the COLUMN is deliberately free-vocab (0008's `source` precedent).
 *
 * `expectedUpdatedAt` is the SHARED company row's token, not the subscription's
 * — `CompanyView.companyUpdatedAt`. They guard different writes and sending the
 * wrong one conflicts on a row nobody touched.
 */
export type LinkedinCompanyIdInput = {
  companyId: number;
  linkedinId: string;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * One row of a Connections.csv import, after mapping.
 *
 * `connectedOn` is ISO or null — `lib/import/read.ts` is what turns LinkedIn's
 * "21 Mar 2023" into a date and REFUSES an ambiguous "03/04/2026", so a null
 * here means the file did not say something provable rather than that nobody
 * looked.
 */
export type ConnectionImportRow = {
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  profileUrl: string;
  connectedOn: string | null;
};

/**
 * How many connections one call may carry. Mirrors `MAX_CHUNK` in
 * `app_import_connections`, and `parity.test.ts` pins the two together — a chunk
 * larger than the function accepts is refused mid-import, after some rows have
 * already landed.
 */
export const MAX_CONNECTION_CHUNK = 1000;

/**
 * How many connections a render reads. `companies()`'s cap, for its reason.
 *
 * It is also the same number as `MAX_ROWS` in `lib/import/read.ts`, and the two
 * meeting is not a coincidence to leave unsaid: a file at the upload ceiling
 * produces a list at the read ceiling. Past it, rows are STORED and not read —
 * ordered by name, so the truncation falls on one end of the alphabet and every
 * warm popover under-counts for those people.
 *
 * That is stated on `/connections` when a user is actually at the ceiling, and
 * the upload route's refusal says splitting the file does not help. A cap this
 * app enforces and does not mention is the one lie this feature could still
 * tell.
 */
export const CONNECTION_LIST_LIMIT = 5000;

export type ImportConnectionsInput = {
  rows: ConnectionImportRow[];
  /** Provenance tag; closed set at the SQL door. */
  source: string;
  idempotencyKey: string;
};

/**
 * What a chunk did, in four numbers that ADD UP to the rows sent.
 *
 * `skipped` is lines with no name; `deduped` is the same person twice (in this
 * chunk, or already held under a profile URL). A report that does not close is
 * one nobody can re-derive afterwards, because only the commit knows which
 * bucket a line went to (matrix row 169).
 */
export type ImportConnectionsResult =
  | { ok: true; inserted: number; updated: number; skipped: number; deduped: number }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type ClearConnectionsInput = { idempotencyKey: string };

export type ClearConnectionsResult =
  | { ok: true; deleted: number }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

// ---- the warm-intro finder (0020) ------------------------------------------

/** What a warm search was pointed at. */
export type WarmTargetKind = "posting" | "company";

/** The user's warm background this search filtered on (the query overlays). */
export type WarmOverlays = { schools: string[]; pastCompanies: string[] };

/**
 * One persisted vendor run: the opaque run id AND its persona. The persona is what
 * lets the stateless poll route re-attribute each candidate correctly (the M1 fix).
 */
export type WarmVendorRun = { runId: string; persona: WarmPersona };

/**
 * One on-demand warm-intro search, as the app reads it.
 *
 * `results` is empty until `status` is `done`; `error` carries the vendor's reason
 * only when `status` is `failed`. The poll route reads this shape and renders the
 * matching UI state (running spinner / results panel / empty / failed / cancelled).
 */
export type WarmSearchView = {
  id: string;
  targetKind: WarmTargetKind;
  postingKey: string;
  company: string;
  /** The three persona strings actually used — shown as "Searched for: a · b · c". */
  params: WarmParams;
  /** The user's warm background this search filtered on — rebuilt into the poll query. */
  overlays: WarmOverlays;
  status: WarmStatus;
  results: WarmCandidate[];
  error: string;
  /**
   * The persisted per-run persona mapping, read by the poll route to rebuild each
   * persona's query and advance the run. Server-side only — the routes strip it
   * before answering the browser, so nothing about the vendor leaks past this app
   * (the WarmVendor-abstraction rule).
   */
  runs: WarmVendorRun[];
  createdAt: string | null;
  updatedAt: string | null;
};

/** The person pinned as the warm intro for one row. */
export type WarmPinView = {
  id: number;
  targetKind: WarmTargetKind;
  postingKey: string;
  company: string;
  /** Normalized company identity — how the grid matches a pin to a row. */
  companyKey: string;
  fullName: string;
  /** "" when the pin is a bare name (the add box accepts a name OR a URL). */
  profileUrl: string;
  headline: string;
  source: string;
  updatedAt: string | null;
};

export type StartWarmSearchInput = {
  targetKind: WarmTargetKind;
  postingKey: string;
  company: string;
  params: WarmParams;
  /** The user's warm background (schools / past employers) to filter on. */
  overlays: WarmOverlays;
  idempotencyKey: string;
};

/**
 * `over-cap` is its own arm rather than a generic error, because it is the one
 * refusal the UI must render as a plain "you have used your searches for today"
 * message with the reset horizon — never a silent drop, never a toast that reads
 * like a bug (the cap is a knob the user is meant to see).
 */
export type StartWarmSearchResult =
  | { ok: true; search: WarmSearchView }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "over-cap"; message: string }
  /**
   * `rate-limited` is the per-user rate / in-flight refusal (#261), and it is a
   * separate arm from `over-cap` rather than a reuse of it. Both become a 429,
   * and the surface renders whichever sentence arrives — but `over-cap` says
   * "the count resets 24 hours after each search", which is false about a burst
   * bound and about an in-flight bound, and the two are not even the same class
   * of limit (a commercial quota vs a security/provider/reliability one, which
   * is the distinction founding users' exemption turns on).
   */
  | { ok: false; kind: "rate-limited"; message: string }
  | { ok: false; kind: "error"; message: string };

export type AttachWarmRunInput = { id: string; runs: WarmVendorRun[] };
export type CompleteWarmSearchInput = { id: string; results: WarmCandidate[] };
export type FailWarmSearchInput = { id: string; error: string };

/** `missing` is a search that is not this user's (or never existed) — a 404, not a 500. */
export type WarmSearchByIdResult =
  | { ok: true; search: WarmSearchView }
  | { ok: false; kind: "missing" }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type PinWarmIntroInput = {
  targetKind: WarmTargetKind;
  postingKey: string;
  company: string;
  fullName: string;
  /** A linkedin.com URL, or "" for a bare-name pin. Refused if non-linkedin. */
  profileUrl: string;
  headline: string;
  source: "warm" | "manual";
  idempotencyKey: string;
};

export type PinWarmIntroResult =
  | { ok: true; pin: WarmPinView }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type UnpinWarmIntroInput = { id: number; idempotencyKey: string };

export type UnpinWarmIntroResult =
  | { ok: true; deleted: number }
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
 * rule holds for a replayed retry, a hand-made request, and any other caller.
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
// upload route chunks, the commit loop chunks, and a person presses Retry.

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

// ---- display preferences (0025) --------------------------------------------

/**
 * One user's display preferences, with the version token that guards a write.
 *
 * A SEPARATE token from `ProfileView.updatedAt`, and that separation is the
 * point rather than an accident: Preferences autosave and the Search Profile
 * saves explicitly (06 §A), so one shared token would mean ticking "Larger
 * text" makes a half-finished profile edit un-saveable. 0025's trigger clause
 * is the server half of the same guarantee.
 *
 * `updatedAt` is null when no row exists yet — somebody who signed in and has
 * never saved anything. That reads as "the defaults", not as an error: the
 * first write materialises the row.
 */
export type DisplayPrefsView = DisplayPrefs & {
  updatedAt: string | null;
};

/**
 * Turning one knob.
 *
 * EVERY VALUE IS OPTIONAL AND OMITTING ONE LEAVES IT ALONE — `undefined` maps
 * to the SQL null that means "leave it". A call that had to restate all four
 * would replay whatever this tab last READ into the other three, so flipping
 * density on the phone would quietly revert the type scale the laptop set
 * thirty seconds earlier. The popover flips one switch at a time; this shape is
 * what makes that safe.
 *
 * No `theme` — light mode only (DEC-014). `app_set_display_prefs` still takes
 * `p_theme` (a function parameter is not append-only-safe to drop without its
 * own migration), and the sources pass the null that means "leave it".
 *
 * `expectedUpdatedAt: null` skips the version check the way 0012's does, for
 * the caller that legitimately has no token yet (a first write against a row
 * that does not exist).
 */
export type SetDisplayPrefsInput = {
  density?: Density;
  typeScale?: TypeScale;
  keyboardHints?: boolean;
  landingView?: string;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * `changed` is what the STORE did, not what the caller asked for.
 *
 * A no-op autosave answers `changed: false` and leaves the token where it was —
 * which is how the caller can tell "saved" from "nothing to save" without
 * comparing timestamps, and what the quiet saved tick (06 §A) should be driven
 * by. Replaying an idempotency key returns the first call's answer verbatim,
 * `changed` included.
 */
export type SetDisplayPrefsResult =
  | { ok: true; prefs: DisplayPrefsView; changed: boolean }
  /** Another device moved these first. `current` is what it set. */
  | { ok: false; kind: "conflict"; current: DisplayPrefsView }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

// ---- the answer library (0014) ---------------------------------------------

/**
 * How many library rows and policy rules one render reads.
 *
 * PostgREST caps a select at its own configured maximum whatever this app asks
 * for, so the number has to exist on this side or the truncation is invisible —
 * matrix row 241, where a cap the app enforced and never mentioned made every
 * warm popover under-count in silence. Past this ceiling rows are STORED and not
 * READ: the library page says so when a user is actually at it, and the prepare
 * engine would answer from a partial library, which is why the same limit is
 * used for both reads rather than one being quietly larger.
 *
 * 500 is generous against the real shape (16 topics × the companies somebody
 * overrides; one answer per novel question) and finite.
 */
export const APPLY_LIBRARY_LIMIT = 500;

/**
 * Saving one library answer.
 *
 * There is no `authoredBy`, here or anywhere: 0014 stamps it from `auth.uid()`
 * in a trigger, and `webapp/lib/apply/index.ts` states in bold that a parameter
 * for it must never exist. `provenance` is the caller's claim — `user-entered`
 * for something typed, `confirmed` for a suggestion accepted unchanged.
 */
export type UpsertAnswerInput = {
  question: string;
  answer: string;
  /** `answers.kind` — identity/location/address/auth/comp/skills/eeo/freeform. */
  kind: string;
  /**
   * WHERE it applies. A NAME, keyed by the store (`company_name_key`), so an
   * answer saved from the review screen and one saved from a script land on the
   * same row. `""` is the answer every board gets.
   *
   * 0017's column, and the reason it exists: a library row is per-question human
   * memory, which says nothing about whether the fact is the same at every
   * employer. Saving "have you worked here before?" globally, from one board,
   * silently overruled the exception somebody had deliberately set.
   */
  company: string;
  /**
   * The person picked the board's own "I don't wish to answer".
   *
   * Accepted from the caller, unlike `authoredBy`, and safe to accept for the
   * reason that one is not: 0017 stamps authorship from `auth.uid()` in a
   * trigger and then refuses `declined` on any row a machine authored. So this
   * flag can only ever describe a choice a signed-in person made.
   */
  declined: boolean;
  provenance: Provenance;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type AnswerWriteResult =
  | { ok: true; answer: AnswerView; created: boolean }
  /** `current` is the row as the SERVER has it — null only if it vanished. */
  | { ok: false; kind: "conflict"; current: AnswerView | null }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * Saving one policy rule.
 *
 * `company` is a NAME and the store keys it: `app_set_policy_rule` runs it
 * through `company_name_key`, and `answer_policies_company_is_a_key` is what
 * makes that true for every writer rather than customary for this one. `""` is
 * the global rule.
 *
 * `fact` is the user's SITUATION, typed — never the word to submit. That is the
 * change the adversarial review forced and the reason one rule can answer both
 * "do you require sponsorship?" and "can you work without sponsorship?".
 */
export type SetPolicyRuleInput = {
  topic: string;
  company: string;
  fact: SituationFact;
  provenance: Provenance;
  note: string;
  enabled: boolean;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type PolicyWriteResult =
  | { ok: true; rule: PolicyRuleView; created: boolean }
  | { ok: false; kind: "conflict"; current: PolicyRuleView | null }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type DeleteAnswerInput = {
  question: string;
  /** The scope to remove. `""` removes the global answer, never a company one. */
  company: string;
  idempotencyKey: string;
};

/**
 * Removing one library answer.
 *
 * 0014 had no delete for `answers` at all and the settings page said so on
 * screen. That stopped being acceptable when a decline became storable: the only
 * exit from a recorded "I don't wish to answer" was to overwrite it with an
 * answer somebody had chosen not to give.
 */
export type DeleteAnswerResult =
  | { ok: true; deleted: boolean }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export type DeletePolicyRuleInput = {
  topic: string;
  company: string;
  idempotencyKey: string;
};

/**
 * `deleted` is what the STORE did, replayed verbatim on a retry.
 *
 * Deleting a rule that is already gone answers `false`; a replay of a real
 * delete answers `true` forever after, because somebody who taps twice on a
 * flaky connection must not be told the second tap did nothing when the first
 * one did.
 */
export type DeletePolicyResult =
  | { ok: true; deleted: boolean }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

// ---- autopilot staging (#206: Prepare/Review with a manual handoff) --------

/**
 * The twelve states of `hq_autopilot_states()`. The UI half renders a stage
 * BY these words; the commands below are the only writers.
 */
export type AutopilotStageState =
  | "preparing"
  | "needs_input"
  | "ready_for_review"
  | "changes_requested"
  | "approved"
  | "submitting"
  | "submitted"
  | "outcome_unknown"
  | "failed_retryable"
  | "failed_terminal"
  | "cancelled"
  | "handed_off";

/** One staged attachment: the user's own artifact at an exact checksum. */
export type AutopilotAttachment = {
  artifactId: number;
  sha256: string;
  filename: string;
  kind: string;
};

/**
 * One stage row, as `app_autopilot_stage_row` returns it and as the review
 * surface reads it. `packageHash` is the GENERATED `payload_hash` — the value
 * an approval must echo back, which is what makes "you approve exactly what
 * you read" enforceable rather than customary.
 */
export type AutopilotStageView = {
  id: number;
  applicationId: number;
  provider: string;
  providerVersion: string;
  formIdentity: string;
  formSchemaHash: string;
  payload: Record<string, string>;
  attachments: AutopilotAttachment[];
  answers: Record<string, StoredAnswer>;
  gaps: StoredGap[];
  state: AutopilotStageState;
  packageHash: string;
  approvedHash: string | null;
  approvedAt: string | null;
  retryOfStageId: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Persist one prepared package. Maps 1:1 onto
 * `app_stage_autopilot_application`; `state` accepts only the three
 * preparation states — approving is a different gesture with a different
 * command, and execution is not a browser gesture at all.
 */
export type StageAutopilotInput = {
  applicationId: number;
  provider: string;
  providerVersion: string;
  formIdentity: string;
  formSchemaHash: string;
  payload: Record<string, string>;
  attachments: AutopilotAttachment[];
  answers: Record<string, StoredAnswer>;
  gaps: StoredGap[];
  state: "preparing" | "needs_input" | "ready_for_review";
  reason: string;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type AutopilotStageWriteResult =
  | { ok: true; stage: AutopilotStageView; created: boolean }
  /** `current` is the stage as the SERVER has it — null when none is live. */
  | { ok: false; kind: "conflict"; current: AutopilotStageView | null }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * The human's decision. `packageHash` is REQUIRED for `approve` and must be
 * the hash the surface DISPLAYED — a package that changed since render is
 * refused with the conflict answer. `request_changes` and `cancel` take no
 * hash by design: refusing a package you have not re-read is never wrong.
 */
export type ReviewAutopilotStageInput = {
  stageId: number;
  decision: "approve" | "request_changes" | "cancel";
  packageHash: string | null;
  reason: string;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type AutopilotReviewResult =
  | { ok: true; stage: AutopilotStageView; changed: boolean }
  | { ok: false; kind: "conflict"; current: AutopilotStageView | null }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

/**
 * The user's report on a handed-off package. `submitted` settles the stage to
 * `handed_off` AND records manual application status 'Applied' through
 * `app_set_status`, in one transaction; `abandoned` cancels. Neither writes a
 * receipt — the user's word is the only evidence this half has, and the copy
 * must say "you marked this applied", never "submitted".
 */
export type SettleAutopilotHandoffInput = {
  stageId: number;
  outcome: "submitted" | "abandoned";
  reason: string;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

export type AutopilotSettleResult =
  | { ok: true; stage: AutopilotStageView; outcome: "submitted" | "abandoned" }
  | { ok: false; kind: "conflict"; current: AutopilotStageView | null }
  | { ok: false; kind: "auth" }
  | { ok: false; kind: "error"; message: string };

export interface DataSource {
  /** Qualified, untriaged, freshest first. */
  queue(opts?: QueueOptions): Promise<JobView[]>;
  /** Everything, for the grid — filtering happens client-side over this. */
  jobs(): Promise<JobView[]>;
  applications(): Promise<ApplicationView[]>;
  /** The OLD discovery-health ledger, in ops terms (channel / cadence / stale). */
  health(): Promise<ChannelHealthView[]>;
  /**
   * Per-job automation activity, in plain words — Coverage's Activity tab (E3).
   * One row per job, newest run mapped to Running / Last succeeded / Failing
   * since; problems ordered first. Reads `bot_runs` (migration 0023).
   */
  getActivity(): Promise<ActivityView[]>;
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

  // ---- quick add (RM-12) --------------------------------------------------

  /** Read pasted links: split, key, parse with provenance, flag duplicates. */
  /**
   * Charge one unit against a per-user bound, for work this process is about to
   * do that no command RPC covers (#261).
   *
   * On the interface rather than inside one method because the expensive
   * user-driven paths are not all commands: quick-add's resolve reads pages,
   * `/api/export` regenerates a whole file. Both are server-side work a signed-in
   * caller can ask for as fast as we answer, and neither has an `app_*` RPC to
   * charge inside.
   *
   * The FIXTURE twin always allows, and that asymmetry is the point rather than a
   * parity gap — `ResolveRateGate`'s shipped reasoning, generalised. A fixture
   * export builds rows from an in-memory table and a fixture resolve is a map
   * lookup; there is no capacity and no vendor to protect, so a gated fake would
   * rate-limit a demo for the cost of nothing.
   */
  chargeRateBound(meter: string): Promise<ChargeRateBoundResult>;
  resolveJobLinks(input: ResolveJobLinksInput): Promise<ResolveJobLinksResult>;
  /** Track one confirmed posting. Idempotent; a duplicate says so. */
  addJob(input: AddJobInput): Promise<AddJobResult>;

  // ---- the referral finder (0013) -----------------------------------------

  /** Paste the `f_C=` number onto a company this user watches. "" clears it. */
  setLinkedinCompanyId(input: LinkedinCompanyIdInput): Promise<CompanyFlagsResult>;
  /** The user's own LinkedIn connections, for the 1st-degree match. */
  connections(): Promise<ConnectionView[]>;
  /** One chunk of a Connections.csv import. Merges; never duplicates. */
  importConnections(input: ImportConnectionsInput): Promise<ImportConnectionsResult>;
  /** Bin every connection, so a bad import is recoverable by re-uploading. */
  clearConnections(input: ClearConnectionsInput): Promise<ClearConnectionsResult>;

  // ---- the warm-intro finder (0020) ---------------------------------------

  /** Reserve one warm search (cap-enforced at insert). Returns the running row. */
  startWarmSearch(input: StartWarmSearchInput): Promise<StartWarmSearchResult>;
  /** Attach the vendor run handle to a just-started search. */
  attachWarmRun(input: AttachWarmRunInput): Promise<WarmSearchByIdResult>;
  /** Read one search by id, for the poll route. Null when it is not yours. */
  getWarmSearch(id: string): Promise<WarmSearchView | null>;
  /** Land ranked results and mark done — one-way, a cancel in flight wins. */
  completeWarmSearch(input: CompleteWarmSearchInput): Promise<WarmSearchByIdResult>;
  /** Mark a running search failed with the vendor's reason. */
  failWarmSearch(input: FailWarmSearchInput): Promise<WarmSearchByIdResult>;
  /** Cancel a running search. Idempotent; a terminal search is a no-op. */
  cancelWarmSearch(id: string): Promise<WarmSearchByIdResult>;
  /** Every pinned intro, for the grid to render pinned cells. */
  warmPins(): Promise<WarmPinView[]>;
  /** Pin a person (a result, or a hand-typed name/URL) to a row. Replaces. */
  pinWarmIntro(input: PinWarmIntroInput): Promise<PinWarmIntroResult>;
  /** Remove a pin. Idempotent. */
  unpinWarmIntro(input: UnpinWarmIntroInput): Promise<UnpinWarmIntroResult>;

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

  // ---- display preferences (0025) -----------------------------------------

  /**
   * This user's display preferences. Read on the SERVER, before first paint.
   *
   * That is the whole reason this is a data-layer method rather than a client
   * hook: the type scale and density are `<html>` attributes, and applying them
   * after hydration is a large-type user watching the page reflow on every
   * navigation. The cookie this replaces existed for exactly that property; the
   * profile keeps it and adds the one the cookie could never have, which is
   * that the preference follows the person to their other devices.
   *
   * Never throws for a missing row: an account with nothing saved reads as the
   * defaults.
   */
  displayPrefs(): Promise<DisplayPrefsView>;
  /** Autosave one or more knobs. Omitted values are left alone. */
  setDisplayPrefs(input: SetDisplayPrefsInput): Promise<SetDisplayPrefsResult>;

  // ---- the answer library (0014) ------------------------------------------

  /**
   * This user's stored answers. The select MUST include `authored_by` — the
   * engine refuses to reuse an answer on a knockout or demographic field
   * without it, so omitting the column silently turns every sensitive library
   * row into a gap.
   */
  answers(): Promise<AnswerView[]>;
  /** This user's policy rules: typed situations, global and per-company. */
  policyRules(): Promise<PolicyRuleView[]>;
  /** Save one answer, at a scope. The growth loop: a question answered once is reused. */
  upsertAnswer(input: UpsertAnswerInput): Promise<AnswerWriteResult>;
  /** Remove one answer. Idempotent by RESULT, not by effect. */
  deleteAnswer(input: DeleteAnswerInput): Promise<DeleteAnswerResult>;
  /** Save one rule. Turning one off is `enabled: false`, not a delete. */
  setPolicyRule(input: SetPolicyRuleInput): Promise<PolicyWriteResult>;
  /** Remove one rule. Idempotent by RESULT, not by effect. */
  deletePolicyRule(input: DeletePolicyRuleInput): Promise<DeletePolicyResult>;

  // ---- autopilot staging (#206) -------------------------------------------

  /**
   * The application's LIVE attempt — any state the one_live_attempt slot
   * counts, which is everything but the three settled states — or null. The
   * review surface renders THIS stored row, never a live re-prepare: payload
   * fidelity means showing exactly the columns `packageHash` covers.
   */
  autopilotStage(applicationId: number): Promise<AutopilotStageView | null>;
  /** Persist a prepared package. Idempotent, optimistic, cannot approve. */
  stageAutopilot(input: StageAutopilotInput): Promise<AutopilotStageWriteResult>;
  /** Approve / request changes / cancel — approval echoes the displayed hash. */
  reviewAutopilotStage(input: ReviewAutopilotStageInput): Promise<AutopilotReviewResult>;
  /** Record the user's report after the manual handoff. Writes no receipt. */
  settleAutopilotHandoff(input: SettleAutopilotHandoffInput): Promise<AutopilotSettleResult>;

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
