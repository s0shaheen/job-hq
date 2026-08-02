/**
 * The Jobs surface's view model: a `JobView` becomes six cells and one pane
 * payload, and nothing above this line knows what a `disposition` is.
 *
 * This is the "view-model edge" 02 §1 names. The engine vocabulary is correct
 * in the database and stays there; the dictionary translates here, once, and
 * every cell and pane row below reads translated words. Pure — no React, no
 * `Date.now()` — so the whole surface's copy is unit-testable without a layout
 * engine, which is the same reason `lib/grid/columns.tsx` split its text
 * functions out.
 *
 * The six columns are 03 §4's budget, and the retirements are deliberate:
 *   - `Comp` becomes **Pay** (02 §4).
 *   - `Work model` and `Location` merge into **Location & model**.
 *   - `Min YoE` moves into the pane's Details.
 *   - `Why` retires entirely; the reason renders as a sentence in the pane.
 *     04 §3: "The Why column stays dead."
 *   - `Warm` retires as a column and returns as an indicator on the Company
 *     cell (03 §4: "The column spent width on a boolean; the indicator keeps
 *     the signal and buys a column back").
 *
 * **Absence reads "Not listed", not an em dash.** The shipped grid used a muted
 * `—`, argued from density. 02 §8 settles it the other way ("unstated is 'Not
 * listed'") and 04 §3 demands a visible one in the sample data, so the dash is
 * gone from this surface. It costs width and buys a value a person can read.
 */

import { decisionWord, reasonSentence } from "@/lib/dictionary";
import { NOT_LISTED, type JobView } from "@/lib/data/view-models";

