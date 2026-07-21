-- 0002 — close the gaps 0001 left open.
--
-- Every item here is an invariant the system already ASSUMES but did not
-- ENFORCE. The distinction matters: an assumed invariant holds until the day
-- someone writes the one line that breaks it, and then it fails silently.

-- ============================================ 1. postings are not public

-- 0001 let ANY authenticated user select ANY row of `postings`. The app never
-- did that (it always joins through user_postings), but the policy is the
-- security boundary, not the query. With three family members that is a
-- privacy leak waiting for one hand-written query; with ten users it is a
-- real one. A posting is readable only by a user who was actually gated it.
drop policy if exists postings_authenticated_read on public.postings;

create policy postings_visible_to_gated_users on public.postings
  for select using (
    exists (select 1 from public.user_postings up
            where up.posting_key = postings.key
              and up.user_id = auth.uid()));

-- The join in that policy runs per row; without this index it is a seq scan
-- of user_postings for every posting returned.
create index if not exists user_postings_by_posting
  on public.user_postings (posting_key, user_id);

-- Same reasoning for the shared companies table: it is reference data, but
-- "which companies is this person watching" is not everyone's business.
drop policy if exists companies_authenticated_read on public.companies;

create policy companies_visible_to_watchers on public.companies
  for select using (
    exists (select 1 from public.user_companies uc
            where uc.company_id = companies.id
              and uc.user_id = auth.uid()));

-- ============================================ 2. events are append-only

-- 0001 called events append-only in a comment. A comment is not a permission.
revoke update, delete on public.events from anon, authenticated;
-- service_role keeps delete for retention pruning only; app code must never
-- update an event. Correcting history means appending a correcting event.
revoke update on public.events from service_role;

create index if not exists events_posting_time
  on public.events (posting_key, occurred_at desc);

-- ============================================ 3. duplicate applications

-- `unique (user_id, posting_key)` does NOT constrain manually-added rows,
-- because NULLs are never equal in Postgres — and most real pipeline rows
-- arrive from Gmail or by hand with no posting_key. Two "Stripe / Product
-- Manager" rows could coexist forever.
create unique index if not exists applications_manual_dedup
  on public.applications (user_id, lower(company), lower(title))
  where posting_key is null;

-- ============================================ 4. a filtered row explains itself

-- The whole point of `filtered` is that it is recoverable and auditable. A
-- filtered row with no reason is unauditable — nobody can tell whether the
-- gate was right.
alter table public.user_postings
  add constraint filtered_rows_state_a_reason
  check (disposition <> 'filtered' or disposition_reason <> '');

-- ============================================ 5. "new for ME"

-- postings.first_seen is system-wide. When a second user joins, every
-- existing posting looks equally old to them — there is no way to ask "what
-- arrived for me since I last looked", which is the core question the daily
-- queue answers.
alter table public.user_postings
  add column if not exists created_at timestamptz not null default now();

create index if not exists user_postings_new_for_user
  on public.user_postings (user_id, created_at desc);

-- ============================================ 6. triage is a real state

-- Snoozing without a wake date is just hiding. If snooze_until is set the
-- row must actually be snoozed, and vice versa.
alter table public.user_postings
  add constraint snooze_has_a_date
  check ((triage = 'snoozed') = (snooze_until is not null));
