import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WARM_MAX_RESULTS, warmMaxResults } from "@/lib/warm/config";
import {
  classifyWarmAdd,
  deriveWarmParams,
  nameFromLinkedinUrl,
  normalizeWarmParams,
  rankCandidates,
  searchedForLine,
  sortByFit,
  WARM_PERSONAS,
} from "@/lib/warm/types";
import type { RawCandidate, WarmCandidate } from "@/lib/warm/types";

/**
 * The pure logic of the warm-intro finder — the merge/rank model, the fit re-order,
 * the role derivation, the manual-add classifier, and the wire normaliser. No
 * network, no vendor, no store: this is the one definition of what a candidate IS
 * and how the list is ordered, shared by the UI, the fixtures, and the fake vendor.
 *
 * Every load-bearing assertion names the mutant it kills. The scoring weights
 * (school 3, past-company 2, persona 1, recruiter GUARANTEED not scored), the dedup
 * identity (URL, else name+company), and the fit re-order (tier before score,
 * SET preserved) are what a swap must not quietly change, so they are pinned hardest.
 */

// A stubbed HQ_WARM_MAX_RESULTS must never leak between the config-knob cases below
// and the cap/recruiter cases that read the real default.
afterEach(() => vi.unstubAllEnvs());

// ------------------------------------------------------------------- helpers

/** A RawCandidate with sane defaults; `persona` is the one thing every row needs. */
function raw(over: Partial<RawCandidate> & Pick<RawCandidate, "persona">): RawCandidate {
  return {
    fullName: "Person",
    headline: "Headline",
    company: "Ramp",
    location: "United States",
    years: "",
    linkedinUrl: "",
    ...over,
  };
}

/** A ranked WarmCandidate with sane defaults; only `fullName` is required. */
function cand(over: Partial<WarmCandidate> & Pick<WarmCandidate, "fullName">): WarmCandidate {
  return {
    headline: "",
    company: "Ramp",
    location: "",
    years: "",
    linkedinUrl: "",
    isRecruiter: false,
    signals: [],
    score: 0,
    ...over,
  };
}

// --------------------------------------------------------------- warmMaxResults

describe("warmMaxResults (the merged-cap knob)", () => {
  it("defaults to 40 when HQ_WARM_MAX_RESULTS is unset", () => {
    vi.stubEnv("HQ_WARM_MAX_RESULTS", "");
    // MUTATION: default drifts off 40 -> the whole cap suite miscounts.
    expect(warmMaxResults()).toBe(40);
    expect(DEFAULT_WARM_MAX_RESULTS).toBe(40);
  });

  it("honours an in-range override (10..50 inclusive)", () => {
    for (const [env, expected] of [
      ["10", 10],
      ["25", 25],
      ["50", 50],
    ] as const) {
      vi.stubEnv("HQ_WARM_MAX_RESULTS", env);
      // MUTATION: ignore the env var -> a deployment cannot raise the cap without a deploy.
      expect(warmMaxResults()).toBe(expected);
    }
  });

  it("falls back to the default for an out-of-range or non-integer value — a bad knob can't take the feature down", () => {
    for (const bad of ["9", "51", "0", "-5", "abc", "25.5", ""]) {
      vi.stubEnv("HQ_WARM_MAX_RESULTS", bad);
      // MUTATION: clamp-to-boundary or trust-the-raw-value -> 9/51 leak through instead of 40.
      expect(warmMaxResults()).toBe(DEFAULT_WARM_MAX_RESULTS);
    }
  });
});

// --------------------------------------------------------------- rankCandidates

