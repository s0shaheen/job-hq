# Decisions, assumptions, and risks

## 1. Decision rule

The recommendations below allow planning to continue without silently deciding product
policy. The owner MUST accept or replace the launch-blocking decisions before external
invitations.

Status values:

- **Open:** owner answer required.
- **Recommended:** working default, not yet owner-approved.
- **Accepted:** owner approved with date.
- **Superseded:** replaced by a later decision.

## 2. Launch-blocking owner decisions

### D-001 — Pilot cohort

Status: Recommended
Question: Who exactly is in the first cohort, and may they invite others?

Recommended decision:

- 3–5 known users;
- hard cap 10;
- named email allowlist;
- no invite forwarding or self-service invitation.

Why: current operations and per-user setup are concierge-scale. Opening signup expands
abuse, entitlement, support, privacy, and scheduling requirements.

### D-002 — Pilot promise

Status: Recommended
Question: Is the first pilot promise strictly Decide + Track + Leave?

Recommended wording:

> Find relevant jobs, make daily decisions, track applications from evidence, and take
> your data with you.

Explicit exclusions: exhaustive discovery, automatic submission, recruiter outreach,
and guaranteed email interpretation.

### D-003 — Autopilot

Status: Recommended
Question: Should Autopilot be hidden, an honest unavailable destination, or include
Prepare/Review?

Recommended decision: keep the nav destination with an honest unavailable state for the
first external wave. Add Prepare/Review only after `0024` is implemented and accepted.
No submission.

Impact:

- Unavailable: smaller critical path.
- Prepare/Review: adds WP-014 and possibly resume decisions.
- Submit: creates a separate high-risk program and is not recommended for this pilot.

### D-004 — Gmail auto-status

Status: Open
Question: Is email-derived application tracking part of the core pilot promise?

Recommended decision: include only if every pilot user accepts concierge setup and the
OAuth/Apps Script, revocation, heartbeat, ambiguity, and reconciliation gates pass.
Otherwise launch a complete manual status path and enable Gmail later.

Owner must choose:

- current per-user Apps Script installation;
- product-managed OAuth after required verification; or
- manual tracking for the first wave.

### D-005 — Digest and notifications

Status: Recommended
Question: Must digest email launch with the pilot?

Recommended decision: off by default. Enable per user only after explicit opt-in,
preferences/unsubscribe, quiet hours, bounce/suppression handling, and action-link gates
pass.

### D-006 — Warm introductions

Status: Recommended
Question: Is provider-backed warm-introduction enrichment in the pilot?

Recommended decision: keep existing safe user-owned connection hints; treat external
enrichment as a separately consented, cost-capped experiment. No LinkedIn scraping or
outreach automation.

### D-007 — Sheet authority

Status: Recommended
Question: Does the Sheet remain an operator-only fallback through the pilot?

Recommended decision: yes, through a defined dual-write soak and reconciliation period.
Pilot users use only the web app. Sheet sunset occurs only after Postgres, backups,
restore, and scheduled jobs meet exit criteria.

### D-008 — Database dump incident

Status: Open, urgent
Questions:

1. Approve immediately disabling the Git-committed full database dump?
2. Approve replacing it with encrypted, versioned, access-controlled backup storage?
3. After restore proof, approve a coordinated repository-history purge plan?
4. Who will make the legal/privacy notification determination?

Recommended decision: yes to 1 and 2 immediately. Treat 3 as a coordinated incident
action after access scope and restoration are understood. Obtain appropriate advice for
4.

### D-009 — Data retention and deletion

Status: Open
Question: What retention applies to each data class?

Owner must fill:

| Data class | Active retention | After account deletion | Backup expiry |
|---|---:|---:|---:|
| Auth and entitlement |  |  |  |
| Search profile/preferences |  |  |  |
| Jobs/decisions |  |  |  |
| Applications/notes |  |  |  |
| Email events/evidence |  |  |  |
| Connections/referral data |  |  |  |
| Answers/policies |  |  |  |
| Imports |  |  |  |
| Activity/audit |  |  |  |
| Staged applications |  |  |  |
| Resume files/versions |  |  |  |
| Operational logs |  |  |  |
| Sheet mirror |  |  |  |

