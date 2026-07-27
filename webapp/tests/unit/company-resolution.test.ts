import { describe, expect, it } from "vitest";
import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import {
  confidenceLabel,
  explainResolution,
  resolutionConfidence,
  sourceLabel,
  tierLabel,
  type CompanyView,
} from "@/lib/data/view-models";

/**
 * The provenance vocabulary — the honesty layer the coverage meter is built on.
 *
 * docs/plans/COMPANY-DISCOVERY-RESEARCH.md's "critical UX caveat" is that a tier
 * shown without its evidence "would render T1's soft estimate as if measured".
 * These tests pin the mapping from `resolution_method` (the values
 * monitor/discover_universe.py actually writes, plus the ones migration 0007
 * documents) to the four confidences — and, more importantly, they pin the
 * FAIL-CLOSED direction: anything this code does not recognise must never come
 * back "verified".
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
    companyUpdatedAt: null,
    updatedAt: null,
    ...over,
  };
}

describe("resolutionConfidence", () => {
  it("calls a probed ATS board verified — the resolver got a live answer", () => {
    // monitor/discover.py probes exactly these four families and requires a live
    // posting back; Greenhouse hits are additionally checked against the board's
    // own name. `_resolve()` writes `discover-<ats>` for whichever answered, so
    // this list is the complete set of strings that can claim evidence.
    for (const ats of ["greenhouse", "ashby", "lever", "smartrec"]) {
      expect(resolutionConfidence(co({ ats, resolutionMethod: `discover-${ats}` }))).toBe(
        "verified",
      );
    }
  });

  it("does NOT trust a discover-* the waterfall cannot produce", () => {
    // This was `startsWith("discover-")` — an OPEN prefix on a closed set. Any
    // future `discover-<anything>` (a new adapter, a hand-typed row, a typo, an
    // ingester borrowing the naming) was counted as a first-party board call
    // nobody made, which is the exact false confidence the fail-closed default
    // exists to prevent, arriving through the one branch that skipped it.
    //
    // Inferred rather than asserted: something did identify a board, and no probe
    // this code can name confirmed it. `discover-icims` is the live example —
    // iCIMS is in the fixture set and is NOT one of the four the resolver probes.
    for (const m of ["discover-icims", "discover-brassring", "discover-", "discover-taleo"]) {
      expect(resolutionConfidence(co({ resolutionMethod: m })), m).toBe("inferred");
    }
  });

  it("calls a CXS-confirmed Workday tenant verified", () => {
    // discover.py's _verify_workday: "the board is real iff its CXS jobs endpoint
    // returns 200 with a jobs payload" — never DNS or pod guessing.
    expect(
      resolutionConfidence(co({ ats: "workday", resolutionMethod: "workday-redirect" })),
    ).toBe("verified");
  });

  it("calls an aggregator or a web-search hit inferred, not verified", () => {
    // Postings arrive, but no first-party board call happened, so "day-of" is a
    // claim nobody checked.
    expect(resolutionConfidence(co({ tier: 2, resolutionMethod: "aggregator" }))).toBe("inferred");
    expect(resolutionConfidence(co({ resolutionMethod: "web-search" }))).toBe("inferred");
  });

  it("calls a mined slug asserted — Common Crawl contains dead boards", () => {
    // The research pass exercised Common Crawl live and recorded that it "needs a
    // downstream validity check (CC contains dead boards)". discover_universe.py
    // passes those slugs through WITHOUT probing them, so the row is tier 1 on
    // trust alone. Reporting that as verified is the meter lying.
    expect(resolutionConfidence(co({ resolutionMethod: "ingested-slug" }))).toBe("asserted");
  });

  it("calls a hand-added name asserted", () => {
    expect(
      resolutionConfidence(co({ tier: 3, ats: "", slug: "", resolutionMethod: "manual" })),
    ).toBe("asserted");
  });

  it("FAILS CLOSED on a method it has never seen", () => {
    // The load-bearing case. A future engine change, a hand-written row, a typo —
    // none of them may be counted as evidence. Defaulting the other way is exactly
    // how a coverage number becomes false confidence, and it would be invisible.
    expect(resolutionConfidence(co({ resolutionMethod: "vendor-hint-2026" }))).toBe("asserted");
    expect(resolutionConfidence(co({ resolutionMethod: "DISCOVERED" }))).toBe("asserted");
  });

  it("is case- and whitespace-insensitive about the methods it does know", () => {
    expect(resolutionConfidence(co({ resolutionMethod: "  Discover-Greenhouse " }))).toBe(
      "verified",
    );
  });

  it("reports no tier as unresolved, whatever the method says", () => {
    expect(resolutionConfidence(co({ tier: null }))).toBe("unresolved");
    // A tier with no method is equally unresolved: the tier alone is an assertion
    // with nothing behind it.
    expect(resolutionConfidence(co({ resolutionMethod: "" }))).toBe("unresolved");
    expect(resolutionConfidence(co({ resolutionMethod: "   " }))).toBe("unresolved");
  });
});

describe("labels", () => {
  it("names a tier with the latency that is the point of the tier", () => {
    expect(tierLabel(1)).toBe("Tier 1 · day-of");
    expect(tierLabel(2)).toBe("Tier 2 · lagged");
    expect(tierLabel(3)).toBe("Tier 3 · manual");
    expect(tierLabel(null)).toBe("Unresolved");
  });

  it("spells 'asserted' to the reader as 'unverified'", () => {
    // The internal word is a category; the word on screen has to be the one a
    // person acts on. "Asserted" reads as neutral; "unverified" reads as a caveat.
    expect(confidenceLabel("asserted")).toBe("unverified");
    expect(confidenceLabel("verified")).toBe("verified");
    expect(confidenceLabel("inferred")).toBe("inferred");
    expect(confidenceLabel("unresolved")).toBe("unresolved");
  });

  it("names a source in English and falls back to the raw tag", () => {
    expect(sourceLabel("commoncrawl")).toBe("Common Crawl");
    expect(sourceLabel("edgar")).toBe("SEC EDGAR");
    expect(sourceLabel("")).toBe("unknown");
    // An unrecognised tag shows verbatim rather than as "unknown" — the engine may
    // add a source before this map does, and hiding it would lose real provenance.
    expect(sourceLabel("new-ingester")).toBe("new-ingester");
  });
});

describe("explainResolution", () => {
  it("names the evidence, not the conclusion", () => {
    const s = explainResolution(co({ resolutionMethod: "discover-greenhouse" }));
    expect(s).toContain("greenhouse API");
    expect(s).toContain("greenhouse/co");
  });

  it("names the API from the ROW's ats, not from the method's suffix", () => {
    // They agree today because `_resolve()` writes `discover-<ats>`. Reading the
    // word out of the method string instead would let a mismatched pair — a mirror
    // bug, a hand-edited row — print a confident sentence about a board this
    // company does not have. The ats column is the one the sweep will fetch from,
    // so it is the one the sentence has to name.
    const s = explainResolution(
      co({ ats: "ashby", slug: "ramp", resolutionMethod: "discover-lever" }),
    );
    expect(s).toContain("ashby API");
    expect(s).toContain("ashby/ramp");
    expect(s).not.toContain("lever API");
  });

  it("says an unrecognised discover-* was never probed by the waterfall", () => {
    const s = explainResolution(co({ ats: "icims", slug: "aon", resolutionMethod: "discover-icims" }));
    expect(s).toContain("discover-icims");
    expect(s.toLowerCase()).toContain("lead");
    expect(s).not.toContain("day-of");
  });

  it("says out loud that a mined slug may be a dead board", () => {
    const s = explainResolution(co({ slug: "loopreturns", resolutionMethod: "ingested-slug" }));
    expect(s.toLowerCase()).toContain("dead board");
    expect(s.toLowerCase()).toContain("unverified");
  });

  it("says an unresolved row is not being pulled from", () => {
    const s = explainResolution(co({ tier: null, ats: "", slug: "", resolutionMethod: "" }));
    expect(s.toLowerCase()).toContain("nothing is pulled");
  });

  it("admits when it does not recognise the method", () => {
    const s = explainResolution(co({ resolutionMethod: "vendor-hint-2026" }));
    expect(s).toContain("vendor-hint-2026");
    expect(s.toLowerCase()).toContain("does not recognise");
  });

  it("never returns an empty string for any fixture row", () => {
    // A blank popover on the one control whose job is explaining provenance is
    // worse than no control.
    for (const c of FIXTURE_COMPANIES) {
      expect(explainResolution(c).length, `${c.id} ${c.name}`).toBeGreaterThan(20);
    }
  });
});

describe("the fixture set reaches every state", () => {
  it("covers all four confidences", () => {
    const seen = new Set(FIXTURE_COMPANIES.map(resolutionConfidence));
    expect([...seen].sort()).toEqual(["asserted", "inferred", "unresolved", "verified"]);
  });

  it("covers all three tiers plus unresolved", () => {
    const seen = new Set(FIXTURE_COMPANIES.map((c) => c.tier));
    expect([...seen].sort()).toEqual([1, 2, 3, null]);
  });

  it("covers all three review states", () => {
    const seen = new Set(FIXTURE_COMPANIES.map((c) => c.reviewState));
    expect([...seen].sort()).toEqual(["approved", "dismissed", "proposed"]);
  });

  it("contains an approved-but-not-swept row and a nameless row", () => {
    // Both are cases a naive grid renders wrong: the first collapses `enabled`
    // into approval, the second paints a blank line.
    expect(
      FIXTURE_COMPANIES.some((c) => c.reviewState === "approved" && !c.enabled),
    ).toBe(true);
    expect(FIXTURE_COMPANIES.some((c) => c.name === "" && c.slug !== "")).toBe(true);
  });
});
