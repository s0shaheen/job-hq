/**
 * The /companies grid's working sets, sort fields and persona seeds.
 *
 * Same shape and same reasoning as lib/grid/presets.ts for /jobs: presets live in
 * CODE so they exist with zero setup and cannot be deleted (a user who deletes
 * "Needs review" has deleted the review gate), each one is a single `?set=` so the
 * URL stays the source of truth, and a preset is shareable like any other state.
 *
 * The personas are the research pass's two real universes
 * (docs/plans/COMPANY-DISCOVERY-RESEARCH.md), not invented archetypes — which is
 * why they differ in the one dimension that matters for this surface: the
 * roommate's universe is ~83–90% day-of on adapters that already exist, while
 * Dad's is Workday-heavy with a long aggregator tail. So the roommate's seed
 * sorts by tier (his good rows are the point) and Dad's leads with the review pile
 * (his universe is a recall problem, and the queue of proposals IS his work).
 */
import type { CompanyView, ReviewState } from "@/lib/data/view-models";
import { resolutionConfidence } from "@/lib/data/view-models";

export const COMPANY_SETS = ["review", "universe", "unresolved", "dismissed", "all"] as const;
export type CompanySet = (typeof COMPANY_SETS)[number];

export function isCompanySet(s: string): s is CompanySet {
  return (COMPANY_SETS as readonly string[]).includes(s);
}

export const DEFAULT_COMPANY_SET: CompanySet = "review";

/**
 * The rows a working set shows.
 *
 * "all" is the input untouched, on purpose — the escape-hatch set must never be a
 * third, secretly-different list (presets.ts's rule, unchanged).
 *
 * "unresolved" spans review states deliberately. An unresolved company is a
 * *plumbing* fact, not a review decision: an approved row with no board is the
 * thing a person most needs to see, because they believe they are watching it and
 * nothing is being pulled. Scoping it to approved rows would hide exactly that.
 */
export function rowsForCompanySet(rows: CompanyView[], set: CompanySet): CompanyView[] {
  switch (set) {
    case "review":
      return rows.filter((c) => c.reviewState === "proposed");
    case "universe":
      return rows.filter((c) => c.reviewState === "approved");
    case "unresolved":
      return rows.filter(
        (c) => c.reviewState !== "dismissed" && resolutionConfidence(c) === "unresolved",
      );
    case "dismissed":
      return rows.filter((c) => c.reviewState === "dismissed");
    case "all":
      return rows;
  }
}

export type CompanyPreset = { set: CompanySet; name: string };

/** Switcher order. Names are asserted by unit test AND clicked by role in the
 *  e2e — renaming one is an API change, not a copy tweak. */
export const COMPANY_PRESETS: CompanyPreset[] = [
  { set: "review", name: "Needs review" },
  { set: "universe", name: "My universe" },
  { set: "unresolved", name: "No board found" },
  { set: "dismissed", name: "Passed" },
  { set: "all", name: "All companies" },
];

export function companyPresetName(set: CompanySet): string {
  return COMPANY_PRESETS.find((p) => p.set === set)?.name ?? set;
}

/** Which set a review decision moves a row INTO — what the toast can offer. */
export function setForReviewState(state: ReviewState): CompanySet {
  if (state === "approved") return "universe";
  if (state === "dismissed") return "dismissed";
  return "review";
}

// ---------------------------------------------------------------- sorting

export const COMPANY_SORT_FIELDS = ["name", "tier", "source", "ats"] as const;
export type CompanySortField = (typeof COMPANY_SORT_FIELDS)[number];

export function isCompanySortField(s: string): s is CompanySortField {
  return (COMPANY_SORT_FIELDS as readonly string[]).includes(s);
}

export type CompanySort = { field: CompanySortField; dir: "asc" | "desc" };

