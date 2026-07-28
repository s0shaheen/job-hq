import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";

/** Keep in step with get-source.ts, which reads this to key the demo store. */
const DEMO_COOKIE = "hq_demo_id";

/**
 * Routes reachable without a session.
 *
 * TWO KINDS OF ENTRY LIVE HERE, and the second kind is the one to get right.
 * `/login`, `/auth` and `/setup` are pages a signed-out person must be able to
 * see. `/api/capture` and `/d` are endpoints that **authenticate their own
 * caller with a credential this app minted** — a bearer token kept as a SHA-256
 * (`lib/capture/token.ts`) and an HMAC-signed link (`lib/digest/token.ts`). For
 * those two, "no session" is the design: an Apps Script and a mail client's
 * in-app browser have no cookie and are never going to acquire one.
 *
 * `middleware.ts`'s matcher excludes static assets and NOTHING else, so it runs
 * on `/api/*` too. `/api/capture` was missing from this list from the day it
 * shipped: every batch the Gmail script POSTed was 307'd to `/login`, the script
 * saw a non-2xx and parked the rows, and no test caught it because the route
 * suite drives the handler directly and never crosses the gate. The dual-write
 * lane C2 shipped had therefore never delivered a single event over HTTP.
 *
 * A redirect is a particularly bad answer for both: 307 preserves the method, so
 * the POST is re-issued at a page that does not want it, and the caller gets a
 * failure that names the wrong thing. `tests/unit/auth-gate.test.ts` pins every
 * name on this list and, more importantly, pins that the two token endpoints are
 * on it.
 */
const PUBLIC_PREFIXES = ["/login", "/auth", "/setup", "/api/capture", "/d"];

/**
 * Exact match, or a `/`-delimited prefix. The delimiter is load-bearing: a bare
 * `startsWith` would let `/d` open `/dashboard`, and `/api/capture` open
 * `/api/capture-everything`.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Session refresh + auth gate, per the @supabase/ssr contract:
 * - do NOT run other logic between createServerClient and the auth call;
 * - always return the response object carrying the refreshed cookies.
 */
export async function updateSession(request: NextRequest) {
  // Demo mode is a deliberate choice by whoever deployed it: fixtures, no auth,
  // and the app says so. Nothing to gate — but give each browser its own store.
  //
  // get-source.ts keys demo stores by the `hq_demo_id` cookie and its comment
  // promises "each browser session gets its own". Nothing issued the cookie, so
  // every visitor fell to the shared `"shared"` store: the owner showing the
  // demo to his dad and his roommate at once would have had them triaging the
  // same queue and draining each other's cards. The promise existed; nothing
  // kept it. Middleware mints the id on first visit so the mechanism is
  // actually driven.
  if (isDemoMode()) {
    const response = NextResponse.next({ request });
    if (!request.cookies.get(DEMO_COOKIE)) {
      response.cookies.set(DEMO_COOKIE, crypto.randomUUID(), {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 30,
        path: "/",
      });
    }
    return response;
  }

  // Unconfigured and NOT demo: send every route to /setup.
  //
  // This used to `return NextResponse.next()` — "never gate on env we don't
  // have" — and the reasoning was backwards. `NEXT_PUBLIC_SUPABASE_*` are
  // inlined at build time, so a build that did not receive them produced an app
  // with no auth gate at all, which then fell through to the fixture data
  // source and served invented jobs to anyone who found the URL, with nothing
  // on screen saying the data was fake. An unconfigured deployment must look
  // broken rather than look like somebody's job search.
  const env = getSupabaseEnv();
  if (!env) {
    const { pathname } = request.nextUrl;
    if (pathname === "/setup" || pathname.startsWith("/setup/")) {
      return NextResponse.next({ request });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/setup";
    url.search = "";
    return NextResponse.redirect(url);
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: no code between client creation and this call.
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  const { pathname } = request.nextUrl;

  if (!claims && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (claims && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/queue";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
