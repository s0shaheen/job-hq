/**
 * The dictionary: where engine vocabulary becomes the words a person reads.
 *
 * 02 section 1 draws the line this module sits on. The engine vocabulary is
 * correct inside the database and stays there untouched; the dictionary lives
 * at the view-model edge. So everything here TRANSLATES and nothing here
 * renames a stored field: `triage` is still `triage` in Supabase, in
 * `JobView`, and in the filter language, and it is never those letters on a
 * screen.
 *
 * Pure. No React, no imports from `app/`, no I/O. One file so that the same
 * concept keeps the same word on all five surfaces — vocabulary consistency is
 * how a person learns a product (02 section 3.0), and it cannot survive being
 * retyped per surface.
 *
 * Every string below obeys 02: sentence case, no em dash, no interpunct,
 * bullet, pipe or slash as glue, straight quotes, none of the banned
 * vocabulary in sections 3.1 and 3.2, none of the banned constructions in 3.3.
 * The en dash appears in exactly one slot, a numeric range. That is not left
 * to review — `tests/unit/dictionary.test.ts` lints every exported string and
 * every string these functions can produce.
 */
import { NOT_LISTED } from "@/lib/data/view-models";
import type { Triage } from "@/lib/data/view-models";
import type { Clause, GridFilter, OrGroup } from "@/lib/grid/filter";
import { fmtDay } from "@/lib/format";

/**
 * "Not listed" is the value word for anything a posting never stated (02
 * section 8). Re-exported, never restated: `lib/data/view-models` already owns
 * the constant and two copies of a value word is how one screen starts saying
 * "Unknown".
 */
export { NOT_LISTED };

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * The four decisions, spelled the way a person says them.
 *
 * "Passed" for `dismissed` and "Later" for `snoozed` are the two that matter:
 * both engine words are judgements the product does not make. A row the user
 * passed on is not dismissed by the system, and a row saved for later is not
 * asleep.
 */
export type DecisionWord = "Needs decision" | "Interested" | "Passed" | "Later";

/** Decision order: undecided first, then the three outcomes. */
export const DECISION_WORDS = [
  "Needs decision",
  "Interested",
  "Passed",
  "Later",
] as const satisfies readonly DecisionWord[];

/** Engine state to word. Total over `Triage`; the switch has no default, so a
 *  fifth triage state would fail the build rather than render blank. */
export function decisionWord(triage: Triage): DecisionWord {
  switch (triage) {
    case "":
      return "Needs decision";
    case "interested":
      return "Interested";
    case "dismissed":
      return "Passed";
    case "snoozed":
      return "Later";
  }
}

/** The exact inverse of `decisionWord`. Writes go back through this, so a
 *  swapped pair here would silently store the opposite of what was clicked. */
export function triageFor(word: DecisionWord): Triage {
  switch (word) {
    case "Needs decision":
      return "";
    case "Interested":
      return "interested";
    case "Passed":
      return "dismissed";
    case "Later":
      return "snoozed";
  }
}

// ---------------------------------------------------------------------------
// Jobs table and views
// ---------------------------------------------------------------------------

/**
 * The six Jobs columns, in order (03 section 4).
 *
 * "Comp" becomes "Pay". "Work model" and "Location" merge into one column
 * because they are one fact to a reader ("Remote, US"). "Min YoE", "Why" and
 * "Warm" leave the table: the first two belong in the detail pane, and the
 * warm-intro indicator rides on the Company cell rather than spending a column
 * on a value most rows do not have.
 */
export const COLUMN_HEADERS = [
  "Company",
  "Title",
  "Pay",
  "Location & model",
  "Posted",
  "Decision",
] as const;

/**
 * The built-in saved views (03 section 4), replacing the five presets in
 * `lib/grid/presets.ts` — Queue, All postings, Snoozed, Dismissed, Needs
 * review. Four of the five now read as the decision they filter on, which is
 * the point: a view is a named query over the Decision column, so its name is
 * the word in that column.
 */
export const SAVED_VIEW_NAMES = [
  "All",
  "Needs decision",
  "Interested",
  "Passed",
  "Later",
] as const;

// ---------------------------------------------------------------------------
// Actions and toasts
// ---------------------------------------------------------------------------

/**
 * The three decision verbs (02 section 6). A verb names its outcome, keeps its
 * name through the flow, and reappears in the toast.
 *
 * The rest of 02's action table — Approve and submit, Withdraw, Reopen,
 * Confirm, Dismiss — arrives with the surfaces that own those verbs. A
 * dictionary entry for a flow nobody can reach is the same defect as a button
 * that opens nothing.
 */
