"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  type AnswerWriteResult,
  type DeleteAnswerResult,
  type DeletePolicyResult,
  type PolicyWriteResult,
} from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
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
