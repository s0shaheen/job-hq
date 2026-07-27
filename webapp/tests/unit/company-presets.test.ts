import { describe, expect, it } from "vitest";
import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import type { CompanyView } from "@/lib/data/view-models";
import {
  COMPANY_PERSONAS,
  COMPANY_PRESETS,
  COMPANY_SETS,
  companyPresetName,
  isCompanySet,
  isCompanySortField,
  rowsForCompanySet,
  setForReviewState,
  sortCompanies,
} from "@/lib/grid/company-presets";

function co(over: Partial<CompanyView> = {}): CompanyView {
  return {
    key: "1",
    id: 1,
    name: "Co",
    ats: "greenhouse",
    slug: "co",
    source: "seed",
    tier: 1,
    resolutionMethod: "discover-greenhouse",
    reviewState: "approved",
    enabled: true,
    priority: false,
    seeded: false,
    linkedinCompanyId: "",
    companyUpdatedAt: null,
    updatedAt: null,
    ...over,
  };
}

describe("working sets", () => {
  it("every set has a preset and every preset a set", () => {
    expect(COMPANY_PRESETS.map((p) => p.set).sort()).toEqual([...COMPANY_SETS].sort());
  });

  it("names the presets as the switcher and the e2e both expect", () => {
    expect(COMPANY_PRESETS.map((p) => p.name)).toEqual([
      "Needs review",
      "My universe",
      "Unresolved",
      "Dismissed",
      "All companies",
    ]);
    expect(companyPresetName("review")).toBe("Needs review");
  });

  it("rejects a set name it does not know", () => {
    expect(isCompanySet("review")).toBe(true);
    expect(isCompanySet("queue")).toBe(false);
    expect(isCompanySet("")).toBe(false);
  });

  it("partitions review, universe and dismissed with no overlap", () => {
    const review = rowsForCompanySet(FIXTURE_COMPANIES, "review");
    const universe = rowsForCompanySet(FIXTURE_COMPANIES, "universe");
    const dismissed = rowsForCompanySet(FIXTURE_COMPANIES, "dismissed");
    expect(review.length + universe.length + dismissed.length).toBe(FIXTURE_COMPANIES.length);
    const keys = [...review, ...universe, ...dismissed].map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("'all' is the input untouched — never a third, secretly-different list", () => {
    expect(rowsForCompanySet(FIXTURE_COMPANIES, "all")).toBe(FIXTURE_COMPANIES);
  });

  it("'unresolved' includes an APPROVED row with no board", () => {
    // The case that most needs surfacing: the user believes they are watching this
    // company and nothing is being pulled. Scoping the set to proposals would hide
    // exactly that, which is why the filter spans review states.
    const rows = [
      co({ id: 1, reviewState: "approved", tier: null, ats: "", slug: "", resolutionMethod: "" }),
      co({ id: 2, reviewState: "proposed", tier: null, ats: "", slug: "", resolutionMethod: "" }),
      co({ id: 3, reviewState: "approved" }),
      co({ id: 4, reviewState: "dismissed", tier: null, resolutionMethod: "" }),
    ];
    expect(rowsForCompanySet(rows, "unresolved").map((c) => c.id)).toEqual([1, 2]);
  });

  it("'unresolved' catches a tiered row whose method is unreadable", () => {
    // Tier 1 with nothing behind it is not resolved, whatever the column says —
    // the same rule the coverage meter enforces, so the two agree.
    const rows = [co({ id: 7, reviewState: "approved", tier: 1, resolutionMethod: "" })];
    expect(rowsForCompanySet(rows, "unresolved").map((c) => c.id)).toEqual([7]);
  });

  it("maps a review decision to the set the row lands in", () => {
    expect(setForReviewState("approved")).toBe("universe");
    expect(setForReviewState("dismissed")).toBe("dismissed");
    expect(setForReviewState("proposed")).toBe("review");
  });
});

describe("sortCompanies", () => {
  it("returns the input untouched with no sort", () => {
    expect(sortCompanies(FIXTURE_COMPANIES, null)).toBe(FIXTURE_COMPANIES);
  });

  it("does not mutate its input", () => {
    const rows = [co({ id: 2, name: "B" }), co({ id: 1, name: "A" })];
    sortCompanies(rows, { field: "name", dir: "asc" });
    expect(rows.map((c) => c.id)).toEqual([2, 1]);
  });

  it("puts an unknown tier last in BOTH directions", () => {
    // /jobs' matrix row 57 on a new surface. Sorting "tier ascending" must not
    // crown the rows we know least about, and flipping the arrow must not either.
    const rows = [
      co({ id: 1, tier: null, resolutionMethod: "" }),
      co({ id: 2, tier: 2, resolutionMethod: "aggregator" }),
      co({ id: 3, tier: 1 }),
    ];
    expect(sortCompanies(rows, { field: "tier", dir: "asc" }).map((c) => c.id)).toEqual([3, 2, 1]);
    expect(sortCompanies(rows, { field: "tier", dir: "desc" }).map((c) => c.id)).toEqual([2, 3, 1]);
  });

  it("ranks a verified board above an unprobed one INSIDE the same tier", () => {
    // The distinction the whole surface exists to show. A tier sort that ignored
    // confidence would put an unprobed Common Crawl slug above a CXS-confirmed
    // Workday tenant, both being "tier 1".
    const rows = [
      co({ id: 1, resolutionMethod: "ingested-slug" }),   // T1 asserted
      co({ id: 2, resolutionMethod: "discover-ashby" }),  // T1 verified
      co({ id: 3, resolutionMethod: "web-search" }),      // T1 inferred
    ];
    expect(sortCompanies(rows, { field: "tier", dir: "asc" }).map((c) => c.id)).toEqual([2, 3, 1]);
  });

  it("puts a nameless row last in BOTH directions", () => {
    // Common Crawl mines boards, not names. Alphabetical order would silently make
    // "" the top result, which is a row with nothing in its most prominent cell.
    const rows = [
      co({ id: 1, name: "" }),
      co({ id: 2, name: "Aon" }),
      co({ id: 3, name: "Zurich" }),
    ];
    expect(sortCompanies(rows, { field: "name", dir: "asc" }).map((c) => c.id)).toEqual([2, 3, 1]);
    expect(sortCompanies(rows, { field: "name", dir: "desc" }).map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it("puts a blank ats or source last in both directions too", () => {
    const rows = [
      co({ id: 1, ats: "", source: "" }),
      co({ id: 2, ats: "ashby", source: "edgar" }),
    ];
    for (const dir of ["asc", "desc"] as const) {
      expect(sortCompanies(rows, { field: "ats", dir }).map((c) => c.id)).toEqual([2, 1]);
      expect(sortCompanies(rows, { field: "source", dir }).map((c) => c.id)).toEqual([2, 1]);
    }
  });

  it("is a total order — equal rows keep a stable id sequence", () => {
    // Without the tiebreak, two rows equal on the sort field swap places between
    // renders and the grid appears to shuffle itself under the cursor.
    const rows = [3, 1, 2].map((id) => co({ id, name: "Same" }));
    for (const dir of ["asc", "desc"] as const) {
      expect(sortCompanies(rows, { field: "name", dir }).map((c) => c.id)).toEqual([1, 2, 3]);
    }
  });

  it("keeps every row — a sort never drops or duplicates one", () => {
    for (const field of ["name", "tier", "source", "ats"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const out = sortCompanies(FIXTURE_COMPANIES, { field, dir });
        expect(out.length, `${field} ${dir}`).toBe(FIXTURE_COMPANIES.length);
        expect(new Set(out.map((c) => c.key)).size).toBe(FIXTURE_COMPANIES.length);
      }
    }
  });

  it("rejects a sort field it does not know", () => {
    expect(isCompanySortField("tier")).toBe(true);
    expect(isCompanySortField("comp")).toBe(false);
  });
});

describe("personas", () => {
  it("each names a real set and a valid sort field", () => {
    expect(COMPANY_PERSONAS.length).toBe(3);
    for (const p of COMPANY_PERSONAS) {
      expect(isCompanySet(p.set), p.id).toBe(true);
      if (p.sort) expect(isCompanySortField(p.sort.field), p.id).toBe(true);
      expect(p.hint.length).toBeGreaterThan(10);
    }
  });

  it("the two research personas differ in what they lead with", () => {
    // Grounded in docs/plans/COMPANY-DISCOVERY-RESEARCH.md: the roommate's
    // universe already resolves 25/30 directly, so his seed shows the approved set
    // sorted by trust; Dad's is a recall problem, so his seed IS the review pile.
    const dad = COMPANY_PERSONAS.find((p) => p.id === "dad")!;
    const roommate = COMPANY_PERSONAS.find((p) => p.id === "roommate")!;
    expect(dad.set).toBe("review");
    expect(roommate.set).toBe("universe");
    expect(roommate.sort).toEqual({ field: "tier", dir: "asc" });
  });
});
