// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseDataSource } from "@/lib/data/supabase-source";
import type { DataSource } from "@/lib/data/source";
import { handleWarmStart } from "@/lib/warm/handler";
import { FakeWarmVendor } from "@/lib/warm/vendor";
import {
  envMax,
  isRateBound,
  METERS,
  RATE_BOUND_SQLSTATE,
  rateBoundMessage,
} from "@/lib/limits/bounds";
import { ResolveRateGate } from "@/lib/quickadd/rate";

// `lib/warm/handler.ts` opens with `import "server-only"`, whose whole job is to
// throw outside a Server Component. The repo's standing shim (`read.test.ts`,
// `get-source-seam.test.ts`) — the marker's build-time guarantee is asserted by
// `service-key-containment.test.ts`, not by this file's ability to import it.
vi.mock("server-only", () => ({}));

/**
 * The app half of #261: the durable per-user bounds, as the browser meets them.
 *
 * `tests/db/test_rate_bounds.py` proves the bound HOLDS in the store — that is
 * where a bound has to be proved, because the browser holds the anon key and can
 * reach the RPCs without this process. What only this side can prove is the
 * TRANSLATION: a SQLSTATE the store raises has to arrive at the user as a 429
 * and a sentence, matched on the code and never on message text, or the whole
 * mechanism is a 500 with a database error in it.
 */

/** A PostgREST error as supabase-js hands it over: code, details, hint, message. */
function pgError(code: string, details = "", message = "boom") {
  return { code, details, hint: "", message };
}

/** A Supabase client whose only job is to answer one `.rpc()` a chosen way. */
function clientAnswering(answer: { data?: unknown; error?: unknown }): SupabaseClient {
  return { rpc: async () => answer } as unknown as SupabaseClient;
}

const OPEN_GATE = { allow: () => true } as unknown as ResolveRateGate;

describe("the refusal is matched on the SQLSTATE, never on the message", () => {
  it("recognises HQBND and nothing else", () => {
    expect(RATE_BOUND_SQLSTATE).toBe("HQBND");
    expect(isRateBound(pgError("HQBND"))).toBe(true);
    // MUTATION: match on `message.includes("rate bound")` -> both of these flip,
    // and the refusal becomes a function of copy somebody will reword.
    expect(isRateBound(pgError("HQCAP"))).toBe(false);
    expect(isRateBound(pgError("P0001", "", "rate bound warm.start exceeded"))).toBe(false);
    expect(isRateBound(null)).toBe(false);
  });

  it("is a DIFFERENT code from the warm daily cap, which means something else", () => {
    // `HQCAP` renders "you have used your N warm searches for today", which is
    // false about a burst bound and about an in-flight bound — and the two are
    // not even the same class of limit (#210's open question).
    expect(isRateBound(pgError("HQCAP"))).toBe(false);
  });
});

describe("the sentence the person reads", () => {
  it("comes from the meter, not from the database's own message", () => {
    // The database says "rate bound quickadd.resolve exceeded: 61 of 60 in this
    // window". CLAUDE.md: a refusal says what to do, not what subsystem said no.
    expect(rateBoundMessage(METERS.quickaddResolve)).toMatch(/link checks/i);
    expect(rateBoundMessage(METERS.warmStart)).toMatch(/warm searches/i);
    expect(rateBoundMessage(METERS.warmConcurrent)).toMatch(/already have warm searches running/i);
  });

  it("names no meter, no number and no subsystem", () => {
    for (const meter of Object.values(METERS)) {
      const sentence = rateBoundMessage(meter);
      expect(sentence).not.toContain(meter);
      expect(sentence).not.toMatch(/\d/);
      expect(sentence).not.toMatch(/bound|SQLSTATE|rate_bounds|HQBND/i);
    }
  });

  it("falls back rather than throwing for a meter this map has not learned", () => {
    // A bound added to the catalog before the copy catches up must still refuse
    // the user in plain English. Throwing inside an error path is the failure
    // this cannot afford.
    expect(rateBoundMessage("some.new.meter")).toMatch(/too many requests/i);
    expect(rateBoundMessage(undefined)).toMatch(/too many requests/i);
  });
});

