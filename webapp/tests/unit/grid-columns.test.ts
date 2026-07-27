import { describe, expect, it } from "vitest";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { clampPerfCount, makePerfJobs, PERF_MAX } from "@/lib/data/perf-fixtures";
import { reasonSetting } from "@/lib/data/view-models";
import {
  compText,
  decisionText,
  GRID_COLUMNS,
  locationText,
  whyText,
  workModelText,
  yoeText,
} from "@/lib/grid/columns";
import { isQueueRow, rowsForSet } from "@/lib/grid/presets";

/**
 * The pure halves of the grid: the working-set predicate, the cell text
 * functions, and the perf-fixture generator. Anything needing layout
 * (virtualization, sticky geometry) lives in Playwright — jsdom has no layout
 * engine, and a virtualizer over jsdom renders an empty list that passes
 * everything.
 */

const byKey = new Map(FIXTURE_JOBS.map((j) => [j.key, j]));
const job = (key: string) => {
  const j = byKey.get(key);
  if (!j) throw new Error(`fixture ${key} missing`);
  return j;
};

describe("the Queue working set (acceptance criterion 16's client half)", () => {
  it("selects exactly the qualified, undecided fixtures", () => {
    // Hardcoded on purpose: if the fixture set changes, this list must be
    // re-derived by a person, not silently re-inferred by the code under test.
    const expected = [
      "greenhouse-8814021", // Ramp
      "ashby-3f21a9c4", // Plaid
      "lever-77c1-4d0a", // Chime
      "greenhouse-9920117", // Northwestern Mutual
      "smartrec-551209", // Mercury
      "ashby-c7d9e001", // Brex
      "greenhouse-1120044", // Modern Treasury
      "lever-2ab8-9911", // Vanta
    ];
    const got = FIXTURE_JOBS.filter(isQueueRow).map((j) => j.key);
    expect(got.sort()).toEqual([...expected].sort());
  });

  it("excludes each triaged, filtered and needs-info category", () => {
    expect(isQueueRow(job("greenhouse-4410982"))).toBe(false); // interested
    expect(isQueueRow(job("ashby-90ab12cd"))).toBe(false); // dismissed
    expect(isQueueRow(job("greenhouse-3312876"))).toBe(false); // snoozed
    expect(isQueueRow(job("workday-R_1472470"))).toBe(false); // filtered geo
    expect(isQueueRow(job("lever-6612-77aa"))).toBe(false); // filtered comp
    expect(isQueueRow(job("radancy-40012"))).toBe(false); // needs-info
  });

  it("rowsForSet('all') is the input, untouched", () => {
    // The All set exists to be the escape hatch; any transformation here would
    // make "all" a third, secretly-different set.
    expect(rowsForSet(FIXTURE_JOBS, "all")).toBe(FIXTURE_JOBS);
    expect(rowsForSet(FIXTURE_JOBS, "queue")).toHaveLength(8);
  });
});

