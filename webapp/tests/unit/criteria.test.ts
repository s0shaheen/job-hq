import { describe, expect, it } from "vitest";
import {
  BASE_CRITERIA,
  describesASearch,
  isOnboarded,
  MAX_CHIPS,
  MAX_CHIP_LENGTH,
  parseCriteria,
} from "@/lib/profile/criteria";
import { draftFromPreset, presetFor } from "@/lib/profile/presets";

/**
 * The boundary between what somebody typed and what gets stored under their name.
 *
 * A server action is a public endpoint and `ProfileCriteria` is erased at
 * runtime, so `parseCriteria` is the only thing standing between a hand-made
 * request and the `criteria` column. What this file mostly pins is the OTHER
 * direction: that the validator does not quietly improve on an answer.
 */

describe("parseCriteria — an empty answer is an answer", () => {
  it("keeps 'Something else' empty instead of rewriting it to product management", () => {
    // The bug this file exists for, and it was a lie rather than a crash: the
    // three free-text fields fell back to BASE_CRITERIA on an empty string, so
    // choosing "Something else" and typing nothing stored `role_family:
    // "product manager"`, `tag_domain: "product-manager"` and
    // `board_search_term: "product"` — a product-management search under the
    // name of somebody who had explicitly said it was not that. Nothing on any
    // screen said so, and the tagger and the board sweep would both have acted
    // on it.
    const other = draftFromPreset("other");
    expect(other.role_family).toBe("");

    const stored = parseCriteria(other);
    expect(stored.role_family).toBe("");
    expect(stored.tag_domain).toBe("");
    expect(stored.board_search_term).toBe("");
  });

  it("lands malformed and MISSING free-text on the explicit unset state", () => {
    // RM-40 vault audit §9 Step 4: "a generic default is still a default; the
    // bug is that a blank field silently acquires a value." A number, a null,
    // or an absent key is not an answer — and it must not become one. Before
    // this change a criteria row missing `role_family` came back as
    // "product manager": one person's search under another person's name.
    const stored = parseCriteria({ role_family: 42, tag_domain: null });
    expect(stored.role_family).toBe("");
    expect(stored.tag_domain).toBe("");
    expect(stored.board_search_term).toBe("");   // the key was never sent
    expect(BASE_CRITERIA.role_family).toBe("");  // the baseline carries no persona
    expect(BASE_CRITERIA.tag_domain).toBe("");
    expect(BASE_CRITERIA.board_search_term).toBe("");
  });

  it("round-trips a preset without changing a character", () => {
    // The control: if the fallback removal broke the normal path, every preset
    // would come back subtly different from what the wizard showed.
    const pm = draftFromPreset("product-manager");
    expect(parseCriteria(pm)).toEqual(pm);
  });

  it("reports 'other' as the active preset for an empty role family", () => {
    expect(presetFor({ role_family: "" }).id).toBe("other");
  });
});

describe("describesASearch", () => {
  it("refuses a profile the engine cannot act on", () => {
    // Both halves are load-bearing and for different reasons: `role_family` is
    // read verbatim into the tagger's prompt, and an empty `titles_include`
    // matches NOTHING (`any([])` in Python, `some()` here), so a profile
    // without one produces an empty queue by construction.
    expect(describesASearch(draftFromPreset("other"))).toBe(false);
    expect(describesASearch({ ...BASE_CRITERIA, role_family: "fp&a" })).toBe(false);
    expect(
      describesASearch({ ...BASE_CRITERIA, role_family: "", titles_include: ["fp&a"] }),
    ).toBe(false);
    expect(
      describesASearch({ ...BASE_CRITERIA, role_family: "fp&a", titles_include: ["fp&a"] }),
    ).toBe(true);
  });

  it("does not accept whitespace as a role family", () => {
    expect(
      describesASearch({ ...BASE_CRITERIA, role_family: "   ", titles_include: ["x"] }),
    ).toBe(false);
  });

  it("accepts every shipped preset except the deliberately-empty one", () => {
    expect(describesASearch(draftFromPreset("product-manager"))).toBe(true);
    expect(describesASearch(draftFromPreset("fpa"))).toBe(true);
  });
});

