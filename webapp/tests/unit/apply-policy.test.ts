import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGreenhouseForm } from "@/lib/apply/greenhouse";
import { questionKey } from "@/lib/apply/normalize";
import {
  classifyTopic,
  isConsentLabel,
  isKnockoutTopic,
  isSensitiveLabel,
  KNOCKOUT_TOPICS,
  POLICY_TOPICS,
  resolveQuestionCountry,
  STANDARD_TOPICS,
} from "@/lib/apply/policy";

/**
 * The classifier, pinned against every question three real boards ask AND
 * against the 59-phrasing corpus an adversarial review assembled.
 *
 * `tests/fixtures/policy-phrasings.json` is that review's evidence turned into a
 * committed artefact: its 12 knockout recall misses, its five polarity traps
 * (each of which produced a WRONG KNOCKOUT ANSWER on a card marked `ready`
 * before this redesign), the two conflict-of-interest near misses, and the
 * phrasings that must keep working. Every case carries one recorded verdict, so
 * a pattern edit that changes any of them goes red — which is the only way a
 * regexp table stays honest as it grows.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures");

function board(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, "greenhouse", `${name}.json`), "utf8"));
}

interface PhrasingCase {
  group: string;
  why: string;
  label: string;
  /** `"none"`, `"ambiguous:a+b"`, or `"<topic>/<polarity>"`. */
  verdict: string;
  sensitive: boolean;
  consent: boolean;
}

const PHRASINGS: PhrasingCase[] = JSON.parse(
  readFileSync(path.join(FIXTURES, "policy-phrasings.json"), "utf8"),
);

/** `topic/polarity`, `"none"`, or `"ambiguous:a+b"`. */
function verdict(label: string): string {
  const m = classifyTopic(label);
  if (m.kind === "none") return "none";
  if (m.kind === "topic") return `${m.topic}/${m.polarity}`;
  return `ambiguous:${[...m.topics].sort().join("+")}`;
}

/** Every distinct question label a board asks, in payload order. */
function labelsOf(payload: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of parseGreenhouseForm(payload).fields) {
    if (seen.has(f.label)) continue;
    seen.add(f.label);
    out.push(f.label);
  }
  return out;
}

// ═══════════════════════════════════════════ the review's 59-phrasing corpus

describe("the phrasing corpus", () => {
  it("is the size the review measured, and covers every group", () => {
    expect(PHRASINGS.length).toBeGreaterThanOrEqual(50);
    const groups = new Set(PHRASINGS.map((c) => c.group));
    for (const g of ["knockout-miss", "polarity-trap", "board", "near-miss", "consent", "answers"]) {
      expect(groups.has(g), `group ${g} missing`).toBe(true);
    }
  });

  for (const c of PHRASINGS) {
    it(`${c.group} · ${c.verdict} :: ${c.label.slice(0, 60).replace(/\s+/g, " ")}`, () => {
      expect(verdict(c.label)).toBe(c.verdict);
      expect(isSensitiveLabel(c.label)).toBe(c.sensitive);
      expect(isConsentLabel(c.label)).toBe(c.consent);
    });
  }
});

describe("the polarity traps that produced wrong knockout answers", () => {
  /**
   * Asserted separately from the corpus so deleting a corpus row cannot quietly
   * delete the guard. Each is a `rule -> question -> staged` triple the review
   * EXECUTED against the first design.
   */
  it("`without sponsorship` is the INVERTED reading, not the direct one", () => {
    expect(verdict("Are you able to work in the US without sponsorship, now or in the future?"))
      .toBe("visa_sponsorship/inverted");
    expect(verdict("Do you require visa sponsorship?")).toBe("visa_sponsorship/direct");
  });

  it("`do you require work authorization` is not read at all", () => {
    // PATTERNS matches `authorized`/`eligible`, not `authorization`, so this
    // never becomes an answer — and SENSITIVE catches it so it never becomes an
    // inference either.
    expect(verdict("Do you require work authorization to be employed here?")).toBe("none");
    expect(isSensitiveLabel("Do you require work authorization to be employed here?")).toBe(true);
  });

  it("a background-check CONSENT is its own topic, not a criminal disclosure", () => {
    expect(verdict("Are you willing to submit to a background check?"))
      .toBe("background_check_consent/direct");
    expect(verdict("Do you consent to a background check at the offer stage?"))
      .toBe("background_check_consent/direct");
    expect(verdict("Have you ever been convicted of a felony?")).toBe("criminal_history/direct");
  });

  it("relocation ASSISTANCE is a different fact than willingness, and is refused", () => {
    expect(verdict("Do you require relocation assistance?")).toBe("relocation/unanswerable");
    expect(verdict("Are you willing to relocate to New York?")).toBe("relocation/direct");
  });

  it("a CURRENT salary is refused, and an expected one is answered", () => {
    expect(verdict("What is your current salary?")).toBe("compensation/unanswerable");
    expect(verdict("What are your salary expectations?")).toBe("compensation/direct");
    // Both words present -> two classes -> uncertain, which also gaps.
    expect(verdict("What is your current salary expectation?")).toBe("compensation/uncertain");
  });
});

