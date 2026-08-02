/**
 * View models — what the UI renders, deliberately separate from the database
 * row types in lib/types.ts.
 *
 * The separation exists because the decision the user makes is not shaped like
 * a database row. A triage decision needs compensation, minimum years, work
 * model and location IN FRONT OF THE USER; those live scattered across a jsonb
 * `tags` blob, a jsonb `geo` blob, and two columns. Mapping happens once, at
 * the edge, so no component ever reaches into a jsonb field and no component
 * has to know that `min_yoe` might be a string.
 *
 * The rule this file enforces, everywhere: **a value that was never stated is
 * `null`, and renders as "Not listed".** It is never zero, never an empty
 * string, never an invented midpoint. Absence is information — it tells the
 * reader to check before spending effort — and faking it is how a triage
 * surface loses trust.
 */

import type { StatusActor } from "@/lib/status";

export type Disposition = "qualified" | "filtered" | "needs-info";
export type Triage = "" | "interested" | "dismissed" | "snoozed";

/** One posting as the triage card and the grid render it. */
export type JobView = {
  key: string;
  company: string;
  title: string;
  url: string;

  /** Raw location string as the board stated it, e.g. "New York, NY". */
  location: string | null;
  /** Resolved US metro ("Chicago"), or null when it could not be placed. */
  metro: string | null;
  /** "US" | "Remote" | a country name | null. */
  market: string | null;
  /**
   * `geo.country` — the country the engine RESOLVED, verbatim.
   *
   * Distinct from `market`, which collapses it: `monitor/geo.py:159` writes
   * `"Remote" if remote else ("US" if country == "United States" else country)`,
   * so a remote posting's market says nothing about where it is anchored. The
   * gate reads the country, and reading `market` in its place would qualify a
   * Canada-anchored remote role that the engine filters — edge case G17,
   * arriving as a lossy view model rather than as a wrong branch.
   */
  country: string | null;
  remote: boolean;
  /** "Remote (US)" / "Hybrid — NYC" / "Onsite", verbatim from tagging. */
  workModel: string | null;

  /** The compensation string exactly as published. Never synthesized. */
  compRange: string | null;
  /** Parsed band in $thousands, for sorting and filtering only. */
  compMinK: number | null;
  compMaxK: number | null;

  /** Minimum years of experience the posting asks for. */
  minYoe: number | null;
  seniority: string | null;
  industry: string | null;
  roleFocus: string | null;
  skills: string[];

  /** ISO date the board published it, when it said so. */
  posted: string | null;
  firstSeen: string | null;

  /**
   * `tags.tagged_at` — when the LLM tag pass last looked at this posting, or
   * null while it never has. The two sentinels `no-jd:<date>` and
   * `failed:<date>` mean it gave up, and they count as TAGGED downstream.
   *
   * Carried because the gate turns on it and nothing else can stand in.
   * `awaiting-tags` is stamped iff this was empty at the time, so a row's
   * CURRENT disposition looks like it should be enough — and it is not: a row
   * filtered on geo while still untagged reads as `filtered`/`geo:India`, and
   * re-gating it under a widened country list has to know whether the answer is
   * `qualified` or `needs-info`. Deriving tagged-ness from the reason gets that
   * row wrong, silently, in the direction of promising a queue the engine will
   * not deliver.
   */
  taggedAt: string | null;

  /**
   * Board lifecycle: `New` | `Seen` | `Closed`, and whatever a human typed —
   * deliberately not an enum, mirroring `postings.status` in 0001_init.sql.
   *
   * Carried because acceptance criterion 16 ("a Closed posting is absent from
   * the queue") is otherwise only enforceable in SQL. The Supabase source
   * excludes Closed rows inside `queue()`, but `jobs()` does not, so any
   * surface built on the full set — the grid — could not express the rule at
   * all and silently showed dead roles as decidable work.
   */
  status: string | null;

  disposition: Disposition;
  /** e.g. "geo:India", "yoe:6>4", "comp:<120k", "" when cleanly qualified. */
  dispositionReason: string;
  triage: Triage;
  snoozeUntil: string | null;

  /**
   * The domain of the job's company as a bare host ("ramp.com"), or null when
   * unknown — the key the LogoAvatar renders a logo from (logo.dev → favicon →
   * monogram), null when it falls straight through to the monogram.
   *
   * A COMPANY fact carried on the posting for convenience, not a `postings` column:
   * postings have no domain and no FK to `companies`, so the Supabase source resolves
   * it by folding the job's company name against the user's company universe (0021's
   * `companies.domain`). Absent for a job whose company is outside that universe —
   * fine, the monogram covers it. Never synthesized from the name.
   */
  companyDomain: string | null;

  /** Optimistic-concurrency token: sent back with any write. */
  updatedAt: string | null;
};

/**
 * How reliably a company's jobs can be pulled (docs/plans/COMPANY-DISCOVERY.md):
 * 1 = direct ATS adapter, day-of · 2 = aggregator-covered, lagged · 3 = manual /
 * best-effort, tracked but not auto-pulled · null = the waterfall has not
 * grounded it yet.
 */
export type ReliabilityTier = 1 | 2 | 3 | null;

/** The human decision on a proposed company (user_companies.review_state, 0008). */
export type ReviewState = "proposed" | "approved" | "dismissed";

