/**
 * The wire contract for `POST /api/capture`, and the closed-set parser that
 * enforces it.
 *
 * PURE ON PURPOSE — no `server-only`, no `node:crypto`, no Supabase. This module
 * is the half of the endpoint that can be reasoned about and tested without a
 * request, a database or a network, and `tests/core/test_capture_contract.py`
 * parses it as text to pin the field list against the other three places the same
 * row shape lives. The impure halves (the credential, the store) are their own
 * files.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE BODY IS THE ROW THE APPS SCRIPT ALREADY BUILDS
 *
 * `appsscript/capture/Code.gs:buildEvent_` produces an object whose keys are
 * `core/schema.py:HEADERS["email_events"]`, appends it to the sheet, and now
 * `JSON.stringify`s the same object into a batch. Nothing is renamed on the way
 * out and nothing is computed for the wire — the whole change on the script side
 * is "POST the rows you were already writing", which is the only kind of change
 * that is reviewable in a file with no local runtime.
 *
 *     { "events": [ { …one row… }, … ] }
 *
 * `matched_key` and `applied_status` are the two headers the script has never
 * written — they belong to the joiner — so they are not in `EVENT_FIELDS`, and
 * sending one is an unknown field. The list here is that header row minus those
 * two, asserted rather than described.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNKNOWN FIELDS ARE REJECTED, AND HERE IS THE COST OF THAT CHOICE
 *
 * The alternative — ignore what you do not recognise — is the friendlier default
 * and the wrong one for this endpoint, because this endpoint has exactly ONE
 * client and that client's row shape is kept in lockstep with two other files by
 * hand. Tolerating unknown keys means the day somebody renames `from` on the
 * script side, every event is accepted, the address is silently dropped, and the
 * only symptom is a column that quietly goes blank. Rejecting names the field.
 *
 * The cost is real and worth stating: deploying a script that sends a NEW field
 * before the webapp knows about it rejects every event in every batch. It is
 * survivable because the sheet append happens first and the joiner reads the tab,
 * and because a rejected row is RETAINED — but only since review, which measured
 * this sentence to be false. A per-row rejection arrives inside a 200, so the
 * script counted it as delivered, dropped it, and pushed nothing; three documents
 * including this one claimed the retry queue held it. The script parks refused
 * rows in `HQ_CAPTURE_PARKED` now, retries them after every future run (so the
 * deploy that fixes the disagreement drains them), and ops-pushes the count and
 * the first reason. `appsscript/README.md` still says webapp first, script
 * second — the mitigation is real, not free.
 */

import { blankTrim } from "@/lib/data/view-models";
import { safeHref } from "@/lib/url/safe-href";

/**
 * Every key the wire accepts, in the sheet's own header order.
 *
 * HQ_CAPTURE_EVENT_FIELDS is a marker, not decoration: the Python contract test
 * extracts this list by name and compares it, element by element, with
 * `core/schema.py:HEADERS["email_events"]`, with `EMAIL_EVENTS_HEADERS` in
 * `Code.gs`, and with the columns `hq_capture_email_events` inserts.
 */
/* HQ_CAPTURE_EVENT_FIELDS */
export const EVENT_FIELDS = [
  "event_id",
  "account",
  "received_at",
  "from",
  "subject",
  "snippet",
  "event_type",
  "company",
  "title",
  "ats",
  "job_url",
  "confidence",
  "evidence",
  "thread_link",
  "processed_at",
] as const;

/**
 * `core/schema.py:EMAIL_EVENT_TYPES` / `hq_email_event_types()`, third copy.
 *
 * Pinned across all four languages by the contract test rather than by this
 * comment — 0015's rule about a list that exists twice.
 */
/* HQ_CAPTURE_EVENT_TYPES */
export const EVENT_TYPES = [
  "received",
  "rejection",
  "oa_invite",
  "interview",
  "recruiter_outreach",
  "offer",
  "other",
] as const;

/** The most events one POST may carry. The script chunks well under this. */
export const MAX_EVENTS = 200;

/**
 * The body cap, counted off the stream (`lib/http/bounded.ts`).
 *
 * An event is a subject, a 300-character snippet and a 200-character evidence
 * quote — call it 2 kB at the top end, so 200 of them is ~400 kB. 1 MB is
 * comfortably above the largest honest batch and far below "somebody is using
 * this endpoint as a memory allocator".
 */
export const MAX_BODY_BYTES = 1_000_000;

