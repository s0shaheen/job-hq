-- 0014 — the answer library and its policy rules: the substrate the auto-apply
-- prepare engine reads, and the only place a knockout answer may come from.
--
-- NUMBERING. This file is 0014 and there is no 0013 on this branch: **0013 is
-- claimed by the parallel referral-finder branch**, which was cut from the same
-- commit. `tests/core/test_migrations.py` normally refuses a gap in the sequence
-- (a gap means somebody's migration never got committed), so the reservation is
-- DECLARED there in `RESERVED_MIGRATION_NUMBERS` and asserted in both
-- directions: an undeclared gap still fails, and the day 0013 lands the
-- reservation goes red until its line is deleted. A silent hole is the bug; a
-- stated one is a decision.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS, AND WHAT AN EARLIER DRAFT OF THIS HEADER GOT WRONG
--
-- `docs/plans/AUTO-APPLY.md` sets one metric as absolute: **wrong knockout
-- answers must be zero, ever.** Every famous auto-apply failure in the grounding
-- research is a tool guessing a work-authorization, sponsorship, compensation or
-- self-identification field.
--
-- The first version of this file claimed four "Postgres refusals" that a
-- machine could not get past. An adversarial review executed all four and got
-- past three of them, because each was keyed on **a string the caller supplied**
-- — `provenance = 'suggested'` and `kind = 'eeo'`. A writer that labels itself
-- `'confirmed'`, or writes an EEO answer as `kind = 'freeform'`, walked through
-- every one of them and onto a green card. A refusal keyed on the honesty of the
-- thing being refused is not a refusal.
--
-- So authorship is now taken from **the server's own view of the session** and
-- never from the payload:
--
--   `authored_by` is stamped by a BEFORE trigger on every insert and every
--   update, on both tables, as `'user'` when `auth.uid()` is present and
--   `'service'` otherwise. There is no parameter for it, no way to send one, and
--   an UPDATE that tries carries the stamp anyway. Every security decision in
--   this file keys on that column.
--
--   `provenance` survives as what it always honestly was: the caller's CLAIM
--   about how an answer was produced (typed, confirmed, suggested). It drives
--   the review surface's "needs a look" state and nothing that guards a
--   knockout. It is advisory, and this file no longer pretends otherwise.
--
-- What Postgres now actually refuses, in the order it matters:
--
--   1. `answer_policies_knockouts_are_human_authored` — a rule on a knockout
--      topic whose `authored_by` is not `'user'`. Because the stamp is applied
--      by the trigger and not by the caller, this holds against a direct
--      service-role INSERT, not merely against a well-behaved RPC caller.
--   2. `hq_authorship_guard` — a `'service'` write may not land on a row a
--      `'user'` authored, and a `'suggested'` provenance may not land on a
--      `'user-entered'` or `'confirmed'` one. The first half is load-bearing;
--      the second is advisory (it guards a field the caller controls).
--   3. `answer_policies_fact_is_wellformed` — a rule stores a typed FACT ABOUT
--      THE PERSON, never a literal answer. See below; this is the change the
--      review's severest finding forced.
--   4. `answers_question_key_shape` — an ANCHORED regexp, so a broken normalizer
--      cannot leak an empty or space-padded key into the column the whole
--      matching layer is keyed on.
--
-- And what is NOT enforced here, stated because the earlier draft implied it was:
--
--   * **Nothing on this table knows that an answer is a self-identification
--     answer.** `kind = 'eeo'` is a caller-supplied label; the CHECK on it is
--     real for rows that declare it and is trivially avoided by rows that do
--     not. The self-ID guard that matters is engine-side
--     (`webapp/lib/apply/prepare.ts`): staging onto a demographic field requires
--     `authored_by = 'user'` AND an exact question-key match, and no layer may
--     ever stage an option marked `decline_to_answer`.
--   * **Nothing here validates a fact against its topic.** SQL checks the fact's
--     SHAPE; the engine checks that the shape is the one this topic needs, and
--     gaps when it is not. Duplicating the per-topic table in PL/pgSQL would be a
--     third copy of a mapping that already lives in two places.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY A RULE STORES A SITUATION AND NOT AN ANSWER
--
-- The review's severest finding, executed against the first draft: a correct
-- rule, a real phrasing, and a wrong knockout answer on a green card.
--
--     rule visa_sponsorship = "No"
--     question "Are you able to work in the US WITHOUT sponsorship?"
--     staged   "No"          -- i.e. "I need sponsorship". The opposite.
--
--     rule criminal_history = "No"
--     question "Are you willing to submit to a BACKGROUND CHECK?"
--     staged   "No"          -- i.e. "I refuse a background check".
--
-- One topic covers questions of opposite polarity, and it covers questions about
-- different facts. Storing the literal word the user picked once and replaying it
-- against every question that classifies to the topic is a guess wearing a
-- rule's clothes.
--
-- So `answer_policies.fact` holds the user's SITUATION as a typed value —
-- `needs_sponsorship: false`, `authorized_in: ["united states"]`,
-- `felony_disclosure: "none"`, `min_comp: 180000` — and the engine DERIVES each
-- staged answer from the situation and the question's detected polarity. When
-- either the topic or the polarity is not certain, it gaps. "When in doubt,
-- gap" is the rule, and it is stated in `webapp/lib/apply/policy.ts` beside the
-- code that implements it.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT HERE
--
-- No staged-application table, no receipts, no submit lane. Those belong to
-- steps 2–3 of the plan's build shape; this file is step 1's storage only. The
-- prepare engine is PURE — it takes the rows these tables hold and returns a
-- staged application, and nothing in it writes.
--
-- ════════════════════════════════════════════════════════════════════════════
-- MATCHING (the seam that decides whether an answer is reused or asked twice)
--
-- Question labels vary between boards for the same question — Anthropic asks for
-- sponsorship twice on one form, in two different sentences. Reuse therefore
-- keys on a NORMALIZED form of the label, `hq_question_key`, mirrored in
-- TypeScript (`webapp/lib/apply/normalize.ts`) with
-- `tests/fixtures/question-keys.golden.json` asserted from BOTH languages — the
-- `job_key` / `gate-corpus` pattern, for the same reason: a port without a
-- cross-language golden test WILL drift, silently.
--
-- The normalizer errs in ONE direction on purpose: **it may fail to merge two
-- spellings of one question; it may never merge two different questions.**
-- Under-normalizing costs a duplicate library row, which a person sees and
-- fixes. Over-normalizing answers question A with question B's answer.

-- ============================================================ the normalizer

/**
 * The identity of a question, for reuse across boards.
 *
 * Lowercase; every character that is not `[a-z0-9]` becomes a space; ends trim.
 * So "Are you legally authorized to work?" and "ARE YOU LEGALLY AUTHORIZED TO
 * WORK" are one key, and the punctuation, casing, non-breaking hyphens
 * (Coinbase really does ship a U+2011 in "decision‑maker") and smart quotes that
 * vary board to board fall out.
 *
 * REPLACED WITH A SPACE, NOT DELETED. "e-mail" becomes "e mail", not "email", so
 * two hyphenation styles of one word do NOT converge. A missed merge is a
 * duplicate row; a false merge is a wrong answer.
 *
 * NO RUN-COLLAPSE PASS. An earlier version had `regexp_replace(x,' +',' ','g')`
 * after this one and the mirror had `.replace(/ +/g," ")`. Both were DEAD:
 * `[^a-z0-9]+` is greedy over the whole run, so `'a  -  b'` already emits
 * `'a b'` and two adjacent spaces are unreachable. The review proved it in both
 * languages. Dead code with a comment claiming it catches something is worse
 * than no code, so it is gone — and the anchored CHECK below now states which of
 * its clauses is falsifiable and which is defence against a FUTURE normalizer.
 *
 * NON-ASCII LETTERS BECOME SPACES, and there is one CROSS-LANGUAGE DIVERGENCE
 * inside that limit, found by a full-BMP sweep: Postgres lowercases U+0130
 * (İ) to `i`, while JavaScript's `toLowerCase` folds it to `i` + U+0307
 * (combining dot), and the combining mark then becomes a space. So `"İstanbul"`
 * keys as `istanbul` here and `i stanbul` in the browser. Every SINGLE-codepoint
 * case agrees; only this multi-character expansion diverges. Consequence, stated
 * rather than discovered later: for a label with a Turkish dotted capital I the
 * browser would miss an existing row, write "again", and the generated column
 * would merge it onto the old row — a silent overwrite. English boards are the
 * stated scope (`docs/research/ats-apply-mechanics.md` covers no other), and the
 * golden fixture carries the case so the divergence is recorded rather than
 * implied.
 *
 * `immutable` is not decoration: `answers.question_key` is a stored generated
 * column and Postgres accepts only an immutable expression there.
 */
create or replace function public.hq_question_key(p_label text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select btrim(regexp_replace(lower(coalesce(p_label, '')), '[^a-z0-9]+', ' ', 'g'))
$$;

comment on function public.hq_question_key(text) is
  'normalized identity of an application question — mirrored by webapp/lib/apply/normalize.ts, pinned by tests/fixtures/question-keys.golden.json';

-- ================================================== authorship, server-derived

/**
 * Stamp `authored_by` from the session, then apply the ratchets.
 *
 * ONE trigger function doing both, on purpose. Two triggers would fire in NAME
 * order for the same timing, and `answers_provenance_ratchet` sorts before
 * `answers_stamp_authored_by` — so the ratchet would have compared a column the
 * stamp had not written yet. A silent ordering dependency in the least
 * inspectable place in the schema; better to have no ordering at all.
 *
 * The stamp is UNCONDITIONAL. There is no "if the caller did not supply one"
 * branch, because that branch is the whole vulnerability: 0010's `status_actor`
 * lesson is that an UPDATE which does not mention a column carries the old value
 * into `new`, so any conditional stamp lets a value the caller once chose live
 * forever. Overwriting every time means the column can only ever say what the
 * server saw.
 *
 * `auth.uid()` is the signal because it is the one thing a caller cannot forge:
 * on Supabase it reads the verified JWT's `sub`, and a service-role key has
 * none. A security-definer function runs with the definer's RIGHTS but the
 * caller's SESSION, so an RPC invoked by a signed-in person stamps `'user'` and
 * the same RPC invoked by the engine stamps `'service'`.
 */
create or replace function public.hq_authorship_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.authored_by := case when auth.uid() is not null then 'user' else 'service' end;

  if tg_op = 'UPDATE' then
    -- LOAD-BEARING. The engine's knockout and self-identification gates read
    -- `authored_by`, so a service lane overwriting a human row is the one way
    -- those gates could be handed a machine answer wearing a human stamp.
    if old.authored_by = 'user' and new.authored_by <> 'user' then
      raise exception 'a service write may not overwrite an answer the user authored'
        using errcode = '42501';
    end if;

    -- ADVISORY, and labelled so nobody builds on it again. `provenance` is a
    -- caller-supplied string; this refuses the honest downgrade and cannot
    -- refuse a dishonest one. It is kept because the review surface reads the
    -- column and a real UI does make this mistake.
    if old.provenance in ('user-entered','confirmed') and new.provenance = 'suggested' then
      raise exception 'a suggested answer may not overwrite one the user entered'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ============================================================ the library

-- `public.answers` already exists (0001, commented "own-Simplify substrate")
-- with `(user_id, question, answer, kind, updated_at)`.

alter table public.answers
  -- The matching key. GENERATED rather than written by the caller: a key the
  -- client computes is a key the client can compute wrongly, and the whole point
  -- of the column is that two spellings of one question land on one row.
  add column if not exists question_key text
    generated always as (public.hq_question_key(question)) stored,
  -- The caller's CLAIM about how this answer was produced. Advisory — see the
  -- header. Drives the review surface's needs-a-look state, guards nothing.
  add column if not exists provenance text not null default 'user-entered',
  -- The SERVER's view. Never accepted from a caller; stamped by the trigger
  -- below on every write. Every gate in the engine keys on this.
  add column if not exists authored_by text not null default 'service',
  add column if not exists confirmed_at timestamptz;

do $$
begin
  -- The closed set 0001 wrote as a COMMENT. A comment is not a constraint (the
  -- lesson 0002 opens with). `eeo` is new here — 0001's list predates the
  -- self-identification rule. It remains ADVISORY metadata: see the header.
  if not exists (select 1 from pg_constraint where conname = 'answers_kind_is_known') then
    alter table public.answers add constraint answers_kind_is_known
      check (kind in ('identity','location','address','auth','comp','skills','eeo','freeform'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'answers_provenance_is_known') then
    alter table public.answers add constraint answers_provenance_is_known
      check (provenance in ('user-entered','confirmed','suggested'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'answers_authored_by_is_known') then
    alter table public.answers add constraint answers_authored_by_is_known
      check (authored_by in ('user','service'));
  end if;

  -- Real for rows that DECLARE `kind='eeo'`, and trivially avoided by rows that
  -- do not — which is why the engine does not trust it. Kept because a row that
  -- says it is a demographic answer and was written by a machine is a bug worth
  -- refusing at the door, and because deleting it would read as "self-ID is
  -- unguarded" when the guard simply moved to where it can work.
  if not exists (select 1 from pg_constraint where conname = 'answers_self_id_is_human_authored') then
    alter table public.answers add constraint answers_self_id_is_human_authored
      check (kind <> 'eeo' or authored_by = 'user');
  end if;

  -- `hq_blank_trim`, not `btrim` and not `length(…) = 0`. Bare btrim trims
  -- SPACES ONLY, so an answer of one newline reads as content everywhere it is
  -- compared — 0010 shipped exactly that bug into an append-only table (matrix
  -- row 110).
  if not exists (select 1 from pg_constraint where conname = 'answers_answer_is_not_blank') then
    alter table public.answers add constraint answers_answer_is_not_blank
      check (public.hq_blank_trim(answer) <> '');
  end if;

  -- ANCHORED. Which clauses are falsifiable, stated honestly after the review
  -- showed the old comment overclaimed:
  --   `^…$` + `[a-z0-9]+`  refuse the EMPTY key — reachable today, from a label
  --                        of pure punctuation, and tested through the column
  --   `( [a-z0-9]+)*`      refuse leading/trailing/doubled spaces. A normalizer
  --                        that loses its TRIM makes this reachable (tested by
  --                        swapping in such a normalizer inside a transaction);
  --                        the DOUBLED-space half is unreachable while
  --                        `hq_question_key` uses a greedy class, and is kept as
  --                        defence against a future one, not as a live guard.
  if not exists (select 1 from pg_constraint where conname = 'answers_question_key_shape') then
    alter table public.answers add constraint answers_question_key_shape
      check (question_key ~ '^[a-z0-9]+( [a-z0-9]+)*$');
  end if;
end
$$;

-- The real identity of a library row. `(user_id, question)` stays the primary
-- key (it is what 0001 declared), but it is the RAW text — so "Are you 18?" and
-- "Are you 18 ?" would be two rows answering one question.
create unique index if not exists answers_user_question_key_uk
  on public.answers (user_id, question_key);

drop trigger if exists answers_provenance_ratchet on public.answers;
drop trigger if exists answers_authorship_guard on public.answers;
create trigger answers_authorship_guard before insert or update on public.answers
  for each row execute function public.hq_authorship_guard();

-- ============================================================ the policy rules

/**
 * Layer 2 of the answer engine: the user's SITUATION, as declarative typed facts
 * a human owns and can read back.
 *
 * Shape decisions, each with the alternative it beat:
 *
 * - **`fact`, not `answer`.** The header explains at length; the short version
 *   is that one topic covers questions of opposite polarity, and replaying a
 *   stored word against all of them submits its opposite half the time. A fact
 *   plus a detected polarity is derivable; a stored answer is not.
 *
 * - **Keyed on `(user_id, topic, company_key)`**, so "one rule per topic,
 *   optionally overridden per company" is a property of the table rather than of
 *   the code that reads it.
 *
 * - **`company_key` holds a KEY, never a name.** `answer_policies_company_is_a_key`
 *   requires `company_key = company_name_key(company_key)`, so a rule written
 *   against `'Coinbase '` cannot exist and then silently never match. Same
 *   lesson as 0009's ghost rows (matrix row 93), one table over.
 *
 * - **`enabled`, not delete.** Turning a rule off is the gesture a person
 *   actually wants when a form starts asking something differently; deleting is
 *   available too (`app_delete_policy_rule`), it just is not the only exit. A
 *   DISABLED company override falls back to the global rule — that is engine
 *   behaviour, asserted in `apply-prepare.test.ts`, and it is what "turning a
 *   rule off" has to mean for the sentence above to be true.
 *
 * `topic` is a CLOSED SET and it is the authority: `webapp/lib/apply/policy.ts`
 * declares the same list and `webapp/tests/unit/apply-policy-parity.test.ts`
 * parses THIS FILE to compare them, the way `status.test.ts` parses
 * `core/schema.py`.
 */
create table if not exists public.answer_policies (
  user_id     uuid not null references public.users (id) on delete cascade,
  topic       text not null,
  -- '' is the GLOBAL rule; a per-company row wins over it. Resolution lives in
  -- the engine because it is a read, and reads belong where they can be tested.
  company_key text not null default '',
  -- `{"kind": …, "value": …}` — the user's situation, typed. Shape checked here,
  -- topic-appropriateness checked by the engine (which gaps on a mismatch).
  fact        jsonb not null,
  provenance  text not null default 'user-entered',
  authored_by text not null default 'service',
  note        text not null default '',
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  primary key (user_id, topic, company_key)
);

do $$
begin
  -- The first seven are the KNOCKOUT topics: a wrong answer ends the
  -- application. `background_check_consent` was split out of `criminal_history`
  -- by the review — "have you been convicted?" and "will you consent to a
  -- background check?" are opposite-signed questions about different facts, and
  -- one topic answering both is how "No" became "I refuse a background check".
  if not exists (select 1 from pg_constraint where conname = 'answer_policies_topic_is_known') then
    alter table public.answer_policies add constraint answer_policies_topic_is_known
      check (topic in (
        -- knockout topics: a wrong answer here ends the application
        'work_authorization',
        'visa_sponsorship',
        'compensation',
        'criminal_history',
        'background_check_consent',
        'legal_name',
        'age_eligibility',
        -- ordinary policy topics
        'relocation',
        'current_location',
        'start_date',
        'prior_employment',
        'prior_interview',
        'relative_at_company',
        'employee_referral',
        'onsite_commitment',
        'how_did_you_hear'
      ));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'answer_policies_provenance_is_known') then
    alter table public.answer_policies add constraint answer_policies_provenance_is_known
      check (provenance in ('user-entered','confirmed','suggested'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'answer_policies_authored_by_is_known') then
    alter table public.answer_policies add constraint answer_policies_authored_by_is_known
      check (authored_by in ('user','service'));
  end if;

  -- THE constraint, and this time it is one. `authored_by` is stamped by the
  -- trigger from `auth.uid()`, so this refuses a direct service-role INSERT and
  -- not merely a caller that admits what it is.
  if not exists (select 1 from pg_constraint where conname = 'answer_policies_knockouts_are_human_authored') then
    alter table public.answer_policies add constraint answer_policies_knockouts_are_human_authored
      check (
        authored_by = 'user'
        or topic not in ('work_authorization','visa_sponsorship','compensation',
                         'criminal_history','background_check_consent','legal_name',
                         'age_eligibility')
      );
  end if;

  -- The fact's SHAPE. Not its topic-appropriateness — that is the engine's, and
  -- a third copy of the per-topic mapping in PL/pgSQL would need its own guard
  -- while failing silently (0011's `job_key` call, made again).
  --
  -- Every kind's emptiness is checked in its own terms, because "empty" differs:
  -- an empty array, a blank string and a missing key are three different ways for
  -- a rule to look configured on a settings screen and resolve to nothing.
  if not exists (select 1 from pg_constraint where conname = 'answer_policies_fact_is_wellformed') then
    alter table public.answer_policies add constraint answer_policies_fact_is_wellformed
      check (
        jsonb_typeof(fact) = 'object'
        and fact ? 'kind'
        and fact ? 'value'
        and case fact ->> 'kind'
              when 'boolean'   then jsonb_typeof(fact -> 'value') = 'boolean'
              when 'countries' then jsonb_typeof(fact -> 'value') = 'array'
                                    and jsonb_array_length(fact -> 'value') > 0
              when 'money'     then jsonb_typeof(fact -> 'value') = 'number'
                                    and (fact -> 'value')::numeric >= 0
              when 'date'      then fact ->> 'value' ~ '^\d{4}-\d{2}-\d{2}$'
              when 'directive' then fact ->> 'value' ~ '^[a-z][a-z0-9-]*(:[a-z0-9-]+)*$'
              when 'enum'      then fact ->> 'value' ~ '^[a-z][a-z0-9_-]*$'
              when 'text'      then public.hq_blank_trim(fact ->> 'value') <> ''
              else false
            end
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'answer_policies_company_is_a_key') then
    alter table public.answer_policies add constraint answer_policies_company_is_a_key
      check (company_key = public.company_name_key(company_key));
  end if;
end
$$;

-- Matrix row 96: `user_companies` was the one versioned table without this, and
-- the column looked fine because the RPCs set it themselves — until a backfill
-- moved the row and left the token behind.
drop trigger if exists answer_policies_touch on public.answer_policies;
create trigger answer_policies_touch before update on public.answer_policies
  for each row execute function public.touch_updated_at();

drop trigger if exists answer_policies_provenance_ratchet on public.answer_policies;
drop trigger if exists answer_policies_authorship_guard on public.answer_policies;
create trigger answer_policies_authorship_guard before insert or update on public.answer_policies
  for each row execute function public.hq_authorship_guard();

-- ============================================================ RLS

alter table public.answer_policies enable row level security;

-- Read-only, scoped to the owner. No insert/update/delete policy, here or ever:
-- the browser writes through the functions below or not at all (0001's closing
-- note). The prepare engine READS both tables through PostgREST, which is why
-- the select policies are load-bearing and why `tests/db/test_apply.py` asserts
-- both directions under `set role authenticated`.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'answer_policies' and policyname = 'answer_policies_self_read') then
    create policy answer_policies_self_read on public.answer_policies
      for select using (user_id = auth.uid());
  end if;
end
$$;

-- ============================================================ result shapes

/**
 * One answers row, as the app reads it.
 *
 * Extracted for `app_profile_row`'s reason (0012): two paths return it — a write
 * and a REPLAY of one — and a replay that answers a differently-shaped object
 * than the original is the difference nothing catches until the UI renders
 * blanks.
 *
 * Deliberately NOT security definer: it is only ever called from inside
 * functions that already run as the definer. Marking it definer would hand a
 * standalone caller a read of anybody's answers.
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
           'answer',       a.answer,
           'kind',         a.kind,
           'provenance',   a.provenance,
           'authoredBy',   a.authored_by,
           'confirmedAt',  a.confirmed_at,
           'updatedAt',    a.updated_at
         );
$$;

revoke all on function public.app_answer_row(public.answers) from public;

/** One answer_policies row, as the app reads it. Same reasoning as above. */
create or replace function public.app_policy_row(p public.answer_policies)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'topic',       p.topic,
           'companyKey',  p.company_key,
           'fact',        p.fact,
           'provenance',  p.provenance,
           'authoredBy',  p.authored_by,
           'note',        p.note,
           'enabled',     p.enabled,
           'updatedAt',   p.updated_at
         );
$$;

revoke all on function public.app_policy_row(public.answer_policies) from public;

-- ============================================================ write: an answer

/**
 * Save one library answer — the gesture behind AUTO-APPLY.md's growth loop
 * ("every novel question answered once becomes a constant").
 *
 * Joins the family `0003_write_path.sql` established: `command_idempotency`
 * storing the RESULT, a post-lock replay re-check, `expected_updated_at`, and
 * the row and its event in one body.
 *
 * There is no `p_authored_by`. That is the point of the whole redesign: the
 * trigger stamps it, this function cannot influence it, and a future parameter
 * added here would reopen exactly what the review walked through.
 */
create or replace function public.app_upsert_answer(
  p_question            text,
  p_answer              text,
  p_kind                text,
  p_provenance          text,
  p_idem                text,
  p_expected_updated_at timestamptz
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
begin
  -- `authenticated` is the only role granted execute, so this is unreachable
  -- today — which is why it is here. The day a service-role lane or a new grant
  -- appears, this is the line that refuses to write a row with a null user_id.
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- The BLANK key matters as much as the missing one: `command_idempotency`'s
  -- primary key is (user_id, idem_key) and '' is a legal text value, so one
  -- caller sending an empty key would have every later empty key replay the
  -- first gesture forever. `hq_blank_trim`, not `length(…) = 0` — a key of one
  -- newline is blank to a person and length 1 to Postgres.
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Bounds on a public endpoint: anyone with a session can post straight to
  -- /rest/v1/rpc, so the server action's caps are one caller's, not the door's.
  if length(v_question) > 2000 then
    raise exception 'question too long: % characters', length(v_question)
      using errcode = '22023';
  end if;
  if length(v_answer) > 8000 then
    raise exception 'answer too long: % characters', length(v_answer)
      using errcode = '22023';
  end if;

  if public.hq_blank_trim(v_answer) = '' then
    raise exception 'answer must not be blank' using errcode = '22023';
  end if;

  -- Caught HERE as well as by `answers_question_key_shape`, because the
  -- constraint's message names a column a person never typed.
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

  insert into public.answers (user_id, question, answer, kind, provenance, confirmed_at)
  values (v_user, v_question, v_answer, v_kind, v_prov,
          case when v_prov = 'confirmed' then now() else null end)
  on conflict (user_id, question_key) do nothing;
  v_inserted := found;

  select * into v_row
    from public.answers
   where user_id = v_user and question_key = v_key
     for update;

  -- Re-check the key with the row LOCKED. The check above only settles
  -- sequential replays; two tabs flushing one outbox on the same 'online' event
  -- both pass it before either writes, and the loser would otherwise apply a
  -- second time or raise a phantom conflict.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Optimistic concurrency, checked INSIDE the transaction that writes, and
  -- comparing INSTANTS: the parameter is DECLARED timestamptz, which is what
  -- protects this (matrix rows 146, 168 are both "one moment, three strings").
  -- The word "conflict" is load-bearing — supabase-source.ts matches on it.
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
           kind        = v_kind,
           provenance  = v_prov,
           -- Confirmation is a moment, not a flag a later edit inherits.
           confirmed_at = case when v_prov = 'confirmed' then now() else confirmed_at end
     where user_id = v_user and question_key = v_key
    returning * into v_row;
  end if;

  -- The row and its audit event in one body, or the trail has holes in it.
  -- `actor` comes from the STAMPED column, not from the claimed provenance: an
  -- earlier version derived it from the caller's string, so a machine writing
  -- `provenance='confirmed'` signed the audit trail as a human.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.answer_saved',
          jsonb_build_object('questionKey', v_key,
                             'kind',        v_kind,
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

-- Named revokes, not `from public` alone. Supabase's bootstrap grants execute on
-- new functions to `anon` and `authenticated` BY NAME, and revoking from
-- `public` does not touch a grant made to a named role — the debt
-- `KNOWN_UNNAMED_REVOKES` records for 21 older functions. Nothing added here
-- joins that list, and `test_definer_functions_are_granted_only_to_authenticated`
-- now checks the GRANT direction too, which the revoke check alone could not.
revoke all on function public.app_upsert_answer(text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_upsert_answer(text, text, text, text, text, timestamptz)
  to authenticated;

-- ============================================================ write: a rule

/**
 * Save one policy rule — a typed fact about the person, never an answer.
 *
 * `p_company` is a NAME and `company_key` is a KEY: the normalization happens
 * here, once, so a rule written from the settings screen and a rule written from
 * a script land on the same row. The check constraint is what makes that true
 * rather than customary.
 */
create or replace function public.app_set_policy_rule(
  p_topic               text,
  p_company             text,
  p_fact                jsonb,
  p_provenance          text,
  p_note                text,
  p_enabled             boolean,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_company  text := public.company_name_key(coalesce(p_company, ''));
  v_topic    text := public.hq_blank_trim(coalesce(p_topic, ''));
  v_prov     text := coalesce(nullif(public.hq_blank_trim(p_provenance), ''), 'user-entered');
  v_note     text := coalesce(p_note, '');
  v_enabled  boolean := coalesce(p_enabled, true);
  v_row      public.answer_policies;
  v_result   jsonb;
  v_inserted boolean := false;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if p_fact is null or jsonb_typeof(p_fact) <> 'object' then
    raise exception 'fact must be an object' using errcode = '22023';
  end if;

  -- Bounded, because this is stored VERBATIM and granted to `authenticated`.
  -- A country list is a handful of short strings; 8 kB is generous and finite.
  if pg_column_size(p_fact) > 8192 then
    raise exception 'fact too large: % bytes', pg_column_size(p_fact)
      using errcode = '22023';
  end if;

  if length(v_note) > 2000 then
    raise exception 'note too long: % characters', length(v_note)
      using errcode = '22023';
  end if;
  if length(v_company) > 200 then
    raise exception 'company too long: % characters', length(v_company)
      using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  insert into public.answer_policies
    (user_id, topic, company_key, fact, provenance, note, enabled)
  values
    (v_user, v_topic, v_company, p_fact, v_prov, v_note, v_enabled)
  on conflict (user_id, topic, company_key) do nothing;
  v_inserted := found;

  select * into v_row
    from public.answer_policies
   where user_id = v_user and topic = v_topic and company_key = v_company
     for update;

  -- The post-lock re-check. Two tabs flushing one outbox on the same 'online'
  -- event both pass the check above before either writes.
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  if not v_inserted
     and p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this rule changed since you read it'
      using errcode = '40001';
  end if;

  if not v_inserted then
    update public.answer_policies
       set fact       = p_fact,
           provenance = v_prov,
           note       = v_note,
           enabled    = v_enabled
     where user_id = v_user and topic = v_topic and company_key = v_company
    returning * into v_row;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.policy_saved',
          jsonb_build_object('topic',      v_topic,
                             'companyKey', v_company,
                             'factKind',   p_fact ->> 'kind',
                             'provenance', v_prov,
                             'authoredBy', v_row.authored_by,
                             'enabled',    v_enabled,
                             'created',    v_inserted),
          case when v_row.authored_by = 'user' then 'user' else 'system' end);

  v_result := jsonb_build_object('rule', public.app_policy_row(v_row),
                                 'created', v_inserted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_set_policy_rule', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.app_set_policy_rule(
  text, text, jsonb, text, text, boolean, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_set_policy_rule(
  text, text, jsonb, text, text, boolean, text, timestamptz)
  to authenticated;

-- ============================================================ write: delete

/**
 * Remove one policy rule.
 *
 * Idempotent by RESULT, not by effect: deleting a rule that is already gone
 * answers `{"deleted": false}` and the replay of a real delete answers
 * `{"deleted": true}` forever after — because a person who taps twice on a flaky
 * connection must not be told the second tap did nothing when the first one did.
 */
create or replace function public.app_delete_policy_rule(
  p_topic   text,
  p_company text,
  p_idem    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_company text := public.company_name_key(coalesce(p_company, ''));
  v_topic   text := public.hq_blank_trim(coalesce(p_topic, ''));
  v_result  jsonb;
  v_deleted boolean := false;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  -- Lock the row (if any) before re-checking the key, so two tabs replaying one
  -- outbox serialise here rather than both deciding they are the first.
  perform 1 from public.answer_policies
    where user_id = v_user and topic = v_topic and company_key = v_company
      for update;

  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;

  delete from public.answer_policies
   where user_id = v_user and topic = v_topic and company_key = v_company;
  v_deleted := found;

  -- An event even when nothing was deleted. "Somebody asked to remove a rule
  -- that was not there" is a real thing to be able to read afterwards.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'apply.policy_deleted',
          jsonb_build_object('topic', v_topic, 'companyKey', v_company, 'deleted', v_deleted),
          'user');

  v_result := jsonb_build_object('deleted', v_deleted);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_delete_policy_rule', v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.app_delete_policy_rule(text, text, text)
  from public, anon, authenticated;
grant execute on function public.app_delete_policy_rule(text, text, text)
  to authenticated;
