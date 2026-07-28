import "server-only";

import { NextResponse } from "next/server";
import { getServiceEnv } from "@/lib/env";
import { declaresOverCap, readBoundedBody } from "@/lib/http/bounded";
import {
  EVENT_FIELDS,
  MAX_BODY_BYTES,
  MAX_EVENTS,
  parseBatch,
  parseEvent,
  type CaptureRow,
} from "./schema";
import { parseBearer, verifySecret } from "./token";
import { SupabaseCaptureStore } from "@/lib/supabase/service";
import type { CaptureOutcome, CaptureStore } from "./store";

/**
 * The body of `POST /api/capture` — the Gmail Apps Script's classified email
 * events, in Postgres.
 *
 * IT LIVES HERE AND NOT IN `route.ts` FOR ONE MECHANICAL REASON: Next validates
 * a route module's exports against a closed set, so `export async function
 * handleCapture` in `app/api/capture/route.ts` is a BUILD failure
 * ("handleCapture is not a valid Route export field") — and the handler has to be
 * exported, because the unit suite drives it with a fake store rather than
 * against a database. `route.ts` is the four lines Next allows.
 *
 * SHEET-SUNSET Phase C2. The script has appended to a spreadsheet tab since the
 * system existed; it now does BOTH, sheet first. Nothing here is authoritative
 * yet: `tracker/join.py` still reads the tab, and this lane is filling so that
 * the day the flag flips there is something to read. Phase D deletes the sheet
 * half of the sender, not this.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY A ROUTE HANDLER AND NOT A SERVER ACTION
 *
 * The same reason `/api/import/upload` and `/api/connections/upload` are routes,
 * plus a stronger one: a server action is invoked by a React client with a
 * session cookie, and this caller is `UrlFetchApp` inside somebody's Gmail
 * account holding a bearer token. There is no session, there is no origin, and
 * there is no CSRF story that applies. This is an API, and it is shaped like one.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE ORDER OF THE CHECKS, WHICH IS LOAD-BEARING
 *
 *   1. configured?          503 — a deployment with no service credential cannot
 *                           write, and must not pretend the batch landed.
 *   2. authenticate         401 — BEFORE the body is read. An unauthenticated
 *                           caller must not get to hand us a megabyte.
 *   3. declared size        413 — free, and refuses an honest oversized caller
 *                           before a byte moves.
 *   4. read, counting bytes 413 — the real cap. Row 265: "a cap that only works
 *                           when the other end is honest about its size is not a
 *                           cap." An ABSENT content-length is not an error here
 *                           (unlike `/api/import/upload`, which 411s because a
 *                           browser form always declares one) — it is exactly
 *                           what the streaming bound exists for.
 *   5. envelope + per-row   200 with outcomes, or 400 for a body that is not a
 *                           batch at all.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ONE BAD ROW NEVER DROPS THE BATCH
 *
 * The sender is an LLM classifier writing rows nobody reviews. Sooner or later it
 * produces one this schema refuses, and the whole point of this endpoint is that
 * the other forty-nine still land. Rejections are per row, they carry the reason
 * and the index, and they are reported in the SAME 200 as the successes — because
 * the batch was fine; a row in it was not. A non-2xx here means "come back with
 * this whole batch again", and the script's retry queue takes that literally.
 */

/**
 * ONE SENTENCE FOR EVERY AUTHENTICATION FAILURE.
 *
 * Absent header, wrong scheme, malformed token, unknown selector, wrong secret,
 * revoked row — all 401, all this string. A response that distinguishes "no such
 * token" from "wrong secret" is a response that confirms a selector exists, and
 * one that says "revoked" confirms it existed. The operator's debugging path is
 * the store itself (`docs/RUNBOOK.md` § The capture endpoint), which is a place
 * that already requires the service key.
 */
const AUTH_FAILED = "Unauthorized.";

function fail(message: string, status: number, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ error: message }, { status, headers });
}

function unauthorized(): NextResponse {
  return fail(AUTH_FAILED, 401, { "WWW-Authenticate": "Bearer" });
}

export type CaptureResponse = {
  received: number;
  inserted: number;
  duplicate: number;
  rejected: number;
  /** How many stored rows carried a repair. Zero is the normal number. */
  repaired: number;
  /** One entry per event sent, in the order sent. */
  results: CaptureOutcome[];
};

/**
 * Injectable for the unit suite, which drives real `Request`s through the real
 * handler against a fake store. Absent, the route builds the service-role client
 * — which is also the only place in the app that does.
 */
