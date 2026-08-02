# Full-product requirements register

Contract: `full-product-pilot-v2`

Status values are `proposed`, `accepted`, `implemented`, `verified`, `released`, or
`retired`. PKT-00A MUST add owner, implementation commit, evidence link, and status
without weakening requirement meaning.

## Scope, identity, and authority

| ID | Normative requirement | Acceptance oracle |
|---|---|---|
| FP-SCOPE-001 | Every activated user MUST receive every contracted Complete or Capability-matrix feature | Route/API/worker probe for two active users |
| FP-SCOPE-002 | Gmail mailbox ingestion, classification, and status mutation MUST be disabled | No mail scopes/tokens/schedules/routes |
| FP-SCOPE-003 | No control or claim may promise an effect it cannot complete or hand off honestly | State/action audit |
| FP-SCOPE-004 | Provider automation support MUST be versioned, enforced, and user-visible | Matrix equals adapter flags and live health |
| FP-ID-001 | Anonymous users may access only public/auth/legal/support routes | Route, DB, RPC, storage matrix |
| FP-ID-002 | Pending users MUST receive a holding state with no product data/commands | Direct boundary negatives |
| FP-ID-003 | Founding users MUST receive free-forever, uncapped, all-capability entitlement | Entitlement and capability probes |
| FP-ID-004 | Unknown plan/capability/identity states MUST default deny | Default-allow mutation fails |
| FP-ID-005 | Ownership MUST derive from authenticated context inside authoritative locks | Client-selected owner rejected |
| FP-ID-006 | Provision, activate, suspend, re-invite, and delete MUST be idempotent/audited | Replay and event readback |
| FP-ID-007 | Suspension/deletion MUST revoke sessions, queues, workers, providers, notifications, and submissions | Revocation drill |
| FP-ID-008 | Two users MUST be isolated across DB, RPC, storage, cache, export, events, workers, and support | Real two-identity matrix |
| FP-ID-009 | Google sign-in MUST NOT imply/request Gmail mailbox consent | OAuth scope capture |
| FP-ID-010 | Service authority MUST be least-privilege, named, monitored, and absent from browser bundles | Credential/role/bundle audit |
| FP-DATA-001 | Postgres MUST be the sole authority for identity-linked product state | Runtime/write-path audit |
| FP-DATA-002 | Object storage MUST be authoritative for immutable artifacts/evidence | Checksum/manifest readback |
| FP-DATA-003 | Production MUST perform zero Sheet read/write/sync/reconciliation operations | Runtime tripwire |
| FP-DATA-004 | Every mutation MUST use an authenticated idempotent command/RPC | Direct DML denial and replay |
| FP-DATA-005 | Same idempotency key with different payload MUST be rejected | Contract test |
| FP-DATA-006 | Versioned resources MUST reject stale writes and preserve drafts | Concurrent-session test |
| FP-DATA-007 | Timeout after possible commit MUST have deterministic result lookup | Failure injection/reconciliation |
| FP-DATA-008 | Every logical mutation MUST have one safe audit event | Command/event equality |
| FP-DATA-009 | APIs MUST distinguish validation, auth, conflict, rate limit, dependency, unknown outcome, and internal failure | Schema examples |
| FP-DATA-010 | Fixtures MUST implement production data-source capabilities with identical defaults and states | Shared contract suite |

## Design and core surfaces