/** One row of the shared company universe, as the /companies grid renders it. */
export type CompanyView = {
  /** Stable row key for selection and writes — `companies.id` as a string. */
  key: string;
  /** Numeric id the write path takes. Kept beside `key` so no caller parses one. */
  id: number;
  /** The company's name. "" for a slug-only row (Common Crawl mines boards, not names). */
  name: string;
  /** ATS family the board belongs to, or "" when unresolved. */
  ats: string;
  /** Board slug within that ATS, or "" when unresolved. */
  slug: string;
  /** Where it was discovered: dork / commoncrawl / edgar / formadv / manual / … */
  source: string;
  tier: ReliabilityTier;
  /** Which waterfall step grounded it — the provenance the popover explains. */
  resolutionMethod: string;
  reviewState: ReviewState;
  /** user_companies.monitor — is the sweep pulling this company for this user. */
  enabled: boolean;
  /** user_companies.priority — is it on the more frequent watch list. */
  priority: boolean;
  /** True when the row came from the seeded sheet rather than from discovery. */
  seeded: boolean;
  /**
   * `companies.linkedin_company_id` (0013) — the `f_C=` number somebody pasted
   * once, "" until they do.
   *
   * Untrusted text by construction: the column is free-vocab (0008's `source`
   * precedent), so the digits-only rule lives in `app_set_linkedin_company_id`
   * and in `lib/referral/linkedin.ts`, at both ends rather than at one.
   */
  linkedinCompanyId: string;
  /**
   * `companies.linkedin_id_source` (0016) — who last answered the id above:
   * `"human"`, `"engine"`, or `""` when nobody has.
   *
   * The engine became the second writer of `linkedinCompanyId` when the TheirStack
   * sweep started harvesting ids off rows it already buys. This says which writer it
   * was, and it is what `warm-cell.tsx` gates its correction control on: a bot's
   * answer gets an edit affordance, because otherwise a valid id removes the only
   * paste surface in the product and nobody can disagree with it.
   *
   * Untrusted text, like the id beside it: the column is free-vocab (0008's `source`
   * precedent), so anything that is not exactly `"human"` reads as not-human.
   */
  linkedinIdSource: string;
  /**
   * `companies.domain` (0021) — the company's domain as a bare host ("ramp.com"),
   * or null when the engine has not harvested one yet. The LogoAvatar's key: the
   * /companies grid renders a company logo from it (logo.dev → favicon → monogram),
   * and null is the honest absent that falls straight through to the monogram.
   *
   * Free-vocab and canonicalized at the door (`hq_normalize_domain`), so the '' the
   * column holds until filled is mapped to null here — a value never stated is null,
   * this file's rule.
   */
  domain: string | null;
  /** Optimistic-concurrency token for the per-user subscription row. */
  updatedAt: string | null;
  /**
   * Optimistic-concurrency token for the SHARED company row — a different token
   * guarding a different write (0013).
   *
   * Named apart from `updatedAt` on purpose. Sending the wrong one produces a
   * conflict on a row nobody touched, which reads as the feature being broken;
   * two distinct names are what stop that at the type level.
   */
  companyUpdatedAt: string | null;
};

/**
 * One row of the user's own LinkedIn connections export (0013).
 *
 * `companyKey` is the GENERATED `company_name_key(company)` from SQL, carried
 * rather than recomputed: it is the join key for every match this feature makes,
 * and a view model that dropped it would push the normalization back into every
 * consumer — which is how 'Aon' and 'aon' became two companies the first time.
 */
export type ConnectionView = {
  id: number;
  fullName: string;
  company: string;
  /** Normalized company identity — the ONLY thing the match compares. */
  companyKey: string;
  /** Their job title, verbatim from the export's "Position" column. */
  title: string;
  /** Their public profile URL, "" when LinkedIn withheld it. */
  profileUrl: string;
  /** ISO date, or null when the export's date could not be PROVED. */
  connectedOn: string | null;
};

/**
 * The identity of a company NAME — the mirror of `public.company_name_key(text)`
 * in migration 0008, and it must stay byte-identical to it.
 *
 * The paste path matches on this rather than on the raw string, because the shared
 * table's unique key is (name, ats, slug) and a paste knows only the name. Three
 * things it fixes, all reproduced against real Postgres: 'Aon' and 'aon' pasted in
 * two sessions became two companies; a name copied out of a web page carries a
 * trailing NBSP, which is not whitespace to `btrim()`, so it became a third; and a
 * paste of an already-GROUNDED name did not collide with it at all.
 *
 * Deliberately not a slugifier. Punctuation stays — "Guggenheim Partners, LLC" and
 * "Guggenheim Partners LLC" are different registered names, and a wrong merge is
 * unrecoverable where a duplicate is merely untidy.
 *
 * The character classes are spelled out rather than left to JS `\s`, which is a
 * superset of Postgres's: writing both sides explicitly is what keeps the fake and
 * the database from disagreeing about which strings are the same company.
 */
const NAME_ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF]/g;
const NAME_SPACES = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

export function companyNameKey(name: string): string {
  return (name ?? "").replace(NAME_ZERO_WIDTH, "").replace(NAME_SPACES, " ").trim().toLowerCase();
}

/**
 * The mirror of `public.hq_blank_trim(text)` in migration 0010, and it must stay
 * byte-identical to it (`parity.test.ts` pins the character set to the SQL).
 *
 * It exists because SQL's `btrim(x)` with no character set trims SPACES ONLY \u2014
 * so `btrim(E'\n\t')` is not empty, and a note consisting of one newline passed
 * every "must not be blank" check in 0010 into an append-only table that cannot
 * delete it. Found by running it, not by reading it.
 *
 * JS `\s` is a superset of what the SQL trims, so the classes are spelled out on
 * both sides rather than left to either language's default \u2014 writing both
 * explicitly is what keeps the fake and the database agreeing about which
 * strings are empty.
 */
const BLANK_TRIM_EDGES =
  /^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/g;

