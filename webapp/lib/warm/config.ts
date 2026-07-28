/**
 * Warm-intro finder knobs. Plain module — no `server-only`, no fetch — so the
 * route, the vendor, and the tests all read one number.
 */

/**
 * How many warm searches one user may start in a rolling 24 hours.
 *
 * The cap is on SPEND, not success: a started vendor run has usually already
 * incurred harvestapi's ~$0.10 per-page charge, so a cancelled or failed run
 * counts too. The number lives here (passed into `app_start_warm_search` as
 * `p_daily_cap`) rather than being hardcoded in SQL, so it is one edit — the
 * Config-knob philosophy, at the one place the webapp can enforce it. ~20/day is
 * ~$2–8/day at the brief's $0.10–0.40 per job, which is the intended ceiling.
 *
 * `HQ_WARM_DAILY_CAP` can override it in a deployment without a code change; a
 * bad value falls back to the default rather than taking the feature down (the
 * house rule for knobs).
 */
export const DEFAULT_WARM_DAILY_CAP = 20;

export function warmDailyCap(): number {
  const raw = Number(process.env.HQ_WARM_DAILY_CAP);
  return Number.isInteger(raw) && raw >= 1 && raw <= 1000 ? raw : DEFAULT_WARM_DAILY_CAP;
}

/**
 * The three personas a search fires, and the intended cost.
 *
 * Each persona is ONE harvestapi search PAGE — up to 25 Short-mode profiles for a
 * flat $0.10, billed even on zero results (the brief's central cost fact: cost
 * scales with QUERIES/PAGES, not results). The set is a constant so the cost is
 * visible and bounded: adding a persona is a deliberate edit that raises the price.
 */
export const WARM_PERSONA_COUNT = 3;

/**
 * Profiles fetched PER PERSONA per search — ONE page (harvestapi returns ≤25/page,
 * $0.10/page). Deliberately one page: 3 personas × 25 = 75 raw candidates, which
 * dedup down to the merged cap below, so raising the merged cap to 40 costs the SAME
 * ~$0.30/search (3 pages) — it does NOT multiply the bill. Only bumping THIS past 25
 * (a 2nd page per persona) would add $0.10/persona/page.
 */
export const WARM_PER_PERSONA_ITEMS = 25;

/**
 * How many merged, ranked candidates a search returns — a knob (`HQ_WARM_MAX_RESULTS`,
 * default 40, clamped 10..50). Raised from 10 on the owner's ask. The cost is
 * unchanged (see `WARM_PER_PERSONA_ITEMS`): 3 personas × 1 page = ~$0.30/search
 * regardless of this value, up to the ~75 raw candidates 3 pages can yield.
 */
export const DEFAULT_WARM_MAX_RESULTS = 40;

export function warmMaxResults(): number {
  const raw = Number(process.env.HQ_WARM_MAX_RESULTS);
  return Number.isInteger(raw) && raw >= 10 && raw <= 50 ? raw : DEFAULT_WARM_MAX_RESULTS;
}

/** The one bounded body the start route accepts (target + three short strings). */
export const WARM_MAX_START_BYTES = 4096;

/**
 * The SQLSTATE `app_start_warm_search` raises over the cap.
 *
 * A custom 5-char code, matched on `error.code` (not the message, which names the
 * number) exactly as the digest store matches `P0002` — so the route can render
 * the over-cap state without the message text becoming load-bearing. PostgREST
 * carries the SQLSTATE through as `error.code`.
 */
export const WARM_CAP_SQLSTATE = "HQCAP";

/** The over-cap sentence, one place, so the store and the UI say the same thing. */
export function warmOverCapMessage(cap: number): string {
  return `You have used your ${cap} warm searches for today. The count resets 24 hours after each search.`;
}
