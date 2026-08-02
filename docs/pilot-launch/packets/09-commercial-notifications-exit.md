# Packet family 09 — Commercial seam, notifications, and exit

## Outcome

Founding users have honest free-forever access, product notifications are controllable,
and every user can archive and delete their account across all stores.

Plan/notification contracts may begin after identity and shared UI stabilize. The final
archive and deletion packets MUST wait for every data-producing packet, including
Autopilot executor/receipts and warm-introduction/funnel storage.

## Atomic packets

### PKT-09A Plans and usage

Canonical plan/capability/usage model with `founding_free` uncapped all-access behavior.
Unknown state denies. Usage reads and limit moments share authoritative counters. No
false paywall.

### PKT-09B Stripe hosted paths

Checkout session, customer portal, signature-verified webhook, event replay defense,
customer/plan mapping, audit, test mode, and safe secret handling. Define cancellation,
downgrade, grace, failed payment, refund, invoice, and tax states before charging.

### PKT-09C Notification preferences

Typed in-app/email preferences, quiet hours, sender/reply-to, unsubscribe, bounce/
suppression, rate limits, dedupe, and signed action-link expiry/replay/revocation.
Gmail mailbox connection is not involved.

Classify separately:

- mandatory security/authentication email: verification, recovery, security change;
- operational account email: export, deletion, incident;
- opted-in product email: role alerts, digest, Autopilot and referral reminders; and
- provider transaction evidence already shown in-app.

Unsubscribe applies to product email without disabling required security/account email.
CAN-SPAM and provider suppression rules are acceptance inputs, not only footer copy.

### PKT-09D Templates

Design-exact verification/recovery, role alert, digest, Autopilot review, submission
confirmed/unknown/failed, referral follow-up, and operational-user message. No sensitive
answer/resume/note content appears unnecessarily.

### PKT-09E Full archive

Manifest and checksums for profile/settings/plan, jobs/decisions/views, applications/
notes/activity, answers/stages/receipts, resumes/artifacts, companies/connections/
referrals, imports, and audit inventory. Formula-injection and large-export behavior are
tested.

### PKT-09F Account deletion

Recent authentication, typed confirmation, immediate processing stop, session/token/job/
notification/submission revocation, active-store deletion, provider cleanup, backup
deletion ledger, progress/status, completion record, and error recovery.

“Provider cleanup” means revoking Job HQ credentials/tokens and deleting eligible local
provider copies. Job HQ cannot recall or delete an application already transmitted to
an employer/ATS; that irreversibility is disclosed before submit and delete.

## Acceptance

Founding user never enters checkout from ordinary use; webhook replay causes one logical
change; unsubscribe is effective before the next eligible send; archive is complete and
readable; restored older backup cannot reactivate deleted processing; operator cannot
silently inspect archive contents.
