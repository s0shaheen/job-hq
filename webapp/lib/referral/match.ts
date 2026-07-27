/**
 * Matching the user's 1st-degree connections to the companies on their rows.
 *
 * One rule, and it is the same rule the database enforces: the join key is
 * `company_name_key`, never the raw string and never `lower()`. 0008 paid for
 * that lesson three times — 'Aon' and 'aon' pasted in two sessions became two
 * companies, a name copied out of a web page carried a trailing NBSP that
 * `btrim()` does not strip, and an already-grounded name failed to collide with
 * itself. A connections export is the same kind of data from the same kind of
 * place: `Goldman<NBSP>Sachs` is what a browser leaves in a cell.
 *
 * `connections.company_key` is a GENERATED column in SQL, so the connection side
 * of the comparison cannot drift. This module normalizes the OTHER side — the
 * posting's or the application's `company` string — with the TypeScript mirror
 * of the same function, which `parity.test.ts` pins character by character.
 */
import { companyNameKey } from "@/lib/data/view-models";
import type { CompanyView, ConnectionView } from "@/lib/data/view-models";

/**
 * Connections grouped by the normalized company they work at.
 *
 * A `Map` rather than an object: company keys come out of user data and
 * `__proto__` is a company name somebody could type. It is also the shape every
 * caller wants — one build per render, then O(1) per row.
 */
export type ConnectionIndex = Map<string, ConnectionView[]>;

/**
 * How many names to show before the popover starts counting instead.
 *
 * Somebody with 3,000 connections has a few dozen at a big bank, and a popover
 * listing all of them is a scroll trap over the one control the row exists for.
 */
export const MAX_LISTED_CONNECTIONS = 8;

export function indexConnections(connections: readonly ConnectionView[]): ConnectionIndex {
  const index: ConnectionIndex = new Map();
  for (const c of connections) {
    // The SQL column is authoritative when present — it IS `company_name_key`
    // computed by Postgres. Recomputing it here when it is missing is what keeps
    // the fixture source honest without giving it a second normalization: the
    // fake stores the same value the generated column would.
    //
    // THE STATED LIMIT, and this line is where it first becomes reachable.
    //
    // `company_name_key` has three implementations (SQL 0008, `core/companykeys.py`,
    // `lib/data/view-models.ts`) pinned to one corpus,
    // `tests/fixtures/company_name_key.golden.json` — which carries a MEASURED
    // divergence: Postgres's `lower()` folds U+0130 (İ, the Turkish dotted
    // capital I) to a bare `i`, while JS and Python fold it to `i` + U+0307. The
    // corpus records it as `sql_key`.
    //
    // Everywhere that divergence had appeared before, BOTH sides of the
    // comparison were computed by the same language: `reconcile_grounded_company`
    // is handed a raw name and keys it itself, so the match is Postgres-vs-
    // Postgres, and `test_a_documented_divergence_cannot_produce_a_wrong_match`
    // proves it is survivable there. Here the two sides come from different
    // languages for the first time in this codebase — the connection's key from
    // the generated column, the posting's from `companyNameKey` two lines down —
    // so a company whose name contains U+0130 is a silent NON-MATCH: the
    // connection is stored, indexed, and never found by the row it belongs to.
    //
    // It is a non-match rather than a wrong match, which is the right way round
    // (the failure is a missing warm path, not outreach sent to strangers), and
    // it is bounded to names carrying that one codepoint. Not fixed, because the
    // fix is to change one of three implementations of a key that is already
    // stored in a generated column and a unique index. Pinned instead, by
    // `referral-match.test.ts`, so it cannot get quietly worse.
    const key = c.companyKey || companyNameKey(c.company);
    if (!key) continue; // a connection with no employer matches no row
    const bucket = index.get(key);
    if (bucket) bucket.push(c);
    else index.set(key, [c]);
  }
  for (const bucket of index.values()) {
    // Alphabetical, so a row's popover reads the same on every render and a test
    // that pins the first name stays pinned. `localeCompare` on the full name,
    // matching the /companies grid's ordering contract.
    bucket.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id - b.id);
  }
  return index;
}

/** The connections at one row's company, by that row's company string. */
export function connectionsAt(index: ConnectionIndex, company: string): ConnectionView[] {
  const key = companyNameKey(company ?? "");
  if (!key) return [];
  return index.get(key) ?? [];
}

/**
 * The user's universe, keyed the same way and for the same reason.
 *
 * A posting's `company` is a string a board wrote; a universe row is one a human
 * curated. They are the same employer when their normalized keys agree, and not
 * otherwise.
 *
 * All three fields travel together because a row's cell needs all three at once:
 * the id to build links with, the `companies.id` a paste would write to, and the
 * SHARED row's version token that paste has to send back. Three separate lookups
 * over the same key is three chances to look one of them up for a different
 * company than the other two.
 */
