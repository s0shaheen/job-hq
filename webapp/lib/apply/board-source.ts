import "server-only";

import { isDemoMode } from "@/lib/data/source";
import { readBoundedBody } from "@/lib/http/bounded";
import { greenhouseFormUrl, type BoardRef } from "./board";
import { DEMO_BOARDS } from "./demo-boards";
import type { GreenhouseJobPayload } from "./greenhouse";

/**
 * Where a form's question schema comes from — the app's second boundary, built
 * the way the first one is.
 *
 * `lib/data/` is one interface with two implementations, and the reasons hold
 * here too: an E2E needs no network, and the owner can look at the surface
 * before anything is provisioned. This is a DIFFERENT boundary from the store,
 * deliberately: a Supabase read is RLS-scoped and fails one way, an outbound GET
 * to somebody else's API is unauthenticated and fails five ways, and folding the
 * second into `DataSource` would have `SupabaseDataSource` making HTTP calls to
 * greenhouse.io.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES NOT DO
 *
 * It does not submit, and it cannot: one GET, to one host, with no credentials
 * of any kind. `docs/plans/AUTO-APPLY.md`'s Tier A is keyless by nature — the
 * question schema is public — so there is no key to leak and no session to
 * attach. Submission is step 3 of the build shape and needs a browser, a
 * residential egress and an owner decision that has not been made.
 *
 * It also does not follow anything a posting gave us. The URL is BUILT from a
 * board token and a job id that `board.ts` has already checked against anchored
 * patterns, against a literal host. A posting's own URL never becomes a request.
 */

export type FormFetchResult =
  | { ok: true; payload: GreenhouseJobPayload }
  /** The board answered, and not with a job — 404, or a body that is not one. */
  | { ok: false; reason: "not-found"; message: string }
  /** The board did not answer inside the bound. */
  | { ok: false; reason: "timeout"; message: string }
  /** The board answered with an error, or the network did not carry it. */
  | { ok: false; reason: "unavailable"; message: string };

export interface BoardSource {
  form(ref: BoardRef): Promise<FormFetchResult>;
}

/**
 * The bound.
 *
 * "Every external call gets a timeout" is rule 1 of the rules that already cost
 * a production incident — three outages in one day traced to unbounded waits.
 * Ten seconds is generous for a JSON GET and finite, which is the whole point:
 * a page render must not be able to hang on somebody else's API.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Above any real board's payload; the largest recorded fixture is ~30 kB.
 *
 * COUNTED OFF THE STREAM, not read off `content-length`. The first version gated
 * on the DECLARED length and then called `res.json()`, so the cap was advisory:
 * a chunked response declares nothing, `Number(null ?? "0")` is 0, and a 20 MB
 * body was read in full. (`Number("abc")` is NaN, which the finite check skipped
 * for the same reason.) An unbounded server-side allocation on a
 * `force-dynamic` page needs Greenhouse itself — or a proxy — to misbehave, and
 * "the cap only works when the other end is honest about its size" is not a cap.
 */
const MAX_PAYLOAD_BYTES = 2_000_000;

/**
 * The reader itself now lives in `lib/http/bounded.ts`, unchanged in behaviour.
 *
 * `/api/capture` needs the identical guard on the inbound half — `Request` and
 * `Response` both carry the stream on `.body` — and the alternative was a second
 * copy of the loop this row-265 lesson is written on. Two copies is two chances
 * for one of them to be relaxed by somebody who only read the other.
 */
const readBounded = readBoundedBody;

class GreenhouseBoardSource implements BoardSource {
  async form(ref: BoardRef): Promise<FormFetchResult> {
    const url = greenhouseFormUrl(ref);
    let res: Response;
    try {
      res = await fetch(url, {
        // Nothing about this request is authenticated, and nothing may be
        // cached into somebody else's answer: a question schema changes when the
        // company edits the form, and a stale one stages an application against
        // fields that no longer exist.
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      return timedOut
        ? { ok: false, reason: "timeout", message: `The board did not answer in ${FETCH_TIMEOUT_MS / 1000}s.` }
        : { ok: false, reason: "unavailable", message: "The board could not be reached." };
    }

    if (res.status === 404) {
      return {
        ok: false,
        reason: "not-found",
        message: "The board has no job with that id — it was probably taken down.",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "unavailable",
        message: `The board answered ${res.status}.`,
      };
    }

    // The declared length is a cheap early exit and nothing more — it is the
    // other end's CLAIM about its own size, and a chunked body declares nothing
    // while `Number("abc")` is NaN. Neither is a reason to read without a bound.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) {
      return { ok: false, reason: "unavailable", message: "The board's answer was too large." };
    }

    const read = await readBounded(res, MAX_PAYLOAD_BYTES);
    if (!read.ok) {
      return {
        ok: false,
        reason: "unavailable",
        message:
          read.why === "too-large"
            ? "The board's answer was too large."
            : "The board answered with no body.",
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(read.text);
    } catch {
      return {
        ok: false,
        reason: "not-found",
        message: "The board answered with something that is not a job posting.",
      };
    }
    return { ok: true, payload: payload as GreenhouseJobPayload };
  }
}

/**
 * Demo mode: the recorded payloads, and an honest miss for everything else.
 *
 * The miss matters as much as the hit. Six of the fixture applications point at
 * Greenhouse boards and three have a payload here, so the "we could not read this
 * posting" state is reachable through the demo rather than only in production —
 * matrix row 15's rule, on the one branch a person is most likely to meet on a
 * bad day.
 */
class FixtureBoardSource implements BoardSource {
  async form(ref: BoardRef): Promise<FormFetchResult> {
    const payload = DEMO_BOARDS[`${ref.boardToken}/${ref.jobId}`];
    if (!payload) {
      return {
        ok: false,
        reason: "not-found",
        message: "The board has no job with that id — it was probably taken down.",
      };
    }
    return { ok: true, payload };
  }
}

export function getBoardSource(): BoardSource {
  return isDemoMode() ? new FixtureBoardSource() : new GreenhouseBoardSource();
}
