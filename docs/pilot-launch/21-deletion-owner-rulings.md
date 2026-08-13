# Account deletion — owner rulings required, with measured evidence

Status: **proposed, awaiting owner rulings.** This is the decision list #204's spec
surfaced, grounded in what the schema measurably does today rather than in what any
document says it does. The evidence column of every ruling is an executable test in
`tests/db/test_deletion_cascade.py`, run against real Postgres with a fully-populated
account (a row in every user-owned table `pg_catalog` knows about, plus a bystander
account proven untouched throughout). Nothing here implements deletion; #204's T4 flow
is owner-gated and starts from these rulings.

The one-sentence summary of the measurements: **a hard `auth.users` delete works today,
takes everything including provider evidence, cannot be audited by the mechanism that
audits everything else, leaves exactly two rows behind, and the contract's
pseudonymization step is refused by two shipped triggers.** One belief in the #204 issue
text is contradicted by measurement — see ruling (c).

The cascade map the tests proved:

| Row class | On `delete from auth.users` | Proof |
|---|---|---|
| `public.users`, `entitlements`, `profiles` | gone (cascade) | `test_a_hard_delete_empties_every_user_owned_table` |
| Every product table with `user_id` — 30 today, enumerated from `pg_catalog`, all populated before the delete | gone (cascade) | same test, exact-zero sweep |
| `events` rows owned by the user | gone — deletion erases its own audit trail | `test_the_deletion_itself_cannot_be_audited_by_events` |
| Autopilot stage, audit trail, class-1 provider receipt | gone — the keep-committed guard steps aside once the owner row is gone | `test_a_hard_delete_empties_every_user_owned_table` |
| `capture_tokens` | gone by row absence — no `revoked_at` is ever stamped | same test |
| Shared rows (`events`/`channel_runs`/`bot_runs` with null `user_id`, `postings`, `companies`) | survive — not the account's data | audit + survivor tests |
| `public.allowed_emails` invite row | **survives, with the email** | `test_what_survives_is_exactly_the_invite_row_and_the_storage_object` |
| `storage.objects` row under the user's prefix | **survives, orphaned** — its `resume_artifacts` pointer is gone | same test |
| Cross-account `approved_by` / `actor_user_id` reference | **blocks the whole delete, atomically** — account comes out fully alive | the two cross-account tests |
| Same-account `approved_by` / `actor_user_id` (the only shape shipped writes produce) | does **not** block — cascades in the same statement | `test_a_self_referencing_approval_does_not_block_the_delete` |

---

## (a) Three entitlement statuses vs the contract's "Removed/deleted" state

**The question.** Contract v2 §2 lists a "Removed/deleted" identity state.
`docs/specs/user-entitlement.md` pins the invariant "Exactly three entitlement states"
(`pending | active | suspended`) and CLAUDE.md's default-deny rule names `removed` as a
state that must deny. Read literally, the invariant forbids the state the contract
requires. Does deletion need a fourth status?

**The evidence.** No. `test_a_hard_delete_empties_every_user_owned_table` proves the
`entitlements` row cascades away with the account: "removed" already **is** row absence,
and the entitlement spec's own denial matrix ("removed — stale session") plus
`tests/db/test_default_deny.py`'s `removed` state sweep already prove absence denies at
every layer. The schema realizes the contract's state without a status value.

**Options.**
1. **Record in `docs/specs/user-entitlement.md` that "removed" is realized as row
   absence plus the #204 deletion ledger, and keep the three-status invariant.**
   Zero migration, matches measured behaviour, and the #204 issue already asks for
   exactly this spec edit. — **Recommended.**
2. Add a fourth `removed` status and keep a tombstone entitlements row. Requires
   removing the cascade from `entitlements.user_id`, touches the recursion-sensitive
   ungated-tables set in `test_default_deny.py`, and duplicates what the deletion
   ledger will record anyway.
3. Do nothing. Leaves the invariant reading as if it forbids #204 — the contradiction
   the issue told us to list rather than silently fix.

## (b) The audit paradox — `events` cannot audit its own deletion

**The question.** Every lifecycle change in this product is an `events` row with an
operator actor (user-entitlement spec, "Invariants"). FP-ID-006 requires the account
lifecycle to be idempotent **and audited**. What audits the deletion itself?

