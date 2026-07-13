// GET /api/run-status?sha=<commit sha> — workflow runs for that head_sha via
// the Actions API. `found: false` right after a push is normal (GitHub takes
// a few seconds to create the run); the client keeps polling.

import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, verifyToken } from "../../../lib/auth";
import { GitHubError, runForSha } from "../../../lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ok = await verifyToken(process.env.EDITOR_PASSCODE, req.cookies.get(AUTH_COOKIE)?.value);
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sha = req.nextUrl.searchParams.get("sha");
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return NextResponse.json({ error: "sha query param required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await runForSha(sha));
  } catch (e) {
    if (e instanceof GitHubError) {
      return NextResponse.json({ error: "github", message: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "internal", message: (e as Error).message }, { status: 500 });
  }
}
