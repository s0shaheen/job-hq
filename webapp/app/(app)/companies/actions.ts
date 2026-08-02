"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDataSource } from "@/lib/data/get-source";
import {
  isDemoMode,
  type BulkReviewInput,
  type BulkReviewResult,
  type CompanyFlagsInput,
  type CompanyFlagsResult,
  type ProposeCompaniesInput,
  type ProposeCompaniesResult,
} from "@/lib/data/source";
import { PROPOSE_SOURCE_TAGS } from "@/lib/data/view-models";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { MAX_NAME_LENGTH, MAX_PASTE_NAMES } from "./paste";

/**
 * The only way a company review decision reaches the store — jobs/bulk-actions.ts,
 * mirrored for the universe grid.
 *
 * Every validator here exists because **a server action is a public endpoint and
 * the input type is erased at runtime** (matrix row 38). The closed sets and the
 * bounds are the same values migration 0008 enforces, checked twice on purpose:
 * the SQL is the authority, and failing at the boundary turns a malformed call into
 * a message instead of a Postgres error string in a toast.
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
 * Checked here rather than left to middleware, exactly as the triage actions
 * explain: a redirect where the client expected a result evaporates the gesture.
 * Answering `auth` lets the client hold it and say so.
 */
async function hasSession(): Promise<boolean> {
  if (!getSupabaseEnv()) return true; // unconfigured/demo: nothing to expire
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

const REVIEW_STATES = ["proposed", "approved", "dismissed"] as const;

/** 0008's own fan-out bound. Past it the request is a bug, not a decision. */
const MAX_REVIEW_IDS = 1000;
const MAX_SOURCE_LEN = 40;

function validateReview(input: BulkReviewInput): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (!Array.isArray(input.companyIds) || input.companyIds.length === 0) {
    return "Nothing is selected.";
  }
  if (input.companyIds.length > MAX_REVIEW_IDS) {
    return `Too many companies in one decision (limit ${MAX_REVIEW_IDS}).`;
  }
  for (const id of input.companyIds) {
    // Integer-checked, not just typeof: `companies.id` is a bigint identity, and a
    // float or a NaN would reach Postgres as an unresolvable argument rather than a
    // clean rejection.
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return "Invalid company.";
  }
  if (!(REVIEW_STATES as readonly string[]).includes(input.reviewState)) {
    return `Invalid decision: ${String(input.reviewState)}`;
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  ) {
    return "Invalid idempotency key.";
  }
  // The parallel-array contract, enforced here for bulk-actions.ts's reason: it is
  // the easiest thing for a hand-crafted call to get wrong, and a SHORTER token
  // array would silently skip the conflict check on the tail rows — the exact
  // clobber the tokens exist to prevent.
  if (
    !Array.isArray(input.expectedUpdatedAt) ||
    input.expectedUpdatedAt.length !== input.companyIds.length
  ) {
    return "Version tokens must match the selection row for row.";
  }
  for (const t of input.expectedUpdatedAt) {
    if (t !== null && typeof t !== "string") return "Invalid version token.";
  }
  return null;
}

export async function setCompanyReviewAction(
  input: BulkReviewInput,
): Promise<BulkReviewResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  const invalid = validateReview(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const src = await getDataSource();
  const result = await src.setCompanyReviewBulk(input);
  if (result.ok) {
    // Approving a company changes what the NEXT sweep pulls, not what is on screen
    // now, so nothing else needs revalidating. /companies itself is deliberately
    // not revalidated: the grid owns its working set and updates optimistically,
    // and refetching mid-session would reorder rows under the user's selection
    // (the queue's rule, and the reason /jobs only revalidates /pipeline).
    revalidatePath("/health");
  }
  return result;
}

function validateFlags(input: CompanyFlagsInput): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (
    typeof input.companyId !== "number" ||
    !Number.isInteger(input.companyId) ||
    input.companyId <= 0
  ) {
    return "Invalid company.";
  }
  if (typeof input.enabled !== "boolean" || typeof input.priority !== "boolean") {
    return "Invalid setting.";
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  ) {
    return "Invalid idempotency key.";
  }
  if (input.expectedUpdatedAt !== null && typeof input.expectedUpdatedAt !== "string") {
    return "Invalid version token.";
  }
  return null;
}

export async function setCompanyFlagsAction(
  input: CompanyFlagsInput,
): Promise<CompanyFlagsResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  const invalid = validateFlags(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const src = await getDataSource();
  const result = await src.setCompanyFlags(input);
  if (result.ok) revalidatePath("/health");
  return result;
}

function validatePropose(input: ProposeCompaniesInput): string | null {
  if (typeof input !== "object" || input === null) return "Malformed request.";
  if (!Array.isArray(input.names) || input.names.length === 0) {
    return "Paste at least one company name.";
  }
  if (input.names.length > MAX_PASTE_NAMES) {
    return `That is ${input.names.length} names. The limit is ${MAX_PASTE_NAMES} per paste.`;
  }
  for (const n of input.names) {
    if (typeof n !== "string" || n.length > MAX_NAME_LENGTH) return "Invalid company name.";
  }
  if (typeof input.source !== "string" || input.source.length > MAX_SOURCE_LEN) {
    return "Invalid source tag.";
  }
  // 0008's closed vocabulary, checked here too: `source` is a reporting dimension
  // the coverage meter groups by, and a server action is a public endpoint.
  if (!(PROPOSE_SOURCE_TAGS as readonly string[]).includes(input.source.trim().toLowerCase())) {
    return `Unknown source tag: ${input.source}`;
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  ) {
    return "Invalid idempotency key.";
  }
  return null;
}

export async function proposeCompaniesAction(
  input: ProposeCompaniesInput,
): Promise<ProposeCompaniesResult> {
  if (await demoSessionExpired()) return { ok: false, kind: "auth" };
  if (!(await hasSession())) return { ok: false, kind: "auth" };

  const invalid = validatePropose(input);
  if (invalid) return { ok: false, kind: "error", message: invalid };

  const src = await getDataSource();
  const result = await src.proposeCompanies(input);
  if (result.ok) {
    // New rows land in the review set, which /companies renders from the server on
    // its next visit. Revalidating it is right HERE and wrong in the review action
    // above: this gesture happens on a different page, so there is no working set
    // on screen to reorder.
    revalidatePath("/companies");
  }
  return result;
}