export async function handleCapture(
  request: Request,
  store?: CaptureStore,
): Promise<NextResponse> {
  if (!store && !getServiceEnv()) {
    return fail("This deployment has no store credential; capture is not accepting events.", 503);
  }

  // ---------------------------------------------------------------- authenticate
  const presented = parseBearer(request.headers.get("authorization"));
  // A malformed or absent token costs no round trip and, now, no allocation:
  // there is no selector to look up, and inventing one to keep the timing
  // identical would be a query per unauthenticated request — a free amplifier
  // for anybody who found the URL. (Constructing the client BEFORE this return
  // built a Supabase object per unauthenticated request. No network and no leak,
  // just work done for nobody.)
  if (!presented) return unauthorized();
  const backing = store ?? new SupabaseCaptureStore();

  let tokenRow;
  try {
    tokenRow = await backing.tokenBySelector(presented.selector);
  } catch (err) {
    // A store outage is NOT a bad credential. Saying 401 here would send an
    // operator to rotate a token that was never the problem, and would tell the
    // script to keep retrying a batch it should also keep retrying — same
    // behaviour, wrong diagnosis, and the diagnosis is the thing that costs a
    // Saturday.
    console.error("[capture] token lookup failed", err);
    return fail("The store could not be reached. The batch was not stored.", 503);
  }
  const live = tokenRow && tokenRow.revoked_at === null ? tokenRow : null;
  // Runs even when `live` is null, against a digest no secret produces: whether a
  // selector exists must not be readable off the clock.
  if (!verifySecret(live?.secret_sha256 ?? null, presented.secret) || !live) {
    return unauthorized();
  }

  // ---------------------------------------------------------------- read
  if (declaresOverCap(request.headers, MAX_BODY_BYTES)) {
    return fail(`That batch is larger than the ${MAX_BODY_BYTES} byte limit.`, 413);
  }
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.why === "too-large"
      ? fail(`That batch is larger than the ${MAX_BODY_BYTES} byte limit.`, 413)
      : fail("The request carried no body.", 400);
  }

  // `readBoundedBody` says `no-body` only for a NULL stream; a zero-length body
  // is a successful read of nothing, and `JSON.parse("")` then answered "The body
  // is not JSON" — technically true and useless to somebody whose request lost
  // its payload somewhere in between.
  if (read.text === "") return fail("The request carried no body.", 400);

  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return fail("The body is not JSON.", 400);
  }

  const batch = parseBatch(body);
  if (!batch.ok) return fail(batch.reason, batch.status);

  // ---------------------------------------------------------------- validate
  const rows: CaptureRow[] = [];
  // Where each valid row sat in what the caller sent, so the store's answers can
  // be put back in the caller's own numbering. Losing this is how a report says
  // "row 3 was rejected" about row 7.
  const at: number[] = [];
  // What the parser repaired, by caller index — merged into the store's answer
  // below, because the row landed and the edit still has to be visible.
  const notes = new Map<number, string>();
  const results: CaptureOutcome[] = new Array(batch.events.length);
  batch.events.forEach((raw, index) => {
    const parsed = parseEvent(raw);
    if (!parsed.ok) {
      const id = (raw as Record<string, unknown> | null)?.event_id;
      results[index] = {
        index,
        event_id: typeof id === "string" ? id.slice(0, 200) : "",
        outcome: "rejected",
        reason: parsed.reason,
      };
      return;
    }
    if (parsed.note) notes.set(index, parsed.note);
    at.push(index);
    rows.push(parsed.row);
  });

  // ---------------------------------------------------------------- store
  if (rows.length > 0) {
    let stored: CaptureOutcome[];
    try {
      stored = await backing.storeEvents(live.user_id, live.id, rows);
    } catch (err) {
      // The whole batch failed, so the whole batch must be retried: a 200 with
      // "rejected" on every row would tell the script these events are bad and
      // to stop sending them, and they are not bad.
      console.error("[capture] store failed", err);
      return fail("The store refused the batch. Nothing was written; try again.", 503);
    }
    if (stored.length !== rows.length) {
      console.error("[capture] store returned", stored.length, "outcomes for", rows.length, "rows");
      return fail("The store answered for a different batch than it was sent.", 502);
    }
    stored.forEach((outcome, i) => {
      const index = at[i];
      const note = notes.get(index);
      results[index] = { ...outcome, index, ...(note ? { note } : {}) };
    });
  }

  const body_: CaptureResponse = {
    received: results.length,
    inserted: results.filter((r) => r.outcome === "inserted").length,
    duplicate: results.filter((r) => r.outcome === "duplicate").length,
    rejected: results.filter((r) => r.outcome === "rejected").length,
    repaired: results.filter((r) => r.note !== undefined).length,
    results,
  };
  return NextResponse.json(body_);
}

/**
 * The contract, rather than Next's bare 405.
 *
 * `/api/import/upload` does this and the reason generalises: the person who hits
 * this URL in a browser is the operator wiring up Script Properties, and the
 * question they have is "is this the right URL and what does it want". A 405 with
 * nothing in it answers neither.
 *
 * Deliberately unauthenticated and deliberately says nothing a caller could not
 * read in this repo: field names and two numbers.
 */
export function captureContract(): NextResponse {
  return NextResponse.json(
    {
      error: "Use POST with an `Authorization: Bearer hqc_…` header.",
      contract: {
        body: { events: [`{ ${EVENT_FIELDS.join(", ")} }`] },
        limits: { bytes: MAX_BODY_BYTES, events: MAX_EVENTS },
        outcomes: ["inserted", "duplicate", "rejected"],
      },
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
