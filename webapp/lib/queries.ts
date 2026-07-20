import type { SupabaseClient } from "@supabase/supabase-js";
import type { Application, ChannelRun, Posting, QueueItem } from "@/lib/types";

/**
 * One typed read helper per page. v1 is READ-ONLY — no insert/update/delete
 * helpers exist in this file on purpose; writes arrive in Phase 2 stage 3.
 *
 * Every helper runs under the signed-in user's session (anon key + RLS does
 * the real authorization); user_id filters below are scoping, not security.
 * Helpers return { rows, error } — pages render friendly error states, never
 * throw at the user.
 */

type Result<T> = { rows: T[]; error: string | null };

const POSTING_COLUMNS =
  "key, company, title, location, url, posted, first_seen, last_seen, status, tags, geo, source";

/**
 * /queue — today's queue: qualified, untriaged postings for this user,
 * freshest first (by the posting's last_seen), capped at 50.
 */
export async function fetchQueue(
  supabase: SupabaseClient,
  userId: string,
): Promise<Result<QueueItem>> {
  const { data, error } = await supabase
    .from("user_postings")
    .select(
      `posting_key, disposition, disposition_reason, triage, score, updated_at, postings!inner(${POSTING_COLUMNS})`,
    )
    .eq("user_id", userId)
    .eq("disposition", "qualified")
    .eq("triage", "")
    // A posting the board has dropped is not actionable — never queue a dead
    // ad the user would click through to a 404.
    .neq("postings.status", "Closed")
    // Order the queue by the joined posting's last_seen (to-one embed order).
    .order("postings(last_seen)", { ascending: false, nullsFirst: false })
    .limit(50);

  if (error) return { rows: [], error: error.message };

  // PostgREST returns the to-one embed as an object; normalize defensively in
  // case the relationship is ever reported as an array.
  const rows: QueueItem[] = (data ?? []).flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const posting = Array.isArray(r.postings) ? r.postings[0] : r.postings;
    if (!posting) return [];
    return [{ ...(r as object), postings: posting as Posting } as QueueItem];
  });

  return { rows, error: null };
}

/**
 * /pipeline — this user's applications ordered by PIPELINE PROGRESSION
 * (Inbox → … → Offer, then terminal states), newest activity first within a
 * stage. Postgres would sort the status text alphabetically ("Applied" above
 * "Inbox"), which buries early-stage rows, so the canonical order from
 * core/schema.py is applied here after the fetch.
 */
const STATUS_ORDER = [
  "Inbox", "Queued", "Applied", "OA", "Screen", "Interview", "Final", "Offer",
  "Rejected", "Withdrawn", "Closed",
];

export async function fetchPipeline(
  supabase: SupabaseClient,
  userId: string,
): Promise<Result<Application>> {
  const { data, error } = await supabase
    .from("applications")
    .select(
      "id, user_id, posting_key, company, title, url, status, suggested_status, evidence, applied_date, next_action, next_action_date, notes, updated_at",
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) return { rows: [], error: error.message };

  // A human-invented status (the sheet allows them) sorts after every known
  // one rather than vanishing or landing mid-pipeline.
  const rank = (s: string) => {
    const i = STATUS_ORDER.indexOf(s);
    return i === -1 ? STATUS_ORDER.length : i;
  };
  const rows = ((data ?? []) as unknown as Application[])
    .slice()
    .sort((a, b) => rank(a.status) - rank(b.status));

  return { rows, error: null };
}

/**
 * /health — recent channel_runs, newest first. Fetches a wider window (100)
 * so the per-channel "hours since last run" strip covers channels that
 * haven't run in the latest 20; the table shows only the first 20.
 * RLS decides visibility (operator view).
 */
export async function fetchHealth(
  supabase: SupabaseClient,
): Promise<Result<ChannelRun>> {
  const { data, error } = await supabase
    .from("channel_runs")
    .select("id, user_id, channel, ran_at, fetched, new_rows, filtered, tagged, errors")
    .order("ran_at", { ascending: false })
    .limit(100);

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as unknown as ChannelRun[], error: null };
}
