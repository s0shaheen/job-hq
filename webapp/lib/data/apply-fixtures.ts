/**
 * The demo answer library: what one person has told this app about themselves.
 *
 * Stored the way the DATABASE stores it, not the way a screen reads it —
 * `question` without its generated key, and `fact` as raw jsonb. That is matrix
 * row 212's rule ("a fake can model the RESULT and never the MAPPING"): the fake
 * runs the seeds through the same `questionKey` and `parseSituationFact` the
 * Supabase source runs its rows through, so both mappings are exercised by every
 * test that drives the fake.
 *
 * The set is chosen so that each state the two surfaces can render is reachable
 * through the only source the tests can drive (matrix row 15). In particular:
 *
 *   - a HUMAN-authored answer to a sensitive question, which is the only kind
 *     `prepare.ts` will reuse on a knockout field;
 *   - a `suggested` answer, so the "somebody should look at this" rendering is
 *     not theoretical;
 *   - a `service`-authored answer to a sensitive question, which the engine
 *     REFUSES — the row is visibly present and visibly not used, which is the
 *     one combination a screenshot can get wrong;
 *   - a DISABLED company override, which falls back to the global rule;
 *   - a rule whose `fact` this build cannot read, which is only reachable from a
 *     writer that is not this UI (a script, a future service lane) and is
 *     therefore unreachable through the demo unless it is seeded here.
 *
 * Two knockout topics are deliberately ABSENT — `background_check_consent` and
 * `age_eligibility` — because "you have no rule for this" is the state the whole
 * feature is judged on and a demo where every question is answered would never
 * show it.
 */
import { FIXTURE_NOW } from "./fixtures";

/** One `public.answers` row, pre-generated-column. */
export type AnswerSeed = {
  question: string;
  answer: string;
  kind: string;
  provenance: string;
  /** The server's stamp. A seed may set `service`; a UI write never can. */
  authoredBy: string;
  /** 0017's scope. Absent is the answer every board gets. */
  companyKey?: string;
  /** 0017: the person picked the board's own "I don't wish to answer". */
  declined?: boolean;
  confirmedAt?: string | null;
  updatedAt?: string;
};

/** One `public.answer_policies` row, with `fact` as the raw jsonb. */
export type PolicySeed = {
  topic: string;
  /** Already a KEY — `company_name_key` of the name, or "" for the global rule. */
  companyKey: string;
  fact: unknown;
  provenance: string;
  authoredBy: string;
  note?: string;
  enabled?: boolean;
  updatedAt?: string;
};

export type ApplyLibrarySeed = {
  answers: AnswerSeed[];
  rules: PolicySeed[];
};

const T0 = new Date(FIXTURE_NOW).getTime();
/** Stable, spaced stamps — never `Date.now()`, or every visual baseline moves. */
const stamp = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString();

export const FIXTURE_ANSWERS: AnswerSeed[] = [
  {
    question: "First Name",
    answer: "Salman",
    kind: "identity",
    provenance: "user-entered",
    authoredBy: "user",
    updatedAt: stamp(600),
  },
  {
    question: "Last Name",
    answer: "Shaheen",
    kind: "identity",
    provenance: "user-entered",
    authoredBy: "user",
    updatedAt: stamp(600),
  },
  {
    question: "Email",
    answer: "salman@example.com",
    kind: "identity",
    provenance: "user-entered",
    authoredBy: "user",
    updatedAt: stamp(600),
  },
  {
    question: "Phone",
    answer: "312-555-0142",
    kind: "identity",
    provenance: "user-entered",
    authoredBy: "user",
    updatedAt: stamp(599),
  },
  {
    question: "Location (City)",
    answer: "Chicago, IL",
    kind: "location",
    provenance: "user-entered",
    authoredBy: "user",
    updatedAt: stamp(599),
  },
  {
    question: "LinkedIn Profile",
    answer: "https://www.linkedin.com/in/example",
    kind: "identity",
    provenance: "user-entered",
    authoredBy: "user",
    updatedAt: stamp(598),
  },
  {
    // A knockout question answered BY HAND, on that exact wording. This is the
    // only route by which a library row may answer a sensitive field, and it is
    // polarity-safe by construction because the human answered this sentence.
    question: "Are you legally authorized to work in the United States?",
    answer: "Yes",
    kind: "auth",
    provenance: "user-entered",
    authoredBy: "user",
    updatedAt: stamp(400),
  },
  {
    // Accepted unchanged from a suggestion — `confirmed` is a moment, not a flag.
    question: "How did you hear about this job?",
    answer: "Company website",
    kind: "freeform",
    provenance: "confirmed",
    authoredBy: "user",
    confirmedAt: stamp(300),
    updatedAt: stamp(300),
  },
  {
    // A machine's proposal nobody has confirmed. It fills the field AND drops the
    // whole application out of `ready`, which is the behaviour worth seeing.
    question: "Preferred First Name",
    answer: "Salman",
    kind: "identity",
    provenance: "suggested",
    authoredBy: "service",
    updatedAt: stamp(120),
  },
  {
    // Sensitive AND service-authored: present in the library, refused by the
    // engine. There is no way to write this row from the UI — the trigger stamps
    // `user` on anything a session writes — so without a seed the refusal has
    // nothing to refuse.
    question: "Will you now or in the future require visa sponsorship?",
    answer: "No",
    kind: "auth",
    provenance: "suggested",
    authoredBy: "service",
    updatedAt: stamp(90),
  },
  {
    // THE row an adversarial review used to break this feature: a global library
    // answer to a question whose truth differs per company. The person has a
    // `prior_employment` exception at Stripe saying "yes, I worked there", and
    // this answer says No everywhere — so on the Stripe board the two disagree,
    // and before 0017 the library won because layer 1 runs before layer 2.
    //
    // It is seeded rather than deleted BECAUSE it is the bug: the demo has to be
    // able to show the exception winning, and it cannot show that without
    // something for it to win against (matrix row 15, on a fix rather than on a
    // feature).
    question: "Have you previously been employed by Stripe?",
    answer: "No",
    kind: "freeform",
    provenance: "user-entered",
    authoredBy: "user",
    updatedAt: stamp(80),
  },
  {
    // A company-scoped answer (0017). The same question is answered one way
    // everywhere and another way at one company, which is the whole point of the
    // column — and it is the state the settings page renders differently.
    question: "How did you hear about this job?",
    answer: "A friend on the payments team",
    kind: "freeform",
    provenance: "user-entered",
    authoredBy: "user",
    companyKey: "stripe",
    updatedAt: stamp(70),
  },
  {
    // A recorded DECLINE. Before 0017 this was stored as the option's label and
    // no layer could ever select it again, so the question gapped as
    // `option-mismatch` forever — the review's M2. Seeded so the replay is
    // exercised by every fixture-driven test rather than only by the one that
    // clicks it.
    question: "Veteran status",
    answer: "I don't wish to answer",
    kind: "eeo",
    provenance: "user-entered",
    authoredBy: "user",
    declined: true,
    updatedAt: stamp(65),
  },
];

