import { exportNote } from "@/lib/data/view-models";
import type { ApplicationView, JobView } from "@/lib/data/view-models";

/**
 * Export column definitions.
 *
 * Exports are flat: one header row, ISO dates, unformatted numbers, no merged
 * cells. These users open the file in Excel and keep working — a "report" with
 * styling and merged headers is unusable as data, which is the most common way
 * an export disappoints the person who asked for it.
 */
/**
 * How a column is written to a typed format (XLSX). CSV is text either way, but
 * Excel treats a "number" stored as text as text: it sorts 100 before 20 and a
 * date filter cannot see it at all. `type` is what keeps a spreadsheet usable
 * as a spreadsheet once it lands on someone else's machine.
 */
export type ColumnType = "text" | "number" | "date";

export type Column<T> = {
  key: string;
  header: string;
  value: (row: T) => string | number | null;
  /** Defaults to "text". Dates must be ISO `YYYY-MM-DD`. */
  type?: ColumnType;
};

export const JOB_COLUMNS: Column<JobView>[] = [
  { key: "company", header: "Company", value: (j) => j.company },
  { key: "title", header: "Title", value: (j) => j.title },
  { key: "location", header: "Location", value: (j) => j.location },
  { key: "metro", header: "Metro", value: (j) => j.metro },
  { key: "workModel", header: "Work model", value: (j) => j.workModel },
  { key: "comp", header: "Compensation", value: (j) => j.compRange },
  { key: "compMin", header: "Comp min ($k)", value: (j) => j.compMinK, type: "number" },
  { key: "compMax", header: "Comp max ($k)", value: (j) => j.compMaxK, type: "number" },
  { key: "minYoe", header: "Min years", value: (j) => j.minYoe, type: "number" },
  { key: "seniority", header: "Seniority", value: (j) => j.seniority },
  { key: "industry", header: "Industry", value: (j) => j.industry },
  {
    key: "skills",
    header: "Skills",
    value: (j) => (j.skills.length ? j.skills.join("; ") : null),
  },
  { key: "posted", header: "Posted", value: (j) => j.posted, type: "date" },
  { key: "firstSeen", header: "First seen", value: (j) => j.firstSeen, type: "date" },
  { key: "decision", header: "Decision", value: (j) => j.triage || "undecided" },
  { key: "url", header: "URL", value: (j) => j.url },
];

export const APPLICATION_COLUMNS: Column<ApplicationView>[] = [
  { key: "company", header: "Company", value: (a) => a.company },
  { key: "title", header: "Title", value: (a) => a.title },
  { key: "status", header: "Status", value: (a) => a.status },
  { key: "appliedDate", header: "Applied", value: (a) => a.appliedDate, type: "date" },
  { key: "nextAction", header: "Next action", value: (a) => a.nextAction },
  {
    key: "nextActionDate",
    header: "Next action date",
    value: (a) => a.nextActionDate,
    type: "date",
  },
  // The NEWEST note, falling back to the flat `applications.notes` column.
  //
  // Migration 0010 made notes an append-only entity and copied the column into
  // it WITHOUT clearing the column, because spec §E round-trips `notes` and this
  // is the reader that would have gone blank (matrix row 44). `exportNote` is
  // that fallback, and it is correct in all three states a row can be in: a
  // pre-migration row (column only), a backfilled one (both), and one written
  // since (notes only, column empty).
  { key: "notes", header: "Notes", value: (a) => exportNote(a) },
  { key: "url", header: "URL", value: (a) => a.url },
];
