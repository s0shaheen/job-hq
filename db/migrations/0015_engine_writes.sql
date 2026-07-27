-- 0015 — the engine writes the pipeline: one email event, one locked step.
--
-- Reading order: 0010_pipeline.sql first. That migration built the human lock
-- (`status_actor`, the `applications_human_status_lock` trigger) and named the
-- writer it was defending against in its own header: "the engine mirrors the
-- sheet with the service role, which bypasses RLS and calls no function of
-- ours". This is that writer finally calling one.
--
-- SHEET-SUNSET Phase C1: `tracker/join.py` matches a classified Gmail event to a
-- Pipeline row and advances it. Until now that happened only in the spreadsheet.
-- Under `HQ_PG_WRITES=first_class` it happens in both stores, and the pg half
-- goes through here.
--
-- WHY A FUNCTION AND NOT THREE REST CALLS. The engine already knows how to
-- upsert through PostgREST (core/pg.py), so the shape it could not have is the
-- only reason this exists: read the row, decide against what it says, and write
-- — with nothing able to slip between the read and the write. Split across REST
-- calls, "is this row locked?" is answered a network round trip before the write
-- that depends on the answer, which is precisely the race the lock exists to
-- close. `select … for update` plus one UPDATE in one body closes it.
--
-- WHAT LIVES HERE AND WHAT STAYS IN PYTHON. Policy lives here: the human lock,
-- forward-only rank, the no-op short circuit, the audit event, idempotent
-- replay. CLASSIFICATION stays in the engine: which status an `oa_invite` means
-- and whether 0.83 confidence clears the gate are `core/schema.py`'s
-- `EVENT_STATUS_RULES` and `HARD_WRITE_MIN_CONFIDENCE`, read by the Apps Script
-- classifier's output and passed in as `p_status` / `p_hard`. The split is the
-- one that survives a second caller: a future `/api/capture` endpoint that
-- writes pg directly gets the policy for free and brings its own classifier.
--
-- NOT SECURITY DEFINER, and it takes `p_user_id`. Those two facts belong
-- together: a definer function that accepts the acting user as an argument is an
-- authorization bypass with extra steps, which is why
-- `tests/core/test_migrations.py::test_definer_functions_never_take_a_user_id`
-- exists. This runs with the CALLER's rights, and the only caller is the
-- engine's service role — 0009's `reconcile_grounded_company`, same shape, same
-- grants, same reasons.

-- ============================================================ the ladder

/**
 * The status vocabulary, in SQL, split the way `core/schema.py` splits it.
 *
 * `hq_finished_statuses()` (0010) already needed two of these three lists and
 * spelled them as one literal array. Ranking needs them apart — terminal ranks
 * above Offer, resolved ranks above terminal — so rather than adding a fourth
 * hand-typed copy of the same eleven strings, the lists are named once here and
 * `hq_finished_statuses()` is redefined as the union it always was. Same
 * contents, same order; `tests/db/test_pipeline.py`'s three-language parity test
 * is what proves that sentence rather than this comment.
 */
create or replace function public.hq_status_order()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['Inbox', 'Queued', 'Applied', 'OA', 'Screen', 'Interview',
               'Final', 'Offer']::text[]
$$;

create or replace function public.hq_status_terminal()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['Rejected', 'Withdrawn', 'Closed']::text[]
$$;

create or replace function public.hq_status_resolved()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['Offer-Accepted', 'Offer-Declined']::text[]
$$;

-- Redefined, not duplicated. 0013 replaces 0008's `app_company_row` for the same
-- reason: a migration that has been applied is history, but a list that exists
-- twice is a list that will disagree with itself.
create or replace function public.hq_finished_statuses()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select public.hq_status_terminal() || public.hq_status_resolved()
$$;

comment on function public.hq_finished_statuses() is
  'terminal + resolved: the statuses that mean the application is over (0010, re-expressed over the split lists in 0015)';

/**
 * `core/schema.py:status_rank`, ported — and the third implementation of it, so
 * it is pinned rather than trusted.
 *
 * `tests/db/test_engine_writes.py::test_the_rank_matches_the_python_original`
 * calls `core.schema.status_rank` itself and compares its answer to this one for
 * every canonical status, an invented one, and the blank and whitespace cases.
 * That pin is the only thing standing between this and the drift that makes a
 * bot advance a row it should have left alone; a comment saying "keep in step" is
 * not a mechanism (`webapp/lib/status.ts` says the same thing about its own copy,
 * and has its own parser to back it).
 *
 * The shape, for readers who will not have schema.py open:
 *   blank            -> -1  (an empty cell is behind everything, so anything advances it)
 *   the ladder       -> 0..7 in order
 *   terminal         -> 9   (above Offer: a bot never reopens a closed row)
 *   resolved         -> 10  (an accepted offer outranks a rejection that lands later)
 *   anything else    -> 11  (a human-invented status is untouchable)
 *
 * 8 is deliberately unused — it is `len(STATUS_ORDER)`, and the Python skips it
 * for the same reason: rank gaps cost nothing and an off-by-one that collapses
 * "Offer" into "Rejected" costs somebody their offer.
 *
 * Rank is NOT the human-wins mechanism and never was: `Rejected` outranks
 * `Offer`, so rank alone let a 0.99-confidence rejection email overwrite an
 * Offer a person had chosen (0010's whole first page). `status_actor` is that
 * mechanism. This answers a different question — is the move FORWARD.
 */
