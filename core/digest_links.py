"""Signed one-click links for the digest email — the MINTING half.

The email is the app (docs/plans/PHASE-DIGEST.md §3): every posting line carries
an **Interested** and a **Not for me** link that work with no login, from a mail
client's in-app browser, on a phone. What makes that safe is that the link *is*
the credential, and this module is the only thing in the engine that makes one.

    /d/<v1>.<kid>.<payload_b64url>.<sig_b64url>

    payload = {"a":"interested"|"dismissed","e":<exp epoch s>,"j":<jti>,
               "p":<posting key>,"t":"digest_action","u":<user uuid>}
    sig     = HMAC-SHA256(SECRET[kid], "v1." + kid + "." + payload_b64url)

`webapp/lib/digest/token.ts` verifies it with `node:crypto`, and the two are
pinned to each other by `tests/fixtures/digest-token.golden.json` — one constant
neither implementation derives at test time, the same discipline
`capture-token.golden.json` applies to the capture credential.

WHY EACH DECISION, so none of them is re-litigated by accident:

* **The action is inside the signature.** One token = one user x one posting x
  one action, so two links per row. The tempting shortcut — one token plus
  `?a=interested` — makes the action forgeable by anyone holding either link,
  and a URL-rewriting mail gateway is entitled to mangle query strings.
* **The token is a PATH segment, not a query parameter.** Query strings land in
  `Referer`, in proxy access logs and in analytics.
* **`kid` is inside the signed prefix.** Retiring a secret kills every
  outstanding token signed with it at once, which is the whole revocation story
  this unit ships (see the deviation note below). Two keys are accepted during a
  rotation window: `HQ_DIGEST_KEYS="new:secret,old:secret"`, newest FIRST, and
  minting always uses the first.
* **`j` (jti) is 16 random bytes.** It is the idempotency key the click lane
  hands to Postgres, which is what makes a double-tap free and a replay return
  the first answer rather than applying twice.
* **7-day expiry.** A Monday email opened Saturday should still work; a link
  older than next week's digest is noise.

DELIBERATE DEVIATION FROM THE PLAN, recorded because a later reader will look
for the missing pieces: PHASE-DIGEST §3.3 designs a `digest_tokens` table for
single-use, per-link revocation and a `token_epoch` in the payload. This unit
ships NONE of that state, because `command_idempotency` (migration 0003) already
gives single-use-for-the-write and replay-safe-for-the-display for free when the
jti is the idempotency key — a table whose only reader would duplicate a
guarantee the store already makes is a table that can drift from it. What is
genuinely lost is per-link revocation (`revoked_at`) and the per-user epoch bump;
what remains is `kid` retirement, which is coarse, and the 7-day floor. For a
two-person system on SES sandbox that is the right trade, and it is written down
here so that the day it stops being right, the fix is an addition rather than an
archaeology exercise.

Nothing here does I/O. Minting is a pure function of (keys, clock, row), which
is what lets `tests/core/test_digest_links.py` prove the format instead of
mocking a mailbox.
"""
from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import hmac
import json
import os
import re
import secrets
from dataclasses import dataclass
from urllib.parse import urlsplit

#: Bumping this is a format change; the verifier rejects anything else.
VERSION = "v1"

#: `kid:secret[,kid:secret…]`, newest first. Operator-owned (SSM), never a
#: Config-tab knob: it is a signing key, not a preference.
KEYS_ENV = "HQ_DIGEST_KEYS"
#: The absolute https origin the links point at. Absent = no links (never a
#: relative href, never a localhost link in a real inbox — matrix row 29).
BASE_URL_ENV = "HQ_WEBAPP_URL"

PURPOSE = "digest_action"
ACTIONS = ("interested", "dismissed")
DEFAULT_TTL_DAYS = 7

#: A key id is public (it rides in the URL) and must survive a path segment.
_KID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,15}$")
#: 32 chars is 128 bits of hex at minimum. Short enough to be a placeholder that
#: somebody pasted; refusing it is cheaper than discovering it in a log.
MIN_SECRET_CHARS = 32

_TOKEN_RE = re.compile(r"^v1\.([a-z0-9][a-z0-9_-]{0,15})\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$")


class TokenError(ValueError):
    """A token that cannot be trusted. Never carries a reason to a user."""


class KeyConfigError(RuntimeError):
    """`HQ_DIGEST_KEYS` is absent or malformed — fail loud, never guess."""


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def unb64u(raw: str) -> bytes:
    return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))


