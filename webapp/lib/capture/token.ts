import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The bearer credential `/api/capture` authenticates with, parsed and verified.
 *
 * Node's crypto only — no `server-only` marker, because this file has no
 * database, no request and no Next import, and the unit suite verifies real
 * tokens against real digests rather than against a stand-in. `node:crypto` is
 * itself the containment: a client bundle importing it does not build.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SHAPE, AND WHY IT IS TWO HALVES
 *
 *     hqc_<16 hex selector>_<64 hex secret>
 *
 * The store holds the selector in the clear and only the SHA-256 of the secret
 * (0018). So verification is: find the row by SELECTOR, then compare digests in
 * constant time. The obvious one-part alternative — hash the whole token and look
 * the row up by its digest — is a perfectly good design that ends with Postgres's
 * `=` on a b-tree index doing the comparison, which is neither constant-time nor
 * ours, and leaves nothing a test can point at. The selector is public by
 * construction; indexing it leaks nothing.
 *
 * SHA-256 rather than bcrypt/argon2 is argued in the migration: the secret is 244
 * bits of `gen_random_uuid()`, there is no dictionary to slow down, and what the
 * digest buys is that a database dump is not a set of live credentials.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NO USER ENUMERATION, IN THE ONE WAY THAT ACTUALLY MATTERS HERE
 *
 * Every failure — absent header, wrong scheme, malformed token, unknown selector,
 * wrong secret, revoked row — is the same 401 with the same sentence. And
 * `verifySecret` performs its digest and comparison even when there is NO row, so
 * "this selector exists" is not answerable from how long the handler took. The DB
 * round trip dominates that measurement anyway; doing it right costs one dummy
 * buffer and removes the argument.
 */

/** `hqc_` + 16 hex + `_` + 64 hex. Anchored: no prefix, no suffix, no whitespace. */
const TOKEN_RE = /^hqc_([0-9a-f]{16})_([0-9a-f]{64})$/;

export type ParsedToken = { selector: string; secret: string };

/**
 * The `Authorization` header, or null.
 *
 * Case-insensitive on the SCHEME (RFC 7235 says it is) and exact on the token —
 * a token that only works when you lowercase it is a token somebody will
 * eventually paste with a stray capital and spend an afternoon on.
 */
export function parseBearer(header: string | null): ParsedToken | null {
  if (!header) return null;
  const m = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  return parseToken(m[1]);
}

export function parseToken(raw: string): ParsedToken | null {
  const m = TOKEN_RE.exec(raw);
  if (!m) return null;
  return { selector: m[1], secret: m[2] };
}

/** The digest the store holds: hex SHA-256 of the secret half's UTF-8 bytes. */
export function secretDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * A digest that no secret produces, for the no-row path.
 *
 * 64 zeroes is a legal hex digest and `sha256(x) == 0…0` for no x anybody will
 * find, so comparing against it is safe AND takes the same code path — which is
 * the whole point of having it rather than an early `return false`.
 */
const ABSENT = "0".repeat(64);

/**
 * Constant-time comparison of the presented secret against a stored digest.
 *
 * `stored === null` means the selector matched no row; the comparison still runs
 * against `ABSENT`.
 *
 * `timingSafeEqual` THROWS on differing lengths, which would turn a malformed
 * stored digest into a 500 — so the length is checked first, and that check is
 * safe to short-circuit because the stored length is not attacker-controlled
 * (0018's CHECK pins it at 64 hex).
 */
export function verifySecret(stored: string | null, secret: string): boolean {
  const expected = stored ?? ABSENT;
  const presented = secretDigest(secret);
  // The SHAPE, not the string length. The first version compared
  // `expected.length` — a string count — while `timingSafeEqual` compares BUFFER
  // lengths, and `Buffer.from(s, "hex")` truncates at the first invalid pair. So
  // 64 characters of non-hex decoded to zero bytes, the guard waved it through,
  // and the compare THREW: a 500 out of a credential check, which is an outage
  // wearing a bug report's clothes. Found in review; unreachable through the
  // store (0018's `capture_tokens_digest_shape`) and one line to close forever.
  //
  // Safe to short-circuit because `stored` is a column value, never anything a
  // caller supplies — the timing-sensitive comparison is the one below it.
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(presented, "hex"));
}
