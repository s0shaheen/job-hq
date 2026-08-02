# Full-product pilot contract v2

Status: scope direction accepted on 2026-07-28; launch contract awaits ADR-002,
ADR-003, design addenda, and G0 inputs
Scope label: `full-product-pilot-v2`
Supersedes: narrow `pilot-contract-v1`

## 1. Contract

Every activated pilot user receives the complete product described here. Invite-only
rollout controls operational risk; it does not permit incomplete features.

The sole launch exclusion is Gmail-derived automatic application status. The product
does not request Gmail mail scopes, ingest general mailbox content, classify application
emails, or change statuses from email during this launch. Manual application status is
complete and authoritative.

Autopilot submission receipts rely on an approved provider evidence class: immutable
reviewed request record, submission timestamp, provider response metadata, and a
provider identifier, authenticated provider record, or approved success marker.
Confirmation-page capture is optional and provider/privacy-policy dependent under
ADR-013. An honest `outcome unknown` state is required when confirmation cannot be
proven. Gmail is not required for a successful receipt.

## 2. Users and access

| Identity state | Product access |
|---|---|
| Anonymous | Public landing, sign-in, signup, legal, and support only |
| Authenticated, pending activation | Holding state and account controls only; no user data or commands |
| Invited/activated first user | Complete product, free forever, no commercial caps |
| Suspended | Sign out, support, legal, archive, and deletion only |
| Removed/deleted | No product access; deletion-ledger and legally required minimal records only |
| Operator | Administrative metadata and health only; private content access requires explicit, time-bounded user consent and audit |
| Service worker | Named, least-privilege, owner-scoped lane; no ambient cross-user authority |

Email/password and Google authentication are supported. Google authentication MUST be
separate from Gmail mailbox consent. No client-selected `user_id` is authoritative.

## 3. Capability matrix

`Complete` means usable by every activated user with all documented states and evidence.
`Capability-matrix` means the product exposes provider-specific support honestly and
offers a complete manual handoff where automated execution is not supportable.

| Capability | Launch status | Required behavior |
|---|---|---|
| Landing, auth, activation | Complete | Public explanation, signup/sign-in, holding state, activation, session and recovery |
| Onboarding and profile | Complete | US geography, any job family/seniority, pay/work model/deal-breakers, preview and versioned save |
| Today | Complete | New roles, ready-to-review work, relevant follow-ups, truthful counts/freshness |
| Jobs | Complete | Six columns, four controls plus Display, saved views, filters, detail URL state, decisions, export, logo ladder |
| Applications | Complete | Add/import, manual statuses, notes, evidence/activity, conflict handling, export |
| Autopilot Prepare | Complete | Deterministic facts/answers, gaps, exact staged snapshot, attachments |
| Autopilot Review | Complete | Exact payload, sensitive-answer policy, edit/discard/approve, immutable approval |
| Autopilot Submit | Capability-matrix | Idempotent authorized execution for supported ATSs, live revalidation, receipts, unknown/manual states |
| Autopilot Rules | Complete | Global pause, provider/job policies, review thresholds, activity, kill switch |
| Resume and attachments | Complete | Import/create/edit/version/render/select/export/delete; user-owned and tenant-isolated |
| Coverage | Complete | Company universe, monitoring, sources, freshness, gaps, activity, no Sheet claims |
| Warm introductions | Complete | Imported/manual connections, provider search, editable personas, cancel, 40 deduplicated results total by default (configurable to 50), fit, multi-pin |
| Referral funnel | Complete | Identified/contacted/replied/referred/interview; human-sent outreach only |
| Settings | Complete | Profile, display, notifications, connected accounts, plan, data, privacy, support |
| Import/export | Complete | CSV/XLSX/paste, mapping/preview/idempotent commit/undo, full account archive |
| Account deletion | Complete | Recent authentication, confirmation, processing stop, store deletion, backup-expiry ledger |
| Notifications | Complete | In-app and opted-in product email, quiet hours, unsubscribe, suppression, replay-safe links |
| Plan and billing surfaces | Complete, dormant charging | Real plan/usage model and Stripe test-mode hosted integration; founding users never see checkout in ordinary use; production charging is a separate commercialization gate |
| Command palette/system states | Complete | Add job, navigation, actions, shortcuts, 404/500/offline/maintenance/session states |
| Gmail automatic status | Excluded | No mail scopes, ingestion, classification, or status mutation |
| Automated LinkedIn access/outreach | Excluded | No cookies, session automation, scraping as user, or message sending |
| Personal Salman content | Excluded from product | Moved to private vault; no default resume, applications, or interview data |
| Google Sheets | Excluded from architecture | No read, write, mirror, sync, fallback, registry, or product dependency |

## 4. ATS execution support

The product MUST publish and enforce a versioned support matrix with these states:

- `prepare_and_submit`: reviewed automation is supported;
- `prepare_then_manual`: product prepares exact answers and attachments, opens the
  provider, and records the user-confirmed outcome;
- `unsupported`: product explains the blocker and does not claim preparation or submit;
- `temporarily_paused`: previously supported integration failed drift/safety health.

Initial implementation order:

1. Greenhouse;
2. Ashby;
3. Lever;
4. SmartRecruiters;
5. selectively qualified account/OTP providers;
6. explicit manual support for providers whose policies or controls prevent safe
   automation.

