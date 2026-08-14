import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseGreenhouseForm,
  prepareApplication,
  type AnswerEntry,
  type ApplicationForm,
  type BackedInference,
  type PolicyRule,
  type SituationFact,
  type StagedField,
} from "@/lib/apply";
import { KNOCKOUT_TOPICS } from "@/lib/apply/policy";

/**
 * The four-layer answer engine, against three real Greenhouse forms.
 *
 * Organised by the claim each block defends, and the first block is the one the
 * whole feature is judged on: `docs/plans/AUTO-APPLY.md` sets "wrong knockout
 * answers (must be zero, ever)" as absolute.
 *
 * An adversarial review broke the first version of this engine five ways, all of
 * them without an adversary — a correct rule, a real phrasing, and a wrong
 * answer on a card marked `ready`. Every one of those five is a test here, run
 * from the direction it was broken from.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures", "greenhouse");

function board(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

const COINBASE = parseGreenhouseForm(board("coinbase-7822885"));
const ANTHROPIC = parseGreenhouseForm(board("anthropic-5101378008"));
const DISCORD = parseGreenhouseForm(board("discord-8485797002"));

/** A pinned day, so a computed start date is a fact and not a moving target. */
const MONDAY = new Date(2026, 6, 27); // 2026-07-27 is a Monday, local time.

function answer(question: string, value: string, extra: Partial<AnswerEntry> = {}): AnswerEntry {
  return {
    question,
    answer: value,
    kind: "freeform",
    provenance: "user-entered",
    // The DEFAULT is the human stamp, because most cases are about ordinary
    // fields. Every test about a sensitive field overrides it explicitly.
    authoredBy: "user",
    ...extra,
  };
}

function rule(topic: string, fact: SituationFact, extra: Partial<PolicyRule> = {}): PolicyRule {
  return {
    topic,
    companyKey: "",
    fact,
    provenance: "user-entered",
    authoredBy: "user",
    enabled: true,
    ...extra,
  };
}

const yes: SituationFact = { kind: "boolean", value: true };
const no: SituationFact = { kind: "boolean", value: false };

const IDENTITY: AnswerEntry[] = [
  answer("First name", "Morgan", { kind: "identity" }),
  answer("Last name", "Hale", { kind: "identity" }),
  answer("Email", "morgan.hale@example.com", { kind: "identity" }),
  answer("Phone", "+1 555 0100", { kind: "identity" }),
];

function stage(
  form: ApplicationForm,
  opts: {
    answers?: AnswerEntry[];
    rules?: PolicyRule[];
    companyKey?: string;
    postingCountry?: string;
    infer?: BackedInference;
    today?: Date;
  } = {},
) {
  return prepareApplication({
    form,
    answers: opts.answers ?? IDENTITY,
    rules: opts.rules ?? [],
    companyKey: opts.companyKey ?? "",
    postingCountry: opts.postingCountry,
    infer: opts.infer,
    today: opts.today ?? MONDAY,
  });
}

function field(staged: { fields: StagedField[] }, name: string): StagedField {
  const f = staged.fields.find((x) => x.name === name);
  expect(f, `no staged field ${name}`).toBeTruthy();
  return f!;
}

/**
 * The value a board's select actually SUBMITS for an option label.
 *
 * Greenhouse's Yes/No selects carry `{label: "Yes", value: 1}` — the wire format
 * is the numeric id, so a rule that means "yes" is TRANSLATED, never copied.
 */
function optionValue(form: ApplicationForm, name: string, label: string): string {
  const f = form.fields.find((x) => x.name === name)!;
  const o = f.options.find((x) => x.label === label);
  expect(o, `${name} has no option ${label}`).toBeTruthy();
  return o!.value;
}

/**
 * A one-question form, for phrasings the recorded boards do not happen to
 * contain — the review's corpus is 59 questions and three boards ask 52 between
 * them.
 *
 * `values` is emitted ONLY for a select. A text field carrying options is not a
 * shape Greenhouse produces, and the first version of this helper emitted them
 * unconditionally: every "does a boolean situation reach a free-text box?" case
 * was silently testing a select instead.
 */
function synthetic(
  label: string,
  opts: { type?: string; options?: string[]; required?: boolean } = {},
): ApplicationForm {
  const type = opts.type ?? "multi_value_single_select";
  const isSelect = type.startsWith("multi_value");
  return parseGreenhouseForm({
    id: 999,
    company_name: "Testco",
    questions: [
      {
        label,
        required: opts.required ?? true,
        fields: [
          {
            name: "q1",
            type,
            values: isSelect
              ? (opts.options ?? ["Yes", "No"]).map((l, i) => ({ label: l, value: i }))
              : [],
          },
        ],
      },
    ],
  });
}

// ═══════════════════════════ the five polarity traps, each a wrong answer once