Recommended starting points, subject to legal/product review:

- staged preparation: 30 days;
- detailed operational activity: 90 days;
- debug logs: shortest period that supports incidents;
- user content: while active, then deletion under the declared request workflow;
- backups: bounded lifecycle with deletion reconciliation.

### D-010 — Suspended/removed user rights

Status: Recommended
Question: What can a suspended user still do?

Recommended decision: narrow account-management access only: sign out, support,
privacy/terms, export, and deletion. Revoke application access, sessions as necessary,
capture tokens, scheduled lanes, and product email immediately.

### D-011 — Support

Status: Open
Questions:

- What single support channel will pilots use?
- Which days/hours are actually covered?
- Who is backup?
- Are the proposed S0/S1/S2 acknowledgement targets sustainable?

Do not publish an unstaffed 24/7 promise.

### D-012 — Pilot duration and success

Status: Recommended
Question: What duration and outcome constitute a meaningful pilot?

Recommended decision:

- seven-day owner soak;
- 48-hour one-user canary;
- four-week external pilot;
- weekly review;
- explicit end decision.

Two weeks is enough to find setup failures but may not capture meaningful application
status changes. Four weeks is the recommended product-learning window.

### D-013 — Geography and job-search segment

Status: Open
Question: Which geographies, role families, seniority levels, and work models are in
scope?

Why: discovery recall, provider coverage, salary copy, location gates, and support
expectations cannot be evaluated without a defined search segment.

### D-014 — Supported devices

Status: Recommended
Question: Which devices/browsers are promised?

Recommended pilot baseline: current/previous Chrome, current Safari macOS/iOS, and
current Firefox for regression; widths 320–1440; mouse/touch/keyboard. If this is too
broad, narrow it before invitations rather than accepting unknown defects.

### D-015 — Recovery objectives

Status: Recommended
Question: What data loss and recovery delay can the owner accept?

Recommended pilot targets:

- RPO no worse than 24 hours;
- RTO no worse than 4 hours during declared support coverage.

These targets are not accepted until an actual restore meets them.

### D-016 — Identity and customer-facing details

Status: Open
Owner must provide:

- production product name;
- production domain;
- sender identity/domain;
- reply-to/support address;
- operator/legal identity used in pilot notice;
- timezone used for default schedules;
- monthly total and per-user cost cap.

### D-017 — Third-party logo requests

Status: Open
Question: May the browser send company domains to logo.dev and Google favicon, or must
logos be proxied/cached?

Impact:

- direct requests are simpler but disclose viewed company domains and user IP to
  providers;
- proxy/cache reduces disclosure and repeated calls but introduces SSRF, storage,
  retention, and operations work.

No-domain monograms work under either decision.

### D-018 — Analytics

Status: Recommended
Question: What pilot analytics are acceptable?

Recommended decision: privacy-minimal first-party semantic events only. Do not capture
email bodies, application notes, answers, resumes, job descriptions, or free-response
text. Add a third-party analytics processor only after purpose, retention, consent, and
data transfer are approved.

### D-019 — SES delivery mode

Status: Open if digest is in scope
Question: Is a verified-recipient concierge workflow acceptable, or must SES production
access be approved before invitations?

### D-020 — Design exceptions

Status: Recommended
Question: Who has final authority to approve a documented deviation from the supplied
design?

Recommended decision: product owner. Accessibility/security fixes are implemented as
the smallest safe deviation and still require an explicit record.

### D-021 — Coverage and company-monitoring authority

Status: Open, core
Question: Which store is authoritative for each pilot user's company-monitoring
decisions and scan inputs?

