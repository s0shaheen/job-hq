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
  /**
   * The import batch that CREATED this row (0011), null for everything else.
   *
   * It is what `app_import_undo` uses to find exactly what a batch made, so it
   * is the difference between a reversible import and a permanent one.
   */
  import_batch_id: string | null;
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
 *
 * 0013 adds two more. `linkedin_company_id` is the `f_C=` number somebody pasted,
 * '' until they do — free-vocab at the column (0008's `source` precedent: a
 * table-wide CHECK lets one unrecognised value fail a 500-row mirror chunk), so
 * every reader has to treat it as untrusted text. `updated_at` is the shared
 * row's optimistic-concurrency token, distinct from `user_companies.updated_at`,
 * and the two guard different writes.
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
  linkedin_company_id: string;
  updated_at: string;
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

/**
 * One row of the user's own LinkedIn `Connections.csv` export (0013).
 *
 * Read directly through PostgREST by every surface that shows a warm path, which
 * is why it is in the drift contract: a shape change here is a blank popover
 * rather than a type error.
 *
 * `company_key` is GENERATED in SQL (`company_name_key(company)`) and therefore
 * read-only from here — the match this table exists for compares THAT, never the
 * raw string, and a generated column is what stops the normalization from
 * drifting away from the one the company universe uses.
 */
export type Connection = {
  // bigint identity: PostgREST serializes int8 as a JSON number
  id: number;
  user_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  company: string;
  company_key: string;
  title: string;
  profile_url: string;
  /** Null when the export's date could not be PROVED — never guessed. */
  connected_on: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

/**
 * One uploaded file (0011). Read directly by the wizard, which is why it is in
 * the drift contract: `/import/[batchId]` renders from these columns, so a shape
 * change here is a blank screen rather than a type error.
 *
 * `state` is the resume cursor's other half. `committing` and `failed` are not
 * decoration — a batch that is mid-commit is not "previewed" and a batch that
 * died is not "committed", and silence about either makes a half-imported
 * spreadsheet look identical to a finished one.
 */
export type ImportBatch = {
  id: string;
  user_id: string;
  state: string;
  filename: string;
  source_kind: string;
  content_hash: string;
  row_count: number;
  committed_count: number;
  mapping: unknown;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
  /** When the 24-hour undo window closes. Read from here, never from a clock. */
  undo_expires_at: string | null;
};

/**
 * One source row (0011). `raw` is kept forever — it is the only way to answer
 * "what did the file actually say" a month later, and it costs kilobytes.
 */
export type ImportRow = {
  batch_id: string;
  user_id: string;
  row_number: number;
  raw: unknown;
  mapped: unknown;
  mapped_at: string | null;
  job_key: string;
  key_strength: string;
  match_kind: string;
  matched_application_id: number | null;
  conflict_state: string;
  conflict: unknown;
  choices: unknown;
  included: boolean;
  outcome: string;
  /** What undo needs: the values as they were, and the token the import wrote. */
  revert: unknown;
  notice: string;
  error: string;
};

/**
 * What happened to each COLUMN of the file (0011) — G13's "engine-owned columns
 * re-import as a report, never a silent drop".
 *
 * Keyed by (batch, column, disposition) in SQL, because one column legitimately
 * has several verdicts: "Status — 38 imported" and "Status — 2 left alone, you
 * had chosen those by hand" are both true and the second is the one that matters.
 */
export type ImportColumnReport = {
  batch_id: string;
  user_id: string;
  column_name: string;
  disposition: string;
  rows_affected: number;
  sample: unknown;
};