describe("polarity is `uncertain` unless exactly one class matches", () => {
  it("zero matches is uncertain, not direct", () => {
    // `criminal` classifies the topic; a bare noun phrase states no direction,
    // so it does not become an answer. This is the branch that separates "we
    // read the question" from "we recognised a word in it".
    expect(verdict("Criminal record disclosure")).toBe("criminal_history/uncertain");
  });

  it("two matches is uncertain, not a precedence order", () => {
    expect(verdict("Are you under 18 years of age?")).toBe("age_eligibility/uncertain");
  });

  it("and the ordinary phrasings of the same question are certain", () => {
    expect(verdict("Are you at least 18 years of age?")).toBe("age_eligibility/direct");
    expect(verdict("Are you under 18?")).toBe("age_eligibility/inverted");
  });
});

// ══════════════════════════════════════════════════════ the sensitive list

describe("SENSITIVE — the recall-tuned list layers 3 and 4 cannot see past", () => {
  it("covers every knockout phrasing the classifier misses", () => {
    /**
     * The review's finding, closed structurally: layer 3's knockout immunity WAS
     * the classifier's recall, which is circular. A label the classifier does not
     * read is now still refused to inference if it trips this list.
     */
    const missed = PHRASINGS.filter((c) => c.group === "knockout-miss" && c.verdict === "none");
    expect(missed.length).toBeGreaterThan(0);
    for (const c of missed) {
      expect(isSensitiveLabel(c.label), `not sensitive: ${c.label}`).toBe(true);
    }
  });

  it("covers every knockout topic's ordinary phrasing too", () => {
    for (const label of [
      "Are you legally authorized to work in the US?",
      "Do you require visa sponsorship?",
      "What are your salary expectations?",
      "Have you ever been convicted of a felony?",
      "Are you willing to submit to a background check?",
      "What is your full legal name?",
      "Are you at least 18 years of age?",
    ]) {
      expect(isSensitiveLabel(label), label).toBe(true);
    }
  });

  it("covers demographics, which are not a topic at all", () => {
    for (const label of [
      "Gender", "Race and Ethnicity", "Veteran Status", "Disability Status",
      "I consider myself a member of the LGBTQ+ community. (optional)",
    ]) {
      expect(isSensitiveLabel(label), label).toBe(true);
    }
  });

  it("does NOT swallow the ordinary fields — it is broad, not total", () => {
    // Without this the list could be `() => true`, which passes every assertion
    // above and turns the whole form into gaps.
    for (const label of [
      "First Name", "Website", "LinkedIn Profile", "Why Anthropic?",
      "How did you hear about this job?", "Preferred First Name",
    ]) {
      expect(isSensitiveLabel(label), label).toBe(false);
    }
  });
});

