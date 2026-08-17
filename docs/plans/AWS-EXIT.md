# AWS exit, per lane — the checklist for the day a lane needs changing anyway

> **Do not migrate a working bot that needs nothing.** Nothing in this file is a backlog,
> a milestone, or a queue. Every row is a checklist for the day a lane needs real changes
> anyway, so that whoever is already in that file knows whether to patch it in place or
> move it — without re-deriving the whole topology first. A lane that runs, alerts, and
> has not been touched in months stays exactly where it is. **Backups never move at all.**

The standing rule is one sentence: when a Lambda bot next needs real work, prefer moving
it to the Supabase side over patching it in place. One sentence is not enough to act on at
the moment it applies, because the moment it applies is the moment you discover the lane
depends on five things AWS supplies for free. This file is those five things, per lane.

Facts below were re-verified against the tree on **2026-08-16**. Where a citation and this
document disagree, the code wins and this document is the defect.

---

## 1. The destination does not exist yet

This is the finding that shapes everything else, and it is worth re-running rather than
believing. Every search below returned nothing on 2026-08-16:

| Claim | How it was checked | Result |
|---|---|---|
| No `pg_cron` anywhere | `grep -rniE 'pg_cron\|pgmq\|pg_net' --include=*.sql --include=*.ts --include=*.py --include=*.toml .` | no hits |
| No `pgmq` | same grep | no hits |
| No `pg_net` | same grep | no hits |
| No extension has ever been created | `grep -rniE 'create +extension' db/migrations/` over all **38** tracked migrations (`git ls-files db/migrations \| wc -l`) | no hits |
| No Edge Functions | `find . -type d -name functions -not -path '*/node_modules/*'` | no hits |
| Nothing tracked under `supabase/` | `git ls-files supabase` | empty; the directory does not exist locally either, and `.gitignore:84` ignores only `supabase/.temp/` (CLI machine state) |
| No `supabase/config.toml` | `find . -name config.toml` | no hits |

Migrations are applied by `db/apply.sh` against its own `public.schema_migrations` ledger,
through the dispatch-gated `db-apply` workflow — **not** by the Supabase CLI. There is no
`supabase init` in this repo's history.

**Therefore the first lane to move pays for the entire platform**: the first
`create extension` migration this repo has ever had, a decision about whether cron job
rows belong in the append-only ledger or out of band, a deploy path for Edge Functions, a
secret home, an alert re-home, and a `bot_runs` writer that is not `handler.py`. Every
lane after it is comparatively cheap.

That is the real economics of "opportunistic", and it inverts the usual instinct: **choose
the first mover by cheapness, not by urgency.** The lane that most wants to move is the
worst one to prove a platform on.

---

## 2. What a migrated lane silently loses

Three capabilities. AWS supplies all three, the Supabase side supplies none of them today,
and a lane that leaves without re-homing all three does not fail loudly — it goes quiet,
which is strictly worse.

### 2.1 The secret store

`/job-hq/*` SSM SecureStrings, loaded once per cold start by `_load_secrets`
(`infra/app/handler.py:77-93`): `get_parameters_by_path`, `Recursive=True`,
`WithDecryption=True`, flattened **by basename** into `os.environ` via `setdefault` so a
real env var wins locally. It raises rather than continuing when the store is dead —
`raise RuntimeError(f"could not load secrets from SSM {prefix!r}: {e}")` — and it is called
*inside* `handler`'s `try`, so a dead secret store pages instead of looking like a quiet
night.

Reachable only from `aws_iam_role.lambda`'s inline `read-secrets` policy
(`infra/terraform/main.tf:101-106`: `ssm:GetParametersByPath`, `GetParameters`,
`GetParameter` on `arn:aws:ssm:…:parameter/job-hq/*`). **No pg_cron job and no Edge
Function can read it.** Undecided, and it must be decided before the first lane moves:
Supabase Vault, per-function secrets, or keeping SSM and fronting it.