Recommended decision: Postgres is authoritative for webapp pilot users;
`monitor/run.py` consumes the same owner-scoped approved state; the Sheet is an
operator-only mirror/fallback until the signed transition contract's sunset criteria
pass.

The answer MUST populate `10-data-authority-and-transition.md` before Coverage is
accepted.

## 3. Current planning assumptions

These are not promises:

| ID | Assumption | If false |
|---|---|---|
| A-001 | Pilot is free | Billing, tax, refunds, quotas, entitlements, support promise enter critical path |
| A-002 | Cohort is known and manually provisioned | Signup abuse, invitations, activation UX, and self-service support enter critical path |
| A-003 | No automatic submission | Executor, credentials, receipts, duplicate prevention, legal/provider risk enter critical path |
| A-004 | Sheet remains operator fallback | Postgres cutover and every scheduled lane must complete before pilot |
| A-005 | Owner can provide concierge setup | Self-service Gmail/onboarding/support must complete first |
| A-006 | Pilot users are in an owner-supported jurisdiction | Privacy/terms/transfer requirements may expand |
| A-007 | Current product name/domain/sender can be finalized before invites | Auth/email/consent cannot be production-ready |
| A-008 | The design bundle is the final visual authority | Changed designs invalidate parity evidence |
| A-009 | Existing production data may be used only in production | Staging requires synthetic production-shape data |
| A-010 | Prepare/Review can be excluded initially | Otherwise `0024` and related design enter P0/P1 |

Every assumption MUST have an owner and review date before release.

## 4. Risk register

Probability and impact are qualitative until the owner accepts a scoring model.

| ID | Risk | Probability | Impact | Control / response | Residual decision |
|---|---|---|---|---|---|
| R-001 | Full user-data dump persists in Git history/clones | Confirmed | Critical | WP-000 incident containment, encrypted replacement, coordinated purge/rotation review | Owner/legal |
| R-002 | Pending/suspended user bypasses UI entitlement gate via direct data API | High | Critical | Database/RPC/storage default deny; direct auth-matrix tests | None accepted |
| R-003 | Ambiguous email resolution updates wrong application under race | High | Critical | Locked server-derived candidates, uniqueness, CAS, human-wins | Disable email review until fixed |
| R-004 | Cross-user data exposure through RLS, service role, export, jobs, or cache | Medium | Critical | Two-user direct tests at every boundary, least privilege, canary | None accepted |
| R-005 | Acknowledged write is lost or duplicated after timeout/retry | Medium | High | Idempotency, result lookup, CAS, audit, failure injection | None for critical commands |
| R-006 | Git dump excludes Storage and creates false recovery confidence | High if resumes ship | High | Separate object backup and restore | Exclude resume files until ready |
| R-007 | Sheet and Postgres diverge during dual-write | Medium | High | Directional reconciliation, human-wins, defined authority, stop threshold | Owner accepts limited window |
| R-008 | Shared job heartbeat masks one user’s dead lane | High | High | Per-user success heartbeat and stale alerts | None |
| R-009 | Gmail setup/scopes fail for external pilot users | Medium | High | Decide setup model, verify OAuth requirements, manual fallback | Narrow pilot or disable |
| R-010 | User believes application was submitted | Medium | Critical trust | No fake submit states/copy; Autopilot unavailable; audit-based claims | None |
| R-011 | External logo/enrichment provider leaks browsing context | Medium | Medium | Owner decision, privacy notice, proxy/cache option, monogram fallback | Owner |
| R-012 | Provider rate/cost overrun | Medium | Medium | Per-user/global caps, circuit breaker, alerts, feature flag | Owner sets cap |
| R-013 | Discovery misses jobs but Coverage implies completeness | High | High trust | Explicit scope/freshness/failures; segment-defined evaluation | Accepted limitation if honest |
| R-014 | User status overwritten by automation | Medium | Critical | Database human-wins lock, concurrent tests, review | None |
| R-015 | Backup file exists but restore fails | Medium | Critical | Scheduled restore drills and RPO/RTO proof | None |
| R-016 | Account deletion leaves scheduled work/tokens/mirrors | High without runbook | High | Full-system deletion inventory and rehearsal | Retention exceptions disclosed |
| R-017 | Fixture passes while production mapping differs | Medium | High | Shared conformance suite and production-equivalent staging | None |
| R-018 | Design is visually close but state/copy/behavior diverges | High | Medium/High | Strict manifest and multi-layer parity evidence | Approved exceptions only |
| R-019 | Accessibility blocks a pilot user | Medium | High | WCAG 2.2 AA, manual keyboard/screen-reader/zoom | None for critical journey |
| R-020 | Unsupported long data hides actions or corrupts layout | Medium | Medium | Boundary fixtures, contained overflow, wrap policy | None |
| R-021 | Support volume exceeds owner capacity | Medium | High | Hard cap, declared hours, pause condition | Owner |
| R-022 | Open S2 defect becomes recurrent journey blocker | Medium | High | Workaround, expiry, wave review, automatic pause | Owner exception |
| R-023 | Migration branches conflict or run out of order | High | High | One serial integrator, ledger/checksum/lock, staging upgrade | None |
| R-024 | Old/new app version skew breaks deploy | Medium | High | Expand/migrate/contract and compatibility window | None |
| R-025 | Logs/analytics capture sensitive content | Medium | High | Data inventory, structured allowlist, redaction mutants | None |
| R-026 | User revokes Gmail but processing continues | Medium | Critical privacy | Revocation propagation, token stop, queued-work cancellation/test | None |
| R-027 | Digest link scanner or forwarding mutates data | Medium | High | GET is inert; confirmation POST; expiry/replay/revocation | Disable actions until fixed |
| R-028 | Wrong domain/logo association presented as fact | Medium | Medium | provenance, human-wins, fallback, correction path | Accepted if clearly uncertain |
| R-029 | Pilot result is inconclusive due cohort/duration | Medium | Medium | Define segment, four weeks, baseline/exit questions | Owner |
| R-030 | User data is copied into tests/support during debugging | Medium | High | synthetic-only lower env, support minimization, access audit | None |