describe("a situation is derived against the question's polarity, never replayed", () => {
  /**
   * Every case here is a `rule -> question -> staged` triple the review EXECUTED
   * against the first design and got the OPPOSITE of the truth, with
   * `readiness: "ready"` and `batchApprovable: true`.
   */
  it("`without sponsorship` inverts a needs-sponsorship situation", () => {
    const form = synthetic("Are you able to work in the US without sponsorship, now or in the future?");
    const staged = stage(form, {
      rules: [rule("visa_sponsorship", { kind: "boolean", value: false })],
    });
    // needs_sponsorship = false, question inverted -> YES, I can work without it.
    expect(field(staged, "q1").answer).toBe(optionValue(form, "q1", "Yes"));
    expect(field(staged, "q1").source).toBe("policy:visa_sponsorship/inverted");
  });

  it("…and the direct phrasing of the same situation answers the other way", () => {
    const form = synthetic("Do you require visa sponsorship?");
    const staged = stage(form, {
      rules: [rule("visa_sponsorship", { kind: "boolean", value: false })],
    });
    expect(field(staged, "q1").answer).toBe(optionValue(form, "q1", "No"));
    expect(field(staged, "q1").source).toBe("policy:visa_sponsorship/direct");
  });

  it("a background-check CONSENT is not answered from a criminal-history situation", () => {
    const form = synthetic("Are you willing to submit to a background check?");
    // The old design answered this "No" from `criminal_history = "No"`, i.e.
    // "I refuse a background check".
    const staged = stage(form, { rules: [rule("criminal_history", { kind: "enum", value: "none" })] });
    expect(field(staged, "q1").answer).toBeNull();
    expect(field(staged, "q1").gap).toBe("policy-unset");

    // Its own situation answers it.
    const consenting = stage(form, { rules: [rule("background_check_consent", yes)] });
    expect(field(consenting, "q1").answer).toBe(optionValue(form, "q1", "Yes"));
  });

  it("relocation ASSISTANCE is refused, not answered from willingness", () => {
    const form = synthetic("Do you require relocation assistance?");
    const staged = stage(form, { rules: [rule("relocation", yes)] });
    expect(field(staged, "q1").answer).toBeNull();
    expect(field(staged, "q1").gap).toBe("polarity-unknown");
  });

  it("a CURRENT salary is refused, and an expected one is answered", () => {
    const money: SituationFact = { kind: "money", value: 150000, currency: "USD" };
    const current = synthetic("What is your current salary?", { type: "input_text" });
    expect(field(stage(current, { rules: [rule("compensation", money)] }), "q1").gap)
      .toBe("polarity-unknown");

    const desired = synthetic("What are your salary expectations?", { type: "input_text" });
    expect(field(stage(desired, { rules: [rule("compensation", money)] }), "q1").answer)
      .toBe("150000");
  });

  it("`do you require work authorization` is not answered at all", () => {
    // The classifier does not read it (`authorization` is not `authorized`), and
    // the sensitive list stops it going anywhere else.
    const form = synthetic("Do you require work authorization to be employed here?");
    const staged = stage(form, {
      rules: [rule("work_authorization", { kind: "countries", value: ["united states"] })],
      infer: () => ({ answer: "Yes", citation: "master-resume.md" }),
    });
    expect(field(staged, "q1").answer).toBeNull();
    expect(field(staged, "q1").gap).toBe("sensitive-unclassified");
  });

  it("an uncertain polarity gaps even with a perfectly good situation", () => {
    const form = synthetic("Are you under 18 years of age?");
    const staged = stage(form, { rules: [rule("age_eligibility", yes)] });
    expect(field(staged, "q1").gap).toBe("polarity-unknown");
  });
});

// ═══════════════════════════════════ the absolute: no wrong knockout answers

// ═══════════════════════════════════ scope, which layer order alone got wrong

/**
 * The precedence an adversarial review walked through, executed from the
 * direction it was broken from.
 *
 * The shape of the bug: `answers` had no company column, the review screen wrote
 * every typed gap answer globally, and layer 1 ran before layer 2. So a one-off
 * answer typed at one board silently and permanently overrode a rule the person
 * had deliberately scoped to a different company — on a card marked ready, on a
 * knockout-adjacent question, through the growth loop the whole feature is built
 * on.
 *
 * The rule now: MOST SPECIFIC SCOPE WINS, and only then the layer order.
 */
describe("a per-company exception outranks an answer that applies everywhere", () => {
  const FORM = synthetic("Have you previously been employed by Stripe?");
  const RULES = [
    rule("prior_employment", no),
    rule("prior_employment", yes, { companyKey: "stripe" }),
  ];
  const YES = optionValue(FORM, "q1", "Yes");
  const NO = optionValue(FORM, "q1", "No");

  it("the exception answers, and says whose it is", () => {
    const staged = stage(FORM, { answers: [], rules: RULES, companyKey: "stripe" });
    expect(field(staged, "q1").answer).toBe(YES);
    expect(field(staged, "q1").source).toBe("policy:prior_employment@stripe/direct");
  });

  it("REGRESSION: a global library answer no longer beats it", () => {
    // The probe's exact scenario. Before the fix this staged "No" — the person's
    // own one-off answer, typed at some other company — at the one company where
    // the truth is Yes, and `batchApprovable` was true.
    const staged = stage(FORM, {
      answers: [answer("Have you previously been employed by Stripe?", "No")],
      rules: RULES,
      companyKey: "stripe",
    });
    expect(field(staged, "q1").answer).toBe(YES);
    expect(field(staged, "q1").layer).toBe("policy");
  });

  it("…and everywhere else that same answer still answers, from the library", () => {
    // The other half, or the fix is just "rules always win": at a company with no
    // exception, layer 1 is still layer 1.
    const staged = stage(FORM, {
      answers: [answer("Have you previously been employed by Stripe?", "No")],
      rules: RULES,
      companyKey: "ramp",
    });
    expect(field(staged, "q1").answer).toBe(NO);
    expect(field(staged, "q1").layer).toBe("constant");
  });

  it("a DISABLED exception falls through to the library, not into a gap", () => {
    // "Turning a rule off puts the general answer back" — the sentence the
    // settings page makes, and it has to stay true of the library too.
    const staged = stage(FORM, {
      answers: [answer("Have you previously been employed by Stripe?", "No")],
      rules: [rule("prior_employment", yes, { companyKey: "stripe", enabled: false })],
      companyKey: "stripe",
    });
    expect(field(staged, "q1").answer).toBe(NO);
    expect(field(staged, "q1").layer).toBe("constant");
  });

  it("an exception that cannot answer GAPS rather than using the general answer", () => {
    // A rule whose fact is the wrong kind for the question. Falling through to
    // the library here would submit the one answer the person has said is wrong
    // at this company, which is the failure in a quieter costume.
    const staged = stage(FORM, {
      answers: [answer("Have you previously been employed by Stripe?", "No")],
      rules: [rule("prior_employment", { kind: "enum", value: "maybe" }, { companyKey: "stripe" })],
      companyKey: "stripe",
    });
    expect(field(staged, "q1").answer).toBeNull();
    expect(field(staged, "q1").gap).toBe("situation-mismatch");
  });

  it("a company-scoped ANSWER outranks the exception, and never leaves its company", () => {
    // 0017's own column, and the top of the ladder: the person answered this
    // exact question at this exact company.
    const answers = [
      answer("Have you previously been employed by Stripe?", "No", { companyKey: "stripe" }),
    ];
    const here = stage(FORM, { answers, rules: RULES, companyKey: "stripe" });
    expect(here.fields[0].answer).toBe(NO);
    expect(here.fields[0].layer).toBe("constant");
    expect(here.fields[0].source).toBe(
      "answer:have you previously been employed by stripe@stripe",
    );

    // …and at Ramp it does not exist: the answer is Stripe's, so what stages is
    // the GLOBAL rule. A scoped answer leaking across companies is the same bug
    // pointing the other way, and the tell is the layer rather than the value —
    // both scopes happen to say No here, which is exactly the coincidence a
    // value-only assertion would pass on.
    const elsewhere = stage(FORM, { answers, rules: RULES, companyKey: "ramp" });
    expect(elsewhere.fields[0].layer).toBe("policy");
    expect(elsewhere.fields[0].source).toBe("policy:prior_employment/direct");
  });

  it("a scoped answer is invisible when the application has no company at all", () => {
    const staged = stage(FORM, {
      answers: [answer("Have you previously been employed by Stripe?", "No", { companyKey: "stripe" })],
      rules: [],
      companyKey: "",
    });
    expect(staged.fields[0].gap).toBe("policy-unset");
  });
});

