/**
 * The store seam for `/d/<token>`.
 *
 * Two methods, for `lib/capture/store.ts`'s reason: `DataSource` is built around
 * a SESSION and RLS decides every row, and this caller has no session at all. It
 * is a different boundary and it gets its own small interface, so the fake the
 * unit suite drives is a fake of two operations rather than of thirty.
 *
 * THE READ IS SCOPED TO THE USER, AND THAT IS A SECURITY PROPERTY, not a
 * convenience. The user comes out of the token's signature, never out of a query
 * parameter, and `postingForUser` looks in that user's `user_postings` — so a
 * token minted for one person against a posting only another person was gated
 * answers `null` and the page says "no longer listed" (matrix row 40). A read of
 * `postings` alone would have leaked company and title to whoever held the link.
 *
 * **A FAKE MUST REPRODUCE THE REAL THING'S FAILURE MODES** (`docs/WEBAPP-BUILD.md`,
 * paid for three times). The one that matters here is `missing`: 0019 RAISES
 * `no such posting for this user`, so `setTriage` reports it as an outcome rather
 * than letting a P0002 become a 500 on a page that must never 500 (row 41).
 */

/** What the confirmation page renders, and nothing else. */
export type DigestPostingView = {
  postingKey: string;
  company: string;
  title: string;
  location: string;
  url: string;
  /** `postings.status`: New | Seen | Closed, or whatever a human typed. */
  status: string;
  /** `user_postings.triage`: '' | interested | dismissed | snoozed. */
  triage: string;
};

/**
 * `applied` carries the triage the row ended up with — which is the FIRST call's
 * answer on a replay, because that is what `command_idempotency` stored.
 *
 * It carries the POSTING too, read out of the same jsonb the function already
 * returns (`app_triage_row` nests it). The success page names the company and the
 * title, and fetching them in a second round trip would be a second chance for
 * the two to disagree: the row this reports is the row the write produced, inside
 * the transaction that produced it.
 */
export type DigestWriteOutcome =
  | { outcome: "applied"; triage: string; posting: DigestPostingView | null }
  | { outcome: "missing" };

export type DigestTriageInput = {
  userId: string;
  postingKey: string;
  /** '' (undo) | interested | dismissed. 0019 refuses anything else by name. */
  triage: string;
  /** The token's `jti`. What makes a double-tap and a mail-gateway replay free. */
  idem: string;
};

export interface DigestStore {
  /** The user's row for this posting, or null. Never throws for "not found". */
  postingForUser(userId: string, postingKey: string): Promise<DigestPostingView | null>;
  /** Apply one decision. Throws only for a store that is actually broken. */
  setTriage(input: DigestTriageInput): Promise<DigestWriteOutcome>;
}

/**
 * The columns the read must ask for.
 *
 * Named as a const for `supabase-select-lists.test.ts`'s reason: a mapper reading
 * a column the select never requested gets `undefined`, coerces to something
 * plausible, and is silent. Here that column would be `status`, and the page
 * would offer a decision on a posting that closed a week ago.
 */
export const DIGEST_POSTING_COLS = "posting_key, triage, postings!inner(company, title, location, url, status)";

/** `postings.status` for a board listing that is gone. Row 41's trigger. */
export const CLOSED_STATUS = "Closed";
