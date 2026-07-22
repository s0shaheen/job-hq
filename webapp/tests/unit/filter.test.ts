import { describe, expect, it } from "vitest";
import { FIXTURE_JOBS, FIXTURE_NOW } from "@/lib/data/fixtures";
import type { JobView } from "@/lib/data/view-models";
import {
  applyFilter,
  clauseMatches,
  compUnknownCount,
  enumValues,
  formatClause,
  formatGroup,
  hasCompClause,
  quickSearch,
  type Clause,
  type GridFilter,
} from "@/lib/grid/filter";
import { flattenGroups, sortRows } from "@/lib/grid/sort";

/**
 * The filter engine and the ordering pipeline — all pure, all fixture-driven.
 * Expected sets are derived from FIXTURE_JOBS with inline plain-JS predicates
 * (never by calling the engine under test), so a fixture added later moves the
 * expectation with it instead of failing as though the engine broke.
 */

const NOW = Date.parse(FIXTURE_NOW);
const keys = (rows: JobView[]) => rows.map((j) => j.key).sort();

function apply(filter: GridFilter, rows: JobView[] = FIXTURE_JOBS) {
  return applyFilter(rows, filter, NOW);
}

describe("text operators", () => {
  it("has: case-insensitive substring", () => {
    const got = apply([[{ kind: "text", field: "company", op: "has", value: "plai" }]]);
    expect(keys(got)).toEqual(keys(FIXTURE_JOBS.filter((j) => /plai/i.test(j.company))));
    expect(got.length).toBeGreaterThan(0);
  });

  it("is: case-insensitive exact match", () => {
    const got = apply([[{ kind: "text", field: "company", op: "is", value: "ramp" }]]);
    expect(got.map((j) => j.company)).toEqual(["Ramp"]);
  });

  it("empty: true selects unstated, false selects stated", () => {
    const unstated = FIXTURE_JOBS.filter((j) => !j.compRange?.trim());
    expect(unstated.length).toBeGreaterThan(0); // the fixture must model the case
    const gotTrue = apply([[{ kind: "text", field: "compRange", op: "empty", value: true }]]);
    expect(keys(gotTrue)).toEqual(keys(unstated));
    const gotFalse = apply([[{ kind: "text", field: "compRange", op: "empty", value: false }]]);
    expect(keys(gotFalse)).toEqual(keys(FIXTURE_JOBS.filter((j) => !!j.compRange?.trim())));
  });
});

describe("enum operators", () => {
  it("in: case-insensitive exact membership; a null field matches nothing", () => {
    const got = apply([
      [{ kind: "enum", field: "workModel", op: "in", values: ["remote (us)", "Remote"] }],
    ]);
    const expected = FIXTURE_JOBS.filter((j) =>
      ["remote (us)", "remote"].includes((j.workModel ?? "").toLowerCase()),
    );
    expect(keys(got)).toEqual(keys(expected));
    // Microsoft states no work model — "in" must not sweep it up
    expect(got.some((j) => j.company === "Microsoft")).toBe(false);
  });

  it("notin: a null field IS none of the listed values, so it stays", () => {
    const got = apply([[{ kind: "enum", field: "workModel", op: "notin", values: ["Hybrid"] }]]);
    expect(got.some((j) => j.company === "Microsoft")).toBe(true); // null workModel
    expect(got.some((j) => j.workModel === "Hybrid")).toBe(false);
  });

  it('triage reads "" as "undecided" so the URL never carries an empty token', () => {
    const got = apply([[{ kind: "enum", field: "triage", op: "in", values: ["undecided"] }]]);
    expect(keys(got)).toEqual(keys(FIXTURE_JOBS.filter((j) => j.triage === "")));
  });
});

describe("number operators (minYoe — unknown FAILS, unlike comp)", () => {
  it("gte / lte / between compare, and a null value never qualifies", () => {
    const gte5 = apply([[{ kind: "number", field: "minYoe", op: "gte", value: 5 }]]);
    expect(keys(gte5)).toEqual(
      keys(FIXTURE_JOBS.filter((j) => j.minYoe !== null && j.minYoe >= 5)),
    );
    // Mercury states no YoE: it is not ">= 5" and it is not "<= 5" either.
    // The G16 keep-rule is comp-specific; YoE has no gate rule granting
    // unknowns a pass, so inventing one here would be the engine guessing.
    const lte5 = apply([[{ kind: "number", field: "minYoe", op: "lte", value: 5 }]]);
    expect(lte5.some((j) => j.company === "Mercury")).toBe(false);
    expect(gte5.some((j) => j.company === "Mercury")).toBe(false);

    const between = apply([[{ kind: "number", field: "minYoe", op: "between", min: 3, max: 4 }]]);
    expect(keys(between)).toEqual(
      keys(FIXTURE_JOBS.filter((j) => j.minYoe !== null && j.minYoe >= 3 && j.minYoe <= 4)),
    );
  });
});

