import type { NextResponse } from "next/server";
import { handleWarmPoll } from "@/lib/warm/handler";
import { refuseUnlessEntitled } from "@/lib/auth/api-guard";

/**
 * `GET /api/warm/[id]` — poll one warm search, advancing the vendor run.
 *
 * Each call is a short function (one Apify round trip), which is what keeps the
 * async lifecycle Vercel-safe: there is no long-held connection, the row carries
 * the state, and the browser polls until `status` is terminal.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

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
export async function GET(_request: Request, ctx: Ctx): Promise<NextResponse> {
  const refused = await refuseUnlessEntitled();
  if (refused) return refused;
  const { id } = await ctx.params;
  return handleWarmPoll(id);
}
