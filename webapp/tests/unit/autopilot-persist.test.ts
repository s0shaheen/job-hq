import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_ANSWER_SOURCES,
  AutopilotMappingError,
  TOPIC_TO_ANSWER_KIND,
  toStagePackage,
} from "@/lib/apply/persist";
import { prepareApplication } from "@/lib/apply/prepare";
import { KNOCKOUT_TOPICS } from "@/lib/apply/policy";
import type {
  AnswerEntry,
  ApplicationForm,
  FormField,
  PolicyRule,
  StagedApplication,
} from "@/lib/apply/types";

/**
 * The persistence seam (#206): the engine's `constant | policy | inference`
 * vocabulary mapped onto the database's `hq_autopilot_answer_sources()` —
 * `user_fact` gated on the SERVER-stamped `authoredBy`, never on the caller's
 * `provenance` claim, and the two unreachable sources never emitted.
 *
 * The staged inputs are produced by the REAL `prepareApplication`, not by hand,
 * so the source tokens the mapper parses are the tokens the engine writes —
 * a hand-built `StagedField` would pin this suite to a spelling the engine
 * could drift from silently.
 */

function field(partial: Partial<FormField> & Pick<FormField, "name" | "label">): FormField {
  return {
    kind: "text",
    required: true,
    options: [],
    siblings: [],
    selfIdentification: false,
    rawType: "input_text",
    ...partial,
  };
}

function form(fields: FormField[]): ApplicationForm {
  return {
    ats: "greenhouse",
    jobId: "4001",
    company: "Acme",
    title: "Product Manager",
    url: "https://boards.greenhouse.io/acme/jobs/4001",
    fields,
    unsupportedBlocks: [],
  };
}

const YES_NO = [
  { label: "Yes", value: "1" },
  { label: "No", value: "0" },
];

const userAnswer = (question: string, answer: string, extra: Partial<AnswerEntry> = {}): AnswerEntry => ({
  question,
  answer,
  kind: "identity",
  provenance: "user-entered",
  authoredBy: "user",
  ...extra,
});

const workAuthField = field({
  name: "question_1",
  label: "Are you legally authorized to work in the United States?",
  kind: "select",
  options: YES_NO,
});

const workAuthRule = (authoredBy: "user" | "service"): PolicyRule => ({
  topic: "work_authorization",
  companyKey: "",
  fact: { kind: "countries", value: ["united states"] },
  provenance: authoredBy === "user" ? "user-entered" : "suggested",
  authoredBy,
  enabled: true,
});

describe("the answer-source mapping", () => {
  it("a user-authored library answer becomes user_fact", () => {
    const staged = prepareApplication({
      form: form([field({ name: "nickname", label: "Preferred name" })]),
      answers: [userAnswer("Preferred name", "Sam")],
      rules: [],
    });
    const pkg = toStagePackage(staged, {
      answers: [userAnswer("Preferred name", "Sam")],
      rules: [],
    });
    expect(pkg.answers.nickname).toEqual({ value: "Sam", source: "user_fact" });
    expect(pkg.payload.nickname).toBe("Sam");
  });

  it("a service-authored library answer becomes constant, never user_fact", () => {
    const entry = userAnswer("Preferred name", "Sam", { authoredBy: "service" });
    const staged = prepareApplication({
      form: form([field({ name: "nickname", label: "Preferred name" })]),
      answers: [entry],
      rules: [],
    });
    const pkg = toStagePackage(staged, { answers: [entry], rules: [] });
    expect(pkg.answers.nickname.source).toBe("constant");
  });

  it("authoredBy ABSENT reads as service — the safe direction for an unknown writer", () => {
    const entry = userAnswer("Preferred name", "Sam");
    delete (entry as unknown as Record<string, unknown>).authoredBy;
    const staged = prepareApplication({
      form: form([field({ name: "nickname", label: "Preferred name" })]),
      answers: [entry],
      rules: [],
    });
    const pkg = toStagePackage(staged, { answers: [entry], rules: [] });
    expect(pkg.answers.nickname.source).toBe("constant");
  });

  it("a user-authored policy answer becomes user_fact, with the DB kind and the sensitive flag", () => {
    const rules = [workAuthRule("user")];
    const staged = prepareApplication({ form: form([workAuthField]), answers: [], rules });
    const pkg = toStagePackage(staged, { answers: [], rules });
    expect(pkg.answers.question_1).toEqual({
      // The option's VALUE, exactly as it would be submitted — not its label.
      value: "1",
      source: "user_fact",
      kind: "work_authorization",
      sensitive: true,
    });
  });

  it("a company-scoped answer and a company exception both resolve through their scoped tokens", () => {
    const scopedAnswer = userAnswer("Preferred name", "Sam A", { companyKey: "acme" });
    const scopedRule: PolicyRule = { ...workAuthRule("user"), companyKey: "acme" };
    const staged = prepareApplication({
      form: form([field({ name: "nickname", label: "Preferred name" }), workAuthField]),
      answers: [scopedAnswer],
      rules: [scopedRule],
      companyKey: "acme",
    });
    const pkg = toStagePackage(staged, {
      answers: [scopedAnswer],
      rules: [scopedRule],
      companyKey: "acme",
    });
    expect(pkg.answers.nickname.source).toBe("user_fact");
    expect(pkg.answers.question_1.source).toBe("user_fact");
  });

  it("REFUSES a sensitive answer whose backing row is not user-authored, naming the field and never the value", () => {
    const rules = [workAuthRule("service")];
    const staged = prepareApplication({ form: form([workAuthField]), answers: [], rules });
    // The engine staged it (the policy lane has no authoredBy gate); the SEAM
    // is where the citation contract bites, before the database's guard does.
    expect(staged.fields[0].answer).not.toBeNull();
    let thrown: unknown;
    try {
      toStagePackage(staged, { answers: [], rules });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AutopilotMappingError);
    const err = thrown as AutopilotMappingError;
    expect(err.fieldName).toBe("question_1");
    expect(err.message).toContain("question_1");
    // The most sensitive strings in the system never ride an exception.
    expect(err.message).not.toContain("Yes");
    expect(err.message).not.toContain('"1"');
  });

  it("REFUSES an inference-layer answer — layer 3 has no persistence lane in this half", () => {
    const staged = prepareApplication({
      form: form([field({ name: "years", label: "Years of TypeScript experience" })]),
      answers: [],
      rules: [],
      infer: () => ({ answer: "6", citation: "resume: 2019-2025" }),
    });
    expect(staged.fields[0].layer).toBe("inference");
    expect(() => toStagePackage(staged, { answers: [], rules: [] })).toThrow(
      AutopilotMappingError,
    );
  });

  it("REFUSES a token that resolves to no supplied row rather than defaulting", () => {
    const entry = userAnswer("Preferred name", "Sam");
    const staged = prepareApplication({
      form: form([field({ name: "nickname", label: "Preferred name" })]),
      answers: [entry],
      rules: [],
    });
    // The caller hands DIFFERENT arrays than the prepare ran with — the seam
    // must refuse to guess who authored the backing row.
    expect(() => toStagePackage(staged, { answers: [], rules: [] })).toThrow(
      AutopilotMappingError,
    );
  });
});

