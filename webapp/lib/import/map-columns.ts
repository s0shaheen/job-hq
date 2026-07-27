import { type Cell, cellText } from "./read";
import { suggestFor, unmappedFor, type Suggestion } from "./suggest";

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
 * **The ALGORITHM now lives in `./suggest.ts`** — pure, importable from a
 * module that has no business pulling in a server-only reader — and this file
 * owns the applications VOCABULARY: which fields exist, and their aliases. The
 * split happened when the connections import (0013) needed the same two passes
 * and the same 0.82 floor over a different field set; a second copy is a second
 * floor, and the two would have drifted the first time somebody tuned one.
 * `diceCoefficient`, `normalizeHeader`, `FUZZY_FLOOR` and `Suggestion` are
 * re-exported so every existing importer and test keeps its import path.
 *
 * Every function here is pure. The module is nonetheless **server-only by
 * transitivity**, because it takes `Cell` values and shares one definition of
 * "blank" with `read.ts` rather than keeping a second copy that can drift. That
 * costs nothing: §2 puts mapping on the server anyway — the browser holds no
 * working set, and the wizard receives suggestions and samples as props. A
 * client component that needs `TARGET_FIELDS` should take it as a prop or read
 * it from a server component, not import this file.
 */
// Re-exported with `export … from`, NOT `import` then `export`. The latter
// creates a local binding AND an export of the same name, which `tsc --noEmit`
// accepts and Next's build refuses ("individual declarations in merged
// declaration must be all exported or all local") — green typecheck, red build.
export { diceCoefficient, FUZZY_FLOOR, normalizeHeader } from "./suggest";
export type { Suggestion } from "./suggest";

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

export type Mapping = Record<MappableField, Suggestion | null>;

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
 * A suggested column mapping for a header row — pure, and the same every time.
 *
 * The two passes and the tie-breaking live in `./suggest.ts`; what this function
 * supplies is the applications vocabulary and its exact-only set. Ties break on
 * `MAPPABLE_FIELDS` order then header order, so the answer is stable and a test
 * that pins it stays pinned.
 */
export function suggestMapping(headers: readonly string[]): Mapping {
  return suggestFor(
    { fields: MAPPABLE_FIELDS, aliases: HEADER_ALIASES, exactOnly: EXACT_ONLY },
    headers,
  );
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
  return unmappedFor(MAPPABLE_FIELDS, headers, mapping);
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
