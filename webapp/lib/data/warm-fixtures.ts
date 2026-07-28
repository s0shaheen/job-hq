/**
 * Deterministic warm-intro candidates for demo mode and the E2E suite.
 *
 * These stand in for the vendor's output and MUST match `RawCandidate` exactly —
 * the fake-matches-vendor-semantics rule the build log paid for three times: a
 * fixture that carried a field the real record does not, or omitted one it does,
 * makes the demo green on a shape production never produces.
 *
 * Built to make the branches REACHABLE (matrix row 15): the set carries a UIUC
 * alum and an ex-Capital One (so the school and past-company signals render), a
 * recruiter (so the "always shown" guarantee is exercised), and one person
 * returned by TWO personas under one profile URL (so the dedup path runs). Any
 * company the demo does not name gets a stable generic set, so no row is a dead
 * "Find intro" button.
 */
import type { RawCandidate } from "@/lib/warm/types";

/** A person at `company`, present in the role persona and (if senior) the senior one. */
function person(
  persona: RawCandidate["persona"],
  fullName: string,
  headline: string,
  company: string,
  years: string,
  slug: string,
  extra: Partial<RawCandidate> = {},
): RawCandidate {
  return {
    persona,
    fullName,
    headline,
    company,
    location: "United States",
    years,
    linkedinUrl: slug ? `https://www.linkedin.com/in/${slug}` : "",
    ...extra,
  };
}

/**
 * The canonical demo set for a company, across the three personas.
 *
 * `company` is substituted so a Ramp search reads as Ramp people. The identities
 * (profile slugs) are stable, and one person — Priya Natarajan — appears in BOTH
 * the role and senior personas under one slug, which is the dedup case.
 */
export function fakeCandidatesFor(company: string, companyKey: string): RawCandidate[] {
  const co = company || "the company";
  const k = (companyKey || co).replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  return [
    // role persona — someone in your role
    person("role", "Ada Okonkwo", `Product Manager, Payments · ${co}`, co, "6 yrs", `ada-${k}`, {
      matchedSchool: "UIUC",
    }),
    person("role", "Marcus Bell", `Senior Product Manager · ${co}`, co, "8 yrs", `marcus-${k}`, {
      matchedPastCompany: "Capital One",
    }),
    person("role", "Priya Natarajan", `Group Product Manager · ${co}`, co, "11 yrs", `priya-${k}`),
    person("role", "Tomás Rivera", `Product Manager, Growth · ${co}`, co, "4 yrs", `tomas-${k}`),

    // senior persona — Priya again (dedup), plus a VP
    person("senior", "Priya Natarajan", `Group Product Manager · ${co}`, co, "11 yrs", `priya-${k}`),
    person("senior", "Dana Whitfield", `VP Product · ${co}`, co, "15 yrs", `dana-${k}`, {
      matchedSchool: "UIUC",
    }),

    // recruiter persona — always shown
    person("recruiter", "Chen Lo", `Technical Recruiter, Product · ${co}`, co, "5 yrs", `chen-${k}`),
  ];
}