describe("CONSENT — an affordance, never an answer", () => {
  it("names the two required acknowledgements the boards actually ship", () => {
    expect(isConsentLabel("AI Policy for Application")).toBe(true);
    expect(isConsentLabel(
      "I understand that Coinbase may use AI tools to assist in the application and interview process.",
    )).toBe(true);
  });

  it("does not claim a background-check consent, which is a real topic", () => {
    // Topic wins in `prepare.ts` — asserted there — but the two must not be
    // confused here either, or a blanket "acknowledge → yes" rule would reach a
    // knockout question.
    expect(verdict("Do you consent to a background check at the offer stage?"))
      .toBe("background_check_consent/direct");
  });

  it("does not fire on ordinary fields", () => {
    for (const label of ["First Name", "Why Anthropic?", "Website"]) {
      expect(isConsentLabel(label), label).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════ the country question

describe("resolveQuestionCountry", () => {
  it("reads a named country", () => {
    expect(resolveQuestionCountry("Are you authorized to work in the United States?"))
      .toBe("united states");
    expect(resolveQuestionCountry("Do you have the right to work in Canada?")).toBe("canada");
    expect(resolveQuestionCountry("Are you currently located in the US?")).toBe("united states");
  });

  it("defers to the posting's country when the question does", () => {
    expect(resolveQuestionCountry(
      "Are you legally authorized to work in the country where this position is located?",
      "United States",
    )).toBe("united states");
  });

  it("answers null when the posting's country is unknown — never `assume the US`", () => {
    // That assumption is a wrong knockout answer for anybody applying from
    // anywhere else, which is most of the planet.
    expect(resolveQuestionCountry(
      "Are you legally authorized to work in the country where this position is located?",
    )).toBeNull();
  });

  it("answers null on a compound, because a list cannot answer `or`", () => {
    expect(resolveQuestionCountry("Are you authorized to work in the US or Canada?")).toBeNull();
  });

  it("answers null when no country is named at all", () => {
    expect(resolveQuestionCountry("Are you eligible to work without restriction?")).toBeNull();
    expect(resolveQuestionCountry("")).toBeNull();
  });
});

// ══════════════════════════════════════════════════ the boards, as a closed set

describe("every question three real boards ask", () => {
  it("is covered by the phrasing corpus or is a plain profile field", () => {
    /**
     * A closed set is only closed if it is CLOSED. A board refresh that adds a
     * question must not leave it unclassified and unnoticed (matrix row 92: a
     * drift guard that cannot see what it guards).
     *
     * `plain` is the fields no classifier should have an opinion about —
     * identity, uploads, the geocodes, and the EEO block, which is flagged from
     * the payload and never from label text.
     *
     * Compared on the NORMALIZED key, not the raw label. Two real Coinbase
     * labels defeat raw comparison and both are the reason `questionKey` exists:
     * the AI acknowledgement carries a trailing newline, and the vendor-referral
     * question carries a U+2011 non-breaking hyphen mid-word.
     */
    const known = new Set(PHRASINGS.map((c) => questionKey(c.label)));
    const plain = new Set([
      "First Name", "Last Name", "Preferred First Name", "Email", "Phone", "Resume/CV",
      "Cover Letter", "Linkedin Profile URL", "Longitude", "Latitude", "Location",
      "Please upload proof of certification or licensure:",
      "Which of the following best describes how you use AI tools today?",
      "Are you a current government official or were you a government official in the last five years (e.g., employee of a government agency or a government owned/controlled company, holder of public office or a civil service position)?",
      "To your knowledge, do you or a close relative currently hold a role, have a significant financial interest in, or maintain a close personal relationship with a senior leader at a company connected to Coinbase that could create an actual or perceived conflict of interest?",
      "(Optional) Personal Preferences",
      "Do you have any deadlines or timeline considerations we should be aware of?",
      "Additional Information", "Why do you want to work at Discord?",
      "Gender", "Race and Ethnicity", "Veteran Status", "Disability Status",
      "Gender Identity (optional)", "Race or Ethnicity (optional)",
      "I consider myself a member of the LGBTQ+ community. (optional)",
    ].map(questionKey));
    const missing: string[] = [];
    for (const name of ["coinbase-7822885", "anthropic-5101378008", "discord-8485797002"]) {
      for (const label of labelsOf(board(name))) {
        const key = questionKey(label);
        if (!known.has(key) && !plain.has(key)) missing.push(`${name}: ${label}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("classifies a minority of them, which is the design", () => {
    // If this ever inverts, the patterns have gone greedy.
    const labels = ["coinbase-7822885", "anthropic-5101378008", "discord-8485797002"]
      .flatMap((n) => labelsOf(board(n)));
    const classified = labels.filter((l) => verdict(l) !== "none").length;
    expect(classified).toBeGreaterThan(8);
    expect(classified).toBeLessThan(labels.length / 2);
  });

  it("keeps both Coinbase conflict-of-interest traps as gaps", () => {
    expect(verdict("Are you a close relative of a government official?")).toBe("none");
    expect(verdict("Were you referred to this position by a vendor of Coinbase?")).toBe("none");
    // …and the real questions still read, so the patterns are not simply dead.
    expect(verdict("Do you have any relatives who work at Coinbase?"))
      .toBe("relative_at_company/direct");
    expect(verdict("Were you referred by a Coinbase employee?")).toBe("employee_referral/direct");
  });
});

describe("the topic sets", () => {
  it("has no duplicates and no overlap between the two halves", () => {
    expect(new Set(POLICY_TOPICS).size).toBe(POLICY_TOPICS.length);
    const knock = new Set<string>(KNOCKOUT_TOPICS);
    expect(STANDARD_TOPICS.some((t) => knock.has(t))).toBe(false);
  });

  it("names exactly the seven topics whose wrong answer ends an application", () => {
    // Duplicated literally rather than derived, so a topic cannot be moved into
    // or out of the knockout half without this line being edited on purpose.
    expect([...KNOCKOUT_TOPICS]).toEqual([
      "work_authorization",
      "visa_sponsorship",
      "compensation",
      "criminal_history",
      "background_check_consent",
      "legal_name",
      "age_eligibility",
    ]);
    for (const t of KNOCKOUT_TOPICS) expect(isKnockoutTopic(t)).toBe(true);
    for (const t of STANDARD_TOPICS) expect(isKnockoutTopic(t)).toBe(false);
  });

  it("does not treat an unknown string as a knockout", () => {
    expect(isKnockoutTopic("work_auth")).toBe(false);
    expect(isKnockoutTopic("")).toBe(false);
  });

  it("classifies only into the closed set", () => {
    const allowed = new Set<string>(POLICY_TOPICS);
    for (const c of PHRASINGS) {
      const m = classifyTopic(c.label);
      if (m.kind === "topic") expect(allowed.has(m.topic)).toBe(true);
      if (m.kind === "ambiguous") for (const t of m.topics) expect(allowed.has(t)).toBe(true);
    }
  });

  it("answers `none` for empty and unparseable labels", () => {
    for (const label of ["", "   ", "???", null, undefined]) {
      expect(classifyTopic(label)).toEqual({ kind: "none" });
      expect(isSensitiveLabel(label)).toBe(false);
      expect(isConsentLabel(label)).toBe(false);
    }
  });
});
