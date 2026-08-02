/**
 * The words. What each policy topic is called, what each provenance token means,
 * and what each gap ASKS.
 *
 * Pure and separate from both surfaces because two of them render it — the
 * settings editor and the review screen — and because the copy is the feature
 * here as much as the resolver is. A gap rendered as an error teaches somebody
 * that the tool is broken; the same gap rendered as its question gets answered
 * and never asked again.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * GAP_COPY IS EXHAUSTIVE ON PURPOSE
 *
 * `GapReason` is a closed set and `lib/apply/types.ts` says why: "the review
 * surface renders one affordance per reason, and a `default:` branch there would
 * be a gap nobody can act on". `Record<GapReason, …>` is what makes a new reason
 * a compile error rather than a blank card.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE POLARITY IS SHOWN, ALWAYS
 *
 * `prepare.ts` stamps `policy:<topic>[@<company>]/<direction>` and its comment is
 * unambiguous about why: "the direction is the half a person needs in order to
 * catch the engine misreading a question. Showing the topic alone is what made
 * the polarity bug invisible for a whole build." `describeSource` therefore
 * returns the direction as a sentence, and the chip renders it.
 */
import type { GapReason, SituationFact } from "./types";
import { KNOCKOUT_TOPICS, POLICY_TOPICS, type PolicyTopic } from "./policy";
import { NOT_LISTED } from "@/lib/data/view-models";

/** Which control a topic's situation is edited with. */
export type TopicField =
  | "boolean"
  | "money"
  | "text"
  | "countries"
  /** `none` / `has` — the only enum the engine turns into an answer. */
  | "history"
  /** A fixed date, or the computed "the Monday N weeks out". */
  | "start-date";

export type TopicSpec = {
  /** What this rule is called in a heading. */
  label: string;
  /** The question a person answers to set it. Second person, one sentence. */
  question: string;
  field: TopicField;
  /** What it changes, or what it deliberately does not. Optional. */
  help?: string;
};

/**
 * One spec per topic in `POLICY_TOPICS`. `Record<PolicyTopic, …>` means a topic
 * added to 0014 and to `policy.ts` cannot reach a screen with no words for it.
 *
 * The `field` of each is the fact kind `deriveAnswer` can actually use for that
 * topic — a `text` fact on `visa_sponsorship` gaps as `situation-mismatch`, so
 * offering a text box there would be offering a rule that never answers anything.
 */
export const TOPIC_SPECS: Record<PolicyTopic, TopicSpec> = {
  work_authorization: {
    label: "Work authorization",
    question: "Which countries can you work in without permission from an employer?",
    field: "countries",
    help: "A board asks about one country at a time. If the question names a country that is not on your list, the answer is No; if it names a country this app cannot recognise, nobody answers it.",
  },
  visa_sponsorship: {
    label: "Visa sponsorship",
    question: "Do you need an employer to sponsor a visa?",
    field: "boolean",
    help: "Asked both ways round on real boards. Storing the situation rather than the word is what lets one answer cover both.",
  },
  compensation: {
    label: "Pay expectation",
    question: "What number do you put when a form asks what you expect?",
    field: "money",
    help: "Used only for expected, desired, target or minimum. A question about your CURRENT salary is a different fact and is never answered from this.",
  },
  criminal_history: {
    label: "Convictions",
    question: "Do you have a conviction to disclose?",
    field: "history",
  },
  background_check_consent: {
    label: "Background check",
    question: "Will you consent to a background check?",
    field: "boolean",
    help: "Kept apart from convictions on purpose: they are opposite-signed questions about different facts, and one rule answering both is how a stored No became a refusal to be screened.",
  },
  legal_name: {
    label: "Legal name",
    question: "What is your legal name, as it appears on your documents?",
    field: "text",
  },
  age_eligibility: {
    label: "Age",
    question: "Are you 18 or older?",
    field: "boolean",
  },
  relocation: {
    label: "Relocation",
    question: "Are you open to relocating for a role?",
    field: "boolean",
    help: "A question about relocation ASSISTANCE (whether the company would pay to move you) is a different fact and is left for you.",
  },
  current_location: {
    label: "Where you live",
    question: "What do you put when a form asks where you are based?",
    field: "text",
  },
  start_date: {
    label: "Start date",
    question: "When could you start?",
    field: "start-date",
    help: "A notice-period question asks something else and is left for you.",
  },
  prior_employment: {
    label: "Worked there before",
    question: "Have you been employed by the company you are applying to?",
    field: "boolean",
    help: "Usually no, and true at one or two places. That is what a company exception is for.",
  },
  prior_interview: {
    label: "Interviewed there before",
    question: "Have you interviewed with the company you are applying to?",
    field: "boolean",
  },
  relative_at_company: {
    label: "Relative there",
    question: "Do you have a relative working at the company you are applying to?",
    field: "boolean",
  },
  employee_referral: {
    label: "Referred by an employee",
    question: "Were you referred by somebody who works there?",
    field: "boolean",
    help: "Set a company exception when somebody refers you, rather than changing this each time.",
  },
  onsite_commitment: {
    label: "Working in person",
    question: "Are you open to working in an office some of the time?",
    field: "boolean",
  },
  how_did_you_hear: {
    label: "How you heard about the job",
    question: "What do you put when a form asks how you heard about the role?",
    field: "text",
  },
};

