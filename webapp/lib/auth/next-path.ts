/**
 * Where the OAuth callback is allowed to send somebody.
 *
 * `?next=` arrives from the URL, which means it arrives from anyone who can get
 * a person to click a link.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It is NOT the fix for a live open redirect, and an earlier version of this
 * comment said it was. That claim was wrong and is corrected rather than
 * quietly deleted, because an unverified exploit story that gets cited later is
 * worse than no story at all.
 *
 * `app/auth/callback/route.ts` builds its destination as `${origin}${next}` and
 * hands the whole string to `NextResponse.redirect`. The origin prefix pins the
 * host BEFORE the URL parser ever sees the attacker's text, so every hostile
 * form resolves back to this app. Measured, not reasoned:
 *
 *   next="//evil.example"        -> https://app.example//evil.example
 *   next="/\evil.example"        -> https://app.example//evil.example
 *   next="/\t/evil.example"      -> https://app.example//evil.example
 *   next="https://evil.example"  -> https://app.examplehttps//evil.example
 *
 * Every one keeps `host=app.example`. There was no reachable hole.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 *
 * Defence in depth against the construction changing. The host is currently
 * pinned by a string concatenation two files away; anything that stops
 * prepending the origin — passing `next` straight to `redirect()`, switching to
 * `new URL(next, request.url)`, moving the hand-off to a client navigation —
 * turns `//evil.example` into a real redirect off-site with no other guard in
 * the way. This makes the value safe on its own terms so that safety does not
 * depend on a detail somewhere else staying true.
 *
 * The check is positive rather than negative: one leading slash, and the
 * character after it is not another slash or a backslash. Anything else falls
 * back to the app's front door rather than being repaired — a value that failed
 * this test is not a path with a typo, it is somebody trying something.
 *
 * The property that actually protects users today — the `Location` header names
 * this origin — is asserted at the route in `tests/unit/auth-callback.test.ts`,
 * because that is where it lives. This function's own tests prove only this
 * function.
 *
 * `DEFAULT_NEXT` is `/` and not `/queue`, because `app/page.tsx` resolves the
 * Landing view preference and this is the moment that preference describes.
 */
export const DEFAULT_NEXT = "/";

export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_NEXT;

  // Control characters first, and this line was added because a mutation found
  // the hole rather than because anyone predicted it. `/\t/evil.example` passes
  // every check below — it starts with one slash and the next character is a
  // tab, not a slash — and `new URL()` STRIPS tabs, newlines and carriage
  // returns while parsing, so the string the parser actually sees is
  // `//evil.example`. The guard would have said "safe" about a value that
  // resolves off-site the moment the origin stops being prepended, which is the
  // exact scenario this function exists for.
  //
  // Caught by `tests/unit/auth-callback.test.ts` when the origin prefix was
  // mutated away: the route went to `evil.example` on that input alone.
  if (/[\u0000-\u0020\u007f]/.test(raw)) return DEFAULT_NEXT;

  if (raw[0] !== "/") return DEFAULT_NEXT;
  if (raw[1] === "/" || raw[1] === "\\") return DEFAULT_NEXT;
  return raw;
}
