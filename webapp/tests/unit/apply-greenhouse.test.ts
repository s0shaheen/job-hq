import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANONICAL_FIELDS, parseGreenhouseForm } from "@/lib/apply/greenhouse";

/**
 * The Greenhouse question-schema parser, against three REAL boards.
 *
 * The fixtures in `webapp/tests/fixtures/greenhouse/` were fetched once (GET
 * only, 2026-07-27) and are the ATS as far as this suite is concerned. Nothing
 * here goes to the network: a live GET would make CI depend on three companies'
 * hiring calendars, and a suite that goes red because Coinbase filled a role is
 * a suite people learn to ignore.
 *
 * The assertions are deliberately about SHAPES the resolver depends on, not
 * about counts that a board can change by editing one question. Where a count
 * IS asserted it is because the number is the point — 19 questions on Coinbase
 * is the figure `docs/research/ats-apply-mechanics.md` recorded.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures", "greenhouse");

function board(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

const COINBASE = board("coinbase-7822885");
const ANTHROPIC = board("anthropic-5101378008");
const DISCORD = board("discord-8485797002");

describe("parseGreenhouseForm — the three recorded boards", () => {
  it("reads Coinbase's 19 questions into named fields", () => {
    const form = parseGreenhouseForm(COINBASE);
    expect(form.ats).toBe("greenhouse");
    expect(form.jobId).toBe("7822885");
    expect(form.company).toBe("Coinbase");

    const names = form.fields.map((f) => f.name);
    // Every name is unique: the submit harness addresses fields by name, and a
    // duplicate would make one of them unreachable.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("first_name");
    expect(names).toContain("question_65684137"); // work authorization
  });

  it("folds every ATS type it meets into a known kind", () => {
    // The fail-loud promise, from the positive direction: across 52 real fields
    // on three boards, nothing lands on `unknown`. If a board ships a new type
    // this goes red, which is the news.
    for (const payload of [COINBASE, ANTHROPIC, DISCORD]) {
      const form = parseGreenhouseForm(payload);
      const unknown = form.fields.filter((f) => f.kind === "unknown");
      expect(unknown.map((f) => `${f.name}:${f.rawType}`)).toEqual([]);
    }
  });

  it("keeps one question's two fields together", () => {
    const form = parseGreenhouseForm(COINBASE);
    const resume = form.fields.find((f) => f.name === "resume")!;
    const resumeText = form.fields.find((f) => f.name === "resume_text")!;
    expect(resume.kind).toBe("file");
    expect(resumeText.kind).toBe("textarea");
    // Satisfying either satisfies the question, so each has to be able to see
    // the other.
    expect(resume.siblings).toEqual(["resume_text"]);
    expect(resumeText.siblings).toEqual(["resume"]);
    expect(resume.label).toBe(resumeText.label);
  });

  it("carries select options with their labels", () => {
    const form = parseGreenhouseForm(COINBASE);
    const auth = form.fields.find((f) => f.name === "question_65684137")!;
    expect(auth.kind).toBe("select");
    expect(auth.required).toBe(true);
    expect(auth.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    // The value is what a submission sends; the label is what a rule matches on.
    expect(auth.options.every((o) => o.value !== "")).toBe(true);
  });

  it("reads the location questions, hidden geocodes included", () => {
    const form = parseGreenhouseForm(COINBASE);
    const hidden = form.fields.filter((f) => f.kind === "hidden").map((f) => f.name);
    expect(hidden.sort()).toEqual(["latitude", "longitude"]);
    // Kept, not dropped: the submit harness needs to know they exist. They are
    // excluded from coverage instead — see the prepare tests.
    expect(form.fields.some((f) => f.name === "location")).toBe(true);
  });

  it("reads Discord's EEO block and marks every field as self-identification", () => {
    const form = parseGreenhouseForm(DISCORD);
    const selfId = form.fields.filter((f) => f.selfIdentification);
    expect(selfId.length).toBeGreaterThan(0);
    expect(selfId.map((f) => f.label)).toContain("Gender");
    expect(selfId.every((f) => f.name.startsWith("demographic_"))).toBe(true);
    // "I don't wish to answer" is carried so the review surface can OFFER it.
    // Nothing else may pick it: choosing to decline is still a choice, and the
    // prepare tests assert nothing does.
    const gender = selfId.find((f) => f.label === "Gender")!;
    expect(gender.options.some((o) => o.declineToAnswer === true)).toBe(true);
  });

  it("does not mark ordinary questions as self-identification", () => {
    // The positive control for the flag: without it, "every EEO field is
    // flagged" would also pass on a parser that flagged everything.
    const form = parseGreenhouseForm(DISCORD);
    const ordinary = form.fields.filter((f) => !f.name.startsWith("demographic_"));
    expect(ordinary.length).toBeGreaterThan(10);
    expect(ordinary.every((f) => f.selfIdentification === false)).toBe(true);
  });

  it("carries absolute_url verbatim, which is NOT always a greenhouse.io page", () => {
    /**
     * Found by asserting the wrong thing first. Two of the three boards answer
     * a `job-boards.greenhouse.io` URL; Coinbase answers its OWN careers
     * wrapper, `www.coinbase.com/careers/positions/…?gh_jid=…`, which
     * `ats-apply-mechanics.md` separately records as sitting behind Cloudflare
     * (403 to curl) while the greenhouse.io-hosted page serves 200.
     *
     * So the submit tier cannot derive its target from `absolute_url` — it has
     * to build the hosted-form URL from the board token and job id. Pinned here
     * because the assumption is cheap to make and expensive to discover in a
     * browser harness.
     */
    expect(parseGreenhouseForm(ANTHROPIC).url).toContain("job-boards.greenhouse.io");
    expect(parseGreenhouseForm(DISCORD).url).toContain("job-boards.greenhouse.io");
    expect(parseGreenhouseForm(COINBASE).url).toContain("www.coinbase.com");
  });

  it("leaves unsupportedBlocks empty when compliance is null", () => {
    for (const payload of [COINBASE, ANTHROPIC, DISCORD]) {
      expect(parseGreenhouseForm(payload).unsupportedBlocks).toEqual([]);
    }
  });

  it("emits no consent field when no consent is required", () => {
    // All three boards return `data_compliance: [{type: 'gdpr', requires_*: false}]`.
    // A parser that emitted a consent gap for the mere PRESENCE of the block
    // would block every Greenhouse application on this planet.
    for (const payload of [COINBASE, ANTHROPIC, DISCORD]) {
      const form = parseGreenhouseForm(payload);
      expect(form.fields.filter((f) => f.rawType === "data_compliance")).toEqual([]);
    }
  });
});

