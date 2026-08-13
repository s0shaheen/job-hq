// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The data boundary, DRIVEN — one case per identity state (#196).
 *
 * `entitlement-default-deny.test.ts` proves the gate is textually present in
 * `get-source.ts`; `entitlement.test.ts` proves the read parses; and
 * `entitlement-gate.test.ts` proves where middleware ROUTES each state. None of
 * them ever calls `getDataSource()` and watches it refuse. This file does — it
 * is the behavioural half of #196's denial matrix for the two layers that fail
 * CLOSED, `getDataSource()` and the api-guard, with the mocked store answering
 * the exact shapes PostgREST answers. The database layer's half of the same
 * matrix lives in `tests/db/test_default_deny.py`.
 *
 * The states, named as the matrix names them:
 *
 *   anonymous / expired — a request with no claims. Middleware now passes a
 *       claims-less POST through (#196's session-expiry rule), so THIS layer is
 *       what stands behind that pass-through and it must throw.
 *   pending / suspended — a row that says so. Includes the operator suspending
 *       an account mid-session: `getDataSource()` re-reads the entitlement on
 *       every resolve, so the next data request after `hq_suspend_user` takes
 *       the suspended branch below without waiting for sign-out.
 *   unknown (absent row) — `maybeSingle()` answered no row. Also the app-layer
 *       shape of a REMOVED account's stale session: the cascade deleted the
 *       entitlement row, the JWT may still verify. Absence is never permission.
 *   unknown (unreadable) — the read itself failed. Middleware fails OPEN on
 *       this signal by decision #223; these two layers are the reason that
 *       decision is survivable, so their fail-CLOSED here is the condition the
 *       decision was granted on.
 *   active — the positive control, or every refusal above is equally proved by
 *       a broken mock.
 *
 * MUTATION TARGETS:
 *   * drop the `read.kind !== "ok"` throw in get-source     -> the unreadable case;
 *   * drop the `!isActive(...)` throw                        -> pending and suspended;
 *   * make `refuseUnlessEntitled` return null on non-ok      -> the api-guard
 *     unreadable case;
 *   * read the status from the row without the active check  -> the absent-row case.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("@/lib/env", () => ({
  getSupabaseEnv: () => ({ url: "https://x.supabase.co", anonKey: "anon-key" }),
}));

const state = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  answer: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: state.claims } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => state.answer }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { entitlementRefusal, refuseUnlessEntitled } from "@/lib/auth/api-guard";
import { NotEntitledError } from "@/lib/auth/entitlement";
import { getDataSource } from "@/lib/data/get-source";

function row(status: string) {
  return { data: { status, invited: false, plan: "free", activated_at: null }, error: null };
}

/** The two closed layers, asked the same question in one breath. */
async function refusals() {
  const thrown = await getDataSource().then(
    () => null,
    (err: unknown) => err,
  );
  const guard = await refuseUnlessEntitled();
  return { thrown, guard };
}

beforeEach(() => {
  state.claims = { sub: "user-1", email: "someone@example.com" };
  state.answer = row("active");
});

describe("getDataSource() — the choke point, per identity state", () => {
  it("refuses a request with no claims at all (anonymous, or a session that expired mid-gesture)", async () => {
    // Middleware no longer 307s this POST; it lands here, and here must throw.
    state.claims = null;
    await expect(getDataSource()).rejects.toMatchObject({
      name: "NotEntitledError",
      status: "pending",
    });
  });

  it("refuses a pending account", async () => {
    state.answer = row("pending");
    await expect(getDataSource()).rejects.toMatchObject({
      name: "NotEntitledError",
      status: "pending",
    });
  });

  it("refuses a suspended account on its very next data request", async () => {
    // The entitlement is re-read on EVERY resolve, so `hq_suspend_user` while a
    // browser session is mid-journey takes effect on the next gesture — no
    // sign-out required (#196's suspension criterion, app-layer half; the
    // store-layer half is tests/db/test_default_deny.py's suspended state).
    state.answer = row("suspended");
    await expect(getDataSource()).rejects.toMatchObject({
      name: "NotEntitledError",
      status: "suspended",
    });
  });

  it("refuses a session whose entitlement row is ABSENT — absence is never permission", async () => {
    // A signup whose entitlement insert failed, or a REMOVED account's stale
    // session after the ON DELETE CASCADE took the row. The claims may verify;
    // the row does not exist; nothing may execute.
    state.answer = { data: null, error: null };
    await expect(getDataSource()).rejects.toMatchObject({
      name: "NotEntitledError",
      status: "pending",
    });
  });

  it("refuses a session whose entitlement row is UNREADABLE — closed here, open in middleware, by decision (#223)", async () => {
    // The condition the #223 fail-open decision was granted on: when the read
    // errors, middleware waves the request through and THIS throw is the deny.
    state.answer = { data: null, error: { message: "connection reset" } };
    await expect(getDataSource()).rejects.toMatchObject({
      name: "NotEntitledError",
      status: "pending",
    });
  });

  it("resolves a real source for an active account (the positive control)", async () => {
    const src = await getDataSource();
    expect(typeof src.queue).toBe("function");
    expect(typeof src.setTriage).toBe("function");
  });
});

describe("the api-guard — the same states, as HTTP answers", () => {
  it("answers 403 for every non-active state, naming the right one", async () => {
    for (const [answer, message] of [
      [row("pending"), /not active yet/i],
      [row("suspended"), /suspended/i],
      [{ data: null, error: null }, /not active yet/i], // absent row
    ] as const) {
      state.answer = answer;
      const { guard } = await refusals();
      expect(guard?.status).toBe(403);
      expect(((await guard?.json()) as { error: string }).error).toMatch(message);
    }
  });

  it("fails closed on an unreadable row and on a claims-less request", async () => {
    state.answer = { data: null, error: { message: "connection reset" } };
    expect((await refuseUnlessEntitled())?.status).toBe(403);

    state.claims = null;
    state.answer = row("active"); // even a readable active row is not reachable without claims
    expect((await refuseUnlessEntitled())?.status).toBe(403);
  });

  it("lets an active account through, and maps the data layer's throw to a 403", async () => {
    expect(await refuseUnlessEntitled()).toBeNull();

    // The other half of the guard: a route that reached getDataSource() and
    // caught its refusal turns it into a 403, and only that error.
    const refused = entitlementRefusal(new NotEntitledError("suspended"));
    expect(refused?.status).toBe(403);
    expect(entitlementRefusal(new Error("boom"))).toBeNull();
  });
});
