import { isCanonicalStatus, STATUSES } from "@/lib/status";
import { type Cell, cellText } from "./read";

/**
 * Mapping a spreadsheet's status words onto ours.
 *
 * The rule that shapes everything here: **a cell in someone's file may not mint
 * a status.** `core/schema.py:150` gives a human-invented status the top rank —
 * it outranks Offer, it outranks Rejected, and no bot may ever touch a row
 * carrying one. That is right when a person typed it into the sheet on purpose.
 * It is a trap when it arrives 300 times from a column somebody named "Stage",
 * because every one of those rows is then permanently frozen against the engine
 * that is supposed to be tracking it, and nothing about the import said so.
 *
 * So the vocabulary is closed to `lib/status.ts`, an unrecognised value lands in
 * `Inbox`, and the word the file used is preserved verbatim in the notes rather
 * than thrown away — `Imported status: "Awaiting recruiter"` is recoverable
 * information; a row silently retitled `Inbox` is not (matrix row 43).
 *
 * Seeded from `tracker/simplify.py:40-46`, the existing "their words → ours"
 * table, so the two importers agree about what `screen` means.
 *
 * Server-only by transitivity, for the reason given in `map-columns.ts`.
 */

/** Where an unrecognised value goes. The start of the pipeline, not a new stage. */
export const UNKNOWN_STATUS_FALLBACK = "Inbox";

/**
 * lowercase, non-alphanumerics to spaces, runs collapsed.
 *
 * Same shape as `normalizeHeader`, kept separate because it also has to fold our
 * OWN canonical spellings: `Offer-Accepted` normalizes to `offer accepted`,
 * which is what makes a round-trip export re-import as itself instead of
 * collapsing into Inbox on the way back in.
 */
export function normalizeStatus(value: string): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Their words → ours.
 *
 * The first block is `tracker/simplify.py`'s own table (`STATUS_NAMES` +
 * `CREATE_STATUS` + `SUGGEST_STATUS`) plus the four the plan adds. The rest are
 * the spellings people actually type into a tracker they made themselves.
 *
 * What is deliberately absent is as important as what is here:
 *
 * - **No mapping onto `Offer-Accepted` / `Offer-Declined`.** Those are
 *   human-only in the engine and in the database, and a spreadsheet cell is not
 *   a human deciding. They still round-trip, because every canonical status is
 *   registered as an alias of itself below.
 * - **No "declined", no "in progress", no "pending".** Each is two different
 *   states depending on who wrote it. Unmapped falls to Inbox with the original
 *   in the notes, which is recoverable; a coin-flip is not.
 */
const FOREIGN_ALIASES: Record<string, string> = {
  // tracker/simplify.py
  saved: "Inbox",
  applied: "Applied",
  screen: "Screen",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  ghosted: "Closed",
  // the plan's additions for assessments
  oa: "OA",
  assessment: "OA",
  "take home": "OA",

  // Inbox
  inbox: "Inbox",
  bookmarked: "Inbox",
  wishlist: "Inbox",
  "to apply": "Inbox",
  backlog: "Inbox",
  interested: "Inbox",
  // Queued
  queued: "Queued",
  queue: "Queued",
  "ready to apply": "Queued",
  // Applied
  submitted: "Applied",
  "application submitted": "Applied",
  "applied online": "Applied",
  // OA
  "online assessment": "OA",
  takehome: "OA",
  "take home assessment": "OA",
  "coding challenge": "OA",
  hackerrank: "OA",
  codesignal: "OA",
  // Screen
  screening: "Screen",
  "phone screen": "Screen",
  "recruiter screen": "Screen",
  "hr screen": "Screen",
  // Interview
  interviewing: "Interview",
  onsite: "Interview",
  "technical interview": "Interview",
  loop: "Interview",
  // Final
  final: "Final",
  finals: "Final",
  "final round": "Final",
  "final interview": "Final",
  // Offer
  "offer received": "Offer",
  "got offer": "Offer",
  // Rejected
  reject: "Rejected",
  denied: "Rejected",
  "turned down": "Rejected",
  "no thanks": "Rejected",
  // Withdrawn
  withdrew: "Withdrawn",
  cancelled: "Withdrawn",
  canceled: "Withdrawn",
  // Closed
  closed: "Closed",
  "no response": "Closed",
  expired: "Closed",
  archived: "Closed",
  dead: "Closed",
};

