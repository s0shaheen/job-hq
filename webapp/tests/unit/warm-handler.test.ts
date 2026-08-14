// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureDataSource } from "@/lib/data/fixture-source";
import {
  handleWarmCancel,
  handleWarmPoll,
  handleWarmStart,
} from "@/lib/warm/handler";
import { FakeWarmVendor } from "@/lib/warm/vendor";
import type { WarmVendor } from "@/lib/warm/vendor";

/**
 * The three warm routes, driven through the REAL handlers with a real
 * `FixtureDataSource` and a `FakeWarmVendor` injected via `deps` — the same
 * pattern `capture-route.test.ts` uses for its store. What is under test is the
 * ORCHESTRATION: the reservation-then-run lifecycle, that the vendor `runs` never
 * reach the browser, that the persisted row carries a persona per run (the M1 fix),
 * and that a vendor throw lands a FAILED row rather than a hung spinner.
 *
 * NODE ENVIRONMENT + server-only stub: `handler.ts` is `server-only` and reaches
 * `next/headers` only through the deps we override, so the marker is stubbed the
 * way the capture route stubs it.
 *
 * ENV: the poll route runs the fit pass (`analyzeFit`). We keep this suite offline
 * and deterministic — demo OFF, no Anthropic key — so fit returns the list
 * UNCHANGED (the fail-safe) and the deterministic score order stands. No network.
 */

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.stubEnv("HQ_DEMO", "");
  vi.stubEnv("NEXT_PUBLIC_HQ_DEMO", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

type ResultRow = {
  fullName: string;
  isRecruiter: boolean;
  score: number;
  signals: { kind: string; label: string }[];
};

type ClientSearch = {
  id: string;
  status: string;
  results: ResultRow[];
  error: string;
  runs?: unknown;
  company: string;
};

function startRequest(body: unknown): Request {
  return new Request("http://x/api/warm/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validStart(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetKind: "company",
    postingKey: "",
    company: "Ramp",
    params: {
      role: "Product Manager",
      senior: "Director of Product or above",
      recruiter: "Product recruiter",
    },
    overlays: { schools: [], pastCompanies: [] },
    idempotencyKey: `idem-${Math.random().toString(16).slice(2)}`,
    ...over,
  };
}

// --------------------------------------------------------------- happy lifecycle

describe("start then poll", () => {
  it("results mode: 200 running with the vendor runs STRIPPED, then poll ranks to done", async () => {
    const source = new FixtureDataSource();
    const vendor = new FakeWarmVendor("results");

    const startRes = await handleWarmStart(startRequest(validStart()), { source, vendor });
    expect(startRes.status).toBe(200);
    const started = (await startRes.json()) as ClientSearch;
    expect(started.status).toBe("running");
    // MUTATION: `toClient` stops stripping `runs` -> the vendor handle leaks to the browser.
    expect("runs" in started).toBe(false);
    expect(started.runs).toBeUndefined();

    // The PERSISTED row carries a persona per run — the whole point of vendor_runs
    // (M1). This is server-side state the poll route rebuilds the query from.
    const persisted = await source.getWarmSearch(started.id);
    expect(persisted).not.toBeNull();
    // MUTATION: attach persists a bare run id (no persona) -> length 0 or no persona.
    expect(persisted?.runs).toHaveLength(3);
    expect(persisted?.runs.map((r) => r.persona).sort()).toEqual(["recruiter", "role", "senior"]);

    const pollRes = await handleWarmPoll(started.id, { source, vendor });
    expect(pollRes.status).toBe(200);
    const done = (await pollRes.json()) as ClientSearch;
    // MUTATION: poll fails to complete-and-rank on 'succeeded' -> stays running / empty.
    expect(done.status).toBe("done");
    expect(done.results.length).toBeGreaterThan(0);
    expect("runs" in done).toBe(false);

    // Ranked: with no fit annotation (offline), sortByFit falls through to score-desc.
    // MUTATION: skip the rank -> the raw vendor order leaks through unsorted.
    for (let i = 1; i < done.results.length; i++) {
      expect(done.results[i - 1].score).toBeGreaterThanOrEqual(done.results[i].score);
    }

    // NO candidate is uniformly mislabeled "role" (the M1 failure): the recruiter run
    // produced a recruiter, and the senior run produced a "Senior in your area"
    // signal. If persona were flattened, neither would exist.
    expect(done.results.some((c) => c.isRecruiter)).toBe(true);
    expect(
      done.results.some((c) => c.signals.some((s) => s.label === "Senior in your area")),
    ).toBe(true);
  });
});

// -------------------------------------------------------------------- overlays

describe("start body overlays", () => {
  it("accepts an explicit overlays object and persists it onto the row", async () => {
    const source = new FixtureDataSource();
    const vendor = new FakeWarmVendor("results");
    const res = await handleWarmStart(
      startRequest(validStart({ overlays: { schools: ["Norvale"], pastCompanies: ["Northwind"] } })),
      { source, vendor },
    );
    expect(res.status).toBe(200);
    const started = (await res.json()) as ClientSearch;
    const persisted = await source.getWarmSearch(started.id);
    // MUTATION: parseStart drops overlays -> the school/ex-employer facets never
    // reach the vendor and the fit pass has no background to reason from.
    expect(persisted?.overlays.schools).toEqual(["Norvale"]);
    expect(persisted?.overlays.pastCompanies).toEqual(["Northwind"]);
  });

  it("still works with NO overlays field — the handler defaults them to empty", async () => {
    const source = new FixtureDataSource();
    const vendor = new FakeWarmVendor("results");
    const body = validStart();
    delete body.overlays;
    const res = await handleWarmStart(startRequest(body), { source, vendor });
    // MUTATION: overlays made required -> a legacy client body 400s.
    expect(res.status).toBe(200);
    const started = (await res.json()) as ClientSearch;
    const persisted = await source.getWarmSearch(started.id);
    expect(persisted?.overlays).toEqual({ schools: [], pastCompanies: [] });
  });
});

// --------------------------------------------------------------- start, cancel

describe("start, poll, cancel", () => {
  it("pending stays running; cancel flips to cancelled and is idempotent", async () => {
    const source = new FixtureDataSource();
    const vendor = new FakeWarmVendor("pending");

    const started = (await (
      await handleWarmStart(startRequest(validStart()), { source, vendor })
    ).json()) as ClientSearch;
    expect(started.status).toBe("running");

    // A pending vendor never resolves: the poll must LEAVE the row running.
    const polled = (await (await handleWarmPoll(started.id, { source, vendor })).json()) as ClientSearch;
    expect(polled.status).toBe("running");

    const cancelRes = await handleWarmCancel(started.id, { source, vendor });
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as ClientSearch).status).toBe("cancelled");

    // A second cancel is a no-op that returns the current status — never an error.
    const again = await handleWarmCancel(started.id, { source, vendor });
    // MUTATION: cancel treats an already-terminal row as an error -> 4xx, or "failed".
    expect(again.status).toBe(200);
    expect(((await again.json()) as ClientSearch).status).toBe("cancelled");
  });
});

