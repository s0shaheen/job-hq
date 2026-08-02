# Archived narrow-pilot scope and journeys

> **Superseded scope notice (2026-07-28):** This file preserves the earlier narrow-pilot
> journey analysis, but its scope recommendations, cohort limits, offline-queue
> scenarios, conditional Autopilot, Sheet fallback, and Gmail questions are not current.
> Do not execute from this file alone. The binding scope is
> [`09-full-product-contract-v2.md`](09-full-product-contract-v2.md); the complete journeys and work are
> in [`13-full-product-roadmap.md`](13-full-product-roadmap.md) and [`packets/`](packets/).
> Reusable safety statements apply only where they do not conflict with those sources.

## 1. Purpose

The pilot is a controlled test of whether Job Search HQ helps real job seekers make
better decisions and maintain an accurate application record without creating
unacceptable privacy, security, or operational risk.

It is not a soft public launch. It is not permission to expose every built route. It is
not evidence that a partially implemented automation is safe.

## 2. Pilot actors

| Actor | Capabilities | Explicit limits |
|---|---|---|
| Pilot user | Manage only their profile, jobs, decisions, applications, settings, exports, and connected accounts | Cannot access another user, administer the system, or enable unapproved features |
| Product owner | Invite/remove users, set pilot policy, review aggregate health, stop rollout | MUST NOT inspect private content except with documented user consent and a support need |
| Support operator | Diagnose an incident using minimal metadata and approved tools | No silent impersonation; content access is consented, time-bounded, and audited |
| Scheduled worker | Discover, classify, reconcile, notify, and back up within a named user lane | MUST fail closed when the owner lane is unresolved |
| External provider | Authentication, database, email, ATS, or hosting capability | Treated as fallible and rate-limited; never the sole source of recoverability |

## 3. Pilot promise

### 3.1 Decide

The user can configure a search profile, see roles that match it, understand missing
information, inspect role details, and record a decision. The system distinguishes
confirmed, likely, user-added, and not-found information in plain language.

### 3.2 Track

The user can add or import applications, update their status, see status evidence and
activity, and receive only the notifications they consented to. If Gmail auto-status is
not enabled for the pilot, the product MUST say so and offer a complete manual path.

### 3.3 Leave

The user can export their data, turn off notifications, disconnect connected accounts,
and request deletion. The product MUST state what is retained, for how long, and what
cannot be recalled from an already-sent email or an external provider.

## 4. Recommended scope

### 4.1 Required in the core pilot

- Invite-only authentication and explicit per-user provisioning.
- Onboarding and search profile.
- Today with truthful role counts and decision actions.
- Jobs with strict design parity, saved views, plain-language filters, detail URL state,
  export, and complete fixture behavior.
- Applications with manual add/import, status updates, evidence/activity, export, and
  honest status-source labeling.
- Coverage with honest freshness, source, blind spots, and no implied sweep that did not
  run.
- Settings for profile, display, notifications, connected-account status, export, and
  account exit.
- Operational health visible to the owner, including per-user stale lanes.
- A support and feedback channel.

### 4.2 Conditional pilot features

These MAY launch only if their specific gates pass:

- Gmail auto-status: requires per-user authorization, minimal scopes, revocation,
  capture freshness, reconciliation, duplicate handling, ambiguous-event review, and
  user-visible manual correction.
- Human-reviewed application preparation: requires migration `0024`, immutable staged
  snapshots, explicit review, no inferred approval, discard, and audit history.
- Email digest: requires opt-in, unsubscribe, quiet hours, replay-safe action links,
  bounce/suppression handling, and content parity with the application state.
- Warm-introduction hints: requires accurate provenance, safe links, no automated
  LinkedIn access, and no promise of outreach tracking.

### 4.3 Outside the recommended first pilot

- Open or self-service signup.
- Paid plans, trials, or billing enforcement.
- Automated application submission.
- Automated referral outreach or LinkedIn scraping.
- Model-generated free-response application answers.
- Unsupported ATS or browser automation presented as reliable.
- Team, recruiter, scout, or delegated-account roles.
- Public marketing claims or service-level agreements.

Out-of-scope functionality MAY remain behind inaccessible feature flags. It MUST NOT be
advertised, linked from pilot navigation, or represented by a control that cannot
complete its promise.

## 5. Cohort and duration

Recommended default:

- 3–5 known users, hard cap 10.
- Four-week structured pilot followed by an explicit continue, change, or stop decision.
- Owner dogfood for at least seven consecutive days before the first external user.
- One external-user canary for at least 48 hours before inviting the remaining cohort.
- No invite forwarding and no self-service invitations.

The cohort SHOULD include at least:

- one user with a sparse or unusual search profile;
- one user importing an existing application history;
- one user with no Gmail connection;
- if Gmail is in scope, one user who connects and later revokes it;
- one keyboard-heavy user or a structured keyboard-only test session.

## 6. End-to-end journey requirements

Each journey MUST have one happy-path example and negative examples for authorization,
validation, concurrency, dependency failure, and recovery. The identifiers below are
stable and MUST appear in the traceability matrix.

### J-01 Accept invitation and sign in

Requirements:

- `PILOT-AUTH-001`: The system MUST accept only an invited identity.
- `PILOT-AUTH-002`: An authenticated but unentitled identity MUST receive a holding state, not application
  data.
- `PILOT-AUTH-003`: Provisioning MUST be idempotent.
- `PILOT-AUTH-004`: Provisioning MUST bind one external identity to one internal
  user.
- `PILOT-AUTH-005`: Session expiration MUST preserve unsaved user input where safe and offer
  re-authentication.
- `PILOT-AUTH-006`: Sign-out MUST invalidate the local session.
- `PILOT-AUTH-007`: Sign-out MUST clear sensitive cached content and commands owned by
  the signed-out identity.

Acceptance:

```gherkin
Scenario: Uninvited identity is denied without data disclosure
  Given a valid identity that is not on the pilot allowlist
  When the identity completes authentication
  Then the product shows the approved holding message
  And no user-scoped application query succeeds
  And the denial is recorded without storing private identity claims in logs
```

### J-02 Complete onboarding

Requirements:

- `PILOT-ONB-001`: The user MUST understand why each required field is needed.
- `PILOT-ONB-002`: Draft values MUST survive back/forward navigation.
- `PILOT-ONB-003`: Saving MUST use the existing RPC write path with idempotency.
- `PILOT-ONB-004`: Saving MUST use a version token.
- `PILOT-ONB-005`: An empty or malformed profile MUST not silently fall back to another user's or a
  compiled persona's criteria.
- `PILOT-ONB-006`: The preview MUST use the same deterministic gate corpus as discovery.

Acceptance:

```gherkin
Scenario: A conflicting profile edit is not overwritten
  Given the same profile was changed in another session
  When the user saves a stale draft
  Then the write is rejected as a conflict
  And the product preserves the draft
  And the product offers reload and compare actions
```

### J-03 Review Today and make decisions

Requirements:

- `PILOT-TODAY-001`: Counts MUST describe the visible, owner-scoped dataset and its freshness.
- `PILOT-TODAY-002`: Decision actions MUST be optimistic and undoable.
- `PILOT-TODAY-003`: Decision actions MUST be idempotent and forward-compatible
  with offline delivery.
- `PILOT-TODAY-004`: Keyboard shortcuts MUST be discoverable.
- `PILOT-TODAY-005`: Keyboard shortcuts MUST not fire while focus is in an input.
- `PILOT-TODAY-006`: A failed write MUST return the item to a truthful state.
- `PILOT-TODAY-007`: A failed write MUST retain a retry path.
- `PILOT-TODAY-008`: The Today badge MUST appear only on Today.
- `PILOT-TODAY-009`: The Today badge MUST not imply unseen roles that are not
  retrievable.

Acceptance:

```gherkin
Scenario: Replaying an offline decision does not duplicate it
  Given the user made one decision while offline
  And the command is queued for that authenticated user
  When connectivity returns and the dispatcher retries the command
  Then exactly one logical decision and one audit event exist
  And the item leaves the actionable count
```

```gherkin
Scenario: A queued command cannot cross identities
  Given user A has a queued decision on a shared device
  When user A signs out and user B signs in
  Then user A's command is not dispatched as user B
  And user B cannot read the queued payload
```

### J-04 Find and inspect Jobs

Requirements:

- `PILOT-JOBS-001`: The surface MUST obey the six-column budget.
- `PILOT-JOBS-002`: The surface MUST obey the toolbar-control budget.
- `PILOT-JOBS-003`: Search, saved views, filters, display settings, and selected-detail URL state MUST
  round-trip deterministically.