describe("rankCandidates", () => {
  it("merges one person returned by two personas into ONE row: union of signals, summed score", () => {
    // Same profile URL, seen by the role sweep and the senior sweep. Being both
    // "in your role" and "senior in your area" is a stronger ask, not two people.
    const url = "https://www.linkedin.com/in/priya-natarajan";
    const out = rankCandidates([
      raw({ persona: "role", fullName: "Priya Natarajan", linkedinUrl: url }),
      raw({ persona: "senior", fullName: "Priya Natarajan", linkedinUrl: url }),
    ]);

    // MUTATION: identity() keyed on anything but the URL (or dedup dropped) -> two rows here.
    expect(out).toHaveLength(1);
    // MUTATION: `cand.score += weight` replaced with `=` -> score 1, not 2.
    expect(out[0].score).toBe(2);
    // MUTATION: the union collapsed to the last-seen signal -> length 1.
    expect(out[0].signals.map((s) => s.label).sort()).toEqual([
      "In your role",
      "Senior in your area",
    ]);
  });

  it("scores additively: a school match (+3) outranks a bare persona (+1); ties break by name", () => {
    // Input order deliberately does NOT match the expected order, so both the
    // score comparator and the name tiebreak are exercised.
    const out = rankCandidates([
      raw({ persona: "role", fullName: "Cara", linkedinUrl: "u:cara" }), // score 1
      raw({ persona: "role", fullName: "Bob", linkedinUrl: "u:bob", matchedSchool: "Norvale" }), // score 4
      raw({ persona: "role", fullName: "Aaron", linkedinUrl: "u:aaron" }), // score 1
    ]);

    // MUTATION: school weight 3 -> 0 collapses Bob to a tie and Aaron (a<b) leads.
    // MUTATION: comparator flipped (a.score-b.score) puts the score-1 pair first.
    // MUTATION: name tiebreak dropped -> stable input order [Bob, Cara, Aaron].
    expect(out.map((c) => c.fullName)).toEqual(["Bob", "Aaron", "Cara"]);
    expect(out[0].score).toBe(4);
    expect(out[1].score).toBe(1);
  });

  it("caps the list at warmMaxResults()", () => {
    const max = warmMaxResults();
    const overCap = Array.from({ length: max + 5 }, (_, i) =>
      raw({ persona: "role", fullName: `Peer ${String(i).padStart(3, "0")}`, linkedinUrl: `u:${i}` }),
    );
    const out = rankCandidates(overCap);
    // MUTATION: drop the `.slice(0, warmMaxResults())` -> all max+5 come back.
    expect(out).toHaveLength(max);
    // A default deployment returns 40, not the old 10.
    expect(max).toBe(40);
  });

  it("GUARANTEES a recruiter a slot even when every recruiter scores below the cut", () => {
    // `warmMaxResults()` non-recruiters that all outscore the recruiter (persona is
    // not scored up), so the recruiter falls one past the cap and the naive cut
    // drops it. The swap logic must put it back — the recruiter link is the one that
    // never has a zero-result day.
    const max = warmMaxResults();
    const peers = Array.from({ length: max }, (_, i) =>
      raw({ persona: "role", fullName: `Peer ${String(i).padStart(3, "0")}`, linkedinUrl: `u:peer:${i}` }),
    );
    const recruiter = raw({
      persona: "recruiter",
      fullName: "Rita Recruiter",
      linkedinUrl: "u:recruiter",
    });
    const out = rankCandidates([...peers, recruiter]);

    expect(out).toHaveLength(max);
    // MUTATION: remove the recruiter-swap block -> no recruiter survives the cut.
    expect(out.some((c) => c.isRecruiter)).toBe(true);
    expect(out.find((c) => c.isRecruiter)?.fullName).toBe("Rita Recruiter");
  });

  it("dedupes on name+company when the profile URL is blank — a different company is a different person", () => {
    const out = rankCandidates([
      raw({ persona: "role", fullName: "Sam Ray", company: "Ramp", linkedinUrl: "" }),
      raw({ persona: "senior", fullName: "Sam Ray", company: "Ramp", linkedinUrl: "" }),
      raw({ persona: "role", fullName: "Sam Ray", company: "Stripe", linkedinUrl: "" }),
    ]);

    // MUTATION: name-only (or constant) identity merges the Stripe row in too -> length 1.
    expect(out).toHaveLength(2);
    const ramp = out.find((c) => c.company === "Ramp");
    const stripe = out.find((c) => c.company === "Stripe");
    expect(ramp?.score).toBe(2); // role + senior merged
    expect(stripe?.score).toBe(1); // its own row
  });
});

// ------------------------------------------------------------------ sortByFit

