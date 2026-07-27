/**
 * Layer 2's reading of a question: which policy topic, and **which direction**.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS A POLARITY DIMENSION AT ALL
 *
 * The first version of this file classified a topic and then submitted the
 * literal word the user had stored for it. An adversarial review executed the
 * consequence — a correct rule, a real phrasing, and a wrong knockout answer on
 * a card marked `ready`:
 *
 *     rule visa_sponsorship = "No"
 *     "Are you able to work in the US WITHOUT sponsorship?"      -> "No"
 *     rule criminal_history = "No"
 *     "Are you willing to submit to a BACKGROUND CHECK?"         -> "No"
 *     rule relocation = "Yes"
 *     "Do you REQUIRE RELOCATION ASSISTANCE?"                    -> "Yes"
 *
 * One topic covers questions of opposite polarity, and sometimes questions about
 * different facts entirely. The old file's own comment argued that two topic
 * matches must be a gap because "a precedence order would silently pick one and
 * be wrong half the time" — and did not apply that reasoning WITHIN a topic,
 * where it is the same argument.
 *
 * So a rule no longer stores an answer. It stores the person's SITUATION as a
 * typed fact (`needs_sponsorship: false`, `authorized_in: ["united states"]`,
 * `min_comp: 180000`), and `prepare.ts` derives the answer from
 *
 *     situation  ×  the question's detected polarity
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHEN IN DOUBT, GAP. This is the rule, and it is absolute.
 *
 * `classifyTopic` answers `uncertain` unless EXACTLY ONE polarity class matches
 * — zero matches is uncertain, two matches is uncertain — and `prepare.ts` turns
 * `uncertain` into a gap without consulting any other layer. A question the
 * engine half-understands is a question a human answers.
 *
 * The concrete cost is real and accepted: "Do you require work authorization to
 * be employed here?" matches both the direct and the inverted class and
 * therefore gaps, even though a person could read it in a second. A gap costs
 * one keystroke. The alternative cost is a submitted lie with the user's name on
 * it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TWO LISTS, TUNED IN OPPOSITE DIRECTIONS
 *
 * The review's other finding was that layer 3's knockout immunity was exactly
 * this classifier's recall — a circular argument, and against 50 real ATS
 * phrasings the classifier missed 12 knockout questions, one of which an
 * inference hook then answered on a required sponsorship select.
 *
 * The answer is not "improve recall until nothing is missed", which is
 * unreachable. It is a SECOND list with the opposite tuning:
 *
 *   `PATTERNS`   precision-tuned. Governs what may be ANSWERED. A false positive
 *                here submits a wrong answer, so every pattern is narrower than
 *                it could be.
 *   `SENSITIVE`  recall-tuned. Governs what may NOT be inferred or drafted. A
 *                false positive here costs a gap, so it is deliberately broad —
 *                bare `visa`, bare `salary`, bare `18` — and it is not required
 *                to agree with `PATTERNS` about anything.
 *
 * A label that trips `SENSITIVE` and does not classify is a gap. Layer 3 cannot
 * see it. That is a structural property rather than an argument about coverage.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PRECISION IS STILL THE POINT, and two patterns are narrow because a REAL
 * question on a REAL board would otherwise be caught. Both are
 * conflict-of-interest disclosures where a generic "no" is a guess:
 *
 *   Coinbase: "Are you a close relative of a GOVERNMENT OFFICIAL…"
 *     — has "relative", is not `relative_at_company`, so that topic also
 *       requires an employment anchor.
 *   Coinbase: "were you referred to this position by a senior leader … at a …
 *     client, business partner, or VENDOR of Coinbase?"
 *     — has "referred", is not `employee_referral`, so that topic also requires
 *       an employee anchor.
 *
 * WHAT IS DELIBERATELY NOT A TOPIC: self-identification (it comes from the
 * payload BLOCK — see `greenhouse.ts` — and a label-text classifier for it would
 * need precision nothing in the fixtures supports), and anything with no
 * evidence on a real board.
 */
import { questionKey } from "./normalize";

/**
 * The topics whose WRONG answer ends an application.
 *
 * `AUTO-APPLY.md`'s hard-constant list, plus two additions each stated rather
 * than slipped in:
 *
 *   `age_eligibility` — a legal eligibility question observed live (Coinbase),
 *   not on the plan's list. The conservative direction on a legal eligibility
 *   question is the knockout side.
 *
 *   `background_check_consent` — SPLIT OUT of `criminal_history` by the review.
 *   "Have you been convicted?" and "Will you consent to a background check?" are
 *   opposite-signed questions about different facts, and one topic answering
 *   both is exactly how a stored "No" became "I refuse a background check".
 */
