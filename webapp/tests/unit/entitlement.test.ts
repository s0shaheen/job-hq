import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  demoEntitlement,
  ENTITLEMENT_COLS,
  isActive,
  isNotEntitled,
  NotEntitledError,
  NOT_ENTITLED,
  parseEntitlement,
  readEntitlement,
  refusedStatus,
} from "@/lib/auth/entitlement";

/**
 * The entitlement decision, on its own.
 *
 * Everything the gate does reduces to two questions — "what did the store say"
 * and "does that mean active" — and both are pure. Pinning them here means the
 * route gate and the data layer can be tested for their ROUTING and their
 * REFUSAL without also re-testing the parse in two more places.
 *
 * The fake answers the three shapes PostgREST actually answers, which is the
 * property that makes it worth anything: a row, NO row (`data: null, error:
 * null` — what `maybeSingle()` returns when RLS filtered everything out, and the
 * exact shape a pending or missing account produces), and an error object.
 * A fake that only knew the first shape would let the whole "absence is not
 * permission" rule ship untested.
 */

type Answer = { data: unknown; error: unknown };

function reader(answer: Answer | (() => never)): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (typeof answer === "function" ? answer() : answer),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const ACTIVE_ROW = {
  status: "active",
  invited: true,
  plan: "free",
  activated_at: "2026-07-01T00:00:00Z",
};

describe("parseEntitlement", () => {
  it("maps a row the way 0027 writes one", () => {
    expect(parseEntitlement(ACTIVE_ROW)).toEqual({
      status: "active",
      invited: true,
      plan: "free",
      activatedAt: "2026-07-01T00:00:00Z",
    });
  });

  it("reads an unknown status as pending, never as active", () => {
    // A status this app does not know about is a status it cannot reason about.
    // Falling to `active` would mean a future value — a billing state, a typo in
    // a hand-run UPDATE — silently opens the product.
    for (const status of ["", "trialing", "ACTIVE", null, 7, undefined]) {
      expect(parseEntitlement({ ...ACTIVE_ROW, status }).status, String(status)).toBe(
        "pending",
      );
    }
  });

  it("reads a non-row as not entitled", () => {
    for (const row of [null, undefined, "active", 1]) {
      expect(parseEntitlement(row)).toEqual(NOT_ENTITLED);
    }
  });

  it("defaults plan to free rather than to empty", () => {
    // `plan` is the billing seam and never a gate input, but a blank one reaching
    // a future price check as "" is a different bug than reaching it as "free".
    expect(parseEntitlement({ ...ACTIVE_ROW, plan: "" }).plan).toBe("free");
    expect(parseEntitlement({ ...ACTIVE_ROW, plan: "pro" }).plan).toBe("pro");
  });
});

describe("isActive", () => {
  it("is true for active and false for everything else", () => {
    expect(isActive({ ...NOT_ENTITLED, status: "active" })).toBe(true);
    expect(isActive({ ...NOT_ENTITLED, status: "pending" })).toBe(false);
    expect(isActive({ ...NOT_ENTITLED, status: "suspended" })).toBe(false);
  });
});

