-- Drop the entitlement guard from autopilot_stages AND NOTHING ELSE.
--
-- The word "only" is the whole mutant. `autopilot_transitions` keeps its guard,
-- so a loose `pytest.raises` still sees a refusal, from the neighbouring table.
-- The named test has to prove it reads the guard's own sentence
-- (`diag.message_primary`) rather than psycopg's CONTEXT block echoing the RPC's
-- `insert into public.autopilot_stages ...`.
drop trigger autopilot_stages_entitlement_guard on public.autopilot_stages;