describe("parseCriteria — the bounds", () => {
  it("de-duplicates chips case-insensitively and caps the list", () => {
    const many = Array.from({ length: MAX_CHIPS + 20 }, (_, i) => `title ${i}`);
    const stored = parseCriteria({ titles_include: ["PM", "pm", " pm ", ...many] });
    expect(stored.titles_include.length).toBe(MAX_CHIPS);
    expect(stored.titles_include.filter((t) => t.toLowerCase() === "pm").length).toBe(1);
  });

  it("truncates an over-long chip rather than refusing the whole list", () => {
    const stored = parseCriteria({ countries: ["x".repeat(MAX_CHIP_LENGTH + 50)] });
    expect(stored.countries[0].length).toBe(MAX_CHIP_LENGTH);
  });

  it("clamps the two numbers", () => {
    expect(parseCriteria({ yoe_max: 9999 }).yoe_max).toBe(60);
    expect(parseCriteria({ yoe_max: -5 }).yoe_max).toBe(0);
    expect(parseCriteria({ comp_min: 99999 }).comp_min).toBe(2000);
  });

  it("reads an absent, blank or junk YoE ceiling as null — the gate off", () => {
    // An unparseable request must not acquire a limit, and null is the state
    // `dispose` reads as OFF (gate-corpus: yoe-null-ceiling-means-the-gate-is-off).
    // The old behaviour handed these a ceiling of 4 — the deployment owner's.
    expect(parseCriteria({}).yoe_max).toBeNull();
    expect(parseCriteria({ yoe_max: null }).yoe_max).toBeNull();
    expect(parseCriteria({ yoe_max: "" }).yoe_max).toBeNull();
    // Whitespace-only is blank, not zero: Number("") is 0, and the #251
    // review caught "  " minting an entry-level-only ceiling nobody set.
    expect(parseCriteria({ yoe_max: "   " }).yoe_max).toBeNull();
    expect(parseCriteria({ yoe_max: "abc" }).yoe_max).toBeNull();
    expect(parseCriteria({ yoe_max: 4 }).yoe_max).toBe(4);  // a stated one survives
    expect(parseCriteria({ yoe_max: 0 }).yoe_max).toBe(0);  // a REAL zero survives too
  });

  it("falls back rather than storing an unrecognised policy", () => {
    // The gate treats an unknown policy as its else-branch, so writing one
    // produces a profile whose behaviour nothing in the UI can describe.
    expect(parseCriteria({ geo_unknown: "sometimes" }).geo_unknown).toBe("filter");
    expect(parseCriteria({ yoe_unknown: "" }).yoe_unknown).toBe("seniority-proxy");
    expect(parseCriteria({ comp_unknown: "maybe" }).comp_unknown).toBe("keep");
  });

  it("drops keys it has never heard of", () => {
    const stored = parseCriteria({ role_family: "fp&a", drop_tables: true });
    expect(Object.keys(stored)).not.toContain("drop_tables");
  });
});

describe("isOnboarded", () => {
  it("reads the never-onboarded sentinel as no keys, not as matching the defaults", () => {
    // A `return true` here survived the whole suite before this test existed,
    // because `FixtureDataSource` answers the ProfileView it was handed and
    // never exercises the mapping. The distinction is load-bearing: somebody who
    // deliberately chose every default must not be sent back through onboarding
    // forever, and somebody who never arrived must not be dropped into an empty
    // queue with no explanation.
    expect(isOnboarded({})).toBe(false);
    expect(isOnboarded(null)).toBe(false);
    expect(isOnboarded(undefined)).toBe(false);
    expect(isOnboarded([])).toBe(false);
    expect(isOnboarded("{}")).toBe(false);
    expect(isOnboarded(BASE_CRITERIA)).toBe(true);
    expect(isOnboarded({ yoe_max: 4 })).toBe(true);
  });
});