- `PILOT-JOBS-004`: Absent values MUST display `Not listed`, never blank, zero, or an invented midpoint.
- `PILOT-JOBS-005`: Company logo fallback MUST treat missing domains as ordinary.
- `PILOT-JOBS-006`: Company logo fallback MUST render a deterministic
  monogram without a broken-image state.
- `PILOT-JOBS-007`: Export counts and file contents MUST use the same scope.
- `PILOT-JOBS-008`: Closing the detail pane with Escape MUST restore focus.
- `PILOT-JOBS-009`: Closing the detail pane with Escape MUST restore URL state.

Acceptance:

```gherkin
Scenario: A deep-linked detail pane restores and closes cleanly
  Given a URL identifies a role visible to the current user
  When the user opens that URL
  Then the correct role is selected in the 420px detail pane
  When the user presses Escape
  Then the pane closes
  And focus returns to the selected row
  And the role selection is removed from the URL
```

```gherkin
Scenario: A role owned by another user cannot be deep-linked
  Given the URL identifies a role that belongs only to another user
  When the current user opens that URL
  Then no role data is disclosed
  And the product returns the approved not-found or permission state
```

### J-05 Add, import, and track an application

Requirements:

- `PILOT-APP-001`: The user MUST be able to add a supported URL or import a history without duplicates
  becoming invisible.
- `PILOT-APP-002`: Status changes MUST respect human-wins rules.
- `PILOT-APP-003`: Automated status changes MUST respect forward-only rules.
- `PILOT-APP-004`: Every automatic status MUST show its source and evidence or be placed in Needs review.
- `PILOT-APP-005`: Ambiguous, stale, or conflicting events MUST never silently overwrite a user decision.
- `PILOT-APP-006`: Import MUST provide validation, preview, and row-level outcomes.
- `PILOT-APP-007`: Import MUST provide resume/retry behavior
  appropriate to its duration, and an exportable error report.

Acceptance:

```gherkin
Scenario: An ambiguous email cannot overwrite a human status
  Given the user has manually set an application status
  And one email plausibly matches multiple applications
  When the event is processed
  Then no application status changes
  And one owner-scoped Needs review item retains the evidence
```

```gherkin
Scenario: Concurrent review resolution commits once
  Given two sessions loaded the same unresolved review
  When both sessions resolve it to different candidates concurrently
  Then exactly one resolution commits
  And at most one application changes
  And the other session receives a conflict or already-resolved result
```

### J-06 Understand Coverage

Requirements:

- `PILOT-COV-001`: Coverage MUST separate configured companies, recently checked companies, supported
  sources, unsupported sources, and failures.
- `PILOT-COV-002`: Freshness MUST be based on successful user-lane activity, not a shared process
  heartbeat.
- `PILOT-COV-003`: A company without a resolvable source MUST not be displayed as monitored.
- `PILOT-COV-004`: Copy MUST say what the system has actually checked.
- `PILOT-COV-005`: Copy MUST say what the user can do next.

Acceptance:

```gherkin
Scenario: One stale user is not masked by shared infrastructure
  Given the global scheduler is healthy
  And user A's last useful scan is current
  And user B's last useful scan exceeds the declared grace period
  When each user opens Coverage
  Then user A sees current freshness
  And user B sees an actionable stale warning
```

### J-07 Manage settings and consent

Requirements:

- `PILOT-SET-001`: Notification channels MUST default to off unless the user explicitly opted in.
- `PILOT-SET-002`: Every marketing or digest email MUST include a working unsubscribe mechanism.
- `PILOT-SET-003`: Connected-account state MUST distinguish connected, expired, revoked, error, and
  reconnecting.
- `PILOT-SET-004`: Display preferences MUST have one authoritative scope per setting: per-user or
  per-view, never both without defined precedence.
- `PILOT-SET-005`: Changing a setting MUST affect only the current user.
- `PILOT-SET-006`: Changing a setting MUST be auditable.

Acceptance:

```gherkin
Scenario: Revocation stops future email processing
  Given the user has a connected Gmail capture lane
  When the user revokes the connection
  Then new capture requests are rejected
  And queued work for that connection cannot change application status
  And the UI reports the revoked state
```

### J-08 Export and leave

Requirements:

- `PILOT-EXIT-001`: Export MUST be available without contacting support.
- `PILOT-EXIT-002`: Export MUST include a manifest describing format version, generated time, scope, and
  omitted classes of data.
