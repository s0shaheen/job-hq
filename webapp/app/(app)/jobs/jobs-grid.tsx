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
import { Popover } from "radix-ui";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import type { JobView, SavedView } from "@/lib/data/view-models";
import { GRID_COLUMNS, HEADER_PX } from "@/lib/grid/columns";
import { applyFilter, compUnknownCount, quickSearch, type OrGroup } from "@/lib/grid/filter";
import { rowsForSet, type PersonaPreset, type WorkingSet } from "@/lib/grid/presets";
import {
  displayLeaves,
  flattenGroups,
  sortRows,
  type GroupBy,
  type SortField,
} from "@/lib/grid/sort";
import { serializeGridState, type GridUrlState } from "@/lib/grid/url-state";
import {
  displayEquals,
  presetUrl,
  resolveGridContext,
  rowPxFor,
  type DisplayState,
} from "@/lib/grid/view-state";
import { cn } from "@/lib/utils";
import FilterBar from "./filter-bar";
import ViewSwitcher from "./view-switcher";
import { WhyChip, WhyPopoverContent } from "./why-popover";

/**
 * The virtualized grid (G1), the filter engine and URL state (G2), and saved
 * views + display state (G3).
 *
 * The URL is the source of truth for every navigational choice — working set,
 * filters, quick search, sort, grouping (matrix row 19). The component
 * resolves `useSearchParams` + the saved views on every render and derives the
 * rows; it holds NO copy of that state, so back/forward and a pasted link
 * cannot disagree with what is on screen. The page is force-dynamic, which
 * makes useSearchParams available during the server render: a cold deep link —
 * including `?view=…` and the landing default on a bare /jobs — paints its
 * exact state in the server HTML with no post-hydration pop (grid-url.spec.ts
 * and grid-views.spec.ts assert the raw response).
 *
 * Display state (density, type scale, keyboard hints) is deliberately NOT in
 * the URL: it is a preference, and URL-encoding it would make every shared
 * link impose the sharer's eyesight on the reader. It lives in the saved
 * view's `state`; unsaved changes ride in `displayEdit`, keyed to the base
 * they were made against so switching views cannot leak one view's edits into
 * another.
 *
 * Discrete decisions (chip added/removed, set/sort/group changed) go through
 * router.push so Back unwinds them one per step; the quick-search box goes
 * through router.replace debounced 300ms so Back never replays keystrokes.
 *
 * `now` comes from the server rather than Date.now(): the `inlast` date
 * operator otherwise evaluates against two different instants on the two
 * renders of hydration, and a row straddling the boundary flickers in or out.
 */