export const KNOCKOUT_TOPICS = [
  "work_authorization",
  "visa_sponsorship",
  "compensation",
  "criminal_history",
  "background_check_consent",
  "legal_name",
  "age_eligibility",
] as const;

/** Topics a rule may answer, with a human still owning the situation. */
export const STANDARD_TOPICS = [
  "relocation",
  "current_location",
  "start_date",
  "prior_employment",
  "prior_interview",
  "relative_at_company",
  "employee_referral",
  "onsite_commitment",
  "how_did_you_hear",
] as const;

/**
 * The closed set, in the order 0014's CHECK constraint declares it.
 * `apply-policy-parity.test.ts` PARSES that constraint and compares.
 */
export const POLICY_TOPICS = [...KNOCKOUT_TOPICS, ...STANDARD_TOPICS] as const;

export type PolicyTopic = (typeof POLICY_TOPICS)[number];

const KNOCKOUT_SET: ReadonlySet<string> = new Set(KNOCKOUT_TOPICS);

/** Is a wrong answer here fatal? Layers 3 and 4 may never reach one. */
export function isKnockoutTopic(topic: string): boolean {
  return KNOCKOUT_SET.has(topic);
}

/**
 * Which way the question is asked, relative to the stored situation.
 *
 *   direct        the answer IS the situation      "Do you require sponsorship?"
 *   inverted      the answer is its opposite       "Can you work WITHOUT sponsorship?"
 *   unanswerable  the topic matched but the question asks about a DIFFERENT
 *                 fact than the topic's rule holds — "Do you require relocation
 *                 ASSISTANCE?", "What is your CURRENT salary?"
 *   uncertain     zero or several classes matched
 *
 * The last two both gap. They are distinguished because `unanswerable` is a
 * recognised question the engine is declining and `uncertain` is one it did not
 * read, and a review surface can say different things about them.
 */
export type Polarity = "direct" | "inverted" | "unanswerable" | "uncertain";

interface Pattern {
  topic: PolicyTopic;
  /** Every one must match the normalized label. */
  all: RegExp[];
}

/** Polarity classes for one topic. Exactly one must match, or it is `uncertain`. */
interface PolarityRules {
  direct: RegExp[];
  inverted?: RegExp[];
  unanswerable?: RegExp[];
}

/**
 * Precision-tuned. Written against the NORMALIZED key, so `\b` boundaries are
 * reliable and no pattern contains punctuation. Real labels from the three
 * recorded boards and from the review's 50-phrasing corpus are quoted beside the
 * patterns they exist for.
 */
