# Personal-vault audit (RM-40)

Observed: 2026-08-03
Contract: `full-product-pilot-v2`
Roadmap item: RM-40 Personal-vault split
Decision authority: DEC-010 (owner-specific resume/application/interview content leaves
the product boundary)

This document is an **inventory and a sequenced plan**. It moves nothing, deletes
nothing, and rewrites no history. It changes no code the product reads.

Paths and categories are cited; owner content is never reproduced. A report that quotes
the material it is warning about has reproduced the problem, and this document is itself
destined for a repository that will one day be less private than it is today.

## 0. Exposure baseline

`s0shaheen/job-hq` is **private** (`gh repo view`: `isPrivate: true`), single remote, no
forks, private for its entire life (2026-05-26 → today). There is no GitHub Pages
workflow, no `gh-pages` branch, no `actions/deploy-pages`. **Nothing in this repository
has been published to the open internet by the repository itself.**

That single fact downgrades most of what follows from "exposed" to "exposed to anyone
with repo access or any clone that has left the owner's control". It is the only control
holding several of these findings shut, and it is a control that disappears the moment
the repository is opened, transferred, or forked into a product org. **Treat repository
visibility as the load-bearing dependency of this entire audit.**

One exception, described in §5: material has left the repository by a different route,
and that departure is irreversible.

## 1. Severity and disposition keys

| Severity | Meaning |
|---|---|
| S1 | A pilot user or an outside reader could obtain owner or third-party personal data, or a live credential |
| S2 | Owner-specific defaults silently govern another user's product behaviour |
| S3 | Owner identity is legible to anyone reading the source, but no user data is reachable |
| S4 | Cosmetic or already contained; cleanup hygiene |

| Disposition | Meaning |
|---|---|
| VAULT | Move to the private owner vault, out of the product repository |
| SYNTH | Replace with a synthetic, generic, obviously-fictional equivalent |
| DELETE | Remove; there is no product need and no vault need |
| KEEP | Genuine product code that only looks owner-specific |
| ROTATE | Credential-shaped; the string must be invalidated, not just removed |

## 2. Inventory — owner and third-party personal content

| Path | What it is | Reachable by | Blast radius | Sev | Disposition |
|---|---|---|---|---|---|
| `resume/base.yaml` | Owner résumé source: identity, contact, employment history | Legacy `resume.yml` workflow, `editor/` app, `scripts/publish_to_drive.py` | Full résumé and contact details of the owner | S1 | VAULT |
| `resume/design.yaml` | Résumé theme carrying owner identity fields | Same | Identity fields only | S2 | VAULT |
| `master-resume.md` | Owner's full career fact base — the source-of-truth corpus for résumé claims | No code imports it | Complete employment history, richer than the résumé | S1 | VAULT |
| `content-workshop.md` | Owner-specific phrasing bank and claim workshop | None | Employment detail and unpublished claims | S1 | VAULT |
| `jd-playbook.md` | Owner-specific application playbook | None | Job-search strategy tied to one identity | S2 | VAULT |
| `references/strategy-synthesis.md` | Owner positioning strategy | None | Positioning and self-assessed gaps | S2 | VAULT |
| `references/recruiter-sims-2026-07-07.md` | Simulated recruiter screens against the owner's profile | None | Interview-adjacent personal material | S1 | VAULT |
| `users/salman/profile.yaml` | Owner's real job-search profile | `tracker/`, monitor CLI | Titles, geography, comp posture, exclusions | S1 | VAULT |
| `users/dad/profile.yaml` | **Third party's** real job-search profile | Same | A family member's employment preferences, in a repo they do not administer | S1 | VAULT |
| `users/roommate/profile.yaml` | **Third party's** real job-search profile | Same | Same | S1 | VAULT |
| `applications` (tracked symlink, mode 120000) | Symlink into the owner's local Google Drive mount | Legacy tooling only; dangling off-machine | Leaks the owner's local path and Drive account structure; the target content is the owner's real applications | S3 | DELETE |
| `infra/render/fixtures/reference_cv.yaml` | Render fixture built from the owner's real employment history | Render test suite | Employment history, presented as a fixture | S2 | SYNTH |
| `docs/background-job-monitor/**` | Exported AI-chat transcripts from the original personal project | None | Personal project reasoning, owner-identified | S3 | VAULT |
| `docs/design-history/**` | Historical specs naming the owner's role and, in at least one file, a notification topic | None | See §4 — one spec records a topic string | S3 | KEEP after topic redaction |

