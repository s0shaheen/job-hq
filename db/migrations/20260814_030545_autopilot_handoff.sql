-- 20260814_030545_autopilot_handoff.sql
--
-- The manual-handoff terminus for Autopilot Prepare/Review (#206, T3 half).
--
-- WHAT THIS CHANGES and WHY. Migrations are append-only: this file will run
-- exactly once against production and can never be edited afterwards.
--
-- `20260802_094615_autopilot_staging.sql` shipped the staging store with eleven
-- states and no way to finish the pilot's only lifecycle: a human approves an
-- exact package, submits it THEMSELVES on the provider's own form, and reports
-- back. `submitted` is unreachable by construction (the state machine requires
-- an `autopilot_receipts` row, and receipts belong to the executor, #207);
-- `outcome_unknown` is only reachable from `submitting`, the engine's
-- side-effect state; `cancelled` would misdescribe a submission that happened.
-- The vocabulary was missing a word, so this file adds one:
--
--   handed_off   an authorised package the USER reports as submitted, with no
--                provider evidence and no claim of any. Terminal, and
--                slot-occupying: it stays inside
--                `autopilot_stages_one_live_attempt`'s predicate, because "the
--                user says the employer has this" must hold the application's
--                slot exactly as firmly as a receipt-backed `submitted` does.
--
-- THE EVIDENCE FOR `handed_off` IS THE USER'S WORD AND NOTHING ELSE. It is
-- recorded as MANUAL application status through `app_set_status` (0010 — the
-- human-status lock, the audit event, the reopen-needs-a-note rule) plus an
-- `events` row. Never an `autopilot_receipts` row: this migration writes no
-- receipt under any input, grants no new receipt privilege, and the state
-- machine refuses `handed_off` on top of one. Product copy renders the user's
-- report ("You marked this applied"), never a submission claim.
--
-- WHERE THE NEW STATE APPEARS — exactly the four places the spec names:
--
--   1. `hq_autopilot_states()`             the twelfth word
--   2. `hq_autopilot_transition_allowed()` one new arrow, `approved → handed_off`,
--                                          and handed_off appears on the LEFT
--                                          zero times: terminal
--   3. `autopilot_stages_approval_matches_state`
--                                          the authorised branch — a handed-off
--                                          stage must still name its reviewer,
--                                          the hash they approved, and when
--   4. `autopilot_stages_one_live_attempt` slot-occupying, as argued above
--
-- AND DELIBERATELY NOT IN `hq_autopilot_committed_states()`. That set feeds the
-- delete guard's "this may have reached an employer" refusal, whose refusal copy
-- says autopilot is submitting or submitted it. A handed-off stage is not a
-- claim autopilot reached an employer — it is the user's own report about their
-- own act, and its durable record is the manual status on the application row
-- plus the `events` trail, both of which the stage's deletion does not rewrite.
-- Keeping it out preserves the four shipped un-do gestures (un-triage, bulk
-- un-triage, import undo, digest undo) for an application whose user changed
-- their mind, while the receipt-existence half of the delete guard — the
-- load-bearing half — is untouched and cannot apply here, because a handed-off
-- stage can never hold a receipt (see the state machine below).
--
-- THE STATE MACHINE grows three refusals for the new word, each the same belt
-- an existing state already wears:
--
--   * entering `handed_off` re-checks `approved_hash = payload_hash` — rule 4's
--     set gains the new state, so a `service_role` write that altered a frozen
--     package with a trigger disabled is caught at the settling transition,
--     which is the attack #206's list names;
--   * entering `handed_off` with no recorded reviewer is refused, and the
--     approval columns may not be rewritten on the way in — `submitting`'s two
--     belts, verbatim, because settling is likewise the moment the answer to
--     "who authorised this" stops being fixable;
--   * entering `handed_off` while a receipt exists is refused — a row holding
--     accepted provider evidence and claiming "the user's word is all there is"
--     contradicts itself; the honest state for provider evidence is `submitted`.
--     Unreachable through legal writes (a receipt is only filed while
--     `submitting`/`outcome_unknown`, and `handed_off` is only entered from
--     `approved`), which is exactly why it is checked: it is the arm for a
--     restore and for a writer that had a trigger disabled.
--
-- THE SETTLE RPC — `app_settle_autopilot_handoff` — records the user's report:
--
--   'submitted'   transitions `approved → handed_off` and writes the manual
--                 application status 'Applied' THROUGH `app_set_status`, in the
--                 same transaction. Through, not around: the settle RPC calls
--                 the shipped function, so the human-status lock is stamped, the
--                 reopen-needs-a-note rule holds, the suggestion is cleared, and
--                 the status audit event is the same one every other human
--                 status write produces. This RPC has no
--                 `set_config('hq.status_write', …)` of its own and never
--                 touches `applications` directly.
--   'abandoned'   routes to cancel semantics through `app_review_autopilot_stage`
--                 — the stage settles as `cancelled`, the
--                 `one_live_attempt` slot releases, and the recorded approval
--                 SURVIVES on the cancelled row (the review RPC's own rule:
--                 "who authorised this, and against what" stays true of a stage
--                 somebody then stopped).
--
--   THE INNER IDEMPOTENCY KEYS ARE UNGUESSABLE, AND THE POSTCONDITION IS
--   CHECKED. An earlier draft of this file used DETERMINISTIC inner keys
--   (`autopilot-handoff-status:<stage id>`) and argued that a collision was
--   "unreachable, not merely unlikely" because the settle is one transaction.
--   THAT ARGUMENT WAS FALSE, and the independent security review demonstrated
--   the consequence, so it is corrected here rather than left in an
--   append-only file for the next reader to trust:
--
--     `app_set_status` (0010) predates 0026 and uses the PRE-0026 replay
--     lookup — `select result … where user_id = … and idem_key = …`, matched on
--     the KEY ALONE, with no command name and no `request_hash`. A browser may
--     pass ANY string as `p_idem` to ANY RPC, so a caller who had once used the
--     string `autopilot-handoff-status:<stage id>` for some other gesture left a
--     row that the inner call would find and return. The settle then reported
--     success while writing NO status at all: `handed_off` landed on top of a
--     `Rejected`/`user` application, with zero `action.status` events and no
--     note. The `abandoned` path never had the defect, because
--     `app_review_autopilot_stage` calls `hq_command_replay`, which compares the
--     command and the fingerprint and RAISES on a mismatch — that asymmetry was
--     the tell.
--
--   Two changes, and the second is the one that holds:
--
--     1. the inner keys carry `gen_random_uuid()`, so no caller can pre-seed a
--        row that satisfies them. The settle's OWN key still provides replay
--        safety — a replayed settle returns the stored result from
--        `hq_command_replay` before reaching either inner call — so the inner
--        key never needed to be stable, only unique.
--     2. THE COMPOSITION VERIFIES ITS POSTCONDITION. After the inner call the
--        application row is RE-READ and must actually say `Applied` /
--        `status_actor = 'user'`; anything else raises and takes the whole
--        transaction with it. Key scoping is a probability argument and this is
--        not: a composed command that cannot see whether its callee wrote is a
--        command that reports success for a write that did not happen. The
--        returned `application` object is built from that re-read, never from
--        the callee's return value.
--
-- THE PER-POSTING SIBLING PRECONDITION, stated honestly. #207's blocker #1
-- (transcribed from PR #177): `autopilot_stages_one_live_attempt` keys on
-- `(user_id, application_id)`, and `applications` can hold two rows for one
-- posting — `unique (user_id, posting_key)` does not constrain
-- `posting_key is null` rows, and 0002's `applications_manual_dedup` covers only
-- the null-key side, so a keyed row plus a manual row for the same posting
-- coexist. This file adds `hq_autopilot_sibling_live_attempt()` and calls it
-- from the two stage-creating paths (`app_stage_autopilot_application` when the
-- write would create a new attempt, `app_retry_autopilot_stage` always), so no
-- Prepare/Review path creates a second live attempt per posting.
--
-- IT IS A RACED-LOOKUP GUARD, NOT THE STRUCTURAL ARBITER. The check and the
-- insert are two steps: two concurrent transactions staging two SIBLING
-- application rows (one keyed, one manual) can each pass the lookup before
-- either row becomes visible, and both inserts then succeed — the partial
-- unique index cannot refuse them because they carry different
-- `application_id`s. Serialization does not close it at read-committed, and
-- nothing here claims it does. What the window leaves possible is exactly that
-- interleaving; what the guard removes is every sequential path, which is every
-- path a browser gesture actually takes. The structural per-posting arbiter —
-- an index over a posting identity rather than the application row — is #207's
-- launch blocker and is deliberately NOT claimed by this migration.
--
-- Before merging, audit: ownership, grants, RLS policies, constraints, and the
-- search_path on any security-definer function.
--
-- THIS FILE IS ALSO TYPESCRIPT INPUT. webapp/tests/unit/types-contract.test.ts
-- parses CREATE TABLE bodies and `alter table … add column` statements. This
-- file adds no table and no column, so no webapp/lib/types.ts change rides
-- with it.

-- ============================================================ the vocabulary

/**
 * The twelve states. `handed_off` is the addition; the staging migration's
 * header remains the authority for the other eleven.
 */
create or replace function public.hq_autopilot_states()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['preparing', 'needs_input', 'ready_for_review', 'changes_requested',
               'approved', 'submitting', 'submitted', 'outcome_unknown',
               'failed_retryable', 'failed_terminal', 'cancelled',
               'handed_off']::text[]
$$;

comment on function public.hq_autopilot_states() is
  'the twelve autopilot staging states; the staging migration header says what the first eleven mean, and the handoff migration header says what handed_off is and is not';

-- ============================================================ the transition map

/**
 * One new arrow: `approved → handed_off`. The user, having submitted the
 * approved package themselves, reports it — a person's act, made through
 * `app_settle_autopilot_handoff`, subject to the same approval-integrity checks
 * as `approved → submitting`.
 *
 * `handed_off` appears on the LEFT zero times. It is terminal: the user's
 * report has been recorded as manual status, and un-recording it is a manual
 * status change on the application, not a stage transition.
 */
create or replace function public.hq_autopilot_transition_allowed(
  p_from text,
  p_to   text
)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select (p_from || '>' || p_to) = any (array[
    -- preparation
    'preparing>needs_input',              'preparing>ready_for_review',
    'preparing>cancelled',
    'needs_input>preparing',              'needs_input>ready_for_review',
    'needs_input>cancelled',
    'ready_for_review>preparing',         'ready_for_review>needs_input',
    'ready_for_review>changes_requested', 'ready_for_review>approved',
    'ready_for_review>cancelled',
    'changes_requested>preparing',        'changes_requested>needs_input',
    'changes_requested>ready_for_review', 'changes_requested>cancelled',
    -- authorisation
    'approved>submitting',                'approved>changes_requested',
    'approved>ready_for_review',          'approved>cancelled',
    -- the manual handoff terminus (#206): the user submitted it themselves and
    -- said so. No arrow out — terminal.
    'approved>handed_off',
    -- execution
    'submitting>submitted',               'submitting>outcome_unknown',
    'submitting>failed_retryable',        'submitting>failed_terminal',
    'submitting>cancelled',
    -- the ambiguous outcome: two exits, neither of them a retry
    'outcome_unknown>submitted',          'outcome_unknown>failed_terminal',
    -- a failure with positive proof that nothing committed may be re-approved
    'failed_retryable>approved',          'failed_retryable>changes_requested',
    'failed_retryable>ready_for_review',  'failed_retryable>cancelled'
  ]);
$$;

comment on function public.hq_autopilot_transition_allowed(text, text) is
  'the autopilot state machine as data: true iff from→to is legal. outcome_unknown exits only to submitted or failed_terminal — never back into submitting — and handed_off exits nowhere.';

-- ============================================================ the approval shape

-- `handed_off` joins the authorised branch: a handed-off stage must still carry
-- the hash a human approved, when, and by whom. Drop-and-add, the staging
-- migration's own pattern for this constraint and for its reason — the
-- predicate changes, so "a constraint by that name exists" is not the question,
-- and adding it VALIDATES every existing row.
--
-- ORDER MATTERS ON RE-APPLY: the staging migration's converge block re-adds the
-- ELEVEN-state shape of this constraint on every `db/apply.sh` run that follows
-- it, and a `handed_off` row passes that shape too (it falls to the `else true`
-- arm), so the two files converge in either order without stranding a row.
-- This file then restores the twelve-state shape.
alter table public.autopilot_stages
  drop constraint if exists autopilot_stages_approval_matches_state;
alter table public.autopilot_stages
  add constraint autopilot_stages_approval_matches_state check (
    case
      when state = any (public.hq_autopilot_editable_states())
        then approved_hash is null and approved_at is null and approved_by is null
      when state in ('approved', 'submitting', 'submitted', 'outcome_unknown',
                     'handed_off')
        then approved_hash is not null and approved_at is not null
             and approved_by is not null
      else true
    end);

-- ============================================================ the slot

/**
 * `handed_off` occupies the application's slot. "The user says the employer has
 * this" blocks a second attempt exactly as firmly as a receipt does: staging
 * again, or retrying, gets a refusal rather than a duplicate application.
 * Releasing the slot is not modelled — the honest exits from "I told you I
 * submitted it" are a manual status change on the application, not a new
 * autopilot attempt against the same row.
 *
 * DROP-AND-CREATE IN ONE DO BLOCK, because `db/apply.sh` runs files through
 * psql statement-by-statement rather than in one transaction: two top-level
 * statements would leave a real (if brief) window with no uniqueness at all.
 * A DO block is a single statement and therefore a single transaction.
 *
 * The staging migration's `create unique index IF NOT EXISTS` re-apply sees the
 * name standing and leaves this twelve-state predicate in place.
 */
do $$
begin
  drop index if exists public.autopilot_stages_one_live_attempt;
  create unique index autopilot_stages_one_live_attempt
    on public.autopilot_stages (user_id, application_id)
    where state in ('preparing', 'needs_input', 'ready_for_review',
                    'changes_requested', 'approved', 'submitting', 'submitted',
                    'outcome_unknown', 'handed_off');
end
$$;

-- ============================================================ the state machine

/**
 * The staging migration's trigger, with `handed_off` wearing the belts its
 * neighbours already wear. The numbered rules and their reasoning live in that
 * file's header; the deltas here are the three named in THIS file's header:
 * rule 4's set gains `handed_off`, the reviewer/approval-rewrite belts on
 * `submitting` now cover `handed_off` too, and the receipt-contradiction set
 * gains it.
 */
create or replace function public.hq_autopilot_state_machine()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_package_changed boolean;
  v_state_changed   boolean := new.state is distinct from old.state;
  v_uid             uuid := auth.uid();
begin
  -- Identity does not move.
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.application_id is distinct from old.application_id
     or new.retry_of_stage_id is distinct from old.retry_of_stage_id
     or new.created_at is distinct from old.created_at then
    raise exception 'autopilot stage % identity is immutable', old.id
      using errcode = '42501';
  end if;

  v_package_changed := (new.provider, new.provider_version, new.form_identity,
                        new.form_schema_hash, new.payload, new.attachments, new.answers)
                       is distinct from
                       (old.provider, old.provider_version, old.form_identity,
                        old.form_schema_hash, old.payload, old.attachments, old.answers);

  if v_package_changed and v_state_changed then
    raise exception
      'autopilot stage %: an edit is not a transition — change the package or the state, not both',
      old.id
      using errcode = '22023',
            hint = 'the approval hash is judged against the stored package; doing both '
                   'in one statement makes "which package was approved" ambiguous';
  end if;

  -- The freeze is wider than the hash: the seven package columns AND `gaps`.
  if (v_package_changed or new.gaps is distinct from old.gaps)
     and not (old.state = any (public.hq_autopilot_editable_states())) then
    raise exception
      'autopilot stage % is % — the reviewed package is frozen', old.id, old.state
      using errcode = '42501',
            hint = 'edit before approval, or send it back with app_review_autopilot_stage';
  end if;

  if v_state_changed then
    if not public.hq_autopilot_transition_allowed(old.state, new.state) then
      raise exception 'autopilot stage %: % is not a legal transition from %',
        old.id, new.state, old.state
        using errcode = '22023';
    end if;

    -- Entering an editable state throws the approval away.
    if new.state = any (public.hq_autopilot_editable_states()) then
      new.approved_hash := null;
      new.approved_at   := null;
      new.approved_by   := null;
    end if;

    -- THE BINDING, now three states wide. `handed_off` is the manual terminus'
    -- version of the same question `submitting` asks: is the package being
    -- settled still the package a human read? A `service_role` write that
    -- altered a frozen package with a trigger disabled regenerates
    -- `payload_hash`, and this is the check that catches it at the next
    -- transition (#206's attack list).
    if new.state in ('approved', 'submitting', 'handed_off') then
      if new.approved_hash is null or new.approved_hash <> old.payload_hash then
        raise exception
          'autopilot stage %: the approval does not match the package', old.id
          using errcode = '42501',
                hint = 'approve the exact package that will be submitted — '
                       're-read the stage and approve again';
      end if;
    end if;

    -- The approver is a person, and it is the person doing the approving.
    if new.state = 'approved' then
      if v_uid is null then
        raise exception
          'autopilot stage % cannot be approved without a signed-in reviewer', old.id
          using errcode = '42501',
                hint = 'approving is a person''s act — app_review_autopilot_stage is the '
                       'only path to it, and neither the engine nor an operator has one';
      end if;
      if new.approved_by is distinct from v_uid then
        raise exception
          'autopilot stage %: an approval records the reviewer who made it', old.id
          using errcode = '42501',
                hint = 'approved_by must be the approving session';
      end if;
    end if;

    -- A submission — or a manual handoff settlement — is the moment the answer
    -- to "who authorised this" stops being fixable.
    if new.state in ('submitting', 'handed_off') and old.approved_by is null then
      raise exception
        'autopilot stage % has no recorded reviewer and cannot be settled as %',
        old.id, new.state
        using errcode = '42501',
              hint = 'the approval predates the reviewer requirement, or was written '
                     'with a trigger disabled — re-approve it';
    end if;

    -- An approval may not be (re)written on the way into either terminus lane.
    if new.state in ('submitting', 'handed_off')
       and (new.approved_hash is distinct from old.approved_hash
            or new.approved_at is distinct from old.approved_at
            or new.approved_by is distinct from old.approved_by) then
      raise exception
        'autopilot stage %: the approval may not be rewritten while settling it',
        old.id using errcode = '42501';
    end if;

    -- The receipt contract, both directions.
    if new.state = 'submitted'
       and not exists (select 1 from public.autopilot_receipts r where r.stage_id = old.id) then
      raise exception
        'autopilot stage % cannot be submitted without a receipt', old.id
        using errcode = '23503',
              hint = 'record accepted provider evidence first, or the state is outcome_unknown';
    end if;

    -- ITS CONVERSE, now covering `handed_off` too: a stage that holds accepted
    -- provider evidence and claims "the user's word is all there is" is a row
    -- contradicting itself — the honest state for provider evidence is
    -- `submitted`. Unreachable through legal writes (a receipt is only filed
    -- while submitting/outcome_unknown; handed_off is entered only from
    -- approved), which is exactly why it is here: this is the arm for a
    -- restore, and for a writer that had a trigger disabled.
    if new.state in ('cancelled', 'failed_retryable', 'failed_terminal', 'handed_off')
       and exists (select 1 from public.autopilot_receipts r where r.stage_id = old.id) then
      raise exception
        'autopilot stage % holds a provider receipt and cannot become %', old.id, new.state
        using errcode = '42501',
              hint = 'a confirmed submission settles as `submitted`; a receipt filed in '
                     'error is a correction with its own record, not a state change';
    end if;
  end if;

  -- `transition_reason` belongs to a transition.
  if not v_state_changed
     and new.transition_reason is distinct from old.transition_reason
     and not (old.state = any (public.hq_autopilot_editable_states())) then
    raise exception
      'autopilot stage %: a transition reason belongs to a transition', old.id
      using errcode = '42501',
            hint = 'the reason is copied into the audit trail when the state moves; '
                   'it is not a note field on a settled stage';
  end if;

  -- An approval is a transition, not a field edit.
  if not v_state_changed
     and (new.approved_hash is distinct from old.approved_hash
          or new.approved_at is distinct from old.approved_at
          or new.approved_by is distinct from old.approved_by) then
    raise exception
      'autopilot stage %: an approval is a transition, not a field edit', old.id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.hq_autopilot_state_machine() is
  'the autopilot lifecycle, enforced for every writer: legal transitions only, the package frozen outside the editable states, an approval that must still match the package AND name the signed-in reviewer who made it — re-checked on the way into submitting AND handed_off — no `submitted` without a receipt, and no settled failure or manual handoff on top of one';

-- The trigger itself is unchanged and already bound to this function name; a
-- `create or replace` re-points nothing and drops nothing.

-- ============================================================ the sibling guard

/**
 * The user's OTHER application row for the same posting, holding a live
 * autopilot attempt — or null.
 *
 * The sibling relation is the one #207's blocker #1 names: `applications` can
 * hold a KEYED row and a MANUAL (`posting_key is null`) row for one posting,
 * because `unique (user_id, posting_key)` ignores nulls and
 * `applications_manual_dedup` covers only the null-key side. Two KEYED rows for
 * one posting cannot exist at all — the unique constraint IS that arm — so this
 * function checks only the manual-identity bridge: same owner, different
 * application row, case-insensitively the same `(company, title)`, with at
 * least one side keyless. Two keyed rows with different posting keys are two
 * different postings (a repost, a second req) and are deliberately NOT
 * siblings.
 *
 * "Live" is derived as NOT-settled rather than restating the live list: only
 * `failed_retryable`, `failed_terminal` and `cancelled` release an attempt, and
 * deriving it that way means a thirteenth state cannot silently fall out of
 * this guard.
 *
 * A LOOKUP, WITH A RACE WINDOW — the migration header states it in full. This
 * closes every sequential path to a duplicate attempt per posting and is not
 * the structural arbiter; that is #207's blocker, fixed there.
 *
 * Not security definer: only ever called from inside the two definer RPCs
 * below, which already run as the owner. Returns the sibling's application id
 * so the refusal can name it.
 */
create or replace function public.hq_autopilot_sibling_live_attempt(
  p_user           uuid,
  p_application_id bigint
)
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select s.application_id
    from public.autopilot_stages s
    join public.applications sib on sib.id = s.application_id
                                and sib.user_id = s.user_id
    join public.applications tgt on tgt.id = p_application_id
                                and tgt.user_id = p_user
   where s.user_id = p_user
     and s.application_id <> p_application_id
     and not (s.state = any (array['failed_retryable', 'failed_terminal',
                                   'cancelled']))
     and (sib.posting_key is null or tgt.posting_key is null)
     and lower(sib.company) = lower(tgt.company)
     and lower(sib.title)   = lower(tgt.title)
   limit 1
$$;

comment on function public.hq_autopilot_sibling_live_attempt(uuid, bigint) is
  'the user''s OTHER application row for the same posting (keyed↔manual bridge) holding a live autopilot attempt, or null — the raced-lookup half of duplicate-per-posting prevention; the structural arbiter is #207''s blocker';

revoke all on function public.hq_autopilot_sibling_live_attempt(uuid, bigint)
  from public, anon, authenticated;

-- ============================================================ write: stage it

/**
 * The staging migration's RPC with two deltas, everything else verbatim:
 *
 *   * the ON CONFLICT inference clause and the open-stage hint learn
 *     `handed_off` (the arbiter predicate must restate the partial index
 *     character for character, and the index changed above);
 *   * WHEN THE WRITE WOULD CREATE A NEW ATTEMPT — no live stage for this
 *     application yet — the sibling guard runs first. An EDIT of an existing
 *     live stage is deliberately exempt: it creates nothing, and refusing it
 *     would brick the very stage a person is trying to fix.
 */
create or replace function public.app_stage_autopilot_application(
  p_application_id      bigint,
  p_provider            text,
  p_provider_version    text,
  p_form_identity       text,
  p_form_schema_hash    text,
  p_payload             jsonb,
  p_attachments         jsonb,
  p_answers             jsonb,
  p_gaps                jsonb,
  p_state               text,
  p_reason              text,
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
  v_provider text := lower(public.hq_blank_trim(coalesce(p_provider, '')));
  v_version  text := public.hq_blank_trim(coalesce(p_provider_version, ''));
  v_form     text := public.hq_blank_trim(coalesce(p_form_identity, ''));
  v_schema   text := lower(public.hq_blank_trim(coalesce(p_form_schema_hash, '')));
  v_payload  jsonb := coalesce(p_payload, '{}'::jsonb);
  v_atts     jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_answers  jsonb := coalesce(p_answers, '{}'::jsonb);
  v_gaps     jsonb := coalesce(p_gaps, '[]'::jsonb);
  v_state    text := coalesce(nullif(public.hq_blank_trim(p_state), ''), 'preparing');
  v_reason   text := left(public.hq_blank_trim(coalesce(p_reason, '')), 500);
  v_row      public.autopilot_stages;
  v_result   jsonb;
  v_inserted boolean := false;
  v_sibling  bigint;
  v_fp       text := public.hq_command_fingerprint(
                       jsonb_build_array(p_application_id, v_provider, v_version,
                                         v_form, v_schema, v_payload, v_atts,
                                         v_answers, v_gaps, v_state));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if v_state not in ('preparing', 'needs_input', 'ready_for_review') then
    raise exception
      'a stage write may only leave the package in a preparation state, not %', v_state
      using errcode = '22023',
            hint = 'approval is app_review_autopilot_stage, and execution is not a browser gesture';
  end if;

  -- Ownership, derived and never named.
  if p_application_id is null
     or not exists (select 1 from public.applications
                     where id = p_application_id and user_id = v_user) then
    raise exception 'no such application for this user: %', p_application_id
      using errcode = 'P0002';
  end if;

  if v_provider = '' then
    raise exception 'a stage needs a provider' using errcode = '22023';
  end if;
  if length(v_version) > 100 or length(v_form) > 200 or length(v_schema) > 128 then
    raise exception 'provider version, form identity or schema hash is too long'
      using errcode = '22023';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_stage_autopilot_application', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- THE PER-POSTING SIBLING PRECONDITION (#206; #207 blocker #1). Only when
  -- this write would CREATE an attempt: an edit of the existing live stage
  -- creates nothing and passes. A raced-lookup guard, not the structural
  -- arbiter — the migration header states exactly what the window leaves
  -- possible.
  if not exists (select 1 from public.autopilot_stages
                  where user_id = v_user and application_id = p_application_id
                    and not (state = any (array['failed_retryable',
                                                'failed_terminal', 'cancelled']))) then
    v_sibling := public.hq_autopilot_sibling_live_attempt(v_user, p_application_id);
    if v_sibling is not null then
      raise exception
        'conflict: another application for this posting already has a live autopilot attempt'
        using errcode = '40001',
              detail = format('application %s holds the live attempt', v_sibling),
              hint = 'open that attempt instead — one posting gets one live attempt, '
                     'whichever application row carries it';
    end if;
  end if;

  -- The arbiter is the PARTIAL index, restated as its inference clause —
  -- `autopilot_stages_one_live_attempt`'s predicate character for character.
  insert into public.autopilot_stages
    (user_id, application_id, provider, provider_version, form_identity,
     form_schema_hash, payload, attachments, answers, gaps, transition_reason)
  values (v_user, p_application_id, v_provider, v_version, v_form,
          v_schema, v_payload, v_atts, v_answers, v_gaps, v_reason)
  on conflict (user_id, application_id)
    where state in ('preparing', 'needs_input', 'ready_for_review',
                    'changes_requested', 'approved', 'submitting', 'submitted',
                    'outcome_unknown', 'handed_off')
    do nothing;
  v_inserted := found;

  select * into v_row
    from public.autopilot_stages
   where user_id = v_user and application_id = p_application_id
     and state in ('preparing', 'needs_input', 'ready_for_review',
                   'changes_requested', 'approved')
     for update;
  if not found then
    raise exception 'conflict: this application has no open autopilot stage'
      using errcode = '40001',
            hint = 'a submission for it is in flight, submitted, ambiguous, or handed off';
  end if;

  -- The post-lock replay re-check.
  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_stage_autopilot_application', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  if not v_inserted then
    if p_expected_updated_at is not null
       and v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'conflict: this autopilot stage changed since you read it'
        using errcode = '40001';
    end if;

    if not (v_row.state = any (public.hq_autopilot_editable_states())) then
      raise exception 'conflict: this autopilot stage is % and its package is frozen',
        v_row.state
        using errcode = '40001',
              hint = 'send it back for changes before re-staging it';
    end if;

    -- Statement one: the package. A write that changes nothing writes nothing.
    if (v_row.provider, v_row.provider_version, v_row.form_identity,
        v_row.form_schema_hash, v_row.payload, v_row.attachments, v_row.answers,
        v_row.gaps)
       is distinct from
       (v_provider, v_version, v_form, v_schema, v_payload, v_atts, v_answers, v_gaps)
    then
      update public.autopilot_stages
         set provider          = v_provider,
             provider_version  = v_version,
             form_identity     = v_form,
             form_schema_hash  = v_schema,
             payload           = v_payload,
             attachments       = v_atts,
             answers           = v_answers,
             gaps              = v_gaps,
             transition_reason = v_reason
       where id = v_row.id
      returning * into v_row;
    end if;
  end if;

  -- Statement two: the state, if it moved.
  if v_row.state is distinct from v_state then
    update public.autopilot_stages
       set state = v_state, transition_reason = v_reason
     where id = v_row.id
    returning * into v_row;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'autopilot.staged',
          jsonb_build_object('stageId', v_row.id,
                             'applicationId', v_row.application_id,
                             'provider', v_row.provider,
                             'state', v_row.state,
                             'packageHash', v_row.payload_hash,
                             'gapCount', jsonb_array_length(v_row.gaps),
                             'created', v_inserted),
          'user');

  v_result := jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                 'created', v_inserted);

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_stage_autopilot_application', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_stage_autopilot_application(
  bigint, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, timestamptz) is
  'prepare or re-prepare the package for one application — idempotent on p_idem, optimistic on p_expected_updated_at, unable to approve anything, and refusing to CREATE a second live attempt for a posting a sibling application row already holds one for';

-- `create or replace` preserves the existing ACL; the staging migration's
-- revoke/grant stands. Restated anyway so this file audits complete on its own.
revoke all on function public.app_stage_autopilot_application(
  bigint, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_stage_autopilot_application(
  bigint, text, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, timestamptz)
  to authenticated;

-- ============================================================ write: retry it

/**
 * The staging migration's RPC with one delta: a retry always creates, so the
 * sibling guard always runs — before the insert, so the refusal is a sentence
 * about the posting rather than an index name, and so a keyed↔manual sibling
 * (which the index cannot see) is refused at all.
 */
create or replace function public.app_retry_autopilot_stage(
  p_stage_id bigint,
  p_reason   text,
  p_idem     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_reason  text := left(public.hq_blank_trim(coalesce(p_reason, '')), 500);
  v_prior   public.autopilot_stages;
  v_row     public.autopilot_stages;
  v_result  jsonb;
  v_sibling bigint;
  v_fp      text := public.hq_command_fingerprint(jsonb_build_array(p_stage_id, v_reason));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem, 'app_retry_autopilot_stage', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  select * into v_prior
    from public.autopilot_stages
   where id = p_stage_id and user_id = v_user
     for update;
  if not found then
    raise exception 'no such autopilot stage for this user: %', p_stage_id
      using errcode = 'P0002';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem, 'app_retry_autopilot_stage', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  if v_prior.state = 'outcome_unknown' then
    raise exception
      'autopilot stage % is outcome_unknown and may not be retried', v_prior.id
      using errcode = '42501',
            hint = 'an application may already exist with this employer; reconcile it to '
                   'submitted or failed_terminal first — that decision is a person''s';
  end if;
  if v_prior.state not in ('failed_retryable', 'failed_terminal', 'cancelled') then
    raise exception 'autopilot stage % is % and is not a finished attempt',
      v_prior.id, v_prior.state
      using errcode = '22023';
  end if;

  -- THE PER-POSTING SIBLING PRECONDITION (#206; #207 blocker #1). A retry
  -- always creates, so it always checks. Raced-lookup guard; header states the
  -- window.
  v_sibling := public.hq_autopilot_sibling_live_attempt(v_user, v_prior.application_id);
  if v_sibling is not null then
    raise exception
      'conflict: another application for this posting already has a live autopilot attempt'
      using errcode = '40001',
            detail = format('application %s holds the live attempt; retry of stage %s refused',
                            v_sibling, v_prior.id),
            hint = 'open that attempt instead — one posting gets one live attempt, '
                   'whichever application row carries it';
  end if;

  begin
    insert into public.autopilot_stages
      (user_id, application_id, provider, provider_version, form_identity,
       form_schema_hash, payload, attachments, answers, gaps,
       retry_of_stage_id, transition_reason)
    values (v_user, v_prior.application_id, v_prior.provider, v_prior.provider_version,
            v_prior.form_identity, v_prior.form_schema_hash, v_prior.payload,
            v_prior.attachments, v_prior.answers, v_prior.gaps,
            v_prior.id, v_reason)
    returning * into v_row;
  exception when unique_violation then
    raise exception
      'conflict: this application already has a newer autopilot attempt'
      using errcode = '40001',
            detail = format('retry of stage %s for application %s',
                            v_prior.id, v_prior.application_id),
            hint = 'open the live attempt instead of retrying the finished one';
  end;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'autopilot.retry_staged',
          jsonb_build_object('stageId', v_row.id,
                             'retryOfStageId', v_prior.id,
                             'applicationId', v_row.application_id,
                             'provider', v_row.provider,
                             'packageHash', v_row.payload_hash,
                             'reason', v_reason),
          'user');

  v_result := jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                 'retryOfStageId', v_prior.id);

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_retry_autopilot_stage', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_retry_autopilot_stage(bigint, text, text) is
  'stage a NEW attempt from a finished one — never a transition backwards, never from outcome_unknown, refused while a sibling application row holds the posting''s live attempt, and it has to be reviewed and approved again';

revoke all on function public.app_retry_autopilot_stage(bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.app_retry_autopilot_stage(bigint, text, text)
  to authenticated;

-- ============================================================ write: settle it

/**
 * Record what the user reports about a handed-off package. The migration
 * header carries the design; the load-bearing facts, restated at the code:
 *
 *   * 'submitted' is TWO recorded acts in ONE transaction: the stage settles
 *     `approved → handed_off` (the state machine re-checks the approval against
 *     the stored package on the way), and the application's MANUAL status is
 *     written through `app_set_status` — the same function, the same
 *     human-status lock, the same audit event as the user picking 'Applied' by
 *     hand, because that is exactly what this is. This function never touches
 *     `applications` directly and never sets `hq.status_write`.
 *
 *   * AND IT CHECKS THAT THE CALLEE WROTE. `app_set_status` uses the pre-0026
 *     key-only replay lookup, so a stored row under the inner key would make it
 *     return without writing — the defect the header records in full. The
 *     inner key is now unguessable AND the application row is re-read and
 *     verified afterwards; a status that is not `Applied`/`user` raises and
 *     rolls the whole settle back, so "the stage says handed_off but no status
 *     was written" is not a state this function can produce.
 *
 *   * 'abandoned' routes through `app_review_autopilot_stage`'s cancel: the
 *     stage settles as `cancelled`, the slot releases, the recorded approval
 *     survives on the row for audit.
 *
 *   * ZERO receipt writes, on every input. The word `autopilot_receipts` does
 *     not appear in this function body, and the state machine independently
 *     refuses `handed_off` on top of one.
 *
 *   * A reopen still needs a note: settling 'submitted' against an application
 *     whose status is finished propagates `app_set_status`'s
 *     "reopening needs a note saying why" unless `p_reason` says why. The
 *     refusal is that function's own sentence — this one adds no bypass,
 *     because the manual-status machinery being un-bypassable is the point.
 */
create or replace function public.app_settle_autopilot_handoff(
  p_stage_id            bigint,
  p_outcome             text,
  p_reason              text,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_outcome text := lower(public.hq_blank_trim(coalesce(p_outcome, '')));
  v_reason  text := left(public.hq_blank_trim(coalesce(p_reason, '')), 500);
  v_row     public.autopilot_stages;
  v_app     public.applications;
  v_result  jsonb;
  v_fp      text := public.hq_command_fingerprint(
                      jsonb_build_array(p_stage_id, v_outcome, v_reason));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if v_outcome not in ('submitted', 'abandoned') then
    raise exception 'unknown handoff outcome: %', v_outcome
      using errcode = '22023',
            hint = 'submitted (the user applied on the provider''s form) or abandoned';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_settle_autopilot_handoff', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- Ownership, derived and never named. A definer bypasses RLS, so this WHERE
  -- is the whole of "you may only settle your own stage" — and a cross-user
  -- probe answers P0002, indistinguishable from a stage that does not exist.
  select * into v_row
    from public.autopilot_stages
   where id = p_stage_id and user_id = v_user
     for update;
  if not found then
    raise exception 'no such autopilot stage for this user: %', p_stage_id
      using errcode = 'P0002';
  end if;

  -- The post-lock replay re-check (0026's pattern).
  v_result := public.hq_command_replay(v_user, p_idem,
                                       'app_settle_autopilot_handoff', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this autopilot stage changed since you read it'
      using errcode = '40001';
  end if;

  -- Only an approved package was handed off. Everything else is a client that
  -- lost track of the stage, and the honest answer is a refusal it can render.
  if v_row.state <> 'approved' then
    raise exception
      'autopilot stage % is % and has no manual handoff to settle', v_row.id, v_row.state
      using errcode = '22023',
            hint = 'only an approved package is handed off; re-read the stage';
  end if;

  if v_outcome = 'submitted' then
    -- Statement one: the terminus. The state machine re-checks that the
    -- approval still matches the stored package, that a reviewer is recorded,
    -- and that no receipt exists — the same belts `approved → submitting`
    -- wears.
    update public.autopilot_stages
       set state = 'handed_off', transition_reason = v_reason
     where id = v_row.id
    returning * into v_row;

    -- Statement two: the MANUAL status, through the front door.
    --
    -- THE INNER KEY CARRIES A FRESH UUID. `app_set_status` matches a replay on
    -- the KEY ALONE (pre-0026), and any browser may send any string as `p_idem`
    -- to any RPC, so a deterministic key here is a key a caller can pre-seed —
    -- after which the callee returns a stored result and writes nothing. The
    -- settle's own key is what provides replay safety, so this one only has to
    -- be unique.
    perform public.app_set_status(
              v_row.application_id, 'Applied', v_reason,
              'autopilot-handoff-status:' || v_row.id::text || ':'
                || gen_random_uuid()::text,
              null);

    -- AND THE POSTCONDITION, because a composed command that cannot see
    -- whether its callee wrote is a command that reports success for a write
    -- that did not happen. Re-read rather than trust the callee's return value:
    -- the row itself is the only thing that can answer "is this application
    -- actually recorded as manually applied".
    select * into v_app
      from public.applications
     where id = v_row.application_id and user_id = v_user;
    if not found
       or v_app.status <> 'Applied'
       or v_app.status_actor <> 'user' then
      raise exception
        'autopilot stage %: the manual status write did not land', v_row.id
        using errcode = '22023',
              detail = format('application %s reads %s/%s after app_set_status',
                              v_row.application_id,
                              coalesce(v_app.status, '<missing row>'),
                              coalesce(v_app.status_actor, '<missing row>')),
              hint = 'nothing was settled — the stage is unchanged and no status '
                     'was recorded; retry, and report this if it repeats';
    end if;

    -- The settle's own audit row. The SHAPE, never the contents (staging
    -- migration's rule): no answer values, no payload, no note text.
    insert into public.events (user_id, kind, payload, actor)
    values (v_user, 'autopilot.handed_off',
            jsonb_build_object('stageId', v_row.id,
                               'applicationId', v_row.application_id,
                               'provider', v_row.provider,
                               'state', v_row.state,
                               'packageHash', v_row.payload_hash,
                               'outcome', 'submitted'),
            'user');

    v_result := jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                   'outcome', 'submitted',
                                   -- From the VERIFIED re-read, never from the
                                   -- callee's return value.
                                   'application', public.app_application_row(v_app));
  else
    -- 'abandoned': cancel semantics, through the review RPC — its transition,
    -- its approval-preserving UPDATE, its `autopilot.cancelled` event.
    --
    -- This callee is post-0026: `hq_command_replay` compares the command and
    -- the fingerprint, so a pre-seeded row RAISES rather than silently
    -- answering — which is why this path never carried the status path's
    -- defect. The key is unguessable here too, so a caller cannot turn its own
    -- settle into that raise.
    perform public.app_review_autopilot_stage(
              p_stage_id, 'cancel', null, v_reason,
              'autopilot-handoff-cancel:' || v_row.id::text || ':'
                || gen_random_uuid()::text,
              null);

    select * into v_row from public.autopilot_stages where id = p_stage_id;

    v_result := jsonb_build_object('stage', public.app_autopilot_stage_row(v_row),
                                   'outcome', 'abandoned',
                                   'application', null);
  end if;

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_settle_autopilot_handoff', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_settle_autopilot_handoff(bigint, text, text, text, timestamptz) is
  'record the user''s report on a handed-off package: submitted settles the stage approved→handed_off and writes MANUAL status ''Applied'' through app_set_status in one transaction; abandoned routes to app_review_autopilot_stage''s cancel. Writes no autopilot_receipts row under any input.';

revoke all on function public.app_settle_autopilot_handoff(
  bigint, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_settle_autopilot_handoff(
  bigint, text, text, text, timestamptz)
  to authenticated;
