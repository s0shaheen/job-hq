# HQ scheduled bots on AWS Lambda + EventBridge Scheduler.
#
# One container image (built from infra/Dockerfile) runs every bot; EventBridge Scheduler
# fires it on each cron with {"job": "<name>"}. Secrets live in SSM Parameter Store under
# var.ssm_prefix (SecureStrings, set out-of-band per the runbook — never in Terraform state).
#
# Adding a bot: add an entry to var.jobs. Adding another project later: copy this dir with a
# different var.project (all names are prefixed), or promote it to a reusable module.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" } # zips the ops alerter
  }
  # Remote state in S3 (versioned, private) — survives worktree/machine cleanup.
  backend "s3" {
    bucket = "job-hq-tfstate-690340855657"
    key    = "job-hq/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { project = var.project, managed_by = "terraform" } }
}

data "aws_caller_identity" "me" {}
data "aws_region" "current" {}

locals {
  name      = var.project # name prefix for every resource
  ssm_arn   = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.me.account_id}:parameter${var.ssm_prefix}*"
  image_uri = "${aws_ecr_repository.bots.repository_url}:${var.image_tag}"

  # The committed registry the bots themselves read, parsed ONCE for the whole module
  # (alerts.tf pulls the ops topic out of it too). No users: map = the original flat
  # single-user doc, which is what keeps the fan-out below a plan no-op today.
  registry = yamldecode(file("${path.module}/../../hq.config.yaml"))
  hq_users = try(keys(local.registry.users), [])
  # Whose instance the flat, already-deployed lanes belong to. provision.py always writes
  # default_user when it creates the users map, and the precondition below refuses to plan
  # without it — see the state-address note.
  hq_default_user = try(local.registry.default_user, "")

  # Schedules are jobs x users, because one EventBridge schedule fires exactly ONE invocation —
  # the per-user lanes the old GitHub Actions matrix gave us for free. Adding a user =
  # provision writes `users: <name>` -> terraform apply grows their lanes; concurrency is
  # per-user Lambda invocations, mirroring the old per-user Actions matrix legs.
  #
  # STATE-ADDRESS CONTINUITY (why the default user is special-cased): a schedule is addressed in
  # Terraform state by its map key and in AWS by its name, so changing either is a DESTROY +
  # CREATE, not an update. Keying every lane "<job>-<user>" the moment a users: map appears would
  # therefore delete all 7 of the operator's LIVE schedules and rebuild them — an outage window,
  # and unrecoverable if the create half fails. So the default user keeps the FLAT key and the
  # FLAT name ("monitor" -> job-hq-monitor) and only gains {"user": "<default>"} in its payload,
  # which target.input applies IN PLACE. Only non-default users get "<job>-<user>" keys/names.
  # The migration apply may only CREATE new lanes and UPDATE inputs; if a plan on this file ever
  # shows an aws_scheduler_schedule destroy, stop and work out why before applying.
  # Single-user (no users: map) keeps the "" lane, so its names AND inputs stay byte-identical.
  schedules = {
    for pair in setproduct(keys(var.jobs), length(local.hq_users) > 0 ? local.hq_users : [""]) :
    (pair[1] == "" || pair[1] == local.hq_default_user ? pair[0] : "${pair[0]}-${pair[1]}") => { job = pair[0], user = pair[1], cron = var.jobs[pair[0]].cron }
  }
}

# --- image registry -------------------------------------------------------------------------
resource "aws_ecr_repository" "bots" {
  name                 = "${local.name}-bots"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}

# --- lambda execution role: write logs + read ONLY its own SSM params ------------------------
resource "aws_iam_role" "lambda" {
  name = "${local.name}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "read_secrets" {
  name = "read-secrets"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"], Resource = local.ssm_arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = "*",
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${data.aws_region.current.name}.amazonaws.com" } } },
    ]
  })
}

# --- the function ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}-bots"
  retention_in_days = 14
}

resource "aws_lambda_function" "bots" {
  function_name = "${local.name}-bots"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = local.image_uri
  timeout       = var.timeout_seconds     # sweeps can be slow; default 900 (Lambda max)
  memory_size   = var.memory_mb
  environment {
    variables = {
      SSM_PREFIX = var.ssm_prefix
      # Presence of this switches the snapshot bots from repo files to the S3 sink (backups.tf).
      HQ_BACKUP_S3_BUCKET = aws_s3_bucket.backups.bucket
    }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }
  depends_on = [aws_iam_role_policy_attachment.logs]

  # infra/deploy.sh pins the running build by git SHA, out of band. Terraform owns everything
  # about this function EXCEPT which build it runs, so an apply can never silently roll the
  # code back to whatever `:latest` (var.image_tag, used only at create time) points at now.
  lifecycle {
    ignore_changes = [image_uri]
  }
}

# --- scheduler role: assume by EventBridge Scheduler, invoke ONLY this function --------------
resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole",
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.me.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "invoke"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.bots.arn }]
  })
}

# --- one schedule per bot PER USER (add a bot = var.jobs; add a user = the registry) --------
resource "aws_scheduler_schedule" "job" {
  for_each = local.schedules

  name                         = "${local.name}-${each.key}" # job-hq-monitor (default user too), or job-hq-monitor-dad
  schedule_expression          = each.value.cron             # EventBridge cron(...) form
  schedule_expression_timezone = var.timezone                # keep UTC to match the old Actions crons 1:1
  flexible_time_window { mode = "OFF" }

  target {
    arn      = aws_lambda_function.bots.arn
    role_arn = aws_iam_role.scheduler.arn
    # `user` is omitted, not blanked, on the single-user lane: the payload must stay
    # byte-identical to the deployed {"job": k}, and handler.py reads a missing user as
    # "the flat registry". The default user's lane keeps its flat NAME but does carry
    # {"user": ...} once a users: map exists — the one in-place change of the migration.
    input = jsonencode({ for k, v in { job = each.value.job, user = each.value.user } : k => v if v != "" })
    retry_policy { maximum_retry_attempts = 2 }
  }

  lifecycle {
    # Fail the plan rather than silently renaming every live lane: with a users: map but no
    # (or a typo'd) default_user, nothing claims the flat key and all 7 deployed schedules
    # would plan as destroy + create.
    precondition {
      condition     = length(local.hq_users) == 0 || contains(local.hq_users, local.hq_default_user)
      error_message = "hq.config.yaml has a users: map but default_user is missing from it; the default user's lanes are the deployed flat-named ones, so applying would destroy every live schedule."
    }
  }
}
