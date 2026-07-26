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
  /** Optimistic-concurrency token: sent back with any write. */
  updatedAt: string | null;
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

const CONFIDENCE_LABELS: Record<ResolutionConfidence, string> = {
  verified: "verified",
  inferred: "inferred",
  asserted: "unverified",
  unresolved: "unresolved",
};

/** The one word the provenance chip carries beside the tier. */
export function confidenceLabel(c: ResolutionConfidence): string {
  return CONFIDENCE_LABELS[c];
}

/** Tier as a person reads it, with the latency that is the point of the tier. */
export function tierLabel(tier: ReliabilityTier): string {
  if (tier === 1) return "Tier 1 · day-of";
  if (tier === 2) return "Tier 2 · lagged";
  if (tier === 3) return "Tier 3 · manual";
  return "Unresolved";
}

/**
 * The full sentence behind a row's tier — what the popover says.
 *
 * Every branch names the EVIDENCE, not the conclusion: "the Greenhouse API
 * answered for slug `x`" rather than "reliable". A reader deciding whether to
 * trust a coverage number needs the former.
 */
export function explainResolution(company: CompanyView): string {
  const board = company.ats && company.slug ? `${company.ats}/${company.slug}` : null;
  const m = company.resolutionMethod.trim().toLowerCase();
  if (company.tier === null || !m) {
    return "Not resolved yet — no board has been found for this company, so nothing is pulled from it.";
  }
  if (m === "workday-redirect") {
    return `Resolved by following the company's own careers page to ${board ?? "a Workday board"}, then confirming it with a Workday CXS jobs call. Jobs are pulled directly, day-of.`;
  }
  if (VERIFIED_METHODS.has(m)) {
    // The API is named from the ROW's ats, not from the method's suffix. They
    // agree today because `_resolve()` writes `discover-<ats>`; taking the word
    // out of the string would let a mismatched pair (a `discover-lever` method on
    // an `ashby` row — a mirror bug, or a hand-edited row) print a confident
    // sentence about a board this company does not have. The ats column is the
    // one the sweep will actually fetch from.
    const api = company.ats || m.slice("discover-".length);
    return `Resolved by probing the ${api} API: ${board ?? "the board"} answered with live postings. Jobs are pulled directly, day-of.`;
  }
  if (m.startsWith("discover-")) {
    // A `discover-*` outside the waterfall's four families. Something named a
    // board; no probe this app can vouch for confirmed it.
    return `Recorded as "${company.resolutionMethod}" against ${board ?? "no board"} — that is not one of the four boards the resolver probes (greenhouse, ashby, lever, smartrec), so nothing here confirms the board answered. Treat it as a lead.`;
  }
  if (m === "ingested-slug") {
    return `The board ${board ?? ""} came from a mined corpus and was passed through without being probed. It may be a dead board — treat the tier as unverified until a sweep pulls from it.`;
  }
  if (m === "manual") {
    return "Added by hand as a name only. Nothing has resolved a board for it, so it is tracked rather than pulled.";
  }
  if (m === "aggregator") {
    return "Covered through the aggregator net rather than a first-party board call — postings arrive, but lagged, and no direct board has been confirmed.";
  }
  if (m === "web-search") {
    return "The ATS was identified from a web search of the company's careers page, not from a board API that answered. Treat it as a lead, not a confirmation.";
  }
  return `Resolved by "${company.resolutionMethod}" — a method this app does not recognise, so its tier is reported as unverified.`;
}

/** Where a company was discovered, as a person reads it. */
export function sourceLabel(source: string): string {
  const s = source.trim().toLowerCase();
  if (!s) return "unknown";
  const labels: Record<string, string> = {
    manual: "added by hand",
    paste: "pasted list",
    dork: "ATS search",
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
  if (!a) return "unknown";
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
      return `Located in ${rest}, outside your countries`;
    case "geo-unknown":
      return "Location could not be identified";
    case "metro":
      return `In the ${rest} metro, outside the ones you follow`;
    case "metro-unknown":
      return "Could not be placed in a metro you follow";
    case "yoe": {
      const [asks, max] = rest.split(">");
      return `Asks for ${asks}+ years; your limit is ${max}`;
    }
    case "yoe-unknown":
      return "Years of experience not stated";
    case "seniority":
      return `Seniority "${rest}" is above your range`;
    case "comp":
      return `Pays below your floor (${rest.replace("<", "under ")})`;
    case "comp-unknown":
      return "Compensation not stated";
    case "work-model":
      return `Work model "${rest}" is one you excluded`;
    case "awaiting-tags":
      return "Not yet analysed — it will be classified shortly";
    default:
      return r;
  }
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

/** How a setting is named to a person, as opposed to in the profile record. */
const SETTING_LABELS: Record<string, string> = {
  countries: "countries",
  metros: "metros",
  yoeMax: "years-of-experience limit",
  seniorityExclude: "seniority exclusions",
  compMin: "compensation floor",
  workModelExclude: "work-model exclusions",
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
