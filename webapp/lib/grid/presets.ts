/**
 * The grid's working sets and built-in presets. G1 shipped Queue and All
 * postings; G3 completes the preset list (Snoozed, Dismissed, Needs review)
 * and adds the persona seeds from spec D.
 *
 * Presets live in CODE, not in saved_views rows, on purpose: they must exist
 * with zero setup — a fresh user's first visit already has the escape hatch
 * ("All postings") and the review pile — and they must not be deletable,
 * because a user who deletes "Queue" has deleted the product. Each preset is
 * one working set, so selecting one is nothing more than navigating to
 * `?set=…` — the URL stays the source of truth (matrix row 19) and a preset
 * is shareable like any other grid state.
 */
import type { JobView } from "@/lib/data/view-models";
// Type-only imports: a value import here would close a runtime cycle
// (url-state imports isWorkingSet from this module).
import type { GridUrlState } from "./url-state";
import type { DisplayState } from "./view-state";

export const WORKING_SETS = ["queue", "all", "snoozed", "dismissed", "needs-review"] as const;
export type WorkingSet = (typeof WORKING_SETS)[number];

export function isWorkingSet(s: string): s is WorkingSet {
  return (WORKING_SETS as readonly string[]).includes(s);
}

/**
 * The Queue predicate: qualified, not yet decided, and still on the board.
 *
 * All three clauses matter. The third is acceptance criterion 16 — a Closed
 * posting is absent from the queue — and it lived only in the Supabase
 * `queue()` query, so a surface built on the full set could not express it and
 * offered dead roles as decidable work. `JobView.status` exists to carry it,
 * and `FIXTURE_JOBS` now contains a Closed row so this clause is falsifiable
 * rather than decorative.
 *
 * The comparison is case-insensitive and tolerant of a missing status:
 * `postings.status` is deliberately not an enum (0001_init.sql explains why —
 * it mirrors a human-editable cell), so it can hold anything. Absent means
 * "not known to be closed", which keeps a row visible; hiding work because a
 * field was blank is the worse failure.
 */
export function isQueueRow(job: JobView): boolean {
  return (
    job.disposition === "qualified" &&
    job.triage === "" &&
    (job.status ?? "").trim().toLowerCase() !== "closed"
  );
}

/** The rows a working set shows. "all" is the input, untouched, on purpose —
 *  the escape-hatch set must never be a third, secretly-different list. */
export function rowsForSet(rows: JobView[], set: WorkingSet): JobView[] {
  switch (set) {
    case "queue":
      return rows.filter(isQueueRow);
    case "all":
      return rows;
    case "snoozed":
      return rows.filter((j) => j.triage === "snoozed");
    case "dismissed":
      return rows.filter((j) => j.triage === "dismissed");
    case "needs-review":
      return rows.filter((j) => j.disposition === "needs-info");
  }
}

export type GridPreset = { set: WorkingSet; name: string };

/**
 * Switcher order. The names are asserted by unit test AND clicked by role in the
 * e2e — renaming one is an API change, not a copy tweak.
 *
 * The SET tokens stay the engine's (`snoozed`, `dismissed`): they are URL state
 * and stored view state, and renaming those breaks every saved link. Only the
 * NAMES are translated, which is the display dictionary's whole shape.
 */
export const GRID_PRESETS: GridPreset[] = [
  { set: "queue", name: "Queue" },
  { set: "all", name: "All postings" },
  { set: "snoozed", name: "Later" },
  { set: "dismissed", name: "Passed" },
  { set: "needs-review", name: "Needs review" },
];

export function presetName(set: WorkingSet): string {
  return GRID_PRESETS.find((p) => p.set === set)?.name ?? set;
}

/**
 * Persona seeds — spec D's per-persona defaults, shipped as pickable presets
 * because there is no per-persona provisioning UI yet. Picking one applies its
 * nav (through the URL) and display state in one gesture; "Save as…" then
 * turns it into a real saved view, and "Use as my landing view" wires
 * `is_default`. Named for what they DO rather than for who they were designed
 * around, since anyone may pick any of them.
 *
 * (Dad's spec-D landing is the Pipeline grouped by status; the pipeline grid
 * is build-order phase 5, so until then his seed points at the comfortable
 * Queue — the plan's §10 flag records this.)
 */
export type PersonaPreset = {
  id: "owner" | "dad" | "roommate";
  name: string;
  nav: GridUrlState;
  display: DisplayState;
};

const QUEUE_NAV: GridUrlState = { set: "queue", filter: [], q: "", sort: null, group: null };

export const PERSONA_PRESETS: PersonaPreset[] = [
  {
    id: "owner",
    name: "Dense, keyboard-first",
    nav: QUEUE_NAV,
    display: { density: "dense", typeScale: "default", hints: true },
  },
  {
    id: "dad",
    name: "Comfortable, large type",
    nav: QUEUE_NAV,
    display: { density: "comfortable", typeScale: "large", hints: false },
  },
  {
    id: "roommate",
    name: "New this week, by company",
    nav: {
      set: "queue",
      filter: [[{ kind: "date", field: "firstSeen", op: "inlast", days: 7 }]],
      q: "",
      sort: null,
      group: "company",
    },
    display: { density: "dense", typeScale: "default", hints: true },
  },
];
