import { describe, expect, it } from "vitest";
import {
  connectionUrl,
  DEGREE_LABELS,
  extractLinkedinId,
  isLinkedinId,
  peopleSearchUrl,
  RECRUITER_KEYWORDS,
  roleKeywords,
  warmLinks,
} from "@/lib/referral/linkedin";

/**
 * The URL builder, which is the whole of layer 0.
 *
 * Nothing in `lib/referral/linkedin.ts` fetches anything — it turns data the app
 * already holds into an address a person clicks in their own logged-in browser.
 * That makes every failure here a *string* failure, and there are exactly two
 * kinds worth this many tests:
 *
 *   1. **A URL that quietly means something else.** A dropped facet, a mangled
 *      id, a present-but-empty parameter: LinkedIn answers all three with a
 *      results page, and a results page that is wrong reads as "nobody works
 *      there" rather than as an error. Nothing about that is visible from the
 *      screen it was launched from.
 *   2. **A URL that came out of somebody's uploaded CSV.** `profile_url` is a
 *      spreadsheet cell, and a spreadsheet cell is a place a `javascript:` string
 *      can live. See the last describe block.
 *
 * Full strings are asserted rather than fragments, because a facet-order change
 * or an encoding change is exactly the kind of edit that "still contains
 * currentCompany" would sail through.
 */

/**
 * The URL as a person reads it. `%5B%221035%22%5D` is `["1035"]` and asserting
 * the second is what makes these tests legible; the raw encoding is pinned once,
 * below, so the decode here cannot hide a change to it.
 */
const decoded = (url: string) => decodeURIComponent(url);

const BASE = "https://www.linkedin.com/search/results/people/";

describe("peopleSearchUrl builds one facet per parameter", () => {
  it("puts a company id in currentCompany, as a JSON array", () => {
    // Mutant: `params.set("currentCompany", current.join(","))` — LinkedIn reads
    // the bare list as one malformed id and returns everybody.
    expect(decoded(peopleSearchUrl({ companyIds: ["1035"] }))).toBe(
      `${BASE}?currentCompany=["1035"]`,
    );
    // The raw encoding, pinned once. Every other assertion in this file decodes,
    // so without this line a switch to a non-encoding join would go unnoticed.
    expect(peopleSearchUrl({ companyIds: ["1035"] })).toBe(
      `${BASE}?currentCompany=%5B%221035%22%5D`,
    );
  });

  it("names each facet the way LinkedIn spells it", () => {
    // Mutant: rename any one of these keys (`schoolFilter` → `school`, `geoUrn` →
    // `geo`). LinkedIn ignores an unknown parameter, so the search silently
    // widens to every person at the company rather than failing.
    expect(decoded(peopleSearchUrl({ pastCompanyIds: ["7"] }))).toBe(`${BASE}?pastCompany=["7"]`);
    expect(decoded(peopleSearchUrl({ schoolIds: ["9"] }))).toBe(`${BASE}?schoolFilter=["9"]`);
    expect(decoded(peopleSearchUrl({ geoIds: ["3"] }))).toBe(`${BASE}?geoUrn=["3"]`);
    expect(decoded(peopleSearchUrl({ degrees: ["F"] }))).toBe(`${BASE}?network=["F"]`);
    expect(peopleSearchUrl({ keywords: "payments" })).toBe(`${BASE}?keywords=payments`);
  });

  it("carries several ids in one facet, in the order given", () => {
    expect(decoded(peopleSearchUrl({ companyIds: ["1035", "2077"] }))).toBe(
      `${BASE}?currentCompany=["1035","2077"]`,
    );
  });

  it("emits the facets in a stable order", () => {
    // A test that pins a URL has to stay pinned, and the order is not incidental:
    // these strings end up in a testid, in a bug report, and in somebody's
    // browser history. Mutant: move the `network` block above `currentCompany` in
    // `peopleSearchUrl` — every URL in this file changes and only this assertion
    // says so.
    expect(
      decoded(
        peopleSearchUrl({
          keywords: "payments",
          degrees: ["F", "S"],
          geoIds: ["3"],
          schoolIds: ["9"],
          pastCompanyIds: ["7"],
          companyIds: ["1035"],
        }),
      ),
    ).toBe(
      `${BASE}?currentCompany=["1035"]&pastCompany=["7"]&schoolFilter=["9"]` +
        `&geoUrn=["3"]&network=["F","S"]&keywords=payments`,
    );
  });

  it("is the bare search surface when nothing is supplied", () => {
    // No trailing `?`. Mutant: `return `${PEOPLE_SEARCH}?${query}`` unconditionally.
    expect(peopleSearchUrl({})).toBe(BASE);
    expect(peopleSearchUrl({ companyIds: [], degrees: [], keywords: "  " })).toBe(BASE);
  });
});

