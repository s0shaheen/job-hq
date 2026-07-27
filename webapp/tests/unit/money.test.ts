import { describe, expect, it } from "vitest";
import { parseCriteria, MAX_COMP_MIN_K } from "@/lib/profile/criteria";
import {
  dollarsFromK,
  formatDollars,
  kFromDollars,
  MAX_COMP_MIN_DOLLARS,
  parseDollars,
} from "@/lib/profile/money";

/**
 * The unit boundary. `comp_min` stays in thousands because the gate reads it
 * there; the screen stays in dollars because that is what a salary is.
 */

describe("parseDollars", () => {
  it("accepts the three forms a person actually types", () => {
    expect(parseDollars("200000")).toBe(200_000);
    expect(parseDollars("200k")).toBe(200_000);
    expect(parseDollars("$200,000")).toBe(200_000);
  });

  it("takes a bare number at face value instead of guessing thousands", () => {
    // The field formats what it got, so "$200" on screen is how a slip becomes
    // visible. Multiplying by 1000 on a hunch would store a floor nobody typed.
    expect(parseDollars("200")).toBe(200);
  });

  it("handles the decorations people paste in", () => {
    expect(parseDollars("  $ 185,500 ")).toBe(185_500);
    expect(parseDollars("1.2m")).toBe(1_200_000);
    expect(parseDollars("120K")).toBe(120_000);
  });

  it("reads an empty box as no floor rather than as junk", () => {
    // Clearing the field is how the floor is turned off. Returning null would
    // leave the old number in place under an empty-looking input.
    expect(parseDollars("")).toBe(0);
    expect(parseDollars("   ")).toBe(0);
  });

  it("reads decoration with no digits as a field halfway through being typed", () => {
    // Calling `$` junk lit the warning under the box on the first keystroke of
    // "$200,000", which is a correction aimed at somebody doing it right.
    expect(parseDollars("$")).toBe(0);
    expect(parseDollars("$,")).toBe(0);
  });

  it("refuses what is not a number", () => {
    expect(parseDollars("a lot")).toBeNull();
    expect(parseDollars("200-300k")).toBeNull();
    expect(parseDollars("12x")).toBeNull();
  });

  it("clamps at the ceiling instead of overflowing the stored unit", () => {
    expect(parseDollars("99999999")).toBe(MAX_COMP_MIN_DOLLARS);
    expect(MAX_COMP_MIN_DOLLARS).toBe(2_000_000);
  });
});

describe("formatDollars", () => {
  it("shows a salary the way a salary is written", () => {
    expect(formatDollars(200_000)).toBe("$200,000");
    expect(formatDollars(185_500)).toBe("$185,500");
  });

  it("shows nothing for no floor, so the box reads as empty rather than as $0", () => {
    expect(formatDollars(0)).toBe("");
    expect(formatDollars(Number.NaN)).toBe("");
  });
});

describe("the round trip through the stored unit", () => {
  it("survives what the gate stores", () => {
    expect(kFromDollars(200_000)).toBe(200);
    expect(dollarsFromK(200)).toBe(200_000);
    expect(dollarsFromK(kFromDollars(185_500))).toBe(185_500);
  });

  it("keeps sub-thousand precision rather than moving the number", () => {
    // `parseCriteria` clamps `comp_min` without truncating and the gate reads it
    // as a float, so 205.5 is a legal floor. Rounding to 206 here would store a
    // number the person did not type.
    expect(kFromDollars(205_500)).toBe(205.5);
  });

  it("lands inside the clamp `parseCriteria` enforces", () => {
    // The two ceilings are one ceiling, said in two units. If they ever drift,
    // the field would accept a number the server silently lowers.
    const k = kFromDollars(MAX_COMP_MIN_DOLLARS);
    expect(k).toBe(MAX_COMP_MIN_K);
    expect(parseCriteria({ comp_min: k }).comp_min).toBe(k);
  });

  it("reads no floor as no floor in both directions", () => {
    expect(kFromDollars(0)).toBe(0);
    expect(dollarsFromK(0)).toBe(0);
  });
});
