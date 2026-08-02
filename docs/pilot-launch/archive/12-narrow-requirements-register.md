# Archived narrow-pilot requirements register

> **Register status (2026-07-28):** This is the earlier narrow-pilot register and is not a
> complete release ledger for `full-product-pilot-v2`. Safety requirements remain
> reusable, but entries that defer or disable Autopilot, resume, billing, referrals,
> Sheet sunset, or full multi-user behavior are superseded. FP-00A MUST generate the
> current atomic register from [`09-full-product-contract-v2.md`](09-full-product-contract-v2.md),
> [`13-full-product-roadmap.md`](13-full-product-roadmap.md), and the instantiated packet.

Status: proposed
Contract: `pilot-contract-v1`
Release artifact: not assigned

This register makes the journey requirements in
`01-pilot-scope-and-journeys.md` traceable without duplicating their normative text.
The source statement is authoritative. `Evidence` remains `pending` until a verifier
links an immutable result for the exact release artifact.

This register is normalized: each requirement row joins to the group metadata below by
its ID prefix. Together, the source statement, group metadata, row, and evidence record
contain every mandatory field from `05-verification-and-traceability.md` §3. The default
verification case ID is the requirement ID with `PILOT-` replaced by `VT-` (for example
`PILOT-AUTH-001` becomes `VT-AUTH-001`).

Status values: proposed, accepted, implemented, verified, released, retired.

## 0. Shared requirement metadata

| ID prefix | Source | Rationale | Actors/scope | Preconditions | Implementation boundary |
|---|---|---|---|---|---|
| PILOT-AUTH | `01` J-01; D-001/D-010; contract Auth row | Only invited active owners access data safely | anonymous, invited, pending, active, suspended, removed; auth/session/client persistence | signed contract, identity provider configured | auth provider, server session, DB access predicate, client cache |
| PILOT-ONB | `01` J-02; Profile roadmap | First value without engine vocabulary or silent fallback | active new/returning user; profile criteria | active entitlement, gate corpus version | onboarding UI, profile RPC/table, TS/Python gate implementations |
| PILOT-TODAY | `01` J-03; Today design/handoff | Daily decisions are fast, truthful, and recoverable | active owner; actionable role set | current owner query and health | Today UI, URL/cache/outbox, decision RPC/audit |
| PILOT-JOBS | `01` J-04; Jobs handoff/design | Exact high-density browse/detail/export experience | active owner; jobs visible to that owner | integrated shell/dictionary/design source version | Jobs UI/view model/data source/export |
| PILOT-APP | `01` J-05; Applications handoff | Human-controlled application record with evidence | active owner; manual and conditional email paths | status model and owner-scoped app data | Applications UI, status/review/import RPCs and tables |
| PILOT-COV | `01` J-06; Coverage handoff; D-021 | Coverage describes real scan inputs, outcomes, and blind spots | active owner and scheduled lane | signed authority contract and per-user activity | Coverage UI, company RPCs, discovery engine/activity |
| PILOT-SET | `01` J-07; Settings/auth handoff | Consent and preferences remain understandable and reversible | active/suspended narrow owner | signed notification/connection decisions | Settings UI, preference/connection RPCs/providers |
| PILOT-EXIT | `01` J-08; D-009; Leave invariant | User can take data and stop processing | active or narrow suspended owner | signed retention/deletion schedule, recent auth for deletion | archive/delete orchestration across stores/providers |
| PILOT-REC | `01` J-09; operations standard | Failure does not create false success, duplication, or opaque support | user, worker, support operator | correlation/idempotency/alerts configured | client, command, jobs, telemetry, support tools |
| PILOT-SEC | WP-012/WP-016; threat model | Default deny and status safety contain highest-impact abuse | all identities and privileged paths | staging auth/RLS environment | DB RLS/RPC/storage plus email-review transaction |
| PILOT-DATA | WP-000/WP-041; authority contract | Private data is recoverable without Git exposure or ambiguous ownership | data/security operators | incident decision and encrypted backup | repository workflow, backup store, restore, reconciliation |
| PILOT-DES | design parity standard | Supplied design is reproduced without invented UI | every pilot-visible state | versioned design artifact | rendered UI, styles, geometry, copy, interactions |
| PILOT-A11Y | quality/design standards | Critical journeys are perceivable and operable | disabled and non-disabled users | supported device/input matrix | semantics, focus, input, zoom/reflow, announcements |
| PILOT-OPS | release/operations standard | Release can be observed, stopped, restored, and reproduced | release/ops/support owners | approved artifact/config and runbooks | deployment, flags, alerts, backup/restore, support |
| PILOT-PRIV | privacy standard; D-004/D-009/D-017/D-018 | Processing matches informed consent and minimization | pilot user, operator, processors | signed notice and data inventory | collection, providers, telemetry, retention/deletion |
| PILOT-SCOPE | signed pilot contract | Deployed product makes only the approved promise | all pilot actors/routes | approved `pilot-contract-v1` | feature gates, navigation, API/RPC, user copy |

