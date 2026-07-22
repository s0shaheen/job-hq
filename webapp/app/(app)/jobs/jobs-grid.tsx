"use client";

import { ChevronDown, ChevronUp, Filter, Inbox, SearchX } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type Column,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import type { JobView } from "@/lib/data/view-models";
import { GRID_COLUMNS, HEADER_PX, ROW_PX } from "@/lib/grid/columns";
import { applyFilter, compUnknownCount, quickSearch, type OrGroup } from "@/lib/grid/filter";
import { rowsForSet, type WorkingSet } from "@/lib/grid/presets";
import {
  displayLeaves,
  flattenGroups,
  sortRows,
  type GroupBy,
  type SortField,
} from "@/lib/grid/sort";
import { parseGridState, serializeGridState, type GridUrlState } from "@/lib/grid/url-state";
import { cn } from "@/lib/utils";
import FilterBar from "./filter-bar";

/**
 * The virtualized grid (G1) plus the filter engine and URL state (G2).
 *
 * The URL is the source of truth for every navigational choice — working set,
 * filters, quick search, sort, grouping (matrix row 19). The component parses
 * `useSearchParams` on every render and derives the rows; it holds NO copy of
 * that state, so back/forward and a pasted link cannot disagree with what is
 * on screen. The page is force-dynamic, which makes useSearchParams available
 * during the server render: a cold deep link paints its exact state in the
 * server HTML with no post-hydration pop (grid-url.spec.ts asserts the raw
 * response).
 *
 * Discrete decisions (chip added/removed, set/sort/group changed) go through
 * router.push so Back unwinds them one per step; the quick-search box goes
 * through router.replace debounced 300ms so Back never replays keystrokes.
 *
 * `now` comes from the server rather than Date.now(): the `inlast` date
 * operator otherwise evaluates against two different instants on the two
 * renders of hydration, and a row straddling the boundary flickers in or out.
 */