const KNOCKOUT_SET: ReadonlySet<string> = new Set(KNOCKOUT_TOPICS);

/**
 * The `enum` fact's stored tokens.
 *
 * Engine values on the wire, never words on screen — named here so the copy
 * lint reads the sentences below rather than the token they switch on.
 */
const DISCLOSURE_NONE = "none";

/** The topic's own name, or the raw string for a topic this build does not know. */
export function topicLabel(topic: string): string {
  return TOPIC_SPECS[topic as PolicyTopic]?.label ?? topic;
}

/** Knockout topics first — a screen that buries them under "how did you hear" has its priorities wrong. */
export const TOPICS_IN_ORDER: readonly PolicyTopic[] = POLICY_TOPICS;

export function isKnockout(topic: string): boolean {
  return KNOCKOUT_SET.has(topic);
}

/** One stored situation, as a sentence a person can check at a glance. */
export function describeFact(fact: SituationFact | null): string {
  if (fact === null) return "Stored in a form this app cannot read";
  switch (fact.kind) {
    case "boolean":
      return fact.value ? "Yes" : "No";
    case "enum":
      return fact.value === DISCLOSURE_NONE
        ? "Nothing to disclose"
        : "Yes, there is something to disclose";
    case "text":
      return fact.value;
    case "countries":
      return fact.value.join(", ");
    case "money":
      // `toLocaleString` with an explicit locale: the server and the browser must
      // render the same string or the markup mismatches on hydration.
      return `$${fact.value.toLocaleString("en-US")}${fact.currency && fact.currency !== "USD" ? ` ${fact.currency}` : ""}`;
    case "date":
      return fact.value;
    case "directive": {
      const weeks = /^monday-weeks-out:(\d+)$/.exec(fact.value);
      return weeks ? `The first Monday at least ${weeks[1]} weeks out` : fact.value;
    }
    default:
      return "Stored in a form this app cannot read";
  }
}

/** What the engine says about where a value came from, in words. */
export type SourceDescription = {
  /** "Your saved answer", "Your rule", "Likely". */
  what: string;
  /** The rule's topic, when there is one. */
  topic: string | null;
  /** The company key a per-company rule was scoped to, or null for the global one. */
  company: string | null;
  /** "read as asked", "read as the opposite", … — never omitted for a rule. */
  direction: string | null;
};

const DIRECTIONS: Record<string, string> = {
  direct: "read as asked",
  inverted: "read as the opposite",
  unanswerable: "read as a different question",
  uncertain: "direction not established",
};

/**
 * Parse the token `prepare.ts` stamps.
 *
 * `policy:<topic>[@<company key>]/<direction>` · `answer:<question key>` ·
 * `inference`. An unrecognised token is described as itself rather than dropped:
 * a value on screen with no provenance beside it is exactly what this feature
 * exists to avoid.
 */
export function describeSource(source: string): SourceDescription {
  if (source.startsWith("answer:")) {
    // `answer:<question key>[@<company key>]` — the scope 0017 added. A question
    // key is `[a-z0-9 ]+` by construction, so the first `@` is the separator.
    // Showing it matters for the same reason the polarity does: an answer that is
    // right at one company and wrong at every other is a thing to be able to see.
    const at = source.indexOf("@");
    return {
      what: "Your saved answer",
      topic: null,
      company: at === -1 ? null : source.slice(at + 1) || null,
      direction: null,
    };
  }
  if (source === "inference") {
    return { what: "Likely", topic: null, company: null, direction: null };
  }
  if (source.startsWith("policy:")) {
    const rest = source.slice("policy:".length);
    const slash = rest.lastIndexOf("/");
    const scope = slash === -1 ? rest : rest.slice(0, slash);
    const direction = slash === -1 ? "" : rest.slice(slash + 1);
    const at = scope.indexOf("@");
    const topic = at === -1 ? scope : scope.slice(0, at);
    const company = at === -1 ? null : scope.slice(at + 1);
    return {
      what: "Your rule",
      topic,
      company,
      // An unknown direction is named as unknown rather than left blank: the
      // whole point of carrying it is that a person can catch a misreading.
      direction: DIRECTIONS[direction] ?? "direction not established",
    };
  }
  return { what: source || NOT_LISTED, topic: null, company: null, direction: null };
}

/**
 * What a gap is, what to do about it, and whether it is one a person can close
 * from the review screen at all.
 *
 * `answerable: false` is not a failure to build a control — it is the design.
 * Self-identification is the human's alone even here; an attachment is not a
 * question; a consent is not a field to fill in on somebody's behalf.
 */
