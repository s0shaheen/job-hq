# HQ bots on AWS Lambda + EventBridge — setup runbook

This moves the **scheduled bots** (the live product) off GitHub Actions onto AWS Lambda, fired by
EventBridge Scheduler. One container image runs every bot; secrets live in SSM Parameter Store.
At this workload it sits comfortably in the **AWS always-free tier** (≈ pennies of ECR storage).

You run ~5 commands. Everything else is the code in this directory. I can't touch your AWS —
`terraform plan` validates everything before anything is created, so nothing here is destructive
until you approve a plan.

**Not migrated, on purpose:** the jobs whose *product is a git commit* — `selfheal.yml`
(schema re-assert + the re-pinned registry + commit) and `pgdump.yml`. Lambda's `/var/task` is
read-only, so both writes there are silently skipped, and a backup that silently doesn't happen is
worse than no backup. They stay on GitHub Actions until there's a sink for them (see Known gaps).
The sheet backup itself no longer waits on that: `snapshot` runs here and writes the tab CSVs to
the S3 bucket in `backups.tf`, so it survives GitHub being down (Actions billing lapse,
2026-07-24 — 21 h with no backup and no alert). Seven schedules live here: `monitor`, `review`,
`tracker`, `digest`, `snapshot`, `wide_cafe`, `wide_theirstack`.

---

## 0. Prerequisites (one-time, local)

Install: **AWS CLI v2**, **Terraform ≥ 1.6**, **Docker** (you already have it).

```sh
aws --version && terraform version && docker version
```

## 1. AWS account + credentials

If you don't have an AWS account, create one (free). Then make a CLI credential:

- Easiest: IAM Identity Center (SSO) → a permission set with `AdministratorAccess` for setup →
  `aws configure sso`. Or a classic IAM user with `AdministratorAccess` + an access key →
  `aws configure`. (Admin is for *setup only*; the bots themselves get a tiny least-privilege role.)

```sh
aws sts get-caller-identity      # should print your account id
export AWS_REGION=us-east-1       # match infra/terraform/variables.tf:region
```

## 2. Put your secrets into SSM Parameter Store

The bots read the same env vars they did under Actions — now sourced from `/job-hq/*`. GitHub
secrets can't be read back, so re-enter each value from where you first got it. Set the ones your
bots actually use (the JSON service account is required; the rest as applicable):

```sh
put() { aws ssm put-parameter --name "/job-hq/$1" --type SecureString --overwrite --value "$2"; }

put GOOGLE_SERVICE_ACCOUNT_JSON "$(cat /path/to/service-account.json)"   # required (all bots)
put ANTHROPIC_API_KEY        "sk-ant-..."
put THEIRSTACK_API_KEY       "..."
put APIFY_TOKEN              "apify_api_..."
put SIMPLIFY_AUTH_COOKIE     "..."
put SIMPLIFY_CSRF            "..."
put SUPABASE_URL            "https://xxxx.supabase.co"     # if the pg mirror runs
put SUPABASE_SERVICE_KEY    "..."
# ntfy topics your bots publish to (see core/notify.py / .env.example) — e.g.:
put MONITOR_OPS_NTFY_TOPIC   "salman-hq-ops-..."
```

(SSM SecureString handles the ~2 KB service-account JSON fine. `--overwrite` makes re-runs idempotent.)

## 3. Create the image registry (Terraform, step 1 of 2)

The Lambda is built *from* an image, so the ECR repo must exist before we can push. Create just it:

```sh
cd infra/terraform
terraform init
terraform apply -target=aws_ecr_repository.bots      # review the plan, type yes
terraform output -raw ecr_repository_url             # note this URL
```

## 4. Build + push the container image — `infra/deploy.sh`

One script, from anywhere in the repo. **The image tag is the git SHA that built it:**

```sh
infra/deploy.sh            # build linux/amd64 -> push ${ECR}:<sha> + ${ECR}:latest -> pin the Lambda to <sha>
infra/deploy.sh --dirty    # emergency only: ships uncommitted tracked files as <sha>-dirty
```

It refuses a dirty tree (a tag that lies is worse than no tag) and refuses an AWS account that
isn't the deployed one — a wrong `AWS_PROFILE` otherwise "succeeds" into an account where
nothing runs the image. On **this first run the function doesn't exist yet**: the script pushes
the image, says so, and exits 0; step 5 creates the function from `:latest`. Every later run
pins the function to `:<sha>`, waits for the update, and prints the rollback line:

```sh
aws lambda update-function-code --function-name job-hq-bots --image-uri "${ECR}:<older-sha>"
```