export default function JobsGrid({ rows, now }: { rows: JobView[]; now: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const parsed = React.useMemo(() => parseGridState(new URLSearchParams(searchKey)), [searchKey]);
  const state = parsed.state;

  // Same contract as the queue: false until React is actually driving the
  // component, so tests wait on readiness instead of racing hydration.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  // A clause we could not read is announced, not silently vanished — and not
  // "repaired" into a filter the user never asked for. Keyed on the search
  // string so one bad link toasts once, not once per render.
  const toastedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (parsed.dropped.length === 0 || toastedFor.current === searchKey) return;
    toastedFor.current = searchKey;
    const n = parsed.dropped.length;
    toast.warning(`Ignored ${n} unrecognized filter${n === 1 ? "" : "s"} from this link`, {
      description: parsed.dropped.join(" · "),
    });
  }, [parsed, searchKey]);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const navigate = React.useCallback(
    (next: GridUrlState, mode: "push" | "replace") => {
      // Serializing over the CURRENT params keeps foreign ones (perf=5000)
      // alive — dropping them would swap the dataset out from under the perf
      // harness on the first filter change.
      const qs = serializeGridState(next, new URLSearchParams(searchKey));
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") {
        router.push(url, { scroll: false });
        // A new filter/sort/set is a new context; a stale 4000px offset would
        // show an arbitrary window of the new list.
        scrollRef.current?.scrollTo({ top: 0 });
      } else {
        router.replace(url, { scroll: false });
      }
    },
    [router, pathname, searchKey],
  );

  // Quick search: the input echoes locally (filtering is live per keystroke)
  // while the URL follows via a debounced replace. The URL stays the source
  // of truth — an external change (Back/Forward, a pasted link) cancels any
  // pending flush and overwrites the echo; our own flush arriving back is
  // recognised by value and leaves in-progress typing alone.
  const [q, setQ] = React.useState(state.q);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentQ = React.useRef<string | null>(null);
  const urlQ = state.q;
  React.useEffect(() => {
    if (lastSentQ.current !== null && urlQ === lastSentQ.current) {
      lastSentQ.current = null;
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setQ(urlQ);
  }, [urlQ]);
  React.useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );
  const onQChange = (next: string) => {
    setQ(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      lastSentQ.current = next;
      navigate({ ...stateRef.current, q: next }, "replace");
    }, 300);
  };

  // The row pipeline, in stated order: working set → filter → quick search →
  // sort → group-flatten. Each stage is a pure module with its own unit tests;
  // this component only composes them.
  const setRows = React.useMemo(() => rowsForSet(rows, state.set), [rows, state.set]);
  const visible = React.useMemo(
    () => quickSearch(applyFilter(setRows, state.filter, now), q),
    [setRows, state.filter, now, q],
  );
  const sorted = React.useMemo(() => sortRows(visible, state.sort), [visible, state.sort]);
  const display = React.useMemo(() => flattenGroups(sorted, state.group), [sorted, state.group]);
  const leaves = React.useMemo(() => displayLeaves(display), [display]);

  const table = useReactTable({
    data: leaves,
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
    state: {
      columnVisibility: { why: state.set === "all", decision: state.set === "all" },
    },
  });

  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX, // constant per density — group headers included
    overscan: 10,
    // Sized before the scroll element mounts, so the server (and the first
    // client render, identically — no hydration mismatch) emits a real
    // viewport of rows instead of an empty rowgroup that pops in after
    // hydration. An empty rowgroup is also an axe violation (rowgroup
    // requires row children), which made the resilience scan flaky by
    // timing.
    initialRect: { width: 1024, height: 900 },
  });

  // --- decisions (router.push — Back unwinds them one per step) ------------

  const switchSet = (set: WorkingSet) => {
    if (set === state.set) return;
    navigate({ ...state, set }, "push");
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  };
  const addGroup = (group: OrGroup) => navigate({ ...state, filter: [...state.filter, group] }, "push");
  const removeGroup = (index: number) =>
    navigate({ ...state, filter: state.filter.filter((_, i) => i !== index) }, "push");
  const clearFilters = () => {
    // Kill any in-flight quick-search flush and reset the local echo directly.
    // Without both, "Clear filters" while the debounce is pending navigates to
    // the clean URL and the stale flush immediately re-applies the query the
    // user just cleared — and when the URL never carried q at all (the user
    // typed and cleared inside one debounce window), no URL change arrives to
    // sync the echo, so the grid stays filtered by invisible state. The e2e
    // no-match test caught exactly this.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    lastSentQ.current = null;
    setQ("");
    navigate({ ...state, filter: [], q: "" }, "push");
  };
  const setGroupBy = (group: GroupBy) => navigate({ ...state, group }, "push");
  const cycleSort = (field: SortField) => {
    const cur = state.sort;
    const next =
      !cur || cur.field !== field
        ? ({ field, dir: "asc" } as const)
        : cur.dir === "asc"
          ? ({ field, dir: "desc" } as const)
          : null;
    navigate({ ...state, sort: next }, "push");
  };

  // Which set, how big it is against everything, and whether filters are in
  // play — stated, not implied. A grid that silently shows a subset is the
  // top-tier trust bug the spec names for exports, wearing a different
  // surface (matrix row 50).
  const narrowed = state.filter.length > 0 || q.trim() !== "";
  const countText = narrowed
    ? `${sorted.length} of ${setRows.length} postings match your filters`
    : state.set === "queue"
      ? `${sorted.length} of ${rows.length} postings — qualified and undecided${state.sort ? "" : ", newest first"}`
      : `all ${rows.length} postings — including filtered and already-decided rows`;

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const colCount = table.getVisibleLeafColumns().length;

  return (
    <div
      data-testid="jobs-grid"
      data-ready={ready ? "true" : "false"}
      className="flex min-h-0 flex-1 flex-col"
    >
      <FilterBar
        state={state}
        q={q}
        countText={countText}
        compUnknown={compUnknownCount(sorted)}
        rows={rows}
        onQChange={onQChange}
        onSwitchSet={switchSet}
        onAddGroup={addGroup}
        onRemoveGroup={removeGroup}
        onGroupChange={setGroupBy}
      />

      {display.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {narrowed && setRows.length > 0 ? (
            // The user's own filters hid everything — a different situation
            // from the profile gating below (that one is a setting; this one
            // is a chip on screen) and from a genuinely empty sweep. Blank
            // grid + no way back is how a working filter reads as a crash.
            <EmptyState
              icon={<SearchX aria-hidden="true" className="size-8" />}
              title="Nothing matches these filters"
              body={`Your filters hide all ${setRows.length} postings in this set.`}
              action={
                <Button variant="primary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title="No postings yet"
              body="The sweeps haven't found anything for you yet. Rows land here twice a day once they do."
            />
          ) : (
            // Filtered-out must never read as nothing-found: one is a quiet
            // day, the other is a setting. The escape hatch is the other
            // working set, where the Why column explains each row.
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
            aria-rowcount={display.length + 1}
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
                const sortField = meta?.sortField;
                const dir =
                  sortField && state.sort?.field === sortField ? state.sort.dir : null;
                const label = flexRender(h.column.columnDef.header, h.getContext());
                return (
                  <div
                    key={h.id}
                    role="columnheader"
                    data-col={h.column.id}
                    aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}
                    style={colStyle(h.column)}
                    className={cn(
                      "flex min-w-0 items-center overflow-hidden px-3 text-2xs font-semibold uppercase tracking-wider text-muted",
                      meta?.align === "right" && "justify-end",
                      meta?.sticky &&
                        "sticky left-0 z-10 border-r border-border bg-raised",
                    )}
                  >
                    {sortField ? (
                      // The quiet-indicator convention: no affordance chrome,
                      // a chevron only on the active column, the active
                      // header darkens one step.
                      <button
                        type="button"
                        onClick={() => cycleSort(sortField)}
                        title={`Sort by ${String(h.column.columnDef.header)}`}
                        className={cn(
                          "flex min-w-0 items-center gap-1 uppercase tracking-wider hover:text-text",
                          dir && "text-text",
                        )}
                      >
                        <span className="truncate">{label}</span>
                        {dir === "asc" ? (
                          <ChevronUp aria-hidden="true" className="size-3 shrink-0" />
                        ) : dir === "desc" ? (
                          <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
                        ) : null}
                      </button>
                    ) : (
                      <span className="truncate">{label}</span>
                    )}
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
                const item = display[vi.index];
                if (item.kind === "group") {
                  return (
                    <div
                      key={`group:${item.label}`}
                      role="row"
                      aria-rowindex={vi.index + 2}
                      data-testid="group-header"
                      className="absolute inset-x-0 flex border-b border-border bg-raised"
                      style={{ height: ROW_PX, top: vi.start }}
                    >
                      <div
                        role="gridcell"
                        aria-colspan={colCount}
                        className="flex min-w-0 flex-1 items-center overflow-hidden"
                      >
                        {/* Sticky like the company column, so the group name
                            stays readable under horizontal scroll. */}
                        <span className="sticky left-0 flex max-w-full items-baseline gap-2 px-3 text-xs">
                          <span className="truncate font-semibold">{item.label}</span>
                          <span className="tabular text-muted">{item.count}</span>
                        </span>
                      </div>
                    </div>
                  );
                }
                const row = tableRows[item.leafIndex];
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
