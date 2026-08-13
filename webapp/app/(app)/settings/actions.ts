"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  type CommitProfileResult,
  type PreviewProfileResult,
  type SetDisplayPrefsInput,
  type SetDisplayPrefsResult,
} from "@/lib/data/source";
import {
  DENSITIES,
  LANDING_VIEW_MAX,
  TYPE_SCALES,
} from "@/lib/display/prefs";
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

/**
 * Autosave one or more display preferences (0025).
 *
 * A server action rather than the cookie write this replaces, and the old
 * comment's argument for the cookie is worth answering rather than deleting: it
 * said there was "nothing to authorize, nothing to audit and nothing another
 * device needs to agree about — it is this browser's eyesight". The last clause
 * was the wrong call. Somebody who needs 16px type needs it on their phone too,
 * and a browser-local preference means every new device starts by being
 * unreadable to the person who most needs it readable.
 *
 * Autosave (06 §A: Preferences autosave, Profile & search does not), so this is
 * built to be cheap: one nullable field per knob, and 0025 writes nothing at
 * all when nothing moved.
 *
 * Every validator here exists for `commitProfileAction`'s reason — a server
 * action is a public endpoint and the input type is erased at runtime (matrix
 * row 38). The closed sets are checked against the SAME constants the parser
 * and the CHECK constraints use, so there is one vocabulary rather than three.
 */
export async function setDisplayPrefsAction(
  input: SetDisplayPrefsInput,
): Promise<SetDisplayPrefsResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (typeof input !== "object" || input === null) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  const {
    density,
    typeScale,
    keyboardHints,
    landingView,
    idempotencyKey,
    expectedUpdatedAt,
  } = input;
  if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 200) {
    return { ok: false, kind: "error", message: "Invalid idempotency key." };
  }
  if (expectedUpdatedAt !== null && typeof expectedUpdatedAt !== "string") {
    return { ok: false, kind: "error", message: "Invalid version token." };
  }
  const bad =
    (density !== undefined && !DENSITIES.includes(density)) ||
    (typeScale !== undefined && !TYPE_SCALES.includes(typeScale)) ||
    (keyboardHints !== undefined && typeof keyboardHints !== "boolean") ||
    (landingView !== undefined &&
      (typeof landingView !== "string" || landingView.length > LANDING_VIEW_MAX));
  if (bad) return { ok: false, kind: "error", message: "Unknown display preference." };

  const src = await getDataSource();
  const result = await src.setDisplayPrefs({
    // Rebuilt field by field rather than spread: a server action receives
    // whatever the caller serialised, and a spread would forward keys the
    // contract does not have straight into the RPC argument object — where
    // PostgREST fails to resolve the overload at all.
    ...(density !== undefined ? { density } : {}),
    ...(typeScale !== undefined ? { typeScale } : {}),
    ...(keyboardHints !== undefined ? { keyboardHints } : {}),
    ...(landingView !== undefined ? { landingView } : {}),
    idempotencyKey,
    expectedUpdatedAt,
  });

  if (result.ok && result.changed) {
    // The ROOT layout renders these as `<html>` attributes, so the whole tree
    // is downstream of them — `"layout"` scope, not the settings page alone.
    // The control reloads anyway (see preferences-form.tsx for why a reload rather
    // than a re-render), and revalidating is what makes that reload cheap
    // rather than a second read of stale cache.
    revalidatePath("/", "layout");
  }
  return result;
}
