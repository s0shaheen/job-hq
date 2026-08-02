"use client";

/**
 * The redesigned Jobs surface: page header, four toolbar controls plus Display,
 * six columns, a scope line, and a right-hand detail pane.
 *
 * WHAT CHANGED, AND WHAT DID NOT
 *
 * Everything below the chrome is the shipped machinery, unchanged by rule
 * (07 §1, §7.8): the URL is still the single source of truth for every
 * navigational choice (working set, filters, quick search, sort, grouping); the
 * row pipeline is still the same five pure modules composed in the same order;
 * selection is still `lib/grid/selection.ts`; and every write still goes through
 * `useDecisions` — one RPC, one idempotency key, optimistic with undo,
 * conflicts reverting the whole batch. The redesign changes what the controls
 * look like, never how they write.
 *
 * What changed is the chrome and the row anatomy:
 *   - Ten columns become six (03 §9's budget). `Why` retires — its sentence
 *     moves into the pane, which is where 04 §3 puts it and why the Why column
 *     "stays dead". `Warm` retires as a column and returns as an indicator on
 *     the Company cell. `Min YoE` moves to the pane's Details. `Comp` becomes
 *     `Pay`; `Work model` + `Location` merge into `Location & model`.
 *   - Twelve or so concurrent controls become four plus one Display popover
 *     (the Linear pattern). Group-by leaves the chrome entirely — 04 §3's
 *     guardrail — but the URL grammar keeps it, so `?group=company` still
 *     groups and every existing deep link still resolves.
 *   - Row click opens the pane instead of selecting. Selection moves onto the
 *     checkbox track, which is what 01 §8 already specified ("Selected:
 *     `selected` token + checkbox; checkboxes appear on hover and while any
 *     selection is active"). This is a real behaviour change and the one most
 *     likely to surprise somebody who used the shipped grid.
 *   - Absence reads "Not listed" rather than a muted em dash (02 §8).
 *
 * DISPLAY STATE is deliberately not in the URL: it is a preference, and
 * URL-encoding it would impose the sharer's eyesight on the reader. It arrives
 * as a prop from the profile (E5) and falls back to the design defaults.
 * PANE state IS in the URL, because which record you are looking at is
 * navigation, not preference — a shared link must restore it (03 §4).
 */

import {
  ChevronDown,
  ChevronUp,
  Search,
  SearchX,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { getCoreRowModel, useReactTable, type Column } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  Button,
  DetailPane,
  DisplayPopover,
  EmptyState,
  FilterChipRow,
  Kbd,
  LogoAvatar,
  PageHeader,
  SavedViewTabs,
  SelectionBar,
  StatusSelect,
  TableToolbar,
} from "@/components/ds";
import { JOB_COLUMNS } from "@/lib/export/columns";
import type { JobView, SavedView } from "@/lib/data/view-models";
import { localIsoDaysFromNow } from "@/lib/dates";
import {
  countedNoun,
  decisionToast,
  filterGroupLabel,
  scopeLine,
  triageFor,
  type DecisionWord,
} from "@/lib/dictionary";
import { toTsv } from "@/lib/export/delimited";
import { applyFilter, quickSearch, type OrGroup } from "@/lib/grid/filter";
import {
  displayColumnList,
  JOBS_COLUMNS,
  SELECT_COLUMN_ID,
} from "@/lib/grid/jobs-columns";
import { jobRow, paneModel, type WarmIndicator } from "@/lib/grid/jobs-rows";
import { readPaneKey, withPaneKey } from "@/lib/grid/pane-state";
import {
  densityLabel,
  densityValue,
  typeSizeLabel,
  typeSizeValue,
  type DisplayPrefs,
} from "@/lib/grid/display-prefs";
import { rowsForSet, type WorkingSet } from "@/lib/grid/presets";
import {
  clearSelection,
  EMPTY_SELECTION,
  pruneSelection,
  rangeSelect,
  toggleSelect,
} from "@/lib/grid/selection";
import { displayLeaves, flattenGroups, sortRows, type SortField } from "@/lib/grid/sort";
import { serializeGridState, type GridUrlState } from "@/lib/grid/url-state";
import { connectionsAt, universeFor, type WarmContext } from "@/lib/referral/match";
import { resolveGridContext, rowPxFor, presetUrl } from "@/lib/grid/view-state";
import { cn } from "@/lib/utils";
import { WarmCell } from "@/components/warm-cell";
import { WarmIntroCell } from "@/components/warm-intro-cell";
import { pinsForRow, type WarmIntroContext } from "@/lib/warm/intro-context";
import { SNOOZE_DAYS, useDecisions } from "./decisions";
import ExportMenu from "./export-menu";
import FilterPopover from "./filter-popover";
import SaveViewDialog from "./save-view-dialog";

