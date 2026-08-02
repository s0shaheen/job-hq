# Packet family 06 — Autopilot Prepare and Review

## Outcome

Autopilot durably prepares an exact application package, explains every gap, and records
immutable explicit approval without submitting yet.

## Atomic packets

### PKT-06A Migration and state machine

Implement missing staging persistence with owner scope, application/provider/form
identity, schema hash, parsed form, resolved answers/evidence, gaps, attachment
checksums, reviewed payload, state/version/timestamps, and audit.

States:

`draft`, `prepared`, `needs_input`, `ready_for_review`, `approved`, `executing`,
`submitted`, `outcome_unknown`, `failed_retryable`, `failed_terminal`, `cancelled`.

Preparation transitions:

| From | To | Required proof |
|---|---|---|
| none or terminal draft | `draft` | owner/application/provider resolved |
| `draft` | `prepared` | form parsed, answers/evidence/attachments snapshotted |
| `draft` or `prepared` | `needs_input` | required unresolved/sensitive gap exists |
| `prepared` or `needs_input` | `ready_for_review` | required gaps resolved and schema current |
| `ready_for_review` | `approved` | explicit or ADR-002-authorized approval recorded against exact hash |
| any pre-execution state | `cancelled` | cancellation before irreversible action |
| `approved` | `ready_for_review` | approval expired or an input changed |
| any editable state | new `draft` version | edit/re-stage; prior approved snapshot remains immutable |

`discard` closes the active draft/stage with an audit event and never mutates an
immutable approved/submitted historical version. Execution transitions exist only in
`07-autopilot-execution.md`.

### PKT-06B Answer engine

Preserve the four-layer policy:

1. constants;
2. explicit typed user facts with polarity/company scope;
3. resume-backed inference with cited evidence;
4. drafted free response requiring review.

Never infer work authorization, visa, EEO, compensation, legal identity,
criminal/background answers, or unsupported factual claims.

### PKT-06C Stage commands

Stage/re-stage/discard/edit/approve use idempotency, CAS, owner derivation, JSON limits,
unknown-field handling, and audit. Approved snapshots are immutable; edits create a new
version. Reused key/different payload is rejected.

### PKT-06D Review UI

Show provider, role, form change state, every field/answer/source, sensitive gaps,
attachments/version, submit consequence, and exact approval. Support phone/laptop,
keyboard, draft preservation, conflict, expiry, provider degradation, and cancellation.

### PKT-06E Today/Applications integration

Ready-to-review counts and rows use the same query contract. Status/history never claims
submission before a receipt.

## Acceptance focus

Two-user isolation, concurrent approval/edit, provider schema change after prepare,
deleted attachment, oversize payload, unknown sensitive field, timeout-after-write,
reload persistence, and policy mutation that would infer a sensitive answer.