const PATTERNS: Pattern[] = [
  // "Are you legally authorized to work in the country where this position is located?" (Coinbase)
  // "Are you legally eligible to work in the United States?" · "unrestricted right to work"
  {
    topic: "work_authorization",
    all: [/\b(authori[sz]ed|eligible)\b.{0,25}\bto work\b|\bright to work\b/],
  },
  // "Do you require visa sponsorship?" + the lawyer's version of the same question.
  { topic: "visa_sponsorship", all: [/\bsponsorship\b|\bsponsor\b/] },
  {
    topic: "compensation",
    all: [
      /\b(salary|compensation|comp|pay|wage|base|ote)\b/,
      /\bexpect\w*\b|\brequirement\w*\b|\bdesired\b|\btarget\b|\bminimum\b|\bcurrent\b|\bseeking\b|\brange\b/,
    ],
  },
  // Disclosure. NOT consent — that is its own topic now.
  {
    topic: "criminal_history",
    all: [
      /\bconvict\w*\b|\bcriminal\b|\bfelony\b|\bfelonies\b|\bmisdemean\w*\b|\barrest\w*\b|\bpleaded\b|\bnolo contendere\b/,
    ],
  },
  // "Are you willing to submit to a background check?" · "Do you consent to a background check?"
  { topic: "background_check_consent", all: [/\bbackground (check|screen\w*|investigation)\b/] },
  { topic: "legal_name", all: [/\blegal name\b|\bname as it appears\b/] },
  // "Are you at least 18 years of age?" (Coinbase) · "over 18" · "of legal working age"
  {
    topic: "age_eligibility",
    all: [
      /\bat least 18\b|\b18 years (of age|or older)\b|\b18 or older\b|\bover 18\b|\bover the age of 18\b|\blegal working age\b|\bunder 18\b|\bunder the age of 18\b/,
    ],
  },

  // "Are you open to relocation for this role?" (Anthropic)
  { topic: "relocation", all: [/\brelocat\w*\b/] },
  // "Are you currently located in the US?" (Discord) · "What is the address…" (Anthropic)
  {
    topic: "current_location",
    all: [
      /\bcurrently (located|residing|living|based)\b|\bwhere (do|are) you\b|\byour (current )?(address|location)\b|\bwhat is the address\b|\bcity and state\b|\bbased in\b/,
    ],
  },
  // "When is the earliest you would want to start working with us?" (Anthropic)
  {
    topic: "start_date",
    all: [
      /\bstart date\b|\bearliest\b.{0,30}\bstart\b|\bwhen (can|could|would) you\b.{0,20}\bstart\b|\bavailable to start\b|\bnotice period\b|\bavailability to start\b/,
    ],
  },
  // "Have you previously been employed by Coinbase in any capacity?" (Coinbase)
  {
    topic: "prior_employment",
    all: [
      /\b(previously|ever|formerly)\b.{0,20}\b(employed|worked)\b|\bformer employee\b|\bworked (here|for us)\b/,
    ],
  },
  // "Have you ever interviewed at Anthropic before?" (Anthropic)
  { topic: "prior_interview", all: [/\binterview\w*\b/, /\b(ever|previously|before|past)\b/] },
  {
    topic: "relative_at_company",
    all: [
      /\b(relative|relatives|family member|immediate family|spouse|parent|sibling)\b/,
      /\b(employed|employee|employees|work|works|working)\b/,
    ],
  },
  {
    topic: "employee_referral",
    all: [
      /\brefer\w*\b/,
      /\b(employee|employees|team member|colleague|someone who works|current employee)\b/,
    ],
  },
  // "Are you open to working in-person in one of our offices 25% of the time?" (Anthropic)
  {
    topic: "onsite_commitment",
    all: [
      /\bin person\b|\bin office\b|\bonsite\b|\bon site\b|\bhybrid\b/,
      /\b(open to|willing|able|comfortable|commit\w*|prepared)\b/,
    ],
  },
  // "How did you hear about this job?" (Coinbase, Discord)
  {
    topic: "how_did_you_hear",
    all: [/\bhow did you hear\b|\bhow (did|do) you (find|learn)\b|\bwhere did you hear\b/],
  },
];

/**
 * Which direction each topic can be asked in.
 *
 * A topic with only a `direct` class still gaps on a phrasing that matches
 * nothing — `uncertain` is the DEFAULT, not `direct`. That is the difference
 * between "we read this question" and "we recognised a word in it".
 */
