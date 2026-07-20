import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
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
  // Unconfigured deployment: let everything through — every page renders the
  // setup notice instead of crashing. Never gate on env we don't have.
  const env = getSupabaseEnv();
  if (!env) return NextResponse.next({ request });

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