/** One row, as the store's function wants it: column names, normalized values. */
export type CaptureRow = {
  event_id: string;
  account: string;
  received_at: string;
  /**
   * The wire says `from`; the column is `from_addr`, because `from` is a
   * reserved word and quoting it in every future query is a tax paid forever for
   * one column name. This is the ONE rename between the two vocabularies and it
   * happens here, once.
   */
  from_addr: string;
  subject: string;
  snippet: string;
  event_type: string;
  company: string;
  title: string;
  ats: string;
  job_url: string;
  confidence: number;
  evidence: string;
  thread_link: string;
  processed_at: string | null;
};

export type EventParse =
  /**
   * `note` is what a REPAIR leaves behind. The row is stored — that is the whole
   * point of repairing rather than refusing — but something about it was not
   * what the sender said, and a repair nobody is told about is a silent edit.
   * It rides in the per-event result next to `outcome`, so the script logs it
   * and a person reading the response sees it.
   */
  | { ok: true; row: CaptureRow; note?: string }
  | { ok: false; reason: string };

export type BatchParse =
  | { ok: true; events: unknown[] }
  /**
   * `status` because the envelope has two different failures and they mean
   * different things to a sender with a retry queue: 400 is "this body is not a
   * batch, fixing it is a code change", 413 is "this batch is too big, send it in
   * pieces". Collapsing them into 400 told the script to stop trying at exactly
   * the moment chunking would have worked.
   */
  | { ok: false; reason: string; status: 400 | 413 };

/**
 * The per-field bounds, and an honest note about WHERE they live.
 *
 * Above every producer's own truncation (`Code.gs` cuts snippet at 300, evidence
 * at 200, company at 80) with room for a subject line nobody truncates.
 *
 * **These are the only bound.** 0018 declares bare `text` columns, so a caller
 * that bypassed this parser could store a two-megabyte subject — measured, in
 * review. That is acceptable exactly because `hq_capture_email_events` is granted
 * to `service_role` alone and this route is its only caller; the alternative
 * (a `length()` CHECK per column) buys nothing today and costs the property C-1
 * and m-2 are both about, which is that the route must never accept what the
 * store refuses. Adding column bounds means adding them at 4x these numbers and
 * teaching the parity test about each one, and that is a trade to make when a
 * second caller exists, not before.
 */
const TEXT_LIMITS: Record<string, number> = {
  event_id: 998, // RFC 5322's line limit; a Message-ID cannot honestly exceed it
  account: 40,
  from: 320, // RFC 5321's maximum path length
  subject: 2000,
  snippet: 2000,
  company: 200,
  title: 300,
  ats: 40,
  job_url: 2000,
  evidence: 1000,
  thread_link: 2000,
};

/**
 * A string Postgres can actually hold, out of one it cannot.
 *
 * THE BUG THIS CLOSES IS THE ENDPOINT'S CENTRAL CLAIM FAILING. "One bad row never
 * drops the batch" is enforced by a per-row exception block inside
 * `hq_capture_email_events` — and two character classes never reach that block,
 * because they are refused at the **jsonb cast**, one layer above the function
 * body. Measured against postgres:16 in review:
 *
 *     U+0000 anywhere in a text field   -> 22P05 unsupported Unicode escape sequence
 *     an unpaired surrogate             -> 22P02 invalid input syntax for type json
 *     one poisoned row in a batch of 50 -> all 50 lost, 0 rows written
 *
 * And it wedges rather than merely dropping: the whole chunk goes back into the
 * script's retry queue, replays at the FRONT of the next run, fails again, and
 * takes every event behind it with it until the bad row ages out of a 40-event
 * window. Weeks, at this mail volume, reported as "the endpoint was unreachable".
 *
 * REACHABLE FROM ORDINARY MAIL, not from an attacker. `Code.gs` truncates with
 * `.slice(n)` on UTF-16 units — `snippet` at 300, and five more in the classifier
 * — and an emoji landing on the boundary is cut in half. Recruiter mail is full
 * of them. (The script now truncates on whole code points, so it stops
 * manufacturing them; this is the backstop for everything else, including an LLM
 * that emits a lone `\ud83c` of its own.)
 *
 * NORMALISE RATHER THAN REJECT, for content. A snippet losing one character to
 * U+FFFD is invisible; refusing the event loses a status change. The one field
 * that is NOT content is `event_id`, and `parseEvent` refuses a row whose key
 * this function would have altered.
 *
 * `toWellFormed()` is ES2024 / Node ≥20, and `package.json` pins `>=20.19`.
 */
