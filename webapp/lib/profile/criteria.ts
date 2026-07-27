/**
 * The Search Profile as it lives in `profiles.criteria` (jsonb, 0001_init.sql).
 *
 * Key names are the PYTHON ones — `yoe_max`, not `yoeMax` — because
 * `core/profile.py` and `monitor/gates.py` are the schema owners: the same blob
 * has to be readable by the engine that gates on it, and a camelCase mirror
 * would be a translation layer nobody maintains. It is also why
 * `GateCriteriaInput` in `lib/gating/dispose.ts` accepts exactly these keys.
 *
 * `criteria = '{}'` is not a profile with defaults — it is the "never
 * onboarded" state, which is what the middleware redirect turns on. Those two
 * have to stay distinguishable: a user who deliberately widened every setting
 * looks identical to one who never arrived if the empty object is silently
 * filled in.
 */
import { METRO_NAMES } from "./metros";

export type GeoUnknownPolicy = "filter" | "keep";
export type YoeUnknownPolicy = "seniority-proxy" | "keep";
export type CompUnknownPolicy = "keep" | "filter";

export type ProfileCriteria = {
  /** What this person is looking for, in words. Drives the tagger's prompt. */
  role_family: string;
  /** What the tagger is told it is reading — "product-manager" | "finance" | … */
  tag_domain: string;
  /** The term corpus-wide boards (Workday et al) are searched with. */
  board_search_term: string;

  titles_include: string[];
  titles_exclude: string[];

  countries: string[];
  /** Empty = anywhere within `countries`. Non-empty narrows to a LOCAL search. */
  metros: string[];
  geo_unknown: GeoUnknownPolicy;

  yoe_max: number;
  yoe_unknown: YoeUnknownPolicy;
  seniority_exclude: string[];

  /** Floor in $thousands. 0 = the gate does not run. */
  comp_min: number;
  comp_unknown: CompUnknownPolicy;
  work_model_exclude: string[];
};

/**
 * The committed baseline (`core/config_defaults.yaml` → `Profile`'s dataclass
 * defaults), which is what a brand-new draft starts from.
 *
 * NOT what an empty `criteria` means. A `{}` row has never been onboarded and
 * the app redirects it to the wizard; these values are the wizard's step-1
 * starting point, not a silent stand-in for a profile that does not exist.
 */
export const BASE_CRITERIA: ProfileCriteria = {
  role_family: "product manager",
  tag_domain: "product-manager",
  board_search_term: "product",
  titles_include: [],
  titles_exclude: [],
  countries: ["United States"],
  metros: [],
  geo_unknown: "filter",
  yoe_max: 4,
  yoe_unknown: "seniority-proxy",
  seniority_exclude: [],
  comp_min: 0,
  comp_unknown: "keep",
  work_model_exclude: [],
};

/** Longest a single chip may be. A pasted paragraph is not a job title. */
export const MAX_CHIP_LENGTH = 120;
/** How many chips one list may hold. Salman's real list is 15; Dad's is 16. */
export const MAX_CHIPS = 60;
/** The highest years-of-experience ceiling worth expressing. Dad's is 30. */
export const MAX_YOE = 60;
/** $thousands. Above this a floor is a typo, not a preference. */
export const MAX_COMP_MIN_K = 2000;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const s = typeof value === "string" ? value.trim() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

function chipList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim().slice(0, MAX_CHIP_LENGTH);
    if (!s) continue;
    // De-duplicated case-insensitively: two chips differing only in case are
    // one filter to the gate (`title_matches` lowercases both sides), and a
    // list that shows the same term twice reads as a bug in the wizard.
    if (out.some((existing) => existing.toLowerCase() === s.toLowerCase())) continue;
    out.push(s);
    if (out.length >= MAX_CHIPS) break;
  }
  return out;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * A short free-text field, where **empty is a legitimate answer**.
 *
 * It used to fall back to `BASE_CRITERIA`'s value on an empty string, and that
 * made "Something else" a lie: the preset sets `role_family`, `tag_domain` and
 * `board_search_term` to `""` on purpose, and every one of them came back out
 * of here as "product manager" / "product-manager" / "product". Somebody who
 * told the wizard they were looking for something else had a product-management
 * search stored under their name, and nothing on any screen said so.
 *
 * A non-string still falls back, because that is a malformed request rather than
 * an answer. Only a deliberate empty string survives.
 */
function text(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, MAX_CHIP_LENGTH);
}

/**
 * Closed-set validation at the boundary.
 *
 * A server action is a public endpoint and `ProfileCriteria` is erased at
 * runtime (matrix row 38), so every value that reaches the database goes
 * through here: unknown keys are dropped, policies fall back to their defaults
 * rather than being written verbatim, and the two numbers are clamped. The
 * gate treats an unrecognised policy string as its else-branch, so writing one
 * would produce a profile whose behaviour nothing in the UI can describe.
 */
export function parseCriteria(raw: unknown): ProfileCriteria {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    role_family: text(r.role_family, BASE_CRITERIA.role_family),
    tag_domain: text(r.tag_domain, BASE_CRITERIA.tag_domain),
    board_search_term: text(r.board_search_term, BASE_CRITERIA.board_search_term),
    titles_include: chipList(r.titles_include, BASE_CRITERIA.titles_include),
    titles_exclude: chipList(r.titles_exclude, BASE_CRITERIA.titles_exclude),
    countries: chipList(r.countries, BASE_CRITERIA.countries),
    metros: chipList(r.metros, BASE_CRITERIA.metros),
    geo_unknown: oneOf(r.geo_unknown, ["filter", "keep"] as const, BASE_CRITERIA.geo_unknown),
    yoe_max: Math.trunc(boundedNumber(r.yoe_max, BASE_CRITERIA.yoe_max, 0, MAX_YOE)),
    yoe_unknown: oneOf(
      r.yoe_unknown,
      ["seniority-proxy", "keep"] as const,
      BASE_CRITERIA.yoe_unknown,
    ),
    seniority_exclude: chipList(r.seniority_exclude, BASE_CRITERIA.seniority_exclude),
    comp_min: boundedNumber(r.comp_min, BASE_CRITERIA.comp_min, 0, MAX_COMP_MIN_K),
    comp_unknown: oneOf(r.comp_unknown, ["keep", "filter"] as const, BASE_CRITERIA.comp_unknown),
    work_model_exclude: chipList(r.work_model_exclude, BASE_CRITERIA.work_model_exclude),
  };
}

/**
 * Has this user ever completed the wizard?
 *
 * `criteria = '{}'` is the signal, and it is read as "no keys at all" rather
 * than "matches BASE_CRITERIA" — the second reading would send somebody who
 * deliberately chose every default back through onboarding forever.
 */
export function isOnboarded(criteria: unknown): boolean {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) return false;
  return Object.keys(criteria as Record<string, unknown>).length > 0;
}

/** Metros a profile names that the engine has never heard of. */
export function unknownMetros(criteria: ProfileCriteria): string[] {
  return criteria.metros.filter((m) => !METRO_NAMES.includes(m));
}

/**
 * Is this profile answerable — i.e. does it say what the person is looking for?
 *
 * `role_family` drives the tagger's prompt and `titles_include` is what the
 * sweep matches a posting's title against, so a profile missing either is one
 * the engine cannot act on. The wizard gates Next on this rather than filling
 * the gap in silently, which is what `text()` above used to do.
 */
export function describesASearch(criteria: ProfileCriteria): boolean {
  return criteria.role_family.trim() !== "" && criteria.titles_include.length > 0;
}
