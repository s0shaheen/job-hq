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

/**
 * One raw segment to one candidate name — THE normalization, shared by the
 * parser and the per-line diagnostics below so they cannot disagree about
 * which segments survive. A diagnostic that re-implemented this with its own
 * trims would eventually flag a line the parser keeps, or miss one it drops.
 */
function normalizeCandidate(raw: string): string {
  return raw
    .trim()
    // A CSV cell's wrapping quotes.
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .replace(MARKERS, "")
    .replace(/[;]+$/, "")
    .trim();
}

export function parsePastedNames(blob: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of blob.split(/[\n\r,\t]+/)) {
    const name = normalizeCandidate(raw);
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

/**
 * The rows `parsePastedNames` DROPS for length, each with the 1-based line it
 * came from — so a five-hundred-line file can say "line 212" instead of "one
 * of them, somewhere".
 *
 * Failing the row and keeping the rest is the contract (a malformed row must
 * not sink the chunk), and naming the line is what makes the failure fixable:
 * the text sits in the box, and the line number is an address into it. Only
 * over-length is a failure here — a blank line, a pure-marker line and a
 * duplicate are ordinary paste shapes the parser absorbs by design, and a
 * blank is "nothing was provided", never an error and never a default.
 *
 * The candidate check is `normalizeCandidate`, the parser's own, so this
 * flags exactly what the parser drops: a 210-character quoted cell whose
 * quotes strip down to 195 characters is KEPT by the parser and must not be
 * flagged here (the add form's previous count, which measured the raw
 * segment, got that case wrong).
 */
export type OverlongLine = { line: number; name: string };

export function overlongLines(blob: string): OverlongLine[] {
  const out: OverlongLine[] = [];
  blob.split(/\r\n|[\n\r]/).forEach((lineText, i) => {
    for (const raw of lineText.split(/[,\t]+/)) {
      const name = normalizeCandidate(raw);
      if (name.length > MAX_NAME_LENGTH) out.push({ line: i + 1, name });
    }
  });
  return out;
}
