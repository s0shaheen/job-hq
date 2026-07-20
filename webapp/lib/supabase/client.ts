"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/env";

/**
 * Browser client — PKCE flow is the @supabase/ssr default. Create lazily
 * (inside handlers/effects), never at module scope, so pages prerender
 * cleanly without credentials.
 */
export function createClient() {
  const env = getSupabaseEnv();
  if (!env) {
    throw new Error(
      "Supabase env vars missing — see /setup (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY).",
    );
  }
  return createBrowserClient(env.url, env.anonKey);
}
