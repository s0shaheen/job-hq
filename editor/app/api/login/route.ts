import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, SESSION_DAYS, makeToken, passcodeMatches } from "../../../lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = process.env.EDITOR_PASSCODE;
  if (!secret) {
    return NextResponse.json({ error: "EDITOR_PASSCODE is not configured on the server" }, { status: 500 });
  }
  let passcode = "";
  try {
    const body = (await req.json()) as { passcode?: unknown };
    if (typeof body.passcode === "string") passcode = body.passcode;
  } catch {
    /* fall through to failure */
  }
  if (!passcode || !(await passcodeMatches(passcode, secret))) {
    // Small fixed delay blunts brute force; entropy of the passcode is the real defense.
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: "wrong passcode" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await makeToken(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return res;
}