describe("readEntitlement", () => {
  it("asks for the columns 0027 creates, on the caller's own row", async () => {
    // The select list and the scope are the two things a silent typo breaks:
    // a wrong column name answers `undefined` (→ pending, a lockout), and a
    // missing `.eq` leans entirely on RLS.
    const calls: string[] = [];
    const spy = {
      from: (t: string) => {
        calls.push(`from:${t}`);
        return {
          select: (c: string) => {
            calls.push(`select:${c}`);
            return {
              eq: (col: string, v: string) => {
                calls.push(`eq:${col}=${v}`);
                return { maybeSingle: async () => ({ data: ACTIVE_ROW, error: null }) };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;

    await readEntitlement(spy, "user-1");
    expect(calls).toEqual([
      "from:entitlements",
      `select:${ENTITLEMENT_COLS}`,
      "eq:user_id=user-1",
    ]);
  });

  it("answers ok/active for a live row", async () => {
    const read = await readEntitlement(reader({ data: ACTIVE_ROW, error: null }), "u");
    expect(read).toEqual({
      kind: "ok",
      entitlement: {
        status: "active",
        invited: true,
        plan: "free",
        activatedAt: "2026-07-01T00:00:00Z",
      },
    });
  });

  it("treats NO ROW as a definitive pending, not as a store failure", async () => {
    // The distinction is the whole reason `EntitlementRead` has three outcomes.
    // Reported as `unreadable`, this would make the route gate (which fails OPEN
    // on that signal) wave a genuinely un-activated account through to the app.
    //
    // KILLED BY: `maybeSingle()` → `single()`, which turns zero rows into an
    // error, or by mapping `!data` onto the `unreadable` branch.
    const read = await readEntitlement(reader({ data: null, error: null }), "u");
    expect(read).toEqual({ kind: "ok", entitlement: NOT_ENTITLED });
  });

  it("reports a query error as unreadable, and never as a status", async () => {
    // KILLED BY: swallowing `error` and returning `NOT_ENTITLED` — the data layer
    // would still refuse, but the route gate would start bouncing every signed-in
    // user to the holding page during any Supabase blip.
    const read = await readEntitlement(
      reader({ data: null, error: { message: "connection reset" } }),
      "u",
    );
    expect(read).toEqual({ kind: "unreadable", message: "connection reset" });
  });

  it("reports a THROWN client error as unreadable rather than propagating it", async () => {
    // Middleware has no error boundary; an exception out of here is a 500 on
    // every route in the app, including the holding page.
    const read = await readEntitlement(
      reader(() => {
        throw new Error("fetch failed");
      }),
      "u",
    );
    expect(read).toEqual({ kind: "unreadable", message: "fetch failed" });
  });

  it("answers not-entitled for a session with no subject, without querying", async () => {
    let queried = false;
    const spy = {
      from: () => {
        queried = true;
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      },
    } as unknown as SupabaseClient;

    expect(await readEntitlement(spy, "")).toEqual({ kind: "ok", entitlement: NOT_ENTITLED });
    expect(queried).toBe(false);
  });
});

describe("the refusal", () => {
  it("carries the status so the surface can say which one it is", () => {
    expect(new NotEntitledError("suspended").status).toBe("suspended");
    expect(refusedStatus(new NotEntitledError("suspended"))).toBe("suspended");
    expect(refusedStatus(new NotEntitledError("pending"))).toBe("pending");
    // Anything else is pending, so an unrelated error can never be read as a
    // suspension notice.
    expect(refusedStatus(new Error("nope"))).toBe("pending");
  });

  it("is recognised across bundle boundaries, where instanceof is not", () => {
    // Next compiles pages, actions and route handlers into separate server
    // bundles, each with its OWN copy of the class object. This reproduces that:
    // a structurally identical error from a "second copy" of the module.
    //
    // KILLED BY: `isNotEntitled` using `err instanceof NotEntitledError` — the
    // second-bundle case goes false, the layout guard silently stops firing, and
    // a pending account gets the whole app shell.
    class OtherBundleCopy extends Error {
      constructor() {
        super("This account is not active yet.");
        this.name = "NotEntitledError";
      }
    }
    const fromOtherBundle = new OtherBundleCopy();

    expect(fromOtherBundle instanceof NotEntitledError).toBe(false);
    expect(isNotEntitled(fromOtherBundle)).toBe(true);
    expect(isNotEntitled(new NotEntitledError("pending"))).toBe(true);
  });

  it("does not claim unrelated errors", () => {
    for (const other of [null, undefined, new Error("boom"), { name: "TypeError" }, "x"]) {
      expect(isNotEntitled(other)).toBe(false);
    }
  });
});

describe("the demo seam", () => {
  it("is active by default and on any value it does not recognise", () => {
    // `parseSeed`'s rule: a typo in a seam cookie must not blank the demo. This
    // is the ONE place the default runs the opposite way from `NOT_ENTITLED`,
    // and it decides nobody's real access.
    for (const value of [undefined, "", "active", "nonsense", "PENDING"]) {
      expect(demoEntitlement(value).status, String(value)).toBe("active");
    }
  });

  it("produces the two blocked states the E2E suite drives", () => {
    expect(demoEntitlement("pending").status).toBe("pending");
    expect(demoEntitlement("suspended").status).toBe("suspended");
  });
});
