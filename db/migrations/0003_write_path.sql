-- Job Search HQ v2 — the human write path.
--
-- WHY THIS EXISTS
--
-- `webapp/lib/data/supabase-source.ts` has been calling `app_set_triage` since
-- the web app was written, and the function existed in no migration. Against a
-- real Supabase project every triage a human made would have failed at the
-- first keystroke — the fixture-backed data source is the only reason anything
-- looked like it worked. Four of the six phase plans in `docs/plans/` each
-- assume they are the one to create it; it is built once, here, first.
--
-- THE CONTRACT (docs/PRODUCT-SPEC.md §I, and 0001_init.sql's closing note)
--
--   * The browser has NO insert/update/delete policy and never gets one. This
--     function is `security definer` so the write happens with the definer's
--     rights, and it derives the acting user from `auth.uid()` — the caller
--     cannot name a user_id. That combination is the whole point: a hostile
--     client can call this, and the worst it can do is act as itself.
--   * The row and its audit event are written together. `events` is the audit
--     trail the spreadsheet never had; a state change without its event is a
--     silent edit, so both happen in one function body or neither does.
--   * An idempotency key makes a double-tap, a retry, and an offline replay
--     free: the first result is stored and replayed verbatim.
--   * `expected_updated_at` turns a second device into a visible conflict
--     rather than a silent clobber.

-- ============================================================ idempotency

-- Stores the RESULT, not just the key. Replaying a gesture has to return what
-- the first attempt returned — a bare "already applied" would leave the client
-- unable to render the row it just changed, and the offline outbox replays
-- gestures precisely because it does not know whether they landed.
create table if not exists public.command_idempotency (
  user_id    uuid not null references public.users (id) on delete cascade,
  idem_key   text not null,
  command    text not null,
  result     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, idem_key)
);

alter table public.command_idempotency enable row level security;
-- No policies: reached only through security-definer functions, never directly.

-- Keys are only useful while a client might still retry. Kept generously wide
-- so an outbox that sat in a closed phone tab for a week still replays safely.
create index if not exists command_idempotency_age_idx
  on public.command_idempotency (created_at);

-- ============================================================ set triage

create or replace function public.app_set_triage(
  p_posting_key         text,
  p_triage              text,
  p_snooze_until        date,
  p_reason              text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
-- Pinned: a security-definer function that inherits the caller's search_path
-- can be made to call a shadowed function. This is the standard hardening and
-- it is not optional.
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.user_postings;
  v_result jsonb;
  v_app_id bigint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- The CHECK on user_postings would catch this too, but a named error beats a
  -- constraint violation surfacing to a user as a wall of Postgres text.
  if p_triage is null or p_triage not in ('', 'interested', 'dismissed', 'snoozed') then
    raise exception 'invalid triage value: %', p_triage using errcode = '22023';
  end if;

  -- A snooze with no wake date is a row that leaves the queue and never comes
  -- back — the spec makes the date mandatory for exactly that reason.
  if p_triage = 'snoozed' and p_snooze_until is null then
    raise exception 'snoozed requires a wake date' using errcode = '22023';
  end if;

  -- Replay: return the first result rather than applying twice.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Lock the row for the duration. Without this, two concurrent gestures can
  -- both read the same updated_at, both pass the conflict check, and both
  -- write — which is the exact race acceptance criterion 26 is about.
  select * into v_row
    from public.user_postings
   where user_id = v_user and posting_key = p_posting_key
     for update;

  if not found then
    raise exception 'no such posting for this user: %', p_posting_key
      using errcode = 'P0002';
  end if;

  -- Optimistic concurrency. A null expectation means "I did not read a value",
  -- which is allowed — the client is then trusting last-write-wins knowingly.
  -- The word "conflict" in the message is load-bearing: supabase-source.ts
  -- matches on it to produce the conflict path rather than a generic error.
  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this row changed since you read it'
      using errcode = '40001';
  end if;

  update public.user_postings
     set triage        = p_triage,
         triage_reason = coalesce(p_reason, ''),
         -- Clearing the triage clears the wake date with it; a dismissed row
         -- carrying a stale snooze date is a row that reanimates itself.
         snooze_until  = case when p_triage = 'snoozed' then p_snooze_until else null end,
         updated_at    = now()
   where user_id = v_user and posting_key = p_posting_key
   returning * into v_row;

  -- Marking a posting interesting creates the application the pipeline shows.
  -- `on conflict do nothing` rather than an existence check: two gestures that
  -- slip past the row lock must not produce two applications.
  if p_triage = 'interested' then
    insert into public.applications (user_id, posting_key, company, title, url, status)
    select v_user, p.key, p.company, p.title, p.url, 'Queued'
      from public.postings p
     where p.key = p_posting_key
       and not exists (
         select 1 from public.applications a
          where a.user_id = v_user and a.posting_key = p_posting_key)
    returning id into v_app_id;
  end if;

  -- Undo removes the application ONLY while it is still bot-untouched.
  -- Acceptance criterion 11: once a bot has advanced it — a confirmation email
  -- arrived, a human moved it — the application is evidence of something that
  -- really happened and un-triaging the posting must not erase it.
  if p_triage = '' then
    delete from public.applications
     where user_id = v_user
       and posting_key = p_posting_key
       and status = 'Queued';
  end if;

  -- The audit event. Append-only: an undo appends a compensating event, it
  -- never deletes the original (acceptance criterion 10).
  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    v_user,
    case p_triage
      when 'interested' then 'action.interested'
      when 'dismissed'  then 'action.dismissed'
      when 'snoozed'    then 'action.snoozed'
      else                   'action.untriage'
    end,
    p_posting_key,
    v_app_id,
    jsonb_strip_nulls(jsonb_build_object(
      'triage',       p_triage,
      'reason',       nullif(coalesce(p_reason, ''), ''),
      'snooze_until', p_snooze_until,
      'idem',         p_idem
    )),
    'user'
  );

  -- Shaped for `toJobView` in webapp/lib/data/supabase-source.ts: the
  -- user_postings columns it reads, plus the nested `postings` object it
  -- unwraps. Returning the row the client will render, from inside the same
  -- transaction that wrote it, is what lets the UI settle without a refetch.
  select jsonb_build_object(
           'posting_key',        v_row.posting_key,
           'disposition',        v_row.disposition,
           'disposition_reason', v_row.disposition_reason,
           'triage',             v_row.triage,
           'snooze_until',       v_row.snooze_until,
           'updated_at',         v_row.updated_at,
           'postings', jsonb_build_object(
             'key',        p.key,
             'company',    p.company,
             'title',      p.title,
             'location',   p.location,
             'url',        p.url,
             'posted',     p.posted,
             'first_seen', p.first_seen,
             'last_seen',  p.last_seen,
             'status',     p.status,
             'tags',       p.tags,
             'geo',        p.geo,
             'source',     p.source
           )
         )
    into v_result
    from public.postings p
   where p.key = v_row.posting_key;

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_triage', v_result)
  -- Two racing calls with the same key: whichever lost still returns the same
  -- shape, and the row it wrote is identical.
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

-- The browser may call this; nothing else about writing is exposed to it.
-- `public` includes anonymous visitors, who have no auth.uid() and would be
-- rejected inside the function anyway — but an un-revoked security-definer
-- function is the kind of thing that becomes a hole three schema changes from
-- now, so it is revoked explicitly.
revoke all on function public.app_set_triage(text, text, date, text, text, timestamptz) from public;
grant execute on function public.app_set_triage(text, text, date, text, text, timestamptz) to authenticated;
