# Reconciled roadmap ledger

## 1. Purpose

This ledger reconciles the repository, recently updated build logs, design gap analyses,
and active branches as of 2026-07-28. It answers two separate questions:

1. What remains before a narrow invite-only pilot?
2. What remains in the total outlined product roadmap?

Status is evidence-based:

- **Released base:** on the current integrated base and used by the system.
- **Branch complete:** implemented and verified on a feature branch, but not accepted on
  one release candidate.
- **Branch incomplete/unsafe:** branch exists but has a named correctness or release gap.
- **Specified:** design/plan exists; implementation incomplete or absent.
- **Open decision:** work cannot be finalized without owner policy.
- **Deferred:** intentionally outside the recommended pilot.

Older build logs contain stale “next up” prose. Current code/migrations take precedence.

### Evidence snapshot

Read-only branch and migration inventory verified 2026-07-28 by the specification
author. Recheck after any branch movement, rebase, force-push, or integration.

| Item | Evidence reference | Interpretation |
|---|---|---|
| Integrated base reviewed | `5c48449328e593e8794791244a13703d86ac5586` | migrations through `0020` present |
| Jobs redesign | `feat/redesign-jobs` at `4a9b09e06cb603118b0305f3dafbe534ed953ec8` | branch implementation; isolated gate result reported, integration not proven |
| Dictionary/anti-slop | `feat/phase0-dictionary-slop-ci` at `c4afa9fcf98288314da1bdb8183935804e269b51` | branch implementation; isolated gates reported, integration not proven |
| Company domains | `feat/company-domain-logos` at `77a3a589cf0e8c6bc767f99bef22acf6b08523a2` | branch exists; follow-up repair/full gate outstanding |
| Email reviews | `feat/e1-email-events` at `1340af9ec6cb1f707622f058ef2f2297a5b9b455` | branch exists; security/concurrency findings unresolved |
| Bot activity | `feat/e3-heartbeats` at `177a8c4e2bc64c59dab5d2ee4de3887c0557d694` | branch exists; integration/qualification unresolved |
| Display preferences | `feat/e5-display-prefs` at `6422d080a62e5fa354685180dcdd63e526928969` | branch exists; integration/qualification unresolved |
| Resume productization | `feat/resume-productized` at `c0eaa5ac98f41337ad935e49c995cfed80e2941d` | branch exists; storage/render/deletion gaps remain |
| Entitlements | `feat/entitlement-model` at `c1e14ddce51062496678db834ace21a058d2f77b` | branch exists; DB/RPC default-deny gap remains |
| Git database dump | `.github/workflows/pgdump.yml`; tracked `snapshots/pg/hq.sql.gz`; commits including `d6f9406` | verified workflow commits the full `public` schema; incident assessment required |

“Reported” test results are not release evidence until their artifacts are attached to
the integrated release candidate under `05-verification-and-traceability.md`.

## 2. Executive status

### Already substantial

- AWS Lambda/EventBridge bot platform, alerts, heartbeats, and S3 sheet backup lanes.
- Twelve ATS adapters and company discovery tooling.
- Durable Sheet access contract.
- Web app foundation, injectable data source, fixtures, authenticated server reads,
  RPC-only writes, idempotency, optimistic/undo/offline/conflict patterns.
- Queue/triage, virtualized Jobs engine, saved views, bulk decisions.
- Company universe/review/reconciliation.
- Applications pipeline, notes, statuses, human-wins lock.
- Search profile/onboarding and two-language gate corpus.
- Connections import and safe LinkedIn deep links.
- Import/export for jobs/applications.
- Prepare/Review logic and answer library, without submission.
- Postgres engine writes, Gmail capture endpoint, SES digest/action foundation.
- Warm-referral layer 2.
- Main migrations through `0020`.

### Complete on separate branches

- Jobs redesign and new app shell.
- Display dictionary completion and anti-slop CI.

These still require integration, current-base re-verification, and release acceptance.

### Critical new finding

The current Git-based Postgres backup commits private `public`-schema data into source
history. This supersedes normal feature sequencing: contain and remediate it before
external pilot data is accepted.

## 3. Pilot critical path ledger

