-- The delete guard, detached.
--
-- `hq_autopilot_committed_stages_are_kept()` can be perfect and still guard
-- nothing if the trigger that calls it is not there. `delete from
-- public.applications` appears in four shipped RPCs and cascades into
-- autopilot_stages; with this trigger gone every one of them erases a submitted
-- stage, its audit trail and its provider receipt, and reports success.
drop trigger autopilot_stages_keep_committed on public.autopilot_stages;
