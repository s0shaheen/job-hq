import type { ApplicationView, JobView } from "@/lib/data/view-models";

/**
 * Export column definitions.
 *
 * Exports are flat: one header row, ISO dates, unformatted numbers, no merged
 * cells. These users open the file in Excel and keep working — a "report" with
 * styling and merged headers is unusable as data, which is the most common way
 * an export disappoints the person who asked for it.
 */
export type Column<T> = {
  key: string;
  header: string;
  value: (row: T) => string | number | null;
  /** Numeric columns are written as numbers so Excel can sum and sort them. */
  numeric?: boolean;
};

export const JOB_COLUMNS: Column<JobView>[] = [
  { key: "company", header: "Company", value: (j) => j.company },
  { key: "title", header: "Title", value: (j) => j.title },
  { key: "location", header: "Location", value: (j) => j.location },
  { key: "metro", header: "Metro", value: (j) => j.metro },
  { key: "workModel", header: "Work model", value: (j) => j.workModel },
  { key: "comp", header: "Compensation", value: (j) => j.compRange },
  { key: "compMin", header: "Comp min ($k)", value: (j) => j.compMinK, numeric: true },
  { key: "compMax", header: "Comp max ($k)", value: (j) => j.compMaxK, numeric: true },
  { key: "minYoe", header: "Min years", value: (j) => j.minYoe, numeric: true },
  { key: "seniority", header: "Seniority", value: (j) => j.seniority },
  { key: "industry", header: "Industry", value: (j) => j.industry },
  {
    key: "skills",
    header: "Skills",
    value: (j) => (j.skills.length ? j.skills.join("; ") : null),
  },
  { key: "posted", header: "Posted", value: (j) => j.posted },
  { key: "firstSeen", header: "First seen", value: (j) => j.firstSeen },
  { key: "decision", header: "Decision", value: (j) => j.triage || "undecided" },
  { key: "url", header: "URL", value: (j) => j.url },
];

export const APPLICATION_COLUMNS: Column<ApplicationView>[] = [
  { key: "company", header: "Company", value: (a) => a.company },
  { key: "title", header: "Title", value: (a) => a.title },
  { key: "status", header: "Status", value: (a) => a.status },
  { key: "appliedDate", header: "Applied", value: (a) => a.appliedDate },
  { key: "nextAction", header: "Next action", value: (a) => a.nextAction },
  { key: "nextActionDate", header: "Next action date", value: (a) => a.nextActionDate },
  { key: "notes", header: "Notes", value: (a) => a.notes },
  { key: "url", header: "URL", value: (a) => a.url },
];
