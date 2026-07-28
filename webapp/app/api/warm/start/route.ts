import type { NextResponse } from "next/server";
import { handleWarmStart } from "@/lib/warm/handler";

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

export async function POST(request: Request): Promise<NextResponse> {
  return handleWarmStart(request);
}