## 1. Authentication and onboarding

| ID | Acceptance oracle | Required negative/boundary | Owner | Status | Evidence |
|---|---|---|---|---|---|
| PILOT-AUTH-001 | Uninvited identity scenario | direct API and existing session | security | proposed | pending |
| PILOT-AUTH-002 | Unentitled holding state | zero application reads | product/security | proposed | pending |
| PILOT-AUTH-003 | Repeat provisioning returns same logical result | simultaneous/replayed provision | security | proposed | pending |
| PILOT-AUTH-004 | One external identity maps to one internal user | duplicate/mismatched identity | security/data | proposed | pending |
| PILOT-AUTH-005 | Expired-session draft survives safe re-auth | unsafe sensitive draft is purged | product/security | proposed | pending |
| PILOT-AUTH-006 | Sign-out invalidates session | back/reload/direct API | security | proposed | pending |
| PILOT-AUTH-007 | Signed-out owner cache/queue unreadable | two users on one device profile | security | proposed | pending |
| PILOT-ONB-001 | User can explain each required field in comprehension charter | engine vocabulary absent | product/design | proposed | pending |
| PILOT-ONB-002 | Draft round-trips back/forward | fast Next after edit | frontend | proposed | pending |
| PILOT-ONB-003 | Save observed at approved RPC boundary | direct table DML denied | backend/data | proposed | pending |
| PILOT-ONB-004 | Stale-save conflict scenario | two tabs concurrent | backend/data | proposed | pending |
| PILOT-ONB-005 | Empty/malformed profile reaches explicit state | no persona/other-user fallback | product/security | proposed | pending |
| PILOT-ONB-006 | Same corpus case returns same preview/discovery decision | bidirectional semantic mutants | engine/frontend | proposed | pending |

## 2. Today and Jobs

| ID | Acceptance oracle | Required negative/boundary | Owner | Status | Evidence |
|---|---|---|---|---|---|
| PILOT-TODAY-001 | UI count equals owner-scoped query at recorded freshness | stale/partial source | product/data | proposed | pending |
| PILOT-TODAY-002 | Decision immediate then undo restores prior state | undo after superseding edit | frontend/backend | proposed | pending |
| PILOT-TODAY-003 | Offline replay scenario | duplicate/reordered dispatch | frontend/backend | proposed | pending |
| PILOT-TODAY-004 | Shortcut help is reachable | pointer-free discovery | design/a11y | proposed | pending |
| PILOT-TODAY-005 | Shortcut does not fire in editable control | all input/contenteditable roles | frontend/a11y | proposed | pending |
| PILOT-TODAY-006 | Rejected write returns to durable truth | provider/DB failure | frontend | proposed | pending |
| PILOT-TODAY-007 | Failed write exposes safe retry/result lookup | timeout after commit | frontend/backend | proposed | pending |
| PILOT-TODAY-008 | Only Today nav item renders badge | all routes/states | design | proposed | pending |
| PILOT-TODAY-009 | Badge equals retrievable actionable set | deleted/permission-stale item | product/data | proposed | pending |
| PILOT-JOBS-001 | Manifest has exactly six accepted data columns | narrow/large text | design | proposed | pending |
| PILOT-JOBS-002 | Manifest has four toolbar controls plus Display | dirty view/selection | design | proposed | pending |
| PILOT-JOBS-003 | parse/serialize/parse equality | unknown, duplicate, reordered params | frontend | proposed | pending |
| PILOT-JOBS-004 | Every absent-value fixture renders `Not listed` | null vs zero vs empty vs N/A | product/design | proposed | pending |
| PILOT-JOBS-005 | Missing domain produces ordinary avatar state | empty/malformed domain | frontend | proposed | pending |
| PILOT-JOBS-006 | Provider failures produce deterministic monogram | both providers unavailable | frontend/design | proposed | pending |
| PILOT-JOBS-007 | Export row keys/count equal visible declared scope | selection/filter changes while open | data/product | proposed | pending |
| PILOT-JOBS-008 | Escape returns focus to selected row | row removed while pane open | frontend/a11y | proposed | pending |
| PILOT-JOBS-009 | Deep-link scenario round-trips URL | invalid/other-owner identifier | frontend/security | proposed | pending |

