# Metric dictionary and pilot SLOs

Status: proposed; thresholds require owner acceptance

## 1. Measurement rules

- Metrics use semantic events and durable state, not a specific vendor.
- Every metric defines numerator, denominator, exclusions, window, minimum sample, data
  source, owner, threshold, and response.
- Rates with a denominator below the minimum sample are reported as counts and `not
  enough data`; they do not prove success.
- Internal test traffic and synthetic canaries are reported separately.
- User content is never a metric dimension.
- A missing telemetry signal is unknown/degraded, never success or zero.
- S0 invariants have zero tolerance and no minimum sample.

## 2. Reliability and safety dictionary

| ID | Metric | Definition | Window/minimum | Proposed threshold | Data source | Response/owner |
|---|---|---|---|---|---|---|
| M-SAFE-001 | Cross-owner access | Count of any read/write/export/cache result containing data not authorized to actor | continuous, any event | 0 | security/audit probes + incident | immediate S0, stop access/release; security |
| M-SAFE-002 | Lost acknowledged commands | Commands reported accepted/success with no durable logical result after reconciliation grace | rolling 24h, any | 0 | command/idempotency/audit tables | S1, stop affected writer; engineering |
| M-SAFE-003 | Duplicate logical effects | More than one durable/external logical effect for one idempotency scope | rolling 24h, any | 0 | command/audit/provider refs | S1, stop affected writer |
| M-SAFE-004 | Human status overwrite | Automation changes a human-locked application state | continuous, any | 0 | status actor + audit | S0/S1, stop email/automation |
| M-SAFE-005 | False submission claim | UI/email says submitted without accepted executor receipt and evidence | continuous, any | 0 | UI contract + events/receipts | S0 trust incident |
| M-REL-001 | Command success rate | successful unique commands / eligible completed unique commands; excludes client offline before dispatch, validation, explicit user conflicts; includes internal/dependency failures | rolling 24h; min 20 | >=95%; pause below 95%; release target >=99.5% after min 200 | command events | engineering |
| M-REL-002 | Unknown command outcomes | timeout/disconnect after possible commit not reconciled within 5 min / dispatched commands | rolling 24h; any count reported | 0 unresolved after 5 min | idempotency/result lookup | S1 if high-value; engineering |
| M-REL-003 | Critical web availability | successful synthetic completion of sign-in/read plus health / scheduled probes | rolling 30d; min 100 probes | >=99.5% | external synthetic probe | pause on sustained breach; ops |
| M-REL-004 | Critical lane freshness | now minus last useful successful completion for each user/lane | each cadence | <= cadence + 50% grace unless lane-specific row overrides | channel runs/heartbeats | warn at grace, S1 after 2 cadences; ops |
| M-REL-005 | Sheet/Postgres divergence | unresolved canonical value/key conflicts / authoritative records in window | per reconciliation; min 1 | 0 human/status conflicts; <=0.1% noncritical for <=24h only | reconciliation report | stop class writer on critical; data |
| M-BKP-001 | Backup RPO | newest successfully restored recoverable point vs incident/check time | each daily drill/report | <=24h | backup/restore manifest | S1 if all lanes fail; data |
| M-BKP-002 | Restore RTO | approval to start drill until critical invariants pass | each drill | <=4 support-hours | drill record | block launch/expansion; data |

## 3. Gmail and notification dictionary

These apply only if the capability is in the signed contract.

| ID | Metric | Definition | Window/minimum | Proposed threshold | Response |
|---|---|---|---|---|---|
| M-MAIL-001 | Capture visibility latency | p95(`captured_at` or Gmail evidence time → event visible/processed state), healthy authorized lane only | rolling 7d; min 20 events | <=30 min | warn user/operator above; stale rules still apply |
| M-MAIL-002 | Capture staleness | now minus last useful successful per-user capture run | continuous | warning after expected cadence + grace; hard upper bound 24h | show warning; stop trust claim |
| M-MAIL-003 | Auto-status precision | confirmed correct automated status changes / reviewed sample of automated changes; uncertain routed-to-review excluded from auto numerator and reported separately | weekly; min 20 reviewed changes, otherwise count only | owner must set; proposed >=95% and zero human overwrite | disable auto mutation below threshold |
| M-MAIL-004 | Review escape rate | ambiguous events that mutated an application without completed review / ambiguous events | rolling 7d; any | 0 | S1, disable resolver |
| M-NOT-001 | Duplicate product sends | duplicate provider-accepted sends for same user/template/window/idempotency scope | rolling 24h; any | 0 | stop product email lane |
| M-NOT-002 | Eligible send acceptance | provider-accepted unique sends / eligible send attempts; excludes opted-out/suppressed | rolling 7d; min 20 | >=99% | investigate/disable if repeated |
| M-NOT-003 | Unsubscribe propagation | preference effective time minus confirmed request time | each request | <=5 min and before next send | S1 privacy if violated |