`references/*.pdf` and `references/*.docx` are published third-party industry guides and
templates. They are not owner content. They are S4 licensing hygiene at most; disposition
KEEP or DELETE at the owner's discretion.

The third-party profiles (`users/dad`, `users/roommate`) are the most legally awkward
finding in this document. They are the personal data of people who did not choose this
repository, and they are in every clone.

## 3. Inventory — owner role defaults baked into product logic

These are the sneaky ones. They are indistinguishable from product code by shape, and
they govern other users' results.

### 3a. Reachable by the running web product

| Path | Category | Blast radius | Sev | Disposition |
|---|---|---|---|---|
| `webapp/lib/profile/criteria.ts:56-70` (`BASE_CRITERIA`) | Role family, tag domain, board search term, YoE ceiling, US-only country set | This is the fallback in `parseCriteria` (`:146-160`) for **every profile write**. A blank or malformed field on any user's profile silently lands on the owner's role family and experience ceiling. Imported by the settings form and onboarding. | S2 | SYNTH — must become an explicit "not set" state, not a different default |
| `webapp/lib/profile/presets.ts:36-125` (`ROLE_PRESETS`) | Target titles and exclusion keywords. Its own docstring states these are copies of `users/salman/profile.yaml` and `users/dad/profile.yaml` | Rendered as the **only** onboarding role templates. Two individuals' hand-tuned lists are the product's entire role taxonomy, and a pilot user is steered into one of them. | S2 | SYNTH — replace with a general job-family taxonomy per §5 of `07-decisions-assumptions-risks.md` |
| `webapp/lib/warm/intro-context.ts:44-53` (`roleFromCriteria`) | Hardcoded role-title fallback, docstring explicitly names the deployment owner's search shape | Warm-intro cell on `/jobs` and `/pipeline` mislabels another user's role | S2 | SYNTH |
| `webapp/lib/warm/fit.ts:118-123`, `:135` | Prompt system message with a hardcoded role fallback and the owner's former employer as a few-shot example | Biases model wording for every user's fit analysis; owner employment history embedded in a shared prompt | S2 | SYNTH |
| `webapp/lib/warm/types.ts:107-112` (`SIGNAL_WEIGHT`) | Ranking weights tuned against the owner's four warm signals; no per-user configuration | Ranking quality for other users, not a disclosure | S3 | KEEP, with a recorded provenance note — or make configurable under RM-4x |
| `webapp/lib/warm/types.ts:13,45,52,74,76`; `webapp/lib/referral/linkedin.ts:297-309` | Owner's school and former employer as canonical illustrative values in doc comments | Source readers only | S3 | SYNTH |
| `webapp/lib/profile/metros.ts:20-36` | 15 US metros only | Product scope limit consistent with DEC-007, not an owner preference | S4 | KEEP |
| `webapp/lib/profile/criteria.ts:75,77` | Limits whose justifying comments cite two specific people's list lengths | Comment only | S4 | SYNTH (comment) |

### 3b. Reachable by a deployed worker

