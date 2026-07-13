// Auth gate for every page and API route. No valid signed cookie: pages
// bounce to /login, APIs get 401. Fail-closed — a missing EDITOR_PASSCODE
// means nothing verifies and everything bounces.

import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, verifyToken } from "./lib/auth";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();

  const ok = await verifyToken(process.env.EDITOR_PASSCODE, req.cookies.get(AUTH_COOKIE)?.value);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