Two second-order consequences of the basename flattening are load-bearing and easy to lose
in a move: a nested per-user copy of a flat parameter would collide on its basename and
resolve arbitrarily (which is why `_select_user` **pops** `HQ_PG_USER_ID` for a named
user, `handler.py:96-123`), and `setdefault` is what lets the same image run locally
against a `.env`.

### 2.2 The failure alert path — three layers, not one

| Layer | Where | Fires on | Names the job? |
|---|---|---|---|
| 1 | `_ops_alert`, `infra/app/handler.py:145-161` → `core.notify.ops_alert` | every raise or nonzero exit, **every** occurrence | **yes** — `[lambda] tracker (dad) failed` plus the failing module and the request id |
| 2 | `aws_cloudwatch_metric_alarm.bots_errors`, `infra/terraform/alerts.tf:107-121` | `Errors > 0` in any 5 min — timeout, OOM kill, broken image, unimportable module, dead SSM | no (one function runs every bot) |
| 2 | `aws_cloudwatch_metric_alarm.bots_silent`, `alerts.tf:127-141` | the schedules going silent altogether | no |
| 3 | SNS `job-hq-alerts` → `job-hq-alerter` (`alerts.tf:69-102`) → ntfy | delivery for layer 2 | — |

Layer 1 is the only layer that can name *which* bot died, precisely because one Lambda runs
them all. Layer 3's alerter is a separate stdlib-only zip function on purpose: it must work
on the days the bots' container image does not.

A migrated lane leaves all three at once. It leaves layer 1 by leaving `handler.py`; it
leaves layers 2 and 3 because both alarms are dimensioned on
`FunctionName = aws_lambda_function.bots.function_name`. `docs/SYSTEM.md` §3 carries the
generated topology.

### 2.3 Its `bot_runs` row

Written only by `_run_start` / `_run_finish` (`infra/app/handler.py:174-196` →
`core/runlog.py`). Both are double-guarded — `runlog` is already best-effort and the
wrapper catches even a broken import — so telemetry can never fail a job, and
`_run_finish` runs *before* the re-raise on the failure path, so a failed run is still
recorded with its error.

A lane that leaves `handler.py` stops writing its row.
`docs/plans/DIGEST-PG-SOURCES.md` §2 shows why that matters: `bot_runs` is the Postgres
answer for five of the nine heartbeats the digest's health section reads (`monitor`,
`review`, `tracker`, `wide_cafe`→`cafe`, `wide_theirstack`→`theirstack`), plus a sixth
partially (`snapshot`). And `bot_runs` is *better* evidence than a heartbeat cell, not
merely equivalent: a beat says "something wrote a timestamp", a row carries `ok` and
`finished_at`, so "ran and failed" stays distinguishable from "ran".

**`selfheal` is already the worked example of this exact failure shape.** It never reaches
`handler.py`, so it writes no `bot_runs` row, so its beat has no Postgres source at all
(`DIGEST-PG-SOURCES.md` §2, row `selfheal`: "**none.**"). Any migrated lane reproduces that
shape unless a `bot_runs` writer moves with it.

---

## 3. The coupling that bites first: `job-hq-bots-silent`

```
period              = 10800          # 3 hours
statistic           = "Sum"          # Invocations
threshold           = 1
comparison_operator = "LessThanThreshold"
treat_missing_data  = "breaching"    # no news is exactly the bad news
```
— `infra/terraform/alerts.tf:127-141`

The alarm asserts that **something** invokes `job-hq-bots` at least once every three hours.
Run the schedules against that window:

| Lane | Cron (UTC) | Max gap between invocations |
|---|---|---|
| `tracker` | `31 0/2 * * ?` | **2 h** ✅ the only lane inside the window |
| `monitor` | `0 12,23 * * ?` | 13 h |
| `wide_theirstack` | `50 13 * * ?` | 24 h |
| every other lane | daily | 24 h |

