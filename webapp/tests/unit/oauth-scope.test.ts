import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The OAuth scope surface, pinned (#196; DEC-002; FP-ID-009).
 *
 * Sign-in must request IDENTITY and nothing else. The only way this app could
 * ever ask for somebody's mail is a `scopes` option (or a `queryParams` scope
 * smuggle) on the one `signInWithOAuth` call — so the absence of both is
 * asserted here, over the source, the way `service-key-containment.test.ts`
 * pins the service key to one file. CLAUDE.md's rule is absolute: no Gmail
 * mail scopes, ever, at the pilot.
 *
 * TWO HALVES, because each is vacuous alone:
 *   * the call-site half proves the ONE call carries no scope option — but
 *     would miss a second call site added elsewhere;
 *   * the census half proves there IS exactly one call site — so the first
 *     half is exhaustive, not anecdotal.
 *
 * The hosted half of the same criterion — the Supabase dashboard's Google
 * provider config and the consent screen it produces — cannot be asserted from
 * this repo. That audit is owner-gated evidence named in #196; this file is
 * the in-repo oracle that would catch the code-side regression.
 *
 * MUTATION TARGETS:
 *   * add `scopes: "..."` to the signInWithOAuth options   -> the no-scopes case;
 *   * add `queryParams: { scope: ... }`                     -> the same case;
 *   * add a second signInWithOAuth call site anywhere       -> the census;
 *   * name a Gmail scope URL anywhere in product source     -> the sweep.
 */

const WEBAPP = process.cwd();
const LOGIN_PAGE = "app/login/page.tsx";

/**
 * Product source: what ships in a bundle. Tests are not it — this file itself
 * says "signInWithOAuth" and would trip its own census.
 *
 * The webapp ROOT's own .ts files are included (non-recursively), and that is
 * the #235 security review's finding, fixed rather than argued with: the first
 * census walked only these three directories, so a call site planted in
 * `middleware.ts` — which runs on every request — sat outside the pin
 * entirely. The root files are named into the census by the anchor test below,
 * so a future refactor that drops them fails there rather than silently.
 */
const PRODUCT_DIRS = ["app", "lib", "components"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const ROOT_FILES = readdirSync(WEBAPP).filter(
  (entry) => /\.(ts|tsx)$/.test(entry) && !statSync(join(WEBAPP, entry)).isDirectory(),
);

const FILES = PRODUCT_DIRS.flatMap((d) => walk(join(WEBAPP, d)))
  .map((p) => relative(WEBAPP, p).split(sep).join("/"))
  .concat(ROOT_FILES);
const read = (p: string) => readFileSync(join(WEBAPP, p), "utf8");

/**
 * The balanced-paren argument text of `signInWithOAuth(...)`.
 *
 * Comments are stripped from the WHOLE source before the call is even looked
 * for, and the order is load-bearing: the login page's header comment quotes
 * `signInWithOAuth({provider:"google"})` in prose, and an extraction that ran
 * first would pin that quotation instead of the code. Measured — the scope
 * mutation stayed green until the strip moved up front.
 */
function callArguments(source: string): string {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const start = stripped.indexOf("signInWithOAuth(");
  expect(start, "the call site this file pins must exist").toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = start + "signInWithOAuth".length; i < stripped.length; i++) {
    if (stripped[i] === "(") depth++;
    else if (stripped[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, "the call must close").toBeGreaterThan(start);
  return stripped.slice(start, end + 1);
}

describe("the one sign-in call requests identity only", () => {
  const args = callArguments(read(LOGIN_PAGE));

  it("names the google provider", () => {
    expect(args).toMatch(/provider:\s*"google"/);
  });

  it("passes NO scopes option — Supabase's identity-only default is the request", () => {
    // KILLED BY: `scopes: "https://mail.google.com/"` (or any scopes key) in
    // the options object. This is the only code-side channel to a wider
    // consent screen, and DEC-002 closes it permanently.
    expect(args).not.toMatch(/\bscopes\s*:/);
  });

  it("passes no queryParams either — the other channel a scope could ride in on", () => {
    // Google also accepts `scope` as a raw authorize-URL query parameter, which
    // supabase-js forwards from `options.queryParams`. Nothing here needs any
    // query parameter, so the absence of the whole key is the cheapest pin.
    expect(args).not.toMatch(/\bqueryParams\b/);
  });
});

describe("the census that makes the pin exhaustive", () => {
  it("found the product tree at all — including the webapp root", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(50);
    expect(FILES).toContain(LOGIN_PAGE);
    // The anchor for the #235 review fix: middleware.ts lives at the webapp
    // root, outside app/lib/components, and it MUST be inside this census —
    // it runs on every request, which makes it the best place to hide a call.
    expect(FILES).toContain("middleware.ts");
  });

  it("signInWithOAuth has exactly one call site: the login page", () => {
    const sites = FILES.filter((p) => read(p).includes("signInWithOAuth"));
    expect(sites).toEqual([LOGIN_PAGE]);
  });

  it("no Gmail scope URL appears anywhere in product source", () => {
    // Comments may say "Gmail" (the capture lane talks about the Apps Script
    // constantly), and fixture rows legitimately LINK to Gmail messages
    // (`https://mail.google.com/mail/u/0/#inbox/…` is a permalink, not a
    // permission). A SCOPE is one of three exact forms: the bare origin as a
    // whole string literal (Google's full-access mail scope), a
    // `googleapis.com/auth/gmail.*` path, or a bare `gmail.<grant>` token.
    const offenders = FILES.filter((p) =>
      /https:\/\/mail\.google\.com\/?["'`]|googleapis\.com\/auth\/gmail|\bgmail\.(readonly|modify|send|compose|labels|metadata|insert|settings)\b/i.test(
        read(p),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
