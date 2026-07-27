/**
 * The vocabulary the auto-apply prepare engine speaks.
 *
 * Everything here is data. Nothing in `lib/apply/` reads a database, opens a
 * browser, calls a model or touches the clock without being handed one — the
 * engine is a pure function from (parsed form + the user's stored answers +
 * their policy rules) to a staged application, which is what makes the
 * zero-wrong-knockouts claim testable at all.
 *
 * `docs/plans/AUTO-APPLY.md` is the spec; the four layers below are its
 * "answer engine — four layers, strict precedence".
 */

/** Where an answer came from — mirrors the `provenance` column in 0014. */
export type Provenance = "user-entered" | "confirmed" | "suggested";

/**
 * Which layer answered a field. `docs/plans/AUTO-APPLY.md`:
 *
 *   1 constants  — the answer library: name, email, links, and any question a
 *                  human has already answered once
 *   2 policy     — declarative rules the human owns (relocation, start date,
 *                  worked-here-before), including the knockout answers
 *   3 inference  — evidence-gated, citation-required, and structurally
 *                  unreachable for knockout and self-identification fields
 *   4 free text  — never auto-filled; drafted and parked (out of scope here)
 */
export type AnswerLayer = "constant" | "policy" | "inference";

/**
 * A field the engine could not fill, and why. Closed set: the review surface
 * renders one affordance per reason, and a `default:` branch there would be a
 * gap nobody can act on.
 */
export type GapReason =
  /** No library entry, no policy topic, nothing to infer from. */
  | "no-answer"
  /**
   * Classified to a policy topic the user has no rule for. THE case the metric
   * is about: a knockout question with no rule stages here and never anywhere
   * else.
   */
  | "policy-unset"
  /** Matched more than one policy topic — a compound question, answerable only by a human. */
  | "policy-ambiguous"
  /**
   * The topic is certain and the DIRECTION is not — zero polarity classes
   * matched, or two did, or the question asks about a different fact than the
   * topic's situation holds ("do you require relocation ASSISTANCE?").
   *
   * The whole reason this reason exists: replaying a stored word against a
   * question of the opposite polarity is how `visa_sponsorship = "No"` became
   * "I need sponsorship" on a card marked ready.
   */
  | "polarity-unknown"
  /**
   * A rule exists, the direction is certain, and the stored situation still
   * cannot answer THIS question — the fact is the wrong kind for it, or the
   * question names a country the situation says nothing about, or a computed
   * directive resolved to nothing.
   */
  | "situation-mismatch"
  /** A derived answer that is not one of the options the form offers. */
  | "option-mismatch"
  /**
   * The label trips the recall-tuned sensitive list and nothing answered it.
   * Distinct from `no-answer` because layers 3 and 4 are forbidden here — this
   * is what closes "layer 3's knockout immunity is the classifier's recall",
   * which was circular.
   */
  | "sensitive-unclassified"
  /** EEO / demographic self-identification. The human's alone, always. */
  | "self-identification"
  /** A textarea with no stored answer: layer 4, drafted and reviewed, never auto-filled. */
  | "free-response"
  /** A file upload. The submit harness attaches it; Prepare only names it. */
  | "attachment"
  /** A consent the form requires. Consenting on somebody's behalf is not filling in a field. */
  | "consent"
  /** A field type or payload block this parser does not understand. Fail loud, never improvise. */
  | "unsupported";

/** What a form field wants, after the ATS's own type vocabulary is folded down. */
export type FieldKind =
  | "text"
  | "textarea"
  | "select"
  | "multiselect"
  | "file"
  | "hidden"
  | "unknown";

/** One option of a select, with the label as the ATS renders it. */
export interface FieldOption {
  label: string;
  value: string;
  /**
   * Greenhouse marks "I don't wish to answer" explicitly on demographic
   * questions. Carried so the review surface can offer it — and so nothing
   * else can pick it, which would be answering on somebody's behalf by another
   * route.
   */
  declineToAnswer?: boolean;
}

/** One answerable field of an application form. */
export interface FormField {
  /**
   * The ATS's own field name — `first_name`, `question_65684137`.
   *
   * Unique within a form, and `parseGreenhouseForm` REFUSES a payload where it
   * is not. This used to be a claim in this comment with nothing behind it,
   * while the submit harness addresses fields by name.
   */
  name: string;
  /** The question as a human reads it. May differ from `name` in every way. */
  label: string;
  kind: FieldKind;
  required: boolean;
  options: FieldOption[];
  /**
   * Fields belonging to one question. Greenhouse's "Resume/CV" is one question
   * with two fields (`resume` file, `resume_text` textarea) and filling either
   * satisfies it.
   */
  siblings: string[];
  /**
   * EEO / demographics. Set from the payload BLOCK, not from the label — see
   * `parseGreenhouseForm`'s note on why a self-ID question asked as an ordinary
   * custom question falls through to a gap instead.
   */
  selfIdentification: boolean;
  /** The raw ATS type string, kept verbatim so an unsupported field can name itself. */
  rawType: string;
}

