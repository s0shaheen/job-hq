-- 0028 — the three résumé tables join 0027's default-deny boundary.
--
-- WHAT WENT WRONG, stated plainly so the shape is recognisable next time.
--
-- `0026_resume.sql` and `0027_entitlement.sql` were cut from the same commit and
-- built in parallel. 0027 attaches a restrictive RLS policy and the
-- `hq_entitlement_guard` trigger to a NAMED array of tables, and that array is the
-- set of tables that existed on the branch it was written on. `resume_documents`,
-- `resume_versions` and `resume_artifacts` did not exist there. So the moment both
-- landed, the store grew three browser-reachable tables outside the boundary
-- 0027 exists to make total — and 0027's own review predicted exactly this
-- ("a table added on another branch is outside the array again"), which is why
-- `tests/db/test_default_deny.py` re-derives the set from `pg_catalog` instead of
-- trusting the array. It went red on the rebase. The mechanism worked.
--
-- WHAT WAS ACTUALLY OPEN, both halves, because "a test is red" is not a finding:
--
--   READS  0026's three policies are PERMISSIVE and owner-scoped only
--          (`user_id = auth.uid()`). A suspended or removed account with a live
--          JWT — the token does not expire when the operator flips the switch —
--          reads its own résumés, versions and artifact rows straight off
--          `/rest/v1/resume_documents` with nothing but the public anon key. The
--          web app is not in that path and cannot gate it.
--
--   WRITES all four résumé RPCs are `security definer`. A definer bypasses RLS by
--          construction, so no policy — restrictive or otherwise — is even
--          consulted inside them, and the trigger is the ENTIRE boundary. Without
--          it, `app_save_resume_document` and `app_record_resume_artifact` accept
--          writes from an account the owner has never turned on, or has turned
--          off.
--
-- CLAUDE.md: "Unknown, pending, suspended, removed, or wrong-owner access defaults
-- to deny." These three tables did not.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY A NEW FILE AND NOT THREE MORE STRINGS IN 0027's ARRAY
--
-- `0027_entitlement.sql` is merged to `main` AND applied to production.
-- Migrations are append-only: editing an applied file makes the schema a function
-- of WHEN a database was provisioned rather than of the directory, and the
-- divergence is silent because `db/apply.sh` re-runs everything and the edited
-- file's `create policy if not exists`-shaped guards make the no-op look like
-- success. Renumbering 0026 was the other option and it is worse — the number is
-- cited across two review rounds and in the production ordering argument.
--
-- This file is correct in BOTH orders, which is the property that makes the
-- append-only rule survivable here:
--
--   fresh install   0026 creates the tables → 0027 gates the set it knows about
--                   → 0028 gates these three.
--   production      0027 is already applied; 0026 and 0028 arrive together in one
--                   provisioning run and 0028 runs after the tables exist.
--
-- ════════════════════════════════════════════════════════════════════════════
-- NO NEW FUNCTIONS, NO NEW GRANTS, NO NEW CONSTRAINTS.
--
-- This file attaches 0027's two existing mechanisms and does nothing else. That
-- is deliberate: a boundary extension that also introduces a predicate is a
-- boundary extension whose reviewer has to verify a predicate. `hq_is_entitled()`
-- and `hq_entitlement_guard()` are already reviewed, already tested, already
-- pinned (`set search_path = public, pg_temp`, asserted for every function in
-- `public` by `test_every_function_in_public_pins_its_search_path`), and already
-- revoked from `public`. Nothing here changes who may execute what.
--
-- Ownership is likewise unchanged: `db/apply.sh` runs as the database owner, the
-- policies and triggers are attached to tables 0026 already created under that
-- same owner, and `alter table ... enable row level security` is a no-op on all
-- three (0026 lines 524–526 already enabled it). It is restated rather than
-- assumed because a gate that depends on another file having enabled RLS is a
-- gate one `alter table ... disable row level security` away from silence.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE INTERACTION WITH 0026's OWN TRIGGERS — checked, not assumed.
--
-- Postgres fires BEFORE-ROW triggers in NAME order, and the names land like this:
--
--   resume_versions_append_only  <  resume_versions_authorship_guard
--                                <  resume_versions_entitlement_guard
--   resume_artifacts_entitlement_guard  <  resume_artifacts_immutable
--
-- On INSERT the entitlement guard runs alongside `..._authorship_guard`, which
-- stamps `authored_by` from `auth.uid()`; neither reads what the other writes, so
-- the order does not matter. On UPDATE/DELETE of `resume_versions` and
-- `resume_artifacts` the append-only/immutable trigger refuses first (versions) or
-- second (artifacts) — either way the write is refused, and both refusals are
-- correct answers to the same question. Two triggers refusing the same statement
-- is not redundancy to be pruned: one answers "this table is a log", the other
-- answers "this account is not turned on", and they are true at different times.
--
-- THE ERASURE PATH STILL WORKS, and this is the one that would break loudly at
-- the worst moment. `delete from public.users` cascades documents → versions →
-- artifacts. It is run by the operator or the service role, so `auth.uid()` is
-- null and `current_setting('role')` is `service_role` or `none`, which is
-- exactly the hatch `hq_entitlement_guard` opens for the engine. A browser
-- session cannot reach that cascade at all: 0026 revokes DELETE on all three from
-- `anon` and `authenticated`, and no RPC deletes a résumé. Asserted, not argued:
-- `tests/db/test_resume.py::test_erasure_still_works_with_the_entitlement_guard_attached`.