const POLARITY: Record<PolicyTopic, PolarityRules> = {
  // situation: authorized_in (countries).
  work_authorization: {
    direct: [/\b(authori[sz]ed|eligible)\b.{0,25}\bto work\b|\bright to work\b/],
    // "Do you REQUIRE work authorization…" — asks the opposite of the fact.
    // Overlaps the direct class on purpose: both match, so it gaps rather than
    // guessing which reading the recruiter meant.
    inverted: [/\b(require|requires|need|needs)\b.{0,25}\b(authori[sz]ation|permit)\b/],
  },
  // situation: needs_sponsorship (boolean).
  visa_sponsorship: {
    direct: [/\b(require|requires|need|needs|sponsorship required)\b/],
    inverted: [/\bwithout sponsorship\b|\bnot require sponsorship\b|\bno sponsorship\b/],
  },
  // situation: min_comp (money). A CURRENT-salary question is a different fact
  // and is refused rather than answered from a minimum — it is also illegal to
  // ask in several US states, which is its own reason not to volunteer one.
  compensation: {
    direct: [/\bexpect\w*\b|\bdesired\b|\btarget\b|\bminimum\b|\bseeking\b|\brequirement\w*\b/],
    unanswerable: [/\bcurrent\b|\bpresent\b|\bmost recent\b|\bprior\b|\bprevious\b/],
  },
  // situation: felony_disclosure (enum none|has).
  criminal_history: {
    direct: [/\bhave you\b|\bwere you\b|\bever been\b|\bdo you have\b/],
  },
  // situation: will_consent (boolean).
  background_check_consent: {
    direct: [/\bwilling\b|\bconsent\b|\bagree\b|\bsubmit to\b|\bundergo\b|\bauthori[sz]e\b/],
  },
  // situation: legal_name (text).
  legal_name: { direct: [/\bname\b/] },
  // situation: is_over_18 (boolean).
  age_eligibility: {
    direct: [
      /\bat least 18\b|\b18 or older\b|\bover 18\b|\bover the age of 18\b|\b18 years (of age|or older)\b|\blegal working age\b/,
    ],
    inverted: [/\bunder 18\b|\bunder the age of 18\b/],
  },

  // situation: relocation_open (boolean). "Do you require relocation ASSISTANCE"
  // asks whether the company must pay to move you — a different fact.
  relocation: {
    direct: [/\bwilling\b|\bopen to\b|\bable to\b|\bprepared to\b|\bconsider\b/],
    unanswerable: [/\bassistance\b|\bpackage\b|\bsupport\b|\bstipend\b|\breimburse\w*\b/],
  },
  // situation: a `text` address, or a `countries` list for "are you in X?".
  current_location: {
    direct: [
      /\bcurrently (located|residing|living|based)\b|\bwhere (do|are) you\b|\byour (current )?(address|location)\b|\bwhat is the address\b|\bcity and state\b|\bbased in\b/,
    ],
  },
  // situation: a date or a directive. A NOTICE PERIOD is not a start date.
  start_date: {
    direct: [
      /\bstart date\b|\bearliest\b|\bwhen (can|could|would) you\b|\bavailable to start\b|\bavailability to start\b/,
    ],
    unanswerable: [/\bnotice period\b/],
  },
  prior_employment: {
    direct: [/\b(previously|ever|formerly)\b|\bformer employee\b|\bworked (here|for us)\b/],
  },
  prior_interview: { direct: [/\b(ever|previously|before|past)\b/] },
  relative_at_company: { direct: [/\b(do|have|are) you\b|\bany\b/] },
  employee_referral: { direct: [/\bwere you\b|\bwho referred\b|\bwas your\b|\bdid (an|a|any)\b/] },
  onsite_commitment: { direct: [/\b(open to|willing|able|comfortable|commit\w*|prepared)\b/] },
  how_did_you_hear: { direct: [/\bhow\b|\bwhere\b/] },
};

/**
 * Recall-tuned. What may never be inferred or drafted, whether or not it
 * classifies.
 *
 * Deliberately broader than `PATTERNS` and NOT required to agree with it. A
 * false positive costs a gap and a different label on a review card; a false
 * negative hands a work-authorization select to a language model, which is the
 * failure the whole feature is judged on.
 */
const SENSITIVE: RegExp[] = [
  /\bsponsor\w*\b|\bvisa\b|\bvisas\b|\bimmigration\b|\bwork permit\b|\bh1b\b|\bh 1b\b|\btn\b|\bopt\b/,
  /\bauthori[sz]\w*\b|\beligib\w*\b|\bright to work\b|\bcitizen\w*\b|\bresidenc\w*\b|\bgreen card\b/,
  // `base` and `remuneration` are here because "Desired annual base (USD)" — a
  // real phrasing from the review's corpus — carries none of the other words.
  /\bsalary\b|\bsalaries\b|\bcompensation\b|\bcomp\b|\bpay\b|\bwage\w*\b|\bote\b|\bbonus\b|\bequity\b|\bbase\b|\bremuneration\b/,
  /\bconvict\w*\b|\bcriminal\b|\bfelony\b|\bfelonies\b|\bmisdemean\w*\b|\barrest\w*\b|\bcharged with\b|\bguilty\b|\bbackground (check|screen\w*)\b|\bclearance\b/,
  /\blegal name\b|\bgovernment issued\b|\bpassport\b|\bsocial security\b|\bssn\b|\bdate of birth\b|\bbirthdate\b/,
  /\b18\b|\bage\b|\bages\b/,
  /\bgender\b|\bsex\b|\brace\b|\bethnic\w*\b|\bveteran\b|\bdisab\w*\b|\blgbt\w*\b|\borientation\b|\bpronoun\w*\b|\breligio\w*\b/,
];

/**
 * A consent or acknowledgement. Not a topic, and not a gap the review surface
 * should label "no answer".
 *
 * Coinbase's "I understand that Coinbase may use AI tools…" and Anthropic's "AI
 * Policy for Application" are both REQUIRED selects, so leaving them
 * unclassified blocked those applications with the wrong explanation attached.
 * They are still never auto-answered — agreeing on somebody's behalf is not
 * filling in a field, and a blanket "acknowledge things → yes" rule would also
 * swallow "do you consent to a background check?". Naming them buys the right
 * affordance, not an answer.
 */
