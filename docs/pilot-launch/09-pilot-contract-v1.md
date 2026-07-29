# Pilot contract v1

Status: proposed, not approved
Owner signature: pending
Approved at: pending
Supersedes: none

This is the one-page scope authority for the first pilot. Recommended values allow work
to continue. External invitations remain blocked until the owner changes the status to
approved and fills every `pending` field.

## 1. Cohort and promise

| Field | Proposed value | Decision |
|---|---|---|
| Cohort | 3–5 known users; hard cap 10 | D-001 |
| Access | Named email allowlist; no forwarding or self-service invite | D-001 |
| Price | Free | A-001 |
| Duration | Seven-day owner soak, 48-hour canary, four-week external pilot | D-012 |
| Promise | Decide + Track + Leave | D-002 |
| Segment | pending geography, role families, seniority, work model | D-013 |
| Devices | current/previous Chrome, current Safari, current Firefox regression; 320–1440px | D-014 |
| Support | pending channel, hours, owner, backup | D-011 |
| RPO/RTO | proposed 24 hours / 4 support-hours | D-015 |
| Cost cap | pending per-user and total monthly cap | D-016 |

Approved user-facing promise:

> Pending owner approval: Find relevant jobs, make daily decisions, track applications
> from evidence, and take your data with you.

Required limitation copy:

- Discovery is not exhaustive.
- Email tracking may require setup and can be corrected manually.
- The product does not submit applications automatically.
- Pilot behavior and availability may change; users retain export and deletion rights.

## 2. Capability matrix

`conditional` means disabled by default and unavailable unless every listed gate passes
for the named user.

| Capability | Proposed scope | User-facing treatment | Required gates | Server flag / deny path | Kill switch | Data/processors | Fallback | Acceptance owner |
|---|---|---|---|---|---|---|---|---|
| Invite/auth | In | Named invite sign-in | WP-016, auth matrix | default-deny pilot access | stop provisioning + revoke | auth identity | support-assisted re-invite | security |
| Onboarding/profile | In | Real | J-02, design parity | profile capability | read-only + support | profile criteria | support-assisted correction | product |
| Today | In | Real New roles | WP-021, J-03 | route/capability | hide actionable writes | jobs/decisions | Jobs route | product |
| Jobs | In | Real | WP-011/015/022, J-04 | route/capability | read-only/export | jobs, logo providers per D-017 | monogram/no provider | design/product |
| Applications | In | Real manual tracking | WP-023, J-05 | route/capability | manual read/export | applications/evidence | manual status | product |
| Coverage | In | Real, truthful freshness | D-021, WP-013/024 | route/capability | stop scans, preserve facts | companies/run events | support status | product/ops |
| Settings | In | Real | WP-025, J-07/08 | route/capability | preserve export/delete | preferences/consent | support | product |
| Import | In | Real | WP-026 | import capability | disable new imports | uploaded tracker data | manual add | data |
| Dataset export | In | Real | WP-026 | never plan-gated | none except incident containment | user data | support delivery | data |
| Full archive | In | Real | J-08, retention schedule | never plan-gated | queue/pause during incident | all user-owned data | support-assisted archive | data |
| Account deletion | In | Real or rehearsed support-assisted flow | J-08, D-009 | narrow recent-auth path | pause only for incident | all stores/providers | support runbook | data/security |
| Gmail capture/status | Conditional | Hidden/manual when disabled | D-004, WP-012/030 | per-user connection/capability | accept off + process off | Gmail, classifier, DB | manual status | security/product |
| Product digest | Conditional | Off until opt-in | D-005/019, WP-031 | per-user notification type | outbound off | SES | in-app only | product/ops |
| Warm local connection hint | Conditional | Flagged experiment | D-006 | per-user flag | enrichment off | connections | plain company cell | product |
| External intro enrichment | Excluded by default | No control | separate provider/cost/privacy acceptance | deny | provider off | TBD | local hints | owner |
| Autopilot nav | Conditional unavailable destination | Exact unavailable copy; no readiness/submission | D-003 | capability deny | route unavailable | none | Applications/Today | product/design |
| Prepare/Review | Excluded by default | No entry point | WP-014 plus D-003 | capability deny | preparation off | ATS form snapshots | manual application | security/product |
| Automatic submission | Excluded | No claim/control | separate future program | hard deny | no submit credential/executor | none | user applies manually | owner |
| Resume artifacts | Excluded by default | No product upload/attach | `0026` full gate | capability deny | upload/render off | object storage/render | user-managed file | security |
| Billing | Excluded | No pricing/paywall | post-pilot | no plan check | none | none | free pilot | owner |
| Open signup | Excluded | Invite-only message | post-pilot abuse/auth program | default deny | signup closed | auth identity | waitlist/support | owner |
| Referral outreach automation | Excluded | No claim/control | post-pilot | hard deny | no outreach credential | none | manual outreach | owner |

## 3. Mandatory processors and data decisions

The owner MUST approve:

| Item | Decision |
|---|---|
| Authentication/database/hosting processors | pending inventory |
| Gmail/classifier processors when conditional feature is enabled | pending D-004 |
| SES/product email | pending D-005/D-019 |
| logo.dev and Google favicon direct browser requests | pending D-017 |
| Analytics | proposed first-party minimal events, D-018 |
| Encrypted backup provider/key owner | pending D-008 |
| Retention/deletion schedule | pending D-009 |

## 4. Release gates

The owner approves invitations only when:

- WP-000 incident containment is accepted.
- Every `In` capability passes its gates.
- Every `Conditional` capability is either fully accepted for named users or verified
  disabled with fallback.
- Every `Excluded` capability has no reachable write or misleading promise.
- Data authority, metric dictionary, requirements traceability, design parity,
  restoration, support, and stop conditions are accepted.
- Product, design, security/data, operations, verification, and release owners sign.

## 5. Sign-off

```text
Product owner:
Design owner:
Security/data owner:
Operations owner:
Verification owner:
Release owner:
Approved scope version:
Approved release artifact:
Approved configuration manifest:
Approval date/time:
```

Any change to cohort, promise, `In/Conditional/Excluded`, processors, retention, or
support creates `pilot-contract-v2`; it cannot be an undocumented flag change.
