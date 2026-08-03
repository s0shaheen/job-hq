-- The restrictive entitlement policy on public.autopilot_receipts, dropped.
--
-- The receipts table is the one holding provider evidence, so the read boundary
-- on it is the one whose absence is worth the most to an attacker with a stale
-- JWT. Same loop, same failure mode, pinned separately.
drop policy autopilot_receipts_entitled on public.autopilot_receipts;