const CONSENT: RegExp[] = [
  /\bi (understand|acknowledge|agree|consent|certify|confirm)\b/,
  /\backnowledg\w*\b/,
  /\b(do you )?(consent|agree) to (the|our|these)\b/,
  /\bai policy\b|\bpolicy for application\b|\bterms and conditions\b|\bprivacy (policy|notice)\b/,
];

export function isSensitiveLabel(label: string | null | undefined): boolean {
  const key = questionKey(label);
  return key !== "" && SENSITIVE.some((re) => re.test(key));
}

export function isConsentLabel(label: string | null | undefined): boolean {
  const key = questionKey(label);
  return key !== "" && CONSENT.some((re) => re.test(key));
}

/**
 * The country a question is asking about, as a lowercased key.
 *
 * `work_authorization` and one reading of `current_location` are questions about
 * a PLACE, and a stored list of countries cannot answer them without knowing
 * which one. Unresolvable → `null` → the caller gaps. There is no "assume the
 * US" branch; that assumption is a wrong knockout answer for anybody applying
 * from anywhere else.
 *
 * `postingCountry` covers the deferring phrasings ("the country where this
 * position is located", which is what Coinbase asks) and is itself optional — a
 * caller that does not know the posting's country gets a gap, correctly.
 */
const COUNTRY_LEXICON: Array<[RegExp, string]> = [
  [/\bunited states\b|\busa\b|\bu s a\b|\bus\b|\bu s\b|\bamerica\b/, "united states"],
  [/\bcanada\b|\bcanadian\b/, "canada"],
  [/\bunited kingdom\b|\buk\b|\bbritain\b|\bengland\b/, "united kingdom"],
  [/\bireland\b/, "ireland"],
  [/\bgermany\b/, "germany"],
  [/\bindia\b/, "india"],
  [/\baustralia\b/, "australia"],
];

const DEFERS_TO_POSTING =
  /\bthe country (where|in which)\b|\bthis country\b|\bthe country of\b|\bfor our company\b/;

export function resolveQuestionCountry(
  label: string | null | undefined,
  postingCountry?: string,
): string | null {
  const key = questionKey(label);
  if (key === "") return null;
  const unique = [
    ...new Set(COUNTRY_LEXICON.filter(([re]) => re.test(key)).map(([, name]) => name)),
  ];
  // Two named countries in one question ("US or Canada") is a compound the
  // engine does not read. Gap.
  if (unique.length > 1) return null;
  if (unique.length === 1) return unique[0];
  if (DEFERS_TO_POSTING.test(key)) {
    const posting = (postingCountry ?? "").trim().toLowerCase();
    return posting === "" ? null : posting;
  }
  return null;
}

/**
 * The verdict on one label.
 *
 * `ambiguous` carries the competing topics because the review surface shows
 * them: "this reads as both relocation and current location — which did they
 * mean?" is a better prompt than a bare unanswered field.
 */
export type TopicMatch =
  | { kind: "none" }
  | { kind: "topic"; topic: PolicyTopic; polarity: Polarity }
  | { kind: "ambiguous"; topics: PolicyTopic[] };

/**
 * Classify a question label into at most one policy topic AND one direction.
 *
 * Takes no company, no posting and no user: a classifier that can see who is
 * asking is one whose verdicts differ between two callers looking at the same
 * form, and the corpus could not pin it. Per-company behaviour lives in rule
 * RESOLUTION (`prepare.ts`); the question's country is resolved separately by
 * `resolveQuestionCountry`, which takes exactly the one extra fact it needs.
 */
export function classifyTopic(label: string | null | undefined): TopicMatch {
  const key = questionKey(label);
  if (key === "") return { kind: "none" };

  const hits: PolicyTopic[] = [];
  for (const p of PATTERNS) {
    if (p.all.every((re) => re.test(key))) hits.push(p.topic);
  }

  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", topics: hits };

  const topic = hits[0];
  const rules = POLARITY[topic];
  const matched: Polarity[] = [];
  if (rules.direct.some((re) => re.test(key))) matched.push("direct");
  if (rules.inverted?.some((re) => re.test(key))) matched.push("inverted");
  if (rules.unanswerable?.some((re) => re.test(key))) matched.push("unanswerable");

  // EXACTLY ONE, or it is uncertain. Zero means the engine recognised a word and
  // did not read the question; two means it read two questions.
  const polarity: Polarity = matched.length === 1 ? matched[0] : "uncertain";
  return { kind: "topic", topic, polarity };
}
