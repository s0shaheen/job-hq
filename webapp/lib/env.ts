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
 * Transactional email (#203) — the flag IS the configuration.
 *
 * Two values, both owner-provisioned deployment secrets and neither in the
 * repo (`secrets.HQ_OPS_NTFY_TOPIC`'s handling; a hardcoded fallback is a test
 * failure):
 *
 *   RESEND_API_KEY — the provider credential. No `NEXT_PUBLIC_` prefix, read at
 *     request time on the server, so it is unreachable from a client bundle by
 *     construction; `lib/email/resend.ts` — the only module that USES it — adds
 *     `import "server-only"`, and `tests/unit/service-key-containment.test.ts`
 *     pins this file as its one reader. The `SUPABASE_SERVICE_KEY` shape.
 *   EMAIL_SENDER — the verified from identity, e.g. `Job Search HQ <a@b.c>`.
 *     Owner input under ADR-011 (sender domain, support identity); until the
 *     domain is verified there is nothing true to put here.
 *
 * `null` means transactional email is OFF, and the dispatch path records that
 * as a named `skipped` row in the send ledger — a loud skip, never a silent
 * success and never a crash of the action the mail rides on.
 */
export type EmailEnv = {
  apiKey: string;
  sender: string;
};

export function getEmailEnv(): EmailEnv | null {
  const apiKey = process.env.RESEND_API_KEY;
  const sender = process.env.EMAIL_SENDER;
  if (!apiKey || !sender) return null;
  return { apiKey, sender };
}

/**
 * Why email is off, for the ledger's `reason` column — named, so a skipped row
 * says which owner input is missing rather than "disabled".
 */
export function emailDisabledReason(): string {
  const missing = [
    process.env.RESEND_API_KEY ? null : "RESEND_API_KEY",
    process.env.EMAIL_SENDER ? null : "EMAIL_SENDER",
  ].filter((n): n is string => n !== null);
  if (missing.length === 0) return "";
  return `email disabled: ${missing.join(" and ")} not set`;
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
