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
import { setTriageAction } from "@/app/(app)/queue/actions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import type { BulkTriageInput, BulkWriteResult, WriteResult } from "@/lib/data/source";
import type { JobView, SavedView, Triage } from "@/lib/data/view-models";
import { localIsoDaysFromNow } from "@/lib/dates";
import { toTsv } from "@/lib/export/delimited";
import { GRID_COLUMNS, HEADER_PX } from "@/lib/grid/columns";
import { applyFilter, compUnknownCount, quickSearch, type OrGroup } from "@/lib/grid/filter";
import { rowsForSet, type PersonaPreset, type WorkingSet } from "@/lib/grid/presets";
import {
  clearSelection,
  clickSelect,
  exportColumnsFor,
  pruneSelection,
  rangeSelect,
  toggleSelect,
  EMPTY_SELECTION,
} from "@/lib/grid/selection";
import { dequeue, enqueue, takeDelivered } from "@/lib/outbox";
import {
  displayLeaves,
  flattenGroups,
  sortRows,
  type GroupBy,
  type SortField,
} from "@/lib/grid/sort";
import { serializeGridState, type GridUrlState } from "@/lib/grid/url-state";
import { WarmCell } from "@/components/warm-cell";
import { connectionsAt, universeFor, type WarmContext } from "@/lib/referral/match";
import {
  displayEquals,
  presetUrl,
  resolveGridContext,
  rowPxFor,
  type DisplayState,
} from "@/lib/grid/view-state";
import { cn } from "@/lib/utils";
import { setTriageBulkAction } from "./bulk-actions";
import ExportMenu from "./export-menu";
import FilterBar from "./filter-bar";
import SelectionBar from "./selection-bar";
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
 *
 * G4 adds selection + bulk triage. Two rules carried over from the queue,
 * because they are the same rules: every gesture is optimistic with an honest
 * failure path (conflict reverts EVERYTHING — the batch is atomic, so the
 * screen must be too), and an undeliverable decision is kept in the outbox,
 * never silently dropped. Selection itself is the pure model in
 * lib/grid/selection.ts; this component only wires gestures to it and prunes
 * it against the visible rows, so a filtered-away row can never ride along in
 * a copy, an export, or a bulk decision.
 */

/** Same window as the queue's — one undo vocabulary everywhere. */
const UNDO_MS = 8000;
const SNOOZE_DAYS = 3;

/** The queue's labelFor, pluralized. One noun ("roles") shared with the
 *  export dialog's copy, so the two surfaces do not name rows differently. */
function bulkLabel(triage: Triage, jobs: JobView[]): string {
  const who =
    jobs.length === 1 ? `${jobs[0].company} — ${jobs[0].title}` : `${jobs.length} roles`;
  if (triage === "interested") return `Saved ${who}`;
  if (triage === "dismissed") return `Passed on ${who}`;
  if (triage === "snoozed") return `Snoozed ${who}`;
  return `Restored ${who}`;
}