/**
 * The full table: every canonical status as an alias of itself, then the
 * foreign vocabulary on top.
 *
 * Self-aliases first and unconditionally. Without them an export → edit →
 * re-import round trip demotes `Final` and `Queued` to Inbox on the way back,
 * which is the loudest possible way to lose trust in the feature.
 */
export const STATUS_ALIASES: Readonly<Record<string, string>> = (() => {
  const table: Record<string, string> = {};
  for (const status of STATUSES) table[normalizeStatus(status)] = status;
  for (const [word, status] of Object.entries(FOREIGN_ALIASES)) {
    // A table entry that is not in lib/status.ts is a bug in this file, and the
    // only safe response is to not use it. `map-status.test.ts` fails on it too,
    // so it cannot reach anyone.
    if (isCanonicalStatus(status)) table[normalizeStatus(word)] = status;
  }
  return table;
})();

export type StatusValue = {
  /** The spelling to show the user — the first one seen in the file. */
  value: string;
  /** Rows carrying this value, counting every spelling of it. */
  count: number;
  /** Every raw spelling folded into this entry, in first-seen order. */
  variants: string[];
};

/**
 * The distinct status words in one column, with counts.
 *
 * Folded case- and whitespace-insensitively, because `Applied`, `applied ` and
 * `APPLIED` are one decision for the user to make, not three — but every raw
 * spelling is kept in `variants` so the notes can quote what the file actually
 * said rather than a normalized version of it.
 *
 * Blank cells are not a value and are not listed. A row with no status is a row
 * whose status the file never stated, and it takes the default like any other
 * unstated field — offering "" as something to map would invite mapping it.
 *
 * `rows` is the DATA rows: pass `rows.slice(headerIndex + 1)`.
 */
export function collectStatusValues(rows: readonly Cell[][], col: number): StatusValue[] {
  const byKey = new Map<string, StatusValue & { first: number }>();
  let seen = 0;

  for (const row of rows) {
    const raw = cellText(row?.[col] ?? null);
    if (raw === "") continue;
    const key = normalizeStatus(raw);
    // A cell of pure punctuation ("—", "-") normalizes to nothing. It is a
    // placeholder somebody typed for "none", not a status.
    if (key === "") continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (!existing.variants.includes(raw)) existing.variants.push(raw);
    } else {
      byKey.set(key, { value: raw, count: 1, variants: [raw], first: seen++ });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .map(({ value, count, variants }) => ({ value, count, variants }));
}

export type StatusMapEntry = {
  /** Always a member of `lib/status.ts`. Never the file's own word. */
  status: string;
  source: "alias" | "fallback";
  /**
   * For a fallback, the line the importer must append to `notes` so the word the
   * file used survives. `null` when the value mapped cleanly and there is
   * nothing to preserve.
   */
  note: string | null;
};

/** The exact phrasing, one place, because the E2E asserts the string. */
export function importedStatusNote(original: string): string {
  return `Imported status: "${original}"`;
}

/**
 * A suggested value→status map, keyed by the raw spelling it was given.
 *
 * Accepts either the raw strings or the `StatusValue` records from
 * `collectStatusValues`, so the preview and the mapping screen can both call it
 * without reshaping their data first.
 *
 * The closed vocabulary is enforced where entries ENTER the table, not here — see
 * `STATUS_ALIASES` above — so this function cannot return a non-canonical status
 * no matter what it is handed. The second guard below is the last line, and
 * `map-status.test.ts` is what actually fires when somebody adds an alias whose
 * target does not exist.
 */
export function suggestStatusMap(
  values: readonly (string | StatusValue)[],
): Record<string, StatusMapEntry> {
  const out: Record<string, StatusMapEntry> = {};

  for (const item of values) {
    const raw = typeof item === "string" ? item : item.value;
    const key = normalizeStatus(raw);
    const hit = STATUS_ALIASES[key];
    if (hit !== undefined && isCanonicalStatus(hit)) {
      out[raw] = { status: hit, source: "alias", note: null };
    } else {
      out[raw] = {
        status: UNKNOWN_STATUS_FALLBACK,
        source: "fallback",
        note: importedStatusNote(raw),
      };
    }
  }

  return out;
}