export default function JobsGrid({
  rows,
  now,
  views,
}: {
  rows: JobView[];
  now: number;
  views: SavedView[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const ctx = React.useMemo(
    () => resolveGridContext(new URLSearchParams(searchKey), views),
    [searchKey, views],
  );
  const state = ctx.nav;

  // Same contract as the queue: false until React is actually driving the
  // component, so tests wait on readiness instead of racing hydration.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  // A clause we could not read is announced, not silently vanished — and not
  // "repaired" into a filter the user never asked for. Keyed on the search
  // string so one bad link toasts once, not once per render.
  const toastedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (ctx.dropped.length === 0 || toastedFor.current === searchKey) return;
    toastedFor.current = searchKey;
    const n = ctx.dropped.length;
    toast.warning(`Ignored ${n} unrecognized filter${n === 1 ? "" : "s"} from this link`, {
      description: ctx.dropped.join(" · "),
    });
  }, [ctx, searchKey]);

  // A `view=` id nothing matches — deleted on another device, or someone
  // else's link. The grid falls back to the plain preset and SAYS so; a silent
  // fallback would show the wrong rows under a URL that promises a view.
  const staleToastFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!ctx.staleViewId || staleToastFor.current === searchKey) return;
    staleToastFor.current = searchKey;
    toast.warning("That saved view no longer exists — showing the built-in set instead.", {
      description: "It may have been deleted on another device.",
    });
  }, [ctx, searchKey]);

  // Unsaved display changes, keyed to the base they edit. The key is what
  // makes display state PER-VIEW: switching to another view or preset leaves
  // the abandoned edit behind instead of dragging comfy-large-type onto every
  // surface the user visits next.
  const baseKey = ctx.base.kind === "view" ? `v:${ctx.base.view.id}` : `p:${ctx.nav.set}`;
  const [displayEdit, setDisplayEdit] = React.useState<{
    key: string;
    value: DisplayState;
  } | null>(null);
  const displayState = displayEdit?.key === baseKey ? displayEdit.value : ctx.baseDisplay;
  const edited = ctx.navEdited || !displayEquals(displayState, ctx.baseDisplay);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const ctxRef = React.useRef(ctx);
  ctxRef.current = ctx;

  const navigate = React.useCallback(
    (next: GridUrlState, mode: "push" | "replace") => {
      // Serializing over the CURRENT params keeps foreign ones (perf=5000)
      // alive — dropping them would swap the dataset out from under the perf
      // harness on the first filter change.
      const base = new URLSearchParams(searchKey);
      // An edit made while a view is active belongs to that view — including
      // the landing default, whose bare URL never carried `view=`. Without
      // this, the first chip added on top of the landing view silently
      // reparents the session onto the Queue preset.
      const b = ctxRef.current.base;
      if (b.kind === "view") base.set("view", b.view.id);
      const qs = serializeGridState(next, base);
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

  // Which columns earn their width is a property of the working set.
  //
  // Why answers "why is this row not in my queue?" — inside the Queue set
  // every row qualifies, so it would be a rail of dashes; in All postings and
  // Needs review it is the point of the view. Decision is the same argument:
  // Queue/Snoozed/Dismissed are *defined* by their triage value, so the column
  // would read the same word on every line while pushing real columns past
  // the container's right edge at 1280px. A column whose value is implied by
  // the view is decoration that costs the reader something.
  const whyVisible = state.set === "all" || state.set === "needs-review";
  const table = useReactTable({
    data: leaves,
    columns: GRID_COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
    state: {
      columnVisibility: { why: whyVisible, decision: state.set === "all" },
    },
  });

  const rowPx = rowPxFor(displayState.density);
  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowPx, // constant per density — group headers included
    overscan: 10,
    // Sized before the scroll element mounts, so the server (and the first
    // client render, identically — no hydration mismatch) emits a real
    // viewport of rows instead of an empty rowgroup that pops in after
    // hydration. An empty rowgroup is also an axe violation (rowgroup
    // requires row children), which made the resilience scan flaky by
    // timing.
    initialRect: { width: 1024, height: 900 },
  });

  // A density switch changes every row height at once. Without re-measuring
  // AND re-anchoring, the virtualizer keeps the old pixel offset against new
  // row math — the viewport lands on an arbitrary slice of the list (or a
  // blank gap) and the user loses their place mid-scroll.
  const prevRowPxRef = React.useRef(rowPx);
  React.useEffect(() => {
    if (prevRowPxRef.current === rowPx) return;
    const el = scrollRef.current;
    const anchor = el ? el.scrollTop / prevRowPxRef.current : 0;
    prevRowPxRef.current = rowPx;
    virtualizer.measure();
    if (el) el.scrollTop = Math.round(anchor * rowPx);
  }, [rowPx, virtualizer]);

  // --- the keyboard cursor and the why-popover (plan §6) -------------------

  // null until the user reaches for the keyboard: a permanent ring on row one
  // would read as a selection nobody made. The ref mirrors the state because
  // keydowns outrun renders: two quick `j`s both reading the STATE would
  // compute the same target and silently swallow a move — the ref is always
  // current, the state only drives paint.
  const [activeIdx, setActiveIdx] = React.useState<number | null>(null);
  const activeIdxRef = React.useRef<number | null>(null);
  const moveActiveTo = React.useCallback((idx: number) => {
    activeIdxRef.current = idx;
    setActiveIdx(idx);
  }, []);
  const [whyOpen, setWhyOpen] = React.useState<string | null>(null);
  const effActive = activeIdx === null ? null : Math.min(activeIdx, display.length - 1);

  React.useEffect(() => {
    /** Nearest job row from `start` walking `dir`, skipping group headers. */
    function jobIndexFrom(start: number, dir: 1 | -1): number | null {
      let i = start;
      while (i >= 0 && i < display.length && display[i].kind !== "job") i += dir;
      return i >= 0 && i < display.length ? i : null;
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      // The queue's guard, verbatim: typing in the quick search, the clause
      // builder, or the save-view name field is text, never a command.
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      // A modal is modal, and an open menu owns the keyboard (typeahead). The
      // why-popover's content is role=dialog too, so while it is open the
      // cursor parks — Escape closes it first, exactly like the export dialog.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      ) {
        return;
      }
      if (display.length === 0) return;

      const raw = activeIdxRef.current;
      const cur = raw === null ? null : Math.min(raw, display.length - 1);

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const dir = e.key === "j" ? 1 : -1;
        // The first press parks on the nearest end rather than skipping row 1.
        const start = cur === null ? (dir === 1 ? 0 : display.length - 1) : cur + dir;
        const target = jobIndexFrom(start, dir);
        if (target === null) return; // already at the edge
        moveActiveTo(target);
        setWhyOpen(null);
        virtualizer.scrollToIndex(target);
      } else if (e.key === "?") {
        e.preventDefault();
        const target = jobIndexFrom(cur ?? 0, 1) ?? jobIndexFrom(cur ?? 0, -1);
        if (target === null) return;
        const item = display[target];
        if (item.kind !== "job") return;
        moveActiveTo(target);
        virtualizer.scrollToIndex(target);
        setWhyOpen((k) => (k === item.job.key ? null : item.job.key));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [display, virtualizer, moveActiveTo]);

  const openJob =
    whyOpen === null ? null : (leaves.find((j) => j.key === whyOpen) ?? null);
  // Virtualized rows unmount when scrolled away, taking the popover's anchor
  // with them — the content must only render while its anchor row is painted,
  // or radix positions it against nothing.
  const virtualItems = virtualizer.getVirtualItems();
  const openInWindow =
    openJob !== null &&
    virtualItems.some((vi) => {
      const it = display[vi.index];
      return it?.kind === "job" && it.job.key === openJob.key;
    });

  // --- saved-view gestures (all URL navigations — row 19 unchanged) --------

  const selectPreset = (set: WorkingSet) => {
    setDisplayEdit(null);
    // presetUrl is ALWAYS explicit (`?set=queue`), because bare /jobs is the
    // landing slot: a user whose default view filters the queue could
    // otherwise never see the plain Queue again.
    router.push(presetUrl(set), { scroll: false });
  };
  const selectView = (id: string) => {
    setDisplayEdit(null);
    router.push(`/jobs?view=${id}`, { scroll: false });
  };
  const applyPersona = (p: PersonaPreset) => {
    // Nav through the URL as ever; display as a pending edit on the target
    // preset, so the switcher immediately offers Save as… to keep it.
    setDisplayEdit({ key: `p:${p.nav.set}`, value: p.display });
    const qs = serializeGridState(p.nav);
    router.push(qs ? `/jobs?${qs}` : presetUrl(p.nav.set), { scroll: false });
  };
  const handleSaved = (view: SavedView) => {
    setDisplayEdit(null);
    // The canonical spelling of a saved view is its id alone; router.refresh
    // re-reads the server's view list so the switcher shows the new row even
    // when the URL itself did not change (a display-only Save).
    router.push(`/jobs?view=${view.id}`, { scroll: false });
    router.refresh();
  };
  const handleConflict = () => {
    const b = ctxRef.current.base;
    setDisplayEdit(null);
    if (b.kind === "view") router.push(`/jobs?view=${b.view.id}`, { scroll: false });
    // Conflicts revert, like triage: the other device's saved state is the
    // truth now, and keeping the losing edit on screen would claim otherwise.
    router.refresh();
  };
  const handleDeleted = () => {
    setDisplayEdit(null);
    router.push(presetUrl("queue"), { scroll: false });
    router.refresh();
  };
  const handleReset = () => {
    setDisplayEdit(null);
    const b = ctxRef.current.base;
    if (b.kind === "view") router.push(`/jobs?view=${b.view.id}`, { scroll: false });
    else router.push(presetUrl(b.set), { scroll: false });
  };

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
      : state.set === "all"
        ? `all ${rows.length} postings — including filtered and already-decided rows`
        : state.set === "snoozed"
          ? `${sorted.length} of ${rows.length} postings — snoozed for later`
          : state.set === "dismissed"
            ? `${sorted.length} of ${rows.length} postings — passed on`
            : `${sorted.length} of ${rows.length} postings — awaiting analysis`;

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
        // Visible on every viewport: it is the only control for which set or
        // view is shown, and hiding it on a phone would leave a phone user no
        // on-screen way to leave the Queue. It replaced the standalone Queue/All
        // toggle that used to be the phone's set control, and a single compact
        // dropdown trigger is narrower than that two-button toggle — so the bar
        // height the loading skeleton mirrors is unchanged.
        switcher={
          <ViewSwitcher
            views={views}
            base={ctx.base}
            edited={edited}
            nav={state}
            display={displayState}
            onSelectPreset={selectPreset}
            onSelectView={selectView}
            onApplyPersona={applyPersona}
            onDisplayChange={(d) => setDisplayEdit({ key: baseKey, value: d })}
            onSaved={handleSaved}
            onConflict={handleConflict}
            onDeleted={handleDeleted}
            onReset={handleReset}
          />
        }
        onQChange={onQChange}
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
          ) : state.set === "snoozed" || state.set === "dismissed" || state.set === "needs-review" ? (
            // An empty preset is a quiet fact about the data, not the queue's
            // profile-gating situation — reusing that copy here would send the
            // user to loosen settings that have nothing to do with it.
            <EmptyState
              icon={<Inbox aria-hidden="true" className="size-8" />}
              title={
                state.set === "snoozed"
                  ? "Nothing snoozed right now"
                  : state.set === "dismissed"
                    ? "Nothing dismissed yet"
                    : "Nothing awaiting analysis"
              }
              body={
                state.set === "snoozed"
                  ? "Postings you snooze wait here until their wake date."
                  : state.set === "dismissed"
                    ? "Postings you pass on land here, in case you change your mind."
                    : "Rows the engine couldn't classify wait here for the next tagging pass."
              }
              action={
                <Button variant="primary" onClick={() => switchSet("all")}>
                  Show all postings
                </Button>
              }
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
        // The why-popover's Root wraps the scroll container so its Anchor can
        // sit on whichever cell of the open row is on screen; the content
        // renders in a portal and only while the anchor row is painted.
        <Popover.Root
          open={openInWindow}
          onOpenChange={(o) => {
            if (!o) setWhyOpen(null);
          }}
        >
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
          className={cn(
            "min-h-0 flex-1 overflow-auto bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            // Type scale: the container's font-size cascades into every cell
            // (cells set no size of their own). Never html { font-size } —
            // that would fight the 200%-zoom test and rescale the chrome.
            displayState.typeScale === "large"
              ? "text-lg"
              : displayState.density === "comfortable"
                ? "text-base"
                : undefined,
          )}
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
              {virtualItems.map((vi) => {
                const item = display[vi.index];
                if (item.kind === "group") {
                  return (
                    <div
                      key={`group:${item.label}`}
                      role="row"
                      aria-rowindex={vi.index + 2}
                      data-testid="group-header"
                      className="absolute inset-x-0 flex border-b border-border bg-raised"
                      style={{ height: rowPx, top: vi.start }}
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
                const isActive = effActive === vi.index;
                const isOpenRow = openJob?.key === row.original.key;
                return (
                  <div
                    key={row.id}
                    role="row"
                    aria-rowindex={vi.index + 2}
                    data-active={isActive ? "true" : undefined}
                    // Positioned with `top`, not translateY: a transform on
                    // the row makes it the containing block for its children
                    // and position:sticky on the company cell silently stops
                    // sticking — the exact failure grid-perf row 27 exists to
                    // catch.
                    className={cn(
                      "group absolute inset-x-0 flex border-b border-border hover:bg-raised",
                      // The keyboard cursor: an inset ring, distinguishable
                      // from (future) selection tint by construction.
                      isActive && "ring-1 ring-inset ring-ring",
                    )}
                    style={{ height: rowPx, top: vi.start }}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta;
                      // The open row's popover anchors on its Why chip when
                      // that column is on screen, else on the sticky company
                      // cell — the one cell horizontal scroll cannot hide.
                      const isAnchor =
                        isOpenRow &&
                        (cell.column.id === "why" || (!whyVisible && meta?.sticky === true));
                      const cellEl = (
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
                          {cell.column.id === "why" &&
                          row.original.disposition !== "qualified" ? (
                            // The chip, not plain text: the sentence is the
                            // cell, the CLICK adds which setting caused it
                            // and where to change it (plan §6).
                            <WhyChip
                              job={row.original}
                              onClick={() =>
                                setWhyOpen((k) =>
                                  k === row.original.key ? null : row.original.key,
                                )
                              }
                            />
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
        {openJob ? <WhyPopoverContent job={openJob} /> : null}
        </Popover.Root>
      )}

      {/* Keyboard hints live on the surface's bottom edge (the Linear /
          Superhuman slot), NOT in the toolbar: the toolbar's rest state must
          hold one line at the desktop viewport — the loading skeleton pins its
          height, and a wrapped toolbar moves the whole grid down 24px when
          data lands (matrix row 7's jump, reborn). Off with the display knob;
          hidden on phones along with the shortcuts themselves. */}
      {displayState.hints && display.length > 0 ? (
        <p
          data-testid="grid-hints"
          className="hidden shrink-0 items-center justify-end gap-x-1 whitespace-nowrap border-t
                     border-border px-4 py-1 text-2xs text-muted sm:flex sm:px-6"
        >
          <Kbd className="ml-0">j</Kbd> <Kbd>k</Kbd> rows · <Kbd>?</Kbd> why this row
        </p>
      ) : null}
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