**The evidence.** `test_the_deletion_itself_cannot_be_audited_by_events`: the user's
`events` rows (present before, counted) are zero after the cascade, while a shared
`user_id is null` row survives as the positive control. Whatever `events` row a deletion
flow wrote would be erased by the very operation it describes. The mechanism the
contract assumes audits everything is structurally unable to audit this one operation.

**Options.**
1. **The #204 deletion ledger (RM-72) is the audit record for deletion, and it must not
   reference `public.users` with any cascading FK — it exists precisely to outlive the
   row.** The spec edit in ruling (a) records this single exception to the
   "every lifecycle change is an events row" invariant. — **Recommended** (this is
   what the issue already plans; the ruling is to accept the invariant exception
   explicitly rather than discover it later).
2. Keep an `events` row with `user_id = null` and the deleted id in the payload.
   Survives the cascade but re-creates the PII-survivor problem of ruling (f) inside a
   browser-readable table, and leaves "audited" split across two mechanisms.
3. Rely on external logs (Vercel/Supabase). Not owner-controlled, not durable to the
   35-day backup horizon, and not queryable by the restore-resurrection check.

## (c) The two no-cascade FKs and the pseudonymization step

**The question.** `20260802_094615_autopilot_staging.sql` deliberately declares
`autopilot_stages.approved_by` and `autopilot_transitions.actor_user_id` without
cascade: the approver identity is part of the audit answer. Contract v2 §8 says
submission receipts and audit records are pseudonymized/deleted within 30 days of a
verified deletion request, retaining a minimum security record 90 days. How do these
coexist in the deletion path?

**The evidence — three measurements, one of which contradicts the issue text.**

1. `test_a_self_referencing_approval_does_not_block_the_delete`: the issue says "a hard
   delete of a user who ever approved or acted on a submission will fail on those FKs".
   Measured: **it does not fail.** Approving is owner-only and the ownership guard
   refuses cross-account transitions, so every shipped write produces
   `approved_by = actor_user_id = user_id` — and both FKs are plain NO ACTION, checked
   at end of statement, by which point the referencing rows have cascaded away with the
   same account. An ordinary account, provider receipt and all, hard-deletes cleanly.
2. The two cross-account tests: when the reference **is** cross-account (reachable only
   as restored/legacy data), the delete is refused with the FK's own name, and the
   refusal is atomic — every row of the account survives, counts identical. The failure
   mode is "fully alive", never "half-deleted".
3. `test_pseudonymizing_the_evidence_references_is_refused_today`: the write §8's step
   would perform is refused by two shipped triggers — `approved_by := null` is "an
   approval is a transition, not a field edit", `actor_user_id := null` is "append-only
   evidence". Pseudonymization cannot be an UPDATE anyone can run today; it requires a
   migration-level carve-out.

   And a fourth, from the cascade map: the receipt/trail content §8 wants retained for
   90 days is **erased at the moment of deletion** — "the owner's erasure takes
   everything" is in-file design intent. Today's behaviour satisfies the 30-day
   pseudonymize clock trivially (instant erasure) and violates the 90-day retention
   clause entirely.

**Options.**
1. **Copy the minimum security record into the deletion ledger before the `auth.users`
   delete, and keep the erasing cascade.** The ledger row (already required by rulings
   (a)/(b)) carries the 90-day record — evidence hashes, provider references,
   timestamps, no identity beyond the ledger's own subject — and the pseudonymization
   carve-out shrinks to the cross-account case only: a dedicated, service-role-only
   step that may null the two FK columns exactly when the referenced user is being
   deleted, shipped as a migration that revises the refusal test with this ruling
   cited. — **Recommended:** smallest carve-out, no new writer for living evidence.
2. Stop the cascade at autopilot evidence (re-parent stages/trail/receipts to a
   tombstone identity at delete time). Maximal retention, but it makes deletion leave
   product rows behind, contradicts the erasure design stated in the migration, and
   every RLS predicate on those tables assumes a real owner.
3. Amend §8 to accept erasure-at-delete (no 90-day record for deleted accounts).
   Honest about today's behaviour and the most private option, but it forfeits the
   only defence evidence if an employer-side dispute arrives after a user deletes.

## (d) Storage objects are not deleted by the database cascade

**The question.** The `resumes` bucket is owner-scoped by key prefix
(`20260802_084857_resume_storage.sql`, `0026_resume.sql`). Does the account cascade
reach the stored objects?

