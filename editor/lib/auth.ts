// Single-user cookie auth. The token is an HMAC-signed expiry timestamp keyed
// off EDITOR_PASSCODE — no session store, and rotating the passcode instantly
// invalidates every session. Web Crypto only, so the exact same code runs in
// edge middleware and Node route handlers.

export const AUTH_COOKIE = "resume_editor_auth";
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    // Domain-separation label for the HMAC. Renaming it (or the cookie above)
    // invalidates every live session exactly like rotating the passcode does —
    // the next visit is one re-login, nothing else.
    enc.encode(`resume-editor:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 2 !== 0 || /[^0-9a-f]/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Token format: "<expiryMillis>.<hmacHex>". */
export async function makeToken(secret: string): Promise<string> {
  const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(exp));
  return `${exp}.${toHex(sig)}`;
}

export async function verifyToken(secret: string | undefined, token: string | undefined): Promise<boolean> {
  if (!secret || !token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  if (!/^\d{1,16}$/.test(exp) || Number(exp) < Date.now()) return false;
  const sig = fromHex(token.slice(dot + 1));
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig as BufferSource, enc.encode(exp));
}

/** Constant-time-ish comparison: compare SHA-256 digests so neither length nor content leaks. */
export async function passcodeMatches(submitted: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(submitted)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}