| ID | Work | Current status | Pilot treatment | Exit |
|---|---|---|---|---|
| P-001 | Git dump incident and encrypted backup replacement | Unsafe current workflow/data | P0 blocker | WP-000 |
| P-002 | Pilot contract, consent, support, retention | Open owner decisions | P0 blocker | Every decision applicable under `pilot-contract-v1`, including D-021 |
| P-003 | Dictionary and anti-slop enforcement | Branch complete | Integrate first | Full release-candidate gates |
| P-004 | Company domains/logo ladder (`0021`) | Branch with targeted repair; full integrated gate outstanding | P1 for Jobs parity | WP-011 |
| P-005 | Ambiguous email review (`0022`) | Branch unsafe under candidate/race boundary | P0 if Gmail; otherwise disable | WP-012 |
| P-006 | Per-user activity (`0023`) | Branch exists; bounds/ownership/freshness require qualification | P0 | WP-013 |
| P-007 | Preparation persistence (`0024`) | Missing | P1 only if Prepare/Review ships | WP-014 or remove entry points |
| P-008 | Display preference consolidation (`0025`) | Branch exists; not integrated | P1 for complete redesign | WP-015 |
| P-009 | Resume productization (`0026`) | Branch exists; storage/render/deletion gaps | Defer unless preparation needs artifacts | Separate accepted gate |
| P-010 | Entitlements (`0027`) | Branch does not enforce DB/RPC default deny | P0 if used; otherwise smaller allowlist DB gate | WP-016 |
| P-011 | Jobs/shell redesign | Branch complete and pushed | P0 | Rebase/integrate/parity |
| P-012 | Today redesign | Specified; not integrated | P0 | WP-021 |
| P-013 | Applications redesign | Specified; not integrated | P0 | WP-023 |
| P-014 | Coverage redesign and source-of-truth fork | Specified/open decision | P0 | WP-024 + D-021 |
| P-015 | Settings/account/data redesign | Partial old settings; target specified | P0 | WP-025 |
| P-016 | Auth/holding/suspension/provisioning | Partial foundation + unsafe entitlement branch | P0 | direct auth matrix |
| P-017 | Gmail product lane | Owner-only Apps Script/current capture foundation | P0 only if core promise includes it | D-004 + WP-030 |
| P-018 | Notification consent/unsubscribe | Digest base exists; consumer controls incomplete | P0 if sending email | WP-031 |
| P-019 | Full account archive and deletion | Dataset export exists; complete Leave flow absent | P0 | WP-025/026 |
| P-020 | Production-equivalent staging | Not proven | P0 | real auth/RLS/storage qualification |
| P-021 | Restore/reconciliation/kill-switch rehearsal | Not accepted; current backup unsafe | P0 | WP-041/042 |
| P-022 | Design parity all pilot states | Jobs branch only + dictionary branch | P0 | design manifests/owner acceptance |
| P-023 | Pilot support/incident/feedback operations | Spec now exists; owner details open | P0 | WP-043 |
| P-024 | Owner soak/canary/cohort | Not started | Final launch sequence | WP-051–053 |

## 4. Full surface roadmap

### Today

Current:

- Queue decision engine, keyboard, optimistic writes, undo, offline and conflict handling
  are built.
- Email review and preparation sources are incomplete/conditional.

Remaining:

- New Today route and exact design composition.
- Correct New roles, Ready to review, Suggested updates sections.
- Badge aggregation and all-clear/first-run/degraded states.
- Correct binding-constraint guidance via relaxation.
- E1/E2 sections only when real sources are enabled.
- Redirect/retire `/queue` after cutover.

Pilot: required with New roles; conditional sections may remain absent honestly.

### Jobs

Current:

- Rich grid engine, filtering, URL state, saved views, selection, export, virtualization.
- Redesign implemented on `feat/redesign-jobs`.
- Dictionary/anti-slop implemented separately.

Remaining:

- Integrate branches and current migrations.
- Resolve warm-intro/company-cell composition.
- Integrate display preference ownership.
- Company domain/logo full verification.
- Production-like performance and state parity.
- Retire old Why, Warm column, personas, and bundled display knobs.

Pilot: required.

### Applications

Current:

- Pipeline, status contract, notes, actor lock, conflicts, import/export.
- Gmail capture and digest foundations.

Remaining:

- Four-band Applications presentation and 400px pane.
- Activity and add-note composition.
- Suggestion review wired to safe E1.
- Manual/freshness state when Gmail is unavailable.
- Add job/application entry point under new IA.
- Redirect/retire `/pipeline`.

Pilot: required.

### Autopilot

Current:

- Answer library, policy topics, board parsing, deterministic preparation, per-application
  review page.
- Explicitly no submit.

