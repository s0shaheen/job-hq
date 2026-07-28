/**
 * LinkedIn people-search deep links — layer 0 of the referral finder, and the
 * only layer this file will ever be.
 *
 * WHAT THIS IS
 *
 * Pure string construction. Every function here takes data the app already
 * holds and returns a `https://www.linkedin.com/...` URL for a PERSON to click
 * in their own logged-in browser. Nothing here fetches anything, holds a
 * session, reads a cookie, or sends a request. There is no network call in this
 * module and there must never be one.
 *
 * That is not squeamishness, it is the architecture (`docs/plans/REFERRAL-FINDER.md`):
 *
 *   layer 0  deep links clicked by the user + their official CSV export — the
 *            risk is zero because nothing automated touches LinkedIn at all.
 *   layer 1  vendor APIs that never touch the user's session — later, if ever.
 *   layer ∞  their `li_at` cookie, a page-reading extension, messaging-as-them
 *            — never built, permanently. Not a v2.
 *
 * hiQ ended with LinkedIn's ToS held enforceable; Proxycurl, a $10M-ARR API
 * vendor, chose shutdown over the fight; HeyReach and its USERS' accounts were
 * banned. The account these links open is the delivery channel for the whole
 * referral play, so its suspension is not a dial — it is the end of the feature.
 *
 * WHY IDs AND NOT NAMES
 *
 * `keywords=Ramp` returns everyone who has ever typed the word. The numeric
 * company id is what makes a search land on the company, and it is free to
 * obtain: the company page's "See all employees" link carries it as `f_C=<id>`.
 * The universe stores it once per company (`companies.linkedin_company_id`).
 *
 * WHY THIS FILE DISTRUSTS ITS OWN COLUMN
 *
 * `linkedin_company_id` is free-vocab at the column, by 0008's precedent — the
 * closed set lives in `app_set_linkedin_company_id`, because a table-wide CHECK
 * on a column the Python mirror bulk-upserts lets one unrecognised value fail a
 * 500-row chunk. The consequence lands here: a reader may not assume the column
 * holds digits, and this module refuses to build a URL out of anything else. A
 * guard at one end of a free-vocab column is a guard that stops working the day
 * something else writes to it.
 */

/** LinkedIn's people-search surface. Not configurable — there is one. */
const PEOPLE_SEARCH = "https://www.linkedin.com/search/results/people/";

/**
 * The connection-degree facet, as LinkedIn spells it.
 *
 * `F` first, `S` second, `O` third+. Named rather than numbered because the URL
 * carries the letters and a `1 | 2 | 3` type would mean translating in two
 * directions for no gain.
 */
export type Degree = "F" | "S" | "O";

export const DEGREE_LABELS: Record<Degree, string> = {
  F: "1st",
  S: "2nd",
  O: "3rd+",
};

/**
 * Every facet this builder knows how to express, which is every facet the design
 * brief's table names.
 *
 * `pastCompanyIds` and `schoolIds` are supported and **not currently supplied by
 * any surface** — see `warmLinks` below, which states exactly what would wire
 * them and why nothing does yet. They are covered by unit tests rather than left
 * as an untested promise.
 */
export type PeopleSearchFacets = {
  /** `currentCompany` — numeric LinkedIn company ids. */
  companyIds?: readonly string[];
  /** `pastCompany` — "used to work at", the ex-colleague signal. */
  pastCompanyIds?: readonly string[];
  /** `schoolFilter` — numeric LinkedIn school ids, the alum signal. */
  schoolIds?: readonly string[];
  /** `network` — connection degree. Empty or absent means no degree filter. */
  degrees?: readonly Degree[];
  /** `keywords` — free text, matched against the whole profile. */
  keywords?: string;
  /** `geoUrn` — LinkedIn's geo ids. Same shape as the others; unused today. */
  geoIds?: readonly string[];
};

/** A numeric LinkedIn entity id: digits, bounded, nothing else. */
const NUMERIC_ID = /^[0-9]{1,20}$/;

/**
 * Is this a LinkedIn entity id we are willing to put in a URL?
 *
 * Exported because the paste form validates with the SAME predicate the URL
 * builder enforces, rather than with a second regexp that can drift from it —
 * and because `app_set_linkedin_company_id` refuses exactly this set, so the
 * three layers (form, builder, database) agree by construction.
 */
export function isLinkedinId(value: string | null | undefined): boolean {
  return NUMERIC_ID.test((value ?? "").trim());
}

