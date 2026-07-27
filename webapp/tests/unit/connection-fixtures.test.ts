import { describe, expect, it } from "vitest";
import { FIXTURE_COMPANIES } from "@/lib/data/company-fixtures";
import { FIXTURE_CONNECTIONS } from "@/lib/data/connection-fixtures";
import { companyNameKey } from "@/lib/data/view-models";
import { connectionUrl } from "@/lib/referral/linkedin";
import { indexConnections, indexUniverse, universeFor } from "@/lib/referral/match";

/**
 * The connections fixture set, held to its own header.
 *
 * `connection-fixtures.ts` opens with a list of the states each row exists to
 * make reachable — the NBSP company, the missing profile URL, the non-LinkedIn
 * URL, the null date, the very long name. Those sentences are the reason the
 * demo and the E2E suite can see the uncomfortable states at all (matrix row 15),
 * and NOTHING enforced them: a fixture header that lies is the same defect as a
 * comment that lies, and it is the more expensive one, because every test
 * downstream keeps passing while the state it was written for stops existing.
 *
 * This file is small and specific on purpose. Each test names the claim it is
 * holding the file to.
 */

describe("the NBSP row", () => {
  it("still carries a literal U+00A0 in its company name", () => {
    // THE guard. The character is invisible in an editor, the fixture's own
    // comment says the next person will "tidy" it into a plain space, and doing
    // so deletes the only case in the whole repo that can tell `company_name_key`
    // from `lower()`. Asserted by CODEPOINT, because an equality check against a
    // string literal in this file would be tidied away in the same edit.
    const nbsp = FIXTURE_CONNECTIONS[2];
    expect(nbsp.fullName).toBe("Chandra Rao");
    expect([...nbsp.company].map((c) => c.codePointAt(0))).toContain(0x00a0);
    // …and it is a company the universe spells with a PLAIN space, or the row
    // proves nothing: the whole point is that the two spellings are one employer.
    const universeRow = FIXTURE_COMPANIES.find((c) => c.name === "Fifth Third Bank");
    expect(universeRow, "the plain-space universe row is gone").toBeDefined();
    expect([...universeRow!.name].map((c) => c.codePointAt(0))).not.toContain(0x00a0);
    // And they really do match, through the key and not through the string.
    expect(nbsp.company).not.toBe(universeRow!.name);
    expect(nbsp.companyKey).toBe(companyNameKey(universeRow!.name));
  });

  it("is the only thing standing between company_name_key and lower()", () => {
    // Stated as an assertion rather than as prose: if this row's company loses
    // its NBSP, no fixture connection differs from its universe row by anything
    // `lower()` would not also fold, and `referral-match.test.ts`'s NBSP tests
    // become the only cover left.
    const distinguishing = FIXTURE_CONNECTIONS.filter(
      (c) => c.company.toLowerCase().trim() !== c.companyKey,
    );
    expect(distinguishing.map((c) => c.fullName)).toEqual(["Chandra Rao"]);
  });
});

