# The résumé render service: a second Lambda, invoked SYNCHRONOUSLY by the webapp.
#
# WHY IT IS A SEPARATE FUNCTION AND A SEPARATE ROLE — the whole point of this file:
#
# This is the only compute in the system whose INPUT IS AUTHORED BY THE USER. A résumé YAML is
# arbitrary attacker-controlled text handed to a third-party renderer (rendercv 2.8) that,
# left alone, executes a theme folder's __init__.py during validation and fetches cv.photo by
# URL with no allowlist (both proven live in tests/infra/test_render_live.py; both blocked in
# infra/render/render.py). Guards in code are the first line. This file is the second: even a
# complete compromise of the renderer lands in a role that can write CloudWatch Logs and
# NOTHING ELSE — no ssm:GetParameter, no s3:*, no ses:SendEmail, no VPC, no database.
#
# Putting the renderer in the bots function instead would have given that same document the
# role that reads every /job-hq/* SecureString (Google service account, Anthropic key, ntfy
# topics) and writes the backup bucket. That is the difference this file buys, and it is why
# an "just add it to var.jobs" refactor of this must not happen.
#
# NO SCHEDULE. There is no aws_scheduler_schedule here on purpose: this function runs when a
# person clicks render, never on a timer, so the `-silent` alarm pattern from alerts.tf would
# be permanently breaching and is deliberately absent. Only the Errors alarm applies.
#
# DEPLOYMENT IS A COORDINATOR STEP. Nothing in this branch has been applied. Bootstrap order
# mirrors the bots': `infra/deploy.sh render` pushes the image, then `terraform apply` creates
# the function from it, then deploy.sh again pins it to the git SHA.

# --- image registry -----------------------------------------------------------------------
resource "aws_ecr_repository" "render" {
  name                 = "${local.name}-render"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}

# --- execution role: logs, and nothing else ------------------------------------------------
# Read the attachments below as the security boundary they are. This role has exactly one
# managed policy (AWSLambdaBasicExecutionRole = CreateLogGroup/Stream + PutLogEvents) and no
# inline policy at all. Adding one is a decision about what a hostile résumé may reach.
resource "aws_iam_role" "render" {
  name = "${local.name}-render"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "render_logs" {
  role       = aws_iam_role.render.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# --- the function ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "render" {
  name              = "/aws/lambda/${local.name}-render"
  retention_in_days = 14
}

resource "aws_lambda_function" "render" {
  function_name = "${local.name}-render"
  role          = aws_iam_role.render.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.render.repository_url}:${var.render_image_tag}"

  # 60 s, not the bots' 900. A render is single-digit seconds warm; a document that runs a
  # minute is a pathological one, and a 15-minute ceiling on a SYNCHRONOUS call is just a
  # 15-minute wait for the person who clicked the button before they learn it failed.
  timeout = var.render_timeout_seconds

  # Typst holds the whole document plus the bundled font index in memory, and Lambda scales
  # vCPU with memory — the compile is CPU-bound, so under-provisioning here costs latency on
  # every render, not just the big ones.
  memory_size = var.render_memory_mb

  # /tmp is the Typst sandbox root (render.py: one work dir per render, rmtree'd in a finally).
  # 512 MB is the default and is ample for a résumé; it is stated rather than defaulted because
  # a document that fills /tmp is a denial of the WARM CONTAINER, not just of its own request.
  ephemeral_storage { size = 512 }

  # NO `environment` BLOCK, and that is deliberate. The renderer is a pure function of its
  # event: it holds no secrets, reads no config, and has nothing to point at a different
  # backend. An env var here would be the first thing an injected payload goes looking for.

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.render.name
  }
  depends_on = [aws_iam_role_policy_attachment.render_logs]

  # Same split as the bots (main.tf): Terraform owns the function, deploy.sh owns which build
  # it runs, so an apply can never roll the renderer back to whatever :latest points at today.
  lifecycle {
    ignore_changes = [image_uri]
  }
}

# --- who may invoke it ----------------------------------------------------------------------
# Nobody, yet. The webapp's server-side identity gets lambda:InvokeFunction on THIS ARN when
# the webapp lane is wired; it is not granted here because there is no principal to grant it to
# on this branch, and a placeholder principal in an IAM policy is how a wildcard invoker ships.
# There is deliberately NO function URL and NO API Gateway: a public HTTP endpoint on the one
# function that renders untrusted documents would be an open renderer for the whole internet.
