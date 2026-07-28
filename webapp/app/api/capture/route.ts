import type { NextResponse } from "next/server";
import { captureContract, handleCapture } from "@/lib/capture/handler";

/**
 * POST /api/capture — the Gmail Apps Script's classified email events.
 *
 * Four lines, because Next validates a route module's exports against a closed
 * set and rejects anything else at BUILD time ("handleCapture is not a valid
 * Route export field"). The handler has to be exported somewhere the unit suite
 * can reach it — it is driven with real `Request`s against a fake store — so it
 * lives in `lib/capture/handler.ts` and this file is the adapter.
 *
 * Everything about what the endpoint does, refuses, and answers is documented
 * there.
 */

export const runtime = "nodejs"; // node:crypto (timingSafeEqual), service client
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<NextResponse> {
  return handleCapture(request);
}

export function GET(): NextResponse {
  return captureContract();
}
