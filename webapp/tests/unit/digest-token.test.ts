// @vitest-environment node
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DigestKeyError,
  loadKeys,
  mintDigestToken,
  PURPOSE_ACTION,
  PURPOSE_UNDO,
  UNDO_ACTION,
  UNDO_TTL_SECONDS,
  verifyDigestToken,
} from "@/lib/digest/token";

/**
 * The digest link's credential: minted, verified, and pinned to the OTHER
 * implementation of itself.
 *
 * NODE ENVIRONMENT, deliberately: `node:crypto`'s `createHmac` and
 * `timingSafeEqual` are the things under test and jsdom is not where they live.
 *
 * THE SHARED GOLDEN. `tests/fixtures/digest-token.golden.json` holds one token
 * and it is asserted from BOTH sides of the wire — here against this module, and
 * in `tests/core/test_digest_links.py` against `core/digest_links.py`, which is
 * what the Lambda actually mints with. Neither side derives the value at test
 * time. That is the whole mechanism: two implementations of "the token for this
 * row" agreeing on a constant neither of them generated, because the failure it
 * prevents is a week of links in somebody's inbox that all read as forged, with
 * nothing anywhere saying why.
 *
 * MUTATION TARGETS — each one run red before green:
 *   * `sort_keys` order changed (swap `a` and `e` in `encodePayload`)
 *                                      -> the round-trip test; nothing else moves
 *   * `separators` -> `JSON.stringify` default spacing
 *                                      -> the round-trip test
 *   * drop the `kid` from the signed prefix
 *                                      -> "a token signed under a retired key"
 *   * `timingSafeEqual` -> `===`       -> every behavioural test still passes, so
 *                                         it is asserted by reading the source
 *   * expiry `<=` -> `<`               -> "a token that expires exactly now"
 *   * return `invalid` for an expired token
 *                                      -> "expired is a different answer"
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const GOLDEN = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "digest-token.golden.json"), "utf8"),
) as {
  kid: string;
  secret: string;
  keys_env: string;
  user_id: string;
  posting_key: string;
  action: "interested";
  jti: string;
  expires_at: number;
  payload_json: string;
  token: string;
  tampered_action_token: string;
};

const KEYS = loadKeys(GOLDEN.keys_env);
/** The instant the golden was minted: its expiry, less the 7-day action TTL. */
const MINTED_MS = (GOLDEN.expires_at - 7 * 86400) * 1000;
/** Comfortably inside the window. */
const LIVE_MS = MINTED_MS + 86400 * 1000;

/** A second key, for the rotation cases. 64 hex, well over the 32-char floor. */
const OTHER = { kid: "k2", secret: "9".repeat(64) };

function parts(token: string): [string, string, string, string] {
  const [v, kid, body, sig] = token.split(".");
  return [v, kid, body, sig];
}

describe("the golden", () => {
  it("mints byte-for-byte what core/digest_links.py minted", () => {
    // The `jti` is injectable ONLY so this line can exist: everything else in the
    // token is a pure function of the row, the clock and the key.
    const minted = mintDigestToken(
      { userId: GOLDEN.user_id, postingKey: GOLDEN.posting_key, action: GOLDEN.action },
      { keys: KEYS, now: MINTED_MS, jti: GOLDEN.jti },
    );
    expect(minted).toBe(GOLDEN.token);
  });

  it("encodes the payload the fixture spells out, key order and all", () => {
    // Read back from the token rather than re-derived, so a JSON writer that
    // sorted differently or added a space is caught as a byte difference and not
    // excused as "the same object".
    const [, , body] = parts(GOLDEN.token);
    expect(Buffer.from(body, "base64url").toString("utf8")).toBe(GOLDEN.payload_json);
  });

  it("verifies its own golden and reports every field", () => {
    const verdict = verifyDigestToken(GOLDEN.token, { keys: KEYS, now: LIVE_MS });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.payload).toEqual({
      userId: GOLDEN.user_id,
      postingKey: GOLDEN.posting_key,
      action: "interested",
      purpose: PURPOSE_ACTION,
      expiresAt: GOLDEN.expires_at,
      jti: GOLDEN.jti,
    });
  });
});

