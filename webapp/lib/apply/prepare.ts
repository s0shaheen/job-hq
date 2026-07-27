/**
 * The answer engine: a parsed form + the user's stored answers + their policy
 * situation → a staged application. Four layers, strict precedence, no guesses.
 *
 * `docs/plans/AUTO-APPLY.md`, "The answer engine — four layers":
 *
 *   1 CONSTANTS   the answer library. Identity fields by the ATS's own stable
 *                 field name; everything else by normalized question key.
 *   2 POLICY      the user's SITUATION as typed facts, derived against the
 *                 question's detected polarity.
 *   3 INFERENCE   evidence-gated, citation-required, and structurally
 *                 unreachable for anything the sensitive list names.
 *   4 FREE TEXT   never auto-filled. Staged as a gap the review surface drafts
 *                 into; drafting itself is a later unit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHEN IN DOUBT, GAP. The absolute, and the thing every branch below serves.
 *
 * "wrong knockout answers (must be zero, ever)". An adversarial review broke the
 * first version of this file five ways, and the fixes are structural rather than
 * patched:
 *
 *   1. **A rule stores a situation, not an answer.** `visa_sponsorship = "No"`
 *      replayed against "can you work WITHOUT sponsorship?" submitted "No",
 *      meaning "I need sponsorship" — the opposite of the truth, on a card
 *      marked ready. `deriveAnswer` now takes the fact and the polarity, and
 *      `polarity: "uncertain" | "unanswerable"` gaps without consulting anything.
 *
 *   2. **The layer-1 gate reads `authoredBy`, not `provenance`.** The review
 *      wrote an EEO answer as `kind: "freeform"` and a knockout answer as
 *      `provenance: "confirmed"`, and both staged. `authoredBy` is stamped by
 *      Postgres from `auth.uid()` and cannot be sent by a caller, so a sensitive
 *      field now requires `authoredBy === "user"` AND an exact question-key
 *      match — per-question human memory, which is polarity-safe by
 *      construction because the human answered THAT question.
 *
 *   3. **Layer 3 cannot see a sensitive label**, whether or not the classifier
 *      read it. The old comment argued a knockout "can never reach layer 3
 *      because it is a topic match", which is circular: against 50 real
 *      phrasings the classifier missed 12 knockout questions and an inference
 *      hook answered one of them on a required sponsorship select. The
 *      recall-tuned `isSensitiveLabel` is the second, independent guard.
 *
 *   4. **Kind gates run BEFORE layer 1.** A library row keyed `resume cv` — the
 *      label on every Greenhouse board — filled the FILE field with pasted text
 *      and the form read `ready`. The attachment and consent gates sat after
 *      layer 1, so they were unreachable whenever layer 1 hit, and deleting
 *      either left all 1,142 tests green.
 *
 *   5. **A form with nothing to answer is blocked, not ready.** `{"id":123,
 *      "questions":[]}` — a closed posting — produced `total: 0`, zero gaps and
 *      `batchApprovable: true`.
 *
 * PURE. No fetch, no database, no model, no clock. `today` is injected because
 * the start-date directive computes from it. That purity is what makes the
 * claims above assertable rather than reviewable.
 *
 * WHAT THE CALLER GETS AND WHAT IT MUST NOT DO. `StagedApplication` is a
 * proposal. Nothing here submits, and `batchApprovable` is the engine's opinion
 * about whether a human could approve this in one keystroke — never permission
 * to skip the human.
 */
import { blankTrim } from "@/lib/data/view-models";
import { CANONICAL_FIELDS } from "./greenhouse";
import { questionKey } from "./normalize";
import {
  classifyTopic,
  isConsentLabel,
  isKnockoutTopic,
  isSensitiveLabel,
  resolveQuestionCountry,
  type Polarity,
  type PolicyTopic,
} from "./policy";
import type {
  AnswerEntry,
  ApplicationForm,
  BackedInference,
  CoverageSummary,
  FormField,
  GapReason,
  PolicyRule,
  Readiness,
  SituationFact,
  StagedApplication,
  StagedField,
} from "./types";