`tracker` is the *only* lane that beats the 3 h window, and the alarm's own description says
so: "No HQ bot ran in 3 h (the tracker chain should fire every 2 h)".

**Move `tracker` off the bots function without re-tuning that alarm and it pages forever** —
`treat_missing_data = "breaching"` means it does not merely stay silent, it actively fires
on every empty window. Nothing about the remaining seven lanes can satisfy a 3 h window;
the next-densest is `monitor` at twice a day.

So every row's checklist has to answer: *what does this lane's departure do to the remaining
invocation rate?* For seven of the eight the answer is "nothing that matters". For `tracker`
the answer is "it breaks the silence alarm outright, and re-tuning it is part of that
migration, not a follow-up."

There is no equivalent trap in `bots_errors`: `treat_missing_data = "notBreaching"` there,
so a quieter function is not a failing one. It has its own known behaviour worth carrying
forward — it stays red until the next *successful* invocation, because Lambda publishes no
metrics while idle.

---

## 4. The lane table

Eight lanes fire on EventBridge Scheduler — `infra/terraform/variables.tf:84-116`, one
`aws_scheduler_schedule.job` per key (`main.tf:180-196`), target `job-hq-bots`, payload
`{"job": "<key>"}` (plus `"user"` on a fan-out lane), `retry_policy.maximum_retry_attempts = 2`.
A ninth clock, `selfheal`, is the last GitHub Actions cron. `docs/plans/SHEET-INVENTORY.md`
§2 is the count of record: **nine lanes on two schedulers.**

| Lane | Cron (UTC) | Module chain | Supabase equivalent | Migration trigger | Verdict |
|---|---|---|---|---|---|
| `wide_cafe` | `30 13 * * ?` | `monitor.wide --source cafe` | Edge Function on a pg_cron trigger | `PgFeedStore` lands, plus a home for `Config[wide_cursor]` | **Cheapest move. First after the platform.** |
| `wide_theirstack` | `50 13 * * ?` | `monitor.wide --source theirstack` | same | same, plus a home for the **billing** cursor `Config[wide_theirstack_cursor]` | **Second.** Cheap, but the cursor is money |
| `review` | `0 15 * * ?` | `monitor.regate` → `monitor.review` | Edge Function; the drain-the-backlog shape maps onto a queue table | `PgFeedStore` lands **and** the secret home is settled (Anthropic key) | Move after the wides |
| `monitor` | `0 12,23 * * ?` | `monitor.run` → `monitor.pgmirror` | Edge Function on a pg_cron trigger — **not** pg_cron alone | `PgFeedStore` lands **and** a replacement exists for `HQ_RUNTIME_DEADLINE_TS` | Move late |
| `tracker` | `31 0/2 * * ?` | `tracker.promote` → `.quickadd` → `.scout` → `.stale` → `.join` → `.outbox` | Edge Function, or pg_cron for the pure-SQL parts; `outbox` is already queue-shaped | `PgFeedStore`, **plus `bots_silent` re-tuned**, plus a deliberate outbox flush cadence | Move late, and **never first** |
| `digest` | `40 11 * * ?` | `tracker.digest` | Edge Function, plus a new home for the SES send | The `sent_at` latch gets a real table | Move **last**. **T4** |
| `snapshot` | `53 8 * * ?` | `tracker.snapshot` | none, and none is wanted | nothing | **Do not migrate.** Retires with the Sheet |
| `pgdump` | `13 9 * * ?` | `tracker.pgdump` | none, and none is **acceptable** | nothing, ever | **Never moves.** §6 |
| `selfheal` | `23 8 * * *` (Actions, `selfheal.yml`) | `tracker.selfheal` + the CSV/registry commit | none — its product is a git commit | nothing | **Already off AWS.** Out of scope |

