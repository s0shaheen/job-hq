import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";

/** Routes reachable without a session. */
const PUBLIC_PREFIXES = ["/login", "/auth", "/setup"];

function isPublicPath(pathname: string): boolean {
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
  // and the app says so. Nothing to gate.
  if (isDemoMode()) return NextResponse.next({ request });

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
