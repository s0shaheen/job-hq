# Sheet sunset — Postgres becomes the system of record, for everyone

**Owner decision, 2026-07-27, verbatim intent:** the Google Sheet becomes obsolete by way of
the web app. Everyone — Salman included — runs on pg through the webapp. Nothing sheet-reliant
survives except file import/export. This doc is the map from here to there.

**The honest framing:** the sheet was never the product; it was the first durable, phone-
editable, zero-infra store the system could trust. Every "sheet feature" is really a system
capability that happens to live in a spreadsheet today. Sunsetting the sheet means giving each
capability a pg-native home — most already exist (migrations 0001–0011) — then cutting reads,
then writes, then the tabs themselves. Never a big bang: each phase leaves the system healthier
than it found it, and the sheet stays a read-only mirror until the day nothing reads it.

---

## 0. What the sheet does today, and where each job goes

| Sheet capability (tab) | Today | Pg-native home | Status |
|---|---|---|---|
| Discovery feed (Feed) | monitor writes rows | `postings` + `user_postings` | tables live; engine mirror exists (`monitor/pgmirror.py`) but is **off** (no SSM creds) |
| Pipeline (Pipeline) | join/promote write; humans edit | `applications` + notes + status lock (0010) | built by P8; engine doesn't write it yet |
| Company universe (Companies) | sweep reads; humans edit | `companies`/`user_companies` + review states (0008/0009) | built; `swept_companies` written, uncalled — **the decided bridge cutover** |
| Config knobs (Config) | phone-editable behavior | per-user settings (P10 Profile groundwork + a `settings` read for the engine) | partial — the engine half needs a read path |
| Heartbeats/watchdogs (Config rows) | digest flags stale beats | `channel_runs` — the health ledger 0001 already shaped for it, one appended row per lane per run (`core/beats.py`) | built (C1): snapshot/digest/pgdump beat there under the flag, and the digest holds each store to its cadence **separately** — neither may vouch for the other |
| Email events (Email Events) | Gmail Apps Script appends rows | an authenticated `/api/capture` endpoint writing pg | **built (C2)**: `public.email_events` + `capture_tokens` (0018), the endpoint, and `Code.gs` dual-writing (sheet first, POST second, local retry queue). Nothing READS the pg copy yet — the joiner still reads the tab |
| Quick Add (Quick Add) | pasted URLs | webapp add/paste (P7) + import (P9) | built |
| Scout tabs (Raza-*) | scout's workflow | webapp grid + import + his own user lane | built in pieces; his onboarding = a user onboarding |
| Digest (Digest tab + Apps Script mailer) | composed row, mailed at 7am | PHASE-DIGEST increments 3–6: the email IS the app (signed links), sent by the engine via an email API | **built (C3)**: `tracker.digest` composes HTML + text and sends over AWS SES (sandbox), with signed one-click links verified by the web app. Both mailers are switched (`HQ_DIGEST_EMAIL`, `DIGEST_EMAIL_SOURCE`) and the Digest tab's `sent_at` cell is the interlock. Unsubscribe headers and the preferences page (increment 6) are NOT built |
| Outbox (Outbox tab) | quiet-hours deferrals | pg table | trivial port once pg is the engine's store |
| Log/Health (Log, Health) | append-only audit + per-company fetch results | `events` (exists) + a `fetch_health` table | partial |
| Backups (selfheal CSV + S3 snapshots) | git + S3 copies of tabs | **pg_dump lanes** — resurrect `pgdump.yml` (git lane) + a Lambda pg_dump→S3 (provider-diverse lane) | pgdump.yml deleted-resurrectable by design |
| Schema self-repair (selfheal) | re-asserts tabs/headers | migrations ARE the schema; drift impossible by construction | replaced by the migration discipline |

## 1. Prerequisite zero: a production Postgres that actually exists

