import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DEFAULT DENY, asserted structurally: a surface added next month is refused for
 * an account that is not turned on unless somebody deliberately exempts it here.
 *
 * The behavioural tests next door prove the gate works on the routes that exist
 * TODAY. Neither of them can prove anything about the route somebody writes in
 * six weeks, and that is the failure this whole model is exposed to: the gate is
 * correct, and one new endpoint quietly sits outside it. `/api/capture` is the
 * precedent in this exact codebase — a route shipped outside a list it needed to
 * be on, green through the unit suite, the route suite and the db suite, and
 * broken in production from day one (`lib/supabase/middleware.ts`).
 *
 * So the rule is enforced over the FILE TREE rather than over a hand-kept list of
 * paths:
 *
 *   * every route handler must reach a gate — `getDataSource()` (which throws for
 *     a pending account) or the explicit `refuseUnlessEntitled()`;
 *   * every `"use server"` module must reach `getDataSource()`;
 *   * the exemptions are enumerated with reasons and asserted EXACT in both
 *     directions, the `KNOWN_UNNAMED_REVOKES` shape: a new file cannot join the
 *     exempt set silently, and a file that stops needing its exemption fails
 *     until the line is deleted.
 */

const WEBAPP = process.cwd();
const APP = join(WEBAPP, "app");

function walk(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(entry)) out.push(full);
  }
  return out;
}

const posix = (p: string) => relative(WEBAPP, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8");

const ROUTE_HANDLERS = walk(APP, (f) => f === "route.ts").map(posix).sort();
const SERVER_ACTION_FILES = walk(join(WEBAPP, "app"), (f) => f.endsWith(".ts"))
  .concat(walk(join(WEBAPP, "lib"), (f) => f.endsWith(".ts")))
  .filter((p) => read(p).startsWith('"use server"'))
  .map(posix)
  .sort();

/** Reaching either of these means the request is refused for a pending account. */
function isGated(source: string): boolean {
  return source.includes("getDataSource(") || source.includes("refuseUnlessEntitled(");
}

/**
 * Route handlers that legitimately do NOT consult the session's entitlement, and
 * why. Each authenticates its own caller with a credential this app minted and
 * acts for a user whose browser is not involved — gating them on a session's
 * entitlement would be gating them on a session they do not have.
 *
 * Asserted exact in both directions below.
 */
const UNGATED_ROUTES: Record<string, string> = {
  "app/api/capture/route.ts":
    "bearer token (SHA-256 in capture_tokens); the caller is a Gmail Apps Script with no cookie",
  "app/d/[token]/route.ts":
    "HMAC-signed digest link; the caller is a mail client's in-app browser with no cookie",
  "app/auth/callback/route.ts":
    "the PKCE exchange that CREATES the session — an entitlement cannot exist before it runs",
  "app/auth/signout/route.ts":
    "signing out has to work from the holding surface, which is the whole point of it",
  "app/api/email/dispatch/route.ts":
    "bearer CRON_SECRET (constant-time, 503 when unconfigured); the caller is a cron " +
    "tick or the operator's curl, acting on SQL-editor activations for users whose " +
    "browsers are not involved",
};

describe("every route handler is behind the entitlement gate", () => {
  it("found the route handlers at all", () => {
    // Guards every case below from vacuously passing on zero files.
    expect(ROUTE_HANDLERS.length).toBeGreaterThanOrEqual(8);
    expect(ROUTE_HANDLERS).toContain("app/api/export/route.ts");
  });

  it.each(ROUTE_HANDLERS.filter((p) => !(p in UNGATED_ROUTES)))("%s", (path) => {
    expect(
      isGated(read(join(WEBAPP, path))),
      `${path} reaches neither getDataSource() nor refuseUnlessEntitled() — an ` +
        `account that is not turned on can drive it. Gate it, or add it to ` +
        `UNGATED_ROUTES with the credential it authenticates its own caller with.`,
    ).toBe(true);
  });

  it("the exemption list is exact in both directions", () => {
    // A list that drifts is a list that hides the next offender. Fixing one means
    // deleting its line; a new ungated route cannot land inside it.
    const actuallyUngated = ROUTE_HANDLERS.filter((p) => !isGated(read(join(WEBAPP, p))));
    expect(actuallyUngated.sort()).toEqual(Object.keys(UNGATED_ROUTES).sort());
  });
});

describe("every server action module is behind the entitlement gate", () => {
  it("found the action modules at all", () => {
    expect(SERVER_ACTION_FILES.length).toBeGreaterThanOrEqual(8);
    expect(SERVER_ACTION_FILES).toContain("app/(app)/queue/actions.ts");
  });

  it.each(SERVER_ACTION_FILES)("%s", (path) => {
    // A server action is publicly invokable by anyone with a session — the
    // middleware redirect in front of the page is not the boundary, the data
    // layer is. Every one of these resolves its source through the choke point.
    expect(
      read(join(WEBAPP, path)).includes("getDataSource("),
      `${path} exports server actions that never resolve a data source, so the ` +
        `refusal in getDataSource() never runs for them`,
    ).toBe(true);
  });
});

describe("the two ends of the gate", () => {
  it("the app shell redirects a refused account instead of swallowing the throw", () => {
    // `(app)/layout.tsx` catches everything and falls back to rendering the shell
    // with no counts. Without the explicit branch, that fallback would paint the
    // entire app for somebody the data layer just turned away.
    const layout = read(join(APP, "(app)", "layout.tsx"));
    expect(layout).toMatch(/isNotEntitled\(err\)/);
    expect(layout).toMatch(/redirect\("\/pending"\)/);
    // Duck-typed, never instanceof: separate server bundles hold separate copies
    // of the class object.
    expect(layout).not.toMatch(/instanceof NotEntitledError/);
  });

  it("the holding surface does NOT go through the data source", () => {
    // It cannot: `getDataSource()` refuses a pending account, so a page that used
    // it to explain the refusal could never render. This is the one page in the
    // app for which reaching the choke point is the bug.
    const page = read(join(APP, "pending", "page.tsx"));
    expect(page).not.toMatch(/getDataSource\(/);
    expect(page).toMatch(/getSessionEntitlement\(/);
  });

  it("the data layer is the only place that decides, and it fails closed", () => {
    const src = read(join(WEBAPP, "lib", "data", "get-source.ts"));
    // The refusal lives on the resolve path, not in a helper somebody can skip.
    expect(src).toMatch(/throw new NotEntitledError/);
    // `unreadable` must refuse here even though middleware lets it through.
    expect(src).toMatch(/read\.kind !== "ok"/);
  });
});
