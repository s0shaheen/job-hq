# Packet family 07 — Autopilot execution and receipts

## Outcome

An explicitly approved package can be submitted once on a supported ATS, with truthful
receipt/unknown/manual behavior and immediate kill switches.

## Decision packet PKT-07A — Execution host

Owner, architecture, security, and operations choose hosted browser, user-owned
extension/agent, hybrid, or another proven host. Evaluate:

- provider fraud/abuse behavior and terms;
- unattended reliability and phone approval;
- cookie/credential exposure;
- install/upgrade/health burden;
- network reputation;
- CAPTCHA/account/OTP behavior;
- command signing/replay;
- cost and incident blast radius.

No worker implements the executor before this decision is signed.

## Atomic build packets

### PKT-07B Command protocol and executor

Single-use signed owner-scoped command, reviewed-payload checksum, expiry, host version,
health, pause/revoke, progress, safe secret handling, and receipt return. Executor loss
mid-submit becomes `outcome_unknown`, never blind retry.

### PKT-07C Submission core

Re-fetch live form; compare schema; revalidate attachment and approval; check duplicate;
acquire per-application/provider lock; rate limit; submit; classify response; persist
immutable receipt; release/retain lock according to outcome.

### PKT-07D Greenhouse

Dedicated fixture corpus, live-shape contract, attachments, custom questions, drift,
confirmation, duplicate, timeout, CAPTCHA/login, and kill switch.

### PKT-07E Ashby

Same requirements, separate adapter and evidence.

### PKT-07F Lever

Same requirements, separate adapter and evidence.

### PKT-07G SmartRecruiters

Same requirements, separate adapter and evidence.

### PKT-07H Manual/account/OTP support

Manual handoff preserves exact prepared answers, attachments, provider link, checklist,
and user-recorded outcome. Account/OTP automation requires separate credential/consent
qualification; user-entered OTP is preferred to mailbox access. No CAPTCHA bypass.

### PKT-07I Rules and activity

Global pause, user/provider/job policy, explicit per-application review, sampling,
success/drift thresholds, adapter-version reset, receipt/activity UI, and notifications.

## Receipt contract

`submitted` requires durable reviewed payload plus provider confirmation page/identifier
or equally strong provider response evidence. Otherwise use `outcome_unknown`,
`failed_retryable`, `failed_terminal`, or manual. Gmail is not required and cannot
mutate status.

Accepted evidence classes, highest to lowest:

1. provider-issued application/confirmation identifier returned after submit;
2. authenticated provider application record retrieved without ambiguity;
3. provider confirmation response plus a redacted confirmation-page capture where
   provider policy permits storage;
4. provider confirmation response with stable success marker validated by the
   versioned adapter corpus.

Class 4 needs provider-specific owner acceptance. Screenshots are optional evidence, not
automatically required: they are encrypted, owner-scoped, access-audited, redacted of
unnecessary answers/EEO values, and retained under ADR-013. If no accepted class is
present, the state is not `submitted`.

Submission outcome and user pipeline status are distinct:

- the immutable attempt outcome records what Job HQ/provider evidence proves;
- the user-controlled pipeline status records how the user wants to track the
  application;
- a confirmed outcome may suggest a status, but does not erase a later user correction;
- a manual handoff may record `user_reported_submitted` without pretending Job HQ has a
  provider receipt.

Legal transitions:

| From | To | Required proof |
|---|---|---|
| `approved` | `executing` | current approval, live schema/attachment valid, lock acquired |
| `executing` | `submitted` | accepted receipt evidence class |
| `executing` | `outcome_unknown` | an external commit may have occurred but confirmation is insufficient |
| `executing` | `failed_retryable` | positive proof no external submit could have committed |
| `executing` | `failed_terminal` | provider/policy/validation failure that requires new preparation/manual path |
| `approved` or pre-submit `executing` | `cancelled` | cancellation acknowledged before irreversible action |
| `outcome_unknown` | `submitted` | later accepted receipt evidence |
| `outcome_unknown` | `failed_terminal` | provider/user reconciliation proves no usable submitted application and blind retry remains unsafe |
| `failed_retryable` | `approved` | user/retry policy requests a new attempt with unchanged or newly approved version |

`outcome_unknown` never transitions directly to `executing` or `failed_retryable`.

## Required adversarial proof

Concurrent double-click/devices, same role/provider identity, timeout before/after
possible commit, stale form, changed attachment, wrong owner, executor replay, forged
receipt, provider HTML drift, rate limit, circuit breaker, pause, and recovery.
