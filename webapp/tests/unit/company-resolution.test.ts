import { describe, expect, it } from "vitest";
import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import {
  confidenceLabel,
  explainResolution,
  refreshLabel,
  resolutionConfidence,
  sourceQuality,
  sourceLabel,
  NOT_LISTED,
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
    linkedinIdSource: "",
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
  it("reserves Added by you for rows that actually came from the person", () => {
    expect(
      sourceQuality(co({ source: "commoncrawl", resolutionMethod: "ingested-slug" })),
    ).toBe("inferred");
    expect(
      sourceQuality(
        co({ source: "paste", tier: 3, ats: "", slug: "", resolutionMethod: "manual" }),
      ),
    ).toBe("asserted");
  });

  it("states the latency a reliability rank means, and never the rank", () => {
    // MUTATION REASON: restore `return `Tier ${tier}`` inside refreshLabel and
    // the "never the word tier" loop below is what fails. The rank is an engine
    // fact; on screen it reads as a quality grade, which is the exact misreading
    // the display dictionary exists to stop.
    expect(refreshLabel(1)).toBe("Jobs arrive the day they post");
    expect(refreshLabel(2)).toBe("Jobs arrive with a lag");
    expect(refreshLabel(3)).toBe("Tracked, not pulled automatically");
    expect(refreshLabel(null)).toBe("No job board found yet");
    for (const t of [1, 2, 3, null] as const) {
      expect(refreshLabel(t).toLowerCase()).not.toContain("tier");
      // The interpunct as glue, banned by the design checklist and shipped
      // inside this very function ("Tier 1 \u00B7 day-of").
      expect(refreshLabel(t)).not.toContain("\u00B7");
    }
  });

  it("renders the four source-quality words, never the engine confidences", () => {
    // MUTATION REASON: revert SOURCE_QUALITY_LABELS to the identity mapping
    // (verified -> "verified") and every line here fails. The engine four are a
    // category system; these four are what a person acts on.
    expect(confidenceLabel("verified")).toBe("Confirmed");
    expect(confidenceLabel("inferred")).toBe("Likely");
    expect(confidenceLabel("asserted")).toBe("Added by you");
    expect(confidenceLabel("unresolved")).toBe("Not found yet");
    for (const c of ["verified", "inferred", "asserted", "unresolved"] as const) {
      expect(confidenceLabel(c).toLowerCase()).not.toMatch(
        /verified|inferred|asserted|unresolved/,
      );
    }
  });

  it("names a source in English and falls back to the raw tag", () => {
    expect(sourceLabel("commoncrawl")).toBe("Common Crawl");
    expect(sourceLabel("edgar")).toBe("SEC EDGAR");
    // ONE absence word for the whole product. "unknown" was a second one.
    expect(sourceLabel("")).toBe(NOT_LISTED);
    // An unrecognised tag shows verbatim rather than as the absence word: the
    // engine may add a source before this map does, and hiding it would lose a
    // real origin.
    expect(sourceLabel("new-ingester")).toBe("new-ingester");
  });
});

describe("explainResolution", () => {
  it("names the evidence, not the conclusion", () => {
    const s = explainResolution(co({ resolutionMethod: "discover-greenhouse" }));
    expect(s).toContain("Found on greenhouse");
    expect(s).toContain("greenhouse/co");
  });

  it("speaks the product vocabulary, not the engine one, on every branch", () => {
    // MUTATION REASON: put "tier" back into any branch of explainResolution and
    // this fails. The function whose whole job is TRANSLATING the engine words
    // was itself written in them: tier, probe, sweep, verified, ATS.
    const banned = /\btiers?\b|\bprobed?\b|\bsweeps?\b|\bverified\b|\bunverified\b|\bATS\b/i;
    for (const c of FIXTURE_COMPANIES) {
      expect(explainResolution(c), `${c.id} ${c.name}`).not.toMatch(banned);
    }
    for (const m of [
      "discover-greenhouse",
      "workday-redirect",
      "discover-icims",
      "ingested-slug",
      "manual",
      "aggregator",
      "web-search",
      "vendor-hint-2026",
      "",
    ]) {
      expect(explainResolution(co({ resolutionMethod: m })), m).not.toMatch(banned);
    }
  });

  it("names the board from the ROW's ats, not from the method's suffix", () => {
    // They agree today because `_resolve()` writes `discover-<ats>`. Reading the
    // word out of the method string instead would let a mismatched pair — a mirror
    // bug, a hand-edited row — print a confident sentence about a board this
    // company does not have. The ats column is the one the sweep will fetch from,
    // so it is the one the sentence has to name.
    const s = explainResolution(
      co({ ats: "ashby", slug: "ramp", resolutionMethod: "discover-lever" }),
    );
    expect(s).toContain("Found on ashby");
    expect(s).toContain("ashby/ramp");
    expect(s).not.toContain("Found on lever");
  });

  it("says an unrecognised discover-* was never checked by the waterfall", () => {
    const s = explainResolution(co({ ats: "icims", slug: "aon", resolutionMethod: "discover-icims" }));
    expect(s).toContain("icims/aon");
    expect(s.toLowerCase()).toContain("lead");
    expect(s.toLowerCase()).toContain("cannot check");
  });

  it("says out loud that a mined slug may be a dead board", () => {
    const s = explainResolution(co({ slug: "loopreturns", resolutionMethod: "ingested-slug" }));
    expect(s.toLowerCase()).toContain("may be dead");
    expect(s.toLowerCase()).toContain("lead");
  });

  it("says an unresolved row is not being pulled from", () => {
    const s = explainResolution(co({ tier: null, ats: "", slug: "", resolutionMethod: "" }));
    expect(s.toLowerCase()).toContain("no jobs are pulled");
  });

  it("admits when it does not recognise the route, without printing the token", () => {
    const s = explainResolution(co({ resolutionMethod: "vendor-hint-2026" }));
    // The raw engine token never reaches the screen (terminology spec 5).
    expect(s).not.toContain("vendor-hint-2026");
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
