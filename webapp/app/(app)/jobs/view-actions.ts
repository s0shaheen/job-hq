"use server";

import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  type DeleteViewInput,
  type DeleteViewResult,
  type SaveViewInput,
  type SaveViewResult,
} from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { makeViewState, parseViewState } from "@/lib/grid/view-state";
import { createClient } from "@/lib/supabase/server";

/**
 * The only way a saved view reaches the store — the same doctrine as
 * queue/actions.ts, which this file mirrors deliberately: the browser has no
 * write permission, so every gesture is a server action carrying a client
 * idempotency key (a double-tap is free) and the `updatedAt` the client last
 * read (a second device is a visible conflict, never a silent clobber).
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
 * Checked here rather than left to middleware, for the same reason as triage:
 * middleware answers an expired session with a redirect, which is right for a
 * navigation and useless for an action — the browser gets a redirect where it
 * expected a result. Answering `auth` lets the client say so.
 */
async function hasSession(): Promise<boolean> {
  if (!getSupabaseEnv()) return true; // unconfigured/demo: nothing to expire
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

/** The one surface that has saved views today. Pipeline joins in phase 5. */
const SURFACES = ["jobs"] as const;

/**
 * Boundary validation — a server action is a public endpoint and these types
 * are erased at runtime, so nothing about the payload can be assumed. `state`
 * is additionally NORMALIZED through the same parser the grid reads with:
 * whatever a hand-crafted call sends, the row that lands in the store is a
 * canonical, bounded ViewState — the grid can never be handed a state its own
 * writer could not have produced.
 */
function validateSave(input: SaveViewInput): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (input.id !== null && (typeof input.id !== "string" || !input.id || input.id.length > 200)) {
    return "Invalid view id.";
  }
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80) {
    return "A view needs a name of at most 80 characters.";
  }
  if (!(SURFACES as readonly string[]).includes(input.surface)) {
    return `Invalid surface: ${String(input.surface)}`;
  }
  if (typeof input.isDefault !== "boolean") return "Invalid default flag.";
  if (
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  ) {
    return "Invalid idempotency key.";
  }
  if (input.expectedUpdatedAt != null && typeof input.expectedUpdatedAt !== "string") {
    return "Invalid version token.";
  }
  return null;
}

export async function saveViewAction(input: SaveViewInput): Promise<SaveViewResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  const invalid = validateSave(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const parsed = parseViewState(input.state);
  const src = await getDataSource();
  return src.saveView({
    ...input,
    name: input.name.trim(),
    state: makeViewState(parsed.nav, parsed.display),
  });
}

export async function deleteViewAction(input: DeleteViewInput): Promise<DeleteViewResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  if (typeof input !== "object" || input === null) {
    return { ok: false, kind: "error", message: "Malformed request." };
  }
  if (typeof input.id !== "string" || !input.id || input.id.length > 200) {
    return { ok: false, kind: "error", message: "Invalid view id." };
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  ) {
    return { ok: false, kind: "error", message: "Invalid idempotency key." };
  }

  const src = await getDataSource();
  return src.deleteView(input);
}
