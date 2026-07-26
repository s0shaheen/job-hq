-- The pipeline write path — P8's half of "the spreadsheet can be closed".
--
-- Reading order: 0003_write_path.sql first. Every function here follows it
-- exactly and for the same reasons — security definer + `auth.uid()` (the
-- caller cannot name a user), the row and its audit event in one body, the
-- stored idempotency RESULT, a post-lock re-check of the idempotency key
-- (0003:166-182 — the pre-lock check only settles SEQUENTIAL replays), a
-- version token that turns a second device into a visible conflict, and a
-- no-op short circuit so a gesture that changes nothing does not invalidate
-- every other tab's token.
--
-- Numbered 0010, not the 0008 docs/plans/PHASE-PIPELINE.md pencilled in.
-- Migrations are assigned serially AT BUILD TIME, and this one moved twice: P7
-- took 0008, then the universe reconciler took 0009 while this branch was in
-- flight. Five plans once all claimed 0003, which is why the rule exists and why
-- `test_migrations.py::test_migrations_are_contiguously_numbered` is the tripwire
-- that caught the collision rather than a reviewer.
--
-- THREE THINGS THIS FIXES
--
-- 1. Acceptance criterion 14 was failing in production. `status_rank`
--    ('Rejected') is 9 and `status_rank('Offer')` is 7, so a rejection email
--    classified at 0.99 overwrote an Offer a human had chosen. Rank protects an
--    INVENTED status and protected nothing a person picked on purpose.
--    `status_actor` is the missing fact, and the trigger is the enforcement
--    point because there are TWO writers (the app and the engine) and only the
--    database sees both.
-- 2. `applications.notes` was one text column with no history — spec A4 names
--    `note` as an entity. A second note overwrote the first with no trace.
-- 3. `Offer` was the end of the ladder, so a finished search could not be
--    represented. `Offer-Accepted` / `Offer-Declined` are human-only and
--    reachable only through `app_set_status`, which stamps the lock.

-- ============================================================ blank, honestly

/**
 * Trim to nothing, for every character a person can produce that looks like
 * nothing.
 *
 * WHY IT EXISTS: `btrim(x)` with no second argument trims SPACES ONLY. Not tabs,
 * not newlines. So `btrim(E'\n\t')` is `E'\n\t'`, which is not `''`, which means
 * a note consisting of one keystroke of whitespace passed every "must not be
 * empty" check in this file and landed in an append-only table that cannot
 * delete it. The check read correctly and did nothing; running it said so.
 *
 * WHY IT IS A REGEX AND NOT A btrim CHARACTER LIST, which is the more expensive
 * lesson. The first version passed the character set as btrim's second argument,
 * written as an E-string: `E' \t\r\n\f\v\u00A0…'`. Postgres E-strings have no
 * `\v` escape, so that string contained the LETTER v — and btrim's second
 * argument is a SET OF CHARACTERS, not a pattern, so every note, status and next
 * action lost a leading or trailing "v":
 *
 *     app_add_note('verify comp band with Priya')  ->  'erify comp band with Priya'
 *     app_add_note('video screen prep')            ->  'ideo screen prep'
 *     app_add_note('v')                            ->  refused as blank
 *
 * Silent data corruption on the way INTO an append-only table, from a list that
 * looks like a regex character class and is not one. The real U+000B was not
 * trimmed at all, so the twin lists diverged in BOTH directions from the
 * TypeScript mirror. Anchored `regexp_replace` removes the whole class of bug:
 * one grammar, and `\v` means vertical tab in it.
 *
 * `^…+|…+$` and NOT a collapse-then-btrim like 0008's `company_name_key`: that
 * function may fold interior runs because it computes an identity, and this one
 * must not — a note's own line breaks are content.
 *
 * `[[:space:]]` covers space, tab, newline, vertical tab, form feed and carriage
 * return. The unicode separators are added for 0008's reason: a string pasted out
 * of a web page arrives carrying NBSP, which no ASCII class contains. Zero-width
 * characters are stripped first — they are not separators, so no trim removes
 * them. Both lists are spelled out on both sides of the language boundary and
 * compared character-by-character in parity.test.ts.
 *
 * IMMUTABLE so the CHECK constraint below can use it.
 */