| Path | Category | Blast radius | Sev | Disposition |
|---|---|---|---|---|
| `core/config_defaults.yaml:65-88` | Owner's exact title include/exclude lists as the engine default | Every user swept by the Lambda handler inherits the owner's title filter | S2 | SYNTH |
| `core/config_defaults.yaml:88-92` (`dna_companies`) | A hardcoded **employer denylist** of four named institutions | Silently suppresses employers for all users; also legible as a personal disclosure about the owner | S2 | SYNTH or move to per-user preference |
| `core/config_defaults.yaml:5-24` | Seniority and years-of-experience deal-breakers, country filter | Another user's results are filtered by the owner's seniority band | S2 | SYNTH |
| `core/config_defaults.yaml:55-58` | Notification timezone and quiet hours | One person's sleep window is the global default; a user in another timezone is paged wrongly | S2 | SYNTH |
| `core/config_defaults.yaml:45-53` | Per-event notification matrix, comment states it is the owner column of a docs matrix | Same | S3 | SYNTH |
| `core/profile.py:39-70` | `Profile` dataclass defaults mirroring the same owner values | Same, at a second layer | S2 | SYNTH |
| `monitor/tagging.py:10-16,29-33` | `DEFAULT_DOMAIN` is the owner's domain; fixed four-family ladder taxonomy | Mis-tags roles outside the owner's domain | S2 | SYNTH |
| `monitor/gates.py:33-35,49`, `monitor/geo.py:38-45,92,147,157` | US-only normalization and metro parsing | Consistent with DEC-007 | S4 | KEEP |
| `monitor/companies.*.csv`, `monitor/candidate_companies.csv`, `monitor/scripts/expand_companies.py:71-101` | ~900-row target-company universe curated for one profile (`docs/companies-expansion.md:73` states the reasoning) | Skews discovery for all users; not personally identifying | S3 | KEEP as a shared corpus, with provenance recorded, or regenerate generically |

### 3c. Legacy tooling only

| Path | Category | Sev | Disposition |
|---|---|---|---|
| `.github/workflows/selfheal.yml:25`, `ci.yml:353`, `run-bot.yml:125,135`, `tracker/provision.py:85` | Literal owner user-slug as the default identity | S3 | SYNTH |
| `.github/workflows/ci.yml:316` | Owner email as a literal `--owner` argument | S3 | SYNTH |
| `tracker/bootstrap.py:336,352,400,442` | Sheet-seeding copy carrying the owner's full name; `:400` branches on a literal user slug | S3 | SYNTH or DELETE with the Sheet cutover |
| `README.md:3`, `infra/Dockerfile:17`, `monitor/{config,gates,geo,priority}.py`, `tracker/{promote,quickadd,scout,simplify}.py`, `core/{notify,channels,pgwrites}.py`, `infra/app/handler.py:104`, `db/migrations/0010_pipeline.sql:557`, `db/migrations/0013_referral.sql:323` | Owner and family members named in comments and docstrings | S3 | SYNTH — comment-only, but pervasive: a source reader learns exactly who this was built for. **Migration comments cannot be edited in place; see §7.** |

### 3d. Verified generic despite appearance

`webapp/lib/apply/policy.ts` and `db/migrations/0014_apply_answers.sql` (situation-typed,
deliberately answer-free); `webapp/lib/gating/{comp,dispose,titles}.ts` (sanity bounds,
not floors); `webapp/lib/profile/money.ts` (`comp_min` defaults to 0 — gate off);
`webapp/lib/warm/config.ts` (env-overridable spend caps);
`webapp/lib/grid/company-presets.ts`, `webapp/lib/apply/demo-boards.ts` (keyed to UI
states); `db/migrations/**` schema (`profiles.criteria` defaults to `'{}'`, no seeded
values). Disposition KEEP for all.

`webapp/lib/apply/types.ts:309` and `webapp/lib/apply/prepare.ts:614` reference the
master-résumé only as a *concept* in the citation contract; facts come from the database.
Vaulting `master-resume.md` does not break them, but the naming should be revisited so
the product does not appear to depend on a file that no longer exists.

## 4. Inventory — fixtures and demo data that are real data in costume

