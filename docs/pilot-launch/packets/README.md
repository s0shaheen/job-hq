# Coordinator packet-family index

These packet-family briefs refine the roadmap into units that must be split and
instantiated. They are not direct implementation prompts. Before a worker receives one,
the coordinator MUST instantiate the full schema in
`../14-work-packet-standard.md` with the current base commit, file allowlists, dependency
evidence, requirement IDs, and source excerpts.

Dispatchable examples live in [`../instances/`](../instances/).

| Packet | Outcome | Tier | Depends on |
|---|---|---:|---|
| [`00-baseline-and-containment.md`](00-baseline-and-containment.md) | Establish truth, stop Git dumps, prove replacement restore | T4 | none |
| [`01-integration-and-access.md`](01-integration-and-access.md) | Integrate migrations and enforce default deny | T3/T4 | 00 |
| [`02-postgres-only-engine.md`](02-postgres-only-engine.md) | Remove all Sheet runtime dependencies | T4 | 01 |
| [`03-shared-design-platform.md`](03-shared-design-platform.md) | Land shared shell, dictionary, system states, parity harness | T2/T3 | 01 |
| [`04-core-surfaces.md`](04-core-surfaces.md) | Complete Today, Jobs, Applications, Coverage, Settings/auth | T2/T3 | 02, 03 |
| [`05-resume-product.md`](05-resume-product.md) | Generic multi-user resume and attachment service | T3/T4 | 01, 03 |
| [`06-autopilot-state.md`](06-autopilot-state.md) | Durable Prepare/Review and safety contract | T3/T4 | 01, 03, 05 |
| [`07-autopilot-execution.md`](07-autopilot-execution.md) | Approved executor, supported ATS adapters, receipts | T4 | 06 |
| [`08-warm-introductions.md`](08-warm-introductions.md) | Provider search, fit, multi-pin, human outreach funnel | T3 | 01, 03, 04 |
| [`09-commercial-notifications-exit.md`](09-commercial-notifications-exit.md) | Billing seam and notifications; final archive/deletion after every data-producing packet | T4 | 01–08 |
| [`10-release-qualification.md`](10-release-qualification.md) | Security/design/reliability proof and staged launch | T4 | all |

Families describe outcomes, not permission to edit every named subsystem at once. Each
brief MUST be split into genuinely atomic child packets and instantiated before
dispatch.