Dispatch-only entries — present in `handler.JOBS`, absent from `var.jobs`, therefore not
lanes and not on this exit path: `simplify`, `seed_universe`, `seed_pipeline`,
`linkedin_backfill`. They are recorded here only because `SHEET-INVENTORY.md` §2 names the
isolation gap they represent: they are reachable from the same Lambda as every scheduled
lane.

The résumé render Lambda (`infra/terraform/render.tf`) is **not** on this exit path either.
It has no schedule by design, it is the only compute in the system whose input is
user-authored, and its role can write CloudWatch Logs and nothing else. It is a second
function, not a ninth lane.

---

## 5. Per-lane checklists

Each row answers the same five questions: what it does, what would replace it, what would
trigger the move, what it depends on that AWS supplies, and the tier.

### `wide_cafe` — the cheapest move, and therefore the right first mover

**Does.** `monitor.wide --source cafe`: one whole-market safety-net sweep via the
`memo23/apify-hiring-cafe-scraper` Apify actor (hiring.cafe crawls 46 ATS families, which
is the coverage the self-hosted fetchers cannot reach economically). Filters titles,
dedupes on job keys, appends untagged Feed rows, sends **one** summary push for YoE-gated
matches.

**Equivalent.** Edge Function on a pg_cron trigger. Not pg_cron alone: it makes bounded
outbound HTTP to Apify.

**Trigger.** `PgFeedStore` lands *and* the lane needs real work anyway.

**AWS dependencies.** `APIFY_TOKEN` from SSM (absent it declines cleanly and logs
`APIFY_TOKEN unset — sweep not activated`, so a lost secret is *not* silent here); the
container image's `requests` pin; egress; the `bot_runs` row that answers the digest's
`cafe` beat. **No** `HQ_RUNTIME_DEADLINE_TS` dependency. **No** LLM call —
`monitor/wide.py` imports no Anthropic path at all; rows land `tagged_at=""` for the
nightly `review` pass to tag.

**Also needs a home for `Config[wide_cursor]`** (`monitor/wide.py:73`). Cheap: the module's
own docstring calls the cursor "belt+braces" — Feed/Pipeline key dedupe is the primary
incremental mechanism and undated items pass on keys alone. **Losing this cursor costs
nothing but a wider re-scan.** That is exactly what makes this lane the safest place to
prove a platform.

**Blast radius of a failed run.** One day of a safety-net sweep. Spend is an Apify
pay-per-result actor at ≈ $4.50/mo worst case, inside Apify's free $5/mo credit.

**Tier: T3** — the move needs the `create extension` migration and a new boundary.

### `wide_theirstack` — the same shape, but the cursor is money

**Does.** `monitor.wide --source theirstack`: the same sweep against TheirStack's
contractual API (`POST /v1/jobs/search`, Bearer auth), fenced to priority companies plus
title terms, budgeted by `Config[wide_credit_budget]`. It also runs `_harvest_linkedin`,
copying LinkedIn company ids and domains into the **Postgres** universe on rows the sweep
already bought — zero extra requests, zero extra credits.

**Equivalent.** Same as `wide_cafe`.

**Trigger.** Same as `wide_cafe`. Two lanes rather than one so the second proves the first
was a pattern and not a special case.

**AWS dependencies.** `THEIRSTACK_API_KEY` from SSM; egress; the `bot_runs` row behind the
digest's `theirstack` beat. No deadline signal, no LLM.

**The cursor is not belt-and-braces here.** `Config[wide_theirstack_cursor]` feeds
`discovered_at_gte` server-side, and the module says why in as many words: *"The cursor is
also what stops us re-buying yesterday's rows: billing is 1 credit per job RETURNED, and a
repeat pull is charged again"* (`monitor/wide.py:297-298`). Free tier is 200 credits/month.
**A migration that loses or resets this cursor spends real money on its first run.** Move
the cursor with the lane, or move `wide_cafe` first and let it prove the mechanism.

**Tier: T3.**

