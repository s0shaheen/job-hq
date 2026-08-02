# Full-product pilot launch control

Status: owner direction accepted; first execution packets ready; blocking ADRs identified
Audience: product owner, engineering, design, security, operations, support, and implementation agents
Normative vocabulary: RFC 2119 and RFC 8174 (`MUST`, `MUST NOT`, `SHOULD`, `MAY`)

## 1. Launch definition

The pilot is the complete Job Search HQ product for its first invited users. It is not a
feature slice, an MVP subset, or an owner-only demo. A feature that the product promises
MUST be complete, reachable, truthful, secure, and supportable for every active pilot
user.

The only owner-approved product exclusion is Gmail-derived automatic application status.
Users MUST still have a complete manual application-status workflow. Gmail sign-in MAY
be used for authentication without requesting mail scopes. Gmail ingestion, email
classification, and automatic status transitions MUST be disabled and absent from the
launch promise.

The web app is the sole user surface and Postgres is the sole operational system of
record. Google Sheets has no synchronization, fallback, control-plane, or user-facing
role after cutover. Spreadsheet-compatible import and export remain file capabilities,
not synchronization.

## 2. Locked owner decisions

| Area | Launch decision |
|---|---|
| Product scope | All designed and promised product features; no placeholder destinations |
| Cohort | Invited/activated users receive the complete product |
| Signup | Email/password and Google sign-in MAY be open; non-activated accounts receive a holding state with no product data |
| Commercial access | First users are free forever and uncapped; no cost cap |
| Billing | Build the complete plan/usage/checkout/portal shape and enforcement seam; activated first users receive an all-access free-forever entitlement |
| Autopilot | Full prepare, review, submit, receipt, rules, activity, and failure/recovery scope |
| Gmail status | Excluded from launch; manual status is authoritative |
| Data authority | Postgres only; no Google Sheets correlation or synchronization |
| Market | United States, any job family or seniority |
| Devices | Laptop and phone; responsive and touch/keyboard accessible |
| Warm introductions | Provider-backed discovery, candidate fit, multi-pin, manual add, and human-run outreach funnel |
| Resume | Productized in-app resume system with user-owned content; no Salman-specific defaults |
| Reliability | Hosted, unattended operation; users do not babysit jobs or keep the owner's laptop online |
| Design | Strict parity with the downloaded owner design system; no invented design |

## 3. Complete product promise

An activated user can:

1. create an account, be activated, onboard, and configure a general US job search;
2. discover and monitor companies and roles without using a spreadsheet;
3. review Today, search Jobs, inspect details, filter, save views, decide, and export;
4. add, import, track, annotate, and update Applications manually;
5. create, import, edit, version, render, select, and export resumes and attachments;
6. configure Autopilot policies and answer facts, prepare an application, review its
   exact payload and attachments, authorize submission, submit on supported ATS paths,
   and receive durable receipt evidence;
7. see an honest unsupported/manual handoff when an ATS cannot be safely automated;
8. manage Coverage, sources, company monitoring, blind spots, and activity;
9. find potential warm introductions, pin candidates, record human outreach and outcomes;
10. use Settings for profile, display, notifications, connections, plan, data, privacy,
    export, and account deletion;
11. use every critical workflow on supported laptop and phone layouts;
12. receive truthful notification and operational status without requiring Gmail
    ingestion; and
13. leave with a complete archive and an enforceable deletion workflow.

“All features” does not mean pretending every ATS permits safe automation. Coverage and
execution support MUST be explicit per provider. Where automation is technically or
contractually unavailable, the full product behavior is a complete manual handoff with
preserved preparation, attachments, answers, deep link, and outcome recording. It MUST
never show a false submitted state.

## 4. Current reality

The repository contains a strong but fragmented foundation:

- discovery adapters, scheduled AWS jobs, Postgres migrations, RLS foundations, imports,
  pipeline status rules, profile gating, notifications, and fixture-backed web data;
- a completed Jobs redesign branch and completed display-dictionary/anti-slop branch;
- active migrations for company domains (`0021`), activity (`0023`), display
  preferences (`0025`), resume productization (`0026`), and entitlements (`0027`);
- a Gmail-review branch (`0022`) that is unsafe and excluded from the launch artifact;
- a missing durable Autopilot staging migration (`0024`);
- application Prepare/Review logic without a production submission executor;
- warm-introduction Layer 2 foundations, with the outreach funnel still incomplete;
- owner-specific resume/application content that must move to a private personal vault;
- remaining engine paths that still read or write Google Sheets; and
- a GitHub workflow that commits a database dump to Git and must be contained.

Branch-local completion is not release completion. Every concern MUST be replayed into
one integration line, upgraded from production-like data, verified after integration,
and deployed from the exact tested artifact.

The root `AGENTS.md` and `CLAUDE.md` were updated on 2026-07-29 to describe the
Postgres-only product, launch safety boundaries, design authority, and delegation
rules. Dispatchers MUST still provide an instantiated packet and current source hashes;
the root doctrine is orientation, not a substitute for packet-specific requirements.

## 5. Required path before invitations