/**
 * The saved-view tabs, in 03 §4's order, each standing for a working set.
 *
 * A tab is a named query (03 §2), and these five are the queries that exist
 * with zero setup. `needs-review` keeps its working set — old links carry it —
 * but has no tab: 02 §4 folds "needs-info" into "checking details", which is a
 * transient state, not a place a person navigates to.
 */
const VIEW_TABS: { name: string; set: WorkingSet }[] = [
  { name: "All", set: "all" },
  { name: "Needs decision", set: "queue" },
  { name: "Interested", set: "interested" },
  { name: "Passed", set: "dismissed" },
  { name: "Later", set: "snoozed" },
];

/** The pane's resting width (03 §4). Draggable; not URL state. */
const DEFAULT_PANE_PX = 420;

export type JobsTableProps = {
  rows: JobView[];
  now: number;
  views: SavedView[];
  warm?: WarmContext;
  /** Layer 2: the on-demand finder's per-page context. Absent under the perf
   *  harness, which has no store to pin against. */
  warmIntro?: WarmIntroContext;
  /** Per-user display preferences. From `profiles` once E5 lands; the design
   *  defaults until then (see lib/grid/display-prefs.ts). */
  prefs: DisplayPrefs;
};

export default function JobsTable({
  rows,
  now,
  views,
  warm,
  warmIntro,
  prefs,
}: JobsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const ctx = React.useMemo(
    () => resolveGridContext(new URLSearchParams(searchKey), views),
    [searchKey, views],
  );
  const state = ctx.nav;

  // False until React is actually driving the component, so tests wait on
  // readiness instead of racing hydration.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  // A clause we could not read is announced, not silently vanished — and not
  // "repaired" into a filter the user never asked for.
  const toastedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (ctx.dropped.length === 0 || toastedFor.current === searchKey) return;
    toastedFor.current = searchKey;
    const n = ctx.dropped.length;
    toast.warning(`Ignored ${n} unrecognized filter${n === 1 ? "" : "s"} from this link`, {
      description: ctx.dropped.join(", "),
    });
  }, [ctx, searchKey]);

  const staleToastFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!ctx.staleViewId || staleToastFor.current === searchKey) return;
    staleToastFor.current = searchKey;
    toast.warning("That saved view no longer exists. Showing the built-in set instead.", {
      description: "It may have been deleted on another device.",
    });
  }, [ctx, searchKey]);

  // --- display preferences -------------------------------------------------
  // Seeded from the profile and edited locally. E5 replaces the local half with
  // a write through the RPC layer; until then a change lasts the session, which
  // is what the shipped surface did through a cookie.
  const [display, setDisplay] = React.useState<DisplayPrefs>(prefs);
  React.useEffect(() => setDisplay(prefs), [prefs]);
  const [hiddenCols, setHiddenCols] = React.useState<ReadonlySet<string>>(new Set());

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const ctxRef = React.useRef(ctx);
  ctxRef.current = ctx;

  const navigate = React.useCallback(
    (next: GridUrlState, mode: "push" | "replace") => {
      // Serializing over the CURRENT params keeps foreign ones (perf=5000, and
      // the pane's job=) alive — dropping them would swap the dataset out from
      // under the perf harness, or close the pane on every filter change.
      const base = new URLSearchParams(searchKey);
      const b = ctxRef.current.base;
      if (b.kind === "view") base.set("view", b.view.id);
      const qs = serializeGridState(next, base);
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") {
        router.push(url, { scroll: false });
        scrollRef.current?.scrollTo({ top: 0 });
      } else {
        router.replace(url, { scroll: false });
      }
    },
    [router, pathname, searchKey],
  );

  // Quick search: the input echoes locally while the URL follows via a
  // debounced replace. The URL stays the source of truth.
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

  // --- the row pipeline ----------------------------------------------------
  const { effRows, busy, decide } = useDecisions(rows);
  const setRows = React.useMemo(() => rowsForSet(effRows, state.set), [effRows, state.set]);
  const visible = React.useMemo(
    () => quickSearch(applyFilter(setRows, state.filter, now), q),
    [setRows, state.filter, now, q],
  );
  const sorted = React.useMemo(() => sortRows(visible, state.sort), [visible, state.sort]);
  const displayRows = React.useMemo(
    () => flattenGroups(sorted, state.group),
    [sorted, state.group],
  );
  const leaves = React.useMemo(() => displayLeaves(displayRows), [displayRows]);
  const leavesRef = React.useRef(leaves);
  leavesRef.current = leaves;

  // --- selection -----------------------------------------------------------
  const [selRaw, setSelRaw] = React.useState(EMPTY_SELECTION);
  const visibleKeys = React.useMemo(() => new Set(leaves.map((j) => j.key)), [leaves]);
  const sel = React.useMemo(() => pruneSelection(selRaw, visibleKeys), [selRaw, visibleKeys]);
  const selRef = React.useRef(sel);
  selRef.current = sel;
  React.useEffect(() => {
    if (sel !== selRaw) setSelRaw(sel);
  }, [sel, selRaw]);

  const selectedRows = React.useMemo(
    () => leaves.filter((j) => sel.keys.has(j.key)),
    [leaves, sel],
  );

  // --- warm-intro lookups --------------------------------------------------
  const warmFor = React.useCallback(
    (job: JobView): WarmIndicator => {
      if (!warm) return null;
      const people = connectionsAt(warm.connections, job.company);
      if (people.length === 0) return null;
      return { count: people.length, first: people[0].fullName };
    },
    [warm],
  );

  /**
   * The company domain the LogoAvatar ladder needs.
   *
   * `CompanyView` does not carry a domain yet — the field arrives on
   * `feat/company-domain-logos`. Read structurally so this branch is green
   * standalone and picks the real value up the moment the column lands: with no
   * domain the ladder answers nothing and every avatar renders its monogram,
   * which is the design's own bottom rung (01 §7).
   */
  const domainFor = React.useCallback(
    (job: JobView): string | null => {
      if (!warm) return null;
      const company = universeFor(warm.universe, job.company) as
        | (Record<string, unknown> & { id: number })
        | undefined;
      const raw = company?.domain;
      return typeof raw === "string" && raw.trim() !== "" ? raw : null;
    },
    [warm],
  );

  // --- the table model -----------------------------------------------------
  const table = useReactTable({
    data: leaves,
    columns: JOBS_COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
    state: {
      columnVisibility: {
        ...Object.fromEntries([...hiddenCols].map((id) => [id, false])),
      },
    },
  });

  const rowPx = rowPxFor(display.density);
  // Columns scale with the type: large type is 18px against the 14px the widths
  // were tuned for, so fixed pixel widths would ellipsize what fit before.
  const colScale = display.typeScale === "large" ? 18 / 14 : 1;
  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowPx,
    overscan: 10,
    // Sized before the scroll element mounts, so the server (and the first
    // client render, identically) emits a real viewport of rows instead of an
    // empty rowgroup that pops in after hydration.
    initialRect: { width: 1024, height: 900 },
  });

  // A density switch changes every row height at once. Without re-measuring AND
  // re-anchoring, the virtualizer keeps the old pixel offset against new row
  // math and the viewport lands on an arbitrary slice of the list.
  const prevRowPxRef = React.useRef(rowPx);
  React.useEffect(() => {
    if (prevRowPxRef.current === rowPx) return;
    const el = scrollRef.current;
    const anchor = el ? el.scrollTop / prevRowPxRef.current : 0;
    prevRowPxRef.current = rowPx;
    virtualizer.measure();
    if (el) el.scrollTop = Math.round(anchor * rowPx);
  }, [rowPx, virtualizer]);

  // --- the detail pane -----------------------------------------------------
  const paneKey = readPaneKey(new URLSearchParams(searchKey));
  const paneJob = React.useMemo(
    () => (paneKey === null ? null : (leaves.find((j) => j.key === paneKey) ?? null)),
    [paneKey, leaves],
  );
  const [panePx, setPanePx] = React.useState(DEFAULT_PANE_PX);

  const setPane = React.useCallback(
    (key: string | null, mode: "push" | "replace") => {
      const next = withPaneKey(new URLSearchParams(searchKey), key);
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, pathname, searchKey],
  );
  const setPaneRef = React.useRef(setPane);
  setPaneRef.current = setPane;
  const paneKeyRef = React.useRef(paneKey);
  paneKeyRef.current = paneKey;

  // --- decisions -----------------------------------------------------------
  const decideOn = React.useCallback(
    (word: DecisionWord, targets: JobView[]) => {
      if (targets.length === 0) return;
      const triage = triageFor(word);
      const selSnapshot = selRef.current;
      void decide(triage, {
        targets,
        snooze: triage === "snoozed" ? localIsoDaysFromNow(SNOOZE_DAYS) : undefined,
        label: decisionToast(word, targets.length),
        undoLabel: (j) => `${decisionToast(word, 1)}: ${j.company}, ${j.title}`,
        onRevert: () => setSelRaw(selSnapshot),
      });
    },
    [decide],
  );
  const decideOnRef = React.useRef(decideOn);
  decideOnRef.current = decideOn;

  const copySelection = React.useCallback(async () => {
    const picked = leavesRef.current.filter((j) => selRef.current.keys.has(j.key));
    if (picked.length === 0) return;
    try {
      await navigator.clipboard.writeText(toTsv(picked, JOB_COLUMNS));
    } catch {
      toast.error("Couldn't copy. The browser blocked clipboard access.");
      return;
    }
    toast(`Copied ${picked.length} ${countedNoun(picked.length, "row")}`);
  }, []);

  // --- the keyboard cursor -------------------------------------------------
  const [activeIdx, setActiveIdx] = React.useState<number | null>(null);
  const activeIdxRef = React.useRef<number | null>(null);
  const moveActiveTo = React.useCallback((idx: number) => {
    activeIdxRef.current = idx;
    setActiveIdx(idx);
  }, []);
  const effActive = activeIdx === null ? null : Math.min(activeIdx, displayRows.length - 1);

  React.useEffect(() => {
    /** Nearest job row from `start` walking `dir`, skipping group headers. */
    function jobIndexFrom(start: number, dir: 1 | -1): number | null {
      let i = start;
      while (i >= 0 && i < displayRows.length && displayRows[i].kind !== "job") i += dir;
      return i >= 0 && i < displayRows.length ? i : null;
    }
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      // Text-entry controls own their keystrokes. A focused selection checkbox
      // does not: the row shortcuts must keep working after a pointer selection.
      const input = el instanceof HTMLInputElement ? el : null;
      const isTextEntry =
        el?.tagName === "TEXTAREA" ||
        el?.tagName === "SELECT" ||
        (input !== null && input.type !== "checkbox" && input.type !== "radio");
      if (isTextEntry) return;
      // A modal is modal and an open menu owns the keyboard. The detail pane is
      // deliberately NOT in this list: 03 §4 keeps the list interactive while
      // the pane is open, which is the whole difference between a pane and a
      // dialog.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "c") {
        if (selRef.current.keys.size === 0) return;
        const docSel = window.getSelection();
        if (docSel && !docSel.isCollapsed) return;
        e.preventDefault();
        void copySelection();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (displayRows.length === 0) return;

      const raw = activeIdxRef.current;
      const cur = raw === null ? null : Math.min(raw, displayRows.length - 1);
      const key = e.key.toLowerCase();

      if (key === "j" || key === "k") {
        e.preventDefault();
        const dir = key === "j" ? 1 : -1;
        const start = cur === null ? (dir === 1 ? 0 : displayRows.length - 1) : cur + dir;
        const target = jobIndexFrom(start, dir);
        if (target === null) return;
        moveActiveTo(target);
        virtualizer.scrollToIndex(target);
        const item = displayRows[target];
        if (item.kind !== "job") return;
        // j/k moves the PANE'S SUBJECT, not just the row cursor (03 §4). The
        // move replaces rather than pushes: walking twenty rows must not bury
        // Back under twenty entries.
        if (paneKeyRef.current !== null) setPaneRef.current(item.job.key, "replace");
        if (e.shiftKey) {
          const fromKey =
            cur !== null && displayRows[cur]?.kind === "job"
              ? (displayRows[cur] as { kind: "job"; job: JobView }).job.key
              : item.job.key;
          setSelRaw((s) => {
            const order = leavesRef.current.map((j) => j.key);
            const withAnchor =
              s.anchor !== null && order.includes(s.anchor)
                ? s
                : { keys: new Set([fromKey]), anchor: fromKey, lastRange: [fromKey] };
            return rangeSelect(withAnchor, order, item.job.key);
          });
        }
      } else if (e.key === "Enter") {
        if (el && /^(A|BUTTON)$/.test(el.tagName)) return;
        if (cur === null) return;
        const item = displayRows[cur];
        if (item.kind !== "job") return;
        e.preventDefault();
        setPaneRef.current(item.job.key, "push");
      } else if (key === "o") {
        if (cur === null) return;
        const item = displayRows[cur];
        if (item.kind !== "job" || !item.job.url) return;
        e.preventDefault();
        window.open(item.job.url, "_blank", "noopener,noreferrer");
      } else if (e.key === " ") {
        if (el && /^(A|BUTTON)$/.test(el.tagName)) return;
        e.preventDefault();
        if (cur === null) return;
        const item = displayRows[cur];
        if (item.kind !== "job") return;
        setSelRaw((s) => toggleSelect(s, item.job.key));
      } else if (e.key === "Escape") {
        // The pane first, then the selection: Escape unwinds one thing at a
        // time, nearest first, which is what every other surface here does.
        if (paneKeyRef.current !== null) {
          e.preventDefault();
          setPaneRef.current(null, "push");
          return;
        }
        if (selRef.current.keys.size === 0) return;
        e.preventDefault();
        setSelRaw(clearSelection());
      } else if ((key === "i" || key === "x" || key === "s") && !e.shiftKey) {
        // Bulk only: with nothing selected these keys stay inert. A stray
        // keypress silently deciding the cursor row would be a decision nobody
        // made, and silent decisions are the one thing this product must never
        // make (03 §3).
        if (selRef.current.keys.size === 0) return;
        e.preventDefault();
        const targets = leavesRef.current.filter((j) => selRef.current.keys.has(j.key));
        decideOnRef.current(key === "i" ? "Interested" : key === "x" ? "Passed" : "Later", targets);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [displayRows, virtualizer, moveActiveTo, copySelection]);

  // --- view gestures -------------------------------------------------------
  const [saveOpen, setSaveOpen] = React.useState(false);
  const activeTab =
    ctx.base.kind === "view"
      ? ctx.base.view.name
      : (VIEW_TABS.find((t) => t.set === state.set)?.name ?? "");
  const tabNames = React.useMemo(
    () => [...VIEW_TABS.map((t) => t.name), ...views.map((v) => v.name)],
    [views],
  );
  const selectTab = (name: string) => {
    const builtIn = VIEW_TABS.find((t) => t.name === name);
    if (builtIn) {
      router.push(presetUrl(builtIn.set), { scroll: false });
      return;
    }
    const view = views.find((v) => v.name === name);
    if (view) router.push(`/jobs?view=${view.id}`, { scroll: false });
  };

  // --- filter gestures -----------------------------------------------------
  const addGroup = (group: OrGroup) =>
    navigate({ ...state, filter: [...state.filter, group] }, "push");
  const removeGroupAt = (index: number) =>
    navigate({ ...state, filter: state.filter.filter((_, i) => i !== index) }, "push");
  const clearFilters = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    lastSentQ.current = null;
    setQ("");
    navigate({ ...state, filter: [], q: "" }, "push");
  };
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

  // One chip per AND group, rendered through the dictionary. A group whose
  // clauses are OR-ed reads as one sentence; the raw clause never reaches the
  // chrome (02 §5).
  const chipLabels = React.useMemo(
    () => state.filter.map((g) => filterGroupLabel(g, now)),
    [state.filter, now],
  );

  // --- the stated scope ----------------------------------------------------
  const narrowed = state.filter.length > 0 || q.trim() !== "";
  const footerText = scopeLine(sorted.length, narrowed ? setRows.length : sorted.length);
  const subtitle = headerSubtitle(rows, now);

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const colCount = table.getVisibleLeafColumns().length;
  const anySelection = sel.keys.size > 0;

  return (
    // `data-bounded-frame` asks `AppShell` for the fixed-viewport frame: this
    // surface virtualizes, so its scroll parent has to be the viewport rather
    // than a document that grows with the row canvas (row 309). It is opt-in
    // because the frame is shared and the other surfaces scroll the document.
    <div data-bounded-frame="" className="flex min-h-0 flex-1 items-stretch">
      <div
        data-testid="jobs-grid"
        data-ready={ready ? "true" : "false"}
        className="flex min-h-0 min-w-0 flex-1 flex-col p-4 md:p-6"
      >
        <PageHeader
          title="Jobs"
          subtitle={subtitle}
          action={<Button onClick={() => router.push("/add")}>Add a job</Button>}
        />

        {/* The toolbar: four controls plus Display, and nothing else in the
            chrome (03 §4). It wraps rather than overflows — the page must
            never scroll sideways at any width. */}
        <TableToolbar
          className="mt-4"
          filters={
            chipLabels.length > 0 ? (
              <FilterChipRow
                filters={chipLabels}
                onRemove={(label) => removeGroupAt(chipLabels.indexOf(label))}
                onClearAll={clearFilters}
              />
            ) : undefined
          }
        >
            {/* THE BAR'S HEIGHT MUST NOT DEPEND ON FONT METRICS — the rule
                `fix/jobs-skeleton-rail-2` establishes for the shipped bar,
                ported here because the composition it was written against is
                the one this file replaces.

                Search is the flexible filler: `flex-1` (basis 0) with
                `min-w-0`, capped at the width it used to be fixed at. Flexbox
                breaks lines on HYPOTHETICAL main size and only then shrinks, so
                a fixed 250px search can be the item that pushes the row over on
                a renderer whose text runs a few percent wide; a basis-0 one
                contributes nothing to that decision and shrinks first. At rest
                it grows straight back to its cap and the spacer below still
                takes the leftover, so nothing moves.

                The other half of that fix does not apply here: it puts the
                count on a declared breakpoint because the count shared the
                bar. In the authored design the count is the scope FOOTER under
                the table, so it can never wrap the toolbar at all. */}
            <label className="flex min-w-0 max-w-[250px] flex-1 items-center gap-2 rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm text-muted">
              <Search size={14} strokeWidth={1.75} aria-hidden />
              <input
                type="search"
                aria-label="Search roles"
                placeholder="Search roles"
                value={q}
                onChange={(e) => onQChange(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-muted"
              />
            </label>

            <SavedViewTabs
              views={tabNames}
              active={activeTab}
              dirty={ctx.navEdited}
              onSelect={selectTab}
              onSave={() => setSaveOpen(true)}
            />

            <FilterPopover rows={effRows} onAdd={addGroup} />

            <ExportMenu
              viewRows={leaves}
              selectionRows={selectedRows}
              allRows={effRows}
              columns={JOB_COLUMNS}
              testid="grid-export"
              triggerLabel={`Export ${
                selectedRows.length > 0 ? selectedRows.length : leaves.length
              } ${countedNoun(
                selectedRows.length > 0 ? selectedRows.length : leaves.length,
                "role",
              )}`}
              primary
            />

            <div className="flex-1" />

            <DisplayPopover
              columns={displayColumnList(hiddenCols)}
              onToggleColumn={(id) =>
                setHiddenCols((h) => {
                  const next = new Set(h);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              density={densityLabel(display.density)}
              onDensityChange={(d) =>
                setDisplay((p) => ({ ...p, density: densityValue(d) }))
              }
              typeSize={typeSizeLabel(display.typeScale)}
              onTypeSizeChange={(t) =>
                setDisplay((p) => ({ ...p, typeScale: typeSizeValue(t) }))
              }
              keyboardHints={display.keyboardHints}
              onKeyboardHintsChange={(on) => setDisplay((p) => ({ ...p, keyboardHints: on }))}
            />
        </TableToolbar>

        {displayRows.length === 0 ? (
          <div className="mt-4 min-h-0 flex-1 overflow-auto">
            {narrowed && setRows.length > 0 ? (
              // 02 §7's "nothing matches" template, verbatim: what is being
              // filtered, the unfiltered count, the action.
              <EmptyState
                icon={SearchX}
                title="No roles match these filters."
                description={`${setRows.length} ${countedNoun(setRows.length, "role")} total.`}
              >
                <Button variant="primary" onClick={clearFilters}>
                  Clear filters
                </Button>
              </EmptyState>
            ) : rows.length === 0 ? (
              // "Nothing yet", not "nothing matches" — 04 §3 defers the true
              // first run to Today's teaching state and points this one at
              // coverage.
              <EmptyState
                title="Roles from your scans will appear here."
                description="Nothing has been found yet."
              >
                <Button onClick={() => router.push("/companies")}>Check coverage</Button>
              </EmptyState>
            ) : (
              <EmptyState
                title="No roles in this view."
                description={`${rows.length} ${countedNoun(rows.length, "role")} total.`}
              >
                <Button variant="primary" onClick={() => router.push(presetUrl("all"))}>
                  Show all roles
                </Button>
              </EmptyState>
            )}
          </div>
        ) : (
          <div
            ref={scrollRef}
            data-testid="grid-scroll"
            role="region"
            aria-label="Roles, scrollable"
            tabIndex={0}
            // This table scales its own type AND its column widths together
            // (`colScale`), so the per-user type-scale tokens must not scale it
            // a second time. See the opt-out block in globals.css.
            data-type-scale-scope="own"
            className={cn(
              "mt-4 min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              // Every branch names a size, including the default one: a subtree
              // that opts out of an inherited scale has to state its own.
              display.typeScale === "large"
                ? "text-lg"
                : display.density === "comfortable"
                  ? "text-base"
                  : "text-sm",
            )}
          >
            <div
              role="grid"
              aria-label="Roles"
              aria-rowcount={displayRows.length + 1}
              aria-multiselectable="true"
              className="w-max min-w-full"
            >
              <div
                role="row"
                aria-rowindex={1}
                className="sticky top-0 z-20 flex border-b border-border-strong bg-surface"
                style={{ height: rowPx }}
              >
                {headers.map((h) => {
                  const meta = h.column.columnDef.meta;
                  const sortField = meta?.sortField;
                  const dir =
                    sortField && state.sort?.field === sortField ? state.sort.dir : null;
                  const label = String(h.column.columnDef.header ?? "");
                  return (
                    <div
                      key={h.id}
                      role="columnheader"
                      data-col={h.column.id}
                      aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}
                      style={colStyle(h.column, colScale)}
                      // Sentence case, weight 500, `text-2` (01 §8). No
                      // uppercase and no letter-spacing: the shipped header was
                      // `uppercase tracking-wider`, which is rejection-checklist
                      // item 01 §12.9 and the single most visible tell on the
                      // whole surface.
                      className={cn(
                        "flex min-w-0 items-center overflow-hidden px-2 text-xs font-medium text-text-2",
                        meta?.align === "right" && "justify-end",
                        meta?.sticky && "sticky left-0 z-10 bg-surface",
                      )}
                    >
                      {sortField ? (
                        <button
                          type="button"
                          onClick={() => cycleSort(sortField)}
                          title={`Sort by ${label}`}
                          className={cn(
                            "flex min-w-0 items-center gap-1 hover:text-text",
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
                  const item = displayRows[vi.index];
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
                          <span className="sticky left-0 flex max-w-full items-baseline gap-2 px-2 text-xs">
                            <span className="truncate font-medium">{item.label}</span>
                            <span className="tabular-nums text-muted">{item.count}</span>
                          </span>
                        </div>
                      </div>
                    );
                  }
                  const row = tableRows[item.leafIndex];
                  const job = row.original;
                  const cells = jobRow(job, now, warmFor(job));
                  const isActive = effActive === vi.index;
                  const isSelected = sel.keys.has(job.key);
                  const isPaneSubject = paneKey === job.key;
                  return (
                    <div
                      key={row.id}
                      role="row"
                      aria-rowindex={vi.index + 2}
                      aria-selected={isSelected}
                      data-active={isActive ? "true" : undefined}
                      data-key={job.key}
                      onClick={(e) => {
                        // Links, buttons and the checkbox own their own click.
                        if ((e.target as HTMLElement).closest("a,button,input,label")) return;
                        moveActiveTo(vi.index);
                        // Row click opens the pane (03 §4). Selection lives on
                        // the checkbox track, per 01 §8 — this is the one
                        // gesture that changed meaning in the redesign.
                        setPane(job.key, "push");
                      }}
                      // Positioned with `top`, not translateY: a transform on
                      // the row makes it the containing block for its children
                      // and position:sticky on the company cell silently stops
                      // sticking.
                      className={cn(
                        "group absolute inset-x-0 flex border-b border-border",
                        isSelected
                          ? "bg-selected [&_.text-muted]:text-text-2"
                          : isPaneSubject
                            ? "bg-raised"
                            : "hover:bg-raised",
                        isActive && "ring-1 ring-inset ring-ring",
                      )}
                      style={{ height: rowPx, top: vi.start }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta;
                        const id = cell.column.id;
                        return (
                          <div
                            key={cell.id}
                            role="gridcell"
                            data-col={id}
                            style={colStyle(cell.column, colScale)}
                            className={cn(
                              "flex min-w-0 items-center overflow-hidden px-2",
                              id === SELECT_COLUMN_ID && "justify-center px-0",
                              meta?.align === "right" && "justify-end tabular-nums",
                              meta?.sticky &&
                                (isSelected
                                  ? "sticky left-0 z-10 bg-selected"
                                  : "sticky left-0 z-10 bg-surface group-hover:bg-raised"),
                            )}
                          >
                            {id === SELECT_COLUMN_ID ? (
                              <RowCheckbox
                                checked={isSelected}
                                visible={anySelection}
                                label={`Select ${job.company}, ${job.title}`}
                                onToggle={(shift) =>
                                  setSelRaw((s) =>
                                    shift
                                      ? rangeSelect(s, leaves.map((j) => j.key), job.key)
                                      : toggleSelect(s, job.key),
                                  )
                                }
                              />
                            ) : id === "company" ? (
                              <span className="flex min-w-0 items-center gap-2">
                                <LogoAvatar name={job.company} domain={domainFor(job)} size={16} />
                                <span className="truncate font-medium" title={job.company}>
                                  {job.company}
                                </span>
                                {warm ? (
                                  <WarmCell
                                    indicator
                                    company={job.company}
                                    title={job.title}
                                    companyId={
                                      universeFor(warm.universe, job.company)
                                        ?.linkedinCompanyId ?? ""
                                    }
                                    linkedinIdSource={
                                      universeFor(warm.universe, job.company)
                                        ?.linkedinIdSource ?? ""
                                    }
                                    connections={connectionsAt(warm.connections, job.company)}
                                    universeId={
                                      universeFor(warm.universe, job.company)?.id ?? null
                                    }
                                    companyUpdatedAt={
                                      universeFor(warm.universe, job.company)
                                        ?.companyUpdatedAt ?? null
                                    }
                                    hasAnyConnections={warm.hasAnyConnections}
                                  />
                                ) : null}
                              </span>
                            ) : id === "title" ? (
                              <span className="truncate text-text-2" title={job.title}>
                                {job.title}
                              </span>
                            ) : id === "pay" ? (
                              <Cell value={cells.pay} />
                            ) : id === "locationModel" ? (
                              <Cell value={cells.locationModel} muted />
                            ) : id === "posted" ? (
                              <Cell value={cells.posted} />
                            ) : id === "decision" ? (
                              <StatusSelect
                                value={cells.decision}
                                disabled={busy}
                                className="gap-1 whitespace-nowrap px-1 text-xs"
                                onSelect={(next) => decideOn(next, [job])}
                              />
                            ) : id === "warmIntro" && warmIntro ? (
                              // Rendered HERE, not in the column def, for the
                              // reason the file header states: `WarmIntroCell`
                              // reaches the warm routes and server actions, and
                              // `jobs-columns.tsx` has to stay importable from a
                              // Vitest unit test.
                              <WarmIntroCell
                                targetKind="posting"
                                postingKey={job.key}
                                company={job.company}
                                title={job.title}
                                defaultParams={warmIntro.defaultParams}
                                pins={pinsForRow(warmIntro, {
                                  postingKey: job.key,
                                  company: job.company,
                                })}
                              />
                            ) : null}
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

        {/* The footer states scope: "47 roles", or "12 of 47 match your
            filters" (01 §8). The number shown equals the number acted on. */}
        <p
          data-testid="grid-count"
          className="mt-2 shrink-0 text-xs tabular-nums text-muted"
        >
          {footerText}
        </p>

        {display.keyboardHints && displayRows.length > 0 && selectedRows.length === 0 ? (
          <p
            data-testid="grid-hints"
            className="hidden shrink-0 items-center justify-end gap-x-1 whitespace-nowrap pt-2
                       text-2xs text-muted sm:flex"
          >
            <Kbd>j</Kbd> <Kbd>k</Kbd> rows, <Kbd>Enter</Kbd> details, <Kbd>o</Kbd> open posting,{" "}
            <Kbd>Space</Kbd> select, <Kbd>i</Kbd> <Kbd>x</Kbd> <Kbd>s</Kbd> decide selection,{" "}
            <Kbd>⌘C</Kbd> copy
          </p>
        ) : null}

        {selectedRows.length > 0 ? (
          <div className="fixed inset-x-2 bottom-4 z-30 flex min-w-0 justify-center">
            <SelectionBar
              count={selectedRows.length}
              busy={busy}
              onInterested={() => decideOn("Interested", selectedRows)}
              onPass={() => decideOn("Passed", selectedRows)}
              onLater={() => decideOn("Later", selectedRows)}
              onClear={() => setSelRaw(clearSelection())}
              extra={
                <>
                  <Button onClick={() => void copySelection()} keyHint="⌘C">
                    Copy
                  </Button>
                  <ExportMenu
                    viewRows={leaves}
                    selectionRows={selectedRows}
                    allRows={effRows}
                    columns={JOB_COLUMNS}
                    testid="sel-export"
                  />
                </>
              }
            />
          </div>
        ) : null}
      </div>

      {paneJob ? (
        <DetailPane
          {...paneModel(paneJob, now, warmFor(paneJob))}
          domain={domainFor(paneJob)}
          busy={busy}
          width={panePx}
          onWidthChange={setPanePx}
          onClose={() => setPane(null, "push")}
          onDecide={(word) => decideOn(word === "Pass" ? "Passed" : word, [paneJob])}
        />
      ) : null}

      <SaveViewDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        base={ctx.base.kind === "view" ? ctx.base.view : null}
        nav={state}
        display={{
          density: display.density,
          typeScale: display.typeScale,
          hints: display.keyboardHints,
        }}
        onSaved={(v) => {
          router.push(`/jobs?view=${v.id}`, { scroll: false });
          router.refresh();
        }}
        onDeleted={() => {
          router.push(presetUrl("queue"), { scroll: false });
          router.refresh();
        }}
        onConflict={() => {
          const b = ctxRef.current.base;
          if (b.kind === "view") router.push(`/jobs?view=${b.view.id}`, { scroll: false });
          router.refresh();
        }}
      />
    </div>
  );
}

/**
 * "47 roles, updated 3h ago" — operating information only (PageHeader's rule).
 *
 * "Updated" is the newest change this table knows about, which is the newest
 * `updatedAt` across the rows. When no row carries one, the clause is dropped
 * rather than guessed: a timestamp nobody can source is worse than no timestamp.
 */
function headerSubtitle(rows: JobView[], now: number): string {
  const count = `${rows.length} ${rows.length === 1 ? "role" : "roles"}`;
  let newest: number | null = null;
  for (const r of rows) {
    if (!r.updatedAt) continue;
    const t = new Date(r.updatedAt).getTime();
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  if (newest === null) return count;
  const hours = Math.floor((now - newest) / 3_600_000);
  if (hours < 1) return `${count}, updated just now`;
  if (hours < 24) return `${count}, updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${count}, updated ${days}d ago`;
}

/** Truncating text cell. The full string rides on title= so truncation hides
 *  pixels, never data. "Not listed" is muted and carries no tooltip. */
function Cell({ value, muted = false }: { value: string; muted?: boolean }) {
  const unstated = value === "Not listed";
  return (
    <span
      className={cn("truncate", (unstated || muted) && "text-muted", unstated && "text-muted")}
      title={unstated ? undefined : value}
    >
      {value}
    </span>
  );
}

/**
 * The row checkbox.
 *
 * Visible on hover and while any selection is active (01 §8), and it is a real
 * `<input type="checkbox">` rather than a styled span: the shipped grid made
 * the whole ROW the selection gesture, so there was nothing for a keyboard or a
 * screen reader to operate. Now that the row click opens the pane, the checkbox
 * is the only pointer path to a selection and it has to be a control.
 */
function RowCheckbox({
  checked,
  visible,
  label,
  onToggle,
}: {
  checked: boolean;
  visible: boolean;
  label: string;
  onToggle: (shift: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={() => {}}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.shiftKey);
      }}
      className={cn(
        "size-4 cursor-pointer accent-[var(--accent)]",
        !checked && !visible && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    />
  );
}

/**
 * One width recipe for header and body cells — deriving both from the same
 * function is what keeps their column edges aligned. Fixed columns neither grow
 * nor shrink; Title (grow) absorbs all leftover width.
 */
function colStyle(col: Column<JobView, unknown>, scale: number): React.CSSProperties {
  return {
    width: col.getSize() * scale,
    flex: col.columnDef.meta?.grow ? "1 0 auto" : "0 0 auto",
  };
}
