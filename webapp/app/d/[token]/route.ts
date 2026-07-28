import type { NextResponse } from "next/server";
import { digestGet, digestPost } from "@/lib/digest/handler";

/**
 * `/d/<token>` — the digest email's one-click landing page.
 *
 * A ROUTE HANDLER AND NOT A PAGE, deliberately. A page component cannot answer a
 * POST, and the whole design of this surface is that the mutation lives on a verb
 * a mail scanner does not use (`lib/digest/handler.ts` explains GET-never-writes
 * at length). Splitting it into a page plus an action would put the render and the
 * write in two files with two different auth stories, when the only credential
 * either of them has is the token in the URL.
 *
 * Nine lines, because Next validates a route module's exports against a closed
 * set and rejects anything else at BUILD time. Everything about what this does,
 * refuses and renders is documented in `lib/digest/handler.ts` and
 * `lib/digest/page.ts`.
 */

export const runtime = "nodejs"; // node:crypto (createHmac, timingSafeEqual), service client
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_request: Request, ctx: Ctx): Promise<NextResponse> {
  const { token } = await ctx.params;
  return digestGet(token);
}

export async function POST(request: Request, ctx: Ctx): Promise<NextResponse> {
  const { token } = await ctx.params;
  return digestPost(request, token);
}