describe("what a derived value looks like when it reaches the board", () => {
  it("trims a text situation rather than submitting its padding", () => {
    // SQL only checks that `hq_blank_trim(value)` is non-empty, so
    // `"  Chicago, IL  "` is a legal row — and it went onto the board's box with
    // the padding still on it.
    const form = synthetic("What city are you based in?", { type: "input_text" });
    const staged = stage(form, {
      rules: [rule("current_location", { kind: "text", value: "  Chicago, IL\u00a0 " })],
    });
    expect(field(staged, "q1").answer).toBe("Chicago, IL");
  });

  it("submits a pay expectation as plain digits", () => {
    // `String(1e21)` is "1e+21". The magnitude bound lives in
    // `parseSituationFact` (a fact that large is refused at the door), and this is
    // the half that says what the accepted range renders as.
    const form = synthetic("What are your salary expectations?", { type: "input_text" });
    const staged = stage(form, {
      rules: [rule("compensation", { kind: "money", value: 185_000, currency: "USD" })],
    });
    expect(field(staged, "q1").answer).toBe("185000");
  });
});

describe("a policy question with no rule is a GAP, never a guess", () => {
  it("leaves Coinbase's work-authorization question unanswered", () => {
    const staged = stage(COINBASE);
    const auth = field(staged, "question_65684137");
    expect(auth.label).toContain("legally authorized to work");
    expect(auth.answer).toBeNull();
    expect(auth.gap).toBe("policy-unset");
    expect(auth.layer).toBeNull();
  });

  it("does not pick the first option, which is what a defaulting mutant does", () => {
    const staged = stage(COINBASE);
    for (const f of staged.fields) if (f.gap !== null) expect(f.answer).toBeNull();
  });

  it("leaves every knockout question on every board unanswered without a rule", () => {
    for (const form of [COINBASE, ANTHROPIC, DISCORD]) {
      const staged = stage(form);
      const knockouts = staged.fields.filter((f) =>
        /authorized to work|sponsorship|at least 18/i.test(f.label),
      );
      expect(knockouts.length, `${form.company} has knockout questions`).toBeGreaterThan(0);
      for (const f of knockouts) {
        expect(f.answer, `${form.company}: ${f.label}`).toBeNull();
      }
    }
  });

  it("answers a knockout ONLY from a situation the human recorded", () => {
    // The positive control. Without it, "knockouts are never answered" also
    // passes on an engine that answers nothing at all.
    const staged = stage(COINBASE, {
      postingCountry: "United States",
      rules: [rule("work_authorization", { kind: "countries", value: ["united states"] })],
    });
    const auth = field(staged, "question_65684137");
    expect(auth.answer).toBe(optionValue(COINBASE, "question_65684137", "Yes"));
    expect(auth.layer).toBe("policy");
    expect(auth.source).toBe("policy:work_authorization/direct");
  });

  it("gaps a country question the posting's country cannot resolve", () => {
    // Coinbase asks about "the country where this position is located". Without
    // a posting country there is no honest answer, and there is no "assume the
    // US" branch — that assumption is wrong for most of the planet.
    const staged = stage(COINBASE, {
      rules: [rule("work_authorization", { kind: "countries", value: ["united states"] })],
    });
    expect(field(staged, "question_65684137").gap).toBe("situation-mismatch");
  });

  it("answers NO when the resolved country is not in the situation", () => {
    const form = synthetic("Are you legally authorized to work in Canada?");
    const staged = stage(form, {
      rules: [rule("work_authorization", { kind: "countries", value: ["united states"] })],
    });
    expect(field(staged, "q1").answer).toBe(optionValue(form, "q1", "No"));
  });

  it("gaps a knockout whose rule is DISABLED", () => {
    const staged = stage(COINBASE, {
      postingCountry: "United States",
      rules: [
        rule("work_authorization", { kind: "countries", value: ["united states"] },
             { enabled: false }),
      ],
    });
    expect(field(staged, "question_65684137").gap).toBe("policy-unset");
  });

  it("gaps a derived value that is not one of the offered options", () => {
    // A `text` situation against a Yes/No select: the derivation succeeds and
    // the OPTION TABLE refuses it, which is the second of the two guards.
    const form = synthetic("Are you legally authorized to work in the US?");
    const staged = stage(form, {
      rules: [rule("work_authorization", { kind: "text", value: "Absolutely" })],
    });
    expect(field(staged, "q1").answer).toBeNull();
    expect(field(staged, "q1").gap).toBe("option-mismatch");
  });

  it("gaps an ambiguous question rather than picking one of its topics", () => {
    const staged = stage(DISCORD, {
      rules: [rule("relocation", yes), rule("current_location", { kind: "text", value: "SF" })],
    });
    const compound = staged.fields.find((f) => /based in or willing to relocate/i.test(f.label))!;
    expect(compound.answer).toBeNull();
    expect(compound.gap).toBe("policy-ambiguous");
  });

  it("covers every knockout topic, so the list above is not a sample", () => {
    expect(KNOCKOUT_TOPICS.length).toBe(7);
  });
});