export type DecisionAction = "Interested" | "Pass" | "Later";

/** The button word to the decision it records. */
const ACTION_WORDS: Record<DecisionAction, DecisionWord> = {
  Interested: "Interested",
  Pass: "Passed",
  Later: "Later",
};

/** 02 section 6's toast column, for a single row. */
export function toastFor(action: DecisionAction): string {
  return decisionToast(ACTION_WORDS[action], 1);
}

/**
 * The same toast, for a decision applied to `count` rows at once.
 *
 * Past-tense verb, then the object, then the count — 02 section 6's shape
 * ("Exported 47 roles", "Imported 32 of 32 rows"). At one row it collapses to
 * the bare verb phrase from the action table, so the toast a person sees after
 * pressing `i` is the same string whether they pressed it on a row or on a
 * selection of one. `toastFor` is defined in terms of this, so the two cannot
 * drift.
 *
 * "Needs decision" is here because `StatusSelect` can set a row back to
 * undecided, and a decision being cleared is a thing that happened.
 */
export function decisionToast(word: DecisionWord, count: number, noun = "roles"): string {
  const many = `${count} ${countedNoun(count, noun)}`;
  switch (word) {
    case "Interested":
      return count === 1 ? "Marked interested" : `Marked ${many} interested`;
    case "Passed":
      return count === 1 ? "Passed" : `Passed ${many}`;
    case "Later":
      return count === 1 ? "Saved for later" : `Saved ${many} for later`;
    case "Needs decision":
      return count === 1 ? "Decision cleared" : `Cleared ${count} decisions`;
  }
}

// ---------------------------------------------------------------------------
// Counts and scope
// ---------------------------------------------------------------------------

function singularOf(noun: string): string {
  if (noun.endsWith("ies")) return `${noun.slice(0, -3)}y`;
  if (noun.endsWith("ss")) return noun;
  return noun.endsWith("s") ? noun.slice(0, -1) : noun;
}

function pluralOf(noun: string): string {
  return /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
}

/**
 * The noun for a count. Takes either form — "role" or "roles" — and returns
 * the one the number needs.
 *
 * Accepting both is not sloppiness; it removes the only way this helper can be
 * called wrong. Half the call sites read naturally with a plural ("Export 12
 * roles") and half with a singular ("Copied 1 row"), and a strict signature
 * would silently emit "Copied 3 row" at whichever half got it backwards.
 *
 * English is not solved here and does not need to be: the nouns this product
 * counts are roles, applications, companies, connections and rows.
 */
export function countedNoun(count: number, noun: string): string {
  const singular = singularOf(noun);
  return count === 1 ? singular : pluralOf(singular);
}

/** "Export 12 roles". The button carries the count when a count exists (02
 *  section 6), and the count it carries is the count it acts on. */
export function exportLabel(count: number, noun = "roles"): string {
  return `Export ${count} ${countedNoun(count, noun)}`;
}

/**
 * The table footer (01 section 8, 02 section 8). Unfiltered states the total
 * alone; filtered states both numbers and why they differ. Showing "47 of 47"
 * on an unfiltered table trains a reader to ignore the line.
 */