describe("column definitions", () => {
  it("ids are unique and the sticky first column is Company", () => {
    const ids = GRID_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("company");
    expect(GRID_COLUMNS[0].meta?.sticky).toBe(true);
    // exactly one sticky column — two would double-cover the scroll edge
    expect(GRID_COLUMNS.filter((c) => c.meta?.sticky)).toHaveLength(1);
  });

  it("numeric-ish columns are right-aligned; text columns are not", () => {
    const rightAligned = GRID_COLUMNS.filter((c) => c.meta?.align === "right").map(
      (c) => c.id,
    );
    expect(rightAligned.sort()).toEqual(["comp", "minYoe", "posted"].sort());
  });

  it("every column is at least 60px wide", () => {
    for (const c of GRID_COLUMNS) {
      expect(c.size, `column ${c.id} has no size`).toBeDefined();
      expect(c.size!).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("cell text — absence is a dash, never an invention", () => {
  it("missing comp is a dash; a non-USD band renders verbatim", () => {
    expect(compText(job("lever-77c1-4d0a"))).toBe("—"); // Chime, no comp
    // The Wise row's £ band parses to null for sorting but must still SHOW —
    // hiding it because it would not parse is the export-column bug in grid form.
    expect(compText(job("workday-R_1472470"))).toBe("£85,000 - £110,000");
  });

  it("missing YoE is a dash; a stated one is the bare number", () => {
    expect(yoeText(job("smartrec-551209"))).toBe("—"); // Mercury, no YoE
    expect(yoeText(job("greenhouse-8814021"))).toBe("3"); // Ramp
    expect(yoeText({ ...job("greenhouse-8814021"), minYoe: 0 })).toBe("Any");
  });

  it("work model and location fall back to Remote only when the row is remote", () => {
    expect(workModelText(job("eightfold-88201"))).toBe("—"); // Microsoft: neither
    expect(workModelText(job("ashby-3f21a9c4"))).toBe("Remote (US)");
    expect(locationText({ ...job("ashby-3f21a9c4"), location: null })).toBe("Remote");
    expect(locationText({ ...job("eightfold-88201"), location: null })).toBe("—");
  });

  it("decision text: undecided is spelled out, a triage value passes through", () => {
    expect(decisionText(job("greenhouse-8814021"))).toBe("undecided");
    expect(decisionText(job("greenhouse-4410982"))).toBe("interested");
    expect(decisionText(job("greenhouse-3312876"))).toBe("snoozed");
  });

  it("why text: qualified rows dash, filtered rows explain in plain English", () => {
    expect(whyText(job("greenhouse-8814021"))).toBe("—");
    expect(whyText(job("workday-R_1472470"))).toBe(
      "Located in United Kingdom, outside your countries",
    );
    expect(whyText(job("radancy-40012"))).toBe(
      "Not yet analysed — it will be classified shortly",
    );
  });
});

describe("perf fixtures — deterministic and honestly shaped", () => {
  it("is deterministic: two calls produce identical rows", () => {
    // The perf budgets in grid-perf.spec.ts are only comparable run-to-run if
    // the dataset is byte-identical. Math.random here would make every perf
    // failure "maybe the data".
    expect(makePerfJobs(500)).toEqual(makePerfJobs(500));
  });

  it("produces n unique keys", () => {
    const rows = makePerfJobs(1000);
    expect(rows).toHaveLength(1000);
    expect(new Set(rows.map((r) => r.key)).size).toBe(1000);
  });

  it("mixes dispositions and triage so Queue and All genuinely differ at 5k", () => {
    const rows = makePerfJobs(1000);
    const queue = rows.filter(isQueueRow);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.length).toBeLessThan(rows.length);
    expect(rows.some((r) => r.disposition === "filtered")).toBe(true);
    expect(rows.some((r) => r.disposition === "needs-info")).toBe(true);
    expect(rows.some((r) => r.triage !== "")).toBe(true);
  });

  it("every filtered row's reason maps to a real profile setting", () => {
    // A reason outside the closed set would render as its raw token in the Why
    // column and dead-end the future settings link.
    for (const r of makePerfJobs(1000)) {
      if (r.disposition !== "filtered") continue;
      expect(
        reasonSetting(r.dispositionReason),
        `unmapped reason: ${r.dispositionReason}`,
      ).not.toBeNull();
    }
  });

  it("keeps the awkward cases the small fixture set carries", () => {
    const rows = makePerfJobs(1000);
    expect(rows.some((r) => r.compRange === null)).toBe(true);
    expect(rows.some((r) => r.minYoe === null)).toBe(true);
    expect(rows.some((r) => r.title.length > 70)).toBe(true);
  });

  it("dates never land after the pinned clock", () => {
    // A future-dated row would make "newest first" reshuffle whenever a test
    // runs across the fixture instant.
    for (const r of makePerfJobs(500)) {
      if (r.posted) expect(r.posted <= "2026-07-21").toBe(true);
      if (r.firstSeen) expect(r.firstSeen <= "2026-07-21").toBe(true);
    }
  });

  it("clamps the query parameter to a bounded, digits-only count", () => {
    expect(clampPerfCount("5000")).toBe(5000);
    expect(clampPerfCount(String(PERF_MAX + 1))).toBe(PERF_MAX);
    expect(clampPerfCount("abc")).toBe(0);
    expect(clampPerfCount("-5")).toBe(0);
    expect(clampPerfCount("")).toBe(0);
    expect(clampPerfCount(undefined)).toBe(0);
    expect(clampPerfCount(["5000", "9"])).toBe(0);
  });

  it("declares the Warm column with no cell of its own", () => {
    // The one column in the table without a `cell`, and the absence is the
    // assertion. `jobs-grid.tsx` renders every Warm cell itself — `WarmCell`
    // reaches a server action, which reaches `getDataSource`, which reaches the
    // `server-only` reader, and a `columns.tsx` that imported it could not be
    // imported by THIS FILE at all.
    //
    // The first version put a dash here as "the no-context branch". It was
    // unreachable: the grid hides the column outright when there is no warm
    // context, which is the only case the dash existed for. Documented dead code
    // is the shape matrix row 227 is about.
    //
    // MUTATION REASON: re-add `cell: () => <Text value={DASH} />` — this goes
    // red, and so does the claim that the grid is the only renderer.
    const warm = GRID_COLUMNS.find((c) => c.id === "warm");
    expect(warm, "the Warm column is gone").toBeTruthy();
    expect(warm!.header).toBe("Warm");
    expect("cell" in warm!).toBe(false);
    // …and every OTHER column does have one, so the assertion above is about
    // this column rather than about the type.
    for (const col of GRID_COLUMNS) {
      if (col.id === "warm") continue;
      expect("cell" in col, `${col.id} lost its cell`).toBe(true);
    }
  });
});
