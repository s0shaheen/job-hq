// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The read-failure seam's two safety properties (`hq_demo_fail_read`).
 *
 * The seam exists so `app/error.tsx` is reachable at all — no fixture state
 * could make a server read fail, so the app-level error boundary had never
 * rendered in any test on any surface. A seam that makes failure reachable is
 * also a new way to make `getDataSource()` throw, and the two things that must
 * stay true about it cannot be proven from a browser:
 *
 *   1. ORDER. The seam throws AFTER the entitlement gate. A pending session
 *      with the cookie set is refused with `NotEntitledError`, never errored —
 *      an E2E cannot see this, because the middleware redirect answers the
 *      browser before `getDataSource()` ever runs for a refused account.
 *      `tests/e2e/error.spec.ts` proves the journey; this proves the layer.
 *   2. SCOPE. The cookie is read inside `isDemoMode()` only. A deployment that
 *      is merely unconfigured must not let a visitor error its pages by
 *      setting a cookie — the same rule every sibling seam already keeps.
 *
 * MUTATION TARGETS:
 *   * move the `failRead` throw above the entitlement gate -> the ordering case;
 *   * read the cookie outside the `isDemoMode()` branch    -> the scope case;
 *   * drop the throw entirely                              -> the armed case, and with
 *                                                             it the E2E suite's only
 *                                                             way into `app/error.tsx`.
 */

const jar = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));
// No Supabase env: outside demo mode the resolve must refuse as unconfigured,
// which is exactly the deployment the scope property protects.
vi.mock("@/lib/env", () => ({ getSupabaseEnv: () => null }));

import { getDataSource, NotConfiguredError } from "@/lib/data/get-source";

async function rejection(): Promise<unknown> {
  try {
    await getDataSource();
  } catch (err) {
    return err;
  }
  return null;
}

beforeEach(() => {
  jar.clear();
  vi.unstubAllEnvs();
  vi.stubEnv("HQ_DEMO", "1");
  vi.stubEnv("NEXT_PUBLIC_HQ_DEMO", "");
});

describe("the hq_demo_fail_read seam", () => {
  it("throws after the entitlement gate: a pending session is refused, not errored", async () => {
    jar.set("hq_demo_entitlement", "pending");
    jar.set("hq_demo_fail_read", "1");

    const err = await rejection();
    // Duck-typed on the name, as every consumer of this error is (separate
    // server bundles hold separate class objects — see lib/auth/entitlement.ts).
    expect((err as Error).name).toBe("NotEntitledError");
    expect((err as Error).message).not.toContain("hq_demo_fail_read");
  });

  it("armed on an active session, the resolve throws the seam's own error", async () => {
    jar.set("hq_demo_fail_read", "1");

    const err = await rejection();
    expect((err as Error).message).toContain("hq_demo_fail_read");
    expect((err as Error).name).not.toBe("NotEntitledError");
  });

  it("unarmed, the resolve answers with a store", async () => {
    await expect(getDataSource()).resolves.toBeTruthy();
  });

  it("outside demo mode the cookie is ignored entirely", async () => {
    vi.stubEnv("HQ_DEMO", "");
    jar.set("hq_demo_fail_read", "1");

    // The unconfigured refusal, not the seam's error: the cookie was never
    // read. If the seam leaked outside `isDemoMode()`, the message would name
    // hq_demo_fail_read and this would fail on both assertions.
    const err = await rejection();
    expect(err).toBeInstanceOf(NotConfiguredError);
    expect((err as Error).message).not.toContain("hq_demo_fail_read");
  });
});
