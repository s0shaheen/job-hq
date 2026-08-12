# resume

Resume storage and rendering as a product capability: user-owned documents, append-only
versions, immutable artifacts, and a render worker that is a pure function. This spec is
the current truth; the contract row is "Resume and attachments" in
`docs/pilot-launch/09-full-product-contract-v2.md` §3.

Two systems share the word "resume" and are deliberately separate. The **product**
capability stores every user's resume in Postgres and object storage. The **legacy owner
pipeline** renders the owner's own resume from repo files and publishes it to Drive. The
header of `db/migrations/0026_resume.sql` states the split: `resume/base.yaml` stays the
source of truth for the owner's resume; the product's storage is a different object.

## What it is

A resume **document** is a user's editable resume: RenderCV-shaped `content` and `design`
JSON, a theme, and a page target. A **version** is an append-only snapshot of a document
taken at save time, identified by a sha256 `content_hash`. An **artifact** is an immutable
recorded file — rendered output (`pdf`, `docx`, `png`, `yaml`) or a user upload — whose
bytes live in object storage, never in Postgres.

## Where it is stored

- `public.resume_documents`, `public.resume_versions`, `public.resume_artifacts` —
  created by `db/migrations/0026_resume.sql`. There is no render queue, job table, or
  bytes column; `0026_resume.sql` says so explicitly.
- Storage bucket `resumes` (private, 10 MiB limit, allowlisted MIME types) — created by
  `db/migrations/20260802_084857_resume_storage.sql`. Object paths are
  `<user_uuid>/<filename>`; every storage policy requires
  `left(name, 37) = auth.uid()::text || '/'` and `public.hq_is_entitled()`.
- Entitlement gating for the three tables (restrictive policy plus guard trigger) comes
  from `db/migrations/0028_resume_entitlement.sql`.

## Who reads and writes it

- **Browser** — four security-definer RPCs in `0026_resume.sql`, granted to
  `authenticated`: `app_save_resume_document`, `app_save_resume_version` (content is
  copied from the document row, never passed in), `app_record_resume_artifact` (refuses
  any storage path not beginning with `auth.uid()` — that refusal is the owner-scoping
  guarantee), `app_set_default_resume`. Reads go through owner-scoped `_self_read`
  policies. No UI route exists yet: `webapp/app/(app)/` has no resume page, no webapp
  code calls the four RPCs, and the only webapp resume module is
  `webapp/lib/resume/attachment.ts` — pure functions and types for the apply attachment
  seam, currently with zero importers. Until that seam is filled, Autopilot Prepare
  gates every file field as an `attachment` gap, which is why no real board reaches
  `ready` (`webapp/lib/apply/prepare.ts`, `webapp/lib/apply/topics.ts`).
- **Render worker** — `infra/render/render.py`, the `job-hq-render` Lambda. It is a pure
  function: YAML in, base64 artifacts out; no secrets, no sockets, no AWS calls, no
  storage writes. Per `infra/terraform/render.tf` it has no schedule and no invoker yet
  ("Nobody, yet"), and `infra/README.md` records it as plan-only, not deployed. When the
  webapp lane is wired, the webapp's server-side identity gets invoke on that ARN and
  records outputs via `app_record_resume_artifact` (service_role keeps `bypassrls` for
  exactly this, per `20260802_084857_resume_storage.sql`).
- **Autopilot** — `db/migrations/20260802_094615_autopilot_staging.sql` checks staged
  attachments against `resume_artifacts`, so a submission can only attach files this
  capability recorded.
- **Legacy owner pipeline** — `.github/workflows/resume.yml` fires on a `main` push
  touching `resume/**` and publishes the owner's rendered resume to Drive via
  `scripts/publish_to_drive.py` and the Apps Script uploader. It never touches Postgres
  or the Lambda. This is why CLAUDE.md warns that a `main` change under `resume/**` can
  publish the owner's resume. The owner-specific defaults in that lane are inventoried
  in `docs/pilot-launch/20-personal-vault-audit.md` §3; do not copy its values into
  product code or fixtures.

## Invariants

- Versions are append-only and artifacts are immutable, enforced by triggers
  (`hq_resume_versions_are_append_only`, `hq_resume_artifacts_are_immutable` in
  `0026_resume.sql`), with update/delete also revoked from `service_role`.
- Every artifact and object path is owner-scoped: the `storage_path` CHECK constraints in
  `0026_resume.sql` and the `left(name, 37)` storage policies are twins of the same rule.
- The theme list is a security control, not a preference: RenderCV executes a theme
  folder's `__init__.py`, so both the CHECK constraints (via `hq_resume_themes()`) and
  the worker's `ALLOWED_THEMES` frozenset in `infra/render/render.py` allowlist themes.
- At most one default resume per user (partial unique index
  `resume_documents_one_default`).
- Authorship is stamped by the database (`hq_resume_authorship_guard`), never accepted
  from the caller.
- The product must never inherit owner defaults: no default resume content ships with
  the product (contract v2 §3, "Personal Salman content — excluded from product").
