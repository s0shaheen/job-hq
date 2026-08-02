/**
 * The company logo source ladder (01 section 7).
 *
 * Pure on purpose. The component holds a rung index and an `onError`; every
 * decision that can be made without a DOM is made here, where a unit test can
 * reach it. That test is `tests/unit/logo-sources.test.ts`.
 *
 * The ladder, best first:
 *
 *   1. `img.logo.dev` by domain, which needs BOTH a domain and a publishable
 *      key. Absent either one, this rung does not exist.
 *   2. Google's favicon service, which needs only the domain.
 *   3. The monogram, which is the component's business rather than this
 *      module's, because it is not a URL.
 *
 * Nothing here mints a URL out of a value that is not a hostname. A company
 * name, a pasted job posting, a half-typed "http://" each produce an empty
 * ladder and therefore the monogram. A request built from junk is a broken
 * image at best, and a request to somebody else's host at worst.
 */

/**
 * A plausible hostname: lowercase alphanumeric labels joined by dots, at least
 * one dot, no scheme, no slash, no whitespace. Deliberately stricter than "a
 * string that is not empty" because this value is interpolated into a URL that
 * the browser will fetch.
 */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** The DNS limit. A longer string is not a hostname however it is spelled. */
const MAX_HOST_LENGTH = 253;

/**
 * Reduce whatever is stored in `company.domain` to a bare host.
 *
 * The column is free text: it has held "ramp.com", "https://www.Ramp.com/careers",
 * and the company name. This strips a leading scheme, the authority's
 * credentials and port, any path or query, and the cosmetic "www." label, then
 * answers "" when nothing usable is left. "" is the honest answer, and the
 * caller turns it into a monogram rather than a guess.
 */
export function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return "";

  // Scheme first, then the authority, then "www.". The order is load bearing:
  // stripping "www." first leaves "https://ramp.com" still carrying a scheme.
  const withoutScheme = lowered.replace(/^https?:\/\//, "");
  const authority = withoutScheme.split(/[/?#]/)[0];

  // Credentials and port are not part of the host. In "evil.com@ramp.com" the
  // host is ramp.com; in "ramp.com:8443" it is ramp.com.
  const credentialSplit = authority.split("@");
  const host = credentialSplit[credentialSplit.length - 1].split(":")[0];
  const bare = host.replace(/^www\./, "");

  if (bare.length > MAX_HOST_LENGTH) return "";
  return HOSTNAME.test(bare) ? bare : "";
}

/**
 * The ordered image URLs to try for a company, best first.
 *
 * Returns `[]` when there is no usable domain, which is the everyday case
 * today: `company.domain` arrives with `feat/company-domain-logos`, and the
 * logo.dev key later still. An empty ladder is not a failure state, it is the
 * monogram.
 */
export function logoSources(domain: string | null | undefined, key: string | undefined): string[] {
  const host = normalizeDomain(domain);
  if (!host) return [];

  const sources: string[] = [];
  const token = (key ?? "").trim();
  if (token) {
    // Both halves encoded. The host already passed HOSTNAME so it carries
    // nothing to escape, and encoding it anyway means a future loosening of
    // that pattern cannot turn this line into an injection.
    sources.push(
      `https://img.logo.dev/${encodeURIComponent(host)}?token=${encodeURIComponent(token)}`,
    );
  }
  sources.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`);
  return sources;
}
