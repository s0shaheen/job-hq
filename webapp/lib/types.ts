/**
 * Row types for the Phase-2 schema. These mirror the designed tables exactly —
 * do not invent columns here; schema changes land in the database first.
 * We keep hand-written types (no generated Database types yet) and cast query
 * results in lib/queries.ts.
 *
 * "Exactly" is enforced: tests/unit/types-contract.test.ts parses
 * db/migrations/*.sql and fails on any column, nullability, or serialized-kind
 * divergence — this file had drifted (missing columns, `| null` on NOT NULL
 * columns) and nothing noticed, because a cast through `unknown` cannot.
 * Dates and timestamps arrive as strings; NOT NULL text columns arrive as ""
 * when unset, never null — the two are different claims and consumers write
 * different fallbacks for them.
 */

/** postings.tags — jsonb written by the tagging pipeline. */
export type PostingTags = {
  min_yoe?: number | string | null;
  comp_range?: string | null;
  [key: string]: unknown;
};

/** postings.geo — jsonb written by the geo backfill. */
export type PostingGeo = {
  city?: string | null;
  state?: string | null;
  country?: string | null;
  remote?: boolean | string | null;
  market?: string | null;
  [key: string]: unknown;
};

export type Posting = {
  key: string;
  company: string;
  title: string;
  location: string;
  url: string;
  posted: string | null;
  first_seen: string;
  last_seen: string;
  status: string;
  tags: PostingTags;
  geo: PostingGeo;
  source: string;
  created_at: string;
  updated_at: string;
};

export type UserPosting = {
  user_id: string;
  posting_key: string;
  disposition: string;
  disposition_reason: string;
  triage: string;
  triage_reason: string;
  snooze_until: string | null;
  score: number | null;
  created_at: string;
  updated_at: string;
};

/** A queue row: user_postings joined to its (to-one) posting. */
export type QueueItem = Pick<
  UserPosting,
  "posting_key" | "disposition" | "disposition_reason" | "triage" | "score" | "updated_at"
> & {
  postings: Posting;
};

export type Application = {
  // bigint identity: PostgREST serializes int8 as a JSON number
  id: number;
  user_id: string;
  posting_key: string | null;
  company: string;
  title: string;
  url: string;
  source: string;
  status: string;
  /**
   * Who last set `status` — 'system' or 'user' (0010). NOT NULL with a default,
   * so it arrives as a string, never null. When it reads 'user' no bot write may
   * change the status: the lock that makes acceptance criterion 14 hold.
   */
  status_actor: string;
  /** When `status` was last set, by anyone. Null on a row nothing has set. */
  status_set_at: string | null;
  suggested_status: string;
  evidence: string;
  applied_date: string | null;
  applied_via: string;
  applied_email: string;
  last_activity: string | null;
  next_action: string;
  next_action_date: string | null;
  /**
   * The flat legacy column, KEPT. 0010 copied it into `application_notes` and
   * left it in place: spec §E round-trips it and the export reads it, so a
   * destructive migration here would blank a column in every export.
   */
  notes: string;
  created_at: string;
  updated_at: string;
};

/**
 * One append-only note (0010). There is no `updated_at` because there is no
 * update — `revoke update, delete` is what makes that structural rather than a
 * convention, and a nullable "edited at" column would invite the opposite.
 */
export type ApplicationNote = {
  // bigint identity: PostgREST serializes int8 as a JSON number
  id: number;
  user_id: string;
  application_id: number;
  body: string;
  author: string;
  created_at: string;
};

export type ChannelRun = {
  // bigint identity: PostgREST serializes int8 as a JSON number
  id: number;
  user_id: string | null;
  channel: string;
  ran_at: string;
  fetched: number;
  new_rows: number;
  filtered: number;
  tagged: number;
  errors: number;
  detail: Record<string, unknown>;
};

export type UserRow = {
  id: string;
  email: string;
  name: string;
  is_operator: boolean;
  created_at: string;
};

/**
 * The shared company universe (0001) plus the discovery metadata 0007 added.
 *
 * `reliability_tier` is the one nullable column and deliberately so: a company is
 * *unresolved* until the resolution waterfall has actually pulled its jobs, and
 * null says that rather than picking a tier on its behalf. `source` and
 * `resolution_method` are NOT NULL with '' defaults, so an unresolved row arrives
 * as an empty string, never null — the mirror inserts name/ats/slug only.
 */
export type Company = {
  // bigint identity: PostgREST serializes int8 as a JSON number
  id: number;
  name: string;
  ats: string;
  slug: string;
  source: string;
  reliability_tier: number | null;
  resolution_method: string;
};

/**
 * One user's subscription to a company: the per-user half of the shared universe.
 *
 * `review_state` and `updated_at` arrived in 0008 — the human decision on a
 * proposal is per-user by construction, and the table had no optimistic-
 * concurrency token at all before then.
 */
export type UserCompany = {
  user_id: string;
  company_id: number;
  monitor: boolean;
  priority: boolean;
  seeded: boolean;
  review_state: string;
  updated_at: string;
};
