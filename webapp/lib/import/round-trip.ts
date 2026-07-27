import { APPLICATION_COLUMNS, type Column } from "@/lib/export/columns";
import type { ApplicationView } from "@/lib/data/view-models";

/**
 * The Excel round trip: export a file, edit it in Excel, import it back.
 *
 * Spec §E. Two machine-owned columns ride along with the ordinary application
 * export and give an imported row an identity — `hq_id` says WHICH row, and
 * `hq_version` says WHICH VERSION of it the person was looking at when they
 * typed. That second one is the whole safety property: a file whose token no
 * longer matches the row is an edit made against a value somebody else has
 * since changed, and it opens the resolver instead of overwriting.
 *
 * `hq_version` is the row's `updated_at` — deliberately the SAME token
 * `setStatus`, `setTriage` and every other write on this system already carry.
 * One concurrency concept, not two: a second mechanism here would need its own
 * staleness rules, its own tests, and its own bugs.
 *
 * ONE CELL DOES NOT SURVIVE A **CSV** ROUND TRIP, and it is stated rather than
 * discovered: `toCsv` neutralises a value beginning `= + - @ TAB CR` with Excel's
 * own apostrophe marker, because board-supplied text is where the formula
 * injection comes from. Re-importing that CSV directly (without opening it in
 * Excel, which reads the marker and drops it) keeps the apostrophe. The xlsx
 * export has no such cost — a workbook cell is typed rather than sniffed — so
 * xlsx is the round-trip format to prefer. Pinned in
 * `tests/unit/export-round-trip.test.ts`; deliberately NOT "fixed" by stripping a
 * leading apostrophe on import, which would eat the first character of a value
 * somebody could plausibly type.
 *
 * TRAILING, NOT HIDDEN, and that is a correction to the plan rather than a
 * shortcut. `write-excel-file` 4.1.1's `SheetOptionsColumn` type carries only
 * `width`; there is no `hidden`, and `{ width: 0 }` is silently dropped (the
 * emitted `<cols>` contains no entry at all). So the honest arrangement is two
 * clearly-named columns at the end of the sheet. If a user deletes them the
 * round trip degrades to `job_key` matching rather than failing, and the
 * preview says which mode it is in.
 */

/** The `hq_id` column header, matched EXACT-ONLY on import. */
export const HQ_ID_HEADER = "hq_id";
/** The `hq_version` column header, matched EXACT-ONLY on import. */
export const HQ_VERSION_HEADER = "hq_version";

/**
 * The five columns an import may write on an EXISTING application.
 *
 * DATABASE column names, and it must stay byte-identical to
 * `public.hq_import_writable_columns()` in migration 0011 —
 * `tests/db/test_import.py` parses this array and compares. A comment saying
 * "keep in step" is not a mechanism, and the failure it would hide is a
 * resolver offering a choice about a column the database refuses to write.
 *
 * Everything else in an imported file is engine-owned: compared, counted and
 * reported (G13), never written. Tags, geo, disposition, company, title and URL
 * are computed from the posting the sweep found, and an import that overwrote
 * them would replace measured facts with a stale copy of them.
 */
export const WRITABLE_COLUMNS = [
  "status",
  "notes",
  "next_action",
  "next_action_date",
  "applied_date",
] as const;

export type WritableColumn = (typeof WRITABLE_COLUMNS)[number];

/**
 * Database column name -> the mapped-payload key that feeds it.
 *
 * The mirror of `public.hq_import_mapped_value(jsonb, text)`'s CASE in migration
 * 0011, and it exists for the same reason that function does: the mapping UI
 * binds to target-field names (`nextActionDate`) while the database and the
 * conflict jsonb speak column names (`next_action_date`). One translation site
 * per language. A second is where `next_action_date` becomes `nextactiondate`
 * and reads as an absent cell — a value silently not imported.
 */
export const MAPPED_KEY: Record<WritableColumn, string> = {
  status: "status",
  notes: "notes",
  next_action: "nextAction",
  next_action_date: "nextActionDate",
  applied_date: "appliedDate",
};

/** How a writable column is named to a person, in the resolver and the report. */
const WRITABLE_LABELS: Record<WritableColumn, string> = {
  status: "Status",
  notes: "Notes",
  next_action: "Next action",
  next_action_date: "Next action date",
  applied_date: "Applied",
};

export function writableColumnLabel(column: string): string {
  return WRITABLE_LABELS[column as WritableColumn] ?? column;
}

export function isWritableColumn(column: string): column is WritableColumn {
  return (WRITABLE_COLUMNS as readonly string[]).includes(column);
}

/**
 * The export columns plus the two machine-owned ones, in that order.
 *
 * Built from `APPLICATION_COLUMNS` rather than re-listing it: a column added to
 * the ordinary export must appear in the round-trip file too, or the file a
 * person edits is missing something they can see everywhere else.
 */
export const ROUND_TRIP_COLUMNS: Column<ApplicationView>[] = [
  ...APPLICATION_COLUMNS,
  {
    key: "hqId",
    header: HQ_ID_HEADER,
    value: (a) => a.id,
    // Text, not number. Excel will happily render a large id in scientific
    // notation once it decides a column is numeric, and `1.23457E+11` matches
    // no row at all — a silent, total failure of the round trip that looks like
    // a formatting preference.
    type: "text",
  },
  {
    key: "hqVersion",
    header: HQ_VERSION_HEADER,
    // The token verbatim. NOT `type: "date"`: as a date cell Excel would round
    // it to the day and every single row would come back reading as stale.
    value: (a) => a.updatedAt,
    type: "text",
  },
];

/** One cell a round-trip file disagrees with the database about. */
export type ConflictCell = {
  column: string;
  /** What the database holds now. */
  mine: string;
  /** What the file says. */
  theirs: string;
};

/** The answer to one conflicted cell. `mine` discards the file's value. */
export type ConflictChoice = "mine" | "theirs";

/**
 * The conflict jsonb from `import_rows.conflict`, as cells in a stable order.
 *
 * Ordered by `WRITABLE_COLUMNS` rather than by whatever order the jsonb object
 * happens to iterate in, so the resolver does not reshuffle itself between
 * renders while somebody is reading it.
 */
export function conflictCells(conflict: unknown): ConflictCell[] {
  if (!conflict || typeof conflict !== "object") return [];
  const obj = conflict as Record<string, { mine?: unknown; theirs?: unknown }>;
  const cells: ConflictCell[] = [];
  for (const column of WRITABLE_COLUMNS) {
    const cell = obj[column];
    if (!cell || typeof cell !== "object") continue;
    cells.push({
      column,
      mine: cell.mine === null || cell.mine === undefined ? "" : String(cell.mine),
      theirs: cell.theirs === null || cell.theirs === undefined ? "" : String(cell.theirs),
    });
  }
  return cells;
}

/**
 * Is every cell of this row answered?
 *
 * The wizard uses it to enable Commit; the DATABASE is what actually enforces
 * it (`app_import_commit_chunk` raises while any row is unresolved), because a
 * UI-only guard is one bad deploy away from writing anyway. This function
 * exists to stop somebody clicking a button that will fail, not to be the rule.
 */
export function isFullyResolved(
  conflict: unknown,
  choices: Record<string, ConflictChoice | undefined>,
): boolean {
  const cells = conflictCells(conflict);
  if (cells.length === 0) return true;
  return cells.every((c) => choices[c.column] === "mine" || choices[c.column] === "theirs");
}
