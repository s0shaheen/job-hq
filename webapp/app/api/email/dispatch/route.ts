import type { NextResponse } from "next/server";
import { handleEmailDispatch } from "@/lib/email/handler";

/**
 * POST /api/email/dispatch — consume recorded entitlement lifecycle events
 * into transactional email, exactly once each (#203).
 *
 * The adapter shape `/api/capture` argues for: Next validates a route module's
 * exports at build time, so the handler lives in `lib/email/handler.ts` where
 * the unit suite can drive it with real `Request`s against the fixture store.
 * Everything about what this refuses and answers is documented there.
 *
 * GET is the same operation: a Vercel cron entry invokes with GET, an operator
 * with `curl -X POST`. The dispatch is idempotent by ledger, so the verb
 * distinction buys nothing here.
 */

export const runtime = "nodejs"; // node:crypto (timingSafeEqual), service client
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<NextResponse> {
  return handleEmailDispatch(request);
}

export function GET(request: Request): Promise<NextResponse> {
  return handleEmailDispatch(request);
}
