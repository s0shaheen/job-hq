-- The restrictive entitlement policy on public.autopilot_transitions, dropped.
--
-- Pinned per table rather than once for the family: the loop at the bottom of
-- the migration builds three policies from one array, and the failure mode that
-- loop invites is a table quietly dropping out of the array. A single-table
-- mutant would not see that.
drop policy autopilot_transitions_entitled on public.autopilot_transitions;
