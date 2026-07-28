import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { safeHref } from "@/lib/url/safe-href";

/**
 * The href guard, held to the SHARED case list.
 *
 * `tests/fixtures/safe-href-cases.json` is the one authority (see the file's own
 * header and `lib/url/safe-href.ts`). `tests/core/test_safe_href_parity.py` runs
 * the Python twin against the same file, so a divergence between the guard the
 * store trusts and the guard the email trusts fails one of the two — which is the
 * C2 review's M6, made unrepeatable.
 *
 * MUTATION TARGETS:
 *   * drop the backslash from FORBIDDEN_CHARS   -> the `evil.com\@good.com` case;
 *   * drop the `%` authority check              -> the `%40` case;
 *   * drop the empty-authority check            -> the `https:///nohost` case;
 *   * check `@` in the whole URL, not authority -> the `/@handle` path case.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CASES: { cases: { in: string; out: string; why: string }[] } = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "safe-href-cases.json"), "utf8"),
);

describe("safeHref, against the shared fixture", () => {
  for (const c of CASES.cases) {
    it(`${JSON.stringify(c.in)} -> ${JSON.stringify(c.out)} (${c.why})`, () => {
      expect(safeHref(c.in)).toBe(c.out);
    });
  }

  it("handles null and undefined without throwing", () => {
    expect(safeHref(null)).toBe("");
    expect(safeHref(undefined)).toBe("");
  });

  it("covers the whole corpus (a fixture that shrank silently is a guard that stopped being tested)", () => {
    expect(CASES.cases.length).toBeGreaterThanOrEqual(30);
  });
});
