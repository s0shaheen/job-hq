import { type Cell, cellText } from "./read";

/**
 * Guessing which spreadsheet column is which — deterministically, and with a
 * floor under the guessing.
 *
 * Deliberately NOT an LLM (decision 1 in docs/plans/PHASE-IMPORT.md). A wrong
 * column mapping is silent corruption: "Contact Company" landing in `company`
 * produces 300 applications at companies that do not exist, and the person who
 * imported them finds out in a month. The fix for that has to be reproducible
 * offline and testable at the boundary, which rules out anything that answers
 * differently on Tuesday.
 *
 * Two rules carry the whole module:
 *
 *   1. **An exact alias hit is the only 1.0.** Everything else is a *suggestion
 *      the user sees and can change*, rendered next to three live values from
 *      the column (`sampleValues`), because mapping without seeing the data is
 *      exactly how "Contact Company" gets accepted.
 *   2. **Below 0.82 nothing is filled in at all.** Not a low-confidence guess,
 *      not a greyed-out default — Unmapped. A confident wrong guess is worse
 *      than no guess, because nobody audits the field that already looks right
 *      (matrix rows 25 and 26).
 *
 * Every function here is pure. The module is nonetheless **server-only by
 * transitivity**, because it takes `Cell` values and shares one definition of
 * "blank" with `read.ts` rather than keeping a second copy that can drift. That
 * costs nothing: §2 puts mapping on the server anyway — the browser holds no
 * working set, and the wizard receives suggestions and samples as props. A
 * client component that needs `TARGET_FIELDS` should take it as a prop or read
 * it from a server component, not import this file.
 */