export const FIXTURE_POLICY_RULES: PolicySeed[] = [
  {
    topic: "work_authorization",
    companyKey: "",
    fact: { kind: "countries", value: ["united states"] },
    provenance: "user-entered",
    authoredBy: "user",
    note: "",
    updatedAt: stamp(500),
  },
  {
    topic: "visa_sponsorship",
    companyKey: "",
    fact: { kind: "boolean", value: false },
    provenance: "user-entered",
    authoredBy: "user",
    note: "",
    updatedAt: stamp(500),
  },
  {
    topic: "compensation",
    companyKey: "",
    fact: { kind: "money", value: 180000, currency: "USD" },
    provenance: "user-entered",
    authoredBy: "user",
    note: "Top of the band, not a floor I would refuse.",
    updatedAt: stamp(499),
  },
  {
    topic: "criminal_history",
    companyKey: "",
    fact: { kind: "enum", value: "none" },
    provenance: "user-entered",
    authoredBy: "user",
    note: "",
    updatedAt: stamp(498),
  },
  {
    topic: "relocation",
    companyKey: "",
    fact: { kind: "boolean", value: true },
    provenance: "user-entered",
    authoredBy: "user",
    note: "",
    updatedAt: stamp(450),
  },
  {
    topic: "start_date",
    companyKey: "",
    fact: { kind: "directive", value: "monday-weeks-out:3" },
    provenance: "user-entered",
    authoredBy: "user",
    note: "",
    updatedAt: stamp(450),
  },
  {
    topic: "prior_employment",
    companyKey: "",
    fact: { kind: "boolean", value: false },
    provenance: "user-entered",
    authoredBy: "user",
    note: "",
    updatedAt: stamp(440),
  },
  {
    topic: "onsite_commitment",
    companyKey: "",
    fact: { kind: "boolean", value: true },
    provenance: "user-entered",
    authoredBy: "user",
    note: "",
    updatedAt: stamp(430),
  },
  {
    // A per-company exception that WINS over the global rule above it.
    topic: "prior_employment",
    companyKey: "stripe",
    fact: { kind: "boolean", value: true },
    provenance: "user-entered",
    authoredBy: "user",
    note: "Contract work in 2019.",
    updatedAt: stamp(200),
  },
  {
    // Turned OFF rather than deleted, so the global relocation rule applies at
    // Ramp. `prepare.ts` treats a disabled override as ABSENT — the first version
    // returned it and then gapped, which made the global rule unreachable there.
    topic: "relocation",
    companyKey: "ramp",
    fact: { kind: "boolean", value: false },
    provenance: "user-entered",
    authoredBy: "user",
    note: "Was true while they had a Chicago office.",
    enabled: false,
    updatedAt: stamp(180),
  },
  {
    // A shape this build cannot read. Legal jsonb, refused by
    // `parseSituationFact`, dropped from the engine's input, and rendered as
    // unreadable rather than as an answer nobody can check.
    topic: "how_did_you_hear",
    companyKey: "",
    fact: { kind: "phrase-bank", value: ["a recruiter", "the website"] },
    provenance: "suggested",
    authoredBy: "service",
    note: "",
    updatedAt: stamp(60),
  },
];

export const FIXTURE_APPLY_LIBRARY: ApplyLibrarySeed = {
  answers: FIXTURE_ANSWERS,
  rules: FIXTURE_POLICY_RULES,
};

/** Nothing stored at all — somebody on their first day. */
export const EMPTY_APPLY_LIBRARY: ApplyLibrarySeed = { answers: [], rules: [] };
