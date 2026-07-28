import type { CaptureRow } from "./schema";

/**
 * The store seam for `/api/capture`.
 *
 * `lib/data/` is one interface with two implementations for reasons stated at
 * the top of `docs/WEBAPP-BUILD.md`, and the same reasons apply here with one
 * addition: `DataSource` is built around a SESSION (`SupabaseDataSource` holds a
 * user-scoped client and RLS decides), and this caller has no session and writes
 * with the service role. Folding a service-role writer into the interface every
 * page uses would put a key that bypasses RLS one import away from every server
 * component. It is a different boundary and it gets a different, two-method
 * interface.
 *
 * **A FAKE MUST REPRODUCE THE REAL THING'S FAILURE MODES.** The build log's rule,
 * paid for three times. `FakeCaptureStore` therefore models the two things
 * Postgres does that a naive stub would not: it dedupes on (user_id, event_id)
 * across CALLS, and it rejects rows that violate 0018's CHECK constraints per
 * ROW rather than failing the batch. `tests/unit/capture-parity.test.ts` extracts
 * both rules from the migration text and holds the fake to them.
 */

export type CaptureTokenRow = {
  id: number;
  user_id: string;
  secret_sha256: string;
  revoked_at: string | null;
};

/**
 * The columns `tokenBySelector` must ask for.
 *
 * Named as a const for the reason `supabase-select-lists.test.ts` exists: a
 * mapper reading a column the select never requested gets `undefined`, coerces to
 * something plausible, and is silent. Here that column would be
 * `secret_sha256` — the verification would compare against `undefined` and
 * `verifySecret` would answer false for a valid token, forever, in production
 * only. The route's tests pin this list against the fields the verifier reads.
 */
export const CAPTURE_TOKEN_COLS = "id,user_id,secret_sha256,revoked_at";

export type CaptureOutcome = {
  /** Index within the array the CALLER sent, so a rejected row can be named. */
  index: number;
  event_id: string;
  outcome: "inserted" | "duplicate" | "rejected";
  /** Why a row was REFUSED. Set by the store. */
  reason?: string;
  /**
   * What was REPAIRED on a row that landed anyway — a `job_url` the classifier
   * wrote as prose, blanked so it can never reach an `href`. Set by the route's
   * parser rather than the store, and attached to the store's own answer: the row
   * is `inserted`, and a silent edit is the thing worth complaining about.
   */
  note?: string;
};

export interface CaptureStore {
  /** The token row for a selector, or null. Never throws for "not found". */
  tokenBySelector(selector: string): Promise<CaptureTokenRow | null>;
  /**
   * Store a validated batch. Per-row outcomes, in the order given.
   *
   * The store decides `inserted` vs `duplicate`, not the caller: a read-then-write
   * in the route would be a race between two overlapping retries of the same
   * batch, and both would answer "inserted" for one row.
   */
  storeEvents(
    userId: string,
    tokenId: number,
    rows: CaptureRow[],
  ): Promise<CaptureOutcome[]>;
}