export function blankTrim(text: string | null | undefined): string {
  return (text ?? "").replace(NAME_ZERO_WIDTH, "").replace(BLANK_TRIM_EDGES, "");
}

/**
 * The provenance tags the paste/propose path accepts — `ALLOWED_SOURCES` in 0008.
 *
 * Closed for 0007's `reliability_tier` reason: `source` is a reporting dimension
 * the coverage meter groups by, and `app_propose_companies` is granted to
 * `authenticated`, so an unbounded string from a browser writes a novel into a
 * group-by. It is a constraint on that FUNCTION, not on `companies.source` — the
 * Python ingesters write that column through one bulk upsert, and a table-wide
 * closed set would let a single unknown tag fail a 500-row chunk and wedge the
 * mirror. Which is why `sourceLabel` below still renders an unrecognised tag
 * verbatim: the engine may legitimately mint one, and hiding it would lose real
 * provenance.
 */
export const PROPOSE_SOURCE_TAGS = [
  "manual",
  "paste",
  "api",
  "import",
  "seed",
  "agent",
  "dork",
  "commoncrawl",
  "common-crawl",
  "edgar",
  "formadv",
  "form-adv",
  "theirstack",
] as const;

/**
 * How much a row's tier is EVIDENCE rather than a guess.
 *
 * This vocabulary exists because of a specific caveat in
 * docs/plans/COMPANY-DISCOVERY-RESEARCH.md: a coverage meter built on
 * `reliability_tier` alone "would render T1's soft estimate as if measured". The
 * research pass's own Dad figure was 47% *grounded* against a ~75%
 * *best-estimate*, and the gap between those two numbers is the whole thing a
 * reader needs to know. So a tier is never shown without saying how it was
 * established:
 *
 *   verified   — the resolver called the board's own API and it answered. This is
 *                the only value that means "we have pulled jobs from here".
 *   inferred   — the ATS was identified from a fingerprint (a careers-page match,
 *                an aggregator's index) with no first-party board call behind it.
 *   asserted   — a slug or a name taken on trust from a third-party corpus or a
 *                human, never re-verified. Common Crawl is the live example: the
 *                research pass found it "contains dead boards".
 *   unresolved — no tier at all. Not a failure state; just not done.
 *
 * The mapping is over the `resolution_method` values the engine actually writes
 * (monitor/discover_universe.py) plus the ones 0007 documents. An UNRECOGNISED
 * method is `asserted`, never `verified` — a method this code has never heard of
 * cannot be counted as evidence, and defaulting the other way is precisely how a
 * meter manufactures false confidence.
 */
export type ResolutionConfidence = "verified" | "inferred" | "asserted" | "unresolved";

/**
 * The methods that mean "a board API answered", enumerated rather than matched by
 * prefix.
 *
 * `monitor/discover.py`'s waterfall probes exactly these four families and demands
 * a live posting back, and `_resolve()` writes `discover-<ats>` for whichever one
 * answered — so this list IS the set of strings that can honestly claim evidence.
 *
 * It used to be `startsWith("discover-")`, which is an OPEN prefix: any future
 * `discover-<anything>` — a new adapter, a hand-typed row, a typo, an ingester
 * that borrows the naming — was counted as a first-party board call nobody made.
 * That is the same false confidence the fail-closed default exists to prevent,
 * arriving through the one branch that skipped it. An unknown `discover-*` now
 * reads as `inferred`: something identified it as a board, and no call this code
 * knows about confirmed it.
 */
const VERIFIED_METHODS: ReadonlySet<string> = new Set([
  "discover-greenhouse",
  "discover-ashby",
  "discover-lever",
  "discover-smartrec",
  // discover.py's Workday branch gates every slug on a CXS jobs POST — "the single
  // source of truth, never DNS/pod-guessing" — and writes this exact string.
  "workday-redirect",
]);

export function resolutionConfidence(company: CompanyView): ResolutionConfidence {
  if (company.tier === null) return "unresolved";
  const m = company.resolutionMethod.trim().toLowerCase();
  if (!m) return "unresolved";
  if (VERIFIED_METHODS.has(m)) return "verified";
  if (m === "aggregator" || m === "web-search" || m === "fingerprint") return "inferred";
  // A `discover-*` this code does not know: a board was identified, but not by a
  // probe in the waterfall we can name. Inferred, never verified.
  if (m.startsWith("discover-")) return "inferred";
  return "asserted";
}

/**
 * ═══ THE DISPLAY DICTIONARY ═══════════════════════════════════════════════════
 *
 * Everything from here to `explainReason` is the engine→person translation layer
 * the design brief calls "the display dictionary", and it has one rule: the
 * engine vocabulary is correct inside the database and inside `core/schema.py`,
 * and it STOPS HERE. No surface renders a word this file did not choose.
 *
 * That is a real constraint, not a style note. `resolution_method`, `tier`,
 * `sweep`, `disposition` and `triage` are precise engineering nouns and every one
 * of them is meaningless-or-wrong to the person reading the screen: "Tier 1"
 * reads as a quality ranking, "unverified" reads as an accusation, "sweep" is a
 * word for something the user never sees happen. The words below are what those
 * facts are called to a person, chosen once, here, so that two surfaces cannot
 * disagree about what a thing is called.
 *
 * The write path, the column names and the status vocabulary are UNTOUCHED by
 * any of this. Renaming is display-layer, by rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Source quality — the four words a person sees where the engine keeps four
 * confidence buckets.
 *
 * `asserted` is an engine confidence, not proof that the person added the row.
 * Machine-mined Common Crawl and TheirStack rows also use it, so the display
 * confidence below folds those rows into "Likely". "Added by you" is reserved
 * for the sources that actually came from a person.
 */
