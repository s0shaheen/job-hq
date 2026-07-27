import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasNoQuestionKey, questionKey } from "@/lib/apply/normalize";

/**
 * The TypeScript half of the two-language question-key contract.
 *
 * `public.hq_question_key(text)` in migration 0014 owns the stored column every
 * library answer is addressed by; this port computes the same key inside a page
 * render so the prepare engine can ask "is this question already answered?"
 * without a round trip.
 *
 * Both sides assert against ONE recorded file,
 * `tests/fixtures/question-keys.golden.json`, whose keys came out of Postgres
 * and were never hand-typed. `tests/db/test_apply.py` is the other half. Edit
 * one implementation without the other and exactly one language goes red.
 *
 * The fixture is at the REPO root rather than under `webapp/`, deliberately:
 * neither side owns it, and a case can be added from either language.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

interface GoldenCase {
  why: string;
  label: string;
  /** What Postgres produces. */
  key: string;
  /**
   * Present only where the two languages genuinely disagree. Recording the
   * divergence beats asserting an agreement that does not exist — and
   * `tests/db/test_apply.py` asserts the list is exactly one case long, so a
   * second one cannot be added without somebody deciding it should be.
   */
  jsKey?: string;
}

const GOLDEN: GoldenCase[] = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "question-keys.golden.json"), "utf8"),
);

describe("questionKey — the golden fixture Postgres recorded", () => {
  it("has cases, so the loop below is not vacuous", () => {
    expect(GOLDEN.length).toBeGreaterThan(20);
  });

  for (const c of GOLDEN) {
    it(c.why.slice(0, 90), () => {
      expect(questionKey(c.label)).toBe(c.jsKey ?? c.key);
    });
  }

  it("has exactly one recorded divergence, and it is the U+0130 one", () => {
    // A divergence list that grows quietly is a drift guard that stopped
    // guarding. Asserted from both languages — `test_the_recorded_divergence_is_exactly_one_case`
    // is the other half.
    const diverging = GOLDEN.filter((c) => c.jsKey !== undefined);
    expect(diverging.map((c) => c.label)).toEqual(["İstanbul office preference"]);
    expect(diverging[0].jsKey).not.toBe(diverging[0].key);
  });
});

describe("the direction the normalizer errs in", () => {
  /**
   * The design claim of the whole matching layer, asserted rather than
   * asserted-in-a-comment: it may fail to merge two spellings of one question,
   * and it may never merge two different questions.
   */
  it("merges spellings that differ only in case, spacing and punctuation", () => {
    const same = [
      "Are you legally authorized to work?",
      "ARE YOU LEGALLY AUTHORIZED TO WORK",
      "  are   you legally authorized to work!!  ",
      "Are you legally authorized to work…",
    ];
    const keys = new Set(same.map(questionKey));
    expect(keys.size).toBe(1);
  });

  it("does NOT merge questions that differ in a word", () => {
    // The near-miss pair from the recorded boards: Discord asks both of these
    // on one form, and answering the second with the first's answer is a wrong
    // knockout.
    expect(questionKey("Are you legally authorized to work in the United States for our Company?"))
      .not.toBe(questionKey("Are you currently located in the US?"));
    // And a negation, which is the difference that matters most and reads the
    // least: one word, opposite meaning.
    expect(questionKey("Do you require visa sponsorship?"))
      .not.toBe(questionKey("Do you not require visa sponsorship?"));
  });

  it("keeps two hyphenation styles of one word apart, on purpose", () => {
    // Deleting the hyphen would merge these. Merging is the direction that
    // costs a wrong answer, so the hyphen becomes a space and the cost is a
    // duplicate library row instead.
    expect(questionKey("e-mail")).toBe("e mail");
    expect(questionKey("email")).toBe("email");
    expect(questionKey("e-mail")).not.toBe(questionKey("email"));
  });
});

describe("emptiness", () => {
  it("is the same nothing however it is spelled", () => {
    for (const label of ["", "   ", "\n\t", "???", "— —", " ​"]) {
      expect(questionKey(label)).toBe("");
      expect(hasNoQuestionKey(label)).toBe(true);
    }
  });

  it("survives null and undefined without inventing a key", () => {
    expect(questionKey(null)).toBe("");
    expect(questionKey(undefined)).toBe("");
    expect(hasNoQuestionKey(null)).toBe(true);
  });

  it("does not report a real label as empty", () => {
    expect(hasNoQuestionKey("Phone")).toBe(false);
  });
});
