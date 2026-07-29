# Instantiated launch packets

The lightweight read-only profile in `../14-work-packet-standard.md` permits the first
and third packets to be dispatched after their baseline is refreshed:

1. [`PKT-BASELINE-READ.md`](PKT-BASELINE-READ.md)
2. [`PKT-DESIGN-MANIFEST.md`](PKT-DESIGN-MANIFEST.md), after baseline acceptance

[`PKT-DUMP-DISABLE.md`](PKT-DUMP-DISABLE.md) is a pre-instantiated T4 draft. Before
dispatch, the coordinator MUST add named ownership, accepted baseline/config digest,
exact optional runbook path, complete dependencies/interfaces/observability/rollout,
and evidence destinations.

The broader files in `../packets/` are coordinator packet families, not direct
implementation prompts. All remaining child packets must be instantiated to the same
standard before dispatch.
