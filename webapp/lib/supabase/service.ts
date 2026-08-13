import "server-only";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServiceEnv } from "@/lib/env";
import type { CaptureRow } from "@/lib/capture/schema";
import {
  CAPTURE_TOKEN_COLS,
  type CaptureOutcome,
  type CaptureStore,
  type CaptureTokenRow,
} from "@/lib/capture/store";
import {
  DIGEST_POSTING_COLS,
  type DigestPostingView,
  type DigestStore,
  type DigestTriageInput,
  type DigestWriteOutcome,
} from "@/lib/digest/store";
import type {
  ClaimOutcome,
  EmailStore,
  LifecycleSendKind,
  PendingLifecycleSend,
  SendRecord,
} from "@/lib/email/store";

/**
 * The service-role client, and the ONLY module in this app that builds one.
 *
 * `lib/supabase/server.ts` is the client every page and action uses: anon key,
 * the visitor's session cookies, RLS deciding every row. It says the app never
 * holds a service key, and for every surface a person drives that remains true.
 * `/api/capture` is the exception argued in `lib/env.ts` — an Apps Script with a
 * bearer token and no browser — and confining the exception to one file is what
 * keeps it an exception.
 *
 * `/d/<token>` is the SECOND caller with the same shape and it lives here rather
 * than in an `admin.ts` of its own (which is what `docs/plans/PHASE-DIGEST.md` §5
 * sketched). The reason is the containment test: it asserts an exact list of
 * files that may hold a service client, and one module with two stores keeps that
 * list at one name. A second module would make "the only file that builds a
 * service client" a sentence with an exception in it, and exceptions are how the
 * next one gets added without an argument. The credential story is identical —
 * no session, no cookie, an acting user learned from an HMAC signature instead of
 * from a bearer token — so it is the same exception, not a new one.
 *
 * THREE THINGS KEEP THE KEY OFF THE CLIENT, and none of them is discipline:
 *
 *   1. `SUPABASE_SERVICE_KEY` has no `NEXT_PUBLIC_` prefix, so it is never
 *      inlined into a browser bundle. This is the actual guarantee.
 *   2. `import "server-only"` at the top: a client component importing this is a
 *      build failure, not a leak.
 *   3. `tests/unit/service-key-containment.test.ts` asserts the env name appears
 *      in exactly the files allowed to hold it, so the next module that wants a
 *      service client has to argue for it in a diff rather than acquire one.
 *
 * `persistSession: false` because there is no session to persist and no storage
 * to persist it in; leaving it on makes supabase-js reach for a browser API that
 * is not there.
 */
function serviceClient(): SupabaseClient {
  const env = getServiceEnv();
  if (!env) {
    // Callers check `getServiceEnv()` first and answer 503; this only fires when
    // that contract is broken, and it must be loud rather than a client pointed
    // at "undefined".
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_KEY missing — /api/capture and /d/<token> cannot " +
        "write without them.",
    );
  }
  return createSupabaseClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 0018. Named so `tests/core/test_migrations.py` can prove it exists with these
 *  parameters — a typo in an RPC name is a 404 the retry queue would grind on. */
export const CAPTURE_RPC = "hq_capture_email_events";

export class SupabaseCaptureStore implements CaptureStore {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? serviceClient();
  }

  async tokenBySelector(selector: string): Promise<CaptureTokenRow | null> {
    const { data, error } = await this.client
      .from("capture_tokens")
      .select(CAPTURE_TOKEN_COLS)
      .eq("selector", selector)
      .maybeSingle();
    // `maybeSingle` answers `{data: null, error: null}` for no row, which is the
    // ordinary case for a token that was never minted. A real error — the store
    // is down, the key is wrong — must not be reported as "unknown token", or a
    // dead database reads to the operator as a bad credential.
    if (error) throw new Error(`capture_tokens lookup failed: ${error.message}`);
    return (data as CaptureTokenRow | null) ?? null;
  }

  async storeEvents(
    userId: string,
    tokenId: number,
    rows: CaptureRow[],
  ): Promise<CaptureOutcome[]> {
    const { data, error } = await this.client.rpc(CAPTURE_RPC, {
      p_user_id: userId,
      p_token_id: tokenId,
      p_events: rows,
    });
    if (error) throw new Error(`${CAPTURE_RPC} failed: ${error.message}`);
    const results = (data as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) {
      // The function always returns `{results: [...]}`. Anything else is a
      // different function than the one this code was written against, and
      // counting it as success would report a stored batch that was not stored.
      throw new Error(`${CAPTURE_RPC} returned no results array`);
    }
    return results as CaptureOutcome[];
  }
}