describe("an id that is not an id is dropped, not escaped and passed", () => {
  /**
   * `companies.linkedin_company_id` is free-vocab at the column by 0008's
   * precedent — the closed set lives in `app_set_linkedin_company_id`, so the
   * day the Python mirror or a psql fix writes something else, this module is
   * the guard that is still standing.
   */
  const NOT_IDS = [
    ["javascript:1", "the anchoring case — an unanchored /[0-9]{1,20}/ matches the 1"],
    ["1035; DROP", "digits with a tail"],
    ["abc", "no digits at all"],
    ["", "an empty cell"],
    [" ", "a cell holding one space"],
    ["123456789012345678901", "21 digits — one past the bound"],
  ] as const;

  it("refuses every one of them at the predicate", () => {
    for (const [value, why] of NOT_IDS) {
      expect(isLinkedinId(value), `${JSON.stringify(value)}: ${why}`).toBe(false);
    }
    // The positive control, without which the loop above passes for a predicate
    // that returns false for everything.
    expect(isLinkedinId("1035")).toBe(true);
    expect(isLinkedinId("12345678901234567890")).toBe(true); // 20 digits, the bound itself
    expect(isLinkedinId("  1035  ")).toBe(true); // trimmed, as the paste form receives it
    expect(isLinkedinId(null)).toBe(false);
    expect(isLinkedinId(undefined)).toBe(false);
  });

  it("drops the bad id and keeps the good one", () => {
    // Mutant: drop the `.filter(...)` in `ids()`. The URL then carries
    // `["1035","javascript:1"]`, correctly encoded and completely wrong.
    for (const [value] of NOT_IDS) {
      expect(decoded(peopleSearchUrl({ companyIds: ["1035", value] }))).toBe(
        `${BASE}?currentCompany=["1035"]`,
      );
    }
  });

  it("OMITS the facet when every id in it was dropped — never present-and-empty", () => {
    // The one that matters most in this block. `currentCompany=[]` is a URL
    // LinkedIn renders as a results page with nothing in it, and a person reads
    // that as "nobody works there" rather than as "we could not build this
    // search". Mutant: change `if (current.length)` to an unconditional
    // `params.set` — this goes red and nothing else in the file does.
    for (const [value, why] of NOT_IDS) {
      const url = peopleSearchUrl({ companyIds: [value] });
      expect(url, `${JSON.stringify(value)}: ${why}`).toBe(BASE);
      expect(url).not.toContain("currentCompany");
    }
    // …and the same for every other id-shaped facet, so the rule is the module's
    // and not one branch's.
    expect(peopleSearchUrl({ pastCompanyIds: ["nope"] })).toBe(BASE);
    expect(peopleSearchUrl({ schoolIds: ["nope"] })).toBe(BASE);
    expect(peopleSearchUrl({ geoIds: ["nope"] })).toBe(BASE);
    // Positive control: the same call with a real id DOES emit the facet, so the
    // assertions above are about the drop and not about the builder being inert.
    expect(peopleSearchUrl({ pastCompanyIds: ["7"] })).toContain("pastCompany");
  });
});

