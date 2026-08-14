"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import { blankTrim } from "@/lib/data/view-models";
import {
  isDemoMode,
  type AnswerWriteResult,
  type DeleteAnswerResult,
  type DeletePolicyResult,
  type PolicyWriteResult,
} from "@/lib/data/source";
import {
  type AutopilotAttachment,
  type AutopilotReviewResult,
  type AutopilotSettleResult,
  type AutopilotStageWriteResult,
} from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { deriveStagePackage } from "./derive";
import { POLICY_TOPICS } from "./policy";
import { isAnswerKind, parseSituationFact } from "./views";
import type { Provenance } from "./types";

/**
 * The three gestures the answer library has, and the door they come through.
 *
 * In `lib/` rather than beside one route, because two surfaces call them: the
 * settings editor, and the review screen where a gap is answered — which is the
 * growth loop and the reason the second application costs less than the first.
 * `lib/referral/actions.ts` is the precedent for a shared server-action module.
 *
 * Every validator here exists because **a server action is a public endpoint and
 * the input type is erased at runtime** (matrix row 38). The closed sets are
 * checked twice on purpose — here and in Postgres — and the two do different
 * jobs: SQL's CHECK is what makes the rule true for every writer, and this one is
 * what makes the refusal a sentence rather than a constraint name.
 *
 * What is deliberately NOT accepted from a caller: `authoredBy`. There is no such
 * field on the inputs and no `p_authored_by` in the migration, because the column
 * every knockout gate reads is stamped by a trigger from `auth.uid()`. A
 * parameter here would reopen the exact hole an adversarial review walked through
 * — `lib/apply/index.ts` says so in bold, and `parity.test.ts` asserts it across
 * all three layers.
 */

/** Demo-only expired-session hook — see queue/actions.ts for why it exists. */
const DEMO_EXPIRED_COOKIE = "hq_demo_session";

async function demoSessionExpired(): Promise<boolean> {
  if (!isDemoMode()) return false;
  try {
    return (await cookies()).get(DEMO_EXPIRED_COOKIE)?.value === "expired";
  } catch {
    return false;
  }
}

async function hasSession(): Promise<boolean> {
  if (!getSupabaseEnv()) return true; // unconfigured/demo: nothing to expire
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

const PROVENANCES = new Set(["user-entered", "confirmed", "suggested"]);
const TOPICS = new Set<string>(POLICY_TOPICS);

/** The shape checks every write shares. Returns a message, or null when clean. */
function commonProblem(idempotencyKey: unknown, expectedUpdatedAt?: unknown): string | null {
  if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 200) {
    return "Invalid idempotency key.";
  }
  if (
    expectedUpdatedAt !== undefined &&
    expectedUpdatedAt !== null &&
    typeof expectedUpdatedAt !== "string"
  ) {
    return "Invalid version token.";
  }
  return null;
}

export type SaveAnswerInput = {
  question: string;
  answer: string;
  kind: string;
  /**
   * WHERE it applies: a company NAME, or `""` for every board. Optional on the
   * wire so a caller that has nothing to say about scope says nothing, and
   * global is what every 0014-era call meant.
   */
  company?: string;
  /** The person picked the board's own "I don't wish to answer". */
  declined?: boolean;
  provenance: Provenance;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * Save one library answer, at a scope.
 *
 * The growth loop, and the only reason the second application is cheaper than the
 * first: "every novel question answered once becomes a constant". Called from the
 * settings surface AND from the review screen, which is the point — a gap
 * answered while reviewing a job is stored in exactly the same place.
 *
 * `company` is what stops that loop being a trap. A library answer outranks a
 * policy rule at layer 1, so before 0017 a question answered once at one board
 * became the answer at every board — including the ones where the person had set
 * an exception saying otherwise. Scope is not a nicety here; it is the
 * difference between "answered once" and "answered wrong everywhere".
 */
export async function saveAnswerAction(input: SaveAnswerInput): Promise<AnswerWriteResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (typeof input !== "object" || input === null) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const problem = commonProblem(input.idempotencyKey, input.expectedUpdatedAt);
  if (problem) return { ok: false, kind: "error", message: problem };
  if (typeof input.question !== "string" || typeof input.answer !== "string") {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.kind !== "string" || !isAnswerKind(input.kind)) {
    return { ok: false, kind: "error", message: "That is not a kind of answer this app stores." };
  }
  const company = input.company ?? "";
  if (typeof company !== "string" || company.length > 200) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (input.declined !== undefined && typeof input.declined !== "boolean") {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.provenance !== "string" || !PROVENANCES.has(input.provenance)) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }

  const src = await getDataSource();
  const result = await src.upsertAnswer({
    question: input.question,
    answer: input.answer,
    kind: input.kind,
    company,
    declined: input.declined === true,
    provenance: input.provenance,
    idempotencyKey: input.idempotencyKey,
    expectedUpdatedAt: input.expectedUpdatedAt ?? null,
  });
  if (result.ok) revalidatePath("/settings/answers");
  return result;
}

