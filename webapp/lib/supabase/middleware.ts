import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  DEMO_ENTITLEMENT_COOKIE,
  demoEntitlement,
  isActive,
  readEntitlement,
  type EntitlementReader,
} from "@/lib/auth/entitlement";
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
const PUBLIC_PREFIXES = [
  "/login",
  "/auth",
  "/setup",
  "/api/capture",
  "/d",
  // The two documents the auth column's legal line points at (04 §4.5). They
  // are the third kind of entry on this list and the safest: static pages that
  // read no session, no profile and no store at all, so there is nothing on them
  // to leak and nothing for the gate to protect. Gating them would send a
  // signed-out visitor who clicked "Privacy" straight back to the page they
  // clicked it from, which is the loop the gate exists to avoid rather than to
  // create.
  "/terms",
  "/privacy",
];

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

/** Where the holding surface lives. Outside `(app)`, so it has no shell to gate. */
export const PENDING_PATH = "/pending";

/**
 * The routes an account that is NOT turned on may reach. An ALLOWLIST, and the
 * direction is the entire point.
 *
 * A denylist ("block /queue, /jobs, /pipeline, …") is wrong the moment somebody
 * adds a route, because the failure mode of forgetting is EXPOSURE. Written this
 * way, forgetting means a new surface is refused until somebody deliberately
 * puts it on this list — the failure mode of forgetting is a 302 to the holding
 * page, which is visible in ten seconds and harms nobody.
 *
 * It is exactly two things:
 *
 *   * the holding surface itself, or a pending user cannot see why they are
 *     stuck (and `/pending` would redirect to itself forever);
 *   * everything already public. That list is signed-out pages plus the two
 *     endpoints that authenticate their own caller with a credential this app
 *     minted (`/api/capture`'s bearer token, `/d`'s signed link). Those do not
 *     read the session at all, so gating them on the session's entitlement would
 *     break the Gmail script for a reason that has nothing to do with it.
 *
 * `/onboarding` is deliberately NOT here: a pending account must not be able to
 * write a search profile, and the wizard is the one surface outside `(app)` that
 * would otherwise let it.
 */
export function isPendingAllowedPath(pathname: string): boolean {
  if (pathname === PENDING_PATH || pathname.startsWith(`${PENDING_PATH}/`)) return true;
  return isPublicPath(pathname);
}

function redirectTo(request: NextRequest, pathname: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url);
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
    // The entitlement gate still runs, driven by the seam cookie instead of by a
    // store there isn't one of. Same predicate, same allowlist, same redirect —
    // which is the point: without this the route gate would be unreachable
    // through the only mode the E2E suite can drive, and "a pending user reaches
    // nothing" would be a claim with no browser behind it.
    const entitlement = demoEntitlement(request.cookies.get(DEMO_ENTITLEMENT_COOKIE)?.value);
    if (!isActive(entitlement) && !isPendingAllowedPath(request.nextUrl.pathname)) {
      return redirectTo(request, PENDING_PATH);
    }
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
    return redirectTo(request, "/login");
  }

  /**
   * The entitlement gate (0027).
   *
   * IN MIDDLEWARE AS WELL AS AT THE DATA LAYER, and the two are not redundant.
   * The data layer is the security boundary — `getDataSource()` throws, so a
   * hand-crafted POST to a server action gets a refusal rather than a write.
   * This is the one that makes a pending person land somewhere that explains
   * itself instead of on an error page, and it is what keeps a route that reads
   * nothing (a future static surface) from rendering for an account that is not
   * turned on.
   *
   * THE COST, STATED. This is one indexed primary-key lookup on a table with one
   * row per user, and middleware runs on every request including the RSC payloads
   * a single navigation fans out into. `(app)/layout.tsx` makes the opposite
   * trade for the onboarding guard and says so; the difference is that this
   * decides ACCESS, and a guard that only runs where somebody remembered to put
   * it is the shape this whole branch exists to remove. The read is skipped
   * whenever the destination is already pending-allowed, so the holding page
   * itself does not pay it per paint.
   *
   * IT FAILS OPEN, and that is deliberate: `unreadable` means the query failed,
   * not that the person is pending, and routing every signed-in user to the
   * holding page during a Supabase blip is an outage this product would be
   * inflicting on itself. The request continues to the data layer, which fails
   * CLOSED on the same signal. Open here, closed there, on purpose.
   */
  const sub = typeof claims?.sub === "string" ? claims.sub : "";
  // Narrowed once. Handing `SupabaseClient` straight to `readEntitlement` twice
  // makes tsc re-derive postgrest's row type from the select literal at each call
  // site and blow its instantiation-depth budget (TS2589); one widening
  // assignment to the structural reader costs nothing and keeps the check — this
  // is an assignment tsc verifies, not a cast that would silence it.
  const reader: EntitlementReader = supabase;

  if (claims && pathname === "/login") {
    // Straight to the right place rather than to /queue and back out again: a
    // pending user bouncing through the queue sees a flash of a surface they are
    // not allowed to be on.
    const read = await readEntitlement(reader, sub);
    const blocked = read.kind === "ok" && !isActive(read.entitlement);
    // `/` and not `/queue`: the Landing view preference (0025) says which
    // surface opens when somebody signs in, and `app/page.tsx` is the one place
    // that reads it. Sending an authenticated visitor straight to the queue from
    // here would make the setting unreachable on the only path it describes.
    // Middleware cannot read it itself without a second query on every request,
    // and `/` is already gated by this same function.
    return redirectTo(request, blocked ? PENDING_PATH : "/");
  }

  if (claims && !isPendingAllowedPath(pathname)) {
    const read = await readEntitlement(reader, sub);
    if (read.kind === "ok" && !isActive(read.entitlement)) {
      return redirectTo(request, PENDING_PATH);
    }
  }

  return supabaseResponse;
}