// ══════════════════════════════════════ layer 3 cannot see a sensitive label

describe("layer 3 is bounded by the SENSITIVE list, not by the classifier's recall", () => {
  /** The most permissive layer 3 that could ever be written. */
  const yesToEverything: BackedInference = () => ({
    answer: "Yes",
    citation: "master-resume.md: definitely",
  });

  it("refuses the knockout phrasings the classifier does NOT read", () => {
    /**
     * The review's exact finding: with an infer hook supplied, "Do you now or
     * will you in the future require an employment-based visa to work in the
     * US?" staged `{answer: "0", layer: "inference"}` on a REQUIRED sponsorship
     * select, because the only thing in front of it was `PATTERNS`' recall.
     */
    for (const label of [
      "Do you now or will you in the future require an employment-based visa to work in the US?",
      "Do you require a work permit to work in Canada?",
      "Will you require immigration support (H-1B, TN, OPT) now or in the future?",
      "Do you require a visa to work in the US?",
      "Do you require work authorization to be employed here?",
    ]) {
      const staged = stage(synthetic(label), { infer: yesToEverything });
      expect(field(staged, "q1").layer, label).toBeNull();
      expect(field(staged, "q1").gap, label).toBe("sensitive-unclassified");
    }
  });

  it("refuses every knockout on every recorded board", () => {
    for (const form of [COINBASE, ANTHROPIC, DISCORD]) {
      const staged = stage(form, { infer: yesToEverything });
      for (const f of staged.fields.filter((x) => x.layer === "inference")) {
        expect(
          /authorized to work|sponsorship|at least 18|salary|criminal|legal name|gender|race|veteran|disab/i
            .test(f.label),
          `layer 3 answered a sensitive field: ${f.label}`,
        ).toBe(false);
      }
    }
  });

  it("still answers an ordinary field, so the guard is not simply total", () => {
    const form = synthetic("Which of the following describes your workflow?", {
      options: ["Manual", "Automated"],
    });
    const staged = stage(form, {
      infer: () => ({ answer: "Automated", citation: "master-resume.md: shipped a pipeline" }),
    });
    expect(field(staged, "q1").layer).toBe("inference");
  });

  it("DISCARDS an answer with no citation — the truth ceiling, architectural", () => {
    for (const citation of ["", "   ", "\n"]) {
      const staged = stage(
        synthetic("Which of the following describes your workflow?", {
          options: ["Manual", "Automated"],
        }),
        { infer: () => ({ answer: "Automated", citation }) },
      );
      expect(field(staged, "q1").layer).toBeNull();
    }
  });

  it("always marks an inferred answer `suggested`, whatever the hook claims", () => {
    const form = synthetic("Which of the following describes your workflow?", {
      options: ["Manual", "Automated"],
    });
    const staged = stage(form, {
      infer: () => ({ answer: "Automated", citation: "cited" }),
    });
    expect(field(staged, "q1").provenance).toBe("suggested");
    expect(staged.readiness).not.toBe("ready");
  });

  it("cannot reach a free-response textarea", () => {
    const staged = stage(DISCORD, {
      infer: () => ({ answer: "Because I love it", citation: "master-resume.md" }),
    });
    const why = staged.fields.find((f) => /why do you want to work/i.test(f.label))!;
    expect(why.gap).toBe("free-response");
    expect(why.layer).toBeNull();
  });
});

// ══════════════════════════════════════════════════════ self-identification

