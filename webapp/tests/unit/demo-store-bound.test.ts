// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * WHICH demo store the bound drops (issue #311).
 *
 * `getDataSource()` holds one fixture store per `hq_demo_id`, capped so a
 * long-lived demo deployment cannot grow without limit. The cap is not in
 * question here; the choice of victim is. It used to be
 * `stores.keys().next().value` — and a `Map` iterates in INSERTION order, which
 * `get` does not disturb, so the store dropped was the one created longest ago
 * whether or not somebody was in the middle of using it. A demo visitor who
 * started an import before fifty other people arrived had their batch deleted
 * mid-wizard, and the wizard told them it had never been theirs.
 *
 * It is not a property a browser test can pin. Reaching it through the UI takes
 * fifty-odd unrelated sessions arriving inside one person's journey, which is
 * exactly why the e2e suite only saw it as an intermittent failure in
 * `import-wizard.spec.ts` and read it as an environment quirk for weeks.
 *
 * MUTATION TARGETS:
 *   * evict `keys().next()` without the re-insert on hit -> the in-use case;
 *   * drop the `touched` check                           -> the in-flight case;
 *   * drop the eviction entirely                         -> the idle case, which
 *                                                           is the bound itself.
 */

const jar = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));
vi.mock("@/lib/env", () => ({ getSupabaseEnv: () => null }));

import type { DataSource } from "@/lib/data/source";
import { getDataSource } from "@/lib/data/get-source";

/** Resolve the store one `hq_demo_id` gets, exactly as a request would. */
async function store(id: string): Promise<DataSource> {
  jar.set("hq_demo_id", id);
  return getDataSource();
}

const IN_FLIGHT_MS = 60_000;

beforeEach(() => {
  jar.clear();
  vi.unstubAllEnvs();
  vi.stubEnv("HQ_DEMO", "1");
  vi.stubEnv("NEXT_PUBLIC_HQ_DEMO", "");
  // The map is process-wide on purpose (page, action and route bundles share
  // it), so each case starts from an empty one rather than inheriting the last.
  (globalThis as { __hqDemoSessions?: Map<string, unknown> }).__hqDemoSessions?.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the demo store bound", () => {
  it("keeps the store a session is still using, however many others arrive", async () => {
    const mine = await store("mine");
    for (let i = 0; i < 200; i += 1) {
      // Two hundred other sessions, four times the cap, one every 100ms — and a
      // request of my own every second, which is a longer gap than the journey
      // that lost its batch had.
      vi.advanceTimersByTime(100);
      await store(`other-${i}`);
      if (i % 10 === 0) expect(await store("mine")).toBe(mine);
    }
    expect(await store("mine")).toBe(mine);
  });

  it("keeps a session that has said nothing for less than a minute", async () => {
    const mine = await store("mine");
    vi.advanceTimersByTime(IN_FLIGHT_MS - 1_000);
    for (let i = 0; i < 200; i += 1) await store(`other-${i}`);
    expect(await store("mine")).toBe(mine);
  });

  it("trims back to the bound once the sessions have gone quiet", async () => {
    // Sixty-one sessions at once. Nothing is dropped while they are all live —
    // that is the previous case — so the map is over its cap on purpose.
    const idle = await store("idle");
    for (let i = 0; i < 60; i += 1) await store(`other-${i}`);
    const held = (globalThis as { __hqDemoSessions?: Map<string, unknown> }).__hqDemoSessions!;
    expect(held.size).toBe(61);

    // A minute later they have all stopped asking for anything, and the next
    // arrival collects them.
    vi.advanceTimersByTime(IN_FLIGHT_MS + 1_000);
    await store("newcomer");
    expect(held.size).toBeLessThanOrEqual(51);
    expect(await store("idle")).not.toBe(idle);
  });

  it("drops the IDLEST rather than the oldest — the whole of #311", async () => {
    const first = await store("first");
    const second = await store("second");
    // `first` is the older session and `second` the quieter one. Under the
    // insertion-order eviction this file exists for, `first` was the victim.
    for (let i = 0; i < 60; i += 1) {
      vi.advanceTimersByTime(2_000);
      await store(`other-${i}`);
      await store("first");
    }
    expect(await store("first")).toBe(first);
    expect(await store("second")).not.toBe(second);
  });
});