describe("keyword encoding", () => {
  it("round-trips a keyword that would otherwise break out of its parameter", () => {
    // `&` starts a new parameter, `#` starts a fragment, `"` closes the JSON
    // array the id facets are written as. Mutant: build the query by hand
    // (`?keywords=${keywords}`) instead of through `URLSearchParams` — the `&`
    // splits the parameter and everything after it is read as a facet name.
    const keyword = 'payments & "money movement" #ledger é';
    const url = peopleSearchUrl({ companyIds: ["1035"], keywords: keyword });

    expect(url).not.toContain("#");
    expect(url.split("&")).toHaveLength(2); // exactly one separator: the real one

    const params = new URL(url).searchParams;
    expect(params.get("keywords")).toBe(keyword);
    expect(params.get("currentCompany")).toBe('["1035"]');
    // Nothing else got invented by the encoding.
    expect([...params.keys()]).toEqual(["currentCompany", "keywords"]);
  });

  it("spells a space %20 and never +", () => {
    // `URLSearchParams.toString()` is form-urlencoded, which writes a space as
    // `+`. That is correct for a form POST and a coin flip in a query string: `+`
    // means a space only to a reader that decodes form-urlencoded, and one that
    // does not searches LinkedIn for the literal `product+manager` and returns
    // nothing. `%20` is read the same way by every decoder.
    //
    // Asserted on the RAW href, not through `decoded()` — `decodeURIComponent`
    // leaves a `+` alone, so the helper this file uses everywhere else would
    // absorb exactly this bug. Mutant: drop the `.replace(/\+/g, "%20")` in
    // `peopleSearchUrl`.
    const url = peopleSearchUrl({ companyIds: ["1035"], keywords: "product manager payments" });
    expect(url).toContain("keywords=product%20manager%20payments");
    expect(url).not.toContain("+");

    // The half that makes a blanket replace safe: the serializer runs FIRST, so a
    // `+` somebody actually typed is already `%2B` by then and survives as one.
    // Without that ordering the replace would eat real plus signs, and `C++` is a
    // keyword people search for.
    const plus = peopleSearchUrl({ keywords: "C++ developer" });
    expect(plus).toBe(`${BASE}?keywords=C%2B%2B%20developer`);
    expect(new URL(plus).searchParams.get("keywords")).toBe("C++ developer");
  });

  it("trims a keyword and omits it when nothing is left", () => {
    expect(peopleSearchUrl({ keywords: "  payments  " })).toBe(`${BASE}?keywords=payments`);
    expect(peopleSearchUrl({ companyIds: ["1035"], keywords: "   " })).toBe(
      `${BASE}?currentCompany=%5B%221035%22%5D`,
    );
  });

  it("keeps the recruiter query's quotes intact through the encoding", () => {
    // Unquoted, `talent acquisition` matches either word and returns most of a
    // company's HR org — the quoting is the whole search.
    expect(RECRUITER_KEYWORDS).toBe('recruiter OR "talent acquisition" OR "technical sourcer"');
    const params = new URL(peopleSearchUrl({ keywords: RECRUITER_KEYWORDS })).searchParams;
    expect(params.get("keywords")).toBe(RECRUITER_KEYWORDS);
  });
});

describe("network degrees", () => {
  it("dedupes, filters junk, and omits the facet when nothing survives", () => {
    // Mutant: drop the `filter` — `network=["F","banana"]` is a facet LinkedIn
    // cannot parse, so it drops the whole degree filter and returns third-degree
    // strangers under a heading that says 1st.
    expect(decoded(peopleSearchUrl({ degrees: ["F", "F", "S"] }))).toBe(`${BASE}?network=["F","S"]`);
    expect(
      decoded(peopleSearchUrl({ degrees: ["F", "X" as never, "O"] })),
    ).toBe(`${BASE}?network=["F","O"]`);
    // Every value junk → no facet at all, for the same reason the id facets are
    // omitted rather than emitted empty.
    expect(peopleSearchUrl({ degrees: ["X" as never] })).toBe(BASE);
    expect(peopleSearchUrl({ degrees: [] })).toBe(BASE);
    // Positive control.
    expect(peopleSearchUrl({ degrees: ["O"] })).toContain("network");
  });

  it("labels the three degrees the way LinkedIn's own UI does", () => {
    expect(DEGREE_LABELS).toEqual({ F: "1st", S: "2nd", O: "3rd+" });
  });
});

