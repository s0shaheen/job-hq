import "server-only";

import { NextResponse } from "next/server";
import { getServiceEnv } from "@/lib/env";
import { declaresOverCap, readBoundedBody } from "@/lib/http/bounded";
import { SupabaseDigestStore } from "@/lib/supabase/service";
import { isClosed, renderDigestPage, type DigestPage } from "./page";
import type { DigestPostingView, DigestStore } from "./store";
import {
  DigestKeyError,
  loadKeys,
  mintDigestToken,
  PURPOSE_UNDO,
  UNDO_ACTION,
  UNDO_TTL_SECONDS,
  verifyDigestToken,
  type DigestKey,
  type DigestPayload,
} from "./token";

/**
 * `/d/<token>` — what happens when the human taps a link in the digest email.
 *
 * IT LIVES HERE AND NOT IN `route.ts` FOR ONE MECHANICAL REASON, the same one
 * `lib/capture/handler.ts` states: Next validates a route module's exports
 * against a closed set, so an exported handler in `app/d/[token]/route.ts` is a
 * BUILD failure — and the handler has to be exported, because the unit suite
 * drives it with real `Request`s against a fake store rather than a database.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * GET NEVER WRITES. EVER.
 *
 * `docs/plans/PHASE-DIGEST.md` §3.2, matrix row 25, and §9's first
 * do-not-re-litigate. Outlook ATP Safe Links, Proofpoint URL Defense, Mimecast
 * and Barracuda **GET every link in an email before a human sees it**. A GET that
 * mutates therefore fires itself, and it is not solvable with User-Agent
 * sniffing — the scanner is indistinguishable from a person by design.
 *
 * So GET verifies the signature, reads the posting for display, and renders a
 * confirmation page whose one large button POSTs the same token back. The
 * mutation exists only in `digestPost`.
 *
 * The shape of this file is the proof, not a comment about it: `digestGet` takes
 * no store WRITE path it could reach by accident — it calls `postingForUser` and
 * nothing else — and it takes no `Request`, because it has nothing to read off
 * one. `tests/unit/digest-action.test.ts` GETs twice (Safe Links, then the human)
 * and asserts the fake recorded zero writes.
 *
 * Costs accepted deliberately: one extra tap, which is also the last chance to
 * notice a misclick, and a scanner that executes JS and clicks buttons would
 * still fire it. A GET-issued nonce in the POST body was considered and rejected
 * — it adds a second state machine to defend against a scanner class that also
 * defeats it. The real defence is that the action is idempotent and reversible in
 * one tap.
 *
 * CSRF is a non-issue: the token IS the bearer secret, there is no cookie and no
 * session, and an attacker who can forge a cross-site POST still cannot know the
 * URL to forge it at.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE ACTING USER COMES OUT OF THE SIGNATURE
 *
 * Matrix row 40. Nothing here reads a query parameter, and `postingForUser`
 * scopes the read to that user's `user_postings` — so a token minted for one
 * person, replayed against a posting only another person was ever gated, gets the
 * "no longer listed" page and learns nothing. The same rule is enforced a second
 * time in the database: 0019 locks the row by `(user_id, posting_key)` and raises
 * when there is none.
 */

/**
 * The three headers every response carries, whatever it renders.
 *
 *   Referrer-Policy: no-referrer   THE TOKEN IS IN THE PATH. Without this, the
 *                                  "View the posting" link hands the whole
 *                                  credential to an ATS in a `Referer` header,
 *                                  and from there to their analytics vendor.
 *   Cache-Control: no-store        a page keyed by a credential must not sit in a
 *                                  shared proxy, a mail client's cache, or a
 *                                  browser's back-forward store.
 *   X-Robots-Tag: noindex          a token URL in a search index is a live
 *                                  credential in a search index.
 */
const SAFETY_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

/**
 * The POST body is empty — the token is in the path and the form has no fields.
 *
 * It is read and bounded anyway, because this URL is public and unauthenticated
 * in the only sense that matters here: anybody who finds the shape can POST to
 * it, and an unbounded read is an allocation they get to ask for. 2 KB is far more
 * than a fieldless form sends and far less than anything worth buffering.
 */
const MAX_BODY_BYTES = 2048;