/**
 * The trim `hq_status_rank` compares with — Python's `str.strip()`, not
 * `hq_blank_trim`.
 *
 * Those two are NOT the same function, and the difference was reachable in the
 * one direction that loses data. `hq_blank_trim` strips zero-width characters
 * (U+200B–D, U+FEFF) globally; `str.strip()` does not strip them at all, because
 * they are not whitespace. So `'​Applied'` — what pasting a status out of a
 * web page into the Pipeline tab produces — ranked 2 in SQL and 11 in Python: SQL
 * would advance over it, Python would treat it as a human-invented status and
 * leave it alone. The store being the LESS careful of the two is the wrong way
 * round, and `p_current_status` made it reachable from a hand-edited cell.
 *
 * The class here is Python's: `[[:space:]]` plus the Unicode separators plus
 * U+0085 (NEL) and U+001C–U+001F (the file/group/record/unit separators), all of
 * which `str.isspace()` reports true for and none of which `[[:space:]]` covers
 * in a UTF-8 locale. Zero-width characters are deliberately NOT stripped, so a
 * status carrying one ranks 11 — untouchable — in both languages.
 *
 * `hq_blank_trim` stays exactly where it is for emptiness checks: a note of one
 * zero-width space really is blank. This is a comparison, not a blankness test.
 */
