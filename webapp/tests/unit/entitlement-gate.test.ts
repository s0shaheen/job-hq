import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ROUTE gate: where a signed-in account that is not turned on ends up.
 *
 * `entitlement.test.ts` pins the decision; this pins what the middleware does
 * with it. The two halves were split because the bug this whole branch exists to
 * prevent is a routing bug — a surface reachable by somebody the store says is
 * not entitled — and a test that only checked the predicate would have been
 * green the whole time.
 *
 * MUTATION TARGETS:
 *   * delete the `!isPendingAllowedPath` block          -> every "lands on /pending" case;
 *   * make the allowlist a denylist (block a fixed set) -> the unknown-route case;
 *   * drop `/pending` from the allowlist                -> the no-redirect-loop case;
 *   * fail CLOSED on `unreadable`                       -> the transient-error case;
 *   * drop the demo-mode gate                           -> every demo case, and with it
 *                                                          the E2E suite's only handle
 *                                                          on this code path.
 */

const state = {
  demo: false,
  claims: null as Record<string, unknown> | null,
  answer: { data: null as unknown, error: null as unknown },
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: state.claims } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => state.answer }),
      }),
    }),
  }),
}));
vi.mock("@/lib/data/source", () => ({ isDemoMode: () => state.demo }));
vi.mock("@/lib/env", () => ({
  getSupabaseEnv: () => ({ url: "https://x.supabase.co", anonKey: "anon-key" }),
}));

import { isPendingAllowedPath, updateSession } from "@/lib/supabase/middleware";

/** Every destination a person can reach in this app today, plus one that does not exist yet. */
const APP_ROUTES = [
  "/",
  "/queue",
  "/jobs",
  "/pipeline",
  "/companies",
  "/companies/add",
  "/connections",
  "/health",
  "/import",
  "/import/abc",
  "/add",
  "/apply/12",
  "/settings",
  "/settings/answers",
  "/onboarding/1",
  "/api/export",
  "/api/import/upload",
  "/api/companies/propose",
  "/api/connections/upload",
  // Not a route today. That is the point: the allowlist has to refuse it without
  // anybody having thought about it.
  "/coverage/next-quarters-surface",
];

