/**
 * The per-page context the on-demand warm-intro cell needs, built once server-
 * side and passed to every row — the layer-2 sibling of `buildWarmContext`
 * (`lib/referral/match.ts`), which does the same for layer 0.
 *
 * PURE and client-importable on purpose. It carries only value types
 * (`companyNameKey`, `deriveWarmParams`) and takes its view types (`WarmPinView`,
 * `ProfileCriteria`) type-only, so the client grid can import `pinsForRow` without
 * dragging the `server-only` reader into a browser bundle — the same boundary
 * `lib/referral/match.ts` respects.
 *
 * Two lookups because a pin is matched to a row two ways, in order: by the row's
 * exact posting key first, then by normalized company name. The fallback is what
 * lets a pin made on a /jobs posting show on the same company's /pipeline card,
 * where the posting key differs but the employer does not.
 *
 * A row now carries a SET of pins, not one: the finder's multi-select pins every
 * checked candidate. So each lookup holds an ARRAY per key and `pinsForRow`
 * returns the whole set — the exact-posting matches when the row has any, else the
 * company-level fallback.
 */
import { companyNameKey } from "@/lib/data/view-models";
import { deriveWarmParams, type WarmParams } from "@/lib/warm/types";
import type { ProfileCriteria } from "@/lib/profile/criteria";
import type { WarmPinView } from "@/lib/data/source";

export type WarmIntroContext = {
  /** Pins that name a specific posting, grouped by that posting's key. */
  pinsByPostingKey: Map<string, WarmPinView[]>;
  /** Every pin, grouped by normalized company — the company-level fallback. */
  pinsByCompanyKey: Map<string, WarmPinView[]>;
  /** The three persona strings a fresh search starts from. */
  defaultParams: WarmParams;
};

/** Title-case a free-text role_family for display ("product manager" → "Product Manager"). */
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The role a search runs on, from the user's profile. A concrete included title
 * wins (it is what the person actually calls the job); a bare role family is the
 * fallback, title-cased; and a profile that says neither is UNSET — `""`, which
 * the warm cell surfaces as "Not listed" and refuses to search on until the
 * person types one. It used to land on the deployment owner's own role, which
 * mislabelled every other user's warm search (RM-40 vault audit §3a / §9 Step 4).
 */
export function roleFromCriteria(criteria: ProfileCriteria | null): string {
  const title = criteria?.titles_include?.[0];
  if (typeof title === "string" && title.trim() !== "") return title.trim();
  const family = criteria?.role_family;
  if (typeof family === "string" && family.trim() !== "") return titleCase(family.trim());
  return "";
}

export function buildWarmIntroContext(
  pins: readonly WarmPinView[],
  criteria: ProfileCriteria | null,
): WarmIntroContext {
  const pinsByPostingKey = new Map<string, WarmPinView[]>();
  const pinsByCompanyKey = new Map<string, WarmPinView[]>();
  const push = (map: Map<string, WarmPinView[]>, key: string, pin: WarmPinView) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(pin);
    else map.set(key, [pin]);
  };
  // `warmPins()` is ordered by id ascending, so each bucket stays id-ascending —
  // a stable render order for the pinned cell's name list.
  for (const p of pins) {
    if (p.targetKind === "posting" && p.postingKey) push(pinsByPostingKey, p.postingKey, p);
    if (p.companyKey) push(pinsByCompanyKey, p.companyKey, p);
  }
  return { pinsByPostingKey, pinsByCompanyKey, defaultParams: deriveWarmParams(roleFromCriteria(criteria)) };
}

/**
 * Every pin for one row: the exact-posting-key set when the row has any, else the
 * company-level fallback set. A row that matches by posting key does NOT also fold
 * in the company set — the posting pins are the specific answer, the same
 * "posting first, company second" precedence the single-pin lookup had.
 */
export function pinsForRow(
  ctx: WarmIntroContext,
  row: { postingKey: string; company: string },
): WarmPinView[] {
  if (row.postingKey) {
    const byPosting = ctx.pinsByPostingKey.get(row.postingKey);
    if (byPosting && byPosting.length > 0) return byPosting;
  }
  const key = companyNameKey(row.company);
  if (!key) return [];
  return ctx.pinsByCompanyKey.get(key) ?? [];
}