export type UniverseEntry = {
  /** `companies.id` — what a paste writes to. */
  id: number;
  /** `companies.linkedin_company_id`, "" when nobody has pasted one. */
  linkedinCompanyId: string;
  /** The SHARED company row's optimistic-concurrency token. */
  companyUpdatedAt: string | null;
  /** The name as the universe spells it, for copy that names the company. */
  name: string;
};

export type UniverseIndex = Map<string, UniverseEntry>;

export function indexUniverse(companies: readonly CompanyView[]): UniverseIndex {
  const index: UniverseIndex = new Map();
  for (const c of companies) {
    const key = companyNameKey(c.name);
    if (!key) continue; // a slug-only row names no company to match against
    const seen = index.get(key);
    // TWO ROWS CAN SHARE A KEY FOR TWO REASONS, and only one of them is benign.
    //
    // The benign one: a single company legitimately has several universe rows — a
    // Greenhouse careers site and a Workday tenant are two rows and both are
    // true. Collapsing those is correct and is what this index is for.
    //
    // The other one, said out loud because an earlier version of this comment
    // framed the first as the only case: `companies_unresolved_name_key` (0008)
    // is PARTIAL on `ats = '' and slug = ''`, so two DIFFERENT companies that
    // happen to normalize to one key — `Apex` and `APEX`, two real firms — are
    // both legal once each is grounded. This index then hands a posting from one
    // of them the LinkedIn id of the other, and `linkedin.ts`'s own words for
    // that are "a wrong company id sends somebody's outreach to strangers at
    // another company".
    //
    // Inherent to keying on a normalized name, and NOT fixed here: the only real
    // fix is a per-posting company id, which is a schema change to `postings` and
    // an engine change to fill it. What is done instead is that the collapse is
    // deterministic (below) rather than plan-dependent, so at least the wrong
    // answer is the same wrong answer every render and a person who notices it
    // once can fix it by clearing the id. `referral-match.test.ts` covers the
    // hostile reading beside the benign one, so nobody re-derives this as a bug.
    //
    // The one carrying an id wins, because that is the row that can answer the
    // question; among equals the first wins, and `companies()` is ordered by name
    // then id, so "first" is deterministic.
    if (seen && (seen.linkedinCompanyId !== "" || c.linkedinCompanyId === "")) continue;
    index.set(key, {
      id: c.id,
      linkedinCompanyId: c.linkedinCompanyId,
      companyUpdatedAt: c.companyUpdatedAt,
      name: c.name,
    });
  }
  return index;
}

/**
 * The universe row behind a company string, or null when this user watches
 * nobody by that name.
 *
 * Null is a real state rather than an edge: a posting can arrive through the
 * wide net from a company nobody has added, and it is the reason the cell says
 * "you are not tracking this yet" instead of offering a paste box with nowhere
 * to write.
 */
export function universeFor(index: UniverseIndex, company: string): UniverseEntry | null {
  const key = companyNameKey(company ?? "");
  if (!key) return null;
  return index.get(key) ?? null;
}

/** The compact summary the grid cell shows: `2 1st-degree` / `Search` / `Add ID`. */
export type WarmSummary = {
  /** 1st-degree connections at this company. */
  firstDegree: number;
  /** Whether a company id exists, so deep links can be built at all. */
  hasCompanyId: boolean;
  /** Whether a paste has anywhere to go. */
  inUniverse: boolean;
};

export function warmSummary(
  company: string,
  connections: ConnectionIndex,
  universe: UniverseIndex,
): WarmSummary {
  const row = universeFor(universe, company);
  return {
    firstDegree: connectionsAt(connections, company).length,
    hasCompanyId: (row?.linkedinCompanyId ?? "") !== "",
    inUniverse: row !== null,
  };
}

/**
 * Everything a surface needs to render warm paths, built once per page render.
 *
 * One builder rather than three call sites assembling the same three things, so
 * /jobs and /pipeline cannot disagree about what a warm path is.
 */
export type WarmContext = {
  connections: ConnectionIndex;
  universe: UniverseIndex;
  /**
   * Whether the user has imported an export at all.
   *
   * Distinct from "no connections at this company", and the distinction is the
   * whole point: one is a fact about the company, the other is a thing to go and
   * do. Collapsing them is how a working feature convinces somebody it is broken
   * (matrix row 15).
   */
  hasAnyConnections: boolean;
};

export function buildWarmContext(
  companies: readonly CompanyView[],
  connections: readonly ConnectionView[],
): WarmContext {
  return {
    connections: indexConnections(connections),
    universe: indexUniverse(companies),
    hasAnyConnections: connections.length > 0,
  };
}