export type GapCopy = {
  title: string;
  body: string;
  /** Can a typed answer here close it? */
  answerable: boolean;
  /** Where the real fix lives, when it is not this screen. */
  fix?: "situation" | "library";
};

export const GAP_COPY: Record<GapReason, GapCopy> = {
  "no-answer": {
    title: "Not answered yet",
    body: "Answer it once here and it is saved for every board that asks it in the same words.",
    answerable: true,
    fix: "library",
  },
  "policy-unset": {
    // The old body offered "answer it here, OR set the rule once and every board
    // gets the same answer" — two scopes, presented as a choice. They were the
    // same scope, and the first one won: a typed answer went into the library,
    // which the engine reads before any rule. The two really do differ, just not
    // in the way that sentence claimed, so it now says what the difference is.
    title: "No rule for this",
    body: "A question about you rather than about this job. Answering here saves this exact wording; setting the rule covers every way a board asks it.",
    answerable: true,
    fix: "situation",
  },
  "policy-ambiguous": {
    title: "Reads as two questions at once",
    body: "It matched more than one of your rules, so nothing was picked. Answering it directly is the only way through.",
    answerable: true,
  },
  "polarity-unknown": {
    title: "The direction is not clear",
    body: "The subject was read and not which way round it is asked. Replaying a stored word here is how a No becomes a Yes, so nothing was.",
    answerable: true,
  },
  "situation-mismatch": {
    title: "Your rule does not fit this question",
    body: "The rule exists and holds a different kind of fact than this question needs, or it names a country the question does not.",
    answerable: true,
    fix: "situation",
  },
  "option-mismatch": {
    title: "Your answer is not on the menu",
    body: "The value that would be submitted is not one of the options this board offers. Pick one of theirs.",
    answerable: true,
  },
  "sensitive-unclassified": {
    title: "Looks like a deal-breaker question",
    body: "It names something a wrong answer ends an application over, and nothing here read it well enough to answer. Yours to answer.",
    answerable: true,
  },
  "self-identification": {
    // "…reused nowhere else" was false, and provably so: an EEO answer typed
    // once comes back on every board wording the question identically, and
    // Greenhouse's EEO block is federal boilerplate, so identical wording is the
    // common case. The behaviour is the design; the sentence was the lie.
    title: "Self-identification, yours alone",
    body: "Nothing fills these in and nothing picks \"I don't wish to answer\" for you. Both are choices, and they are yours. What you choose is saved against this exact question and comes back on any board that asks it in the same words, a decline included. Remove it under Application answers whenever you want.",
    answerable: true,
  },
  "free-response": {
    title: "Wants prose",
    body: "Drafting long answers is a later piece of work. Write it on the board, or paste what you write here to keep it.",
    answerable: true,
    fix: "library",
  },
  attachment: {
    title: "A file upload",
    body: "Prepare does not attach anything. This is why no real board reaches \"ready\". Every one of them asks for a resume.",
    answerable: false,
  },
  consent: {
    title: "A consent to agree to",
    body: "Agreeing to something on your behalf is not filling in a field. Tick it on the board.",
    answerable: false,
  },
  unsupported: {
    title: "A field this app could not read",
    body: "The board asked for something in a shape this parser does not know. Nothing was guessed into it.",
    answerable: false,
  },
};

/**
 * `answers.kind` in front of a person.
 *
 * The stored vocabulary is the storage's — `auth`, `eeo`, `freeform` — and
 * printing it on a settings page is the internal-jargon failure the resume rules
 * name one domain over. A kind this build does not know prints as itself rather
 * than as nothing.
 */
const KIND_LABELS: Record<string, string> = {
  identity: "About you",
  location: "Where you are",
  address: "Address",
  auth: "Work authorization",
  comp: "Pay",
  skills: "Skills",
  eeo: "Self-identification",
  freeform: "Anything else",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * Which `answers.kind` a typed answer to this field should be stored under.
 *
 * Metadata, not a gate — the engine reads the payload's demographic block and
 * `authored_by`, never this — so being wrong here costs a mis-filed row on the
 * settings page and nothing else. `eeo` is set from the block for the same
 * reason 0014's constraint exists: a row that says it is a self-identification
 * answer and was written by a machine should be refusable at the door.
 */
export function kindForField(input: {
  selfIdentification: boolean;
  topic: string | null;
}): string {
  if (input.selfIdentification) return "eeo";
  switch (input.topic) {
    case "work_authorization":
    case "visa_sponsorship":
      return "auth";
    case "compensation":
      return "comp";
    case "current_location":
      return "location";
    case "legal_name":
      return "identity";
    default:
      return "freeform";
  }
}

/** Which layer answered, in words. */
export function layerLabel(layer: "constant" | "policy" | "inference" | null): string {
  if (layer === "constant") return "Saved answer";
  if (layer === "policy") return "Rule";
  if (layer === "inference") return "Likely";
  return "Not answered";
}