Remaining:

- `0024` staged queue/state/snapshot persistence.
- Autopilot review surface.
- Exact gap/source copy.
- Optional resume selection/artifact integration.
- Approval invalidation/hash.
- Later: isolated executor, consent/rules, live-form revalidation, receipts, Gmail
  independent confirmation, submission log, throttles and provider policies.
- Later: model-assisted free-response drafting under truth/sensitivity rules.

Pilot: honest unavailable recommended; Prepare/Review conditional; submit deferred.

### Coverage

Current:

- Company review grid/RPCs/reconciliation.
- Connections import/deep links.
- Warm referral layer 2.
- Planned activity branch.

Remaining:

- E4: choose Postgres vs Sheet authority and wire `monitor/run.py`.
- Exact Coverage tabs/composition/copy.
- Per-user activity/freshness/failures.
- Source/confidence dictionary.
- External enrichment UX and cost/consent if used.
- Consolidate/redirect `/companies`, `/connections`, `/health`.
- Referral layer 3 outreach funnel, if later approved.

Pilot: Coverage/freshness required; external enrichment/referral outreach optional/deferred.

### Settings

Current:

- Profile/onboarding logic and preview.
- Partial display preference mechanisms.
- Answer settings.
- Per-dataset import/export.

Remaining:

- Settings shell/rail and exact groups.
- Profile & search presentation.
- Preferences including display and notifications.
- Connected accounts state/consent/revoke/freshness.
- Data: import, per-dataset export, full archive.
- Account: identity, support, suspension/deletion.
- Optional Plan & billing.
- Profile v2 E8: what-work compilation, canonical geographies, visa signal.

Pilot: core settings/data/account required; billing/E8 may defer.

### Auth and onboarding

Current:

- Supabase session, Google sign-in, RLS, onboarding redirect/profile wizard.

Remaining:

- Exact auth/onboarding design.
- Named invite/allowlist provisioning and default-deny data boundary.
- Pending/suspended/removed states.
- Session management and sensitive-action re-authentication.
- Terms/privacy/support links.
- Optional email/password/code flows if selected.
- Open-signup abuse/rate controls only if scope expands.

Pilot: closed invite path required; open signup deferred.

### Import and export

Current:

- Four-stage resumable import, mapping, preview, commit/report, dedupe and conflict
  handling.
- Jobs/applications CSV/XLSX export and round-trip identifiers.

Remaining:

- Design/copy re-registration.
- Surface existing Selection export when selection exists.
- Formula-injection and cross-application compatibility proof.
- Full-account archive manifest.
- Account deletion linkage.

Pilot: required.

### Email and notifications

Current:

- SES mailer, operator-oriented digest, signed action foundations.
- SES sandbox constraints.

Remaining:

- Split operator briefing from consumer digest.
- Single-alert template.
- Notification preferences and deep link.
- List-Unsubscribe/unsubscribe.
- Bounce/complaint/suppression.
- Production sending decision/access.
- Transactional auth template if product owns it.
- Submission record only after submit exists.
- E6 product Gmail watcher/poller for scalable non-owner use.

Pilot: only the emails actually sent need full gates; other templates may defer.

### Landing, legal, and billing

Current: substantially absent.

Remaining:

- Public landing route and authenticated redirect behavior.
- Real product screenshot/crops only after surfaces are accepted.
- Terms, Privacy, contact.
- Product name/domain/sender.
- Billing state, Stripe checkout/portal/webhook.
- Usage enforcement and plan display.
- Company cap selection rule.
- Paid feature definition that does not sell unbuilt auto-submit.

Pilot: public landing and billing deferred under a named free invite-only cohort.
Pilot notice/privacy/contact still required.

### System surfaces

Remaining:

- Command palette.
- Unified add-job flow.
- Shortcuts help.
- 404, 500, offline, maintenance, permission, and configuration-error states.
- Cross-route navigation/redirect cleanup.
- Global accessible toast/dialog/pane behavior.

Pilot: error/offline/permission surfaces required; command palette may defer.

## 5. Engine, data, and infrastructure roadmap

### Discovery

Current:

- Twelve ATS fetchers, scheduled sweeps/review/wide channels, company seed/review
  infrastructure.

Remaining:

- E4 authoritative company source for every web user.
- Per-user schedule fan-out and isolation.
- Known geography activation gaps.
- Provider coverage/cost/rate budgets.
- Shared-fetch/caching architecture before meaningful scale beyond the pilot cap.
- Honest completeness and freshness measurement.
- Company-domain canonicalization and privacy decision.

