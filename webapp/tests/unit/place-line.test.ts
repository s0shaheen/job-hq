import { describe, expect, it } from "vitest";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { NOT_LISTED, placeLine, type JobView } from "@/lib/data/view-models";

/**
 * The single place segment on Today's fact line.
 *
 * `workModel` is verbatim from tagging, and printing it raw is the failure
 * this function exists to prevent — it carries schedule detail ("Hybrid, 3
 * days onsite"), a parenthesised market ("Remote (US)") and, per the field's
 * own doc comment, an em dash ("Hybrid — NYC"). An em dash reaching interface
 * copy through DATA is invisible to the copy lint, which reads source, so the
 * counterexample below is the one that matters.
 */
const BASE = FIXTURE_JOBS[0] as JobView;
const job = (over: Partial<JobView>): JobView => ({ ...BASE, ...over });

describe("placeLine", () => {
  it("pairs the model word with the metro for an onsite or hybrid role", () => {
    expect(
      placeLine(job({ workModel: "Hybrid", metro: "New York", location: "New York, NY", remote: false })),
    ).toBe("Hybrid, New York");
    expect(
      placeLine(job({ workModel: "Onsite", metro: "Los Angeles", remote: false })),
    ).toBe("Onsite, Los Angeles");
  });

  it("pairs Remote with the country it is anchored in, not with 'Remote' again", () => {
    // `market` answers "Remote" for a remote role, which would render
    // "Remote, Remote". The country is the fact the reader wants.
    expect(
      placeLine(job({ workModel: "Remote (US)", remote: true, market: "Remote", country: "United States" })),
    ).toBe("Remote, US");
    expect(
      placeLine(job({ workModel: "Remote", remote: true, market: "Remote", country: "Canada" })),
    ).toBe("Remote, Canada");
  });

  it("reads only the leading model word, so tagging's trailing detail never prints", () => {
    expect(
      placeLine(job({ workModel: "Hybrid, 3 days onsite", metro: "Chicago", remote: false })),
    ).toBe("Hybrid, Chicago");
    // The em-dash shape the field's doc comment records. Printing `workModel`
    // raw would put a banned glyph on screen through data rather than through
    // a string literal.
    const withDash = placeLine(job({ workModel: "Hybrid — NYC", metro: "New York", remote: false }));
    expect(withDash).toBe("Hybrid, New York");
    expect(withDash).not.toContain("—");
  });

  it("falls back to the board's own location when no metro resolved", () => {
    expect(
      placeLine(job({ workModel: "Onsite", metro: null, location: "Costa Mesa, CA", remote: false })),
    ).toBe("Onsite, Costa Mesa, CA");
  });

  it("keeps whichever half exists when the other does not", () => {
    expect(placeLine(job({ workModel: null, metro: "Seattle", remote: false }))).toBe("Seattle");
    expect(
      placeLine(job({ workModel: "Remote", remote: true, country: null, metro: null, location: null })),
    ).toBe("Remote");
  });

  it("holds the slot with Not listed rather than going blank", () => {
    expect(
      placeLine(
        job({ workModel: null, metro: null, location: null, market: null, country: null, remote: false }),
      ),
    ).toBe(NOT_LISTED);
  });

  it("does not treat an arbitrary tagging string as a model word", () => {
    // "Flexible" is not one of the three. The segment falls back to the place
    // rather than inventing a fourth work model.
    expect(
      placeLine(job({ workModel: "Flexible", metro: "Chicago", remote: false })),
    ).toBe("Chicago");
  });
});