export function storable(v: string): string {
  // The NUL is spelled as an ESCAPE, never as the character itself — 0010's
  // rule, and this file broke it once already in review: a literal U+0000 in a
  // source line is a guard nobody can read, review, or notice the deletion of.
  return v.replaceAll("\u0000", "").toWellFormed();
}

/**
 * A URL safe to put in an `href`, repaired if it can be and blanked if it cannot.
 *
 * `job_url` is the one genuinely third-party value on the row: an LLM read it out
 * of an untrusted email body. PHASE-DIGEST 3–6 puts these rows into a mailed HTML
 * document, so an unchecked `javascript:` or `data:text/html,` here is a stored
 * one-click waiting for a feature that is already designed. `lib/referral/
 * linkedin.ts:connectionUrl` guards a URL out of a CSV cell for exactly this
 * reason (matrix row 267).
 *
 * **IT NEVER REJECTS THE EVENT, and the first version did.** That version treated
 * a bad URL as identity rather than content and refused the whole row, so —
 * measured — an interview notification whose `job_url` said `"N/A"`,
 * `"not specified"`, `"/jobs/1234"`, `"www.ramp.com/careers"` or
 * `" https://x.co/j"` (a leading space) was dropped entirely. That contradicts
 * `storable()`'s rule twenty lines up: **normalise for content, refuse only for
 * identity**, and a status change is worth vastly more than the link on it.
 *
 * THE REPAIRS, and they are deliberately two:
 *
 *   * `.trim()`, because a leading space is not an opinion about the URL.
 *   * a bare `www.` host gets `https://`. Nearly unambiguous: `www.` cannot begin
 *     a scheme and cannot begin a path, so a hostname is almost the only thing it
 *     can be. The exception is a FILENAME — `www.resume.pdf` is repaired into
 *     `https://www.resume.pdf`, a link that resolves to nothing. Left that way on
 *     purpose: the only fix is a TLD allowlist, which is a list somebody has to
 *     keep current forever, and it would blank real hosts whose TLD the list has
 *     not heard of. One dead link in a digest row is the cheaper failure.
 *
 * Everything else — `N/A`, `/jobs/1234`, prose, `mailto:`, and every dangerous
 * scheme — BLANKS the field and carries a note into the per-row result. Blanking
 * is the same answer for "the classifier wrote prose" and for "the classifier
 * wrote `javascript:`", which is right: neither is a URL, both must never reach
 * an `href`, and the note is what keeps the second one from being invisible.
 * Guessing a scheme for `/jobs/1234` would mean inventing a host.
 *
 * CREDENTIALS IN THE URL BLANK IT TOO, and the decision is the shared
 * `lib/url/safe-href.ts` — the SAME guard the digest email and the pipeline/queue
 * cells render through. It refuses userinfo in both the `@` and the `\@` forms
 * (`https://evil.com\@good.com` reads as `good.com` and a browser resolves it to
 * `evil.com`), which was the C2 review's M6: this file's own earlier guard used
 * `new URL()` and let the backslash form through while the two renderers refused
 * it. `job_url` is what an LLM read out of an attacker-writable email body, so a
 * stored value that reads as one host and resolves to another is a phish this
 * endpoint would be stamping for a page to render live.
 *
 * The one thing that stays HERE, before the guard, is the `www.` -> `https://`
 * repair: it is capture-specific (the email and the cells never see a bare host),
 * and the guard runs on the repaired candidate, so `www.google.com@evil.example`
 * is refused the same as the explicit form. A path containing `@`
 * (`https://www.ramp.com/@handle`) is kept: the guard fences the authority, not
 * the path.
 */
function safeUrl(v: string): { url: string; note?: string } {
  const trimmed = v.trim();
  if (trimmed === "") return { url: "" };
  const seen = JSON.stringify(trimmed.slice(0, 60));
  let candidate = "";
  if (/^https?:\/\/[^\s]/i.test(trimmed)) candidate = trimmed;
  else if (/^www\.[^\s/]+\.[^\s/]/i.test(trimmed)) candidate = `https://${trimmed}`;
  if (candidate === "") return { url: "", note: `dropped, not an http(s) URL: ${seen}` };

  if (safeHref(candidate) === "") {
    return { url: "", note: `dropped, unsafe to render as a link: ${seen}` };
  }
  return { url: candidate };
}

