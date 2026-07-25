# HQ bots on AWS Lambda + EventBridge — setup runbook

This moves the **scheduled bots** (the live product) off GitHub Actions onto AWS Lambda, fired by
EventBridge Scheduler. One container image runs every bot; secrets live in SSM Parameter Store.
At this workload it sits comfortably in the **AWS always-free tier** (≈ pennies of ECR storage).

You run ~5 commands. Everything else is the code in this directory. I can't touch your AWS —
`terraform plan` validates everything before anything is created, so nothing here is destructive
until you approve a plan.

**Not migrated (on purpose, follow-on):** the two *backup* jobs — `tracker.snapshot`'s git-commit
and `pgdump` — need an S3 sink instead of git. The 8 live sheet/pg bots are what's here.

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
docker build --platform linux/amd64 -f infra/Dockerfile -t "$ECR:latest" .
docker push "$ECR:latest"
```

(`--platform linux/amd64` matters if you're on an Apple-silicon Mac — Lambda runs x86 here.)

## 5. Create everything else (Terraform, step 2 of 2)

```sh
cd infra/terraform
terraform apply                                      # creates the Lambda, IAM roles, 8 schedules
```

## 6. Smoke-test one bot before trusting the schedules

```sh
FN=$(terraform output -raw lambda_function_name)
aws lambda invoke --function-name "$FN" --payload '{"job":"digest"}' --cli-binary-format raw-in-base64-out /tmp/out.json
cat /tmp/out.json                                    # {"job":"digest","ran":["tracker.digest"]}
aws logs tail "/aws/lambda/$FN" --since 5m           # the bot's own output + any ntfy it sent
```

If a secret is missing you'll see a loud error here (fail-loud by design), not silent success.

## 7. Confirm the schedules are live, then retire the Actions crons

```sh
terraform output schedule_names                      # job-hq-monitor, job-hq-tracker, ...
```

Once you trust them, delete (or disable) the `schedule:` blocks in `.github/workflows/*.yml` so
the two don't double-run. Keep the CI workflows (`ci.yml`) — those stay on Actions.

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
- `terraform/` — ECR, the Lambda, a least-privilege execution role (logs + read its own SSM only),
  a scheduler role (invoke only this function), and one EventBridge schedule per bot.