@dataclass(frozen=True)
class Payload:
    user_id: str
    posting_key: str
    action: str
    expires_at: int
    jti: str

    def as_dict(self) -> dict:
        return {"a": self.action, "e": self.expires_at, "j": self.jti,
                "p": self.posting_key, "t": PURPOSE, "u": self.user_id}


def load_keys(raw: str | None = None) -> list[tuple[str, str]]:
    """`[(kid, secret)]`, newest first. Raises rather than returning [].

    An empty list would mean "mint unsigned links", and the caller that asked
    for keys is about to put a URL in somebody's inbox. `has_keys()` is the
    question to ask when absence is an acceptable answer.
    """
    text = os.environ.get(KEYS_ENV, "") if raw is None else raw
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for chunk in text.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        kid, sep, secret = chunk.partition(":")
        kid, secret = kid.strip(), secret.strip()
        if not sep or not _KID_RE.match(kid):
            raise KeyConfigError(
                f"{KEYS_ENV} entry {chunk[:24]!r} is not `kid:secret` with a lowercase "
                f"alphanumeric kid — refusing to sign with a key id that cannot survive a URL")
        if len(secret) < MIN_SECRET_CHARS:
            raise KeyConfigError(
                f"{KEYS_ENV} key {kid!r} has a {len(secret)}-char secret; "
                f"{MIN_SECRET_CHARS} is the floor")
        if kid in seen:
            raise KeyConfigError(f"{KEYS_ENV} names key id {kid!r} twice — which one signs?")
        seen.add(kid)
        pairs.append((kid, secret))
    if not pairs:
        raise KeyConfigError(
            f"{KEYS_ENV} is unset or empty — the digest cannot mint action links. "
            f"Set it to `kid:secret` (SSM /job-hq/HQ_DIGEST_KEYS) or accept a digest "
            f"with no one-click links.")
    return pairs


def has_keys(raw: str | None = None) -> bool:
    """True when `load_keys()` would succeed. A malformed value is FALSE here and
    a raise there: the composer degrades to a link-free digest, and says so."""
    try:
        load_keys(raw)
        return True
    except KeyConfigError:
        return False


def _sign(secret: str, signed_prefix: str) -> str:
    return b64u(hmac.new(secret.encode("utf-8"), signed_prefix.encode("ascii"),
                         hashlib.sha256).digest())


def mint(user_id: str, posting_key: str, action: str, *,
         now: _dt.datetime | None = None, ttl_days: int = DEFAULT_TTL_DAYS,
         keys: list[tuple[str, str]] | None = None, jti: str | None = None) -> str:
    """One token. `jti` is injectable ONLY so the golden fixture can be a
    constant; every real call takes the random one."""
    if action not in ACTIONS:
        raise ValueError(f"{action!r} is not a digest action; use one of {ACTIONS}")
    if not user_id or not posting_key:
        raise ValueError("a digest token needs both a user id and a posting key")
    pairs = keys if keys is not None else load_keys()
    kid, secret = pairs[0]
    now = now or _dt.datetime.now(_dt.timezone.utc)
    payload = Payload(user_id=str(user_id), posting_key=str(posting_key), action=action,
                      expires_at=int(now.timestamp()) + ttl_days * 86400,
                      jti=jti or b64u(secrets.token_bytes(16)))
    body = b64u(json.dumps(payload.as_dict(), separators=(",", ":"),
                           sort_keys=True).encode("utf-8"))
    prefix = f"{VERSION}.{kid}.{body}"
    return f"{prefix}.{_sign(secret, prefix)}"