## 5. Open technical questions

These should be answered during work-package specification, not guessed:

1. What exact store is authoritative for company monitoring per user during the pilot?
2. Which existing users/data are in the Git dump, and who has ever had repository
   access?
3. Which provider/region/retention will hold replacement encrypted backups and Storage
   objects?
4. Does the current migration runner record checksums and enforce exactly-once
   application? If not, what is the migration-ledger transition?
5. Which subset of `0021`–`0027` is truly required under the accepted pilot scope?
6. If `0024` is deferred, how will every Prepare/Review entry point and Today section be
   removed or honestly disabled?
7. What is the direct database predicate for active pilot access?
8. How quickly must suspension invalidate existing sessions and queued work?
9. Is Gmail capture manual Apps Script or product OAuth, and what external-user
   verification is required?
10. How are email capture and joiner freshness reconciled per user?
11. What constitutes a complete account archive across Postgres, Sheet, files, and
    provider data?
12. How are deletions reconciled when restoring an older backup?
13. What are the data/query limits for the largest pilot user?
14. Which route owns status evidence and review when Gmail is disabled?
15. What production build/config identifier is shown to support?

## 6. Owner response template

The owner can answer concisely:

```text
D-001 cohort:
D-002 promise:
D-003 Autopilot:
D-004 Gmail:
D-005 digest:
D-006 warm intros:
D-007 Sheet fallback:
D-008 dump containment/history:
D-009 retention:
D-011 support channel/hours:
D-012 duration:
D-013 geography/roles:
D-014 devices:
D-015 RPO/RTO:
D-016 product/domain/sender/cost:
D-017 logo providers:
D-018 analytics:
D-019 SES:
D-020 design authority:
```

Unanswered decisions retain their recommended planning default but remain release
blockers where marked Open.
