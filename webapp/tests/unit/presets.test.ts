/**
 * The built-in presets (G3) — the working sets that exist with zero setup and
 * cannot be deleted. Expected memberships are derived from FIXTURE_JOBS with
 * inline predicates, never by calling the function under test, and never as
 * hardcoded totals (the counts moved the day a Closed fixture was added, and a
 * literal would have failed as though the code broke rather than the data
 * grew).
 */
import { describe, expect, it } from "vitest";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { applyFilter } from "@/lib/grid/filter";
import {
  GRID_PRESETS,
  PERSONA_PRESETS,
  WORKING_SETS,
  isWorkingSet,
  rowsForSet,
} from "@/lib/grid/presets";
import { serializeGridState } from "@/lib/grid/url-state";

/** The instant the fixtures are dated against — matches fixtures.FIXTURE_NOW. */
const FIXTURE_NOW = Date.parse("2026-07-21T15:00:00.000Z");

const keys = (rows: { key: string }[]) => rows.map((r) => r.key).sort();

describe("built-in presets", () => {
  it("every working set has exactly one preset, in switcher order", () => {
    // The names are what the switcher renders and what the e2e clicks by
    // role+name — a renamed preset must fail HERE, not flake in Playwright.
    expect(GRID_PRESETS.map((p) => p.set)).toEqual([...WORKING_SETS]);
    expect(GRID_PRESETS.map((p) => p.name)).toEqual([
      "Queue",
      "All postings",
      "Snoozed",
      "Dismissed",
      "Needs review",
    ]);
  });

  it("isWorkingSet accepts every set and rejects everything else", () => {
    for (const s of WORKING_SETS) expect(isWorkingSet(s)).toBe(true);
    expect(isWorkingSet("garbage")).toBe(false);
    expect(isWorkingSet("")).toBe(false);
    expect(isWorkingSet("Queue")).toBe(false); // sets are lowercase URL tokens
  });

  it("Queue is the H16 predicate: qualified, undecided, and still on the board", () => {
    const expected = FIXTURE_JOBS.filter(
      (j) =>
        j.disposition === "qualified" &&
        j.triage === "" &&
        (j.status ?? "").trim().toLowerCase() !== "closed",
    );
    expect(keys(rowsForSet(FIXTURE_JOBS, "queue"))).toEqual(keys(expected));

    // The Closed clause must have a fixture to fail on, or it is decorative.
    const closed = FIXTURE_JOBS.find(
      (j) =>
        (j.status ?? "").trim().toLowerCase() === "closed" &&
        j.disposition === "qualified" &&
        j.triage === "",
    );
    expect(closed, "no qualified-but-Closed fixture — criterion 16 untestable").toBeDefined();
    expect(rowsForSet(FIXTURE_JOBS, "queue").some((j) => j.key === closed!.key)).toBe(false);
  });

  it("All postings is the input, untouched — never a third secretly-different list", () => {
    expect(rowsForSet(FIXTURE_JOBS, "all")).toEqual(FIXTURE_JOBS);
  });

  it("Snoozed is exactly the snoozed rows", () => {
    const expected = FIXTURE_JOBS.filter((j) => j.triage === "snoozed");
    expect(expected.length).toBeGreaterThan(0);
    expect(keys(rowsForSet(FIXTURE_JOBS, "snoozed"))).toEqual(keys(expected));
  });

  it("Dismissed is exactly the dismissed rows", () => {
    const expected = FIXTURE_JOBS.filter((j) => j.triage === "dismissed");
    expect(expected.length).toBeGreaterThan(0);
    expect(keys(rowsForSet(FIXTURE_JOBS, "dismissed"))).toEqual(keys(expected));
  });

  it("Needs review is exactly the needs-info rows", () => {
    const expected = FIXTURE_JOBS.filter((j) => j.disposition === "needs-info");
    expect(expected.length).toBeGreaterThan(0);
    expect(keys(rowsForSet(FIXTURE_JOBS, "needs-review"))).toEqual(keys(expected));
  });
});

describe("persona seeds (spec D)", () => {
  it("carries the owner's and Dad's display prefs verbatim", () => {
    const owner = PERSONA_PRESETS.find((p) => p.id === "owner");
    const dad = PERSONA_PRESETS.find((p) => p.id === "dad");
    expect(owner?.display).toEqual({ density: "dense", typeScale: "default", hints: true });
    expect(dad?.display).toEqual({ density: "comfortable", typeScale: "large", hints: false });
  });

  it("the roommate seed is last-7-days grouped by company, and the window is real", () => {
    const rm = PERSONA_PRESETS.find((p) => p.id === "roommate");
    expect(rm).toBeDefined();
    expect(serializeGridState(rm!.nav)).toBe("f=firstSeen.inlast.7&group=company");

    // Against the pinned clock: the clause admits exactly the rows first seen
    // inside the window, boundary day included (ISO days compare lexically).
    const cutoff = new Date(FIXTURE_NOW - 7 * 86_400_000).toISOString().slice(0, 10);
    const universe = rowsForSet(FIXTURE_JOBS, rm!.nav.set);
    const expected = universe.filter((j) => j.firstSeen !== null && j.firstSeen >= cutoff);
    const got = applyFilter(universe, rm!.nav.filter, FIXTURE_NOW);
    expect(got.length).toBeGreaterThan(0);
    expect(keys(got)).toEqual(keys(expected));
  });
});