/** Milliseconds in a day. Dates are compared, never localised. */
const DAY_MS = 86_400_000;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Keep source-provided text, while enforcing the display system's glue rules. */
function displayText(value: string): string {
  return value
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*·\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "3d ago" under seven days, then "Jul 12", with the year only across a year
 * boundary (02 §8).
 *
 * `now` is a parameter rather than a `Date.now()` call for the reason the
 * filter engine's is: the server render and the hydrating client must evaluate
 * the same instant, or a row on the seven-day boundary renders two different
 * strings and the hydrate is corrupt.
 */
export function relativeDay(iso: string | null | undefined, now: number): string {
  if (!iso) return NOT_LISTED;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_LISTED;
  const days = Math.floor((now - d.getTime()) / DAY_MS);
  if (days >= 0 && days < 7) return days <= 0 ? "today" : `${days}d ago`;
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === new Date(now).getUTCFullYear()
    ? day
    : `${day}, ${d.getUTCFullYear()}`;
}

/** The Pay cell: the band the posting stated, verbatim, or "Not listed". */
export function payText(job: JobView): string {
  return job.compRange ? displayText(job.compRange) || NOT_LISTED : NOT_LISTED;
}

/**
 * The merged Location & model cell: "Remote, US" / "Hybrid, Chicago".
 *
 * Two columns became one, so the join has to survive the cases two columns hid.
 * A posting that says "Remote" in BOTH fields must not render "Remote, Remote"
 * — that reads as a data bug and it is the commonest shape in the corpus.
 */
export function locationModelText(job: JobView): string {
  const model = job.workModel ? displayText(job.workModel) : (job.remote ? "Remote" : "");
  const place = job.location ? displayText(job.location) : "";
  if (model && place) {
    return model.toLowerCase() === place.toLowerCase() ? model : `${model}, ${place}`;
  }
  return model || place || NOT_LISTED;
}

/** The Minimum years value, for the pane's Details. */
export function minYearsText(job: JobView): string {
  if (job.minYoe === null || job.minYoe === undefined) return NOT_LISTED;
  return job.minYoe === 0 ? "Any" : `${job.minYoe}+ years`;
}

/**
 * The board a row came from, in the words a person uses.
 *
 * The key is `{ats}-{native_id}` (core/jobkeys.py). "ATS" and "board" are both
 * on 02's engine list; the user-facing frame is "job board or career site", and
 * a named board is the honest specific ("Found on Greenhouse").
 */
export function boardName(key: string): string | null {
  const dash = key.indexOf("-");
  if (dash <= 0) return null;
  const ats = key.slice(0, dash);
  const named: Record<string, string> = {
    greenhouse: "Greenhouse",
    ashby: "Ashby",
    lever: "Lever",
    smartrec: "SmartRecruiters",
    workday: "Workday",
    eightfold: "Eightfold",
    oraclehcm: "Oracle",
    radancy: "Radancy",
  };
  if (named[ats]) return named[ats];
  // A family this table does not name renders as a career site rather than as
  // its slug: an unrecognised token in the pane is the engine leaking.
  return ats ? "a career site" : null;
}

export type WarmIndicator = { count: number; first: string } | null;

/** The six cells, already translated. */
export type JobRow = {
  key: string;
  company: string;
  title: string;
  url: string;
  pay: string;
  locationModel: string;
  posted: string;
  decision: ReturnType<typeof decisionWord>;
  /** Rendered on the Company cell, never as its own column. */
  warm: WarmIndicator;
};

export function jobRow(job: JobView, now: number, warm: WarmIndicator = null): JobRow {
  return {
    key: job.key,
    company: displayText(job.company),
    title: displayText(job.title),
    url: job.url,
    pay: payText(job),
    locationModel: locationModelText(job),
    posted: relativeDay(job.posted, now),
    decision: decisionWord(job.triage),
    warm,
  };
}

/** The tooltip on the warm indicator (02 §4's attested wording). */
export function warmTooltip(warm: NonNullable<WarmIndicator>): string {
  return `You know someone here: ${warm.first}`;
}

export type PanePayload = {
  company: string;
  title: string;
  href: string | null;
  decision: string;
  reason: string;
  details: [string, string][];
  about: string;
  skills: string[];
  activity: [string, string][];
};

/**
 * The pane payload: at most three labeled sections, all attested (02 §10).
 *
 * Details renders EVERY row including the unstated ones — a missing row would
 * silently read as a narrower posting rather than an unknown one, which is the
 * rule `decisionFacts` already states for the queue's four tiles, applied to
 * eight. No field here is invented: the design's example payload carries Equity
 * and Visa sponsorship rows, and `JobView` has neither, so they are absent
 * rather than rendered as a permanent "Not listed" for data the system does not
 * collect. E8 adds visa sponsorship; the row arrives with the field.
 */
export function paneModel(job: JobView, now: number, warm: WarmIndicator = null): PanePayload {
  const details: [string, string][] = [
    ["Pay", payText(job)],
    ["Minimum years", minYearsText(job)],
    ["Location", job.location ? displayText(job.location) : (job.remote ? "Remote" : NOT_LISTED)],
    ["Work model", job.workModel ? displayText(job.workModel) : (job.remote ? "Remote" : NOT_LISTED)],
    ["Seniority", job.seniority ? displayText(job.seniority) : NOT_LISTED],
    ["Posted", relativeDay(job.posted, now)],
    ["First seen", relativeDay(job.firstSeen, now)],
    ["Warm intro", warm ? warmTooltip(warm) : NOT_LISTED],
  ];

  // Newest first. The oldest entry is the source (04 §3), which is what makes
  // the section answer "where did this come from" without a Provenance chip.
  const activity: [string, string][] = [];
  if (job.triage !== "" && job.updatedAt) {
    activity.push([decidedEvent(job.triage), relativeDay(job.updatedAt, now)]);
  }
  if (job.taggedAt) activity.push(["Details checked", relativeDay(job.taggedAt, now)]);
  const board = boardName(job.key);
  if (job.firstSeen && board) {
    activity.push([`Found on ${board}`, relativeDay(job.firstSeen, now)]);
  }

  return {
    company: displayText(job.company),
    title: displayText(job.title),
    href: job.url || null,
    decision: decisionWord(job.triage),
    reason: reasonSentence(job.dispositionReason),
    details,
    about: job.roleFocus ? displayText(job.roleFocus) : NOT_LISTED,
    skills: job.skills.map(displayText),
    activity,
  };
}

/** The Activity line for a decision. Past tense, the verb from 02 §6. */
function decidedEvent(triage: JobView["triage"]): string {
  if (triage === "interested") return "Marked interested";
  if (triage === "dismissed") return "Passed";
  if (triage === "snoozed") return "Saved for later";
  return "Decision cleared";
}
