-- The predicate answers with the OWNER's rights instead of the caller's.
--
-- 0027 declares hq_is_entitled() deliberately NOT security definer, and this
-- is the one-word "tidy-up" that reverses it. The body is byte-for-byte the
-- shipped one; only the declaration changes. With it, a browser session whose
-- role cannot read `entitlements` at all — the store-side shape of the
-- app-layer `unreadable` — stops being denied by error: the definer reads the
-- table anyway, the policies quietly evaluate, and rows flow to a session
-- whose entitlement nothing could actually check against ITS rights.
create or replace function public.hq_is_entitled()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.entitlements e
     where e.user_id = auth.uid()
       and e.status = 'active');
$$;
