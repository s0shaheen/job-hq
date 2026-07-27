"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  MAX_CONNECTION_CHUNK,
  type ClearConnectionsInput,
  type ClearConnectionsResult,
  type CompanyFlagsResult,
  type ImportConnectionsInput,
  type ImportConnectionsResult,
  type LinkedinCompanyIdInput,
} from "@/lib/data/source";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { CONNECTION_SOURCE_TAGS } from "./connections";
import { isLinkedinId } from "./linkedin";

/**
 * The referral finder's write path. Shared by /jobs, /pipeline and /connections
 * rather than duplicated per route — `lib/export/actions.ts` is the precedent
 * for a server-action module that more than one surface calls.
 *
 * Every validator here exists because **a server action is a public endpoint and
 * the input type is erased at runtime** (matrix row 38). The closed sets and the
 * bounds are the same values migration 0013 enforces, checked twice on purpose:
 * the SQL is the authority, and failing at the boundary turns a malformed call
 * into a sentence instead of a Postgres error string in a toast.
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
 * Checked here rather than left to middleware: a redirect where the client
 * expected a result evaporates the gesture. Answering `auth` lets the client
 * hold it and say so.
 */
async function hasSession(): Promise<boolean> {
  if (!getSupabaseEnv()) return true; // unconfigured/demo: nothing to expire
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

function validIdem(key: unknown): boolean {
  return typeof key === "string" && key.trim() !== "" && key.length <= 200;
}

function validateLinkedinId(input: LinkedinCompanyIdInput): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (
    typeof input.companyId !== "number" ||
    !Number.isInteger(input.companyId) ||
    input.companyId <= 0
  ) {
    return "Invalid company.";
  }
  if (typeof input.linkedinId !== "string") return "Invalid LinkedIn id.";
  // The SAME predicate the URL builder enforces and the SAME set the SQL
  // accepts. Three layers agreeing on one closed set is the point: the COLUMN
  // is deliberately free-vocab (0008's `source` precedent), so a guard at one
  // end is a guard that stops working the day something else writes to it.
  if (input.linkedinId !== "" && !isLinkedinId(input.linkedinId)) {
    return "A LinkedIn company id is digits only — the number after f_C= in the URL.";
  }
  if (!validIdem(input.idempotencyKey)) return "Invalid idempotency key.";
  if (input.expectedUpdatedAt !== null && typeof input.expectedUpdatedAt !== "string") {
    return "Invalid version token.";
  }
  return null;
}

export async function setLinkedinCompanyIdAction(
  input: LinkedinCompanyIdInput,
): Promise<CompanyFlagsResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  const invalid = validateLinkedinId(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const src = await getDataSource();
  const result = await src.setLinkedinCompanyId(input);
  if (result.ok) {
    // The id is a fact about a company, so every surface that renders a warm
    // path is now stale. /jobs and /pipeline are revalidated; /companies is
    // deliberately NOT, for the reason its own actions give — that grid owns
    // its working set and refetching would reorder rows under a live selection.
    revalidatePath("/jobs");
    revalidatePath("/pipeline");
  }
  return result;
}

function validateImport(input: ImportConnectionsInput): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (!Array.isArray(input.rows)) return "Malformed request.";
  if (input.rows.length === 0) return "There is nothing to import.";
  if (input.rows.length > MAX_CONNECTION_CHUNK) {
    return `That is ${input.rows.length} rows in one call — the limit is ${MAX_CONNECTION_CHUNK}.`;
  }
  for (const r of input.rows) {
    if (typeof r !== "object" || r === null) return "Malformed row.";
    for (const field of [
      "fullName",
      "firstName",
      "lastName",
      "company",
      "title",
      "profileUrl",
    ] as const) {
      if (typeof r[field] !== "string") return "Malformed row.";
    }
    // ISO or null, never a free-text date: `readConnectedOn` refuses anything
    // ambiguous at the edge, and the SQL nulls anything else — so a non-ISO
    // string arriving here is a caller that skipped the parser.
    if (r.connectedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.connectedOn))) {
      return "Dates must be ISO (YYYY-MM-DD) or absent.";
    }
  }
  if (
    typeof input.source !== "string" ||
    !(CONNECTION_SOURCE_TAGS as readonly string[]).includes(input.source)
  ) {
    return `Unknown source tag: ${String(input.source)}`;
  }
  if (!validIdem(input.idempotencyKey)) return "Invalid idempotency key.";
  return null;
}

export async function importConnectionsAction(
  input: ImportConnectionsInput,
): Promise<ImportConnectionsResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  const invalid = validateImport(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const src = await getDataSource();
  const result = await src.importConnections(input);
  if (result.ok) {
    revalidatePath("/connections");
    revalidatePath("/jobs");
    revalidatePath("/pipeline");
  }
  return result;
}

export async function clearConnectionsAction(
  input: ClearConnectionsInput,
): Promise<ClearConnectionsResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };
  if (!validIdem(input?.idempotencyKey)) {
    return { ok: false, kind: "error", message: "Invalid idempotency key." };
  }

  const src = await getDataSource();
  const result = await src.clearConnections(input);
  if (result.ok) {
    revalidatePath("/connections");
    revalidatePath("/jobs");
    revalidatePath("/pipeline");
  }
  return result;
}