const SOURCE_QUALITY_LABELS: Record<ResolutionConfidence, string> = {
  verified: "Confirmed",
  inferred: "Likely",
  asserted: "Added by you",
  unresolved: "Not found yet",
};

/** The one word the source chip carries. */
export function confidenceLabel(c: ResolutionConfidence): string {
  return SOURCE_QUALITY_LABELS[c];
}

const USER_ADDED_SOURCES: ReadonlySet<string> = new Set(["paste", "manual", "user"]);

/** The confidence bucket a person sees, derived from confidence and authorship. */
export function sourceQuality(company: CompanyView): ResolutionConfidence {
  const confidence = resolutionConfidence(company);
  if (
    confidence === "asserted" &&
    !USER_ADDED_SOURCES.has(company.source.trim().toLowerCase())
  ) {
    return "inferred";
  }
  return confidence;
}

/**
 * How often this company's jobs arrive — the tier's actual meaning, without the
 * word "tier".
 *
 * The tier number is a reliability RANK in the engine and reads as a quality
 * grade on screen, which is the specific misreading the design bans it for. What
 * a person needs from it is the latency, so that is what this says.
 */
export function refreshLabel(tier: ReliabilityTier): string {
  if (tier === 1) return "Jobs arrive the day they post";
  if (tier === 2) return "Jobs arrive with a lag";
  if (tier === 3) return "Tracked, not pulled automatically";
  return "No job board found yet";
}

/**
 * A user's decision on a posting.
 *
 * `user_postings.triage` stores "" | interested | dismissed | snoozed. The empty
 * string is the one that matters: it is not "no decision exists", it is "this is
 * waiting for you", and a blank cell says the first when the truth is the second.
 */
const DECISION_LABELS: Record<Triage, string> = {
  "": "Needs decision",
  interested: "Interested",
  dismissed: "Passed",
  snoozed: "Later",
};

export function decisionLabel(triage: Triage): string {
  return DECISION_LABELS[triage] ?? DECISION_LABELS[""];
}

/**
 * Whether a posting cleared the user's search.
 *
 * The engine calls this the gate and its outcome the disposition; the person
 * asks "does this match what I asked for". `needs-info` is a TRANSIENT state
 * (the tag pass has not run), so it says what is happening rather than naming a
 * bucket.
 */
const MATCH_LABELS: Record<Disposition, string> = {
  qualified: "Matches your search",
  filtered: "Didn't match your search",
  "needs-info": "Checking details",
};

export function dispositionLabel(d: Disposition): string {
  return MATCH_LABELS[d] ?? MATCH_LABELS["needs-info"];
}

/**
 * The discovery scan, from the toggle that controls it.
 *
 * "sweep" is the engine's word for the run; "scan" is the product's. The toggle
 * states its own scope, because a bare on/off leaves "on for what?" unanswered.
 */
export const SCAN_INCLUDED = "Include in scans";
export const SCAN_EXCLUDED = "Not included in scans";

export function watchingLabel(included: boolean): string {
  return included ? SCAN_INCLUDED : SCAN_EXCLUDED;
}

/**
 * A question that ends an application if answered the wrong way.
 *
 * The engine calls it a knockout. Nobody outside a recruiting-tools team has
 * heard that word.
 */
export const DEAL_BREAKER = "Deal-breaker";
export const DEAL_BREAKER_PLURAL = "Deal-breaker questions";

/**
 * Where a stored answer applies.
 *
 * The policy engine stacks layers; a person has answers, and some of them are
 * different at one company. A company exception is shown INSIDE the answer it
 * modifies, never as a "layer".
 */
export const ANSWER_SCOPE_GLOBAL = "Your answers";
export const ANSWER_SCOPE_COMPANY = "Company-specific answers";

/** `situation_facts` — the things that are true about the person, not the job. */
export const ABOUT_YOU = "About you";

/** An imported spreadsheet. The engine batches; a person imports. */
export const IMPORT_NOUN = "import";

/**
 * Structural labels, from the design's attested-terms allowlist.
 *
 * The rule these exist to satisfy is unusual and worth restating: chrome runs on
 * an ALLOWLIST, not a banlist. Plain English is not enough — an invented section
 * header reads as generated even when every word in it is ordinary — so each of
 * these is attested in at least one named reference product (Jira, Salesforce,
 * Linear, GitHub, LinkedIn). Adding a new one means finding a product that
 * already uses it, or deciding the section should not have a header.
 */
export const PANE_DETAILS = "Details"; // Jira, Salesforce
export const PANE_ABOUT_THE_ROLE = "About the role"; // LinkedIn Jobs
export const PANE_ACTIVITY = "Activity"; // Jira, Linear, GitHub, Salesforce
export const PANE_SKILLS = "Skills"; // LinkedIn
/** The `resolution_method` line in the pane. Not a column. */
export const HOW_IT_WAS_FOUND = "How it was found";

/**
 * The kind of place a posting came from.
 *
 * "ATS" is a category name used by the people who buy them. The person reading
 * this sees a job board or a company's own careers page.
 */
export function boardKindLabel(ats: string): string {
  const a = (ats ?? "").trim();
  if (!a) return NOT_LISTED;
  // The name of the board is real information (a person recognises Greenhouse
  // from having applied through it); the CATEGORY word is what gets translated.
  return `${a} job board`;
}

/**
 * How this company's job board was found — the sentence the detail pane carries
 * under `HOW_IT_WAS_FOUND`.
 *
 * Every branch names the EVIDENCE, not the conclusion: "the Greenhouse board
 * answered with live postings" rather than "reliable". A reader deciding whether
 * to trust a coverage number needs the former.
 *
 * Written in the product's vocabulary, not the engine's: no tier, no probe, no
 * sweep, no verified/inferred/asserted. Those words are what this function
 * TRANSLATES; leaking them back into its own prose would defeat the point of
 * having a dictionary at all.
 */
