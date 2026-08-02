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

/**
 * The service-role credential — `/api/capture` and nothing else.
 *
 * WHY THIS EXISTS AT ALL, given `lib/supabase/server.ts` says in as many words
 * that "this app never holds a service_role/secret key". That sentence was true
 * of every surface that existed when it was written, and all of them are surfaces
 * a PERSON drives: the anon key plus RLS is exactly right when the caller has a
 * session. `/api/capture` has no session and cannot have one — the caller is an
 * Apps Script running in a Gmail account, authenticating with a bearer token this
 * app minted, writing rows on behalf of a user whose browser is not involved.
 * Anon + RLS cannot express that, and the alternative (a write policy for
 * `authenticated`) would open the door this schema has kept shut since 0001.
 *
 * THE TWO NAMES ARE NOT `NEXT_PUBLIC_`, AND THAT IS THE WHOLE GUARANTEE.
 * `NEXT_PUBLIC_*` values are inlined into the client bundle at build time; these
 * are read at request time on the server and are unreachable from a browser
 * bundle by construction. `lib/supabase/service.ts` adds `import "server-only"`
 * on top, so a client component importing it is a BUILD failure rather than a
 * leak, and `tests/unit/service-key-containment.test.ts` asserts the name appears
 * in no other file. Three layers, because the failure mode is publishing a key
 * that bypasses every row-level policy in the database.
 *
 * The names match the ENGINE's (`core/pg.py`, `db/README.md` step 5) on purpose:
 * one secret, one name, whichever process is holding it.
 */
export type ServiceEnv = {
  url: string;
  serviceKey: string;
};

export function getServiceEnv(): ServiceEnv | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

/**
 * The logo.dev PUBLISHABLE token — client-safe BY DESIGN, and the deliberate
 * inverse of `getServiceEnv` above.
 *
 * `getServiceEnv` exists to keep a secret OFF the client bundle. This does the
 * opposite on purpose: logo.dev issues a publishable key (`pk_…`) meant to sit in an
 * `<img src="https://img.logo.dev/{domain}?token={key}">` a browser fetches. It grants
 * read-only logo lookups and nothing else — inlining it into the bundle is the
 * intended use, exactly like `NEXT_PUBLIC_SUPABASE_ANON_KEY`. That is why it carries
 * the `NEXT_PUBLIC_` prefix a secret must NEVER carry, and why
 * `service-key-containment.test.ts` neither flags it nor should: that test bans
 * `NEXT_PUBLIC_*SERVICE` / `*SECRET`, and a publishable key is neither. The real
 * secret — `SUPABASE_SERVICE_KEY` — stays server-only and unchanged, still read in
 * this one file and nowhere else.
 *
 * Returns "" when unset. The LogoAvatar (landing with the Jobs surface) degrades
 * gracefully: no key → skip the logo.dev tier → Google favicon → monogram. See
 * `docs/plans/LOGO-AVATAR.md` for the full ladder.
 */
export function getLogoDevKey(): string {
  return process.env.NEXT_PUBLIC_LOGO_DEV_KEY ?? "";
}
