import { describe, expect, it } from "vitest";
import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import type { CompanyView } from "@/lib/data/view-models";
import { ORACLE_UNMEASURED, computeCoverage, sharePct } from "@/lib/grid/coverage";
import { rowsForCompanySet } from "@/lib/grid/company-presets";

/**
 * The coverage meter's arithmetic.
 *
 * The thing under test is not really the addition — it is the REFUSAL. The
 * research pass's headline warning about this exact widget is that it "would
 * render T1's soft estimate as if measured", and its own Dad figure was 47%
 * grounded against a ~75% best-estimate. So the assertions below are mostly about
 * numbers the meter must NOT produce: a tier count that swallows an unverifiable
 * row, and a recall percentage of a denominator nobody has measured.
 */

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
    linkedinIdSource: "",
    companyUpdatedAt: null,
    updatedAt: null,
    ...over,
  };
}

describe("computeCoverage", () => {
  it("counts an empty universe without dividing by zero", () => {
    const c = computeCoverage([]);
    expect(c).toMatchObject({ total: 0, resolved: 0, unresolved: 0, verifiedTier1: 0 });
    // NaN% on the first screen a new user sees is the app looking broken on the
    // one surface whose job is telling them how it is doing.
    expect(sharePct(c.resolved, c.total)).toBe(0);
  });

  it("splits tiers and confidences over the same rows", () => {
    const c = computeCoverage([
      co({ id: 1, resolutionMethod: "discover-greenhouse" }),           // T1 verified
      co({ id: 2, ats: "workday", resolutionMethod: "workday-redirect" }), // T1 verified
      co({ id: 3, source: "commoncrawl", resolutionMethod: "ingested-slug" }), // T1 likely
      co({ id: 4, tier: 2, resolutionMethod: "aggregator" }),           // T2 inferred
      co({ id: 5, source: "paste", tier: 3, resolutionMethod: "manual" }), // T3 added by user
      co({ id: 6, tier: null, resolutionMethod: "" }),                  // unresolved
    ]);
    expect(c.total).toBe(6);
    expect(c.resolved).toBe(5);
    expect(c.unresolved).toBe(1);
    expect(c.byTier[0]).toEqual({ tier: 1, count: 3, verified: 2, inferred: 1, asserted: 0 });
    expect(c.byTier[1]).toEqual({ tier: 2, count: 1, verified: 0, inferred: 1, asserted: 0 });
    expect(c.byTier[2]).toEqual({ tier: 3, count: 1, verified: 0, inferred: 0, asserted: 1 });
    expect(c.byConfidence).toEqual({ verified: 2, inferred: 2, asserted: 1, unresolved: 1 });
  });

  it("reports verified tier 1 SEPARATELY from tier 1", () => {
    // The whole point of the widget. Three companies are "Tier 1 · day-of"; only
    // two have ever had a board answer. A meter that printed 3 would be the
    // research pass's warning, shipped: a soft estimate rendered as a measurement.
    const c = computeCoverage([
      co({ id: 1, resolutionMethod: "discover-greenhouse" }),
      co({ id: 2, resolutionMethod: "discover-ashby" }),
      co({ id: 3, resolutionMethod: "ingested-slug" }),
    ]);
    expect(c.byTier[0].count).toBe(3);
    expect(c.verifiedTier1).toBe(2);
    expect(c.verifiedTier1).toBeLessThan(c.byTier[0].count);
  });

  it("keeps a tiered row with an unreadable method OUT of every tier bucket", () => {
    // A row claiming tier 1 with no method behind it must not land in
    // "Tier 1 · day-of" — its day-of-ness is supported by nothing. `resolved`
    // keys off the confidence rather than off the tier column so the two numbers
    // can never disagree with each other.
    const c = computeCoverage([co({ tier: 1, resolutionMethod: "" })]);
    expect(c.byTier[0].count).toBe(0);
    expect(c.resolved).toBe(0);
    expect(c.unresolved).toBe(1);
    expect(c.byConfidence.unresolved).toBe(1);
  });

  it("every tier bucket's confidences sum to its count", () => {
    // An internal consistency invariant: a row cannot be in a tier without also
    // being in exactly one confidence bucket, or the two rails of the meter
    // silently describe different sets.
    const c = computeCoverage(FIXTURE_COMPANIES);
    for (const t of c.byTier) {
      expect(t.verified + t.inferred + t.asserted, `tier ${t.tier}`).toBe(t.count);
    }
    expect(c.byTier.reduce((n, t) => n + t.count, 0)).toBe(c.resolved);
    expect(c.resolved + c.unresolved).toBe(c.total);
  });

  it("describes exactly the set it is handed", () => {
    // The grid passes the APPROVED universe, because a proposal nobody accepted is
    // not coverage of anything. Passing a different set changes the meaning of
    // every number, which is why the component states which set it counted.
    const approved = rowsForCompanySet(FIXTURE_COMPANIES, "universe");
    const c = computeCoverage(approved);
    expect(c.total).toBe(approved.length);
    expect(c.total).toBeLessThan(FIXTURE_COMPANIES.length);
  });

  it("the fixture universe has a non-zero unresolved slice", () => {
    // If it were zero, the "unresolved" rail would never render and would ship
    // unlooked-at — matrix row 15's lesson, applied to a meter.
    expect(computeCoverage(FIXTURE_COMPANIES).unresolved).toBeGreaterThan(0);
  });
});

describe("sharePct", () => {
  it("rounds to a whole percent", () => {
    expect(sharePct(1, 3)).toBe(33);
    expect(sharePct(2, 3)).toBe(67);
    expect(sharePct(5, 5)).toBe(100);
    expect(sharePct(0, 5)).toBe(0);
  });

  it("answers 0 rather than NaN or Infinity on an empty denominator", () => {
    expect(sharePct(0, 0)).toBe(0);
    expect(sharePct(3, 0)).toBe(0);
    expect(sharePct(1, -1)).toBe(0);
  });
});

describe("the oracle slot", () => {
  it("is empty, because nothing in this app can measure recall", () => {
    // monitor/oracle.py computes recall against TheirStack's blurred denominator.
    // It is a keyed Python job, nothing writes its result anywhere the web app
    // reads, and the research pass marks every denominator "Estimate-only".
    // A number here would be fabricated.
    expect(ORACLE_UNMEASURED).toEqual({ facet: null, denominator: null, recallPct: null });
  });

  it("has no default number that could be mistaken for a measurement", () => {
    for (const v of Object.values(ORACLE_UNMEASURED)) expect(v).toBeNull();
  });
});