describe("roleKeywords", () => {
  it("strips stop words and the whole seniority ladder", () => {
    // The ladder is removed on purpose: "Senior Product Manager" should find the
    // product org, and pinning the search to one rung hides the person one rung
    // up who is the better ask. Mutant: delete "senior" from TITLE_STOP_WORDS.
    expect(roleKeywords("Senior Product Manager, Payments")).toBe("product manager payments");
    expect(roleKeywords("Staff Product Manager")).toBe("product manager");
    expect(roleKeywords("Principal Product Manager II")).toBe("product manager");
    expect(roleKeywords("Associate Product Manager")).toBe("product manager");
  });

  it("splits on punctuation rather than gluing it to the word before", () => {
    // Mutant: `.replace(/[^a-z0-9]+/g, "")` — "PM/TPM" becomes the single
    // nonsense token "pmtpm" and the search returns nothing.
    expect(roleKeywords("PM/TPM")).toBe("pm tpm");
    expect(roleKeywords("Product Manager (Remote)")).toBe("product manager");
    expect(roleKeywords("Product_Manager-Payments")).toBe("product manager payments");
  });

  it("de-duplicates in order, because repeating a term narrows nothing", () => {
    // "Product Manager, Product Platform" is a real title.
    expect(roleKeywords("Product Manager, Product Platform")).toBe("product manager platform");
  });

  it("caps at four words", () => {
    // Past four LinkedIn ANDs the terms into nothing, and a link that always
    // returns zero results teaches somebody to stop clicking. Mutant: `.slice(0, 6)`.
    expect(roleKeywords("Product Manager Payments Ledger Billing Disputes")).toBe(
      "product manager payments ledger",
    );
  });

  it("answers the empty string for a title made only of stop words", () => {
    expect(roleKeywords("Senior Associate, Full Time (Remote, US)")).toBe("");
    expect(roleKeywords("")).toBe("");
    expect(roleKeywords(null as never)).toBe("");
  });

  it("and that empty string removes the 'People in this role' link entirely", () => {
    // The assertion that makes the one above matter. A blank `keywords` facet
    // would render a link labelled "People in this role" that searches for
    // everybody at the company — a link whose label is a lie.
    const links = warmLinks({ companyId: "1035", title: "Senior Associate (Remote)" });
    expect(links.map((l) => l.id)).not.toContain("peers");
    // Positive control on the same company: a real title DOES produce it.
    expect(
      warmLinks({ companyId: "1035", title: "Product Manager, Payments" }).map((l) => l.id),
    ).toContain("peers");
  });
});

describe("extractLinkedinId", () => {
  it("takes the bare number people paste", () => {
    expect(extractLinkedinId("1035")).toEqual({ id: "1035" });
    expect(extractLinkedinId("  1035  ")).toEqual({ id: "1035" });
  });

  it("takes the id out of a 'See all employees' URL, in both shapes", () => {
    // LinkedIn has shipped the facet bare and JSON-array-encoded; a reader that
    // only handles one of them refuses a URL the person copied correctly.
    expect(
      extractLinkedinId("https://www.linkedin.com/search/results/people/?f_C=1035&origin=COMPANY"),
    ).toEqual({ id: "1035" });
    expect(
      extractLinkedinId(
        "https://www.linkedin.com/search/results/people/?f_C=%5B%221035%22%5D&origin=COMPANY",
      ),
    ).toEqual({ id: "1035" });
    expect(
      extractLinkedinId('https://www.linkedin.com/search/results/people/?currentCompany=["1035"]'),
    ).toEqual({ id: "1035" });
  });

  it("refuses an empty paste", () => {
    const r = extractLinkedinId("");
    expect(r).toHaveProperty("error");
    expect("id" in r).toBe(false);
    expect((r as { error: string }).error).not.toBe("");
  });

  it("refuses the company PAGE url BY NAME, pointing at the thing that works", () => {
    // The failure mode worth being helpful about: `linkedin.com/company/ramp`
    // carries no id at all, and "invalid input" would leave somebody pasting it
    // again.
    //
    // Written against the mutant that collapses the two error branches into one
    // generic message. The FIRST version of this test asserted only "See all
    // employees" and "f_C=" — both of which the generic message also contains —
    // so the mutant survived it. It is the difference between the two messages
    // that carries the value, so that is what is asserted.
    const page = extractLinkedinId("https://www.linkedin.com/company/ramp/?trk=public_jobs");
    const junk = extractLinkedinId("see attached");
    expect("id" in page).toBe(false);
    expect("id" in junk).toBe(false);
    const pageError = (page as { error: string }).error;
    const junkError = (junk as { error: string }).error;

    expect(pageError).toContain("company page URL");
    expect(pageError).toContain("See all employees");
    expect(pageError).toContain("f_C=");
    // The load-bearing one: this paste gets its OWN sentence, because the person
    // did almost the right thing and needs to be told which half was wrong.
    expect(pageError).not.toBe(junkError);
    expect(junkError).not.toContain("company page URL");
  });

  it("refuses junk rather than guessing an id out of it", () => {
    // A wrong company id sends somebody's outreach to strangers at another
    // company, which is worse than an empty cell.
    for (const junk of ["ramp", "https://example.com/1035x", "see attached", "!!!"]) {
      const r = extractLinkedinId(junk);
      expect("id" in r, `${junk} should not yield an id`).toBe(false);
      expect((r as { error: string }).error.length).toBeGreaterThan(0);
    }
  });

  it("never throws — a refusal is an object, and every id it returns is one", () => {
    // The contract the paste form depends on: it renders `error` beside the
    // input, so an exception here is a white screen instead of a sentence.
    for (const input of ["", "   ", "javascript:1", "0".repeat(50), "1035", "f_C=99"]) {
      const r = extractLinkedinId(input);
      if ("id" in r) expect(isLinkedinId(r.id), `${input} yielded a non-id`).toBe(true);
      else expect(typeof r.error).toBe("string");
    }
  });
});

