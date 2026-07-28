// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The service-role key stays on the server, proven rather than promised.
 *
 * `lib/supabase/server.ts` has said since 0001 that "this app never holds a
 * service_role/secret key, so a bug here can never read another family member's
 * rows". `/api/capture` is the first exception (argued in `lib/env.ts`: the caller
 * is an Apps Script with a bearer token and no session, which anon + RLS cannot
 * express), and `/d/<token>` is the second one of the same shape — a person who
 * tapped a signed link in an email, with no session and no cookie. An exception
 * that nothing bounds is not an exception, it is the new default — so this file is
 * the boundary, and both callers reach the store through the SAME module rather
 * than each building a client of their own.
 *
 * Matrix row 245's shape, applied to a secret: "nothing forbade a `fetch`
 * appearing in `lib/referral/` — and one added two phases from now" is the same
 * sentence as "nothing forbade a second module reaching for the service client".
 *
 * WHAT EACH ASSERTION CATCHES:
 *   * the env NAME appearing outside its one reader — a second, unreviewed holder
 *   * a `NEXT_PUBLIC_` service key — the actual leak, inlined into every bundle
 *   * `lib/supabase/service.ts` imported by anything but the capture route — one
 *     import from a page component and the client bundle question reopens
 *   * the `server-only` marker deleted — the build-time backstop
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(HERE, "..", "..");

/** Every source file in the app, tests excluded (they name what they test). */
function sources(): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".next", "tests", "playwright-report", "test-results"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
    }
  };
  walk(WEBAPP);
  return out;
}

const FILES = sources();
const rel = (f: string) => path.relative(WEBAPP, f);

describe("the service key", () => {
  it("is READ from the environment in exactly one file", () => {
    // The read, not the mention: `service.ts` names it in a comment and in the
    // sentence it throws, which is documentation rather than a second holder.
    // A second `process.env.SUPABASE_SERVICE_KEY` anywhere is a second place a
    // secret can escape from, and adding it should require editing this line
    // on purpose.
    const readers = FILES.filter((f) =>
      /process\.env\.SUPABASE_SERVICE_KEY/.test(readFileSync(f, "utf8")),
    )
      .map(rel)
      .sort();
    expect(readers).toEqual(["lib/env.ts"]);
  });

  it("is mentioned only where it is read or received", () => {
    const holders = FILES.filter((f) => readFileSync(f, "utf8").includes("SUPABASE_SERVICE_KEY"))
      .map(rel)
      .sort();
    expect(holders).toEqual(["lib/env.ts", "lib/supabase/service.ts"]);
  });

  it("is never a NEXT_PUBLIC_ name anywhere", () => {
    // The one mistake that actually publishes it: `NEXT_PUBLIC_*` is inlined
    // into the client bundle at build time.
    for (const f of FILES) {
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/NEXT_PUBLIC_\w*SERVICE/);
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/NEXT_PUBLIC_\w*SECRET/);
    }
  });

  it("guards its own sample env file, if one exists", () => {
    // A `.env.example` carrying `NEXT_PUBLIC_SUPABASE_SERVICE_KEY=` is a
    // suggestion somebody will follow.
    for (const name of [".env.example", ".env.local.example"]) {
      const p = path.join(WEBAPP, name);
      try {
        expect(readFileSync(p, "utf8")).not.toMatch(/NEXT_PUBLIC_\w*SERVICE/);
      } catch {
        /* absent is fine */
      }
    }
  });
});

describe("the service client module", () => {
  const SERVICE = path.join(WEBAPP, "lib", "supabase", "service.ts");

  it("carries the server-only marker", () => {
    expect(readFileSync(SERVICE, "utf8")).toMatch(/^import "server-only";/m);
  });

  it("is imported by the two token handlers and by nothing else", () => {
    // Both are sessionless endpoints authenticating a caller with a credential
    // this app minted. A THIRD name appearing here is the thing to argue about in
    // a diff: a page component or a server action importing this reopens the
    // client-bundle question that `server-only` and the missing `NEXT_PUBLIC_`
    // prefix exist to close.
    const importers = FILES.filter((f) => f !== SERVICE)
      .filter((f) => /from "@\/lib\/supabase\/service"/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(importers).toEqual(["lib/capture/handler.ts", "lib/digest/handler.ts"]);
  });

  it("is the only module that constructs a supabase client with a non-anon key", () => {
    // `lib/supabase/client.ts` and `server.ts` both build clients; both take
    // `env.anonKey`. A third caller reaching for `serviceKey` shows up here.
    const users = FILES.filter((f) => /getServiceEnv\(/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    // Each handler calls it to decide its own unconfigured answer before building
    // anything; the client module calls it to build. All three are intended and
    // all three are listed.
    expect(users).toEqual([
      "lib/capture/handler.ts",
      "lib/digest/handler.ts",
      "lib/env.ts",
      "lib/supabase/service.ts",
    ]);
  });
});