create or replace function public.hq_status_trim(p_status text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  -- Spelled as ESCAPES, never as the characters themselves: 0010's own lesson
  -- is that an invisible character in a source file is a rule nobody can read
  -- or review. HQ_PY_STRIP_CLASS is a marker, not decoration -- the parity test
  -- in tests/db/test_engine_writes.py expands it against Python's own answer one
  -- codepoint at a time, so a character added to one side and not the other
  -- fails rather than drifting.
  select regexp_replace(coalesce(p_status, ''),
           /* HQ_PY_STRIP_CLASS */
           '^[[:space:]\u0085\u001C-\u001F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+'
           || '|[[:space:]\u0085\u001C-\u001F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$',
           '', 'g')
$$;

comment on function public.hq_status_trim(text) is
  'Python str.strip()''s whitespace class, for status COMPARISON — unlike hq_blank_trim it leaves zero-width characters in place, so a status carrying one is untouchable in both languages';

create or replace function public.hq_status_rank(p_status text)
returns int
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  -- `hq_status_trim`, not bare btrim and not `hq_blank_trim`: bare btrim trims
  -- spaces only, so a status of one tab would rank as human-invented (11) and lock
  -- the row against every bot forever — and `hq_blank_trim` trims MORE than the
  -- Python original, which is the divergence documented above it.
  select case
    when public.hq_status_trim(p_status) = '' then -1
    when array_position(public.hq_status_order(),
                        public.hq_status_trim(p_status)) is not null
      then array_position(public.hq_status_order(),
                          public.hq_status_trim(p_status)) - 1
    when public.hq_status_trim(p_status) = any (public.hq_status_terminal())
      then array_length(public.hq_status_order(), 1) + 1
    when public.hq_status_trim(p_status) = any (public.hq_status_resolved())
      then array_length(public.hq_status_order(), 1) + 2
    else array_length(public.hq_status_order(), 1) + 3
  end
$$;

comment on function public.hq_status_rank(text) is
  'forward-only comparison rank; the SQL port of core/schema.py:status_rank, pinned against it in tests/db/test_engine_writes.py';

-- ============================================================ seed the twin

/**
 * One sheet Pipeline row, reconciled into `applications` — the drain for every
 * application that existed before the flag did.
 *
 * WHY IT IS NEEDED AT ALL. `hq_apply_email_event` can only create a row when an
 * email arrives about it, and most applications have already had every email they
 * are going to get. Without this, flipping `HQ_PG_WRITES=first_class` leaves the
 * store's pipeline permanently empty of everything the sheet already holds — 141
 * rows, measured — and every event about them answers `no_application`.
 *
 * BOTS FILL BLANKS; HUMANS WIN, in both directions, because both stores now have
 * humans in them:
 *
 *   * a column pg already has a value for is never overwritten. The web app is a
 *     live editing surface, and this job runs by hand at an arbitrary time; the
 *     sheet is the older record, not automatically the truer one.
 *   * `status` moves FORWARD only, on the same ladder every other engine write
 *     uses, so seeding can never walk a row back.
 *   * a row whose pg `status_actor` is already 'user' has its status left entirely
 *     alone — somebody pressed something in the app, and this job did not.
 *   * a row the SHEET says is claimed ('user' in its dropdown) carries that claim
 *     ACROSS. This is the durable half of the dual-lock: once the claim is in pg,
 *     the 0010 trigger defends it against every writer, including this one on its
 *     next run, without anybody having to pass the sheet's opinion in.
 *
 * `posting_key` is REQUIRED and must already name a `postings` row. Sheet rows
 * that predate the Feed, and the weak `norm-` keys the fuzzy matcher mints, have
 * no posting to hang from — `applications.posting_key` is a foreign key, and a
 * NULL-keyed row here would be a twin the event lane could never match, so the
 * next real event would mint a SECOND row for the same application. The caller
 * counts and names those instead; guessing is what produces duplicates.
 */
create or replace function public.hq_upsert_sheet_application(
  p_user_id     uuid,
  p_posting_key text,
  p_row         jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_key        text := public.hq_blank_trim(p_posting_key);
  v_row        public.applications;
  v_status     text := public.hq_blank_trim(p_row ->> 'status');
  v_claimed    boolean := lower(public.hq_blank_trim(p_row ->> 'status_actor')) = 'user';
  v_new_status text;
  v_new_actor  text;
  v_outcome    text;
begin
  if p_user_id is null or v_key = '' then
    raise exception 'hq_upsert_sheet_application needs a user and a posting key'
      using errcode = '22023';
  end if;
  -- Same refusal as the event path, for the same reason: no bot may end a search,
  -- and a seeding job reading a hand-typed cell is exactly where one would try.
  -- A human's own `Offer-Accepted` still crosses over — it arrives with
  -- status_actor='user', and the claimed branch below writes it as a human write.
  if v_status = any (public.hq_status_resolved()) and not v_claimed then
    raise exception '% is a human-only ending; a bot may not seed it', v_status
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.postings where key = v_key) then
    return jsonb_build_object('outcome', 'no_posting', 'posting_key', v_key);
  end if;

  select * into v_row from public.applications
   where user_id = p_user_id and posting_key = v_key
     for update;

  if not found then
    -- Born with the sheet's own status and claim. `set_config` because a claimed
    -- row's INSERT is followed by nothing, but its next UPDATE from any writer must
    -- meet a trigger that already knows a human owns it.
    insert into public.applications
      (user_id, posting_key, company, title, url, source, status, status_actor,
       status_set_at, suggested_status, evidence, applied_date, applied_via,
       applied_email, last_activity, next_action, next_action_date, notes)
    values (
      p_user_id, v_key,
      coalesce(p_row ->> 'company', ''), coalesce(p_row ->> 'title', ''),
      coalesce(p_row ->> 'url', ''),
      coalesce(nullif(public.hq_blank_trim(p_row ->> 'source'), ''), 'sheet-seed'),
      coalesce(nullif(v_status, ''), 'Inbox'),
      case when v_claimed then 'user' else 'system' end,
      case when v_claimed then now() else null end,
      coalesce(p_row ->> 'suggested_status', ''),
      coalesce(p_row ->> 'evidence', ''),
      public.hq_iso_date(p_row ->> 'applied_date'),
      coalesce(p_row ->> 'applied_via', ''),
      coalesce(p_row ->> 'applied_email', ''),
      public.hq_iso_date(p_row ->> 'last_activity'),
      coalesce(p_row ->> 'next_action', ''),
      public.hq_iso_date(p_row ->> 'next_action_date'),
      coalesce(p_row ->> 'notes', ''))
    on conflict (user_id, posting_key) do nothing
    returning * into v_row;
    if found then
      insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
      values (p_user_id, 'application.seeded', v_key, v_row.id,
              jsonb_build_object('source', 'sheet-pipeline', 'status', v_row.status,
                                 'claimed', v_claimed),
              'system');
      return jsonb_build_object('outcome', 'created', 'application_id', v_row.id,
                                'posting_key', v_key);
    end if;
    select * into v_row from public.applications
     where user_id = p_user_id and posting_key = v_key
       for update;
  end if;

  -- The row exists. Status first, under both locks.
  v_new_status := v_row.status;
  v_new_actor  := v_row.status_actor;
  if v_row.status_actor <> 'user' and v_status <> ''
     and public.hq_status_rank(v_status) > public.hq_status_rank(v_row.status) then
    v_new_status := v_status;
  end if;
  if v_row.status_actor <> 'user' and v_claimed then
    v_new_actor := 'user';                       -- the claim crosses over, once
    v_new_status := coalesce(nullif(v_status, ''), v_new_status);
  end if;

  if v_new_status is distinct from v_row.status
     or v_new_actor is distinct from v_row.status_actor
     -- blanks only, on every other column: a value the app already holds is a
     -- value somebody may have typed there this morning
     or (public.hq_blank_trim(v_row.company) = '' and coalesce(p_row ->> 'company', '') <> '')
     or (public.hq_blank_trim(v_row.title) = '' and coalesce(p_row ->> 'title', '') <> '')
     or (public.hq_blank_trim(v_row.url) = '' and coalesce(p_row ->> 'url', '') <> '')
     or (public.hq_blank_trim(v_row.evidence) = '' and coalesce(p_row ->> 'evidence', '') <> '')
     or (public.hq_blank_trim(v_row.notes) = '' and coalesce(p_row ->> 'notes', '') <> '')
     or (v_row.applied_date is null and public.hq_iso_date(p_row ->> 'applied_date') is not null)
     or (v_row.last_activity is null and public.hq_iso_date(p_row ->> 'last_activity') is not null)
  then
    -- Declared as a human write ONLY when it is one: the claim crossing over is a
    -- person's gesture arriving late, and the 0010 trigger refuses an undeclared
    -- write that changes `status_actor` on an already-claimed row.
    if v_new_actor = 'user' and v_row.status_actor <> 'user' then
      perform set_config('hq.status_write', 'human', true);
    end if;
    update public.applications
       set status        = v_new_status,
           status_actor  = v_new_actor,
           status_set_at = case when v_new_actor = 'user' and v_row.status_actor <> 'user'
                                then now() else status_set_at end,
           company       = case when public.hq_blank_trim(company) = ''
                                then coalesce(p_row ->> 'company', '') else company end,
           title         = case when public.hq_blank_trim(title) = ''
                                then coalesce(p_row ->> 'title', '') else title end,
           url           = case when public.hq_blank_trim(url) = ''
                                then coalesce(p_row ->> 'url', '') else url end,
           evidence      = case when public.hq_blank_trim(evidence) = ''
                                then coalesce(p_row ->> 'evidence', '') else evidence end,
           notes         = case when public.hq_blank_trim(notes) = ''
                                then coalesce(p_row ->> 'notes', '') else notes end,
           applied_date  = coalesce(applied_date, public.hq_iso_date(p_row ->> 'applied_date')),
           last_activity = coalesce(last_activity, public.hq_iso_date(p_row ->> 'last_activity'))
     where id = v_row.id
     returning * into v_row;
    perform set_config('hq.status_write', '', true);
    v_outcome := 'updated';
  else
    v_outcome := 'unchanged';
  end if;

  return jsonb_build_object('outcome', v_outcome, 'application_id', v_row.id,
                            'posting_key', v_key);
end;
$$;

comment on function public.hq_upsert_sheet_application(uuid, text, jsonb) is
  'engine-only: reconcile one sheet Pipeline row into applications — fills blanks, advances status forward-only, never touches a row the app has claimed, and carries the sheet''s own claim across once';

revoke all on function public.hq_upsert_sheet_application(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.hq_upsert_sheet_application(uuid, text, jsonb)
  to service_role;

-- ==================================================== the events that landed nowhere

/**
 * A classified email the store had nothing to apply to, recorded so that fact is
 * findable later.
 *
 * WHY IT EXISTS. `join` stamps the event's `matched_key` cell whatever the store
 * answered, because that cell means "the SHEET lane processed this event" and it
 * did. Leaving it blank to keep the store's queue alive would un-truth the sheet's
 * own audit AND turn a permanently unresolvable event — the four weak `norm-` keys
 * in today's Pipeline can never name a posting — into a re-application every two
 * hours, forever, each one appending a Log row and re-appearing in the next
 * morning's briefing. A queue that cannot drain is not a queue.
 *
 * So the event retires in the sheet and leaves its trace HERE instead: per-user,
 * append-only, queryable, next to every other thing that happened to this
 * application. 0009's `note_grounding_blocked` is the same shape for the same
 * reason — "we refused, here is what and why" belongs in `events`.
 *
 * The drain is `tracker.pgseed` (the Pipeline→applications seed), not this
 * function; what this makes possible is knowing what to drain, and noticing if the
 * residue stops shrinking. `docs/RUNBOOK.md` carries the query.
 *
 * ONCE PER CONCLUSION, not once per run. The guard is an existence check on the
 * idempotency key inside the payload rather than a `command_idempotency` row,
 * because these paths must stay RETRYABLE: the posting genuinely may arrive
 * tomorrow, and storing a command result would answer "already applied" for an
 * event that was never applied at all.
 */
create or replace function public.hq_note_unapplied_event(
  p_user_id    uuid,
  p_posting_key text,
  p_event_id   text,
  p_event_type text,
  p_idem       text,
  p_reason     text
)
returns void
language sql
set search_path = public, pg_temp
as $$
  insert into public.events (user_id, kind, posting_key, payload, actor)
  select p_user_id, 'email.unapplied', p_posting_key,
         jsonb_build_object('reason', p_reason, 'event_id', p_event_id,
                            'event_type', p_event_type, 'idem', p_idem,
                            'posting_key', p_posting_key),
         'gmail-capture'
   where not exists (
     select 1 from public.events e
      where e.user_id = p_user_id
        and e.kind = 'email.unapplied'
        and e.payload ->> 'idem' = p_idem)
$$;

comment on function public.hq_note_unapplied_event(uuid, text, text, text, text, text) is
  'engine-only: record that a classified email had no application to apply to, so the residue is findable and drainable (tracker.pgseed)';

revoke all on function public.hq_note_unapplied_event(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_note_unapplied_event(uuid, text, text, text, text, text)
  to service_role;

-- ============================================================ apply an event

/**
 * One classified email event, applied to one application.
 *
 * `p_status` is what the classifier's event type maps to ('' when the type
 * carries no status rule — a recruiter cold email is activity, not a stage).
 * `p_hard` is the engine's answer to "is this rule a hard one AND did the
 * classifier clear the confidence gate": true means "write the status", false
 * means "record the opinion". Splitting it that way keeps every threshold in
 * `core/schema.py`, where the sheet lane reads it too.
 *
 * `p_create` is the birth certificate for an application that does not exist
 * yet — the Gmail-first case the sheet lane calls `_create_row`: a confirmation
 * email for something applied to before anything was tracking it. NULL means
 * "never create", and the row is created at `Inbox` rather than at the event's
 * status ON PURPOSE, so the advance below applies the same forward-only rule to
 * a newborn row as to a five-week-old one. The sheet lane has two paths there
 * and therefore two copies of the rule; this has one.
 *
 * OUTCOMES, all returned rather than raised, because every one of them is a
 * thing the caller reports differently and none of them is an error:
 *
 *   no_posting     the jobkey names no row in `postings`. `applications.posting_key`
 *                  is a foreign key, so this is not a row this function may
 *                  invent — the sweep mirrors postings, and until it has, the
 *                  event waits. Logged and skipped by the caller, never guessed.
 *   no_application no application for this user + posting, and p_create was NULL.
 *   matched        the event carries no status rule: activity stamp only.
 *   advanced       forward move on an unclaimed row. The one write that changes `status`.
 *   kept           the move is backward or sideways — a stale or out-of-order
 *                  email. Deliberately NOT recorded as a suggestion: "suggests
 *                  Applied" on an Interview row is noise that teaches people to
 *                  ignore the column.
 *   locked         a human owns this row's status. The bot's opinion lands in
 *                  `suggested_status` and `status` is not touched — acceptance
 *                  criterion 14, whose second half is that the human keeps their
 *                  Offer AND sees the rejection.
 *   suggested      below the confidence gate, or a soft rule: same write, and it
 *                  happens on locked and unlocked rows alike.
 *
 * The branch ORDER matters and mirrors `core/sheets.py:advance_status` exactly:
 * the lock is checked before the rank, so a locked row gets a suggestion even
 * when the move would have been backward. The two answers are not
 * interchangeable — one says "a person owns this", the other says "this email is
 * stale" — and collapsing them is how criterion 14 was lost the first time.
 *
 * IDEMPOTENT on the classifier's `event_id`. `join` replays every event whose
 * `matched_key` cell is still blank, so a run that wrote pg and then died before
 * stamping the sheet WILL come back with the same event. The stored result is
 * returned verbatim on a replay (0003's rule: a bare "already applied" leaves the
 * caller unable to report what happened), and the check is repeated BEHIND the
 * row lock because the pre-lock one only settles sequential replays.
 *
 * `p_current_status` / `p_current_actor` are the OTHER store's view of the same
 * application — during dual-write, the sheet Pipeline row the sheet lane just
 * decided against. Both rules below are evaluated across the pair, so the two
 * lanes reach the same verdict by construction. See the block above the decision
 * for why this is a parameter rather than something this function could infer.
 */

-- The pre-review signature took nine arguments. `create or replace` with a
-- different parameter list creates an OVERLOAD rather than replacing, and
-- PostgREST resolves overloads by argument NAME — two versions in one database
-- would make every call ambiguous ("function is not unique") rather than wrong,
-- which is at least loud, but `db/apply.sh` re-runs this whole directory and has
-- no business leaving a second copy behind. No live database has ever held the
-- old one; this is here so that stays true.
drop function if exists public.hq_apply_email_event(
  uuid, text, text, text, text, boolean, text, date, jsonb);

create or replace function public.hq_apply_email_event(
  p_user_id        uuid,
  p_posting_key    text,
  p_event_id       text,
  p_event_type     text,
  p_status         text,
  p_hard           boolean,
  p_evidence       text,
  p_activity_on    date,
  p_create         jsonb,
  -- REQUIRED, deliberately without defaults. A default would make "I forgot to pass
  -- the sheet's truth" and "I have no second store" the same call, and the first of
  -- those silently restores the defect the pair exists to close. Post-Phase-D callers
  -- pass NULL and mean it; `tests/core/test_migrations.py` asserts `join` passes every
  -- parameter this function declares, so a future argument cannot be forgotten either.
  p_current_status text,
  p_current_actor  text
)
returns jsonb
language plpgsql
-- Pinned for 0009's reason: this body calls `public.hq_status_rank` and
-- `public.hq_blank_trim`, and a shadowed resolution of either decides whether
-- somebody's Offer survives.
set search_path = public, pg_temp
as $$
declare
  v_idem          text;
  v_row           public.applications;
  v_result        jsonb;
  v_status        text := public.hq_blank_trim(p_status);
  v_evidence      text := public.hq_blank_trim(p_evidence);
  v_key           text := public.hq_blank_trim(p_posting_key);
  v_on            date := coalesce(p_activity_on, current_date);
  v_created       boolean := false;
  v_outcome       text;
  v_new_status    text;
  v_new_suggested text;
  v_new_evidence  text;
  v_creating      boolean;
  v_other_actor   text := lower(public.hq_blank_trim(p_current_actor));
  v_other_locked  boolean;
  v_known_rank    int;
begin
  if p_user_id is null then
    raise exception 'hq_apply_email_event needs the user whose lanes it writes'
      using errcode = '22023';
  end if;
  if v_key = '' then
    raise exception 'hq_apply_email_event needs a posting key' using errcode = '22023';
  end if;
  -- The idempotency key IS the classifier's event id, so a missing one means the
  -- caller cannot promise replay safety and this must not pretend otherwise.
  if public.hq_blank_trim(p_event_id) = '' then
    raise exception 'idempotency key required (the email event id)'
      using errcode = '22023';
  end if;
  -- No bot may end a search. The engine structurally cannot name these
  -- (`EVENT_STATUS_RULES` has no entry that maps to one, and `tracker/join.py`
  -- asserts it), which is exactly why the refusal is repeated at the other end
  -- of the wire: the engine's guarantee is about today's table, and this one
  -- holds for whatever calls it next.
  if v_status = any (public.hq_status_resolved()) then
    raise exception '% is a human-only ending; no bot may write it', v_status
      using errcode = '42501';
  end if;

  -- The idempotency key names the event AND what was concluded about it, not the
  -- event alone. Two reachable bugs came out of the shorter version:
  --
  --   * the fuzzy branch of `join`'s ladder resolves one event to a DIFFERENT
  --     Pipeline row when the candidate set changes between runs (`promote` adds
  --     rows every two hours), and the replay then returned the first row's answer
  --     while writing nothing — reported to the caller as success, on a row that
  --     never moved. `posting_key` in the key makes those two different commands.
  --   * a re-classified message (0.6 'received' on Monday, 0.99 'interview' on
  --     Tuesday — the classifier is an LLM and its output is not stable) replayed
  --     Monday's conclusion forever. Including the conclusion lets Tuesday apply,
  --     and the forward-only ladder is what keeps that monotonic: a classifier
  --     that changes its mind can move the row on, never back.
  v_idem := 'join:' || public.hq_blank_trim(p_event_id) || ':' || v_key
            || ':' || v_status || ':' || case when coalesce(p_hard, false) then 'h' else 's' end;

  select result into v_result
    from public.command_idempotency
   where user_id = p_user_id and idem_key = v_idem;
  if found then
    return v_result;
  end if;

  -- The posting first. `applications.posting_key` references `postings (key)`,
  -- so an event whose jobkey the sweep has not mirrored yet cannot produce a row
  -- here — and MUST NOT produce a guessed one. Answered rather than raised: this
  -- is a gap to be drained (`tracker.pgseed`, or the next sweep mirroring the
  -- posting), not a failure to page somebody about at 02:31.
  if not exists (select 1 from public.postings where key = v_key) then
    perform public.hq_note_unapplied_event(
      p_user_id, v_key, p_event_id, p_event_type, v_idem, 'no_posting');
    return jsonb_build_object('outcome', 'no_posting', 'posting_key', v_key,
                              'created', false);
  end if;

  select * into v_row
    from public.applications
   where user_id = p_user_id and posting_key = v_key
     for update;

  if not found then
    -- `jsonb_typeof` as well as `is null`: PostgREST sends a JSON `null` for an
    -- absent argument, and `jsonb 'null'` is a VALUE, not NULL — without this
    -- the caller's "do not create" would create a row with every field blank.
    v_creating := p_create is not null and jsonb_typeof(p_create) <> 'null';
    if not v_creating then
      perform public.hq_note_unapplied_event(
        p_user_id, v_key, p_event_id, p_event_type, v_idem, 'no_application');
      return jsonb_build_object('outcome', 'no_application', 'posting_key', v_key,
                                'created', false);
    end if;
    insert into public.applications
      (user_id, posting_key, company, title, url, source, status,
       applied_date, applied_via, applied_email, evidence, last_activity)
    values (
      p_user_id, v_key,
      coalesce(p_create ->> 'company', ''),
      coalesce(p_create ->> 'title', ''),
      coalesce(p_create ->> 'url', ''),
      coalesce(nullif(public.hq_blank_trim(p_create ->> 'source'), ''), 'gmail'),
      'Inbox',
      -- `hq_iso_date` (0013): NULL for anything that is not an ISO date, never a
      -- rolled-over neighbour and never a raise. A received_at the classifier
      -- could not parse must not fail the whole event.
      public.hq_iso_date(p_create ->> 'applied_date'),
      coalesce(p_create ->> 'applied_via', ''),
      coalesce(p_create ->> 'applied_email', ''),
      v_evidence, v_on)
    on conflict (user_id, posting_key) do nothing
    returning * into v_row;

    if found then
      v_created := true;
    else
      -- Lost the insert race to a concurrent lane. The winner's row is the row;
      -- take the lock on it and carry on as if it had been there all along.
      select * into v_row
        from public.applications
       where user_id = p_user_id and posting_key = v_key
         for update;
    end if;
  end if;

  -- Behind the lock (0003:166-182). The pre-lock check settles SEQUENTIAL
  -- replays only: two tracker runs overlapping on one event both clear it before
  -- either writes, and without this the loser applies a second time against an
  -- append-only trail.
  select result into v_result
    from public.command_idempotency
   where user_id = p_user_id and idem_key = v_idem;
  if found then
    return v_result;
  end if;

  if v_created then
    insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
    values (p_user_id, 'email.application_created', v_key, v_row.id,
            jsonb_build_object('event_id', p_event_id, 'event_type', p_event_type,
                               'idem', v_idem),
            'gmail-capture');
  end if;

  -- ---------------------------------------------------------------- sheet truth
  --
  -- During dual-write the human's editing surface is the SPREADSHEET, and pg's own
  -- `status_actor` is written by exactly one thing: `app_set_status`, the web app.
  -- So a person who types Offer into the Pipeline tab claims the sheet row and
  -- claims nothing here — pg's twin still says 'Queued' with actor 'system', and
  -- deciding against it re-created the defect 0010 exists to prevent, in the store
  -- Phase C is promoting to system of record. Executed, before this: sheet said
  -- Offer/'user' and `join` recorded a suggestion, while the SAME event advanced pg
  -- to Rejected.
  --
  -- The fix is not a smarter guess about pg's own row; it is that the caller already
  -- HAS the authoritative pair and can hand it over. `p_current_status` /
  -- `p_current_actor` are the sheet Pipeline row's `status` and `status_actor` as the
  -- sheet lane saw them, and the two rules below are then evaluated against BOTH
  -- stores at once. The result is that the two lanes reach the same verdict by
  -- construction, which is what dual-write is supposed to mean.
  --
  -- NULL means "this caller has no second store to reconcile against" — a future
  -- `/api/capture` writing pg directly, and every caller after Phase D. It decides on
  -- pg alone, which is correct exactly then and wrong exactly now, so `join` always
  -- passes both (pinned in tests/core/test_migrations.py).
  --
  -- UNKNOWN ACTOR LOCKS. The sheet's cell is a two-value dropdown a human edits, so
  -- '' and 'system' mean unclaimed and 'user' means claimed — and anything else means
  -- this function does not understand what it is looking at. The safe reading of an
  -- unknown value is the one that does not lose somebody's Offer (0010's own comment
  -- makes the same argument for the column, in the other direction). Case-folded
  -- because `advance_status` reads the same cell with `.casefold()`.
  v_other_locked := v_other_actor not in ('', 'system');

  -- Forward-only against the FURTHEST either store has got. max(), never the pg row
  -- alone: a sheet at `Offer-Accepted` (rank 10, typed by hand, no dropdown needed)
  -- and a pg twin at `Queued` (rank 1) is a real pairing today, and rank 9 `Rejected`
  -- must lose to it exactly the way it loses in the sheet lane.
  v_known_rank := greatest(
    public.hq_status_rank(v_row.status),
    case when p_current_status is null then -1
         else public.hq_status_rank(p_current_status) end);

  if v_status = '' then
    v_outcome := 'matched';
  elsif not coalesce(p_hard, false) then
    v_outcome := 'suggested';
  -- The lock, from EITHER store, and before the rank — `core/sheets.py`'s
  -- `advance_status` checks them in this order for a reason that survives the port:
  -- "a person owns this row" and "this email is stale" call for different answers,
  -- and collapsing them loses the half of criterion 14 where the human keeps their
  -- Offer AND sees that a rejection came in.
  elsif v_row.status_actor = 'user' or v_other_locked then
    v_outcome := 'locked';
  elsif public.hq_status_rank(v_status) <= v_known_rank then
    v_outcome := 'kept';
  else
    v_outcome := 'advanced';
  end if;

  v_new_status    := v_row.status;
  v_new_suggested := v_row.suggested_status;
  -- Evidence is written on the two paths that record an opinion, and only when
  -- there IS one: writing it unconditionally blanked the existing deep link
  -- whenever an event arrived with no thread_link, and that link is the one
  -- field on the row a person actually needs to act on. `advance_status` has
  -- always guarded it the same way.
  v_new_evidence  := case when v_outcome in ('advanced', 'locked', 'suggested')
                           and v_evidence <> '' then v_evidence
                     else v_row.evidence end;
  if v_outcome = 'advanced' then
    v_new_status := v_status;
  elsif v_outcome in ('locked', 'suggested') then
    v_new_suggested := v_status;
  end if;

  -- A pass that changes nothing writes nothing. `applications_touch` bumps
  -- `updated_at` on every UPDATE and `updated_at` is the web app's concurrency
  -- token, so an unguarded activity stamp would invalidate every open tab's
  -- token twice an hour and turn the next real gesture into a phantom conflict
  -- (0010's rule, and 0003's before it).
  if v_new_status is distinct from v_row.status
     or v_new_suggested is distinct from v_row.suggested_status
     or v_new_evidence is distinct from v_row.evidence
     or v_row.last_activity is distinct from v_on then
    update public.applications
       set status           = v_new_status,
           suggested_status = v_new_suggested,
           evidence         = v_new_evidence,
           last_activity    = v_on
     where id = v_row.id
     returning * into v_row;
  end if;

  -- `status_actor` and `status_set_at` are NOT written, on any path. 0010's
  -- column comment is the specification: `status_set_at` is a human-gesture
  -- timestamp, and a bot advance that stamped `status_actor = 'system'` on a row
  -- that already said 'system' would be harmless the day it shipped and a
  -- one-statement unlock the day somebody generalises it.

  -- The state change and its audit event in one body, or the trail has holes in
  -- it. `kind` carries the classifier's own event type verbatim rather than a
  -- mapping table nobody maintains; `actor` is the writer, which is the Gmail
  -- capture pipeline and not a person.
  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    p_user_id,
    'email.' || coalesce(nullif(public.hq_blank_trim(p_event_type), ''), 'unclassified'),
    v_key, v_row.id,
    jsonb_strip_nulls(jsonb_build_object(
      'outcome',  v_outcome,
      'status',   nullif(v_status, ''),
      'hard',     coalesce(p_hard, false),
      'created',  nullif(v_created, false),
      'event_id', p_event_id,
      'idem',     v_idem
    )),
    'gmail-capture');

  v_result := jsonb_build_object(
    'outcome',          v_outcome,
    'created',          v_created,
    'application_id',   v_row.id,
    'posting_key',      v_key,
    'status',           v_row.status,
    'suggested_status', v_row.suggested_status);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (p_user_id, v_idem, 'hq_apply_email_event', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.hq_apply_email_event(uuid, text, text, text, text, boolean, text, date, jsonb, text, text) is
  'engine-only: apply one classified Gmail event to an application under the 0010 human-status lock — advance-only, humans win, idempotent on the event id';

-- `public` is the pseudo-role; `anon` and `authenticated` hold their own grants
-- from Supabase's default privileges and would keep them. All three are revoked
-- by name, because this function takes the acting user as an argument: reachable
-- from a browser it would let any session advance any other person's pipeline.
revoke all on function public.hq_apply_email_event(uuid, text, text, text, text, boolean, text, date, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_apply_email_event(uuid, text, text, text, text, boolean, text, date, jsonb, text, text)
  to service_role;
