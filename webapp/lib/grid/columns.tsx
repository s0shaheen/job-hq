/**
 * Column model for the /jobs grid — @tanstack/react-table ColumnDef s plus the
 * pure text functions the cells render, exported separately so Vitest can
 * exercise the "absence is a dash, never an invention" rule without a layout
 * engine.
 *
 * G1 renders display columns only (no accessors): the grid is read-only and
 * unsorted, so an accessor would be dead weight. G2 adds accessorFns alongside
 * its sortingFns (nulls-last in both directions) — do not add them earlier
 * "for completeness"; an accessor nothing reads is untestable.
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
    meta: { sticky: true },
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
    meta: { grow: true },
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
    id: "comp",
    header: "Comp",
    size: 160,
    meta: { align: "right" },
    cell: ({ row }) => <Text value={compText(row.original)} />,
  },
  {
    id: "minYoe",
    header: "Min YoE",
    size: 80,
    meta: { align: "right" },
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
    meta: { align: "right" },
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
