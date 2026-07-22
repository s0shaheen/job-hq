import { describe, expect, it } from "vitest";
import type { GridFilter } from "@/lib/grid/filter";
import {
  parseGridState,
  serializeGridState,
  type GridUrlState,
} from "@/lib/grid/url-state";

/**
 * URL state — matrix row 30's territory: a clause that does not survive the
 * round trip is a filter the user set and silently lost, and a malformed param
 * that crashes the parser takes the whole page down with it. Every assertion
 * here goes through a real URLSearchParams, because that is what both the
 * server (page searchParams) and the client (useSearchParams) hand us.
 */

function roundTrip(state: GridUrlState): GridUrlState {
  const qs = serializeGridState(state);
  return parseGridState(new URLSearchParams(qs)).state;
}

const EMPTY: GridUrlState = { set: "queue", filter: [], q: "", sort: null, group: null };

describe("serialization shape (the diffable contract)", () => {
  it("emits the plan's exact example string", () => {
    // Exact string on purpose: the URL is a user-visible artifact people
    // bookmark and diff. If this changes, every saved link changes meaning.
    const state: GridUrlState = {
      set: "queue",
      filter: [
        [{ kind: "enum", field: "workModel", op: "in", values: ["Remote", "Hybrid"] }],
        [
          { kind: "number", field: "compMax", op: "gte", value: 150 },
          { kind: "text", field: "compRange", op: "empty", value: true },
        ],
      ],
      q: "payments",
      sort: { field: "posted", dir: "desc" },
      group: "company",
    };
    expect(serializeGridState(state)).toBe(
      "f=workModel.in.Remote|Hybrid&f=compMax.gte.150,compRange.empty.true" +
        "&q=payments&sort=posted.desc&group=company",
    );
  });

  it("the default state serializes to nothing at all", () => {
    // /jobs with no params and /jobs?set=queue&q= must be the SAME url, or
    // every navigation appends noise params and no two links ever compare equal.
    expect(serializeGridState(EMPTY)).toBe("");
  });

  it("preserves params it does not own (perf=5000 must survive a filter change)", () => {
    const base = new URLSearchParams("perf=5000");
    const qs = serializeGridState({ ...EMPTY, set: "all" }, base);
    expect(qs).toContain("perf=5000");
    expect(qs).toContain("set=all");
    // and parsing back does not report the foreign param as garbage
    expect(parseGridState(new URLSearchParams(qs)).dropped).toEqual([]);
  });
});

describe("round trip — parse(serialize(s)) === s", () => {
  it("survives every operator across every field type", () => {
    const state: GridUrlState = {
      set: "all",
      filter: [
        [{ kind: "text", field: "company", op: "has", value: "ramp" }],
        [{ kind: "text", field: "title", op: "is", value: "Product Manager" }],
        [{ kind: "text", field: "location", op: "empty", value: false }],
        [{ kind: "enum", field: "status", op: "notin", values: ["Closed"] }],
        [{ kind: "enum", field: "triage", op: "in", values: ["undecided", "snoozed"] }],
        [{ kind: "number", field: "minYoe", op: "lte", value: 4 }],
        [{ kind: "number", field: "compMax", op: "between", min: 120, max: 200 }],
        [{ kind: "date", field: "posted", op: "before", value: "2026-07-01" }],
        [{ kind: "date", field: "firstSeen", op: "after", value: "2026-06-15" }],
        [{ kind: "date", field: "posted", op: "inlast", days: 7 }],
        [{ kind: "remote", value: "onsite-hybrid" }],
      ],
      q: "payments ops",
      sort: { field: "comp", dir: "asc" },
      group: "company",
    };
    expect(roundTrip(state)).toEqual(state);
  });

  it("survives values containing the separator characters and unicode", () => {
    // "." is structural (field.op.value), "," joins OR-clauses, "|" joins enum
    // values. A company named "Ramp, Inc." or a title with "C|C++" must come
    // back byte-identical, not truncated at the first separator.
    const state: GridUrlState = {
      ...EMPTY,
      filter: [
        [{ kind: "text", field: "company", op: "is", value: "Ramp, Inc." }],
        [{ kind: "text", field: "title", op: "has", value: "C|C++ , v2.5.1" }],
        [{ kind: "text", field: "location", op: "has", value: "Zürich — Süd" }],
        [{ kind: "text", field: "company", op: "has", value: "100% remote & fun" }],
        // literal "%2C" typed by a user must not decay into a comma
        [{ kind: "text", field: "title", op: "has", value: "literal %2C stays" }],
        [
          {
            kind: "enum",
            field: "workModel",
            op: "in",
            values: ["Remote (US)", "Hybrid — 3 days, onsite"],
          },
        ],
      ],
    };
    expect(roundTrip(state)).toEqual(state);
  });

  it("keeps AND-group order and OR-clause order", () => {
    const filter: GridFilter = [
      [
        { kind: "text", field: "company", op: "has", value: "b" },
        { kind: "text", field: "company", op: "has", value: "a" },
      ],
      [{ kind: "text", field: "title", op: "has", value: "z" }],
    ];
    const back = roundTrip({ ...EMPTY, filter });
    expect(back.filter).toEqual(filter);
  });

  it("round-trips q with spaces and set/sort/group alone", () => {
    expect(roundTrip({ ...EMPTY, q: "modern treasury" }).q).toBe("modern treasury");
    expect(roundTrip({ ...EMPTY, set: "all" }).set).toBe("all");
    expect(roundTrip({ ...EMPTY, sort: { field: "company", dir: "desc" } }).sort).toEqual({
      field: "company",
      dir: "desc",
    });
    expect(roundTrip({ ...EMPTY, group: "company" }).group).toBe("company");
  });
});