/** 0019. Named so `tests/core/test_migrations.py` can prove it exists with these
 *  parameters — a typo in an RPC name is a 404, and the only thing between the
 *  vitest suite (fake store) and the db suite (raw SQL) is this string. */
export const DIGEST_RPC = "hq_digest_set_triage";

/**
 * Postgres's `errcode` for 0019's "no such posting for this user".
 *
 * Matched rather than the message, because the message names the posting key and
 * a future edit to that sentence must not turn "no longer listed" into a 500 on
 * the one page `docs/plans/PHASE-DIGEST.md` row 41 says may never 500. PostgREST
 * carries the SQLSTATE through as `error.code`.
 */
const NO_SUCH_POSTING = "P0002";

export class SupabaseDigestStore implements DigestStore {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? serviceClient();
  }

  async postingForUser(userId: string, postingKey: string): Promise<DigestPostingView | null> {
    const { data, error } = await this.client
      .from("user_postings")
      .select(DIGEST_POSTING_COLS)
      .eq("user_id", userId)
      .eq("posting_key", postingKey)
      .maybeSingle();
    // `maybeSingle` answers `{data: null, error: null}` for no row, which is the
    // ordinary case for a posting this user was never gated. A real error — the
    // store is down, the key is wrong — must not be reported as "not yours", or a
    // dead database reads to a person as "that job is gone".
    if (error) throw new Error(`user_postings lookup failed: ${error.message}`);
    if (!data) return null;
    const row = data as Record<string, unknown>;
    // PostgREST renders a to-one embed as an object and a to-many as an array,
    // and which one it picks depends on how it infers the relationship —
    // `toJobView` unwraps both for the same reason.
    const p = (Array.isArray(row.postings) ? row.postings[0] : row.postings) as
      | Record<string, unknown>
      | undefined;
    if (!p) return null;
    return {
      postingKey: String(row.posting_key ?? postingKey),
      company: String(p.company ?? ""),
      title: String(p.title ?? ""),
      location: String(p.location ?? ""),
      url: String(p.url ?? ""),
      status: String(p.status ?? ""),
      triage: String(row.triage ?? ""),
    };
  }

  async setTriage(input: DigestTriageInput): Promise<DigestWriteOutcome> {
    const { data, error } = await this.client.rpc(DIGEST_RPC, {
      p_user_id: input.userId,
      p_posting_key: input.postingKey,
      p_triage: input.triage,
      p_idem: input.idem,
    });
    if (error) {
      if (error.code === NO_SUCH_POSTING) return { outcome: "missing" };
      throw new Error(`${DIGEST_RPC} failed: ${error.message}`);
    }
    const row = data as Record<string, unknown> | null;
    if (!row || typeof row.triage !== "string") {
      // The function always returns `app_triage_row`'s object. Anything else is a
      // different function than the one this was written against, and rendering
      // "saved" over it would tell somebody their decision landed when the shape
      // says nobody knows what landed.
      throw new Error(`${DIGEST_RPC} returned no triage row`);
    }
    return { outcome: "applied", triage: row.triage, posting: triageRowPosting(row) };
  }
}

/** 20260813_055534 (#203). Named so `tests/core/test_migrations.py` can prove
 *  each exists with these parameters — a typo in an RPC name is a 404 the
 *  dispatch loop would grind on. */