-- ============================================================ the precondition
--
-- Fail loud rather than attaching a gate to nothing. If 0027 has not been applied,
-- `create policy ... using (public.hq_is_entitled())` would fail anyway — but with
-- a bare "function does not exist" that reads like a typo instead of like a
-- missing migration, and `create trigger ... execute function` would too. Naming
-- the dependency is the difference between an operator who knows to check the
-- directory and one who starts editing this file.
do $$
begin
  if to_regprocedure('public.hq_is_entitled()') is null
     or to_regprocedure('public.hq_entitlement_guard()') is null then
    raise exception
      '0028 needs 0027_entitlement.sql: public.hq_is_entitled() / public.hq_entitlement_guard() are missing'
      using errcode = '42883';
  end if;
end
$$;

-- ============================================================ the attachment
--
-- Same loop, same names, same two mechanisms as 0027's closing section. Kept
-- byte-comparable on purpose: a reader who has read 0027 should be able to see at
-- a glance that this adds three rows to that set and changes nothing about how the
-- set is enforced. The policy name is `<table>_entitled` and the trigger name is
-- `<table>_entitlement_guard` because `tests/db/test_default_deny.py` finds them
-- by shape (a RESTRICTIVE policy whose USING mentions `hq_is_entitled`, a trigger
-- whose function is `hq_entitlement_guard`) — the names are for humans, the shape
-- is what is asserted.
--
-- `drop ... if exists` first, so `db/apply.sh` re-applying the whole directory is
-- a no-op rather than a duplicate-object error.
do $$
declare
  t text;
  gated text[] := array[
    'resume_documents', 'resume_versions', 'resume_artifacts'
  ];
begin
  foreach t in array gated loop
    if to_regclass('public.' || quote_ident(t)) is null then
      raise exception 'entitlement gate names a table that does not exist: public.%', t;
    end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_entitled', t);
    execute format(
      'create policy %I on public.%I as restrictive for all '
      'using (public.hq_is_entitled()) with check (public.hq_is_entitled())',
      t || '_entitled', t);

    execute format('drop trigger if exists %I on public.%I', t || '_entitlement_guard', t);
    execute format(
      'create trigger %I before insert or update or delete on public.%I '
      'for each row execute function public.hq_entitlement_guard()',
      t || '_entitlement_guard', t);
  end loop;
end
$$;

comment on policy resume_documents_entitled on public.resume_documents is
  'restrictive (0028): ANDed with resume_documents_self_read, so a pending, suspended, removed or unknown account reads nothing over /rest/v1 even with a live JWT';
comment on policy resume_versions_entitled on public.resume_versions is
  'restrictive (0028): see resume_documents_entitled';
comment on policy resume_artifacts_entitled on public.resume_artifacts is
  'restrictive (0028): see resume_documents_entitled';
