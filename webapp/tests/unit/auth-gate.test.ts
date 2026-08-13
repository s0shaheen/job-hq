import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// A signed-out visitor, a configured store, not demo mode: the exact state in
// which the gate decides. Mocked so `updateSession` can be driven directly (m8).
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: null } }) } }),
}));
vi.mock("@/lib/data/source", () => ({ isDemoMode: () => false }));
vi.mock("@/lib/env", () => ({
  getSupabaseEnv: () => ({ url: "https://x.supabase.co", anonKey: "anon-key" }),
}));

import { isPublicPath, updateSession } from "@/lib/supabase/middleware";

/**
 * Which paths the auth gate lets through without a session.
 *
 * THIS FILE EXISTS BECAUSE THE GATE HAD NO TEST AT ALL, and the cost was a lane
 * that never worked. `/api/capture` authenticates its caller with a bearer token
 * and was never added to the public list, so `middleware.ts` — whose matcher
 * excludes static assets and nothing else — 307'd every batch the Gmail Apps
 * Script POSTed to `/login`. The script saw a non-2xx and parked the rows. The
 * route suite drives `handleCapture` with real `Request`s and never crosses the
 * gate, so it was green throughout; so was the contract suite, and so was the db
 * suite. Every layer tested its own half of a wire that was cut in the middle.
 *
 * The rule the list encodes, and the thing to check when adding to it: a path is
 * public either because a signed-out person must SEE it (`/login`, `/setup`) or
 * because the caller carries a credential this app minted and verifies itself
 * (`/api/capture`'s bearer token, `/d`'s signed link). Nothing is public because
 * it was convenient.
 *
 * MUTATION TARGETS:
 *   * drop `/api/capture` from the list        -> the capture test (the shipped bug);
 *   * drop `/d`                                -> the digest test;
 *   * `startsWith(p)` without the `/`          -> the delimiter tests;
 *   * add `/api` instead of `/api/capture`     -> the other-endpoints test.
 */

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIDDLEWARE = path.join(WEBAPP, "lib", "supabase", "middleware.ts");

describe("the auth gate's public paths", () => {
  it("lets the capture endpoint through — it carries a bearer token, not a cookie", () => {
    // The Apps Script has no session and cannot acquire one. A redirect here is
    // worse than a 401: 307 preserves the method, so the POST is re-issued at a
    // page that does not want it and the script is told the wrong thing.
    expect(isPublicPath("/api/capture")).toBe(true);
  });

  it("lets a digest action link through — it carries a signed token in its path", () => {
    expect(isPublicPath("/d/v1.k1.eyJhIjoiaW50ZXJlc3RlZCJ9.sig")).toBe(true);
    expect(isPublicPath("/d")).toBe(true);
  });

  it("lets a signed-out person reach the pages they must", () => {
    for (const p of [
      "/login",
      "/auth/callback",
      "/setup",
      "/setup/finish",
      // The auth column's legal line (04 §4.5). Gated, these two would bounce a
      // signed-out visitor who clicked "Privacy" back to the page they clicked
      // it from — a loop with no error and no way out of it.
      "/terms",
      "/privacy",
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it("gates every surface a person drives", () => {
    for (const p of ["/", "/queue", "/pipeline", "/companies", "/apply", "/settings", "/health"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("gates the API routes that DO run under a session", () => {
    // These read and write through the visitor's own session and RLS. Opening
    // `/api` wholesale to fix the capture bug would have opened all of them.
    for (const p of ["/api/export", "/api/import/upload", "/api/companies/propose"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("matches on a slash delimiter, not a bare prefix", () => {
    // `/d` must not open `/dashboard`, and `/setup` must not open `/setups`.
    for (const p of ["/dashboard", "/details", "/setups", "/logins", "/api/capture-everything"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("runs on /api at all — the matcher excludes static assets and nothing else", () => {
    // The bug above is only reachable because middleware sees API routes. If a
    // future edit excludes `/api` from the matcher, `/api/capture` stops needing
    // to be on the public list and this file's first test becomes theatre; the
    // assertion is here so that change has to come past it.
    const config = readFileSync(path.join(WEBAPP, "middleware.ts"), "utf8");
    expect(config).not.toMatch(/matcher[\s\S]{0,200}api/);
  });

  it("is the only place the list lives", () => {
    // A second copy is how one of them goes stale. The gate reads this constant
    // and the test reads the gate; nothing else may hold a list of public paths.
    const src = readFileSync(MIDDLEWARE, "utf8");
    expect(src.match(/PUBLIC_PREFIXES/g)?.length).toBe(2); // the declaration and its one use
  });
});

describe("the gate itself — what updateSession actually does (m8)", () => {
  // The earlier tests pin `isPublicPath`; NOTHING pinned the 307 that was the
  // real bug. This drives `updateSession` with a signed-out visitor so the
  // redirect is what gets re-checked, not just the list it reads.
  async function decide(pathname: string): Promise<{ status: number; location: string | null }> {
    const res = await updateSession(new NextRequest(`http://localhost${pathname}`));
    return { status: res.status, location: res.headers.get("location") };
  }

  it("passes the token endpoints through with no session and no redirect", async () => {
    for (const p of ["/api/capture", "/d/v1.k1.payload.sig"]) {
      const { location } = await decide(p);
      expect(location, `${p} must not redirect`).toBeNull();
    }
  });

  it("redirects a gated page to /login for a navigation", async () => {
    const { status, location } = await decide("/queue");
    expect(location).toMatch(/\/login$/);
    expect(status).toBe(307);
  });

  it("never 307s a session-expired POST — the gesture is answered in-band (#196)", async () => {
    // A session that expires mid-gesture must get { ok: false, kind: "auth" }
    // from the server action, or 401 from the route handler — never a 307. A
    // 307 preserves the method, so the POST would be re-issued at /login,
    // which answers with a page where the caller expected a result, and the
    // UI could never say "your session ended". The deny is not lost by
    // passing through: every action opens with a session check, the gated
    // routes answer 401, and `getDataSource()` throws for a request with no
    // claims before a row moves (proven in entitlement-boundary.test.ts).
    //
    // KILLED BY: restoring the unconditional `redirectTo(request, "/login")`
    // for the no-claims case.
    for (const p of ["/queue", "/api/export", "/api/import/upload"]) {
      const res = await updateSession(
        new NextRequest(`http://localhost${p}`, { method: "POST" }),
      );
      expect(res.headers.get("location"), `${p} must not redirect a POST`).toBeNull();
      expect(res.status, p).toBe(200);
    }
  });

  it("still redirects a signed-out GET even where a POST passes through", async () => {
    // The pair that makes the POST case above a measurement rather than a
    // description: same path, other method, opposite answer.
    const { location } = await decide("/api/export");
    expect(location).toMatch(/\/login$/);
  });
});
