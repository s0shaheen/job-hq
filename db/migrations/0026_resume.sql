-- 0026 — the résumé becomes a product row: a document a person edits, an
-- immutable log of what was rendered, and the files that came out of it.
--
-- NUMBERING. This file is 0026. When it was written, 0020–0025 were all claimed
-- by parallel branches cut from the same commit, each holding its number so two
-- sessions could not collide on merge. Two of them have since landed on main
-- (0020 warm-referral, #94; 0025 display preferences, #98) and this branch has
-- rebased onto both; 21–24 are still out, and the live list is
-- `RESERVED_MIGRATION_NUMBERS` in `tests/core/test_migrations.py`, not this
-- paragraph — a header that restates a moving list is a header that goes stale.
-- `tests/core/test_migrations.py` normally refuses a gap in the sequence (a gap
-- means somebody's migration never got committed), so the reservation is
-- DECLARED there in `RESERVED_MIGRATION_NUMBERS` and asserted in both
-- directions: an undeclared gap still fails, and the day each of those lands the
-- reservation goes red until its line is deleted. 0014 opened with the same
-- paragraph about 0013 and 0017 with the same one about 0016; the mechanism
-- worked twice, so it is used again rather than re-litigated.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY THE SOURCE IS JSONB AND NOT THE YAML EVERYONE EDITS TODAY
--
-- `resume/base.yaml` is the repo's source of truth and stays that way for the
-- owner's own résumé. This is the PRODUCT's storage, and it is a different
-- object: the people who will use it are not YAML authors, the surface is a
-- form, and the content library that comes later has to QUERY structure
-- ("every bullet that carries a payments metric") rather than re-parse a blob.
-- RenderCV takes a YAML *string*, which `yaml.safe_dump` produces
-- deterministically from jsonb, so nothing is lost on the way out. Precedent in
-- this schema: `profiles.criteria jsonb`, where the engine owns the shape and
-- validates on read.
--
-- THE COST, STATED. Comment-preserving edits die: `editor/lib/yamlops.ts`'s
-- replay layer survives only as the IMPORT parser. That property exists to
-- protect a hand-written repo file, which is exactly the thing that is NOT
-- moving here — a form-edited row has no comments to preserve. And RenderCV's
-- entry models silently swallow unknown keys (a `hightlights:` typo drops the
-- whole bullet list, no error, measured 2026-07-28), so the import path needs
-- its own stray-key diff whatever the store is.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT THE `theme` CHECK IS ACTUALLY FOR
--
-- It is a security control and it is written down here so nobody relaxes it as
-- a nicety. RenderCV's `validate_design()` resolves an unknown theme NAME as a
-- FILESYSTEM FOLDER — `input_file_path.parent / theme`, else `Path.cwd()` — and
-- `exec_module()`s that folder's `__init__.py` DURING VALIDATION. Measured
-- 2026-07-28: a canary file was written before validation raised, so the error
-- that follows is not protection; the code already ran. The render service
-- carries its own allowlist (defence in depth). This one stops the value being
-- STORED, which is the layer a future second renderer, a re-render job or a
-- migration script cannot forget.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY `page_target` IS PER DOCUMENT AND NOT ONE GLOBAL ONE-PAGE RULE
--
-- Measured, not assumed (2026-07-28, neutral content across all nine themes):
-- themes AGREE on page count while content is comfortably under or over a page,
-- and DIVERGE precisely in the snug band — 5 roles × 4 bullets renders as one
-- page on `harvard` and `ink` and as two on the other seven. Page count is a
-- joint function of content and theme and cannot be predicted client-side. On
-- top of that a four-page academic CV is a legitimate use of the same tool, so
-- `0` means NO LIMIT rather than "unset". The repo's own one-page gate is a
-- property of the owner's résumé, not of the product.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT HERE
--
-- No render queue, no job table, no bytes. Artifacts are recorded here and
-- STORED in Supabase Storage under `{user_id}/…`; this file records the pointer
-- and the ownership rule that pointer has to satisfy.

-- ============================================================ the theme set

/**
 * The nine themes RenderCV 2.8 ships, as the authority both other languages
 * mirror.
 *
 * An immutable function rather than nine literals repeated in three CHECKs and
 * again in TypeScript — `hq_email_event_types()` and `hq_status_order()`'s
 * shape, for the same reason: a closed set that crosses a language boundary
 * needs one place to be wrong. `harvard` does not exist before RenderCV 2.8, so
 * this list is version-bound and moves when the pin moves.
 */
create or replace function public.hq_resume_themes()
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select array['classic', 'ember', 'engineeringclassic', 'engineeringresumes',
               'harvard', 'ink', 'moderncv', 'opal', 'sb2nov']::text[]
$$;

comment on function public.hq_resume_themes() is
  'the nine built-in RenderCV 2.8 themes — an allowlist, not a menu: an unknown name is resolved by RenderCV as a folder and executed during validation';

-- ================================================== authorship, server-derived

/**
 * Stamp `authored_by` on a saved version from the session.
 *
 * A VARIANT of `hq_authorship_guard` rather than a reuse, and the reason is
 * mechanical: that function's UPDATE branch reads `old.provenance`, a column
 * this table does not have and will not grow — a version records what was
 * rendered, not a claim about how it was produced. Sharing the function would
 * have worked only because the branch is unreachable on an append-only table,
 * which is a dependency on a fact somewhere else in this file.
 *
 * The stamp is UNCONDITIONAL and there is no parameter for it, for 0014's
 * reason: any "if the caller did not supply one" branch lets a value the caller
 * once chose live forever. `auth.uid()` is the signal because it is the one
 * thing a caller cannot forge — a definer function runs with the definer's
 * RIGHTS but the caller's SESSION, so the same RPC stamps `'user'` for a person
 * and `'service'` for the engine.
 */
create or replace function public.hq_resume_authorship_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.authored_by := case when auth.uid() is not null then 'user' else 'service' end;
  return new;
end;
$$;

/**
 * Refuse every UPDATE and every DELETE on the version log.
 *
 * Two layers on purpose. The REVOKE below protects against the browser, which
 * Supabase hands INSERT/UPDATE/DELETE on every new table in `public` so RLS can
 * be the decider. The TRIGGER protects against a future security-definer
 * function that forgets — a definer runs as the table's owner, and the owner's
 * privileges are exactly what the revoke does not touch. `events` and
 * `application_notes` are append-only by revoke alone; this table is the one a
 * "just fix the page count on that row" helper would be written against.
 *
 * CONSEQUENCE, stated rather than discovered later: while a version row exists,
 * the document it belongs to cannot be deleted either, because the cascade IS a
 * DELETE and this refuses every one of them. That is the correct default for a
 * log — "delete my résumé" is a soft delete or an explicit purge lane, and
 * neither exists yet. When one is built it belongs here, as a named exception,
 * rather than as a quietly weakened trigger.
 */
create or replace function public.hq_resume_versions_are_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- The ONE named exception the header promises: rows may leave this table as
  -- part of their owner's erasure, and only then. During `delete from users`
  -- the referential cascade fires after the parent row is gone, so "the owner
  -- no longer exists" is exactly the cascade's signature — a direct DELETE
  -- against a living user's history still refuses. Without this, the users
  -- cascade hits this trigger and user erasure is impossible while a single
  -- version row exists.
  if tg_op = 'DELETE'
     and not exists (select 1 from public.users where id = old.user_id) then
    return old;
  end if;
  raise exception 'resume_versions is append-only: % refused on version %',
    tg_op, coalesce(old.id, new.id)
    using errcode = '42501';
end;
$$;

/*
 * Artifacts are immutable evidence: `sha256`/`byte_size`/`storage_path` are the
 * claims a submission later points at, and a definer helper that "just fixes"
 * one would rewrite history with no trail. Same erasure exception as versions;
 * everything else refuses.
 */
create or replace function public.hq_resume_artifacts_are_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from public.users where id = old.user_id) then
    return old;
  end if;
  raise exception 'resume_artifacts is immutable evidence: % refused on artifact %',
    tg_op, coalesce(old.id, new.id)
    using errcode = '42501';
end;
$$;

-- ============================================================ the documents

create table if not exists public.resume_documents (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,

  -- The row's identity, because `app_save_resume_document` deliberately carries
  -- no id: a save keyed on an id cannot be the FIRST save, and the client would
  -- need a round trip before it could type anything. Trimmed on the way in
  -- (`hq_blank_trim`, not bare btrim — a name of one newline is blank to a
  -- person and length 1 to Postgres), so 'Base ' and 'Base' cannot become two
  -- documents that look identical in a list.
  name text not null check (public.hq_blank_trim(name) <> ''),

  kind  text not null default 'resume',
  theme text not null default 'harvard',

  -- The RenderCV `cv` block, as structure. Jsonb and not YAML text: the surface
  -- is a form, the content library that follows has to query this, and
  -- `yaml.safe_dump` renders it deterministically for the renderer. See the
  -- header for the property this gives up.
  content jsonb not null default '{}'::jsonb,
  -- The `design` block MINUS the theme, which lives in its own column because
  -- it is the one field in there with a security consequence.
  design jsonb not null default '{}'::jsonb,

  -- Pages this document is supposed to fit in. **0 means no limit.** Per
  -- document rather than one global rule: page count is a joint function of
  -- content and theme (measured — the nine themes diverge in the snug band and
  -- agree nowhere else that matters), and a four-page academic CV is a real use
  -- of the same tool.
  page_target smallint not null default 1,

  -- The version this document is currently "at". Nullable — a document exists
  -- before anything has been rendered from it — and the FK is added in an ALTER
  -- below, because the two tables reference each other.
  current_version_id bigint,

  is_default boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint resume_documents_kind_is_known
    check (kind in ('resume', 'cv')),
  -- SECURITY, not tidiness. An unknown theme name is resolved by RenderCV as a
  -- filesystem folder and its `__init__.py` is executed during validation; the
  -- render service allowlists too, and this is the layer that stops the value
  -- from ever being STORED. See the header.
  constraint resume_documents_theme_is_known
    check (theme = any (public.hq_resume_themes())),
  constraint resume_documents_page_target_is_sane
    check (page_target between 0 and 5),

  unique (user_id, name)
);

-- ============================================================ the version log

create table if not exists public.resume_versions (
  id bigint generated always as identity primary key,
  document_id bigint not null references public.resume_documents (id) on delete cascade,
  -- Denormalized from the document on purpose, so RLS is ONE predicate rather
  -- than a join back through `resume_documents` on every row — the shape
  -- `import_rows` and `import_column_reports` (0011) already use for the same
  -- reason. The write function is the only writer and it takes the value from
  -- `auth.uid()`, so the two cannot disagree.
  user_id uuid not null references public.users (id) on delete cascade,

  -- The document's content AS IT WAS, copied at save time. A version that
  -- pointed at the live document would answer "what did we render?" with
  -- whatever the row says today, which is the one question a version log exists
  -- to answer differently.
  content jsonb not null,
  design  jsonb not null,
  theme   text  not null,

  content_hash text not null,

  -- `{rendercv, typst, rendercv_fonts}`. LOAD-BEARING, not telemetry.
  -- RenderCV does not use semver — 2.4 was a full rewrite, 2.7 silently changed
  -- `bold_keywords` semantics, and `harvard` does not exist before 2.8 — and it
  -- publishes no migration path. `rendercv[full]==2.8` then leaves typst on a
  -- `>=` floor while typst is what actually decides where the page breaks. So
  -- "why does this render differently than it did in March" is answerable only
  -- if the answer was written down at the time.
  engine jsonb not null default '{}'::jsonb,

  -- Null until something has rendered it. A real third state, not anchored
  -- emptiness: 0 pages is not a thing and a guessed 1 is worse than a blank.
  page_count smallint,

  label text not null default '',

  -- The SERVER's view of who saved this. Never accepted from a caller; stamped
  -- by the trigger below. There is no `p_authored_by` anywhere in this file and
  -- there must never be one.
  authored_by text not null default 'service',

  -- No `updated_at` and no touch trigger: the table is APPEND-ONLY. A column
  -- that can never change does not need a token saying when it last did.
  created_at timestamptz not null default now(),

  constraint resume_versions_theme_is_known
    check (theme = any (public.hq_resume_themes())),
  -- ANCHORED at both ends, and both anchors are falsifiable: without `^` a hash
  -- prefixed with anything at all passes, and without `$` a hash with a suffix
  -- does. Both are reachable from the endpoint, which is granted to
  -- `authenticated` and takes this value verbatim.
  constraint resume_versions_content_hash_shape
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint resume_versions_authored_by_is_known
    check (authored_by in ('user', 'service')),
  constraint resume_versions_page_count_is_sane
    check (page_count is null or page_count > 0)
);

-- ============================================================ the artifacts

create table if not exists public.resume_artifacts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,

  -- Null for an UPLOAD: a file the person brought has no version behind it.
  -- `set null` rather than cascade, so a purged version cannot take a file the
  -- apply flow already attached somewhere with it.
  version_id bigint references public.resume_versions (id) on delete set null,

  -- THE POINT OF THIS TABLE. The apply/Autopilot flow attaches a file and must
  -- not care whether we made it or the person uploaded it — one seam, two
  -- origins, so an "upload your own résumé" feature is a row here and not a
  -- second attachment path with its own permissions story.
  origin text not null,
  kind   text not null,

  -- The object key in the `resumes` bucket. Owner-scoped by construction: see
  -- the two constraints below for exactly how much of that is the database's.
  storage_path text not null,

  filename  text   not null check (public.hq_blank_trim(filename) <> ''),
  byte_size bigint not null check (byte_size > 0),
  sha256    text   not null,

  -- A render is regenerable and therefore evictable. An UPLOAD and a SENT COPY
  -- are not: engine drift means re-rendering the same jsonb next year does not
  -- reproduce the PDF a company received, and that PDF is evidence. Default is
  -- `permanent` because the safe mistake is keeping a file too long.
  retention text not null default 'permanent',

  created_at timestamptz not null default now(),

  constraint resume_artifacts_origin_is_known
    check (origin in ('rendered', 'uploaded')),
  constraint resume_artifacts_kind_is_known
    check (kind in ('pdf', 'docx', 'png', 'yaml')),
  constraint resume_artifacts_retention_is_known
    check (retention in ('permanent', 'cache')),
  constraint resume_artifacts_sha256_shape
    check (sha256 ~ '^[0-9a-f]{64}$'),
  -- ANCHORED at the start only, on purpose: this one says "the path opens with
  -- something uuid-shaped and a slash", and the rest of the key is a filename
  -- nobody should constrain from here.
  constraint resume_artifacts_path_starts_with_a_uuid
    check (storage_path ~ '^[0-9a-f-]{36}/'),
  -- And the RELATIONAL half, which is the one that actually names an owner.
  -- Stated precisely so the comment does not overclaim: this proves the first
  -- 36 characters of the key are THIS ROW'S `user_id`, because a uuid renders as
  -- exactly 36 characters and `substring(… from 37)` is everything after them.
  -- It proves nothing about the rest of the key, and it is not what the browser
  -- meets first — `app_record_resume_artifact` refuses the same thing with a
  -- message that names a parameter somebody typed. This is the floor under it.
  constraint resume_artifacts_path_is_owner_scoped
    check (storage_path = user_id::text || substring(storage_path from 37)),

  -- A storage path IS the identity of a stored file; two rows for one object is
  -- a bug, and this is also what makes recording the same artifact twice an
  -- idempotent no-op rather than a duplicate.
  unique (user_id, storage_path)
);