| ID | Normative requirement | Acceptance oracle |
|---|---|---|
| FP-DES-001 | Visible behavior MUST use the digested owner design sources and approved exceptions only | Design manifest/digest |
| FP-DES-002 | Navigation MUST be Today, Jobs, Applications, Autopilot, Coverage, plus Settings; Today-only badge | DOM/geometry/a11y tree |
| FP-DES-003 | UI MUST pass deterministic anti-slop and banned-copy checks | Every violation fixture fails |
| FP-DES-004 | Absent values MUST render `Not listed`; digits MUST be tabular | State/style corpus |
| FP-DES-005 | Every loading/empty/error/degraded/conflict/offline/session/permission state MUST exist where applicable | Route/state manifest |
| FP-DES-006 | True offline MUST disable writes; no browser mutation queue may dispatch later | Browser reconnect test |
| FP-DES-007 | Critical workflows MUST meet WCAG 2.2 AA with keyboard, touch, screen reader, zoom, reduced motion | Evidence matrix |
| FP-DES-008 | Critical workflows MUST work at 320, 375, 768, 1024, and 1440 CSS pixels | Viewport matrix |
| FP-DES-009 | Page-level horizontal scroll and hidden primary actions are forbidden | Geometry assertions |
| FP-TODAY-001 | Today badge/count/rows MUST use one owner-scoped actionable query contract | DB/read/UI equality |
| FP-TODAY-002 | Today MUST include new roles, Autopilot reviews, and product follow-ups when non-empty | State manifest |
| FP-TODAY-003 | Gmail-derived suggestions MUST not appear | Seeded event remains unused |
| FP-JOBS-001 | Jobs MUST use six default columns and four toolbar controls plus Display | DOM manifest |
| FP-JOBS-002 | Search/filter/view/selection/detail URL state MUST round-trip | Property/history tests |
| FP-JOBS-003 | Detail pane MUST restore deep links and close with Escape/focus restoration | Browser/geometry test |
| FP-JOBS-004 | Logos MUST use logo.dev, favicon, then deterministic monogram; no-domain is ordinary | Provider-failure matrix |
| FP-JOBS-005 | Export count/scope/rows MUST agree and neutralize formula injection | Export parser oracle |
| FP-APP-001 | Applications MUST support add/import/manual status/notes/activity/export without Gmail | End-to-end journey |
| FP-APP-002 | Human status MUST not be overwritten by automation | DB mutation test |
| FP-APP-003 | Two-tab conflicts MUST not lose a human edit | Concurrent test |
| FP-COV-001 | Coverage MUST reflect actual Postgres subscriptions and per-user runs | DB/worker/UI equality |
| FP-COV-002 | Freshness MUST distinguish never/running/succeeded/partial/failed/stale | State matrix |
| FP-COV-003 | Coverage MUST contain no Sheet source/sync/fallback claim | Copy/runtime audit |
| FP-SET-001 | Profile MUST support US, any job family/seniority/work model without persona defaults | Diverse corpus |
| FP-SET-002 | Profile preview and engine gating MUST share one deterministic corpus | Golden tests |
| FP-SET-003 | Re-gating existing roles MUST require explicit confirmation | Command/state test |
| FP-SYS-001 | Palette/add-job/shortcuts/404/500/maintenance/session states MUST be complete | Route manifest |
| FP-SYS-002 | Add-job parse failure MUST save a deduplicated stub without inventing facts | Server/browser test |

## Resume and Autopilot

| ID | Normative requirement | Acceptance oracle |
|---|---|---|
| FP-RES-001 | No Salman-specific resume/application/interview content may ship | Content/history scan |
| FP-RES-002 | Resume sources, versions, renders, and artifacts MUST be tenant-owned/versioned | DB/RLS/storage matrix |
| FP-RES-003 | Users MUST create/import/edit/render/select/export/delete resumes on phone and laptop | End-to-end journey |
| FP-RES-004 | Artifacts MUST bind immutably to source version/checksum | Artifact manifest |
| FP-RES-005 | Render/upload MUST enforce type, signature, size, resource, time, and network limits | Adversarial corpus |
| FP-RES-006 | Wrong-owner, stale, deleted, corrupt, oversize, or unsupported attachments MUST stop safely | Negative matrix |
| FP-RES-007 | Signed object access MUST be short-lived and non-enumerable | Storage tests |
| FP-RES-008 | Resume export, retention, backup, and deletion MUST match account contract | Archive/delete/restore |
| FP-AUTO-001 | Preparation MUST persist form identity/hash, answers/evidence/gaps, attachments, state/version, audit | Snapshot readback |
| FP-AUTO-002 | Approved payloads MUST be immutable; edits create a new version | Constraint/command test |
| FP-AUTO-003 | Sensitive/legal facts MUST never be inferred or submitted without explicit user fact/review | Policy mutation |
| FP-AUTO-004 | Unless ADR-002 authorizes policy-driven unattended execution with accepted eligibility/sampling/reset controls, production submission MUST require per-application approval | State/RPC/executor matrix |
| FP-AUTO-005 | Live form/schema/attachment/approval MUST be revalidated immediately before submit | Drift fixture |
| FP-AUTO-006 | One user/provider/job scope MUST create at most one external application | Concurrent provider test |
| FP-AUTO-007 | Executor commands MUST be scoped, signed, single-use, expiring, versioned, and revocable | Protocol adversarial test |
| FP-AUTO-008 | CAPTCHA, unexpected login/OTP, sensitive gap, or material drift MUST stop without bypass | Challenge corpus |
| FP-AUTO-009 | `submitted` requires approved payload plus strong provider confirmation | Receipt test |
| FP-AUTO-010 | Uncertain post-submit results MUST become `outcome_unknown` and never blind retry | Timeout injection |
| FP-AUTO-011 | User/provider/global kill switches MUST default safe and work during failure | Rehearsal |
| FP-AUTO-012 | Each ATS family MUST have independent fixtures, drift health, throttle, circuit breaker, support state | Qualification record |
| FP-AUTO-013 | Manual providers MUST preserve answers, attachments, link, checklist, and user outcome | Handoff journey |
| FP-AUTO-014 | Phone users MUST prepare/review/approve/observe; executor unavailability MUST be explicit | Phone test |
| FP-AUTO-015 | Gmail MUST NOT be required for a receipt or mutate application status | Submit without Gmail |
| FP-AUTO-016 | Activity MUST distinguish confirmed, unknown, retryable, terminal, cancelled, and manual | State/copy manifest |

## Referrals, commercial, notifications, and exit