export interface PrepareInput {
  form: ApplicationForm;
  /** Rows of `public.answers` for this user. */
  answers: AnswerEntry[];
  /** Rows of `public.answer_policies` for this user. */
  rules: PolicyRule[];
  /**
   * `company_name_key(form.company)`, supplied by the caller because company
   * identity lives in `lib/data/view-models.ts` and this module takes its keys
   * pre-computed rather than re-deriving one somebody else owns. `""` disables
   * company-scoped rules.
   */
  companyKey?: string;
  /**
   * The posting's country, for questions that defer to it ("authorized to work
   * in the country where this position is located" — what Coinbase asks).
   * Absent means those questions GAP. There is no "assume the US" branch.
   */
  postingCountry?: string;
  /** Layer 3. Omit it and layer 3 does not exist for this run. */
  infer?: BackedInference;
  /** Injected so a computed start date is testable against a pinned day. */
  today?: Date;
}

/**
 * A field the coverage summary counts.
 *
 * Hidden fields are the ATS's own bookkeeping — Greenhouse's
 * `location_questions` carries a latitude and a longitude its place-autocomplete
 * fills in. Counting them as unanswered questions would report every application
 * two questions short of ready, forever, for a reason no human could act on.
 */
function isAnswerable(field: FormField): boolean {
  return field.kind !== "hidden";
}

/** Layer 1, part a: the ATS's own canonical field names. */
function canonicalKeyFor(field: FormField): string | null {
  const canonical = CANONICAL_FIELDS[field.name];
  return canonical ? questionKey(canonical) : null;
}

/**
 * Resolve one computed policy directive.
 *
 * A CLOSED SET, and small on purpose. The plan names exactly one computed rule —
 * "start date → the Monday 2–3 weeks out" — and a directive language with more
 * in it than the product asks for is a language nobody has written a test for.
 * An unrecognised directive returns null, which gaps the field: a rule that
 * resolves to nothing must not resolve to something.
 */