```text
Contain data incident and establish encrypted restore
  → freeze full-product contract and provider support matrix
  → integrate migrations and security boundaries
  → complete Postgres-only engine and remove Sheet dependencies
  → complete shared design system, auth, entitlement, and system states
  → complete every user surface
  → productize resumes and attachments
  → complete Autopilot prepare/review/submit/receipt
  → complete warm-introduction discovery and human outreach funnel
  → complete notifications, billing shape, data exit, and account lifecycle
  → prove multi-user isolation, design parity, mobile, security, and recovery
  → owner soak
  → one external-user canary
  → invited cohort
```

No launch milestone may skip a predecessor by hiding the unfinished feature. A
technically unsupported ATS route may use the specified manual handoff because that is
the product’s honest supported behavior, not a placeholder.

## 6. Launch gates

| Gate | Required exit evidence |
|---|---|
| G0 Contract | This full-product contract, provider support matrix, privacy/retention terms, support identity, and owner approval |
| G1 Containment | Git dump stopped; access scope assessed; encrypted backup and isolated restore proven; history-remediation decision recorded |
| G2 Integrated schema | Unique contiguous migrations, empty install, production-like upgrade, RLS/grant audit, restore compatibility |
| G3 Data cutover | All production reads/writes/schedules use Postgres; no Sheet credential required; no reconciliation lane remains |
| G4 Security | Default-deny entitlements, two-user isolation, service-role containment, secrets review, abuse controls, deletion propagation |
| G5 Product | Every promised journey and degraded state passes against production-shaped data |
| G6 Autopilot safety | Exact-payload review, explicit authorization, idempotent submit, unknown-outcome recovery, receipts, provider matrix, kill switches |
| G7 Design/accessibility | Strict parity manifest for every route/state/viewport; WCAG 2.2 AA evidence; no unexplained exceptions |
| G8 Reliability | SLOs, hosted monitoring, alerts, backup/restore, job recovery, rollback, and incident drills |
| G9 Release candidate | Requirements traceability complete; zero severity 0/1; exact commit/config/environment recorded |
| G10 Staged launch | Owner soak, external canary, stop-condition review, then invitations |

## 7. Release rule

Launch is allowed only when:

- every `MUST` requirement in the signed scope has passing evidence;
- no promised surface is a placeholder or dead control;
- Gmail automatic status is disabled at route, scheduler, token, and product-copy layers;
- no product operation depends on Google Sheets or the owner’s laptop;
- every state-changing command is authenticated, owner-derived, idempotent, auditable,
  and either undoable or explicitly irreversible;
- every automated submission is attributable to an immutable reviewed payload and has
  a receipt or an honest unknown/manual state;
- an isolated restore, full export, and account deletion have been exercised;
- the tested artifact and production artifact are identical; and
- the owner signs the remaining accepted risks.

## 8. Document map and precedence

1. [`09-full-product-contract-v2.md`](09-full-product-contract-v2.md) is the scope authority.
2. [`13-full-product-roadmap.md`](13-full-product-roadmap.md) is the dependency graph and
   total remaining work.
3. [`14-work-packet-standard.md`](14-work-packet-standard.md) defines cheaper-model
   handoffs.
4. [`packets/`](packets/) contains coordinator packet families;
   [`instances/`](instances/) contains dispatchable packet instances.
5. [`15-full-product-requirements-register.md`](15-full-product-requirements-register.md)
   is the current atomic normative ledger.
6. [`03-engineering-quality-standard.md`](03-engineering-quality-standard.md),
   [`04-design-parity-standard.md`](04-design-parity-standard.md), and
   [`05-verification-and-traceability.md`](05-verification-and-traceability.md) define
   implementation-neutral quality and evidence.
7. [`10-data-authority-and-transition.md`](10-data-authority-and-transition.md) governs
   Postgres authority and Sheet removal.
8. [`11-metric-dictionary-and-slos.md`](11-metric-dictionary-and-slos.md) governs
   measurable safety and reliability.
9. [`07-decisions-assumptions-risks.md`](07-decisions-assumptions-risks.md) records
   locked decisions, blocking ADRs, design addenda, and current risks.
10. [`16-source-manifest.md`](16-source-manifest.md) records content-addressed design and
    repository planning sources.
11. [`17-ui-verification-standard.md`](17-ui-verification-standard.md) is the executable
    companion to 04 and 05: the surface × state × mode coverage ledger, the live-data
    browser lane, the launch journeys, and the flake and anti-vacuity policies. A routed
    surface with a `missing` cell is not a release candidate.
12. [`archive/`](archive/) preserves historical narrow-pilot analysis. It is not an
    execution source.

Any older sentence in this directory that recommends a narrow pilot, a placeholder
Autopilot, a Google Sheet fallback, a small hard cohort cap, or deferring billing/resume/
referral/product capabilities is superseded by this file and
`09-full-product-contract-v2.md`.

For visible behavior, the source order is:

1. `/Users/s0shaheen/Downloads/job-hq-design-system`;
2. `/Users/s0shaheen/job-hq-design-context/design-mirror/README.md`;
3. the relevant `*-handoff.md` and `gap-*.md`;
4. the copy dictionary in `02-terminology-and-copy.md`; and
5. existing implementation only where the design is silent.

The design source is read-only. Missing states become owner questions or explicit
design-addendum requirements, not agent invention.
