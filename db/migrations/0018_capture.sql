-- 0018 — the capture lane gets a home in Postgres: Gmail events over HTTP.
--
-- SHEET-SUNSET Phase C2. The Gmail Apps Script has one output today, the sheet's
-- **Email Events** tab, and it is the one component of this system that lives
-- outside this repo — pasted into script.google.com, running as the owner, with
-- no CI, no typecheck and no local runtime. Phase C's line: "the Gmail Apps
-- Script stops appending to a tab and POSTs to `/api/capture` (bearer token; the
-- script keeps a local retry queue)".
--
-- This migration is the store half of that: the table the endpoint writes, the
-- credential it authenticates with, and the one locked step that turns a batch
-- of classified emails into rows.
--
-- WHAT THIS IS NOT. It is not the cutover. The script DUAL-WRITES until Phase D
-- — sheet first and authoritative, then the POST — so everything here fills
-- alongside a tab that `tracker/join.py` still reads. Nothing in the engine
-- reads `public.email_events` yet; 0015's `hq_apply_email_event` is the door it
-- will eventually knock on, and that function already anticipated this caller by
-- name ("a future `/api/capture` endpoint that writes pg directly gets the policy
-- for free and brings its own classifier").
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE SHAPE IS THE SHEET'S, AND THAT IS DELIBERATE
--
-- `core/schema.py:HEADERS["email_events"]` is the row the Apps Script already
-- builds, and the columns below are that list with three changes, each of which
-- is a thing SQL can say and a spreadsheet cannot:
--
--   * `from` → `from_addr`. `from` is a reserved word; quoting it forever in
--     every query is a tax paid by every future reader for one column name.
--   * the two timestamp cells become `timestamptz`, and NULL is a real answer.
--     A tab stores "2026-07-27 14:02:19Z" as text and hopes; here an unparseable
--     stamp is a rejected ROW with a reason, never a guessed instant.
--   * `captured_at` is new: when the STORE received the event, which is not when
--     Gmail did and not when the classifier ran. During dual-write the gap
--     between `processed_at` and `captured_at` is the only measurement of how
--     long the POST lane was down, and it is invisible without a third stamp.
--
-- `matched_key` and `applied_status` come across unchanged and stay ENGINE-OWNED,
-- exactly as they are in the tab: the capture endpoint never writes them (its
-- validator refuses them as unknown fields), and the joiner stamps them when the
-- pg join lane exists. They are here so the column set is the tab's and the
-- eventual read path does not need a second table.
--
-- ════════════════════════════════════════════════════════════════════════════
-- DEDUP: (user_id, event_id), NOT event_id ALONE
--
-- `event_id` is the RFC-822 Message-ID, which is globally unique per message, so
-- a bare unique index would work today and would be wrong tomorrow for a reason
-- the sheet cannot have: this store is per-user. Two people on one thread — a
-- referral intro, a shared recruiter blast — receive the SAME Message-ID, and a
-- global key would let whichever mailbox captured it first silently deny the
-- other person their own row.
--
-- Within one user the key still dedupes across ACCOUNTS, which is the behaviour
-- the sheet has and the alt-inbox lane depends on: `appsscript/README.md` — "the
-- shared event_id (RFC-822 Message-ID survives forwarding) means the forwarded
-- main-copy of the same message dedupes against it". The first capture of a
-- message wins and the forwarded twin is a `duplicate`.
--
-- A BLANK event_id IS REFUSED. Matrix row 218's lesson at a new door: `''` is a
-- legal text value and a legal key, so one caller sending it would make every
-- later event a duplicate of the first — a dedup key that dedupes everything.
--
-- ════════════════════════════════════════════════════════════════════════════
-- NO `updated_at`, NO TOUCH TRIGGER
--
-- Every other table that has one has it for a reason this one does not have: the
-- web app's optimistic concurrency token, or a mirror that needs to say when it
-- last looked. `email_events` rows are append-once records of a message that has
-- already happened. Nothing edits them from a browser, there is no version to
-- re-check, and a trigger firing on the joiner's eventual `matched_key` stamp
-- would be a column nobody reads maintained by a trigger nobody needs (matrix
-- row 237's shape, avoided rather than repeated).

-- ============================================================ the event types

/**
 * `core/schema.py:EMAIL_EVENT_TYPES`, in SQL — the third copy, so it is PINNED
 * rather than trusted.
 *
 * The Apps Script's classifier already refuses an LLM answer outside this list
 * (`EVENT_TYPES.indexOf(obj.event_type) < 0` → fall back to rules), the capture
 * route validates against its own copy, and `tests/core/test_capture_contract.py`
 * asserts all three lists are the same list. 0015 named its status vocabulary the
 * same way for the same reason: a list that exists twice is a list that will
 * disagree with itself.
 */
create or replace function public.hq_email_event_types()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['received', 'rejection', 'oa_invite', 'interview',
               'recruiter_outreach', 'offer', 'other']::text[]
$$;

comment on function public.hq_email_event_types() is
  'the classifier''s closed set, mirroring core/schema.py:EMAIL_EVENT_TYPES; pinned across SQL, Python, the Apps Script and the capture route by tests/core/test_capture_contract.py';

-- ============================================================ the events

create table public.email_events (
  id      bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,

  -- The RFC-822 Message-ID the Apps Script read off the message, or its
  -- `gm-<gmail id>` fallback for the rare message that carries none.
  event_id text not null,
  -- Which mailbox saw it: 'main' or 'alt' (the scout's forwarding inbox). Free
  -- text rather than an enum — a third mailbox is an onboarding step, not a
  -- migration.
  account  text not null default '',

  -- When Gmail says the message arrived. NULL is unreachable through the
  -- endpoint (the validator refuses an event without a parseable stamp) and the
  -- column stays nullable anyway: a future importer with worse data must be able
  -- to say "unknown" instead of inventing an instant.
  received_at timestamptz,
  from_addr   text not null default '',
  subject     text not null default '',
  snippet     text not null default '',

  -- The classifier's output. `confidence` is what `core/schema.py`'s
  -- HARD_WRITE_MIN_CONFIDENCE gate reads, so a value outside 0..1 is not a
  -- rounding curiosity — it is a number that would clear or fail a gate by
  -- accident.
  event_type text    not null default 'other',
  company    text    not null default '',
  title      text    not null default '',
  ats        text    not null default '',
  job_url    text    not null default '',
  confidence numeric not null default 0,
  evidence   text    not null default '',
  thread_link text   not null default '',

  -- When the SCRIPT classified it, and when the STORE received it. Two stamps
  -- because they answer different questions and their difference is the only
  -- measurement of a POST lane that was down.
  processed_at timestamptz,
  captured_at  timestamptz not null default now(),

  -- Engine-owned, written by the joiner and never by the endpoint. Anchored
  -- emptiness rather than NULL: '' means "the join lane has not retired this
  -- event", which is a state, and `is null` is not a state anybody wants to
  -- write a WHERE clause about twice.
  matched_key    text not null default '',
  applied_status text not null default '',

  constraint email_events_event_id_present
    check (public.hq_blank_trim(event_id) <> ''),
  constraint email_events_type_is_known
    check (event_type = any (public.hq_email_event_types())),
  constraint email_events_confidence_is_a_probability
    check (confidence >= 0 and confidence <= 1),

  unique (user_id, event_id)
);

-- The two reads this table will get: "what has landed lately" (the digest, the
-- health surface) and "what has the join lane not retired" (the drain).
create index email_events_user_time_idx
  on public.email_events (user_id, received_at desc);
create index email_events_unmatched_idx
  on public.email_events (user_id, captured_at desc)
  where matched_key = '';

comment on table public.email_events is
  'classified Gmail events, POSTed by the capture Apps Script through /api/capture; the pg twin of the sheet''s Email Events tab (SHEET-SUNSET phase C2)';
comment on column public.email_events.event_id is
  'RFC-822 Message-ID — the authoritative dedup key, per user (see the migration header for why not global)';
comment on column public.email_events.captured_at is
  'when the STORE received it, as distinct from processed_at (when the script classified it) — their difference is how long the POST lane was down';

-- ============================================================ the credential

/**
 * One bearer token per capture script instance, stored as a digest.
 *
 * SPLIT INTO A SELECTOR AND A SECRET, which is the whole design and the reason
 * this is not one opaque column. The token a script sends is
 *
 *     hqc_<16 hex selector>_<64 hex secret>
 *
 * and the endpoint looks the row up by SELECTOR, then compares the SHA-256 of
 * the secret against `secret_sha256` with `crypto.timingSafeEqual`. Looking the
 * row up by the digest of the whole token would also work and would make the
 * comparison Postgres's `=` on an index — which is neither constant-time nor
 * ours, and leaves nothing for a test to point at. The selector is public by
 * construction, so indexing it leaks nothing.
 *
 * SHA-256 AND NOT BCRYPT, deliberately. Password hashing exists to make a
 * GUESSABLE secret expensive to guess; the secret here is 244 bits from
 * `gen_random_uuid()` and there is no dictionary to run against it. What a
 * digest buys is that a database dump is not a set of live credentials, and a
 * plain SHA-256 buys exactly that. It also keeps this migration free of
 * `pgcrypto`: `sha256(bytea)` and `gen_random_uuid()` are both core Postgres, so
 * the schema applies identically to a vanilla `postgres:16` in CI and to a
 * Supabase project where pgcrypto lives in the `extensions` schema and a pinned
 * `search_path` would not find it.
 *
 * NO POLICIES, AND THE GRANTS REVOKED BY NAME. `command_idempotency`'s posture
 * (0003): reachable from the server and from nowhere else. RLS with no policies
 * already hides every row from `authenticated`, and the revoke below is the belt
 * — a future migration that adds a well-meaning read policy to this table still
 * cannot hand a browser a digest, because the privilege is gone.
 */
create table public.capture_tokens (
  id      bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,

  -- The public half, carried in the token and indexed. 16 hex characters.
  selector      text not null unique,
  -- The private half's SHA-256, hex. Never the secret itself.
  secret_sha256 text not null,

  -- Which script instance holds it: 'main', 'alt'. Rotation is scoped to a
  -- label, so rotating the main mailbox's token cannot silently kill the
  -- scout's.
  label text not null default '',

  created_at   timestamptz not null default now(),
  -- Stamped by `hq_capture_email_events` on every accepted call. This is what
  -- makes "is this token still in use?" answerable before revoking it.
  last_used_at timestamptz,
  revoked_at   timestamptz,

  constraint capture_tokens_selector_shape check (selector ~ '^[0-9a-f]{16}$'),
  constraint capture_tokens_digest_shape   check (secret_sha256 ~ '^[0-9a-f]{64}$')
);

create index capture_tokens_user_label_idx
  on public.capture_tokens (user_id, label, created_at desc);

comment on table public.capture_tokens is
  'bearer credentials for /api/capture — selector + SHA-256 of the secret, never the secret; minted and rotated by the hq_*_capture_token functions (docs/RUNBOOK.md § The capture endpoint)';

-- ============================================================ RLS

alter table public.email_events   enable row level security;
alter table public.capture_tokens enable row level security;

-- The owner reads their own events. That is the whole browser surface: there is
-- deliberately NO insert/update/delete policy, because the only writer is the
-- endpoint's service role calling the function below. 0001's closing sentence,
-- unchanged for a new table.
create policy email_events_self_read on public.email_events
  for select using (user_id = auth.uid());

-- AND THE WRITE PRIVILEGES GO, not just the policies.
--
-- The read policy above is the whole browser surface, and for a while that held
-- only because no write policy existed — Supabase's default grants hand
-- `authenticated` INSERT/UPDATE/DELETE on every new table in `public` so that RLS
-- can be the decider, so the door was shut by the absence of a rule rather than
-- by the absence of a privilege. Measured in review: add one plausible future
-- `for all using (user_id = auth.uid())` policy here and a browser session
-- updates and deletes its own captured mail; add the same policy to
-- `capture_tokens` and it still gets `42501`, because that table's grants are
-- gone. `0002` (events), `0010` (application_notes) and `0013` (connections) all
-- name this revoke; this table was the outlier.
revoke insert, update, delete, truncate on public.email_events
  from public, anon, authenticated;

-- capture_tokens gets NO policy of any kind. See the table's comment: a digest is
-- credential material and the browser has no question that needs it. `public` is
-- named alongside the two roles for 0013's reason — it is a distinct grantee, and
-- leaving it out is how a revoke reads closed and is not.
revoke all on public.capture_tokens from public, anon, authenticated;

-- ============================================================ minting

/**
 * A new capture token for one user. The plaintext is returned ONCE and is not
 * recoverable afterwards — that is the point of storing a digest.
 *
 * NOT `security definer`, and it takes `p_user_id`: those two facts belong
 * together, and `tests/core/test_migrations.py::test_definer_functions_never_take_a_user_id`
 * is why. A definer function that mints a credential for whoever it is asked to
 * is a credential vending machine. This runs with the CALLER's rights, and the
 * callers are the operator in the SQL editor and the service role — 0015's
 * shape, same grants, same reasons.
 *
 * WHY A SQL FUNCTION AND NOT A DISPATCHABLE ENGINE JOB. The house style for "run
 * a thing by hand" is `handler.JOBS` + **Run a bot**, and it is the wrong shape
 * here for one concrete reason: both of those lanes print to a log. A Lambda job
 * writes CloudWatch and an Actions dispatch writes a run log, and a minted bearer
 * token in either is a credential published to a place nobody thinks of as a
 * secret store. The operator pastes this into the SQL editor, copies the token
 * straight into Script Properties, and it exists in no log at all. Provisioning
 * the allowlist already works this way (`db/README.md` step 3).
 */
create or replace function public.hq_mint_capture_token(
  p_user_id uuid,
  p_label   text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_label    text := coalesce(public.hq_blank_trim(p_label), '');
  v_selector text;
  v_secret   text;
  v_id       bigint;
begin
  if p_user_id is null then
    raise exception 'hq_mint_capture_token needs the user the token acts for'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'no such user: %', p_user_id using errcode = '23503';
  end if;

  -- 60 random bits of selector and 244 of secret, both out of `gen_random_uuid()`
  -- so this file needs no extension. A selector collision raises on the unique
  -- index — loud, and the fix is to run the statement again.
  v_selector := left(replace(gen_random_uuid()::text, '-', ''), 16);
  v_secret   := replace(gen_random_uuid()::text, '-', '')
             || replace(gen_random_uuid()::text, '-', '');

  insert into public.capture_tokens (user_id, selector, secret_sha256, label)
  values (p_user_id, v_selector,
          encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), v_label)
  returning id into v_id;

  insert into public.events (user_id, kind, payload, actor)
  values (p_user_id, 'capture.token_minted',
          jsonb_build_object('token_id', v_id, 'selector', v_selector, 'label', v_label),
          'operator');

  -- `token` is the ONLY time the plaintext exists outside the caller's terminal.
  return jsonb_build_object(
    'token_id', v_id,
    'label',    v_label,
    'selector', v_selector,
    'token',    'hqc_' || v_selector || '_' || v_secret);
end;
$$;

comment on function public.hq_mint_capture_token(uuid, text) is
  'operator-only: mint one /api/capture bearer token and return its plaintext ONCE (the store keeps only a SHA-256)';

revoke all on function public.hq_mint_capture_token(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_mint_capture_token(uuid, text) to service_role;

/**
 * Revoke a user's live capture tokens. `p_label` NULL means every label.
 *
 * Revocation is a stamp rather than a DELETE, for `events`' reason: "which
 * credential was live when that batch landed" is a question an incident asks, and
 * a deleted row cannot answer it. `last_used_at` on the revoked row is what says
 * whether the thing you just killed was still being used.
 */
create or replace function public.hq_revoke_capture_tokens(
  p_user_id uuid,
  p_label   text
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if p_user_id is null then
    raise exception 'hq_revoke_capture_tokens needs a user' using errcode = '22023';
  end if;
  update public.capture_tokens
     set revoked_at = now()
   where user_id = p_user_id
     and revoked_at is null
     and (p_label is null or label = public.hq_blank_trim(p_label));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.events (user_id, kind, payload, actor)
    values (p_user_id, 'capture.tokens_revoked',
            jsonb_build_object('count', v_n, 'label', p_label), 'operator');
  end if;
  return v_n;
end;
$$;

comment on function public.hq_revoke_capture_tokens(uuid, text) is
  'operator-only: stamp revoked_at on a user''s live capture tokens (NULL label = all of them); never deletes, because an incident asks which credential was live';

revoke all on function public.hq_revoke_capture_tokens(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_revoke_capture_tokens(uuid, text) to service_role;

/**
 * Rotate: revoke this label's live tokens and mint its replacement, in one
 * statement.
 *
 * Scoped to the LABEL and not to the user, because the alt mailbox runs its own
 * copy of the script with its own token, and "rotate the main token" must not be
 * a way to silently stop the scout's lane. Two functions composed rather than a
 * third copy of either.
 *
 * There IS a window here, and it is the honest one: the old token stops working
 * the moment this returns, and the new one starts working before anybody has
 * pasted it into Script Properties. The script's retry queue is what covers it —
 * the POSTs in between fail with 401, queue locally, and flush on the next run
 * after the paste. The sheet lane never notices.
 */
create or replace function public.hq_rotate_capture_token(
  p_user_id uuid,
  p_label   text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_revoked integer;
begin
  v_revoked := public.hq_revoke_capture_tokens(p_user_id, coalesce(p_label, ''));
  return public.hq_mint_capture_token(p_user_id, p_label)
         || jsonb_build_object('revoked', v_revoked);
end;
$$;

comment on function public.hq_rotate_capture_token(uuid, text) is
  'operator-only: revoke this label''s live tokens and mint its replacement in one statement';

revoke all on function public.hq_rotate_capture_token(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hq_rotate_capture_token(uuid, text) to service_role;

-- ============================================================ the write

/**
 * One POSTed batch of classified emails, stored.
 *
 * PER-ROW, INSIDE A LOOP, WITH A PER-ROW EXCEPTION BLOCK — and that is the whole
 * reason this is a function rather than a bulk `insert … select … on conflict`.
 * A set-based insert is one statement: a single row that violates a CHECK aborts
 * it, and the batch that contained it is dropped in full. The Apps Script has one
 * classifier, an LLM, and it will eventually produce a row this schema refuses;
 * losing fifty good events to one bad one, in the lane that is the system's
 * status ground truth, is not a trade worth the round trips it saves.
 * `tracker/pgseed.py` reached the same conclusion one layer up ("one bad row does
 * not end the seed") for a hand-edited spreadsheet; this is the same rule for a
 * language model.
 *
 * The subtransaction is paid once per event, at a bound of MAX_EVENTS below, on a
 * lane that carries single-digit events per run.
 *
 * OUTCOMES, one per event, all returned rather than raised:
 *
 *   inserted   a new row. The only outcome that writes.
 *   duplicate  (user_id, event_id) is already here. The script WILL resend —
 *              its retry queue replays a whole batch — and a replay must be free.
 *              Deliberately DO NOTHING rather than DO UPDATE: the row is the
 *              record of one message as it was classified when it was captured,
 *              and a re-classified replay overwriting it would silently rewrite
 *              a record the join lane may already have acted on. 0015 handles
 *              re-classification where it belongs, in its idempotency key.
 *   rejected   the row violated a constraint. The reason is the database's own
 *              message, carried back so the response can name the row rather
 *              than the batch.
 *
 * NOT `security definer`, takes `p_user_id`, granted to `service_role` alone:
 * 0015's posture, and the same test enforces it.
 */
create or replace function public.hq_capture_email_events(
  p_user_id  uuid,
  p_token_id bigint,
  p_events   jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- A bound at the SQL boundary as well as at the route's, matrix row 185's
  -- discipline: the endpoint's cap is a number in a TypeScript file and this one
  -- is enforced by the store, for every caller it ever grows.
  c_max_events constant integer := 500;
  v_event   jsonb;
  v_n       integer;
  v_id      bigint;
  v_results jsonb := '[]'::jsonb;
  v_index   integer := 0;
  v_outcome text;
  v_reason  text;
begin
  if p_user_id is null then
    raise exception 'hq_capture_email_events needs the user whose events these are'
      using errcode = '22023';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'hq_capture_email_events needs an array of events'
      using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_events);
  if v_n > c_max_events then
    raise exception 'capture batch of % exceeds the % event cap', v_n, c_max_events
      using errcode = '22023';
  end if;
  -- THE CREDENTIAL IS CHECKED HERE TOO, before anything is written.
  --
  -- The route already resolves the token and refuses a revoked one, and this
  -- function's comments read as though the pairing were enforced here. It was
  -- not: review demonstrated stamping user B's token for rows stored under user
  -- A, and a revoked token id storing rows normally. Neither is reachable through
  -- the one caller — it always passes `live.user_id` and `live.id` together — but
  -- a function whose comment claims an invariant it does not hold is a function
  -- the NEXT caller will trust. Checked first, so a bad pairing writes nothing
  -- rather than raising after the loop and rolling back work it should never have
  -- started.
  if p_token_id is not null
     and not exists (select 1 from public.capture_tokens
                      where id = p_token_id
                        and user_id = p_user_id
                        and revoked_at is null) then
    raise exception 'capture token % is not a live credential for user %',
      p_token_id, p_user_id using errcode = '42501';
  end if;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    v_index := v_index + 1;
    v_reason := null;
    begin
      insert into public.email_events (
        user_id, event_id, account, received_at, from_addr, subject, snippet,
        event_type, company, title, ats, job_url, confidence, evidence,
        thread_link, processed_at)
      values (
        p_user_id,
        coalesce(v_event ->> 'event_id', ''),
        coalesce(v_event ->> 'account', ''),
        (v_event ->> 'received_at')::timestamptz,
        coalesce(v_event ->> 'from_addr', ''),
        coalesce(v_event ->> 'subject', ''),
        coalesce(v_event ->> 'snippet', ''),
        coalesce(v_event ->> 'event_type', 'other'),
        coalesce(v_event ->> 'company', ''),
        coalesce(v_event ->> 'title', ''),
        coalesce(v_event ->> 'ats', ''),
        coalesce(v_event ->> 'job_url', ''),
        coalesce((v_event ->> 'confidence')::numeric, 0),
        coalesce(v_event ->> 'evidence', ''),
        coalesce(v_event ->> 'thread_link', ''),
        (v_event ->> 'processed_at')::timestamptz)
      on conflict (user_id, event_id) do nothing
      returning id into v_id;

      v_outcome := case when v_id is null then 'duplicate' else 'inserted' end;
    exception when others then
      -- `when others` for `hq_iso_date`'s reason, and it is not laziness: the
      -- shapes that reach here raise different errcodes (22P02 for a
      -- confidence that is not a number, 23514 for every CHECK, 22007/22008 for
      -- a stamp), and a narrower catch leaks whichever one it did not name —
      -- which aborts the batch, which is the failure this block exists to
      -- prevent.
      v_outcome := 'rejected';
      v_reason  := sqlerrm;
    end;

    v_results := v_results || jsonb_build_object(
      'index',    v_index - 1,
      'event_id', coalesce(v_event ->> 'event_id', ''),
      'outcome',  v_outcome,
      'reason',   v_reason);
  end loop;

  -- The credential's proof of life: it authenticated, and it reached the store.
  --
  -- NOT "it stored something", which is what this comment used to claim and what
  -- review measured to be false — a batch whose every row was rejected still
  -- stamps. That is the RIGHT behaviour and the wrong sentence: the question this
  -- column exists to answer is "is anything still using this credential, or can I
  -- revoke it", and a script POSTing rows the schema refuses is emphatically
  -- still using it. Stamping only on a successful INSERT would make a
  -- misconfigured sender look dead and get its token revoked out from under it.
  if p_token_id is not null then
    update public.capture_tokens set last_used_at = now() where id = p_token_id;
  end if;

  return jsonb_build_object('results', v_results);
end;
$$;

comment on function public.hq_capture_email_events(uuid, bigint, jsonb) is
  'endpoint-only: store one POSTed batch of classified Gmail events — per-row outcomes (inserted|duplicate|rejected), idempotent on (user_id, event_id), one bad row never drops the batch';

-- `public` is the pseudo-role; `anon` and `authenticated` hold Supabase's own
-- default grants and keep them unless named. This function takes the acting user
-- as an argument, so reachable from a browser it would let any session write
-- events into anyone's lane.
revoke all on function public.hq_capture_email_events(uuid, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.hq_capture_email_events(uuid, bigint, jsonb)
  to service_role;
