import { describe, expect, it } from "vitest";
import { bindingConstraint } from "@/lib/data/view-models";
import type { JobView } from "@/lib/data/view-models";

/**
 * The number in this message is the whole reason it is trustworthy. "Your
 * metros filtered 3 of 6" sends someone to a setting; a wrong count sends them
 * to the wrong setting and costs more than saying nothing would have.
 */

function job(partial: Partial<JobView>): JobView {
  return {
    key: partial.key ?? "k",
    company: "C",
    title: "T",
    url: "https://example.com",
    status: "Seen",
    location: null,
    metro: null,
    market: null,
    remote: false,
    workModel: null,
    compRange: null,
    compMinK: null,
    compMaxK: null,
    minYoe: null,
    seniority: null,
    industry: null,
    roleFocus: null,
    skills: [],
    posted: null,
    firstSeen: null,
    disposition: "qualified",
    dispositionReason: "",
    triage: "",
    snoozeUntil: null,
    updatedAt: null,
    ...partial,
  };
}

function filtered(key: string, reason: string): JobView {
  return job({ key, disposition: "filtered", dispositionReason: reason });
}

describe("bindingConstraint", () => {
  it("returns null when nothing was filtered", () => {
    expect(bindingConstraint([job({ key: "a" }), job({ key: "b" })])).toBeNull();
  });

  it("returns null for an empty store, rather than inventing a constraint", () => {
    expect(bindingConstraint([])).toBeNull();
  });

  it("groups by setting, not by reason string", () => {
    // Two countries are one countries list. Reporting them as two separate
    // constraints of one row each would bury the setting that actually binds.
    const c = bindingConstraint([
      filtered("a", "geo:India"),
      filtered("b", "geo:United Kingdom"),
      filtered("c", "yoe:8>4"),
    ]);
    expect(c?.setting).toBe("countries");
    expect(c?.filtered).toBe(2);
  });

  it("counts the total across every posting, filtered or not", () => {
    const c = bindingConstraint([
      filtered("a", "comp:<120k"),
      filtered("b", "comp:<120k"),
      job({ key: "c" }),
      job({ key: "d", disposition: "needs-info", dispositionReason: "awaiting-tags" }),
    ]);
    expect(c?.setting).toBe("compMin");
    expect(c?.filtered).toBe(2);
    expect(c?.total).toBe(4);
  });

  it("ignores reasons that point at no setting", () => {
    // "awaiting-tags" is the engine being behind, not a filter the user set.
    // Offering to loosen a setting would be advice about the wrong problem.
    expect(
      bindingConstraint([filtered("a", "awaiting-tags"), filtered("b", "")]),
    ).toBeNull();
  });

  it("carries one filtered row's reason in plain English", () => {
    const c = bindingConstraint([filtered("a", "yoe:8>4")]);
    expect(c?.label).toBe("years-of-experience limit");
    expect(c?.example).toBe("Asks for 8+ years; your limit is 4");
  });

  it("keeps the first setting on a tie, so the message does not flip", () => {
    const rows = [filtered("a", "geo:India"), filtered("b", "comp:<120k")];
    expect(bindingConstraint(rows)?.setting).toBe("countries");
    expect(bindingConstraint(rows)?.setting).toBe("countries");
  });
});
