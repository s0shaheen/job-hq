import "server-only";

import { NextResponse } from "next/server";
import { isActive, isNotEntitled, refusedStatus } from "@/lib/auth/entitlement";
import { getSessionEntitlement } from "@/lib/data/get-source";

/**
 * The entitlement refusal, as an HTTP answer (migration 0027).
 *
 * TWO FUNCTIONS BECAUSE THERE ARE TWO KINDS OF ROUTE, and the second kind is why
 * this file exists at all:
 *
 *   * routes that read or write through `getDataSource()` are already refused —
 *     it throws, and `entitlementRefusal` only turns that throw into a 403
 *     instead of the 500 an unhandled one produces. Cosmetic, and worth it: a
 *     500 tells the client to retry and fills the log with a false alarm;
 *   * routes that never resolve a data source at all are refused by NOTHING.
 *     `/api/connections/upload` parses an uploaded CSV and hands the rows back
 *     to the browser without touching the store, so a pending account could
 *     drive it all day. `refuseUnlessEntitled` is that route's gate, and the
 *     shape any future route of the same kind has to wear.
 *
 * `tests/unit/entitlement-default-deny.test.ts` enumerates `app/api/**` and
 * requires every handler to reach one of the two, so a new endpoint that
 * forgets is a red test rather than an open door.
 */

/** 02 §7's error template: what happened, then what happens next. */
const MESSAGE = {
  pending: "This account is not active yet.",
  suspended: "This account is suspended.",
} as const;

function refusal(status: "pending" | "suspended"): NextResponse {
  return NextResponse.json({ error: MESSAGE[status] }, { status: 403 });
}

/**
 * A 403 if `err` is the data layer's refusal, otherwise `null` so the caller's
 * own error handling runs unchanged.
 */
export function entitlementRefusal(err: unknown): NextResponse | null {
  if (!isNotEntitled(err)) return null;
  const status = refusedStatus(err);
  return refusal(status === "suspended" ? "suspended" : "pending");
}

/**
 * A 403 for a route that would otherwise never ask, or `null` to continue.
 *
 * Fails CLOSED on an unreadable entitlement, matching `getDataSource()`: this is
 * the security boundary's half of the gate, not the routing half.
 */
export async function refuseUnlessEntitled(): Promise<NextResponse | null> {
  const read = await getSessionEntitlement();
  if (read.kind !== "ok") return refusal("pending");
  if (isActive(read.entitlement)) return null;
  return refusal(read.entitlement.status === "suspended" ? "suspended" : "pending");
}