export type DeleteAnswerActionInput = {
  question: string;
  company?: string;
  idempotencyKey: string;
};

/**
 * Remove one library answer.
 *
 * The exit 0014 did not have. It matters most for the answer somebody regrets
 * least reversibly — a recorded "I don't wish to answer", whose only other exit
 * was to overwrite it with an answer they had chosen not to give.
 */
export async function deleteAnswerAction(
  input: DeleteAnswerActionInput,
): Promise<DeleteAnswerResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (typeof input !== "object" || input === null) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const problem = commonProblem(input.idempotencyKey);
  if (problem) return { ok: false, kind: "error", message: problem };
  if (typeof input.question !== "string") {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const company = input.company ?? "";
  if (typeof company !== "string" || company.length > 200) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }

  const src = await getDataSource();
  const result = await src.deleteAnswer({
    question: input.question,
    company,
    idempotencyKey: input.idempotencyKey,
  });
  if (result.ok) revalidatePath("/settings/answers");
  return result;
}

export type SaveRuleInput = {
  topic: string;
  company: string;
  fact: unknown;
  provenance: Provenance;
  note: string;
  enabled: boolean;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * Save one policy rule.
 *
 * `fact` arrives as unknown and leaves as a `SituationFact` or not at all:
 * `parseSituationFact` is the same function that reads a stored row, so a rule
 * this door accepts is one the engine can definitely use. A rule that lands and
 * then answers nothing is worse than a refusal — it looks configured.
 */
export async function saveRuleAction(input: SaveRuleInput): Promise<PolicyWriteResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (typeof input !== "object" || input === null) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const problem = commonProblem(input.idempotencyKey, input.expectedUpdatedAt);
  if (problem) return { ok: false, kind: "error", message: problem };
  if (typeof input.topic !== "string" || !TOPICS.has(input.topic)) {
    return { ok: false, kind: "error", message: "That is not a rule this app knows about." };
  }
  if (typeof input.company !== "string" || input.company.length > 200) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.note !== "string" || typeof input.enabled !== "boolean") {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.provenance !== "string" || !PROVENANCES.has(input.provenance)) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const fact = parseSituationFact(input.fact);
  if (fact === null) {
    return {
      ok: false,
      kind: "error",
      message: "That answer is not in a shape this app can use. Nothing was saved.",
    };
  }

  const src = await getDataSource();
  const result = await src.setPolicyRule({
    topic: input.topic,
    company: input.company,
    fact,
    provenance: input.provenance,
    note: input.note,
    enabled: input.enabled,
    idempotencyKey: input.idempotencyKey,
    expectedUpdatedAt: input.expectedUpdatedAt ?? null,
  });
  if (result.ok) revalidatePath("/settings/answers");
  return result;
}

export type DeleteRuleInput = {
  topic: string;
  company: string;
  idempotencyKey: string;
};

export async function deleteRuleAction(input: DeleteRuleInput): Promise<DeletePolicyResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (typeof input !== "object" || input === null) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const problem = commonProblem(input.idempotencyKey);
  if (problem) return { ok: false, kind: "error", message: problem };
  if (typeof input.topic !== "string" || !TOPICS.has(input.topic)) {
    return { ok: false, kind: "error", message: "That is not a rule this app knows about." };
  }
  if (typeof input.company !== "string" || input.company.length > 200) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }

  const src = await getDataSource();
  const result = await src.deletePolicyRule({
    topic: input.topic,
    company: input.company,
    idempotencyKey: input.idempotencyKey,
  });
  if (result.ok) revalidatePath("/settings/answers");
  return result;
}

