/**
 * The saved-view `state` shape and the resolution of URL + saved views into
 * the grid's effective state (G3).
 *
 * `saved_views.state` is `unknown` to the store on purpose; this module is the
 * ONLY thing that reads it, so its parser must survive anything a past version
 * (or a hand-crafted server-action call) ever wrote — garbage becomes defaults,
 * never a throw, because a view that crashes /jobs is a view nobody can delete.
 */
import { describe, expect, it } from "vitest";
import type { SavedView } from "@/lib/data/view-models";
import { ROW_PX } from "@/lib/grid/columns";
import { parseGridState, serializeGridState } from "@/lib/grid/url-state";
import {
  DEFAULT_DISPLAY,
  displayEquals,
  makeViewState,
  parseViewState,
  resolveGridContext,
  rowPxFor,
} from "@/lib/grid/view-state";

const nav = (qs: string) => parseGridState(new URLSearchParams(qs)).state;

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: "v1",
  surface: "jobs",
  name: "Mine",
  state: makeViewState(nav("set=all&f=minYoe.lte.3"), {
    density: "comfortable",
    typeScale: "default",
    hints: true,
  }),
  isDefault: false,
  updatedAt: "2026-07-21T00:00:00.000Z",
  ...over,
});

describe("view state round trip", () => {
  it("make → parse preserves nav and display exactly", () => {
    const n = nav("set=all&f=workModel.in.Remote|Remote+(US)&sort=comp.desc&q=payments");
    const d = { density: "comfortable", typeScale: "large", hints: false } as const;
    const parsed = parseViewState(makeViewState(n, d));
    expect(serializeGridState(parsed.nav)).toBe(serializeGridState(n));
    expect(parsed.display).toEqual(d);
  });

  it("garbage becomes the defaults, never a throw", () => {
    for (const raw of [null, undefined, 42, "junk", [], {}, { nav: 42, density: "cozy", typeScale: 9, hints: "yes" }]) {
      const parsed = parseViewState(raw);
      expect(parsed.display).toEqual(DEFAULT_DISPLAY);
      expect(serializeGridState(parsed.nav)).toBe("");
    }
  });

  it("a corrupt clause inside a stored view drops; valid siblings survive", () => {
    const parsed = parseViewState({
      nav: "f=garbage,minYoe.lte.3",
      density: "dense",
      typeScale: "default",
      hints: true,
    });
    expect(serializeGridState(parsed.nav)).toBe("f=minYoe.lte.3");
  });

  it("the design's word 'compact' parses to the stored 'dense', forever", () => {
    // KILLING MUTATION: deleting the explicit `raw === "compact"` branch in
    // parseDensity. Today the fallback happens to be dense too, so the literal
    // assertion (not `DEFAULT_DISPLAY.density`) is what makes this test bite:
    // the day the default flips to comfortable, a view written with the
    // design's spelling would silently change row height, and this line fails
    // instead.
    //
    // The direction is the taxonomy split (see view-state.ts's header): `dense`
    // is the wire format, spelled by migration 0025's CHECK and matched by
    // `globals.css`; `Compact` is what a person reads. The alias exists so the
    // word the design uses is never the word that breaks a saved view.
    expect(parseViewState({ density: "compact" }).display.density).toBe("dense");
    expect(rowPxFor(parseViewState({ density: "compact" }).display.density)).toBe(32);
  });

  it("an unrecognised density falls back to the default, never a throw", () => {
    // KILLING MUTATION: widening parseDensity to pass through whatever it was
    // given (`raw as Density`), which would put "cozy" into a union that has
    // no row height for it and hand rowPxFor a value it silently reads as 32.
    for (const raw of ["cozy", "dEnse", "COMFORTABLE", "", 40, null, {}]) {
      expect(parseViewState({ density: raw }).display.density).toBe(DEFAULT_DISPLAY.density);
    }
  });

  it("rowPxFor is Carbon's two sizes: comfortable 40, dense 32", () => {
    // KILLING MUTATION: leaving the shipped 44 in place for comfortable, which
    // is the number the design overrode (01 §8), or swapping the two arms.
    // The ROW_PX pin stays because the constant is deliberately duplicated
    // (importing columns.tsx would drag react-table into the server action
    // bundle) and this is what keeps the copies from drifting.
    expect(rowPxFor("comfortable")).toBe(40);
    expect(rowPxFor("dense")).toBe(32);
    expect(rowPxFor("dense")).toBe(ROW_PX);
  });

  it("displayEquals compares all three knobs", () => {
    expect(displayEquals(DEFAULT_DISPLAY, { ...DEFAULT_DISPLAY })).toBe(true);
    expect(displayEquals(DEFAULT_DISPLAY, { ...DEFAULT_DISPLAY, hints: false })).toBe(false);
    expect(displayEquals(DEFAULT_DISPLAY, { ...DEFAULT_DISPLAY, density: "comfortable" })).toBe(false);
    expect(displayEquals(DEFAULT_DISPLAY, { ...DEFAULT_DISPLAY, typeScale: "large" })).toBe(false);
  });
});

