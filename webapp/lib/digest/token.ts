import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The digest email's one-click credential, verified — and minted, for Undo.
 *
 * The MINTING half in production is `core/digest_links.py`: the Lambda digest job
 * composes the email and puts these in somebody's inbox. This file is the other
 * end of that wire, and the two are pinned to each other by
 * `tests/fixtures/digest-token.golden.json` — one constant that neither
 * implementation derives at test time. A diff in that file is a format change
 * that breaks every link already sitting in a mailbox.
 *
 *     /d/v1.<kid>.<payload_b64url>.<sig_b64url>
 *
 *     payload = {"a":"interested"|"dismissed"|"undo","e":<exp epoch s>,"j":<jti>,
 *                "p":<posting key>,"t":"digest_action"|"digest_undo","u":<user uuid>}
 *     sig     = HMAC-SHA256(SECRET[kid], "v1." + kid + "." + payload_b64url)
 *
 * `node:crypto` only — no dependency, and no `server-only` marker, for
 * `lib/capture/token.ts`'s reason: this file has no database, no request and no
 * Next import, and `node:crypto` is itself the containment (a client bundle
 * importing it does not build).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DECISIONS, so none of them is re-litigated by accident
 *
 * They are argued at length in `core/digest_links.py` and in
 * `docs/plans/PHASE-DIGEST.md` §3; the short version, because the verifier is
 * where they are enforced:
 *
 *   * **The action is inside the signature.** One token = one user x one posting
 *     x one action. The shortcut — one token plus `?a=interested` — makes the
 *     action forgeable by anyone holding either link, and a URL-rewriting mail
 *     gateway is entitled to mangle query strings.
 *   * **`kid` is inside the signed prefix**, so retiring a secret kills every
 *     outstanding token signed with it at once. That is the whole revocation
 *     story this unit ships: there is no `digest_tokens` table and no
 *     `token_epoch` (`core/digest_links.py` records why), because
 *     `command_idempotency` keyed on the `jti` already gives single-use for the
 *     write and replay-safety for the display.
 *   * **Two keys are accepted mid-rotation**, newest first, and minting uses the
 *     first. `HQ_DIGEST_KEYS="new:secret,old:secret"`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ONE OPAQUE ANSWER, WITH ONE INTERNAL EXCEPTION
 *
 * Malformed, unknown kid, bad signature, unreadable payload, wrong purpose,
 * missing field — all of them come back as `"invalid"`, and the page renders the
 * same sentence for every one. A page that distinguishes "forged" from "retired
 * key" is an oracle.
 *
 * `"expired"` is the exception and it is deliberate: the rendered copy names the
 * date and the posting, so a Monday email opened three weeks later still tells
 * the person what it was about. That is only safe because an expired token had a
 * VALID signature — the reason is a fact about time, not about whether the caller
 * guessed a secret.
 */

/** Bumping this is a format change; anything else is rejected outright. */
export const DIGEST_VERSION = "v1";

/** `kid:secret[,kid:secret]`, newest first. Operator-owned (SSM/Vercel env). */
export const KEYS_ENV = "HQ_DIGEST_KEYS";

export const PURPOSE_ACTION = "digest_action";
export const PURPOSE_UNDO = "digest_undo";

/** What a link minted into the email can ask for. */
export const ACTIONS = ["interested", "dismissed"] as const;
/** What an Undo asks for: clear the triage. Never rides in the email. */
export const UNDO_ACTION = "undo";

export type DigestAction = (typeof ACTIONS)[number] | typeof UNDO_ACTION;
export type DigestPurpose = typeof PURPOSE_ACTION | typeof PURPOSE_UNDO;

/** 7 days: a Monday email opened Saturday still works; older than next week's digest is noise. */
export const ACTION_TTL_SECONDS = 7 * 86400;
/** 24 hours. Undo is a second thought, not a bookmark. */
export const UNDO_TTL_SECONDS = 86400;

/** A key id is public (it rides in the URL) and must survive a path segment. */
const KID_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;
/** 32 chars is 128 bits of hex. Short enough to be a placeholder somebody pasted. */
const MIN_SECRET_CHARS = 32;

const TOKEN_RE = /^v1\.([a-z0-9][a-z0-9_-]{0,15})\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/;

export type DigestKey = { kid: string; secret: string };

export type DigestPayload = {
  userId: string;
  postingKey: string;
  action: DigestAction;
  purpose: DigestPurpose;
  /** Epoch seconds. */
  expiresAt: number;
  /** The idempotency key handed to Postgres. */
  jti: string;
};

/**
 * `expired` carries the payload; `invalid` never does.
 *
 * The expired page names the posting, which needs the user id and the posting key
 * out of a payload whose signature checked out. `invalid` means the payload was
 * never trustworthy, so there is nothing in it to hand anybody.
 */
