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
      "SUPABASE_URL / SUPABASE_SERVICE_KEY missing — /api/capture cannot write without them.",
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