def verify(token: str, *, keys: list[tuple[str, str]] | None = None,
           now: _dt.datetime | None = None) -> Payload:
    """The reference verifier. `webapp/lib/digest/token.ts` is the one that runs
    in production; this one exists so the round trip is provable in one language
    and so the golden has an author.

    Raises `TokenError` for every failure with the SAME class, because the
    landing page's copy for "forged" and "revoked" is deliberately identical —
    a page that distinguishes them is an oracle.
    """
    m = _TOKEN_RE.match(token or "")
    if not m:
        raise TokenError("malformed token")
    kid, body, sig = m.groups()
    pairs = keys if keys is not None else load_keys()
    secret = next((s for k, s in pairs if k == kid), None)
    if secret is None:
        raise TokenError("unknown key id")
    if not hmac.compare_digest(_sign(secret, f"{VERSION}.{kid}.{body}"), sig):
        raise TokenError("bad signature")
    try:
        data = json.loads(unb64u(body).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise TokenError("unreadable payload") from exc
    if not isinstance(data, dict) or data.get("t") != PURPOSE:
        raise TokenError("wrong token purpose")
    if data.get("a") not in ACTIONS:
        raise TokenError("unknown action")
    for field in ("u", "p", "j"):
        if not isinstance(data.get(field), str) or not data[field]:
            raise TokenError(f"missing {field}")
    if not isinstance(data.get("e"), int):
        raise TokenError("missing expiry")
    stamp = now or _dt.datetime.now(_dt.timezone.utc)
    if data["e"] <= int(stamp.timestamp()):
        raise TokenError("expired")
    return Payload(user_id=data["u"], posting_key=data["p"], action=data["a"],
                   expires_at=data["e"], jti=data["j"])


# --------------------------------------------------------------- href safety

#: Whitespace, backslash, C0 controls and DEL. `\\` is the M6 bypass (a browser
#: normalises it to `/`, so `https://evil.com\\@good.com` reads as `good.com` and
#: resolves to `evil.com`); a control character is a header-injection or display
#: trick.
_UNSAFE_CHARS = re.compile(r"[\s\\\x00-\x1f\x7f]")
_AUTHORITY_END = re.compile(r"[/?#]")


def safe_href(raw: str) -> str:
    """A URL that is safe to render into an `href`, or `""`. The Python twin of
    `webapp/lib/url/safe-href.ts`.

    THE DIGEST EMAIL MUST CHECK EVERY href IT RENDERS, and two of its inputs come
    from outside the system: `postings.url` / the Feed's `url` originates with an
    ATS adapter, and a captured `job_url` was read out of an untrusted email body
    by an LLM. This is the same guard the web app runs at write time
    (`lib/capture/schema.ts:safeUrl`) and at render time (the landing page and
    the pipeline/queue cells), and the C2 review's M6 was those guards
    DISAGREEING: one let `https://evil.com\\@good.com` through and the others
    refused it. They now share one algorithm and one case list.

    WHY PURE STRING WORK, NOT `urlsplit`: `urlsplit` and Node's `new URL` disagree
    on `%40` (an encoded `@`) and on an empty authority, so if either parser
    decided, the two languages could not agree. Neither decides. The rules, each
    a way a browser's host differs from a reader's:

      * no whitespace, control char or backslash anywhere;
      * `http://` or `https://` only;
      * the authority (up to the first `/`, `?` or `#`) is non-empty, has no `@`
        (userinfo) and no `%` (an encoded `@` is userinfo in disguise);
      * the host (authority up to any `:port`) is non-empty.

    Returns the trimmed original, never a "repaired" one. Both implementations are
    held to `tests/fixtures/safe-href-cases.json`.
    """
    url = (raw or "").strip()
    if not url or _UNSAFE_CHARS.search(url):
        return ""
    if not re.match(r"^https?://", url, re.I):
        return ""
    after_scheme = url[url.index("://") + 3:]
    m = _AUTHORITY_END.search(after_scheme)
    authority = after_scheme[:m.start()] if m else after_scheme
    if authority == "" or "@" in authority or "%" in authority:
        return ""
    if authority.split(":", 1)[0] == "":
        return ""
    return url


def webapp_base(raw: str | None = None) -> str:
    """The origin action links are built against, or `""`.

    https only, with one named exception: `http://localhost` / `http://127.0.0.1`
    so the composer can be driven against `npm run dev`. Everything else — a
    relative path, a preview deployment on plain http, an empty env var —
    answers `""`, and the composer renders a digest with no action links and a
    line saying why. A broken href in an inbox is worse than an absent one.
    """
    url = (os.environ.get(BASE_URL_ENV, "") if raw is None else raw).strip().rstrip("/")
    if not url:
        return ""
    checked = safe_href(url)
    if not checked:
        return ""
    parts = urlsplit(checked)
    if parts.scheme.lower() == "https":
        return checked
    if parts.hostname in ("localhost", "127.0.0.1"):
        return checked
    return ""


def action_url(base: str, token: str) -> str:
    """`<base>/d/<token>`. Empty base = empty URL; the caller renders no link."""
    return f"{base}/d/{token}" if base and token else ""
