/**
 * The grid's working sets. G1 ships the two that make the surface honest —
 * Queue (what needs a decision) and All postings (everything, including what
 * the profile filtered out). The full preset list (Snoozed, Dismissed, Needs
 * review) and saved views arrive in G3 on top of these.
 */
import type { JobView } from "@/lib/data/view-models";

export type WorkingSet = "queue" | "all";

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
  return set === "queue" ? rows.filter(isQueueRow) : rows;
}
