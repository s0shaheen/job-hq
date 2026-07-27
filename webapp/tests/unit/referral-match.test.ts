import { describe, expect, it } from "vitest";
import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import { FIXTURE_CONNECTIONS } from "@/lib/data/connection-fixtures";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { companyNameKey } from "@/lib/data/view-models";
import type { CompanyView, ConnectionView } from "@/lib/data/view-models";
import {
  buildWarmContext,
  connectionsAt,
  indexConnections,
  indexUniverse,
  MAX_LISTED_CONNECTIONS,
  universeFor,
  warmSummary,
} from "@/lib/referral/match";

/**
 * The join between "people I know" and "companies I am looking at".
 *
 * One rule decides every answer in this file: the key is `company_name_key`,
 * never the raw string and never `lower()`. That is not a stylistic preference —
 * 0008 paid for the alternative three times, and a connections export is the
 * same kind of data from the same kind of place. `Fifth Third<NBSP>Bank` is what
 * a browser leaves in a cell when somebody pastes out of a web page, and under
 * `lower()` that row matches NOTHING while looking completely correct on screen.
 *
 * So the mutation these tests are written against is one line: replace
 * `companyNameKey(...)` with `.toLowerCase()` anywhere in `match.ts`. Several
 * assertions below go red on it; the ones that do say so.
 */

// ------------------------------------------------------------------- helpers

let seq = 0;
function conn(over: Partial<ConnectionView> & Pick<ConnectionView, "fullName">): ConnectionView {
  const company = over.company ?? "";
  return {
    id: ++seq,
    company,
    // Computed the way the fixture set computes it, which is the way SQL
    // GENERATES it. Hand-typing a key here would let a test pass on a value the
    // database could never produce.
    companyKey: companyNameKey(company),
    title: "",
    profileUrl: "",
    connectedOn: null,
    ...over,
  };
}

function co(over: Partial<CompanyView> & Pick<CompanyView, "id" | "name">): CompanyView {
  return {
    key: String(over.id),
    ats: "greenhouse",
    slug: `slug-${over.id}`,
    source: "seed",
    tier: 1,
    resolutionMethod: "discover-greenhouse",
    reviewState: "approved",
    enabled: true,
    priority: false,
    seeded: false,
    linkedinCompanyId: "",
    linkedinIdSource: "",
    updatedAt: "2026-07-21T12:00:00.000Z",
    companyUpdatedAt: "2026-07-21T12:03:00.000Z",
    ...over,
  };
}

// ------------------------------------------------------------ indexConnections

