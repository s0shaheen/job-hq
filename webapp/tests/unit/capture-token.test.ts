// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBearer, parseToken, secretDigest, verifySecret } from "@/lib/capture/token";

/**
 * The bearer credential: parsed, digested, compared.
 *
 * NODE ENVIRONMENT, deliberately: `node:crypto`'s `timingSafeEqual` is the thing
 * under test and jsdom is not where it lives.
 *
 * THE GOLDEN PAIR. `tests/fixtures/capture-token.golden.json` holds one secret
 * and its SHA-256, and it is asserted from BOTH sides of the wire — here against
 * `secretDigest`, and in `tests/db/test_capture.py` against Postgres's own
 * `encode(sha256(convert_to(…, 'UTF8')), 'hex')`. The two implementations of "the
 * digest of this token" are the only thing standing between a minted credential
 * and a 401 nobody can explain, and a comment saying "keep them in step" is not a
 * mechanism (matrix rows 92, 130, 163's family).
 *
 * MUTATION TARGETS:
 *   * `update(secret, "utf8")` -> `update(secret)`   still green (same bytes for
 *     hex input) — which is WHY the golden is shared with SQL rather than
 *     self-generated: only a cross-language pin can catch an encoding change.
 *   * `timingSafeEqual` -> `===`                     the compare-runs-anyway test
 *                                                    survives, so it is asserted
 *                                                    by reading the source too
 *   * drop the `stored ?? ABSENT` fallback           the unknown-selector test
 *                                                    throws instead of answering
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const GOLDEN = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "capture-token.golden.json"), "utf8"),
) as { secret: string; sha256: string; token: string; selector: string };

describe("the token format", () => {
  it("splits the golden token into its two halves", () => {
    const parsed = parseToken(GOLDEN.token);
    expect(parsed).toEqual({ selector: GOLDEN.selector, secret: GOLDEN.secret });
  });

  it("refuses every near miss", () => {
    for (const bad of [
      "",
      GOLDEN.secret, // the secret alone
      `hqc_${GOLDEN.selector}_${GOLDEN.secret.slice(0, 63)}`, // one hex short
      `hqc_${GOLDEN.selector}_${GOLDEN.secret}x`,
      `hqc_${GOLDEN.selector.toUpperCase()}_${GOLDEN.secret}`, // hex is lowercase
      `HQC_${GOLDEN.selector}_${GOLDEN.secret}`,
      ` hqc_${GOLDEN.selector}_${GOLDEN.secret}`,
      `hqc_${GOLDEN.selector}_${GOLDEN.secret}\n`,
      `hqc_${GOLDEN.selector}_${GOLDEN.secret.replace("a", "g")}`, // not hex
    ]) {
      expect(parseToken(bad), `accepted ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("reads the Authorization header, scheme case-insensitively", () => {
    expect(parseBearer(`Bearer ${GOLDEN.token}`)?.selector).toBe(GOLDEN.selector);
    expect(parseBearer(`bearer ${GOLDEN.token}`)?.selector).toBe(GOLDEN.selector);
    expect(parseBearer(`BEARER  ${GOLDEN.token}`)?.selector).toBe(GOLDEN.selector);
  });

  it("refuses every other way a header can be wrong", () => {
    for (const header of [
      null,
      "",
      GOLDEN.token, // no scheme
      `Basic ${GOLDEN.token}`,
      `Bearer${GOLDEN.token}`, // no space
      `Bearer ${GOLDEN.token} extra`,
    ]) {
      expect(parseBearer(header), `accepted ${JSON.stringify(header)}`).toBeNull();
    }
  });
});

describe("the digest", () => {
  it("matches the golden, which SQL is held to as well", () => {
    expect(secretDigest(GOLDEN.secret)).toBe(GOLDEN.sha256);
  });

  it("verifies the right secret and refuses the neighbours", () => {
    expect(verifySecret(GOLDEN.sha256, GOLDEN.secret)).toBe(true);
    // One character different, in the first position and the last: a compare
    // that returned early on a prefix match would pass one of these.
    expect(verifySecret(GOLDEN.sha256, `f${GOLDEN.secret.slice(1)}`)).toBe(false);
    expect(verifySecret(GOLDEN.sha256, `${GOLDEN.secret.slice(0, 63)}f`)).toBe(false);
  });

  it("answers false — not throws — when there is no row for the selector", () => {
    // The unknown-selector path runs the SAME comparison against a digest no
    // secret produces, so "does this selector exist" is not readable off the
    // clock. An early `return false` would be the enumeration oracle.
    expect(verifySecret(null, GOLDEN.secret)).toBe(false);
  });

  it("answers false rather than throwing on a malformed stored digest", () => {
    // 0018's CHECK makes this unreachable through the store. It is asserted
    // anyway because `timingSafeEqual` THROWS on differing lengths, and a 500
    // from a credential check is an outage dressed as a bug report.
    expect(verifySecret("deadbeef", GOLDEN.secret)).toBe(false);
    expect(verifySecret("", GOLDEN.secret)).toBe(false);
    // THE ONE THAT ACTUALLY THREW, and which the first version of this test
    // missed: 64 characters of NON-HEX. The guard used to compare string
    // lengths — 64 === 64, straight through — while `timingSafeEqual` compares
    // BUFFER lengths and `Buffer.from(s, "hex")` truncates at the first invalid
    // pair, so it met a 0-byte buffer against a 32-byte one and raised. Found in
    // review; every other case here passes the string-length guard too, which is
    // why that mutant survived until this line existed.
    expect(verifySecret("z".repeat(64), GOLDEN.secret)).toBe(false);
    expect(verifySecret("deadbeef".repeat(8) + "zz", GOLDEN.secret)).toBe(false);
    // Uppercase hex still verifies: a hex decode is case-insensitive, and a
    // stored digest that shouted is still the same digest.
    expect(verifySecret(GOLDEN.sha256.toUpperCase(), GOLDEN.secret)).toBe(true);
  });

  it("really uses timingSafeEqual", () => {
    // A behavioural test cannot tell a constant-time compare from `===` without
    // timing measurements, which are exactly the flaky test this suite refuses
    // to add. So the mechanism is asserted where it is legible: in the source.
    // `===` passes every other test in this file.
    const src = readFileSync(path.join(REPO, "webapp", "lib", "capture", "token.ts"), "utf8");
    expect(src).toMatch(/timingSafeEqual\(/);
    expect(src).not.toMatch(/expected === presented|presented === expected/);
  });
});
