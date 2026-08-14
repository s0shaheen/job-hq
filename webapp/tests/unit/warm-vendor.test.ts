// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { WARM_PER_PERSONA_ITEMS } from "@/lib/warm/config";
import { deriveWarmParams, WARM_PERSONAS } from "@/lib/warm/types";
import type { RawCandidate } from "@/lib/warm/types";
import {
  buildProfileSearchInput,
  buildWarmQueries,
  FakeWarmVendor,
  mapDatasetItem,
} from "@/lib/warm/vendor";
import type { WarmPoll, WarmQuery, WarmRunHandle } from "@/lib/warm/vendor";

/**
 * The VENDOR boundary — the pure exports (`buildProfileSearchInput`,
 * `mapDatasetItem`, `buildWarmQueries`) plus the deterministic `FakeWarmVendor`.
 *
 * NODE ENVIRONMENT: `vendor.ts` is `server-only` (the marker that fails a client
 * bundle importing it). Under vitest that marker is a module that throws on
 * import, stubbed here the way `capture-route.test.ts` stubs it. We never call
 * `getWarmVendor()` — it reaches `next/headers` cookies — only the pure exports
 * and the fake, which is the whole contract this file pins.
 *
 * The load-bearing part is the persona -> harvestapi-facet mapping AND the persona
 * PARITY between the fake and the real path: both proven here without spending a
 * cent, because every real run bills at >= $0.10. Each assertion names the mutant.
 */

vi.mock("server-only", () => ({}));

// A minimal WarmQuery with only the fields a test cares about.
function query(over: Partial<WarmQuery> & Pick<WarmQuery, "persona" | "text">): WarmQuery {
  return { company: "Ramp", ...over };
}

// ------------------------------------------------------ buildProfileSearchInput

describe("buildProfileSearchInput", () => {
  it("maps the role persona to a single current-title, Short mode, one page of 25", () => {
    const input = buildProfileSearchInput(query({ persona: "role", text: "Product Manager" }));
    // MUTATION: profileScraperMode flipped off "Short" -> a pricier/heavier scrape.
    expect(input.profileScraperMode).toBe("Short");
    // MUTATION: maxItems hardcoded to the merged cap (40) -> a 2nd page, $0.10 more per persona.
    expect(input.maxItems).toBe(WARM_PER_PERSONA_ITEMS);
    expect(WARM_PER_PERSONA_ITEMS).toBe(25);
    // MUTATION: drop `takePages: 1` -> harvestapi walks past one page and bills per page.
    expect(input.takePages).toBe(1);
    // MUTATION: currentJobTitles built from the wrong field.
    expect(input.currentJobTitles).toEqual(["Product Manager"]);
    // A plain role query carries no seniority facet.
    expect(input.seniorityLevelIds).toBeUndefined();
  });

  it("adds the Director/VP/CXO seniority ids for the senior persona", () => {
    const input = buildProfileSearchInput(
      query({ persona: "senior", text: "Director of Product or above" }),
    );
    // MUTATION: drop the senior branch -> no seniorityLevelIds, and "senior in your
    // area" degrades into another role search.
    expect(input.seniorityLevelIds).toEqual(["220", "300", "310"]);
    expect(input.currentJobTitles).toEqual(["Director of Product or above"]);
  });

  it("widens the recruiter persona to the recruiting title set", () => {
    const input = buildProfileSearchInput(query({ persona: "recruiter", text: "Product recruiter" }));
    const titles = input.currentJobTitles as string[];
    // MUTATION: drop the recruiter branch -> only the raw persona string, so the
    // search misses everyone whose title says "Recruiter"/"Talent Acquisition".
    expect(titles).toContain("Product recruiter");
    expect(titles).toContain("Recruiter");
    expect(titles).toContain("Talent Acquisition");
    // A recruiter search is not seniority-gated.
    expect(input.seniorityLevelIds).toBeUndefined();
  });

  it("carries the company into searchQuery, quoted, as the slug-less fallback", () => {
    const input = buildProfileSearchInput(query({ persona: "role", text: "PM", company: "Ramp" }));
    // MUTATION: drop the quotes -> an unquoted multi-word company ORs its words.
    expect(input.searchQuery).toBe('"Ramp"');
  });

  it("passes the company URL and the warm overlays through when supplied", () => {
    const input = buildProfileSearchInput(
      query({
        persona: "role",
        text: "PM",
        companyUrl: "https://www.linkedin.com/company/1035",
        schools: ["Norvale"],
        pastCompanies: ["Northwind"],
        location: "United States",
      }),
    );
    expect(input.currentCompanies).toEqual(["https://www.linkedin.com/company/1035"]);
    // MUTATION: overlays dropped -> the school/ex-employer signals never reach the vendor.
    expect(input.schools).toEqual(["Norvale"]);
    expect(input.pastCompanies).toEqual(["Northwind"]);
    expect(input.locations).toEqual(["United States"]);
  });
});