function request(pathname: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

async function decide(pathname: string, cookie?: string) {
  const res = await updateSession(request(pathname, cookie));
  return { status: res.status, location: res.headers.get("location") };
}

beforeEach(() => {
  state.demo = false;
  state.claims = { sub: "user-1", email: "someone@example.com" };
  state.answer = { data: null, error: null };
});

describe("isPendingAllowedPath — an allowlist, not a denylist", () => {
  it("lets a pending account reach the holding surface and nothing else it owns", () => {
    expect(isPendingAllowedPath("/pending")).toBe(true);
    for (const p of APP_ROUTES) {
      expect(isPendingAllowedPath(p), p).toBe(false);
    }
  });

  it("keeps every already-public path reachable", () => {
    // Signing out has to work FROM the holding page, and the two token endpoints
    // do not read the session at all — gating them on the session's entitlement
    // would break the Gmail script for a reason unrelated to it.
    for (const p of ["/login", "/auth/signout", "/auth/callback", "/setup", "/api/capture", "/d/tok"]) {
      expect(isPendingAllowedPath(p), p).toBe(true);
    }
  });

  it("refuses a route nobody has written yet", () => {
    // The default-deny claim, stated as a test: a surface that does not exist is
    // already blocked, so shipping it does not open a hole by omission.
    for (const p of ["/billing", "/coverage", "/autopilot", "/today", "/pendingish"]) {
      expect(isPendingAllowedPath(p), p).toBe(false);
    }
  });

  it("matches on a slash delimiter, so /pending does not open /pendings", () => {
    expect(isPendingAllowedPath("/pending/why")).toBe(true);
    expect(isPendingAllowedPath("/pendings")).toBe(false);
    expect(isPendingAllowedPath("/pending-review")).toBe(false);
  });
});

describe("a session whose account is not turned on", () => {
  for (const status of ["pending", "suspended"] as const) {
    it(`is sent to /pending from every surface (${status})`, async () => {
      state.answer = { data: { status, invited: false, plan: "free" }, error: null };
      for (const p of APP_ROUTES) {
        const { location, status: code } = await decide(p);
        expect(location, `${p} must land on /pending`).toMatch(/\/pending$/);
        // 307 preserves the method, which matters: a server action POSTs to its
        // own page path, so this is also how an action gesture is refused.
        expect(code, p).toBe(307);
      }
    });
  }

  it("is sent to /pending from /login, not to /queue", async () => {
    // Otherwise the first thing after signing in is a flash of the queue.
    state.answer = { data: { status: "pending" }, error: null };
    expect((await decide("/login")).location).toMatch(/\/pending$/);
  });

  it("reaches the holding surface itself without looping", async () => {
    state.answer = { data: { status: "pending" }, error: null };
    expect((await decide("/pending")).location).toBeNull();
  });

  it("can still sign out", async () => {
    state.answer = { data: { status: "pending" }, error: null };
    expect((await decide("/auth/signout")).location).toBeNull();
  });

  it("is refused when the store has no row for them at all", async () => {
    // A signup whose entitlement insert failed, or an account created by a path
    // that predates 0027. Absence is not permission.
    state.answer = { data: null, error: null };
    expect((await decide("/queue")).location).toMatch(/\/pending$/);
  });
});

describe("an account that IS turned on", () => {
  beforeEach(() => {
    state.answer = { data: { status: "active", invited: true, plan: "free" }, error: null };
  });

  it("reaches every surface untouched", async () => {
    for (const p of APP_ROUTES) {
      expect((await decide(p)).location, p).toBeNull();
    }
  });

  it("still leaves /login for the app's front door", async () => {
    // `/` and not `/queue`: the front door resolves the Landing view
    // preference (`app/page.tsx`). What this pins is that an ACTIVE account
    // leaves the login page for the app rather than for the holding page.
    expect((await decide("/login")).location).toMatch(/localhost\/$/);
  });
});

describe("when the store cannot answer", () => {
  it("lets the request through — the route gate fails OPEN by design", async () => {
    // The refusal that matters happens one layer down, in `getDataSource()`,
    // which fails CLOSED on the same signal. Failing closed HERE would turn a
    // Supabase blip into "every signed-in person is in the holding pen", an
    // outage this product would be inflicting on itself.
    //
    // KILLED BY: treating `unreadable` as blocked in middleware.
    state.answer = { data: null, error: { message: "connection reset" } };
    expect((await decide("/queue")).location).toBeNull();
    expect((await decide("/login")).location).toMatch(/localhost\/$/);
  });
});

describe("a signed-out visitor is unaffected", () => {
  it("still goes to /login, not to /pending", async () => {
    // /pending is not public: a person with no session has nothing to hold.
    state.claims = null;
    expect((await decide("/queue")).location).toMatch(/\/login$/);
    expect((await decide("/pending")).location).toMatch(/\/login$/);
  });
});

describe("demo mode drives the same gate through a cookie", () => {
  beforeEach(() => {
    state.demo = true;
  });

  it("is active with no cookie, so every existing E2E is untouched", async () => {
    for (const p of ["/queue", "/jobs", "/pipeline"]) {
      expect((await decide(p)).location, p).toBeNull();
    }
  });

  it("blocks every surface when the seam cookie says pending", async () => {
    // Without this branch the route gate is unreachable in the only mode the E2E
    // suite runs in, and "a pending user reaches nothing" is a claim with no
    // browser behind it.
    for (const p of APP_ROUTES) {
      const { location } = await decide(p, "hq_demo_entitlement=pending");
      expect(location, p).toMatch(/\/pending$/);
    }
  });

  it("leaves the holding page and sign-out reachable", async () => {
    expect((await decide("/pending", "hq_demo_entitlement=pending")).location).toBeNull();
    expect(
      (await decide("/auth/signout", "hq_demo_entitlement=suspended")).location,
    ).toBeNull();
  });
});
