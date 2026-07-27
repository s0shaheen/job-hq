-- 0017 — the answer library learns two things it could not say: WHERE an answer
-- applies, and that somebody chose not to give one.
--
-- NUMBERING. This file is 0017 and there is no 0016 on this branch: **0016 is
-- claimed by the parallel engine branch**, cut from the same commit. The
-- reservation is DECLARED in `tests/core/test_migrations.py`'s
-- `RESERVED_MIGRATION_NUMBERS` and asserted in both directions — an undeclared
-- gap still fails, and the day 0016 lands the reservation goes red until its
-- line is deleted. 0014 opened with the same paragraph about 0013; the mechanism
-- worked, so it is used again rather than re-litigated.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY: TWO WAYS A CORRECT LIBRARY ANSWER BECAME A WRONG ONE
--
-- An adversarial review executed both against the surfaces #83 wired up.
--
-- 1. **A one-off answer outranked a deliberate per-company exception.**
--    `prepare.ts` consults the library (layer 1) before the policy rules
--    (layer 2), `public.answers` had no company column, and the review screen
--    wrote every typed gap answer globally. So:
--
--        rule   prior_employment = false, and = true at "stripe"
--        then   the person answers "Have you worked here before?" once, at Ramp
--        result "No" is submitted AT STRIPE, on a card marked ready
--
--    The reasoning in `prepare.ts` was that an exact question-key match is
--    "polarity-safe by construction". True, and not the whole claim:
--    polarity-safe is not COMPANY-safe, which is the entire reason
--    `answer_policies` has a `company_key` and this table did not.
--
--    So `answers.company_key` exists, and the engine resolves **most specific
--    scope first**: this company's answer, then this company's rule, then the
--    global answer, then the global rule. "An exception wins over the rule above
--    it" is what the settings page has always promised; it is now true of
--    everything above it, not only of the global rule.
--
-- 2. **Choosing "I don't wish to answer" poisoned the question forever.**
--    `matchOption` refuses a `decline_to_answer` option from every layer, which
--    is correct — the ENGINE must never decline on somebody's behalf. The review
--    screen then stored the option's LABEL as an ordinary answer, so the next
--    prepare found a stored value that no layer may select and gapped as
--    `option-mismatch`: *"The value we would submit is not one of the options
--    this board offers. Pick one of theirs."* It is one of theirs. They picked it.
--
--    So `answers.declined` exists. It records the CHOICE rather than the words,
--    which is what makes it replayable: a board wording its decline option
--    differently still gets that board's own option, and a board offering none
--    still gaps honestly. The engine's rule is untouched — nothing DERIVES a
--    decline from a fact; the flag can only arrive from a person picking it, and
--    `answers_declined_is_human_authored` refuses a machine-authored one at the
--    door the way `answers_self_id_is_human_authored` already does.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY NOT ROUTE A SCOPED ANSWER INTO `answer_policies` INSTEAD
--
-- The alternative considered, and the code-grounded reason it lost: a rule
-- stores a SITUATION, and the review screen has an ANSWER. Turning one into the
-- other means inverting the polarity the engine detected — the exact operation
-- 0014's header exists to describe as the bug ("a stored word replayed against a
-- question of the opposite polarity"), run backwards. It is also undefined for
-- every gap whose polarity was never established (`polarity-unknown`), which is
-- precisely where a person most needs to record an answer.
--
-- Scoping the LIBRARY keeps the property that makes layer 1 safe: the row holds
-- the literal thing a human picked, for one question, and nothing interprets it.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE IDENTITY CHANGE, AND WHY THE PRIMARY KEY HAD TO MOVE
--
-- 0001 declared `primary key (user_id, question)` — the RAW text. Two rows for
-- one question at two scopes need that key to include the scope, or the second
-- one cannot exist. So the PK becomes `(user_id, question, company_key)` and the
-- real identity — the one the matching layer is keyed on — becomes the unique
-- index `(user_id, question_key, company_key)`.
--
-- The PK stays on the RAW question rather than moving to the generated key: a
-- generated column in a primary key is legal and adds a dependency this table
-- does not need, and the unique index is already the constraint that decides
-- which rows are the same question.
--
-- No data migration is needed: every existing row is global (`company_key = ''`,
-- the default) and not a decline, which is exactly what those rows meant.

-- ============================================================ the columns