### `review` — queue-shaped, and the first *LLM* lane

**Does.** `monitor.regate` → `monitor.review`: re-apply the current filter knobs to every
Feed row, then drain the untagged-open backlog through the LLM tagger. It is the consumer
for what both wide lanes produce.

**Equivalent.** Edge Function. The drain-the-queue shape maps cleanly onto a queue table —
the closest thing this repo already has to that pattern is `notification_outbox`
(`db/migrations/20260803_105951_notification_outbox.sql`), drained by `tracker.outbox`.

**Trigger.** `PgFeedStore` lands. It spends Anthropic credits, so the secret home must be
settled first — though note it already degrades honestly without one:
`monitor/review.py:264-265` prints `ANTHROPIC_API_KEY not set — tagging pass skipped` and
continues. That is the correct behaviour and it must survive the move; a migrated lane that
silently skips tagging forever because a secret never arrived is the failure this whole
document is about.

**AWS dependencies.** `ANTHROPIC_API_KEY` from SSM; the `bot_runs` row behind the `review`
beat; the container image's pinned SDK.

**Tier: T3.**

### `monitor` — the largest, and the one that needs a Lambda primitive rebuilt

**Does.** `monitor.run` → `monitor.pgmirror`: sweep every monitored company's board, filter
titles, reconcile against Feed history, tag new roles, one push; then mirror the Feed into
`postings`/`user_postings`. Twice daily, and the second sweep is the whole reason the old
hourly priority watch could be retired.

**Equivalent.** Edge Function on a pg_cron trigger. **Not pg_cron alone** — it makes N
outbound board fetches plus an Anthropic call.

**Trigger.** `PgFeedStore` lands **and** the lane needs real work **and** there is a
replacement for `HQ_RUNTIME_DEADLINE_TS`.

**AWS dependencies, including the one that is a Lambda primitive.**
`_export_runtime_deadline` (`infra/app/handler.py:126-142`) publishes
`HQ_RUNTIME_DEADLINE_TS` from `context.get_remaining_time_in_millis()` minus a 60 s reserve,
and `monitor/run.py:97` reads it (`RUNTIME_DEADLINE_ENV`). The sweep's *own* budget is a
Config knob (`run_budget_min`) that knows nothing about the runtime's hard timeout; without
the deadline signal the sweep believes it has more time than it gets and is killed
mid-flight, losing the end-of-run flush, the feed snapshot and the heartbeat, instead of
taking the designed budget stop with its cursor parked. The 60 s reserve exists because
that stop itself needs time to flush.

**Any runtime this lane moves to must publish its own deadline in the same shape**, or the
budget stop stops working — and it stops working *silently*, in the direction of a
truncated sweep. `monitor/linkedin_backfill.py:160` reads the same variable, so the signal
has two consumers, not one.

**Tier: T3.**

### `tracker` — the lane the silence alarm is watching

**Does.** Six modules in one chain: `promote`, `quickadd`, `scout`, `stale`, `join`,
`outbox`. `outbox` is deliberately last because it delivers whatever quiet hours held back,
so **the chain's 2-hourly cadence *is* the notification flush cadence** (`core/outbox.py`,
and `handler.py:41` says so).

**Equivalent.** Edge Function, or pg_cron for the parts that are pure SQL. `outbox` is
already queue-shaped against `notification_outbox`.

**Trigger.** `PgFeedStore` **and** `job-hq-bots-silent` re-tuned **and** a deliberate
decision about the flush cadence.

**AWS dependencies.** Everything in §2, plus the two couplings above:

1. **The silence alarm.** See §3. This is the lane the alarm watches. Moving it without
   re-tuning `alerts.tf:127-141` produces a permanent page — not a missed alert, an
   unending one.
2. **The flush cadence is inherited, not chosen.** Moving `tracker` changes when
   notifications go out. That must be a decision somebody makes on purpose, not a side
   effect of a schedule landing on a different clock.

