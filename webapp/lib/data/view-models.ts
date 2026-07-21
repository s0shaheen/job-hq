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

/** One application as the pipeline renders it. */
export type ApplicationView = {
  id: number;
  postingKey: string | null;
  company: string;
  title: string;
  url: string | null;
  status: string;
  /** A status a bot proposes but will not apply on its own. */
  suggestedStatus: string | null;
  /** Deep link to the email that justified the current status. */
  evidence: string | null;
  appliedDate: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  notes: string | null;
  updatedAt: string | null;
};

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
