# Ops alerting for the scheduled bots: CloudWatch alarm -> SNS -> ntfy.
#
# This is what the GitHub Actions "Ops alert on failure" step used to do. Two layers, because
# they fail differently and neither alone is enough:
#
#   1. handler.py pushes ntfy itself when a bot raises — names the JOB, fires on EVERY failure
#      (a CloudWatch alarm already in ALARM does not re-notify for the second failure).
#   2. these alarms catch what in-process code cannot report: a Lambda timeout or OOM kill, a
#      broken image, an import error, a missing secret store — and the schedules going silent
#      altogether, which is the only failure mode that produces no signal at all.
#
# The alerter is a separate stdlib-only zip function on purpose: layer 2 must not depend on the
# bots' container image, which is exactly what may be broken.

locals {
  # Single source of truth for the ops topic: the committed registry the bots themselves read
  # (parsed once in main.tf, where the per-user schedule fan-out reads it too). Handles the flat
  # (single-user) doc and the users/<name> shape; if neither resolves, the plan fails loudly
  # rather than shipping an alerter that pushes into the void.
  ops_topic = try(local.registry.ntfy.ops,
  local.registry.users[local.registry.default_user].ntfy.ops)

  log_group_url = join("", [
    "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}",
    "#logsV2:log-groups/log-group/$252Faws$252Flambda$252F${local.name}-bots",
  ])
}

# --- the channel ----------------------------------------------------------------------------
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

# Optional second channel for the day ntfy.sh itself is down. Off by default: an unconfirmed
# subscription looks like redundancy without being any. Set var.alert_email, apply, then tap the
# AWS confirmation email once.
resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# --- the alerter (SNS -> ntfy) ---------------------------------------------------------------
data "archive_file" "alerter" {
  type        = "zip"
  source_file = "${path.module}/../alerter/index.py"
  output_path = "${path.module}/.build/alerter.zip"
}

resource "aws_iam_role" "alerter" {
  name = "${local.name}-alerter"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "alerter_logs" {
  role       = aws_iam_role.alerter.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "alerter" {
  name              = "/aws/lambda/${local.name}-alerter"
  retention_in_days = 14
}

resource "aws_lambda_function" "alerter" {
  function_name    = "${local.name}-alerter"
  role             = aws_iam_role.alerter.arn
  runtime          = "python3.12" # stdlib-only, so it is free to be newer than the bots' 3.11
  handler          = "index.handler"
  filename         = data.archive_file.alerter.output_path
  source_code_hash = data.archive_file.alerter.output_base64sha256
  timeout          = 20
  environment {
    variables = {
      OPS_NTFY_TOPIC = local.ops_topic
      LOG_GROUP_URL  = local.log_group_url # ntfy Click target: straight to the bots' logs
    }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.alerter.name
  }
  depends_on = [aws_iam_role_policy_attachment.alerter_logs]
}

resource "aws_lambda_permission" "alerter_sns" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.alerter.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "alerter" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.alerter.arn
}

# --- the alarms ------------------------------------------------------------------------------
# One function runs every bot, so this alarm cannot name the job — layer 1 (handler.py) does.
# Its job is to catch the failures that never reach handler.py's except block.
resource "aws_cloudwatch_metric_alarm" "bots_errors" {
  alarm_name          = "${local.name}-bots-errors"
  alarm_description   = "A scheduled HQ bot failed on Lambda (raised, timed out, or was killed). Logs: /aws/lambda/${local.name}-bots — the per-job push names which bot."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.bots.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching" # no invocations in a window is not a failure (see below)
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn] # the "it recovered" push, so ALARM always closes
}

# The silence alarm — the one that would have caught "six days of dead runs never paged anyone".
# The tracker chain alone fires every 2 h, so every 3 h window must contain at least one
# invocation; zero means the schedules, the role, or the account is broken. Missing data is
# BREACHING here on purpose: no news is exactly the bad news.
resource "aws_cloudwatch_metric_alarm" "bots_silent" {
  alarm_name          = "${local.name}-bots-silent"
  alarm_description   = "No HQ bot ran in 3 h (the tracker chain should fire every 2 h). Check EventBridge schedules ${local.name}-* and the scheduler role."
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = aws_lambda_function.bots.function_name }
  statistic           = "Sum"
  period              = 10800
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# The render service's errors (render.tf). It lives here, next to the bots' alarms, because the
# SNS topic and the alerter are shared and because docs/SYSTEM.md's alarm table is generated
# from THIS FILE — an alarm defined elsewhere would work and go undocumented.
#
# There is no `-silent` twin, and that is not an oversight: the renderer has no schedule. It
# runs when a person clicks render, so "no invocations in 3 h" is a normal Tuesday night, and an
# alarm that fires every night is one nobody reads by Friday.
#
# What this catches is what the function cannot report itself: it is invoked SYNCHRONOUSLY, so a
# validation error already surfaces to the person who typed the document that caused it. A
# timeout, an OOM kill, a broken image or an import failure never reaches that person as
# anything but a spinner — this is the only path by which those page anyone.
resource "aws_cloudwatch_metric_alarm" "render_errors" {
  alarm_name          = "${local.name}-render-errors"
  alarm_description   = "The résumé render Lambda failed (raised, timed out, was killed, or the image is broken). Logs: /aws/lambda/${local.name}-render. A user-visible validation error is NOT this — those return to the caller."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.render.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching" # no renders in a window is the normal state here
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