**Tier: T3** (T4 if the move changes outbox delivery semantics rather than just its host —
that is notifications).

### `digest` — last, because it mails a real person

**Does.** `tracker.digest`: compose the daily briefing from six tab reads plus nine lane
heartbeats, render it, send over SES v2, push, and stamp the `sent_at` latch.

**Equivalent.** Edge Function — plus a home for the SES send, which today rides the bots
execution role directly (`aws_iam_role_policy.send_email`, `infra/terraform/mail.tf:51-63`,
scoped to `ses:SendEmail` on exactly the identities Terraform verified, never `Resource = "*"`).
A migrated digest needs a mail path with an equally narrow grant, or it has quietly widened
send-as to every identity the account ever verifies.

**Trigger.** The `sent_at` latch gets a real table.
`docs/plans/DIGEST-PG-SOURCES.md` §4 is blunt about the stakes: *"today's design can send a
person two copies, and the proposed one can silently skip a day."* Both failure modes are
paid for by a human.

**AWS dependencies.** The SES identities and the send grant; `HQ_MAIL_SENDER` pinned by
Terraform to the verified sender (`main.tf`) so the engine cannot send from an address
nobody verified; `HQ_DIGEST_KEYS` and `HQ_WEBAPP_URL` from SSM (deliberately *not* in
Terraform state); and the health section's own reads, which is the recursive part — the
digest is the consumer of the `bot_runs` rows every other lane's migration threatens.

**Tier: T4.** Notifications, per CLAUDE.md: T3 gates plus owner acceptance and rehearsal.

---

## 6. `pgdump` never moves, and the reason is structural

This is not "not yet". It is not deferred, it is not blocked on the platform, and it does
not become cheap once the wides have proven the pattern. **The backup stays on AWS
permanently, by design.**

**Off-vendor is the entire point.** A backup of Supabase that is scheduled by Supabase,
executed by Supabase, and stored by Supabase is not a backup — it is a second copy inside
the failure domain it exists to survive. Every plausible Supabase-side "equivalent" is
therefore not an equivalent at all; it is the removal of the property the lane exists for.

What it writes to, and why widening it is a test failure (`infra/terraform/backups.tf`):

- `s3://job-hq-backups-690340855657/pgdump/public.sql.gz` — one object for the whole
  store, versioned (versioning *is* the history), AES256, all four public-access blocks on.
- Lifecycle: noncurrent versions expire at 90 days with a `newer_noncurrent_versions = 30`
  floor. The floor is the interesting half — age alone would mean "if this lane dies for
  90 days, delete every good copy and keep only the last bad one", which is the failure
  mode of a lane whose deaths are exactly what the backup exists to survive.
- The bots role holds `s3:PutObject` on exactly two prefixes (`snapshots/*`, `pgdump/*`)
  and **no** `GetObject`, **no** `DeleteObject`/`DeleteObjectVersion`, **no** `ListBucket`.
  A compromised bot can only add versions. `tests/infra/test_backups_terraform.py` fails if
  that grant widens.
- `auth` is deliberately excluded from the dump: identities, sessions and refresh tokens do
  not leave the database.

**The mechanism cannot follow even if the argument were ignored.** `infra/Dockerfile`
stage 1 builds PostgreSQL **17.6** `pg_dump` from pinned source (`PG_SHA256` checked with
`sha256sum --check --strict`, `--with-openssl` because PGSSLMODE=require on a non-SSL build
is a refusal) into `/opt/pg17/bin/pg_dump`. No packaged 17 exists on the Amazon Linux 2
Lambda base, PGDG publishes no EL7-compatible 17, and `pg_dump` **aborts** when the server
major exceeds the client's — the versioned path is the point, and PR #89 is the live
failure that proved it (postgresql-client-17 installed, `/usr/bin/pg_dump` still ran 16.14
via postgresql-common's cluster-resolving perl wrapper, dump aborted against the 17.6
server). `tracker/pgdump.py:60,66,121-143` re-checks the major at runtime and refuses below
17.