describe("sortByFit", () => {
  it("puts a strong fit above a higher-SCORE but weak fit — the LLM read overrides the deterministic score", () => {
    const weakHigh = cand({ fullName: "Zed", score: 10, fit: { tier: "weak", reason: "same function" } });
    const strongLow = cand({ fullName: "Amy", score: 1, fit: { tier: "strong", reason: "shared Norvale" } });
    const out = sortByFit([weakHigh, strongLow]);
    // MUTATION: sort by score first (or ignore fit) -> Zed (score 10) leads.
    expect(out.map((c) => c.fullName)).toEqual(["Amy", "Zed"]);
  });

  it("sorts a candidate with NO fit last among equals — never above a fitted one", () => {
    // Equal score: only the fit tier can separate them. The un-annotated row is rank 0.
    const noFit = cand({ fullName: "Aaron", score: 5 });
    const weak = cand({ fullName: "Zoe", score: 5, fit: { tier: "weak", reason: "same function" } });
    const out = sortByFit([noFit, weak]);
    // MUTATION: treat missing fit as a top tier (or fall through to name) -> Aaron leads.
    expect(out.map((c) => c.fullName)).toEqual(["Zoe", "Aaron"]);
  });

  it("preserves the SET — the recruiter guarantee rankCandidates gave still holds after the re-order", () => {
    const recruiter = cand({
      fullName: "Rita Recruiter",
      isRecruiter: true,
      score: 0,
      fit: { tier: "medium", reason: "recruiter for this role" },
    });
    const input: WarmCandidate[] = [
      cand({ fullName: "Bob", score: 4, fit: { tier: "weak", reason: "same function" } }),
      cand({ fullName: "Ada", score: 1, fit: { tier: "strong", reason: "shared Norvale" } }),
      recruiter,
      cand({ fullName: "Cara", score: 2 }),
    ];
    const before = input.map((c) => c.fullName).sort();
    const out = sortByFit(input);

    // MUTATION: a comparator that drops rows (or a filter creeping in) shrinks the set.
    expect(out.map((c) => c.fullName).sort()).toEqual(before);
    // The recruiter survives the re-order — the guarantee is not undone by fit.
    expect(out.some((c) => c.isRecruiter && c.fullName === "Rita Recruiter")).toBe(true);
    // Order: strong (Ada) > medium (Rita) > weak (Bob) > no-fit (Cara).
    expect(out.map((c) => c.fullName)).toEqual(["Ada", "Rita Recruiter", "Bob", "Cara"]);
    // MUTATION: sortByFit mutates its input in place instead of copying.
    expect(input.map((c) => c.fullName)).toEqual(["Bob", "Ada", "Rita Recruiter", "Cara"]);
  });
});

// -------------------------------------------------------------- deriveWarmParams

describe("deriveWarmParams", () => {
  it('"Product Manager" derives the product persona set', () => {
    expect(deriveWarmParams("Product Manager")).toEqual({
      role: "Product Manager",
      senior: "Director of Product or above",
      recruiter: "Product recruiter",
    });
  });

  it('"Staff Software Engineer" derives the Engineering area for senior + recruiter', () => {
    const p = deriveWarmParams("Staff Software Engineer");
    expect(p.role).toBe("Staff Software Engineer");
    // MUTATION: functionArea() dropping the eng/software branch falls back to Product.
    expect(p.senior).toBe("Director of Engineering or above");
    expect(p.recruiter).toBe("Engineering recruiter");
  });

  it("falls back to the Product Manager shape for a blank role", () => {
    // MUTATION: `clean || "Product Manager"` removed -> empty role/senior/recruiter.
    for (const blank of ["", "   "]) {
      expect(deriveWarmParams(blank)).toEqual({
        role: "Product Manager",
        senior: "Director of Product or above",
        recruiter: "Product recruiter",
      });
    }
  });
});

// --------------------------------------------------------------- classifyWarmAdd

