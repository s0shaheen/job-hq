/**
 * The gate's own counterexamples (`17-ui-verification-standard.md` section 10).
 *
 * A coverage gate is the easiest thing in a repo to write vacuously: declare
 * everything covered, cite nothing checkable, ship a green matrix that proves
 * nothing. So each rule here is driven with a fixture ledger that violates it,
 * and asserted to go red. Mutating any single check in `report.ts` fails one of
 * these.
 */
import { describe, expect, test } from "vitest";
import { buildReport, type BuildOptions } from "../coverage/report";
import { CitationResolver } from "../coverage/spec-titles";
import { blocked, e2e, MISSING, na, type SurfaceLedger } from "../coverage/ledger";
import type { SurfaceSource } from "../coverage/sources";

/** A real spec and a real title, so the resolvable case is genuinely resolved. */
const REAL_SPEC = "triage";
const REAL_TITLE = "the four decision facts are visible without any interaction";

const STATES = ["Populated", "Conflict"];

const SURFACES: SurfaceSource[] = [
  { surface: "demo", status: "exact_inputs_present", blockingAddenda: [], advisoryAddenda: [] },
];

function report(ledger: Record<string, SurfaceLedger>, extra: Partial<BuildOptions> = {}) {
  return buildReport({
    ledger,
    surfaces: SURFACES,
    states: STATES,
    addenda: new Set(["ADD-001"]),
    resolver: new CitationResolver(),
    baseline: { date: "2026-01-01", entries: [{ key: "* | * | live", reason: "no live lane" }] },
    generatedBy: "vitest",
    ...extra,
  });
}

describe("the coverage ledger gate", () => {
  test("a resolvable citation passes, and is counted as covered", () => {
    const result = report({
      demo: {
        routes: ["/demo"],
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.counts.covered).toBe(1);
    expect(result.counts.na).toBe(2); // n/a carries into live mode; covered does not
    expect(result.counts.missingBaselined).toBe(1);
    expect(result.counts.missingNew).toBe(0);
  });

  test("a citation to a title no spec declares FAILS, and names the nearest title", () => {
    const result = report({
      demo: {
        routes: ["/demo"],
        fixture: {
          Populated: e2e(REAL_SPEC, "the four decision facts are visible without any interaction at all"),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("demo | Populated | fixture");
    expect(result.errors[0]).toContain("which that spec does not declare");
    // The point of the near list: "you renamed it to this", not "look for it".
    expect(result.errors[0]).toContain(REAL_TITLE);
  });

  test("a citation to a spec file that does not exist FAILS", () => {
    const result = report({
      demo: {
        routes: ["/demo"],
        fixture: {
          Populated: e2e("no-such", REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("tests/e2e/no-such.spec.ts");
    expect(result.errors[0]).toContain("does not exist");
  });

  test("a missing cell outside the baseline FAILS", () => {
    const result = report({
      demo: {
        routes: ["/demo"],
        fixture: { Populated: e2e(REAL_SPEC, REAL_TITLE), Conflict: MISSING },
      },
    });

    expect(result.counts.missingNew).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("demo | Conflict | fixture");
    expect(result.errors[0]).toContain("outside the 2026-01-01 baseline");
  });

  test("the same missing cell passes once it is baselined, and is still not covered", () => {
    const result = report(
      {
        demo: {
          routes: ["/demo"],
          fixture: { Populated: e2e(REAL_SPEC, REAL_TITLE), Conflict: MISSING },
        },
      },
      {
        baseline: {
          date: "2026-01-01",
          entries: [
            { key: "* | * | live", reason: "no live lane" },
            { key: "demo | Conflict | fixture", reason: "no spec simulates a second writer" },
          ],
        },
      },
    );

    expect(result.errors).toEqual([]);
    expect(result.counts.missingNew).toBe(0);
    expect(result.counts.missingBaselined).toBe(3);
    expect(result.counts.covered).toBe(1);
  });

  test("a missing cell on an unrouted surface is listed as unbuilt, never enforced", () => {
    const result = report({ demo: { routes: [], fixture: {} } });

    expect(result.errors).toEqual([]);
    expect(result.counts.missingNew).toBe(0);
    expect(result.counts.unbuilt).toBe(4);
  });

  test("a baseline entry that no longer matches a missing cell FAILS", () => {
    const result = report(
      {
        demo: {
          routes: ["/demo"],
          fixture: {
            Populated: e2e(REAL_SPEC, REAL_TITLE),
            Conflict: na("this surface issues no write, so two writers cannot disagree"),
          },
        },
      },
      {
        baseline: {
          date: "2026-01-01",
          entries: [
            { key: "* | * | live", reason: "no live lane" },
            { key: "demo | Conflict | fixture", reason: "closed by the surface packet, entry left behind" },
          ],
        },
      },
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("no longer matches a missing cell");
  });

  test("a blocked cell naming an ADD item nobody wrote down FAILS", () => {
    const result = report({
      demo: {
        routes: ["/demo"],
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: blocked("ADD-999", "there is no approved design input for a conflicting write here"),
        },
      },
    });

    expect(result.errors.some((e) => e.includes("ADD-999"))).toBe(true);
  });

  test("a state the ledger invents, or a surface the manifest does not list, FAILS", () => {
    const result = report({
      demo: {
        routes: ["/demo"],
        fixture: {
          Populated: e2e(REAL_SPEC, REAL_TITLE),
          Conflict: na("this surface issues no write, so two writers cannot disagree"),
          "Vibes acceptable": na("a state the parity standard has never heard of"),
        },
      },
      ghost: { routes: ["/ghost"], fixture: {} },
    });

    expect(result.errors.some((e) => e.includes("Vibes acceptable"))).toBe(true);
    expect(result.errors.some((e) => e.includes('ledger declares surface "ghost"'))).toBe(true);
  });

  test("a surface in the manifest that the ledger forgot FAILS", () => {
    const result = report({}, {});
    expect(result.errors.some((e) => e.includes('which the ledger does not declare'))).toBe(true);
  });
});

describe("the shipped ledger", () => {
  test("declares every real surface and state, and every citation resolves", () => {
    // No injection: the real manifest, the real section 5 table, the real specs.
    const result = buildReport({ generatedBy: "vitest" });
    expect(result.errors).toEqual([]);
  });

  test("does not claim coverage it does not have", () => {
    const result = buildReport({ generatedBy: "vitest" });
    // Every live cell is missing or excused; none is covered. If this ever goes
    // green by accident, the live lane arrived without anyone saying so.
    const coveredLive = result.rows.filter((r) => r.mode === "live" && r.cell.verdict === "covered");
    expect(coveredLive).toEqual([]);
  });
});
