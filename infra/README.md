# HQ bots on AWS Lambda + EventBridge — setup runbook

This moves the **scheduled bots** (the live product) off GitHub Actions onto AWS Lambda, fired by
EventBridge Scheduler. One container image runs every bot; secrets live in SSM Parameter Store.
At this workload it sits comfortably in the **AWS always-free tier** (≈ pennies of ECR storage).

You run ~5 commands. Everything else is the code in this directory. I can't touch your AWS —
`terraform plan` validates everything before anything is created, so nothing here is destructive
until you approve a plan.

**Not migrated, on purpose:** the jobs whose *product is a git commit* — `selfheal.yml`
(`tracker.selfheal` + `tracker.snapshot` + commit) and `pgdump.yml`. Lambda's `/var/task` is
read-only, so both writes there are silently skipped, and a backup that silently doesn't happen is
worse than no backup. They stay on GitHub Actions until there's an S3 sink (see Known gaps).
Six schedules live here: `monitor`, `review`, `tracker`, `digest`, `wide_cafe`, `wide_theirstack`.

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

## 4. Build + push the container image

From the **repo root** (the Dockerfile copies core/monitor/tracker):

```sh
cd ../..                                             # repo root
ECR=$(cd infra/terraform && terraform output -raw ecr_repository_url)
aws ecr get-login-password | docker login --username AWS --password-stdin "${ECR%/*}"
docker build --platform linux/amd64 -f infra/Dockerfile -t "${ECR}:latest" .
docker push "${ECR}:latest"
```

(`--platform linux/amd64` matters if you're on an Apple-silicon Mac — Lambda runs x86 here.
Keep the braces: in **zsh** `"$ECR:latest"` is parsed as the `:l` lowercase modifier plus
"atest", and you get a push to a repo named `job-hq-botsatest`.)

## 5. Create everything else (Terraform, step 2 of 2)

```sh
cd infra/terraform
terraform apply     # the Lambda, IAM roles, 6 schedules, and the alerting stack (alerts.tf)
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

- **No per-user fan-out.** The Actions workflows ran a matrix over `vars.HQ_USERS`; a Lambda
  schedule fires one invocation. Today the registry is single-user (flat `hq.config.yaml`), so
  they're equivalent — but the moment a second user instance exists, each schedule must fan out
  (one invocation per user with `HQ_USER` set, or a dispatcher job) or the new user gets nothing.
- **No S3 sink**, so `tracker.snapshot`, the re-pinned registry, and `pgdump` stay on Actions,
  and `monitor.run`'s git-diffable `monitor/snapshots/*.json` only refreshes on a dispatched
  Actions run (it warns and continues on Lambda; the nightly CSV snapshot still backs up Feed).
- **Mutable `:latest` image tag.** Terraform can't see a new build — after pushing, force the pull
  with `aws lambda update-function-code --function-name job-hq-bots --image-uri "${ECR}:latest"`.
  Tagging by git SHA is the fix.
- **ntfy.sh is the only alert channel** unless you set `var.alert_email` (an SNS email
  subscription; confirm the AWS email once).

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
- `alerter/index.py` — SNS→ntfy bridge for the CloudWatch alarms; stdlib only, no shared code
  with the bots (it has to survive their image being broken).
- `terraform/` — ECR, the Lambda, a least-privilege execution role (logs + read its own SSM only),
  a scheduler role (invoke only this function), one EventBridge schedule per bot, and
  `alerts.tf`'s alarms + SNS topic + alerter.