| Path | What it is | Sev | Disposition |
|---|---|---|---|
| `webapp/lib/data/preview-fixtures.ts:138-155` | The demo profile is explicitly the owner's | S2 | SYNTH |
| `webapp/lib/data/apply-fixtures.ts:74,90,145,231` | Owner's first name and a compensation figure in demo data | S1 | SYNTH — a compensation figure rendered to a pilot user in demo mode is a disclosure |
| `webapp/lib/data/warm-fixtures.ts:9-10,54,65`, `webapp/lib/data/fixtures.ts:323` | Owner's school and former employer as demo values | S2 | SYNTH |
| `infra/render/fixtures/reference_cv.yaml` | See §2 | S2 | SYNTH |

Fixtures render in demo mode and in the E2E suite. `HQ_DEMO` must never be enabled in
production, but a fixture is shipped source regardless, and demo mode is exactly the
surface a prospective user is shown.

## 5. Inventory — snapshots, exports, dumps

| Path | Size | What it is | Sev | Disposition |
|---|---|---|---|---|
| `snapshots/pg/hq.sql.gz` | 816,890 B, 6 commits (2026-07-28 → 2026-08-01) | **A real production Postgres dump.** `COPY` blocks for 23 tables including `users`, `profiles`, `applications`, `application_notes`, `answers`, `capture_tokens`, `email_events`, `connections`, `allowed_emails`, `warm_searches`. One real user, one profile, 14 real applications. `capture_tokens` and `answers` are empty in these six blobs — **on this lane they would not have been** | S1 | DELETE from the tree; history decision is separate and owner-approved |
| `snapshots/hq/feed.csv` | 3,211,332 B | Production Sheet mirror | S2 | DELETE |
| `snapshots/hq/pipeline.csv` | 34,394 B | Production Sheet mirror — most likely to carry per-application personal content | S1 | DELETE |
| `snapshots/hq/digest.csv` | 14,289 B | Same | S1 | DELETE |
| `snapshots/hq/{log,scout_jobs,companies,health,config,quick_add,scout_daily,targets}.csv` | ~280 KB total | Production Sheet mirrors, committed nightly | S2 | DELETE |
| `monitor/snapshots/hq.json` | 2,006,951 B | Engine-state snapshot | S3 | DELETE |
| `monitor/snapshots/pm.json` | 798,835 B | Engine-state snapshot | S3 | DELETE |
| `tracker/data/{applog,scout,simplify}-import.csv` | ~9 KB | Described in `.gitignore` as sanitized; migration import data | S3 | Verify sanitization, then VAULT |

Containment for the dump is **already done and must not be undone**:
`.github/workflows/pgdump.yml` is disabled by design under incident FP-OPS-001 — its only
step is `exit 1`, `PGDUMP_ENABLED` is deliberately ignored, and the file is retained as
incident evidence. Remediation (history and credential rotation) was deferred to an
owner-approved packet. Roadmap tasks #18/#19 track the S3 replacement lane. This audit
does not reopen that decision; it records that **containment is complete and remediation
is not**, and that the six blobs remain reachable by anyone who can clone.

## 6. Inventory — credentials

No live API key, token, or private key was found in the tree or in any commit. Probes
across all refs for `ghp_`, `github_pat_`, `AKIA`, `-----BEGIN`, `client_secret`,
`AIzaSy`, `xoxb-`, `password=` returned zero commits. `sk-ant-` appears only as a
documentation placeholder (`.env.example:6`, `infra/README.md:55`, `docs/RUNBOOK.md:935`).
No `.env` is tracked. Postgres URLs with passwords are all loopback test harness. Secret
hygiene in this repository is genuinely good.

The credential finding is of a different shape.

