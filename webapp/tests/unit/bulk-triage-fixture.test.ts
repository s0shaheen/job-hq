import { describe, expect, it } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import { FIXTURE_APPLICATIONS, FIXTURE_JOBS } from "@/lib/data/fixtures";
import type { BulkTriageInput } from "@/lib/data/source";

/**
 * The fixture's bulk path must be atomic exactly as the SQL is.
 *
 * tests/db/test_bulk_triage.py proves app_set_triage_bulk applies the whole
 * selection or none of it. If the fixture applied greedily and stopped at the
 * conflict, the demo and the E2E suite would show a half-applied batch the
 * database can never produce — the too-forgiving fake, at the one place
 * atomicity is the whole point.
 */

// Undecided AND without an existing application, so bulk-interested genuinely
// creates a Queued row for each: Ramp and Plaid are qualified/untriaged but
// already carry applications (Queued, and Applied), and interested must never
// duplicate one — that guard is correct, so the test picks clean keys rather
// than assert against it.
const HAS_APP = new Set(FIXTURE_APPLICATIONS.map((a) => a.postingKey).filter(Boolean));
function undecided(n: number): string[] {
  return FIXTURE_JOBS.filter(
    (j) => j.triage === "" && j.disposition === "qualified" && !HAS_APP.has(j.key),
  )
    .slice(0, n)
    .map((j) => j.key);
}

function bulk(over: Partial<BulkTriageInput>): BulkTriageInput {
  const keys = over.postingKeys ?? undecided(3);
  return {
    postingKeys: keys,
    triage: "dismissed",
    idempotencyKey: crypto.randomUUID(),
    expectedUpdatedAt: keys.map(() => null),
    ...over,
  };
}

describe("happy path", () => {
  it("triages the whole selection in one call", async () => {
    const src = new FixtureDataSource();
    const keys = undecided(3);
    const res = await src.setTriageBulk(bulk({ postingKeys: keys, triage: "dismissed" }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.jobs.map((j) => j.triage)).toEqual(["dismissed", "dismissed", "dismissed"]);
  });

  it("creates one application per interested row", async () => {
    const src = new FixtureDataSource();
    const keys = undecided(3);
    await src.setTriageBulk(bulk({ postingKeys: keys, triage: "interested" }));
    const apps = await src.applications();
    for (const k of keys) expect(apps.some((a) => a.postingKey === k && a.status === "Queued")).toBe(true);
  });
});

describe("atomicity", () => {
  it("applies NONE of the batch when one row conflicts", async () => {
    const src = new FixtureDataSource();
    const keys = undecided(3);

    // Move the last row so its expected version is stale.
    const moved = await src.setTriage({
      postingKey: keys[2],
      triage: "interested",
      idempotencyKey: crypto.randomUUID(),
      expectedUpdatedAt: null,
    });
    if (!moved.ok) throw new Error("setup failed");

    // Read fresh versions, then hand the batch a STALE one for the moved row.
    const jobs = await src.jobs();
    const expected = keys.map((k) => {
      if (k === keys[2]) return "1970-01-01T00:00:00.000Z"; // deliberately stale
      return jobs.find((j) => j.key === k)!.updatedAt;
    });

    const res = await src.setTriageBulk(bulk({ postingKeys: keys, triage: "dismissed", expectedUpdatedAt: expected }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("conflict");

    // The first two rows were reachable in the loop but must be untouched.
    const after = await src.jobs();
    for (const k of keys.slice(0, 2)) {
      expect(after.find((j) => j.key === k)!.triage).toBe("");
    }
  });

  it("applies none when a key does not exist", async () => {
    const src = new FixtureDataSource();
    const keys = undecided(2);
    const res = await src.setTriageBulk(
      bulk({ postingKeys: [...keys, "greenhouse-nope"], triage: "dismissed" }),
    );
    expect(res.ok).toBe(false);
    const after = await src.jobs();
    for (const k of keys) expect(after.find((j) => j.key === k)!.triage).toBe("");
  });
});

describe("validation and idempotency", () => {
  it("refuses an empty selection", async () => {
    const src = new FixtureDataSource();
    const res = await src.setTriageBulk(bulk({ postingKeys: [] }));
    expect(res.ok).toBe(false);
  });

  it("replays a batch key rather than applying twice", async () => {
    const src = new FixtureDataSource();
    const keys = undecided(3);
    const idem = crypto.randomUUID();
    const first = await src.setTriageBulk(bulk({ postingKeys: keys, triage: "interested", idempotencyKey: idem }));
    const again = await src.setTriageBulk(bulk({ postingKeys: keys, triage: "interested", idempotencyKey: idem }));
    expect(again).toEqual(first);
    expect((await src.applications()).filter((a) => keys.includes(a.postingKey ?? "")).length).toBe(3);
  });
});