describe("warmLinks", () => {
  it("returns nothing when there is no company id", () => {
    // The cell renders the paste prompt instead. A link set built on a missing id
    // is five searches for "everybody on LinkedIn" dressed up as warm paths.
    expect(warmLinks({ companyId: "" })).toEqual([]);
    expect(warmLinks({ companyId: null })).toEqual([]);
    expect(warmLinks({ companyId: undefined })).toEqual([]);
  });

  it("returns nothing when the id is NON-NUMERIC, which is the same failure", () => {
    // Both halves asserted, because the column is free-vocab: a value the
    // database let through is exactly the value that reaches here. Mutant: change
    // the guard to `if (!companyId) return []` — the blank cases above still pass
    // and this one goes red.
    for (const bad of ["javascript:1", "ramp", "1035; DROP", "1".repeat(21)]) {
      expect(warmLinks({ companyId: bad, title: "Product Manager" }), bad).toEqual([]);
    }
    // Positive control: the same call with digits produces the full set.
    expect(warmLinks({ companyId: "1035", title: "Product Manager" }).length).toBeGreaterThan(0);
  });

  it("returns the five company-scoped links, in the order a person should try them", () => {
    // Recruiters first because that link works regardless of warmth and never has
    // a zero-result day; the degree filters after, because they are the ones that
    // pay off. Mutant: reorder the pushes.
    const links = warmLinks({ companyId: "1035", title: "Senior Product Manager, Payments" });
    expect(links.map((l) => l.id)).toEqual([
      "recruiters",
      "peers",
      "first",
      "second",
      "everyone",
    ]);

    const byId = new Map(links.map((l) => [l.id, l]));
    expect(decoded(byId.get("first")!.href)).toBe(
      `${BASE}?currentCompany=["1035"]&network=["F"]`,
    );
    expect(decoded(byId.get("second")!.href)).toBe(
      `${BASE}?currentCompany=["1035"]&network=["F","S"]`,
    );
    expect(decoded(byId.get("everyone")!.href)).toBe(`${BASE}?currentCompany=["1035"]`);
    expect(new URL(byId.get("recruiters")!.href).searchParams.get("keywords")).toBe(
      RECRUITER_KEYWORDS,
    );
    expect(new URL(byId.get("peers")!.href).searchParams.get("keywords")).toBe(
      "product manager payments",
    );
    // Every link says in words what its search actually asks for, and names the
    // role search's terms — a link whose detail does not match its href is the
    // copy-promises-unwired-behaviour defect (matrix row 227) one level down.
    expect(byId.get("peers")!.detail).toContain('"product manager payments"');
    for (const link of links) {
      expect(link.label, `${link.id} has no label`).not.toBe("");
      expect(link.detail, `${link.id} has no detail`).not.toBe("");
      expect(link.href.startsWith(BASE), `${link.id} points off the search surface`).toBe(true);
    }
  });

  it("gives every link a stable id, so a React key and a testid can rely on it", () => {
    const a = warmLinks({ companyId: "1035", title: "Product Manager" });
    const b = warmLinks({ companyId: "1035", title: "Product Manager" });
    expect(a.map((l) => l.id)).toEqual(b.map((l) => l.id));
    expect(new Set(a.map((l) => l.id)).size).toBe(a.length);
  });

  /**
   * The school and past-company links, which NO SURFACE SUPPLIES TODAY.
   *
   * Said out loud rather than left for somebody to discover: the doc comment on
   * `WarmLinkOptions.signals` states the gap and its cause — those two links need
   * two numeric ids per USER, and there is no per-user place to keep them
   * (`profiles.criteria` is pinned field-by-field to `monitor/gates.py`,
   * `profiles.notify` belongs to the digest phase, and inventing a settings
   * surface for two fields is a profile-phase change).
   *
   * Matrix row 227 is "dead code carrying a promise", and this is the exception
   * to it being made DELIBERATELY: the branch is built and tested, the copy never
   * mentions alumni, and nothing on screen promises it. The tests below are what
   * make "built and tested" true rather than a claim — and the absence assertion
   * is what keeps the unwired half from appearing in a cell by accident.
   */
  describe("the school / past-company branch, deliberately unwired", () => {
    it("is absent when no signals are supplied", () => {
      const ids = warmLinks({ companyId: "1035", title: "Product Manager" }).map((l) => l.id);
      expect(ids).not.toContain("alumni");
      expect(ids).not.toContain("ex-colleagues");
      // Same for a signals object that carries no ids — an empty array must not
      // produce a link whose facet was then dropped, which is the present-and-
      // empty failure from the top of this file arriving by another route.
      const empty = warmLinks({
        companyId: "1035",
        signals: { schoolIds: [], pastCompanyIds: [], schoolLabel: "UIUC" },
      }).map((l) => l.id);
      expect(empty).not.toContain("alumni");
      expect(empty).not.toContain("ex-colleagues");
    });

    it("appears, correctly built, the moment ids are supplied", () => {
      const links = warmLinks({
        companyId: "1035",
        title: "Product Manager",
        signals: {
          schoolIds: ["18043"],
          schoolLabel: "UIUC",
          pastCompanyIds: ["1234", "5678"],
          pastCompanyLabel: "Capital One",
        },
      });
      const byId = new Map(links.map((l) => [l.id, l]));
      expect(links.map((l) => l.id).slice(-2)).toEqual(["alumni", "ex-colleagues"]);
      expect(byId.get("alumni")!.label).toBe("UIUC here");
      expect(decoded(byId.get("alumni")!.href)).toBe(
        `${BASE}?currentCompany=["1035"]&schoolFilter=["18043"]`,
      );
      expect(byId.get("ex-colleagues")!.label).toBe("Ex-Capital One here");
      expect(decoded(byId.get("ex-colleagues")!.href)).toBe(
        `${BASE}?currentCompany=["1035"]&pastCompany=["1234","5678"]`,
      );
    });

    it("falls back to a generic label rather than rendering 'undefined here'", () => {
      const links = warmLinks({ companyId: "1035", signals: { schoolIds: ["18043"] } });
      expect(links.find((l) => l.id === "alumni")!.label).toBe("Your school here");
    });
  });
});