| Path | What it is | Sev | Disposition |
|---|---|---|---|
| `hq.config.yaml:21-23` | Two **live ntfy topics**, committed as literals. An ntfy topic *is* the credential: anyone holding the string can read every notification published to it and publish arbitrary pushes to the owner's phone. Both contain the owner's name | S1 | ROTATE |
| `.github/workflows/resume.yml:33` | The same literal as a **hardcoded fallback**: `secrets.HQ_NTFY_TOPIC \|\| '<literal>'` | S1 | ROTATE + DELETE the fallback |
| `appsscript/capture/Code.gs:43-45` | Same literals as constants | S1 | ROTATE |
| `docs/{ACTIVATION,RUNBOOK,SYSTEM,MULTIUSER}.md` | Same literals in prose | S1 | ROTATE |
| `docs/design-history/specs/2026-05-26-pm-job-monitor-design.md:90` | A historical topic string | S2 | ROTATE |
| `hq.config.yaml:25-26` | Two Google Drive folder IDs — capability-URL-shaped | S2 | Treat as secret; move to configuration |
| `hq.config.yaml:28-29` | GCP service-account email and owner email | S3 | SYNTH / move to configuration |
| `tests/core/test_workflows.py:242` | A different ops-topic-shaped string used as a fixture; looks synthetic | S4 | Owner eyeball, then SYNTH to an obviously-fake value |

**Roadmap task #34 ("Remove the hardcoded jobs ntfy topic in `resume.yml`") is marked
completed, but the literal is present at HEAD.** Commit `dd4527c` documents rotation as a
pending owner action rather than performing it. The topics must be assumed live.

### The irreversible part

`.github/workflows/resume.yml` triggers on every push to `main` touching `resume/**`. It
renders both résumé variants, publishes to a private Google Drive folder via an Apps
Script uploader, and then **pushes the rendered preview and the résumé itself as an
attachment to `https://ntfy.sh/$HQ_NTFY_TOPIC`**.

ntfy.sh is a public broker. The topic is the only access control, and the topic literal
is committed in seven files — including as this workflow's own fallback when the secret
is unset. Anyone who has read this repository, at any point in its life, can subscribe to
that topic and has been able to passively receive every rendered résumé since the
workflow existed.

**Material published to a public broker must be treated as irreversibly exposed.**
Rotating the topic stops future publication. It does not retract anything already sent,
and it cannot. The private-repo status is the only reason to believe the audience was
small; it is not evidence that the audience was empty.

This is the highest-value single action available in this audit — ahead of the dump
history rewrite, because the dump was never pushed anywhere public and this was.

## 7. History-only findings — recorded, not acted on

No action is taken on history in this audit. Recorded for the separate, owner-approved
history packet:

- `snapshots/pg/hq.sql.gz` — six blobs, `4c91b6f` (2026-07-28) → `eb39b88` (2026-08-01).
- `snapshots/hq/email_events.csv` — added `09d248a` (2026-07-13), deleted `d8fd49b`
  (2026-07-21). Email-event data for a real user; content live in history across that
  eight-day range.
- `profiles/pm.yaml` — added `4c36292` (2026-05-26), deleted by the restructure `93efc32`
  (2026-07-13). Per `docs/design-history/specs/2026-05-26-pm-job-monitor-design.md:90`
  this file historically carried a notification topic.
- `snapshots/pm.json`, `candidate_companies.csv`, `candidates_resolved.csv`,
  `candidates_unresolved.csv`, `new_companies_to_add.csv`, `companies.seed.csv`,
  `background-context/**` — all removed by `93efc32`; renames, so content survives under
  current paths and is *also* in history at the old ones.
- Every `hq.config.yaml` commit since inception carries the live ntfy topics.
- `db/migrations/0010_pipeline.sql:557` and `0013_referral.sql:323` name individuals in
  comments. **Migrations are append-only and keyed by filename in the production
  `schema_migrations` ledger.** Editing them re-runs them. These comments can only be
  addressed by history rewrite or left in place; the correct answer is almost certainly
  to leave them and record the deviation.

