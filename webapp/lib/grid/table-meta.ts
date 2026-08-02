/**
 * The react-table module augmentation, in one place.
 *
 * It used to live inside `lib/grid/columns.tsx`, which was fine while there was
 * one column model. There are two during the Jobs cutover (the shipped one and
 * the redesigned one), and TypeScript merges `declare module` blocks by
 * DECLARING them, not by de-duplicating them — two files describing the same
 * property is a duplicate-identifier error, not a merge. So the augmentation
 * moves here and both column models import it for the side effect.
 *
 * Nothing else belongs in this file. It is a type declaration, not a home for
 * grid helpers.
 */
import type { RowData } from "@tanstack/react-table";
import type { JobView } from "@/lib/data/view-models";
import type { SortField } from "./sort";

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
    /**
     * A column the Display popover offers but cannot switch off.
     *
     * Company is the sticky primary cell: hiding it leaves rows that cannot be
     * identified, which is not a display preference, it is a broken table.
     */
    locked?: boolean;
    /** Rendered by the surface, not by a `cell` — the column declares only its
     *  identity, width and header. See the note in jobs-columns.tsx. */
    surfaceRendered?: boolean;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    /** The instant relative dates are measured against, pinned server-side so
     *  both renders of hydration agree. Never `Date.now()` inside a cell. */
    now?: number;
    /** Row-scoped warm-intro lookups, built once per page load. */
    warmFor?: (job: JobView) => { count: number; first: string } | null;
    /** Company domain for the LogoAvatar ladder, when the field exists. */
    domainFor?: (job: JobView) => string | null;
  }
}

export {};