/** The nine human-owned fields an import can write. */
export const TARGET_FIELDS = [
  "company",
  "title",
  "url",
  "status",
  "appliedDate",
  "nextAction",
  "nextActionDate",
  "notes",
  "location",
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

/**
 * The two machine-owned columns a round-trip export carries.
 *
 * Matched EXACT-ONLY, never fuzzy. Their presence flips the batch into
 * round-trip mode, where rows are matched by id and `hqVersion` decides whether
 * a write is allowed — so a column called "HQ Identifier" fuzzy-matching its way
 * into `hqId` would hand the matcher primary keys from somebody's own numbering
 * scheme. Nothing about that failure is visible until it writes.
 */
export const ROUND_TRIP_FIELDS = ["hqId", "hqVersion"] as const;
export type RoundTripField = (typeof ROUND_TRIP_FIELDS)[number];

export type MappableField = TargetField | RoundTripField;
export const MAPPABLE_FIELDS: readonly MappableField[] = [...TARGET_FIELDS, ...ROUND_TRIP_FIELDS];

export type Suggestion = {
  /** The source header, verbatim as it appears in the file. */
  header: string;
  /**
   * Which column, 0-based.
   *
   * Carried alongside the name because a name is not an address: a sheet with
   * two columns called "Notes" gives a commit step reading by name a coin flip,
   * and the second one is the empty one about half the time.
   */
  index: number;
  /** 1.0 for an alias hit; the Dice score for a fuzzy one. Never below the floor. */
  confidence: number;
  source: "alias" | "fuzzy";
};

export type Mapping = Record<MappableField, Suggestion | null>;

/**
 * Below this, the field stays Unmapped.
 *
 * Calibrated on the case it exists for: normalized "contact company" against
 * "company" scores 0.63 on bigram Dice, and at any floor low enough to catch it
 * the mapper is guessing. Above it sit the endings people actually type —
 * "Locations" vs "location" is 0.93, "Statuses" vs "status" is 0.83. "URLs" vs
 * "url" is 0.80 and stays Unmapped, which is the honest outcome for a
 * three-letter word where one added character moves the score 20 points.
 */
export const FUZZY_FLOOR = 0.82;

/**
 * lowercase, non-alphanumerics to spaces, runs collapsed.
 *
 * Punctuation becomes a space rather than nothing so that `job_title` and
 * `job-title` land on `job title` alongside `Job Title`, instead of on
 * `jobtitle` — which would then have to be a separate alias for every field.
 */
export function normalizeHeader(header: string): string {
  return (header ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The alias table — "their words" for each of our fields.
 *
 * Every entry is written in normalized form and asserted disjoint by the tests:
 * one header may not exact-match two targets, because the resolution would then
 * depend on the order of this object rather than on anything true.
 */
export const HEADER_ALIASES: Record<MappableField, readonly string[]> = {
  company: ["company", "company name", "employer", "organisation", "organization", "org", "firm"],
  title: ["title", "job title", "role", "position", "job", "job role", "job position", "role title"],
  url: [
    "url",
    "link",
    "job url",
    "job link",
    "posting url",
    "posting link",
    "job posting url",
    "application url",
    "apply link",
    "listing url",
  ],
  status: ["status", "stage", "state", "application status", "current status", "application stage"],
  appliedDate: [
    "applied",
    "applied date",
    "date applied",
    "application date",
    "applied on",
    "apply date",
    "date of application",
    "submitted",
    "date submitted",
  ],
  nextAction: ["next action", "next step", "next steps", "action", "todo", "to do", "follow up"],
  nextActionDate: [
    "next action date",
    "next step date",
    "follow up date",
    "due",
    "due date",
    "next date",
    "reminder",
    "reminder date",
  ],
  notes: ["notes", "note", "comment", "comments", "remarks", "details", "description"],
  location: ["location", "job location", "city", "place", "office", "based in", "work location"],
  // Exact-only. Left in the table so `suggestMapping` has one code path, and
  // excluded from the fuzzy pass by name below.
  hqId: ["hq id", "hqid"],
  hqVersion: ["hq version", "hqversion"],
};

const EXACT_ONLY = new Set<MappableField>(ROUND_TRIP_FIELDS);

/**
 * Sørensen–Dice on character bigrams of the normalized, de-spaced strings.
 *
 * Bigrams rather than edit distance because the failure mode here is *extra
 * words*, not typos: "Contact Company" contains "company" whole, and any
 * containment-flavoured measure scores it near 1.0 and maps it. Dice divides by
 * the length of both strings, so the four unmatched bigrams of "contact" drag
 * it to 0.63 — which is the entire reason this measure and not another.
 */
export function diceCoefficient(a: string, b: string): number {
  const gramsOf = (s: string): string[] => {
    const flat = s.replace(/ /g, "");
    if (flat.length < 2) return flat.length === 1 ? [flat] : [];
    const out: string[] = [];
    for (let i = 0; i < flat.length - 1; i += 1) out.push(flat.slice(i, i + 2));
    return out;
  };
  const left = gramsOf(a);
  const right = gramsOf(b);
  if (left.length === 0 || right.length === 0) return a === b ? 1 : 0;

  // Multiset intersection: a repeated bigram may only be matched once, or
  // "aaaa" scores 1.0 against "aa".
  const pool = new Map<string, number>();
  for (const g of left) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of right) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      pool.set(g, n - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (left.length + right.length);
}

function emptyMapping(): Mapping {
  const out = {} as Mapping;
  for (const f of MAPPABLE_FIELDS) out[f] = null;
  return out;
}

/**
 * A suggested column mapping for a header row — pure, and the same every time.
 *
 * Two passes, in this order and for this reason:
 *
 *   1. **Exact alias hits.** Leftmost header wins a target; a header that wins
 *      one target is spent and cannot serve another. A duplicated header name
 *      ("Notes" twice) therefore maps once instead of quietly rotating.
 *   2. **Fuzzy, globally.** Every remaining (target, header) pair is scored, the
 *      pairs at or above the floor are sorted best-first, and assignment walks
 *      that list. Sorting globally rather than looping targets in declaration
 *      order is what stops `company` from taking a 0.84 header that `location`
 *      would have matched at 0.97.
 *
 * Ties break on target order then header order, so the answer is stable and a
 * test that pins it stays pinned.
 */
export function suggestMapping(headers: readonly string[]): Mapping {
  const mapping = emptyMapping();
  const normalized = headers.map(normalizeHeader);
  const spent = new Set<number>();

  const aliasOwner = new Map<string, MappableField>();
  for (const field of MAPPABLE_FIELDS) {
    for (const alias of HEADER_ALIASES[field]) {
      if (!aliasOwner.has(alias)) aliasOwner.set(alias, field);
    }
  }

  for (let i = 0; i < headers.length; i += 1) {
    if (normalized[i] === "") continue;
    const field = aliasOwner.get(normalized[i]);
    if (field && mapping[field] === null) {
      mapping[field] = { header: headers[i], index: i, confidence: 1, source: "alias" };
      spent.add(i);
    }
  }

  type Candidate = { field: MappableField; index: number; score: number; order: number };
  const candidates: Candidate[] = [];
  for (let f = 0; f < MAPPABLE_FIELDS.length; f += 1) {
    const field = MAPPABLE_FIELDS[f];
    if (EXACT_ONLY.has(field) || mapping[field] !== null) continue;
    for (let i = 0; i < headers.length; i += 1) {
      if (spent.has(i) || normalized[i] === "") continue;
      // Scored against every alias AND the field's own name, so `nextActionDate`
      // still matches "nextActionDate" out of a machine-written export.
      let best = 0;
      for (const alias of [...HEADER_ALIASES[field], normalizeHeader(field)]) {
        const score = diceCoefficient(normalized[i], alias);
        if (score > best) best = score;
      }
      if (best >= FUZZY_FLOOR) candidates.push({ field, index: i, score: best, order: f });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order || a.index - b.index);

  for (const c of candidates) {
    if (mapping[c.field] !== null || spent.has(c.index)) continue;
    mapping[c.field] = {
      header: headers[c.index],
      index: c.index,
      confidence: c.score,
      source: "fuzzy",
    };
    spent.add(c.index);
  }

  return mapping;
}

/**
 * Round-trip mode: the file carries our own id and version columns.
 *
 * Both, not either. `hqId` alone would match rows by id and then write them with
 * no concurrency token at all, which is the exact overwrite AC 23 exists to
 * prevent — so a file missing `hqVersion` falls back to `job_key` matching
 * (matrix row 40) rather than half-entering a mode it cannot finish.
 */
export function isRoundTrip(mapping: Mapping): boolean {
  return mapping.hqId !== null && mapping.hqVersion !== null;
}

/**
 * Columns with no target, for the "these went nowhere" half of the G13 report.
 *
 * By column index, not by name. A sheet with two "Notes" columns has ONE of them
 * mapped and one going nowhere, and someone who typed into the wrong copy
 * deserves to be told rather than to find the sheet unchanged.
 */
export function unmappedHeaders(headers: readonly string[], mapping: Mapping): string[] {
  const taken = new Set(
    MAPPABLE_FIELDS.map((f) => mapping[f]?.index).filter((i): i is number => i !== undefined),
  );
  return headers.filter((_, i) => !taken.has(i));
}

/**
 * Up to `n` real values per header, for the mapping screen.
 *
 * This is the mechanism behind matrix row 25, not decoration. The 0.82 floor
 * stops the mapper from *inventing* a mapping; showing three live values is what
 * stops a plausible-looking one from being accepted. "Contact Company" scores
 * too low to be pre-filled, but a user hand-picking it sees `Jane Okafor`,
 * `R. Silva`, `procurement@` under it and stops.
 *
 * Blanks are skipped rather than counted: three empty samples say nothing, and
 * the first three rows of a real export are often the emptiest.
 */
export function sampleValues(
  rows: readonly Cell[][],
  headerIndex: number,
  n = 3,
): Record<string, string[]> {
  const header = rows[headerIndex] ?? [];
  const out: Record<string, string[]> = {};

  for (let c = 0; c < header.length; c += 1) {
    const name = cellText(header[c] ?? null);
    if (name === "") continue;
    // Duplicate header names share one bucket — the mapping UI keys on the
    // name, so the samples it shows have to cover every column wearing it.
    const bucket = (out[name] ??= []);
    for (let r = headerIndex + 1; r < rows.length && bucket.length < n; r += 1) {
      const value = cellText(rows[r]?.[c] ?? null);
      if (value !== "") bucket.push(value);
    }
  }

  return out;
}