/**
 * Pure sort, applied to the array before react-table sees it — lib/grid/sort.ts's
 * rule, for its reason: react-table's `desc` inverts the whole comparator, which
 * would send unknowns to the front, and a mounted-table test cannot observe order
 * in jsdom.
 *
 * Two properties are load-bearing and both have their own test:
 *
 *   1. **Unknowns last in BOTH directions.** An unresolved company has no tier, a
 *      Common Crawl row has no name. Sorting "tier ascending" must not crown the
 *      rows we know least about, and flipping to descending must not either. This
 *      is /jobs' matrix row 57 ("nulls sort as 0") on a new surface.
 *   2. **Day-of first is a DESCENDING-BY-TRUST order, not ascending by number.**
 *      Tier 1 is the most reliable and the lowest integer, so "best first" reads
 *      as ascending here — and within a tier, a verified row outranks an inferred
 *      one, because that is the distinction the whole surface exists to show. A
 *      sort on the tier column that ignored confidence would put an unprobed
 *      Common Crawl slug above a CXS-confirmed Workday tenant.
 */
const CONFIDENCE_RANK: Record<string, number> = {
  verified: 0,
  inferred: 1,
  asserted: 2,
  unresolved: 3,
};

function cmpText(a: string, b: string): number {
  // "" is absence, not an empty first place: a slug-only row has no name, and
  // alphabetical order would silently make it the top result.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

export function sortCompanies(rows: CompanyView[], sort: CompanySort | null): CompanyView[] {
  if (!sort) return rows;
  const dir = sort.dir === "asc" ? 1 : -1;
  const out = [...rows];
  out.sort((a, b) => {
    let cmp = 0;
    if (sort.field === "tier") {
      const at = a.tier, bt = b.tier;
      // Unknown tier is last regardless of direction — the ONE place `dir` is
      // deliberately not applied, so an unresolved row cannot be promoted by
      // flipping the arrow.
      if (at === null || bt === null) {
        if (at === bt) cmp = 0;
        else return at === null ? 1 : -1;
      } else {
        cmp = at - bt;
      }
      if (cmp === 0) {
        cmp = CONFIDENCE_RANK[resolutionConfidence(a)] - CONFIDENCE_RANK[resolutionConfidence(b)];
      }
    } else if (sort.field === "name") {
      cmp = cmpText(a.name, b.name);
      if (!a.name && !b.name) return a.id - b.id;
      if (!a.name || !b.name) return cmp; // absence stays last in both directions
    } else {
      cmp = cmpText(a[sort.field], b[sort.field]);
      const av = a[sort.field], bv = b[sort.field];
      if (!av && !bv) return a.id - b.id;
      if (!av || !bv) return cmp;
    }
    // A stable, total order: without the id tiebreak two rows equal on the sort
    // field swap places between renders and the grid appears to shuffle itself.
    return cmp * dir || a.id - b.id;
  });
  return out;
}

// ---------------------------------------------------------------- personas

/**
 * Persona seeds — one gesture that sets the working set AND the sort.
 *
 * Named for what they DO rather than for whose universe they were derived from,
 * since anyone may pick any of them (presets.ts's convention).
 */
export type CompanyPersona = {
  id: "owner" | "dad" | "roommate";
  name: string;
  set: CompanySet;
  sort: CompanySort | null;
  /** What this seed is for, shown under its name in the menu. */
  hint: string;
};

export const COMPANY_PERSONAS: CompanyPersona[] = [
  {
    id: "owner",
    name: "Everything, day-of first",
    set: "all",
    sort: { field: "tier", dir: "asc" },
    hint: "The whole universe, most reliable rows on top.",
  },
  {
    id: "dad",
    // The research pass's finding: Dad's universe is a RECALL problem — heavy on
    // corporate ATSs and long-tailed — so the proposals queue is the work, and
    // reading it alphabetically is how a person checks off a list of employers.
    name: "Review the pile, A–Z",
    set: "review",
    sort: { field: "name", dir: "asc" },
    hint: "Proposals awaiting a yes or no, in name order.",
  },
  {
    id: "roommate",
    // The opposite finding: 25/30 of his sample resolved directly, so his
    // universe is already good and what matters is seeing which rows are proven.
    name: "Confirmed boards first",
    set: "universe",
    sort: { field: "tier", dir: "asc" },
    hint: "Approved companies, confirmed boards on top.",
  },
];