// --------------------------------------------------------------- mapDatasetItem

describe("mapDatasetItem", () => {
  it("maps a harvestapi record into a RawCandidate and stamps overlays from the QUERY", () => {
    const q = query({
      persona: "role",
      text: "PM",
      company: "Ramp",
      schools: ["Norvale"],
      pastCompanies: ["Northwind"],
    });
    const mapped = mapDatasetItem(
      {
        firstName: "Ada",
        lastName: "Okonkwo",
        currentPosition: [{ position: "Product Manager", companyName: "Ramp" }],
        // The live actor emits `location.linkedinText`, deepest string form first.
        location: { linkedinText: "San Francisco, CA" },
        linkedinUrl: "https://www.linkedin.com/in/ada-okonkwo",
      },
      q,
    );
    expect(mapped.fullName).toBe("Ada Okonkwo");
    // MUTATION: read headline/company from the wrong nested field.
    expect(mapped.headline).toBe("Product Manager");
    expect(mapped.company).toBe("Ramp");
    // MUTATION: stop reading `location.linkedinText` (the m2 fix) -> location "".
    expect(mapped.location).toBe("San Francisco, CA");
    expect(mapped.linkedinUrl).toBe("https://www.linkedin.com/in/ada-okonkwo");
    // The persona rides along so the ranker can score it.
    expect(mapped.persona).toBe("role");
    // Short mode carries no education, so the matched signals come from the query's
    // own overlay facets — the row matched them by construction.
    // MUTATION: stamp matchedSchool from the (absent) record field -> undefined.
    expect(mapped.matchedSchool).toBe("Norvale");
    expect(mapped.matchedPastCompany).toBe("Northwind");
  });

  it("reads location deepest-first: linkedinText, then parsed.text, then text", () => {
    const q = query({ persona: "role", text: "PM" });
    // linkedinText wins over the object-form parsed.text and the flat text (m2).
    expect(
      mapDatasetItem(
        { location: { linkedinText: "Austin, TX", parsed: { text: "TX Metro" }, text: "somewhere" } },
        q,
      ).location,
    ).toBe("Austin, TX");
    // No linkedinText -> parsed.text (parsed is an OBJECT now, not a string).
    expect(mapDatasetItem({ location: { parsed: { text: "New York, NY" } } }, q).location).toBe(
      "New York, NY",
    );
    // Only the flat text survives.
    expect(mapDatasetItem({ location: { text: "Remote" } }, q).location).toBe("Remote");
    // A plain string location is taken verbatim.
    expect(mapDatasetItem({ location: "Chicago, IL" }, q).location).toBe("Chicago, IL");
  });

  it("reads a flat `name` when firstName/lastName are absent", () => {
    const mapped = mapDatasetItem({ name: "Marcus Bell" }, query({ persona: "role", text: "PM" }));
    expect(mapped.fullName).toBe("Marcus Bell");
  });

  it("defends every field: a missing record becomes '' rather than the word undefined", () => {
    // The empty query carries no company/overlay, so the fallbacks are visible.
    const mapped = mapDatasetItem({}, { persona: "senior", text: "", company: "" });
    // MUTATION: any `str()` guard removed -> "undefined" next to somebody's name.
    expect(mapped.fullName).toBe("");
    expect(mapped.headline).toBe("");
    expect(mapped.company).toBe("");
    expect(mapped.location).toBe("");
    expect(mapped.years).toBe("");
    expect(mapped.linkedinUrl).toBe("");
    expect(mapped.matchedSchool).toBeUndefined();
    expect(mapped.matchedPastCompany).toBeUndefined();
    // The persona is still carried even for an empty record.
    expect(mapped.persona).toBe("senior");
  });
});

// --------------------------------------------------------------- buildWarmQueries

describe("buildWarmQueries", () => {
  it("builds exactly three queries — role/senior/recruiter — each carrying the company", () => {
    const params = deriveWarmParams("Product Manager");
    const queries = buildWarmQueries(params, { company: "Ramp" });

    // MUTATION: add/drop a persona -> the per-search cost (3 x ~$0.10) changes.
    expect(queries).toHaveLength(3);
    expect(queries.map((q) => q.persona)).toEqual([...WARM_PERSONAS]);
    // MUTATION: reorder or mis-wire the text -> a persona runs someone else's string.
    expect(queries.map((q) => q.text)).toEqual([
      params.role,
      params.senior,
      params.recruiter,
    ]);
    // MUTATION: drop the company from a query -> a search for "everybody on LinkedIn".
    for (const q of queries) expect(q.company).toBe("Ramp");
  });

  it("threads the warm overlays into every persona query via queryForPersona", () => {
    const params = deriveWarmParams("Product Manager");
    const queries = buildWarmQueries(params, {
      company: "Ramp",
      schools: ["Norvale"],
      pastCompanies: ["Northwind"],
    });
    // MUTATION: buildWarmQueries stops routing through queryForPersona -> overlays
    // reach only some (or none) of the three runs.
    for (const q of queries) {
      expect(q.schools).toEqual(["Norvale"]);
      expect(q.pastCompanies).toEqual(["Northwind"]);
    }
  });
});

