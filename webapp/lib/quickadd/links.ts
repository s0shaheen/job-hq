/**
 * What the paste box actually contains.
 *
 * The authored dialog (`templates/system-surfaces/SystemSurfaces.dc.html`,
 * frames "add a job" and "add several") labels the field `Posting links` and
 * states the splitting rule under it in the owner's own words:
 *
 *   "One link or several. New lines, commas, and semicolons all separate."
 *
 * So the rule is not a judgement call and it is not `lib/data/paste.ts`'s rule
 * either — that one splits on tabs too, because it is a spreadsheet column of
 * company names. This one is transcribed from the composition.
 *
 * A comma inside a URL is therefore a split point. That is a real, deliberate
 * loss: a Workday link with a comma-bearing query string arrives as two
 * entries, both unreadable, both shown to the user as unreadable rather than
 * guessed at. The alternative — inventing a smarter rule than the one written
 * on the screen — is a paste box whose stated behaviour and real behaviour
 * differ, which is worse than a split link the user can see and fix.
 */

/** More than this in one paste is a spreadsheet, and `/import` is that surface. */
export const MAX_LINKS = 25;

/**
 * The ONE sentence any unreadable posting produces, wherever it failed.
 *
 * It lives here, in the module with no `node:` imports, so the fixture source
 * and the client bundle can both name it without dragging the fetcher's DNS
 * resolver along. The wording is the owner's, from the authored parse-failure
 * frame; the surface adds the second half of that sentence ("The link is
 * saved…") because only the surface knows the link was in fact saved.
 */
export const UNREADABLE = "Couldn't read this posting.";

export type Entry =
  /** Something addressable. `url` is the trimmed original, never rewritten. */
  | { readonly kind: "url"; readonly url: string }
  /**
   * Free text the user typed instead of a link — "Ramp, Product Manager".
   * Kept as its own kind because it can never be fetched, and presenting it as
   * a failed fetch would be an error message about a mistake nobody made.
   */
  | { readonly kind: "text"; readonly text: string };

/**
 * Bare hosts count. `boards.greenhouse.io/ramp/jobs/4021775` pasted without a
 * scheme is what a browser address bar hands you, and refusing it would refuse
 * the most common paste in the product.
 */
const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/|$|\?)/i;

function looksAddressable(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  // A scheme we do not speak is NOT a link. `javascript:` and `data:` are the
  // reason this is an allowlist: they reach a fetcher and a href otherwise.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return BARE_HOST.test(value);
}

/**
 * Split a paste into entries, in the order they were written, without
 * duplicates.
 *
 * Deduplication is by the exact trimmed string. Two spellings of one posting
 * (`?utm_source=` on one of them) survive as two entries here and are collapsed
 * later by `jobKey`, which is the only thing in the codebase entitled to say
 * that two URLs are one posting.
 */
export function splitEntries(pasted: string): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const raw of (pasted ?? "").split(/[\n\r,;]+/)) {
    const value = raw.trim();
    if (value === "") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(looksAddressable(value) ? { kind: "url", url: value } : { kind: "text", text: value });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/**
 * The absolute form of an addressable entry, for fetching and for storing.
 *
 * `//` is prepended rather than `https://` where a scheme is absent, so the
 * caller's default applies once, in one place. Returns null when `URL` refuses
 * it — a string that reached here looking addressable and is not is a bug in
 * `looksAddressable`, and returning null makes it visible as "couldn't read
 * this" rather than as a thrown 500.
 */
export function absoluteUrl(entry: string): string | null {
  const value = (entry ?? "").trim();
  if (value === "") return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