/** A parsed application form, ATS-independent. */
export interface ApplicationForm {
  ats: "greenhouse";
  /** The ATS's own posting id. */
  jobId: string;
  company: string;
  title: string;
  url: string;
  fields: FormField[];
  /**
   * Payload blocks the parser recognised the NAME of and not the SHAPE of.
   * A form carrying one cannot be batch-approved: something on the real page
   * will be asked that nothing here has seen.
   */
  unsupportedBlocks: string[];
}

/**
 * Who wrote a row, from the SERVER's view — 0014's `authored_by`, stamped by a
 * trigger from `auth.uid()` and never accepted from a caller.
 *
 * Every gate that could touch a knockout or a demographic field reads THIS and
 * never `provenance`, which is the caller's claim. An adversarial review walked
 * through four "refusals" keyed on the claim by writing `provenance:
 * "confirmed"`, and each time the answer landed on a card marked ready.
 */
export type AuthoredBy = "user" | "service";

/** One row of `public.answers`, as the engine reads it. */
export interface AnswerEntry {
  question: string;
  /**
   * `hq_question_key(question)`. Should come FROM THE COLUMN — it is
   * `generated always as` and is the identity the unique index enforces.
   * Recomputed only when absent.
   */
  questionKey?: string;
  answer: string;
  kind: string;
  provenance: Provenance;
  /** Absent reads as `"service"`: the safe direction for an unknown writer. */
  authoredBy?: AuthoredBy;
}

/**
 * The user's SITUATION, typed — `answer_policies.fact` in 0014.
 *
 * A rule stores what is TRUE ABOUT THE PERSON, never the word to submit. The
 * engine derives an answer from the situation and the question's polarity, which
 * is the only way one rule can answer both "do you require sponsorship?" and
 * "can you work without sponsorship?" without being wrong about one of them.
 */
export type SituationFact =
  | { kind: "boolean"; value: boolean }
  | { kind: "enum"; value: string }
  | { kind: "text"; value: string }
  | { kind: "countries"; value: string[] }
  | { kind: "money"; value: number; currency?: string }
  | { kind: "date"; value: string }
  | { kind: "directive"; value: string };

/** One row of `public.answer_policies`. */
export interface PolicyRule {
  topic: string;
  /** `company_name_key(name)`, or `""` for the global rule. */
  companyKey: string;
  fact: SituationFact;
  provenance: Provenance;
  authoredBy?: AuthoredBy;
  enabled: boolean;
}

/** A field after the resolver has looked at it. Exactly one of `answer`/`gap` is set. */
export interface StagedField {
  name: string;
  label: string;
  required: boolean;
  kind: FieldKind;
  /** The value to submit, or `null` when this is a gap. */
  answer: string | null;
  layer: AnswerLayer | null;
  provenance: Provenance | null;
  /**
   * The provenance TOKEN the review surface shows beside the value:
   * `answer:<question key>`, `policy:<topic>`, `policy:<topic>@<company key>`,
   * or `inference`. Empty for a gap.
   */
  source: string;
  gap: GapReason | null;
  /** For `inference` only: the fact that backs the answer. Never empty when set. */
  citation?: string;
}

/** The counts the Review UI needs before it renders a single card. */
export interface CoverageSummary {
  /** Answerable fields — hidden fields are the ATS's own bookkeeping and are excluded. */
  total: number;
  /** Filled from layer 1 or 2 by something a human authored. */
  answered: number;
  /** Filled, but a human has to look: layer 3, or a `suggested` provenance. */
  needsReview: number;
  /** Not filled. */
  gaps: number;
  /** Gaps on REQUIRED fields — the ones that stop a submission rather than shrinking it. */
  blockingGaps: number;
  /** Gap counts by reason, for the review surface's grouping. Zero-valued keys omitted. */
  gapsByReason: Partial<Record<GapReason, number>>;
}

/**
 * How close this application is to being submittable.
 *
 * `ready` is the plan's green card — "an application whose every field is
 * profile- or rule-sourced (no inference, no free text) renders as one green
 * card, approvable in a keystroke". `blocked` and `needs-review` both mean a
 * human opens it; they differ in whether the human has a choice about that.
 */
export type Readiness = "ready" | "needs-review" | "blocked";

/** The engine's answer. Nothing here has been submitted; nothing here can submit. */
export interface StagedApplication {
  form: ApplicationForm;
  fields: StagedField[];
  coverage: CoverageSummary;
  readiness: Readiness;
  /**
   * `readiness === "ready"`. Named separately because it is the gesture the
   * plan authorises ("batch-approve is legal … blind-batch is not") and a
   * caller reading a boolean should not have to know which enum member means yes.
   */
  batchApprovable: boolean;
}

/**
 * Layer 3, as a hook the caller supplies.
 *
 * The engine never constructs one. It is called only for fields the strict
 * precedence has already cleared — never a knockout topic, never
 * self-identification, never a file, never free text — and its answer is
 * REJECTED unless it carries a citation. That is the truth ceiling made
 * architectural rather than aspirational (`AUTO-APPLY.md`, layer 3): "the model
 * may answer only by citing a resume/master-resume fact that backs it".
 */
export type BackedInference = (
  field: FormField,
) => { answer: string; citation: string } | null;