describe("malformed input — dropped loudly, never a crash, never a guess", () => {
  function parse(qs: string) {
    return parseGridState(new URLSearchParams(qs));
  }

  it("drops only the malformed clause, keeping valid siblings in the same param", () => {
    const { state, dropped } = parse("f=garbage,minYoe.lte.3");
    expect(state.filter).toEqual([[{ kind: "number", field: "minYoe", op: "lte", value: 3 }]]);
    expect(dropped).toEqual(["garbage"]);
  });

  it("rejects unknown fields, wrong ops for a type, and unparseable values", () => {
    const cases = [
      "salary.gte.100", // unknown field
      "company.gte.5", // number op on a text field
      "minYoe.has.three", // text op on a number field
      "minYoe.gte.abc", // not a number
      "compMax.between.9", // between needs min-max
      "compMax.between.200-100", // inverted range: refusing beats silently swapping
      "posted.before.tomorrow", // not an ISO day
      "posted.inlast.-3", // negative window
      "remote.is.maybe", // outside the tri-state
      "company.empty.perhaps", // empty takes true/false only
      "workModel.in.", // an enum clause with zero values matches nothing knowable
    ];
    for (const c of cases) {
      const { state, dropped } = parse(`f=${c}`);
      expect(state.filter, c).toEqual([]);
      expect(dropped, c).toContain(c);
    }
  });

  it("drops a clause with fewer than two dots (nothing to split on)", () => {
    const { state, dropped } = parse("f=company.has");
    expect(state.filter).toEqual([]);
    expect(dropped).toEqual(["company.has"]);
  });

  it("falls back to defaults on malformed set/sort/group, and says so", () => {
    const { state, dropped } = parse("set=weird&sort=comp.sideways&group=metro");
    expect(state.set).toBe("queue");
    expect(state.sort).toBeNull();
    expect(state.group).toBeNull();
    expect(dropped).toEqual(
      expect.arrayContaining(["set=weird", "sort=comp.sideways", "group=metro"]),
    );
  });

  it("rejects a sort on a field that is not sortable", () => {
    const { state, dropped } = parse("sort=skills.asc");
    expect(state.sort).toBeNull();
    expect(dropped).toEqual(["sort=skills.asc"]);
  });

  it("a fully valid URL reports nothing dropped", () => {
    const { dropped } = parse("set=all&f=compMax.gte.150&sort=posted.desc&group=company&q=pay");
    expect(dropped).toEqual([]);
  });
});
