-- Close the privileges that row-level security does not reach.
--
-- RLS governs SELECT, INSERT, UPDATE and DELETE. It does not govern TRUNCATE,
-- TRIGGER or REFERENCES, and Supabase's default grants hand `authenticated`
-- every privilege on every table in `public` so that RLS can be the thing
-- deciding access. The gap: TRUNCATE is decided by the privilege system alone.
--
-- 0002 revokes update and delete on `events` and comments that the audit trail
-- is append-only. It reads like a closed door and is not one — a signed-in
-- browser session could run
--
--     truncate public.events;
--
-- and empty the entire append-only trail, for every user at once, in one
-- statement. That is the loudest possible action leaving the quietest possible
-- trace, because the trace is what gets deleted. Verified against a real
-- database in tests/db/test_rls.py, which failed with DID NOT RAISE before
-- this file existed.
--
-- The same reasoning covers the rest of the schema: nothing a browser session
-- does should ever be a whole-table operation.

revoke truncate on all tables in schema public from anon, authenticated;

-- TRIGGER lets a caller attach their own function to a table, which runs with
-- the table owner's rights on every write anyone makes. REFERENCES allows a
-- foreign key onto a table, which leaks the existence of rows the policy hides
-- (an insert that fails tells you the key exists) and can block deletes.
revoke trigger, references on all tables in schema public from anon, authenticated;

-- Future tables inherit the same shape, so this does not have to be remembered
-- in every later migration — which is precisely the kind of thing that is not
-- remembered.
alter default privileges in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- The engine keeps TRUNCATE: it runs as service_role for retention pruning and
-- restore drills, and it is not reachable from a browser.