/**
 * Did the SWEEP write the id in this cell? (`companies.linkedin_id_source`, 0016.)
 *
 * A predicate rather than an inline comparison in `warm-cell.tsx`, because it decides
 * whether a person is offered a way to CHANGE an id, and the two ways of getting it
 * wrong are both invisible on screen:
 *
 *   * `=== "engine"` widened to `!== "human"` offers the control on a row whose
 *     provenance is unknown — telling somebody "the sweep set this ID" about a number
 *     the sweep may never have touched. Copy that asserts a thing it cannot know.
 *   * the check dropped entirely offers it on a HUMAN's own paste, which reopens the
 *     surface churn this gate exists to avoid and puts a bot's explanation on a
 *     person's own work.
 *
 * Exported so `referral-links.test.ts` can pin both directions without a browser; the
 * e2e proves the wiring, this proves the rule. Anything that is not exactly `"engine"`
 * is not evidence a bot wrote it — the opposite direction from the SQL guard, which
 * treats unknown as "the engine may write", and deliberately so: there, unknown means
 * a recoverable write; here, unknown would mean an unfounded claim.
 */
export function isEngineWrittenId(source: string | null | undefined): boolean {
  return (source ?? "") === "engine";
}

/**
 * The id inside whatever a person pasted.
 *
 * People paste three things and mean the same one: the bare number, the
 * "See all employees" URL (`.../search/results/people/?...f_C=1035...`), and a
 * `?trk=` -laden company URL somebody copied out of the address bar. Everything
 * else answers `null` rather than a guess — a wrong company id sends somebody's
 * outreach to strangers at another company, which is worse than an empty cell.
 *
 * Deliberately NOT a general URL parser: it looks for `f_C=` / `currentCompany=`
 * / a bare number and gives up otherwise. `linkedin.com/company/ramp` carries no
 * id at all, so it is refused BY NAME with the one thing that does work, which is
 * the failure mode worth being helpful about.
 */
