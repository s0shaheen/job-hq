-- 0019 — the emailed decision: one triage applied by a signed link, with no session.
--
-- SHEET-SUNSET Phase C3, the click lane. `docs/plans/PHASE-DIGEST.md` §3: the
-- digest email carries an **Interested** and a **Not for me** link per posting,
-- each a signed token minted by `core/digest_links.py`. The person taps one from
-- a mail client's in-app browser, on a phone, having never signed in. This is the
-- write that happens at the end of that tap.
--
-- A LINK'S SINGLE-USE GUARANTEE IS A `command_idempotency` ROW (0003), keyed on
-- the token's `jti` — there is no `digest_tokens` table (that trade is argued in
-- `core/digest_links.py`). So this lane now DEPENDS on those rows outliving the
-- links that reference them: 0003 keeps them forever and has no retention job,
-- which is what makes the guarantee hold. If a sweep is ever added there it must
-- keep rows at least as long as `ACTION_TTL_SECONDS` (7 days,
-- webapp/lib/digest/token.ts), or every emailed link silently becomes multi-use
-- the day its row is pruned out from under it.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY `app_set_triage` CANNOT BE THE FUNCTION THAT RUNS
--
-- 0003's function derives the acting user from `auth.uid()` and is granted to
-- `authenticated`. Both halves of that are exactly right for the browser and
-- exactly wrong here: a token route has no cookie, no session and no JWT, so
-- `auth.uid()` is NULL and the call raises `not authenticated` before it reads a
-- row. The caller is a Next.js route handler holding the service role
-- (`webapp/lib/supabase/service.ts`), acting for a user it learned from an
-- HMAC-signed payload rather than from a login.
--
-- So the user arrives as an ARGUMENT, and that is precisely why this function is
-- **NOT `security definer`**. Those two facts belong together — 0015 and 0018 say
-- the same sentence, and `tests/core/test_migrations.py::
-- test_definer_functions_never_take_a_user_id` is the mechanism behind it: a
-- definer function that acts as whoever it is asked to act as is an authorization
-- bypass with extra steps. This runs with the CALLER's rights, the caller is
-- `service_role`, and service_role bypasses RLS anyway — so definer would buy
-- nothing and cost the one guard that keeps a browser from naming somebody else's
-- user id. `search_path` is still pinned: cheap, and a shadowed function inside a
-- non-definer body is still a function this code did not mean to call.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY THE BODY IS `app_set_triage`'s, COPIED
--
-- 0006 already accepted this trade for the bulk variant and stated it: "it
-- repeats app_set_triage's body per key rather than sharing a helper,
-- deliberately — the single-row function is the one the whole system already
-- leans on, and coupling a rarely-used path into it would put every triage one
-- refactor away from breakage. The behaviour is pinned independently in tests,
-- and that agreement is a test, not an abstraction."
--
-- The same reasoning holds with one addition specific to this caller: the two
-- functions have DIFFERENT authorization stories (a session versus a signed
-- token) and different argument lists, so the shared helper would have to take
-- the acting user as a parameter — which is the definer-shaped hole above,
-- rebuilt one layer down. `tests/db/test_digest_action.py` is the pin.
--
-- WHAT IS DELIBERATELY THE SAME, because a decision must mean the same thing
-- whichever door it came through:
--
--   * a bad triage value is refused BY NAME, not by letting the CHECK surface as
--     a wall of Postgres text;
--   * the idempotency key is read BEFORE the row lock and AGAIN behind it (0003's
--     comment explains the concurrent-replay race that the second read closes);
--   * a gesture that changes nothing writes nothing — no `updated_at` bump, no
--     duplicate audit event;
--   * marking interested creates the `Queued` application, moving off interested
--     removes it while it is still bot-untouched (acceptance criteria 9 and 11);
--   * the audit event has the same kinds, the same columns and `actor = 'user'`,
--     because the user really is who decided. The door is recorded in the payload
--     (`"via": "digest"`), which is what an incident actually asks.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY DIFFERENT
--
-- **No expected-version argument.** `app_set_triage` takes one because a browser
-- read the row a moment ago and can hand back the instant it saw; an emailed link
-- holds no version token and never could — it was minted days earlier, before the
-- row had the value it has now. Refusing on staleness would turn "I opened
-- Monday's email on Saturday" into an error page. The concurrency story here is
-- the other two mechanisms instead: the idempotency key (the token's `jti`) makes
-- a replay return the first answer, and a row that somebody already decided
-- renders as *already decided* with the reverse offered in one tap, which is a
-- better answer than a conflict banner nobody can act on from a phone.
--
-- **No `snoozed`.** A snooze needs a wake date and an emailed link has no way to
-- ask for one; 0003 raises on a dateless snooze for that reason. Refused by name
-- here rather than accepted and silently turned into something else.
--
-- **`''` IS a legal value.** It is the Undo, and Undo is the whole reason a
-- one-tap action from an inbox is safe to offer.
--
-- **`triage_reason` is left alone on a no-op.** 0003 clears the reason whenever
-- the caller passes none, which is right for a form that had a reason field and
-- left it empty. This caller has no reason field at all, so a re-tap of a link
-- for a decision the row already carries must not quietly erase a note the human
-- typed in the app. On a real CHANGE the reason does clear, because a reason
-- written for a superseded decision is worse than no reason.

create or replace function public.hq_digest_set_triage(
  p_user_id     uuid,
  p_posting_key text,
  p_triage      text,
  p_idem        text
)
returns jsonb
language plpgsql
-- Pinned even without `security definer`: a shadowed `app_triage_row` in a
-- caller's search_path is still a function this body did not mean to call.
set search_path = public, pg_temp
as $$
declare
  v_row    public.user_postings;
  v_status text;
  v_result jsonb;
  v_app_id bigint;
begin
  if p_user_id is null then
    raise exception 'hq_digest_set_triage needs the user the link was minted for'
      using errcode = '22023';
  end if;

  if p_idem is null or length(p_idem) = 0 or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- The CHECK on user_postings would catch a bad value too, and 'snoozed' would
  -- pass it — so the closed set is named here. `''` is in it on purpose: that is
  -- the Undo.
  if p_triage is null or p_triage not in ('', 'interested', 'dismissed') then
    raise exception 'invalid triage value: %', p_triage using errcode = '22023';
  end if;

  -- Replay, before anything is locked. The `jti` inside the signed token is the
  -- key, so the same emailed link tapped twice next week returns the answer the
  -- first tap produced rather than applying a second time.
  --
  -- Scoped to the POSTING too (C3 review m1). The key is `(user_id, idem_key)` and
  -- a `jti` is 128 random bits minted per (user, posting, action), so a collision
  -- across two of one user's postings is not reachable — but a replay that
  -- returned a row the caller never named would let the success page put the
  -- wrong company on "Saved …", and the guard is one predicate. A stored result
  -- for a different posting is treated as no replay: the call falls through to the
  -- row lookup for `p_posting_key`, which is the posting the token actually signs.
  select result into v_result
    from public.command_idempotency
   where user_id = p_user_id and idem_key = p_idem
     and result->>'posting_key' = p_posting_key;
  if found then
    return v_result;
  end if;

  select * into v_row
    from public.user_postings
   where user_id = p_user_id and posting_key = p_posting_key
     for update;

  -- The row belongs to a user, and the user came out of the signature. A token
  -- for one person against a posting only another person was gated therefore
  -- lands here and reveals nothing about it (matrix row 40). The route renders
  -- this as "no longer listed", the same page a closed posting gets.
  if not found then
    raise exception 'no such posting for this user: %', p_posting_key
      using errcode = 'P0002';
  end if;

  -- A CLOSED board listing is refused here, not just at the route (C3 review M1).
  -- `digestGet` renders "no longer listed" for a closed posting; a POST that then
  -- wrote a triage and minted a `Queued` application for a dead listing (row 41's
  -- exact scenario: Safe Links GETs, the human taps hours later, the board has
  -- closed it) would contradict the page they saw. The route checks first; this
  -- is the layer that also closes the race where it closes between GET and POST,
  -- and the guard against a direct RPC call. Same errcode as not-found, because
  -- the user-facing answer is the same "no longer listed" and the store maps both
  -- to the `gone` page — a first tap only; a REPLAY was already answered above,
  -- so a decision made before the board closed still renders its recorded result.
  select status into v_status from public.postings where key = p_posting_key;
  if v_status = 'Closed' then
    raise exception 'posting no longer open: %', p_posting_key
      using errcode = 'P0002';
  end if;

  -- Again, behind the lock. 0003's reason, and it applies harder to this caller:
  -- a mail gateway that prefetches links can fire two requests for one token
  -- within milliseconds of each other, so both pass the check above before either
  -- writes. Re-reading here makes the loser a replay, which is what it always was.
  -- Scoped to the posting for the same reason as the pre-lock read (m1).
  select result into v_result
    from public.command_idempotency
   where user_id = p_user_id and idem_key = p_idem
     and result->>'posting_key' = p_posting_key;
  if found then
    return v_result;
  end if;

  -- A gesture that changes nothing writes nothing.
  --
  -- The UPDATE below bumps `updated_at` unconditionally, and `updated_at` is the
  -- version token every open tab in the app is holding. Re-tapping a link for the
  -- decision the row already carries would invalidate all of them and append a
  -- second audit event about a write that changed nothing.
  --
  -- `snooze_until is null` is part of "unchanged" because none of the three legal
  -- values here is `snoozed`: a row that still carries a wake date is a row this
  -- gesture really does alter, and treating it as a no-op would leave a dismissed
  -- posting that reanimates itself.
  if v_row.triage = p_triage and v_row.snooze_until is null then
    v_result := public.app_triage_row(v_row);
    insert into public.command_idempotency (user_id, idem_key, command, result)
    values (p_user_id, p_idem, 'hq_digest_set_triage', v_result)
    on conflict (user_id, idem_key) do nothing;
    return v_result;
  end if;

  update public.user_postings
     set triage        = p_triage,
         -- Cleared on a real change: a reason typed for the decision this one
         -- replaces is stale, and the link carries none to put in its place.
         triage_reason = '',
         -- Clearing or flipping the triage clears the wake date with it; a
         -- dismissed row carrying a stale snooze date is a row that comes back.
         snooze_until  = null,
         updated_at    = now()
   where user_id = p_user_id and posting_key = p_posting_key
   returning * into v_row;

  if p_triage = 'interested' then
    -- `not exists` rather than an existence check in the route: two taps that
    -- somehow slip past the row lock must not produce two applications.
    insert into public.applications (user_id, posting_key, company, title, url, status)
    select p_user_id, p.key, p.company, p.title, p.url, 'Queued'
      from public.postings p
     where p.key = p_posting_key
       and not exists (
         select 1 from public.applications a
          where a.user_id = p_user_id and a.posting_key = p_posting_key)
    returning id into v_app_id;
  else
    -- Moving away from interested removes the application it created, but only
    -- while it is still bot-untouched (acceptance criterion 11): once a
    -- confirmation email has advanced it, the row is evidence of something that
    -- really happened. Undo (`''`) and a change of mind take the same path, which
    -- is 0003's rule generalised the same way.
    delete from public.applications
     where user_id = p_user_id
       and posting_key = p_posting_key
       and status = 'Queued';
  end if;

  -- Append-only: an undo appends a compensating event and never deletes the
  -- original (acceptance criterion 10). `actor` is `'user'` because a person
  -- tapped a link in their own mail; `via` records WHICH door, which is the
  -- question an incident asks and the one the actor column cannot answer.
  insert into public.events (user_id, kind, posting_key, application_id, payload, actor)
  values (
    p_user_id,
    case p_triage
      when 'interested' then 'action.interested'
      when 'dismissed'  then 'action.dismissed'
      else                   'action.untriage'
    end,
    p_posting_key,
    v_app_id,
    jsonb_build_object('triage', p_triage, 'idem', p_idem, 'via', 'digest'),
    'user'
  );

  v_result := public.app_triage_row(v_row);

  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (p_user_id, p_idem, 'hq_digest_set_triage', v_result)
  -- Two racing taps under one key: the loser returns the same shape, and the row
  -- it would have written is identical.
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.hq_digest_set_triage(uuid, text, text, text) is
  'endpoint-only: apply one triage decision from a signed digest link (POST /d/<token>) — idempotent on the token''s jti, no session, no expected-version argument; the app''s own gesture is app_set_triage';

-- `public` is the pseudo-role; `anon` and `authenticated` hold Supabase's own
-- default grants and keep them unless named. This function takes the acting user
-- as an argument, so reachable from a browser it would let any session triage
-- anybody's queue — 0015's and 0018's sentence, and the same test pins it.
revoke all on function public.hq_digest_set_triage(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_digest_set_triage(uuid, text, text, text)
  to service_role;
