"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDataSource } from "@/lib/data/get-source";
import { isDemoMode, type BulkTriageInput, type BulkWriteResult } from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * The only way a BULK triage decision reaches the store — queue/actions.ts,
 * mirrored for N keys. One call, one transaction: the data layer applies the
 * whole selection or none of it (a conflict on any row returns
 * `kind:"conflict"` with nothing written), which is what lets the client offer
 * one optimistic update and ONE undo instead of N reconciliations.
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

/**
 * Checked here rather than left to middleware, exactly as the single-row
 * action explains: a redirect where the client expected a result evaporates
 * the decision. Answering `auth` lets the client revert the gesture and say
 * why (DEC-011: refused visibly, never queued).
 */
async function hasSession(): Promise<boolean> {
  if (!getSupabaseEnv()) return true; // unconfigured/demo: nothing to expire
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

const TRIAGE_VALUES = ["", "interested", "dismissed", "snoozed"] as const;

/** The SQL's own fan-out bound (0006): past it the request is a bug, not a
 *  decision, and failing fast beats locking a thousand rows. */
const MAX_BULK_KEYS = 1000;

/**
 * Boundary validation — a server action is a public endpoint and
 * `BulkTriageInput` is erased at runtime. The parallel-array contract is
 * enforced here because it is the easiest thing for a hand-crafted call to get
 * wrong, and a shorter `expectedUpdatedAt` would silently skip conflict checks
 * on the tail rows — the exact clobber the tokens exist to prevent.
 */
function validate(input: BulkTriageInput): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (!Array.isArray(input.postingKeys) || input.postingKeys.length === 0) {
    return "Nothing is selected.";
  }
  if (input.postingKeys.length > MAX_BULK_KEYS) {
    return `Too many rows in one decision (limit ${MAX_BULK_KEYS}).`;
  }
  for (const k of input.postingKeys) {
    if (typeof k !== "string" || !k || k.length > 200) return "Invalid posting.";
  }
  if (!(TRIAGE_VALUES as readonly string[]).includes(input.triage)) {
    return `Invalid decision: ${String(input.triage)}`;
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  ) {
    return "Invalid idempotency key.";
  }
  if (input.triage === "snoozed") {
    if (typeof input.snoozeUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.snoozeUntil)) {
      return "A snooze needs a wake date.";
    }
  } else if (input.snoozeUntil != null && typeof input.snoozeUntil !== "string") {
    return "Invalid snooze date.";
  }
  if (
    !Array.isArray(input.expectedUpdatedAt) ||
    input.expectedUpdatedAt.length !== input.postingKeys.length
  ) {
    return "Version tokens must match the selection row for row.";
  }
  for (const t of input.expectedUpdatedAt) {
    if (t !== null && typeof t !== "string") return "Invalid version token.";
  }
  return null;
}

export async function setTriageBulkAction(input: BulkTriageInput): Promise<BulkWriteResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  const invalid = validate(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const src = await getDataSource();
  const result = await src.setTriageBulk(input);
  if (result.ok) {
    // Same rule as the single-row action: only the pipeline is revalidated.
    // The grid owns its working set and updates optimistically; refetching it
    // mid-session would reorder rows under the user's selection.
    revalidatePath("/pipeline");
  }
  return result;
}