describe("indexConnections keys on company_name_key, not on the raw string", () => {
  it("matches across a non-breaking space", () => {
    // THE case this module exists for. The connection's employer is spelled with
    // U+00A0 (what pasting out of a web page leaves); the posting spells it with
    // a plain space. They are the same employer and only `company_name_key` says
    // so. Mutation reason: swap `companyNameKey` for `toLowerCase()` in
    // `indexConnections`/`connectionsAt` and this returns zero.
    //
    // Written as the `\u00a0` ESCAPE and not as the literal character: a literal
    // NBSP is invisible in an editor, and the next person tidies it into a plain
    // space without knowing they have deleted the only case that can tell
    // `company_name_key` from `lower()`. (`connection-fixtures.ts` has to carry
    // the literal, which is why `connection-fixtures.test.ts` guards it by
    // codepoint instead.)
    const index = indexConnections([
      conn({ fullName: "Chandra Rao", company: "Fifth\u00a0Third Bank" }),
    ]);
    expect(connectionsAt(index, "Fifth Third Bank").map((c) => c.fullName)).toEqual(["Chandra Rao"]);
    // And the other direction, because the NBSP can be on either side.
    const flipped = indexConnections([conn({ fullName: "Dev Patel", company: "Fifth Third Bank" })]);
    expect(connectionsAt(flipped, "Fifth\u00a0Third Bank").map((c) => c.fullName)).toEqual([
      "Dev Patel",
    ]);
  });

  it("matches across case", () => {
    // 'Aon' and 'aon' pasted in two sessions became two companies once already.
    const index = indexConnections([conn({ fullName: "A", company: "Aon" })]);
    expect(connectionsAt(index, "aon")).toHaveLength(1);
    expect(connectionsAt(index, "AON")).toHaveLength(1);
  });

  it("matches across an interior whitespace run and surrounding padding", () => {
    // A run of spaces collapses to one; a tab or an ideographic space is a space.
    // Mutation reason: `.trim().toLowerCase()` keeps the run and the tab, so all
    // three of these miss.
    const index = indexConnections([conn({ fullName: "A", company: "Northern   Trust" })]);
    expect(connectionsAt(index, "Northern Trust")).toHaveLength(1);
    expect(connectionsAt(index, "  Northern Trust  ")).toHaveLength(1);
    expect(connectionsAt(index, "Northern\tTrust")).toHaveLength(1);
    // Positive control: a genuinely different company still misses. Without this
    // the three above would pass for an index that returned everything.
    expect(connectionsAt(index, "Northern Trust Bank")).toEqual([]);
  });

  it("prefers the SQL's generated key over recomputing it", () => {
    // `connections.company_key` is a GENERATED column, so when it is present it
    // IS what Postgres computed. Recomputation is the fallback for the fake, not
    // the primary path — a row whose stored key disagrees with its display name
    // must file under the STORED one, or the demo and production disagree about
    // which company a person works at.
    const index = indexConnections([
      { id: 1, fullName: "Odd One", company: "Displayed Differently", companyKey: "ramp", title: "", profileUrl: "", connectedOn: null },
    ]);
    expect(connectionsAt(index, "Ramp").map((c) => c.fullName)).toEqual(["Odd One"]);
    expect(connectionsAt(index, "Displayed Differently")).toEqual([]);
  });

  it("indexes a connection with no employer under nothing, and matches it to no row", () => {
    // LinkedIn's export leaves Company blank for plenty of people. They are still
    // connections; they are just not evidence about any company.
    const nameless = conn({ fullName: "Employerless Person", company: "" });
    const input = [nameless, conn({ fullName: "Ada", company: "Ramp" })];
    const index = indexConnections(input);

    // The positive control that makes the negative meaningful: the row IS in the
    // input, so what follows is about the index and not about a dropped fixture.
    expect(input.map((c) => c.fullName)).toContain("Employerless Person");
    expect([...index.keys()]).toEqual(["ramp"]);
    expect([...index.values()].flat().map((c) => c.fullName)).not.toContain("Employerless Person");
    // A blank company on the ROW side matches nothing either — an application
    // with no company must not collect every employerless connection.
    expect(connectionsAt(index, "")).toEqual([]);
    expect(connectionsAt(index, "   ")).toEqual([]);
  });

  it("sorts the names within a bucket deterministically", () => {
    // A popover that reorders between renders is one nobody can point at, and a
    // test that pins the first name has to stay pinned. Mutant: delete the
    // `bucket.sort(...)` — the order becomes input order and this goes red.
    const index = indexConnections([
      conn({ fullName: "Zoë Hart", company: "Ramp" }),
      conn({ fullName: "Ada Okonkwo", company: "Ramp" }),
      conn({ fullName: "Bo Lindqvist", company: "Ramp" }),
    ]);
    expect(connectionsAt(index, "Ramp").map((c) => c.fullName)).toEqual([
      "Ada Okonkwo",
      "Bo Lindqvist",
      "Zoë Hart",
    ]);
  });

  it("breaks a name tie on id, so two people with one name keep a fixed order", () => {
    const index = indexConnections([
      conn({ id: 90, fullName: "Chris Lee", company: "Ramp" }),
      conn({ id: 12, fullName: "Chris Lee", company: "Ramp" }),
    ]);
    expect(connectionsAt(index, "Ramp").map((c) => c.id)).toEqual([12, 90]);
  });

  it("uses a Map, so a company called __proto__ is a company and not a footgun", () => {
    const index = indexConnections([conn({ fullName: "A", company: "__proto__" })]);
    expect(index).toBeInstanceOf(Map);
    expect(connectionsAt(index, "__proto__")).toHaveLength(1);
    expect(connectionsAt(index, "constructor")).toEqual([]);
  });
});

