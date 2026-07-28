"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  type PinWarmIntroResult,
  type UnpinWarmIntroInput,
  type UnpinWarmIntroResult,
  type WarmTargetKind,
} from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { classifyWarmAdd } from "./types";

/**
 * The warm-intro finder's LAYER-0 write path: pinning a person to a row and the
 * manual-add box. No `fetch`, no vendor — a pin is just a row this user chose to
 * keep, whether it came from a vendor result (`source: "warm"`) or was typed in the
 * add box (`source: "manual"`). The vendor search itself is the ROUTES' job
 * (`app/api/warm/*`), which is where the network call lives; this file never leaves
 * the app.
 *
 * Shaped like `lib/referral/actions.ts`: every validator here exists because a
 * server action is a public endpoint and the input type is erased at runtime, and
 * the same demo/session guards keep a redirect from evaporating a gesture.
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

function validIdem(key: unknown): boolean {
  return typeof key === "string" && key.trim() !== "" && key.length <= 200;
}

function validTargetKind(kind: unknown): kind is WarmTargetKind {
  return kind === "posting" || kind === "company";
}

export type PinWarmIntroActionInput = {
  targetKind: WarmTargetKind;
  postingKey: string;
  company: string;
  fullName: string;
  profileUrl: string;
  headline: string;
  idempotencyKey: string;
};

/** Pin a person FROM a vendor result — structured, `source: "warm"`. */
export async function pinWarmIntroAction(
  input: PinWarmIntroActionInput,
): Promise<PinWarmIntroResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };
  if (!validTargetKind(input?.targetKind)) return badRequest("Malformed request.");
  if (typeof input.company !== "string" || input.company.trim() === "") {
    return badRequest("A company is required.");
  }
  if (typeof input.fullName !== "string" || input.fullName.trim() === "") {
    return badRequest("A pin needs a name.");
  }
  if (!validIdem(input.idempotencyKey)) return badRequest("Invalid idempotency key.");

  const src = await getDataSource();
  const result = await src.pinWarmIntro({
    targetKind: input.targetKind,
    postingKey: typeof input.postingKey === "string" ? input.postingKey : "",
    company: input.company,
    fullName: input.fullName,
    profileUrl: typeof input.profileUrl === "string" ? input.profileUrl : "",
    headline: typeof input.headline === "string" ? input.headline : "",
    source: "warm",
    idempotencyKey: input.idempotencyKey,
  });
  if (result.ok) revalidateWarm();
  return result;
}

export type AddWarmIntroActionInput = {
  targetKind: WarmTargetKind;
  postingKey: string;
  company: string;
  /** Raw text from the add box: a LinkedIn URL OR a plain name. */
  text: string;
  idempotencyKey: string;
};

/** The manual-add box: classify the text, then pin it as `source: "manual"`. */
export async function addWarmIntroAction(
  input: AddWarmIntroActionInput,
): Promise<PinWarmIntroResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };
  if (!validTargetKind(input?.targetKind)) return badRequest("Malformed request.");
  if (typeof input.company !== "string" || input.company.trim() === "") {
    return badRequest("A company is required.");
  }
  if (!validIdem(input.idempotencyKey)) return badRequest("Invalid idempotency key.");

  // The one refusal is a non-LinkedIn URL; a plain name is always accepted.
  const parsed = classifyWarmAdd(typeof input.text === "string" ? input.text : "");
  if (!parsed.ok) return badRequest(parsed.error);

  const src = await getDataSource();
  const result = await src.pinWarmIntro({
    targetKind: input.targetKind,
    postingKey: typeof input.postingKey === "string" ? input.postingKey : "",
    company: input.company,
    fullName: parsed.fullName,
    profileUrl: parsed.profileUrl,
    headline: "",
    source: "manual",
    idempotencyKey: input.idempotencyKey,
  });
  if (result.ok) revalidateWarm();
  return result;
}

export async function unpinWarmIntroAction(
  input: UnpinWarmIntroInput,
): Promise<UnpinWarmIntroResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };
  if (!validIdem(input?.idempotencyKey)) {
    return { ok: false, kind: "error", message: "Invalid idempotency key." };
  }
  const src = await getDataSource();
  const result = await src.unpinWarmIntro(input);
  if (result.ok) revalidateWarm();
  return result;
}

function badRequest(message: string): PinWarmIntroResult {
  return { ok: false, kind: "error", message };
}

function revalidateWarm(): void {
  // A pin changes the warm-intro cell on both grids that render it.
  revalidatePath("/jobs");
  revalidatePath("/pipeline");
}
