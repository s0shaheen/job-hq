-- The `resumes` bucket and its owner-scoped storage policy.
--
-- WHAT WAS MISSING, and how three merged components came to assert it as fact.
--
-- PR #104 landed the résumé product: a document a person edits, an immutable
-- artifact log, and a render service that produces files. Three of its pieces
-- name a Supabase Storage bucket and an owner-scoped policy over
-- `storage.objects` as something that already exists. Nothing created either.
-- Quoted, so the claims are on the record rather than paraphrased:
--
--   0026_resume.sql:325   "-- The object key in the `resumes` bucket.
--                          Owner-scoped by construction: see"
--   0026_resume.sql:518   comment on column resume_artifacts.storage_path —
--                         "object key in the `resumes` bucket, owner-scoped:
--                          the first 36 characters are this row's user_id
--                          (constraint) and app_record_resume_artifact refuses
--                          anything else at the door"
--   0026_resume.sql:1173  "THE OWNER-SCOPING GUARANTEE lives on the first check
--                          in this body: the path … makes 'a user's storage
--                          prefix is theirs' true against a caller posting
--                          straight to /rest/v1/rpc, rather than true only for
--                          the code path that builds the key."
--
--   webapp/lib/resume/attachment.ts, on ResumeAttachmentRef.storagePath —
--                         "`{user_id}/{artifact_id}/{filename}`. The leading
--                          segment is the owner and that is load-bearing: it is
--                          what the STORAGE POLICY matches on"
--   …and on ResumeArtifactStore —
--                         "Both methods are owner-scoped by the STORAGE POLICY,
--                          not by this interface"
--
--   db/test-harness.sql, § storage (0026) —
--                         "the policy is `(storage.foldername(name))[1] =
--                          auth.uid()::text` … With this stub,
--                          `tests/db/test_rls.py` can `set role authenticated`
--                          and prove that user A cannot read user B's résumé
--                          PDF" — and no such test existed, because no such
--                          policy existed. The stub stood up a `storage` schema
--                          with RLS never enabled and zero policies: a table any
--                          signed-in role could read end to end.
--
-- So `app_record_resume_artifact`'s refusal was the ONLY owner-scoping in the
-- system, and it guards the LEDGER ROW, not the bytes. A caller with nothing but
-- the anon key and a JWT could POST to /storage/v1/object/resumes/<anyone>/…
-- and GET it back; the row would be missing and the file would not care. Every
-- one of the three comments above described a control that was not there.
--
-- This file writes it. It is a T3 change: a new authorization boundary on a
-- table this schema does not own.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY THE PREDICATE IS A PREFIX COMPARE AND NOT `storage.foldername(name)[1]`
--
-- The harness comment proposed the foldername form, which is what Supabase's own
-- examples use. This file uses `left(name, 37) = auth.uid()::text || '/'`
-- instead, for one reason: it is CHARACTER-FOR-CHARACTER the rule the database
-- already enforces one layer up.
--
--   0026, the CHECK:  storage_path = user_id::text || substring(storage_path from 37)
--   0026, the RPC:    if left(v_path, 37) <> (v_user::text || '/') then raise
--   here, the policy: left(name, 37) = auth.uid()::text || '/'
--
-- Three statements of one rule that a reader can diff by eye. `foldername()` is
-- a second implementation of the same idea with its own edge cases (it drops the
-- final segment, so its behaviour on a key with no slash is a property of array
-- slicing rather than of the rule), and a boundary whose two halves are written
-- differently is a boundary whose halves drift. `storage.foldername` stays in
-- the harness because the real schema has it and something else may yet call it;
-- nothing here depends on it.
--
-- A key with no `/` fails: `left('resume.pdf', 37)` is `'resume.pdf'`. A key that
-- merely CONTAINS the caller's uuid fails: the compare is anchored at position 1.
-- An anonymous caller fails twice over — `auth.uid()` is null, so the compare is
-- null, and the policies are `to authenticated` besides.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE ENTITLEMENT DECISION: YES, STORAGE RESPECTS IT. IMPLEMENTED HERE.
--
-- The question is whether a suspended account with a live JWT may still read the
-- PDFs it stored while it was active. The answer is no, and it is not a judgement
-- call — 0028 already decided it for the same bytes' metadata:
--
--   "A suspended or removed account with a live JWT — the token does not expire
--    when the operator flips the switch — reads its own résumés, versions and
--    artifact rows straight off /rest/v1/resume_documents with nothing but the
--    public anon key."
--
-- 0028 closed that on `resume_artifacts`. If storage were left ungated, the same
-- suspended session would be refused the ROW describing the file and served the
-- FILE — a boundary that stops at the index and lets the document through. The
-- storage path is not even a secret it has to guess: it is deterministic,
-- `{user_id}/{artifact_id}/{filename}`, and the session had it before suspension.
--
-- CLAUDE.md: "Unknown, pending, suspended, removed, or wrong-owner access
-- defaults to deny." Storage is access.
--
-- HOW, and why NOT 0028's restrictive-policy shape. 0028 attaches a RESTRICTIVE
-- policy per table because a restrictive policy is ANDed with every permissive
-- policy including ones that do not exist yet — the right instrument for a table
-- this schema owns outright. `storage.objects` is not that table. It is SHARED:
-- one table holds every bucket in the project, and a restrictive policy on it
-- applies to all of them. The avatars bucket somebody adds next quarter would
-- silently inherit a résumé-branch entitlement gate, and the way that surfaces is
-- an unrelated feature returning empty for a pending user with no policy naming
-- it. So `public.hq_is_entitled()` is a conjunct INSIDE each of the four
-- policies, all of which are already scoped `bucket_id = 'resumes'`. The gate is
-- exactly as wide as the bucket this migration creates.
--
-- The cost is the one a restrictive policy would have covered: a FIFTH permissive
-- policy added to this bucket later, without the conjunct, reopens it. That is
-- named in `tests/db/test_resume_storage.py::
-- test_every_policy_on_the_resumes_bucket_carries_the_entitlement_conjunct`,
-- which re-derives the policy set from `pg_catalog` — the same trick 0028's own
-- test uses, and for the same reason: a human list is what goes stale.
--
-- `hq_is_entitled()` is `stable`, `security invoker`, pins `search_path`, and is
-- already granted to `anon, authenticated, service_role` (0027). Calling it from
-- a policy adds no new grant and no new definer. It reads `public.entitlements`
-- under that table's own RLS, where `entitlements_self_read` shows a session its
-- own row and nothing else — so the policy cannot become a probe for whether
-- somebody ELSE is suspended.
--
-- ════════════════════════════════════════════════════════════════════════════
-- OWNERSHIP, GRANTS, RLS, SEARCH PATH — the T3 audit, each answered.
--
-- OWNERSHIP. `storage.objects` is owned by `supabase_storage_admin` on a real
-- project, and by whoever ran the harness locally. CREATE POLICY, COMMENT ON
-- POLICY and ALTER TABLE … ENABLE ROW LEVEL SECURITY all require ownership
-- privileges, so every step below happens inside ONE `do` block that first asks
-- `pg_has_role(current_user, relowner, 'USAGE')`. Three answers, all three
-- exercised against a synthetic Supabase-shaped database (schema and tables
-- owned by `supabase_storage_admin`, applied by a NON-superuser) rather than
-- reasoned about:
--
--   privileged member  the normal case, including every Supabase project and
--                      any superuser. The DDL runs as the applying role. Green.
--   member, no inherit `set role` to the owner for the DDL — and this path has
--                      its own failure, which the experiment found: becoming the
--                      owner swaps ALL privileges, and `supabase_storage_admin`
--                      need not hold `usage on schema auth`, which
--                      `create policy … using (auth.uid() …)` needs at parse
--                      time. It got "permission denied for schema auth". So the
--                      DDL sits in a sub-block that re-raises naming the cause
--                      and the better fix (`grant … with inherit true`).
--   not a member       RAISES immediately, naming the grant to issue.
--
-- No branch skips the DDL and reports success. A migration that half-applies a
-- security boundary and says nothing is the failure this whole file exists to
-- fix. One `do` block rather than several because a role switch has to cover
-- every statement it protects and `db/apply.sh` gives each statement its own
-- transaction.
--
-- GRANTS. None are issued or revoked here, on purpose. Supabase grants
-- `anon, authenticated, service_role` table privileges on `storage.objects` at
-- project creation so that RLS — not the privilege system — is the decider, the
-- same arrangement 0004 documents for `public`. Widening or narrowing the grants
-- on a table owned by the storage service is how the storage API stops working
-- in a way no test here would catch. RLS is the whole control surface, and RLS
-- is what is asserted.
--
-- RLS. Enabled if it is not already (it is, on Supabase). NOT forced: `force row
-- level security` would apply the policies to the table's owner too, and the
-- owner is the storage service itself. `service_role` keeps `bypassrls`, which
-- is what lets the render Lambda write an artifact on a user's behalf — the same
-- hatch `hq_entitlement_guard` opens for the engine.
--
-- SEARCH PATH. No function is created here, security-definer or otherwise. The
-- only function the policies call is `public.hq_is_entitled()`, schema-qualified
-- at the call site, `set search_path = public, pg_temp` at its definition, and
-- already covered by the sweep in `tests/db/test_default_deny.py`.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT THE BUCKET ROW CARRIES, AND WHAT ENFORCES IT.
--
-- `public = false` is the one that matters: a public bucket serves every object
-- in it over an unauthenticated URL and no policy is consulted at all. It is
-- written with `on conflict (id) do update`, so re-provisioning re-asserts it and
-- a bucket someone flipped public in the dashboard comes back private.
--
-- `file_size_limit` and `allowed_mime_types` are defence in depth against the
-- bucket becoming general-purpose file storage. Be precise about who enforces
-- them: the STORAGE API does, on upload, by reading these columns. Postgres does
-- not. The suite can prove the values are stored and cannot prove an oversized
-- upload is refused — see the harness note.

-- ============================================================ preconditions
--
-- Fail with a sentence that names the missing thing, rather than with whatever
-- Postgres says about a relation it cannot find.
do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise exception
      'resume_storage needs Supabase Storage: storage.objects / storage.buckets are missing'
      using errcode = '42P01',
            hint = 'a real project has them; locally, load db/test-harness.sql first';
  end if;
  if to_regprocedure('public.hq_is_entitled()') is null then
    raise exception
      'resume_storage needs 0027_entitlement.sql: public.hq_is_entitled() is missing'
      using errcode = '42883';
  end if;
end
$$;

-- ============================================================ the bucket + policies
do $$
declare
  v_owner    oid;
  v_ownname  text;
  v_privs    boolean;
  v_member   boolean;
  v_switched boolean := false;
  -- Captured BEFORE any role switch. `current_user` inside the exception handler
  -- below is still the SWITCHED role — the subtransaction rollback that reverts
  -- `set role` has not happened yet when the handler body runs — so a hint built
  -- from `current_user` there told the operator to grant a role to itself.
  -- Observed, not theorised; the first draft printed exactly that.
  v_applier  text := current_user;
  -- The one rule, written once. Every policy below interpolates this string, so
  -- read/insert/update/delete cannot drift apart — which is how a bucket ends up
  -- readable by a caller who could not have written to it.
  v_owned    text := $pred$
        bucket_id = 'resumes'
    and auth.uid() is not null
    and left(name, 37) = auth.uid()::text || '/'
    and public.hq_is_entitled()
  $pred$;
begin
  select c.relowner into v_owner from pg_class c where c.oid = 'storage.objects'::regclass;
  select r.rolname into v_ownname from pg_roles r where r.oid = v_owner;
  v_privs  := pg_has_role(current_user, v_owner, 'USAGE');
  v_member := pg_has_role(current_user, v_owner, 'MEMBER');

  if not v_privs then
    if v_member then
      -- Membership without inheritance: the privileges are reachable but not
      -- automatic, so become the owner for the DDL.
      --
      -- THIS FALLBACK IS NOT FREE AND IS NOT SILENT ABOUT IT. Becoming the owner
      -- swaps EVERY privilege, not just the one that was missing, and the owner
      -- of a storage schema has no particular reason to hold `usage on schema
      -- auth` — which `create policy … using (auth.uid() …)` needs at parse
      -- time. Reproduced against a synthetic Supabase-shaped database (schema
      -- and tables owned by `supabase_storage_admin`, `postgres` a member with
      -- `inherit false`) and it failed there on exactly that. So the switched
      -- path is wrapped below and re-raises pointing at the fix that has no such
      -- edge: grant the role WITH INHERIT, and the DDL runs as the applying role
      -- with its own privileges intact. Supabase's own projects take that path —
      -- `postgres` is a privileged member there, which is why the dashboard's
      -- storage policy editor works at all — and this branch exists for the
      -- self-hosted and hand-configured cases that are not.
      --
      -- `set role`, NOT `set local role`. SET LOCAL outside an explicit
      -- transaction block is a WARNING and a no-op, and `db/apply.sh` runs each
      -- statement on its own — so the "safer" spelling is the one that silently
      -- does nothing and lets the CREATE POLICY below fail on a permission
      -- error nobody expected. Plain SET is still transactional: if anything
      -- below raises, this block's transaction aborts and the role goes back
      -- with it. The success path resets explicitly at the end.
      execute format('set role %I', v_ownname);
      v_switched := true;
    else
      -- NOT a refusal yet. Ownership and membership turn out not to decide this
      -- on hosted Supabase: `postgres` there is neither the owner of
      -- `storage.objects` nor a member of `supabase_storage_admin`, and creates
      -- policies on it anyway — which is why the dashboard's storage policy
      -- editor works. Measured against the live project on 2026-08-02, after
      -- this migration refused it on the membership test and the corrective
      -- `grant supabase_storage_admin to postgres` came back
      -- "role memberships are reserved, only superusers can grant them". So the
      -- inferred predicate was both wrong AND pointed at a fix nobody can apply.
      --
      -- Ask the database instead of reasoning about it: create a throwaway
      -- policy and drop it. The capability is the thing that matters, and this
      -- is the only way to learn it that does not model Supabase's grants.
      begin
        execute 'create policy hq_storage_capability_probe on storage.objects for select using (false)';
        execute 'drop policy hq_storage_capability_probe on storage.objects';
      exception when insufficient_privilege then
        raise exception
          'cannot create the resumes storage policy: % owns storage.objects, '
          '% is not a member, and it cannot create a policy there either',
          v_ownname, v_applier
          using errcode = '42501',
                hint = 'on hosted Supabase the applying role can normally do this; '
                       'if it cannot, create the bucket policies from the dashboard '
                       'SQL editor, which runs with the needed rights';
      end;
    end if;
  end if;

  -- A sub-block, only so the switched path can say what went wrong. The body is
  -- left at its own indentation rather than shifted two spaces, because a
  -- whitespace-only reindent of an authorization boundary is a diff nobody reads.
  begin

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('resumes', 'resumes', false, 10485760, array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    -- Both spellings. The app sends `application/yaml`
    -- (`ARTIFACT_CONTENT_TYPE` in webapp/lib/resume/attachment.ts); browsers and
    -- curl have been known to send the older `text/yaml` for the same bytes, and
    -- a rejected upload of the file that REPRODUCES a résumé is a bad trade for
    -- a stricter list.
    'application/yaml',
    'text/yaml'
  ])
  on conflict (id) do update
     set public             = false,
         file_size_limit    = excluded.file_size_limit,
         allowed_mime_types = excluded.allowed_mime_types;

  if not (select c.relrowsecurity from pg_class c where c.oid = 'storage.objects'::regclass) then
    execute 'alter table storage.objects enable row level security';
  end if;

  -- Four policies rather than one `for all`, so a mutation test can take exactly
  -- one verb away and watch exactly one assertion go red. `for all` with a single
  -- USING/WITH CHECK reads tidier and makes "read is broken" and "delete is
  -- broken" the same experiment.

  execute 'drop policy if exists resumes_read_own on storage.objects';
  execute format(
    'create policy resumes_read_own on storage.objects for select to authenticated using (%s)',
    v_owned);

  execute 'drop policy if exists resumes_insert_own on storage.objects';
  execute format(
    'create policy resumes_insert_own on storage.objects for insert to authenticated with check (%s)',
    v_owned);

  -- USING and WITH CHECK both, and the honest note is that the second is
  -- EXPLICIT rather than load-bearing. The first draft of this comment claimed
  -- that without WITH CHECK an owner could rename their object into another
  -- user's prefix. That is false, and the mutation experiment said so: dropping
  -- `with check (%s)` here killed no test, because Postgres uses an UPDATE
  -- policy's USING expression as its WITH CHECK when none is given. The clause
  -- stays because the fallback is a rule a reader has to know, and a policy
  -- whose write-side behaviour is implicit is one somebody "simplifies" by
  -- adding a WITH CHECK that differs. It is not the control; the control is that
  -- both sides say the same thing, and
  -- `test_an_object_cannot_be_renamed_out_of_its_owners_prefix` proves the
  -- rename is refused either way.
  execute 'drop policy if exists resumes_update_own on storage.objects';
  execute format(
    'create policy resumes_update_own on storage.objects for update to authenticated using (%s) with check (%s)',
    v_owned, v_owned);

  execute 'drop policy if exists resumes_delete_own on storage.objects';
  execute format(
    'create policy resumes_delete_own on storage.objects for delete to authenticated using (%s)',
    v_owned);

  execute $c$comment on policy resumes_read_own on storage.objects is
    'resume_storage: a signed-in, ENTITLED session reads objects under its own uuid prefix in the resumes bucket and nothing else; anon has no policy at all'$c$;
  execute $c$comment on policy resumes_insert_own on storage.objects is
    'resume_storage: the storage-boundary twin of app_record_resume_artifact''s left(path,37) refusal — a caller posting straight to /storage/v1 cannot write another user''s prefix'$c$;
  execute $c$comment on policy resumes_update_own on storage.objects is
    'resume_storage: USING and WITH CHECK both, so an object cannot be renamed OUT of its owner''s prefix'$c$;
  execute $c$comment on policy resumes_delete_own on storage.objects is
    'resume_storage: a user deletes only their own résumé files'$c$;

  exception
    when insufficient_privilege then
      -- Unswitched, this is just the truth and deserves no decoration.
      if not v_switched then raise; end if;
      -- Switched, it is almost always the auth-schema case described above, and
      -- the original message ("permission denied for schema auth") sends the
      -- reader hunting through 0001 for something that is not wrong.
      raise exception
        'creating the resumes storage policy as % failed: %', v_ownname, sqlerrm
        using errcode = '42501',
              hint = 'this migration became ' || quote_ident(v_ownname)
                     || ' because ' || quote_ident(v_applier)
                     || ' is a member WITHOUT inherit, and that role lacks a privilege of its '
                     || 'own (usually `usage on schema auth`, which auth.uid() needs at parse '
                     || 'time). Prefer: grant ' || quote_ident(v_ownname) || ' to '
                     || quote_ident(v_applier)
                     || ' with inherit true; then re-run — the DDL then runs as the applying '
                     || 'role, keeping its own privileges.';
  end;

  if v_switched then
    execute 'reset role';
  end if;
end
$$;