Everything above assumes a LIVE database. Today the webapp's migrations run against CI-fresh
Postgres and (likely) a demo store in any deployed build; the engine's pg mirror skips loudly
because `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are not in SSM. **Verify, then provision:**
Supabase project per `db/README.md`, apply 0001–00NN, secrets into SSM `/job-hq/` + Vercel env,
auth wired for the allowlist. Nothing else in this plan starts until a real `select 1` succeeds
from both the webapp and a Lambda bot. (~an hour, mostly dashboards; needs the operator for
account creation.)

## 2. The phases (each shippable, each reversible until D)

**A — Dual-write soak (engine → pg mirror ON).** Load the Supabase secrets into SSM; the
existing `pgmirror` starts mirroring Feed→postings on every sweep. Resurrect `pgdump.yml`
(one `git show` away) so the new store has its git backup lane from day one, and add the
Lambda pg_dump→S3 twin (same two-lane doctrine as the sheet backups; `PGDUMP_ENABLED=true`).
Sheet remains authoritative; pg fills with real data. *Exit test: row counts converge daily;
backups verified restorable.*

**B — Reads cutover.** The sweep's company list flips to `swept_companies` (the decided
bridge): approving in the grid now changes what gets pulled — the P7 UI copy finally becomes
fully true. The webapp reads real pg everywhere (retire demo-mode in production). Config
knobs the ENGINE needs get a pg `settings` read with the same validate-or-default discipline
as `core/config.py`. *Exit test: a company approved in the grid appears in the next sweep; a
dismissed one never returns.*

**C — Writes cutover (the real migration).** *C1 is built (`HQ_PG_WRITES`, unset = Phase A
unchanged; flip procedure and preconditions in `docs/RUNBOOK.md` § The store lane): the sweep's
mirror became the sweep's own write, `join` applies matches through 0015's
`hq_apply_email_event` under the 0010 lock — deciding against BOTH stores' status and claim, since
during dual-write the human edits the sheet and pg's `status_actor` is written only by the web
app — snapshot/digest beat into `channel_runs` with the digest holding each store to its cadence
separately, and `tracker.pgseed` seeds the sheet's Pipeline into `applications` (the drain for
applications older than the flag; events it cannot apply are recorded as `email.unapplied`).*
Engine writes pg first-class: discovery upserts
postings (mirror becomes the write, not the echo); `join` matches email events to
`applications` under the 0010 status lock; outbox/heartbeats/log move to their tables. *C2 is
built (migration 0018): the Gmail Apps Script POSTs each batch to `/api/capture` under a
per-user bearer token — kept as a SHA-256, minted/rotated/revoked from the SQL editor per
`docs/RUNBOOK.md` § The capture endpoint — and keeps a local retry queue in Script Properties.
It still appends to the tab FIRST and the tab is still what `join` reads; the pg copy has no
reader until the join lane flips. Two named remainders: nothing drains an event the queue
dropped into pg (the sheet has it, so this is a phase-D blocker rather than a live one), and
the endpoint rejects unknown fields, so the webapp deploys before the script does.*
*C3 is built: the engine composes AND sends the digest email. **The vendor is AWS SES, in sandbox
mode** — the account, the IAM role, the Terraform and the CloudWatch/SNS/ntfy alerting all exist
for the bots Lambda already, so SES costs one resource and one policy statement instead of a
vendor, a dashboard and a second API key; verified-recipient sandbox is the right shape for a
two-person system rather than a limitation to escape, and promotion is a later ops step. Signed
one-click links point back into the webapp, minted by `core/digest_links.py` and verified there,
pinned across the two languages by `tests/fixtures/digest-token.golden.json`. The merge flips
nothing: `HQ_DIGEST_EMAIL=engine` turns the engine's send on, `DIGEST_EMAIL_SOURCE=engine` turns
the Apps Script's off, the Digest tab's `sent_at` cell stops both mailing the same day, and the
script pages if it is off and nothing stamped. Order and rollback: `docs/RUNBOOK.md` § The digest
email lane. NOT built: unsubscribe headers and the per-type preferences page (increment 6).*
During C the sheet gets a one-way nightly EXPORT (pg→CSV→the same
git/S3 lanes) so the human-readable mirror never dies before its replacement is trusted.
*Exit test: two weeks of Gmail-capture→pipeline advances with zero sheet involvement.*

**Carried into D, from the C2 review:** `email_events`' text columns are bounded in
TypeScript (`webapp/lib/capture/schema.ts:TEXT_LIMITS`) and not in SQL, which is correct while
`hq_capture_email_events` is granted to `service_role` alone and `/api/capture` is its only
caller. **The day a second caller exists, the bounds move into the migration — and they belong
in `tests/unit/capture-parity.test.ts` at the same time**, at a multiple of the route's own
numbers. A store stricter than its route is the failure C-1 and m-2 both were: a row that
validates, travels, and comes back as a raw constraint name nobody reads.

**D — Decommission.** Freeze the sheet (final export archived in git + S3), retire the
sheet-writing halves of selfheal/snapshot and the `core/sheets` write path (the read path
stays for `tracker.migrate`-style imports), strip `hq.config.yaml`'s tab registry to history,
update SYSTEM.md/CLAUDE.md/RUNBOOK (the sysmap gate forces this), and the durability contract
gets rewritten for pg: **RLS + migrations + the status lock + two backup lanes are the new
contract** — same principles (fail loud, humans win, no silent writes), new substrate.

## 3. What gets SIMPLER (the payoff)

- One store, one write path, one schema discipline — no gid pinning, no header re-assertion,
  no SchemaAnomaly class, no self-heal, no Sheets quota arithmetic, no durability-contract
  gymnastics for human sorting.
- The Apps Script shrinks to a Gmail classifier with one HTTP POST (no Sheets bindings).
- Onboarding a user stops touching Google entirely: profile + auth row + lanes.
- The failure surface consolidates: pg down = one loud thing, not N tabs of partial truth.

## 4. What gets LOST, named honestly

- **Phone-editable-anything.** The sheet was an accidental admin UI; post-sunset, anything
  without a webapp surface needs one before its sheet crutch dies (Config knobs are the risk).
- **The scout's zero-training surface** — he onboards like any user, and that is a real
  conversation, not a migration.
- **Sheets version history** as a free restore line — replaced by pg_dump lanes, which must be
  TESTED restorable before D, not assumed.
- Google-native sharing/eyeballing. The export exists for exactly this.

## 5. Sequencing against the live roadmap

P10 (Profile) merges first — it IS the settings/onboarding groundwork this plan leans on.
Then: prerequisite-zero + Phase A (small, mostly ops) → row-167 policy fix rides along →
B → C (the big build, digest-email included) → D. The git-history purge (authorized) runs in
the gap after P10 merges, before Phase A branches. Multi-user (dad) onboards on B/C's spine —
his universe was never in the sheet to begin with.