alter table public.answers
  -- '' is the answer for EVERY board; a key scopes it to one company. Same
  -- vocabulary as `answer_policies.company_key`, and the same CHECK, so a row
  -- written against 'Coinbase ' cannot exist and then silently never match.
  add column if not exists company_key text not null default '',
  -- The person chose the board's own "I don't wish to answer" option. Stored as
  -- a CHOICE and not as its words: `answer` still carries the label they saw, so
  -- the settings page can show what they picked, but the engine replays the
  -- flag — which is what makes it survive a board that words the option
  -- differently.
  add column if not exists declined boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'answers_company_is_a_key') then
    alter table public.answers add constraint answers_company_is_a_key
      check (company_key = public.company_name_key(company_key));
  end if;

  -- `answers_self_id_is_human_authored`'s sibling, and load-bearing in the same
  -- narrow way: `authored_by` is the trigger's stamp from `auth.uid()`, so this
  -- refuses a direct service-role INSERT claiming somebody declined. The ENGINE
  -- never derives a decline from anything (`matchOption` skips the option from
  -- every layer); this is the door's half of the same sentence.
  if not exists (select 1 from pg_constraint where conname = 'answers_declined_is_human_authored') then
    alter table public.answers add constraint answers_declined_is_human_authored
      check (declined = false or authored_by = 'user');
  end if;
end
$$;

-- ============================================================ the identity

do $$
begin
  -- Idempotent, because a migration that cannot be applied twice is one nobody
  -- dares re-run. The PK is looked up by its ROLE, not by the name 0001 gave it.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.answers'::regclass and contype = 'p'
       and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, question)'
  ) then
    alter table public.answers drop constraint answers_pkey;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.answers'::regclass and contype = 'p'
  ) then
    alter table public.answers add constraint answers_pkey
      primary key (user_id, question, company_key);
  end if;
end
$$;

-- The real identity of a library row, now scoped. The old index answered "one
-- row per question"; this one answers "one row per question per scope", which is
-- what the review screen needs in order to store a per-company answer at all.
drop index if exists public.answers_user_question_key_uk;
create unique index if not exists answers_user_question_scope_uk
  on public.answers (user_id, question_key, company_key);

-- ============================================================ result shape

/**
 * One answers row, as the app reads it — now carrying its scope and whether it
 * is a decline.
 *
 * `create or replace` keeps the same signature (the row type's NAME is
 * unchanged), so every caller of it keeps working; the two new keys arrive in
 * the same jsonb the write path and its replay both return. 0012's lesson,
 * still: two paths return this shape and a replay that answers a
 * differently-shaped object is the difference nothing catches until the UI
 * renders blanks.
 */
create or replace function public.app_answer_row(a public.answers)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'question',     a.question,
           'questionKey',  a.question_key,
           'companyKey',   a.company_key,
           'answer',       a.answer,
           'declined',     a.declined,
           'kind',         a.kind,
           'provenance',   a.provenance,
           'authoredBy',   a.authored_by,
           'confirmedAt',  a.confirmed_at,
           'updatedAt',    a.updated_at
         );
$$;

revoke all on function public.app_answer_row(public.answers) from public;

-- ============================================================ write: an answer

-- The signature grows two parameters, so this is a DROP and a create rather than
-- a replace: Postgres treats a different argument list as a different function,
-- and leaving the old one behind would leave a second door into the same table
-- that cannot write a scope. Dropped by its exact 0014 signature, so a rerun
-- after this file has landed finds nothing and carries on.
drop function if exists public.app_upsert_answer(text, text, text, text, text, timestamptz);

/**
 * Save one library answer, at a scope.
 *
 * `p_company` is a NAME and `company_key` is a KEY — normalized here, once, the
 * way `app_set_policy_rule` does it, so an answer saved from the review screen
 * and one saved from a script land on the same row. `''` is the global answer
 * and stays the default for every caller that does not care.
 *
 * `p_declined` records that the person picked the board's own "I don't wish to
 * answer" option. There is still no `p_authored_by` and there must never be one;
 * the decline flag is safe to accept precisely BECAUSE the trigger stamps
 * authorship independently and `answers_declined_is_human_authored` then refuses
 * the combination a machine could produce.
 */
