-- Absence becomes permission: a signed-in session whose entitlement row is
-- MISSING answers entitled. This is the exact mistake 0027's predicate comment
-- warns about ("Missing means not entitled; a gate that reads absence as
-- permission is not a gate"), spelled the way a plausible refactor would spell
-- it — coalesce the missing row onto "well, they are signed in".
--
-- A pending or suspended row still answers false, so every state-sweep test
-- stays green; only the absent-row denial reddens, which is what proves that
-- test is the one guarding this line.
create or replace function public.hq_is_entitled()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select e.status = 'active'
       from public.entitlements e
      where e.user_id = auth.uid()),
    auth.uid() is not null);
$$;