describe("what the package carries", () => {
  const library = [userAnswer("Preferred name", "Sam")];
  const fields = [
    field({ name: "nickname", label: "Preferred name" }),
    field({ name: "cover", label: "Why do you want to work here?", kind: "textarea" }),
    field({ name: "resume", label: "Resume/CV", kind: "file", rawType: "input_file" }),
  ];
  const staged = prepareApplication({ form: form(fields), answers: library, rules: [] });
  const pkg = toStagePackage(staged, { answers: library, rules: [] });

  it("gaps carry the field, its kind, the reason, and whether it blocks", () => {
    expect(pkg.gaps).toEqual([
      { fieldId: "cover", kind: "textarea", reason: "free-response", required: true },
      { fieldId: "resume", kind: "file", reason: "attachment", required: true },
    ]);
  });

  it("the payload holds exactly the answered fields", () => {
    expect(pkg.payload).toEqual({ nickname: "Sam" });
  });

  it("the form's identity comes through verbatim", () => {
    expect(pkg.provider).toBe("greenhouse");
    expect(pkg.formIdentity).toBe("4001");
    expect(pkg.providerVersion).toBe("");
    expect(pkg.formSchemaHash).toBe("");
  });

  it("a self-identification answer carries the eeo kind", () => {
    const gender = userAnswer("Gender", "Woman");
    const f = field({
      name: "gender",
      label: "Gender",
      kind: "select",
      selfIdentification: true,
      options: [
        { label: "Woman", value: "2" },
        { label: "I don't wish to answer", value: "9", declineToAnswer: true },
      ],
    });
    const s = prepareApplication({ form: form([f]), answers: [gender], rules: [] });
    const p = toStagePackage(s, { answers: [gender], rules: [] });
    expect(p.answers.gender).toEqual({
      value: "2",
      source: "user_fact",
      kind: "eeo",
      sensitive: true,
    });
  });
});

describe("the two vocabularies cannot drift", () => {
  it("every knockout topic maps to a database answer kind", () => {
    // A topic the database cannot name silently loses one of the three refusal
    // signals `hq_autopilot_package_guard` reads.
    for (const topic of KNOCKOUT_TOPICS) {
      expect(TOPIC_TO_ANSWER_KIND[topic], `no DB kind for knockout topic ${topic}`).toBeTruthy();
    }
  });

  it("every mapped kind is one of hq_autopilot_sensitive_answer_kinds()", () => {
    // The migration's closed set, restated here INDEPENDENTLY — a mapping to a
    // word the database does not recognise as sensitive would pass the guard
    // as an ordinary kind.
    const dbKinds = new Set([
      "work_authorization", "visa", "sponsorship", "eeo", "compensation",
      "legal_identity", "criminal_background", "security_clearance",
      "disability", "veteran_status",
    ]);
    for (const kind of Object.values(TOPIC_TO_ANSWER_KIND)) {
      expect(dbKinds.has(kind), `${kind} is not a DB sensitive kind`).toBe(true);
    }
  });

  it("the source vocabulary is the migration's, and this half can emit only half of it", () => {
    expect([...AUTOPILOT_ANSWER_SOURCES]).toEqual([
      "constant", "user_fact", "resume_evidence", "drafted",
    ]);
    // A structural sweep: everything the mapper can produce for a whole
    // prepared application is constant/user_fact — resume_evidence and drafted
    // have no producing layer in the manual-handoff half.
    const rules = [workAuthRule("user")];
    const library = [userAnswer("Preferred name", "Sam")];
    const staged: StagedApplication = prepareApplication({
      form: form([field({ name: "nickname", label: "Preferred name" }), workAuthField]),
      answers: library,
      rules,
    });
    const pkg = toStagePackage(staged, { answers: library, rules });
    for (const a of Object.values(pkg.answers)) {
      expect(["constant", "user_fact"]).toContain(a.source);
    }
  });
});
