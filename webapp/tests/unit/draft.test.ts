import { describe, expect, it } from "vitest";
import { clampStep, decodeDraft, encodeDraft, MAX_DRAFT_LENGTH } from "@/lib/profile/draft";
import { BASE_CRITERIA, MAX_CHIP_LENGTH } from "@/lib/profile/criteria";
import { draftFromPreset } from "@/lib/profile/presets";

/**
 * The wizard's answers live in the address bar, which is what makes refresh,
 * Back and a pasted link all work — and which gives the mechanism a ceiling.
 * What this file mostly pins is what happens AT the ceiling, because the first
 * version crossed it silently and lost everything somebody had typed.
 */

describe("encodeDraft / decodeDraft", () => {
  it("round-trips every shipped preset", () => {
    for (const id of ["product-manager", "fpa", "other"]) {
      const draft = draftFromPreset(id);
      const encoded = encodeDraft(draft);
      expect(encoded, id).not.toBeNull();
      expect(decodeDraft(encoded as string)).toEqual(draft);
    }
  });

  it("survives non-ASCII, which base64 of a raw string would not", () => {
    const draft = { ...BASE_CRITERIA, role_family: "financial planning & analysis — Zoë" };
    expect(decodeDraft(encodeDraft(draft) as string)?.role_family).toBe(draft.role_family);
  });

  it("answers null over the cap instead of an empty string", () => {
    // The two used to be the same value, and that is exactly why nothing said
    // so: the caller wrote `?d=` with nothing in it, the sync effect then rewrote
    // the URL from the baseline, and every answer was gone with no message and
    // no way back through Back. Browser-verified at ~2.9 kB of chips.
    const huge = {
      ...BASE_CRITERIA,
      titles_include: Array.from(
        { length: 40 },
        (_, i) => `${"t".repeat(MAX_CHIP_LENGTH - 3)}${i}`,
      ),
    };
    expect(encodeDraft(huge)).toBeNull();
  });

  it("keeps a draft that is comfortably under the cap", () => {
    // The control. A cap that refused everything would satisfy the test above.
    const ok = { ...BASE_CRITERIA, titles_include: ["product manager", "senior product manager"] };
    const encoded = encodeDraft(ok);
    expect(encoded).not.toBeNull();
    expect((encoded as string).length).toBeLessThan(MAX_DRAFT_LENGTH);
  });

  it("keeps the real presets well under the cap", () => {
    // If a preset ever crossed it, onboarding would refuse to advance on its own
    // default answers — which is the failure the null return exists to make
    // visible, arriving as a bug rather than as a message.
    for (const id of ["product-manager", "fpa"]) {
      expect((encodeDraft(draftFromPreset(id)) as string).length, id).toBeLessThan(
        MAX_DRAFT_LENGTH / 2,
      );
    }
  });

  it("refuses to half-repair an unreadable draft", () => {
    // "Fail loud, never guess": a draft that will not decode opens the wizard on
    // its defaults rather than on whatever survived the corruption.
    expect(decodeDraft(null)).toBeNull();
    expect(decodeDraft("")).toBeNull();
    expect(decodeDraft("!!!not-base64!!!")).toBeNull();
    expect(decodeDraft("W10")).toBeNull(); // valid base64url of `[]` — an array, not an object
    expect(decodeDraft("x".repeat(MAX_DRAFT_LENGTH + 1))).toBeNull();
  });

  it("passes a decoded draft through the same validator a save uses", () => {
    // A URL is user input. Without this, a hand-edited `?d=` could put a policy
    // string into the form that the gate treats as its else-branch and no screen
    // can describe.
    const encoded = encodeDraft({ ...BASE_CRITERIA, yoe_max: 9999 } as never);
    expect(decodeDraft(encoded as string)?.yoe_max).toBe(60);
    expect(decodeDraft(encodeDraft({ geo_unknown: "sometimes" } as never) as string)?.geo_unknown).toBe(
      "filter",
    );
  });
});

describe("clampStep", () => {
  it("turns any address into a real step", () => {
    expect(clampStep("1")).toBe(1);
    expect(clampStep("6")).toBe(6);
    expect(clampStep("99")).toBe(6);
    expect(clampStep("0")).toBe(1);
    expect(clampStep("-3")).toBe(1);
    expect(clampStep("banana")).toBe(1);
    expect(clampStep(undefined)).toBe(1);
    expect(clampStep("3.7")).toBe(3);
  });
});
