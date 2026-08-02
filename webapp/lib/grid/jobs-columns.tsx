/**
 * The redesigned Jobs column model: seven data columns and one selection track.
 *
 * The 40px checkbox track is selection chrome, not a data column.
 *
 * **Two different things are called "warm", and only one of them retired.**
 * `jobs-handoff.md` §column-map retires the old `Warm` column — layer 0, the
 * connections the user uploaded — by folding it onto the Company cell as an
 * indicator, and that is what `WarmCell indicator` is. `Warm intro` is layer 2,
 * the on-demand finder that arrived with migration 0020, and the owner's
 * authored `JobsTable.dc.html` gives it a track of its own: the template's grid
 * is EIGHT wide, and its own description names "warm-intro column and on-demand
 * Find intro flow". Reading the handoff's retirement as covering both is how the
 * surface loses a capability the design draws.
 *
 * Widths come from that template, verbatim:
 *   40 · 175 · minmax(215, 1fr) · 100 · 145 · 75 · 110 · 150
 *
 * **The columns declare identity, width, header and sort field; the SURFACE
 * renders every cell.** That is the opposite of the shipped `columns.tsx`, and
 * deliberately: five of these seven cells need something a `ColumnDef` cannot
 * reach without dragging it into a Vitest unit test — a server action (the
 * warm-path indicator), a write callback (Decision), the pinned `now` (Posted),
 * the warm index (Company), the selection model (the checkbox). The shipped file
 * already carved out two cells for exactly that reason and documented the
 * import cycle it was avoiding; carving out five and stating the rule once is
 * cleaner than carving out two and pretending the other six are different.
 * `meta.surfaceRendered` marks them so nothing looks accidentally empty.
 */
import type { ColumnDef } from "@tanstack/react-table";
import type { JobView } from "@/lib/data/view-models";
import "./table-meta";

/** The seven data column ids, in view order. The budget, as a value. */
export const JOBS_DATA_COLUMNS = [
  "company",
  "title",
  "pay",
  "locationModel",
  "posted",
  "decision",
  "warmIntro",
] as const;

export type JobsDataColumnId = (typeof JOBS_DATA_COLUMNS)[number];

/** The one track that is not a data column (see the header note). */
export const SELECT_COLUMN_ID = "select";

export const JOBS_COLUMNS: ColumnDef<JobView>[] = [
  {
    id: SELECT_COLUMN_ID,
    // No header text. A column header over a checkbox track is chrome with
    // nothing to say, and 01 §12.28 rejects invented chrome labels. The
    // select-all control lives in the cell position and carries its own
    // aria-label.
    header: "",
    size: 40,
    meta: { surfaceRendered: true },
  },
  {
    id: "company",
    header: "Company",
    size: 175,
    meta: { sticky: true, sortField: "company", locked: true, surfaceRendered: true },
  },
  {
    id: "title",
    header: "Title",
    size: 215,
    meta: { grow: true, sortField: "title", surfaceRendered: true },
  },
  {
    id: "pay",
    header: "Pay",
    size: 100,
    meta: { align: "right", sortField: "comp", surfaceRendered: true },
  },
  {
    id: "locationModel",
    header: "Location & model",
    size: 145,
    meta: { surfaceRendered: true },
  },
  {
    id: "posted",
    header: "Posted",
    size: 75,
    meta: { align: "right", sortField: "posted", surfaceRendered: true },
  },
  {
    id: "decision",
    header: "Decision",
    size: 110,
    meta: { surfaceRendered: true },
  },
  {
    id: "warmIntro",
    header: "Warm intro",
    size: 150,
    // Not sortable. The cell's content is a per-row search state, not a fact
    // about the posting, so there is no field to order by — and the design
    // draws no sort affordance on this header.
    meta: { surfaceRendered: true },
  },
];

/** What the Display popover lists, in view order: the data columns only. */
export function displayColumnList(
  hidden: ReadonlySet<string>,
): { id: string; name: string; on: boolean; locked?: boolean }[] {
  return JOBS_COLUMNS.filter((c) =>
    (JOBS_DATA_COLUMNS as readonly string[]).includes(c.id!),
  ).map((c) => ({
    id: c.id!,
    name: String(c.header),
    on: !hidden.has(c.id!),
    locked: c.meta?.locked === true,
  }));
}