describe("parseGreenhouseForm — fail loud", () => {
  it("refuses a payload that is not an object", () => {
    for (const bad of [null, undefined, 42, "job", [] as unknown]) {
      expect(() => parseGreenhouseForm(bad)).toThrow(/not an object|no job id/);
    }
  });

  it("refuses an error envelope rather than staging an empty form", () => {
    // What `boards-api.greenhouse.io` actually answers for a closed posting.
    expect(() => parseGreenhouseForm({ error: "Not found" })).toThrow(/no job id/);
  });

  it("refuses a job fetched WITHOUT ?questions=true", () => {
    // The mistake a caller is most likely to make: the same endpoint minus the
    // parameter returns the same shape with no `questions` key. Staging THAT
    // gives an application with nothing to ask, which would read as ready.
    const { questions: _dropped, ...withoutQuestions } = COINBASE as Record<string, unknown>;
    expect(() => parseGreenhouseForm(withoutQuestions)).toThrow(/\?questions=true/);
  });

  it("names an unknown field type instead of guessing it into a text box", () => {
    const mutant = {
      id: 1,
      questions: [
        {
          label: "Sign here",
          required: true,
          fields: [{ name: "signature_pad", type: "input_signature", values: [] }],
        },
      ],
    };
    const field = parseGreenhouseForm(mutant).fields[0];
    expect(field.kind).toBe("unknown");
    expect(field.rawType).toBe("input_signature");
  });

  it("flags a populated compliance block it has never seen the shape of", () => {
    const withCompliance = { ...(COINBASE as object), compliance: [{ type: "eeoc" }] };
    expect(parseGreenhouseForm(withCompliance).unsupportedBlocks).toEqual(["compliance"]);
  });

  it("flags a compliance block of ANY shape, scalars included", () => {
    /**
     * The first version tested `typeof x === "object"` for the non-array case,
     * and `typeof "something" === "object"` is false — so a string in this slot
     * was silently ignored by the detector whose whole job is failing loud. A
     * fail-loud check with a fail-open branch is worse than none, because it
     * reads as covered.
     */
    for (const compliance of ["something", 42, true, {}, { type: "eeoc" }, [{ q: 1 }]]) {
      expect(
        parseGreenhouseForm({ ...(COINBASE as object), compliance }).unsupportedBlocks,
        JSON.stringify(compliance),
      ).toEqual(["compliance"]);
    }
    // …and the two shapes that really are absent stay absent.
    for (const compliance of [null, undefined, []]) {
      expect(
        parseGreenhouseForm({ ...(COINBASE as object), compliance }).unsupportedBlocks,
        JSON.stringify(compliance ?? null),
      ).toEqual([]);
    }
  });

  it("refuses a form that declares one field name twice", () => {
    /**
     * `types.ts` claimed names are unique within a form and nothing enforced it.
     * The submit harness addresses fields BY NAME, so two questions sharing one
     * would have had whichever was written second silently win — with a
     * different answer.
     */
    expect(() =>
      parseGreenhouseForm({
        id: 1,
        questions: [
          { label: "A", required: true, fields: [{ name: "dup", type: "input_text" }] },
          { label: "B", required: true, fields: [{ name: "dup", type: "input_text" }] },
        ],
      }),
    ).toThrow(/declares field dup twice/);
  });

  it("does not refuse the real boards, which reuse no name", () => {
    // The positive control: without it, "duplicates throw" also passes on a
    // parser that throws on everything.
    for (const payload of [COINBASE, ANTHROPIC, DISCORD]) {
      expect(() => parseGreenhouseForm(payload)).not.toThrow();
    }
  });

  it("emits a consent GAP field when consent really is required", () => {
    const withConsent = {
      ...(COINBASE as object),
      data_compliance: [{ type: "gdpr", requires_consent: true }],
    };
    const consent = parseGreenhouseForm(withConsent).fields.find(
      (f) => f.rawType === "data_compliance",
    )!;
    expect(consent.required).toBe(true);
    expect(consent.label).toContain("requires_consent");
  });

  it("drops a field with no name rather than addressing it by index", () => {
    const mutant = {
      id: 1,
      questions: [{ label: "Nameless", required: true, fields: [{ type: "input_text" }] }],
    };
    expect(parseGreenhouseForm(mutant).fields).toEqual([]);
  });
});

describe("CANONICAL_FIELDS", () => {
  it("maps only ATS-stable names, never board-specific ones", () => {
    // `question_*` names are per-board and change when a recruiter edits the
    // form. Putting one here would bind the answer library to one posting.
    expect(Object.keys(CANONICAL_FIELDS).some((n) => n.startsWith("question_"))).toBe(false);
  });

  it("covers the identity fields every recorded board asks for", () => {
    const everywhere = ["first_name", "last_name", "email", "phone"];
    for (const payload of [COINBASE, ANTHROPIC, DISCORD]) {
      const names = new Set(parseGreenhouseForm(payload).fields.map((f) => f.name));
      for (const n of everywhere) {
        expect(names.has(n), `${n} missing from a board`).toBe(true);
        expect(CANONICAL_FIELDS[n], `${n} has no canonical question`).toBeTruthy();
      }
    }
  });
});