## 3. Applications and Coverage

| ID | Acceptance oracle | Required negative/boundary | Owner | Status | Evidence |
|---|---|---|---|---|---|
| PILOT-APP-001 | Add/import report accounts for every input | duplicates, weak match, malformed URL | product/data | proposed | pending |
| PILOT-APP-002 | Human-lock database invariant | automation after human change | data/security | proposed | pending |
| PILOT-APP-003 | Status transition model | backward/unknown transition | data/engine | proposed | pending |
| PILOT-APP-004 | Every auto status has evidence or review | missing/redacted evidence | product/data | proposed | pending |
| PILOT-APP-005 | Ambiguous email scenario | stale/conflicting candidates | security/data | proposed | pending |
| PILOT-APP-006 | Import preview/commit report equality | included/excluded/error totals | data/product | proposed | pending |
| PILOT-APP-007 | Interrupted import resumes or reports safe restart | browser close/network loss | backend/frontend | proposed | pending |
| PILOT-COV-001 | Coverage query separates configured/checked/supported/failed | zero/partial provider data | product/data | proposed | pending |
| PILOT-COV-002 | One-stale-user scenario | shared healthy heartbeat | ops/data | proposed | pending |
| PILOT-COV-003 | Unresolved company is not claimed monitored | failed resolution/grounding conflict | product/engine | proposed | pending |
| PILOT-COV-004 | Copy predicate equals recorded successful checks | invoked-but-failed run | product/ops | proposed | pending |
| PILOT-COV-005 | Every degraded state has an executable next action | no user repair available | product/design | proposed | pending |

## 4. Settings and exit

| ID | Acceptance oracle | Required negative/boundary | Owner | Status | Evidence |
|---|---|---|---|---|---|
| PILOT-SET-001 | New user sends no product email before explicit consent | migrated/unknown preference | product/privacy | proposed | pending |
| PILOT-SET-002 | Unsubscribe prevents next eligible send | forwarded/replayed/expired link | product/privacy | proposed | pending |
| PILOT-SET-003 | State machine renders connected/expired/revoked/error/reconnecting | provider unreachable | product/frontend | proposed | pending |
| PILOT-SET-004 | Preference manifest names one scope/precedence | cookie + DB + saved-view conflict | product/frontend | proposed | pending |
| PILOT-SET-005 | Two-user preference isolation | direct RPC wrong owner | security/data | proposed | pending |
| PILOT-SET-006 | Setting mutation and audit are atomic | rejected/no-op/conflict | data | proposed | pending |
| PILOT-EXIT-001 | Active user completes archive without support | suspended narrow-access path | product/data | proposed | pending |
| PILOT-EXIT-002 | Archive manifest matches contents/classes | unknown future data class | data/privacy | proposed | pending |
| PILOT-EXIT-003 | Deletion rejects stale/non-recent session | replayed confirmation | security | proposed | pending |
| PILOT-EXIT-004 | Confirmation displays exact scope and consequence | accidental/double activation | product/security | proposed | pending |
| PILOT-EXIT-005 | Session/token revocation query returns none active | queued/retrying capture | security/ops | proposed | pending |
| PILOT-EXIT-006 | No future notification/job after completion | delayed queue/schedule | ops/privacy | proposed | pending |
| PILOT-EXIT-007 | Completion record contains no deleted content | logs/audit/analytics scan | privacy/data | proposed | pending |
| PILOT-EXIT-008 | Pre-confirmation notice equals signed retention schedule | backup/audit exception | privacy/product | proposed | pending |

