"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDataSource } from "@/lib/data/get-source";
import { isDemoMode, type TriageInput, type WriteResult } from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * The only way a triage decision reaches the store.
 *
 * It is a server action rather than a client-side insert because the browser
 * deliberately has no write permission (db/migrations/0001_init.sql ends by
 * saying so). Everything that makes a write safe lives on this side: the
 * idempotency key that makes a double-tap free, and the `expectedUpdatedAt`
 * that turns a second device into a visible conflict instead of a silent
 * clobber.
 */

/**
 * Demo-only: makes the next write behave as though the session had expired.
 *
 * The re-auth path is otherwise untestable without waiting an hour for a real
 * JWT to lapse, and an untested re-auth path is one that gets discovered by
 * whoever is triaging at the moment it first happens. Gated on demo mode, so
 * it cannot exist in a real deployment.
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

/**
 * Is there still a session?
 *
 * Checked here rather than left to middleware: middleware answers a expired
 * session by REDIRECTING to /login, which is right for a page navigation and
 * useless for a server action — the browser gets a redirect where it expected
 * a result, and the decision evaporates with no error anyone can act on.
 * Answering explicitly lets the client revert the gesture and say why
 * (DEC-011: refused visibly, never queued).
 */
async function hasSession(): Promise<boolean> {
  if (!getSupabaseEnv()) return true; // unconfigured/demo: nothing to expire
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

const TRIAGE_VALUES = ["", "interested", "dismissed", "snoozed"] as const;

/**
 * Validate the payload before it reaches the store.
 *
 * A server action is a public HTTP endpoint with a generated name — anyone with
 * a session can invoke it with any body, and the `TriageInput` type is erased at
 * runtime. Without this, `triage` could be any string at all. Today the
 * Postgres CHECK constraint would reject most of it (loudly, as a raw
 * constraint violation shown to the user), and the fixture store accepts it
 * happily; neither is an answer. Validating here means the closed sets in the
 * spec are enforced at the boundary, in the one place both data sources share.
 */
function validate(input: TriageInput): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (typeof input.postingKey !== "string" || !input.postingKey || input.postingKey.length > 200) {
    return "Invalid posting.";
  }
  if (!(TRIAGE_VALUES as readonly string[]).includes(input.triage)) {
    return `Invalid decision: ${String(input.triage)}`;
  }
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey ||
      input.idempotencyKey.length > 200) {
    return "Invalid idempotency key.";
  }
  // A snooze with no wake date is a row that leaves the queue and never returns.
  if (input.triage === "snoozed") {
    if (typeof input.snoozeUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.snoozeUntil)) {
      return "A snooze needs a wake date.";
    }
  } else if (input.snoozeUntil != null && typeof input.snoozeUntil !== "string") {
    return "Invalid snooze date.";
  }
  if (input.expectedUpdatedAt != null && typeof input.expectedUpdatedAt !== "string") {
    return "Invalid version token.";
  }
  return null;
}

export async function setTriageAction(input: TriageInput): Promise<WriteResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  const invalid = validate(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const src = await getDataSource();
  const result = await src.setTriage(input);
  if (result.ok) {
    // Only the pipeline is revalidated. The queue is a working set the user is
    // walking through: refetching it after every decision would reorder cards
    // under their cursor and fight the optimistic update. It is re-read on the
    // next visit, which is when a fresh list is actually wanted.
    revalidatePath("/pipeline");
  }
  return result;
}