There is no `interview-prep/` directory in this repository's history, and no committed
rendered résumé PDF or DOCX — `.gitignore` has held on `resume/out/` throughout.

## 8. Adjacency risk — present but untracked

The owner's working checkout currently holds, untracked and **not covered by
`.gitignore`**:

- `interview-prep/` — live interview preparation for three named, in-flight applications.
- A `.m4a` audio recording of a real recruiter screen, at the repository root.

Neither is in git. Both are one `git add -A` away from being in git permanently, and one
of them is a recording of another person's voice. This is the cheapest and most urgent
item in the entire audit: a `.gitignore` entry, no moves, no deletions, fully reversible.

## 9. Sequenced plan

Each step names what must be true before it runs and whether it can be undone. Steps 1–3
are independent of the vault split and should not wait for it.

### Step 0 — freeze the adjacency (immediate, reversible, no approval needed)

Add `interview-prep/` and audio extensions to `.gitignore`. Verify with
`git status --porcelain` that neither appears.
**Precondition:** none. **Reversible:** entirely.
**Owner approval:** not required.

### Step 1 — rotate the ntfy topics (urgent, irreversible in one direction)

1. Owner creates two new topics and stores them as `secrets.HQ_NTFY_TOPIC` and
   `secrets.HQ_OPS_NTFY_TOPIC`.
2. In one coordinated change, remove all seven literals — `hq.config.yaml`,
   `.github/workflows/resume.yml` (**delete the `|| '<literal>'` fallback rather than
   overriding it**; a hardcoded topic or literal fallback is a test failure per
   `CLAUDE.md`), `appsscript/capture/Code.gs`, and the four docs. Redact the design-history
   spec.
3. Verify no notification path silently no-ops: a workflow that loses its fallback and
   its secret pages nobody, which is worse than paging the wrong topic.

**Precondition:** owner has created the replacement topics. A partial rotation is worse
than none — it leaves a working topic behind while creating the belief that rotation
happened.
**Irreversible:** the old topics stay valid until deleted, and everything already
broadcast to them is already gone. Rotation is forward-only protection.
**Owner approval:** required (owner action, owner devices).

### Step 2 — stop the snapshot writers (reversible)