/**
 * A stamp the store can cast, or a refusal.
 *
 * TWO SHAPES, because the script writes two: `buildEvent_` formats `received_at`
 * as `yyyy-MM-dd'T'HH:mm:ss'Z'` and `nowStamp_` formats `processed_at` as
 * `yyyy-MM-dd HH:mm:ssZ` — the second being `core/sheets._now()`'s shape, which
 * exists so every bot timestamp in the spreadsheet parses identically. Both are
 * accepted and normalized to the first.
 *
 * **A REGEXP IS A SHAPE, NOT A DATE** (matrix row 228, and it bites harder here
 * than in SQL): `Date.parse("2026-02-31T00:00:00Z")` does NOT fail in V8 — it
 * answers March 3rd. So the components are re-read off the constructed instant
 * and compared with what was written. Without that, a day that does not exist is
 * accepted here, silently becomes a different day, and the only thing that ever
 * notices is somebody reading their own timeline months later.
 */
export function normalizeStamp(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(raw);
  if (!m) return null;
  const [y, mo, d, hh, mm, ss] = m.slice(1, 7).map((s) => Number(s));
  const frac = m[7] ?? "";
  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  const at = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss, ms));
  if (
    at.getUTCFullYear() !== y ||
    at.getUTCMonth() !== mo - 1 ||
    at.getUTCDate() !== d ||
    at.getUTCHours() !== hh ||
    at.getUTCMinutes() !== mm ||
    at.getUTCSeconds() !== ss
  ) {
    return null; // 2026-02-31, 2026-07-27T25:00:00Z — shaped right, not a moment
  }
  return at.toISOString();
}

/** The envelope: `{ events: [...] }` and nothing else. */
export function parseBatch(body: unknown): BatchParse {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      reason: 'The body must be a JSON object of the form {"events": [...]}.',
    };
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== "events");
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      reason: `The body carries ${unknown.length} field(s) this endpoint does not accept: ${unknown
        .sort()
        .join(", ")}. The only accepted key is "events".`,
    };
  }
  const events = record.events;
  if (!Array.isArray(events)) {
    return { ok: false, status: 400, reason: '"events" must be an array.' };
  }
  if (events.length === 0) {
    // Not an error the caller can act on, but not a success either: a batch of
    // nothing is a bug in the sender, and answering 200 to it teaches nobody.
    return { ok: false, status: 400, reason: '"events" is empty — there is nothing to store.' };
  }
  if (events.length > MAX_EVENTS) {
    return {
      ok: false,
      status: 413,
      reason: `That batch carries ${events.length} events and this endpoint takes ${MAX_EVENTS} at a time. Send it in chunks.`,
    };
  }
  return { ok: true, events };
}

/**
 * One event, validated against the closed set and normalized into a row.
 *
 * EVERY REFUSAL HERE IS ALSO A CONSTRAINT IN 0018, and that is deliberate rather
 * than redundant: the CHECKs are what hold for every future caller, and these are
 * what let the response say which row and why in a sentence rather than handing
 * back `violates check constraint "email_events_type_is_known"`. The two are
 * pinned against each other in `tests/unit/capture-parity.test.ts` — anything
 * this accepts, the store must accept, or the endpoint's own validator is
 * decorative.
 */