-- ============================================================ the mutual FK

do $$
begin
  -- Added here rather than in the CREATE TABLE because the two tables reference
  -- each other and one of them has to exist first. `set null`, not cascade: a
  -- document whose current version went away is a document with no current
  -- version, not a document that should disappear.
  if not exists (select 1 from pg_constraint
                  where conname = 'resume_documents_current_version_fk') then
    alter table public.resume_documents add constraint resume_documents_current_version_fk
      foreign key (current_version_id) references public.resume_versions (id)
      on delete set null;
  end if;
end
$$;

-- ====================================================== the OWNERSHIP FK

-- `resume_versions.user_id` and `resume_artifacts.user_id` are denormalised from
-- the parent row (see the comment on the column) so that RLS is one predicate
-- rather than a join. The justification given there — "the write function is the
-- only writer and it takes the value from auth.uid()" — is a HABIT, not a fact:
-- `service_role` retains INSERT on all three tables. A single row carrying A's
-- `document_id` and B's `user_id` breaks two things at once:
--
--   READ    B sees a version of A's document, because the policy is
--           `user_id = auth.uid()` and this row says B.
--   ERASURE A can never be deleted again. The cascade from `resume_documents`
--           deletes the version by `document_id`, the append-only trigger asks
--           whether `old.user_id` still exists, and B does — so the trigger
--           refuses and `delete from users` raises forever. A denormalised
--           column that can disagree with its parent turns GDPR erasure into a
--           permanent hard failure, which is the failure the trigger's carve-out
--           was written to prevent.
--
-- The composite foreign key is what makes the denormalisation TRUE rather than
-- merely intended: a version may only belong to a document with the same owner,
-- and an artifact only to a version with the same owner. It needs a unique key
-- on the pair to point at; `(id, user_id)` is redundant with the primary key by
-- construction, which is exactly why it costs nothing to assert.
--
-- Added here, after both tables exist, for the same reason the mutual FK above
-- is: `resume_versions` does not exist when `resume_documents` is created.
--
-- NO REFERENTIAL ACTION on either, deliberately. Each sits beside a
-- single-column FK that already declares one — `document_id … on delete
-- cascade`, `version_id … on delete set null` — and those keep deciding what a
-- parent's deletion does, so erasure still travels the one path the append-only
-- carve-out recognises and an artifact still outlives its version as a null.
-- Two FKs over the same columns declaring DIFFERENT actions is how a delete gets
-- an order-dependent outcome; these assert ownership and nothing else.
--
-- Both are MATCH SIMPLE (the default), which is what makes the artifact FK
-- correct rather than merely quiet: a null `version_id` — an UPLOAD, or a
-- rendered artifact whose version has just been set null — is unconstrained,
-- and a non-null one must agree on the owner.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'resume_documents_id_user_key') then
    alter table public.resume_documents
      add constraint resume_documents_id_user_key unique (id, user_id);
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'resume_versions_id_user_key') then
    alter table public.resume_versions
      add constraint resume_versions_id_user_key unique (id, user_id);
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'resume_versions_document_owner_fk') then
    alter table public.resume_versions add constraint resume_versions_document_owner_fk
      foreign key (document_id, user_id)
      references public.resume_documents (id, user_id);
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'resume_artifacts_version_owner_fk') then
    alter table public.resume_artifacts add constraint resume_artifacts_version_owner_fk
      foreign key (version_id, user_id)
      references public.resume_versions (id, user_id);
  end if;
