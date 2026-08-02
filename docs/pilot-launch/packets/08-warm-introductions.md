# Packet family 08 — Warm introductions and referral funnel

## Outcome

Users can find and prioritize plausible human introductions, then manage outreach
themselves without surrendering LinkedIn credentials or automating messages.

## Atomic packets

### PKT-08A Layer-2 integration

Integrate `0020` provider lifecycle and production data-source interfaces. Support
start/poll/cancel, ordinary no result, rate limit, provider failure, expiry, and reload.
No user cookie/session is collected.

### PKT-08B Search parameters and results

Three editable persona searches, default target 40 deduplicated results total across
them, configurable to 50, user-supplied profile/name, company/role context, provenance,
and deterministic ordering. Provider-returned shortfall is ordinary. The count is a
target/provider bound, not a founding-user quota.

### PKT-08C Fit analysis

Explain candidate fit using only available role, user profile, company, function,
seniority, geography, and connection evidence. Missing data remains unknown. Store model
version/input references without private text telemetry.

### PKT-08D Multi-pin/manual add

Pin multiple candidates per job, add a person manually, unpin, and display consistent
state in Jobs, Applications, Coverage, and detail panes. Commands are idempotent/CAS and
owner-derived.

### PKT-08E Outreach funnel

Contact entity and stages `identified`, `contacted`, `replied`, `referred`, `interview`;
notes, follow-up date, user-reviewed draft/copy action, and Today reminders.

### PKT-08F Metrics

Funnel conversion, time-to-contact, reply/referral/interview rates, provider quality,
and failures use event definitions from the metric dictionary. No automated messaging,
profile scraping as the user, or content telemetry.

### PKT-08G People-data governance

Before live provider use, record processor/subprocessor, data source, permitted use,
accuracy limits, data sent, retention/deletion, correction/removal, regional transfer,
security, incident notice, and contract/terms review. User consent and product copy
cannot imply that presence, absence, or fit is verified when it is provider-derived.

## Design dependency

The owner design currently lags multi-select and 40-result default behavior. Require a design
addendum before visible implementation; do not invent the panel.
