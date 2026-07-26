/**
 * URL state for the /companies grid: working set, quick search, sort.
 *
 * The URL is the source of truth (matrix row 19 / criterion 22) — the grid holds
 * no copy, so Back/Forward and a pasted link cannot disagree with what is on
 * screen. This is a much smaller grammar than `lib/grid/url-state.ts`, which
 * carries the /jobs filter-clause language; deliberately so, since P7 ships
 * working sets and a search rather than a clause builder.
 *
 * Two rules are carried over verbatim because they cost real bugs on /jobs:
 *
 *   1. **A malformed parameter is DROPPED, never "repaired".** A `?set=banana`
 *      link renders the default set; it does not guess at which set was meant, and
 *      it does not crash (matrix row 55). Silently repairing a bad param shows a
 *      user rows they did not ask for under a URL that promises otherwise.
 *   2. **`parse(serialize(s)) === s` for every state.** Round-tripping is what
 *      makes a shared link reproducible, and the unit test asserts it over values
 *      containing the characters that break naive encoders.
 *
 * Unlike /jobs' `presetUrl`, `serializeCompanyState` OMITS the default set rather
 * than always emitting it. /jobs needs an explicit `set=` because a saved landing
 * view can otherwise make the plain Queue unreachable (matrix row 65); this surface
 * has no landing views, so bare `/companies` unambiguously means the review set —
 * and an omitted default keeps the canonical URL short.
 */
import type { CompanyView } from "@/lib/data/view-models";
import { sourceLabel } from "@/lib/data/view-models";
import {
  DEFAULT_COMPANY_SET,
  isCompanySet,
  isCompanySortField,
  type CompanySet,
  type CompanySort,
} from "@/lib/grid/company-presets";

export type CompanyUrlState = {
  set: CompanySet;
  q: string;
  sort: CompanySort | null;
};

export const EMPTY_COMPANY_STATE: CompanyUrlState = {
  set: DEFAULT_COMPANY_SET,
  q: "",
  sort: null,
};

/** Read the grid's state out of a query string. Unreadable values are dropped. */
export function parseCompanyState(params: URLSearchParams): CompanyUrlState {
  const rawSet = params.get("set") ?? "";
  const set = isCompanySet(rawSet) ? rawSet : DEFAULT_COMPANY_SET;

  // Trimmed on the way in so `?q=%20%20` is the same state as no query at all —
  // otherwise the grid claims to be filtered while showing everything, and the
  // Clear control appears with nothing to clear.
  const q = (params.get("q") ?? "").trim();

  let sort: CompanySort | null = null;
  const rawSort = params.get("sort") ?? "";
  if (rawSort) {
    const [field, dir] = rawSort.split(":");
    // Half-valid is not valid: a recognised field with a bogus direction applies
    // NOTHING, rather than half-applying an order nobody asked for.
    if (isCompanySortField(field) && (dir === "asc" || dir === "desc")) {
      sort = { field, dir };
    }
  }

  return { set, q, sort };
}

/**
 * Write the state back into a query string, preserving any foreign parameters in
 * `base` — dropping those would swap the dataset out from under anything else
 * reading the URL.
 */
export function serializeCompanyState(
  state: CompanyUrlState,
  base?: URLSearchParams,
): string {
  const p = new URLSearchParams(base ?? undefined);
  // The default set is omitted, not spelled out: bare /companies means it.
  if (state.set === DEFAULT_COMPANY_SET) p.delete("set");
  else p.set("set", state.set);

  const q = state.q.trim();
  if (q) p.set("q", q);
  else p.delete("q");

  if (state.sort) p.set("sort", `${state.sort.field}:${state.sort.dir}`);
  else p.delete("sort");

  return p.toString();
}

/**
 * Quick search over the fields a person actually types into this box.
 *
 * `sourceLabel` is searched as well as the raw tag, because the grid SHOWS the
 * label: someone reading "Common Crawl" in the Found-via column and typing it must
 * match, even though the stored value is `commoncrawl`. A search box that cannot
 * find what is on screen reads as broken.
 *
 * Every term must match somewhere (AND), which is how a two-word query narrows
 * rather than widens — `quickSearch` on /jobs behaves the same way.
 */
export function searchCompanies(rows: CompanyView[], query: string): CompanyView[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((c) => {
    const haystack = [
      c.name,
      c.ats,
      c.slug,
      c.source,
      sourceLabel(c.source),
      c.resolutionMethod,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
