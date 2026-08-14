import { describe, expect, it } from "vitest";
import {
  engineAnswers,
  engineRules,
  parseSituationFact,
  readAuthoredBy,
  readProvenance,
  toAnswerView,
  toPolicyRuleView,
} from "@/lib/apply/views";

/**
 * The seam between a stored row and the two things that read it: a screen, and
 * the engine.
 *
 * Everything asserted here is about what happens to a row this build does not
 * fully understand. Both defaults run toward refusal — an unreadable provenance
 * is `suggested` (a human is asked to look) and an unreadable authorship is
 * `service` (every sensitive gate refuses it) — because the alternative is a row
 * becoming the most trusted kind of row by being unreadable.
 */
describe("reading a stored row", () => {
  it("defaults an unknown provenance to the one that asks for a human", () => {
    expect(readProvenance("user-entered")).toBe("user-entered");
    expect(readProvenance("confirmed")).toBe("confirmed");
    expect(readProvenance("suggested")).toBe("suggested");
    // A value 0014's CHECK does not allow, a future one it might, and no value.
    expect(readProvenance("imported")).toBe("suggested");
    expect(readProvenance(undefined)).toBe("suggested");
    expect(readProvenance(7)).toBe("suggested");
  });

  it("defaults an unknown authorship to `service`, which every gate refuses", () => {
    expect(readAuthoredBy("user")).toBe("user");
    expect(readAuthoredBy("service")).toBe("service");
    expect(readAuthoredBy("USER")).toBe("service");
    expect(readAuthoredBy(undefined)).toBe("service");
    expect(readAuthoredBy(null)).toBe("service");
  });

  it("maps a PostgREST row without inventing a key", () => {
    const view = toAnswerView({
      question: "Are you 18 years of age or older?",
      question_key: "are you 18 years of age or older",
      answer: "Yes",
      kind: "auth",
      provenance: "user-entered",
      authored_by: "user",
      confirmed_at: null,
      updated_at: "2026-07-21T00:00:00.000Z",
    });
    expect(view.questionKey).toBe("are you 18 years of age or older");
    expect(view.confirmedAt).toBeNull();
    expect(view.updatedAt).toBe("2026-07-21T00:00:00.000Z");
    // A row that arrived WITHOUT the generated column keeps an empty key rather
    // than growing one here: `prepare.ts` recomputes when it is absent, and a key
    // computed in two places is two places to disagree.
    expect(toAnswerView({ question: "Email", answer: "a@b.c" }).questionKey).toBe("");
    // "" is absence, not a value — the same rule `str()` follows in the Supabase
    // mapper, so a never-written timestamp does not read as an instant.
    expect(toAnswerView({ question: "Email", updated_at: "" }).updatedAt).toBeNull();
  });

  it("hands the engine `authored_by`, the stored key and the SCOPE, unchanged", () => {
    const entries = engineAnswers([
      {
        question: "Will you now or in the future require visa sponsorship?",
        questionKey: "will you now or in the future require visa sponsorship",
        companyKey: "stripe",
        answer: "No",
        declined: false,
        kind: "auth",
        provenance: "suggested",
        authoredBy: "service",
        confirmedAt: null,
        updatedAt: null,
      },
    ]);
    expect(entries[0].authoredBy).toBe("service");
    expect(entries[0].questionKey).toBe("will you now or in the future require visa sponsorship");
    // 0017's column. Dropping it from this mapper makes every scoped row read as
    // global — the bug in the other direction, and one nothing else would catch.
    expect(entries[0].companyKey).toBe("stripe");
  });

  it("reads the scope and the decline flag off a database row", () => {
    const scoped = toAnswerView({
      question: "Have you previously been employed by Stripe?",
      company_key: "stripe",
      answer: "Yes",
      declined: false,
      kind: "freeform",
    });
    expect(scoped.companyKey).toBe("stripe");
    expect(scoped.declined).toBe(false);
    // Absent reads as global and as not-a-decline: every row written before 0017
    // meant exactly that, and anything that is not literally `true` must not
    // become the one kind of row that selects an option no layer may.
    const old = toAnswerView({ question: "Email", answer: "a@b.c" });
    expect(old.companyKey).toBe("");
    expect(old.declined).toBe(false);
    expect(toAnswerView({ question: "Gender", answer: "x", declined: "true" }).declined).toBe(false);
    expect(toAnswerView({ question: "Gender", answer: "x", declined: true }).declined).toBe(true);
  });
});

