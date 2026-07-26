"use client";

import { ChevronDown, ChevronUp, Inbox, SearchX } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type Column,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Popover } from "radix-ui";
import { Button, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import type { CompanyView } from "@/lib/data/view-models";
import { COMPANY_GRID_COLUMNS, COMPANY_HEADER_PX, COMPANY_ROW_PX } from "@/lib/grid/company-columns";
import {
  companyPresetName,
  rowsForCompanySet,
  sortCompanies,
  type CompanySet,
  type CompanySort,
  type CompanySortField,
} from "@/lib/grid/company-presets";
import {
  clearSelection,
  clickSelect,
  pruneSelection,
  rangeSelect,
  toggleSelect,
  EMPTY_SELECTION,
} from "@/lib/grid/selection";
import { cn } from "@/lib/utils";
import { ProvenanceChip, ProvenancePopoverContent } from "./provenance-popover";
import {
  parseCompanyState,
  searchCompanies,
  serializeCompanyState,
  type CompanyUrlState,
} from "./url-state";

/**
 * The /companies universe review grid.
 *
 * Built by EXTENDING the /jobs grid's primitives rather than replacing them, which
 * is the UX teardown's binding instruction — and in practice means the parts that
 * were expensive to get right on /jobs are not re-litigated here:
 *
 *   * `lib/grid/selection.ts`, unchanged. It is key-based and surface-agnostic, so
 *     the shift-range semantics, the "second shift-click replaces the live span"
 *     rule, and the two independent enforcements of "a hidden row can never reach
 *     a payload" all apply verbatim.
 *   * The virtualization shape: a fixed row height, rows positioned with `top`
 *     and never `translateY` (a transform makes the row a containing block and
 *     silently kills the sticky first cell — matrix row 48), an `initialRect` so
 *     the server emits a real viewport of rows, and both axes scrolling in ONE
 *     container so the page never scrolls sideways.
 *   * The URL as the source of truth for set / search / sort (matrix row 19), with
 *     discrete choices pushed so Back unwinds them one per step and the search box
 *     replaced-and-debounced so Back never replays keystrokes.
 *   * `why-popover.tsx`'s chip-plus-popover column, re-skinned as Resolution.
 *
 * What is deliberately NOT ported: the filter-clause grammar, grouping, saved
 * views and export. Each is a real feature on /jobs and none is in P7's five
 * increments; shipping half of one is worse than not having it, and the working
 * sets plus quick search cover this surface's actual job — deciding on proposals.
 */

export default function CompaniesGrid({
  rows,
  toolbarExtras,
  aboveGrid,
  bulkBar,
  sweepCell,
  onSelectionChange,
}: {
  rows: CompanyView[];
  /** Rendered in the toolbar beside the count (the view switcher). */
  toolbarExtras?: (ctx: { set: CompanySet; sort: CompanySort | null }) => React.ReactNode;
  /** Rendered between the toolbar and the grid (the coverage meter). */
  aboveGrid?: (ctx: { setRows: CompanyView[]; allRows: CompanyView[] }) => React.ReactNode;
  /**
   * The Sweep cell, when the parent can WRITE it.
   *
   * Same arrangement as the Resolution column: the ColumnDef reserves the width
   * and names the header, and whoever owns the store renders the interactive
   * half. The grid deliberately has no store — keeping the write out of here is
   * what let it be built and tested without one — so a consumer that only reads
   * (or a future export) still gets the static text from the column model.
   */
  sweepCell?: (company: CompanyView) => React.ReactNode;
  /** Rendered while rows are selected (the bulk verbs bar). */
  bulkBar?: (ctx: {
    selected: CompanyView[];
    clear: () => void;
  }) => React.ReactNode;
  /**
   * Fires on EVERY selection change, the empty one included.
   *
   * A parent binding keyboard write-verbs needs the current selection, and reading
   * it out of the `bulkBar` render prop is a real bug: `bulkBar` is only called
   * while something is selected, so clearing the selection leaves the parent
   * holding the last non-empty set — and the next keypress decides rows the user
   * can no longer see highlighted. This callback is the one that also fires with
   * zero rows.
   */
  onSelectionChange?: (ctx: { selected: CompanyView[]; clear: () => void }) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const state = React.useMemo(
    () => parseCompanyState(new URLSearchParams(searchKey)),
    [searchKey],
  );

  // Same contract as /jobs and the queue: false until React is actually driving
  // the component, so tests wait on readiness instead of racing hydration
  // (matrix row 21 — a keystroke before hydration is silently dropped).
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const navigate = React.useCallback(
    (next: CompanyUrlState, mode: "push" | "replace") => {
      // Serialize over the CURRENT params so foreign ones survive a set change.
      const qs = serializeCompanyState(next, new URLSearchParams(searchKey));
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") {
        router.push(url, { scroll: false });
        // A new set/sort is a new context; a stale scroll offset would show an
        // arbitrary window of the new list.
        scrollRef.current?.scrollTo({ top: 0 });
      } else {
        router.replace(url, { scroll: false });
      }
    },
    [router, pathname, searchKey],
  );

  // Quick search: the input echoes locally (filtering is live per keystroke) while
  // the URL follows via a debounced replace. jobs-grid.tsx's mechanism verbatim,
  // including the flush-cancel — without it, clearing the box while a flush is
  // pending re-applies the query the user just cleared.
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

  // The row pipeline, in stated order: working set → quick search → sort. Each
  // stage is a pure module with its own unit tests; this component composes them.
  const setRows = React.useMemo(() => rowsForCompanySet(rows, state.set), [rows, state.set]);
  const visible = React.useMemo(() => searchCompanies(setRows, q), [setRows, q]);
  const leaves = React.useMemo(() => sortCompanies(visible, state.sort), [visible, state.sort]);
  const leavesRef = React.useRef(leaves);
  leavesRef.current = leaves;

  // --- selection (lib/grid/selection.ts, unmodified) -----------------------
  const [selRaw, setSelRaw] = React.useState(EMPTY_SELECTION);
  const visibleKeys = React.useMemo(() => new Set(leaves.map((c) => c.key)), [leaves]);
  const sel = React.useMemo(() => pruneSelection(selRaw, visibleKeys), [selRaw, visibleKeys]);
  const selRef = React.useRef(sel);
  selRef.current = sel;
  React.useEffect(() => {
    if (sel !== selRaw) setSelRaw(sel);
  }, [sel, selRaw]);

  /** Selected rows in display order — the exact payload the bulk verbs receive.
   *  Filtered over LEAVES, not the full set: the order-intersection is the second,
   *  independent enforcement of the prune rule, so even a pruning bug cannot put an
   *  invisible row into a write. */
  const selectedRows = React.useMemo(
    () => leaves.filter((c) => sel.keys.has(c.key)),
    [leaves, sel],
  );

  const clearSel = React.useCallback(() => setSelRaw(clearSelection()), []);
  React.useEffect(() => {
    onSelectionChange?.({ selected: selectedRows, clear: clearSel });
    // `selectedRows` identity is the signal. `onSelectionChange` is deliberately
    // absent from the deps: a parent that recreates the closure every render would
    // otherwise turn this into a per-render effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRows, clearSel]);

  // Which columns earn their width is a property of the working set — /jobs'
  // argument, unchanged. Inside "Needs review" every row is proposed, so a Review
  // column would read the same word on every line while pushing real columns past
  // the right edge; inside "Dismissed" the Sweep column is a rail of dashes,
  // because nothing dismissed is swept.
  const reviewVisible = state.set !== "review";
  const sweepVisible = state.set !== "dismissed" && state.set !== "review";
  const table = useReactTable({
    data: leaves,
    columns: COMPANY_GRID_COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
    state: { columnVisibility: { review: reviewVisible, sweep: sweepVisible } },
  });

  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: leaves.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMPANY_ROW_PX,
    overscan: 10,
    // Sized before the scroll element mounts, so the server (and the first client
    // render, identically — no hydration mismatch) emits a real viewport of rows
    // instead of an empty rowgroup that pops in after hydration. An empty rowgroup
    // is also an axe violation, which made /jobs' resilience scan flaky by timing.
    initialRect: { width: 1024, height: 900 },
  });

  // --- the keyboard cursor and the provenance popover ----------------------
  const [activeIdx, setActiveIdx] = React.useState<number | null>(null);
  const activeIdxRef = React.useRef<number | null>(null);
  const moveActiveTo = React.useCallback((idx: number) => {
    activeIdxRef.current = idx;
    setActiveIdx(idx);
  }, []);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const effActive = activeIdx === null ? null : Math.min(activeIdx, leaves.length - 1);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      // The queue's guard, verbatim: typing in the search box or a name field is
      // text, never a command (matrix rows 69 and 78).
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      // A modal is modal and an open menu owns the keyboard. The provenance
      // popover's content is role=dialog too, so while it is open the cursor
      // parks — Escape closes it first (matrix row 34).
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (leaves.length === 0) return;

      const raw = activeIdxRef.current;
      const cur = raw === null ? null : Math.min(raw, leaves.length - 1);
      const key = e.key.toLowerCase();

      if (key === "j" || key === "k") {
        e.preventDefault();
        const dir = key === "j" ? 1 : -1;
        // The first press parks on the nearest end rather than skipping row 1.
        const target =
          cur === null ? (dir === 1 ? 0 : leaves.length - 1) : cur + dir;
        if (target < 0 || target >= leaves.length) return; // already at the edge
        moveActiveTo(target);
        setOpenKey(null);
        virtualizer.scrollToIndex(target);
        if (e.shiftKey) {
          // Shift+j/k extends from the anchor. With no anchor yet, the row the
          // cursor came FROM becomes it, so the first extension selects both ends
          // the way a hand expects.
          const fromKey = cur !== null ? leaves[cur].key : leaves[target].key;
          setSelRaw((s) => {
            const order = leavesRef.current.map((c) => c.key);
            const withAnchor =
              s.anchor !== null && order.includes(s.anchor) ? s : clickSelect(fromKey);
            return rangeSelect(withAnchor, order, leaves[target].key);
          });
        }
      } else if (e.key === " ") {
        // Not from a button or link: Space is activation there, and firing both
        // would toggle a row the user only meant to press a control.
        if (el && /^(A|BUTTON)$/.test(el.tagName)) return;
        e.preventDefault();
        if (cur === null) return;
        setSelRaw((s) => toggleSelect(s, leaves[cur].key));
      } else if (e.key === "Escape") {
        if (selRef.current.keys.size === 0) return;
        e.preventDefault();
        setSelRaw(clearSelection());
      } else if (e.key === "?") {
        e.preventDefault();
        const target = cur ?? 0;
        moveActiveTo(target);
        virtualizer.scrollToIndex(target);
        setOpenKey((k) => (k === leaves[target].key ? null : leaves[target].key));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leaves, virtualizer, moveActiveTo]);

  const openRow = openKey === null ? null : (leaves.find((c) => c.key === openKey) ?? null);
  // Virtualized rows unmount when scrolled away, taking the popover's anchor with
  // them — the content must only render while its anchor row is painted, or radix
  // positions it against nothing.
  const virtualItems = virtualizer.getVirtualItems();
  const openInWindow =
    openRow !== null && virtualItems.some((vi) => leaves[vi.index]?.key === openRow.key);

  // --- navigation ---------------------------------------------------------

  const switchSet = (set: CompanySet) => {
    if (set === state.set) return;
    navigate({ ...state, set }, "push");
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  };
  const cycleSort = (field: CompanySortField) => {
    const cur = state.sort;
    const next =
      !cur || cur.field !== field
        ? ({ field, dir: "asc" } as const)
        : cur.dir === "asc"
          ? ({ field, dir: "desc" } as const)
          : null;
    navigate({ ...state, sort: next }, "push");
  };
  const clearSearch = () => {
    // Kill any in-flight flush and reset the echo directly — jobs-grid.tsx's
    // clearFilters lesson: without both, a pending flush re-applies the query the
    // user just cleared, and when the URL never carried `q` at all no URL change
    // arrives to sync the echo, so the grid stays filtered by invisible state.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    lastSentQ.current = null;
    setQ("");
    navigate({ ...state, q: "" }, "push");
  };

  // Which set, how big it is against everything, and whether a search is in play
  // — stated, not implied. A grid that silently shows a subset is the top-tier
  // trust bug the spec names for exports, wearing a different surface (row 50).
  const searching = q.trim() !== "";
  const noun = (n: number) => (n === 1 ? "company" : "companies");
  const countText = searching
    ? `${leaves.length} of ${setRows.length} ${noun(setRows.length)} match “${q.trim()}”`
    : state.set === "review"
      ? `${leaves.length} of ${rows.length} ${noun(rows.length)} — proposed, awaiting your decision`
      : state.set === "universe"
        ? `${leaves.length} of ${rows.length} ${noun(rows.length)} — approved and in your universe`
        : state.set === "unresolved"
          ? `${leaves.length} of ${rows.length} ${noun(rows.length)} — no board resolved, so nothing is pulled`
          : state.set === "dismissed"
            ? `${leaves.length} of ${rows.length} ${noun(rows.length)} — declined`
            : `all ${rows.length} ${noun(rows.length)} — every review state`;

  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  return (
    <div
      data-testid="companies-grid"
      data-ready={ready ? "true" : "false"}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Toolbar. One line at rest on the desktop viewport — the loading skeleton
          pins this height, and a wrapped toolbar moves the whole grid down when
          data lands (matrix row 7's jump). */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2 sm:px-6">
        {toolbarExtras?.({ set: state.set, sort: state.sort })}
        <label className="relative flex min-w-0 items-center">
          <span className="sr-only">Search companies</span>
          <input
            value={q}
            onChange={(e) => onQChange(e.target.value)}
            placeholder="Search name, board, source…"
            data-testid="company-search"
            className="h-7 w-40 min-w-0 rounded-md border border-border-strong bg-surface px-2 text-xs
                       text-text placeholder:text-muted focus-visible:outline-2
                       focus-visible:-outline-offset-1 focus-visible:outline-ring sm:w-56"
          />
        </label>
        <p data-testid="company-count" className="min-w-0 break-words text-xs text-muted">
          {countText}
        </p>
      </div>

      {aboveGrid?.({ setRows, allRows: rows })}

      {leaves.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {searching && setRows.length > 0 ? (
            // The user's own search hid everything — a different situation from an
            // empty set, and from an empty universe. A blank grid with no way back
            // is how a working search reads as a crash (matrix row 60).
            <EmptyState
              icon={<SearchX aria-hidden="true" className="size-8" />}
              title="Nothing matches that search"
              body={`No company in this set matches “${q.trim()}”.`}
              action={
                <Button variant="primary" onClick={clearSearch}>
                  Clear search
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title="No companies yet"
              body="Your universe is empty. Paste a list of companies to start it — nothing is monitored until you approve it."
              // The copy says "paste a list", so the button has to be here: an
              // empty state that names the next step without offering it makes the
              // user go and find it (empty.tsx — "nothing yet needs an explanation",
              // and an explanation with no door is half of one).
              action={
                <Link
                  href="/companies/add"
                  className={buttonClass({ variant: "primary" })}
                >
                  Add companies
                </Link>
              }
            />
          ) : (
            // An empty set is a quiet fact about the data, and each one means
            // something different — naming them apart is the whole point of row 15.
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title={
                state.set === "review"
                  ? "Nothing waiting on you"
                  : state.set === "universe"
                    ? "Nothing approved yet"
                    : state.set === "unresolved"
                      ? "Every company has a board"
                      : "Nothing dismissed"
              }
              body={
                state.set === "review"
                  ? "Proposals land here for a yes or no. Discovery adds them; so does pasting a list."
                  : state.set === "universe"
                    ? "Approve a proposal and it starts being swept for jobs."
                    : state.set === "unresolved"
                      ? "Every company here resolved to a board the sweep can pull from."
                      : "Companies you decline stay here, so discovery does not propose them again."
              }
              action={
                <Button variant="primary" onClick={() => switchSet("all")}>
                  Show all companies
                </Button>
              }
            />
          )}
        </div>
      ) : (
        // The popover's Root wraps the scroll container so its Anchor can sit on
        // the open row's Resolution cell; the content renders in a portal and only
        // while the anchor row is painted.
        <Popover.Root
          open={openInWindow}
          onOpenChange={(o) => {
            if (!o) setOpenKey(null);
          }}
        >
          <div
            ref={scrollRef}
            data-testid="company-scroll"
            // Both axes scroll HERE and nowhere else — the page must never scroll
            // sideways (layout.spec.ts measures painted geometry at six widths).
            // tabIndex + role name the region for keyboard users; a scrollable box
            // nobody can focus is unreachable by keyboard, which axe caught on the
            // pipeline table.
            role="region"
            aria-label="Company universe, scrollable"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-auto bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            {/* w-max: the grid is as wide as its columns and the CONTAINER
                scrolls; min-w-full stretches it when the viewport is wider. */}
            <div
              role="grid"
              aria-label="Company universe"
              aria-rowcount={leaves.length + 1}
              aria-multiselectable="true"
              className="w-max min-w-full"
            >
              <div
                role="row"
                aria-rowindex={1}
                className="sticky top-0 z-20 flex border-b border-border-strong bg-raised"
                style={{ height: COMPANY_HEADER_PX }}
              >
                {headers.map((h) => {
                  const meta = h.column.columnDef.meta;
                  const sortField = SORTABLE[h.column.id];
                  const dir = sortField && state.sort?.field === sortField ? state.sort.dir : null;
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
                        meta?.sticky && "sticky left-0 z-10 border-r border-border bg-raised",
                      )}
                    >
                      {sortField ? (
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
                {virtualItems.map((vi) => {
                  const row = tableRows[vi.index];
                  if (!row) return null;
                  const company = row.original;
                  const isActive = effActive === vi.index;
                  const isSelected = sel.keys.has(company.key);
                  const isOpenRow = openRow?.key === company.key;
                  return (
                    <div
                      key={row.id}
                      role="row"
                      aria-rowindex={vi.index + 2}
                      aria-selected={isSelected}
                      data-active={isActive ? "true" : undefined}
                      data-key={company.key}
                      onMouseDown={(e) => {
                        // Shift-click extends the range; without this the same
                        // gesture also smears a text selection across it.
                        if (e.shiftKey) e.preventDefault();
                      }}
                      onClick={(e) => {
                        // Chips explain and buttons act — a click on them is not a
                        // selection gesture.
                        if ((e.target as HTMLElement).closest("a,button,input")) return;
                        moveActiveTo(vi.index);
                        const order = leaves.map((c) => c.key);
                        setSelRaw((s) =>
                          e.shiftKey
                            ? rangeSelect(s, order, company.key)
                            : e.metaKey || e.ctrlKey
                              ? toggleSelect(s, company.key)
                              : clickSelect(company.key),
                        );
                      }}
                      // Positioned with `top`, not translateY: a transform on the
                      // row makes it the containing block for its children and
                      // position:sticky on the first cell silently stops sticking
                      // (matrix row 48).
                      className={cn(
                        "group absolute inset-x-0 flex border-b border-border",
                        // Selection is the tint, the cursor is the inset ring.
                        // Muted text is promoted to text-2 on a selected row: a
                        // tint strong enough to read as selection is too dark for
                        // #707067 to clear AA on (matrix row 82).
                        isSelected
                          ? "bg-selected [&_.text-muted]:text-text-2"
                          : "hover:bg-raised",
                        isActive && "ring-1 ring-inset ring-ring",
                      )}
                      style={{ height: COMPANY_ROW_PX, top: vi.start }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta;
                        const isAnchor = isOpenRow && cell.column.id === "resolution";
                        const cellEl = (
                          <div
                            key={cell.id}
                            role="gridcell"
                            data-col={cell.column.id}
                            style={colStyle(cell.column)}
                            className={cn(
                              "flex min-w-0 items-center overflow-hidden px-3",
                              meta?.sticky &&
                                // Opaque, and re-tinted on row hover — a sticky
                                // cell with a transparent background shows the
                                // scrolled columns through itself, and its tint
                                // must match the row or the pinned column reads as
                                // a different selection than the rest.
                                (isSelected
                                  ? "sticky left-0 z-10 border-r border-border bg-selected"
                                  : "sticky left-0 z-10 border-r border-border bg-surface group-hover:bg-raised"),
                            )}
                          >
                            {cell.column.id === "resolution" ? (
                              // The chip, not plain text: the cell states the tier
                              // AND how it was established, and the CLICK adds the
                              // evidence behind it.
                              <ProvenanceChip
                                company={company}
                                onClick={() =>
                                  setOpenKey((k) => (k === company.key ? null : company.key))
                                }
                              />
                            ) : cell.column.id === "sweep" && sweepCell ? (
                              sweepCell(company)
                            ) : (
                              flexRender(cell.column.columnDef.cell, cell.getContext())
                            )}
                          </div>
                        );
                        return isAnchor ? (
                          <Popover.Anchor asChild key={cell.id}>
                            {cellEl}
                          </Popover.Anchor>
                        ) : (
                          cellEl
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {openRow ? <ProvenancePopoverContent company={openRow} /> : null}
        </Popover.Root>
      )}

      {selectedRows.length > 0 ? bulkBar?.({ selected: selectedRows, clear: clearSel }) : null}
    </div>
  );
}

/** Which columns' headers drive a sort. A column absent here is a plain label. */
const SORTABLE: Record<string, CompanySortField | undefined> = {
  name: "name",
  resolution: "tier",
  source: "source",
  board: "ats",
};

/**
 * One width recipe for header and body cells — deriving both from the same
 * function is what keeps their column edges aligned within the 1px the sticky
 * test asserts (columns.tsx). Fixed columns neither grow nor shrink; the Company
 * column (grow) absorbs leftover width when the viewport is wider than the sum.
 */
function colStyle(col: Column<CompanyView, unknown>): React.CSSProperties {
  return {
    width: col.getSize(),
    flex: col.columnDef.meta?.grow ? "1 0 auto" : "0 0 auto",
  };
}

/** Re-exported so the page can name the active set in its header copy. */
export { companyPresetName };
