/**
 * View models for the import wizard — what the UI renders, deliberately
 * separate from the row types in `lib/types.ts`.
 *
 * They live here rather than in `lib/data/view-models.ts` for one reason: every
 * type in this file is meaningless outside `/import`, and view-models.ts is the
 * file every surface reads. `round-trip.ts` is already here; keeping the phase's
 * vocabulary in one directory is what stops the next session hunting for it.
 *
 * The rule view-models.ts enforces applies here too: **a value the file never
 * stated is absent, never invented.** An unparseable date is `null`, not today;
 * an unmapped column is missing from `columnMap`, not mapped to "".
 */

/** Where a batch is in the wizard (`import_batches.state`, migration 0011). */
export type ImportState =
  | "uploaded"
  | "mapped"
  | "previewed"
  | "committing"
  | "committed"
  | "rolled_back"
  | "failed";

/** What committing a row WOULD do (`import_rows.match_kind`). */
export type ImportMatchKind =
  | "new"
  | "matches-existing"
  | "suggestion"
  | "unkeyable"
  | "round-trip"
  | "duplicate-in-file";

/** What committing a row DID (`import_rows.outcome`). */
export type ImportOutcome = "pending" | "created" | "updated" | "skipped" | "failed";

export type ImportConflictState = "none" | "unresolved" | "resolved";

export type ImportSourceKind = "xlsx" | "csv" | "paste";

/** Per-column verdict (`import_column_reports.disposition`) — G13. */
export type ImportDisposition =
  | "imported"
  | "read-only"
  | "locked"
  | "unmapped"
  | "unknown-column";

/**
 * Everything the mapping step decided, stored server-side on the batch.
 *
 * Server-side is what makes G12's "resumable" true rather than aspirational:
 * close the tab mid-mapping and `/import/<id>` renders the same step back.
 * The browser holds no working set at any point.
 */
export type ImportMapping = {
  /** The header row as read, in file order. */
  headers: string[];
  /** 0-based index of the row treated as the header. */
  headerRowIndex: number;
  /**
   * Target field -> the 0-based COLUMN INDEX feeding it. A missing key is
   * Unmapped.
   *
   * An index and not a header name, because a name is not an address: a sheet
   * with two columns called "Notes" gives a by-name lookup a coin flip, and the
   * loser is silently not imported. `headers` is what the UI shows; this is what
   * the mapping actually means.
   */
  columnMap: Record<string, number>;
  /** The file's status word -> ours. */
  statusMap: Record<string, string>;
  /** True once `hq_id` was found — the file came from an export of this pipeline. */
  roundTrip: boolean;
  /** Headers that went nowhere, and why. Written straight to the column report. */
  unmapped: { name: string; disposition: "unmapped" | "unknown-column" }[];
  /** Which encoding the bytes were decoded as, so the UI can say so. */
  encoding?: string;
  /** Which sheet of a multi-sheet workbook. */
  sheet?: string;
};

export const EMPTY_IMPORT_MAPPING: ImportMapping = {
  headers: [],
  headerRowIndex: 0,
  columnMap: {},
  statusMap: {},
  roundTrip: false,
  unmapped: [],
};

/** One uploaded file, as the wizard renders it. */
export type ImportBatchView = {
  id: string;
  state: ImportState;
  filename: string;
  sourceKind: ImportSourceKind;
  contentHash: string;
  /** Rows the file declared. */
  rowCount: number;
  /** Rows that have reached a terminal outcome — the resume cursor. */
  committedCount: number;
  /** Rows actually staged, which is what the progress bar divides by. */
  stagedCount: number;
  mapping: ImportMapping;
  createdAt: string | null;
  /** Optimistic-concurrency token: sent back with the mapping write. */
  updatedAt: string | null;
  committedAt: string | null;
  /** When the undo window closes. From the ROW — never computed on the client. */
  undoExpiresAt: string | null;
};

/** One source row, as the preview renders it. */
export type ImportRowView = {
  rowNumber: number;
  /** The source cells, verbatim. */
  raw: Record<string, string>;
  /** After column + status mapping, keyed by target field. */
  mapped: Record<string, string>;
  jobKey: string;
  keyStrength: "strong" | "weak" | "none";
  matchKind: ImportMatchKind;
  matchedApplicationId: number | null;
  conflictState: ImportConflictState;
  /** Per changed cell: `{column: {mine, theirs}}`. */
  conflict: Record<string, { mine: string; theirs: string }>;
  choices: Record<string, "mine" | "theirs">;
  included: boolean;
  outcome: ImportOutcome;
  /** Something true and not an error: "an earlier row won". */
  notice: string;
  error: string;
};