end
$$;

-- ============================================================ indexes

create index if not exists resume_documents_by_user
  on public.resume_documents (user_id, updated_at desc);

-- At most ONE default per user, enforced by the database rather than by the
-- function that flips it. `app_set_default_resume` clears the others first, and
-- this is what makes "the others" a fact instead of a habit — a second writer,
-- a backfill or a psql fix cannot leave two rows claiming to be the default.
create unique index if not exists resume_documents_one_default
  on public.resume_documents (user_id) where is_default;

create index if not exists resume_versions_by_document
  on public.resume_versions (document_id, created_at desc);

create index if not exists resume_artifacts_by_user
  on public.resume_artifacts (user_id, created_at desc);

-- ============================================================ triggers

-- Matrix row 96: `user_companies` was the one versioned table without this, and
-- the column looked fine because the RPCs set it themselves — until a backfill
-- moved the row and left the token behind. A new versioned table gets it on day
-- one.
drop trigger if exists resume_documents_touch on public.resume_documents;
create trigger resume_documents_touch before update on public.resume_documents
  for each row execute function public.touch_updated_at();

drop trigger if exists resume_versions_authorship_guard on public.resume_versions;
create trigger resume_versions_authorship_guard before insert on public.resume_versions
  for each row execute function public.hq_resume_authorship_guard();