### Application/email engine

Remaining:

- Safe E1 ambiguous review resolution.
- Productized per-user Gmail authorization/capture.
- Per-user join/reconciliation/lag.
- Retention and deletion.
- Consumer notification controls/deliverability.
- Optional future submission executor under separate authorization.

### Database/API

Remaining:

- Integrate `0021`–`0027` with missing `0024` decision.
- Exactly-once migration ledger/checksums/locking if current runner lacks them.
- Database-default-deny access predicate.
- Complete RLS/RPC/storage auth matrix.
- Full archive/deletion.
- JSON/input bounds and error taxonomy.
- Production-like GoTrue/Storage/RLS verification.
- Query/volume qualification.

### Infrastructure/operations

Current:

- Lambda/EventBridge schedules, in-process and CloudWatch alerting, Sheet S3 snapshots.

Remaining:

- Stop and remediate Git database dumps.
- Encrypted database and object backups.
- Restore automation/drills.
- Production/staging isolation and release manifests.
- Per-user health and feature kill switches.
- Incident/support/data-request operations.
- Cost and quota monitoring.
- Deployment canary and rollback rehearsal.

### Sheet sunset

Planned phases remain:

- keep dual writes and reconcile;
- move each reader/writer lane to Postgres;
- preserve operator fallback through accepted soak;
- remove Sheet as system of record only after all user lanes, backups, restore, and
  support paths are proven;
- retire or archive Sheets with explicit read-only/history policy.

Pilot: do not complete sunset before the narrow pilot unless the entire recovery
contract is independently satisfied.

## 6. Product-learning and customer roadmap

Before pilot:

- define target segment and recruitment criteria;
- prepare consent/privacy/support materials;
- baseline interview;
- onboarding observation script;
- pilot metrics and privacy-minimal event dictionary;
- feedback taxonomy;
- incident communication;
- export/deletion exit.

During pilot:

- structured weekly check-in;
- status/data correction sampling;
- support burden measurement;
- discovery-quality sampling against the declared segment;
- trust/comprehension review;
- cohort expansion only on evidence.

After pilot:

- decide whether value is strong enough to expand;
- choose the next biggest validated problem, not the largest existing spec;
- update pricing only after measurable usage/value and stable entitlements;
- decide Gmail productization, Autopilot, referrals, and Sheet sunset from pilot evidence.

## 7. Dependency-ordered release roadmap

### Release 0 — containment

- WP-000 database dump incident.
- Pilot policy decisions.
- Freeze invitations.

### Release 1 — integration foundation

- Dictionary/anti-slop.
- Serial migration integration.
- Default-deny access.
- Safe E1 or email disabled.
- Per-user activity.
- Shared shell and design primitives.

### Release 2 — core Decide

- Today.
- Jobs.
- Profile/onboarding.
- Coverage truth/freshness.

### Release 3 — core Track and Leave

- Applications.
- Manual or safe Gmail status path.
- Import/export/full archive.
- Settings/notifications/connected accounts/deletion.

### Release 4 — operations qualification

- Encrypted restore proof.
- Staging auth/RLS/storage.
- Reconciliation.
- Kill switches/alerts/incidents/support.
- Strict parity/accessibility/security/performance evidence.

### Release 5 — pilot

- Owner soak.
- One-user canary.
- 3–5 user wave.
- Four-week review.

### Post-pilot decision tree

- If daily Decide value is strong: improve discovery breadth/quality and shared fetch.
- If Track trust is weak: prioritize Gmail/reconciliation/evidence, not Autopilot.
- If Leave/support trust is weak: fix export/deletion/operations before growth.
- If Prepare demand is strong: land `0024` and resume artifacts before any executor.
- If willingness to pay is demonstrated: specify billing/entitlements and a real paid
  capability.
- If scale is approved: productize OAuth, scheduling, support, abuse, cost, and Sheet
  sunset.

## 8. Definition of roadmap completion

An item leaves this ledger only when:

- implementation is integrated;
- source docs reflect actual behavior;
- production/fixture interfaces conform;
- requirements and negative cases are traced;
- security/privacy/design/accessibility/reliability gates pass;
- deployment and rollback/disablement are real;
- release evidence identifies the exact artifact;
- owner decisions and accepted risk are recorded.

A pushed branch, a passing isolated test suite, or a design handoff alone is not
completion.
