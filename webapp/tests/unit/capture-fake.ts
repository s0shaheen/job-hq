import type { CaptureRow } from "@/lib/capture/schema";
import type { CaptureOutcome, CaptureStore, CaptureTokenRow } from "@/lib/capture/store";

/**
 * A `CaptureStore` that behaves the way 0018 behaves — including where 0018
 * refuses.
 *
 * "A fake must reproduce the real thing's failure modes, not just its happy
 * path" (`docs/WEBAPP-BUILD.md`), and the specific way that rule has been broken
 * three times in this repo is a fake that ACCEPTS what the store would reject.
 * So this one carries the four refusals `hq_capture_email_events` can produce,
 * and `capture-parity.test.ts` extracts each of them from the migration text
 * rather than trusting the list below.
 *
 * The dedup is per (user_id, event_id) and it survives across CALLS, which is the
 * property the whole retry design rests on: the script resends a batch it already
 * sent, and every row of it must come back `duplicate` rather than landing twice.
 */

/** Mirrors 0018's `c_max_events`; the parity test pins the number. */
export const FAKE_MAX_EVENTS = 500;

/** `hq_email_event_types()`; the parity test extracts the SQL array and compares. */
export const EVENT_TYPES_SQL = [
  "received",
  "rejection",
  "oa_invite",
  "interview",
  "recruiter_outreach",
  "offer",
  "other",
];

/** The composite key, spelled once. A space is safe: a Message-ID cannot hold one. */
function rowKey(userId: string, eventId: string): string {
  return `${userId} ${eventId}`;
}

export class FakeCaptureStore implements CaptureStore {
  readonly tokens = new Map<string, CaptureTokenRow>();
  /** `rowKey(user_id, event_id)` -> the row as stored. */
  readonly events = new Map<string, CaptureRow & { user_id: string }>();
  /** token id -> the last time `storeEvents` accepted a call with it. */
  readonly lastUsed = new Map<number, number>();
  /** Make the next token LOOKUP throw, the way a store outage does. */
  failNextLookup: string | null = null;
  /** Make the next WRITE throw. Separate, because the route answers each with a
   *  different sentence and collapsing them hid which branch a test drove. */
  failNextWrite: string | null = null;
  lookups = 0;

  addToken(row: Partial<CaptureTokenRow> & { selector: string }): CaptureTokenRow {
    const full: CaptureTokenRow = {
      id: row.id ?? this.tokens.size + 1,
      user_id: row.user_id ?? "11111111-1111-1111-1111-111111111111",
      secret_sha256: row.secret_sha256 ?? "0".repeat(64),
      revoked_at: row.revoked_at ?? null,
    };
    this.tokens.set(row.selector, full);
    return full;
  }

  async tokenBySelector(selector: string): Promise<CaptureTokenRow | null> {
    this.lookups += 1;
    if (this.failNextLookup) {
      const why = this.failNextLookup;
      this.failNextLookup = null;
      throw new Error(why);
    }
    return this.tokens.get(selector) ?? null;
  }

  async storeEvents(
    userId: string,
    tokenId: number,
    rows: CaptureRow[],
  ): Promise<CaptureOutcome[]> {
    if (this.failNextWrite) {
      const why = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(why);
    }
    if (rows.length > FAKE_MAX_EVENTS) {
      // The SQL RAISEs here rather than answering per-row, and so does this: a
      // cap breached is a bad CALL, not a bad row.
      throw new Error(`capture batch of ${rows.length} exceeds the ${FAKE_MAX_EVENTS} event cap`);
    }
    const out = rows.map((row, index) => {
      const bad = checkRow(row);
      if (bad) {
        return { index, event_id: row.event_id, outcome: "rejected" as const, reason: bad };
      }
      const key = rowKey(userId, row.event_id);
      if (this.events.has(key)) {
        return { index, event_id: row.event_id, outcome: "duplicate" as const };
      }
      this.events.set(key, { ...row, user_id: userId });
      return { index, event_id: row.event_id, outcome: "inserted" as const };
    });
    this.lastUsed.set(tokenId, Date.now());
    return out;
  }
}

/**
 * 0018's CHECK constraints, in TypeScript.
 *
 * Deliberately phrased as the DATABASE's refusals rather than as the route's:
 * `parseEvent` produces friendlier sentences and refuses MORE (it bounds text
 * lengths, which the store does not), and the parity test's job is to prove that
 * the route's stricter set is a subset of this one — anything the route accepts,
 * the store accepts.
 */
export function checkRow(row: CaptureRow): string | null {
  if (blankTrim(row.event_id) === "") {
    return 'violates check constraint "email_events_event_id_present"';
  }
  if (!EVENT_TYPES_SQL.includes(row.event_type)) {
    return 'violates check constraint "email_events_type_is_known"';
  }
  if (!(row.confidence >= 0 && row.confidence <= 1)) {
    return 'violates check constraint "email_events_confidence_is_a_probability"';
  }
  if (!castsToTimestamptz(row.received_at)) {
    return `invalid input syntax for type timestamp with time zone: "${row.received_at}"`;
  }
  if (row.processed_at !== null && !castsToTimestamptz(row.processed_at)) {
    return `invalid input syntax for type timestamp with time zone: "${row.processed_at}"`;
  }
  return null;
}

/**
 * 0010's `hq_blank_trim`, enough of it for a CHECK on a Message-ID.
 *
 * The zero-width class is written as ESCAPES, never as the characters
 * themselves — 0010's own rule, and this file broke it once: the literal
 * version put four invisible codepoints in a source line nobody could read or
 * review, and one of them was indistinguishable from a typo.
 */
function blankTrim(s: string): string {
  return s.replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim();
}

/**
 * Whether Postgres would take this as a `timestamptz`.
 *
 * NOT a general date parser and not trying to be: `parseEvent` has already
 * normalized every stamp to `Date.prototype.toISOString()`'s output, so the only
 * question the fake has to answer honestly is whether an UNNORMALIZED value —
 * one a test hands to `storeEvents` directly, bypassing the route — would cast.
 */
function castsToTimestamptz(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/.test(value) &&
    !Number.isNaN(Date.parse(value.replace(" ", "T")))
  );
}
