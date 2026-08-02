/**
 * The Jobs detail pane's URL state (03 §4: "pane state in the URL so a link
 * restores it", with the list staying interactive and no route change).
 *
 * Pure string and param work, so it is unit-tested rather than driven through
 * the grid: the properties that matter here are total (every param survives,
 * the input object is never touched) and a browser test would sample them.
 */
import { describe, expect, it } from "vitest";
import { PANE_PARAM, readPaneKey, withPaneKey } from "@/lib/grid/pane-state";

const p = (qs: string) => new URLSearchParams(qs);

describe("readPaneKey", () => {
  it("reads the posting key the URL names", () => {
    expect(readPaneKey(p("job=greenhouse-4012345"))).toBe("greenhouse-4012345");
    expect(readPaneKey(p(`${PANE_PARAM}=workday-R-0099887`))).toBe("workday-R-0099887");
  });

  it("no param, and an empty param, are both null", () => {
    // KILLING MUTATION: returning `params.get()` straight through. An empty
    // `?job=` would then be a key, and the caller would open a pane over a row
    // that cannot exist rather than showing no pane.
    expect(readPaneKey(p(""))).toBeNull();
    expect(readPaneKey(p("set=all&f=minYoe.lte.3"))).toBeNull();
    expect(readPaneKey(p("job="))).toBeNull();
  });

  it("a key past the length bound is refused", () => {
    // KILLING MUTATION: dropping the length check, or writing it as `<` so the
    // boundary is off by one. The value comes from a URL somebody else may have
    // written, and an unbounded string has no business reaching a row lookup.
    expect(readPaneKey(p(`job=${"a".repeat(200)}`))).toBe("a".repeat(200));
    expect(readPaneKey(p(`job=${"a".repeat(201)}`))).toBeNull();
  });

  it("a hostile key with whitespace or a control character is refused", () => {
    // KILLING MUTATION: deleting the FORBIDDEN test. These reach a row lookup
    // and, on the way, a `data-` attribute and a log line; a newline or a NUL
    // in either is a display and injection trick, and `lib/url/safe-href.ts`
    // draws the same fence for the same reason.
    for (const raw of [
      "greenhouse 4012345",
      "greenhouse\n4012345",
      "greenhouse\t4012345",
      "greenhouse\u00004012345",
      "greenhouse\u001b[31m",
      "greenhouse\u007f",
      " greenhouse-4012345",
      "greenhouse-4012345 ",
    ]) {
      const params = new URLSearchParams();
      params.set(PANE_PARAM, raw);
      expect(readPaneKey(params)).toBeNull();
    }
  });
});

describe("withPaneKey", () => {
  it("sets the key, and round-trips through readPaneKey", () => {
    const next = withPaneKey(p("set=all"), "ashby-abc-123");
    expect(next.get(PANE_PARAM)).toBe("ashby-abc-123");
    expect(readPaneKey(next)).toBe("ashby-abc-123");
  });

  it("null deletes the key and leaves the rest of the query alone", () => {
    // KILLING MUTATION: setting the param to "" instead of deleting it, which
    // leaves a bare `?job=` on every closed pane and puts a junk param in every
    // link somebody copies.
    const next = withPaneKey(p("set=all&job=greenhouse-1&sort=comp.desc"), null);
    expect(next.has(PANE_PARAM)).toBe(false);
    expect(next.toString()).toBe("set=all&sort=comp.desc");
  });

  it("replaces an existing key rather than appending a second one", () => {
    // KILLING MUTATION: `append` in place of `set`. URLSearchParams keeps both,
    // `get` returns the first, and the pane would freeze on the first row
    // clicked while the URL grew a `job=` per click.
    const next = withPaneKey(p("job=greenhouse-1"), "greenhouse-2");
    expect(next.getAll(PANE_PARAM)).toEqual(["greenhouse-2"]);
  });

  it("preserves every other param, perf= included", () => {
    // KILLING MUTATION: rebuilding the query from a known param list. `perf=`
    // is the grid's measurement harness (app/(app)/jobs/page.tsx) and is not on
    // any such list, so opening a pane would silently exit the harness.
    const before = p("set=all&f=minYoe.lte.3&q=payments&sort=comp.desc&group=company&perf=5000");
    const opened = withPaneKey(before, "lever-77");
    expect(opened.get("perf")).toBe("5000");
    expect(opened.get("f")).toBe("minYoe.lte.3");
    expect(opened.get("q")).toBe("payments");
    expect(opened.get("group")).toBe("company");
    const closed = withPaneKey(opened, null);
    expect(closed.toString()).toBe(before.toString());
  });

  it("returns a NEW object and never mutates the input", () => {
    // KILLING MUTATION: `params.set(...); return params;`. The router already
    // holds that object, so an in-place edit changes the history entry under it
    // and Back/Forward replay a URL that never matched what the screen showed.
    const before = p("set=all");
    const after = withPaneKey(before, "greenhouse-1");
    expect(after).not.toBe(before);
    expect(before.toString()).toBe("set=all");
    expect(before.has(PANE_PARAM)).toBe(false);

    const deleted = withPaneKey(p("job=greenhouse-1"), null);
    expect(deleted.toString()).toBe("");
  });

  it("an empty-string key closes the pane rather than writing a blank param", () => {
    expect(withPaneKey(p("job=greenhouse-1"), "").has(PANE_PARAM)).toBe(false);
  });
});
