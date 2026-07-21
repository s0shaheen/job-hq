"use client";

import { Filter, Inbox } from "lucide-react";
import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type Column,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import type { JobView } from "@/lib/data/view-models";
import { GRID_COLUMNS, HEADER_PX, ROW_PX } from "@/lib/grid/columns";
import { rowsForSet, type WorkingSet } from "@/lib/grid/presets";
import { cn } from "@/lib/utils";

/**
 * The read-only virtualized grid (increment G1). react-table owns the column
 * model, react-virtual owns which rows exist in the DOM; the working set is a
 * plain predicate applied BEFORE the table sees the data, so it stays a pure,
 * Vitest-tested module (plan decision 2 — the filter language never enters
 * react-table state).
 *
 * The set toggle is component state, deliberately not the URL: URL-addressable
 * filters are increment G2's contract (matrix row 19) and shipping half of it
 * as an ad-hoc param here would become the compatibility floor G2 has to
 * honour.
 */
export default function JobsGrid({ rows }: { rows: JobView[] }) {
  const [set, setSet] = React.useState<WorkingSet>("queue");
  // Same contract as the queue: false until React is actually driving the
  // component, so tests wait on readiness instead of racing hydration.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  const visible = React.useMemo(() => rowsForSet(rows, set), [rows, set]);

  const table = useReactTable({
    data: visible,
    columns: GRID_COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
    // Two columns only earn their width in the All postings set.
    //
    // Why answers "why is this row not in my queue?" — inside the Queue set
    // every row qualifies, so it would be a rail of dashes. Decision is the
    // same argument: the Queue set is *defined* as the undecided rows, so the
    // column reads "undecided" on every line while pushing real columns past
    // the container's right edge at 1280px. A column whose value is implied by
    // the view is decoration that costs the reader something.
    state: { columnVisibility: { why: set === "all", decision: set === "all" } },
  });

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX, // constant per density — no measurement pass
    overscan: 10,
    // Sized before the scroll element mounts, so the server (and the first
    // client render, identically — no hydration mismatch) emits a real
    // viewport of rows instead of an empty rowgroup that pops in after
    // hydration. An empty rowgroup is also an axe violation (rowgroup
    // requires row children), which made the resilience scan flaky by
    // timing.
    initialRect: { width: 1024, height: 900 },
  });

  const switchSet = (next: WorkingSet) => {
    setSet(next);
    // A new working set is a new context; keeping a 4000px offset would show
    // an arbitrary window of the other list.
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  };

  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  return (
    <div
      data-testid="jobs-grid"
      data-ready={ready ? "true" : "false"}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2 sm:px-6">
        <div
          role="group"
          aria-label="Working set"
          className="flex h-7 shrink-0 overflow-hidden rounded-md border border-border-strong"
        >
          <button
            type="button"
            aria-pressed={set === "queue"}
            onClick={() => switchSet("queue")}
            className={cn(
              "px-2.5 text-xs font-medium transition-colors",
              set === "queue"
                ? "bg-accent-subtle text-text"
                : "bg-surface text-text-2 hover:bg-raised",
            )}
          >
            Queue
          </button>
          <button
            type="button"
            aria-pressed={set === "all"}
            onClick={() => switchSet("all")}
            className={cn(
              "border-l border-border-strong px-2.5 text-xs font-medium transition-colors",
              set === "all"
                ? "bg-accent-subtle text-text"
                : "bg-surface text-text-2 hover:bg-raised",
            )}
          >
            All postings
          </button>
        </div>
        {/* Which set, and how big it is against everything — stated, not
            implied. A grid that silently shows a subset is the top-tier trust
            bug the spec names for exports, wearing a different surface. */}
        <p data-testid="grid-count" className="text-xs text-muted">
          {set === "queue"
            ? `${visible.length} of ${rows.length} postings — qualified and undecided, newest first`
            : `all ${rows.length} postings — including filtered and already-decided rows`}
        </p>
      </div>

      {visible.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title="No postings yet"
              body="The sweeps haven't found anything for you yet. Rows land here twice a day once they do."
            />
          ) : (
            // Filtered-out must never read as nothing-found: one is a quiet
            // day, the other is a setting. The full binding-constraint
            // sentence (G9 counts) arrives with the filter engine in G2; until
            // then the escape hatch is the other working set.
            <EmptyState
              icon={<Filter aria-hidden="true" className="size-8" />}
              title="Nothing undecided right now"
              body={`All ${rows.length} postings here are filtered out or already decided. All postings shows every one, with the reason it isn't in the queue.`}
              action={
                <Button variant="primary" onClick={() => switchSet("all")}>
                  Show all postings
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          data-testid="grid-scroll"
          // Both axes scroll HERE and nowhere else — the page must never
          // scroll sideways (layout.spec.ts measures painted geometry at six
          // widths). tabIndex + role name the region for keyboard users; a
          // scrollable box nobody can focus is unreachable by keyboard, which
          // axe caught on the pipeline table.
          role="region"
          aria-label="Job postings, scrollable"
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {/* w-max: the grid is as wide as its columns and the CONTAINER
              scrolls; min-w-full stretches it when the viewport is wider.
              Every cell carries an explicit width, so w-max resolves to the
              column sum rather than to some untruncated title's width. */}
          <div
            role="grid"
            aria-label="Job postings"
            aria-rowcount={tableRows.length + 1}
            className="w-max min-w-full"
          >
            <div
              role="row"
              aria-rowindex={1}
              className="sticky top-0 z-20 flex border-b border-border-strong bg-raised"
              style={{ height: HEADER_PX }}
            >
              {headers.map((h) => {
                const meta = h.column.columnDef.meta;
                return (
                  <div
                    key={h.id}
                    role="columnheader"
                    data-col={h.column.id}
                    style={colStyle(h.column)}
                    className={cn(
                      "flex min-w-0 items-center overflow-hidden px-3 text-2xs font-semibold uppercase tracking-wider text-muted",
                      meta?.align === "right" && "justify-end",
                      meta?.sticky &&
                        "sticky left-0 z-10 border-r border-border bg-raised",
                    )}
                  >
                    <span className="truncate">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </span>
                  </div>
                );
              })}
            </div>
            <div
              role="rowgroup"
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const row = tableRows[vi.index];
                return (
                  <div
                    key={row.id}
                    role="row"
                    aria-rowindex={vi.index + 2}
                    // Positioned with `top`, not translateY: a transform on
                    // the row makes it the containing block for its children
                    // and position:sticky on the company cell silently stops
                    // sticking — the exact failure grid-perf row 27 exists to
                    // catch.
                    className="group absolute inset-x-0 flex border-b border-border hover:bg-raised"
                    style={{ height: ROW_PX, top: vi.start }}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta;
                      return (
                        <div
                          key={cell.id}
                          role="gridcell"
                          data-col={cell.column.id}
                          style={colStyle(cell.column)}
                          className={cn(
                            "flex min-w-0 items-center overflow-hidden px-3",
                            meta?.align === "right" && "tabular justify-end",
                            meta?.sticky &&
                              // Opaque, and re-tinted on row hover — a sticky
                              // cell with a transparent background shows the
                              // scrolled columns through itself.
                              "sticky left-0 z-10 border-r border-border bg-surface group-hover:bg-raised",
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One width recipe for header and body cells — deriving both from the same
 * function is what keeps their column edges aligned within the 1px the sticky
 * test asserts. Fixed columns neither grow nor shrink; Title (grow) absorbs
 * all leftover width when the viewport is wider than the column sum.
 */
function colStyle(col: Column<JobView, unknown>): React.CSSProperties {
  return {
    width: col.getSize(),
    flex: col.columnDef.meta?.grow ? "1 0 auto" : "0 0 auto",
  };
}
