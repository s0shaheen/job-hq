/**
 * Row types for the Phase-2 schema. These mirror the designed tables exactly —
 * do not invent columns here; schema changes land in the database first.
 * We keep hand-written types (no generated Database types yet) and cast query
 * results in lib/queries.ts.
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
  location: string | null;
  url: string;
  posted: string | null;
  first_seen: string | null;
  last_seen: string | null;
  status: string | null;
  tags: PostingTags | null;
  geo: PostingGeo | null;
  source: string | null;
};

export type UserPosting = {
  user_id: string;
  posting_key: string;
  disposition: string | null;
  disposition_reason: string | null;
  triage: string | null;
  triage_reason: string | null;
  snooze_until: string | null;
  score: number | null;
  updated_at: string | null;
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
  url: string | null;
  status: string;
  suggested_status: string | null;
  evidence: string | null;
  applied_date: string | null;
  next_action: string | null;
  next_action_date: string | null;
  notes: string | null;
  updated_at: string | null;
};

export type ChannelRun = {
  // bigint identity: PostgREST serializes int8 as a JSON number
  id: number;
  user_id: string | null;
  channel: string;
  ran_at: string;
  fetched: number | null;
  new_rows: number | null;
  filtered: number | null;
  tagged: number | null;
  errors: number | string | null;
};

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  is_operator: boolean;
};
