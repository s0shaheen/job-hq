/**
 * The per-user bounds, app side (#261).
 *
 * Charged through `DataSource.chargeRateBound(meter)`, which is the seam that
 * lets the mechanism reach SERVER ACTIONS and ROUTE HANDLERS and not only `app_*`
 * RPCs — quick-add's resolve (a server action) and `/api/export` (a route) both
 * write nothing, so neither has a command to charge inside, and for both the
 * capability exists only in this process.
 *
 * The BOUNDS THEMSELVES DO NOT LIVE HERE. They live in `public.rate_bounds`
 * (`db/migrations/20260817_011844_per_user_rate_bounds.sql`), and that is the
 * decision rather than an accident of where the code went: a browser holds the
 * anon key and can POST straight to `/rest/v1/rpc/app_*`, so any number this
 * process supplies is a number the caller could have supplied instead. The
 * database owns the limit; this module owns the NAMES, the SQLSTATE, and the
 * sentence a person reads.
 *
 * The one thing this side may do is make a bound STRICTER. `p_max` on
 * `app_charge_rate_bound` is clamped `least(coalesce(p_max, max_units),
 * max_units)` in SQL, so an env override can tighten a meter for a deploy
 * without a database write and can never loosen one. That asymmetry is the
 * whole of the override contract.
 *
 * THE CLASS IS DECIDED; THE NUMBERS ARE STILL PLACEHOLDERS, and the two were
 * always separate questions — the CLASS decides the code and the value only
 * decides the threshold. ADR-015 Q2, owner ruling on #210 dated 2026-08-18,
 * answered the first for every meter at once: these limits are PROVIDER-SPEND
 * AND ABUSE PROTECTION, never commercial quotas, so a founding account is
 * subject to all of them and nothing in this lane may read `invited`. The
 * second is still open — every seeded row carries `is_placeholder = true` and a
 * test asserts it. There is still nothing to change here when the owner picks
 * the numbers: it is one UPDATE against `public.rate_bounds`.
 */

/**
 * The SQLSTATE `hq_charge_rate_bound` raises over a bound.
 *
 * A custom 5-char code matched on `error.code`, never on message text —
 * `WARM_CAP_SQLSTATE`'s reasoning exactly (`lib/warm/config.ts`). PostgREST
 * carries the SQLSTATE through as `error.code`, the meter through as
 * `error.details`, and the retry horizon through as `error.hint`.
 *
 * NOT `HQCAP`, and the difference is load-bearing. `HQCAP` means "you have used
 * your N warm searches for today" and renders its own designed state. The two
 * bounds are the same CLASS since ADR-015 Q2 (both provider-spend, both applying
 * to founding accounts), and they still get different codes: a burst bound, an
 * in-flight bound and a daily cap are three refusals with three different
 * resets, and fusing them would make one sentence lie about the others. The
 * class settles WHO a bound applies to, not what it says when it bites.
 */
export const RATE_BOUND_SQLSTATE = "HQBND";

/** The catalogued meters. One string, one place, matched against `rate_bounds`. */
export const METERS = {
  /** Quick-add's resolve step: user-driven OUTBOUND fetch, up to 25 pages a call. */
  quickaddResolve: "quickadd.resolve",
  /** Starting a warm search: vendor spend, ~$0.30 an Apify run. */
  warmStart: "warm.start",
  /**
   * Warm searches in flight at once: live state, not a window counter.
   *
   * NEVER pass this to `chargeRateBound` — it is catalogued `is_chargeable =
   * false` and the RPC raises `22023` for it. It appears here only so the
   * refusal it raises from inside `app_start_warm_search` (HQBND, with
   * `warm.concurrent` in `details`) resolves to a sentence. Charging it was a
   * free-row primitive before the flag existed: a 1-second window plus a
   * `(user_id, meter, window_start)` key is 86,400 durable rows a day.
   */
  warmConcurrent: "warm.concurrent",
  /**
   * Building an export file: a small POST that regenerates the caller's whole
   * CSV or XLSX server-side, up to 999 rows, with no payload bound in front of
   * it. Amplification against our own capacity.
   */
  exportBuild: "export.build",
} as const;

export type MeterName = (typeof METERS)[keyof typeof METERS];

/** `quickadd.resolve` → `HQ_RATE_MAX_QUICKADD_RESOLVE`. */
function envNameFor(meter: MeterName): string {
  return `HQ_RATE_MAX_${meter.replace(/[.-]/g, "_").toUpperCase()}`;
}

/**
 * A tighter limit for this deploy, or `null` for "whatever the catalog says".
 *
 * Read here rather than in SQL because it is a deploy-time knob and the
 * database has no environment. Ignored unless it is a positive integer: a
 * malformed override must not silently become a bound of zero, which would wedge
 * the capability it was meant to damp.
 */
export function envMax(meter: MeterName): number | null {
  const raw = Number(process.env[envNameFor(meter)]);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * What the person reads.
 *
 * The database's own message names the meter and the numbers — subsystem
 * language, and CLAUDE.md's rule is that a refusal says what to do rather than
 * what said no. So the sentence is built here, from the meter, and the
 * database's `hint` (an ISO instant) is deliberately NOT rendered: there is no
 * approved design state anywhere for a countdown or a "try again at HH:MM"
 * affordance, and inventing one is forbidden. "In a few minutes" is what the
 * shipped surfaces can say today.
 */
const SENTENCES: Record<MeterName, string> = {
  [METERS.quickaddResolve]:
    "Too many link checks in a short time. Wait a few minutes and try again.",
  [METERS.warmStart]:
    "Too many warm searches in a short time. Wait a few minutes and try again.",
  [METERS.warmConcurrent]:
    "You already have warm searches running. Wait for one to finish, or cancel it.",
  [METERS.exportBuild]:
    "Too many exports in a short time. Wait a few minutes and try again.",
};

const FALLBACK = "Too many requests in a short time. Wait a few minutes and try again.";

/**
 * The sentence for a refusal, from the meter PostgREST carried in `details`.
 *
 * Falls back rather than throwing: a bound added to the catalog before this map
 * learns its name must still refuse the user in plain English. Falling back is
 * the failure this can afford; a thrown error inside an error path is not.
 */
export function rateBoundMessage(details: string | null | undefined): string {
  const meter = (details ?? "").trim();
  return (SENTENCES as Record<string, string>)[meter] ?? FALLBACK;
}

/** Did PostgREST hand back a rate-bound refusal? Matched on the code, never the text. */
export function isRateBound(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === RATE_BOUND_SQLSTATE;
}