export function scopeLine(shown: number, total: number, noun = "roles"): string {
  return shown === total
    ? `${total} ${countedNoun(total, noun)}`
    : `${shown} of ${total} match your filters`;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Money per 02 section 8: "$120k" under a million, "$1.2M" above.
 *
 * The input is thousands, because that is the unit the gate and `compMaxK`
 * carry. A trailing ".0" is dropped so a round million reads "$1M".
 */
export function formatPayK(k: number): string {
  if (!Number.isFinite(k)) return NOT_LISTED;
  if (Math.abs(k) >= 1000) {
    return `$${(k / 1000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `$${Math.round(k)}k`;
}

/**
 * A pay range: "$120k–$150k".
 *
 * This is the ONE en dash the product allows (02 section 2), and it is allowed
 * because it is between two numbers. Everywhere else a range or a pause is a
 * comma or a period.
 */
export function formatPayRangeK(minK: number, maxK: number): string {
  return `${formatPayK(minK)}–${formatPayK(maxK)}`;
}

// ---------------------------------------------------------------------------
// Why a row was filtered
// ---------------------------------------------------------------------------

/**
 * Work-model tokens as 02 spells them. The engine writes "onsite"; the
 * dictionary writes "on-site", which is the spelling in 02 section 5's own
 * example sentence.
 */
const WORK_MODEL_WORDS: Record<string, string> = {
  onsite: "on-site",
  "on-site": "on-site",
  hybrid: "hybrid",
  remote: "remote",
};

function sentenceCase(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * A gate reason, as a sentence (02 section 5).
 *
 * The pattern, every time: state the job's fact, then the user's rule it hit.
 * Never show the raw token. `lib/gating/dispose.ts` owns the tokens and keeps
 * owning them — this reads them, and an unknown one falls back to the generic
 * rather than printing itself.
 *
 * The sentences differ from `explainReason` in `lib/data/view-models.ts` on
 * purpose. That function predates this dictionary and says "your limit is 4"
 * where 02 says "your profile says 4", and "Compensation" where 02 says "Pay".
 * When the queue surface cuts over it reads from here and that one goes.
 */
export function reasonSentence(reason: string | null | undefined): string {
  const raw = (reason ?? "").trim();
  if (!raw) return "Matches your search.";

  const kind = raw.split(":")[0];
  const rest = raw.slice(kind.length + 1).trim();
  const generic = "Didn't match your search.";

  switch (kind) {
    case "geo":
      return rest ? `Location is ${rest}, outside your area.` : generic;
    case "geo-unknown":
      return "Location is not listed, and you filter those out.";
    case "metro":
      // "Cities", not "metro": the profile's own section is named cities, and
      // a reason sentence that uses the token's word is halfway to the token.
      return rest ? `Located in ${rest}, outside the cities you follow.` : generic;
    case "metro-unknown":
      return "No city could be matched, and you filter those out.";
    case "work-model": {
      const word = WORK_MODEL_WORDS[rest.toLowerCase()] ?? rest.toLowerCase();
      return word ? `${sentenceCase(word)} only; you excluded ${word}.` : generic;
    }
    case "comp": {
      // The token is `comp:<120k` — the floor in thousands, the way
      // `gates.py` writes it. Re-format through the dictionary's money rules
      // so a floor above a million reads "$1M" and not "$1000k".
      const k = Number(rest.replace(/^</, "").replace(/k$/i, ""));
      return Number.isFinite(k) && k > 0
        ? `Pay is below your ${formatPayK(k)} minimum.`
        : "Pay is below your minimum.";
    }
    case "comp-unknown":
      return "Pay is not listed, and you filter those out.";
    case "yoe": {
      const [asks, limit] = rest.split(">");
      // `yoe:05>4` is a real token: the engine mirrors Python's formatting
      // byte for byte and does not normalise. "Asks for 05+ years" is not a
      // sentence, so the number is read as a number here.
      const asked = Number(asks);
      if (!Number.isFinite(asked) || !limit) return generic;
      return `Asks for ${asked}+ years; your profile says ${limit}.`;
    }
    case "yoe-unknown":
      // Carried by QUALIFIED rows, so this is a fact and not a rejection.
      return "Years of experience are not listed.";
    case "seniority":
      return rest ? `Level is ${rest}; you ruled that level out.` : generic;
    case "title-exclude":
    case "title_exclude":
      return rest ? `Title matches your excluded term "${rest}".` : generic;
    case "awaiting-tags":
      // 02 section 4: the transient state is "checking details", never
      // "awaiting tags" and never "needs-info".
      return "Checking details.";
    default:
      return generic;
  }
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

/**
 * Field names as a person reads them, for the filter chips and the clause
 * builder. This is the display half of `FIELD_LABELS` in `lib/grid/filter.ts`:
 * the engine keeps `compMax` and `triage`, the chip says "Pay" and "Decision".
 *
 * "Min YoE" becomes "Minimum years" — an abbreviation nobody outside the repo
 * expands, and 03 section 4 retires it from the table anyway, so its only
 * remaining appearance is here and in the pane.
 */
export const FILTER_FIELD_LABELS: Record<string, string> = {
  company: "Company",
  title: "Title",
  location: "Location",
  compRange: "Pay",
  compMax: "Pay",
  workModel: "Work model",
  seniority: "Seniority",
  status: "Status",
  triage: "Decision",
  minYoe: "Minimum years",
  posted: "Posted",
  firstSeen: "First seen",
};

/**
 * What a chip says when the clause cannot be phrased: an unknown field, an
 * empty search term, a triage token this dictionary has never heard of.
 *
 * It exists so that the failure mode is a vague chip rather than a leaked
 * machine clause. A user who sees "comp:>=120" learns that the product talks
 * to itself in front of them.
 */
const UNPHRASABLE = "Custom filter";

/**
 * `lib/grid/filter.ts` surfaces undecided rows as the token "undecided", since
 * the empty string cannot ride in a URL. The chip still has to say the word
 * from the Decision column.
 */
const TRIAGE_TOKEN_WORDS: Record<string, DecisionWord> = {
  undecided: "Needs decision",
  interested: "Interested",
  dismissed: "Passed",
  snoozed: "Later",
};

/** "a", "a or b", "a, b or c". No serial comma before "or", and no slash or
 *  pipe standing in for the word (02 section 2). */
function joinOr(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/** Whole days between an ISO date and an instant, or null when the date is
 *  unreadable or not in the past. */
function daysBefore(iso: string, now: number): number | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((now - t) / 86_400_000);
  return days >= 1 ? days : null;
}

/**
 * One clause, as a sentence.
 *
 * Every operator in `lib/grid/filter.ts` produces one: three text, two enum,
 * three number, three date, and the remote clause. None of them can produce a
 * comparison glyph or a field token — the chip is prose or it is
 * `UNPHRASABLE`.
 *
 * `now` is optional and threaded, never read from `Date.now()` inside. When it
 * is supplied, an absolute date bound renders relatively ("Posted over 30d"),
 * which is how a person set it; without it the bound renders as the date
 * ("Posted before Jun 25"). The parameter is explicit for the same reason
 * `clauseMatches` takes one: the server and the hydrating client must render
 * the same instant, or the chip flickers and the console-error scan fails.
 */
export function filterChipLabel(clause: Clause, now?: number): string {
  if (clause.kind === "remote") {
    return clause.value === "remote" ? "Remote only" : "On-site or hybrid";
  }

  const label = FILTER_FIELD_LABELS[clause.field];
  if (!label) return UNPHRASABLE;

  switch (clause.kind) {
    case "text": {
      if (clause.op === "empty") {
        return clause.value ? `${label} is not listed` : `${label} is listed`;
      }
      const value = clause.value.trim();
      if (!value) return UNPHRASABLE;
      return clause.op === "has"
        ? `${label} contains "${value}"`
        : `${label} is "${value}"`;
    }

    case "enum": {
      const words: string[] = [];
      for (const raw of clause.values) {
        if (clause.field === "triage") {
          const word = TRIAGE_TOKEN_WORDS[raw.toLowerCase()];
          if (!word) return UNPHRASABLE; // never leak a triage token
          words.push(word);
        } else {
          const value = raw.trim();
          if (!value) return UNPHRASABLE;
          words.push(value);
        }
      }
      if (words.length === 0) return UNPHRASABLE;
      // "is not Remote or Hybrid" reads in plain English as "not (Remote or
      // Hybrid)", which is exactly what `notin` matches.
      return `${label} is${clause.op === "notin" ? " not" : ""} ${joinOr(words)}`;
    }

    case "number": {
      const fmt = (n: number) => (clause.field === "compMax" ? formatPayK(n) : String(n));
      if (clause.op === "between") {
        return clause.field === "compMax"
          ? `${label} ${formatPayRangeK(clause.min, clause.max)}`
          : `${label} ${clause.min}–${clause.max}`;
      }
      if (!Number.isFinite(clause.value)) return UNPHRASABLE;
      return `${label} ${clause.op === "gte" ? "above" : "below"} ${fmt(clause.value)}`;
    }

    case "date": {
      if (clause.op === "inlast") return `${label} under ${clause.days}d`;
      if (now !== undefined) {
        const days = daysBefore(clause.value, now);
        // `before cutoff` is "older than the cutoff"; `after cutoff` is
        // "newer than". Both read as a window when the cutoff is in the past.
        if (days !== null) {
          return clause.op === "before"
            ? `${label} over ${days}d`
            : `${label} under ${days}d`;
        }
      }
      const day = fmtDay(clause.value);
      // `fmtDay` answers an unreadable date with an em dash, which is banned
      // copy; the vague chip is the better failure.
      if (!day || day === "—") return UNPHRASABLE;
      return `${label} ${clause.op === "before" ? "before" : "after"} ${day}`;
    }
  }
}

/** One chip per OR-group, since the filter is an AND of groups and a group is
 *  one condition to a reader. */
export function filterGroupLabel(group: OrGroup, now?: number): string {
  if (group.length === 0) return UNPHRASABLE;
  return group.map((c) => filterChipLabel(c, now)).join(" or ");
}

/** The chip row for a whole filter. */
export function filterChipLabels(filter: GridFilter, now?: number): string[] {
  return filter.map((group) => filterGroupLabel(group, now));
}