describe("classifyWarmAdd", () => {
  it("keeps a plain name as a label, never rejecting it as not-a-URL", () => {
    const r = classifyWarmAdd("Ada Okonkwo");
    // MUTATION: routing a name through the URL guard would refuse it -> ok:false.
    expect(r).toEqual({ ok: true, fullName: "Ada Okonkwo", profileUrl: "" });
  });

  it("keeps a linkedin.com profile URL and derives the name from its slug", () => {
    const url = "https://www.linkedin.com/in/ada-okonkwo";
    const r = classifyWarmAdd(url);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profileUrl).toBe(url);
      expect(r.fullName).toBe("Ada Okonkwo");
    }
  });

  it("https-prefixes a bare linkedin.com/in/... with no scheme", () => {
    const r = classifyWarmAdd("linkedin.com/in/ada-okonkwo");
    expect(r.ok).toBe(true);
    // MUTATION: forget to prepend https:// -> the raw scheme-less string survives.
    if (r.ok) expect(r.profileUrl).toBe("https://linkedin.com/in/ada-okonkwo");
  });

  it("refuses a non-LinkedIn URL, because it would end up in an href", () => {
    const r = classifyWarmAdd("https://evil.example/x");
    // MUTATION: `!isLinkedinProfileUrl` dropped -> a hostile origin is kept as a link.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/LinkedIn/);
  });

  it("NEVER produces a javascript: profileUrl — an href XSS is the one refusal that matters", () => {
    const js = "javascript:alert(document.cookie)";
    const r = classifyWarmAdd(js);
    // Either refused, or kept as a bare name — but the script string must never
    // reach `profileUrl`, which the cell renders as an <a href>.
    const profileUrl = r.ok ? r.profileUrl : "";
    expect(profileUrl).not.toContain("javascript:");
    expect(profileUrl).toBe("");
  });

  it("errors on an empty box", () => {
    expect(classifyWarmAdd("").ok).toBe(false);
    expect(classifyWarmAdd("   ").ok).toBe(false);
  });
});

// ----------------------------------------------------------- nameFromLinkedinUrl

describe("nameFromLinkedinUrl", () => {
  it("titlecases the /in/ slug", () => {
    expect(nameFromLinkedinUrl("https://www.linkedin.com/in/ada-okonkwo/")).toBe("Ada Okonkwo");
  });

  it("strips LinkedIn's hex disambiguation suffix", () => {
    // MUTATION: drop the `-[0-9a-f]{4,}$` strip -> "Ada Okonkwo 9f8e2a".
    expect(nameFromLinkedinUrl("https://www.linkedin.com/in/ada-okonkwo-9f8e2a")).toBe("Ada Okonkwo");
  });

  it("returns '' when the URL carries no /in/ slug", () => {
    expect(nameFromLinkedinUrl("https://www.linkedin.com/company/ramp")).toBe("");
  });
});

// ---------------------------------------------------------- normalizeWarmParams

describe("normalizeWarmParams", () => {
  it("fills a blank persona from the derived default", () => {
    const p = normalizeWarmParams(
      { role: "Product Manager", senior: "  ", recruiter: "" },
      "Product Manager",
    );
    // MUTATION: `s || d[k]` -> `s` lets a blank persona reach the vendor as an empty query.
    expect(p.senior).toBe("Director of Product or above");
    expect(p.recruiter).toBe("Product recruiter");
    expect(p.role).toBe("Product Manager");
  });

  it("collapses whitespace, trims, and caps each field at 200 chars", () => {
    expect(normalizeWarmParams({ role: "  Product   Manager " }, "").role).toBe("Product Manager");
    // MUTATION: drop the `.slice(0, 200)` -> length 300.
    expect(normalizeWarmParams({ role: "x".repeat(300) }, "").role).toHaveLength(200);
  });
});

// ------------------------------------------------------------- searchedForLine

describe("searchedForLine", () => {
  it("joins the three personas with ' · '", () => {
    // MUTATION: change the separator -> not "a · b · c".
    expect(searchedForLine({ role: "a", senior: "b", recruiter: "c" })).toBe("a · b · c");
  });

  it("drops a blank persona rather than leaving a dangling separator", () => {
    expect(searchedForLine({ role: "a", senior: "", recruiter: "c" })).toBe("a · c");
  });
});

// A cheap guard so the persona list the vendor iterates cannot silently reorder
// out from under the tests above.
describe("WARM_PERSONAS", () => {
  it("is exactly role, senior, recruiter in that order", () => {
    expect(WARM_PERSONAS).toEqual(["role", "senior", "recruiter"]);
  });
});