export default function JobsGrid({
  rows,
  now,
  views,
  warm,
}: {
  rows: JobView[];
  now: number;
  views: SavedView[];
  /**
   * The warm-path indexes, built server-side once per render (0013).
   *
   * Optional because the perf harness (`?perf=5000`) is deliberately store-free
   * — it measures render budgets and has no universe to match against — and the
   * Warm cell renders a dash rather than guessing when it is absent.
   */
  warm?: WarmContext;
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

  // Optimistic overlay for bulk triage. The server list stays the base (so
  // router.refresh() keeps working for saved-view flows); a write patches rows
  // by key on top of it. The fresher version wins on merge: after a refresh
  // the server may already hold what a patch was holding — or newer, from
  // another device — and an optimistic overlay must never beat a fresher read.
  const [patches, setPatches] = React.useState<ReadonlyMap<string, JobView>>(new Map());
  const patchesRef = React.useRef(patches);
  patchesRef.current = patches;
  const effRows = React.useMemo(() => {
    if (patches.size === 0) return rows;
    return rows.map((r) => {
      const p = patches.get(r.key);
      if (!p) return r;
      if (r.updatedAt !== null && p.updatedAt !== null && r.updatedAt > p.updatedAt) return r;
      return p;
    });
  }, [rows, patches]);

  // The row pipeline, in stated order: working set → filter → quick search →
  // sort → group-flatten. Each stage is a pure module with its own unit tests;
  // this component only composes them.
  const setRows = React.useMemo(() => rowsForSet(effRows, state.set), [effRows, state.set]);
  const visible = React.useMemo(
    () => quickSearch(applyFilter(setRows, state.filter, now), q),
    [setRows, state.filter, now, q],
  );
  const sorted = React.useMemo(() => sortRows(visible, state.sort), [visible, state.sort]);
  const display = React.useMemo(() => flattenGroups(sorted, state.group), [sorted, state.group]);
  const leaves = React.useMemo(() => displayLeaves(display), [display]);
  const leavesRef = React.useRef(leaves);
  leavesRef.current = leaves;

  // --- selection (G4) ------------------------------------------------------
  // Raw state + a derived prune against the CURRENT visible rows. The derived
  // value is what every consumer (bar, copy, export, bulk) reads, so a row a
  // filter just hid is out of scope synchronously; the effect then commits the
  // prune so widening the filter later cannot resurrect it. pruneSelection
  // returns the same object when nothing changed — no set-state loop.
  const [selRaw, setSelRaw] = React.useState(EMPTY_SELECTION);
  const visibleKeys = React.useMemo(() => new Set(leaves.map((j) => j.key)), [leaves]);
  const sel = React.useMemo(() => pruneSelection(selRaw, visibleKeys), [selRaw, visibleKeys]);
  const selRef = React.useRef(sel);
  selRef.current = sel;
  React.useEffect(() => {
    if (sel !== selRaw) setSelRaw(sel);
  }, [sel, selRaw]);

  /** Selected rows in display order — the exact payload copy/export receive.
   *  Filtered over LEAVES, not the full row set: the order-intersection is the
   *  second, independent enforcement of the prune rule, so even a pruning bug
   *  cannot put an invisible row into a clipboard or a file. */
  const selectedRows = React.useMemo(
    () => leaves.filter((j) => sel.keys.has(j.key)),
    [leaves, sel],
  );

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
      columnVisibility: {
        why: whyVisible,
        decision: state.set === "all",
        // Hidden with no context to render — which in practice means the perf
        // harness, since `?perf=5000` is the one path that renders this grid
        // without a warm context. A column of dashes on 5,000 rows is a rail
        // that costs the reader width and says nothing.
        //
        // **STATED COST: `grid-perf.spec.ts` therefore never measures the Warm
        // cell.** That spec is the branch's render budget — rendered rows ≤ 80,
        // client TTI under 4× CPU throttle, no long task over 200ms across a
        // 30-viewport scroll — and this line structurally excludes the newest
        // per-row component from all of it, including the `Popover.Root` each
        // painted Warm cell mounts.
        //
        // Not closed, and the reason is that closing it honestly means giving
        // the harness a synthetic universe and 5,000 synthetic connections, at
        // which point the budget measures the fixture generator as much as the
        // grid. The bound that makes this acceptable is a real one rather than
        // an argument: react-virtual paints ~80 rows, so at most ~80 popover
        // roots exist at any scroll position no matter how many rows the store
        // holds — the count does not grow with the data. If the Warm cell ever
        // grows work that is not per-painted-row (a subscription, an effect with
        // a timer, an observer), that bound stops holding and the harness has to
        // learn to build a warm context.
        warm: warm !== undefined,
      },
    },
  });

  // Copy/export column contract: the visible columns in view order, mapped
  // through JOB_COLUMNS (+ URL) — computed from the same table state that
  // paints the header, so the file can never carry a column the screen hides.
  const exportCols = exportColumnsFor(table.getVisibleLeafColumns().map((c) => c.id));
  const exportColsRef = React.useRef(exportCols);
  exportColsRef.current = exportCols;

  const rowPx = rowPxFor(displayState.density);
  // Columns scale with the type: large type is 18px against the 14px the widths
  // were tuned for, so the fixed pixel widths would ellipsize what fit before.
  const colScale = displayState.typeScale === "large" ? 18 / 14 : 1;
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

  // --- bulk triage (G4) ----------------------------------------------------

  const [bulkBusy, setBulkBusy] = React.useState(false);
  const busyRef = React.useRef(false);

  const patchRows = React.useCallback((next: JobView[]) => {
    setPatches((p) => {
      const merged = new Map(p);
      for (const r of next) merged.set(r.key, r);
      return merged;
    });
  }, []);

  /** Put back exactly what a key held before the gesture — including "no
   *  patch at all", which deleting alone would get wrong for a row an earlier
   *  gesture had already patched. */
  const restorePatches = React.useCallback(
    (snapshot: ReadonlyArray<readonly [string, JobView | undefined]>) => {
      setPatches((p) => {
        const merged = new Map(p);
        for (const [k, v] of snapshot) {
          if (v === undefined) merged.delete(k);
          else merged.set(k, v);
        }
        return merged;
      });
    },
    [],
  );

  const copySelection = React.useCallback(async () => {
    const picked = leavesRef.current.filter((j) => selRef.current.keys.has(j.key));
    if (picked.length === 0) return;
    try {
      await navigator.clipboard.writeText(toTsv(picked, exportColsRef.current));
    } catch {
      // Clipboard access is permission-gated; a copy that silently did nothing
      // would be pasted-into-a-sheet as an empty surprise.
      toast.error("Couldn't copy — the browser blocked clipboard access.");
      return;
    }
    toast(`Copied ${picked.length} ${picked.length === 1 ? "row" : "rows"}`);
  }, []);

  /**
   * Undo one row the background flush delivered while its toast was up — the
   * queue's undoDelivered, except the grid restores the row's PRIOR triage
   * (a bulk gesture in All postings may start from any value, not just "").
   */
  const undoDeliveredRow = React.useCallback(
    async (written: JobView, prior: JobView) => {
      const input = {
        postingKey: written.key,
        triage: prior.triage,
        snoozeUntil: prior.triage === "snoozed" ? (prior.snoozeUntil ?? null) : null,
        idempotencyKey: crypto.randomUUID(),
        expectedUpdatedAt: written.updatedAt,
      };
      let undo: WriteResult;
      try {
        undo = await setTriageAction(input);
      } catch {
        // The undo never reached the server: hold it, don't drop it.
        const idem = crypto.randomUUID();
        enqueue({
          id: idem,
          input: { ...input, idempotencyKey: idem },
          label: `Undo ${bulkLabel(written.triage, [written])}`,
          queuedAt: Date.now(),
          reason: "offline",
        });
        patchRows([{ ...written, triage: prior.triage, snoozeUntil: input.snoozeUntil }]);
        return;
      }
      if (undo.ok) {
        patchRows([undo.job]);
        return;
      }
      if (undo.kind === "auth") {
        toast.error("Couldn't undo — your session expired.", {
          description: "Sign in and try again.",
        });
      } else if (undo.kind === "conflict") {
        toast.warning("Couldn't undo — this was changed somewhere else.");
      } else {
        toast.error("Couldn't undo that.", { description: undo.message });
      }
    },
    [patchRows],
  );

  /**
   * The ONE undo for a delivered batch: the inverse batch, fresh idempotency
   * key, guarded by the updatedAt values the delivery returned. The data layer
   * applies one triage per call, so a selection whose rows had MIXED prior
   * values partitions by prior (triage, wake date) — almost always one group,
   * since the queue set is all-undecided by definition.
   */
  const undoBulk = React.useCallback(
    async (written: JobView[], priors: JobView[]) => {
      type Group = { triage: Triage; snoozeUntil: string | null; written: JobView[] };
      const groups = new Map<string, Group>();
      for (let i = 0; i < written.length; i++) {
        const p = priors[i];
        const snoozeUntil = p.triage === "snoozed" ? (p.snoozeUntil ?? null) : null;
        const gk = `${p.triage}|${snoozeUntil ?? ""}`;
        let g = groups.get(gk);
        if (!g) groups.set(gk, (g = { triage: p.triage, snoozeUntil, written: [] }));
        g.written.push(written[i]);
      }
      for (const g of groups.values()) {
        let res: BulkWriteResult;
        try {
          res = await setTriageBulkAction({
            postingKeys: g.written.map((w) => w.key),
            triage: g.triage,
            snoozeUntil: g.snoozeUntil,
            idempotencyKey: crypto.randomUUID(),
            expectedUpdatedAt: g.written.map((w) => w.updatedAt),
          });
        } catch {
          // Offline mid-undo: same doctrine as the queue — the undo is a
          // decision, it goes to the outbox and the rows read as undone.
          for (const w of g.written) {
            const idem = crypto.randomUUID();
            enqueue({
              id: idem,
              input: {
                postingKey: w.key,
                triage: g.triage,
                snoozeUntil: g.snoozeUntil,
                idempotencyKey: idem,
                expectedUpdatedAt: w.updatedAt,
              },
              label: `Undo ${bulkLabel(w.triage, [w])}`,
              queuedAt: Date.now(),
              reason: "offline",
            });
          }
          patchRows(
            g.written.map((w) => ({ ...w, triage: g.triage, snoozeUntil: g.snoozeUntil })),
          );
          continue;
        }
        if (res.ok) {
          patchRows(res.jobs);
          continue;
        }
        if (res.kind === "auth") {
          toast.error("Couldn't undo — your session expired.", {
            description: "Sign in and try again.",
          });
        } else if (res.kind === "conflict") {
          toast.warning("Couldn't undo — this was changed somewhere else.");
          router.refresh();
        } else {
          toast.error("Couldn't undo that.", { description: res.message });
        }
      }
    },
    [patchRows, router],
  );

  /**
   * One decision, N rows, one transaction, one undo. The optimistic update
   * lands first (in the Queue set the rows leave the screen, exactly like the
   * queue's cards); the failure branches mirror triage-queue.tsx because they
   * are the same failures — with one difference the atomicity contract forces:
   * a conflict reverts EVERY row, since the store applied none of them.
   */
  const bulkDecide = React.useCallback(
    async (triage: Triage, snooze?: string) => {
      if (busyRef.current) return;
      const targets = leavesRef.current.filter((j) => selRef.current.keys.has(j.key));
      if (targets.length === 0) return;
      busyRef.current = true;
      setBulkBusy(true);

      const priors = targets.map((j) => ({ ...j }));
      const selSnapshot = selRef.current;
      const patchSnapshot = targets.map(
        (j) => [j.key, patchesRef.current.get(j.key)] as const,
      );
      const snoozeUntil = triage === "snoozed" ? (snooze ?? null) : null;
      patchRows(targets.map((j) => ({ ...j, triage, snoozeUntil })));

      const idem = crypto.randomUUID();
      const input: BulkTriageInput = {
        postingKeys: targets.map((j) => j.key),
        triage,
        snoozeUntil,
        idempotencyKey: idem,
        expectedUpdatedAt: targets.map((j) => j.updatedAt),
      };
      const label = bulkLabel(triage, targets);

      /**
       * Hold, don't discard (the queue's rule). The outbox speaks single-row
       * gestures, so a deferred batch rides as N entries under derived keys —
       * the flush delivers them row by row, which forfeits atomicity but not
       * the decisions; the atomic path needed the server, and the server was
       * the thing we could not reach.
       */
      const defer = (reason: "offline" | "auth") => {
        for (let i = 0; i < targets.length; i++) {
          enqueue({
            id: `${idem}:${i}`,
            input: {
              postingKey: targets[i].key,
              triage,
              snoozeUntil,
              idempotencyKey: `${idem}:${i}`,
              expectedUpdatedAt: targets[i].updatedAt,
            },
            label: bulkLabel(triage, [targets[i]]),
            queuedAt: Date.now(),
            reason,
          });
        }
        busyRef.current = false;
        setBulkBusy(false);
        toast(label, {
          description:
            reason === "auth"
              ? "Saved on this device — sign in to apply it."
              : "Saved on this device — it'll sync when you're back online.",
          action: {
            label: "Undo",
            onClick: () => {
              // Row by row, the queue's three-way branch: still local (drop
              // it), delivered behind our back (compensating write), or gone
              // without a trace (say so — restoring the row would lie).
              let lost = 0;
              for (let i = 0; i < targets.length; i++) {
                if (dequeue(`${idem}:${i}`)) {
                  restorePatches([patchSnapshot[i]]);
                  continue;
                }
                const w = takeDelivered(`${idem}:${i}`);
                if (w) void undoDeliveredRow(w, priors[i]);
                else lost++;
              }
              if (lost > 0) {
                toast.error(
                  lost === targets.length
                    ? "Couldn't undo that."
                    : `Couldn't undo ${lost} of them.`,
                  {
                    description:
                      "The decision already left this device. Reload to see where it landed.",
                  },
                );
              }
            },
          },
          duration: UNDO_MS,
        });
      };

      let result: BulkWriteResult;
      try {
        result = await setTriageBulkAction(input);
      } catch {
        defer("offline");
        return;
      }
      if (!result.ok && result.kind === "auth") {
        defer("auth");
        return;
      }
      busyRef.current = false;
      setBulkBusy(false);

      if (result.ok) {
        // The server's rows, not the optimistic guesses: their updatedAt is
        // what makes the undo batch conflict-checkable (the queue's stale-
        // object lesson, applied N-wide).
        patchRows(result.jobs);
        const written = result.jobs;
        toast(label, {
          action: { label: "Undo", onClick: () => void undoBulk(written, priors) },
          duration: UNDO_MS,
        });
        return;
      }

      // All-or-nothing came back as nothing: every row reverts, including the
      // ones that would have succeeded alone — showing them decided while the
      // store holds nothing is the half-applied screen the transaction exists
      // to rule out. The selection comes back too, so a retry is one keypress.
      restorePatches(patchSnapshot);
      setSelRaw(selSnapshot);
      if (result.kind === "conflict") {
        toast.warning("Changed on another device — nothing was applied. Showing the latest.");
        router.refresh();
        return;
      }
      toast.error("Couldn't save that.", {
        description: result.message,
        action: { label: "Retry", onClick: () => void bulkDecide(triage, snooze) },
      });
    },
    [patchRows, restorePatches, undoBulk, undoDeliveredRow, router],
  );

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
      // ⌘C with rows selected: the grid owns copy. With none — or with real
      // text highlighted — the browser keeps its native copy untouched.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "c") {
        if (selRef.current.keys.size === 0) return;
        const docSel = window.getSelection();
        if (docSel && !docSel.isCollapsed) return;
        e.preventDefault();
        void copySelection();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (display.length === 0) return;

      const raw = activeIdxRef.current;
      const cur = raw === null ? null : Math.min(raw, display.length - 1);
      const key = e.key.toLowerCase();

      if (key === "j" || key === "k") {
        e.preventDefault();
        const dir = key === "j" ? 1 : -1;
        // The first press parks on the nearest end rather than skipping row 1.
        const start = cur === null ? (dir === 1 ? 0 : display.length - 1) : cur + dir;
        const target = jobIndexFrom(start, dir);
        if (target === null) return; // already at the edge
        moveActiveTo(target);
        setWhyOpen(null);
        virtualizer.scrollToIndex(target);
        if (e.shiftKey) {
          // Shift+j/k: extend the selection from the anchor to the cursor.
          // With no anchor yet, the row the cursor came FROM becomes it, so
          // the first extension selects both ends the way a hand expects.
          const item = display[target];
          if (item.kind !== "job") return;
          const fromKey =
            cur !== null && display[cur]?.kind === "job"
              ? (display[cur] as { kind: "job"; job: JobView }).job.key
              : item.job.key;
          setSelRaw((s) => {
            const order = leavesRef.current.map((j) => j.key);
            const withAnchor =
              s.anchor !== null && order.includes(s.anchor) ? s : clickSelect(fromKey);
            return rangeSelect(withAnchor, order, item.job.key);
          });
        }
      } else if (e.key === " ") {
        // Not from a button or link: Space is activation there, and firing
        // both would toggle a row the user only meant to press a control.
        if (el && /^(A|BUTTON)$/.test(el.tagName)) return;
        e.preventDefault();
        if (cur === null) return;
        const item = display[cur];
        if (item.kind !== "job") return;
        setSelRaw((s) => toggleSelect(s, item.job.key));
      } else if (e.key === "Escape") {
        if (selRef.current.keys.size === 0) return;
        e.preventDefault();
        setSelRaw(clearSelection());
      } else if ((key === "i" || key === "x" || key === "s") && !e.shiftKey) {
        // Bulk only: with nothing selected these keys stay inert — single-row
        // triage is the queue's surface, and a stray keypress silently
        // deciding the active row here would be a decision nobody made.
        if (selRef.current.keys.size === 0) return;
        e.preventDefault();
        if (key === "i") void bulkDecide("interested");
        else if (key === "x") void bulkDecide("dismissed");
        else void bulkDecide("snoozed", localIsoDaysFromNow(SNOOZE_DAYS));
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
  }, [display, virtualizer, moveActiveTo, bulkDecide, copySelection]);

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

  // Both Export menus (toolbar and selection bar) state counts from the same
  // arrays the grid renders — the stated number IS the file's number.
  const exportMenuFor = (testid: string) => (
    <ExportMenu
      viewRows={leaves}
      selectionRows={selectedRows}
      allRows={effRows}
      columns={exportCols}
      testid={testid}
    />
  );

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
        rows={effRows}
        // Visible on every viewport: it is the only control for which set or
        // view is shown, and hiding it on a phone would leave a phone user no
        // on-screen way to leave the Queue. It replaced the standalone Queue/All
        // toggle that used to be the phone's set control, and a single compact
        // dropdown trigger is narrower than that two-button toggle — so the bar
        // height the loading skeleton mirrors is unchanged.
        switcher={
          <>
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
            {/* Export sits beside the switcher: scope is a property of the
                view, and the menu's "Current view" line names whatever the
                switcher currently shows (H22). Desktop chrome, like the Group
                select — at rest the phone bar holds one line (the loading
                skeleton pins that height, and this button wrapped it to two:
                the loaded rail landed 34px below the skeleton's, matrix row
                7's jump, caught by grid.spec's rail test on the mobile
                project). A phone still reaches every scope: selecting any row
                puts the same menu in the selection bar. */}
            <span className="hidden sm:block">{exportMenuFor("grid-export")}</span>
          </>
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
          // This grid scales its own type AND its column widths together
          // (`colScale`), so the per-user `data-type-scale` cookie must not scale
          // it a second time — the two compounded and clipped the comp band. See
          // the opt-out block in globals.css.
          data-type-scale-scope="own"
          className={cn(
            "min-h-0 flex-1 overflow-auto bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            // Type scale: the container's font-size cascades into every cell
            // (cells set no size of their own). Never html { font-size } —
            // that would fight the 200%-zoom test and rescale the chrome.
            // Every branch names a size, including the default one. Leaving the
            // dense case to inherit was fine until the per-user `data-type-scale`
            // cookie existed: the container then inherited the SCALED body size in
            // px, so switching the view to "Large type" resolved `--text-lg` (a
            // token the opt-out pins to its default) to the SAME 16px it had
            // already inherited — the view's own control silently stopped working.
            // A subtree that opts out of an inherited scale has to state its size.
            displayState.typeScale === "large"
              ? "text-lg"
              : displayState.density === "comfortable"
                ? "text-base"
                : "text-sm",
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
            aria-multiselectable="true"
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
                    style={colStyle(h.column, colScale)}
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
                const isSelected = sel.keys.has(row.original.key);
                const isOpenRow = openJob?.key === row.original.key;
                return (
                  <div
                    key={row.id}
                    role="row"
                    aria-rowindex={vi.index + 2}
                    aria-selected={isSelected}
                    data-active={isActive ? "true" : undefined}
                    data-key={row.original.key}
                    onMouseDown={(e) => {
                      // Shift-click extends the range; without this the same
                      // gesture also smears a text selection across it.
                      if (e.shiftKey) e.preventDefault();
                    }}
                    onClick={(e) => {
                      // Links open and chips explain — a click on them is not
                      // a selection gesture.
                      if ((e.target as HTMLElement).closest("a,button")) return;
                      moveActiveTo(vi.index);
                      const k = row.original.key;
                      const order = leaves.map((j) => j.key);
                      setSelRaw((s) =>
                        e.shiftKey
                          ? rangeSelect(s, order, k)
                          : e.metaKey || e.ctrlKey
                            ? toggleSelect(s, k)
                            : clickSelect(k),
                      );
                    }}
                    // Positioned with `top`, not translateY: a transform on
                    // the row makes it the containing block for its children
                    // and position:sticky on the company cell silently stops
                    // sticking — the exact failure grid-perf row 27 exists to
                    // catch.
                    className={cn(
                      "group absolute inset-x-0 flex border-b border-border",
                      // Selection is the tint, the cursor is the inset ring —
                      // both at once stay distinguishable by construction.
                      // A selected row keeps its tint under hover: hover means
                      // "you are here", selection means "this is chosen", and
                      // swapping the second for the first on mouse-move reads
                      // as the selection flickering off.
                      //
                      // Muted text is promoted to text-2 on a selected row: a
                      // tint strong enough to read as selection is too dark for
                      // #707067 muted text to clear AA on (3.97:1 — the
                      // axe-with-selection scan caught this the first time it
                      // ran). The darker text-2 passes on the tint in both
                      // themes, so selection stays visible AND legible.
                      isSelected
                        ? "bg-selected [&_.text-muted]:text-text-2"
                        : "hover:bg-raised",
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
                          style={colStyle(cell.column, colScale)}
                          className={cn(
                            "flex min-w-0 items-center overflow-hidden px-3",
                            meta?.align === "right" && "tabular justify-end",
                            meta?.sticky &&
                              // Opaque, and re-tinted on row hover — a sticky
                              // cell with a transparent background shows the
                              // scrolled columns through itself. The selected
                              // tint is opaque too, for the same reason, and
                              // must match the row or the pinned column reads
                              // as a different selection than the rest.
                              (isSelected
                                ? "sticky left-0 z-10 border-r border-border bg-selected"
                                : "sticky left-0 z-10 border-r border-border bg-surface group-hover:bg-raised"),
                          )}
                        >
                          {cell.column.id === "warm" && warm ? (
                            // The real cell, rendered HERE rather than in the
                            // column def: `WarmCell` reaches a server action,
                            // which reaches the server-only reader, and
                            // `columns.tsx` has to stay importable from a
                            // Vitest unit test. Same split the Why chip uses,
                            // for a different reason.
                            <WarmCell
                              company={row.original.company}
                              title={row.original.title}
                              companyId={
                                universeFor(warm.universe, row.original.company)
                                  ?.linkedinCompanyId ?? ""
                              }
                              linkedinIdSource={
                                universeFor(warm.universe, row.original.company)
                                  ?.linkedinIdSource ?? ""
                              }
                              connections={connectionsAt(warm.connections, row.original.company)}
                              universeId={
                                universeFor(warm.universe, row.original.company)?.id ?? null
                              }
                              companyUpdatedAt={
                                universeFor(warm.universe, row.original.company)
                                  ?.companyUpdatedAt ?? null
                              }
                              hasAnyConnections={warm.hasAnyConnections}
                            />
                          ) : cell.column.id === "why" &&
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
      {/* Hidden while the selection bar is up: the bar floats exactly over
          this strip and carries every hint a selection can use (i/s/x, ⌘C,
          Esc) on its own buttons — two layers of keyboard hints in the same
          pixels read as clutter, which the G4 screenshot pass showed. */}
      {displayState.hints && display.length > 0 && selectedRows.length === 0 ? (
        <p
          data-testid="grid-hints"
          className="hidden shrink-0 items-center justify-end gap-x-1 whitespace-nowrap border-t
                     border-border px-4 py-1 text-2xs text-muted sm:flex sm:px-6"
        >
          <Kbd className="ml-0">j</Kbd> <Kbd>k</Kbd> rows · <Kbd>Space</Kbd> select ·{" "}
          <Kbd>⇧j</Kbd> <Kbd>⇧k</Kbd> extend · <Kbd>i</Kbd> <Kbd>x</Kbd> <Kbd>s</Kbd> decide
          selection · <Kbd>⌘C</Kbd> copy · <Kbd>?</Kbd> why
        </p>
      ) : null}

      {selectedRows.length > 0 ? (
        <SelectionBar
          count={selectedRows.length}
          busy={bulkBusy}
          onInterested={() => void bulkDecide("interested")}
          onSnooze={() => void bulkDecide("snoozed", localIsoDaysFromNow(SNOOZE_DAYS))}
          onDismiss={() => void bulkDecide("dismissed")}
          onCopy={() => void copySelection()}
          onClear={() => setSelRaw(clearSelection())}
          exportMenu={exportMenuFor("sel-export")}
        />
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
/**
 * Column width, scaled with the type size.
 *
 * The widths in columns.tsx are tuned for the 14px default. At large type
 * (18px) the same pixel width ellipsizes what fit before — the Comp band
 * "$165,000 - $210,000" is the one that first spills, and a comp column that
 * hides its own numbers is the failure the width note in columns.tsx warns
 * about. Scaling every column by the same font ratio keeps the layout
 * proportional, and applying the SAME factor to the header and the body cell
 * keeps their column edges aligned (row 48) — the header font scales too, so a
 * one-sided scale would misalign them.
 */
function colStyle(col: Column<JobView, unknown>, scale: number): React.CSSProperties {
  return {
    width: col.getSize() * scale,
    flex: col.columnDef.meta?.grow ? "1 0 auto" : "0 0 auto",
  };
}