drop trigger if exists resume_versions_append_only on public.resume_versions;
create trigger resume_versions_append_only before update or delete on public.resume_versions
  for each row execute function public.hq_resume_versions_are_append_only();

drop trigger if exists resume_artifacts_immutable on public.resume_artifacts;
create trigger resume_artifacts_immutable before update or delete on public.resume_artifacts
  for each row execute function public.hq_resume_artifacts_are_immutable();

-- ============================================================ documentation

comment on table public.resume_documents is
  'one résumé a user keeps — the editable row; content and design are jsonb and YAML is import/export only (0026 header)';
comment on column public.resume_documents.theme is
  'one of hq_resume_themes(); the CHECK is a security control — RenderCV resolves an unknown theme name as a filesystem folder and executes its __init__.py during validation';
comment on column public.resume_documents.page_target is
  'pages this document must fit in; 0 means NO LIMIT — page count is a joint function of content and theme and a multi-page academic CV is legitimate';
comment on column public.resume_documents.current_version_id is
  'the saved version this document is at; null until something has been saved from it';

comment on table public.resume_versions is
  'append-only log of saved résumé versions — update and delete are revoked AND refused by a trigger';
comment on column public.resume_versions.engine is
  '{rendercv, typst, rendercv_fonts} — load-bearing: RenderCV does not use semver, publishes no migration path, and leaves typst floating on a >= pin while typst decides page count';
comment on column public.resume_versions.authored_by is
  'the SERVER''s view of who saved it, stamped from auth.uid() by hq_resume_authorship_guard; never accepted from a caller';

comment on table public.resume_artifacts is
  'one stored file per row, RENDERED here or UPLOADED by the user — the attachments seam the apply flow reads without caring which';
comment on column public.resume_artifacts.storage_path is
  'object key in the `resumes` bucket, owner-scoped: the first 36 characters are this row''s user_id (constraint) and app_record_resume_artifact refuses anything else at the door';
comment on column public.resume_artifacts.retention is
  'permanent | cache — renders are regenerable and evictable; uploads and sent copies are not reproducible (engine drift) and are evidence';

-- ============================================================ RLS

alter table public.resume_documents enable row level security;
alter table public.resume_versions  enable row level security;
alter table public.resume_artifacts enable row level security;

-- Read-only, scoped to the owner. No insert/update/delete policy, here or ever:
-- the browser writes through the functions below or not at all (0001's closing
-- note). All three are read DIRECTLY through PostgREST by the editor surface,
-- which is why these select policies are load-bearing rather than
-- belt-and-braces.
--
-- THEY ARE NOT YET TESTED, and this note says so rather than claiming otherwise:
-- `tests/db/test_rls.py` covers the earlier tables and mentions none of these
-- three. Both directions — owner reads own row, other user reads nothing — need
-- adding there under `set role authenticated` before this schema is applied
-- anywhere real. An unverified RLS policy is a policy nobody has seen deny.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'resume_documents'
                  and policyname = 'resume_documents_self_read') then
    create policy resume_documents_self_read on public.resume_documents
      for select using (user_id = auth.uid());
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'resume_versions'
                  and policyname = 'resume_versions_self_read') then
    create policy resume_versions_self_read on public.resume_versions
      for select using (user_id = auth.uid());
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                  and tablename = 'resume_artifacts'
                  and policyname = 'resume_artifacts_self_read') then
    create policy resume_artifacts_self_read on public.resume_artifacts
      for select using (user_id = auth.uid());
  end if;
end
$$;

-- AND THE WRITE PRIVILEGES GO, not just the policies. Supabase's bootstrap
-- grants `authenticated` INSERT/UPDATE/DELETE on every new table in `public` so
-- that RLS — not the privilege system — decides who sees which rows, and it
-- grants BY NAME: revoking from `public` alone does not touch a grant made to
-- `anon` or to `authenticated` (matrix row 216). A door shut by the absence of
-- a rule reopens the day somebody adds a plausible `for all using (user_id =
-- auth.uid())` policy; a door shut by the absence of a privilege does not.
revoke insert, update, delete, truncate on public.resume_documents
  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.resume_versions
  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.resume_artifacts
  from public, anon, authenticated;

