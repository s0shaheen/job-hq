/**
 * Column model for the /jobs grid — @tanstack/react-table ColumnDef s plus the
 * pure text functions the cells render, exported separately so Vitest can
 * exercise the "absence is a dash, never an invention" rule without a layout
 * engine.
 *
 * Columns stay display-only (no accessorFns): sorting lives in the pure
 * `lib/grid/sort.ts`, applied to the array BEFORE react-table sees it, for the
 * same reason filtering does — matrix row 35 ("nulls sort as 0") needs a unit
 * test that can actually fail, and react-table's null handling only runs
 * inside a mounted table, where jsdom's missing layout engine renders nothing
 * to observe. A column declares WHICH sort field its header drives via
 * `meta.sortField`; the header button and the URL do the rest.
 *
 * Width notes vs. the plan's table: Comp is 160, not 130 — the fixture's own
 * "$185,000 - $240,000" measures ~131px at 13px tabular figures and would
 * ellipsize its top number inside 130 + padding, and a comp column that hides
 * the max is worse than a wider one. Min YoE is 80 for the same reason (the
 * uppercase header did not fit 70). Metro and First seen are hidden in the
 * plan's default view and G1 has no column chooser, so they are omitted
 * rather than shipped unreachable.
 */
import type { ColumnDef, RowData } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import type { JobView } from "@/lib/data/view-models";
import { explainReason } from "@/lib/data/view-models";
import { fmtDay } from "@/lib/format";
import type { SortField } from "@/lib/grid/sort";
import { cn } from "@/lib/utils";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Numerics right-align so magnitudes line up down a column. */
    align?: "left" | "right";
    /** The one flex column that absorbs leftover width (Title). */
    grow?: boolean;
    /** Pinned to the left edge under horizontal scroll (Company). */
    sticky?: boolean;
    /** Which sort field this column's header drives (lib/grid/sort.ts).
     *  Absent = the header is a plain label. */
    sortField?: SortField;
  }
}

/** Fixed row height — the constant that makes virtualization exact. A wrapped
 *  cell would silently corrupt the scroll math for every row below it, which
 *  is why every cell truncates and grid.spec.ts measures the long fixture. */
export const ROW_PX = 32;
export const HEADER_PX = 32;

/**
 * How absence reads. The card spells out "Not listed" because it shows four
 * fields with room to explain; a dense grid repeating those words hundreds of
 * times per screen would bury the stated values in boilerplate. The em dash is
 * the console convention (Stripe, Linear) for "nothing stated", it is muted so
 * a scanning eye skips it, and it is still never a zero, an empty cell, or an
 * invented midpoint.
 */
export const DASH = "—";

export function compText(j: JobView): string {
  // Verbatim, including non-USD bands the sorter cannot parse — a £ range the
  // user can read beats a dash that hides what the posting said.
  return j.compRange?.trim() || DASH;
}

export function yoeText(j: JobView): string {
  if (j.minYoe === null || j.minYoe === undefined) return DASH;
  return j.minYoe === 0 ? "Any" : String(j.minYoe);
}

export function workModelText(j: JobView): string {
  return j.workModel?.trim() || (j.remote ? "Remote" : DASH);
}

export function locationText(j: JobView): string {
  return j.location?.trim() || (j.remote ? "Remote" : DASH);
}

export function postedText(j: JobView): string {
  return fmtDay(j.posted); // fmtDay already answers null with the dash
}

export function decisionText(j: JobView): string {
  return j.triage === "" ? "undecided" : j.triage;
}

export function whyText(j: JobView): string {
  // Only rows the engine held back have a "why"; explaining "Matches your
  // search" on every qualified row would drown the rows that need reading.
  return j.disposition === "qualified" ? DASH : explainReason(j.dispositionReason);
}

/** Truncating text cell. The full string rides on title= so truncation hides
 *  pixels, never data. A dash carries no tooltip — there is nothing to show. */
function Text({ value }: { value: string }) {
  return (
    <span
      className={cn("truncate", value === DASH && "text-muted")}
      title={value === DASH ? undefined : value}
    >
      {value}
    </span>
  );
}