export function explainResolution(company: CompanyView): string {
  const board = company.ats && company.slug ? `${company.ats}/${company.slug}` : null;
  const m = company.resolutionMethod.trim().toLowerCase();
  if (company.tier === null || !m) {
    return "No job board has been found for this company yet, so no jobs are pulled from it.";
  }
  if (m === "workday-redirect") {
    return `Found by following the company's own careers page to ${board ?? "a Workday board"}, then confirming it answered. Jobs arrive the day they post.`;
  }
  if (VERIFIED_METHODS.has(m)) {
    // The API is named from the ROW's ats, not from the method's suffix. They
    // agree today because `_resolve()` writes `discover-<ats>`; taking the word
    // out of the string would let a mismatched pair (a `discover-lever` method on
    // an `ashby` row — a mirror bug, or a hand-edited row) print a confident
    // sentence about a board this company does not have. The ats column is the
    // one the scan will actually fetch from.
    const api = company.ats || m.slice("discover-".length);
    return `Found on ${api}: ${board ?? "the board"} answered with live postings. Jobs arrive the day they post.`;
  }
  if (m.startsWith("discover-")) {
    // A `discover-*` outside the waterfall's four families. Something named a
    // board; no check this app can vouch for confirmed it.
    return `Recorded against ${board ?? "no board"}, by a route this app cannot check. Nothing here confirms the board answered. Treat it as a lead.`;
  }
  if (m === "ingested-slug") {
    return `The board ${board ?? ""} came from a public index and nothing has checked it since. It may be dead. Treat it as a lead until jobs arrive from it.`;
  }
  if (m === "manual") {
    return "Added by hand as a name only. No job board has been found for it, so it is tracked rather than pulled.";
  }
  if (m === "aggregator") {
    return "Covered through a jobs aggregator rather than the company's own board. Postings arrive, with a lag, and no direct board has been confirmed.";
  }
  if (m === "web-search") {
    return "The board was identified from a web search of the company's careers page, not from a board that answered. Treat it as a lead, not a confirmation.";
  }
  return "Found by a route this app does not recognise, so nothing here confirms the board answered.";
}

/** Where a company was discovered, as a person reads it. */
export function sourceLabel(source: string): string {
  const s = source.trim().toLowerCase();
  if (!s) return NOT_LISTED;
  const labels: Record<string, string> = {
    manual: "added by hand",
    paste: "pasted list",
    dork: "job-board search",
    commoncrawl: "Common Crawl",
    "common-crawl": "Common Crawl",
    edgar: "SEC EDGAR",
    formadv: "Form ADV",
    "form-adv": "Form ADV",
    theirstack: "TheirStack",
    import: "imported",
    seed: "seed list",
    agent: "discovery agent",
  };
  return labels[s] ?? source.trim();
}

/**
 * One note on an application. Append-only — there is no edit and no delete,
 * in the type as in the table (`revoke update, delete`, migration 0010).
 */
export type NoteView = {
  id: number;
  body: string;
  /** user | scout | system | import. Rendered verbatim if unrecognised. */
  author: string;
  createdAt: string | null;
};

/** How a note's author is named to a person. */
const NOTE_AUTHOR_LABELS: Record<string, string> = {
  user: "you",
  scout: "the scout",
  system: "the system",
  import: "imported",
};

export function noteAuthorLabel(author: string): string {
  const a = (author ?? "").trim().toLowerCase();
  if (!a) return NOT_LISTED;
  // Verbatim for an unrecognised tag, for `sourceLabel`'s reason: a future
  // writer may legitimately mint one, and hiding it loses real provenance.
  return NOTE_AUTHOR_LABELS[a] ?? author.trim();
}

/** One application as the pipeline renders it. */
export type ApplicationView = {
  id: number;
  postingKey: string | null;
  company: string;
  title: string;
  url: string | null;
  status: string;
  /**
   * Who last set `status`. `"user"` means a human chose it and no bot write may
   * change it — the lock that makes acceptance criterion 14 hold (0010).
   */
  statusActor: StatusActor;
  /** A status a bot proposes but will not apply on its own. */
  suggestedStatus: string | null;
  /** Deep link to the email that justified the current status. */
  evidence: string | null;
  appliedDate: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  /**
   * The flat legacy column. KEPT: spec §E round-trips it and the export column
   * reads it, so 0010 copied it into `application_notes` and left it in place.
   * New writes go to the notes entity; this is what a pre-0010 row still has.
   */
  notes: string | null;
  /** How many notes exist, so the UI can say so without fetching them. */
  noteCount: number;
  /** The newest note, or null. What the export writes, in preference to `notes`. */
  latestNote: NoteView | null;
  /**
   * The board's lifecycle status for this application's posting, or null when
   * there is no posting or it is not visible to this user.
   *
   * DERIVED on every read, never stored — a stored `delisted` flag lies the
   * moment the board reposts the role (matrix row 122).
   */
  postingStatus: string | null;
  updatedAt: string | null;
};

/**
 * Has the board dropped this posting?
 *
 * The honest limitation, worth stating where the function is rather than in a
 * plan: `postings` is only readable through a `user_postings` row
 * (0002_invariants.sql:16), so a manually-added application whose `posting_key`
 * points at a posting this user was never gated returns `null` here and reads
 * as still-listed. That is a false NEGATIVE, and it is the right way round —
 * the other direction tells someone a live job is dead.
 */