describe("reading a stored fact", () => {
  it("accepts every kind the engine implements", () => {
    expect(parseSituationFact({ kind: "boolean", value: false })).toEqual({
      kind: "boolean",
      value: false,
    });
    // …and zero is NOT one of them. A "pay expectation" of nothing derives the
    // literal answer "0" onto a compensation field, and clearing the box in the
    // settings control is how somebody would get there (`parseDollars("")` is 0).
    // SQL allows it (`>= 0`); this side is the stricter one, the same direction
    // `countries` and `date` already run in.
    expect(parseSituationFact({ kind: "money", value: 0 })).toBeNull();
    expect(parseSituationFact({ kind: "money", value: -1 })).toBeNull();
    expect(parseSituationFact({ kind: "money", value: 150000.5 })).toBeNull();
    // `String(1e21)` is "1e+21" — a machine token on a knockout field. Refused
    // six orders of magnitude before JavaScript would switch notation.
    expect(parseSituationFact({ kind: "money", value: 1e21 })).toBeNull();
    expect(parseSituationFact({ kind: "money", value: 1_000_000_000 })).not.toBeNull();
    expect(parseSituationFact({ kind: "money", value: 150000, currency: "USD" })).toEqual({
      kind: "money",
      value: 150000,
      currency: "USD",
    });
    expect(parseSituationFact({ kind: "directive", value: "monday-weeks-out:3" })).not.toBeNull();
    expect(parseSituationFact({ kind: "countries", value: ["united states", "canada"] })).not.toBeNull();
  });

  it("refuses the shapes that would become a guess", () => {
    // Each of these is legal jsonb and several are legal to 0014's CHECK. The
    // engine cannot answer from any of them, and the honest outcome is a rule
    // nobody can read rather than a value nobody can check.
    expect(parseSituationFact(null)).toBeNull();
    expect(parseSituationFact("Yes")).toBeNull();
    expect(parseSituationFact([{ kind: "boolean", value: true }])).toBeNull();
    expect(parseSituationFact({ value: true })).toBeNull();
    expect(parseSituationFact({ kind: "boolean" })).toBeNull();
    expect(parseSituationFact({ kind: "boolean", value: "true" })).toBeNull();
    expect(parseSituationFact({ kind: "money", value: -1 })).toBeNull();
    expect(parseSituationFact({ kind: "money", value: "150000" })).toBeNull();
    expect(parseSituationFact({ kind: "countries", value: [] })).toBeNull();
    expect(parseSituationFact({ kind: "countries", value: ["  "] })).toBeNull();
    expect(parseSituationFact({ kind: "text", value: "\n\t" })).toBeNull();
    expect(parseSituationFact({ kind: "date", value: "17/08/2026" })).toBeNull();
    expect(parseSituationFact({ kind: "enum", value: "None" })).toBeNull();
    expect(parseSituationFact({ kind: "directive", value: "Monday Weeks Out: 3" })).toBeNull();
    expect(parseSituationFact({ kind: "phrase-bank", value: ["a recruiter"] })).toBeNull();
  });

  it("keeps an unreadable rule off the engine's input entirely", () => {
    const rules = [
      {
        topic: "how_did_you_hear",
        companyKey: "",
        fact: null,
        provenance: "suggested" as const,
        authoredBy: "service" as const,
        note: "",
        enabled: true,
        updatedAt: null,
      },
      {
        topic: "relocation",
        companyKey: "",
        fact: { kind: "boolean" as const, value: true },
        provenance: "user-entered" as const,
        authoredBy: "user" as const,
        note: "",
        enabled: true,
        updatedAt: null,
      },
    ];
    expect(engineRules(rules).map((r) => r.topic)).toEqual(["relocation"]);
    // And a DISABLED rule is passed through with its flag rather than filtered
    // here: `prepare.ts` owns that decision (a disabled company override has to
    // fall back to the global rule, which this layer cannot see).
    const disabled = engineRules([{ ...rules[1], enabled: false }]);
    expect(disabled).toHaveLength(1);
    expect(disabled[0].enabled).toBe(false);
  });

  it("maps a rule row and keeps the unreadable half visible to a screen", () => {
    const view = toPolicyRuleView({
      topic: "how_did_you_hear",
      company_key: "",
      fact: { kind: "phrase-bank", value: ["a recruiter"] },
      provenance: "suggested",
      authored_by: "service",
      note: "",
      enabled: true,
      updated_at: "2026-07-21T00:00:00.000Z",
    });
    // The row is real, its version token is real, and its fact is null — which is
    // what lets the settings surface say "we cannot read this" beside a rule that
    // still exists, rather than dropping it and leaving a person wondering.
    expect(view.topic).toBe("how_did_you_hear");
    expect(view.updatedAt).toBe("2026-07-21T00:00:00.000Z");
    expect(view.fact).toBeNull();
  });
});
