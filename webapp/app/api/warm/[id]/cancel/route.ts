import type { NextResponse } from "next/server";
import { handleWarmCancel } from "@/lib/warm/handler";

/**
 * `POST /api/warm/[id]/cancel` — abort the vendor run AND flip the row to
 * cancelled. Idempotent; a cancel of an already-finished run is a no-op, not an
 * error (the handler explains the order: abort first, then flip).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, ctx: Ctx): Promise<NextResponse> {
  const { id } = await ctx.params;
  return handleWarmCancel(id);
}
