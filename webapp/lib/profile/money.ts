/**
 * Pay: dollars on the screen, thousands in the profile.
 *
 * `comp_min` is stored in $thousands because that is what the gate reads —
 * `dispose()` compares it against a posting's band and stamps `comp:<120k` into
 * the audit trail, and `core/profile.py` writes the same unit. That contract is
 * not up for negotiation, so the translation happens HERE, at the one boundary
 * where a person types a number.
 *
 * The field used to expose the storage unit directly, labelled "Minimum pay, in
 * thousands" with a max of 2000. The owner read that as a $2,000 ceiling on his
 * own first run, which is the correct reading of what it said. A person types
 * "200000" or "200k" or "$200,000"; all three mean the same thing and none of
 * them mean 200.
 */
import { MAX_COMP_MIN_K } from "./criteria";

/** The same ceiling as `MAX_COMP_MIN_K`, said in the unit people type. */
export const MAX_COMP_MIN_DOLLARS = MAX_COMP_MIN_K * 1000;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** `200000` -> `"$200,000"`. What the field shows once it is not being typed in. */
export function formatDollars(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars <= 0) return "";
  return usd.format(Math.round(dollars));
}

/**
 * What somebody typed, in dollars, or `null` if it is not a number at all.
 *
 * Accepts `$`, commas, spaces and a trailing `k`/`m`, because those are the
 * forms people actually write a salary in. An empty box is 0 rather than `null`:
 * clearing the field is how you turn the floor off, and treating that as junk
 * would leave the old value in place while the box looked empty.
 *
 * `"200"` is two hundred dollars, not two hundred thousand. Guessing the
 * intended magnitude is the mistake this function replaced; the formatted
 * `"$200"` that comes back is what makes a slip visible.
 */
export function parseDollars(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return 0;

  const cleaned = s.replace(/[$,\s_]/g, "");
  // Decoration with no digits yet — a lone `$`, a stray comma — is a field
  // halfway through being typed, not junk. Calling it junk lit the warning
  // under the box on the first keystroke of `$200,000`.
  if (!cleaned) return 0;

  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(cleaned);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;

  const scale = m[2] === "k" || m[2] === "K" ? 1_000 : m[2] === "m" || m[2] === "M" ? 1_000_000 : 1;
  return Math.min(Math.round(n * scale), MAX_COMP_MIN_DOLLARS);
}

/** Storage unit -> screen unit. */
export function dollarsFromK(k: number): number {
  if (!Number.isFinite(k) || k <= 0) return 0;
  return Math.round(k * 1000);
}

/**
 * Screen unit -> storage unit.
 *
 * Not rounded to whole thousands. `parseCriteria` clamps `comp_min` without
 * truncating it and the gate reads it as a float, so a $205,500 floor survives
 * as 205.5 rather than being silently moved to a number the person did not type.
 */
export function kFromDollars(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.min(Math.round(dollars) / 1000, MAX_COMP_MIN_K);
}