create or replace function public.hq_blank_trim(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  -- HQ_BLANK_ZERO_WIDTH and HQ_BLANK_SEPARATORS are markers, not decoration:
  -- parity.test.ts extracts these two classes by name and expands them against
  -- the JavaScript mirror one codepoint at a time. The previous pin matched three
  -- substrings and stayed green when \t was deleted from the SQL.
  select regexp_replace(
           regexp_replace(coalesce(p_text, ''),
                          /* HQ_BLANK_ZERO_WIDTH */ '[\u200B\u200C\u200D\uFEFF]', '', 'g'),
           /* HQ_BLANK_SEPARATORS */
           '^[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+' ||
           '|[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$',
           '', 'g')
$$;

comment on function public.hq_blank_trim(text) is
  'trim every space-like character from both ends — bare btrim() leaves tabs and newlines, and a btrim CHARACTER LIST written with \v silently ate the letter v';

/**
 * The statuses that mean "this application is over" — terminal plus resolved.
 *
 * One definition, because the reopen rule turns on it and a hand-typed tuple got
 * it wrong: it listed the three terminal states and omitted `Offer-Accepted` /
 * `Offer-Declined`, so ending a search and then quietly un-ending it needed no
 * reason at all. Mirrors `core/schema.py`'s `STATUS_TERMINAL + STATUS_RESOLVED`,
 * and `tests/db/test_pipeline.py` pins it against `webapp/lib/status.ts`.
 *
 * Deliberately NOT a CHECK on `applications.status`: that column mirrors a
 * human-editable sheet cell, and 0001:149-153 explains why a closed set there
 * would fail a 500-row upsert chunk. This is a predicate, not a constraint.
 */
create or replace function public.hq_finished_statuses()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['Rejected', 'Withdrawn', 'Closed', 'Offer-Accepted', 'Offer-Declined']::text[]
$$;

-- ============================================================ the human lock

alter table public.applications
  add column if not exists status_actor text not null default 'system';
alter table public.applications
  add column if not exists status_set_at timestamptz;

-- Two values, closed. Unlike `status` — which deliberately has no CHECK because
-- it mirrors a human-editable sheet cell and a novel value must not fail a
-- 500-row upsert chunk (0001:149-153) — this column is written only by the
-- functions below and by a two-value sheet dropdown. A third value here would
-- mean "locked or not?" has no answer, and the safe reading of an unknown value
-- (treat as unlocked) is the one that loses somebody's Offer.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'applications_status_actor_check'
  ) then
    alter table public.applications
      add constraint applications_status_actor_check
      check (status_actor in ('system', 'user'));
  end if;
end
$$;

comment on column public.applications.status_actor is
  'who last set `status`: system (bots may keep advancing it) or user (locked — no bot write may change it, whatever the rank or confidence)';
comment on column public.applications.status_set_at is
  'when `status` was last set THROUGH ONE OF THE app_* FUNCTIONS — a service-role or mirror write leaves it behind updated_at, so it is a human-gesture timestamp and not an audit of the column';

