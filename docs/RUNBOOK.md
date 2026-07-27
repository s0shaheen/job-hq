# RUNBOOK — Job Search HQ operations

Every scheduled job pushes to the **ops ntfy topic** (`REDACTED-NTFY-TOPIC`) when it
fails. Silence means healthy. Triage is always the same three steps:

1. **Read the alert title — it tells you where the logs are.**
   - `[lambda] <job> failed` → the bots run on AWS Lambda (`infra/`). Logs:
     `aws logs tail /aws/lambda/job-hq-bots --since 30m` (or tap the push, which links to the
     log group). The body names the failing module; every entrypoint prints its real cause
     on stderr before exiting.
   - `HQ bots ALARM: job-hq-bots-*` → a CloudWatch alarm, i.e. a failure the bot couldn't
     report itself. See [A CloudWatch alarm fired](#a-cloudwatch-alarm-fired).
   - `[salman] <name> failed` → a GitHub Actions run (self-heal, resume, or a **Run a bot**
     dispatch — that one's title reads `[salman] Run a bot: <job> failed`). Open the run from
     the push.
2. Cross-check the sheet: **Log** tab (append-only audit of every bot action), **Health**
   tab (per-company fetch results), and the `heartbeat_*` rows in **Config**.
3. Fix per the matching section below, then re-run — all jobs are idempotent and safe to
   re-run, two ways:
   - Lambda: `aws lambda invoke --function-name job-hq-bots --payload '{"job":"tracker"}'
     --cli-binary-format raw-in-base64-out /tmp/out.json`
   - Actions: **Actions → "Run a bot" → Run workflow**, pick the `job` (optionally a `user`
     lane and `extra_args` like `--dry-run`). Same code and the repo secrets instead of SSM —
     the fallback when AWS itself is the problem, and the phone-only path. It runs the same
     module chain the Lambda would, because both read `JOBS` in `infra/app/handler.py`.
     Every "re-run X" below means this one workflow with that `job` selected.

---

## Healthy state (what "fine" looks like)

Heartbeats live in the Config tab as `heartbeat_<name>` rows (UTC). The digest flags any
heartbeat older than **2× its cadence**; a job that never ran shows "no heartbeat yet".

| Heartbeat | Written by | Cadence | Stale-flagged after |
|---|---|---|---|
| `heartbeat_capture` | Apps Script (Gmail) | 15 min trigger (cadence 1.5 h) | 3 h → **ops alert** from digest |
| `heartbeat_tracker` | `tracker.join` (5th of 6 in the chain; `outbox` runs after it and writes no beat of its own) | every 2 h | 4 h |
| `heartbeat_priority` | `monitor.priority` | retired — local runs only, no workflow | not watched |
| `heartbeat_monitor` | `monitor.run` | daily 07:00 CT | 48 h |
| `heartbeat_review` | `monitor.review` | daily 10:00 CT | 48 h |
| `heartbeat_cafe` | `monitor.wide --source cafe` | daily 08:30 CT | 48 h |
| `heartbeat_theirstack` | `monitor.wide --source theirstack` | daily 08:50 CT | 48 h |
| `heartbeat_simplify` | `tracker.simplify` | dispatch only (retired 2026-07-25) — **Run a bot**, `job = simplify` | not watched |
| `heartbeat_selfheal` | `tracker.selfheal` | nightly 03:23 CT (Actions) | 48 h → **ops alert** "HQ backups stale" |
| `heartbeat_snapshot` | `tracker.snapshot`, **git mode** | nightly 03:23 CT (Actions, → `snapshots/<user>/`) | 48 h → **ops alert** "HQ backups stale" |
| `heartbeat_snapshot_s3` | `tracker.snapshot`, **S3 mode** | nightly 03:53 CT (Lambda, → S3) | 48 h → **ops alert** "HQ backups stale" |
| `heartbeat_digest` | `tracker.digest` | daily 06:40 CT | (digest is the watchdog; its workflow alert covers it) |

Deliberate heartbeat gaps (so the watchdog can catch real death): `priority` is unscheduled and unwatched; the old note below applies only if it is re-scheduled — `priority` skips its
heartbeat when *every* company fetch failed; `wide` skips it when no source swept;
`simplify` skips it on auth failure. A clean "not activated / disabled" skip DOES
heartbeat — pre-activation silence is healthy, failure is not.

**The backup heartbeats page, they don't just print.** `heartbeat_snapshot_s3` is written by the
Lambda `snapshot` job (03:53 CT) after every tab CSV lands in S3, so it stays fresh even when
GitHub Actions is dead entirely — the 2026-07-24 billing lapse ran 21 h with no backup and no
alert. If any of the three goes past 2× its cadence (or was never written), the daily digest
ops-pushes **"HQ backups stale"** naming the dead lane; the briefing line alone was too quiet for
a failure you discover on restore day.

**One heartbeat per lane, and that is load-bearing.** `tracker.snapshot` is the same module in
both places, but it writes `heartbeat_snapshot` in git mode and `heartbeat_snapshot_s3` in S3 mode
(chosen by whether `HQ_BACKUP_S3_BUCKET` is set). If they shared one beat, the nightly Actions run
would keep it fresh while the S3 copy had been dead for a week, and the digest would report
"backed up" — the same silent death, one layer up. So the alert names the copy: **`snapshot` = the
git/Actions copy, `snapshot_s3` = the S3/Lambda copy.** Confirm the named one before calling it
fixed (`git log -- snapshots/hq/` for git, `aws s3api list-object-versions` for S3), and note that
running the Actions self-heal by hand refreshes only the git pair.

Until the Lambda lane's first run, `heartbeat_snapshot_s3` has no value and the digest pages
"no heartbeat yet" — correct, not a false alarm: there is no S3 copy yet. It clears on the first
successful `snapshot` invocation.

Daily rhythm (America/Chicago): 03:23 self-heal + snapshot commit (Actions) → 03:53 snapshot → S3
(Lambda) → 06:40 digest composed → ~7:00 digest email (Apps Script) → 07:00 daily monitor sweep →
08:30 + 08:50 wide sweeps → 10:00 tagging review → 18:00 second sweep → tracker chain every 2 h at
:31 → Gmail capture every 15 min around the clock. Everything except the self-heal commit fires
from AWS EventBridge. (The 04:53 PG snapshot is gone — see
[PG snapshot](#pg-snapshot-deleted-resurrectable).)

Also healthy: the digest's "Automation health" section printing
`✅ all systems ran on schedule`, a fresh `chore: nightly HQ snapshot` commit each night, and
both CloudWatch alarms sitting in `OK`:

```sh
aws cloudwatch describe-alarms --alarm-name-prefix job-hq-bots \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output text
```

---

## A CloudWatch alarm fired

Two alarms watch the bots' Lambda; both also push again when they clear (`HQ bots recovered:`).
They exist for failures a bot cannot report about itself — see `infra/README.md § Ops alerting`.

**`job-hq-bots-errors`** — an invocation errored in the last 5 minutes.

- You will usually get the `[lambda] <job> failed` push *too*, which names the job and module —
  triage that per the section below. The alarm alone (no per-job push) is the interesting case: it
  means the handler never reached its except block. Causes: the 900 s **timeout** (look for
  `Task timed out`), an **OOM** kill (`Runtime exited`), a **broken image** or import error after a
  bad build, or a dead SSM secret store (`could not load secrets from SSM`).
- Look: `aws logs tail /aws/lambda/job-hq-bots --since 30m --filter-pattern '?ERROR ?Task ?Runtime'`
- Fix the cause, re-invoke that job by hand (intro, step 3), and confirm the recovery push. The
  alarm stays red until a *successful* invocation publishes a clean datapoint — Lambda emits no
  metrics while idle — so left alone it clears on the next scheduled run, not 5 minutes later.
- Rolling back a bad image: rebuild from a known-good commit and `aws lambda
  update-function-code --function-name job-hq-bots --image-uri "$ECR:latest"` (per `infra/README.md`).

**`job-hq-bots-silent`** — zero invocations in 3 hours, i.e. the schedules stopped firing. Nothing
ran, so nothing failed loudly; this is the alarm that exists because "six days of dead runs never
paged anyone" once happened on Actions.

- Check the schedules exist and are ENABLED: `aws scheduler list-schedules --name-prefix job-hq`
- Then the scheduler role (`job-hq-scheduler`) and the function itself
  (`aws lambda get-function --function-name job-hq-bots`).
- If AWS is the problem and the sheet needs work now: **Actions → "Run a bot"** with the job you
  need — the workflow and the repo secrets exist for exactly this.
- Terraform is the repair tool: `cd infra/terraform && terraform plan` shows anything drifted or
  deleted, and `apply` re-creates it.

## Monitor run failed

**Symptom:** ops push "Job monitor failed" / stderr `[monitor] FAILED`; no new Feed rows in
the morning; `heartbeat_monitor` stale.

**Causes, most likely first:**
- `SchemaAnomaly` — see [SchemaAnomaly](#schemaanomaly--schema-anomaly-abort). The message
  names the exact tab/header/keys. No writes happened.
- Google auth: `GOOGLE_SERVICE_ACCOUNT_JSON` secret invalid, or the sheet lost its share to
  the service account (email in `hq.config.yaml`). Re-share as Editor.
- Sheets API quota/5xx storm (rare at this scale; the backoff client absorbs normal blips).
- `[monitor] SKIPPED — HQ sheet_id is unset` — registry never pinned; run Actions → CI → Run
  workflow with `bootstrap: true` (the old `bootstrap.yml` folded into CI as a gated job).

**Not a failure:** individual company errors. One company can never kill the run — it is
quarantined as an ERROR row in Health and the sweep continues.

**Fix:** address the printed cause, re-run via **Run a bot** with `job = monitor`. Reconcile is
idempotent (keys dedupe), so a partial run followed by a full run is safe.

## Priority watch failed

**Retired, and now unreachable from any workflow.** `monitor.priority` has no cron (since
2026-07-21 the twice-daily sweep covers every company), no Lambda job, and — since the workflow
cleanup — no dispatch either. The module still works: `python -m monitor.priority` locally. Keep
this section only because an old alert can still be in your history.

**Symptom:** either ops push "Priority watch failed" (crash) or "Priority watch: every
company failed" (all fetches errored). `heartbeat_priority` goes stale in the second case
too — that is deliberate, and nothing watches it now.

**Causes:** every-company failure usually means network/bot-wall trouble from datacenter egress
(Azure IPs) or an expired Google credential; a single company erroring repeatedly is that
company's adapter/slug (check Log tab, `priority / fetch_error` rows).

**Fix:** for systemic failure, check one company's board URL by hand and re-run locally. For one
company, treat as [ERROR in Health](#a-company-shows-error-or-zero-in-health). Priority
skips not-yet-seeded companies by design (`skip_unseeded` in Log) — the daily monitor seeds
them first; that is not an error.

## Tracker run failed

**Symptom:** ops push "Tracker run failed". The chain is `promote → quickadd → scout →
stale → join → outbox`, run in that order; the first module to fail stops the chain, and
`heartbeat_tracker` (written only by `join`) goes stale. `outbox` runs last and delivers
whatever quiet hours held back — a failure there leaves the beat healthy, so it reports
itself (`tracker/outbox failed`) rather than relying on the watchdog.

**Causes:**
- **Duplicate Quick Add URLs** — the same URL pasted twice makes rows unaddressable:
  `[quick_add] duplicate url rows [...]`. Delete the duplicate row(s).
- **Duplicate scout Job Links** — same shape: `[scout_jobs] duplicate Job Link rows [...]`.
  Remove the duplicate row(s) (keep the one with the Applied tick).
- **Duplicate Pipeline keys** — someone copy-pasted a whole row: `duplicate keys: [...]`.
  Delete or re-key the copy.
- Header damage on any tab in the chain → [SchemaAnomaly](#schemaanomaly--schema-anomaly-abort).

**Fix:** remove the duplicates / repair the header named in the message, re-run via **Run a bot**
with `job = tracker`. Everything downstream (a Quick Add row stuck blank, an unsynced scout row) self-processes on
the next successful pass — latches (`· status`, `· synced_at`, `promoted_at`, `matched_key`)
mean nothing is double-processed.

Note: a Quick Add row whose `· status` says `error: ...` stays failed on purpose (dead URL,
no retry loop). Clear the `· status` cell to make the bot retry that row.

## A push arrived late (or the Outbox tab has rows in it)

Not a failure. A non-urgent push raised inside a user's quiet hours
(`notify_quiet_hours`, default `21:00-06:30` local) is **deferred, never dropped**: it lands
in the bot-owned **Outbox** tab with the wake time the policy computed, and the next
`tracker` chain run past that time delivers it. So a sweep at 22:00 buzzes the phone on the
first flush after 06:30, which on the `:31` cadence is 07:31 CT. An OA or interview invite
ignores quiet hours entirely and goes out at once.

Read the row, not the silence — every outcome is written down:

| `outcome` | Meaning |
|---|---|
| blank, `delivered_at` blank | still queued; `deliver_after` says when |
| `sent` | delivered by the flush |
| `dropped: …` | the user's channel changed before delivery (they moved to email, or turned that event off); their newer answer won |
| `requeued: deferred again at delivery …` | the policy said "still quiet" at delivery time; a NEW row with a later wake time carries the notification, and this one closes |
| `abandoned after N failed sends` | the wire (or an unset topic) refused it N times — also ops-pushed as **HQ outbox row abandoned** |
| `abandoned after N attempts: …quiet hours…` | it never left the window; same ops push |

An abandoned notification is the one case where a row is closed and nothing was sent. Its
ops push repeats the notification's own title and body, because `monitor.run` marks the Feed
rows `pushed_at` when a push is **queued** — those rows will not be re-pushed, so that alert
is the last place the roles are named. Act on it from the message or the Outbox row.

**"HQ outbox row failed" push:** one row could not be processed (usually a hand-edited
`attempts` cell). The rest of the batch went out; the row is untouched and retried next
flush. Fix the cell.

**"Outbox tab missing" warning in a tracker run:** expected only in the window between
shipping the tab and the first self-heal that creates it. Fix by running **Run a bot** with
`job = selfheal` (which also re-pins the gid); nothing is lost, because a queue write that
fails ops-pushes **HQ outbox write failed** rather than swallowing the notification.

**Turning quiet hours off:** Config tab, `notify_quiet_hours` = `off`.

**Why the tab is usually empty.** Only two events have a Python producer today: `digest`
(`tracker.digest`) and `new_roles` (`monitor.run`, `monitor.wide`, and `monitor.priority`,
which is retired to local runs — it is in no workflow and no `handler.JOBS` chain). The
other three knobs are reserved. Every one of the scheduled ones composes between
06:40 and 18:00 CT in daylight time — outside the default window — and the flush re-asks the
policy before delivering, so it cannot send inside the window either. The crons are fixed
UTC, so in **standard** time the digest composes at 05:40 CT and the morning sweep at 06:00
CT, both inside the window: from November those two defer and land on the 06:31 CT flush.

**The path quiet hours does not cover.** The Gmail capture Apps Script pushes OA / interview
/ recruiter / offer events itself (`appsscript/capture/Code.gs`, `jobsPush_`) on a 15-minute
trigger, without asking `core.channels` — no channel ceiling, no quiet hours. An OA at 3am
buzzes. For OA and interview that matches the policy (they are urgent and exempt anyway);
for recruiter and offer it does not. Known hole, closed when the Apps Script path moves
behind the same choke point.

**Who a mis-routed push reaches.** The live registry is flat (no `users:` map), so
`core.notify` resolves one jobs topic for everybody. A notification that escapes a user's
ceiling today lands on the **operator's** phone, not theirs — noise, not a leak. That
changes the day the registry grows per-user topics.

## Digest failed

**Symptom:** ops push "Digest failed"; no morning digest row/ping.

**Fix:** usual sheet triage (auth / SchemaAnomaly), re-run via **Run a bot** with
`job = digest` — same-day re-runs refresh the body and keep `sent_at`.

**Digest ran but no email arrived:** composing and mailing are separate. The Python job
writes the Digest tab row; the **Apps Script** `sendDigest` (7–8 am CT trigger) emails the
newest unsent row and stamps `sent_at`. If the row exists with blank `sent_at`, the script
side failed → script.google.com → HQ Email Capture → Executions.

## Wide sweep failed

**Symptom:** ops push "Wide sweep failed" — meaning **no source succeeded** (all
hiring.cafe term-runs failed AND TheirStack failed or is off).

**Not a failure:** `[wide] APIFY_TOKEN unset — wide layer not activated; skipping` is a
clean pre-activation skip (with heartbeat).

**Causes:** Apify free credit exhausted or token revoked; the actor
(`memo23/apify-hiring-cafe-scraper`) broken or renamed — it wraps an undocumented interface
that has broken before; hiring.cafe SSR payload change. Per-term failures land in Log as
`wide / cafe_error`; TheirStack problems as `wide / theirstack_error` (TheirStack is
optional and never fatal on its own).

**Fix:** check the Apify console (usage + actor run logs). If the actor is dead, swap
`ACTOR_ID` in `monitor/wide.py` for the alternate documented in
`docs/research/aggregator-apis.md`. Cursors (`wide_cursor`, `wide_theirstack_cursor` in
Config) are just optimizations — safe to blank; keys re-dedupe everything. Re-run one source at a
time via **Run a bot** with `job = wide_cafe` or `job = wide_theirstack` (separate jobs on
purpose: a stalled Apify run must never starve TheirStack).

## Simplify import failed

**Symptom:** ops push "Simplify auth expired" (at most once per day) and/or the digest
health line flags `simplify` stale. The run itself exits 0 on auth failure — the alert
and the missing heartbeat are the signal.

**Cause:** the session JWT died (undocumented TTL; expiry is the one expected fragility).

**Fix:** [Simplify re-auth](#simplify-re-auth) below. To turn the integration off instead,
set Config `simplify_enabled` = `false` (clean skip, heartbeat kept, no more alerts).

## Simplify re-auth

Takes ~2 minutes. Simplify has no export or API; the import uses the same private endpoint
its web app calls, authenticated by two of your own cookies.

1. In a desktop browser, log in at **simplify.jobs**.
2. Open DevTools (F12 / ⌥⌘I) → **Application** tab (Chrome) or **Storage** (Firefox) →
   **Cookies** → `https://simplify.jobs`.
3. Copy the **value** of the `authorization` cookie (a long JWT, `eyJ...`).
4. Copy the **value** of the `csrf` cookie.
5. Update the two repo secrets:

   ```sh
   gh secret set SIMPLIFY_AUTH_COOKIE --repo s0shaheen/job-hq   # paste the authorization JWT
   gh secret set SIMPLIFY_CSRF        --repo s0shaheen/job-hq   # paste the csrf value
   ```

6. Re-run: Actions → **"Run a bot"** → Run workflow with `job = simplify` (it runs
   `tracker.simplify` then `tracker.migrate --simplify-csv`, the same pair the old
   `simplify.yml` did). Success looks like `[simplify] saved_new=… filled=…` in the log and a
   fresh `heartbeat_simplify`.

Since 2026-07-25 this runs **only** when you dispatch it: the cron was retired rather than
re-created on Lambda, because babysitting a cookie that expires every few weeks buys nothing the
Gmail capture doesn't already file into Pipeline. Re-auth when you actually want a sweep. The
dedicated `simplify.yml` is gone (2026-07-25 workflow cleanup) but the job is not — it is one of
the choices in **Run a bot**, and `aws lambda invoke --payload '{"job":"simplify"}'` still works
if the cookies are also in SSM.

The daily-alert dedup key `simplify_alert_date` in Config resets itself; don't edit it.

## Self-heal failed

**Symptom:** ops push "Self-heal failed"; no nightly snapshot commit.

**Distinguish from:** ops push "HQ self-heal made repairs" — that is *success*, listing what
it fixed (recreated tab, re-appended header, re-pinned gids, restored protection). Read it,
confirm the repairs make sense, done.

**Causes:** service-account access lost; a **duplicate required header** it refuses to
auto-resolve (`duplicate required headers [...] — resolve manually`: a human created a
second column with a bot header's name — delete/rename the extra column); GitHub push
rejection on the snapshot commit (re-run).

**Fix:** repair in the sheet, re-run Actions → "Self-heal and snapshot" → Run workflow. That
workflow is the one that *commits* (schema re-assert + tab CSVs + re-pinned gids), so use it — not
**Run a bot** with `job = selfheal`, which re-asserts the schema but only commits `hq.config.yaml`
if a gid actually moved.

## PG snapshot (present, gated off)

`pgdump.yml` was deleted on 2026-07-25 with the rest of the migration scaffolding and
**resurrected in #72** (Phase A). This section said "deleted" until 2026-07-27; it was wrong, and
the file has been in the tree the whole time.

It runs nightly at `53 9 * * *` (~04:53 CT) **only when the `PGDUMP_ENABLED` repo variable is
`true`**, dumps `--schema=public` to `snapshots/pg/hq.sql.gz`, gates on a plausibility size check
plus `gzip -t`, commits, and — since Phase C1 — stamps the `pgdump` pg heartbeat as its last step
(`python -m tracker.beat pgdump`, after the commit, so a failed dump cannot vouch for itself).

**It needs `PGDUMP_ENABLED=true` before `HQ_PG_WRITES=first_class` goes to SSM.** Under
first_class the store is what the system depends on, and the digest pages **HQ backups stale**
naming `pgdump (pg)` for as long as the lane has never beaten. That page is the point: pg
load-bearing with no backup is the sheet's 2026-07-24 outage waiting to happen in the substrate
that replaced it.

**Secrets it needs:** `SUPABASE_DB_URL` (the dump), plus `SUPABASE_URL` /
`SUPABASE_SERVICE_KEY` / `HQ_PG_USER_ID` and the `HQ_PG_WRITES` variable (the heartbeat step —
without them the beat step is a silent no-op and the lane reads dead).

## The store lane (`HQ_PG_WRITES`)

The engine's Postgres writes are one operator-owned switch, in SSM as `/job-hq/HQ_PG_WRITES` and
as the `HQ_PG_WRITES` repo **variable** for the two Actions lanes (`selfheal.yml`'s snapshot step,
`pgdump.yml`'s beat step). It is not a Config-tab knob: the blast radius is "which store is
authoritative", not a per-user preference.

| Value | What the engine does |
|---|---|
| unset (default) | Phase A. The sheet is the system of record; `monitor.pgmirror` echoes the Feed as the monitor job's tail step; `join` writes the sheet only; heartbeats live in Config alone. A pg failure fails that tail step and nothing else. |
| `first_class` | Phase C. The sweep writes `postings`/`user_postings` itself and **fails** if it can't; `join` applies every email-event match to `applications` through the 0010 status lock; snapshot/digest beat in both stores and the digest watches both. The sheet is still written — dual-write runs until Phase D. |

Any other value **raises** on every bot. That is deliberate: `HQ_PG_WRITES=firstclass` quietly
running Phase A while everyone believes Phase C is live is the exact silent divergence the phase
exists to end.

### Before you set it to `first_class`

1. A real Supabase project exists and `db/apply.sh` has applied 0001–00NN (`db/README.md`).
2. `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `HQ_PG_USER_ID` are in SSM **and** in the repo secrets
   (the two Actions lanes above need them too).
3. **`PGDUMP_ENABLED=true`** — see the section above. pg must have a watched backup first.
4. Run the universe seed and the pipeline seed, in that order, and read their summaries:
   `aws lambda invoke --function-name job-hq-bots --payload '{"job":"seed_universe"}' /dev/stdout`
   then the same with `{"job":"seed_pipeline"}` (or **Run a bot** → `seed_pipeline`).
   `seed_pipeline` NAMES the Pipeline rows it could not seed — rows whose key matches no mirrored
   posting. Those have no pg twin and will stay that way; that is expected for pre-Feed rows and
   for the weak `norm-` keys the fuzzy matcher mints.
5. Only then set the flag. Rollback is setting it back to `mirror` (or deleting it) — nothing
   written under first_class has to be undone, because the sheet was written too.

### "HQ store lane skipped N event(s)"

A `::warning` from `tracker.join`: the sheet applied those emails and pg had no row to apply them
to. Each one is recorded pg-side, so the residue is queryable:

```sql
select payload->>'reason', payload->>'posting_key', payload->>'event_id', occurred_at
  from public.events
 where kind = 'email.unapplied' and user_id = '<HQ_PG_USER_ID>'
 order by occurred_at desc;
```

`no_application` means the seed has not been run (or has not been re-run since these applications
appeared) — run `seed_pipeline`. `no_posting` means the jobkey names nothing in `postings`: either
the sweep has not mirrored it yet (it will resolve itself) or the key is a weak `norm-` one that
never can (nothing to do; the sheet remains its only record).

The number not shrinking between runs is the signal. Nobody is paged for it — the sheet applied
the event, so nothing is lost — but a number that only grows means the two stores are drifting.

## Resume pipeline failed

**Symptom:** ops push "Resume pipeline failed" naming the commit. No new files in Drive.

**Causes, in gate order:**
- YAML parse error from a phone/raw edit — the Actions log shows rendercv's error.
- One-page gate: `Base resume rendered N pages — must be exactly 1` (or `make alt`'s same
  gate). Trim content; the cut order lives in CLAUDE.md's hard constraints.
- Drive upload: the Apps Script uploader retries 3×; persistent failure usually means the
  web-app deployment changed (see [token rotation](#rotating-the-resume-drive-upload-token))
  or the `APPSSCRIPT_UPLOAD_*` secrets are wrong.
- `Drive publish SKIPPED` notice = the two secrets aren't configured yet; render+gates still
  ran. That's pre-activation state, not an error.

**Blast radius:** none. Drive `Resume/Current/` keeps the last good publish; nothing is
overwritten until every gate passes. Fix the YAML, push again (or re-run the workflow).

## A company shows ERROR or ZERO in Health

The Health tab is a full snapshot per daily monitor run — one row per monitored company.

- **ERROR** = the fetch raised. Dead/renamed slug, an ATS migration (this is how you notice
  a Visa→Workday / Microsoft→Eightfold-style replatform), or a bot wall that only triggers
  from datacenter IPs. The `message` column carries the exception.
- **ZERO** = fetch OK but **zero roles survived the title filter**. Normal for small
  companies; suspicious as a long streak on a company that obviously has PM roles (can also
  mean a stale slug that returns an empty valid response).

**Fix:**
1. Open the company's careers page by hand; confirm the board still exists and note its URL.
2. For greenhouse/lever/ashby/smartrec, rediscover the slug:
   `python -m monitor.discover "Company Name"` — update the `slug` cell.
3. For workday/eightfold/oraclehcm/google/apple/goldman/radancy/amazon, check the adapter
   notes in `docs/research/bigtech-ats.md`; verify from a runner with Actions → CI → Run
   workflow → `smoke` (runs `monitor.scripts.smoke_adapters` from datacenter egress).
4. Meanwhile the wide layer still catches that company's postings (hiring.cafe indexes the
   big boards) — coverage degrades, it doesn't disappear.
5. Dead company / don't care: set `monitor` = `FALSE` on its Companies row. Never delete
   the row — history stays.

## Gmail capture went silent

**Symptom:** ops push "Gmail capture silent — heartbeat_capture older than 3h" (the digest
is the watchdog), or Email Events stops growing while applications are clearly landing.

**Causes:** the time trigger was deleted/disabled; a script edit broke it (triggers run the
**latest saved code** — a bad save takes effect immediately, no deploy step); Google paused
the grant (rare; password changes do NOT kill it); Apps Script quota (won't happen at this
volume — <5% of budget).

**Fix:**
1. As `shaheensalmant@gmail.com`, open script.google.com → **HQ Email Capture** →
   **Executions**: read the newest error. Google also emails the owner on trigger failures
   (crashes rethrow on purpose so that channel fires).
2. **Triggers** page: `runCapture` (every 15 min) + `sendDigest` (daily 7–8 am) must both
   exist. Missing → run `setupTriggers` once from the editor.
3. If a tab was recreated (self-heal repair alert), re-pin the gid constants in the CONFIG
   block (`EMAIL_EVENTS_GID` / `CONFIG_GID` / `DIGEST_GID`) from `hq.config.yaml: tabs`.
4. Verify: within 15 min, `heartbeat_capture` in Config updates.

Missed mail during the outage is NOT lost: capture scans `newer_than:3d` minus the
`hq/processed` label, so up to 3 days backfills itself. Longer outage: run `backfill90`
from the script editor (idempotent — the label is the cursor).

## SchemaAnomaly / schema anomaly abort

**What it means:** the sheet stopped matching `core/schema.py` in a way the bots refuse to
guess about, so the run **aborted before writing anything**. That is the design: a skipped
run is recoverable, a guessed write is corruption.

**The three shapes (the alert names the exact one):**
- `missing header 'x'` / `duplicate header 'x'` — someone deleted, renamed, or duplicated a
  required column header in row 1.
- `duplicate keys: [...]` — two rows share a value in the tab's key column (`key`,
  `event_id`, Quick Add `url`, scout `Job Link`), so rows can't be addressed unambiguously.
- `no column for [...]` — code wants a column the tab doesn't have (schema drift; run
  self-heal, which appends missing bot headers).

**Fix:** repair exactly what the message names — restore/rename the header cell, delete the
duplicate row(s) — then re-run the failed job (**Run a bot**, or `aws lambda invoke`; intro step
3). Self-heal re-asserts the full structure
(headers, frozen row, dropdowns, checkboxes, protections, gids) every night at 03:23 CT and can be
dispatched immediately: Actions → "Self-heal and snapshot". Header row 1 is protected and frozen
precisely to make this rare.

### Deploying a release that adds a required column

**Run self-heal FIRST, before the release is live — do not wait for the cron.**

A new entry in `core.schema.HEADERS` is a REQUIRED header the moment the code ships, and
`header_map()` refuses to guess: from the deploy until self-heal appends the column, every
read and write on that tab raises `SchemaAnomaly` and aborts with zero writes. That is the
durability contract working exactly as designed — nothing is corrupted, and nothing runs
either. On the Pipeline tab that means `promote`, `quickadd`, `scout`, `stale` and `join` all
stop, so a full working day of email-driven status updates can be missed if the deploy lands
in the morning.

    Actions → "Self-heal and snapshot"        # or:
    aws lambda invoke --function-name job-hq-bots --payload '{"job":"selfheal"}' /dev/stderr

Then re-run the affected chain (**Run a bot**, `job = tracker`) so the skipped cycle catches
up. Releases known to need this:

| Release | Column added | Tab |
|---|---|---|
| P8 pipeline (`0010_pipeline.sql`) | `status_actor` | Pipeline |

Check it landed before declaring the deploy done: the header exists in row 1, and a `tracker`
run completes without a `SchemaAnomaly` push.

## Restoring the sheet after a bad human edit

Three independent layers; use whichever fits the damage. Layers 1 and 2 are the same CSVs written
by two different jobs on two different schedulers, on purpose — GitHub going dark takes out layer
1 only.

**Layer 1 — nightly CSV snapshots in git** (`snapshots/hq/<tab>.csv`, committed 03:23 CT by
the self-heal workflow; liveness = `heartbeat_snapshot`):

```sh
git log --oneline -- snapshots/hq/          # find the last good night
git show <sha>:snapshots/hq/pipeline.csv > /tmp/pipeline.csv
```

Then in Sheets: File → Import → Upload → *Insert new sheet(s)* → copy the good rows back
over the damaged range (or replace the tab's contents wholesale if the whole tab is toast).
Diff first when unsure: `git diff <sha> -- snapshots/hq/pipeline.csv`.

**Layer 2 — versioned CSVs in S3** (`s3://job-hq-backups-690340855657/snapshots/<user>/<tab>.csv`,
written 03:53 CT by the Lambda `snapshot` job; `<user>` is `hq` on the single-user registry;
liveness = `heartbeat_snapshot_s3`). The
keys are stable and **bucket versioning is the history** — pick a version, not a filename. 90 days
of noncurrent versions are kept. The bots' IAM role is PutObject-only, so a restore is you, with
your own admin credentials:

```sh
B=job-hq-backups-690340855657
aws s3api list-object-versions --bucket "$B" --prefix snapshots/hq/pipeline.csv \
  --query 'Versions[].[LastModified,VersionId]' --output text    # newest first
aws s3api get-object --bucket "$B" --key snapshots/hq/pipeline.csv \
  --version-id <VersionId> /tmp/pipeline.csv
```

Then import into Sheets exactly as in layer 1. Use this when Actions has been down (no fresh
commit to restore from) or when the git copy itself is suspect.

**Layer 3 — Sheets version history** (File → Version history → See version history):
restores the whole spreadsheet to a point in time. Use for mass damage in the last hours
that the nightly snapshot hasn't seen.

**Afterwards, always:** run Actions → "Self-heal and snapshot" once. If a tab was deleted/recreated
its gid changed — self-heal re-pins `hq.config.yaml` and commits it; then update the gid
constants in the capture Apps Script CONFIG block if `email_events`/`config`/`digest` were
among them. Bots re-fill their own readout columns (`stale`, scout flags) on the next pass.

## Rotating the resume Drive-upload token

The uploader web app authenticates by a shared 256-bit token (Script Property in the
**HQ Drive Upload** project + GitHub secret). Rotate any time:

1. `openssl rand -hex 32`
2. script.google.com → HQ Drive Upload → Project Settings → **Script Properties** → set
   `UPLOAD_TOKEN` to the new value (properties are read at runtime — no redeploy needed for
   a property change).
3. `gh secret set APPSSCRIPT_UPLOAD_SECRET --repo s0shaheen/job-hq` → paste the same value.
4. Smoke-test per `appsscript/README.md` §2 step 5, or push any `resume/` commit.

**If you edited the web-app CODE:** Deploy → **Manage deployments** → ✏️ → Version: *New
version* → Deploy — this keeps the URL. A fresh "New deployment" mints a NEW `/exec` URL
and silently strands the `APPSSCRIPT_UPLOAD_URL` secret (update it if you did that).

## Editor shows a stale render (or won't publish)

**Status chip stuck / showing an old run:**
- Confirm a run actually started: repo → Actions → "Resume render & publish" for your
  commit. The workflow only fires on pushes to `main` touching `resume/**` — a publish to
  another branch renders nothing.
- The chip picks the workflow run matching `/render|resume|cv/i` on name/path. If that
  workflow was renamed away from those words, the chip falls back to the first run on the
  commit — rename it back or update `editor/`.
- PAT problems: the fine-grained PAT needs **Contents RW + Actions read** on the one repo.
  Revoked/expired → publishes fail with a GitHub API error; re-mint per `editor/README.md`.

**"Reload before publishing" (409):** the file changed on GitHub after the editor loaded it
(another session, a direct commit). Reload the editor, redo the edit. Nothing was written —
publishes are compare-and-swap on the blob sha, never forced.

**Locked out:** rotating `EDITOR_PASSCODE` in Vercel invalidates every session cookie at
once — that is the intended kill switch. Log in again with the new passcode.

## Adding / removing a monitored company

**Add:** one row in the **Companies** tab — `name`, `ats`, `slug`, `monitor` = `TRUE`.
Valid `ats` values: `greenhouse` · `ashby` · `lever` · `smartrec` · `workday` · `amazon` ·
`eightfold` · `oraclehcm` · `google` · `apple` · `goldman` · `radancy` (plus `apify` for
actor-backed one-offs). Slug unknown? `python -m monitor.discover "Company Name"` probes
the hosted-ATS families. The next daily run **seeds silently** (fills the board's current
roles with no pushes, flips `seeded` to TRUE); only genuinely new roles push after that.

**Priority tier:** set `priority` = `TRUE` → the hourly watch fetches it and pushes new
matching roles immediately, **no YoE gate**. Unseeded priority companies are skipped until
the daily sweep seeds them (prevents a first-run push storm).

**Remove:** set `monitor` = `FALSE`. Never delete rows — Feed history and dedup keys stay.

## Changing behavior (the Config tab)

Every knob is a `key / value / description` row, re-read fresh by every run and validated
per key. **An invalid value never breaks anything**: the run falls back to the committed
default (`core/config_defaults.yaml`) and pushes the problem to ops.

| Key | Default | Valid | Read by | Effect |
|---|---|---|---|---|
| `yoe_push_max` | 4 | int 0–30 | monitor, wide, digest | Push/list a new role when its min required YoE ≤ this |
| `stale_days` | 30 | int 3–365 | stale | Applied+ rows silent longer than this get the ⏳ flag + digest nudge |
| `titles_include` | PM titles + deployment strategist, forward deployed, product strategist, product operations, strategic projects | comma- or newline-separated | monitor, priority, wide | Title match list (substring, case-insensitive) |
| `titles_exclude` | product marketing, designer, analyst, program manager, pmm, intern… | same | monitor, priority, wide | Title veto list |
| `dna_companies` | Capital One, Discover, Bank of America, Citi | same | scout | Do-not-apply guard — flags (never blocks) matching companies on the scout tab |
| `workday_search` | `product` | non-empty string | monitor, priority | Search keyword sent to corpus-wide boards (Workday, Amazon, Eightfold, Oracle HCM, Google, Apple, Goldman, Radancy) |
| `push_new_jobs` | true | true/false | monitor, wide | Master switch for new-role pushes |
| `notify_digest` | both | push / email / both / none | every push (`core.channels`) | Where the daily briefing goes |
| `notify_new_roles` | push | same | monitor, priority, wide | Where newly discovered roles go |
| `notify_status_change` | push | same | *(reserved — no Python job pushes status changes yet; the Apps Script does)* | Where status advances go |
| `notify_oa_interview` | push | same | *(reserved — same Apps Script path)* | OA/interview invites. **Urgent: ignores quiet hours** |
| `notify_stale_nudge` | none | same | *(reserved — nudges ride the digest today)* | Follow-up nudges on silent applications |
| `simplify_enabled` | true | true/false | simplify | Daily Simplify sync on/off |
| `push_status_events` | true | true/false | *(reserved — no job acts on it yet; instant status pushes come from the Apps Script)* | — |
| `digest_hour_ct` | 7 | int 0–23 | *(reserved — compose time is the digest workflow cron, send time the Apps Script trigger)* | — |
| `ghost_suggest` | true | true/false | *(reserved — ghost-closing suggestions not implemented; `stale_days` flagging is live)* | — |
| `filter_countries` | United States | comma-separated | monitor, priority, wide, review | Geo gate: rows anchored elsewhere get `disposition=filtered` (invisible, recoverable). Remote rows with no stated country pass |
| `filter_geo_unknown` | filter | filter / keep | same | Rows whose location can't be placed: hide (`filter`) or let through (`keep`). Priority companies always get `keep` |
| `filter_yoe_max` | 4 | int 0–30 | same | Min required YoE above this → `filtered`. (`yoe_push_max` stays the tighter phone-push bar) |
| `filter_yoe_unknown` | seniority-proxy | seniority-proxy / keep | same | Tagged rows without a stated YoE: gate on the seniority tag, or keep |
| `filter_seniority_exclude` | Senior, Staff, GPM, Director, VP | comma-separated | same | Seniority tags treated as over-bar when YoE is unknown |
| `fetch_workers` | 8 | int 1–32 | monitor | Concurrent board fetches in the daily sweep (network only; sheet writes stay serial) |
| `run_budget_min` | 30 | int 5–120 | monitor | Soft wall-clock budget; a budget-stopped sweep flushes, parks a resume cursor, and continues next run |
| `linkedin_backfill_budget` | 20 | int 0–50 | linkedin_backfill | Companies the LinkedIn-id backfill probes per run — one request and at most one credit each, so this is also the spend cap. **50 is the ceiling because TheirStack allows 50 requests/hour per key**, and because 400 probes at 6.5 s pacing is 43 min against Lambda's 900 s timeout. 0 = off. The free harvest inside `wide_theirstack` ignores it and costs nothing |

**The `notify_*` knobs refine, they never widen.** `notify_channel` in
`users/<name>/profile.yaml` is the per-person ceiling (`email` = never an ntfy push, `none`
= silence), so a `both`/`push` value above is clamped down for anyone who set one.
`core/channels.py` is the single enforcement point — reached through `core.notify.push`,
which is the only door to ntfy. Do not re-check a channel at a call site: two enforcement
points is how `monitor/wide.py` and `tracker/digest.py` ended up with none.

After changing any `filter_*` knob, re-stamp existing rows: Actions → **Run a bot** → Run
workflow with `job = review` (its chain is `monitor.regate` → `monitor.review`, so the re-gate is
no longer a separate checkbox), or `python -m monitor.regate` locally — `--dry-run` first prints
the would-be counts.

**Machine-maintained Config keys — never edit:** every `heartbeat_*`, `wide_cursor`,
`wide_theirstack_cursor`, `monitor_sweep_cursor`, `linkedin_backfill_cursor`,
`simplify_alert_date`, `capture_alert_date`. (Blanking a cursor is harmless — keys
re-dedupe — but pointless. Blanking `linkedin_backfill_cursor` restarts that walk from
the top of the universe, which costs credits re-probing companies already answered.)

**Capture watchdog:** `heartbeat_capture` is written by the Gmail Apps Script on every
successful capture run; `tracker/join` ops-alerts (once per day) when it is missing or
more than 48h stale — that alert means statuses are NOT auto-advancing and the capture script
needs re-deploying per `appsscript/README.md`.

Two thresholds that are code, not Config, by design: the Feed board-stale window (a role
missing from its board 14 days → Closed; `monitor/run.py STALE_DAYS`) and the inline-tag
cost cap per monitor run (60; env `MONITOR_INLINE_TAG_MAX`).

---

## Secrets inventory (GitHub repo secrets)

| Secret | Used by | Breakage mode |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | every sheet job | everything sheet-touching fails loudly |
| `ANTHROPIC_API_KEY` | monitor, priority, review, tracker (quickadd), wide | tagging/enrichment skips or degrades; discovery unaffected |
| `APPSSCRIPT_UPLOAD_URL` / `APPSSCRIPT_UPLOAD_SECRET` | resume publish | publish step skipped/fails; render gates still run |
| `SIMPLIFY_AUTH_COOKIE` / `SIMPLIFY_CSRF` | **Run a bot** `job = simplify` only (no cron anywhere) | expired = one ops push, clean exit 0; see [Simplify re-auth](#simplify-re-auth). Refresh them right before a dispatch, not on a schedule |
| `APIFY_TOKEN` | wide | unset = clean skip; the wide layer is off |
| `THEIRSTACK_API_KEY` | wide (optional) | second wide source off; never fatal |
| `SUPABASE_DB_URL` | **nothing** — its only reader was `pgdump.yml` | inert since the workflow was deleted ([PG snapshot](#pg-snapshot-deleted-resurrectable)). Leave it or delete it; either way nothing breaks until the workflow is restored |
| `HQ_NTFY_TOPIC` / `HQ_OPS_NTFY_TOPIC` | all (optional overrides) | unset = defaults from `hq.config.yaml` |

(The capture Apps Script keeps its own `ANTHROPIC_API_KEY` copy in Script Properties; the
editor keeps `EDITOR_PASSCODE` + `GITHUB_TOKEN` in Vercel env — neither is a repo secret.)

**Two stores since the Lambda cutover.** The scheduled bots read the same names from **AWS SSM
Parameter Store** under `/job-hq/` (SecureStrings, loaded into env per cold start); the GitHub
repo secrets above now serve CI, the resume pipeline, the self-heal workflow, and any bot you
dispatch through **Run a bot**. A rotated key has to be updated in **both** places, or the
dispatch fallback quietly runs with the stale one:

```sh
aws ssm put-parameter --name /job-hq/ANTHROPIC_API_KEY --type SecureString --overwrite --value 'sk-ant-…'
gh secret set ANTHROPIC_API_KEY --repo s0shaheen/job-hq
aws ssm get-parameters-by-path --path /job-hq/ --query 'Parameters[].Name' --output text   # inventory
```
