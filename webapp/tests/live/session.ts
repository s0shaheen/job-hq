/**
 * REAL SESSIONS, in the exact cookie format the shipped app reads.
 *
 * The fixture lane fakes an identity with `hq_demo_entitlement`, which is honest
 * about being a seam. The live lane cannot do that and must not: the whole point
 * is that `updateSession` calls `supabase.auth.getClaims()` on a real JWT, and a
 * hand-rolled cookie that the middleware cannot parse would fail in a way that
 * looks like the product being broken.
 *
 * So the session is minted by `@supabase/ssr`'s own `createServerClient` with a
 * cookie adapter that COLLECTS instead of writing. That is the same library, the
 * same chunking, the same names and the same encoding the app's own server
 * client uses — if Supabase changes the cookie format, this lane changes with
 * it rather than silently issuing a session nothing accepts.
 *
 * WHY NOT DRIVE `/login`. The login page offers Google OAuth only, and this lane
 * will not automate a third-party consent screen: it is somebody else's UI, it
 * is rate-limited, and it makes the slowest suite in the estate depend on
 * Google's uptime. What the browser proves is everything AFTER the session
 * exists — which is where RLS, the entitlement gate and the holding surface
 * live. The OAuth hand-off itself stays uncovered and stated as uncovered,
 * rather than mocked into a green cell.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { Cookie } from "@playwright/test";
import type { LiveEnv } from "./env";

export interface Collected {
  name: string;
  value: string;
  options?: CookieOptions;
}

/**
 * Sign in and return the cookies a browser must carry to BE that user.
 *
 * Throws on a failed sign-in rather than returning an empty jar. A lane that
 * proceeded with no cookies would render the signed-out product and every
 * assertion about a refused account would pass for the wrong reason — the
 * highest-value vacuous pass available here.
 */
export async function signInCookies(
  env: LiveEnv,
  email: string,
  origin: string,
): Promise<Cookie[]> {
  const collected: Collected[] = [];
  const client = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return collected.map(({ name, value }) => ({ name, value }));
      },
      setAll(toSet) {
        for (const entry of toSet) {
          const at = collected.findIndex((c) => c.name === entry.name);
          if (at >= 0) collected.splice(at, 1);
          collected.push(entry);
        }
      },
    },
  });

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: env.password,
  });
  if (error) throw new Error(`signInWithPassword(${email}) failed: ${error.message}`);
  if (!data.session) throw new Error(`signInWithPassword(${email}) returned no session`);
  if (collected.length === 0) {
    throw new Error(
      `signInWithPassword(${email}) emitted no cookies; @supabase/ssr's cookie ` +
        `contract has changed and this lane would drive a signed-out browser`,
    );
  }

  return toPlaywrightCookies(collected, origin);
}

/**
 * Shape what `@supabase/ssr` emitted into what Playwright's `addCookies` wants.
 *
 * A PURE FUNCTION, AND THAT IS THE FIX THE REVIEW ASKED FOR. This logic used to
 * be inline in the network call above, so it had no harness — which is why the
 * reviewer correctly declined to change its `httpOnly` handling: a fix that
 * cannot ship with the mutation that proves it is not a fix, it is a hope. Split
 * out, it takes synthetic input and is driven directly by
 * `tests/unit/live-lane.test.ts`.
 *
 * WHAT WAS WRONG. This defaulted `httpOnly` to TRUE, while `@supabase/ssr`'s own
 * default is FALSE — its browser client has to be able to read the session. So
 * the module claimed "the same encoding the app uses" and then encoded one flag
 * differently. Harmless TODAY, because `lib/supabase/client.ts` is used on
 * `/login` alone and every seeded journey reads its session on the server; the
 * moment a surface reads the session in the browser, the live lane would have
 * diverged from production silently, and it would have looked like a product
 * bug. Now whatever the library says is what the browser gets, and the two
 * places this lane MUST deviate are the two that are stated below.
 */
export function toPlaywrightCookies(
  collected: readonly Collected[],
  origin: string,
): Cookie[] {
  const { hostname } = new URL(origin);
  return collected.map(({ name, value, options }) => ({
    name,
    value,
    domain: hostname,
    path: options?.path ?? "/",
    // DEVIATION 1, stated. Session cookies rather than the token's absolute
    // expiry: the lane is minutes long, and copying an absolute time would make
    // the run's validity depend on clock skew between this process and the
    // container running the browser.
    expires: -1,
    // The library's value, verbatim. No default of our own — see above.
    httpOnly: options?.httpOnly ?? false,
    // DEVIATION 2, stated. The e2e server is plain HTTP on 127.0.0.1, so a
    // `secure` cookie is dropped by the browser and the session silently does
    // not exist. Forced false rather than passed through, because @supabase/ssr
    // sets `secure: true` whenever it thinks it is on HTTPS.
    secure: false,
    sameSite: normaliseSameSite(options?.sameSite),
  }));
}

/**
 * `@supabase/ssr` writes the lowercase spelling the `Set-Cookie` header uses;
 * Playwright's type wants the capitalised one. Passing the library's string
 * straight through is a type error at best and a silently-dropped cookie at
 * worst, so the two vocabularies are mapped explicitly rather than cast.
 */
function normaliseSameSite(value: unknown): "Strict" | "Lax" | "None" {
  const v = typeof value === "string" ? value.toLowerCase() : "";
  if (v === "strict") return "Strict";
  if (v === "none") return "None";
  // Lax is both the library's practical default and the browser's, and it is
  // what the app's own middleware sets on `hq_demo_id`.
  return "Lax";
}

/**
 * Playwright `storageState`, ready to write to disk.
 *
 * `origins: []` is deliberate — no localStorage is carried. The app reads its
 * session from cookies on the SERVER; seeding browser storage as well would let
 * a client-side fallback keep a journey alive after the cookie was invalidated,
 * which is precisely the thing the session-expiry journey must be able to see.
 */
export function storageState(cookies: Cookie[]) {
  return { cookies, origins: [] as const };
}
