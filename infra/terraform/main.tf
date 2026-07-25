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
  name       = var.project                       # name prefix for every resource
  ssm_arn    = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.me.account_id}:parameter${var.ssm_prefix}*"
  image_uri  = "${aws_ecr_repository.bots.repository_url}:${var.image_tag}"
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
  environment { variables = { SSM_PREFIX = var.ssm_prefix } }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }
  depends_on = [aws_iam_role_policy_attachment.logs]
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

# --- one schedule per bot (add a bot = add to var.jobs) -------------------------------------
resource "aws_scheduler_schedule" "job" {
  for_each = var.jobs

  name                         = "${local.name}-${each.key}"
  schedule_expression          = each.value.cron           # EventBridge cron(...) form
  schedule_expression_timezone = var.timezone              # keep UTC to match the old Actions crons 1:1
  flexible_time_window { mode = "OFF" }

  target {
    arn      = aws_lambda_function.bots.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ job = each.key })
    retry_policy { maximum_retry_attempts = 2 }
  }
}
