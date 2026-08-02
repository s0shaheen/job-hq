/**
 * The Display popover's label bridge, and the one place the two density
 * vocabularies are allowed to meet.
 *
 * This file used to test a `resolveDisplayPrefs()` that guessed at an optional
 * `profiles.displayPrefs` field before E5 existed. E5 landed (migration 0025),
 * `lib/display/prefs.ts` owns the parser, `tests/unit/display-prefs.test.ts`
 * tests it against the SQL, and the guess was deleted rather than left to fork.
 * What remains is the part E5 does not own: the stored value a stylesheet
 * matches on one side, the word a person reads on the other.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_PREFS,
  densityLabel,
  densityValue,
  typeSizeLabel,
  typeSizeValue,
  type DensityLabel,
  type TypeSizeLabel,
} from "@/lib/grid/display-prefs";
import { DEFAULT_DISPLAY, rowPxFor, type Density, type TypeScale } from "@/lib/grid/view-state";

describe("label and value bridges", () => {
  it("density labels and values are exact inverses in both directions", () => {
    // KILLING MUTATION: a `densityLabel` that title-cases the stored string
    // generically. It reads right for "comfortable" and then mints "Dense" for
    // the other, which `densityValue` cannot read back — the way a segmented
    // control stops writing without erroring.
    const values: Density[] = ["comfortable", "dense"];
    const labels: DensityLabel[] = ["Comfortable", "Compact"];
    expect(values.map(densityLabel)).toEqual(labels);
    for (const v of values) expect(densityValue(densityLabel(v))).toBe(v);
    for (const l of labels) expect(densityLabel(densityValue(l))).toBe(l);
  });

  it("type size labels and values are exact inverses in both directions", () => {
    const values: TypeScale[] = ["default", "large"];
    const labels: TypeSizeLabel[] = ["Default", "Large"];
    expect(values.map(typeSizeLabel)).toEqual(labels);
    for (const v of values) expect(typeSizeValue(typeSizeLabel(v))).toBe(v);
    for (const l of labels) expect(typeSizeLabel(typeSizeValue(l))).toBe(l);
  });

  it("the labels are the words the popover renders, spelled exactly", () => {
    // KILLING MUTATION: sentence-casing these to "Comfortable"/"compact" on the
    // theory that 02 §2 governs them. It does not: these are a control's proper
    // values, spelled by 01 §8 and 04 §3 ("density Comfortable/Compact"), and
    // the e2e reads them off the segmented control by name.
    expect(densityLabel("comfortable")).toBe("Comfortable");
    expect(densityLabel("dense")).toBe("Compact");
    expect(typeSizeLabel("default")).toBe("Default");
    expect(typeSizeLabel("large")).toBe("Large");
  });

  it("the stored word and the read word are deliberately different", () => {
    // THE WHOLE POINT OF THE BRIDGE, asserted on one line so that deleting it
    // and rendering the raw value fails here rather than in a screenshot.
    //
    // MUTATION REASON: `densityLabel = (d) => d` passes nothing above except by
    // accident and fails this outright. A stored `dense` must never reach a
    // screen, and the design's `compact` must never reach the database.
    expect(densityLabel("dense")).not.toBe("dense");
    expect(densityValue("Compact")).toBe("dense");
  });
});

describe("the grid's density constants and E5's are one set of values", () => {
  it("the grid default is the profile default, field for field", () => {
    // Two modules type this knob and one migration stores it. If they ever
    // disagree, a user with no stored preference renders at one height inside
    // the grid and another everywhere else, with nothing failing.
    expect(DEFAULT_DISPLAY.density).toBe(DEFAULT_DISPLAY_PREFS.density);
    expect(DEFAULT_DISPLAY.typeScale).toBe(DEFAULT_DISPLAY_PREFS.typeScale);
    expect(DEFAULT_DISPLAY.hints).toBe(DEFAULT_DISPLAY_PREFS.keyboardHints);
  });

  it("every stored density has a row height and a label", () => {
    // MUTATION REASON: adding a third density to `lib/display/prefs.ts` without
    // teaching `rowPxFor` or `densityLabel` about it. Both would answer
    // silently — 32px and "Compact" — for a value that means neither.
    for (const d of ["comfortable", "dense"] as const) {
      expect(rowPxFor(d)).toBeGreaterThan(0);
      expect(densityValue(densityLabel(d))).toBe(d);
    }
  });
});