export const EMAIL_PENDING_RPC = "hq_email_pending_lifecycle";
export const EMAIL_CLAIM_RPC = "hq_email_claim_send";
export const EMAIL_RECORD_RPC = "hq_email_record_send";

/**
 * The THIRD store in this module, same argument as the second: the caller
 * (`/api/email/dispatch`) has no session and cannot have one — it acts on
 * operator decisions made in the SQL editor, for users whose browsers are not
 * involved. Same exception, not a new one; the containment test's file list
 * stays at one name.
 *
 * Every method throws on a store error rather than reporting an empty queue or
 * a landed outcome: a dead ledger must read as dead, because "no pending mail"
 * and "could not ask" are different facts and only one of them is calm.
 */
export class SupabaseEmailStore implements EmailStore {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? serviceClient();
  }

  async pendingLifecycle(): Promise<PendingLifecycleSend[]> {
    const { data, error } = await this.client.rpc(EMAIL_PENDING_RPC);
    if (error) throw new Error(`${EMAIL_PENDING_RPC} failed: ${error.message}`);
    if (!Array.isArray(data)) {
      throw new Error(`${EMAIL_PENDING_RPC} returned no rows array`);
    }
    return data.map((row: Record<string, unknown>) => ({
      sendKey: String(row.send_key ?? ""),
      userId: String(row.user_id ?? ""),
      eventKind: String(row.event_kind ?? ""),
      email: String(row.email ?? ""),
      name: String(row.name ?? ""),
      occurredAt: String(row.occurred_at ?? ""),
    }));
  }

  async claimSend(input: {
    sendKey: string;
    userId: string;
    kind: LifecycleSendKind;
    recipient: string;
  }): Promise<ClaimOutcome> {
    const { data, error } = await this.client.rpc(EMAIL_CLAIM_RPC, {
      p_send_key: input.sendKey,
      p_user_id: input.userId,
      p_kind: input.kind,
      p_recipient: input.recipient,
    });
    if (error) throw new Error(`${EMAIL_CLAIM_RPC} failed: ${error.message}`);
    const row = data as { claimed?: unknown; status?: unknown; reason?: unknown } | null;
    if (!row || typeof row.claimed !== "boolean") {
      // The function always answers `{claimed, status, …}`. Anything else is a
      // different function than this was written against, and treating it as
      // a claim would send mail nothing recorded.
      throw new Error(`${EMAIL_CLAIM_RPC} returned no claim verdict`);
    }
    if (row.claimed) return { claimed: true };
    return {
      claimed: false,
      status: String(row.status ?? ""),
      reason: String(row.reason ?? ""),
    };
  }

  async recordSend(sendKey: string, record: SendRecord): Promise<void> {
    const { error } = await this.client.rpc(EMAIL_RECORD_RPC, {
      p_send_key: sendKey,
      p_status: record.status,
      p_provider: record.provider,
      p_provider_message_id: record.status === "sent" ? record.providerMessageId : "",
      p_reason: record.status === "sent" ? "" : record.reason,
    });
    // Including P0002 ("no claimed row"): the dispatch loop only records what
    // it just claimed, so an unclaimed key here is a harness bug, not a state.
    if (error) throw new Error(`${EMAIL_RECORD_RPC} failed: ${error.message}`);
  }
}

/**
 * The posting nested inside `app_triage_row`'s jsonb, as the page needs it.
 *
 * A jsonb object rather than a PostgREST embed, so no array/object ambiguity —
 * but every field is still read defensively: this crosses a JSON boundary the
 * TypeScript compiler cannot see into, and a renamed column would arrive as
 * `undefined` and be printed as the word "undefined" next to somebody's job.
 */
function triageRowPosting(row: Record<string, unknown>): DigestPostingView | null {
  const p = row.postings as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") return null;
  return {
    postingKey: String(row.posting_key ?? p.key ?? ""),
    company: String(p.company ?? ""),
    title: String(p.title ?? ""),
    location: String(p.location ?? ""),
    url: String(p.url ?? ""),
    status: String(p.status ?? ""),
    triage: String(row.triage ?? ""),
  };
}