describe("self-identification is the human's alone", () => {
  it("stages every EEO field as its own gap reason", () => {
    const staged = stage(DISCORD);
    const selfId = staged.fields.filter((f) => f.name.startsWith("demographic_"));
    expect(selfId.length).toBeGreaterThan(3);
    for (const f of selfId) {
      expect(f.answer).toBeNull();
      expect(f.gap).toBe("self-identification");
    }
  });

  it("NEVER picks the decline option, from any layer", () => {
    /**
     * The tempting shortcut: every EEO question offers "I don't wish to answer",
     * so a resolver could "safely" pick it and clear the block. Declining is a
     * choice, and making it for somebody is the same act as making any other.
     *
     * The review found the OLD engine doing exactly this from a library row, so
     * this is asserted with a human-authored, exactly-keyed answer naming the
     * decline option — the strongest input that could reach it.
     */
    const staged = stage(DISCORD, {
      answers: [
        ...IDENTITY,
        answer("Gender", "I don't wish to answer", { kind: "eeo", authoredBy: "user" }),
      ],
    });
    const gender = staged.fields.find((f) => f.label === "Gender")!;
    expect(gender.answer).toBeNull();
    expect(gender.gap).toBe("option-mismatch");
  });

  it("REGRESSION: a decline the person CHOSE is replayed, not gapped forever", () => {
    /**
     * The other blocking finding. `matchOption` refuses the decline option from
     * every layer — correct, and the engine still does — but the review screen
     * stored the option's LABEL as an ordinary answer, so the next prepare found
     * a value no layer may select and gapped as `option-mismatch`: *"The value
     * we would submit is not one of the options this board offers. Pick one of
     * theirs."* It is one of theirs. They already picked it.
     *
     * The flag is what makes it replayable. The test above still holds — an
     * answer that merely SPELLS the label is refused — so the two together pin
     * the distinction the whole fix rests on: the engine never declines, and a
     * person's own decline is an answer.
     */
    const staged = stage(DISCORD, {
      answers: [
        ...IDENTITY,
        answer("Gender", "I don't wish to answer", {
          kind: "eeo",
          authoredBy: "user",
          declined: true,
        }),
      ],
    });
    const gender = staged.fields.find((f) => f.label === "Gender")!;
    const src = DISCORD.fields.find((f) => f.label === "Gender")!;
    const decline = src.options.find((o) => o.declineToAnswer)!;
    expect(gender.gap).toBeNull();
    expect(gender.answer).toBe(decline.value);
    expect(gender.declined).toBe(true);
    expect(gender.layer).toBe("constant");
  });

  it("replays a decline onto the board's OWN option, whatever it calls it", () => {
    // Matched on the flag rather than on the words, so a board wording its
    // decline differently still gets its own option rather than a mismatch.
    const form = synthetic("Gender", { options: ["Man", "Woman", "Prefer not to say"] });
    // `synthetic` builds an ordinary question, so mark the option the way the
    // demographic parser does and re-stage against it.
    form.fields[0].selfIdentification = true;
    form.fields[0].options[2].declineToAnswer = true;
    const staged = stage(form, {
      answers: [
        answer("Gender", "I don't wish to answer", {
          kind: "eeo",
          authoredBy: "user",
          declined: true,
        }),
      ],
    });
    expect(field(staged, "q1").answer).toBe(optionValue(form, "q1", "Prefer not to say"));
  });

  it("gaps a decline on a board that offers no way to decline", () => {
    // The honest end of the same branch: `option-mismatch` is TRUE here — this
    // board really does not offer it — which is the case the copy was written
    // for and the case it was wrongly printed for before.
    const form = synthetic("Gender", { options: ["Man", "Woman"] });
    form.fields[0].selfIdentification = true;
    const staged = stage(form, {
      answers: [
        answer("Gender", "I don't wish to answer", {
          kind: "eeo",
          authoredBy: "user",
          declined: true,
        }),
      ],
    });
    expect(field(staged, "q1").answer).toBeNull();
    expect(field(staged, "q1").gap).toBe("option-mismatch");
  });

  it("a MACHINE cannot ride the decline flag onto a demographic field", () => {
    // Belt and braces against the door 0017 already closes: the constraint
    // refuses `declined` on any row the trigger did not stamp `user`, and the
    // engine's sensitive gate refuses the row anyway.
    const staged = stage(DISCORD, {
      answers: [
        ...IDENTITY,
        answer("Gender", "I don't wish to answer", {
          kind: "freeform",
          authoredBy: "service",
          declined: true,
        }),
      ],
    });
    const gender = staged.fields.find((f) => f.label === "Gender")!;
    expect(gender.answer).toBeNull();
    expect(gender.gap).toBe("self-identification");
  });

  it("REGRESSION: no policy rule reaches a demographic field, at EITHER scope", () => {
    /**
     * The scope reordering put rung 2 — this company's exception — ABOVE the
     * self-identification stop, so a demographic-block question that classifies
     * to a topic was answered from a company-scoped rule while the same rule
     * scoped globally was refused. Same field, same fact, two answers depending
     * on scope.
     *
     * Written through the PRODUCTION classifier: the demo's EEO labels are
     * "Gender" and "Veteran status" and neither classifies to a topic, so a test
     * using them cannot see this at all. "Are you legally authorized to work in
     * the United States?" inside an EEO block does classify, and boards do put
     * work-authorization questions in that block.
     */
    const form = synthetic("Are you legally authorized to work in the United States?");
    form.fields[0].selfIdentification = true;
    const fact: SituationFact = { kind: "countries", value: ["united states"] };

    for (const [scope, rules] of [
      ["a company exception", [rule("work_authorization", fact, { companyKey: "stripe" })]],
      ["the global rule", [rule("work_authorization", fact)]],
      [
        "both",
        [rule("work_authorization", fact), rule("work_authorization", fact, { companyKey: "stripe" })],
      ],
    ] as const) {
      const staged = stage(form, {
        answers: [],
        rules: [...rules],
        companyKey: "stripe",
        postingCountry: "United States",
      });
      expect(field(staged, "q1").answer, scope).toBeNull();
      expect(field(staged, "q1").layer, scope).toBeNull();
      expect(field(staged, "q1").gap, scope).toBe("self-identification");
    }

    // The positive control: the same rule, the same board, WITHOUT the
    // demographic flag, answers — so the refusal above is about self-ID and not
    // about a rule that cannot answer this question at all.
    const ordinary = synthetic("Are you legally authorized to work in the United States?");
    const answered = stage(ordinary, {
      answers: [],
      rules: [rule("work_authorization", fact, { companyKey: "stripe" })],
      companyKey: "stripe",
      postingCountry: "United States",
    });
    expect(field(answered, "q1").layer).toBe("policy");
    expect(field(answered, "q1").source).toBe("policy:work_authorization@stripe/direct");
  });

  it("refuses a machine-written self-ID answer even when it is labelled ordinary", () => {
    /**
     * The review's exploit: 0014's `kind='eeo'` check is keyed on a
     * caller-supplied string, so a machine wrote the same answer as
     * `kind: "freeform"` and it staged onto the demographic field. The engine
     * now keys on `authoredBy`, which Postgres stamps.
     */
    const staged = stage(DISCORD, {
      answers: [
        ...IDENTITY,
        answer("Gender", "Male", { kind: "freeform", provenance: "confirmed", authoredBy: "service" }),
      ],
    });
    const gender = staged.fields.find((f) => f.label === "Gender")!;
    expect(gender.answer).toBeNull();
    expect(gender.gap).toBe("self-identification");
  });

  it("DOES reuse the person's own substantive self-identification", () => {
    /**
     * The other half, and what makes the growth loop work. Refusing this would
     * make somebody re-declare their race on every application, which is its own
     * kind of disrespect. `authoredBy: "user"` is the licence, and 0014's
     * trigger is what makes that field trustworthy.
     */
    const staged = stage(DISCORD, {
      answers: [...IDENTITY, answer("Gender", "Male", { kind: "eeo", authoredBy: "user" })],
    });
    const gender = staged.fields.find((f) => f.label === "Gender")!;
    expect(gender.layer).toBe("constant");
    // The submitted value is the option's ID, not the label text.
    expect(gender.answer).toMatch(/^\d+$/);
  });
});

// ═════════════════════════════════ the kind gates, and where they now sit

