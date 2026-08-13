-- 20260813_025743_app_add_job.sql
--
-- `public.app_add_job`: the quick-add write (PR #182, Step A of the
-- integrator's sequencing). One RPC that tracks one confirmed posting for the
-- calling user — the write half of the surface that deletes the product's last
-- Sheet instruction. The read half (`resolveJobLinks`) is deliberately NOT a
-- database function: resolution is app-layer TypeScript
-- (`webapp/lib/quickadd/resolve.ts`) whose duplicate lookup goes through the
-- `user_postings` RLS policies, so there is nothing for SQL to add there.
--
-- THE CALL CONTRACT is the one `webapp/lib/data/supabase-source.ts` on
-- `feat/quickadd-surface` already sends:
--
--     app_add_job(p_key, p_url, p_company, p_title, p_idem) returns jsonb
--     → { outcome: 'added' | 'duplicate', posting: app_triage_row(...) }
--
-- `posting` is the same nested shape every other posting write returns
-- (`app_triage_row`, 0003), so `toJobView` unwraps it unchanged.
--
-- THE ONE SECURITY PROPERTY, stated where the reviewer will look:
--
--   `postings` is a globally shared table with no user_id. This function may
--   INSERT a missing row and may NEVER UPDATE an existing one — a
--   browser-reachable write that could modify an existing posting would let
--   one user rewrite the company and title of a posting in everyone else's
--   queue. The insert is `on conflict (key) do nothing`, and no branch of this
--   function updates `postings`. The per-user half (`user_postings`) is keyed
--   on `auth.uid()` alone, so a caller can only ever gate THEMSELVES onto a
--   posting.
--
-- WHERE `p_key` REALLY COMES FROM, honestly: the Next server action
-- (`webapp/app/(app)/add/actions.ts`) computes it with `jobKey(...)` from the
-- confirmed url/company/title and the browser never sends one — but this
-- function is also directly callable at `/rest/v1/rpc/app_add_job` by any
-- authenticated session, so AT THIS BOUNDARY the key is caller-supplied and
-- unverifiable: recomputing it here would be a THIRD implementation of the
-- most drift-prone function in the system, which
-- `tests/core/test_migrations.py::test_job_key_is_never_computed_in_sql`
-- exists to refuse. What contains a fabricated key instead:
--
--   * an existing posting cannot be altered (insert-only, above);
--   * the `user_postings` row is the caller's own, so the blast radius of a
--     forged key is "the caller gates themselves onto a posting", which grants
--     them SELECT of that one shared row via `postings_visible_to_gated_users`
--     (0002) — shared job-listing facts, not another user's data. Named here
--     for the independent security review to rule on, not discovered by it.
--
-- NO FETCH SURFACE: this function accepts only parsed text fields and never
-- dereferences `p_url`. The SSRF/rate-limit attack items on #182 (DNS-rebinding
-- TOCTOU in quickadd/fetch.ts, unbounded user-driven outbound fetch) live in
-- the webapp's resolver and are Step-B concerns; the database layer adds no
-- outbound request of any kind.
--
-- IDEMPOTENCY is the post-0026 shape, not 0003's manual replay (the #182 PR
-- body's sketch predates 0026 and is superseded here, per the integrator's
-- sequencing comment): `hq_command_replay` + `request_hash`, so a key reused
-- with a different command or different arguments is refused with 22023
-- instead of silently answering the first gesture's result. The replay is
-- checked before the lock and again behind it (the two-tabs-one-outbox race
-- `app_set_triage` documents at 0003:166-182).
--
-- NO version/CAS parameter, deliberately: a create has no prior version. Its
-- entire conflict class is "this already exists", and that is reported as
-- `outcome: 'duplicate'` with the existing row rather than applied twice or
-- raised at.
--
-- ENTITLEMENT is not re-implemented here. `postings`, `user_postings`,
-- `events`, and `command_idempotency` are all in 0027's gated set, so
-- `hq_entitlement_guard()` fires BEFORE ROW inside this definer exactly as it
-- fires on a raw insert: a pending or suspended account gets 42501 on the
-- first row this function tries to write, and the whole call aborts. No new
-- table, no new column, so there is no gate registration to extend
-- (`tests/db/test_default_deny.py` re-derives the set from pg_catalog and
-- would object if that claim were wrong).
--
-- The audit rule's answers, stated rather than implied:
--   * ownership   — one new function, owned by the migration role (postgres),
--                   like every app_* before it; no table changes
--   * grants      — revoke all from public, anon, authenticated BY NAME
--                   (Supabase's bootstrap grants execute to the named roles,
--                   0026's lesson); grant execute to authenticated only
--   * RLS         — no policy changes; the function is security definer and
--                   both tables it writes carry 0027's restrictive policy and
--                   trigger, which definer rights do not bypass (the trigger)
--   * constraints — none added; dedup rides the EXISTING primary keys —
--                   postings(key) and user_postings(user_id, posting_key) —
--                   so there is no new index and nothing to drift
--   * search_path — pinned `public, pg_temp` on the one definer below

/**
 * Track one posting the user confirmed on the quick-add surface.
 *
 * Inserts the shared `postings` row iff the natural key is new (NEVER an
 * update), gates the caller onto it via `user_postings`
 * (disposition 'qualified', reason 'added:you'), appends the audit event, and
 * stores the durable result under the caller's idempotency key. "Nothing
 * inserted into user_postings" IS the duplicate outcome — the primary key is
 * the dedup.
 *
 * Bounds mirror the server action's (`webapp/app/(app)/add/actions.ts`):
 * company/title ≤ 200 (MAX_FIELD), url ≤ 2048 (MAX_URL). The key bound is
 * 2052 = 4 + 2048, the worst case of the `url-` fallback key over a
 * maximum-length URL — the #182 sketch's 200 would refuse a legitimate add of
 * an unreadable posting behind a long aggregator link, because such a row has
 * no title for a `norm-` key and falls back to keying on the URL itself.
 *
 * `p_url` may be '' (a typed-in row has no link) but a non-empty value must
 * not smuggle a scheme the app would render as an executable href: the
 * resolver's own allowlist (`looksAddressable`) refuses `javascript:` and
 * `data:` in the browser tier, and a direct PostgREST caller skips that tier,
 * so the refusal is repeated at this boundary. Scheme-less values pass — a
 * bare host is the most common paste in the product and the resolver's
 * absolute form is a courtesy, not a contract.
 */
create or replace function public.app_add_job(
  p_key     text,
  p_url     text,
  p_company text,
  p_title   text,
  p_idem    text
)
returns jsonb
language plpgsql
security definer
-- Pinned: a security-definer function that inherits the caller's search_path
-- can be made to call a shadowed function. Standard hardening, not optional.
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_key     text := public.hq_blank_trim(p_key);
  v_url     text := public.hq_blank_trim(p_url);
  v_company text := public.hq_blank_trim(p_company);
  v_title   text := public.hq_blank_trim(p_title);
  v_posting public.postings;
  v_row     public.user_postings;
  v_added   boolean := false;
  v_outcome text;
  v_result  jsonb;
  -- The payload fingerprint this key is scoped to; `hq_command_replay` refuses
  -- a second use of the key with a different one (22023). Built from the
  -- NORMALISED values, so a retry differing only in whitespace is still the
  -- same gesture.
  v_fp      text;
begin
  -- `authenticated` is the only role granted execute, so this is unreachable
  -- today — which is why it is here. The day a service-role lane or a new
  -- grant appears, this is the line that refuses a row with a null user_id.
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- The BLANK key matters as much as the missing one: `command_idempotency`'s
  -- primary key is (user_id, idem_key) and '' is a legal text value, so one
  -- caller sending an empty key would have every later empty key replay the
  -- first gesture forever.
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- A row with nothing to key on is refused, in words, before anything is
  -- written — the natural key is the identity every funnel shares, and a
  -- keyless posting is a row nothing can ever match or dedup against.
  if v_key = '' then
    raise exception 'a job needs a key to be tracked under' using errcode = '22023';
  end if;
  if length(v_key) > 2052 then
    raise exception 'key too long: % characters', length(v_key)
      using errcode = '22023';
  end if;

  if length(v_url) > 2048 then
    raise exception 'url too long: % characters', length(v_url)
      using errcode = '22023';
  end if;
  -- A scheme other than http(s) is refused. `postings.url` is rendered as an
  -- href across the app, and the browser-tier allowlist that keeps
  -- `javascript:` out of it does not bind a direct PostgREST caller.
  if v_url <> ''
     and v_url ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
     and v_url !~* '^https?://' then
    raise exception 'only http(s) links can be stored' using errcode = '22023';
  end if;

  if length(v_company) > 200 then
    raise exception 'company too long: % characters', length(v_company)
      using errcode = '22023';
  end if;
  if length(v_title) > 200 then
    raise exception 'title too long: % characters', length(v_title)
      using errcode = '22023';
  end if;

  v_fp := public.hq_command_fingerprint(
            jsonb_build_array(v_key, v_url, v_company, v_title));

  -- Replay: return the first result rather than applying twice. Raises 22023
  -- when this key was first used by another command or with other arguments.
  v_result := public.hq_command_replay(v_user, p_idem, 'app_add_job', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- The shared half. INSERT-ONLY: `do nothing`, never `do update` — see the
  -- header for what an update here would hand one user over everyone else's
  -- queue. An existing posting keeps its facts even when the caller's
  -- confirmed fields differ; the caller still gets gated onto it below, and
  -- the row they see is the shared one, which is the honest answer.
  --
  -- `posted` stays null: this surface does not know when the job was posted,
  -- and 0001's rule is null over a guess. `first_seen`/`last_seen` are today —
  -- the day this system first saw the posting is the day the user pasted it.
  insert into public.postings
    (key, company, title, location, url, first_seen, last_seen, status, source)
  values
    (v_key, v_company, v_title, '', v_url, current_date, current_date,
     'New', 'quickadd')
  on conflict (key) do nothing;

  -- Lock the posting row for the rest of the transaction, whichever call
  -- created it. Serialises two concurrent adds of the same posting so exactly
  -- one of them inserts the user_postings row below and the other reads it.
  select * into v_posting
    from public.postings
   where key = v_key
     for update;
  -- The insert hit the conflict arm AND the row is gone by the time we lock:
  -- a concurrent erasure. Fail loud rather than gate the user onto nothing.
  if not found then
    raise exception 'conflict: this posting was removed while you were saving'
      using errcode = '40001';
  end if;

  -- Re-check the key with the row LOCKED. The check above only settles
  -- sequential replays; two tabs flushing one outbox on the same 'online'
  -- event both pass it before either writes, and the loser would otherwise
  -- apply a second time (0003:166-182, the two-tabs-one-outbox race).
  v_result := public.hq_command_replay(v_user, p_idem, 'app_add_job', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- The per-user half. The PK (user_id, posting_key) is the dedup: nothing
  -- inserted ⇒ this user already tracks the posting ⇒ the duplicate outcome.
  -- No new index needed. Ownership is auth.uid() and nothing else — there is
  -- no parameter that could name another user.
  insert into public.user_postings
    (user_id, posting_key, disposition, disposition_reason)
  values
    (v_user, v_key, 'qualified', 'added:you')
  on conflict (user_id, posting_key) do nothing;
  v_added := found;
  v_outcome := case when v_added then 'added' else 'duplicate' end;

  select * into v_row
    from public.user_postings
   where user_id = v_user and posting_key = v_key;
  if not found then
    raise exception 'conflict: this row was removed while you were saving'
      using errcode = '40001';
  end if;

  -- The audit event, in the same transaction as the write. A duplicate gesture
  -- is still a gesture somebody made and gets its event with its outcome; a
  -- REPLAY is the same gesture arriving twice and returned above before
  -- reaching this line, so one gesture appends exactly one event.
  insert into public.events (user_id, kind, posting_key, payload, actor)
  values (v_user, 'action.add_job', v_key,
          jsonb_strip_nulls(jsonb_build_object(
            'url',     nullif(v_url, ''),
            'key',     v_key,
            'outcome', v_outcome,
            'idem',    p_idem)),
          'user');

  -- The row the client renders, from inside the transaction that wrote it —
  -- `app_triage_row` (0003), so this write's payload and every other posting
  -- write's payload cannot drift apart, and `toJobView` unwraps it unchanged.
  v_result := jsonb_build_object(
    'outcome', v_outcome,
    'posting', public.app_triage_row(v_row));

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_add_job', v_fp, v_result)
  -- Two racing calls with the same key: whichever lost still returns the same
  -- shape, and the row it wrote is identical.
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_add_job(text, text, text, text, text) is
  'quick add: track one confirmed posting for the calling user — inserts the shared postings row iff the key is new (never updates one), gates the caller via user_postings (the PK is the dedup), idempotent on p_idem via hq_command_replay + request_hash, one audit event per gesture';

-- Named revokes, not `from public` alone: Supabase's bootstrap grants execute
-- on new functions to `anon` and `authenticated` BY NAME, and revoking from
-- `public` does not touch a grant made to a named role (0026's lesson; the
-- KNOWN_UNNAMED_REVOKES debt list in tests/core/test_migrations.py is exactly
-- the set of older functions that got this wrong).
revoke all on function public.app_add_job(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.app_add_job(text, text, text, text, text)
  to authenticated;