pg_cron cannot shell out to that binary. An Edge Function has neither the binary nor the
**2048 MB of ephemeral storage** the lane stages the compressed dump into
(`infra/terraform/main.tf:132`; Lambda's filesystem is read-only everywhere else, and the
default 512 MB would be a silent ceiling on how large the database may get before the
nightly backup starts failing).

**It is also the one lane the Sheet cutover does not unblock.** `SHEET-INVENTORY.md` §2:
every scheduled entrypoint except `pgdump` reaches a Sheet; `pgdump` is the one sheet-free
scheduled lane. There is nothing waiting on. It will never become "ready".

**Its Actions twin is not an alternative and never becomes one.**
`.github/workflows/pgdump.yml` is a deliberate `exit 1` tombstone under FP-OPS-001
(`docs/pilot-launch/instances/PKT-DUMP-DISABLE.md`); the `PGDUMP_ENABLED` repo variable is
intentionally ignored; `tests/core/test_dump_containment.py` statically rejects `pg_dump`
in any workflow run block; and `pgdump` is the one job deliberately **absent** from
`run-bot.yml`'s dispatch choice list, asserted by
`tests/test_runjob.py::test_the_dropdown_does_not_offer_it` and paired with
`test_the_database_dump_job_refuses_to_run_from_actions`, which exists because
`python scripts/runjob.py pgdump` is not the literal string `pg_dump` and would slip past
the containment check. No dump may enter git, and there is no manual Actions lane to fall
back to.

Operations, liveness beat and restore: `docs/RUNBOOK.md` § The store's backup.

## 6b. `snapshot` retires; `selfheal` already left

Neither migrates, and for opposite reasons.

**`snapshot`** (`tracker.snapshot`, `53 8 * * ?`) writes every HQ tab to CSV at
`s3://job-hq-backups-<account>/snapshots/<user>/<tab>.csv`. Its entire product is Google
Sheet tab CSVs. There is no Supabase equivalent because there is nothing left to snapshot
once the Sheet is gone: **it dies with the Sheet rather than moving** (`SHEET-INVENTORY.md`
§2 classes it `a, then c`). Until then it is load-bearing and paged — it exists because on
2026-07-24 an Actions billing lapse stopped every backup for 21 hours with no alert, and it
writes a *separate* heartbeat (`heartbeat_snapshot_s3`) from the Actions git copy
(`heartbeat_snapshot`) precisely so a dead S3 lane cannot hide behind a live git one.

**`selfheal`** (`23 8 * * *`, `.github/workflows/selfheal.yml`) re-asserts Sheet headers,
dropdowns, protections and gids, re-pins them into `hq.config.yaml`, exports the tabs, and
**commits** — to the `snapshots` branch, never `main`. It is already off AWS and was never
migrated to it: Lambda's `/var/task` is read-only, so both writes there would be silently
skipped, and a backup that silently does not happen is worse than no backup. The rule for
that split is stated in the file itself: *if a job's product is a git commit, it stays on
Actions.* It remains dispatchable by hand through `handler.JOBS`, which is why it appears
in the job registry at all.

`selfheal` is also this document's worked example of §2.3 — it never reaches `handler.py`,
so it writes no `bot_runs` row, so `DIGEST-PG-SOURCES.md` §2 records its Postgres answer as
"**none**". That is the exact shape every migrated lane inherits by default.

A tenth clock exists outside both schedulers: the Gmail Apps Script's own triggers
(`appsscript/capture/Code.gs:107-113 setupTriggers` — `runCapture` every 15 min,
`sendDigest` daily at 07:00 America/Chicago, and `onFeedEdit` as a spreadsheet on-edit
trigger). They run under Apps Script authorisation rather than the service
account, so they are neither AWS's nor Actions' to move, and `SHEET-INVENTORY.md` §2 already
calls them a separate decommission.

