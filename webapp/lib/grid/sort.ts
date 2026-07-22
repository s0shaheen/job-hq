/**
 * Sorting and grouping — pure, applied to the row array BEFORE react-table
 * sees it, exactly like filtering.
 *
 * The plan sketched this as react-table `sortingFn`s. It moved here because of
 * matrix-row-35's trap: react-table implements `desc` by inverting the
 * comparator's result, so a comparator that sends nulls last via "+Infinity"
 * sends them FIRST the moment the direction flips — no-comp rows crowning
 * "comp desc" is the exact bug row 35 names. react-table's `sortUndefined:
 * "last"` option does handle that, but only inside a mounted table, where
 * Vitest (no layout engine, virtualizer renders nothing) cannot watch it fail.
 * A pure sortRows is provable in a unit test, which is the same reason the
 * plan itself kept the filter language out of react-table.
 */
import type { JobView } from "@/lib/data/view-models";

export const SORT_FIELDS = ["company", "title", "comp", "minYoe", "posted"] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type SortDir = "asc" | "desc";
export type SortSpec = { field: SortField; dir: SortDir };

const ACCESSORS: Record<SortField, (j: JobView) => string | number | null> = {
  company: (j) => j.company,
  title: (j) => j.title,
  comp: (j) => j.compMaxK, // band top — the same number the comp filter reads (H7)
  minYoe: (j) => j.minYoe,
  posted: (j) => j.posted, // ISO dates order lexicographically
};

/**
 * Stable sort, unknowns last in BOTH directions. "Sort by comp" is a question
 * about stated bands; rows that stated nothing are an appendix to the answer,
 * not the top of it. Returns a copy — the input may be a memoized array a
 * previous render still holds.
 */
export function sortRows(rows: JobView[], spec: SortSpec | null): JobView[] {
  if (!spec) return rows;
  const acc = ACCESSORS[spec.field];
  const stated: JobView[] = [];
  const unknown: JobView[] = [];
  for (const row of rows) (acc(row) === null ? unknown : stated).push(row);
  const dir = spec.dir === "desc" ? -1 : 1;
  stated.sort((a, b) => {
    const va = acc(a)!;
    const vb = acc(b)!;
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
    return cmp * dir;
  });
  return [...stated, ...unknown]; // unknowns keep their incoming relative order
}

export type GroupBy = "company" | null;

export type DisplayRow =
  | { kind: "group"; label: string; count: number }
  | { kind: "job"; job: JobView; leafIndex: number };

/**
 * The flat list the virtualizer walks: group headers are ROWS in it, so one
 * `estimateSize` covers everything and the scroll math stays exact. Groups
 * appear in first-appearance order of the (already sorted) input — sorting
 * decides which group leads, grouping only pulls members together.
 *
 * `leafIndex` numbers the job rows 0..n-1 in DISPLAY order: it is the index
 * into the reordered leaf array handed to react-table, so a virtual item finds
 * its table row by subscript instead of by search.
 */
export function flattenGroups(rows: JobView[], group: GroupBy): DisplayRow[] {
  if (!group) return rows.map((job, leafIndex) => ({ kind: "job", job, leafIndex }));
  const byLabel = new Map<string, JobView[]>();
  for (const job of rows) {
    const label = job.company;
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(job);
    else byLabel.set(label, [job]);
  }
  const out: DisplayRow[] = [];
  let leafIndex = 0;
  for (const [label, jobs] of byLabel) {
    out.push({ kind: "group", label, count: jobs.length });
    for (const job of jobs) out.push({ kind: "job", job, leafIndex: leafIndex++ });
  }
  return out;
}

/** The leaf order implied by a display list — the array react-table gets. */
export function displayLeaves(display: DisplayRow[]): JobView[] {
  const out: JobView[] = [];
  for (const row of display) if (row.kind === "job") out.push(row.job);
  return out;
}
