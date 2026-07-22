import { describe, expect, it } from "vitest";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { JOB_COLUMNS } from "@/lib/export/columns";
import {
  clearSelection,
  clickSelect,
  EMPTY_SELECTION,
  exportColumnsFor,
  pruneSelection,
  rangeSelect,
  selectedInOrder,
  toggleSelect,
  type Selection,
} from "@/lib/grid/selection";
import { rowsForSet } from "@/lib/grid/presets";
import { displayLeaves, flattenGroups, sortRows } from "@/lib/grid/sort";

/**
 * The pure selection model (plan §5). The trust-critical rule lives here:
 * selection persists across filter changes BY KEY, minus rows the new filter
 * hides — "export selection" must never emit a row that is not visible, which
 * the spec calls a top-tier trust bug. pruneSelection is that rule as a
 * function, so it can be broken on purpose and watched to fail.
 */

const ORDER = ["a", "b", "c", "d", "e", "f"];

const keysOf = (s: Selection) => [...s.keys].sort();

describe("click / toggle", () => {
  it("plain click selects only that row and pins the anchor", () => {
    const s = clickSelect("c");
    expect(keysOf(s)).toEqual(["c"]);
    expect(s.anchor).toBe("c");
  });

  it("a second plain click replaces the selection, never accumulates", () => {
    const s = clickSelect("e");
    expect(keysOf(s)).toEqual(["e"]);
    expect(s.anchor).toBe("e");
  });

  it("toggle adds a row and moves the anchor to it", () => {
    const s = toggleSelect(clickSelect("a"), "d");
    expect(keysOf(s)).toEqual(["a", "d"]);
    expect(s.anchor).toBe("d");
  });

  it("toggle removes an already-selected row, anchor still moves", () => {
    const s = toggleSelect(toggleSelect(clickSelect("a"), "d"), "a");
    expect(keysOf(s)).toEqual(["d"]);
    // The anchor follows the gesture even when it deselects — the next
    // shift-click ranges from where the user last pointed, which is how
    // Gmail/Airtable behave and what a hand expects.
    expect(s.anchor).toBe("a");
  });
});

describe("shift-click range", () => {
  it("selects the contiguous span from the anchor, inclusive", () => {
    const s = rangeSelect(clickSelect("b"), ORDER, "e");
    expect(keysOf(s)).toEqual(["b", "c", "d", "e"]);
    expect(s.anchor).toBe("b"); // the anchor survives — ranges re-pin from it
  });

  it("ranges upward when the target sits before the anchor", () => {
    const s = rangeSelect(clickSelect("d"), ORDER, "a");
    expect(keysOf(s)).toEqual(["a", "b", "c", "d"]);
  });

  it("a second shift-click re-pins the span from the same anchor (shrink works)", () => {
    const wide = rangeSelect(clickSelect("a"), ORDER, "e");
    const narrow = rangeSelect(wide, ORDER, "c");
    // e and d leave; a shrunken range must not strand the tail selected.
    expect(keysOf(narrow)).toEqual(["a", "b", "c"]);
  });

  it("keeps rows selected outside the live range (toggle then range)", () => {
    const scattered = toggleSelect(clickSelect("a"), "d"); // anchor now d
    const s = rangeSelect(scattered, ORDER, "f");
    expect(keysOf(s)).toEqual(["a", "d", "e", "f"]);
    const shrunk = rangeSelect(s, ORDER, "e");
    expect(keysOf(shrunk)).toEqual(["a", "d", "e"]); // a is untouched by the re-pin
  });

  it("with no anchor (fresh or pruned away) it degrades to a plain select", () => {
    const s = rangeSelect(EMPTY_SELECTION, ORDER, "c");
    expect(keysOf(s)).toEqual(["c"]);
    expect(s.anchor).toBe("c");
  });

  it("an anchor the current order no longer contains degrades to a plain select", () => {
    const s = rangeSelect(clickSelect("zz-hidden"), ORDER, "b");
    expect(keysOf(s)).toEqual(["b"]);
    expect(s.anchor).toBe("b");
  });

  it("never selects group headers: a span over a grouped display holds job keys only", () => {
    // Real pipeline: queue rows sorted by comp desc, grouped by company. The
    // order handed to the model is displayLeaves(...) — job rows only — so a
    // range across group boundaries cannot pick up a header by construction,
    // and this pins that the leaf order is what selection operates on.
    const rows = sortRows(rowsForSet(FIXTURE_JOBS, "queue"), { field: "comp", dir: "desc" });
    const display = flattenGroups(rows, "company");
    const leaves = displayLeaves(display).map((j) => j.key);
    expect(display.length).toBeGreaterThan(leaves.length); // headers exist

    const s = rangeSelect(clickSelect(leaves[1]), leaves, leaves[4]);
    expect([...s.keys].every((k) => leaves.includes(k))).toBe(true);
    expect(selectedInOrder(s, leaves)).toEqual(leaves.slice(1, 5));
  });
});