export type ImportColumnReportView = {
  column: string;
  disposition: ImportDisposition;
  rows: number;
  sample: string[];
};

/** Row counts per bucket, as `app_import_preview` returns them. */
export type ImportCounts = Partial<Record<ImportMatchKind, number>>;

/**
 * How a match kind is named to a person, and then what will happen — in that
 * order, because the second is the thing they are actually deciding about.
 *
 * `suggestion` is the one worth reading twice. It says the system cannot PROVE
 * the two rows are the same job, which is the honest description of a `norm-`
 * key, and it says what it will do instead. A label reading "duplicate" would
 * invite somebody to expect the merge that deliberately never happens.
 */
const MATCH_KIND_LABELS: Record<ImportMatchKind, string> = {
  new: "New",
  "matches-existing": "Updates one you have",
  suggestion: "Might already exist",
  unkeyable: "New",
  "round-trip": "Edited in Excel",
  "duplicate-in-file": "Repeat in this file",
};

export function matchKindLabel(kind: ImportMatchKind): string {
  return MATCH_KIND_LABELS[kind] ?? kind;
}

const MATCH_KIND_EXPLAIN: Record<ImportMatchKind, string> = {
  new: "Nothing here matches it, so it will be added.",
  "matches-existing":
    "It names an application you already have. Status, notes, next action and dates from the file will be applied to it; everything else in the file is set by the system from the job posting and will only be reported.",
  suggestion:
    "It looks like an application you already have, but the file gives no way to prove it — so it is never merged into a row that might be a different job. It is added separately and flagged, or skipped if you already have that exact company and title.",
  unkeyable: "Nothing here matches it, so it will be added.",
  "round-trip":
    "This row came from an export of your own pipeline, so the edits you made in Excel will be applied back to it.",
  "duplicate-in-file":
    "An earlier row in this same file is the same job. The first one wins and this one is skipped.",
};

export function explainMatchKind(kind: ImportMatchKind): string {
  return MATCH_KIND_EXPLAIN[kind] ?? "";
}

/**
 * The per-column report, as a sentence.
 *
 * G13 exists because the alternative is a silent drop, and a silent drop is what
 * makes somebody stop trusting an import altogether. Each branch says what
 * happened AND why — "not imported" with no reason reads as a bug.
 */
export function explainDisposition(r: ImportColumnReportView): string {
  const rows = r.rows === 1 ? "1 row" : `${r.rows} rows`;
  switch (r.disposition) {
    case "imported":
      return `${rows} imported.`;
    case "read-only":
      return `${rows} differed; not imported — this column is set by the system from the job posting.`;
    case "locked":
      return `${rows} left alone — you had chosen those statuses yourself, and nothing but you may overwrite that.`;
    case "unmapped":
      return "Not mapped to anything, so nothing from this column was imported.";
    case "unknown-column":
      return "Not a column this app knows, so nothing from it was imported.";
    default:
      return "";
  }
}

/**
 * Is this batch still undoable, per the SERVER's window?
 *
 * Hiding the button when this is false is a courtesy, not the rule:
 * `app_import_undo` reads `undo_expires_at` off the row and refuses on its own,
 * so a stale tab, a wrong client clock and a hand-made request all get the same
 * answer. A UI-only window is exactly the shape matrix row 32 names.
 */
export function isUndoable(batch: ImportBatchView, now: Date = new Date()): boolean {
  if (batch.state !== "committed" && batch.state !== "committing") return false;
  if (!batch.undoExpiresAt) return false;
  return new Date(batch.undoExpiresAt).getTime() > now.getTime();
}

/** Progress as the bar renders it: settled rows over staged rows. */
export function importProgress(batch: ImportBatchView): number {
  const total = batch.stagedCount || batch.rowCount;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, batch.committedCount / total));
}

/**
 * Which wizard step a batch is on — derived from its state, never stored.
 *
 * Stored separately it would be a second source of truth that drifts the first
 * time somebody reloads mid-commit, which is precisely the moment the answer
 * matters. `/import/<id>` renders whatever this returns.
 */
export type ImportStep = "map" | "preview" | "commit" | "report";

export function importStep(batch: ImportBatchView): ImportStep {
  switch (batch.state) {
    case "uploaded":
    case "mapped":
      return "map";
    case "previewed":
      return "preview";
    case "committing":
      return "commit";
    default:
      return "report";
  }
}