/**
 * The href guard — the one place in this feature where a wrong answer is a
 * security bug rather than a bad search.
 *
 * `connections.profile_url` arrives from a CSV the user uploaded. A CSV cell is
 * a place a `javascript:` string can live, and rendering one as an href would
 * make somebody's spreadsheet a script on this origin. The guard is therefore
 * an allowlist — an https linkedin.com address, or a name search instead — and
 * every case below is a shape somebody could get into that column.
 */
describe("connectionUrl refuses anything that is not a linkedin.com profile", () => {
  const person = { fullName: "Ada Okonkwo", companyId: "1035" };
  const nameSearch = `${BASE}?currentCompany=["1035"]&network=["F"]&keywords=Ada Okonkwo`;

  it("passes a real profile URL through verbatim", () => {
    // The positive control the refusals below are only meaningful beside: without
    // it, a guard that refused EVERYTHING would pass every test in this block.
    const url = "https://www.linkedin.com/in/ada-okonkwo";
    expect(connectionUrl({ ...person, profileUrl: url })).toBe(url);
    // Verbatim, including the tracking tail LinkedIn's own export writes.
    const tracked = "https://www.linkedin.com/in/ada-okonkwo?trk=contacts-contacts_list";
    expect(connectionUrl({ ...person, profileUrl: tracked })).toBe(tracked);
  });

  it("passes a country subdomain, which is what half the export holds", () => {
    // Mutant: anchor the pattern at `https://www\.linkedin\.com/` — every
    // connection outside the US falls back to a name search, and the feature
    // quietly half-works for anyone with an international network.
    expect(connectionUrl({ ...person, profileUrl: "https://uk.linkedin.com/in/x" })).toBe(
      "https://uk.linkedin.com/in/x",
    );
    expect(connectionUrl({ ...person, profileUrl: "https://linkedin.com/in/x" })).toBe(
      "https://linkedin.com/in/x",
    );
  });

  it("refuses http — the scheme is part of the allowlist, not decoration", () => {
    // Mutant: `/^https?:\/\//`. A plain-http link is a downgrade somebody's
    // network can rewrite, and the export never writes one.
    expect(decoded(connectionUrl({ ...person, profileUrl: "http://www.linkedin.com/in/x" }))).toBe(
      nameSearch,
    );
  });

  it("refuses a javascript: URL", () => {
    // The whole reason this function is not `profileUrl || search`.
    expect(
      decoded(connectionUrl({ ...person, profileUrl: "javascript:alert(1)" })),
    ).toBe(nameSearch);
    expect(connectionUrl({ ...person, profileUrl: "javascript:alert(1)" })).not.toContain(
      "javascript",
    );
  });

  it("refuses a host that merely CONTAINS linkedin.com in its path", () => {
    // Mutant: `/linkedin\.com/i.test(raw)` — a substring test passes
    // `https://evil.com/linkedin.com/x` and puts an attacker's host in an href
    // the user has every reason to trust.
    for (const hostile of [
      "https://evil.com/linkedin.com/x",
      "https://linkedin.com.evil.com/in/x",
      "https://notlinkedin.com/in/x",
    ]) {
      expect(decoded(connectionUrl({ ...person, profileUrl: hostile })), hostile).toBe(nameSearch);
    }
  });

  it("falls back to a name search when the export gave no URL at all", () => {
    // LinkedIn omits the URL for connections who restricted it, so this is the
    // everyday case rather than the corner: "here is the name, go find them
    // yourself" is a worse answer than a search that usually lands.
    expect(decoded(connectionUrl({ ...person, profileUrl: "" }))).toBe(nameSearch);
    expect(decoded(connectionUrl({ ...person, profileUrl: null }))).toBe(nameSearch);
    expect(decoded(connectionUrl({ fullName: "Ada Okonkwo", companyId: "1035" }))).toBe(nameSearch);
  });

  it("scopes the fallback search to the company only when the id is usable", () => {
    // Same free-vocab distrust as everywhere else in this module: a junk company
    // id must not turn the fallback into a search LinkedIn cannot parse.
    expect(
      decoded(connectionUrl({ fullName: "Ada Okonkwo", companyId: "javascript:1", profileUrl: "" })),
    ).toBe(`${BASE}?network=["F"]&keywords=Ada Okonkwo`);
    expect(
      decoded(connectionUrl({ fullName: "Ada Okonkwo", profileUrl: "" })),
    ).toBe(`${BASE}?network=["F"]&keywords=Ada Okonkwo`);
  });
});
