import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `derive.ts` starts with `import "server-only"`, whose whole job is to throw
// when a client bundle reaches it. Stubbed so the module can be imported from a
// test at all — the same line `apply-board-source.test.ts` carries.
vi.mock("server-only", () => ({}));

const { deriveStagePackage } = await import("@/lib/apply/derive");
const { FixtureDataSource } = await import("@/lib/data/fixture-source");
const { FIXTURE_APPLICATIONS } = await import("@/lib/data/fixtures");
const { DEMO_BOARDS } = await import("@/lib/apply/demo-boards");
import type { BoardSource } from "@/lib/apply/board-source";
import type { ApplyLibrarySeed } from "@/lib/data/apply-fixtures";

/**
 * THE ANSWER SOURCES ARE DERIVED ON THE SERVER (#206, security review finding 2).
 *
 * The first version of `stageAutopilotAction` accepted the mapped package and
 * validated `answers[*].source` against the four-word vocabulary, so a browser
 * could assert `user_fact` on anything — the laundering shape the issue's
 * attack list names — while `persist.ts`, written to prevent it, had zero
 * production callers. These tests drive the seam that replaced it: the package
 * is re-derived from the user's own stored rows, and the client names only an
 * application.
 */

/** The board, without a network: `board-source.ts`'s own demo payloads. */
const boards: BoardSource = {
  async form(ref) {
    const payload = DEMO_BOARDS[`${ref.boardToken}/${ref.jobId}`];
    return payload
      ? { ok: true as const, payload }
      : { ok: false as const, reason: "not-found" as const, message: "no such job" };
  },
};

/** The Stripe fixture application — a real Greenhouse target in DEMO_BOARDS. */
const STRIPE_APP = FIXTURE_APPLICATIONS[0];

function sourceWith(library: ApplyLibrarySeed) {
  return new FixtureDataSource(
    undefined,
    FIXTURE_APPLICATIONS.map((a) => ({ ...a })),
    undefined,
    undefined,
    undefined,
    undefined,
    library,
  );
}

/**
 * The user's situation for Stripe's work-authorization knockout, at an
 * authorship.
 *
 * A POLICY RULE rather than a library answer, and that choice is the point.
 * `prepare.ts`'s layer 1 already refuses a library row on a sensitive field
 * unless it is server-stamped `user` AND matched on that exact question — so a
 * service-authored library row never becomes an answer for the mapper to
 * judge (asserted below as the defence in depth it is). Layer 2 has no such
 * gate: a rule answers from the situation whoever wrote it, which is precisely
 * the gap `persist.ts` closes.
 */
function workAuthLibrary(authoredBy: "user" | "service"): ApplyLibrarySeed {
  return {
    answers: [],
    rules: [
      {
        topic: "work_authorization",
        companyKey: "",
        fact: { kind: "countries", value: ["united states"] },
        provenance: authoredBy === "user" ? "user-entered" : "suggested",
        authoredBy,
      },
    ],
  };
}