describe("kind gates run BEFORE the library", () => {
  it("never puts library text into a FILE field", () => {
    /**
     * The review's finding, and it was live on every Greenhouse board: one
     * library row keyed `resume cv` filled `resume` (a file) AND `resume_text`
     * (a textarea), and the form read `ready`. The gate sat below the lookup,
     * so it was unreachable whenever the lookup hit.
     */
    const staged = stage(COINBASE, {
      answers: [...IDENTITY, answer("Resume/CV", "pasted resume text")],
    });
    const resume = field(staged, "resume");
    expect(resume.kind).toBe("file");
    expect(resume.answer).toBeNull();
    expect(resume.gap).toBe("attachment");
    // The paste half is a legitimate target and still fills.
    expect(field(staged, "resume_text").answer).toBe("pasted resume text");
  });

  it("never puts library text into a consent field", () => {
    const withConsent = parseGreenhouseForm({
      ...(COINBASE as unknown as object),
      id: 7822885,
      questions: [],
      data_compliance: [{ type: "gdpr", requires_consent: true }],
    });
    const consent = withConsent.fields.find((f) => f.rawType === "data_compliance")!;
    const staged = stage(withConsent, { answers: [answer(consent.label, "Yes")] });
    expect(field(staged, consent.name).gap).toBe("consent");
  });

  it("stages an unknown field type as unsupported even WITH a library answer", () => {
    const mutant = parseGreenhouseForm({
      id: 1,
      questions: [
        { label: "Sign here", required: false, fields: [{ name: "sig", type: "input_signature" }] },
      ],
    });
    const staged = stage(mutant, { answers: [answer("Sign here", "Morgan")] });
    expect(field(staged, "sig").gap).toBe("unsupported");
  });

  it("names a policy acknowledgement as a consent, not as `no answer`", () => {
    // Anthropic's required "AI Policy for Application" select. Never answered —
    // agreeing on somebody's behalf is not filling in a field — but the review
    // surface gets the right affordance for the corpus's most common consent.
    const staged = stage(ANTHROPIC);
    const policy = staged.fields.find((f) => f.label === "AI Policy for Application")!;
    expect(policy.gap).toBe("consent");
  });
});

// ═══════════════════════════════════════════════════════ layer 1: constants