// -------------------------------------------------------------------- over cap

describe("the daily cap", () => {
  it("returns 429 with a message when the row is armed over-cap before start", async () => {
    const source = new FixtureDataSource();
    source.forceWarmOverCap();

    const res = await handleWarmStart(startRequest(validStart()), {
      source,
      vendor: new FakeWarmVendor("results"),
    });
    // MUTATION: map over-cap to a generic 400/500 -> the UI cannot render the cap state.
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/warm searches for today/i);
  });
});

// ---------------------------------------------------------- vendor start throws

describe("a vendor that throws at start", () => {
  it("charges the row then records it FAILED — not a spinner that never resolves", async () => {
    const source = new FixtureDataSource();
    const throwing: WarmVendor = {
      start: async () => {
        throw new Error("the vendor blew up");
      },
      poll: async () => ({ status: "running", candidates: [] }),
      cancel: async () => {},
    };

    const res = await handleWarmStart(startRequest(validStart()), { source, vendor: throwing });
    // The reservation succeeded (200), but the run failed and the row says so.
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClientSearch;
    // MUTATION: swallow the throw -> status stays "running" forever.
    expect(body.status).toBe("failed");
  });
});

// -------------------------------------------------------------- fail-mode poll

describe("fail mode", () => {
  it("start succeeds running, then poll marks the search failed", async () => {
    const source = new FixtureDataSource();
    const vendor = new FakeWarmVendor("fail");

    const started = (await (
      await handleWarmStart(startRequest(validStart()), { source, vendor })
    ).json()) as ClientSearch;
    expect(started.status).toBe("running");

    const polled = (await (await handleWarmPoll(started.id, { source, vendor })).json()) as ClientSearch;
    // MUTATION: poll ignores the 'failed' vendor status -> stuck running.
    expect(polled.status).toBe("failed");
  });
});

// ------------------------------------------------------------------ not found

describe("poll of a non-existent id", () => {
  it("is a 404, not a 500", async () => {
    const res = await handleWarmPoll("does-not-exist", {
      source: new FixtureDataSource(),
      vendor: new FakeWarmVendor("results"),
    });
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------ start validation

describe("start validation", () => {
  const deps = () => ({ source: new FixtureDataSource(), vendor: new FakeWarmVendor("results") });

  it("400 when the company is missing", async () => {
    const res = await handleWarmStart(startRequest(validStart({ company: "" })), deps());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/company/i);
  });

  it("400 when the idempotency key is missing or blank", async () => {
    for (const key of [undefined, "", "   "]) {
      const res = await handleWarmStart(startRequest(validStart({ idempotencyKey: key })), deps());
      expect(res.status, `key=${JSON.stringify(key)}`).toBe(400);
    }
  });

  it("400 when the body is not JSON", async () => {
    const res = await handleWarmStart(
      new Request("http://x/api/warm/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json{",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/JSON/i);
  });
});