/**
 * The lock, as a TRIGGER rather than a rule inside the write functions.
 *
 * There are two writers and they share nothing else. The web app goes through
 * `app_set_status` below; the engine mirrors the sheet with the service role,
 * which bypasses RLS and calls no function of ours. A rule living in the
 * functions guards the door the app knocks on and leaves the other one open —
 * and the other one is the one that produced the defect, because the bot is
 * what overwrote the Offer.
 *
 * THE ESCAPE HATCH, and why it is a session flag rather than the obvious thing.
 *
 * The obvious thing — "allow it when the write also sets `status_actor` to
 * 'user'" — DOES NOT WORK, and it looked like it did until this ran against
 * Postgres. An UPDATE that does not mention a column carries the OLD value into
 * `new`, so on a row already locked (`status_actor = 'user'`) every bot write
 * arrives with `new.status_actor = 'user'` for free and sails straight through
 * the guard. The one row the trigger exists to protect was the one row it let
 * past. A row trigger cannot see which columns were in the SET list, so there
 * is no version of that check that distinguishes "set to user" from "inherited
 * user".
 *
 * So the declaration is explicit: a writer that means "this change came from a
 * human" sets `hq.status_write` to 'human' for the duration of its own
 * statement. The four functions below do it and clear it again immediately, so
 * the flag never covers more than the write it was set for. A future sheet
 * mirror relaying a human's own edit does the same. What the trigger refuses is
 * every write that changes `status` without saying so — which is the shape of
 * every bot write, including the service-role UPDATE that caused the defect.
 *
 * `true` (transaction-local) on the set_config matters: a session-scoped flag
 * on a pooled connection would outlive the request that set it.
 *
 * It fires on UPDATE only. An INSERT cannot violate anything (there is no prior
 * human decision to overwrite), and a DELETE is governed by
 * `app_set_triage`'s Queued-only rule.
 */
create or replace function public.applications_human_status_lock()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_declared boolean := coalesce(current_setting('hq.status_write', true), '') = 'human';
begin
  if old.status_actor = 'user' and not v_declared then
    if new.status is distinct from old.status then
      raise exception
        'status is locked to the human choice % on application %; record the suggestion instead',
        old.status, old.id
        using errcode = '42501';   -- insufficient_privilege: a refusal, not a conflict
    end if;
    -- Guarding `status` alone left a ONE-STATEMENT UNLOCK: `update applications
    -- set status_actor = 'system'` passed cleanly, and the bot write behind it
    -- then passed too. The lock has to defend its own latch, or it is a lock with
    -- the key taped to it. Only a declared human write may hand the row back to
    -- the bots ("let them drive this one again"), and no UI in this phase does.
    if new.status_actor is distinct from old.status_actor then
      raise exception
        'status_actor on application % is locked to user; releasing it is a human gesture',
        old.id
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists applications_human_status_lock on public.applications;
-- BEFORE, and before the touch trigger by name-ordering accident? No — order is
-- alphabetical among BEFORE triggers on the same event, and it does not matter:
-- this one only ever raises or passes the row through untouched.
create trigger applications_human_status_lock
  before update on public.applications
  for each row execute function public.applications_human_status_lock();

-- ============================================================ notes as rows

/**
 * `applications.notes` is one text column with no history, and spec A4 names
 * `note` as an entity that must exist. A second note overwrote the first.
 *
 * Append-only, for the reason `events` is (0002_invariants.sql:37-43): a
 * comment is not a permission. Editing a note means appending a correction, and
 * that is visible in the UI rather than implied — a textarea over the old value
 * teaches people the opposite.
 */
create table if not exists public.application_notes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  application_id bigint not null references public.applications (id) on delete cascade,
  -- `hq_blank_trim`, not bare `btrim`: the latter trims spaces only, so this
  -- CHECK accepted a note consisting of one newline into a table that cannot
  -- delete it. See the function's comment.
  body text not null check (public.hq_blank_trim(body) <> ''),
  -- user | scout | system | import. Not a CHECK: `author` is provenance, and a
  -- future writer minting a tag must not fail the insert — the UI renders an
  -- unrecognised author verbatim (`sourceLabel`'s rule, same reasoning).
  author text not null default 'user',
  created_at timestamptz not null default now()
);

create index if not exists application_notes_by_app
  on public.application_notes (application_id, created_at desc, id desc);

alter table public.application_notes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'application_notes'
       and policyname = 'application_notes_self_read'
  ) then
    create policy application_notes_self_read on public.application_notes
      for select using (user_id = auth.uid());
  end if;
