# Data authority and transition contract

Status: proposed template; owner/source decisions incomplete

## 1. Rule

Each data class MUST have one authoritative state at a point in time. Mirrors and
derived views may exist, but they cannot both silently “win.” A transition is accepted
only when direction, reconciliation, repair, deletion, rollback, and sunset are
specified.

## 2. Contract fields

| Field | Definition |
|---|---|
| Class | User/domain data being controlled |
| Authority | Store or external evidence that wins |
| Writers | Every permitted writer |
| Readers | Every consumer |
| Direction | Source → mirror/derived store |
| Key | Stable identity/dedup mapping |
| Conflict | Deterministic winner; human-wins where applicable |
| Reconciliation oracle | Query/property that detects divergence |
| Cadence/grace | When it runs and how late is stale |
| Stop threshold | Divergence that pauses rollout |
| Repair authority | Component/person allowed to repair |
| Deletion | Propagation and backup reconciliation |
| Rollback | Trusted path after disabling new writer |
| Sunset | Evidence required to remove old path |

## 3. Proposed authority matrix

Every `pending` item is launch-blocking if its data class is in scope.

| Data class | Proposed authority | Writers/readers and direction | Conflict/repair | Reconciliation and stop | Deletion/rollback/sunset |
|---|---|---|---|---|---|
| Auth identity | Supabase Auth identity mapped 1:1 to `public.users` | auth provisioning → user row | external identity stable; no client owner | one auth identity ↔ one active internal user; any cross-map stops rollout | revoke auth + row policy; restore uses deletion ledger |
| Pilot access | DB-enforced allowlist/active predicate | named operator command; every read/RPC checks | deny on missing/unknown | direct identity matrix every release; any bypass S0 | suspension stops sessions/lanes; no sunset during pilot |
| Search profile | Postgres `profiles` | user RPC; discovery reads compiled criteria | latest valid CAS; no persona fallback | view/engine corpus equality; any cross-user or semantic drift stops affected launch | delete/export; Sheet copy, if any, is non-authoritative |
| Job catalog | Shared Postgres postings populated by engine; provider boards are source evidence | fetchers → normalized postings; user views read | canonical key/dedupe contract | provider counts, duplicate keys, freshness per channel | shared facts may remain if non-user; user association deletes |
| User job decision | Postgres `user_postings` | user RPC, approved automation only | human-wins; CAS/idempotency | decision/audit equality; any lost/duplicate/human overwrite stops | export/delete; Sheet mirror must not overwrite |
| Company monitoring | **Pending D-021; recommended Postgres** | user RPC → `user_companies` → `monitor/run.py`; Sheet mirror optional | user choice wins; engine fills blanks only | approved monitored set equals next scan input per user; any false monitored claim pauses Coverage | delete association; fallback reads last reconciled Postgres/Sheet only under runbook; Sheet sunset after soak |
| Company domain | Shared Postgres with provenance | service/human approved writes; UI/logo reads | human value/clear wins; engine never overwrites | canonicalization and private-address corpus | shared fact correction; user deletion may not delete non-user shared company |
| Applications/status | Postgres applications | user RPC + safe email joiner | human-wins, forward-only automation, CAS | application/status/evidence/audit equality; any wrong mutation stops email lane | full export/delete; Sheet mirror reconciled without guessing |
| Application notes | Postgres append-only notes | user RPC; app reads | author/owner fixed; no silent edit | counts/owners; any cross-user S0 | export/delete or minimized retention per D-009 |
| Email capture raw/evidence | **Pending D-004 transition** | Gmail/App Script or OAuth poller → capture → Postgres; Sheet-first while dual-write | event ID dedupe; no guessed match | per-user captured vs processed outcomes and lag; stale threshold from metric dictionary | revoke/stop, export/delete/retention; Sheet rollback only while complete |
| Email review | Postgres review state | engine creates; user resolves via locked RPC | server candidate set, uniqueness, CAS | one resolution, at most one app mutation | retention/delete; disable resolution on incident |
| Events/audit | Postgres append-only, minimized | atomic commands/engine events; owner/support read appropriate subset | no content correction; append compensating record | command ↔ event invariant | D-009 defines minimized tombstone and expiry |
| Import staging | Postgres import tables plus transient upload | user upload/map/commit | batch ID/idempotency, later human changes win | row outcomes sum to scope; no hidden row | expire payload; export report; disable new imports |
| Saved views/preferences | Postgres after `0025` | user RPC; app reads | one declared per-user/per-view precedence | fixture/live defaults and no-op/version checks | export/delete; cookie migration retires |
| Connections | Postgres user-owned | user import/remove | normalized keys; never inferred as relationship | import report and owner isolation | export/delete; no LinkedIn network access |
| Preparation snapshots | Postgres only if `0024` accepted | deterministic stage/review RPC | approval bound to immutable hash; changed inputs stale | recompute/hash/state invariant | 30-day proposal; delete/disable; no submit rollback needed |
| Resume metadata/files | Postgres + private object storage only if `0026` accepted | authenticated upload/isolated render | server-verified digest/owner | DB/object checksum and restore | D-009; independent object backup; exclude otherwise |
| Notifications | Postgres preference + delivery provider receipt | user opt-in; scheduler/mailer | unsubscribe wins immediately | eligible set = send attempts; duplicate/suppression/lag | stop/revoke/delete; in-app fallback |
| Activity/heartbeats | Postgres per-user and allowlisted shared ops | handler start/finish | useful success, never invocation-only | cadence + grace per metric dictionary | 90-day proposal; does not replace durable audit |
| Sheet mirror | Operator-only transitional copy | approved dual writers | never override Postgres human state under proposed model | class-specific reconciliation | read-only/archive after sunset criteria |
| Backups | Managed + encrypted versioned external backup | backup service only | immutable/versioned; restore role separate | integrity + isolated restore, not file heartbeat | lifecycle and deletion ledger; never Git |

## 4. Reconciliation record

Each dual-write/replay lane MUST emit:

```yaml
class: applications
window_start: ""
window_end: ""
authority: postgres
mirror: sheet
authority_count: 0
mirror_count: 0
matched: 0
missing_in_authority: 0
missing_in_mirror: 0
value_conflicts: 0
human_conflicts: 0
unresolved: 0
oldest_unresolved_age: ""
repair_action: none
result: pass | warn | stop
release_artifact: ""
```

Counts alone are insufficient. The oracle MUST compare canonical keys, owner, relevant
values, status actor/version, and evidence identity without logging sensitive content.

## 5. Proposed stop rules

- Any cross-owner row: immediate S0.
- Any user decision overwritten by mirror/automation: immediate S0/S1 and stop writer.
- Any acknowledged authoritative write missing after the reconciliation grace: S1.
- Any unresolved ambiguity requiring guessed repair: stop repair and request owner/user.
- Any conditional lane beyond its metric grace: disable its product promise and show
  degraded state.
- Any restoration that changes ownership or resurrects deleted processing: restore
  failure.

Numerical grace and sample thresholds come from
`11-metric-dictionary-and-slos.md`.

## 6. Transition acceptance

For each class:

1. backfill with writers controlled;
2. compare canonical state;
3. deploy dual-compatible readers/writers;
4. enable one canary owner;
5. reconcile every run/window;
6. expand to pilot cohort;
7. meet the signed soak duration;
8. rehearse rollback;
9. change authority explicitly;
10. retire mirror writers only after exit evidence;
11. preserve export/deletion and restore reconciliation.

D-021 and D-004 MUST resolve the company-monitoring and email rows before the respective
capabilities launch.