// --------------------------------------------------------------- indexUniverse

describe("indexUniverse", () => {
  it("keeps a row with no LinkedIn id — the entry is the paste TARGET", () => {
    // "In the universe with no id" and "not in the universe" are different
    // states with different cells: one offers a paste box, the other says to add
    // the company first. An index that dropped id-less rows would collapse them.
    const index = indexUniverse([co({ id: 5, name: "Fifth Third Bank", linkedinCompanyId: "" })]);
    const row = universeFor(index, "Fifth Third Bank");
    expect(row).toMatchObject({ id: 5, linkedinCompanyId: "" });
    expect(warmSummary("Fifth Third Bank", new Map(), index)).toMatchObject({
      hasCompanyId: false,
      inUniverse: true,
    });
  });

  it("carries the id, the row id and the SHARED row's token together", () => {
    // Three separate lookups over the same key is three chances to look one of
    // them up for a different company than the other two. `companyUpdatedAt` is
    // the shared company row's token, NOT the subscription's `updatedAt` — a
    // paste sending the wrong one conflicts on a row nobody touched.
    const index = indexUniverse([
      co({
        id: 101,
        name: "Ramp",
        linkedinCompanyId: "12345678",
        linkedinIdSource: "human",
        updatedAt: "2026-07-21T12:00:00.000Z",
        companyUpdatedAt: "2026-07-21T12:03:21.000Z",
      }),
    ]);
    expect(universeFor(index, "Ramp")).toEqual({
      id: 101,
      linkedinCompanyId: "12345678",
      // Rides with the id, and asserted in the same `toEqual` for the reason the
      // comment above gives about the other three: the cell needs them at one
      // instant, so a field that silently stopped travelling is the bug.
      linkedinIdSource: "human",
      companyUpdatedAt: "2026-07-21T12:03:21.000Z",
      name: "Ramp",
    });
    // Mutant: carry `c.updatedAt` in the entry instead. This is the assertion
    // that notices, and the two fixture values are deliberately different so it
    // can (see the `company()` helper in company-fixtures.ts).
    expect(universeFor(index, "Ramp")!.companyUpdatedAt).not.toBe("2026-07-21T12:00:00.000Z");
  });

  it("lets the ID-BEARING row win when one company has several universe rows", () => {
    // A Greenhouse careers site and a Workday tenant are two rows and both are
    // true. The row that can answer the question is the one with an id, and it is
    // deliberately SECOND here: a naive first-writer-wins implementation returns
    // the id-less row and the cell shows a paste prompt for a company that
    // already has one.
    const index = indexUniverse([
      co({ id: 10, name: "Ramp", ats: "greenhouse", linkedinCompanyId: "" }),
      co({ id: 11, name: "Ramp", ats: "workday", linkedinCompanyId: "12345678" }),
    ]);
    expect(universeFor(index, "Ramp")).toMatchObject({ id: 11, linkedinCompanyId: "12345678" });
  });

  it("collapses TWO DIFFERENT companies that share a normalized name — the hostile reading", () => {
    // The other reason two rows share a key, and the one the comment above
    // `indexUniverse` used to leave out. `companies_unresolved_name_key` (0008)
    // is PARTIAL on `ats = '' and slug = ''`, so two genuinely different firms
    // that normalize the same are both legal once each is grounded — `Apex` and
    // `APEX` are two real companies, verified in Postgres to share a key.
    //
    // This test asserts the WRONG answer on purpose, because it is the answer the
    // code gives and pretending otherwise is how somebody re-derives it as a bug
    // in six months. What it pins is that the wrong answer is DETERMINISTIC: the
    // id-bearing row wins every render, so a person who notices the mismatch once
    // can clear the id and it stays cleared. A plan-dependent collapse would flip
    // between reloads and be unfixable from inside the app.
    //
    // Not fixed here: the real fix is a per-posting company id, which is a schema
    // change to `postings` and an engine change to fill it.
    const index = indexUniverse([
      co({ id: 40, name: "Apex", ats: "greenhouse", slug: "apex-legal", linkedinCompanyId: "" }),
      co({ id: 41, name: "APEX", ats: "lever", slug: "apex-robotics", linkedinCompanyId: "999" }),
    ]);
    // One entry, not two — a posting from EITHER firm resolves to the same row.
    expect(index.size).toBe(1);
    const hit = universeFor(index, "Apex");
    expect(hit).toMatchObject({ id: 41, linkedinCompanyId: "999" });
    // Stated plainly: the Apex-legal posting is handed Apex-robotics' id. That is
    // "a wrong company id sends somebody's outreach to strangers at another
    // company", in `linkedin.ts`'s own words, and it is the accepted cost of
    // keying on a normalized name.
    expect(universeFor(index, "Apex Legal")).toBeNull(); // …unless the name differs at all

    // Deterministic across input order — the half that IS guaranteed.
    const reversed = indexUniverse([
      co({ id: 41, name: "APEX", ats: "lever", slug: "apex-robotics", linkedinCompanyId: "999" }),
      co({ id: 40, name: "Apex", ats: "greenhouse", slug: "apex-legal", linkedinCompanyId: "" }),
    ]);
    expect(universeFor(reversed, "Apex")).toMatchObject({ id: 41, linkedinCompanyId: "999" });
  });

  it("does not match a company whose name carries U+0130 — the SQL/TS key divergence", () => {
    // The stated limit at `match.ts`'s `indexConnections`, made executable.
    //
    // `company_name_key` has three implementations pinned to one corpus, and the
    // corpus carries a MEASURED divergence: Postgres folds U+0130 (İ) to a bare
    // `i`, JS and Python fold it to `i` + U+0307. Everywhere it appeared before,
    // both sides of the comparison came from the same language. Here they do not:
    // the connection's key is the generated column's, the posting's is computed
    // by `companyNameKey`.
    //
    // The consequence is a silent NON-match, which is the right way round — a
    // missing warm path rather than outreach sent to strangers — and it is
    // bounded to names carrying that one codepoint.
    //
    // MUTATION REASON: if either implementation is ever changed to agree, this
    // goes red and the comment at `match.ts` has to be deleted with it.
    const sqlKey = "is bank"; // what Postgres stores in `connections.company_key`
    const tsKey = companyNameKey("\u0130s Bank"); // what this module computes
    expect(tsKey).toBe("i\u0307s bank");
    expect(tsKey).not.toBe(sqlKey);

    const index = indexConnections([
      conn({ id: 1, fullName: "Elif Yilmaz", company: "\u0130s Bank", companyKey: sqlKey }),
    ]);
    // Stored and indexed…
    expect(index.get(sqlKey)).toHaveLength(1);
    // …and never found by the posting it belongs to.
    expect(connectionsAt(index, "\u0130s Bank")).toEqual([]);
    // The positive control: an ASCII company on the same index still matches, so
    // the empty answer above is about the codepoint and not about the helper.
    const ok = indexConnections([
      conn({ id: 2, fullName: "Ada Okonkwo", company: "Ramp", companyKey: "ramp" }),
    ]);
    expect(connectionsAt(ok, "Ramp")).toHaveLength(1);
  });

  it("among equals, the FIRST row wins — deterministically", () => {
    // `companies()` orders by name then id, so "first" is a fact rather than a
    // plan artifact. Both directions are asserted: two id-less rows and two
    // id-bearing rows both resolve to the first.
    const idless = indexUniverse([
      co({ id: 10, name: "Aon", linkedinCompanyId: "" }),
      co({ id: 11, name: "aon", linkedinCompanyId: "" }),
    ]);
    expect(universeFor(idless, "Aon")!.id).toBe(10);

    const both = indexUniverse([
      co({ id: 10, name: "Aon", linkedinCompanyId: "111" }),
      co({ id: 11, name: "Aon", linkedinCompanyId: "222" }),
    ]);
    expect(universeFor(both, "Aon")!.linkedinCompanyId).toBe("111");
  });

  it("ignores a row with no name at all", () => {
    // Common Crawl mines boards, not names, so a slug-only row is the real shape
    // of a discovered company. It names no company, so it can match none — and
    // indexing it under "" would give every company-less row a universe entry.
    const nameless = FIXTURE_COMPANIES.filter((c) => c.name === "");
    expect(nameless.length, "the fixture set no longer carries a slug-only row").toBeGreaterThan(0);

    const index = indexUniverse(FIXTURE_COMPANIES);
    expect([...index.keys()]).not.toContain("");
    for (const row of nameless) {
      expect([...index.values()].map((v) => v.id)).not.toContain(row.id);
    }
    expect(universeFor(index, "")).toBeNull();
    expect(universeFor(index, "   ")).toBeNull();
  });
});