describe("the env override", () => {
  it("is read only when it is a positive integer", () => {
    const key = "HQ_RATE_MAX_QUICKADD_RESOLVE";
    const before = process.env[key];
    try {
      delete process.env[key];
      expect(envMax(METERS.quickaddResolve)).toBeNull();
      process.env[key] = "12";
      expect(envMax(METERS.quickaddResolve)).toBe(12);
      // MUTATION: accept anything Number() parses -> "0" becomes a bound of zero,
      // which wedges the capability the damper exists to protect, and "abc"
      // becomes NaN passed to SQL.
      for (const bad of ["0", "-3", "abc", "1.5", ""]) {
        process.env[key] = bad;
        expect(envMax(METERS.quickaddResolve)).toBeNull();
      }
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });
});

describe("quick-add resolve charges the durable bound before it reads anything", () => {
  it("refuses on HQBND with the meter's sentence, and reads no page", async () => {
    // The client throws on any use past `.rpc()`, which is the assertion that a
    // refused resolve performs no outbound read and no duplicate lookup.
    const client = {
      rpc: async () => ({ data: null, error: pgError("HQBND", METERS.quickaddResolve) }),
      from: () => {
        throw new Error("a refused resolve must touch nothing");
      },
    } as unknown as SupabaseClient;
    const source = new SupabaseDataSource(client, "user-a", OPEN_GATE);

    const res = await source.resolveJobLinks({ pasted: "Ramp, Product Manager" });
    expect(res).toEqual({
      ok: false,
      kind: "error",
      message: rateBoundMessage(METERS.quickaddResolve),
    });
  });

  it("FAILS LOUD when the meter cannot be charged at all", async () => {
    // `app_add_job`'s precedent: an unreachable meter is not permission to spend
    // somebody's bandwidth. That includes the window between a deploy and the
    // `db-apply` run that creates the function.
    //
    // MUTATION: swallow the error and resolve anyway -> the bound is off for
    // every deploy that ships ahead of its migration, silently.
    const source = new SupabaseDataSource(
      clientAnswering({ data: null, error: pgError("42883", "", "function does not exist") }),
      "user-a",
      OPEN_GATE,
    );
    const res = await source.resolveJobLinks({ pasted: "Ramp, Product Manager" });
    expect(res.ok).toBe(false);
  });

  it("surfaces an expired session as auth, not as a bound", async () => {
    const source = new SupabaseDataSource(
      clientAnswering({ data: null, error: pgError("28000") }),
      "user-a",
      OPEN_GATE,
    );
    expect(await source.resolveJobLinks({ pasted: "Ramp" })).toEqual({ ok: false, kind: "auth" });
  });
});

describe("startWarmSearch translates the store's refusals", () => {
  it("maps HQBND to `rate-limited`, keeping `over-cap` for the daily cap", async () => {
    const bounded = new SupabaseDataSource(
      clientAnswering({ data: null, error: pgError("HQBND", METERS.warmStart) }),
      "user-a",
    );
    expect(
      await bounded.startWarmSearch({
        targetKind: "posting",
        postingKey: "",
        company: "Ramp",
        params: { role: "PM", personas: [], seniority: "", location: "" } as never,
        overlays: { schools: [], pastCompanies: [] },
        idempotencyKey: "idem-1",
      }),
    ).toEqual({ ok: false, kind: "rate-limited", message: rateBoundMessage(METERS.warmStart) });
  });

  it("maps the in-flight refusal to its own sentence, from DETAIL", async () => {
    const inflight = new SupabaseDataSource(
      clientAnswering({ data: null, error: pgError("HQBND", METERS.warmConcurrent) }),
      "user-a",
    );
    const res = await inflight.startWarmSearch({
      targetKind: "posting",
      postingKey: "",
      company: "Ramp",
      params: { role: "PM", personas: [], seniority: "", location: "" } as never,
      overlays: { schools: [], pastCompanies: [] },
      idempotencyKey: "idem-2",
    });
    // MUTATION: build the sentence from `error.message` -> the user reads
    // "rate bound warm.concurrent exceeded: 4 of 3 in this window".
    expect(res).toEqual({
      ok: false,
      kind: "rate-limited",
      message: rateBoundMessage(METERS.warmConcurrent),
    });
  });
});

describe("the fixture twin allows, and says why rather than pretending symmetry", () => {
  it("always allows — there is no network, no vendor and no shared capacity", async () => {
    const { FixtureDataSource } = await import("@/lib/data/fixture-source");
    const fixture = new FixtureDataSource();
    for (const meter of Object.values(METERS)) {
      expect(await fixture.chargeRateBound(meter)).toEqual({ ok: true });
    }
    // The parity rule (CLAUDE.md) is "every production capability has a fixture
    // equivalent", and this IS the equivalent: the fixture's resolve is a map
    // lookup and its export builds from memory, so a gated fake would rate-limit
    // the E2E suite's one shared demo user for the cost of nothing.
  });
});

describe("the route answers a bound with 429", () => {
  /** The route's whole dependency: one `startWarmSearch`. */
  function sourceRefusing(kind: "rate-limited" | "over-cap", message: string): DataSource {
    return { startWarmSearch: async () => ({ ok: false, kind, message }) } as unknown as DataSource;
  }

  function startRequest() {
    return new Request("http://localhost/api/warm/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetKind: "posting",
        postingKey: "gh-1",
        company: "Ramp",
        params: { role: "Product Manager" },
        overlays: { schools: [], pastCompanies: [] },
        idempotencyKey: "idem-3",
      }),
    });
  }

  it("returns 429 and the sentence, which is what the panel renders", async () => {
    // AC 1: a distinct SQLSTATE mapped to 429. `warm-intro-cell.tsx` keys its
    // refusal panel off the STATUS and renders `body.error` verbatim, so this is
    // the whole of the UI contract — no component invents anything.
    //
    // MUTATION: map `rate-limited` to 400 -> the panel falls to `failed`, which
    // offers a Retry button for a request that cannot succeed yet.
    const message = rateBoundMessage(METERS.warmStart);
    const res = await handleWarmStart(startRequest(), {
      source: sourceRefusing("rate-limited", message),
      vendor: new FakeWarmVendor("results"),
    });
    expect(res.status).toBe(429);
    expect((await res.json()) as { error?: string }).toEqual({ error: message });
  });

  it("still returns 429 for the daily cap, with the cap's own sentence", async () => {
    // Both refusals are 429 and they are NOT the same sentence. This is the
    // assertion that keeps the two arms from being collapsed back into one.
    const res = await handleWarmStart(startRequest(), {
      source: sourceRefusing("over-cap", "You have used your 20 warm searches for today."),
      vendor: new FakeWarmVendor("results"),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/for today/i);
    expect(body.error).not.toBe(rateBoundMessage(METERS.warmStart));
  });
});
