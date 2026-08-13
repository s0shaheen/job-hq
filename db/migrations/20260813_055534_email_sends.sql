-- 20260813_055534_email_sends.sql
--
-- #203: the transactional-email send ledger and the suppression list — the
-- durable half of account-lifecycle mail (activation, suspension, and the
-- deletion confirmation #204 will need). The provider half lives in
-- webapp/lib/email/; this file is what makes a send IDEMPOTENT against the RPC
-- replays that trigger it, and what makes "never mail this address again" a
-- fact in the store rather than a memory in a process.
--
-- THE TRIGGER RECORD ALREADY EXISTS. `hq_activate_user` / `hq_suspend_user`
-- (0027) each write an `events` row in-transaction, and a REPLAY of either
-- writes no second event (`changed: false` returns before the insert). So the
-- send path CONSUMES those rows — `hq_email_pending_lifecycle()` below — and
-- keys each send on the event's id. No HTTP call sits inside any RPC: mail
-- failure must never cost the action it rides on (the digest lane's doctrine).
--
-- WHY A CLAIM/RESULT PAIR AND NOT ONE "SEND HAPPENED" INSERT. The attack that
-- matters is a crash AFTER the provider accepted and BEFORE any record was
-- written: re-running would send twice, and the second copy of "your account
-- is on" tells a person something broke. So the ledger row is written FIRST
-- (`hq_email_claim_send`, status `claimed`), the provider is called only for a
-- fresh claim, and the outcome lands by UPDATE (`hq_email_record_send`). A
-- crash between accept and record leaves a `claimed` row that no re-run will
-- ever claim again — the ambiguous outcome stays ambiguous and is never
-- blindly retried, exactly the `outcome_unknown` posture Autopilot takes.
--
-- WHY `on delete cascade` AND NOT `set null` ON user_id: `recipient` and
-- `address` are the user's email address, and
-- tests/db/test_deletion_cascade.py sweeps every table for the deleted
-- account's identifiers after a hard delete — the only sanctioned survivors
-- are the invite row and the storage object. A ledger row that outlived its
-- account would be a new PII survivor class. The cost is honest and named:
-- #204's deletion-confirmation ledger row cannot live here past the delete,
-- so its durable record belongs to #204's deletion ledger, not this table.
--
-- Grants: browser roles get NOTHING — no select, no DML, no execute. These
-- tables carry addresses and send outcomes no product surface is designed to
-- show; the only reader and writer is the server lane (service_role), same as
-- notification_outbox. The entitlement pair is attached anyway, armed for the
-- day a future migration grants a read (the 20260803_105951 rationale).
--
-- Before merging, audit: ownership, grants, RLS policies, constraints, and the
-- search_path on any security-definer function. (None of the functions below
-- is security definer — they run with the caller's rights, and the only
-- granted caller is service_role. 0018/0027's pattern.)
--
-- THIS FILE IS ALSO TYPESCRIPT INPUT. webapp/tests/unit/types-contract.test.ts
-- parses these CREATE TABLE bodies; neither table below is covered by a type
-- in webapp/lib/types.ts (no browser surface reads them), so no type edit
-- rides this commit.

-- ============================================================ the send ledger

create table public.email_sends (
  id bigint generated always as identity primary key,

  -- The account the mail is about. `not null` + cascade: see the header.
  user_id uuid not null references public.users (id) on delete cascade,

  -- A closed vocabulary this migration owns end to end (the 0027 `status`
  -- precedent). The deletion kind is declared now so #204 lands data, not DDL.
  kind text not null check (kind in (
    'lifecycle.activation',
    'lifecycle.suspension',
    'lifecycle.deletion_confirmation'
  )),

  -- THE IDEMPOTENCY LATCH. For entitlement mail this is 'evt:<events.id>' —
  -- minted by hq_email_pending_lifecycle from the audit row the operator RPC
  -- wrote, so a replayed hq_activate_user (which writes no second event)
  -- cannot mint a second key. Globally unique: events.id is, and #204's keys
  -- will carry their own prefix.
  send_key text not null,
  constraint email_sends_send_key_unique unique (send_key),

  -- The address AT SEND TIME. users.email can change later; what was mailed
  -- cannot, and an audit that answers "what did we send, where" must not
  -- re-derive the address through a join that no longer says what happened.
  recipient text not null check (recipient <> ''),

  -- claimed    — the row is minted, the provider call is (or was) in flight.
  --              A row stuck here is a crash between accept and record: an
  --              ambiguous outcome, kept ambiguous, never blindly retried.
  -- sent       — the provider accepted; provider_message_id says which mail.
  -- skipped    — the flag was off (no key / no sender); recorded, not dropped.
  -- suppressed — the address is on email_suppressions; reason names why.
  -- failed     — the provider refused (4xx/5xx); reason carries its answer.
  -- unknown    — the provider call itself died mid-flight with no answer.
  status text not null default 'claimed' check (status in (
    'claimed', 'sent', 'skipped', 'suppressed', 'failed', 'unknown'
  )),

  -- Which implementation answered: 'resend', 'fixture', or '' while claimed /
  -- when no provider was consulted (skipped, suppressed).
  provider text not null default '',

  provider_message_id text not null default '',

  -- Why a non-sent row is not sent. The tracker/outbox rule applies: every
  -- outcome string names what actually occurred.
  reason text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A sent row names its message; a row that never reached a provider must
  -- not carry one. Total, like notification_outbox_closed_has_outcome.
  constraint email_sends_sent_has_message_id
    check ((status = 'sent') = (provider_message_id <> ''))
);

comment on table public.email_sends is
  'The transactional-mail ledger (#203): one row per attempted lifecycle send, '
  'claimed BEFORE the provider is called so a crash after provider-accept can '
  'never double-send. send_key is the idempotency latch (evt:<events.id> for '
  'entitlement mail). Server lane only; no browser path.';

comment on column public.email_sends.send_key is
  'idempotency key, globally unique: evt:<events.id> for entitlement lifecycle '
  'mail — a replayed operator RPC writes no second event, so no second key';

drop trigger if exists email_sends_touch on public.email_sends;
create trigger email_sends_touch before update on public.email_sends
  for each row execute function public.touch_updated_at();

-- The dispatch read: "is this event already handled" is a probe of send_key
-- (the unique constraint's index answers it). This one serves the per-user
-- audit question and the cascade.
create index email_sends_user_idx on public.email_sends (user_id, created_at);

-- ============================================================ the suppression list

create table public.email_suppressions (
  id bigint generated always as identity primary key,

  -- The account whose address this is. Suppression rows cascade with the
  -- account for the same PII-survivor reason as the ledger; an address with
  -- no account has nothing lifecycle mail would ever be sent to.
  user_id uuid not null references public.users (id) on delete cascade,

  -- Stored lowercased (the check makes half-normalized rows unrepresentable);
  -- the unique index below is the actual "never again" guarantee.
  address text not null check (address = lower(address) and address <> ''),

  -- 'bounce' | 'complaint' | 'manual' — who told us to stop. Closed, owned here.
  reason text not null check (reason in ('bounce', 'complaint', 'manual')),

  -- Which provider (or operator) reported it: 'resend', 'operator', …
  source text not null default '',

  created_at timestamptz not null default now()
);

comment on table public.email_suppressions is
  'Addresses transactional mail must never be sent to (#203): bounces, '
  'complaints, and operator holds. Consulted inside hq_email_claim_send, so a '
  'send path that forgets to check cannot exist. Server lane only.';

-- One suppression per address. `do nothing` on conflict in the recorder: the
-- first reason stands — "stop mailing this" does not get less true twice.
create unique index email_suppressions_address_idx
  on public.email_suppressions (address);

-- ============================================================ RLS

alter table public.email_sends enable row level security;
alter table public.email_suppressions enable row level security;

-- NO BROWSER PATH AT ALL — read or write — and the notification_outbox shape
-- verbatim: the self-read policy is written and then the privilege is revoked
-- out from under it, so a future `grant select` (a "what mail did I get"
-- surface, if one is ever designed) is correct on arrival instead of open on
-- arrival.
create policy email_sends_read on public.email_sends
  for select using (user_id = auth.uid());
create policy email_suppressions_read on public.email_suppressions
  for select using (user_id = auth.uid());

revoke select, insert, update, delete, truncate on public.email_sends
  from public, anon, authenticated;
revoke select, insert, update, delete, truncate on public.email_suppressions
  from public, anon, authenticated;

-- ============================================================ entitlement gate
--
-- A table created after 0027 inherits nothing (20260803_105950's lesson). With
-- every browser privilege revoked these tables sit outside the sweep's
-- browser-reachable set today; the pair is attached so a later grant cannot
-- un-gate them by omission.

create policy email_sends_entitled on public.email_sends
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

create policy email_suppressions_entitled on public.email_suppressions
  as restrictive for all
  using (public.hq_is_entitled())
  with check (public.hq_is_entitled());

create trigger email_sends_entitlement_guard
  before insert or update or delete on public.email_sends
  for each row execute function public.hq_entitlement_guard();

create trigger email_suppressions_entitlement_guard
  before insert or update or delete on public.email_suppressions
  for each row execute function public.hq_entitlement_guard();

-- ============================================================ the dispatch read

/**
 * Every entitlement lifecycle event that has no ledger row yet, with the
 * recipient facts the templates need — and NOTHING else. No jobs, no notes,
 * no counts: the private-content rule is enforced by this being the send
 * path's only read.
 *
 * Keyed on the audit row 0027 already writes: a replay of hq_activate_user
 * returns `changed: false` before its event insert, so a replay adds nothing
 * here — idempotency is inherited from the RPC's own contract and then
 * enforced a second time by email_sends_send_key_unique.
 *
 * Oldest first, bounded: a dispatcher that dies mid-batch resumes at the same
 * front of the queue, and an unbounded read of a table that only grows is a
 * slow request waiting to happen.
 *
 * Not security definer (caller's rights; only service_role may execute), and
 * it takes no user id — it answers for the whole store, which is exactly why
 * browser roles hold nothing on it.
 */
create or replace function public.hq_email_pending_lifecycle(
  p_limit int default 50
)
returns table (
  send_key    text,
  user_id     uuid,
  event_kind  text,
  email       text,
  name        text,
  occurred_at timestamptz
)
language sql
stable
set search_path = public, pg_temp
as $$
  select 'evt:' || ev.id,
         ev.user_id,
         ev.kind,
         u.email,
         u.name,
         ev.occurred_at
    from public.events ev
    join public.users u on u.id = ev.user_id
   where ev.kind in ('entitlement.activated', 'entitlement.suspended')
     and not exists (select 1 from public.email_sends s
                      where s.send_key = 'evt:' || ev.id)
   order by ev.occurred_at, ev.id
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function public.hq_email_pending_lifecycle(int) is
  'server lane only: entitlement lifecycle events with no email_sends row yet, '
  'oldest first — the dispatch read for #203 transactional mail';

revoke all on function public.hq_email_pending_lifecycle(int)
  from public, anon, authenticated;
grant execute on function public.hq_email_pending_lifecycle(int) to service_role;

-- ============================================================ the claim

/**
 * Mint the ledger row for one send, BEFORE any provider is called.
 *
 * Three answers, one shape — jsonb with `claimed` and `status`:
 *
 *   fresh key, clean address → {claimed: true,  status: 'claimed'}: the caller
 *     may contact the provider, exactly once, and must record what came back.
 *   fresh key, suppressed    → {claimed: false, status: 'suppressed', reason}:
 *     a TERMINAL row is written naming which suppression applied. The refusal
 *     is recorded, not retried — the key is now taken, so no later dispatch
 *     asks again.
 *   taken key                → {claimed: false, status: <existing>}: somebody
 *     already handled (or is handling, or died handling) this send. The
 *     insert-first design makes this the dedupe: the unique constraint, not a
 *     read-then-write race, decides who holds the claim.
 *
 * Fails loud on a user that does not exist, a kind outside the vocabulary
 * (the CHECK raises), and a blank recipient — nothing guesses.
 */
create or replace function public.hq_email_claim_send(
  p_send_key  text,
  p_user_id   uuid,
  p_kind      text,
  p_recipient text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_recipient   text := lower(public.hq_blank_trim(p_recipient));
  v_suppression public.email_suppressions%rowtype;
  v_existing    public.email_sends%rowtype;
  v_id          bigint;
begin
  if public.hq_blank_trim(p_send_key) = '' then
    raise exception 'hq_email_claim_send needs a send key' using errcode = '22023';
  end if;
  if p_user_id is null then
    raise exception 'hq_email_claim_send needs the user the mail is about'
      using errcode = '22023';
  end if;
  if v_recipient = '' then
    raise exception 'hq_email_claim_send needs a recipient address'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'no such user: %', p_user_id using errcode = '23503';
  end if;

  select * into v_suppression from public.email_suppressions
   where address = v_recipient;

  if found then
    insert into public.email_sends (user_id, kind, send_key, recipient, status, reason)
    values (p_user_id, p_kind, p_send_key, v_recipient, 'suppressed',
            format('suppressed: %s (%s, %s)',
                   v_suppression.reason,
                   coalesce(nullif(v_suppression.source, ''), 'unrecorded source'),
                   v_suppression.created_at::date))
    on conflict (send_key) do nothing
    returning id into v_id;

    if v_id is null then
      select * into v_existing from public.email_sends where send_key = p_send_key;
      return jsonb_build_object('claimed', false, 'status', v_existing.status,
                                'reason', v_existing.reason);
    end if;

    select * into v_existing from public.email_sends where id = v_id;
    return jsonb_build_object('claimed', false, 'status', 'suppressed',
                              'reason', v_existing.reason);
  end if;

  insert into public.email_sends (user_id, kind, send_key, recipient)
  values (p_user_id, p_kind, p_send_key, v_recipient)
  on conflict (send_key) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from public.email_sends where send_key = p_send_key;
    return jsonb_build_object('claimed', false, 'status', v_existing.status,
                              'reason', v_existing.reason);
  end if;

  return jsonb_build_object('claimed', true, 'status', 'claimed', 'id', v_id);
end;
$$;

comment on function public.hq_email_claim_send(text, uuid, text, text) is
  'server lane only: mint the ledger row for one send before any provider call. '
  'The unique send_key is the dedupe; a suppressed address gets a terminal '
  'suppressed row naming which suppression applied.';

revoke all on function public.hq_email_claim_send(text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_email_claim_send(text, uuid, text, text)
  to service_role;

-- ============================================================ the outcome

/**
 * Land the provider's answer on the claim — and ONLY on a claim.
 *
 * The row must exist and must still be `claimed`: recording a result for a
 * send nobody claimed is a harness bug, and re-recording a terminal row would
 * let a confused caller overwrite 'sent' with 'failed' (or worse, the other
 * direction). Both raise. `sent` requires the provider message id and every
 * other status forbids it — the table CHECK enforces it; the argument check
 * here just names the mistake before the constraint's colder message does.
 */
create or replace function public.hq_email_record_send(
  p_send_key            text,
  p_status              text,
  p_provider            text default '',
  p_provider_message_id text default '',
  p_reason              text default ''
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_row public.email_sends%rowtype;
begin
  if p_status not in ('sent', 'skipped', 'failed', 'unknown') then
    raise exception 'hq_email_record_send: % is not a recordable outcome', p_status
      using errcode = '22023';
  end if;
  if (p_status = 'sent') <> (coalesce(p_provider_message_id, '') <> '') then
    raise exception
      'hq_email_record_send: sent requires a provider message id and % forbids one',
      p_status
      using errcode = '22023';
  end if;

  update public.email_sends
     set status              = p_status,
         provider            = coalesce(p_provider, ''),
         provider_message_id = coalesce(p_provider_message_id, ''),
         reason              = coalesce(p_reason, '')
   where send_key = p_send_key and status = 'claimed'
  returning * into v_row;

  if v_row.id is null then
    raise exception
      'hq_email_record_send: no claimed row for key % — either nothing claimed it or its outcome is already recorded',
      p_send_key
      using errcode = 'P0002';
  end if;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status,
                            'provider_message_id', v_row.provider_message_id);
end;
$$;

comment on function public.hq_email_record_send(text, text, text, text, text) is
  'server lane only: land one outcome on one claimed ledger row. Refuses an '
  'unclaimed key and refuses to overwrite a terminal row.';

revoke all on function public.hq_email_record_send(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_email_record_send(text, text, text, text, text)
  to service_role;

-- ============================================================ the suppression recorder

/**
 * Record "never mail this address again."
 *
 * Called by the server lane when the provider reports a bounce or complaint
 * (the Resend webhook route lands WITH the owner's account — an unverifiable
 * webhook endpoint would be an unauthenticated suppression writer, which is a
 * denial-of-mail hole, so it waits for the signing secret) and by the operator
 * for a manual hold. Idempotent: the first reason stands.
 *
 * The address must belong to a known user — a suppression for an address this
 * store has never mailed anchors to nothing and cascades with nobody, which is
 * the PII-survivor shape the deletion sweep forbids.
 */
create or replace function public.hq_email_suppress(
  p_address text,
  p_reason  text,
  p_source  text default ''
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_address text := lower(public.hq_blank_trim(p_address));
  v_user    uuid;
  v_id      bigint;
begin
  if v_address = '' then
    raise exception 'hq_email_suppress needs an address' using errcode = '22023';
  end if;
  if p_reason not in ('bounce', 'complaint', 'manual') then
    raise exception 'hq_email_suppress: % is not a suppression reason', p_reason
      using errcode = '22023';
  end if;

  select id into v_user from public.users where lower(email) = v_address;
  if v_user is null then
    raise exception 'hq_email_suppress: no user holds address %', v_address
      using errcode = 'P0002';
  end if;

  insert into public.email_suppressions (user_id, address, reason, source)
  values (v_user, v_address, p_reason, coalesce(p_source, ''))
  on conflict (address) do nothing
  returning id into v_id;

  return jsonb_build_object('suppressed', true, 'created', v_id is not null);
end;
$$;

comment on function public.hq_email_suppress(text, text, text) is
  'server lane only: record a bounce/complaint/manual hold for an address. '
  'Idempotent — the first reason stands.';

revoke all on function public.hq_email_suppress(text, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_email_suppress(text, text, text) to service_role;