export function isDelisted(app: ApplicationView): boolean {
  return (app.postingStatus ?? "").trim().toLowerCase() === "closed";
}

/**
 * The note body the export writes for a row.
 *
 * Newest note first, falling back to the flat column. That ordering is the only
 * one correct both before and after 0010's backfill: a pre-migration row has a
 * column and no notes, a post-migration row has both, and a row written since
 * has notes and an empty column. Matrix row 109 — the backfill copies and never
 * clears, and this is the reader that makes both states work.
 */
export function exportNote(app: ApplicationView): string | null {
  const latest = app.latestNote?.body?.trim();
  if (latest) return latest;
  const flat = app.notes?.trim();
  return flat ? flat : null;
}

export type ChannelHealthView = {
  channel: string;
  ranAt: string | null;
  fetched: number;
  newRows: number;
  filtered: number;
  tagged: number;
  errors: number;
  /** Hours since the last run, or null when it has never run. */
  ageHours: number | null;
  /** Expected cadence in hours; drives the stale badge. */
  cadenceHours: number;
};

// ---- automation activity (bot_runs, migration 0023) ------------------------
//
// Coverage's Activity tab, in plain words. `ChannelHealthView` above is the OLD
// health surface — ops vocabulary (channel / cadence / stale) over the discovery
// ledger. This is E3's replacement: one row per JOB per invocation, mapped so
// no ops jargon reaches the view. The dictionary — raw run rows in, "Running" /
// "Last succeeded 2h ago" / "Failing since Jul 24" out — lives entirely below,
// shared by both data sources so the fake cannot say something the query can't.

/**
 * One `bot_runs` row, as either data source hands it to the mapper.
 *
 * Deliberately the raw run, not a rendered view: `activityForJob` is the ONE
 * place raw becomes plain words, and both sources reach it through the same
 * `activityFromRuns` so a divergence is a test failure, not a demo that lies.
 */
export type BotRunRow = {
  job: string;
  startedAt: string;
  /** null = still running, or the invocation died before it could close. */
  finishedAt: string | null;
  /** null while running; true|false once finished. */
  ok: boolean | null;
  fetched: number;
  newRows: number;
  /** One-line failure summary, or null on success. */
  error: string | null;
};

export type ActivityState = "running" | "succeeded" | "failing" | "never";

/** One job's automation activity, as the Activity tab renders it. */
export type ActivityView = {
  /** The raw `handler.JOBS` key — a stable React key / deep-link handle, not shown. */
  job: string;
  /** The job in plain words: what a person reads. */
  label: string;
  state: ActivityState;
  /** "Running" | "Last succeeded 2h ago" | "Failing since Jul 24" | "Never run". */
  stateLabel: string;
  /** "38 roles checked, 2 new" | a failure's one-liner | "". */
  lastResult: string;
  /** ISO of the newest FINISHED run, or null. */
  lastRunAt: string | null;
};

/**
 * How a job key is named to a person, as opposed to in `handler.JOBS`.
 *
 * The point of the tab is that "monitor" and "wide_theirstack" are ops names.
 * Grounded in what each job actually does (CLAUDE.md's schedule table), and an
 * unrecognised key renders verbatim — `sourceLabel`'s rule, for its reason: a
 * future job may legitimately appear before this map learns its name, and hiding
 * it would drop a real run off the one surface that answers "is it alive?".
 */
const JOB_LABELS: Record<string, string> = {
  monitor: "Job discovery",
  review: "Role tagging",
  tracker: "Pipeline sync",
  digest: "Daily briefing",
  snapshot: "Backups",
  selfheal: "Self-heal",
  simplify: "Simplify import",
  wide_cafe: "Wide net (hiring.cafe)",
  wide_theirstack: "Wide net (TheirStack)",
  seed_universe: "Universe seed",
  seed_pipeline: "Pipeline seed",
  linkedin_backfill: "Referral finder",
};

