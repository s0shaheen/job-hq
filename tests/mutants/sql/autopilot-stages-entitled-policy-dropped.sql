-- The restrictive entitlement policy on public.autopilot_stages, dropped.
--
-- This is the READ half of the boundary: /rest/v1 is a surface the web app is
-- not in the path of, and a live JWT does not expire when an operator suspends
-- an account. With the restrictive policy gone the permissive `_self_read`
-- policy stands alone and a suspended owner reads their own rows again.
drop policy autopilot_stages_entitled on public.autopilot_stages;
