import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * PKCE callback: Google -> Supabase -> here with ?code=...; exchange it for a
 * session (cookies are written by the server client) and continue to `next`.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next") ?? "/queue";
  // Only ever redirect within this app.
  const next = nextParam.startsWith("/") ? nextParam : "/queue";

  if (code && getSupabaseEnv()) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    if (isNotAllowlisted(error.message)) {
      return NextResponse.redirect(`${origin}/login?error=not_allowed`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}

/**
 * Did the exchange fail because `handle_new_auth_user` refused this address?
 *
 * `0001_init.sql` raises `email % is not allowlisted for Job Search HQ` from a
 * trigger on the auth.users insert, and Supabase surfaces that as a 500 from
 * the token exchange — so without this branch a person who was never invited
 * signs in with Google, waits, and lands on "Sign-in didn't complete. Try
 * again." They then try again, forever, because trying again is exactly what
 * the message told them to do (matrix row 92).
 *
 * Matched on the phrase the trigger raises, and on Supabase's own generic
 * database-error wording around it, because the two are wrapped differently
 * depending on where the failure surfaces. A miss here degrades to the old
 * generic message rather than to something wrong.
 */
function isNotAllowlisted(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not allowlisted") ||
    m.includes("database error saving new user") ||
    m.includes("database error creating new user")
  );
}
