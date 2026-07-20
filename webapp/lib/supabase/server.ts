import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/env";

/**
 * Server client bound to the CURRENT USER's session cookies. Authorization is
 * the anon key + RLS — this app never holds a service_role/secret key, so a
 * bug here can never read another family member's rows.
 *
 * Callers must check getSupabaseEnv() first (pages render <SetupNotice/> when
 * it is null); this throws only if that contract is violated.
 */
export async function createClient() {
  const env = getSupabaseEnv();
  if (!env) {
    throw new Error(
      "Supabase env vars missing — see /setup (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY).",
    );
  }

  const cookieStore = await cookies();

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — safe to ignore when middleware
          // is refreshing sessions (it is; see middleware.ts).
        }
      },
    },
  });
}