`:latest` is still pushed, but only as a human convenience pointer — nothing deploys from it, and
Terraform ignores `image_uri` entirely (`lifecycle.ignore_changes` in `main.tf`) so an apply can
never roll the running code back to it.

(`--platform linux/amd64` matters on an Apple-silicon Mac — Lambda runs x86 here, and a wrong-arch
image fails at first *invocation*, not at push. If you type any of this by hand, keep the braces:
in **zsh** `"$ECR:latest"` parses as the `:l` lowercase modifier plus "atest", and you push to a
repo named `job-hq-botsatest`.)

## 5. Create everything else (Terraform, step 2 of 2)

```sh
cd infra/terraform
terraform apply     # the Lambda, IAM roles, the S3 backup bucket (backups.tf),
                    # 7 schedules x users, and the alerting stack (alerts.tf)
```

## 6. Smoke-test one bot before trusting the schedules

```sh
FN=$(terraform output -raw lambda_function_name)
aws lambda invoke --function-name "$FN" --payload '{"job":"digest"}' --cli-binary-format raw-in-base64-out /tmp/out.json
cat /tmp/out.json                                    # {"job":"digest","ran":["tracker.digest"]}
aws logs tail "/aws/lambda/$FN" --since 5m           # the bot's own output + any ntfy it sent
```

If a secret is missing you'll see a loud error here (fail-loud by design), not silent success.

## 7. The Actions crons are retired (done 2026-07-25)

```sh
terraform output schedule_names                      # job-hq-monitor, job-hq-tracker, ...
```

The `schedule:` blocks are gone from `.github/workflows/monitor|review|tracker|digest|wide-*|
simplify.yml` — every one keeps `workflow_dispatch`, so a manual re-run (or a run when AWS itself
is the problem) is still one click with the same code and the same repo secrets. `selfheal.yml`,
`pgdump.yml`, `ci.yml` and `resume.yml` still run on Actions.

---

## Ops alerting (`terraform/alerts.tf`)

The Actions crons each ended with an "Ops alert on failure" step. That's replaced by two layers,
because they catch different failures and neither alone is enough:

| Layer | Fires when | Names the job? |
|---|---|---|
| `app/handler.py` → `core.notify.ops_alert` | any bot raises or exits nonzero — **every** occurrence | yes: `[lambda] tracker failed` + the failing module |
| CloudWatch alarm → SNS → `alerter/index.py` → ntfy | the failures in-process code can't report | no (one Lambda runs all bots) |

Two alarms, both also pushing on recovery:

- **`job-hq-bots-errors`** — `Errors > 0` in any 5 min. Catches timeouts, OOM kills, a broken
  image, an unimportable module, a dead SSM secret store. Won't re-notify while already in ALARM;
  that's what layer 1 is for. It also **stays red until the next successful invocation** — Lambda
  publishes no metrics while idle, so there is no clean datapoint to clear it with, and the
  recovery push lands on the next scheduled run (≤ 2 h, the tracker cadence) rather than 5 minutes
  later. That's accurate rather than annoying: red until something actually succeeds. To clear it
  now, invoke any job by hand.
- **`job-hq-bots-silent`** — `Invocations < 1` over 3 h, missing data treated as **breaching**.
  The tracker chain alone fires every 2 h, so silence means the schedules, the scheduler role, or
  the account is broken. This is the only failure mode that otherwise produces no signal at all.

The alerter is a separate stdlib-only zip Lambda on purpose: it must work on the days the bots'
container image doesn't. It reads the ops topic from `hq.config.yaml` at `terraform apply` time
(env `OPS_NTFY_TOPIC`), so there's no SSM or IAM dependency at alert time.

Test it end to end (both layers, one command each — expect two pushes plus a recovery push
~5-10 min later):

```sh
FN=$(terraform output -raw lambda_function_name)
aws lambda invoke --function-name "$FN" --payload '{"job":"__alarm_test__"}' \
  --cli-binary-format raw-in-base64-out /tmp/out.json    # layer 1: "[lambda] __alarm_test__ failed"
aws lambda invoke --function-name "$(terraform output -raw alerter_function_name)" \
  --payload '{"probe":"alerter"}' --cli-binary-format raw-in-base64-out /tmp/a.json  # layer 2 path
aws cloudwatch describe-alarms --alarm-names $(terraform output -json alarm_names | tr -d '[]",') \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output text
```

## Known gaps (all documented, none silent)

- **`pgdump` still runs on GitHub Actions, and is still gated OFF by `PGDUMP_ENABLED`.** There is
  no live Supabase behind it, so there is nothing to dump; moving it here would need a `pg_dump`
  binary baked into the image *and* a live database. Deferred deliberately — an empty backup job
  running in two places is not redundancy.