export const GRID_COLUMNS: ColumnDef<JobView>[] = [
  {
    id: "company",
    header: "Company",
    size: 160,
    meta: { sticky: true, sortField: "company" },
    cell: ({ row }) => (
      <span className="truncate font-medium" title={row.original.company}>
        {row.original.company}
      </span>
    ),
  },
  {
    id: "title",
    header: "Title",
    size: 300,
    meta: { grow: true, sortField: "title" },
    cell: ({ row }) => (
      <a
        href={row.original.url}
        target="_blank"
        rel="noopener noreferrer"
        title={row.original.title}
        className="truncate hover:text-accent"
      >
        {row.original.title}
      </a>
    ),
  },
  {
    id: "warm",
    header: "Warm",
    size: 110,
    // THIRD, not last, and the position was measured rather than chosen. The
    // grid scrolls horizontally inside its own container, and at 1280px the
    // seven original columns already fill it exactly — so a Warm column appended
    // at the end sits past the right edge and is invisible on the default
    // desktop view. The first recorded baseline is what showed it: a new feature
    // that has to be scrolled to is a new feature nobody uses. Posted is what
    // scrolls off in its place, which is the cheapest column to lose.
    //
    // No `sortField`: sorting by warmth is the design brief's eventual ask
    // ("so 'which of today's queue has a warm path' is a sort, not a hunt"),
    // and it cannot be done here — `lib/grid/sort.ts` sorts a `JobView[]`
    // before react-table sees it, and warmth is not on a JobView. A header that
    // looked sortable and was not would be worse than a plain one.
    //
    // NO CELL, deliberately, and this is the one column in the table without
    // one. `jobs-grid.tsx` renders every Warm cell itself, because `WarmCell`
    // reaches a server action, `lib/referral/actions.ts` reaches
    // `getDataSource`, and that reaches the `server-only` reader — a
    // `columns.tsx` that imported the component could no longer be imported by a
    // Vitest unit test at all (`grid-columns.test.ts` and `view-state.test.ts`
    // both failed to LOAD, proving it).
    //
    // The first version put a dash here as "the no-context branch". It was
    // unreachable: the grid hides this column outright when there is no warm
    // context, which is the only case that cell existed for. Documented dead
    // code is the shape matrix row 227 is about, and this file is not exempt
    // from it — so the column declares its identity, its width and its header,
    // and nothing it cannot honour. `grid-columns.test.ts` asserts the absence.
  },
  {
    id: "warm-intro",
    header: "Warm intro",
    size: 120,
    // The layer-2 sibling of `warm`, and CELL-LESS for the exact same reason:
    // `jobs-grid.tsx` renders every Warm-intro cell itself, because
    // `WarmIntroCell` reaches `/api/warm/*` and the warm server actions, and a
    // module unit-tested by Vitest (`grid-columns.test.ts`) must stay importable
    // without dragging a client component and its `server-only` transitive
    // imports in. Placed right after `warm` so both warm surfaces sit left of
    // the horizontal-scroll fold on the default desktop view — a warm feature
    // that has to be scrolled to is one nobody uses (the note on `warm` above).
    //
    // No `cell` (see `grid-columns.test.ts`, which exempts this column beside
    // `warm`); no `sortField`, because "which of today's queue has a pinned
    // intro" is not a field on `JobView`.
  },
  {
    id: "comp",
    header: "Comp",
    size: 160,
    meta: { align: "right", sortField: "comp" },
    cell: ({ row }) => <Text value={compText(row.original)} />,
  },
  {
    id: "minYoe",
    header: "Min YoE",
    size: 80,
    meta: { align: "right", sortField: "minYoe" },
    cell: ({ row }) => <Text value={yoeText(row.original)} />,
  },
  {
    id: "workModel",
    header: "Work model",
    size: 110,
    cell: ({ row }) => <Text value={workModelText(row.original)} />,
  },
  {
    id: "location",
    header: "Location",
    size: 150,
    cell: ({ row }) => <Text value={locationText(row.original)} />,
  },
  {
    id: "posted",
    header: "Posted",
    size: 90,
    meta: { align: "right", sortField: "posted" },
    cell: ({ row }) => <Text value={postedText(row.original)} />,
  },
  {
    id: "decision",
    header: "Decision",
    size: 110,
    cell: ({ row }) => {
      const t = row.original.triage;
      // Undecided is the overwhelming majority (it is the Queue set's whole
      // membership), so it renders as quiet text — colour means state, and a
      // badge on every row is decoration. Actual decisions get the pill.
      if (t === "") return <span className="truncate text-muted">undecided</span>;
      const tone = t === "interested" ? "accent" : t === "snoozed" ? "warn" : "neutral";
      return (
        <Badge tone={tone} className="whitespace-nowrap">
          {t}
        </Badge>
      );
    },
  },
  {
    id: "why",
    header: "Why",
    size: 220,
    cell: ({ row }) => <Text value={whyText(row.original)} />,
  },
];