export function jobLabel(job: string): string {
  const j = (job ?? "").trim();
  // NOT_LISTED, never the engine's own "unknown": this string is rendered as
  // the Activity row's name, and an absent fact says "Not listed" everywhere in
  // the product. The copy lint caught it — a nameless run is an absent fact,
  // not a job called unknown.
  if (!j) return NOT_LISTED;
  return JOB_LABELS[j] ?? j;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Jul 24", in UTC so a fixed run instant renders the same date everywhere. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown date";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "just now" / "3m ago" / "2h ago" / "5d ago" — coarse on purpose. */
function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "at an unknown time";
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * "Last result" for one run: the counts if it moved any, else its error, else a
 * bare "completed". "roles checked" matches the discovery job the tab leads with;
 * a non-discovery job reports 0 counts and reads "completed", never a wrong noun.
 */
function resultText(run: BotRunRow): string {
  if (run.fetched > 0 || run.newRows > 0) {
    const base = `${run.fetched} roles checked`;
    return run.newRows > 0 ? `${base}, ${run.newRows} new` : base;
  }
  // `!== true`, not `=== false`: a finished run whose outcome is unknown is not
  // a success, and must not read as one. See `succeeded` below.
  if (run.ok !== true) return (run.error ?? "").trim() || "failed";
  return "completed";
}

/**
 * How long an open run may stay open before it stops meaning "Running".
 *
 * An invocation that is OOM-killed or hits its Lambda timeout dies without
 * closing its row, so `finished_at` stays null forever. Read literally, the tab
 * whose entire promise is "is the machinery alive" would then say "Running"
 * about a job that died days ago — health()'s answer-by-omission failure, in a
 * louder register, because "Running" is an active reassurance rather than a
 * silence. Lambda's hard ceiling is 15 minutes, so an hour is a wide margin:
 * past it the row is abandoned, not running, and the job's state comes from its
 * newest FINISHED run instead. No new state is invented — an abandoned run
 * simply stops voting. If it is the ONLY run there is, "Running" stands, since
 * the alternative would be to claim the job never ran.
 */
const ABANDONED_RUN_MS = 60 * 60 * 1000;

/**
 * One job's runs (any order) → its plain-words Activity row.
 *
 * The state machine, newest run first:
 *   - the newest run is still open        → Running
 *   - the newest FINISHED run succeeded   → Last succeeded <when>
 *   - the newest FINISHED run failed      → Failing since <the first failure of
 *                                           the current streak, i.e. the run
 *                                           right after the last success>
 *   - no runs at all                      → Never run
 *
 * "Failing since" is the START of the current failing streak, not the newest
 * failure: walking back from now until the last success and taking the oldest
 * failure is what makes the date answer "how long has this been broken", which
 * is the question an operator actually has.
 */
export function activityForJob(job: string, runs: BotRunRow[], now: number): ActivityView {
  const base = { job, label: jobLabel(job) };
  if (runs.length === 0) {
    return { ...base, state: "never", stateLabel: "Never run", lastResult: "", lastRunAt: null };
  }
  const byNewest = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  const finished = byNewest.filter((r) => r.finishedAt !== null);
  const lastRunAt = finished[0]?.finishedAt ?? null;

  const open = byNewest[0].finishedAt === null ? byNewest[0] : null;
  // NaN (an unparseable startedAt) compares false, so a row we cannot date is
  // treated as running rather than as abandoned — the conservative direction.
  const abandoned =
    open !== null && now - new Date(open.startedAt).getTime() > ABANDONED_RUN_MS;
  if (open !== null && !(abandoned && finished.length > 0)) {
    // Running now. Still surface the last known result, so a long job is not a
    // blank row — but the state is what it is doing, not what it last did.
    return {
      ...base,
      state: "running",
      stateLabel: "Running",
      lastResult: finished[0] ? resultText(finished[0]) : "",
      lastRunAt,
    };
  }
  const newest = finished[0];
  // `=== true`, not `!== false`. A finished run with a null outcome is barred by
  // 0023's check constraint, so this is defence in depth against a hand-edited
  // or future-writer row — and the direction matters: an unknown outcome shown
  // as "Last succeeded" is the system telling the user their automation is fine
  // when nobody knows that. Unknown routes to the not-succeeded branch instead.
  if (newest.ok === true) {
    return {
      ...base,
      state: "succeeded",
      stateLabel: `Last succeeded ${relativeTime(newest.finishedAt as string, now)}`,
      lastResult: resultText(newest),
      lastRunAt,
    };
  }

  // Failing: walk the finished runs newest→oldest through the unbroken run of
  // failures; the last one in that streak is when it started going wrong.
  let since = newest;
  for (const run of finished) {
    if (run.ok !== true) since = run;
    else break;
  }
  return {
    ...base,
    state: "failing",
    stateLabel: `Failing since ${shortDate(since.finishedAt as string)}`,
    lastResult: resultText(newest),
    lastRunAt,
  };
}

//: Problems first — the tab exists to surface them — then healthy, then quiet.
const STATE_ORDER: Record<ActivityState, number> = {
  failing: 0,
  running: 1,
  succeeded: 2,
  never: 3,
};

/**
 * Every job's runs → one Activity row per job, ordered deterministically.
 *
 * Both `SupabaseDataSource` and `FixtureDataSource` call THIS, over the same
 * `BotRunRow` shape, so "the fake matches the query" is structural rather than
 * hoped-for. Order: failing, then running, then succeeded, then never; ties by
 * label, so the tab never reshuffles between two reads of the same data.
 */
export function activityFromRuns(runs: BotRunRow[], now: number = Date.now()): ActivityView[] {
  const byJob = new Map<string, BotRunRow[]>();
  for (const run of runs) {
    const list = byJob.get(run.job);
    if (list) list.push(run);
    else byJob.set(run.job, [run]);
  }
  const out = [...byJob.entries()].map(([job, jobRuns]) => activityForJob(job, jobRuns, now));
  return out.sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.label.localeCompare(b.label),
  );
}

/**
 * A user's saved grid state. `state` is deliberately opaque here — its shape
 * (filters, sort, group, quick search, column layout, density, type scale,
 * keyboard hints) is the grid's concern, not the data layer's, and the store
 * never interprets it. Keeping it `unknown` here means a change to what the
 * grid remembers never ripples into the data boundary.
 */
export type SavedView = {
  id: string;
  surface: string;
  name: string;
  state: unknown;
  isDefault: boolean;
  /** Optimistic-concurrency token: sent back with any write. */
  updatedAt: string | null;
};

/** The four facts a triage decision actually turns on. */
export type DecisionFacts = {
  comp: string;
  minYoe: string;
  workModel: string;
  location: string;
};

export const NOT_LISTED = "Not listed";

/**
 * The decision bar. Every field returns a display string, and an unstated
 * field returns NOT_LISTED rather than being omitted — a missing tile would
 * silently look like a narrower posting rather than an unknown one.
 */
export function decisionFacts(job: JobView): DecisionFacts {
  return {
    comp: job.compRange?.trim() || NOT_LISTED,
    minYoe:
      job.minYoe === null || job.minYoe === undefined
        ? NOT_LISTED
        : job.minYoe === 0
          ? "Any"
          : `${job.minYoe}+ yrs`,
    workModel: job.workModel?.trim() || (job.remote ? "Remote" : NOT_LISTED),
    location: job.location?.trim() || (job.remote ? "Remote" : NOT_LISTED),
  };
}