- **The re-pinned registry still needs Actions.** `selfheal.yml` re-pins `hq.config.yaml` and
  commits it; git is its product, so it stays there. The *sheet* backup no longer depends on that
  (see below) — only the registry half does.
- **The git-diffable copies still only refresh on an Actions run** (`snapshots/hq/*.csv`,
  `monitor/snapshots/*.json`). That is the point: the S3 copy and the git copy are two independent
  backups on two independent schedulers, not one with a fallback. Losing either is now loud —
  the daily digest ops-pushes **"HQ backups stale"** when `heartbeat_selfheal`,
  `heartbeat_snapshot` (git copy) or `heartbeat_snapshot_s3` (S3 copy) goes past 2x its cadence.
  The two snapshot lanes write **separate** heartbeats deliberately: sharing one would let the
  Actions run refresh it nightly while the S3 copy was dead, and the watchdog would report
  "backed up" — exactly the silent failure the second copy was added to end.
- **ntfy.sh is the only alert channel** unless you set `var.alert_email` (an SNS email
  subscription; confirm the AWS email once).

Closed on this branch (kept here so the history is readable):

- ~~No per-user fan-out.~~ Schedules are `var.jobs` x the registry's `users:` keys
  (`local.schedules` in `main.tf`), so a second user gets `job-hq-<job>-<user>` lanes firing
  `{"job":..,"user":..}` and the handler exports `HQ_USER` per invocation. Adding a user =
  `tracker.provision` writes them into `hq.config.yaml` -> `terraform apply`. Single-user is
  unchanged by construction: no `users:` map means the old names and the old `{"job": k}` payload,
  so this planned as a no-op. The `default_user` keeps the **flat** key and name even after the
  users map appears (only its `input` gains `"user"`), because a changed map key or schedule name
  is a destroy + create — the migration apply must only add lanes and update inputs, never delete
  a live one. A plan showing an `aws_scheduler_schedule` destroy is a bug, not a migration.
- ~~No S3 sink for the sheet backup.~~ `backups.tf` + env `HQ_BACKUP_S3_BUCKET`: the scheduled
  `snapshot` job (08:53 UTC) writes `s3://job-hq-backups-<account>/snapshots/<user>/<tab>.csv`
  — write-only IAM, versioned, noncurrent versions expire at 90 days — so the sheet is backed up
  even when GitHub isn't running anything (Actions billing lapse, 2026-07-24: 21 h, no backup, no
  alert). `monitor.run` drops its feed JSON at `feeds/<label>.json` the same way when the FS is
  read-only. Restore: `docs/RUNBOOK.md § Restoring the sheet`.
- ~~Mutable `:latest` image tag.~~ `infra/deploy.sh` tags and deploys by git SHA (step 4), and
  `aws_lambda_function.bots` ignores `image_uri` so Terraform can't pull the code back to
  `:latest`. Rollback is one `update-function-code` at an older SHA that is already in ECR.

---

## Add a bot later

1. Add its `python -m` sequence to `JOBS` in `infra/app/handler.py`.
2. Add an entry to `var.jobs` in `variables.tf` with its cron.
3. Rebuild+push the image (step 4) and `terraform apply`.

## Add another project later

Copy `infra/terraform` into the other repo, change `var.project` (every resource is name-prefixed),
point its Dockerfile at that repo, and it stands alone in the same AWS account. When you have a few,
promote this into a shared Terraform *module* and have each project instantiate it — that's the
natural next refactor, not needed yet.

## Cost & teardown

- **Cost:** Lambda (1M free req/mo) + EventBridge Scheduler (free at this volume) + SSM standard
  params (free) + a few MB of ECR = effectively $0. No metered wall like Actions/Modal here.
- **Teardown:** `terraform destroy` (then delete the SSM params by hand — they're not in state).

## What I built here

- `app/handler.py` — dispatches `{"job": <name>}` to the exact `python -m` sequence each old
  workflow ran (bots unchanged); loads `/job-hq/*` secrets from SSM once per cold start.
- `Dockerfile` — AWS Python 3.11 Lambda image with core/monitor/tracker + the handler.
- `deploy.sh` — build/push/pin by git SHA, with the dirty-tree and wrong-account guards.
- `alerter/index.py` — SNS→ntfy bridge for the CloudWatch alarms; stdlib only, no shared code
  with the bots (it has to survive their image being broken).
- `terraform/` — ECR, the Lambda, a least-privilege execution role (logs + read its own SSM +
  PutObject to the backup bucket), a scheduler role (invoke only this function), one EventBridge
  schedule per bot per user, `backups.tf`'s versioned S3 backup bucket, and `alerts.tf`'s alarms
  + SNS topic + alerter.