export function extractLinkedinId(input: string): { id: string } | { error: string } {
  const text = (input ?? "").trim();
  if (text === "") return { error: "Paste the number from the company's LinkedIn URL." };

  if (NUMERIC_ID.test(text)) return { id: text };

  // f_C=1035 or f_C=%5B%221035%22%5D — the "See all employees" URL, in both the
  // bare and the JSON-array-encoded shapes LinkedIn has used.
  const faceted = /(?:f_C|currentCompany)=(?:%5B%22|\[")?([0-9]{1,20})/i.exec(text);
  if (faceted) return { id: faceted[1] };

  if (/linkedin\.com\/company\//i.test(text)) {
    return {
      error:
        "That is the company page URL, which does not carry the id. Open it, click " +
        '"See all employees", and paste the address of THAT page — it contains f_C=<number>.',
    };
  }

  return {
    error:
      "No LinkedIn company id in that. Open the company page, click \"See all employees\", " +
      "and paste the address of that page (or just the number after f_C=).",
  };
}

/**
 * The one shape a profile URL is allowed to have: an `https` linkedin.com address.
 *
 * Exported as the SHARED guard rather than re-inlined per caller — `connectionUrl`
 * below uses it, and the warm-intro manual-add box (`lib/warm/actions.ts`) uses the
 * SAME predicate to decide "is this pasted text a URL to keep, or a bare name?".
 * A CSV cell or a hand-typed box is user text, and a `javascript:` string rendered
 * as an href would make it a script on this origin — so a URL that is not
 * linkedin.com is refused, and the caller treats it as a name (or an error), never
 * as a link. Still fetch-free: this is a string test, and `lib/referral/` reaches
 * nothing outbound (the hard-line test).
 */
export function isLinkedinProfileUrl(value: string | null | undefined): boolean {
  return /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\/[^\s]*$/i.test((value ?? "").trim());
}

/** `["1035","2077"]` → `["1035","2077"]` as LinkedIn's URL params want it. */
function jsonList(values: readonly string[]): string {
  return JSON.stringify(values);
}

/**
 * One people-search URL from a facet set.
 *
 * Ids that are not ids are DROPPED rather than escaped-and-passed: an id the
 * database let through because the column is free-vocab has no business in a URL
 * even correctly encoded, since the resulting search is wrong rather than
 * dangerous, and a search that quietly means something else is the failure this
 * whole module is careful about. If every id in a facet is dropped, the facet is
 * absent — never present-and-empty, which LinkedIn renders as "no results" and a
 * reader reads as "nobody works there".
 *
 * `URLSearchParams` does the encoding, so a keyword containing `&`, `#` or a
 * quote cannot break out of its parameter.
 */
export function peopleSearchUrl(facets: PeopleSearchFacets): string {
  const params = new URLSearchParams();

  const ids = (values: readonly string[] | undefined) =>
    (values ?? []).map((v) => (v ?? "").trim()).filter((v) => NUMERIC_ID.test(v));

  const current = ids(facets.companyIds);
  if (current.length) params.set("currentCompany", jsonList(current));

  const past = ids(facets.pastCompanyIds);
  if (past.length) params.set("pastCompany", jsonList(past));

  const schools = ids(facets.schoolIds);
  if (schools.length) params.set("schoolFilter", jsonList(schools));

  const geo = ids(facets.geoIds);
  if (geo.length) params.set("geoUrn", jsonList(geo));

  const degrees = (facets.degrees ?? []).filter((d) => d === "F" || d === "S" || d === "O");
  if (degrees.length) params.set("network", jsonList([...new Set(degrees)]));

  const keywords = (facets.keywords ?? "").trim();
  if (keywords) params.set("keywords", keywords);

  // `URLSearchParams.toString()` is form-urlencoded, which spells a space `+`.
  // That is correct for a form POST and a coin flip in a query string: `+` means
  // a space only to a reader that decodes form-urlencoded, and one that does not
  // searches LinkedIn for the literal `product+manager`. Rewritten to `%20`,
  // which every decoder reads the same way.
  //
  // Safe as a blanket replace precisely because the serializer ran first: a `+`
  // a person actually typed is already `%2B` by this point, so the only `+` left
  // in the string is one the encoder put there for a space.
  const query = params.toString().replace(/\+/g, "%20");
  return query ? `${PEOPLE_SEARCH}?${query}` : PEOPLE_SEARCH;
}

/**
 * The search string for "people who hire" at a company.
 *
 * LinkedIn's keyword box takes boolean operators, and the quoted phrase matters:
 * unquoted, `talent acquisition` matches profiles with either word, which is
 * most of a company's HR org.
 */
export const RECRUITER_KEYWORDS = 'recruiter OR "talent acquisition" OR "technical sourcer"';

/**
 * Words worth searching for from a posting's own title.
 *
 * The title is the ONLY per-posting signal available at layer 0, so this is what
 * makes "role peers" different from "everybody who works there". Stop words are
 * removed because `of` and `the` are not search terms, and the seniority ladder
 * is removed on purpose: "Senior Product Manager" should find the whole product
 * org, and pinning the search to one rung hides the person one rung up who is
 * the better ask.
 *
 * Capped at four words. Past that LinkedIn ANDs the terms into nothing, and a
 * link that always returns zero results teaches somebody to stop clicking.
 */
const TITLE_STOP_WORDS = new Set([
  "a", "an", "and", "at", "for", "in", "of", "or", "the", "to", "with",
  "senior", "sr", "staff", "principal", "lead", "junior", "jr", "associate",
  "i", "ii", "iii", "iv", "1", "2", "3",
  "remote", "hybrid", "onsite", "us", "usa",
  "full", "time", "fulltime", "contract", "intern", "internship",
]);

export function roleKeywords(title: string): string {
  const words = (title ?? "")
    .toLowerCase()
    // Everything that is not a letter or a digit becomes a break: "PM/TPM" is
    // two words, and `(Remote)` must not glue itself to the word before it.
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w !== "" && !TITLE_STOP_WORDS.has(w));
  // De-duplicated in order — "Product Manager, Product Platform" is a real title
  // and repeating a term narrows nothing.
  return [...new Set(words)].slice(0, 4).join(" ");
}

/** One link the warm-paths cell renders. */
export type WarmLink = {
  /** Stable id for testids and React keys; never shown. */
  id: string;
  /** What the person reads. */
  label: string;
  /** One line saying what the search actually asks for. */
  detail: string;
  href: string;
};

export type WarmLinkOptions = {
  /** `companies.linkedin_company_id`, or "" / null when nobody has pasted one. */
  companyId: string | null | undefined;
  /** The posting's title, for the role-peers search. Optional. */
  title?: string | null;
  /**
   * The user's own warm signals — their school and their past employers, as
   * LinkedIn entity ids.
   *
   * **Nothing supplies these today, and that is a stated gap rather than an
   * oversight.** The design brief's table wants "UIUC there" and "ex-Capital One
   * there" links, and they need two numeric ids per USER. There is no per-user
   * place to keep them: `profiles.criteria` is the gate contract (its shape is
   * pinned to `monitor/gates.py`'s dataclass field by field, in both
   * directions), `profiles.notify` belongs to the digest phase, and inventing a
   * settings surface for two fields is a profile-phase change, not this one.
   *
   * So the facets are built and tested and NOT rendered, and the cell's copy
   * never mentions alumni — because copy that promises unwired behaviour is the
   * defect (matrix row 227). Wiring is one profile field and one settings input
   * away; the branch below is what it plugs into.
   */
  signals?: {
    schoolIds?: readonly string[];
    schoolLabel?: string;
    pastCompanyIds?: readonly string[];
    pastCompanyLabel?: string;
  };
};

/**
 * The link set for one row, in the order a person should try them.
 *
 * Recruiters first because that link works regardless of warmth and is the one
 * that never has a zero-result day; degree filters after, because they are the
 * ones that pay off. Returns `[]` when there is no company id — the cell renders
 * the paste prompt instead, and a link set built on a missing id would be five
 * searches for "everybody on LinkedIn".
 */
export function warmLinks(opts: WarmLinkOptions): WarmLink[] {
  const companyId = (opts.companyId ?? "").trim();
  if (!isLinkedinId(companyId)) return [];
  const companyIds = [companyId];

  const links: WarmLink[] = [
    {
      id: "recruiters",
      label: "Recruiters here",
      detail: "People search: this company, filtered to recruiting titles",
      href: peopleSearchUrl({ companyIds, keywords: RECRUITER_KEYWORDS }),
    },
  ];

  const role = roleKeywords(opts.title ?? "");
  if (role) {
    links.push({
      id: "peers",
      label: "People in this role",
      detail: `People search: this company, keywords "${role}"`,
      href: peopleSearchUrl({ companyIds, keywords: role }),
    });
  }

  links.push(
    {
      id: "first",
      label: "Your 1st-degree here",
      detail: "People search: this company, 1st-degree connections only",
      href: peopleSearchUrl({ companyIds, degrees: ["F"] }),
    },
    {
      id: "second",
      label: "1st + 2nd degree here",
      detail: "People search: this company, everyone within two hops of you",
      href: peopleSearchUrl({ companyIds, degrees: ["F", "S"] }),
    },
    {
      id: "everyone",
      label: "Everyone here",
      detail: "People search: this company, no other filter",
      href: peopleSearchUrl({ companyIds }),
    },
  );

  // The unwired half, kept behind its data rather than behind a flag: with no
  // signals there is no link, so nothing on screen can promise it.
  const schools = opts.signals?.schoolIds ?? [];
  if (schools.length) {
    links.push({
      id: "alumni",
      label: `${opts.signals?.schoolLabel ?? "Your school"} here`,
      detail: "People search: this company, filtered to your school",
      href: peopleSearchUrl({ companyIds, schoolIds: schools }),
    });
  }
  const past = opts.signals?.pastCompanyIds ?? [];
  if (past.length) {
    links.push({
      id: "ex-colleagues",
      label: `Ex-${opts.signals?.pastCompanyLabel ?? "colleagues"} here`,
      detail: "People search: this company, filtered to people who worked where you did",
      href: peopleSearchUrl({ companyIds, pastCompanyIds: past }),
    });
  }

  return links;
}

/**
 * The link to one named person.
 *
 * A connection's exported profile URL when the export gave one, and a name
 * search scoped to their company when it did not — LinkedIn omits the URL for
 * connections who have restricted it, and "here is the name, go find them
 * yourself" is a worse answer than a search that usually lands.
 *
 * The URL is passed through only when it is a linkedin.com profile address.
 * `connections.profile_url` comes out of a CSV the user uploaded, and a CSV cell
 * is a place a `javascript:` string can live — rendering it as an href would
 * make somebody else's spreadsheet a script on this origin.
 */
export function connectionUrl(connection: {
  profileUrl?: string | null;
  fullName: string;
  companyId?: string | null;
}): string {
  const raw = (connection.profileUrl ?? "").trim();
  if (isLinkedinProfileUrl(raw)) return raw;

  const companyId = (connection.companyId ?? "").trim();
  return peopleSearchUrl({
    keywords: connection.fullName.trim(),
    companyIds: isLinkedinId(companyId) ? [companyId] : undefined,
    degrees: ["F"],
  });
}