function resolveDirective(directive: string, today: Date): string | null {
  const m = /^monday-weeks-out:(\d+)$/.exec(directive);
  if (!m) return null;
  const weeks = Number(m[1]);
  if (!Number.isFinite(weeks) || weeks < 0 || weeks > 52) return null;

  // Local-day arithmetic via setDate, never `n * 86_400_000` — a day is 23 or 25
  // hours long across a daylight-saving boundary, and `lib/dates.ts` carries the
  // same rule for the same reason (matrix row 35).
  const d = new Date(today.getTime());
  d.setDate(d.getDate() + weeks * 7);
  // Forward to the next Monday. `(8 - day) % 7` is 0 when d is already Monday,
  // which is correct: a start date that is already a Monday does not slip a week.
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The exception this person set for THIS company, if any.
 *
 * Split out of the old `ruleFor` — which returned `company ?? global` — because
 * the two scopes are consulted at different points in the precedence now, and a
 * function that quietly picks one of them hides the thing that matters. See
 * `stageField`'s "MOST SPECIFIC SCOPE WINS".
 *
 * A DISABLED rule is treated as ABSENT rather than as an override that answers
 * nothing — so turning off a company override falls back to everything below it,
 * which is what "turning a rule off is the gesture a person wants" has to mean.
 * The first version returned the disabled override and then gapped, which
 * silently made the global rule unreachable for that company.
 */
function companyRuleFor(rules: PolicyRule[], topic: string, companyKey: string): PolicyRule | null {
  if (companyKey === "") return null;
  for (const r of rules) {
    if (r.topic === topic && r.enabled && r.companyKey === companyKey) return r;
  }
  return null;
}

/** The rule that governs a topic everywhere. Same disabled-is-absent rule. */
function globalRuleFor(rules: PolicyRule[], topic: string): PolicyRule | null {
  for (const r of rules) {
    if (r.topic === topic && r.enabled && r.companyKey === "") return r;
  }
  return null;
}

/**
 * Does a derived value name one of the options this field offers?
 *
 * Compared through `questionKey`, because a derived "Yes" and an option labelled
 * "Yes" are the same answer and exact string match would gap every board whose
 * casing differs. The value SUBMITTED is the option's own `value` — Greenhouse's
 * Yes/No selects are `{label: "Yes", value: 1}`, so a harness posting the label
 * posts something the ATS does not recognise.
 *
 * The first version also accepted a proposed value that equalled an option's
 * VALUE. That is removed: with situations rather than literals, nothing the
 * engine derives is ever an ATS option id, and the branch's only live effect was
 * that a stored literal `"0"` silently selected the option with id 0 ("No").
 *
 * A field with no options accepts anything.
 */
function matchOption(field: FormField, proposed: string): string | null {
  if (field.options.length === 0) return proposed;
  const want = questionKey(proposed);
  for (const o of field.options) {
    // Never on somebody's behalf, from any layer. The decline option exists so
    // the review surface can OFFER it; choosing it is still a choice.
    //
    // Still literally true after 0017: a recorded decline reaches the board's
    // option through `stageFromLibrary`'s own branch, keyed on a flag only a
    // person's own choice can set, and never through here. A value that merely
    // SPELLS the decline label still falls through to `option-mismatch`.
    if (o.declineToAnswer) continue;
    if (questionKey(o.label) === want) return o.value;
  }
  return null;
}

function gap(field: FormField, reason: GapReason): StagedField {
  return {
    name: field.name,
    label: field.label,
    required: field.required,
    kind: field.kind,
    answer: null,
    layer: null,
    provenance: null,
    source: "",
    gap: reason,
  };
}

/** "Yes"/"No" for a boolean situation, flipped when the question is inverted. */
function yesNo(value: boolean, polarity: Polarity): string {
  return (polarity === "inverted" ? !value : value) ? "Yes" : "No";
}

/**
 * Derive the answer to ONE question from the user's situation.
 *
 * Returns a value or a gap reason — never a guess. Every branch that cannot
 * establish the answer with certainty returns `situation-mismatch`, which is the
 * "when in doubt, gap" rule expressed as a return type.
 */
function deriveAnswer(
  field: FormField,
  fact: SituationFact,
  polarity: Polarity,
  postingCountry: string | undefined,
  today: Date,
): { value: string } | { gap: GapReason } {
  const isSelect = field.options.length > 0;

  switch (fact.kind) {
    case "boolean":
      // A yes/no answer typed into a free-text box is a guess about format.
      if (!isSelect) return { gap: "situation-mismatch" };
      return { value: yesNo(fact.value, polarity) };

    case "enum": {
      // `criminal_history`'s `none`/`has`. An enum the engine does not know how
      // to turn into an answer is a mismatch, not a string to submit.
      if (!isSelect) return { gap: "situation-mismatch" };
      if (fact.value !== "none" && fact.value !== "has") return { gap: "situation-mismatch" };
      return { value: yesNo(fact.value === "has", polarity) };
    }

    case "countries": {
      // "Are you authorized to work in X?" cannot be answered by a list until X
      // is known. No default, no "assume the US" — that assumption is a wrong
      // knockout answer for most of the planet.
      if (!isSelect) return { gap: "situation-mismatch" };
      const country = resolveQuestionCountry(field.label, postingCountry);
      if (country === null) return { gap: "situation-mismatch" };
      const has = fact.value.some((c) => c.trim().toLowerCase() === country);
      return { value: yesNo(has, polarity) };
    }

    case "money":
      // Inverting a number is meaningless; there is no branch for it.
      if (polarity !== "direct") return { gap: "situation-mismatch" };
      // Plain digits, because `parseSituationFact` refuses anything that is not a
      // whole number under a billion. Without that bound `String(1e21)` is
      // "1e+21" — submitted, on a knockout field.
      return { value: String(fact.value) };

    case "text":
      if (polarity !== "direct") return { gap: "situation-mismatch" };
      // TRIMMED at the point it becomes a submitted value. SQL only checks that
      // `hq_blank_trim(value)` is non-empty, so `"  Chicago, IL  "` is a legal
      // row, and it went onto the board's box with its padding.
      return { value: blankTrim(fact.value) };

    case "date":
      if (polarity !== "direct") return { gap: "situation-mismatch" };
      return { value: fact.value };

    case "directive": {
      if (polarity !== "direct") return { gap: "situation-mismatch" };
      const resolved = resolveDirective(fact.value, today);
      return resolved === null ? { gap: "situation-mismatch" } : { value: resolved };
    }

    default:
      // An unknown fact kind reaching here means the store grew one the engine
      // does not implement. Gap, loudly, rather than stringifying an object.
      return { gap: "situation-mismatch" };
  }
}

interface StageContext {
  rules: PolicyRule[];
  companyKey: string;
  postingCountry?: string;
  today: Date;
  infer?: BackedInference;
  /** Library rows that apply everywhere, by question key. */
  byKey: Map<string, AnswerEntry>;
  /** Library rows scoped to THIS company (0017), by question key. Empty when there is no company. */
  byCompanyKey: Map<string, AnswerEntry>;
}

/** A library row and whether it matched THIS question rather than a canonical alias. */
interface LibraryHit {
  entry: AnswerEntry;
  exact: boolean;
}

/**
 * The library row for this field, at one scope.
 *
 * The canonical field name wins over the label, and `exact` records which one
 * matched — because a sensitive field may only take a row matched on ITS OWN
 * question key. That is what makes layer 1 polarity-safe: the human answered
 * that exact sentence, so no direction has to be inferred.
 */
function lookupEntry(
  byKey: Map<string, AnswerEntry>,
  canonical: string | null,
  labelKey: string,
): LibraryHit | null {
  const byCanonical = canonical ? byKey.get(canonical) : undefined;
  const byLabel = labelKey === "" ? undefined : byKey.get(labelKey);
  const entry = byCanonical ?? byLabel;
  if (!entry) return null;
  return { entry, exact: entry === byLabel };
}

/**
 * Layer 1 against one scope: an answer, an `option-mismatch` gap, or nothing.
 *
 * `null` means "this scope has nothing usable here" and the caller falls through
 * to the next one. A gap RETURN, by contrast, stops the search: a stored answer
 * that is not on this board's menu is a thing to tell a person about, not a
 * reason to go looking for a different answer to submit.
 */
function stageFromLibrary(
  field: FormField,
  hit: LibraryHit | null,
  sensitive: boolean,
  base: Pick<StagedField, "name" | "label" | "required" | "kind">,
): StagedField | null {
  if (!hit) return null;
  const { entry, exact } = hit;
  /**
   * A sensitive field takes an answer only when BOTH hold:
   *
   *   the server saw a signed-in person write it (`authoredBy === "user"`,
   *   stamped by a trigger, not claimed by the caller), and
   *
   *   the match was on THIS question's key — never the canonical-field alias.
   *
   * An entry that fails either falls through as if it did not exist.
   */
  const usable = !sensitive || (entry.authoredBy === "user" && exact);
  if (!usable) return null;

  /**
   * A refusal the person recorded, replayed onto THIS board's own decline option.
   *
   * The engine still never DERIVES a decline — `matchOption` skips the option
   * from every layer, including this one — and nothing but a person picking it
   * can set the flag (0017 refuses `declined` on any row the trigger did not
   * stamp `user`). What changes is that picking it is no longer a one-way door:
   * the first version stored the option's LABEL as an ordinary answer, which no
   * layer may select, so the question gapped as `option-mismatch` forever after
   * and the copy for that gap — "pick one of theirs" — was false about the one
   * case it was printed for.
   *
   * Matched on the FLAG rather than on the words, so a board wording its decline
   * option differently still gets its own. A board offering none gaps, and there
   * `option-mismatch` is the honest sentence rather than a false one.
   */
  if (entry.declined === true) {
    const decline = field.options.find((o) => o.declineToAnswer);
    if (!decline) return gap(field, "option-mismatch");
    return {
      ...base,
      answer: decline.value,
      layer: "constant",
      provenance: entry.provenance,
      source: answerSource(entry),
      gap: null,
      declined: true,
    };
  }

  const value = blankTrim(entry.answer);
  const option = value === "" ? null : matchOption(field, value);
  if (option !== null) {
    return {
      ...base,
      answer: option,
      layer: "constant",
      provenance: entry.provenance,
      source: answerSource(entry),
      gap: null,
    };
  }
  // A stored answer that is not on the menu — including one that names the
  // decline option, which `matchOption` refuses from every layer.
  if (value !== "" && field.options.length > 0) return gap(field, "option-mismatch");
  return null;
}

/** Layer 2 against one rule, once its polarity is known to be usable. */
function stageFromRule(
  field: FormField,
  topic: PolicyTopic,
  rule: PolicyRule,
  polarity: Polarity,
  ctx: StageContext,
  base: Pick<StagedField, "name" | "label" | "required" | "kind">,
): StagedField {
  const derived = deriveAnswer(field, rule.fact, polarity, ctx.postingCountry, ctx.today);
  if ("gap" in derived) return gap(field, derived.gap);
  const option = matchOption(field, derived.value);
  if (option === null) return gap(field, "option-mismatch");
  return {
    ...base,
    answer: option,
    layer: "policy",
    provenance: rule.provenance,
    source: sourceOf(topic, rule.companyKey, polarity),
    gap: null,
  };
}

/**
 * Resolve one field. Four layers, two scopes, stopping at the first hit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * MOST SPECIFIC SCOPE WINS, AND ONLY THEN THE LAYER ORDER
 *
 *   1  this company's saved answer      (library, `company_key = <this company>`)
 *   2  this company's exception         (`answer_policies`, same company)
 *   3  the saved answer for every board (library, `company_key = ''`)
 *   4  the rule for every board         (`answer_policies`, global)
 *
 * The middle two used to be the other way round, and an adversarial review
 * walked through the gap: `answers` had no company column, the review screen
 * wrote every typed gap answer globally, and layer 1 ran before layer 2 — so a
 * one-off answer typed at one board silently and permanently overrode a rule the
 * person had deliberately scoped to another. The justification for layer-1 reuse
 * on sensitive fields is that an exact question-key match is "polarity-safe by
 * construction". True, and not the whole claim: polarity-safe is not
 * COMPANY-safe, which is the entire reason `answer_policies` has a `company_key`
 * — and now `answers` does too (0017).
 *
 * A company exception that then CANNOT answer (its polarity is unreadable, its
 * fact is the wrong kind) gaps rather than falling through to the global answer.
 * That is deliberate: the person said this company is different, so the general
 * answer is the one thing that is known to be wrong here.
 */
function stageField(field: FormField, ctx: StageContext): StagedField {
  const base = {
    name: field.name,
    label: field.label,
    required: field.required,
    kind: field.kind,
  };

  // ── KIND GATES, BEFORE LAYER 1 ─────────────────────────────────────────────
  //
  // These used to sit after the library lookup, which made them unreachable
  // whenever it hit — and "Resume/CV" is the label on every Greenhouse board, so
  // one library row put pasted text into a FILE field and the form read ready.
  // A gate below the thing it guards is not a gate.
  if (field.kind === "unknown") return gap(field, "unsupported");
  if (field.kind === "file") return gap(field, "attachment");
  if (field.rawType === "data_compliance") return gap(field, "consent");

  const topicMatch = classifyTopic(field.label);
  const knockout = topicMatch.kind === "topic" && isKnockoutTopic(topicMatch.topic);

  /**
   * Is this a field where only the person's own recorded words may be reused?
   *
   * The union of three signals, deliberately broader than any one of them:
   * the payload said it is a demographic question, the classifier read a
   * knockout topic, or the recall-tuned list saw a knockout WORD. A label needs
   * to clear all three to be treated as ordinary.
   */
  const sensitive = field.selfIdentification || knockout || isSensitiveLabel(field.label);

  const canonical = canonicalKeyFor(field);
  const labelKey = questionKey(field.label);

  // ── 1. the library, at THIS company ────────────────────────────────────────
  const scoped = stageFromLibrary(
    field,
    lookupEntry(ctx.byCompanyKey, canonical, labelKey),
    sensitive,
    base,
  );
  if (scoped) return scoped;

  /**
   * May a POLICY RULE answer this field, at any scope?
   *
   * Self-identification is the human's alone. The LIBRARY may still answer it —
   * their own words, on this exact question, human-authored — which is why the
   * stop below sits under the two library rungs rather than above everything.
   * No rule may, and that has to be true at BOTH scopes.
   *
   * Read here rather than only at the stop, because rung 2 runs above it: an
   * adversarial review found a demographic-block question that classifies to a
   * topic ("Are you legally authorized to work in the United States?" inside an
   * EEO block) answered from a company exception while the same rule scoped
   * globally was correctly refused. Same field, same fact, two answers depending
   * on scope, which is an asymmetry rather than a judgement call.
   */
  const policyMayAnswer = !field.selfIdentification;

  // ── 2. the exception this person set for THIS company ──────────────────────
  //
  // Ahead of the global library, and this is the whole of it: a rule scoped to
  // one employer is more specific than an answer that applies to every one of
  // them, and losing to one is how a deliberate exception got silently overruled
  // on a card marked ready.
  if (policyMayAnswer && topicMatch.kind === "topic") {
    const { topic, polarity } = topicMatch;
    const exception = companyRuleFor(ctx.rules, topic, ctx.companyKey);
    if (exception !== null) {
      // The direction was not established. Never fall through to another layer —
      // a knockout question the engine half-read is a human's to answer, and
      // here the general answer is the one that is known to be wrong.
      if (polarity === "uncertain" || polarity === "unanswerable") {
        return gap(field, "polarity-unknown");
      }
      return stageFromRule(field, topic, exception, polarity, ctx, base);
    }
  }

  // ── 3. the library, everywhere ─────────────────────────────────────────────
  const everywhere = stageFromLibrary(
    field,
    lookupEntry(ctx.byKey, canonical, labelKey),
    sensitive,
    base,
  );
  if (everywhere) return everywhere;

  // Self-identification, unanswered by the library at either scope, stops here.
  // The POLICY layers do not exist for it — rung 2 is gated on the same flag
  // above, because it runs before this line and the old comment claimed a reach
  // this stop no longer had.
  if (field.selfIdentification) return gap(field, "self-identification");

  // ── 4. the situation, everywhere ───────────────────────────────────────────
  if (topicMatch.kind === "ambiguous") return gap(field, "policy-ambiguous");

  if (topicMatch.kind === "topic") {
    const { topic, polarity } = topicMatch;
    if (polarity === "uncertain" || polarity === "unanswerable") {
      return gap(field, "polarity-unknown");
    }
    const rule = globalRuleFor(ctx.rules, topic);
    if (rule === null) {
      // THE case the metric is about. No rule → a gap, on every topic and
      // unconditionally on a knockout one.
      return gap(field, "policy-unset");
    }
    return stageFromRule(field, topic, rule, polarity, ctx, base);
  }

  // A consent or acknowledgement. Named so the review surface offers the right
  // affordance — agreeing on somebody's behalf is not filling in a field.
  if (isConsentLabel(field.label)) return gap(field, "consent");

  // ── The second guard on layers 3 and 4 ─────────────────────────────────────
  //
  // Independent of the classifier, and tuned the other way. A label the
  // classifier did not read but that names a knockout subject stops here; the
  // review found an inference hook answering "Do you now or will you in the
  // future require an employment-based visa…" on a required select because the
  // only thing standing in front of it was `PATTERNS`' recall.
  if (sensitive) return gap(field, "sensitive-unclassified");

  // ── Layer 4 (checked before 3): free response ──────────────────────────────
  //
  // Ordered ahead of inference on purpose. A textarea is prose about this
  // person's motivation, and the layer-3 contract is "answer only by citing a
  // fact that backs it" — which a cover letter is not.
  if (field.kind === "textarea") return gap(field, "free-response");

  // ── Layer 3: backed inference ──────────────────────────────────────────────
  if (ctx.infer) {
    const guess = ctx.infer(field);
    // A citation is not optional. `AUTO-APPLY.md`, layer 3: "The model may
    // answer only by citing a resume/master-resume fact that backs it… No
    // citation → not filled, flagged." Enforced here rather than trusted to the
    // hook, because the hook is the part most likely to be replaced.
    const citation = blankTrim(guess?.citation);
    const answer = blankTrim(guess?.answer);
    if (guess && citation !== "" && answer !== "") {
      const option = matchOption(field, answer);
      if (option !== null) {
        return {
          ...base,
          answer: option,
          layer: "inference",
          // Always `suggested`, whatever the hook says. An inferred answer that
          // could claim to be user-entered would be indistinguishable from one
          // on the review screen, which is what provenance exists for.
          provenance: "suggested",
          source: "inference",
          gap: null,
          citation,
        };
      }
    }
  }

  return gap(field, "no-answer");
}

/**
 * The provenance token the review surface shows beside a policy-derived value.
 *
 * Carries the POLARITY as well as the topic, because "we read this as the
 * inverted form of your sponsorship rule" is the sentence a person needs in
 * order to catch the engine misreading a question. The topic alone was what the
 * old design showed, and it is exactly what made the polarity bug invisible.
 */
function sourceOf(topic: PolicyTopic, companyKey: string, polarity: Polarity): string {
  const scope = companyKey === "" ? topic : `${topic}@${companyKey}`;
  return `policy:${scope}/${polarity}`;
}

/**
 * The provenance token for a library answer, carrying its SCOPE.
 *
 * `answer:<question key>` for the answer every board gets, `answer:<key>@<company
 * key>` for one that applies at a single employer. The review surface renders
 * the scope beside the value for the same reason it renders the polarity: an
 * answer that is right at one company and wrong at every other one is a thing a
 * person has to be able to see. A question key is `[a-z0-9 ]+` by construction,
 * so the first `@` is always the separator.
 */
function answerSource(entry: AnswerEntry): string {
  const key = entry.questionKey ?? questionKey(entry.question);
  const scope = entry.companyKey ?? "";
  return scope === "" ? `answer:${key}` : `answer:${key}@${scope}`;
}

function summarize(fields: StagedField[]): CoverageSummary {
  const gapsByReason: Partial<Record<GapReason, number>> = {};
  let answered = 0;
  let needsReview = 0;
  let gaps = 0;
  let blockingGaps = 0;

  for (const f of fields) {
    if (f.gap) {
      gaps += 1;
      if (f.required) blockingGaps += 1;
      gapsByReason[f.gap] = (gapsByReason[f.gap] ?? 0) + 1;
      continue;
    }
    /**
     * A `suggested` provenance counts as needs-review even at layer 1 or 2: it
     * means a machine proposed the value and nobody has confirmed it.
     *
     * THIS is where inference stops an application being `ready`, and the reason
     * is the one quality datapoint in `docs/plans/AUTO-APPLY.md` that matters,
     * from JobCopilot's own user base: *"full auto-apply feels productive but
     * produces negligible results; review mode is the only mode that generates
     * real interviews."* A card that is 95% deterministic and 5% guessed is not
     * 95% trustworthy — it is one guess away from the failure the whole design
     * exists to avoid, and batching it is how a person stops reading the 5%.
     *
     * The `layer === "inference"` half is REDUNDANT TODAY: `stageField` stamps
     * every inferred answer `suggested` unconditionally, and a test pins that.
     * It is kept as the backstop for the day the stamp moves, and it is labelled
     * redundant rather than described as if it were doing the work.
     */
    if (f.layer === "inference" || f.provenance === "suggested") needsReview += 1;
    else answered += 1;
  }

  return { total: fields.length, answered, needsReview, gaps, blockingGaps, gapsByReason };
}

/**
 * How close this application is to being submittable.
 *
 * `ready` is the plan's green card — "an application whose every field is
 * profile- or rule-sourced (no inference, no free text) renders as one green
 * card, approvable in a keystroke" — and it is deliberately NARROW:
 *
 *   every field answered, from layer 1 or layer 2 only, none of it `suggested`,
 *   no gaps of any kind, no unsupported payload block, and at least one field to
 *   answer.
 *
 * Inference ANYWHERE on the form drops the whole application to individual
 * review, not just the inferred field. That happens through `needsReview` —
 * `summarize` carries the reasoning, at the line that enforces it.
 *
 * `total === 0` is `blocked`, not `ready`. `{"id":123,"questions":[]}` — a
 * closed posting, a wrong fetch moment, a board hiccup — reaches the parser's
 * throw only when the `questions` KEY is missing, so an empty array arrives here
 * and used to produce a green card with nothing on it.
 *
 * An `attachment` gap on a required field BLOCKS, and no real Greenhouse board
 * therefore reaches `ready` yet: every one of them asks for a resume, and
 * Prepare does not attach. That is a true statement about where this unit stops.
 * Excusing attachments from readiness would buy a green card that cannot be
 * submitted, which is the same class of lie as the empty-form one above.
 */
function readinessOf(form: ApplicationForm, coverage: CoverageSummary): Readiness {
  if (form.unsupportedBlocks.length > 0) return "blocked";
  if (coverage.total === 0) return "blocked";
  if (coverage.blockingGaps > 0) return "blocked";
  if (coverage.gaps > 0 || coverage.needsReview > 0) return "needs-review";
  return "ready";
}

/** Stage one application. Pure; submits nothing; can submit nothing. */
export function prepareApplication(input: PrepareInput): StagedApplication {
  const today = input.today ?? new Date();
  const companyKey = input.companyKey ?? "";

  // Two maps, one per scope. Last write wins on a duplicate key, which cannot
  // happen through the store (0017's unique index is `(question_key,
  // company_key)`) and can happen through a caller that concatenated two reads.
  // Built explicitly rather than assuming uniqueness.
  //
  // An answer scoped to a DIFFERENT company is dropped here rather than filtered
  // later: it is not this application's business at all, and a map that held it
  // would be one lookup away from being the bug 0017 exists to close.
  const byKey = new Map<string, AnswerEntry>();
  const byCompanyKey = new Map<string, AnswerEntry>();
  for (const a of input.answers) {
    const key = a.questionKey ?? questionKey(a.question);
    if (key === "") continue;
    const scope = a.companyKey ?? "";
    if (scope === "") byKey.set(key, a);
    else if (companyKey !== "" && scope === companyKey) byCompanyKey.set(key, a);
  }

  const ctx: StageContext = {
    rules: input.rules,
    companyKey,
    postingCountry: input.postingCountry,
    today,
    infer: input.infer,
    byKey,
    byCompanyKey,
  };

  const fields = input.form.fields.filter(isAnswerable).map((f) => stageField(f, ctx));
  const coverage = summarize(fields);
  const readiness = readinessOf(input.form, coverage);

  return {
    form: input.form,
    fields,
    coverage,
    readiness,
    batchApprovable: readiness === "ready",
  };
}