describe("layer 1 — the answer library", () => {
  it("fills identity fields by the ATS's stable field name, not by label", () => {
    const staged = stage(COINBASE);
    expect(field(staged, "first_name").answer).toBe("Morgan");
    expect(field(staged, "email").source).toBe("answer:email");
  });

  it("matches a custom question by NORMALIZED label across boards", () => {
    const staged = stage(COINBASE, {
      answers: [...IDENTITY, answer("are you at least 18 years of age", "Yes")],
    });
    const eighteen = field(staged, "question_65684130");
    expect(eighteen.answer).toBe(optionValue(COINBASE, "question_65684130", "Yes"));
    expect(eighteen.layer).toBe("constant");
  });

  it("beats a policy situation that would have answered the same field", () => {
    // Strict precedence. The library entry is what this person said about THIS
    // question; the situation is a generalisation.
    const staged = stage(COINBASE, {
      answers: [...IDENTITY, answer("Are you at least 18 years of age?", "Yes")],
      rules: [rule("age_eligibility", no)],
    });
    expect(field(staged, "question_65684130").layer).toBe("constant");
    expect(field(staged, "question_65684130").answer)
      .toBe(optionValue(COINBASE, "question_65684130", "Yes"));
  });

  it("refuses a machine-authored answer on a sensitive field", () => {
    const staged = stage(COINBASE, {
      answers: [
        ...IDENTITY,
        answer("Are you at least 18 years of age?", "Yes",
               { provenance: "confirmed", authoredBy: "service" }),
      ],
    });
    // Falls through to layer 2, which has no rule -> gap, not the machine's word.
    expect(field(staged, "question_65684130").layer).toBeNull();
    expect(field(staged, "question_65684130").gap).toBe("policy-unset");
  });

  it("treats a missing authoredBy as `service` on a sensitive field", () => {
    // The safe direction for an unknown writer: a caller that assembled the
    // array itself and forgot the column does not get a knockout answered.
    const entry = answer("Are you at least 18 years of age?", "Yes");
    delete (entry as { authoredBy?: string }).authoredBy;
    const staged = stage(COINBASE, { answers: [...IDENTITY, entry] });
    expect(field(staged, "question_65684130").layer).toBeNull();
  });

  it("refuses a CANONICAL-ALIAS match on a sensitive field", () => {
    /**
     * "an exact question_key match" is the OTHER half of the gate, and it is the
     * half that makes per-question memory polarity-safe: the human answered THAT
     * question, so no direction has to be inferred. An alias match is a
     * different question wearing the same field name.
     *
     * Unreachable on today's boards — no `CANONICAL_FIELDS` name is ever
     * labelled with a sensitive question — so the case is built: a field the ATS
     * calls `email` whose LABEL asks for a legal name. The `email` library row
     * would otherwise be typed into it, human-authored and completely wrong.
     * Without this the branch survives mutation, which is how a guard becomes
     * decoration.
     */
    const aliased = parseGreenhouseForm({
      id: 998,
      questions: [
        {
          label: "What is your full legal name?",
          required: true,
          fields: [{ name: "email", type: "input_text", values: [] }],
        },
      ],
    });
    const staged = stage(aliased, {
      answers: [answer("Email", "morgan.hale@example.com", { kind: "identity" })],
    });
    expect(field(staged, "email").answer).toBeNull();
    expect(field(staged, "email").gap).toBe("policy-unset");

    // The exact-key match on the same field DOES fill, so the gate is not
    // simply refusing everything.
    const exact = stage(aliased, {
      answers: [answer("What is your full legal name?", "Morgan Hale")],
    });
    expect(field(exact, "email").answer).toBe("Morgan Hale");
  });

  it("still fills an ORDINARY field from a machine-written row", () => {
    // The positive control on the authorship gate: it binds sensitive fields
    // only, or the growth loop could never suggest anything.
    const staged = stage(COINBASE, {
      answers: [
        ...IDENTITY,
        answer("Linkedin Profile URL", "https://x", { provenance: "suggested", authoredBy: "service" }),
      ],
    });
    expect(field(staged, "question_65684129").answer).toBe("https://x");
    expect(field(staged, "question_65684129").provenance).toBe("suggested");
  });

  it("treats a blank stored answer as no answer", () => {
    // blankTrim, not .trim(): a stored answer of one newline is blank to a
    // person and truthy to JavaScript.
    const staged = stage(COINBASE, {
      answers: [...IDENTITY, answer("Linkedin Profile URL", "\n  ")],
    });
    expect(field(staged, "question_65684129").answer).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════ layer 2: policy

describe("layer 2 — the situation", () => {
  it("answers both of Anthropic's sponsorship questions from ONE situation", () => {
    const staged = stage(ANTHROPIC, { rules: [rule("visa_sponsorship", no)] });
    const both = staged.fields.filter((f) => /sponsorship/i.test(f.label));
    expect(both.length).toBe(2);
    for (const f of both) {
      expect(f.answer).toBe(optionValue(ANTHROPIC, f.name, "No"));
      expect(f.source).toBe("policy:visa_sponsorship/direct");
    }
  });

  it("prefers a company-scoped rule over the global one", () => {
    const staged = stage(COINBASE, {
      companyKey: "coinbase",
      rules: [rule("prior_employment", no), rule("prior_employment", yes, { companyKey: "coinbase" })],
    });
    const prior = field(staged, "question_65684131");
    expect(prior.answer).toBe(optionValue(COINBASE, "question_65684131", "Yes"));
    expect(prior.source).toBe("policy:prior_employment@coinbase/direct");
  });

  it("falls back to the global rule when a company override is DISABLED", () => {
    /**
     * The docstring says turning a rule off is the gesture a person wants. The
     * first version returned the disabled override and then gapped, which made
     * the global rule unreachable for that company — safe, and not what the
     * word means.
     */
    const staged = stage(COINBASE, {
      companyKey: "coinbase",
      rules: [
        rule("prior_employment", no),
        rule("prior_employment", yes, { companyKey: "coinbase", enabled: false }),
      ],
    });
    expect(field(staged, "question_65684131").source).toBe("policy:prior_employment/direct");
    expect(field(staged, "question_65684131").answer)
      .toBe(optionValue(COINBASE, "question_65684131", "No"));
  });

  it("ignores a company-scoped rule when no company key is supplied", () => {
    const staged = stage(COINBASE, {
      rules: [rule("prior_employment", yes, { companyKey: "coinbase" })],
    });
    expect(field(staged, "question_65684131").gap).toBe("policy-unset");
  });

  it("resolves a computed start date to the Monday N weeks out", () => {
    const staged = stage(ANTHROPIC, {
      rules: [rule("start_date", { kind: "directive", value: "monday-weeks-out:3" })],
    });
    // MONDAY is 2026-07-27; three weeks out is 2026-08-17, itself a Monday, and
    // a date that is already a Monday must not slip another week.
    expect(field(staged, "question_14826590008").answer).toBe("2026-08-17");
  });

  it("rolls a computed date forward to Monday when it lands mid-week", () => {
    const staged = stage(ANTHROPIC, {
      today: new Date(2026, 6, 29), // Wednesday
      rules: [rule("start_date", { kind: "directive", value: "monday-weeks-out:2" })],
    });
    expect(field(staged, "question_14826590008").answer).toBe("2026-08-17");
  });

  it("gaps an unrecognised directive instead of resolving it to something", () => {
    for (const value of ["tomorrow", "monday-weeks-out-3", "monday-weeks-out:999"]) {
      const staged = stage(ANTHROPIC, {
        rules: [rule("start_date", { kind: "directive", value })],
      });
      expect(field(staged, "question_14826590008").gap, value).toBe("situation-mismatch");
    }
  });

  it("gaps a boolean situation on a free-text field", () => {
    // "Yes" typed into a text box is a guess about format.
    const form = synthetic("Are you willing to relocate to New York?", { type: "input_text" });
    expect(field(stage(form, { rules: [rule("relocation", yes)] }), "q1").gap)
      .toBe("situation-mismatch");
  });

  it("gaps an enum the engine does not know how to read", () => {
    const form = synthetic("Have you ever been convicted of a felony?");
    expect(
      field(stage(form, { rules: [rule("criminal_history", { kind: "enum", value: "maybe" })] }), "q1")
        .gap,
    ).toBe("situation-mismatch");
    expect(
      field(stage(form, { rules: [rule("criminal_history", { kind: "enum", value: "none" })] }), "q1")
        .answer,
    ).toBe(optionValue(form, "q1", "No"));
  });
});

// ═════════════════════════════════════════════════════════════ the bookkeeping

describe("coverage and readiness", () => {
  it("excludes hidden geocode fields from the counts", () => {
    const staged = stage(COINBASE);
    expect(staged.fields.some((f) => f.name === "latitude")).toBe(false);
    expect(staged.coverage.total).toBe(staged.fields.length);
    expect(COINBASE.fields.some((f) => f.name === "latitude")).toBe(true);
  });

  it("adds up: answered + needsReview + gaps === total", () => {
    for (const form of [COINBASE, ANTHROPIC, DISCORD]) {
      const c = stage(form).coverage;
      expect(c.answered + c.needsReview + c.gaps).toBe(c.total);
    }
  });

  it("counts blocking gaps only on required fields", () => {
    const staged = stage(ANTHROPIC);
    const required = staged.fields.filter((f) => f.required && f.gap !== null);
    expect(staged.coverage.blockingGaps).toBe(required.length);
    expect(staged.coverage.blockingGaps).toBeLessThan(staged.coverage.gaps);
  });

  it("groups gaps by reason, omitting reasons with no gaps", () => {
    const byReason = stage(DISCORD).coverage.gapsByReason;
    expect(byReason["self-identification"]).toBeGreaterThan(0);
    expect(Object.values(byReason).every((n) => (n ?? 0) > 0)).toBe(true);
    expect(byReason.unsupported).toBeUndefined();
  });

  it("is BLOCKED while a required question has no answer", () => {
    const staged = stage(COINBASE);
    expect(staged.coverage.blockingGaps).toBeGreaterThan(0);
    expect(staged.readiness).toBe("blocked");
    expect(staged.batchApprovable).toBe(false);
  });

  it("is BLOCKED when the form has nothing to answer at all", () => {
    /**
     * `{"id":123,"questions":[]}` — a closed posting, a wrong fetch moment, a
     * board hiccup. The parser's throw only covers a MISSING `questions` key, so
     * an empty array reaches here and used to produce a green card with nothing
     * on it.
     */
    const empty = parseGreenhouseForm({ id: 123, company_name: "Gone", questions: [] });
    const staged = stage(empty);
    expect(staged.coverage.total).toBe(0);
    expect(staged.readiness).toBe("blocked");
    expect(staged.batchApprovable).toBe(false);
  });

  it("is BLOCKED when the only fields are hidden ones", () => {
    // Same shape, one layer down: the geocodes are excluded from coverage, so a
    // form of nothing but hidden fields also totals zero.
    const hiddenOnly = parseGreenhouseForm({
      id: 124,
      questions: [],
      location_questions: [
        { label: "Longitude", required: true, fields: [{ name: "longitude", type: "input_hidden" }] },
      ],
    });
    expect(stage(hiddenOnly).readiness).toBe("blocked");
  });

  it("is BLOCKED when the form carries a payload block nothing understands", () => {
    const withCompliance: ApplicationForm = {
      ...COINBASE,
      unsupportedBlocks: ["compliance"],
    };
    expect(stage(withCompliance).readiness).toBe("blocked");
  });

  it("is not READY on any real board, because every one wants a resume", () => {
    // Stated as its own assertion rather than left implicit in a fixture: an
    // application without its attachment is not approvable in a keystroke, and
    // Prepare does not attach.
    const { answers, rules } = fullyAnswered();
    const staged = stage(DISCORD, { answers, rules });
    expect(staged.coverage.gapsByReason.attachment).toBe(2);
    expect(staged.readiness).toBe("blocked");
  });

  it("is READY only when every field is human-sourced with nothing left over", () => {
    const { answers, rules } = fullyAnswered();
    const staged = stage(DISCORD_NO_UPLOADS, { answers, rules });
    expect(staged.coverage.gaps).toBe(0);
    expect(staged.coverage.needsReview).toBe(0);
    expect(staged.coverage.answered).toBe(staged.coverage.total);
    expect(staged.readiness).toBe("ready");
    expect(staged.batchApprovable).toBe(true);
  });

  it("drops out of READY the moment one answer is machine-suggested", () => {
    const { answers, rules } = fullyAnswered();
    const suggested = [...answers];
    suggested[suggested.length - 1] = {
      ...suggested[suggested.length - 1],
      provenance: "suggested",
    };
    expect(stage(DISCORD_NO_UPLOADS, { answers: suggested, rules }).readiness)
      .toBe("needs-review");
  });

  it("drops out of READY when inference answered ANY field on the form", () => {
    /**
     * Not just the inferred field — the whole application. The reason is the one
     * quality datapoint in AUTO-APPLY.md that matters, from JobCopilot's own
     * user base: "full auto-apply feels productive but produces negligible
     * results; review mode is the only mode that generates real interviews."
     * A card that is 95% deterministic and 5% guessed is one guess away from the
     * failure the design exists to avoid, and batching it is how a person stops
     * reading the 5%.
     */
    const { answers, rules } = fullyAnswered();
    // Remove one ordinary answer and let the hook supply it instead. "Website"
    // is chosen because it classifies to no topic and trips no sensitive
    // pattern — the only shape of field layer 3 is ever allowed to reach.
    const withoutOne = answers.filter((a) => a.question !== "Website");
    const staged = stage(DISCORD_NO_UPLOADS, {
      answers: withoutOne,
      rules,
      infer: (f) =>
        f.label === "Website"
          ? { answer: "https://example.com", citation: "master-resume.md: portfolio" }
          : null,
    });
    expect(staged.coverage.gaps).toBe(0);
    expect(staged.fields.some((f) => f.layer === "inference")).toBe(true);
    expect(staged.readiness).toBe("needs-review");
    expect(staged.batchApprovable).toBe(false);
  });
});

/**
 * Discord's real form MINUS its two upload fields, answered completely from
 * human sources.
 *
 * The subtraction is the honest part. **No real Greenhouse board can reach
 * `ready` today**, because every one of them asks for a resume and Prepare does
 * not attach files — an `attachment` gap on a required field is a blocking gap,
 * and it should be: an application without its resume is not one a human could
 * approve in a keystroke. That is a true statement about where this unit stops,
 * not a bug to route around, and the alternative (excusing attachment gaps from
 * readiness) would be a `ready` that lies in exactly the way the review's
 * finding 7 was about.
 *
 * So the `ready` path is exercised on the 22 fields that ARE questions, and this
 * comment is the record of why the other two are missing.
 */
const DISCORD_NO_UPLOADS: ApplicationForm = {
  ...DISCORD,
  fields: DISCORD.fields.filter((f) => f.kind !== "file"),
};

function fullyAnswered(): { answers: AnswerEntry[]; rules: PolicyRule[] } {
  const answers: AnswerEntry[] = [...IDENTITY];
  const rules: PolicyRule[] = [
    rule("work_authorization", { kind: "countries", value: ["united states"] }),
    rule("current_location", { kind: "countries", value: ["united states"] }),
  ];
  // Everything else Discord asks, from the person's own library — including the
  // EEO block, which only their own recorded answers can fill.
  for (const f of prepareApplication({
    form: DISCORD_NO_UPLOADS, answers, rules, companyKey: "", today: MONDAY,
  }).fields) {
    if (f.gap === null) continue;
    const src = DISCORD_NO_UPLOADS.fields.find((x) => x.name === f.name)!;
    const opt = src.options.find((o) => !o.declineToAnswer);
    answers.push(answer(f.label, opt ? opt.label : "n/a", { authoredBy: "user" }));
  }
  return { answers, rules };
}

describe("purity", () => {
  it("returns the same staging twice for the same inputs", () => {
    const once = stage(ANTHROPIC, { rules: [rule("relocation", yes)] });
    const twice = stage(ANTHROPIC, { rules: [rule("relocation", yes)] });
    expect(JSON.stringify(twice.fields)).toBe(JSON.stringify(once.fields));
  });

  it("does not mutate the form, answers or rules it was given", () => {
    const answers = [...IDENTITY];
    const rules = [rule("relocation", yes)];
    const snapshot = JSON.stringify({ form: ANTHROPIC, answers, rules });
    stage(ANTHROPIC, { answers, rules });
    expect(JSON.stringify({ form: ANTHROPIC, answers, rules })).toBe(snapshot);
  });
});