create or replace function public.app_upsert_answer(
  p_question            text,
  p_answer              text,
  p_kind                text,
  p_provenance          text,
  p_idem                text,
  p_expected_updated_at timestamptz,
  p_company             text default '',
  p_declined            boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_key      text;
  v_row      public.answers;
  v_result   jsonb;
  v_inserted boolean := false;
  v_kind     text := coalesce(nullif(public.hq_blank_trim(p_kind), ''), 'freeform');
  v_prov     text := coalesce(nullif(public.hq_blank_trim(p_provenance), ''), 'user-entered');
  v_answer   text := coalesce(p_answer, '');
  v_question text := coalesce(p_question, '');
  v_company  text := public.company_name_key(coalesce(p_company, ''));
  v_declined boolean := coalesce(p_declined, false);
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if length(v_question) > 2000 then
    raise exception 'question too long: % characters', length(v_question)
      using errcode = '22023';
  end if;
  if length(v_answer) > 8000 then
    raise exception 'answer too long: % characters', length(v_answer)
      using errcode = '22023';
  end if;
  if length(v_company) > 200 then
    raise exception 'company too long: % characters', length(v_company)
      using errcode = '22023';
  end if;

  if public.hq_blank_trim(v_answer) = '' then
    raise exception 'answer must not be blank' using errcode = '22023';
  end if;

  v_key := public.hq_question_key(v_question);
  if v_key = '' then
    raise exception 'question must contain letters or digits' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  insert into public.answers
    (user_id, question, company_key, answer, declined, kind, provenance, confirmed_at)
  values (v_user, v_question, v_company, v_answer, v_declined, v_kind, v_prov,
          case when v_prov = 'confirmed' then now() else null end)
  on conflict (user_id, question_key, company_key) do nothing;
  v_inserted := found;

  select * into v_row
    from public.answers
   where user_id = v_user and question_key = v_key and company_key = v_company
     for update;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  if not v_inserted
     and p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this answer changed since you read it'
      using errcode = '40001';
  end if;

  if not v_inserted then
    update public.answers
       set question    = v_question,
           answer      = v_answer,
           declined    = v_declined,
           kind        = v_kind,
           provenance  = v_prov,
           confirmed_at = case when v_prov = 'confirmed' then now() else confirmed_at end
     where user_id = v_user and question_key = v_key and company_key = v_company
    returning * into v_row;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.answer_saved',
          jsonb_build_object('questionKey', v_key,
                             'companyKey',  v_company,
                             'kind',        v_kind,
                             'declined',    v_declined,
                             'provenance',  v_prov,
                             'authoredBy',  v_row.authored_by,
                             'created',     v_inserted),
          case when v_row.authored_by = 'user' then 'user' else 'system' end);

  v_result := jsonb_build_object('answer', public.app_answer_row(v_row),
                                 'created', v_inserted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_upsert_answer', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.app_upsert_answer(
  text, text, text, text, text, timestamptz, text, boolean)
  from public, anon, authenticated;
grant execute on function public.app_upsert_answer(
  text, text, text, text, text, timestamptz, text, boolean)
  to authenticated;

-- ============================================================ write: delete

/**
 * Remove one library answer.
 *
 * 0014 shipped without this and the settings page said so on screen: "an answer
 * can be overwritten and not deleted". That is a real cost once a decline is
 * storable — the only exit from a recorded "I don't wish to answer" was to
 * overwrite it with an answer the person had chosen not to give.
 *
 * Idempotent by RESULT, not by effect, exactly as `app_delete_policy_rule` is:
 * deleting an answer that is already gone answers `{"deleted": false}`, and the
 * replay of a real delete answers `{"deleted": true}` forever after, because
 * somebody who taps twice on a flaky connection must not be told the second tap
 * did nothing when the first one did.
 */
create or replace function public.app_delete_answer(
  p_question text,
  p_company  text,
  p_idem     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_company text := public.company_name_key(coalesce(p_company, ''));
  v_key     text := public.hq_question_key(coalesce(p_question, ''));
  v_result  jsonb;
  v_deleted boolean := false;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if v_key = '' then
    raise exception 'question must contain letters or digits' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Lock the row (if any) before re-checking the key, so two tabs replaying one
  -- outbox serialise here rather than both deciding they are the first.
  perform 1 from public.answers
    where user_id = v_user and question_key = v_key and company_key = v_company
      for update;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  delete from public.answers
   where user_id = v_user and question_key = v_key and company_key = v_company;
  v_deleted := found;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.answer_deleted',
          jsonb_build_object('questionKey', v_key, 'companyKey', v_company,
                             'deleted', v_deleted),
          'user');

  v_result := jsonb_build_object('deleted', v_deleted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_delete_answer', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.app_delete_answer(text, text, text)
  from public, anon, authenticated;
grant execute on function public.app_delete_answer(text, text, text)
  to authenticated;
