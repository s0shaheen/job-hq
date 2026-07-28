import type { NextResponse } from "next/server";
import { handleWarmPoll } from "@/lib/warm/handler";

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

export async function GET(_request: Request, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleWarmPoll(id);
}