// ----------------------------------------------------------------- universeFor

describe("universeFor", () => {
  const index = indexUniverse(FIXTURE_COMPANIES);

  it("answers null for a posting company nobody watches", () => {
    // Plaid is a real FIXTURE_JOBS company with no universe row, and null is a
    // real state rather than an edge — a posting can arrive through the wide net
    // from a company nobody has added. It is what makes the cell say "you are not
    // tracking this yet" instead of offering a paste box with nowhere to write.
    expect(FIXTURE_JOBS.some((j) => j.company === "Plaid")).toBe(true);
    expect(FIXTURE_COMPANIES.some((c) => c.name === "Plaid")).toBe(false);
    expect(universeFor(index, "Plaid")).toBeNull();
    // Positive control on the same index: a company that IS watched resolves.
    expect(universeFor(index, "Ramp")).not.toBeNull();
  });

  it("matches across the same three differences the connections side does", () => {
    // Mutation reason, again: `toLowerCase()` in place of `companyNameKey`. The
    // NBSP case is the one that goes red — the other two survive a naive lower().
    expect(universeFor(index, "  ramp  ")!.id).toBe(101);
    expect(universeFor(index, "Fifth\u00a0Third Bank")!.id).toBe(104);
    expect(universeFor(index, "Fifth  Third  Bank")!.id).toBe(104);
    // And punctuation is NOT folded, because two registered names are two
    // companies: a wrong merge is unrecoverable where a duplicate is untidy.
    expect(universeFor(index, "Ramp, Inc.")).toBeNull();
  });
});

