/**
 * The coverage meter's arithmetic — pure, no React, so the one thing it must not
 * get wrong is unit-testable.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not report recall. docs/plans/COMPANY-DISCOVERY.md's demo moment is
 * *"210 companies, 94% of the Chicago treasury-posting universe"* — and that
 * denominator comes from the TheirStack coverage oracle (`monitor/oracle.py`),
 * which is a keyed Python job that nothing in this app can call. A percentage of
 * an unknown universe is not a measurement, so `OracleSlot` below is an
 * explicitly-empty, explicitly-labelled hole rather than a number. The research
 * pass's own denominators are marked "Estimate-only (no key)"; printing one here
 * as if it were measured is the single most damaging thing this surface could do.
 *
 * What it DOES report is grounded in rows that exist: how many companies are in
 * the universe, how they split across the three reliability tiers, how many are
 * unresolved — and, crossing that, HOW EACH TIER WAS ESTABLISHED.
 *
 * That second axis is the point. From
 * docs/plans/COMPANY-DISCOVERY-RESEARCH.md's "critical UX caveat": a meter built
 * on `reliability_tier` alone "would render T1's soft estimate as if measured".
 * The research's Dad figure was 47% grounded against ~75% best-estimate — a 28pp
 * gap hiding inside one tier number. So every count here comes paired with its
 * confidence breakdown, and `verifiedTier1` (the only number that means "we have
 * actually pulled jobs from this board") is computed separately from `tier1`.
 */
import type { CompanyView, ResolutionConfidence } from "@/lib/data/view-models";
import { resolutionConfidence } from "@/lib/data/view-models";

export type TierCount = {
  tier: 1 | 2 | 3;
  count: number;
  /** Of those, how many were established by a board call that answered. */
  verified: number;
  /** Of those, how many rest on a fingerprint with no first-party call. */
  inferred: number;
  /** Of those, how many are a slug or name taken on trust and never re-probed. */
  asserted: number;
};

export type Coverage = {
  /** Companies in the universe this meter describes. */
  total: number;
  /** Companies with any reliability tier at all. */
  resolved: number;
  /** Companies the waterfall has not grounded (tier null). */
  unresolved: number;
  byTier: [TierCount, TierCount, TierCount];
  /**
   * Tier 1 rows whose tier came from a board API that answered — the only
   * "day-of" figure that is evidence rather than an expectation.
   */
  verifiedTier1: number;
  /** Every row's confidence, tallied, tiers included. */
  byConfidence: Record<ResolutionConfidence, number>;
};

function emptyTier(tier: 1 | 2 | 3): TierCount {
  return { tier, count: 0, verified: 0, inferred: 0, asserted: 0 };
}

/**
 * Tally a set of companies.
 *
 * The input is whatever set the caller is describing — the grid passes the
 * APPROVED universe, because a proposal nobody has accepted is not coverage of
 * anything. Passing a different set changes the meaning of every number, so the
 * component states which set it counted.
 */
export function computeCoverage(companies: readonly CompanyView[]): Coverage {
  const byTier: [TierCount, TierCount, TierCount] = [emptyTier(1), emptyTier(2), emptyTier(3)];
  const byConfidence: Record<ResolutionConfidence, number> = {
    verified: 0,
    inferred: 0,
    asserted: 0,
    unresolved: 0,
  };
  let resolved = 0;

  for (const c of companies) {
    const confidence = resolutionConfidence(c);
    byConfidence[confidence] += 1;
    // A row whose tier is set but whose method is unreadable comes back
    // "unresolved" from resolutionConfidence, and it must NOT be counted into a
    // tier bucket here — that would put a row in "Tier 1 · day-of" whose
    // day-of-ness nothing supports. `resolved` keys off the confidence, not off
    // the tier column, so the two can never disagree.
    if (c.tier === null || confidence === "unresolved") continue;
    resolved += 1;
    const bucket = byTier[c.tier - 1];
    bucket.count += 1;
    if (confidence === "verified") bucket.verified += 1;
    else if (confidence === "inferred") bucket.inferred += 1;
    else bucket.asserted += 1;
  }

  return {
    total: companies.length,
    resolved,
    unresolved: companies.length - resolved,
    byTier,
    verifiedTier1: byTier[0].verified,
    byConfidence,
  };
}

/**
 * Share of the total, as a percentage, rounded to a whole number — and 0 when
 * there is nothing to divide by.
 *
 * `total === 0` returning 0 rather than NaN matters: an empty universe renders a
 * meter, and "NaN%" on the first screen a new user sees is the app looking
 * broken on the one surface whose job is telling them how well it is doing.
 */
export function sharePct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * The oracle's slot: named, sized, and empty until a measurement exists.
 *
 * `monitor/oracle.py` computes `recall = 1 − gap_D/D` against TheirStack's
 * blurred denominator, live-verified 2026-07-24. Nothing writes that result into
 * a table the web app reads, so this surface has no honest number to show. The
 * slot exists so the absence is VISIBLE — a meter that simply omitted recall
 * would read as "coverage: 84%" and be understood as recall by every human who
 * saw it.
 */
export type OracleSlot = {
  /** Which facet's universe would be measured, e.g. "Chicago finance". */
  facet: string | null;
  /** Distinct companies posting into that facet. Null until the oracle runs. */
  denominator: number | null;
  /** 1 − gap_D/D. Null until the oracle runs. */
  recallPct: number | null;
};

/** The only honest value today: an empty slot with its reason attached. */
export const ORACLE_UNMEASURED: OracleSlot = { facet: null, denominator: null, recallPct: null };
