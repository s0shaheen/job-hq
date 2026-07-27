/**
 * What a profile change does to the rows a user already has.
 *
 * The plan is built here, in TypeScript, and applied by `app_commit_profile`.
 * The gate does not get a third implementation in PL/pgSQL — two are already
 * pinned to one corpus and a third would need its own guard, which is matrix
 * row 141's rule arriving on a new surface.
 *
 * Three rules, and the first one is the entire mechanism behind G8:
 *
 *   1. **`triage <> ''` is never touched.** That single clause gives AC 18 (an
 *      already-`interested` posting survives a narrowed profile) and the
 *      dismissed half of AC 19 (a widened profile does not reanimate a
 *      dismissed row — G3, "no reanimation"). It is enforced AGAIN in the SQL,
 *      because a client bug must not be able to route around it.
 *   2. **Unchanged tuples are skipped**, the same idempotence
 *      `monitor/regate.py:38` already relies on: restamping a row with the
 *      value it has costs a write, a version-token bump and an audit event for
 *      nothing, and it would make every save look like it changed 4,000 rows.
 *   3. **A `filtered` entry always carries a reason.** `0002_invariants.sql`'s
 *      `filtered_rows_state_a_reason` check fires otherwise, which is correct
 *      and loud — and the plan should not be the thing that trips it.
 */
import { dispose, normalizeGateConfig, type GateRow } from "@/lib/gating/dispose";
import type { JobView } from "@/lib/data/view-models";
import type { ProfileCriteria } from "./criteria";

export type RegateEntry = {
  key: string;
  disposition: string;
  reason: string;
  /** What the row said before — carried so the banner can name what changed. */
  wasDisposition: string;
};

/** A JobView, as the gate reads it. */
export function jobGateRow(job: JobView): GateRow {
  return {
    // `country`, never `market`. They look interchangeable and are not: a remote
    // posting's market is the literal "Remote" whatever country it is anchored
    // in (`monitor/geo.py:159`), so reading market here would re-gate a
    // Canada-anchored remote role as qualified — the exact case G17 exists for,
    // and the exact case the corpus pins.
    country: job.country,
    remote: job.remote,
    metro: job.metro,
    work_model: job.workModel,
    comp_range: job.compRange,
    min_yoe: job.minYoe,
    seniority: job.seniority,
    tagged_at: job.taggedAt,
  };
}

/**
 * The restamp plan for one profile change.
 *
 * Returns only the rows that would actually move. An empty array is a valid
 * and common answer — most saves change a setting nothing in the current set
 * turns on.
 */
export function buildRegatePlan(jobs: JobView[], criteria: ProfileCriteria): RegateEntry[] {
  const config = normalizeGateConfig(criteria);
  const plan: RegateEntry[] = [];
  for (const job of jobs) {
    // Rule 1. A decided row is the user's, permanently, whatever the profile
    // now says about it.
    if (job.triage !== "") continue;

    const [disposition, reason] = dispose(jobGateRow(job), config);
    // Rule 2.
    if (disposition === job.disposition && reason === job.dispositionReason) continue;
    // Rule 3. Not reachable from `dispose` — every filtered branch returns a
    // reason — and asserted anyway, because the cost of being wrong is a
    // CHECK violation that aborts somebody's whole save.
    if (disposition === "filtered" && !reason) continue;

    plan.push({ key: job.key, disposition, reason, wasDisposition: job.disposition });
  }
  return plan;
}

/**
 * The keys a save would newly QUALIFY — what the review banner links to.
 *
 * Only rows moving INTO `qualified` from something else. A row that was already
 * qualified and merely changed its reason is not news, and putting it in the
 * banner would make "12 postings now qualify" a number the user cannot find on
 * screen.
 */
export function newlyQualifiedKeys(plan: RegateEntry[]): string[] {
  return plan.filter((e) => e.disposition === "qualified" && e.wasDisposition !== "qualified").map((e) => e.key);
}