---

## 7. The order, and why it is that order

Nothing below is scheduled. The order is what to pick *if* something forces a move.

**0. The platform, proven on something that can fail harmlessly.** Not a lane migration:
the first `create extension` migration this repo has ever had; the decision about whether
cron job rows live in the append-only ledger or out of band; a deploy path for Edge
Functions (`supabase init` first — there is no `config.toml`); the secret home; the alert
re-home for all three layers; and a `bot_runs` writer that is not `handler.py`. **T3**, and
it is most of the total cost.

**1. `wide_cafe`, then `wide_theirstack`.** Bounded HTTP, one source each, idempotent on
job keys, no LLM, no deadline signal. A failed run costs one day of a safety-net sweep. Two
lanes rather than one so the second proves the first was a pattern and not a special case.

*Cafe first, TheirStack second* — the ordering is by cursor cost, not alphabet:
`Config[wide_cursor]` is belt-and-braces behind key dedupe and losing it costs a wider
re-scan, while `Config[wide_theirstack_cursor]` is the anti-double-spend guard on a
1-credit-per-row API with a 200-credit free tier. Prove the cursor mechanism on the lane
where getting it wrong is free.

**2. `review`.** Queue-shaped, and the first lane whose per-run spend is an LLM call. It is
also the consumer of what step 1 produces, so moving it after the wides keeps the
producer/consumer pair pointing at one store for the shortest possible window.

**3. `monitor`.** The largest, and the one that needs a budget signal built to replace a
Lambda primitive (§5, `HQ_RUNTIME_DEADLINE_TS`).

**4. `tracker`.** Only after `job-hq-bots-silent` is re-tuned, because it is the lane that
alarm is watching, and only with the outbox flush cadence decided deliberately rather than
inherited.

**5. `digest`.** Last, because it mails a real person and the failure modes are a double
send or a silent skip.

Every step except 0 is gated on `PgFeedStore`. The seam is already substitutable and that
is not a hope: `monitor/sheet.py:43` declares `SheetStore` as a **16-method** `Protocol`,
`HQFeedStore` (`:64`) is the Sheet implementation, `FakeSheetStore` (`:398`) is a second
implementation the tests already run against, and `monitor/run.py:128 run_monitor(store, …)`
is written entirely against the protocol.

## 8. Tiers

Recorded so a future agent does not have to re-derive them. Tier is set by what the change
CAN break, per CLAUDE.md.

| Tier | Applies to |
|---|---|
| **T1** | A lane whose migration only changes where the schedule fires, with no migration and no new boundary. **None of the nine qualifies today**, because none can move without the platform work in step 0. |
| **T3** | Every lane migration on this page. Each needs a migration — the `create extension` file, cron job rows in the ledger, the `sent_at` latch table, or a new grant. Independent security review plus real-boundary mutation proof. |
| **T4** | `digest`. It is notifications; the failure modes are mailing a person twice or silently skipping a day. Also `tracker` if the move changes outbox *delivery semantics* rather than only its host. |

Writing this checklist is T0. Almost nothing the checklist describes is.

---

## 9. What this document is not

- **Not a plan.** No lane here is scheduled to move, and a lane that runs and alerts stays
  put. If you arrived here without a lane already needing changes, the answer is "do
  nothing".
- **Not a source for `docs/SYSTEM.md`.** That file's schedule and backup tables are
  generated by `python scripts/sysmap.py` and `tests/test_sysmap.py` fails on drift. Run
  the generator; never hand-edit the blocks.
- **Not the Sheet cutover.** `docs/plans/SHEET-SUNSET.md` owns that, and it is the real
  precondition for most rows here. `SHEET-INVENTORY.md` is the fact table.
- **Not a justification for touching infrastructure.** Landing this document changed no
  Terraform, no handler, no workflow, and no schedule.