describe("every row the header promises exists", () => {
  it("puts two people at one company, so '2 first-degree' is not the same render as '1'", () => {
    const index = indexConnections(FIXTURE_CONNECTIONS);
    const sizes = [...index.values()].map((b) => b.length);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(2);
    expect(index.get("ramp")).toHaveLength(2);
    // And a bucket of exactly one, so the two renders are both reachable.
    expect(sizes).toContain(1);
  });

  it("carries a connection with NO profile URL", () => {
    // The "search for them by name" branch of `connectionUrl` renders from this
    // row, or it ships untested. LinkedIn withholds the URL for connections who
    // restricted it, so this is the everyday case, not a corner.
    const noUrl = FIXTURE_CONNECTIONS.filter((c) => c.profileUrl === "");
    expect(noUrl.map((c) => c.fullName)).toEqual(["Bo Lindqvist"]);
    expect(connectionUrl(noUrl[0])).toContain("/search/results/people/");
  });

  it("carries a connection whose exported URL is NOT a linkedin.com address", () => {
    // A CSV cell is a place a `javascript:` string can live, and the href guard
    // has to have something to refuse. Without this row the guard is a branch no
    // fixture reaches.
    const foreign = FIXTURE_CONNECTIONS.filter(
      (c) => c.profileUrl !== "" && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(c.profileUrl),
    );
    expect(foreign.map((c) => c.fullName)).toEqual(["Dev Patel"]);
    // The guard refuses it and falls back, rather than putting example.invalid in
    // an href on this origin.
    expect(connectionUrl(foreign[0])).not.toContain(foreign[0].profileUrl);
    expect(connectionUrl(foreign[0])).toContain("/search/results/people/");
    // Positive control: a real LinkedIn URL in the same set IS passed through, so
    // the assertion above is about the guard and not about it refusing everything.
    const real = FIXTURE_CONNECTIONS.find((c) => c.profileUrl.includes("linkedin.com"))!;
    expect(connectionUrl(real)).toBe(real.profileUrl);
  });

  it("carries a null connectedOn", () => {
    // LinkedIn's date column is "21 Mar 2023" and an unreadable one must render
    // as absent rather than as today.
    expect(FIXTURE_CONNECTIONS.filter((c) => c.connectedOn === null).map((c) => c.fullName)).toEqual(
      ["Dev Patel"],
    );
    // …beside dates that DO read, or "absent" is the only state on screen.
    expect(FIXTURE_CONNECTIONS.filter((c) => c.connectedOn !== null).length).toBeGreaterThan(1);
    for (const c of FIXTURE_CONNECTIONS) {
      if (c.connectedOn !== null) expect(c.connectedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("carries a very long name and a very long title", () => {
    // FIXTURE_JOBS' reason: long content truncates, it does not blow out the
    // layout. A fixture set of short names ships that untested at every width.
    expect(Math.max(...FIXTURE_CONNECTIONS.map((c) => c.fullName.length))).toBeGreaterThan(40);
    expect(Math.max(...FIXTURE_CONNECTIONS.map((c) => c.title.length))).toBeGreaterThan(60);
  });

  it("carries a connection at a company with no LinkedIn id, and one at no company row at all", () => {
    // Two different "no links" states, and the header claims both. One has names
    // to ask and a paste prompt still on screen; the other has nowhere to paste.
    const universe = indexUniverse(FIXTURE_COMPANIES);
    const watchedButIdless = FIXTURE_CONNECTIONS.filter((c) => {
      const row = universeFor(universe, c.company);
      return row !== null && row.linkedinCompanyId === "";
    });
    expect(watchedButIdless.map((c) => c.fullName)).toEqual(["Chandra Rao", "Dev Patel"]);

    const notInUniverse = FIXTURE_CONNECTIONS.filter(
      (c) => universeFor(universe, c.company) === null,
    );
    expect(notInUniverse.map((c) => c.fullName)).toEqual([
      "Eleni Papadopoulou-Constantinidis von Habsburg-Lothringen",
    ]);

    // Positive control: somebody IS at a company with an id, or all three states
    // above are the same state.
    const withId = FIXTURE_CONNECTIONS.filter(
      (c) => (universeFor(universe, c.company)?.linkedinCompanyId ?? "") !== "",
    );
    expect(withId.map((c) => c.fullName)).toEqual(["Ada Okonkwo", "Bo Lindqvist"]);
  });
});

describe("the fixture's own invariants", () => {
  it("computes companyKey with the function SQL generates the column with", () => {
    // Hand-typing a key here would let a fixture hold one the database could
    // never produce, and the match would pass in the demo and fail in production.
    for (const c of FIXTURE_CONNECTIONS) {
      expect(c.companyKey, `${c.fullName}'s key is not company_name_key(${c.company})`).toBe(
        companyNameKey(c.company),
      );
    }
  });

  it("gives every row a name and a distinct id", () => {
    // `full_name` is the one required column in 0013 — a connection with no name
    // is not a person you can ask for anything, and the CHECK refuses it.
    for (const c of FIXTURE_CONNECTIONS) expect(c.fullName.trim()).not.toBe("");
    expect(new Set(FIXTURE_CONNECTIONS.map((c) => c.id)).size).toBe(FIXTURE_CONNECTIONS.length);
  });
});