export type DigestVerdict =
  | { ok: true; payload: DigestPayload }
  | { ok: false; reason: "expired"; payload: DigestPayload }
  | { ok: false; reason: "invalid" };

/** `HQ_DIGEST_KEYS` is absent or malformed. Loud, never a guess. */
export class DigestKeyError extends Error {}

export function b64u(raw: Buffer): string {
  return raw.toString("base64url");
}

function unb64u(raw: string): Buffer {
  return Buffer.from(raw, "base64url");
}

/**
 * `[{kid, secret}]`, newest first. Throws rather than answering `[]`.
 *
 * An empty list would mean "verify nothing" on this side and "sign nothing" on
 * the other, and both are silent. Mirrors `core.digest_links.load_keys` refusal
 * for refusal, because a key file the two ends disagree about is a key file that
 * works in CI and 401s an inbox.
 */
export function loadKeys(raw?: string | null): DigestKey[] {
  const text = raw === undefined ? (process.env[KEYS_ENV] ?? "") : (raw ?? "");
  const keys: DigestKey[] = [];
  const seen = new Set<string>();
  for (const chunk of text.split(",")) {
    const entry = chunk.trim();
    if (!entry) continue;
    const at = entry.indexOf(":");
    const kid = at === -1 ? "" : entry.slice(0, at).trim();
    const secret = at === -1 ? "" : entry.slice(at + 1).trim();
    if (at === -1 || !KID_RE.test(kid)) {
      throw new DigestKeyError(
        `${KEYS_ENV} entry ${JSON.stringify(entry.slice(0, 24))} is not \`kid:secret\` with a ` +
          "lowercase alphanumeric kid — a key id that cannot survive a URL cannot sign a link",
      );
    }
    if (secret.length < MIN_SECRET_CHARS) {
      throw new DigestKeyError(
        `${KEYS_ENV} key ${JSON.stringify(kid)} has a ${secret.length}-char secret; ` +
          `${MIN_SECRET_CHARS} is the floor`,
      );
    }
    if (seen.has(kid)) {
      throw new DigestKeyError(`${KEYS_ENV} names key id ${JSON.stringify(kid)} twice — which one signs?`);
    }
    seen.add(kid);
    keys.push({ kid, secret });
  }
  if (keys.length === 0) {
    throw new DigestKeyError(
      `${KEYS_ENV} is unset or empty — /d/<token> cannot verify a single link, so every ` +
        "action link in every digest already sent reads as forged",
    );
  }
  return keys;
}

function sign(secret: string, signedPrefix: string): string {
  return b64u(createHmac("sha256", Buffer.from(secret, "utf8")).update(signedPrefix, "ascii").digest());
}

/**
 * The payload, byte-for-byte as Python's `json.dumps(sort_keys=True,
 * separators=(",", ":"))` writes it.
 *
 * Key order is the sorted order, spelled out rather than sorted at runtime so the
 * contract is readable. The escape pass is the part that is easy to miss:
 * `json.dumps` defaults to `ensure_ascii=True` and emits `\uXXXX` for everything
 * above U+007F, while `JSON.stringify` emits the character. Every posting key is
 * `{ats}-{native_id}` and every user id is a UUID, so today nothing differs —
 * which is exactly the kind of agreement that holds until one company name gets
 * into a key and one side mints a token the other cannot reproduce.
 */
function encodePayload(p: DigestPayload): string {
  const json = JSON.stringify({
    a: p.action,
    e: p.expiresAt,
    j: p.jti,
    p: p.postingKey,
    t: p.purpose,
    u: p.userId,
  // The class is written as ESCAPES, never as the characters themselves:
  // `capture-fake.ts` broke that rule once and put four codepoints nobody could
  // read into a source line, one of them indistinguishable for a typo.
  }).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return b64u(Buffer.from(json, "utf8"));
}

export type MintInput = {
  userId: string;
  postingKey: string;
  action: DigestAction;
  purpose?: DigestPurpose;
  /** Seconds. Defaults per purpose: 7 days for an action, 24 h for an undo. */
  ttlSeconds?: number;
};

export type MintOptions = {
  keys?: DigestKey[];
  /** Epoch MILLISECONDS, like `Date.now()`. */
  now?: number;
  /** Injectable ONLY so the golden fixture can be a constant. */
  jti?: string;
};

/**
 * One token, signed with the newest key.
 *
 * The web app mints exactly one kind in production — the **Undo** handed to the
 * success page — and it is a freshly minted single-use token rather than the
 * original replayed with an inverted action, because the original is by then a
 * known-used value that may be sitting in a proxy log (PHASE-DIGEST §3.3).
 *
 * It can nevertheless mint an action token, and that is not dead code: it is what
 * lets the unit suite reproduce the shared golden from this side of the wire.
 */
