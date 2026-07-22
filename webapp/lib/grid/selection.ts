/**
 * The selection model — pure, no React, plan §5. A `Set<postingKey>` plus a
 * range anchor, operating over the CURRENT filtered+sorted leaf order (the
 * array `displayLeaves` produces — job rows only, so a shift-range can never
 * pick up a group header: the header simply is not in the order it spans).
 *
 * Keys, not indices, everywhere. The grid re-sorts and re-filters under the
 * selection constantly; an index-based model would silently select different
 * rows after every sort, which is the classic spreadsheet-selection bug.
 *
 * The trust-critical rule (spec E, matrix row 33's shape): selection persists
 * across filter changes BY KEY, minus rows the new filter hides. "Export
 * selection" must never emit a row that is not visible — a file with rows the
 * screen does not show is the silent scope surprise the spec calls a top-tier
 * trust bug. `pruneSelection` (state — permanent removal) and
 * `selectedInOrder` (read — order-intersection) enforce it from both ends, so
 * even a caller that forgets to prune cannot leak a hidden row into a payload.
 */
import type { JobView } from "@/lib/data/view-models";
import { JOB_COLUMNS, type Column } from "@/lib/export/columns";

export type Selection = {
  /** Selected posting keys. */
  keys: ReadonlySet<string>;
  /** Range origin: where the last non-shift gesture landed. */
  anchor: string | null;
  /**
   * Keys the LIVE shift-range added, in span order. A second shift-click
   * replaces this span rather than accumulating — click row 2, shift-click 8,
   * shift-click 4 must leave 2–4, not 2–8. Without tracking the live span,
   * shrinking a range strands its tail selected (Gmail/Airtable get this
   * right; naive implementations do not).
   */
  lastRange: readonly string[];
};

export const EMPTY_SELECTION: Selection = { keys: new Set(), anchor: null, lastRange: [] };

/** Plain click: this row and nothing else. */
export function clickSelect(key: string): Selection {
  return { keys: new Set([key]), anchor: key, lastRange: [] };
}

/** ⌘/Ctrl-click or Space: flip one row; the anchor follows the gesture. */
export function toggleSelect(sel: Selection, key: string): Selection {
  const keys = new Set(sel.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  // The live range is committed by any non-shift gesture: the next
  // shift-click spans from HERE, and must not un-select what this one built.
  return { keys, anchor: key, lastRange: [] };
}

/**
 * Shift-click / Shift+j/k: the contiguous span from the anchor to `key`,
 * inclusive, over the current leaf order. Replaces the previous live span
 * (see `lastRange`); keys selected outside it survive. An anchor the current
 * order no longer contains (hidden by a filter, then pruned) degrades to a
 * plain select — spanning from an invisible row would select rows the user
 * cannot see between here and nowhere.
 */
export function rangeSelect(sel: Selection, order: readonly string[], key: string): Selection {
  const from = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
  const to = order.indexOf(key);
  if (from < 0 || to < 0) return clickSelect(key);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const span = order.slice(lo, hi + 1);
  const keys = new Set(sel.keys);
  for (const k of sel.lastRange) keys.delete(k);
  for (const k of span) keys.add(k);
  return { keys, anchor: sel.anchor, lastRange: span };
}

export function clearSelection(): Selection {
  return EMPTY_SELECTION;
}

/**
 * The filter-change rule: keep by key, DROP what is no longer visible —
 * permanently, so widening the filter later does not resurrect a selection
 * the user has stopped being able to see or reason about. Returns the same
 * object when nothing changed, so a caller syncing React state off this
 * cannot enter a set-state loop.
 */
export function pruneSelection(sel: Selection, visible: ReadonlySet<string>): Selection {
  const anchorHidden = sel.anchor !== null && !visible.has(sel.anchor);
  let hidden = anchorHidden;
  if (!hidden) for (const k of sel.keys) if (!visible.has(k)) { hidden = true; break; }
  if (!hidden) return sel;
  const keys = new Set<string>();
  for (const k of sel.keys) if (visible.has(k)) keys.add(k);
  return {
    keys,
    anchor: anchorHidden ? null : sel.anchor,
    lastRange: sel.lastRange.filter((k) => visible.has(k)),
  };
}

/**
 * The keys copy/export receive: current visual order, intersected with the
 * order itself — so even if a stale key survived somewhere, it cannot reach a
 * clipboard or a file. Order-intersection is the second, independent
 * enforcement of the prune rule above.
 */
export function selectedInOrder(sel: Selection, order: readonly string[]): string[] {
  return order.filter((k) => sel.keys.has(k));
}

/**
 * The export/copy column set for a view: the visible grid columns, in view
 * order, mapped through JOB_COLUMNS by key — one column vocabulary, shared
 * with the export dialog, so the same key can never mean two headers. Grid-
 * only columns (why) have no export analog and drop out; hidden columns are
 * excluded because they are never passed in; the URL is appended because the
 * Title cell renders AS a link to it — a CSV cell cannot carry an href, so
 * the URL column is that link's honest serialization, and the menu says so.
 */
export function exportColumnsFor(visibleIds: readonly string[]): Column<JobView>[] {
  const byKey = new Map(JOB_COLUMNS.map((c) => [c.key, c]));
  const cols: Column<JobView>[] = [];
  for (const id of visibleIds) {
    const col = byKey.get(id);
    if (col && col.key !== "url") cols.push(col);
  }
  cols.push(byKey.get("url")!);
  return cols;
}
