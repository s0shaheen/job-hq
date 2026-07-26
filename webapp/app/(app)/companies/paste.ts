/**
 * Parsing a pasted list of company names — pure, and in its own module because a
 * `"use server"` file may only export async functions.
 *
 * Shared by the add form, the API route and `actions.ts`, so a name that the UI
 * previews is byte-identical to the name that gets written. A second, slightly
 * different splitter anywhere would make the preview a lie.
 */

/** The bounds migration 0008 enforces, restated so the UI can say them up front. */
export const MAX_PASTE_NAMES = 500;
export const MAX_NAME_LENGTH = 200;

/**
 * Split a pasted blob into candidate names.
 *
 * Held by unit test to the shapes people actually paste: one per line, a CSV
 * column, a comma-joined sentence, quoted cells, Windows line endings, a numbered
 * or bulleted list.
 *
 * Splitting rule: newlines, commas and tabs all separate. A spreadsheet column
 * pasted as CSV arrives comma-joined, and someone typing "Aon, Exelon, Grainger"
 * means three companies.
 *
 * The cost is a company whose legal name contains a comma — "Guggenheim Partners,
 * LLC" arrives as two rows. That is the deliberate trade, and it is chosen in this
 * direction because the two errors are not symmetrical: a split name is visible in
 * the preview and fixable in one edit, since every row lands as a PROPOSAL a human
 * reviews before anything is monitored. The reverse error is invisible — a
 * comma-joined paste silently becoming one 300-character "company" would resolve to
 * nothing, forever, with nothing on screen explaining why.
 */
/**
 * Every leading list marker, in one pass: "-", "–", "—", "•", "*", "1.", "2)".
 *
 * The `+` is the point — markers COMBINE. A line pasted out of a formatted document
 * arrives as `- 1. McDonald's`, and a pattern that matched once left `1. McDonald's`
 * standing as the company name (found by looking at the add form's preview, which is
 * the entire reason the preview exists). A repeat-group inside one regex handles that
 * without a loop, so there is no iteration bound to get wrong and a line of pure
 * markers collapses to "" and is dropped rather than leaving a residue behind.
 *
 * The digits must be followed by `.` or `)` so a leading number that IS the name
 * survives: "3M" and "1-800-Flowers" are companies.
 */
const MARKERS = /^(?:(?:[-–—•*]|\d+[.)])\s*)+/;

export function parsePastedNames(blob: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of blob.split(/[\n\r,\t]+/)) {
    const name = raw
      .trim()
      // A CSV cell's wrapping quotes.
      .replace(/^["']+|["']+$/g, "")
      .trim()
      .replace(MARKERS, "")
      .replace(/[;]+$/, "")
      .trim();
    if (!name || name.length > MAX_NAME_LENGTH) continue;
    const lower = name.toLowerCase();
    // Deduped case-insensitively, matching what app_propose_companies does — so
    // the count the form previews is the count the store will add.
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(name);
  }
  return out;
}