describe("resolveGridContext", () => {
  const p = (qs: string) => new URLSearchParams(qs);

  it("bare /jobs with no views is the Queue preset, unedited", () => {
    const ctx = resolveGridContext(p(""), []);
    expect(ctx.base).toEqual({ kind: "preset", set: "queue" });
    expect(serializeGridState(ctx.nav)).toBe("");
    expect(ctx.navEdited).toBe(false);
    expect(ctx.baseDisplay).toEqual(DEFAULT_DISPLAY);
    expect(ctx.staleViewId).toBeNull();
  });

  it("bare /jobs opens the default view — the landing view contract", () => {
    const v = view({ isDefault: true });
    const ctx = resolveGridContext(p(""), [view({ id: "other", name: "Other" }), v]);
    expect(ctx.base).toEqual({ kind: "view", view: v });
    expect(serializeGridState(ctx.nav)).toBe("set=all&f=minYoe.lte.3");
    expect(ctx.baseDisplay.density).toBe("comfortable");
    expect(ctx.navEdited).toBe(false);
  });

  it("bare /jobs ignores non-default views", () => {
    const ctx = resolveGridContext(p(""), [view()]);
    expect(ctx.base).toEqual({ kind: "preset", set: "queue" });
  });

  it("an explicit set param beats the landing default — Queue stays reachable", () => {
    // Without this, a user with a landing view could never get back to the
    // plain Queue preset: /jobs would always be hijacked by their default.
    const ctx = resolveGridContext(p("set=queue"), [view({ isDefault: true })]);
    expect(ctx.base).toEqual({ kind: "preset", set: "queue" });
    expect(ctx.navEdited).toBe(false);
  });

  it("?view=id selects the view even when it is not the default", () => {
    const v = view();
    const ctx = resolveGridContext(p("view=v1"), [v]);
    expect(ctx.base).toEqual({ kind: "view", view: v });
    expect(serializeGridState(ctx.nav)).toBe("set=all&f=minYoe.lte.3");
    expect(ctx.navEdited).toBe(false);
  });

  it("owned nav params override the view's nav and read as edited", () => {
    const ctx = resolveGridContext(p("view=v1&f=company.has.ramp"), [view()]);
    expect(ctx.base.kind).toBe("view");
    expect(serializeGridState(ctx.nav)).toBe("f=company.has.ramp");
    expect(ctx.navEdited).toBe(true);
  });

  it("nav params that spell the saved state exactly are NOT edited", () => {
    const ctx = resolveGridContext(p("view=v1&set=all&f=minYoe.lte.3"), [view()]);
    expect(ctx.navEdited).toBe(false);
  });

  it("a stale view id falls back to the preset, loudly", () => {
    const ctx = resolveGridContext(p("view=nope"), [view()]);
    expect(ctx.staleViewId).toBe("nope");
    expect(ctx.base).toEqual({ kind: "preset", set: "queue" });
    const withParams = resolveGridContext(p("view=nope&set=all"), [view()]);
    expect(withParams.base).toEqual({ kind: "preset", set: "all" });
    expect(withParams.staleViewId).toBe("nope");
  });

  it("plain preset URLs resolve by set, edited only when narrowed beyond it", () => {
    const snoozed = resolveGridContext(p("set=snoozed"), []);
    expect(snoozed.base).toEqual({ kind: "preset", set: "snoozed" });
    expect(snoozed.navEdited).toBe(false);

    const narrowed = resolveGridContext(p("set=all&sort=comp.desc"), []);
    expect(narrowed.base).toEqual({ kind: "preset", set: "all" });
    expect(narrowed.navEdited).toBe(true);
  });

  it("surfaces dropped clauses from the URL, not from the stored view", () => {
    // A malformed URL clause is the user's link and must toast; a malformed
    // STORED clause was already dropped at parse and re-toasting it on every
    // visit would nag about something the user cannot edit yet.
    const fromUrl = resolveGridContext(p("f=garbage"), []);
    expect(fromUrl.dropped).toEqual(["garbage"]);
    const corrupt = view({ state: { nav: "f=garbage", density: "compact", typeScale: "default", hints: true } });
    const fromView = resolveGridContext(p("view=v1"), [corrupt]);
    expect(fromView.dropped).toEqual([]);
  });
});