// ---- autopilot staging (#206) ----------------------------------------------
//
// The first call sites of the three autopilot commands. Same discipline as the
// library actions above: a server action is a public endpoint and the input
// type is erased at runtime, so every closed set is checked HERE as well as in
// Postgres — SQL's check is what makes the rule true for every writer, this one
// is what makes the refusal a sentence.
//
// THE PACKAGE IS NOT AN ARGUMENT. `stageAutopilotAction` takes an APPLICATION,
// not the answers to write: `deriveStagePackage` re-runs prepare and the
// mapping seam server-side against the user's own RLS-scoped rows. The first
// version of this action DID take the mapped package and checked
// `answers[*].source` against the four-word vocabulary — which let a browser
// simply assert `user_fact`, the laundering shape #206's attack list names,
// while `persist.ts` (written to prevent exactly that) had no production
// callers at all. See `derive.ts` for the full reasoning.

const AUTOPILOT_STATES_STAGEABLE = new Set(["preparing", "needs_input", "ready_for_review"]);
const AUTOPILOT_DECISIONS = new Set(["approve", "request_changes", "cancel"]);
const AUTOPILOT_OUTCOMES = new Set(["submitted", "abandoned"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function attachmentsProblem(attachments: AutopilotAttachment[]): string | null {
  if (!Array.isArray(attachments)) return "Malformed request.";
  for (const a of attachments) {
    if (!isRecord(a)) return "Malformed request.";
    if (typeof a.artifactId !== "number" || !Number.isFinite(a.artifactId)) {
      return "An attachment names an artifact by id.";
    }
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256.toLowerCase())) {
      return "An attachment needs its artifact's 64-hex sha256.";
    }
    if (typeof a.filename !== "string" || typeof a.kind !== "string") {
      return "Malformed request.";
    }
  }
  return null;
}

export type StageAutopilotActionInput = {
  /**
   * WHICH application to prepare and persist. Not what to write — the values,
   * their sources and the gaps are all derived server-side from this user's own
   * rows (`derive.ts`).
   */
  applicationId: number;
  /**
   * The attachment choice. Client-supplied on purpose and safe to be: the
   * database's package guard verifies every entry is THIS user's
   * `resume_artifacts` row at THAT checksum, so a forged entry can only ever
   * name a file the user already owns, unchanged.
   */
  attachments: AutopilotAttachment[];
  state: "preparing" | "needs_input" | "ready_for_review";
  reason: string;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * Prepare one application server-side and persist the result.
 *
 * It can leave the stage only in a preparation state: approving is
 * `reviewAutopilotStageAction`, with the hash the reviewer actually saw.
 */
export async function stageAutopilotAction(
  input: StageAutopilotActionInput,
): Promise<AutopilotStageWriteResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (!isRecord(input)) return { ok: false, kind: "error", message: "Malformed request." };
  const problem = commonProblem(input.idempotencyKey, input.expectedUpdatedAt);
  if (problem) return { ok: false, kind: "error", message: problem };
  if (typeof input.applicationId !== "number" || !Number.isSafeInteger(input.applicationId)) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.state !== "string" || !AUTOPILOT_STATES_STAGEABLE.has(input.state)) {
    return {
      ok: false,
      kind: "error",
      message: "A stage write may only leave the package in a preparation state.",
    };
  }
  if (typeof input.reason !== "string" || input.reason.length > 500) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const attProblem = attachmentsProblem(input.attachments);
  if (attProblem) return { ok: false, kind: "error", message: attProblem };

  const src = await getDataSource();
  // THE PACKAGE IS DERIVED, NOT RECEIVED. Nothing a caller can put on the wire
  // reaches `answers`, `payload`, `gaps` or any answer's `source`.
  const derived = await deriveStagePackage(input.applicationId, { src });
  if (!derived.ok) {
    return { ok: false, kind: "error", message: derived.message };
  }

  const result = await src.stageAutopilot({
    applicationId: input.applicationId,
    provider: derived.package.provider,
    providerVersion: derived.package.providerVersion,
    formIdentity: derived.package.formIdentity,
    formSchemaHash: derived.package.formSchemaHash,
    payload: derived.package.payload,
    attachments: input.attachments,
    answers: derived.package.answers,
    gaps: derived.package.gaps,
    state: input.state,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    expectedUpdatedAt: input.expectedUpdatedAt ?? null,
  });
  if (result.ok) revalidatePath("/autopilot");
  return result;
}

