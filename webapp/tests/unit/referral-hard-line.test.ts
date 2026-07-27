import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE HARD LINE, as a gate rather than as a comment.
 *
 * `docs/plans/REFERRAL-FINDER.md`'s risk ladder is the architecture of this
 * feature, not a phase order:
 *
 *   layer 0  deep links the person clicks in their own session, plus the
 *            official CSV export — zero risk.
 *   layer 1  vendor APIs that never touch their session — later, if ever.
 *   layer ∞  their `li_at` cookie, a page-reading extension, messaging-as-them
 *            — never built, permanently. Not a v2.
 *
 * Enforcement is suspension-first (hiQ ended with the ToS held enforceable;
 * Proxycurl, a $10M-ARR vendor, chose shutdown over the fight; HeyReach and its
 * USERS' accounts were banned), and the account those links open is the delivery
 * channel for the whole referral play. So a single well-meaning `fetch` added to
 * this feature two phases from now — an "enrich this company" button, a
 * favicon, a preview card — is not a bug to fix later. It is the feature ending.
 *
 * Every file this guards currently says so in prose, and prose is what a
 * refactor deletes. `referral.spec.ts` argues in its own preamble that a string
 * test is the only thing that survives a redesign; this is that argument applied
 * to the constraint the whole feature is shaped by, and the suite already uses
 * source-text pins for weaker claims.
 *
 * WHAT THIS IS NOT: a security boundary. Somebody determined to add a fetch can
 * delete this file in the same commit. It is a tripwire — the thing that makes a
 * reviewer look, and makes the deletion a deliberate act with a diff beside it
 * rather than an omission nobody noticed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(HERE, "..", "..");

/**
 * The files that must never reach the network, and why each one is on the list.
 *
 * `lib/referral/` minus `actions.ts`: the actions module is a `"use server"`
 * boundary that calls THIS app's own data source, which is the same-origin write
 * path every other surface uses. It is listed separately below with its own,
 * narrower rule.
 */
const PURE: string[] = [
  "lib/referral/linkedin.ts",
  "lib/referral/match.ts",
  "lib/referral/connections.ts",
  "components/warm-cell.tsx",
  "lib/data/connection-fixtures.ts",
];

/**
 * Anything that opens a socket, resolves a host, or asks the browser to fetch a
 * byte on the page's behalf.
 *
 * `<img`/`background-image`/`new Image` are on the list deliberately and are the
 * ones a reviewer would not think of: rendering a company's LinkedIn logo is an
 * automated request to linkedin.com carrying the user's cookies, made by every
 * row of the grid, without anybody calling it scraping. `preconnect` and
 * `dns-prefetch` are here for the same reason one step earlier.
 */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /\bfetch\s*\(/, what: "fetch()" },
  { pattern: /\bXMLHttpRequest\b/, what: "XMLHttpRequest" },
  { pattern: /\baxios\b/, what: "axios" },
  { pattern: /\bnavigator\.sendBeacon\b/, what: "sendBeacon" },
  { pattern: /\bnew\s+WebSocket\b/, what: "WebSocket" },
  { pattern: /\bnew\s+EventSource\b/, what: "EventSource" },
  { pattern: /\bnew\s+Image\s*\(/, what: "new Image()" },
  { pattern: /<img[\s>]/i, what: "<img>" },
  { pattern: /\bbackgroundImage\b/, what: "backgroundImage" },
  { pattern: /rel=["'](?:preconnect|dns-prefetch|prefetch|preload)/, what: "a resource hint" },
  { pattern: /\bimport\s*\(\s*["']https?:/, what: "a remote dynamic import" },
];

function read(rel: string): string {
  return readFileSync(path.join(WEBAPP, rel), "utf8");
}

/**
 * Comments stripped before matching.
 *
 * Every one of these files EXPLAINS what it does not do, and several name
 * `fetch` while doing so. A checker that reads prose is a checker that gets
 * worked around by rewording, which is the opposite of what it is for — the same
 * reason `tests/core/test_migrations.py` strips SQL comments before looking for
 * "security definer".
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("layer 0 stays layer 0", () => {
  it("guards files that exist", () => {
    // The guard on the guard. A renamed file makes every check below read an
    // empty string and pass against nothing — the vacuous-pin shape this repo
    // has been bitten by four times (matrix rows 92, 130, 163, 165).
    for (const rel of PURE) {
      expect(() => statSync(path.join(WEBAPP, rel)), `${rel} is gone — update this list`).not.toThrow();
      expect(read(rel).length, `${rel} is empty`).toBeGreaterThan(500);
    }
    expect(PURE.length).toBeGreaterThanOrEqual(5);
  });

  it("the whole lib/referral directory is covered, including files added later", () => {
    // A list of paths goes stale the moment somebody adds `lib/referral/enrich.ts`,
    // and a stale allowlist is worse than none because it is counted. The
    // directory is enumerated and every entry must be either guarded here or
    // named in the one documented exception.
    const dir = path.join(WEBAPP, "lib", "referral");
    const found = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const covered = new Set(PURE.map((p) => path.basename(p)));
    const exempt = new Set(["actions.ts"]);
    for (const f of found) {
      expect(
        covered.has(f) || exempt.has(f),
        `lib/referral/${f} is neither guarded nor exempt — add it to PURE, or to the ` +
          `exception list WITH a reason, because a new file in this directory is exactly ` +
          `where a fetch would arrive`,
      ).toBe(true);
    }
  });

  it.each(PURE)("%s reaches nothing outbound", (rel) => {
    const source = code(read(rel));
    for (const { pattern, what } of FORBIDDEN) {
      expect(
        pattern.test(source),
        `${rel} contains ${what}. The referral finder is layer 0: every LinkedIn URL ` +
          `is an <a href> a PERSON clicks in their own session, and nothing here may ` +
          `perform a request. Read the risk ladder in docs/plans/REFERRAL-FINDER.md ` +
          `before deleting this test.`,
      ).toBe(false);
    }
  });

  it("the guard can fail — it detects each forbidden shape in a sample", () => {
    // Assume your own new test cannot fail until you have watched it. Rather than
    // mutating five source files by hand, the patterns are run against a string
    // that contains every one of them.
    const sample = `
      fetch("https://www.linkedin.com/x");
      new XMLHttpRequest();
      import axios from "axios";
      navigator.sendBeacon("/x");
      new WebSocket("wss://x");
      new EventSource("/x");
      new Image().src = "https://linkedin.com/logo.png";
      <img src="https://linkedin.com/logo.png" />
      style.backgroundImage = "url(https://linkedin.com/logo.png)";
      <link rel="preconnect" href="https://linkedin.com" />
      await import("https://cdn.example/x.js");
    `;
    for (const { pattern, what } of FORBIDDEN) {
      expect(pattern.test(sample), `the ${what} pattern matches nothing`).toBe(true);
    }
    // …and it does not fire on the code these files really contain.
    for (const rel of PURE) {
      for (const { pattern } of FORBIDDEN) expect(pattern.test(code(read(rel)))).toBe(false);
    }
  });

  it("every outbound link is a plain anchor the user clicks", () => {
    // The other half of layer 0: a `next/link` prefetches on hover, which would
    // make the app request linkedin.com without anybody clicking anything. The
    // popover's external links are plain `<a target="_blank" rel="noopener
    // noreferrer">`, and the two internal ones (to /connections) are the only
    // `Link` usages in the file.
    // Comments stripped, for the same reason the FORBIDDEN sweep strips them:
    // the file's own header explains the rule using the words `<a href>`, and a
    // checker that reads prose is one that gets worked around by rewording.
    const cell = code(read("components/warm-cell.tsx"));
    const anchors = cell.match(/<a\b[^>]*>/gs) ?? [];
    expect(anchors.length, "no anchors in warm-cell — the selector broke").toBeGreaterThan(1);
    for (const a of anchors) {
      expect(a, `an outbound anchor without rel=noopener: ${a}`).toContain("noopener noreferrer");
      expect(a).toContain('target="_blank"');
    }
    // No `Link` may carry an absolute URL — that is the prefetch hazard.
    expect(/<Link[^>]*href=\{?["'`]https?:/.test(cell)).toBe(false);
  });

  it("the only network call in the feature is same-origin, and it is the upload", () => {
    // `connections-surface.tsx` does contain a `fetch` and must: it posts the
    // user's own file to THIS app. It is excluded from PURE for that reason and
    // pinned here instead, so "the one fetch" cannot quietly become two, or
    // become one that points somewhere else.
    const surface = code(read("app/(app)/connections/connections-surface.tsx"));
    const calls = surface.match(/fetch\s*\(\s*([^,)]+)/g) ?? [];
    expect(calls, "the upload fetch is gone, or there is more than one").toHaveLength(1);
    expect(calls[0]).toContain('"/api/connections/upload"');
    // Relative, so it cannot be pointed at another origin by a config value.
    expect(/fetch\s*\(\s*["'`]https?:/.test(surface)).toBe(false);
  });
});