describe("prune on filter change — the export-scope trust rule", () => {
  it("drops keys the new filter hides and keeps the rest", () => {
    const s = rangeSelect(clickSelect("a"), ORDER, "d"); // a b c d
    const pruned = pruneSelection(s, new Set(["a", "c", "e", "f"]));
    expect(keysOf(pruned)).toEqual(["a", "c"]);
  });

  it("drops a hidden anchor so the next range cannot span from an invisible row", () => {
    const s = rangeSelect(clickSelect("b"), ORDER, "d");
    const pruned = pruneSelection(s, new Set(["c", "d", "e", "f"]));
    expect(pruned.anchor).toBeNull();
    // …and a follow-up shift-click degrades safely to a plain select.
    expect(keysOf(rangeSelect(pruned, ORDER, "f"))).toEqual(["f"]);
  });

  it("returns the SAME object when nothing is hidden (no state churn loop)", () => {
    const s = rangeSelect(clickSelect("a"), ORDER, "c");
    expect(pruneSelection(s, new Set(ORDER))).toBe(s);
  });

  it("prunes the live range too, so a later re-pin cannot resurrect hidden rows", () => {
    const s = rangeSelect(clickSelect("a"), ORDER, "d"); // live range a..d
    const pruned = pruneSelection(s, new Set(["a", "b", "e", "f"]));
    // Re-pin from the surviving anchor: only currently-derived spans apply.
    const rePinned = rangeSelect(pruned, ["a", "b", "e", "f"], "b");
    expect(keysOf(rePinned)).toEqual(["a", "b"]);
  });
});

describe("selectedInOrder — what copy/export receive", () => {
  it("emits keys in the CURRENT visual order, not insertion order", () => {
    const s = toggleSelect(toggleSelect(clickSelect("e"), "a"), "c");
    expect(selectedInOrder(s, ORDER)).toEqual(["a", "c", "e"]);
  });

  it("silently skips keys the order no longer contains — a hidden row can never reach a file", () => {
    const s = toggleSelect(clickSelect("a"), "d");
    expect(selectedInOrder(s, ["a", "b", "c"])).toEqual(["a"]);
  });

  it("clearSelection empties everything", () => {
    const s = clearSelection();
    expect(s.keys.size).toBe(0);
    expect(s.anchor).toBeNull();
  });
});

describe("exportColumnsFor — visible columns in view order, mapped through JOB_COLUMNS", () => {
  it("keeps view order and resolves each id to its export column", () => {
    const cols = exportColumnsFor(["company", "title", "comp", "posted"]);
    expect(cols.map((c) => c.key)).toEqual(["company", "title", "comp", "posted", "url"]);
    // The same Column objects, not copies — headers/values stay in lockstep
    // with the export core everything else uses.
    expect(cols[0]).toBe(JOB_COLUMNS.find((c) => c.key === "company"));
  });

  it("drops grid-only columns (why) that have no export analog", () => {
    const cols = exportColumnsFor(["company", "why", "decision"]);
    expect(cols.map((c) => c.key)).toEqual(["company", "decision", "url"]);
  });

  it("always appends the URL exactly once — the Title link's honest serialization", () => {
    const cols = exportColumnsFor(["company", "title"]);
    expect(cols.filter((c) => c.key === "url")).toHaveLength(1);
  });

  it("a hidden column is excluded because it was never passed in", () => {
    const cols = exportColumnsFor(["company", "title", "comp", "minYoe", "workModel", "location", "posted"]);
    expect(cols.map((c) => c.key)).not.toContain("metro");
    expect(cols.map((c) => c.key)).not.toContain("firstSeen");
  });
});
