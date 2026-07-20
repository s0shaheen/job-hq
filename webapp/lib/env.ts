/**
 * Env guard. The app must never crash on missing configuration — pages render
 * a setup notice instead (see app/setup + components/setup-notice.tsx), and
 * `next build` succeeds with no Supabase credentials present.
 *
 * NEXT_PUBLIC_* values are inlined at build time, so this check is cheap and
 * works identically in server components, client components, and middleware.
 */
export type SupabaseEnv = {
  url: string;
  anonKey: string;
};

export function getSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
