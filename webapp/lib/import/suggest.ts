/**
 * The header-guessing algorithm, extracted from `map-columns.ts` so a second
 * kind of import can run it without owning a second copy.
 *
 * Nothing about the two rules is specific to applications, and both are the
 * whole reason this is deterministic code rather than a model call
 * (`docs/plans/PHASE-IMPORT.md` decision 1):
 *
 *   1. **An exact alias hit is the only 1.0.** Everything else is a suggestion
 *      the person sees beside three live values from the column, because mapping
 *      without seeing the data is exactly how "Contact Company" gets accepted.
 *   2. **Below the floor nothing is filled in at all.** Not a low-confidence
 *      guess, not a greyed-out default — Unmapped. A confident wrong guess is
 *      worse than no guess, because nobody audits the field that already looks
 *      right.
 *
 * Extracted rather than copied, and PURE rather than server-only: `map-columns.ts`
 * imports `Cell`/`cellText` from the server-only reader, so anything importing it
 * inherits that. This file imports nothing, which is what lets the connections
 * import — whose mapping runs over already-decoded text — reuse the algorithm
 * instead of growing a second 0.82 floor that drifts from the first one.
 */

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

export type SuggestSpec<F extends string> = {
  /** Every field a mapping may name, in the order ties break on. */
  fields: readonly F[];
  /** Normalized "their words" per field. Must be disjoint across fields. */
  aliases: Record<F, readonly string[]>;
  /** Fields matched by exact alias ONLY — never fuzzy. */
  exactOnly?: ReadonlySet<F>;
};

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
 * Ties break on field order then header order, so the answer is stable and a
 * test that pins it stays pinned.
 */
export function suggestFor<F extends string>(
  spec: SuggestSpec<F>,
  headers: readonly string[],
): Record<F, Suggestion | null> {
  const mapping = {} as Record<F, Suggestion | null>;
  for (const f of spec.fields) mapping[f] = null;

  const normalized = headers.map(normalizeHeader);
  const spent = new Set<number>();

  const aliasOwner = new Map<string, F>();
  for (const field of spec.fields) {
    for (const alias of spec.aliases[field]) {
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

  type Candidate = { field: F; index: number; score: number; order: number };
  const candidates: Candidate[] = [];
  for (let f = 0; f < spec.fields.length; f += 1) {
    const field = spec.fields[f];
    if (spec.exactOnly?.has(field) || mapping[field] !== null) continue;
    for (let i = 0; i < headers.length; i += 1) {
      if (spent.has(i) || normalized[i] === "") continue;
      // Scored against every alias AND the field's own name, so `nextActionDate`
      // still matches "nextActionDate" out of a machine-written export.
      let best = 0;
      for (const alias of [...spec.aliases[field], normalizeHeader(field)]) {
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
 * Columns with no target, for the "these went nowhere" half of a report.
 *
 * By column index, not by name. A sheet with two "Notes" columns has ONE of them
 * mapped and one going nowhere, and someone who typed into the wrong copy
 * deserves to be told rather than to find the sheet unchanged.
 */
export function unmappedFor<F extends string>(
  fields: readonly F[],
  headers: readonly string[],
  mapping: Record<F, Suggestion | null>,
): string[] {
  const taken = new Set(
    fields.map((f) => mapping[f]?.index).filter((i): i is number => i !== undefined),
  );
  return headers.filter((_, i) => !taken.has(i));
}