describe("comp operators — G16: an unknown comp is never silently dropped", () => {
  const unknownComp = FIXTURE_JOBS.filter((j) => j.compMaxK === null);

  it("the fixture models both flavours of unknown: unstated AND unparseable", () => {
    // Chime states nothing; Wise states "£85,000 - £110,000" which the parser
    // (correctly) refuses. Both are compMaxK === null and both must survive a
    // comp filter. If this precondition fails, every test below is vacuous.
    expect(unknownComp.some((j) => j.compRange === null)).toBe(true);
    expect(unknownComp.some((j) => j.compRange !== null)).toBe(true);
  });

  it("gte keeps every unknown-comp row alongside the qualifying stated ones", () => {
    const got = apply([[{ kind: "number", field: "compMax", op: "gte", value: 150 }]]);
    expect(keys(got)).toEqual(
      keys(FIXTURE_JOBS.filter((j) => j.compMaxK === null || j.compMaxK >= 150)),
    );
    // the two named sentinels, so a regression reads as the spec violation it is
    expect(got.some((j) => j.company === "Wise")).toBe(true); // £ band, unparseable
    expect(got.some((j) => j.company === "Chime")).toBe(true); // nothing stated
    expect(got.some((j) => j.company === "Retool")).toBe(false); // $115k top, honestly below
  });

  it("lte and between keep unknowns the same way", () => {
    const lte = apply([[{ kind: "number", field: "compMax", op: "lte", value: 120 }]]);
    expect(keys(lte)).toEqual(
      keys(FIXTURE_JOBS.filter((j) => j.compMaxK === null || j.compMaxK <= 120)),
    );
    const between = apply([
      [{ kind: "number", field: "compMax", op: "between", min: 190, max: 210 }],
    ]);
    expect(keys(between)).toEqual(
      keys(
        FIXTURE_JOBS.filter(
          (j) => j.compMaxK === null || (j.compMaxK >= 190 && j.compMaxK <= 210),
        ),
      ),
    );
  });

  it("excluding unknowns is an explicit second clause, and it spares stated-but-unparsed bands", () => {
    // compRange.empty.false drops rows that STATED nothing (Chime) but keeps
    // Wise, which stated a £ band the sorter cannot parse — the user asked to
    // exclude the silent rows, not the foreign-currency ones. G16 verbatim:
    // "£90k → unknown, and a comp filter never silently drops it."
    const got = apply([
      [{ kind: "number", field: "compMax", op: "gte", value: 150 }],
      [{ kind: "text", field: "compRange", op: "empty", value: false }],
    ]);
    expect(got.some((j) => j.company === "Wise")).toBe(true);
    expect(got.some((j) => j.company === "Chime")).toBe(false);
    expect(got.some((j) => j.company === "Microsoft")).toBe(false);
  });

  it("compUnknownCount and hasCompClause feed the chip's 'incl. N unstated'", () => {
    expect(compUnknownCount(FIXTURE_JOBS)).toBe(unknownComp.length);
    expect(hasCompClause([[{ kind: "number", field: "compMax", op: "gte", value: 150 }]])).toBe(
      true,
    );
    expect(hasCompClause([[{ kind: "number", field: "minYoe", op: "gte", value: 5 }]])).toBe(
      false,
    );
    expect(hasCompClause([])).toBe(false);
  });
});

describe("date operators (pinned to FIXTURE_NOW)", () => {
  it("before and after compare ISO days strictly; a null date never qualifies", () => {
    const cut = "2026-07-16"; // daysAgo(5) at the pinned clock
    const before = apply([[{ kind: "date", field: "posted", op: "before", value: cut }]]);
    expect(keys(before)).toEqual(
      keys(FIXTURE_JOBS.filter((j) => j.posted !== null && j.posted < cut)),
    );
    const after = apply([[{ kind: "date", field: "posted", op: "after", value: cut }]]);
    expect(keys(after)).toEqual(
      keys(FIXTURE_JOBS.filter((j) => j.posted !== null && j.posted > cut)),
    );
  });

  it("inlast N days includes the boundary day", () => {
    const got = apply([[{ kind: "date", field: "posted", op: "inlast", days: 5 }]]);
    expect(keys(got)).toEqual(
      keys(FIXTURE_JOBS.filter((j) => j.posted !== null && j.posted >= "2026-07-16")),
    );
    expect(got.length).toBeGreaterThan(0);
  });
});