## 4. Performance dictionary

The owner MUST accept the reference device/network before G6.

Proposed reference:

- production build;
- pinned current Chromium for repeatability plus supported-browser sample;
- mid-tier laptop/mobile profile agreed in release evidence;
- warm and cold navigation reported separately;
- realistic p75 pilot dataset and maximum supported dataset;
- production-like network profile;
- no synthetic fixture short-circuiting live service boundaries.

| ID | Metric | Definition | Window/minimum | Proposed threshold |
|---|---|---|---|---|
| M-PERF-001 | Primary content visible | navigation start to meaningful primary content, excluding skeleton | release sample >=30 per critical route | p75 <=2.5s |
| M-PERF-002 | Local interaction response | input to next paint/state feedback, excluding declared network completion | >=100 interactions | p95 <=200ms |
| M-PERF-003 | Healthy command completion | dispatch to accepted/conflict/rejected result while dependencies healthy | >=50 commands | p95 <=2s |
| M-PERF-004 | Table interaction | scroll/filter/select responsiveness at max supported dataset | release scenario | no sustained long task >200ms; no unreachable content |

## 5. Product-learning dictionary

These inform continue/expand; they do not override safety stops.

| ID | Metric | Definition | Window/minimum | Proposed four-week target |
|---|---|---|---|---|
| M-PROD-001 | Activation | invited users who complete onboarding and first decision within 24h / invited users who start sign-in | cohort; report count if <5 | >=80% |
| M-PROD-002 | Retention | activated users with at least one meaningful Decide/Track day in each of final two weeks / activated users | weeks 3–4 | >=70% |
| M-PROD-003 | Time to first value | median onboarding start → first saved decision | cohort | report median; target <=30 min excluding scan wait |
| M-PROD-004 | Decision-session duration | median active time from Today open to queue clear/leave; idle >2 min excluded | weekly; min 10 sessions | <=5 min, without elevated correction/support |
| M-PROD-005 | Export rehearsal | activated users completing readable archive/export / activated users asked to rehearse | pilot | >=80%, 100% capability success |
| M-PROD-006 | Trust comprehension | users who can correctly explain why a sampled role appeared and current application status / interviewed active users | exit interview | >=80% |
| M-PROD-007 | Support burden | support cases requiring owner action per active user-week, by severity | weekly | owner must set sustainable capacity in D-011 |

## 6. Alert and stop mapping

| Condition | Action |
|---|---|
| Any M-SAFE-001/004/005 event | immediate stop affected system and new invitations |
| M-SAFE-002/003 nonzero | stop affected writer, reconcile, incident |
| M-REL-001 below 95% with >=20 eligible commands | pause new invitations and investigate |
| One user critical lane exceeds 2 cadences | disable affected promise for that user; support/incident |
| Two users encounter the same journey-blocking defect | pause cohort expansion |
| Backup cannot restore or RPO/RTO fails | block launch/expansion; S1 if only recovery lane |
| M-MAIL-003 below approved threshold | route all suggestions to review or disable auto-status |
| Support open workload exceeds D-011 capacity | pause invitations |

## 7. Metric acceptance record

```text
Reference environment:
Command inclusion/exclusion approved:
Lane cadences and grace:
Auto-status sample method and threshold:
Support capacity:
Performance device/network:
RPO/RTO:
Product targets:
Metric owner:
Approved at:
Expiry/review date:
```

No target becomes a public SLA merely because it is an internal pilot gate.
