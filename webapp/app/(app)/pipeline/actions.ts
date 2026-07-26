"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  type AppWriteResult,
  type NextActionInput,
  type NoteInput,
  type StatusInput,
  type SuggestionInput,
} from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * The only way a pipeline gesture reaches the store.
 *
 * Mirrors `queue/actions.ts` exactly, including its two non-obvious decisions:
 * the session check happens HERE rather than in middleware (which answers an
 * expired session with a redirect — right for a navigation, useless for an
 * action, because the browser gets a redirect where it expected a result and the
 * gesture evaporates), and every payload is validated at the boundary because a
 * server action is a public HTTP endpoint and these input types are erased at
 * runtime.
 *
 * It DOES revalidate `/pipeline`, unlike the queue. The rule the queue follows —
 * never refetch mid-session — exists because the queue is a working set the user
 * walks through and a refetch reorders cards under their cursor. The pipeline is
 * a list edited in place, so a re-read moves nothing.
 */

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

/** The checks every gesture shares. Returns an error string or null. */
function validateCommon(input: {
  applicationId?: unknown;
  idempotencyKey?: unknown;
  expectedUpdatedAt?: unknown;
}): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (
    typeof input.applicationId !== "number" ||
    !Number.isSafeInteger(input.applicationId) ||
    input.applicationId <= 0
  ) {
    return "Invalid application.";
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  ) {
    return "Invalid idempotency key.";
  }
  if (
    "expectedUpdatedAt" in input &&
    input.expectedUpdatedAt != null &&
    typeof input.expectedUpdatedAt !== "string"
  ) {
    return "Invalid version token.";
  }
  return null;
}

/**
 * The gate every action runs before touching the store.
 *
 * Auth first, then validation. The order matters: an expired session with a
 * malformed payload should be reported as the expired session, because that is
 * the one the user can act on — and `kind: "auth"` sends the gesture to the
 * outbox instead of discarding it.
 */
async function guard(
  input: { applicationId?: unknown; idempotencyKey?: unknown; expectedUpdatedAt?: unknown },
  extra?: () => string | null,
): Promise<AppWriteResult | null> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };
  const invalid = validateCommon(input) ?? extra?.() ?? null;
  if (invalid) return { ok: false, kind: "error", message: invalid };
  return null;
}

export async function setStatusAction(input: StatusInput): Promise<AppWriteResult> {
  const refused = await guard(input, () => {
    // Free text, not an enum: the sheet allows an invented status and refusing
    // one here would make the app less capable than the spreadsheet. Bounded to
    // the same 80 characters the SQL bounds it to, so the two agree about what
    // is too long rather than the UI discovering it from a Postgres error.
    if (typeof input.status !== "string" || !input.status.trim()) return "A status is required.";
    if (input.status.length > 80) return "That status is too long.";
    if (input.note != null && typeof input.note !== "string") return "Invalid note.";
    if (typeof input.note === "string" && input.note.length > 4000) {
      return "That note is too long.";
    }
    return null;
  });
  if (refused) return refused;

  const result = await (await getDataSource()).setStatus(input);
  if (result.ok) revalidatePath("/pipeline");
  return result;
}

export async function resolveSuggestionAction(
  input: SuggestionInput,
): Promise<AppWriteResult> {
  const refused = await guard(input, () =>
    input.decision === "confirm" || input.decision === "reject"
      ? null
      : `Invalid decision: ${String(input.decision)}`,
  );
  if (refused) return refused;

  const result = await (await getDataSource()).resolveSuggestion(input);
  if (result.ok) revalidatePath("/pipeline");
  return result;
}

export async function addNoteAction(input: NoteInput): Promise<AppWriteResult> {
  const refused = await guard(input, () => {
    if (typeof input.body !== "string" || !input.body.trim()) {
      return "A note needs something in it.";
    }
    if (input.body.length > 4000) return "That note is too long.";
    return null;
  });
  if (refused) return refused;

  const result = await (await getDataSource()).addNote(input);
  if (result.ok) revalidatePath("/pipeline");
  return result;
}

export async function setNextActionAction(
  input: NextActionInput,
): Promise<AppWriteResult> {
  const refused = await guard(input, () => {
    if (typeof input.nextAction !== "string") return "Invalid next action.";
    if (input.nextAction.length > 500) return "That next action is too long.";
    if (input.nextActionDate != null) {
      if (
        typeof input.nextActionDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.nextActionDate)
      ) {
        return "Invalid date.";
      }
    }
    return null;
  });
  if (refused) return refused;

  const result = await (await getDataSource()).setNextAction(input);
  if (result.ok) revalidatePath("/pipeline");
  return result;
}

/** The note history for one row — read on demand when the dialog opens. */
export async function loadNotesAction(applicationId: number) {
  if (await demoSessionExpired()) return { ok: false as const, kind: "auth" as const };
  if (!(await hasSession())) return { ok: false as const, kind: "auth" as const };
  if (typeof applicationId !== "number" || !Number.isSafeInteger(applicationId)) {
    return { ok: false as const, kind: "error" as const, message: "Invalid application." };
  }
  const notes = await (await getDataSource()).notes(applicationId);
  return { ok: true as const, notes };
}