describe("tri-state remote", () => {
  it("remote / onsite-hybrid partition the set; absence of the clause is 'any'", () => {
    const remote = apply([[{ kind: "remote", value: "remote" }]]);
    const onsite = apply([[{ kind: "remote", value: "onsite-hybrid" }]]);
    expect(keys(remote)).toEqual(keys(FIXTURE_JOBS.filter((j) => j.remote)));
    expect(keys(onsite)).toEqual(keys(FIXTURE_JOBS.filter((j) => !j.remote)));
    expect(remote.length + onsite.length).toBe(FIXTURE_JOBS.length);
  });
});

describe("compound: AND of OR-groups, depth 2", () => {
  // Synthetic rows toggling each clause independently, so every cell of the
  // (A∨B) ∧ (C∨D) truth table is occupied by exactly one named row.
  const base = FIXTURE_JOBS[0];
  const mk = (key: string, over: Partial<JobView>): JobView => ({ ...base, ...over, key });
  const A = (j: Partial<JobView>) => ({ company: "Acme Corp", ...j });
  const rows: JobView[] = [
    mk("a-and-c", { ...A({}), minYoe: 1, remote: true, compMaxK: 200 }),
    mk("a-and-d", { ...A({}), minYoe: 1, remote: false, compMaxK: 90 }),
    mk("b-and-c", { company: "Zeta", minYoe: 7, remote: true, compMaxK: 200 }),
    mk("b-and-d", { company: "Zeta", minYoe: 7, remote: false, compMaxK: 90 }),
    mk("ab-only", { ...A({}), minYoe: 9, remote: false, compMaxK: 200 }), // first group twice, second never
    mk("cd-only", { company: "Zeta", minYoe: 1, remote: true, compMaxK: 90 }), // second group twice, first never
    mk("neither", { company: "Zeta", minYoe: 1, remote: false, compMaxK: 200 }),
  ];
  const filter: GridFilter = [
    [
      { kind: "text", field: "company", op: "has", value: "acme" }, // A
      { kind: "number", field: "minYoe", op: "gte", value: 5 }, // B
    ],
    [
      { kind: "remote", value: "remote" }, // C
      { kind: "number", field: "compMax", op: "lte", value: 100 }, // D
    ],
  ];

  it("keeps exactly the rows satisfying one clause from EVERY group", () => {
    expect(keys(apply(filter, rows))).toEqual(
      ["a-and-c", "a-and-d", "b-and-c", "b-and-d"].sort(),
    );
  });

  it("a single group is pure OR; single-clause groups are pure AND", () => {
    expect(keys(apply([filter[0]], rows))).toEqual(
      ["a-and-c", "a-and-d", "ab-only", "b-and-c", "b-and-d"].sort(),
    );
    const pureAnd: GridFilter = [
      [{ kind: "text", field: "company", op: "has", value: "acme" }],
      [{ kind: "remote", value: "remote" }],
    ];
    expect(keys(apply(pureAnd, rows))).toEqual(["a-and-c"]);
  });

  it("the empty filter is the identity", () => {
    expect(apply([], rows)).toEqual(rows);
  });
});

describe("quick search", () => {
  it("matches company, title, location and role text, case-insensitively", () => {
    expect(quickSearch(FIXTURE_JOBS, "modern trea").map((j) => j.company)).toEqual([
      "Modern Treasury",
    ]);
    expect(quickSearch(FIXTURE_JOBS, "LEDGER").length).toBeGreaterThan(0);
    expect(quickSearch(FIXTURE_JOBS, "zzz-no-such").length).toBe(0);
    expect(quickSearch(FIXTURE_JOBS, "  ")).toEqual(FIXTURE_JOBS);
  });
});

describe("sorting — matrix row 35: unknowns sort last in BOTH directions", () => {
  const queue = FIXTURE_JOBS.filter((j) => j.disposition === "qualified" && j.triage === "");

  it("comp asc puts the lowest stated band first and null comp last", () => {
    const got = sortRows(queue, { field: "comp", dir: "asc" });
    const stated = queue.filter((j) => j.compMaxK !== null);
    const min = Math.min(...stated.map((j) => j.compMaxK!));
    expect(got[0].compMaxK).toBe(min);
    expect(got[got.length - 1].compMaxK).toBeNull();
  });

  it("comp desc puts the highest first — and null comp STILL last, never first", () => {
    // The naive implementation (null → 0, then invert the comparator) sends
    // every no-comp row to the TOP of "comp desc", which is the exact failure
    // this exists to prevent.
    const got = sortRows(queue, { field: "comp", dir: "desc" });
    const stated = queue.filter((j) => j.compMaxK !== null);
    const max = Math.max(...stated.map((j) => j.compMaxK!));
    expect(got[0].compMaxK).toBe(max);
    expect(got[got.length - 1].compMaxK).toBeNull();
  });

  it("minYoe and posted behave the same way about unknowns", () => {
    for (const dir of ["asc", "desc"] as const) {
      const yoe = sortRows(queue, { field: "minYoe", dir });
      expect(yoe[yoe.length - 1].minYoe).toBeNull(); // Mercury
      const posted = sortRows(FIXTURE_JOBS, { field: "posted", dir });
      expect(posted[posted.length - 1].posted).not.toBeNull(); // every fixture states one…
      const withNull = sortRows(
        [...FIXTURE_JOBS, { ...FIXTURE_JOBS[0], key: "x-noposted", posted: null }],
        { field: "posted", dir },
      );
      expect(withNull[withNull.length - 1].posted).toBeNull(); // …so add one that doesn't
    }
  });

  it("company sorts alphabetically, case-insensitively, and does not mutate its input", () => {
    const input = [...FIXTURE_JOBS];
    const got = sortRows(input, { field: "company", dir: "asc" });
    expect(got.map((j) => j.company)).toEqual(
      [...FIXTURE_JOBS.map((j) => j.company)].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      ),
    );
    expect(input).toEqual(FIXTURE_JOBS); // sortRows returns a copy
    expect(sortRows(input, null)).toBe(input); // no sort → untouched input
  });
});