| ID | Normative requirement | Acceptance oracle |
|---|---|---|
| FP-REF-001 | Referral search MUST not require/store a LinkedIn cookie/session | Request/storage audit |
| FP-REF-002 | Search MUST support editable personas, cancel, no-result, failure, rate-limit, reload | Provider/browser matrix |
| FP-REF-003 | Default result target MUST be 40 deduplicated total across three searches, configurable to 50, without a founding-user quota | Command/config test |
| FP-REF-004 | Fit claims MUST use evidence and expose missing/uncertain inputs | Scoring corpus |
| FP-REF-005 | Users MUST multi-pin/unpin/manually add candidates per job | Command/read consistency |
| FP-REF-006 | Funnel MUST support identified/contacted/replied/referred/interview with notes/follow-up | Journey |
| FP-REF-007 | Product MUST NOT impersonate the user, store/use the user’s LinkedIn cookie/session, automate the user session, or send outreach as the user; disclosed provider-sourced search is governed separately | Runtime/action/vendor audit |
| FP-BILL-001 | Plan checks MUST be enforced below UI and agree with usage | DB/RPC/worker matrix |
| FP-BILL-002 | Founding users MUST never be commercially quota-capped, charged, or expired; safety/provider/abuse limits remain | Boundary probes |
| FP-BILL-003 | Stripe webhooks MUST verify signature and be replay-safe | Webhook test |
| FP-BILL-004 | Checkout/portal MUST be hosted and secrets server-only | Bundle/route audit |
| FP-BILL-005 | Charging cannot activate until cancellation/downgrade/failure/refund/tax policy is approved | Release gate |
| FP-NOT-001 | Product email MUST require eligibility/opt-in and obey quiet hours | Scheduler/provider test |
| FP-NOT-002 | Unsubscribe MUST take effect within five minutes and before next send | Clock test |
| FP-NOT-003 | Bounce/suppression and duplicate-send prevention MUST be durable | Provider/replay test |
| FP-NOT-004 | Signed actions MUST expire, resist replay, and be revocable | Token matrix |
| FP-NOT-005 | Notifications/telemetry MUST exclude unnecessary private text | Payload/log audit |
| FP-EXIT-001 | Full archive MUST cover every data/artifact class with manifest/checksums | Inventory comparison |
| FP-EXIT-002 | Spreadsheet exports MUST neutralize formula injection | Malicious-cell corpus |
| FP-EXIT-003 | Deletion MUST require recent auth and stop processing before content removal | Sequence audit |
| FP-EXIT-004 | Deletion MUST cover DB, storage, queues, locally controlled provider credentials/data, notifications, and workers | Multi-store drill |
| FP-EXIT-005 | Deletion ledger MUST prevent restored backups from reactivating processing | Restore-after-delete |
| FP-EXIT-006 | Active-store and backup deletion MUST meet published 7/35-day schedule | Compliance report |
| FP-EXIT-007 | Deletion MUST NOT claim to retract an application already transmitted to an employer/ATS | Copy/state audit |

## Operations and release

| ID | Normative requirement | Acceptance oracle |
|---|---|---|
| FP-OPS-001 | No new database dump may enter Git after the containment cutoff | Workflow/runtime tripwire |
| FP-OPS-002 | Encrypted DB/object backups MUST have separate key/access and 35-day lifecycle | Config/access audit |
| FP-OPS-003 | Isolated restore MUST prove integrity, ownership, RPO/RTO, deleted-user suppression | Restore report |
| FP-OPS-004 | Every worker run MUST be attributable to one user and useful completion state | Run ledger |
| FP-OPS-005 | One user’s success MUST not mask another user’s stale/failed lane | Two-user alert fixture |
| FP-OPS-006 | Hosted uptime/application telemetry MUST work without owner laptop | Production evidence |
| FP-OPS-007 | Telemetry MUST be pseudonymous and content-field denylisted | Redaction audit |
| FP-OPS-008 | Every provider/high-risk feature MUST have an independent kill switch | Failure rehearsal |
| FP-OPS-009 | Production MUST contain no required owner-laptop/manual-babysitting process | Runtime audit |
| FP-OPS-010 | All known/platform-visible dump copies/history MUST be assessed/remediated; unknowable clones remain residual exposure | Incident/history report |
| FP-REL-001 | Every requirement MUST map to exact integrated evidence and reviewer acceptance | Traceability report |
| FP-REL-002 | Release MUST have zero unresolved severity 0/1 issues | Defect ledger |
| FP-REL-003 | Exact commit/config/provider/design digests MUST deploy without rebuild drift | Provenance check |
| FP-REL-004 | Owner MUST complete seven-day production soak using only web app | Soak ledger |
| FP-REL-005 | One external canary MUST run at least 48 hours before cohort invitations | Canary record |
| FP-REL-006 | Cross-user disclosure, lost write, false/duplicate submit, failed restore/delete, or critical a11y failure MUST stop rollout | Stop drill |
| FP-REL-007 | Support identity/channel and severity ownership MUST exist before invitation | Published runbook |
| FP-REL-008 | Cohort expansion MUST require explicit owner decision | Release log |
