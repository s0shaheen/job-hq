import type { NextResponse } from "next/server";
import { handleWarmStart } from "@/lib/warm/handler";
import { refuseUnlessEntitled } from "@/lib/auth/api-guard";

/**
 * `POST /api/warm/start` — reserve a warm search and kick off the vendor run.
 *
 * A route handler, not a server action, for `/api/import/upload`'s reason plus one:
 * the browser polls `GET /api/warm/[id]` afterwards, and a GET poll wants a route.
 * Everything it does — cap enforcement, the vendor start, the failed-row-on-throw —
 * is in `lib/warm/handler.ts`, which the unit suite drives with a fake vendor.
 */
export const runtime = "nodejs"; // the vendor fetch + service-free session client
export const dynamic = "force-dynamic";

/**
 * The entitlement gate runs FIRST, before the id is even resolved (migration 0027).
 *
 * `lib/warm/handler.ts` reaches `getDataSource()`, which refuses a pending account
 * — but it refuses by THROWING, several frames in and after the handler has begun
 * its work, and a route that answers 500 tells the client to retry. This route is
 * also the most expensive surface in the product: `handleWarmStart` reserves a
 * harvestapi search, so "not turned on" has to be decided before any vendor round
 * trip, not by an exception unwinding out of one.
 *
 * It is also what `tests/unit/entitlement-default-deny.test.ts` requires of every
 * handler in `app/api/**`, and that sweep reads THIS file rather than following
 * the delegation into `lib/warm/` — deliberately, because a check it cannot see is
 * a check the next person deleting a line cannot see either.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const refused = await refuseUnlessEntitled();
  if (refused) return refused;
  return handleWarmStart(request);
}