Confirm no scheduled job still writes `snapshots/**` or `monitor/snapshots/**`.
`pgdump.yml` is already hard-disabled; do not touch it — it is incident evidence.
**Precondition:** the S3 replacement lane (tasks #18/#19) exists or the owner accepts the
gap.
**Reversible:** yes.

### Step 3 — synthesize the fixtures (reversible, T2)

Replace §4 fixture identities with obviously-fictional data. Do this **before** the vault
move, so demo mode and the E2E suite never depend on a file that is about to leave.
**Precondition:** none. **Reversible:** yes.
**Verification:** change-scoped lane plus the demo-mode browser proof; the compensation
figure in `apply-fixtures.ts` must be gone from rendered output, not merely renamed.

### Step 4 — de-personalize the defaults (reversible, but T2/T3 by blast radius)

In dependency order:

1. `core/config_defaults.yaml`, `core/profile.py` and `monitor/tagging.py` — worker
   defaults. The tagger belongs here, not with the taxonomy in (3): its
   `DEFAULT_DOMAIN = "product-manager"` made an unset `tag_domain` read every posting
   through the owner's field, which is the *unset-acquires-a-value* bug, not the ladder
   question. Fixed in #253 — unset now claims no field, keeps the neutral seniority
   alphabet the three named families already fall back to, and says so once per run
   (a weaker-than-configured lane must not look healthy, per #252/#255). The four
   `SENIORITY_LADDERS` families themselves are (3)'s problem and were left alone.
2. `webapp/lib/profile/criteria.ts` — make the write-path fallback an explicit *unset*
   state, not a different default. A generic default is still a default; the bug is that a
   blank field silently acquires a value.
3. `webapp/lib/profile/presets.ts` — replace with a general job-family taxonomy. This is
   blocked on §5 of `07-decisions-assumptions-risks.md` (the general-market taxonomy and
   golden corpus) and **should not be improvised**.
4. `webapp/lib/warm/{intro-context,fit}.ts` prompt fallbacks.
5. Comment and CI-slug sweep (§3c), excluding migrations.

**Precondition for (3):** the taxonomy decision exists. Until then, (3) is blocked, not
deferred.
**Reversible:** yes, but (1) and (2) change what every user's sweep and profile write do —
these are behaviour changes and carry the tier their blast radius implies, not the tier
their diff size implies.
**Owner approval:** required for (3).

### Step 5 — the vault move (irreversible in practice)

Move §2 VAULT items to the private owner vault, delete the `applications` symlink, and
delete the §5 snapshot files from the tree.

**Preconditions, all of them:**
- Steps 3 and 4 complete, so nothing the product reads points at a vaulted path.
- The vault exists, is backed up, and the owner has verified the copy — the résumé source
  and `master-resume.md` are the owner's live working documents, not archives.
- ADR-004 (one-time legacy owner data: clean start versus explicit one-time import) is
  resolved. Vaulting `users/*/profile.yaml` before that decision destroys the input to the
  import path if the owner chooses import.
- The legacy résumé pipeline (`resume.yml`, `editor/`, `scripts/publish_to_drive.py`,
  `scripts/yaml_to_docx.py`) is either retired or repointed. The `editor/` app is
  single-tenant by construction: it edits *this repository's* file over the GitHub API.
  Vaulting `resume/base.yaml` breaks it. That is probably correct, but it must be a
  decision rather than a surprise.

**Irreversible:** deleting the tree copies is recoverable from git history — which is
precisely why deletion does not reduce exposure. The unrecoverable failure mode is
different: if the vault copy is wrong or incomplete and history is later rewritten, the
owner's career corpus is gone. **Verify the vault before deleting anything, and do not
rewrite history in the same change as the move.**
**Owner approval:** required.

### Step 6 — third-party data (separate, and not merely technical)

`users/dad/profile.yaml` and `users/roommate/profile.yaml` are two other people's
personal data. Deleting the files does not remove them from history or from any clone.
The owner should decide whether these individuals are told. This is a notification
question, not an engineering one, and it should not be silently folded into Step 5.
**Owner approval:** required.

### Step 7 — history decision (irreversible; separate packet; not this audit)

Deferred to the owner-approved history packet already referenced by
`docs/pilot-launch/packets/00-baseline-and-containment.md`. Recorded here only so it is
not lost.

What must be true first: every collaborator and every clone is known; all CI, deployment,
and worktree references are inventoried; a full mirror backup exists and has been
restore-tested. A history rewrite invalidates every existing clone, every open PR, and
every commit SHA cited anywhere in `docs/` — including several citations in this package.
**It cannot be undone.** It is also the only action that removes the dump and the
historical topics from the repository, and it does nothing at all about material already
broadcast to a public broker.

## 10. What this audit did not do

No file was moved, deleted, or renamed. No history was rewritten. No code the product
reads was changed. No credential was rotated — Step 1 is an owner action and is
deliberately not pre-executed. Line numbers are as observed at `f710f50` and will drift.

## 11. Counts

| Category | S1 | S2 | S3 | S4 |
|---|---|---|---|---|
| Owner and third-party personal content (§2) | 7 | 4 | 3 | — |
| Owner defaults in product logic (§3) | — | 12 | 8 | 3 |
| Fixtures that are real data (§4) | 1 | 3 | — | — |
| Snapshots and exports (§5) | 3 | 9 | 3 | — |
| Credentials (§6) | 5 | 2 | 1 | 1 |
| History-only (§7) | 3 | 3 | — | — |
| Adjacency (§8) | 2 | — | — | — |