// ------------------------------------------------------------ buildWarmContext

describe("buildWarmContext", () => {
  it("separates 'no export uploaded' from 'nobody at this company'", () => {
    // Two states that look identical in a cell and mean completely different
    // things: one is a fact about the company, the other is a thing to go and do.
    // Collapsing them is how a working feature convinces somebody it is broken
    // (matrix row 15). Mutant: `hasAnyConnections: true` — the first expectation
    // below goes red while everything else stays green.
    const nothingUploaded = buildWarmContext(FIXTURE_COMPANIES, []);
    expect(nothingUploaded.hasAnyConnections).toBe(false);
    expect(connectionsAt(nothingUploaded.connections, "Ramp")).toEqual([]);

    const uploaded = buildWarmContext(FIXTURE_COMPANIES, FIXTURE_CONNECTIONS);
    expect(uploaded.hasAnyConnections).toBe(true);
    // Same context, and Databricks still has nobody at it. Both facts are true at
    // once, which is exactly why they are two fields.
    expect(connectionsAt(uploaded.connections, "Databricks")).toEqual([]);
    expect(connectionsAt(uploaded.connections, "Ramp")).toHaveLength(2);
  });

  it("builds both indexes from the arguments it was given", () => {
    const ctx = buildWarmContext(FIXTURE_COMPANIES, FIXTURE_CONNECTIONS);
    expect(ctx.universe).toBeInstanceOf(Map);
    expect(ctx.connections).toBeInstanceOf(Map);
    expect(universeFor(ctx.universe, "Ramp")!.linkedinCompanyId).toBe("12345678");
  });
});

