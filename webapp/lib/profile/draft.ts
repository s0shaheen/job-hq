/**
 * The wizard's draft, carried in the URL.
 *
 * Not React state, not a cookie, not a server-side scratch row: the URL, because
 * the three things a person does to a multi-step form are refresh it, press
 * Back, and send themselves the link. State that lives in a component loses all
 * three (matrix row 87), and every alternative store has to be cleaned up
 * afterwards.
 *
 * Encoded as base64url of JSON rather than as a dozen query parameters. A
 * flattened form would need an escaping grammar for a job title containing a
 * comma — which is what `lib/grid/url-state.ts` is, 200 lines of it, earned by a
 * surface where the URL is a shareable artefact people read. Nobody reads an
 * onboarding draft, so it gets the boring encoding and the length cap instead.
 */
import { parseCriteria, type ProfileCriteria } from "./criteria";

/** The query parameter the whole draft rides in. */
export const DRAFT_PARAM = "d";

/**
 * Refused above this many characters, encoded.
 *
 * Browsers and proxies start disagreeing past ~2,000 and the failure is a
 * truncated URL, which decodes to garbage rather than to an error. The real
 * presets encode to well under 1,200; the cap exists so a pasted paragraph in a
 * chip cannot quietly break navigation. `parseCriteria`'s per-chip and per-list
 * limits are what keep it under.
 */
export const MAX_DRAFT_LENGTH = 4000;

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a draft, or answer `null` when it will not fit.
 *
 * DROPPED, never truncated — a truncated base64url decodes to something, and
 * something is worse than nothing here. But dropped SILENTLY was the bug: the
 * caller wrote `?d=` with nothing in it, the sync effect then rewrote the URL
 * from the baseline, and every answer the person had typed was gone with no
 * message and no way back through Back. Browser-verified at ~2.9 kB of chips.
 *
 * `null` rather than `""` so a caller cannot mistake "did not fit" for "nothing
 * to encode" — the two used to be the same value, which is why nothing said so.
 */
export function encodeDraft(criteria: ProfileCriteria): string | null {
  const encoded = toBase64Url(JSON.stringify(criteria));
  return encoded.length > MAX_DRAFT_LENGTH ? null : encoded;
}

/**
 * Decode a draft, falling back to `null` on anything unreadable.
 *
 * Never throws and never half-repairs. A draft that will not decode is a
 * navigation the user should start again from a known state, not a form
 * populated with whatever survived — "fail loud, never guess", where loud here
 * means the wizard opens on its defaults rather than on somebody's corrupted
 * half-answers.
 */
export function decodeDraft(raw: string | null | undefined): ProfileCriteria | null {
  if (!raw || raw.length > MAX_DRAFT_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // Through the same closed-set validator the server uses, so the wizard can
    // never render a value a save would silently change underneath it.
    return parseCriteria(parsed);
  } catch {
    return null;
  }
}

/**
 * The two steps, and the clamp that makes `/onboarding/99` a real page.
 *
 * Six of these shipped first, one per setting. Three of them asked about
 * unknown-handling policies, which are the engine's questions rather than
 * anyone's, and the owner's verdict on his own first run was that the whole
 * thing had to be far shorter. What survives is the two a person can answer
 * without being taught the product; the rest kept their defaults and moved
 * behind a disclosure on step two.
 */
export const FIRST_STEP = 1;
export const LAST_STEP = 2;

export function clampStep(raw: string | number | undefined): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n)) return FIRST_STEP;
  return Math.min(Math.max(Math.trunc(n), FIRST_STEP), LAST_STEP);
}