// ---------------------------------------------------------------- FakeWarmVendor

describe("FakeWarmVendor", () => {
  const queries = buildWarmQueries(deriveWarmParams("Product Manager"), { company: "Ramp" });

  it("carries persona + company on each run so poll is stateless across instances", async () => {
    const handle: WarmRunHandle = await new FakeWarmVendor("results").start(queries);
    // MUTATION: `runs` reverted to a bare `runIds` string[] -> no query, persona lost.
    expect(handle.runs).toHaveLength(3);
    for (const run of handle.runs) {
      // The run id still encodes the company so a fresh instance can recover it.
      expect(run.runId).toContain("Ramp");
      // The query rides on the handle — the persona/overlay source the poll route persists.
      expect(run.query.company).toBe("Ramp");
    }
    expect(handle.runs.map((r) => r.query.persona)).toEqual([...WARM_PERSONAS]);

    // A DIFFERENT instance polls the same handle and still returns Ramp people —
    // start and poll run in different requests / vendor objects in production.
    const poll: WarmPoll = await new FakeWarmVendor("results").poll(handle);
    expect(poll.status).toBe("succeeded");
    expect(poll.candidates.length).toBeGreaterThan(0);
    for (const c of poll.candidates) expect(c.company).toBe("Ramp");
  });

  it("PERSONA PARITY: each candidate is attributed to the persona of the run it came from", async () => {
    // Build the handle the real way, then poll a FRESH instance — exactly the
    // start-request / poll-request split production has, where the persona can only
    // ride on the handle (it cannot live in vendor instance memory).
    const handle = await new FakeWarmVendor("results").start(queries);
    const poll = await new FakeWarmVendor("results").poll(handle);

    const asked = new Set(handle.runs.map((r) => r.query.persona));
    // Every returned candidate's persona is one a run actually asked for — the fake
    // attributes persona from `run.query.persona`, the SAME source the real
    // `mapDatasetItem(item, run.query)` uses.
    // MUTATION: poll ignores run.query.persona and hardcodes "role" -> a "senior"/
    // "recruiter" candidate appears that no run asked for (or, below, they vanish).
    for (const c of poll.candidates) expect(asked.has(c.persona)).toBe(true);

    // Each run contributes ONLY its own persona's people — so all three personas are
    // represented, not flattened to "role" (the M1 bug that killed the recruiter
    // guarantee: every candidate stamped "role", isRecruiter never set).
    for (const run of handle.runs) {
      const fromRun = poll.candidates.filter((c) => c.persona === run.query.persona);
      expect(fromRun.length).toBeGreaterThan(0);
    }
    expect(poll.candidates.some((c) => c.persona === "senior")).toBe(true);
    expect(poll.candidates.some((c) => c.persona === "recruiter")).toBe(true);
  });

  it("results mode: candidates are shaped EXACTLY like RawCandidate", async () => {
    const handle = await new FakeWarmVendor("results").start(queries);
    const poll = await new FakeWarmVendor("results").poll(handle);

    const required: (keyof RawCandidate)[] = [
      "persona",
      "fullName",
      "headline",
      "company",
      "location",
      "years",
      "linkedinUrl",
    ];
    const allowed = new Set<string>([...required, "matchedSchool", "matchedPastCompany"]);
    // MUTATION: a fixture that adds a field the real record lacks (or drops a
    // required one) makes the demo green on a shape production never produces.
    for (const c of poll.candidates) {
      for (const key of required) expect(c).toHaveProperty(key);
      for (const key of Object.keys(c)) expect(allowed.has(key)).toBe(true);
    }
  });

  it("pending mode: 'running' with no candidates — the state the Cancel button needs", async () => {
    const handle = await new FakeWarmVendor("pending").start(queries);
    expect(await new FakeWarmVendor("pending").poll(handle)).toEqual({
      status: "running",
      candidates: [],
    });
  });

  it("empty mode: 'succeeded' with zero candidates — the no-matches state", async () => {
    const handle = await new FakeWarmVendor("empty").start(queries);
    expect(await new FakeWarmVendor("empty").poll(handle)).toEqual({
      status: "succeeded",
      candidates: [],
    });
  });

  it("fail mode: 'failed' with an error and no candidates", async () => {
    const handle = await new FakeWarmVendor("fail").start(queries);
    const poll = await new FakeWarmVendor("fail").poll(handle);
    expect(poll.status).toBe("failed");
    expect(poll.candidates).toEqual([]);
    expect(poll.error).toBeTruthy();
  });

  it("cancel resolves without throwing", async () => {
    await expect(new FakeWarmVendor("pending").cancel()).resolves.toBeUndefined();
  });
});
