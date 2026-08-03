import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE OAUTH CALLBACK'S `Location` HEADER, asserted at the route.
 *
 * This file exists because a review found the branch describing an open
 * redirect that was never reachable, proved by a unit test over a PURE FUNCTION
 * while the property being claimed lives in the route. `safeNextPath` is worth
 * having — see its own header for why — but a test of it says nothing about
 * where a browser is actually sent.
 *
 * So this drives the handler and reads the header a browser would follow. Two
 * properties, and the first is the one that matters:
 *
 *   1. the host in `Location` is ALWAYS this app's, for every hostile `next`;
 *   2. an ordinary in-app path still survives, so property 1 is not being met
 *      by refusing everything.
 *
 * `getSupabaseEnv` and `createClient` are mocked because the route's other job
 * is exchanging a PKCE code with Supabase, which is not what is under test and
 * cannot run here. The mock exchanges successfully so the redirect that carries
 * `next` is the one taken; the failure branches have their own cases below.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  env: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getSupabaseEnv: mocks.env }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: mocks.exchange } }),
}));

const { GET } = await import("@/app/auth/callback/route");

const ORIGIN = "https://app.example";

async function callbackLocation(next: string | null, code = "pkce-code"): Promise<string> {
  const url = new URL(`${ORIGIN}/auth/callback`);
  if (code) url.searchParams.set("code", code);
  if (next !== null) url.searchParams.set("next", next);
  const res = await GET(new Request(url));
  return res.headers.get("location") ?? "";
}

describe("the OAuth callback's redirect target", () => {
  beforeEach(() => {
    mocks.env.mockReturnValue({ url: "https://x.supabase.co", anonKey: "anon" });
    mocks.exchange.mockResolvedValue({ error: null });
  });

  it("never names a host other than this app's, whatever `next` says", async () => {
    // The corpus is every shape that turns a path into an off-site URL somewhere:
    // protocol-relative, backslash variants several browsers normalise to `//`,
    // an absolute URL, and a scheme that is not a location at all.
    //
    // KILLED BY removing BOTH layers, and the two-step is the point rather than
    // a caveat. Run while writing this:
    //
    //   * replace `${origin}${next}` with `new URL(next, request.url)` and this
    //     went RED on `/\t/evil.example` -> https://evil.example/. `new URL()`
    //     strips tabs while parsing, so a value `safeNextPath` was happy with
    //     resolved off-site. That is a hole this test found in the guard, not a
    //     hypothetical;
    //   * with the control-character check then added to `safeNextPath`, the
    //     same mutation goes GREEN again — the second layer holds the line on
    //     its own, which is what "defence in depth" has to mean to be worth
    //     writing down;
    //   * remove the control-character check as well and it goes RED again.
    //
    // So the origin prefix and the guard are each sufficient today, which is
    // exactly why the property is asserted HERE, at the route, where "sufficient
    // today" is the thing a user depends on.
    for (const next of [
      "//evil.example",
      "//evil.example/queue",
      "/\\evil.example",
      "/\t/evil.example",
      "https://evil.example",
      "http://evil.example/queue",
      "javascript:alert(1)",
      "evil.example",
    ]) {
      const location = await callbackLocation(next);
      expect(location, `next=${JSON.stringify(next)} produced no Location`).not.toBe("");
      expect(
        new URL(location).host,
        `next=${JSON.stringify(next)} redirected off-site: ${location}`,
      ).toBe("app.example");
    }
  });

  it("still honours an ordinary in-app path", async () => {
    // Without this, the case above is satisfied by a handler that refuses
    // everything and sends every sign-in to the same place — which would pass a
    // security check and break the product.
    for (const next of ["/queue", "/jobs?set=all", "/settings/preferences"]) {
      const location = await callbackLocation(next);
      expect(new URL(location).pathname + new URL(location).search, next).toBe(next);
    }
  });

  it("defaults to the front door, which resolves the landing view", async () => {
    const location = await callbackLocation(null);
    expect(new URL(location).pathname).toBe("/");
  });

  it("sends a failed exchange to the login page, not onward", async () => {
    mocks.exchange.mockResolvedValue({ error: { message: "bad code" } });
    const location = await callbackLocation("/queue");
    const url = new URL(location);
    expect(url.host).toBe("app.example");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("error")).toBe("auth");
  });

  it("names the allowlist refusal so the person is not told to try again forever", async () => {
    // The one failure where "try again" is actively wrong advice. Preserved
    // through the RM-34 restyle; `login/page.tsx` renders the copy.
    mocks.exchange.mockResolvedValue({
      error: { message: "Database error saving new user" },
    });
    const location = await callbackLocation("/queue");
    expect(new URL(location).searchParams.get("error")).toBe("not_allowed");
  });
});