export function parseEvent(raw: unknown): EventParse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const e = raw as Record<string, unknown>;

  const unknown = Object.keys(e).filter((k) => !(EVENT_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `unknown field(s): ${unknown.sort().join(", ")} — this endpoint accepts exactly the Email Events header row`,
    };
  }

  const text = (key: string): string | { bad: string } => {
    const v = e[key];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") return { bad: `${key} must be a string` };
    // STORABLE-ISING, and it is the one transformation in this parser rather
    // than a validation — see `storable()` for why the alternative (reject) is
    // wrong for content. Done BEFORE the length check so the bound applies to
    // what is actually stored.
    const clean = storable(v);
    const limit = TEXT_LIMITS[key];
    if (limit !== undefined && clean.length > limit) {
      return { bad: `${key} is ${clean.length} characters and the limit is ${limit}` };
    }
    return clean;
  };

  const values: Record<string, string> = {};
  for (const key of EVENT_FIELDS) {
    if (key === "confidence") continue;
    const v = text(key);
    if (typeof v !== "string") return { ok: false, reason: v.bad };
    values[key] = v;
  }

  // The dedup key, and the ONE field `storable()` may not silently repair.
  //
  // Everywhere else a NUL or a half-emoji is content damage and losing one
  // character beats losing the event. Here it is the identity: a key this parser
  // invented is a key that can collide with a different message's, or fail to
  // match the same message on a replay. So if normalising CHANGED it, the row is
  // refused and named — which is also the only way the sender ever learns it is
  // manufacturing them.
  const rawEventId = typeof e.event_id === "string" ? e.event_id : "";
  if (rawEventId !== "" && storable(rawEventId) !== rawEventId) {
    return {
      ok: false,
      reason:
        "event_id carries a NUL or an unpaired surrogate — the dedup key must be storable exactly as sent, and this one is not",
    };
  }
  // Trimmed, because ' ' is a legal text value and a legal key, and one caller
  // sending it would make every later event a duplicate of the first — matrix
  // row 218's shape at a new door.
  const eventId = values.event_id.trim();
  // BLANKNESS IS TESTED THE WAY THE STORE TESTS IT. 0018's CHECK is
  // `hq_blank_trim(event_id) <> ''`, which strips U+200B/200C/200D/FEFF as well
  // as whitespace; `String.prototype.trim()` strips none of them. So a
  // zero-width-only id passed this parser and came back from Postgres as a raw
  // constraint name — the exact failure the parity file exists to prevent, found
  // in review. `blankTrim` is the same port `view-models.ts` already carries;
  // what is STORED is still the `.trim()`ed original, because normalising a key
  // is the thing the guard above refuses to do.
  if (blankTrim(eventId) === "") {
    return { ok: false, reason: "event_id is blank — it is the dedup key and cannot be empty" };
  }

  const eventType = values.event_type || "other";
  if (!(EVENT_TYPES as readonly string[]).includes(eventType)) {
    return {
      ok: false,
      reason: `event_type "${eventType}" is not one of ${EVENT_TYPES.join(", ")}`,
    };
  }

  // REQUIRED. `msg.getDate()` cannot fail on the script side, so an event
  // arriving without a parseable one means the sender is not the sender we think
  // it is — and `received_at` is what every later read orders by. Refusing costs
  // nothing during dual-write (the sheet has the row) and guessing `now()` would
  // put a three-week-old rejection at the top of today's timeline.
  const received = normalizeStamp(values.received_at);
  if (received === null) {
    return {
      ok: false,
      reason: values.received_at
        ? `received_at "${values.received_at}" is not an ISO-8601 UTC instant`
        : "received_at is missing",
    };
  }

  // Optional: the script stamps it, an importer might not.
  let processed: string | null = null;
  if (values.processed_at !== "") {
    processed = normalizeStamp(values.processed_at);
    if (processed === null) {
      return {
        ok: false,
        reason: `processed_at "${values.processed_at}" is not an ISO-8601 UTC instant`,
      };
    }
  }

  // The two fields that become an `href`. Content, not identity: repaired where
  // that is unambiguous, blanked otherwise, and the event lands either way.
  const urls: Record<string, string> = {};
  const notes: string[] = [];
  for (const key of ["job_url", "thread_link"] as const) {
    const checked = safeUrl(values[key]);
    urls[key] = checked.url;
    if (checked.note) notes.push(`${key} ${checked.note}`);
  }

  const rawConfidence = e.confidence;
  let confidence = 0;
  if (rawConfidence !== undefined && rawConfidence !== null && rawConfidence !== "") {
    if (typeof rawConfidence !== "number" && typeof rawConfidence !== "string") {
      return { ok: false, reason: "confidence must be a number" };
    }
    // `Number()` on both, and the branch that used to be here had two identical
    // arms. A STRING is accepted deliberately: the sheet lane carries every cell
    // as text and a future importer will hand over "0.9". `Number("")` is 0 and
    // `Number("abc")` is NaN, so both of the ways that goes wrong are caught by
    // the finite check below rather than rounded off.
    confidence = Number(rawConfidence);
    if (!Number.isFinite(confidence)) {
      return { ok: false, reason: `confidence ${JSON.stringify(rawConfidence)} is not a number` };
    }
    if (confidence < 0 || confidence > 1) {
      return { ok: false, reason: `confidence ${confidence} is outside 0..1` };
    }
  }

  return {
    ok: true,
    note: notes.length ? notes.join("; ") : undefined,
    row: {
      event_id: eventId,
      account: values.account,
      received_at: received,
      from_addr: values.from,
      subject: values.subject,
      snippet: values.snippet,
      event_type: eventType,
      company: values.company,
      title: values.title,
      ats: values.ats,
      job_url: urls.job_url,
      confidence,
      evidence: values.evidence,
      thread_link: urls.thread_link,
      processed_at: processed,
    },
  };
}