Provider coverage is not accepted from adapter code alone. Each `prepare_and_submit`
provider needs a live-shape fixture corpus, drift detection, duplicate defense,
attachment proof, exact payload review, response classification, and kill switch.
CAPTCHA, unexpected login, schema drift, sensitive unanswered questions, or unknown
result MUST stop safely; the system MUST NOT bypass anti-abuse controls.

## 5. Data authority

- Postgres is authoritative for identity-linked product data.
- Object storage is authoritative for immutable user artifacts such as resume versions
  and submission evidence.
- The audit/event ledger is authoritative for command outcomes.
- Provider confirmation evidence is authoritative for automated submission outcome.
- Manual user status is authoritative for application pipeline status.
- No Google Sheet credential, tab, row, sync, or reconciliation process may be required
  by production.
- CSV and XLSX are import/export formats only.

## 6. Commercial contract

The product owner explicitly assigns `founding_free` to each invited first-user account
through an audited activation command. Assignment is not inferred from signup date,
email domain, client input, or a missing plan. Once assigned, it survives ordinary
suspension/reactivation and can be removed only through a separately confirmed,
audited owner action that honors the user promise.

Activated founding users have this server-enforced entitlement:

- all product capabilities;
- no company, job, search, referral-result, resume, or submission quota;
- no charge and no trial expiry;
- visible plan description that does not falsely imply a payment obligation.

“Uncapped” removes commercial quotas and charges. It does not remove security, abuse,
concurrency, provider-rate, reliability, or infrastructure-safety limits.

The billing architecture still includes plan state, usage meters, checkout session,
customer portal, verified webhook, downgrade/cancellation policy, and feature
entitlements so later users can be commercialized without retrofitting authorization.
No unbuilt feature may be advertised or sold.

## 7. Market and devices

- Geography: United States.
- Job family: general; no PM/finance-specific assumptions in schemas, defaults, ranking,
  resume editor, or copy.
- Seniority: general.
- Work model: remote, hybrid, and on-site.
- Devices: supported laptop browsers and phone browsers.
- Browser policy: current and previous stable Chrome, Edge, and Firefox on desktop;
  current and previous stable Safari on macOS/iOS; current and previous stable Chrome
  on Android.
- Required widths: 320, 375, 768, 1024, and 1440 CSS pixels.
- Interaction: touch, pointer, and keyboard; WCAG 2.2 AA.
- Phone users can complete all review, configuration, tracking, resume, and data-exit
  workflows. If submission execution requires a user-owned desktop agent, the phone can
  approve and observe it, and the product MUST state when that agent is unavailable.
- Release evidence includes at least one physical iPhone/Safari, Android/Chrome, and
  laptop test; emulation alone is insufficient.

The hosted product, discovery, notifications, backups, and server work MUST run without
the owner’s laptop. A user-owned executor architecture for ATS interaction requires an
explicit security/operations decision before implementation.

## 8. Privacy and retention defaults

Unless the owner replaces these before invitations:

| Data class | Active account | After verified deletion request | Backup expiry |
|---|---:|---:|---:|
| Profile, jobs, applications, notes, answers, resumes, referral data | Until user deletes or account deletion | Remove from active stores within 7 days | 35 days |
| Staged applications not submitted | 30 days after last activity | Remove within 7 days | 35 days |
| Submission receipts and audit records | Account lifetime | Pseudonymize/delete content within 30 days; retain minimum security record 90 days | 35 days |
| Import source files | 24 hours after completed/abandoned processing | Immediate active-store deletion | 35 days |
| Detailed operational logs | 30 days | Normal log lifecycle; no private content | Not separately backed up |
| Security/audit metadata | 90 days | Pseudonymized minimum for abuse/incident defense | 35 days |
| Encrypted database/object backups | Rolling 35 days | Deletion ledger prevents restored account from resuming; expires naturally within 35 days | 35 days |

Telemetry MUST NOT contain resume contents, answers, notes, email bodies, job
descriptions, imported row contents, or provider credentials. Logs use pseudonymous
identifiers and allowlisted fields.

## 9. Support and rollout defaults

Support uses one published email address plus in-product feedback. The owner must provide
the actual address before invitations. Default ordinary coverage is business days in US
Central time. Security, cross-user, data-loss, and false/duplicate-submission severity 0
alerts page a named primary and backup 24/7:

- severity 0/security or confirmed data loss: immediate automated page, human
  acknowledgement target 30 minutes, stop rollout;
- severity 1/critical journey unavailable: acknowledge within 4 support hours;
- severity 2/degraded noncritical workflow: acknowledge within 1 business day;
- severity 3/copy or cosmetic issue: triage weekly.

Rollout sequence:

1. exact production release candidate;
2. owner uses only the web app for seven consecutive days;
3. one external user for at least 48 hours;
4. owner reviews stop conditions and evidence;
5. invite the initial cohort in bounded waves.

Rollout stops for any cross-user disclosure, lost acknowledged write, false submission
claim, unbounded duplicate submission, failed restore promise, uncontained secret,
severity 0/1 defect, or a critical journey below its SLO.

## 10. Owner inputs still required

These do not change product scope but must be supplied before invitations:

- public product/operator identity;
- support and reply-to email address;
- privacy/terms text or approved counsel path;
- final uptime and application-observability vendors;
- logo-provider privacy posture: direct request versus server proxy/cache;
- Autopilot execution-host architecture;
- accent-green confirmation or design addendum;
- Stripe test account ownership. Production charging ownership/date belongs to the
  later commercialization gate and does not block founding-user invitations.

No implementation agent may decide these silently. It may prepare alternatives, threat
models, and reversible scaffolding.