## 5. Recovery

| ID | Acceptance oracle | Required negative/boundary | Owner | Status | Evidence |
|---|---|---|---|---|---|
| PILOT-REC-001 | Failure injection renders approved degraded state | network/DB/email/ATS individually | product/frontend | proposed | pending |
| PILOT-REC-002 | Timeout-after-commit scenario creates one logical effect | decision/app/event/send classes | backend/data | proposed | pending |
| PILOT-REC-003 | Alert fires for one stale critical user lane | global/shared health remains green | ops | proposed | pending |
| PILOT-REC-004 | Support correlation finds operation without sensitive content | email/note/token fixture | ops/privacy | proposed | pending |

## 6. Cross-cutting launch requirements

| ID | Statement | Acceptance oracle | Owner | Status | Evidence |
|---|---|---|---|---|---|
| PILOT-SEC-001 | Every user-scoped read/write/export/cache MUST default-deny outside the active owner entitlement | full direct authorization matrix and failing allow-by-default mutant | security | proposed | pending |
| PILOT-SEC-002 | Email review MUST commit at most one server-authorized resolution | genuine concurrent transaction scenario and outside-candidate negative | security/data | proposed | pending |
| PILOT-DATA-001 | Live database backups MUST be encrypted, access-controlled, versioned, and outside Git | canary absent from Git, restored externally, unauthorized decrypt denied | data/security | proposed | pending |
| PILOT-DATA-002 | Every mirrored class MUST have one accepted authority/reconciliation contract | `10-data-authority-and-transition.md` signed and drill passed | data | proposed | pending |
| PILOT-DATA-003 | A restored older backup MUST not resume processing for deleted accounts | deletion-ledger restoration scenario | data/privacy | proposed | pending |
| PILOT-DES-001 | Every pilot-visible route/state MUST pass the strict parity manifest | `04-design-parity-standard.md` evidence, zero unexplained exception | design | proposed | pending |
| PILOT-A11Y-001 | Every critical journey MUST conform to WCAG 2.2 AA and manual keyboard/screen-reader/zoom checks | automated plus manual evidence | accessibility/design | proposed | pending |
| PILOT-OPS-001 | Every risky capability MUST have a tested server-side kill switch and safe degraded state | staging activation, disable, recovery rehearsal | ops | proposed | pending |
| PILOT-OPS-002 | Restore MUST meet accepted RPO/RTO and preserve ownership/integrity | isolated restore drill | ops/data | proposed | pending |
| PILOT-OPS-003 | The exact verified artifact/configuration MUST be the deployed canary artifact/configuration | digest/manifest equality and post-deploy invariants | release | proposed | pending |
| PILOT-PRIV-001 | Pilot collection, processing, retention, processors, export, deletion, and support access MUST match the signed notice | data inventory + behavior audit + consent record | privacy/product | proposed | pending |
| PILOT-SCOPE-001 | In/Conditional/Excluded behavior MUST match the signed `pilot-contract-v1` matrix | route/API/flag capability probe | product/release | proposed | pending |

## 7. Evidence record schema

Each `pending` cell is replaced by a stable evidence reference with:

```yaml
requirement_id: PILOT-AUTH-001
case_id: VT-AUTH-001
release_artifact: "<commit/build digest>"
database_schema: "<migration versions/checksums>"
configuration_manifest: "<digest>"
environment: staging
controlled_inputs: {}
oracle: ""
counterexample_or_mutation: ""
result: pass
artifact_uri: ""
verified_by: ""
verified_at: ""
expires_on_change:
  - implementation boundary
  - schema/policy
  - auth/provider configuration
```

No requirement may move to `verified` without at least one passing acceptance case and
one relevant negative/boundary case. Security/data invariants require a failing
counterexample or mutation proof.
