/**
 * How each mappable field is named to a person, and what mapping it means.
 *
 * Keyed by field NAME rather than written as an ordered list, and that is
 * deliberate: `MAPPABLE_FIELDS` in `lib/import/map-columns.ts` owns the set and
 * the order, and a second ordered list here would be a second answer to "which
 * fields can an import write". `import-fields.test.ts` asserts every member of
 * that list has copy here, so adding a field fails a test instead of rendering a
 * select labelled `nextActionDate`.
 *
 * This module deliberately imports nothing. `map-columns.ts` and `map-status.ts`
 * are server-only by transitivity (they share `read.ts`'s definition of blank),
 * so the mapping screen — a client component — cannot reach them. Copy is the one
 * thing it needs that is safe to hold on both sides.
 */

export type FieldCopy = {
  label: string;
  help: string;
  /** Year-first dates only; a date field says so where the choice is made. */
  date?: true;
  /** Written by the round-trip export. Never filled in by hand. */
  machine?: true;
};

/**
 * A row cannot be imported without both of these — the commit path refuses it
 * ("a row needs both a company and a title"), so the mapping screen refuses
 * first rather than letting somebody discover it 40 rows later.
 *
 * A round-trip file is the exception: those rows are matched by `hq_id` and the
 * company/title in them are engine-owned and only reported. `map-step.tsx` is
 * where that exception is applied.
 */
export const REQUIRED_FIELDS = ["company", "title"] as const;

const FIELD_COPY: Record<string, FieldCopy> = {
  company: { label: "Company", help: "Who you applied to." },
  title: { label: "Job title", help: "The role, as the posting names it." },
  url: {
    label: "Job URL",
    help:
      "A link to the posting. A link from a real job board is what lets a second import update this row instead of adding a duplicate.",
  },
  status: {
    label: "Status",
    help: "Where the application stands. Each value in your file is mapped to a stage below.",
  },
  appliedDate: {
    label: "Applied",
    help: "The date you applied. Year-first (2026-03-04) — see the note below.",
    date: true,
  },
  nextAction: { label: "Next action", help: "What this application needs from you next." },
  nextActionDate: {
    label: "Next action date",
    help: "When that is due. Year-first (2026-03-04).",
    date: true,
  },
  notes: {
    label: "Notes",
    help: "Free text. An imported note is added to the history; it never overwrites one.",
  },
  location: {
    label: "Location",
    help: "Only used to tell two postings of the same role in different cities apart.",
  },
  hqId: {
    label: "hq_id",
    help: "Written by this app's round-trip export. It says which row your edits belong to.",
    machine: true,
  },
  hqVersion: {
    label: "hq_version",
    help:
      "The version the file was exported at. If the row has changed since, your edit opens a side-by-side rather than overwriting it.",
    machine: true,
  },
};

export function fieldCopy(field: string): FieldCopy {
  return FIELD_COPY[field] ?? { label: field, help: "" };
}

/**
 * What each batch state means to the person who left it there.
 *
 * Written as "what is waiting" rather than as the state name, because the list's
 * job is to answer "did that finish, and if not what do I do". `uploaded` and
 * `mapped` read the same on purpose — `importStep` puts both on the mapping
 * screen, and a list that distinguished them would be describing the database.
 */
export const IMPORT_STATE_COPY: Record<string, { label: string; hint: string }> = {
  uploaded: { label: "Not imported yet", hint: "Waiting for you to say which column is which." },
  mapped: { label: "Not imported yet", hint: "Waiting for you to say which column is which." },
  previewed: { label: "Not imported yet", hint: "Waiting for you to review it before it writes." },
  committing: { label: "Part-imported", hint: "It stopped part-way. Open it to carry on." },
  committed: { label: "Imported", hint: "" },
  rolled_back: { label: "Undone", hint: "Everything this import wrote was put back." },
  failed: { label: "Stopped", hint: "It could not finish. Open it to see what happened." },
};

export function stateCopy(state: string): { label: string; hint: string } {
  return IMPORT_STATE_COPY[state] ?? { label: state, hint: "" };
}

/** Every field this module has copy for — the drift guard's other half. */
export function fieldsWithCopy(): string[] {
  return Object.keys(FIELD_COPY);
}