end
$$;

-- No insert/update/delete policy, ever: the browser writes through
-- `app_add_note` or not at all (0001's closing note). The revoke is belt and
-- braces for the day someone adds a policy without reading that note — and
-- update/delete are revoked from every role that could hold them, because
-- append-only is the whole point of the table.
revoke insert, update, delete, truncate on public.application_notes from anon, authenticated;

comment on table public.application_notes is
  'append-only note history per application; editing means appending a correction';

-- Backfill, NON-DESTRUCTIVELY. `applications.notes` stays exactly where it is:
-- spec §E round-trips it and webapp/lib/export/columns.ts reads it, so clearing
-- the column here would silently blank a column in every export the day this
-- applies. The export now prefers the newest NOTE and falls back to the column,
-- which is the only ordering that is correct both before and after this runs.
--
-- `created_at` comes from the application, not from now(): a note stamped today
-- for something written three weeks ago is a small lie that makes the history
-- unreadable. Guarded on emptiness so re-running the migration cannot duplicate.
insert into public.application_notes (user_id, application_id, body, author, created_at)
select a.user_id, a.id, a.notes, 'import', a.created_at
  from public.applications a
 where public.hq_blank_trim(a.notes) <> ''
   and not exists (
     select 1 from public.application_notes n where n.application_id = a.id
   );

-- ============================================================ result shape

/**
 * The row the pipeline renders, shaped for `toApplicationView` in
 * webapp/lib/data/supabase-source.ts.
 *
 * Extracted for 0003's reason: five paths return it (four writes and a replay),
 * and a replay returning a differently-shaped row than the original write is
 * the kind of divergence nothing catches until the UI renders blanks.
 *
 * `updated_at` is a LOAD-BEARING member of the shape — it is the concurrency
 * token the client sends back with its next gesture, and dropping it turns
 * every write on this surface into last-writer-wins silently. `status_actor`
 * likewise: the UI shows whether the row is bot-driven or claimed.
 *
 * `posting_status` is the delisted signal, DERIVED on every read and never
 * stored. A stored flag lies the moment the board reposts the role.
 *
 * The bound is `posting_key`, NOT row-level security. An earlier version of this
 * comment claimed RLS narrowed it — that was wrong, and verified wrong: this
 * runs inside a `security definer` function, which bypasses the `postings`
 * policy, so a posting the user was never gated DOES answer here. The only null
 * cases are an application with no `posting_key` (added by hand) and a
 * `posting_key` pointing at a row the sweep has not mirrored. Both read as
 * not-delisted, which is the right way round — the opposite direction tells
 * somebody a live job is dead.
 *
 * The PostgREST read path in `supabase-source.ts` is the one that IS narrowed by
 * that policy, so the two paths can legitimately disagree for a posting outside
 * the user's gate. Both fail towards "still listed".
 */
create or replace function public.app_application_row(a public.applications)
returns jsonb
language sql
stable
-- Deliberately NOT security definer: only ever called from inside the definer
-- functions below, so it already runs with the rights it needs. Marking it
-- definer would hand a standalone caller the ability to read any application
-- row (0003's app_triage_row, same call).
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id',               a.id,
           'posting_key',      a.posting_key,
           'company',          a.company,
           'title',            a.title,
           'url',              a.url,
           'status',           a.status,
           'status_actor',     a.status_actor,
           'status_set_at',    a.status_set_at,
           'suggested_status', a.suggested_status,
           'evidence',         a.evidence,
           'applied_date',     a.applied_date,
           'next_action',      a.next_action,
           'next_action_date', a.next_action_date,
           'notes',            a.notes,
           'updated_at',       a.updated_at,
           'posting_status',   (select p.status from public.postings p
                                 where p.key = a.posting_key),
           'note_count',       (select count(*) from public.application_notes n
                                 where n.application_id = a.id),
           'latest_note',      (select jsonb_build_object(
                                         'id',         n.id,
                                         'body',       n.body,
                                         'author',     n.author,
                                         'created_at', n.created_at)
                                  from public.application_notes n
                                 where n.application_id = a.id
                                 -- id desc breaks the tie two notes written in
                                 -- the same millisecond would otherwise leave to
                                 -- the query plan; the index carries both keys.
                                 order by n.created_at desc, n.id desc
                                 limit 1)
         )
$$;

revoke all on function public.app_application_row(public.applications) from public;

-- ============================================================ set status

/**
 * Change a status, withdraw, or reopen — the one gesture a human makes on this
 * surface, and the one that beats every bot afterwards.
 *
 * `p_status` is free text on purpose. The sheet allows an invented status and
 * `status_rank` ranks one highest by construction; refusing it here would make
 * the app strictly less capable than the spreadsheet it replaces. Bounded, and
 * validated for emptiness, but not enumerated.
 *
 * `p_note` is REQUIRED on a reopen (terminal → non-terminal) and optional
 * otherwise. A reopen with no reason is the row nobody can explain three weeks
 * later — "why is this alive again" is exactly the question the audit trail
 * exists to answer, and enforcing it in SQL rather than in the dialog means it
 * holds for every caller.
 */
create or replace function public.app_set_status(
  p_application_id      bigint,
  p_status              text,
  p_note                text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_row       public.applications;
  v_result    jsonb;
  v_status    text := public.hq_blank_trim(p_status);
  v_note      text := public.hq_blank_trim(p_note);
  v_reopening boolean;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if v_status = '' then
    raise exception 'a status is required' using errcode = '22023';
  end if;
  -- A bound, because everything a browser can send gets one. The sheet's own
  -- column is not this wide and a status is a label, not a note.
  if length(v_status) > 80 then
    raise exception 'status is too long (max 80 characters)' using errcode = '22023';
  end if;
  if length(v_note) > 4000 then
    raise exception 'note is too long (max 4000 characters)' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  select * into v_row
    from public.applications
   where user_id = v_user and id = p_application_id
     for update;
  if not found then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  -- Re-check behind the lock (0003:166-182). Two tabs flushing one outbox on
  -- the same 'online' event send the same key concurrently; both cleared the
  -- check above before either wrote, and without this the loser either raises a
  -- phantom conflict or applies a second time against an append-only trail.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Reopen: leaving a FINISHED state for a live one. Checked against the row we
  -- just locked rather than against anything the client said, because the
  -- client's idea of the current status is exactly what may be stale.
  --
  -- `hq_finished_statuses()` and not a hand-typed tuple. This was the fourth copy
  -- of that list in the repo, and it was also the WRONG list: it named only the
  -- three terminal states, so `Offer-Accepted -> Applied` with no note went
  -- straight through — reachable from the shipped Select, which offers every
  -- STATUS_ORDER value while only the Reopen BUTTON is gated on terminality.
  -- Un-ending a finished search is the most consequential reopen there is.
  v_reopening := v_row.status = any (public.hq_finished_statuses())
                 and not (v_status = any (public.hq_finished_statuses()));
  if v_reopening and v_note = '' then
    raise exception 'reopening needs a note saying why' using errcode = '22023';
  end if;

  -- A gesture that changes nothing writes nothing (0003's rule). Re-selecting
  -- the status a row already has would otherwise bump updated_at, invalidate
  -- every other tab's token, and append an audit event about a non-event.
  -- A note ALWAYS counts as a change, so it is excluded from this branch.
  if v_row.status = v_status and v_row.status_actor = 'user' and v_note = '' then
    v_result := public.app_application_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_set_status', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this application changed since you read it'
      using errcode = '40001';
  end if;

  -- Declare the write, for the duration of this one statement. See the trigger.
  perform set_config('hq.status_write', 'human', true);
  update public.applications
     set status           = v_status,
         -- The lock. Set on EVERY status write from this function, because
         -- every one of them came from a person pressing something.
         status_actor     = 'user',
         status_set_at    = now(),
         -- A human choosing a status answers the bot's suggestion by making it
         -- moot. Leaving it would render "Applied · suggests Rejected" beside a
         -- status the human just set to Rejected themselves.
         suggested_status = '',
         updated_at       = now()
   where user_id = v_user and id = p_application_id
   returning * into v_row;
  perform set_config('hq.status_write', '', true);

  if v_note <> '' then
    insert into public.application_notes (user_id, application_id, body, author)
    values (v_user, p_application_id, v_note, 'user');
  end if;

  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user, 'action.status', v_row.posting_key, v_row.id,
    jsonb_strip_nulls(jsonb_build_object(
      'status',   v_status,
      'reopened', nullif(v_reopening, false),
      'note',     nullif(v_note, ''),
      'idem',     p_idem
    )),
    'user'
  );

  -- Re-read: the note just inserted has to be in the row the client renders,
  -- and `v_row` was captured before the insert.
  select * into v_row from public.applications
   where user_id = v_user and id = p_application_id;
  v_result := public.app_application_row(v_row);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_status', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- Granted to `authenticated`, and revoked from `public` — which on Supabase is
-- housekeeping rather than a door being closed. The platform's bootstrap already
-- name-grants EXECUTE on new functions in `public` to anon and authenticated, so
-- the revoke narrows almost nothing; what actually holds is that the body runs
-- with the DEFINER's rights only for its own statements and refuses a null
-- `auth.uid()` on the first line. 0003 carries the same pattern and the same
-- reasoning error in its comment; it is not rewritten here, because a migration
-- that has been applied is history.
revoke all on function public.app_set_status(bigint, text, text, text, timestamptz) from public;
grant execute on function public.app_set_status(bigint, text, text, text, timestamptz) to authenticated;

-- ============================================================ suggestions

/**
 * Confirm or reject a `suggested_status`.
 *
 * The suggestion mechanism exists because a classifier below 0.85 confidence
 * should not move a row on its own. Both answers are recorded: "the bot
 * suggested Rejected and Salman said no" is information, and an unrecorded
 * rejection is indistinguishable from a suggestion nobody ever saw.
 *
 * Reject touches `status` NOT AT ALL. That is the entire failure mode of matrix
 * row 42 — a "no thanks" that quietly applies the thing it declined.
 */
create or replace function public.app_resolve_suggestion(
  p_application_id      bigint,
  p_decision            text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_row       public.applications;
  v_result    jsonb;
  v_suggested text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_decision is null or p_decision not in ('confirm', 'reject') then
    raise exception 'invalid decision: %', p_decision using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  select * into v_row
    from public.applications
   where user_id = v_user and id = p_application_id
     for update;
  if not found then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  v_suggested := public.hq_blank_trim(v_row.suggested_status);

  -- Nothing to resolve. Returned as the row rather than raised: the honest
  -- reading of a second Confirm arriving after the first is "already done",
  -- and a double-tap on a slow connection produces exactly that. Raising would
  -- turn a free gesture into a red toast about a thing that worked.
  if v_suggested = '' then
    v_result := public.app_application_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_resolve_suggestion', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this application changed since you read it'
      using errcode = '40001';
  end if;

  if p_decision = 'confirm' then
    perform set_config('hq.status_write', 'human', true);
    update public.applications
       set status           = v_suggested,
           status_actor     = 'user',   -- confirming IS a human decision
           status_set_at    = now(),
           suggested_status = '',
           updated_at       = now()
     where user_id = v_user and id = p_application_id
     returning * into v_row;
    perform set_config('hq.status_write', '', true);
  else
    update public.applications
       set suggested_status = '',
           -- status and status_actor deliberately untouched. Rejecting a
           -- suggestion is not a claim over the row: a later, better-evidenced
           -- email should still be able to advance it.
           updated_at       = now()
     where user_id = v_user and id = p_application_id
     returning * into v_row;
  end if;

  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user,
    case p_decision when 'confirm' then 'action.status.confirmed'
                    else                 'action.status.rejected' end,
    v_row.posting_key, v_row.id,
    jsonb_build_object('suggested', v_suggested, 'idem', p_idem),
    'user'
  );

  v_result := public.app_application_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_resolve_suggestion', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

revoke all on function public.app_resolve_suggestion(bigint, text, text, timestamptz) from public;
grant execute on function public.app_resolve_suggestion(bigint, text, text, timestamptz) to authenticated;

-- ============================================================ add a note

/**
 * Append a note. No `p_expected_updated_at`, deliberately.
 *
 * A note cannot conflict with anything: it does not overwrite a value, so
 * "somebody else wrote one first" is not an error, it is two notes. Demanding a
 * version token here would reject a perfectly good comment because an unrelated
 * status changed while it was being typed — which is how people learn to keep
 * their notes somewhere else.
 *
 * For the same reason it does NOT bump `applications.updated_at`: the
 * application row did not change, and bumping it would invalidate every open
 * tab's token and produce phantom conflicts on the next real gesture.
 */
create or replace function public.app_add_note(
  p_application_id bigint,
  p_body           text,
  p_idem           text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.applications;
  v_result jsonb;
  v_body   text := public.hq_blank_trim(p_body);
  v_id     bigint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  -- Refused BEFORE any write. The table's CHECK would catch it too, but as a
  -- constraint violation rendered to a person as a wall of Postgres text.
  if v_body = '' then
    raise exception 'a note needs something in it' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception 'note is too long (max 4000 characters)' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Locked even though nothing on the row is updated: it is what serialises two
  -- concurrent notes on one application so the post-lock replay check below can
  -- do its job, and it proves the application exists and is this user's.
  select * into v_row
    from public.applications
   where user_id = v_user and id = p_application_id
     for update;
  if not found then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  insert into public.application_notes (user_id, application_id, body, author)
  values (v_user, p_application_id, v_body, 'user')
  returning id into v_id;

  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user, 'action.note', v_row.posting_key, v_row.id,
    jsonb_build_object('note_id', v_id, 'idem', p_idem),
    'user'
  );

  v_result := public.app_application_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_add_note', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

revoke all on function public.app_add_note(bigint, text, text) from public;
grant execute on function public.app_add_note(bigint, text, text) to authenticated;

-- ============================================================ next action

create or replace function public.app_set_next_action(
  p_application_id      bigint,
  p_next_action         text,
  p_next_action_date    date,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.applications;
  v_result jsonb;
  v_text   text := public.hq_blank_trim(p_next_action);
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if length(v_text) > 500 then
    raise exception 'next action is too long (max 500 characters)' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  select * into v_row
    from public.applications
   where user_id = v_user and id = p_application_id
     for update;
  if not found then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Saved on blur, so this fires constantly on a field nobody edited. Without
  -- the short circuit, tabbing through the pipeline would bump every row's
  -- version token and fill the audit trail with non-events.
  if v_row.next_action = v_text
     and v_row.next_action_date is not distinct from p_next_action_date then
    v_result := public.app_application_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (v_user, p_idem, 'app_set_next_action', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this application changed since you read it'
      using errcode = '40001';
  end if;

  update public.applications
     set next_action      = v_text,
         next_action_date = p_next_action_date,
         updated_at       = now()
   where user_id = v_user and id = p_application_id
   returning * into v_row;

  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user, 'action.next_action', v_row.posting_key, v_row.id,
    jsonb_strip_nulls(jsonb_build_object(
      'next_action',      nullif(v_text, ''),
      'next_action_date', p_next_action_date,
      'idem',             p_idem
    )),
    'user'
  );

  v_result := public.app_application_row(v_row);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_next_action', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

revoke all on function public.app_set_next_action(bigint, text, date, text, timestamptz) from public;
grant execute on function public.app_set_next_action(bigint, text, date, text, timestamptz) to authenticated;