function html(page: DigestPage): NextResponse {
  const [body, status] = renderDigestPage(page);
  return new NextResponse(body, {
    status,
    headers: { ...SAFETY_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * A protocol refusal, not one of the six states.
 *
 * An oversized body is the caller misbehaving, and answering it with "something
 * went wrong on our side" would send an operator looking for a fault that is not
 * theirs.
 */
function refuse(status: number, sentence: string): NextResponse {
  return new NextResponse(`${sentence}\n`, {
    status,
    headers: { ...SAFETY_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

/** Keys, or null when the DEPLOYMENT is broken (which is not the reader's fault). */
function keysOrNull(): DigestKey[] | null {
  try {
    return loadKeys();
  } catch (err) {
    if (err instanceof DigestKeyError) {
      // Loud in the log, "try again" on the page. Rendering "your link is not
      // valid" here would be a thousand people told their mail was forged while
      // the real fault is one missing environment variable.
      console.error("[digest] HQ_DIGEST_KEYS is unusable", err);
      return null;
    }
    throw err;
  }
}

/** The undo handed to a success page: a fresh single-use token, 24 h. */
function mintUndo(payload: DigestPayload, keys: DigestKey[]): string {
  // NOT the original token replayed with an inverted action. The original is by
  // then a known-used value that may be sitting in a proxy log (PHASE-DIGEST
  // §3.3), and a used token that still does something is a used token worth
  // stealing.
  return mintDigestToken(
    {
      userId: payload.userId,
      postingKey: payload.postingKey,
      action: UNDO_ACTION,
      purpose: PURPOSE_UNDO,
      ttlSeconds: UNDO_TTL_SECONDS,
    },
    { keys },
  );
}

/**
 * A FRESH action token, for the "change to X" button on an already-decided page.
 *
 * Never the original token replayed (C3 review M2). The original that reached
 * this page may already be BURNT — it is the token whose first tap set the
 * decision that got overwritten — and a burnt token is a `command_idempotency`
 * replay: it returns the first tap's stale answer and writes nothing, so the
 * button does nothing and the success page then lies. A new `jti` always applies.
 * Short-lived (24 h) because it is handed to a page, not emailed.
 */
function mintAction(payload: DigestPayload, action: "interested" | "dismissed", keys: DigestKey[]): string {
  return mintDigestToken(
    { userId: payload.userId, postingKey: payload.postingKey, action, ttlSeconds: UNDO_TTL_SECONDS },
    { keys },
  );
}

/** `interested` -> what a button says about switching TO it. */
function switchLabel(action: string): string {
  return action === "interested" ? "Change to Interested" : "Change to Not for me";
}

/** The reverse of the row's current decision, as a switch offer with a FRESH
 *  token. `null` when the row carries a human-invented status this lane does not
 *  know how to reverse. */
function reverseOffer(
  payload: DigestPayload,
  decided: string,
  keys: DigestKey[],
): { token: string; label: string } | null {
  const other = decided === "interested" ? "dismissed" : decided === "dismissed" ? "interested" : null;
  if (!other) return null;
  return { token: mintAction(payload, other, keys), label: switchLabel(other) };
}

/**
 * GET — verify, read, render. No `Request` parameter, because there is nothing on
 * a request this handler is entitled to act on, and no store write it can reach.
 */
export async function digestGet(token: string, store?: DigestStore): Promise<NextResponse> {
  const keys = keysOrNull();
  if (!keys) return html({ kind: "trouble" });

  const verdict = verifyDigestToken(token, { keys });
  if (!verdict.ok && verdict.reason === "invalid") return html({ kind: "invalid" });

  if (!store && !getServiceEnv()) {
    // A deployment with no store credential cannot read the posting, and a
    // confirmation page for a posting it could not read would be a button
    // promising a write that will also fail.
    return html({ kind: "trouble" });
  }
  const backing = store ?? new SupabaseDigestStore();
  const payload = verdict.payload;

  let posting: DigestPostingView | null;
  try {
    posting = await backing.postingForUser(payload.userId, payload.postingKey);
  } catch (err) {
    console.error("[digest] posting lookup failed", err);
    return html({ kind: "trouble" });
  }

  if (!verdict.ok) {
    // Expired, and the signature was good — so the posting may be named. That is
    // the whole reason expired has a page of its own: three weeks later the email
    // still tells the person what it was about.
    return html({ kind: "expired", posting, expiresAt: payload.expiresAt });
  }

  // Row 41 and row 40 share a page: a listing the board closed, and a posting
  // this token's user was never gated. One page, because two would answer "does
  // this posting exist" for anybody holding a link.
  if (!posting || isClosed(posting)) return html({ kind: "gone", posting });

  // An undo is always a confirm. It is idempotent, it is only ever reached from a
  // success page (never from the email, so no scanner prefetches it), and a row
  // that is already clear makes the POST a no-op rather than a wrong answer.
  if (payload.purpose === PURPOSE_UNDO || posting.triage === "") {
    return html({ kind: "confirm", posting, action: payload.action });
  }

  // The row already carries a decision, and the page renders THAT decision, from
  // the row, not from the token's action (C3 review M2). The offer is a fresh
  // token every time: Undo when the row matches what this link asked for, the
  // reverse when it does not. Never the original token — it may be burnt (see
  // `mintAction`), and a burnt token replays a stale answer and writes nothing.
  return html({
    kind: "already",
    posting,
    decided: posting.triage,
    offer:
      posting.triage === payload.action
        ? { token: mintUndo(payload, keys), label: "Undo" }
        : reverseOffer(payload, posting.triage, keys),
  });
}

/** POST — the one path that writes. */
export async function digestPost(
  request: Request,
  token: string,
  store?: DigestStore,
): Promise<NextResponse> {
  if (declaresOverCap(request.headers, MAX_BODY_BYTES)) {
    return refuse(413, "That request body is larger than this endpoint accepts.");
  }
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  // `no-body` is not an error here: a form with no fields is exactly what this
  // page submits, and `readBoundedBody` reports a null stream that way. The
  // CONTENT is never looked at — the token is in the path and the action is
  // inside its signature.
  if (!read.ok && read.why === "too-large") {
    return refuse(413, "That request body is larger than this endpoint accepts.");
  }

  const keys = keysOrNull();
  if (!keys) return html({ kind: "trouble" });

  const verdict = verifyDigestToken(token, { keys });
  if (!verdict.ok && verdict.reason === "invalid") return html({ kind: "invalid" });

  if (!store && !getServiceEnv()) return html({ kind: "trouble" });
  const backing = store ?? new SupabaseDigestStore();
  const payload = verdict.payload;

  if (!verdict.ok) {
    // Expired on the POST too, and it writes nothing. The expiry is checked on
    // BOTH verbs on purpose: a confirmation page left open overnight must not
    // become a link that outlives its own token.
    let posting: DigestPostingView | null = null;
    try {
      posting = await backing.postingForUser(payload.userId, payload.postingKey);
    } catch (err) {
      console.error("[digest] posting lookup failed", err);
    }
    return html({ kind: "expired", posting, expiresAt: payload.expiresAt });
  }

  // A CLOSED posting is refused on POST the way `digestGet` refuses it (matrix
  // row 41, C3 review M1). Without this, Safe Links GETs the "no longer listed"
  // page, the human taps hours later, and the tap creates a `Queued` application
  // for a dead listing. Read the row first and agree with GET. 0019 refuses a
  // closed posting too — this is the same guard one layer up, and it also closes
  // the race where the board closes it between GET and this POST. A read failure
  // is `trouble`, never a silent write.
  let posting: DigestPostingView | null;
  try {
    posting = await backing.postingForUser(payload.userId, payload.postingKey);
  } catch (err) {
    console.error("[digest] posting lookup failed", err);
    return html({ kind: "trouble" });
  }
  if (!posting || isClosed(posting)) return html({ kind: "gone", posting });

  // An undo clears the triage; an action token asks for the action it was signed
  // with. Nothing else can be requested, and 0019 refuses anything else by name.
  const triage = payload.purpose === PURPOSE_UNDO ? "" : payload.action;

  let result;
  try {
    result = await backing.setTriage({
      userId: payload.userId,
      postingKey: payload.postingKey,
      triage,
      // THE TOKEN'S `jti` IS THE IDEMPOTENCY KEY. It is what makes a double-tap
      // free, a mail-gateway replay free, and a link clicked again next week
      // return the answer the first tap produced rather than applying twice
      // (matrix row 26).
      idem: payload.jti,
    });
  } catch (err) {
    console.error("[digest] set triage failed", err);
    return html({ kind: "trouble" });
  }

  if (result.outcome === "missing") return html({ kind: "gone", posting: null });

  // WHAT THE ROW ACTUALLY SAYS NOW, not what this token once did (C3 review M2).
  // `setTriage` is idempotent on the `jti`, so a replay returns the FIRST tap's
  // stored answer — correct for not-double-writing, a lie for display the moment
  // the row moved via another link since. So re-read the live row and render the
  // truth: "done" when the row is in the state this tap asked for, "already" (with
  // the real decision and a fresh reverse offer) when a stale replay disagrees
  // with it. The idempotency store still did its job; the page just does not
  // trust a snapshot to describe the present. A re-read failure falls back to the
  // write's own result rather than 500ing a page that must not.
  // `posting` is the non-null row read before the write (the gone-check above
  // returned otherwise), so it is a safe fallback when the re-read comes back
  // empty for a reason a page must not 500 over.
  let live: DigestPostingView = result.posting ?? posting;
  try {
    const reread = await backing.postingForUser(payload.userId, payload.postingKey);
    if (reread) live = reread;
  } catch (err) {
    console.error("[digest] post-write re-read failed", err);
  }
  const current = live.triage;

  if (current !== triage) {
    // A replay whose stored answer predates a later change. Say what the row
    // truly is and offer to flip it, with a FRESH token (the tapped one is spent).
    return html({ kind: "already", posting: live, decided: current, offer: reverseOffer(payload, current, keys) });
  }

  return html({
    kind: "done",
    posting: live,
    triage: current,
    // Nothing to undo once the triage is clear, and offering it anyway would be a
    // button that reports success for doing nothing.
    undoToken: current === "" ? null : mintUndo(payload, keys),
  });
}