describe("the package is derived from the user's own rows", () => {
  it("a user-authored row becomes user_fact on a knockout field", async () => {
    const src = sourceWith(workAuthLibrary("user"));
    const out = await deriveStagePackage(STRIPE_APP.id, { src, boards });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.package.answers.question_1001).toEqual({
      value: "1",
      source: "user_fact",
      kind: "work_authorization",
      sensitive: true,
    });
  });

  it("a SERVICE-authored rule on the same knockout field is refused, not laundered", async () => {
    // The engine stages this one — layer 2 reads the situation, not the
    // authorship — so the mapping seam is the gate, and the refusal is the
    // whole citation contract: a sensitive answer is only ever an explicit
    // user fact.
    const src = sourceWith(workAuthLibrary("service"));
    const out = await deriveStagePackage(STRIPE_APP.id, { src, boards });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("mapping");
    expect(out.message).toContain("question_1001");
    expect(out.message).toContain("not server-stamped user-authored");
    // The refusal never echoes the answer, the question text, or the company.
    expect(out.message).not.toContain("Yes");
    expect(out.message).not.toContain("legally authorized");
  });

  it("nothing a caller could send changes a source: the same application derives the same package", async () => {
    // The proof by construction — `deriveStagePackage` takes an application id
    // and NOTHING else about the content, so two calls that differ only in what
    // a client "wants" are the same call.
    const src = sourceWith(workAuthLibrary("user"));
    const a = await deriveStagePackage(STRIPE_APP.id, { src, boards });
    const b = await deriveStagePackage(STRIPE_APP.id, { src, boards });
    expect(a).toEqual(b);
  });

  it("every derived source is constant or user_fact — the two unreachable layers stay unreachable", async () => {
    const src = sourceWith(workAuthLibrary("user"));
    const out = await deriveStagePackage(STRIPE_APP.id, { src, boards });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const sources = Object.values(out.package.answers).map((a) => a.source);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) expect(["constant", "user_fact"]).toContain(s);
    // No inference hook is supplied, so layer 3 cannot have run.
    expect(sources).not.toContain("resume_evidence");
    expect(sources).not.toContain("drafted");
  });

  it("a service-authored LIBRARY row never even reaches the mapper — the engine gaps it", async () => {
    // Defence in depth, and the reason the refusal above had to be driven
    // through a rule: `stageFromLibrary` requires `authoredBy === "user"` and
    // an exact question-key match before it will reuse a stored answer on a
    // sensitive field, so this row is not an answer at all.
    const src = sourceWith({
      answers: [
        {
          question: "Are you legally authorized to work in the United States?",
          answer: "Yes",
          kind: "auth",
          provenance: "user-entered",
          authoredBy: "service",
        },
      ],
      rules: [],
    });
    const out = await deriveStagePackage(STRIPE_APP.id, { src, boards });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.package.answers.question_1001).toBeUndefined();
    expect(out.package.gaps.some((g) => g.fieldId === "question_1001")).toBe(true);
  });

  it("gaps come through, including the attachment gap no board escapes", async () => {
    const src = sourceWith(workAuthLibrary("user"));
    const out = await deriveStagePackage(STRIPE_APP.id, { src, boards });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const byField = new Map(out.package.gaps.map((g) => [g.fieldId, g]));
    expect(byField.get("resume")?.reason).toBe("attachment");
    // A knockout with no stored answer and no rule is the case the metric is
    // about: staged as a gap, never guessed.
    expect(byField.get("question_1002")?.reason).toBe("policy-unset");
  });
});

describe("the refusals a caller can act on", () => {
  it("an application that is not this user's is missing, not an error page", async () => {
    const src = sourceWith(workAuthLibrary("user"));
    const out = await deriveStagePackage(999_999, { src, boards });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("missing");
  });

  it("a non-Greenhouse row is not-preparable", async () => {
    const src = sourceWith(workAuthLibrary("user"));
    // Application 2 is an Ashby posting in the fixtures.
    const ashby = FIXTURE_APPLICATIONS.find((a) => a.postingKey?.startsWith("ashby"));
    expect(ashby).toBeDefined();
    const out = await deriveStagePackage(ashby!.id, { src, boards });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("not-preparable");
  });

  it("a board that does not answer is a fetch refusal, and stages nothing", async () => {
    const src = sourceWith(workAuthLibrary("user"));
    const silent: BoardSource = {
      async form() {
        return { ok: false, reason: "timeout", message: "The board did not answer in time." };
      },
    };
    const out = await deriveStagePackage(STRIPE_APP.id, { src, boards: silent });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("fetch");
  });
});

describe("the write path takes no content from the wire", () => {
  const SRC = readFileSync(join(process.cwd(), "lib", "apply", "actions.ts"), "utf8");
  const inputType =
    /export type StageAutopilotActionInput = \{[\s\S]*?\n\};/.exec(SRC)?.[0] ?? "";
  const body =
    /export async function stageAutopilotAction\([\s\S]*?\n\}/.exec(SRC)?.[0] ?? "";

  it("the parsers found the real declarations", () => {
    expect(inputType).toContain("applicationId");
    expect(body).toContain("src.stageAutopilot");
  });

  it("the action's input carries no package, answers, payload, gaps or source", () => {
    // MUTATION REASON: re-adding `package: StagePackage` to the input is exactly
    // the shape the security review rejected, and it would turn this red.
    for (const forbidden of ["package", "answers", "payload", "gaps", "source"]) {
      expect(
        inputType.includes(`${forbidden}:`),
        `StageAutopilotActionInput declares ${forbidden} — the client must not supply content`,
      ).toBe(false);
    }
  });

  it("every content field the command receives comes from the derived package", () => {
    for (const field of ["payload", "answers", "gaps"]) {
      expect(body).toContain(`${field}: derived.package.${field}`);
      expect(body).not.toContain(`${field}: input.${field}`);
    }
    expect(body).toContain("deriveStagePackage(input.applicationId");
  });

  it("the attachment choice is still the caller's, because the database re-checks it", () => {
    // Ownership and checksum are verified by `hq_autopilot_package_guard`, so a
    // forged entry can only name a file this user already owns, unchanged.
    expect(body).toContain("attachments: input.attachments");
  });
});