-- The engine's role loses everything that would rewrite or erase history, the
-- way 0002 does for `events`. Append-only has to mean append-only for the writer
-- that bypasses RLS too, and the trigger above is the layer under this one.
--
-- TRUNCATE IS THE ONE THAT MATTERED, and it is here because the first draft left
-- it out. The append-only trigger is a ROW trigger and TRUNCATE does not fire
-- one, so `set role service_role; truncate public.resume_versions cascade;`
-- took every user's résumés, version log and evidence — three tables, no
-- trigger, no audit event, and no cascade the erasure carve-out could
-- recognise. `truncate` WAS revoked from `public, anon, authenticated` above;
-- the one role that could actually reach it was the one left out.
--
-- And nothing upstream covered it: 0004's `alter default privileges … revoke
-- truncate` names `anon, authenticated` only, and says so deliberately — the
-- engine keeps TRUNCATE because it prunes and restores elsewhere. That is right
-- for a cache table and wrong for these three, so the narrowing is stated here,
-- per table, rather than assumed from a default.
--
-- `resume_artifacts` joins `resume_versions` on update/delete for the same
-- reason its own trigger exists: it is documented as immutable evidence, and a
-- table whose whole job is to be unrewritable should not leave the privilege
-- granted to the writer with BYPASSRLS. `resume_documents` keeps UPDATE and
-- DELETE — a document is meant to change, and DELETE is the erasure cascade.
revoke update, delete on public.resume_versions  from service_role;
revoke update, delete on public.resume_artifacts from service_role;
revoke truncate on public.resume_documents from service_role;
revoke truncate on public.resume_versions  from service_role;
revoke truncate on public.resume_artifacts from service_role;

-- ================================================== idempotency, scoped

-- WHAT WENT WRONG, so nobody re-simplifies this back.
--
-- `command_idempotency` (0003) has carried a `command` column since the day it
-- was created. Every RPC in the repo WRITES it. Not one of the twenty-five
-- lookups before this file READ it — they are all `where user_id = … and
-- idem_key = …`, and they return whatever result that key happens to hold.
--
-- Executed: `app_set_default_resume(<doc>, <a save's key>)` returned the SAVE's
-- result verbatim — an object with a `created` field the default lane cannot
-- produce — while setting no default at all. The caller was told a write it
-- never performed had succeeded. Same shape one step smaller: replaying a save
-- with a DIFFERENT payload silently discarded the second write and handed back
-- the first one's row.
--
-- That is repo-wide debt, and it is fixed HERE because this is the first
-- migration to ship four commands a client keys from ONE outbox, so the odds of
-- a key crossing lanes stop being theoretical. The older RPCs keep writing
-- `request_hash` as null and are unaffected; when they are migrated to this
-- helper, the null is what tells them apart.
--
-- REFUSE, do not silently re-key. A key reused for another command or another
-- payload is a client bug, and the two answers that are not a refusal are both
-- worse: returning the stored result reports a write that did not happen, and
-- performing the write anyway defeats the key. Fail loud (CLAUDE.md), with a
-- message that names the two commands and never the key or the payload.
alter table public.command_idempotency
  add column if not exists request_hash text;

comment on column public.command_idempotency.request_hash is
  'fingerprint of the arguments the key was first used with; null for RPCs written before 0026. A replay whose arguments differ is refused, not silently dropped';

/**
 * The fingerprint a replay is compared against.
 *
 * `jsonb`, not a concatenated string: `('a','bc')` and `('ab','c')` have the
 * same concatenation and are different calls. sha256 rather than md5 because
 * this is cheap and the argument for md5 is only ever "it was already there".
 *
 * Values, never names, and NEVER STORED — a hash of the résumé is not a copy of
 * the résumé, which is the property that lets this live in a table the audit
 * lane reads.
 */
create or replace function public.hq_command_fingerprint(p_args jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select encode(sha256(convert_to(p_args::text, 'UTF8')), 'hex')
$$;

comment on function public.hq_command_fingerprint(jsonb) is
  'sha256 of a command''s arguments — the value stored in command_idempotency.request_hash; a hash, never the arguments themselves';

/**
 * The replay lookup, command- and payload-scoped.
 *
 * Returns the stored result for a genuine replay, `null` when the key is new,
 * and RAISES when the key belongs to a different gesture.
 *
 * Deliberately NOT security definer, `app_resume_document_row`'s reasoning: it
 * is only ever called from inside functions that already run as the definer, and
 * marking it definer would hand a standalone caller a read of anybody's stored
 * command results.
 */
create or replace function public.hq_command_replay(
  p_user         uuid,
  p_idem         text,
  p_command      text,
  p_request_hash text
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_prev public.command_idempotency;
begin
  select * into v_prev
    from public.command_idempotency
   where user_id = p_user and idem_key = p_idem;
  if not found then
    return null;
  end if;

  if v_prev.command is distinct from p_command then
    raise exception
      'idempotency key already used by % — % cannot replay it', v_prev.command, p_command
      using errcode = '22023';
  end if;

  if v_prev.request_hash is distinct from p_request_hash then
    raise exception
      'idempotency key already used by % with different arguments', p_command
      using errcode = '22023';
  end if;

  -- `result` is `jsonb not null`, but the JSON value `null` is not a SQL null
  -- and would be indistinguishable from "no row" on the way out. Every command
  -- in this family builds an object; one that did not would be silently treated
  -- as a first call and applied twice.
  if jsonb_typeof(v_prev.result) is distinct from 'object' then
    raise exception 'stored result for % is not an object', p_command
      using errcode = '22023';
  end if;
  return v_prev.result;
end;
$$;

comment on function public.hq_command_replay(uuid, text, text, text) is
  'the command- and payload-scoped replay lookup: the first result for a true replay, null for a new key, and a raise when one key is reused for a different gesture';

revoke all on function public.hq_command_fingerprint(jsonb)
  from public, anon, authenticated;
revoke all on function public.hq_command_replay(uuid, text, text, text)
  from public, anon, authenticated;

-- ============================================================ result shapes

/**
 * One resume_documents row, as the app reads it.
 *
 * Extracted for `app_profile_row`'s reason (0012): two paths return it — a
 * write and a REPLAY of one — and a replay that answers a differently-shaped
 * object than the original is the difference nothing catches until the UI
 * renders blanks.
 *
 * Deliberately NOT security definer: it is only ever called from inside
 * functions that already run as the definer. Marking it definer would hand a
 * standalone caller a read of anybody's documents.
 */
create or replace function public.app_resume_document_row(d public.resume_documents)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id',               d.id,
           'name',             d.name,
           'kind',             d.kind,
           'theme',            d.theme,
           'content',          d.content,
           'design',           d.design,
           'pageTarget',       d.page_target,
           'currentVersionId', d.current_version_id,
           'isDefault',        d.is_default,
           'createdAt',        d.created_at,
           'updatedAt',        d.updated_at
         );
$$;

revoke all on function public.app_resume_document_row(public.resume_documents) from public;

/** One resume_versions row, as the app reads it. Same reasoning as above. */
create or replace function public.app_resume_version_row(v public.resume_versions)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id',          v.id,
           'documentId',  v.document_id,
           'content',     v.content,
           'design',      v.design,
           'theme',       v.theme,
           'contentHash', v.content_hash,
           'engine',      v.engine,
           'pageCount',   v.page_count,
           'label',       v.label,
           'authoredBy',  v.authored_by,
           'createdAt',   v.created_at
         );
$$;

revoke all on function public.app_resume_version_row(public.resume_versions) from public;

/** One resume_artifacts row, as the app reads it. Same reasoning as above. */
create or replace function public.app_resume_artifact_row(a public.resume_artifacts)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'id',          a.id,
           'versionId',   a.version_id,
           'origin',      a.origin,
           'kind',        a.kind,
           'storagePath', a.storage_path,
           'filename',    a.filename,
           'byteSize',    a.byte_size,
           'sha256',      a.sha256,
           'retention',   a.retention,
           'createdAt',   a.created_at
         );
$$;

revoke all on function public.app_resume_artifact_row(public.resume_artifacts) from public;

-- ============================================================ write: a document

/**
 * Create or update one résumé document.
 *
 * KEYED ON `(user_id, name)` and not on an id, because the signature carries no
 * id and must not: a save keyed on an id cannot be the FIRST save, and a client
 * that has to round-trip before it can store anything is a client that loses
 * the first edit. The unique constraint on the pair is what makes the upsert a
 * fact rather than a race.
 *
 * Joins the family `0003_write_path.sql` established: `command_idempotency`
 * storing the RESULT, a post-lock replay re-check, `expected_updated_at`, and
 * the row and its event in one body.
 */
