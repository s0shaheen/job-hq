# Packet family 02 — Postgres-only engine

## Outcome

The deployed product and every scheduled lane run from Postgres/object storage without
Google Sheets, reconciliation, or the owner’s laptop.

## Atomic packets

### PKT-02A Runtime dependency inventory

Trace every production read/write/config/heartbeat/schedule path that touches gspread,
Sheet IDs/gids, `core.sheets`, tracker tabs, Sheet-derived config, or Sheet snapshots.
Classify as replace, historical import, or delete.

### PKT-02B Company/discovery cutover

Discovery consumes user-scoped Postgres company subscriptions, search profile, enabled
state, schedule, and provider policy. Results and run records write Postgres through
owner-derived commands. Unknown user lanes fail before provider access.

### PKT-02C Jobs/applications cutover

Replace Feed/Pipeline/Quick Add/promote/join/stale paths with Postgres-native commands
and event rules. Manual application status is authoritative. Gmail join/status is off.

### PKT-02D Configuration and schedules

Move user-editable behavior to validated per-user settings. EventBridge/Lambda jobs are
jobs × active users, idempotent, bounded, observable, and cancellable on suspension.

### PKT-02E Health and backup cutover

Use Postgres run/activity ledgers and encrypted database/object backups. AWS Sheet CSV
snapshots and Sheet heartbeat semantics are removed from the product recovery claim.

### PKT-02F Decommission

Export/archive legacy Sheet data, revoke product service-account access, remove runtime
secrets and deployment requirements, stop dual-write/reconciliation, and update
runbooks/system maps. Historical import tools cannot run accidentally in production.

## Acceptance

- production boots and completes discovery/application journeys with no Google
  service-account secret;
- repository/runtime scan finds no scheduled Sheet read/write;
- no UI, API, worker, alert, backup, or rollback references a live Sheet;
- a two-user schedule proves isolation and one-user failure does not mask another;
- post-cutover rollback uses compatible Postgres code/flags, not Sheets.