// ------------------------------------------------------------------ warmSummary

/**
 * The four fixture rows that exist for these four numbers.
 *
 * `company-fixtures.ts` and `connection-fixtures.ts` were built to make each of
 * these combinations reachable, and their comments say so row by row. This is
 * the test that turns those comments into a claim: if somebody "tidies" the
 * fixture set, the state that stops being reachable is named here rather than
 * quietly ceasing to be rendered by any test.
 */
describe("warmSummary over the fixture set", () => {
  const connections = indexConnections(FIXTURE_CONNECTIONS);
  const universe = indexUniverse(FIXTURE_COMPANIES);
  const summary = (company: string) => warmSummary(company, connections, universe);

  it("Ramp: names AND links — two first-degree connections and a pasted id", () => {
    expect(summary("Ramp")).toEqual({ firstDegree: 2, hasCompanyId: true, inUniverse: true });
  });

  it("Databricks: links but nobody you know — an id with no connections behind it", () => {
    // Not the same cell as "no id at all", which is why the fixture carries it.
    expect(summary("Databricks")).toEqual({ firstDegree: 0, hasCompanyId: true, inUniverse: true });
  });

  it("Fifth Third Bank: names but no links — and one of them is the NBSP row", () => {
    // The only combination that proves the two halves of the popover are
    // independent: people to ask, no deep links, paste prompt still on screen.
    // It is also the NBSP case end to end — under `lower()` this reads 1, not 2.
    expect(summary("Fifth Third Bank")).toEqual({
      firstDegree: 2,
      hasCompanyId: false,
      inUniverse: true,
    });
    expect(connectionsAt(connections, "Fifth Third Bank").map((c) => c.fullName)).toEqual([
      "Chandra Rao",
      "Dev Patel",
    ]);
  });

  it("Anthropic: a connection at a company that is not in the universe at all", () => {
    // The fourth combination, reachable from the other direction: names, no id,
    // and nowhere to paste one.
    expect(summary("Anthropic")).toEqual({
      firstDegree: 1,
      hasCompanyId: false,
      inUniverse: false,
    });
  });

  it("a company in neither: all three answers are the empty ones", () => {
    expect(summary("Plaid")).toEqual({ firstDegree: 0, hasCompanyId: false, inUniverse: false });
    expect(summary("")).toEqual({ firstDegree: 0, hasCompanyId: false, inUniverse: false });
  });

  it("counts every fixture connection into exactly one bucket", () => {
    // A guard on the four numbers above: they are only meaningful if the fixture
    // set has not grown a sixth person nobody counted.
    const bucketed = [...connections.values()].flat().length;
    expect(bucketed).toBe(FIXTURE_CONNECTIONS.filter((c) => c.company !== "").length);
    expect(FIXTURE_CONNECTIONS).toHaveLength(5);
  });
});

describe("MAX_LISTED_CONNECTIONS", () => {
  it("is a real cap, and the fixture buckets sit under it", () => {
    // Somebody with 3,000 connections has a few dozen at a big bank, and a
    // popover listing all of them is a scroll trap over the one control the row
    // exists for. The fixture buckets are small on purpose, so the demo shows the
    // NAMES branch rather than the "and 34 more" one — both need to be reachable,
    // and this pins which one the fixtures produce.
    expect(MAX_LISTED_CONNECTIONS).toBeGreaterThan(1);
    const index = indexConnections(FIXTURE_CONNECTIONS);
    for (const bucket of index.values()) {
      expect(bucket.length).toBeLessThanOrEqual(MAX_LISTED_CONNECTIONS);
    }
  });
});
