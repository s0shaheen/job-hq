// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import type { ChargeRateBoundResult } from "@/lib/data/source";
import { METERS, rateBoundMessage } from "@/lib/limits/bounds";

/**
 * `POST /api/export` and its per-user bound (#261).
 *
 * WHY THIS ROUTE IS IN THE FIRST SET AT ALL, since nothing here is outbound and
 * nothing is vendor-billed. It is the cheapest amplification in the product and
 * it had NO bound of any kind — not a payload cap, not a rate. A ~100-byte POST
 * regenerates the caller's whole dataset: up to 999 rows through
 * `queue({ limit: 999 })`, and for `xlsx` through a zip writer, on a serverless
 * function, as often as it is asked. Auth and entitlement both answer "may you"
 * and neither answers "how often".
 *
 * (#261's own issue text credits this route with a payload bound. It does not
 * have one — measured here, and the reason `export.build` joined the NOW set
 * after the design was first written down.)
 *
 * Node environment for `import-upload-route.test.ts`'s reason: jsdom's `Request`
 * is not the one the handler parses.
 */

vi.mock("server-only", () => ({}));

const { chargeRef, sourceRef, readsRef } = vi.hoisted(() => ({
  chargeRef: { current: { ok: true } as ChargeRateBoundResult },
  sourceRef: { current: null as unknown },
  /** How many times the route asked the store for rows. THE work being bounded. */
  readsRef: { current: 0 },
}));

// `hasSession()` short-circuits to true when there is no Supabase env, so the
// route never reaches GoTrue and no auth mock is needed.
vi.mock("@/lib/env", () => ({ getSupabaseEnv: () => null }));

// The entitlement refusal has its own owner (`entitlement-gate.test.ts`); here it
// passes so every case exercises the bound it was written for.
vi.mock("@/lib/auth/api-guard", () => ({
  refuseUnlessEntitled: async () => null,
  entitlementRefusal: () => null,
}));

vi.mock("@/lib/data/get-source", () => ({
  getDataSource: async () => sourceRef.current,
}));

const { POST } = await import("@/app/api/export/route");

function exportRequest(): Request {
  return new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataset: "jobs", format: "csv", scope: "all" }),
  });
}

beforeEach(() => {
  const source = new FixtureDataSource();
  // The bound is the only thing under test, so it is the only thing overridden.
  source.chargeRateBound = async () => chargeRef.current;
  // COUNTING THE WORK, not the response. A refusal that arrives after the file
  // was built looks identical from outside — same status, same body — and the
  // whole point of a reservation is that it lands BEFORE the cost. `jobs()` is
  // the route's first read for `scope: "all"`, so it is the observation that
  // separates the two.
  const realJobs = source.jobs.bind(source);
  source.jobs = async () => {
    readsRef.current += 1;
    return realJobs();
  };
  sourceRef.current = source;
  chargeRef.current = { ok: true };
  readsRef.current = 0;
});

describe("the export route charges a per-user bound before it reads a row", () => {
  it("builds the file when the bound allows", async () => {
    const res = await POST(exportRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment/);
    // The population assertion: without it, the "reads nothing" cases below pass
    // against a route that reads nothing ever.
    expect(Number(res.headers.get("X-HQ-Rows"))).toBeGreaterThan(0);
    expect(readsRef.current).toBe(1);
  });

  it("answers 429 with the meter's sentence and BUILDS NOTHING", async () => {
    // MUTATION: move the charge below `build(...)` -> `reads` becomes 1. The
    // response is byte-identical either way, which is why the assertion has to
    // be on the work rather than on the status: a reservation taken after the
    // cost has already been paid is not a reservation.
    chargeRef.current = {
      ok: false,
      kind: "rate-limited",
      message: rateBoundMessage(METERS.exportBuild),
    };
    const res = await POST(exportRequest());
    expect(res.status).toBe(429);
    expect((await res.json()) as { error?: string }).toEqual({
      error: rateBoundMessage(METERS.exportBuild),
    });
    expect(readsRef.current).toBe(0);
  });

  it("refuses rather than exports when the meter cannot be evaluated", async () => {
    // FAIL LOUD. A meter we could not reach is not permission to spend the
    // capacity it was bounding — and 503 rather than 429, because "try again in
    // a few minutes" would be a guess about a fault, not a bound.
    chargeRef.current = {
      ok: false,
      kind: "error",
      message: "Couldn't check your usage limit right now.",
    };
    const res = await POST(exportRequest());
    expect(res.status).toBe(503);
    expect(readsRef.current).toBe(0);
  });

  it("reports an expired session as 401, not as a bound", async () => {
    chargeRef.current = { ok: false, kind: "auth" };
    const res = await POST(exportRequest());
    expect(res.status).toBe(401);
    expect(readsRef.current).toBe(0);
  });
});