- `PILOT-EXIT-003`: Account deletion MUST require recent authentication.
- `PILOT-EXIT-004`: Account deletion MUST require explicit confirmation.
- `PILOT-EXIT-005`: Deletion MUST revoke sessions and connected-account tokens.
- `PILOT-EXIT-006`: Deletion MUST stop notifications and scheduled work.
- `PILOT-EXIT-007`: The system MUST produce a completion record without retaining deleted content.
- `PILOT-EXIT-008`: Legal or operational retention exceptions MUST be stated before confirmation.

Acceptance:

```gherkin
Scenario: An account archive is complete and isolated
  Given user A requests a full archive
  When archive creation succeeds
  Then the manifest identifies every included and omitted data class
  And the archive contains no record owned only by user B
```

```gherkin
Scenario: Deleted account processing does not resume after restore
  Given an account deletion completed under the signed retention schedule
  When an older backup is restored into recovery
  Then the deletion reconciliation ledger prevents the account's future processing
  And retained backup data expires under the disclosed schedule
```

### J-09 Recover from a failure

Requirements:

- `PILOT-REC-001`: A user MUST receive a truthful local state when the network, database, email provider,
  or ATS is unavailable.
- `PILOT-REC-002`: Retried commands MUST not duplicate decisions, applications, events, or notifications.
- `PILOT-REC-003`: The owner MUST be alerted when a critical user lane is stale or repeatedly failing.
- `PILOT-REC-004`: Support MUST be able to correlate a user-reported action with an audit event using a
  non-secret support reference.

Acceptance:

```gherkin
Scenario: Timeout after commit is reconciled without duplication
  Given a command commits but its response is lost
  When the client retries with the same idempotency key
  Then it receives the original logical result
  And no duplicate durable or external effect exists
```

```gherkin
Scenario: Sensitive content is absent from support telemetry
  Given a failed command involves an email event and application note
  When support uses the correlation reference
  Then the operation and error class are traceable
  And the email body, note, tokens, and signed links are absent
```

## 7. Experience-state contract

Every pilot route MUST intentionally implement:

- initial loading;
- populated;
- natural empty;
- filter-caused empty;
- partial data / missing optional value;
- dependency degraded;
- validation error;
- authorization denied / holding;
- session expired;
- offline or write queued;
- write conflict;
- destructive confirmation;
- success with undo where applicable;
- keyboard focus and focus restoration;
- narrow viewport and 200% text zoom.

A blank page, raw exception, silent no-op, indefinite spinner, and disabled control with
no explanation are never acceptable states.

## 8. Pilot success and stop criteria

### 8.1 Success signals

Measure by event semantics, not by a specific analytics vendor:

- invited → activated conversion;
- time to complete onboarding;
- first relevant role viewed;
- first decision recorded;
- first application added or imported;
- weekly active decision / tracking days;
- number and rate of user-corrected automatic statuses;
- export and notification-control success;
- support contacts per active user;
- qualitative answer to: “What would you do if this disappeared tomorrow?”

No metric MAY require capturing job descriptions, email bodies, resume content, or
free-response text unless the user explicitly consents to that measurement.

### 8.2 Immediate stop conditions

Stop invitations and disable the affected feature when any of these occurs:

- cross-user data exposure or authorization bypass;
- an unapproved application submission or external message;
- unrecoverable user-data loss or material corruption;
- connected-account access after revocation;
- repeated duplicate notifications or application actions;
- backup restoration failure for data believed recoverable;
- a privacy promise that the implementation cannot honor;
- no owner able to respond to a severity 0/1 incident.

### 8.3 Pause-and-assess conditions

- more than 5% of state-changing commands fail in a rolling 24-hour window;
- any pilot user has a stale critical lane for more than one scheduled interval plus
  the documented grace period;
- two users encounter the same journey-blocking defect;
- support demand exceeds the owner’s declared capacity;
- automatic status precision falls below the owner-approved threshold.

## 9. Exit decision

At the end of the pilot, the owner MUST choose one:

- **Expand** — all gates remain green and the next cohort is explicitly bounded.
- **Continue** — keep the same cohort while addressing named learning questions.
- **Narrow** — disable a conditional capability and retain the core promise.
- **Stop** — export or delete user data according to consent, revoke access, and conduct
  a blameless review.

Silence is not approval to continue or expand.
