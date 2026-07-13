// GET  /api/file?which=base|design           -> { which, path, content, sha, repo, branch }
// PUT  /api/file { which, sha, label?, contentString | structuredOps }
//   structuredOps: fetch fresh, verify sha (409 on drift), replay ops through
//   the yaml Document API (comments survive), commit.
//   contentString: parse-validate only, then commit the string byte-for-byte.
// Middleware already gates /api/*; routes re-check the cookie anyway so an
// accidental matcher change can never leave the GitHub token driveable.

import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, verifyToken } from "../../../lib/auth";
import { GitHubError, getFile, putFile, repoConfig, type Which } from "../../../lib/github";
import { applyOps, invalidOps, yamlError, type Op } from "../../../lib/yamlops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_BYTES = 1_000_000;

async function authed(req: NextRequest): Promise<boolean> {
  return verifyToken(process.env.EDITOR_PASSCODE, req.cookies.get(AUTH_COOKIE)?.value);
}

function isWhich(x: unknown): x is Which {
  return x === "base" || x === "design";
}

function errResponse(e: unknown): NextResponse {
  if (e instanceof GitHubError) {
    return NextResponse.json({ error: e.stale ? "stale" : "github", message: e.message }, { status: e.status });
  }
  return NextResponse.json({ error: "internal", message: (e as Error).message }, { status: 500 });
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const which = req.nextUrl.searchParams.get("which");
  if (!isWhich(which)) return NextResponse.json({ error: "which must be base|design" }, { status: 400 });
  try {
    const { repo, branch } = repoConfig();
    const f = await getFile(which);
    return NextResponse.json({ which, path: f.path, content: f.content, sha: f.sha, repo, branch });
  } catch (e) {
    return errResponse(e);
  }
}

type PutBody = {
  which?: unknown;
  sha?: unknown;
  label?: unknown;
  contentString?: unknown;
  structuredOps?: unknown;
};

export async function PUT(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const { which, sha } = body;
  if (!isWhich(which)) return NextResponse.json({ error: "which must be base|design" }, { status: 400 });
  if (typeof sha !== "string" || !sha) return NextResponse.json({ error: "sha required" }, { status: 400 });
  const hasRaw = body.contentString !== undefined;
  const hasOps = body.structuredOps !== undefined;
  if (hasRaw === hasOps) {
    return NextResponse.json({ error: "exactly one of contentString | structuredOps" }, { status: 400 });
  }

  try {
    let next: string;
    if (hasOps) {
      const bad = invalidOps(body.structuredOps);
      if (bad) return NextResponse.json({ error: "bad_ops", message: bad }, { status: 400 });
      const cur = await getFile(which);
      if (cur.sha !== sha) {
        return NextResponse.json(
          { error: "stale", message: "File changed on GitHub since you loaded it — reload before publishing." },
          { status: 409 },
        );
      }
      try {
        next = applyOps(cur.content, body.structuredOps as Op[]);
      } catch (e) {
        // Ops didn't fit the file — client model diverged. Nothing written.
        return NextResponse.json({ error: "ops_failed", message: (e as Error).message }, { status: 422 });
      }
    } else {
      if (typeof body.contentString !== "string" || body.contentString.length === 0) {
        return NextResponse.json({ error: "contentString must be a non-empty string" }, { status: 400 });
      }
      if (Buffer.byteLength(body.contentString, "utf-8") > MAX_CONTENT_BYTES) {
        return NextResponse.json({ error: "content too large" }, { status: 413 });
      }
      const parseErr = yamlError(body.contentString);
      if (parseErr) return NextResponse.json({ error: "invalid_yaml", message: parseErr }, { status: 400 });
      next = body.contentString;
    }

    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "phone edit";
    const r = await putFile(which, next, sha, `resume: ${label}`);
    // Echo the committed text so the client resyncs its baseline without a refetch.
    return NextResponse.json({
      ok: true,
      which,
      content: next,
      fileSha: r.fileSha,
      commitSha: r.commitSha,
      commitUrl: r.commitUrl,
    });
  } catch (e) {
    return errResponse(e);
  }
}