describe("tampering", () => {
  it("refuses one flipped character in the PAYLOAD", () => {
    const [v, kid, body, sig] = parts(GOLDEN.token);
    const flipped = (body[0] === "e" ? "f" : "e") + body.slice(1);
    expect(flipped).not.toBe(body);
    expect(verifyDigestToken(`${v}.${kid}.${flipped}.${sig}`, { keys: KEYS, now: LIVE_MS })).toEqual(
      { ok: false, reason: "invalid" },
    );
  });

  it("refuses one flipped character in the SIGNATURE", () => {
    const [v, kid, body, sig] = parts(GOLDEN.token);
    // Both ends, because a comparison that returned early on a prefix match would
    // pass one of them.
    for (const bad of [
      (sig[0] === "A" ? "B" : "A") + sig.slice(1),
      sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A"),
    ]) {
      expect(bad).not.toBe(sig);
      expect(
        verifyDigestToken(`${v}.${kid}.${body}.${bad}`, { keys: KEYS, now: LIVE_MS }),
      ).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses the fixture's action swap — matrix row 27", () => {
    // `interested` edited to `dismissed` in the payload with the ORIGINAL
    // signature left in place: the exact URL edit somebody tries first, and the
    // reason the action is INSIDE the HMAC rather than in a query parameter.
    expect(
      verifyDigestToken(GOLDEN.tampered_action_token, { keys: KEYS, now: LIVE_MS }),
    ).toEqual({ ok: false, reason: "invalid" });
    // Non-vacuity: the tampered token really does carry the other action, so the
    // refusal above is the signature's doing and not a parse failure.
    const [, , body] = parts(GOLDEN.tampered_action_token);
    expect(Buffer.from(body, "base64url").toString("utf8")).toContain('"a":"dismissed"');
  });

  it("refuses every other malformed shape without throwing", () => {
    const [v, kid, body, sig] = parts(GOLDEN.token);
    for (const bad of [
      "",
      "nonsense",
      GOLDEN.token.replace("v1.", "v2."),
      `${v}.${kid}.${body}`, // no signature
      `${v}.${kid}.${body}.${sig}.extra`,
      `${v}.${kid}..${sig}`,
      `${v}.${kid.toUpperCase()}.${body}.${sig}`, // a kid is lowercase
      ` ${GOLDEN.token}`,
      `${GOLDEN.token}\n`,
      `${v}.${kid}.${body}.${sig.slice(0, 42)}`, // one character short
    ]) {
      expect(
        verifyDigestToken(bad, { keys: KEYS, now: LIVE_MS }),
        `accepted ${JSON.stringify(bad)}`,
      ).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses a payload that is signed correctly but is not an object", () => {
    // Reached by signing something this module would never mint: the signature
    // check passes and the SHAPE check has to catch it. Without the shape check a
    // JSON array walks straight into the field reads below it.
    const body = Buffer.from('["interested"]', "utf8").toString("base64url");
    const prefix = `v1.${GOLDEN.kid}.${body}`;
    const sig = createHmac("sha256", Buffer.from(GOLDEN.secret, "utf8"))
      .update(prefix, "ascii")
      .digest("base64url");
    expect(verifyDigestToken(`${prefix}.${sig}`, { keys: KEYS, now: LIVE_MS })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("key rotation", () => {
  it("refuses a token whose kid is not in the ring — the whole revocation story", () => {
    // Retiring a secret is how every outstanding link signed with it dies at
    // once. There is no per-link revocation table (core/digest_links.py records
    // why), so if this passes, nothing revokes anything.
    expect(verifyDigestToken(GOLDEN.token, { keys: [OTHER], now: LIVE_MS })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses a token signed with the RIGHT secret under the WRONG kid", () => {
    // The kid is inside the signed prefix, so the same secret under a different
    // key id produces a different signature. Without that, retiring a kid would
    // retire nothing as long as the secret leaked with it.
    const forged = mintDigestToken(
      { userId: GOLDEN.user_id, postingKey: GOLDEN.posting_key, action: "interested" },
      { keys: [{ kid: "k9", secret: GOLDEN.secret }], now: MINTED_MS, jti: GOLDEN.jti },
    );
    const [, , body, sig] = parts(forged);
    expect(sig).not.toBe(parts(GOLDEN.token)[3]);
    expect(body).toBe(parts(GOLDEN.token)[2]); // same payload, different signature
  });

  it("accepts BOTH keys mid-rotation, newest first", () => {
    const ring = [OTHER, ...KEYS];
    // The old key still verifies the links already in flight...
    expect(verifyDigestToken(GOLDEN.token, { keys: ring, now: LIVE_MS }).ok).toBe(true);
    // ...and the new one is what signs from now on.
    const fresh = mintDigestToken(
      { userId: GOLDEN.user_id, postingKey: GOLDEN.posting_key, action: "dismissed" },
      { keys: ring, now: LIVE_MS },
    );
    expect(parts(fresh)[1]).toBe(OTHER.kid);
    expect(verifyDigestToken(fresh, { keys: ring, now: LIVE_MS }).ok).toBe(true);
    // And the retired-only ring cannot verify what the new key signed.
    expect(verifyDigestToken(fresh, { keys: KEYS, now: LIVE_MS }).ok).toBe(false);
  });

  it("refuses to run at all on an unusable key configuration", () => {
    // Absence would otherwise mean "verify nothing", which is silent. A raise is
    // rendered as "try again" and logged, never as "your link is forged".
    for (const bad of ["", "   ", "nosecret", "k1:short", "k1:" + "a".repeat(32) + ",k1:" + "b".repeat(32), "K1:" + "a".repeat(32)]) {
      expect(() => loadKeys(bad), `accepted ${JSON.stringify(bad)}`).toThrow(DigestKeyError);
    }
    expect(loadKeys(GOLDEN.keys_env)).toEqual([{ kid: GOLDEN.kid, secret: GOLDEN.secret }]);
  });
});

describe("expiry", () => {
  it("is a DIFFERENT answer from invalid, and it carries the payload", () => {
    // The rendered copy for expired names the date and the posting; the copy for
    // forged is one sentence and says nothing. That is only safe because an
    // expired token had a VALID signature — so the distinction lives here, in the
    // verifier, and never leaks into the invalid path.
    const verdict = verifyDigestToken(GOLDEN.token, { keys: KEYS, now: (GOLDEN.expires_at + 1) * 1000 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("expired");
    expect(verdict).toHaveProperty("payload.postingKey", GOLDEN.posting_key);
  });

  it("expires ON the second, not after it", () => {
    // `<=`, mirroring `core/digest_links.py`. A `<` here and a `<=` there is one
    // second of disagreement about whether a link works, which is exactly the
    // kind of divergence a golden cannot catch.
    expect(verifyDigestToken(GOLDEN.token, { keys: KEYS, now: GOLDEN.expires_at * 1000 }).ok).toBe(
      false,
    );
    expect(
      verifyDigestToken(GOLDEN.token, { keys: KEYS, now: (GOLDEN.expires_at - 1) * 1000 }).ok,
    ).toBe(true);
  });

  it("never reports a FORGED token as expired", () => {
    // The oracle this ordering exists to prevent: if the clock were checked
    // before the signature, "expired" would confirm that a guessed payload was
    // correctly signed.
    const [v, kid, body] = parts(GOLDEN.tampered_action_token);
    expect(
      verifyDigestToken(`${v}.${kid}.${body}.${"A".repeat(43)}`, {
        keys: KEYS,
        now: (GOLDEN.expires_at + 999_999) * 1000,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("the undo token", () => {
  it("is its own purpose, its own action and 24 hours", () => {
    const token = mintDigestToken(
      {
        userId: GOLDEN.user_id,
        postingKey: GOLDEN.posting_key,
        action: UNDO_ACTION,
        purpose: PURPOSE_UNDO,
      },
      { keys: KEYS, now: LIVE_MS },
    );
    const verdict = verifyDigestToken(token, { keys: KEYS, now: LIVE_MS });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.payload.purpose).toBe(PURPOSE_UNDO);
    expect(verdict.payload.action).toBe(UNDO_ACTION);
    expect(verdict.payload.expiresAt).toBe(Math.floor(LIVE_MS / 1000) + UNDO_TTL_SECONDS);
    // Dead a day later. An undo is a second thought, not a bookmark.
    expect(verifyDigestToken(token, { keys: KEYS, now: LIVE_MS + 86401_000 }).ok).toBe(false);
  });

  it("gets a fresh jti every time, because the jti is the idempotency key", () => {
    const mint = () =>
      mintDigestToken(
        {
          userId: GOLDEN.user_id,
          postingKey: GOLDEN.posting_key,
          action: UNDO_ACTION,
          purpose: PURPOSE_UNDO,
        },
        { keys: KEYS, now: LIVE_MS },
      );
    // Two undos sharing a jti would make the second one a REPLAY of the first in
    // `command_idempotency` — it would answer "done" and change nothing.
    expect(new Set([mint(), mint(), mint()]).size).toBe(3);
  });

  it("refuses to mint a purpose and an action that do not belong together", () => {
    expect(() =>
      mintDigestToken(
        { userId: GOLDEN.user_id, postingKey: GOLDEN.posting_key, action: UNDO_ACTION },
        { keys: KEYS },
      ),
    ).toThrow();
    expect(() =>
      mintDigestToken(
        {
          userId: GOLDEN.user_id,
          postingKey: GOLDEN.posting_key,
          action: "interested",
          purpose: PURPOSE_UNDO,
        },
        { keys: KEYS },
      ),
    ).toThrow();
  });
});

describe("the comparison itself", () => {
  it("really uses timingSafeEqual", () => {
    // A behavioural test cannot tell a constant-time compare from `===` without
    // timing measurements, which are exactly the flaky test this suite refuses to
    // add. So the mechanism is asserted where it is legible: in the source.
    // `===` passes every other test in this file.
    const src = readFileSync(path.join(REPO, "webapp", "lib", "digest", "token.ts"), "utf8");
    expect(src).toMatch(/timingSafeEqual\(/);
    expect(src).not.toMatch(/expected === presented|presented === expected/);
  });

  it("answers false rather than throwing on a length mismatch", () => {
    // `timingSafeEqual` THROWS on differing buffer lengths, and a crash out of a
    // credential check is an outage wearing a bug report's clothes
    // (`lib/capture/token.ts` paid for exactly this). The regex pins the
    // presented half at 43 characters, so this is reachable only by loosening it
    // — which is one edit away.
    const [v, kid, body] = parts(GOLDEN.token);
    expect(() =>
      verifyDigestToken(`${v}.${kid}.${body}.${"A".repeat(43)}`, { keys: KEYS, now: LIVE_MS }),
    ).not.toThrow();
  });
});
