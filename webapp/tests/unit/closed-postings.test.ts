import { describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_JOBS } from "@/lib/data/fixtures";
import { isQueueRow, rowsForSet } from "@/lib/grid/presets";

/**
 * Acceptance criterion 16: a `Closed` posting is absent from the queue.
 *
 * It lived only inside `SupabaseDataSource.queue()`'s SQL, so nothing else
 * could honour it: `jobs()` returns Closed rows, the fixture source did not
 * filter them at all, and `JobView` carried no status for a client-side
 * predicate to read. The grid — built on the full set — therefore offered
 * delisted roles as decidable work.
 *
 * The rule now lives in the view model and is enforced on every surface. These
 * tests are only meaningful because `FIXTURE_JOBS` contains a Closed row that
 * is otherwise perfectly qualified and untriaged: without it, every assertion
 * below would pass on an implementation that ignores status entirely.
 */

const closed = FIXTURE_JOBS.filter((j) => (j.status ?? "").toLowerCase() === "closed");

describe("the fixture set can falsify this", () => {
  it("contains a Closed posting that would otherwise qualify", () => {
    expect(closed.length).toBeGreaterThan(0);
    for (const j of closed) {
      // If it were filtered or already triaged, the status clause would never
      // be the thing keeping it out, and these tests would prove nothing.
      expect(j.disposition).toBe("qualified");
      expect(j.triage).toBe("");
    }
  });
});

describe("the queue", () => {
  it("omits a Closed posting", async () => {
    const rows = await new FixtureDataSource().queue({ limit: 999 });
    for (const c of closed) {
      expect(rows.map((r) => r.key)).not.toContain(c.key);
    }
  });

  it("still returns the open qualified ones", async () => {
    const rows = await new FixtureDataSource().queue({ limit: 999 });
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("the grid's Queue preset", () => {
  it("omits a Closed posting", () => {
    const keys = rowsForSet(FIXTURE_JOBS, "queue").map((r) => r.key);
    for (const c of closed) expect(keys).not.toContain(c.key);
  });

  it("keeps it in All postings, where the point is to show everything", () => {
    const keys = rowsForSet(FIXTURE_JOBS, "all").map((r) => r.key);
    for (const c of closed) expect(keys).toContain(c.key);
  });

  it("treats a missing status as open, never as closed", () => {
    // `postings.status` mirrors a human-editable cell and is not an enum, so
    // it can be anything or nothing. Hiding work because a field was blank is
    // the worse failure.
    const row = { ...FIXTURE_JOBS[0], status: null };
    expect(isQueueRow(row)).toBe(true);
  });

  it("matches regardless of case or padding", () => {
    for (const v of ["closed", "CLOSED", " Closed "]) {
      expect(isQueueRow({ ...FIXTURE_JOBS[0], status: v })).toBe(false);
    }
  });
});