export type ReviewAutopilotStageActionInput = {
  stageId: number;
  decision: "approve" | "request_changes" | "cancel";
  /** REQUIRED for approve: the hash the surface displayed, echoed verbatim. */
  packageHash: string | null;
  reason: string;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * The human's decision on a stored package. Approving sends the displayed
 * `packageHash`; a package that changed since render, or a stale token, comes
 * back as `conflict` with the server's row — the surface re-reads before any
 * retry, never re-sends blind.
 */
export async function reviewAutopilotStageAction(
  input: ReviewAutopilotStageActionInput,
): Promise<AutopilotReviewResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (!isRecord(input)) return { ok: false, kind: "error", message: "Malformed request." };
  const problem = commonProblem(input.idempotencyKey, input.expectedUpdatedAt);
  if (problem) return { ok: false, kind: "error", message: problem };
  if (typeof input.stageId !== "number" || !Number.isFinite(input.stageId)) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.decision !== "string" || !AUTOPILOT_DECISIONS.has(input.decision)) {
    return { ok: false, kind: "error", message: "That is not a review decision this app knows." };
  }
  if (input.decision === "approve") {
    if (typeof input.packageHash !== "string" || !/^[0-9a-f]{64}$/.test(input.packageHash)) {
      return {
        ok: false,
        kind: "error",
        message: "Approving needs the hash of the package you reviewed.",
      };
    }
  } else if (input.packageHash !== null && typeof input.packageHash !== "string") {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.reason !== "string" || input.reason.length > 500) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }

  const src = await getDataSource();
  const result = await src.reviewAutopilotStage({
    stageId: input.stageId,
    decision: input.decision,
    packageHash: input.decision === "approve" ? input.packageHash : null,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    expectedUpdatedAt: input.expectedUpdatedAt ?? null,
  });
  if (result.ok) revalidatePath("/autopilot");
  return result;
}

export type SettleAutopilotHandoffActionInput = {
  stageId: number;
  outcome: "submitted" | "abandoned";
  reason: string;
  idempotencyKey: string;
  expectedUpdatedAt: string | null;
};

/**
 * Record what the user reports after the manual handoff. 'submitted' writes
 * the MANUAL application status through the database's own `app_set_status`
 * lane — the copy above this button says "you marked this applied", never
 * "submitted", because the user's word is the only evidence this half has.
 * Neither outcome writes provider evidence of any kind.
 */
export async function settleAutopilotHandoffAction(
  input: SettleAutopilotHandoffActionInput,
): Promise<AutopilotSettleResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (!isRecord(input)) return { ok: false, kind: "error", message: "Malformed request." };
  const problem = commonProblem(input.idempotencyKey, input.expectedUpdatedAt);
  if (problem) return { ok: false, kind: "error", message: problem };
  if (typeof input.stageId !== "number" || !Number.isFinite(input.stageId)) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.outcome !== "string" || !AUTOPILOT_OUTCOMES.has(input.outcome)) {
    return { ok: false, kind: "error", message: "That is not a handoff outcome this app records." };
  }
  if (typeof input.reason !== "string" || input.reason.length > 500) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }

  const src = await getDataSource();
  const result = await src.settleAutopilotHandoff({
    stageId: input.stageId,
    outcome: input.outcome,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    expectedUpdatedAt: input.expectedUpdatedAt ?? null,
  });
  if (result.ok) {
    revalidatePath("/autopilot");
    revalidatePath("/pipeline");
  }
  return result;
}
