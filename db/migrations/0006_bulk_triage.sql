-- Bulk triage — one decision applied to many postings, atomically.
--
-- The grid lets a user select N rows and press i/x/s once. That has to be one
-- transaction, not N calls: N calls can fail halfway and leave half the
-- selection triaged, which is the silent-partial-state this system exists to
-- avoid. So app_set_triage_bulk does the whole selection or none of it — a
-- conflict on any single row rolls the entire batch back, and the caller
-- re-reads rather than discovering later that 3 of 40 rows were skipped.
--
-- It repeats app_set_triage's body per key rather than sharing a helper,
-- deliberately: the single-row function is the one the whole system already
-- leans on, and coupling a rarely-used bulk path into it would put every triage
-- one refactor away from breakage. The behaviour is pinned independently in
-- tests/db/test_bulk_triage.py, and the two must agree — that agreement is a
-- test, not an abstraction.

create or replace function public.app_set_triage_bulk(
  p_keys                text[],
  p_triage              text,
  p_snooze_until        date,
  p_reason              text,
  p_idem                text,
  p_expected_updated_at text[]   -- parallel to p_keys; a null element skips the check
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_result jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_row    public.user_postings;
  v_key    text;
  v_exp    timestamptz;
  v_app_id bigint;
  i        int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_triage is null or p_triage not in ('', 'interested', 'dismissed', 'snoozed') then
    raise exception 'invalid triage value: %', p_triage using errcode = '22023';
  end if;
  if p_triage = 'snoozed' and p_snooze_until is null then
    raise exception 'snoozed requires a wake date' using errcode = '22023';
  end if;
  if p_keys is null or array_length(p_keys, 1) is null then
    raise exception 'no postings selected' using errcode = '22023';
  end if;
  -- A bound, because everything that fans out gets one. A single gesture over
  -- more than this is a bug or an accident, not a decision, and a runaway batch
  -- should fail fast rather than lock a thousand rows.
  if array_length(p_keys, 1) > 1000 then
    raise exception 'too many postings in one batch' using errcode = '22023';
  end if;

  -- The whole batch replays as a unit under one key.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  for i in 1 .. array_length(p_keys, 1) loop
    v_key := p_keys[i];
    v_exp := case
               when p_expected_updated_at is null then null
               when p_expected_updated_at[i] is null then null
               else p_expected_updated_at[i]::timestamptz
             end;
    v_app_id := null;

    select * into v_row
      from public.user_postings
     where user_id = v_user and posting_key = v_key
       for update;
    if not found then
      raise exception 'no such posting for this user: %', v_key using errcode = 'P0002';
    end if;

    -- Any single conflict fails the whole transaction — the batch is atomic.
    if v_exp is not null and v_row.updated_at is distinct from v_exp then
      raise exception 'conflict: % changed since you read it', v_key
        using errcode = '40001';
    end if;

    -- A no-op row contributes nothing: no write, no event, no version bump —
    -- so a bulk gesture that lands on rows already in that state does not
    -- invalidate every other tab's tokens for them (0003's lesson, at scale).
    if v_row.triage = p_triage
       and v_row.triage_reason is not distinct from coalesce(p_reason, '')
       and v_row.snooze_until is not distinct from
           (case when p_triage = 'snoozed' then p_snooze_until else null end)
    then
      v_rows := v_rows || public.app_triage_row(v_row);
      continue;
    end if;

    update public.user_postings
       set triage        = p_triage,
           triage_reason = coalesce(p_reason, ''),
           snooze_until  = case when p_triage = 'snoozed' then p_snooze_until else null end,
           updated_at    = now()
     where user_id = v_user and posting_key = v_key
     returning * into v_row;

    if p_triage = 'interested' then
      insert into public.applications (user_id, posting_key, company, title, url, status)
      select v_user, p.key, p.company, p.title, p.url, 'Queued'
        from public.postings p
       where p.key = v_key
         and not exists (
           select 1 from public.applications a
            where a.user_id = v_user and a.posting_key = v_key)
      returning id into v_app_id;
    end if;

    if p_triage <> 'interested' then
      delete from public.applications
       where user_id = v_user and posting_key = v_key and status = 'Queued';
    end if;

    insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
    values (
      v_user,
      case p_triage
        when 'interested' then 'action.interested'
        when 'dismissed'  then 'action.dismissed'
        when 'snoozed'    then 'action.snoozed'
        else                   'action.untriage'
      end,
      v_key, v_app_id,
      jsonb_strip_nulls(jsonb_build_object(
        'triage', p_triage,
        'reason', nullif(coalesce(p_reason, ''), ''),
        'snooze_until', p_snooze_until,
        'idem', p_idem,
        'bulk', true
      )),
      'user'
    );

    v_rows := v_rows || public.app_triage_row(v_row);
  end loop;

  v_result := jsonb_build_object('rows', v_rows);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_triage_bulk', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;

revoke all on function public.app_set_triage_bulk(text[], text, date, text, text, text[]) from public;
grant execute on function public.app_set_triage_bulk(text[], text, date, text, text, text[]) to authenticated;