describe("grouping — flattenGroups", () => {
  const a = FIXTURE_JOBS[0]; // Ramp
  const b = FIXTURE_JOBS[1]; // Plaid
  const c = { ...FIXTURE_JOBS[0], key: "ramp-2" }; // second Ramp row

  it("null group is a pass-through of job rows with sequential leaf indices", () => {
    const got = flattenGroups([a, b], null);
    expect(got).toEqual([
      { kind: "job", job: a, leafIndex: 0 },
      { kind: "job", job: b, leafIndex: 1 },
    ]);
  });

  it("groups by company in first-appearance order, pulling group members together", () => {
    const got = flattenGroups([a, b, c], "company");
    expect(got).toEqual([
      { kind: "group", label: "Ramp", count: 2 },
      { kind: "job", job: a, leafIndex: 0 },
      { kind: "job", job: c, leafIndex: 1 },
      { kind: "group", label: "Plaid", count: 1 },
      { kind: "job", job: b, leafIndex: 2 },
    ]);
  });
});

describe("chip labels and enum values", () => {
  it("formats each clause kind for the filter bar", () => {
    const cases: Array<[Clause, string]> = [
      [{ kind: "text", field: "company", op: "has", value: "ramp" }, 'Company contains "ramp"'],
      [{ kind: "text", field: "compRange", op: "empty", value: false }, "Comp stated"],
      [{ kind: "text", field: "compRange", op: "empty", value: true }, "Comp not stated"],
      [{ kind: "enum", field: "workModel", op: "in", values: ["Remote", "Hybrid"] }, "Work model: Remote or Hybrid"],
      [{ kind: "number", field: "compMax", op: "gte", value: 150 }, "Comp ≥ $150k"],
      [{ kind: "number", field: "compMax", op: "between", min: 120, max: 200 }, "Comp $120k–$200k"],
      [{ kind: "number", field: "minYoe", op: "lte", value: 4 }, "Min YoE ≤ 4"],
      [{ kind: "date", field: "posted", op: "inlast", days: 7 }, "Posted in last 7d"],
      [{ kind: "remote", value: "remote" }, "Remote only"],
      [{ kind: "remote", value: "onsite-hybrid" }, "Onsite or hybrid"],
    ];
    for (const [clause, label] of cases) expect(formatClause(clause)).toBe(label);
    expect(
      formatGroup([
        { kind: "number", field: "compMax", op: "gte", value: 150 },
        { kind: "text", field: "compRange", op: "empty", value: true },
      ]),
    ).toBe("Comp ≥ $150k or Comp not stated");
  });

  it("enumValues offers the distinct stated values, and triage its closed set", () => {
    const wm = enumValues(FIXTURE_JOBS, "workModel");
    expect(wm).toContain("Remote (US)");
    expect(new Set(wm).size).toBe(wm.length); // distinct
    expect(wm).not.toContain(null);
    expect(enumValues(FIXTURE_JOBS, "triage")).toEqual([
      "undecided",
      "interested",
      "snoozed",
      "dismissed",
    ]);
    expect(enumValues(FIXTURE_JOBS, "status")).toContain("Closed");
  });
});

describe("clauseMatches is total — every clause kind answers on every row", () => {
  it("never throws on the awkward fixtures", () => {
    const clauses: Clause[] = [
      { kind: "text", field: "location", op: "has", value: "chicago" },
      { kind: "enum", field: "seniority", op: "in", values: ["PM"] },
      { kind: "number", field: "compMax", op: "gte", value: 1 },
      { kind: "date", field: "firstSeen", op: "inlast", days: 30 },
      { kind: "remote", value: "remote" },
    ];
    for (const job of FIXTURE_JOBS) {
      for (const clause of clauses) {
        expect(typeof clauseMatches(job, clause, NOW)).toBe("boolean");
      }
    }
  });
});