**The evidence.** `test_what_survives_is_exactly_the_invite_row_and_the_storage_object`
proves the local half: after the delete, the `storage.objects` row under the user's
prefix survives, and the `resume_artifacts` row that named it is gone — the object is
**orphaned**: unreachable and undeletable through every product surface, bytes still in
the bucket, the user's uuid still in the key. The hosted half — that Supabase Storage
keeps the S3 bytes too — is **unverified locally** (the harness stubs the table, not the
service; its own header says deleting the row deleting the object is not reproducible
here). The production check, against the real project after a scratch deletion:

```sql
-- storage schema, real project: rows under the deleted user's prefix
select name, created_at from storage.objects
 where bucket_id = 'resumes' and name like '<deleted-user-uuid>/%';
```

plus the dashboard/`storage-api` listing of the same prefix (row absence alone does not
prove object absence; the harness cannot see the difference, the service can).

**Options.**
1. **Deletion deletes the user's storage prefix explicitly, before the `auth.users`
   delete, via the service client — the order the #204 acceptance criteria already
   specify — and the rehearsal captures the production check above as evidence.**
   — **Recommended** (this is the issue's plan; the ruling is confirming order and
   evidence, and that a failure between storage-delete and auth-delete must land in
   the resumable named state, never in "looks deleted").
2. A sweeper that garbage-collects orphaned prefixes after the fact. Adds a second
   deletion mechanism, and between delete and sweep the bytes survive with no owner —
   the exact window §8's 7-day clock starts ticking on.
3. Accept orphaned objects until RM-72 completes. Fails §8 outright; listed only to be
   rejected explicitly.

## (e) Contract §3 marks deletion Complete while the controls are inert

**The question.** Contract v2 §3's destination table has "Account deletion | Complete |
Recent authentication, confirmation, processing stop, store deletion, backup-expiry
ledger". The shipped surface (`webapp/app/(app)/settings/data/page.tsx`) renders "Export
everything" and "Delete account" disabled, with the reason beside them, citing exactly
this missing machinery. Which one is telling the truth?

**The evidence.** The whole of `tests/db/test_deletion_cascade.py` is the measurement:
no ledger table exists, no deletion RPC exists, the pseudonymization step is refused by
shipped triggers, storage is not reached, and the only delete that works is a raw
operator-lane `delete from auth.users` with the six behaviours the map above documents.
"Complete" describes the contract's destination, not anything a user can do; the page
is honest, the table cell is not.

**Options.**
1. **Amend the §3 cell to "Contracted — controls shipped inert; #204 is the
   gap-closer", citing this file, until #204's T4 flow passes owner acceptance and
   rehearsal.** One-line honesty fix, keeps the destination scope. — **Recommended.**
2. Leave §3 as is, treating the column as destination-state only. Costless today, but
   the issue itself flags this as a known contradiction, and a table that reads
   "Complete" over inert controls is the exact drift pattern this directory's standards
   exist to prevent.
3. Descope deletion from the pilot contract. Contradicts §2's identity table and the
   privacy posture the pilot is being offered under; rejected.

## (f) Surfaced by the tests, not the spec: the invite row outlives the account

**The question.** Not in #204's list — the survivor sweep found it.
`public.allowed_emails` keeps the deleted user's email (it has no FK to anything), and
that row is what `handle_new_auth_user` reads at signup. After a deletion, the email is
retained PII in an operator-only table, and a same-email re-signup lands **instantly
active and `invited`** — founding, free forever — rather than pending.

**The evidence.** `test_what_survives_is_exactly_the_invite_row_and_the_storage_object`:
the email sweep finds exactly one surviving row, in `allowed_emails`. (Re-signup
creating a fresh identity is contract-permitted and already proven —
`handle_new_auth_user` refuses to merge identities — but nothing decides whether the
fresh identity should inherit the invite.)

**Options.**
1. **Deletion also deletes the `allowed_emails` row, recording in the ledger that the
   invite was consumed; re-inviting is an explicit operator act.** Least retained PII,
   and re-activation becomes a decision instead of a leftover. — **Recommended.**
2. Keep the row (the owner may want deleted founding users to be able to return
   frictionlessly). If ruled this way, §8's retention table needs a row saying so —
   today it retains this email by accident, not by decision.

---

Every recommendation above that changes shipped behaviour lands through #204's own
tiers (T3 migrations/RPCs, T4 assembled flow, owner acceptance and rehearsal). The
tests named here are the pins: each one that encodes a gap says in its docstring which
ruling revises it, so closing a gap without the ruling reads as a red test, not as
progress.
