import { describe, expect, it } from "vitest";
import { BASE_CRITERIA, describesASearch } from "@/lib/profile/criteria";
import {
  boardTermFromRole,
  titlesAreDerived,
  titlesFromRole,
  withDerivedDefaults,
} from "@/lib/profile/derive";
import { draftFromPreset } from "@/lib/profile/presets";

/**
 * One typed field has to produce a profile the engine can run.
 *
 * The wizard asked for three separate things before it would advance, two of
 * which are the engine's vocabulary rather than anyone's. These derive them,
 * into fields that stay on screen and stay editable.
 */

describe("titlesFromRole", () => {
  it("makes the role its own title, once", () => {
    // Contains-matching does the rest: "data analyst" already catches "Senior
    // Data Analyst" and "Data Analyst II".
    expect(titlesFromRole("Data Analyst")).toEqual(["data analyst"]);
    expect(titlesFromRole("  Nurse   Practitioner ")).toEqual(["nurse practitioner"]);
  });

  it("derives nothing from nothing", () => {
    expect(titlesFromRole("")).toEqual([]);
    expect(titlesFromRole("   ")).toEqual([]);
  });
});

describe("boardTermFromRole", () => {
  it("picks the word that names the work, not the level", () => {
    expect(boardTermFromRole("senior financial analyst")).toBe("financial");
    expect(boardTermFromRole("product manager")).toBe("product");
    expect(boardTermFromRole("staff software engineer")).toBe("software");
  });

  it("matches what the committed profiles use", () => {
    // `users/salman/profile.yaml` searches for "product"; `users/dad/profile.yaml`
    // for "financial". A derivation that disagreed with the two real profiles
    // would be deriving the wrong thing.
    expect(boardTermFromRole("product manager")).toBe("product");
    expect(boardTermFromRole("financial planning & analysis")).toBe("financial");
  });

  it("falls back to the first word rather than to nothing", () => {
    expect(boardTermFromRole("vp")).toBe("vp");
    expect(boardTermFromRole("")).toBe("");
  });
});

describe("titlesAreDerived", () => {
  it("stops claiming a list once somebody has edited it", () => {
    expect(titlesAreDerived([], "data analyst")).toBe(true);
    expect(titlesAreDerived(["data analyst"], "Data Analyst")).toBe(true);
    expect(titlesAreDerived(["data analyst", "analytics manager"], "data analyst")).toBe(false);
    expect(titlesAreDerived(["something i typed"], "data analyst")).toBe(false);
  });

  it("reads a preset's list as somebody's answer", () => {
    const pm = draftFromPreset("product-manager");
    expect(titlesAreDerived(pm.titles_include, pm.role_family)).toBe(false);
  });
});

describe("withDerivedDefaults", () => {
  it("turns one typed field into a profile the engine can run", () => {
    const one = { ...BASE_CRITERIA, role_family: "clinical research coordinator" };
    const full = withDerivedDefaults({
      ...one,
      tag_domain: "",
      board_search_term: "",
      titles_include: [],
    });
    expect(full.titles_include).toEqual(["clinical research coordinator"]);
    expect(full.board_search_term).toBe("clinical");
    expect(full.tag_domain).toBe("clinical research coordinator");
    expect(describesASearch(full)).toBe(true);
  });

  it("never overwrites an answer", () => {
    const answered = {
      ...BASE_CRITERIA,
      role_family: "data analyst",
      tag_domain: "analytics",
      board_search_term: "data",
      titles_include: ["business intelligence analyst"],
    };
    expect(withDerivedDefaults(answered)).toEqual(answered);
  });

  it("leaves a profile with no role alone rather than inventing one", () => {
    // The lie `parseCriteria` used to tell was filling an empty role in from the
    // committed baseline. Nothing here may reintroduce it.
    const blank = { ...BASE_CRITERIA, role_family: "", tag_domain: "", board_search_term: "" };
    const out = withDerivedDefaults(blank);
    expect(out.role_family).toBe("");
    expect(out.titles_include).toEqual([]);
    expect(describesASearch(out)).toBe(false);
  });
});
