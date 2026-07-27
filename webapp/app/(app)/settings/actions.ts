"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  type CommitProfileResult,
  type PreviewProfileResult,
} from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { parseCriteria, type ProfileCriteria } from "@/lib/profile/criteria";
import { buildRegatePlan } from "@/lib/profile/regate";

/**
 * The two gestures the profile has: check, and save.
 *
 * Every validator here exists because **a server action is a public endpoint
 * and the input type is erased at runtime** (matrix row 38). `parseCriteria` is
 * the closed-set boundary — unknown keys dropped, policies falling back rather
 * than being written verbatim, both numbers clamped — and it runs on the way in
 * so the preview is computed over exactly the object a save would store.
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

export async function previewProfileAction(
  criteria: ProfileCriteria,
  windowDays = 30,
): Promise<PreviewProfileResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };
  if (typeof criteria !== "object" || criteria === null) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const src = await getDataSource();
  return src.previewProfile({ criteria: parseCriteria(criteria), windowDays });
}

/**
 * Save the profile and restamp what it moves.
 *
 * The re-gate plan is built HERE, on the server, from a fresh read of the
 * user's own rows — not sent by the browser. Two reasons, and the second is the
 * one that matters: shipping the whole set to a phone to compute a plan is
 * wasteful, and a plan the client composed is a plan the client can compose
 * wrongly. The SQL re-checks every entry anyway (`triage = ''`, the tuple
 * really differs), so a bad plan changes nothing — but building it from a read
 * taken seconds ago is the difference between "usually right" and "right".
 */
export async function commitProfileAction(
  criteria: ProfileCriteria,
  idempotencyKey: string,
  expectedUpdatedAt: string | null,
): Promise<CommitProfileResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (typeof criteria !== "object" || criteria === null) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (
    typeof idempotencyKey !== "string" ||
    !idempotencyKey ||
    idempotencyKey.length > 200
  ) {
    return { ok: false, kind: "error", message: "Invalid idempotency key." };
  }
  if (expectedUpdatedAt !== null && typeof expectedUpdatedAt !== "string") {
    return { ok: false, kind: "error", message: "Invalid version token." };
  }

  const clean = parseCriteria(criteria);
  const src = await getDataSource();
  const plan = buildRegatePlan(await src.jobs(), clean);

  const result = await src.commitProfile({
    criteria: clean,
    regate: plan,
    idempotencyKey,
    expectedUpdatedAt,
  });

  if (result.ok) {
    // The queue and the grid read `disposition`, and a save just changed it for
    // however many rows the plan touched — this is the one write in the app
    // where refetching those surfaces is the point rather than a nuisance.
    revalidatePath("/queue");
    revalidatePath("/jobs");
    revalidatePath("/settings");
  }
  return result;
}
