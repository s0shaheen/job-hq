# HQ bots on AWS Lambda + EventBridge — setup runbook

This moves the **scheduled bots** (the live product) off GitHub Actions onto AWS Lambda, fired by
EventBridge Scheduler. One container image runs every bot; secrets live in SSM Parameter Store.
At this workload it sits comfortably in the **AWS always-free tier** (≈ pennies of ECR storage).

You run ~5 commands. Everything else is the code in this directory. I can't touch your AWS —
`terraform plan` validates everything before anything is created, so nothing here is destructive
until you approve a plan.

**Not migrated, on purpose:** the job whose *product is a git commit* — `selfheal.yml` (schema
re-assert + the re-pinned registry + commit). Lambda's `/var/task` is read-only, so that write
there is silently skipped, and a backup that silently doesn't happen is worse than no backup. It
stays on GitHub Actions until there's a sink for it (see Known gaps). (`pgdump.yml` was the other
one; it was gated off with no database behind it and got deleted in the 2026-07-25 workflow
cleanup — resurrectable from git history.)
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
put MONITOR_OPS_NTFY_TOPIC   "example-hq-ops-..."
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

Those per-bot workflows are gone too (2026-07-25, after the cutover proved out). The manual lane is
now a single workflow, **`run-bot.yml` "Run a bot"**: pick a `job` from a dropdown pinned to the
`JOBS` table below, optionally a `user` lane and `extra_args`, and `scripts/runjob.py` runs that
job's exact module chain with the same code and the repo secrets. That is the manual re-run path,
the run-when-AWS-is-the-problem path, and the only thing that refreshes the git-diffable snapshot
copies. `.github/workflows/` is now four files: `ci.yml`, `resume.yml`, `selfheal.yml`,
`run-bot.yml`.

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

## The mail lane (`terraform/mail.tf`)

The daily digest is sent by the `digest` job itself, over **SES v2** from the bots Lambda (boto3
`sesv2.send_email`, under the execution role it already has — no API key, no second runtime).
That replaces the `MailApp.sendEmail` call in the Gmail Apps Script.

Two variables turn it on. Both live in `terraform/variables.tf`, both default to OFF:

| Variable | What it is |
|---|---|
| `ses_sender_email` | the From address. Empty (the default) = **no SES resources at all**, and the Lambda's `HQ_MAIL_SENDER` is empty, so the engine composes the digest and sends nothing. |
| `ses_verified_emails` | the recipients, verified as identities alongside the sender. |

```sh
cd infra/terraform
terraform apply \
  -var 'ses_sender_email=you@gmail.com' \
  -var 'ses_verified_emails=["you@gmail.com","dad@gmail.com"]'
# or put both in terraform.tfvars so you never retype them
```

**Then click the verification email.** Terraform creates the identity; AWS emails each address a
confirmation link, and until a human taps it that identity is `Pending` and nothing sends.
Applying is not verifying.

```sh
terraform output ses_verified_identities        # every address this lane created
aws sesv2 get-email-identity --email-identity you@gmail.com \
  --query '[IdentityType,VerifiedForSendingStatus]' --output text     # EMAIL_ADDRESS  True
```

**Sandbox, and why we stay there.** Every SES account starts in sandbox: the From address *and
every To address* must be a verified identity, 200 messages/day, 1 message/second. One digest to
two humans is two messages a day, so the caps are not the constraint — verification is. Leaving
sandbox is an AWS support request, worth filing the day a recipient appears who can't click a
verification link. Sandbox also fails in the useful direction: an unverified address is rejected
at send time instead of delivered to a stranger.

**The failure you will actually hit** is a recipient nobody verified. SES answers with
`MessageRejected` — *"Email address is not verified. The following identities failed the check in
region US-EAST-1: dad@gmail.com"* — and the engine gives that its own error class
(`AddressNotVerified`, `core/mailer.py`), so it lands as a distinct named ops push instead of a
generic digest failure. The fix is one `terraform apply` plus one click, not a code change. The
same error appears if the *sender* is unverified, which is why `mail.tf` builds its identity set
from sender + recipients together: an unverified From plans clean, applies clean, and rejects
every send.

`HQ_DIGEST_KEYS` (one-click link signing keys, `kid:secret,oldkid:oldsecret`, newest first) and
`HQ_WEBAPP_URL` (the absolute https origin those links point at) are **not** in Terraform. They
follow the same out-of-band secret discipline as everything else (step 2), so no signing key ever
lands in Terraform state:

```sh
put HQ_DIGEST_KEYS "k1:$(openssl rand -hex 32)"     # SecureString, per step 2's helper
put HQ_WEBAPP_URL  "https://<your webapp origin>"   # not a secret, kept with the rest for one lookup
put HQ_DIGEST_EMAIL "engine"                        # the engine-side switch; unset = compose, don't send
```

## Known gaps (all documented, none silent)

- **`pgdump` is deleted, not ported.** There is no live Supabase behind it, so there was nothing to
  dump, and it sat gated OFF by `PGDUMP_ENABLED` — a workflow file impersonating a backup. Bringing
  it here instead of to Actions would need a `pg_dump` binary baked into the image *and* a live
  database. Restore the workflow from git history when both exist (`docs/RUNBOOK.md` § PG snapshot
  has the commands).
- **The re-pinned registry still needs Actions.** `selfheal.yml` re-pins `hq.config.yaml` and
  commits it; git is its product, so it stays there. The *sheet* backup no longer depends on that
  (see below) — only the registry half does.
- **The git-diffable copies still only refresh on an Actions run** — `snapshots/hq/*.csv` nightly
  from `selfheal.yml`, `monitor/snapshots/*.json` only on a **Run a bot** dispatch. That is the point: the S3 copy and the git copy are two independent
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

## The render service (`terraform/render.tf`, `infra/render/`)

A **second Lambda**, `job-hq-render`, from a **second image** — not another entry in `var.jobs`.
It turns two YAML documents into a PDF and a page count, and the webapp invokes it
**synchronously** when a person clicks render. There is no schedule, no function URL and no API
Gateway behind it.

**Why it is separate, which is the only thing worth remembering about it:** this is the one
piece of compute in the system whose input is written by the user. A résumé YAML is arbitrary
attacker-controlled text handed to a third-party renderer, and rendercv 2.8 — left alone —
executes a custom theme folder's `__init__.py` during validation and fetches `cv.photo` by URL
with no allowlist. Both are real, both are reproduced against the live library in
`tests/infra/test_render_live.py`, and both are blocked in `infra/render/render.py` (a hardcoded
theme allowlist checked before the model is built; an unconditional photo strip). The guards are
the first line. The separate function is the second: its role can write CloudWatch Logs and
nothing else, so a full compromise of the renderer reaches an empty account. In the bots
function the same document would have had the role that reads every `/job-hq/*` SecureString.

| | bots | render |
|---|---|---|
| image | `infra/Dockerfile`, Python 3.11 | `infra/render/Dockerfile`, Python 3.12 (rendercv 2.8 needs >= 3.12) |
| deps | `requirements.txt` | `infra/render/requirements.txt` (rendercv + pypdf, nothing else) |
| role | SSM read + S3 backups + SES send | **CloudWatch Logs only** |
| invoked by | EventBridge Scheduler, 7 lanes | the webapp, synchronously |
| alarms | `-bots-errors`, `-bots-silent` | `-render-errors` only (no schedule = no silence alarm) |

```sh
infra/deploy.sh render        # build + push + pin to the git SHA, same as the bots
cd infra/terraform && terraform apply
```

Bootstrap order is the bots' order: the image must exist before Terraform can create the
function from it, so `deploy.sh render` prints a "run terraform apply, then re-run me" notice
the first time and exits 0.

**The one-page gate.** `render.gate_themes()` renders `infra/render/fixtures/reference_cv.yaml`
in all nine themes and raises `ThemeGateFailed`, naming each theme and its page count, if any
spills past one page. CI's `render` job runs it. A theme the product offers that cannot hold a
full one-page résumé is a shipping defect, not a user problem — which is why this one raises
where the per-document gate inside `render()` only reports.

**Not deployed.** Nothing on this branch has been applied; ECR repo, function, role and alarm
all exist as plan-only Terraform.

## Add a bot later

1. Add its `python -m` sequence to `JOBS` in `infra/app/handler.py`.
2. Add an entry to `var.jobs` in `variables.tf` with its cron.
3. Add the name to `run-bot.yml`'s `job` choice list (`tests/test_runjob.py` fails until you do —
   that pin is what keeps the manual lane and the schedules running the same chain).
4. Rebuild+push the image (step 4 above) and `terraform apply`.

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
  PutObject to the backup bucket + SendEmail on the verified identities), a scheduler role (invoke
  only this function), one EventBridge schedule per bot per user, `backups.tf`'s versioned S3
  backup bucket, `mail.tf`'s SES identities for the digest (off until a sender is set), and
  `alerts.tf`'s alarms + SNS topic + alerter.