export function mintDigestToken(input: MintInput, options: MintOptions = {}): string {
  const purpose = input.purpose ?? PURPOSE_ACTION;
  if (purpose === PURPOSE_ACTION && !(ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`${JSON.stringify(input.action)} is not a digest action`);
  }
  if (purpose === PURPOSE_UNDO && input.action !== UNDO_ACTION) {
    throw new Error("an undo token carries the undo action");
  }
  if (!input.userId || !input.postingKey) {
    throw new Error("a digest token needs both a user id and a posting key");
  }
  const keys = options.keys ?? loadKeys();
  const { kid, secret } = keys[0];
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const ttl = input.ttlSeconds ?? (purpose === PURPOSE_UNDO ? UNDO_TTL_SECONDS : ACTION_TTL_SECONDS);
  const body = encodePayload({
    userId: input.userId,
    postingKey: input.postingKey,
    action: input.action,
    purpose,
    expiresAt: nowSeconds + ttl,
    jti: options.jti ?? b64u(randomBytes(16)),
  });
  const prefix = `${DIGEST_VERSION}.${kid}.${body}`;
  return `${prefix}.${sign(secret, prefix)}`;
}

/**
 * Constant-time comparison of the presented signature against the computed one.
 *
 * `timingSafeEqual` THROWS on differing lengths, which would turn a truncated
 * token into a 500 — a crash out of a credential check, which is an outage
 * wearing a bug report's clothes (`lib/capture/token.ts` paid for that lesson).
 * `TOKEN_RE` already pins the presented half at 43 characters and the computed
 * half is always 43, so the guard is belt rather than braces, and it is here
 * because the regex is one edit away from someone loosening it.
 */
function signatureMatches(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(presented, "utf8"));
}

export type VerifyOptions = {
  keys?: DigestKey[];
  /** Epoch MILLISECONDS. */
  now?: number;
};

/**
 * Verify a token. Never throws for a bad token; throws only for a bad DEPLOYMENT
 * (`DigestKeyError`, when `HQ_DIGEST_KEYS` is missing or malformed), because that
 * is an operator's problem and must not be rendered as "your link is invalid" a
 * thousand times without anybody noticing.
 */
export function verifyDigestToken(token: string, options: VerifyOptions = {}): DigestVerdict {
  const keys = options.keys ?? loadKeys();
  const match = TOKEN_RE.exec(token ?? "");
  if (!match) return { ok: false, reason: "invalid" };
  const [, kid, body, presented] = match;

  const key = keys.find((k) => k.kid === kid);
  // A retired kid and a forged one are the same answer, on purpose: the whole
  // point of retiring a key is that the tokens signed with it stop working, and a
  // page that said "retired" would tell an attacker which of their guesses were
  // once real.
  if (!key) return { ok: false, reason: "invalid" };
  if (!signatureMatches(sign(key.secret, `${DIGEST_VERSION}.${kid}.${body}`), presented)) {
    return { ok: false, reason: "invalid" };
  }

  let data: unknown;
  try {
    data = JSON.parse(unb64u(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "invalid" };
  }
  const raw = data as Record<string, unknown>;

  const purpose = raw.t;
  if (purpose !== PURPOSE_ACTION && purpose !== PURPOSE_UNDO) {
    return { ok: false, reason: "invalid" };
  }
  const action = raw.a;
  const allowed: readonly string[] =
    purpose === PURPOSE_UNDO ? [UNDO_ACTION] : (ACTIONS as readonly string[]);
  // The purpose and the action are checked TOGETHER. An `undo` inside a
  // `digest_action` token would be a link in an email that silently clears a
  // decision, and an `interested` inside a `digest_undo` token would be a 24-hour
  // link doing a 7-day link's job.
  if (typeof action !== "string" || !allowed.includes(action)) {
    return { ok: false, reason: "invalid" };
  }
  for (const field of ["u", "p", "j"] as const) {
    if (typeof raw[field] !== "string" || raw[field] === "") return { ok: false, reason: "invalid" };
  }
  if (typeof raw.e !== "number" || !Number.isInteger(raw.e)) return { ok: false, reason: "invalid" };

  const payload: DigestPayload = {
    userId: raw.u as string,
    postingKey: raw.p as string,
    action: action as DigestAction,
    purpose,
    expiresAt: raw.e,
    jti: raw.j as string,
  };
  // Last, and only after the signature: an expired token is one whose contents we
  // are entitled to read, which is what lets the expired page name the posting.
  if (payload.expiresAt <= Math.floor((options.now ?? Date.now()) / 1000)) {
    return { ok: false, reason: "expired", payload };
  }
  return { ok: true, payload };
}