create or replace function public.app_save_resume_document(
  p_name                text,
  p_kind                text,
  p_theme               text,
  p_content             jsonb,
  p_design              jsonb,
  p_page_target         smallint,
  p_idem                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_name     text := public.hq_blank_trim(coalesce(p_name, ''));
  v_kind     text := coalesce(nullif(public.hq_blank_trim(p_kind), ''), 'resume');
  v_theme    text := coalesce(nullif(public.hq_blank_trim(p_theme), ''), 'harvard');
  v_content  jsonb := coalesce(p_content, '{}'::jsonb);
  v_design   jsonb := coalesce(p_design, '{}'::jsonb);
  v_target   smallint := coalesce(p_page_target, 1::smallint);
  v_row      public.resume_documents;
  v_result   jsonb;
  v_inserted boolean := false;
  -- The payload fingerprint this key is scoped to; `hq_command_replay` refuses a
  -- second use of the key with a different one. Built from the NORMALISED values
  -- above, so a retry differing only in whitespace is still the same gesture.
  -- `p_expected_updated_at` is deliberately NOT in it: that is concurrency
  -- control rather than payload, and folding it in would refuse an honest retry
  -- whose only difference is a token the client re-read in between.
  v_fp       text := public.hq_command_fingerprint(
                       jsonb_build_array(v_name, v_kind, v_theme,
                                         v_content, v_design, v_target));
begin
  -- `authenticated` is the only role granted execute, so this is unreachable
  -- today — which is why it is here. The day a service-role lane or a new grant
  -- appears, this is the line that refuses to write a row with a null user_id.
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- The BLANK key matters as much as the missing one: `command_idempotency`'s
  -- primary key is (user_id, idem_key) and '' is a legal text value, so one
  -- caller sending an empty key would have every later empty key replay the
  -- first gesture forever.
  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  if v_name = '' then
    raise exception 'a resume needs a name' using errcode = '22023';
  end if;
  if length(v_name) > 200 then
    raise exception 'name too long: % characters', length(v_name)
      using errcode = '22023';
  end if;

  if v_kind not in ('resume', 'cv') then
    raise exception 'unknown resume kind: %', v_kind using errcode = '22023';
  end if;

  -- Caught HERE as well as by `resume_documents_theme_is_known`, because the
  -- constraint's message names a column a person never typed — and because this
  -- is the value whose only other reader executes a folder by that name.
  if not (v_theme = any (public.hq_resume_themes())) then
    raise exception 'unknown resume theme: %', v_theme using errcode = '22023';
  end if;

  if v_target < 0 or v_target > 5 then
    raise exception 'page target must be 0 (no limit) to 5, not %', v_target
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_content) <> 'object' or jsonb_typeof(v_design) <> 'object' then
    raise exception 'content and design must both be objects' using errcode = '22023';
  end if;

  -- Bounded, because this is stored VERBATIM and the function is granted to
  -- `authenticated`: anyone with a session can post straight to /rest/v1/rpc, so
  -- the server action's caps are one caller's and not the door's. 256 kB is
  -- roughly forty pages of bullets and finite.
  if pg_column_size(v_content) > 262144 then
    raise exception 'content too large: % bytes', pg_column_size(v_content)
      using errcode = '22023';
  end if;
  if pg_column_size(v_design) > 65536 then
    raise exception 'design too large: % bytes', pg_column_size(v_design)
      using errcode = '22023';
  end if;

  -- Replay: return the first result rather than applying twice.
  v_result := public.hq_command_replay(v_user, p_idem, 'app_save_resume_document', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  insert into public.resume_documents
    (user_id, name, kind, theme, content, design, page_target)
  values (v_user, v_name, v_kind, v_theme, v_content, v_design, v_target)
  on conflict (user_id, name) do nothing;
  v_inserted := found;

  select * into v_row
    from public.resume_documents
   where user_id = v_user and name = v_name
     for update;
  -- The insert hit the conflict arm AND the row is gone by the time we lock:
  -- a concurrent erasure. Without this check the audit below records
  -- documentId null and the caller gets a half-empty shape.
  if not found then
    raise exception 'conflict: this resume was removed while you were saving'
      using errcode = '40001';
  end if;

  -- Re-check the key with the row LOCKED. The check above only settles
  -- sequential replays; two tabs flushing one outbox on the same 'online' event
  -- both pass it before either writes, and the loser would otherwise apply a
  -- second time or raise a phantom conflict.
  v_result := public.hq_command_replay(v_user, p_idem, 'app_save_resume_document', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- Optimistic concurrency, checked INSIDE the transaction that writes, and
  -- comparing INSTANTS: the parameter is DECLARED timestamptz, which is what
  -- protects this (matrix rows 146, 168 are both "one moment, three strings").
  -- The word "conflict" is load-bearing — supabase-source.ts matches on it.
  if not v_inserted
     and p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'conflict: this resume changed since you read it'
      using errcode = '40001';
  end if;

  -- A save that changes nothing writes nothing (0003's rule, same as
  -- `app_set_default_resume` below): the UPDATE bumps `updated_at`, which is
  -- the version token every other open tab holds, so an idle autosave would
  -- invalidate them all for a write that changed no field.
  if not v_inserted
     and (v_row.kind, v_row.theme, v_row.content, v_row.design, v_row.page_target)
         is distinct from (v_kind, v_theme, v_content, v_design, v_target) then
    update public.resume_documents
       set kind        = v_kind,
           theme       = v_theme,
           content     = v_content,
           design      = v_design,
           page_target = v_target
     where id = v_row.id
    returning * into v_row;
  end if;

  -- The row and its audit event in one body, or the trail has holes in it. The
  -- payload names the shape and not the contents: an audit trail carrying a copy
  -- of every résumé is a second store nobody decided to keep.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'resume.document_saved',
          jsonb_build_object('documentId', v_row.id,
                             'name',       v_row.name,
                             'kind',       v_row.kind,
                             'theme',      v_row.theme,
                             'pageTarget', v_row.page_target,
                             'created',    v_inserted),
          'user');

  v_result := jsonb_build_object('document', public.app_resume_document_row(v_row),
                                 'created', v_inserted);

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_save_resume_document', v_fp, v_result)
  -- Two racing calls with the same key: whichever lost still returns the same
  -- shape, and the row it wrote is identical.
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_save_resume_document(
  text, text, text, jsonb, jsonb, smallint, text, timestamptz) is
  'create or update one resume document, keyed on (user, name) — idempotent on p_idem, optimistic on p_expected_updated_at';

-- Named revokes, not `from public` alone. Supabase's bootstrap grants execute on
-- new functions to `anon` and `authenticated` BY NAME, and revoking from
-- `public` does not touch a grant made to a named role — the debt
-- `KNOWN_UNNAMED_REVOKES` records for 21 older functions. Nothing added here
-- joins that list.
revoke all on function public.app_save_resume_document(
  text, text, text, jsonb, jsonb, smallint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.app_save_resume_document(
  text, text, text, jsonb, jsonb, smallint, text, timestamptz)
  to authenticated;

-- ============================================================ write: a version

/**
 * Append one saved version, and move the document to it.
 *
 * The content is COPIED from the document rather than passed in, which is why
 * there are no content/design/theme parameters: a caller that could name them
 * could record a version of something the document never said, and the version
 * log's only job is to be the thing that really was there.
 *
 * No `p_expected_updated_at`. The table is append-only, so there is no prior
 * value for a caller to be stale about — the document IS locked for the write,
 * which is what stops two saves from racing onto one `current_version_id`.
 */
create or replace function public.app_save_resume_version(
  p_document_id  bigint,
  p_content_hash text,
  p_engine       jsonb,
  p_page_count   smallint,
  p_label        text,
  p_idem         text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_hash   text := lower(public.hq_blank_trim(coalesce(p_content_hash, '')));
  v_engine jsonb := coalesce(p_engine, '{}'::jsonb);
  v_label  text := coalesce(p_label, '');
  v_doc    public.resume_documents;
  v_row    public.resume_versions;
  v_result jsonb;
  -- The payload fingerprint this key is scoped to; `hq_command_replay` refuses a
  -- second use of the key with a different one. Built from the NORMALISED values
  -- above, so a retry differing only in whitespace is still the same gesture.
  v_fp     text := public.hq_command_fingerprint(
                     jsonb_build_array(p_document_id, v_hash, v_engine,
                                       p_page_count, v_label));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Checked here as well as by `resume_versions_content_hash_shape`: the
  -- constraint refuses the value and this one names it.
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'content hash must be 64 hex characters, not %', v_hash
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_engine) <> 'object' then
    raise exception 'engine must be an object' using errcode = '22023';
  end if;
  if pg_column_size(v_engine) > 8192 then
    raise exception 'engine too large: % bytes', pg_column_size(v_engine)
      using errcode = '22023';
  end if;

  if length(v_label) > 200 then
    raise exception 'label too long: % characters', length(v_label)
      using errcode = '22023';
  end if;

  if p_page_count is not null and p_page_count < 1 then
    raise exception 'page count must be at least 1 when it is known, not %', p_page_count
      using errcode = '22023';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem, 'app_save_resume_version', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- The document, locked for the duration. Scoped to `user_id` in the same
  -- predicate that finds it, so a caller naming somebody else's document gets
  -- "no such document" and not a lock on a row they cannot see.
  select * into v_doc
    from public.resume_documents
   where id = p_document_id and user_id = v_user
     for update;
  if not found then
    raise exception 'no such resume document for this user: %', p_document_id
      using errcode = 'P0002';
  end if;

  -- Re-check the key now that the document is locked, so two tabs replaying one
  -- outbox serialise here rather than both deciding they are the first and
  -- appending two versions of one save.
  v_result := public.hq_command_replay(v_user, p_idem, 'app_save_resume_version', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  insert into public.resume_versions
    (document_id, user_id, content, design, theme, content_hash, engine, page_count, label)
  values (v_doc.id, v_user, v_doc.content, v_doc.design, v_doc.theme,
          v_hash, v_engine, p_page_count, v_label)
  returning * into v_row;

  update public.resume_documents
     set current_version_id = v_row.id
   where id = v_doc.id;

  -- `actor` comes from the STAMPED column and not from anything the caller
  -- said: 0014's lesson, where deriving it from a claimed provenance let a
  -- machine sign the audit trail as a human.
  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'resume.version_saved',
          jsonb_build_object('documentId',  v_doc.id,
                             'versionId',   v_row.id,
                             'contentHash', v_row.content_hash,
                             'theme',       v_row.theme,
                             'pageCount',   v_row.page_count,
                             'engine',      v_row.engine,
                             'authoredBy',  v_row.authored_by),
          case when v_row.authored_by = 'user' then 'user' else 'system' end);

  v_result := jsonb_build_object('version', public.app_resume_version_row(v_row));

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_save_resume_version', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_save_resume_version(
  bigint, text, jsonb, smallint, text, text) is
  'append one immutable version of a document and point the document at it — content is copied from the row, never passed in';

revoke all on function public.app_save_resume_version(
  bigint, text, jsonb, smallint, text, text)
  from public, anon, authenticated;
grant execute on function public.app_save_resume_version(
  bigint, text, jsonb, smallint, text, text)
  to authenticated;

-- ============================================================ write: an artifact

/**
 * Record one stored file — a render we produced or a file the person uploaded.
 *
 * THE OWNER-SCOPING GUARANTEE lives on the first check in this body: the path
 * must begin with `auth.uid()` and a slash, or the call raises. That is what
 * makes "a user's storage prefix is theirs" true against a caller posting
 * straight to /rest/v1/rpc, rather than true only for the code path that builds
 * the key. `resume_artifacts_path_is_owner_scoped` is the floor under it and
 * says the same thing in the column's own terms.
 *
 * Idempotent on the PATH as well as on the key, because a storage object has
 * one identity: re-recording a file that is already recorded answers
 * `{"created": false}` and the row that is already there.
 */
create or replace function public.app_record_resume_artifact(
  p_version_id   bigint,
  p_origin       text,
  p_kind         text,
  p_storage_path text,
  p_filename     text,
  p_byte_size    bigint,
  p_sha256       text,
  p_retention    text,
  p_idem         text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_origin    text := public.hq_blank_trim(coalesce(p_origin, ''));
  v_kind      text := public.hq_blank_trim(coalesce(p_kind, ''));
  v_path      text := coalesce(p_storage_path, '');
  v_filename  text := public.hq_blank_trim(coalesce(p_filename, ''));
  v_sha       text := lower(public.hq_blank_trim(coalesce(p_sha256, '')));
  v_retention text := coalesce(nullif(public.hq_blank_trim(p_retention), ''), 'permanent');
  v_row       public.resume_artifacts;
  v_result    jsonb;
  v_inserted  boolean := false;
  -- The payload fingerprint this key is scoped to; `hq_command_replay` refuses a
  -- second use of the key with a different one. Built from the NORMALISED values
  -- above, so a retry differing only in whitespace is still the same gesture.
  v_fp        text := public.hq_command_fingerprint(
                        jsonb_build_array(p_version_id, v_origin, v_kind, v_path,
                                          v_filename, p_byte_size, v_sha, v_retention));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- THE ownership check. A uuid renders as 36 characters, so the owner's prefix
  -- is the first 37 including the separator. Compared against `auth.uid()` and
  -- never against a parameter, which is the whole reason this function has no
  -- `p_user_id`.
  if left(v_path, 37) <> (v_user::text || '/') then
    raise exception 'storage path must begin with the owner id: %', v_path
      using errcode = '22023';
  end if;
  if length(v_path) > 500 then
    raise exception 'storage path too long: % characters', length(v_path)
      using errcode = '22023';
  end if;

  if v_origin not in ('rendered', 'uploaded') then
    raise exception 'unknown artifact origin: %', v_origin using errcode = '22023';
  end if;
  if v_kind not in ('pdf', 'docx', 'png', 'yaml') then
    raise exception 'unknown artifact kind: %', v_kind using errcode = '22023';
  end if;
  if v_retention not in ('permanent', 'cache') then
    raise exception 'unknown retention: %', v_retention using errcode = '22023';
  end if;

  if v_filename = '' then
    raise exception 'an artifact needs a filename' using errcode = '22023';
  end if;
  if length(v_filename) > 255 then
    raise exception 'filename too long: % characters', length(v_filename)
      using errcode = '22023';
  end if;

  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'sha256 must be 64 hex characters, not %', v_sha
      using errcode = '22023';
  end if;

  if p_byte_size is null or p_byte_size <= 0 then
    raise exception 'byte size must be positive' using errcode = '22023';
  end if;
  if p_byte_size > 52428800 then
    raise exception 'artifact too large: % bytes', p_byte_size using errcode = '22023';
  end if;

  -- A version this user does not own is not a version they may attach a file
  -- to. Null is legal and is what an upload looks like.
  if p_version_id is not null
     and not exists (select 1 from public.resume_versions
                      where id = p_version_id and user_id = v_user) then
    raise exception 'no such resume version for this user: %', p_version_id
      using errcode = 'P0002';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem, 'app_record_resume_artifact', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  insert into public.resume_artifacts
    (user_id, version_id, origin, kind, storage_path, filename, byte_size, sha256, retention)
  values (v_user, p_version_id, v_origin, v_kind, v_path, v_filename,
          p_byte_size, v_sha, v_retention)
  on conflict (user_id, storage_path) do nothing;
  v_inserted := found;

  select * into v_row
    from public.resume_artifacts
   where user_id = v_user and storage_path = v_path
     for update;
  -- Same vanished-row guard as `app_save_resume_document`: without it a
  -- concurrent erasure leaves v_row null and the audit event half-empty.
  if not found then
    raise exception 'conflict: this artifact''s owner row was removed while recording'
      using errcode = '40001';
  end if;

  -- The post-lock re-check. Two tabs flushing one outbox on the same 'online'
  -- event both pass the check above before either writes.
  v_result := public.hq_command_replay(v_user, p_idem, 'app_record_resume_artifact', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  insert into public.events (user_id, kind, payload, actor)
  values (v_user, 'resume.artifact_recorded',
          jsonb_build_object('artifactId', v_row.id,
                             'versionId',  v_row.version_id,
                             'origin',     v_row.origin,
                             'kind',       v_row.kind,
                             'byteSize',   v_row.byte_size,
                             'retention',  v_row.retention,
                             'created',    v_inserted),
          'user');

  v_result := jsonb_build_object('artifact', public.app_resume_artifact_row(v_row),
                                 'created', v_inserted);

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_record_resume_artifact', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_record_resume_artifact(
  bigint, text, text, text, text, bigint, text, text, text) is
  'record one stored file (rendered or uploaded); refuses any storage path that does not begin with auth.uid() — that refusal IS the owner-scoping guarantee';

revoke all on function public.app_record_resume_artifact(
  bigint, text, text, text, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.app_record_resume_artifact(
  bigint, text, text, text, text, bigint, text, text, text)
  to authenticated;

-- ============================================================ write: the default

/**
 * Make one document the user's default, clearing whichever held it.
 *
 * The clearing is a WRITE and not a hope: `resume_documents_one_default` is a
 * partial unique index, so a function that set the new flag without clearing the
 * old one would raise rather than quietly produce two defaults — which is the
 * shape a constraint is supposed to have.
 */
create or replace function public.app_set_default_resume(
  p_document_id bigint,
  p_idem        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_row    public.resume_documents;
  v_result jsonb;
  -- The payload fingerprint this key is scoped to; `hq_command_replay` refuses a
  -- second use of the key with a different one. Built from the NORMALISED values
  -- above, so a retry differing only in whitespace is still the same gesture.
  v_fp     text := public.hq_command_fingerprint(jsonb_build_array(p_document_id));
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idem is null or public.hq_blank_trim(p_idem) = '' or length(p_idem) > 200 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem, 'app_set_default_resume', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  select * into v_row
    from public.resume_documents
   where id = p_document_id and user_id = v_user
     for update;
  if not found then
    raise exception 'no such resume document for this user: %', p_document_id
      using errcode = 'P0002';
  end if;

  v_result := public.hq_command_replay(v_user, p_idem, 'app_set_default_resume', v_fp);
  if v_result is not null then
    return v_result;
  end if;

  -- A gesture that changes nothing writes nothing (0003's rule). The UPDATE
  -- below bumps `updated_at`, which is the version token every other open tab is
  -- holding, so re-setting the default a document already has would invalidate
  -- them all and append an event about a write that changed nothing.
  if not v_row.is_default then
    update public.resume_documents
       set is_default = false
     where user_id = v_user and is_default and id <> v_row.id;

    update public.resume_documents
       set is_default = true
     where id = v_row.id
    returning * into v_row;

    insert into public.events (user_id, kind, payload, actor)
    values (v_user, 'resume.default_set',
            jsonb_build_object('documentId', v_row.id, 'name', v_row.name),
            'user');
  end if;

  v_result := jsonb_build_object('document', public.app_resume_document_row(v_row));

  insert into public.command_idempotency
    (user_id, idem_key, command, request_hash, result)
  values (v_user, p_idem, 'app_set_default_resume', v_fp, v_result)
  on conflict (user_id, idem_key) do nothing;

  return v_result;
end;
$$;

comment on function public.app_set_default_resume(bigint, text) is
  'flip one document to the user''s default, clearing any other — a no-op when it already is, so the version token every open tab holds is not invalidated for nothing';

revoke all on function public.app_set_default_resume(bigint, text)
  from public, anon, authenticated;
grant execute on function public.app_set_default_resume(bigint, text)
  to authenticated;