/**
 * Plain-English rendering of why a row was filtered. The raw reasons are
 * machine tokens; a person reading "geo:India" learns less than they should,
 * and this string appears in the one view whose entire job is answering
 * "why am I not seeing anything?".
 */
export function explainReason(reason: string): string {
  const r = (reason || "").trim();
  if (!r) return "Matches your search";
  const [kind, rest] = [r.split(":")[0], r.split(":").slice(1).join(":")];
  switch (kind) {
    case "geo":
      return `Location is ${rest}, outside your area`;
    case "geo-unknown":
      return "Location could not be identified";
    case "metro":
      return `In the ${rest} metro, outside the ones you follow`;
    case "metro-unknown":
      return "Could not be placed in a city you follow";
    case "yoe": {
      const [asks, max] = rest.split(">");
      return `Asks for ${asks}+ years; your profile says ${max}`;
    }
    case "yoe-unknown":
      return "Years of experience not stated";
    case "seniority":
      return `Seniority "${rest}" is above your range`;
    case "comp": {
      // "<120k" is the token; "$120k" is the number the user typed into their
      // own pay floor, and stating it back is what makes the sentence checkable.
      const floor = rest.replace(/^</, "");
      return `Pay is below your ${floor.startsWith("$") ? floor : `$${floor}`} minimum`;
    }
    case "comp-unknown":
      return "Pay not stated";
    case "work-model":
    case "work_model":
      return `${workModelWord(rest)} only; you excluded ${workModelWord(rest).toLowerCase()}`;
    case "title-exclude":
    case "title_exclude":
      return `Title matches your excluded term "${rest}"`;
    case "awaiting-tags":
      return "Checking details. This one is classified shortly";
    default:
      // Never the raw token. A reason this app has not learned to phrase is
      // still a filter the user's own settings applied, and saying so is true;
      // printing "geo-newthing:XX" teaches the reader nothing and reads as a
      // bug. The token stays on `dispositionReason` for anyone debugging.
      return "Filtered out by your search settings";
  }
}

/** "onsite" is how the engine spells it; "On-site" is how it is written. */
function workModelWord(raw: string): string {
  const w = (raw || "").trim().toLowerCase();
  if (w === "onsite" || w === "on-site") return "On-site";
  if (w === "hybrid") return "Hybrid";
  if (w === "remote") return "Remote";
  return raw;
}

/** Which profile setting a filtered row points at, for a deep link. */
export function reasonSetting(reason: string): string | null {
  const kind = (reason || "").split(":")[0];
  if (kind === "geo" || kind === "geo-unknown") return "countries";
  if (kind === "metro" || kind === "metro-unknown") return "metros";
  if (kind === "yoe" || kind === "yoe-unknown") return "yoeMax";
  if (kind === "seniority") return "seniorityExclude";
  if (kind === "comp" || kind === "comp-unknown") return "compMin";
  if (kind === "work-model") return "workModelExclude";
  return null;
}

/**
 * How a setting is named to a person, as opposed to in the profile record.
 *
 * ONE vocabulary in three places: here, `SETTING_LABELS` in
 * `app/(app)/jobs/why-popover.tsx`, and the section headings on `/settings`.
 * The popover says "Change your pay floor" and links to `#compMin`, so the
 * heading it lands on has to be the same words — a link that arrives somewhere
 * with a different name reads as the wrong link. Keep the three in step.
 */
const SETTING_LABELS: Record<string, string> = {
  countries: "countries",
  metros: "cities",
  yoeMax: "experience limit",
  seniorityExclude: "levels ruled out",
  compMin: "pay floor",
  workModelExclude: "ways of working",
};

/** The single setting responsible for the most filtered-out postings. */
export type BindingConstraint = {
  /** Profile setting key, for the deep link. */
  setting: string;
  /** That key in plain English. */
  label: string;
  /** Postings this setting removed. */
  filtered: number;
  /** Postings considered, filtered ones included. */
  total: number;
  /** One of those postings' reasons, spelled out, as the concrete case. */
  example: string;
};

/**
 * Why the queue is empty, when the answer is "your profile", not "nothing was
 * found".
 *
 * Those two states look identical on screen and mean opposite things. One is a
 * quiet day and the right response is to wait. The other is a setting that can
 * be widened in ten seconds, and a user who is not told that concludes the app
 * stopped working — which is the failure this exists to prevent.
 *
 * Grouping is by SETTING rather than by reason string because the setting is
 * what the user can actually go and change: "geo:India" and "geo:United
 * Kingdom" are two rows behind one countries list. Returns null when no
 * filtered row points at a setting at all, since naming a constraint that did
 * not bind would send someone to loosen a filter that was never the problem.
 */
export function bindingConstraint(jobs: JobView[]): BindingConstraint | null {
  const bySetting = new Map<string, { count: number; example: string }>();
  for (const job of jobs) {
    if (job.disposition !== "filtered") continue;
    const setting = reasonSetting(job.dispositionReason);
    if (!setting) continue;
    const seen = bySetting.get(setting);
    if (seen) seen.count += 1;
    else bySetting.set(setting, { count: 1, example: explainReason(job.dispositionReason) });
  }

  let best: [string, { count: number; example: string }] | null = null;
  for (const entry of bySetting) {
    // strictly greater, so a tie keeps the first setting encountered and the
    // message does not flip between two equals on every render
    if (!best || entry[1].count > best[1].count) best = entry;
  }
  if (!best) return null;

  return {
    setting: best[0],
    label: SETTING_LABELS[best[0]] ?? best[0],
    filtered: best[1].count,
    total: jobs.length,
    example: best[1].example,
  };
}
