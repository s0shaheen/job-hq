/**
 * `monitor/comp.py`, ported. The compensation parser the gate judges a floor
 * with.
 *
 * Ported rather than called, for the reason `docs/plans/PHASE-PROFILE.md` §1
 * settles: the app is a Next.js server on Vercel and the engine is a Lambda on
 * a cron, so reaching the Python one from a page render means an unbounded
 * external dependency inside the request path — the rule three outages in one
 * day already bought. What keeps the two honest is
 * `tests/fixtures/gate-corpus.json`, run from both languages.
 *
 * Deliberately conservative, exactly as the original: anything that does not
 * parse cleanly is `[null, null]` — "unknown" — which the gate then treats
 * under an explicit policy knob. With ~48% of live postings stating no comp at
 * all, an aggressive parser hides far more real jobs than a shy one.
 *
 * plans/README C7 names this file as the ONE comp parser in the web app.
 * `supabase-source.ts` wraps it for the grid's display columns and adds a
 * non-dollar rule on top; the rule stays out of here, because the gate is
 * mirroring Python and Python has no such rule.
 */
import { casefold, pyStrip } from "./py";

/** A money token: $150,000 / 150000 / $150k / 150K */
const MONEY = /\$?\s*(\d[\d,]*\.?\d*)\s*([kK])?/g;
/** Hourly/daily rates must never be read as salaries. */
const NON_ANNUAL = /\b(hour|hourly|\/hr|per hour|day|daily|week|weekly|month|monthly)\b/i;

/** below this it isn't an annual salary in $k */
export const MIN_PLAUSIBLE_K = 10;
/** above this it's a typo or equity, not base */
export const MAX_PLAUSIBLE_K = 2000;

function toK(raw: string, kSuffix: boolean): number | null {
  // Python's float() raises on junk and JavaScript's Number() answers NaN; the
  // regex above can only hand this digits, commas and at most one dot, so the
  // two agree on everything it can produce. The guard is here for the case the
  // regex is ever widened.
  const v = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  if (kSuffix) return v; // "150k" -> 150
  if (v >= 1000) return v / 1000; // "150000" -> 150
  return v; // bare "150" already reads as $150k
}

/**
 * comp_range -> [minK, maxK] in thousands of dollars.
 *
 * Either side may be null ("$150k+" has no ceiling; "up to $130k" has no
 * floor). Both null means unknown — never assume.
 */
export function parseComp(text: string | null | undefined): [number | null, number | null] {
  const s = pyStrip(text ?? "");
  if (!s || NON_ANNUAL.test(s)) return [null, null];

  const vals: number[] = [];
  // `matchAll` needs the /g flag and consumes lastIndex; the literal is module
  // scope, so reset it rather than trusting the previous caller.
  MONEY.lastIndex = 0;
  for (const m of s.matchAll(MONEY)) {
    const v = toK(m[1], Boolean(m[2]));
    if (v !== null && v >= MIN_PLAUSIBLE_K && v <= MAX_PLAUSIBLE_K) vals.push(v);
  }
  if (!vals.length) return [null, null];

  const low = casefold(s);
  if (vals.length === 1) {
    const v = vals[0];
    if (low.includes("up to") || /^(max|under|below)/.test(low)) return [null, v];
    if (s.includes("+") || low.includes("at least") || low.includes("starting") || low.includes("from"))
      return [v, null];
    return [v, v];
  }
  return [Math.min(...vals), Math.max(...vals)];
}

/**
 * Does this comp range clear a floor (in $k)? `null` = unknown.
 *
 * Judged on the range's TOP: a posting listed at $110-160k clears a $120k
 * floor, because the band the employer published includes it. Judging on the
 * bottom would filter out most real negotiating ranges.
 */
export function meetsFloor(text: string | null | undefined, floorK: number): boolean | null {
  const [lo, hi] = parseComp(text);
  if (lo === null && hi === null) return null;
  const ceiling = hi !== null ? hi : (lo as number);
  return ceiling >= floorK;
}
