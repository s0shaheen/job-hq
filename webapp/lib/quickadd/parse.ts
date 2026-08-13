/**
 * What a pasted posting says about itself, and where each fact came from.
 *
 * `tracker/quickadd.py` answers this question with one LLM call over 6,000
 * characters of stripped page text, and its prompt ends "never invent a value".
 * This module answers a deliberately smaller version of the same question with
 * no model at all:
 *
 *   * the COMPANY comes from the link's own structure — every ATS in the key
 *     vocabulary puts the employer's slug in the path or the host, and that is
 *     a fact about the URL, not a reading of the page;
 *   * the TITLE comes from the page's own `<title>` or `og:title`;
 *   * everything else is `Not listed`.
 *
 * Two properties matter more than coverage. First, every field carries its
 * PROVENANCE, and the surface prints it: "Company from the link", "Title from
 * the page title". A parse the user cannot audit is a parse the user has to
 * trust, and the one thing the legacy lane could not do is show its working.
 * Second, nothing here guesses. A slug that does not resolve to a name returns
 * null and the field reads `Not listed` — never a title reverse-engineered from
 * a path segment, which is exactly the plausible-looking wrong answer this
 * product cannot afford.
 */

/** A fact with its source. `from` is user-facing copy, in sentence case. */
export type Fact = { readonly value: string; readonly from: string } | null;

const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;/gi, "'"],
  [/&nbsp;/gi, " "],
];

function decode(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim();
}

/** Longer than this is a page that put its whole description in the title. */
const TITLE_CAP = 200;

/**
 * ATS slug positions, first match wins.
 *
 * The list is the same vocabulary `core/jobkeys.py` keys on, and it is a list
 * of PLACES A SLUG SITS, not a list of employers. A board this does not know
 * falls through to the registrable domain below, and a board that puts nothing
 * identifying in the URL falls through to null.
 */
const COMPANY_IN_PATH: ReadonlyArray<readonly [RegExp, number]> = [
  [/(?:^|\.)greenhouse\.io\/(?:embed\/job_app\?[^#]*|)([^/?#]+)/i, 1],
  [/job-boards\.greenhouse\.io\/([^/?#]+)/i, 1],
  [/jobs(?:\.eu)?\.lever\.co\/([^/?#]+)/i, 1],
  [/jobs\.ashbyhq\.com\/([^/?#]+)/i, 1],
  [/jobs\.smartrecruiters\.com\/([^/?#]+)/i, 1],
  [/apply\.workable\.com\/([^/?#]+)/i, 1],
  [/([^./?#]+)\.recruitee\.com/i, 1],
  [/([^./?#]+)\.applytojob\.com/i, 1],
  [/([^./?#]+)\.bamboohr\.com/i, 1],
  [/([^./?#]+)\.myworkdayjobs\.com/i, 1],
];

/** Hosts that identify a job board rather than an employer. */
const AGGREGATORS = new Set([
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "dice.com",
  "monster.com",
  "wellfound.com",
  "builtin.com",
  "otta.com",
  "google.com",
]);

/**
 * Title-case a slug: `product-manager` → `Product Manager`, `ramp` → `Ramp`.
 *
 * Applied ONLY to a company slug, never to a title. A company slug is a name
 * with its spaces removed; a path segment that happens to hold a job title is
 * a title with its punctuation, seniority qualifiers and parentheses removed,
 * and reconstructing one reads as a fact while being a reconstruction.
 */
function nameFromSlug(slug: string): string | null {
  const cleaned = decodeURIComponent(slug || "").replace(/[_+]/g, "-").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(cleaned)) return null;
  const words = cleaned
    .split("-")
    .filter((w) => w !== "")
    // A trailing id or a `careers` suffix is plumbing, not part of the name.
    .filter((w) => !/^\d+$/.test(w) && !/^(careers|jobs|inc|llc)$/i.test(w));
  if (words.length === 0 || words.length > 4) return null;
  return words
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * The employer, read out of the link.
 *
 * Returns null on an aggregator: `linkedin.com/jobs/view/123` names LinkedIn,
 * and printing "LinkedIn" in the company slot of a Ramp posting is the exact
 * confidently-wrong parse this surface exists to make impossible.
 */
export function companyFromUrl(url: string): Fact {
  let host: string;
  let full: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    full = parsed.toString();
  } catch {
    return null;
  }
  for (const [pattern, group] of COMPANY_IN_PATH) {
    const match = pattern.exec(full);
    const name = match ? nameFromSlug(match[group] ?? "") : null;
    if (name) return { value: name, from: "from the link" };
  }
  const registrable = host.split(".").slice(-2).join(".");
  if (AGGREGATORS.has(registrable)) return null;
  // A company's own careers page: `careers.ramp.com`, `ramp.com/careers/…`.
  const label = host.split(".").slice(-2, -1)[0] ?? "";
  const name = nameFromSlug(label);
  return name ? { value: name, from: "from the link" } : null;
}

/**
 * The role, read out of the page the user pasted.
 *
 * Boards write `<title>Product Manager, Risk - Ramp</title>`, so the employer
 * suffix is trimmed when it matches the company we already resolved. When it
 * does not match, the whole title stands: trimming on the separator alone
 * would quietly eat a title that legitimately contains a dash.
 */
export function titleFromHtml(html: string, company?: string | null): Fact {
  const source = html ?? "";
  const og =
    /<meta[^>]+(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(source) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:title["']/i.exec(source);
  const tag = /<title[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(source);
  const raw = og?.[1] ?? tag?.[1];
  if (raw == null) return null;
  let value = decode(raw).slice(0, TITLE_CAP);
  if (company) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(`\\s*[-–|@]\\s*${escaped}\\s*$`, "i"), "").trim();
    value = value.replace(new RegExp(`\\s+at\\s+${escaped}\\s*$`, "i"), "").trim();
  }
  // A `<title>` of "Careers" or "Jobs" names the page, not the role.
  if (value === "" || /^(careers|jobs|job|home|apply)$/i.test(value)) return null;
  return { value, from: og ? "from the posting's own title" : "from the page title" };
}

export type ParsedPosting = {
  readonly company: Fact;
  readonly title: Fact;
};

/**
 * The whole parse. `html` is null when the page could not be read at all, and
 * the company is still resolved from the link in that case — the URL is the
 * valuable part, and it is readable without the network.
 */
export function parsePosting(url: string, html: string | null): ParsedPosting {
  const company = companyFromUrl(url);
  const title = html == null ? null : titleFromHtml(html, company?.value ?? null);
  return { company, title };
}
