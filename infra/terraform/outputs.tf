output "ecr_repository_url" {
  description = "Push the container image here (see the runbook)."
  value       = aws_ecr_repository.bots.repository_url
}

output "lambda_function_name" {
  value = aws_lambda_function.bots.function_name
}

output "schedule_names" {
  description = "One EventBridge schedule per bot."
  value       = sort([for s in aws_scheduler_schedule.job : s.name])
}

output "alerts_topic_arn" {
  description = "CloudWatch alarms publish here; the alerter Lambda turns them into ntfy pushes."
  value       = aws_sns_topic.alerts.arn
}

output "alerter_function_name" {
  value = aws_lambda_function.alerter.function_name
}

output "alarm_names" {
  value = sort([aws_cloudwatch_metric_alarm.bots_errors.alarm_name,
    aws_cloudwatch_metric_alarm.bots_silent.alarm_name,
  aws_cloudwatch_metric_alarm.render_errors.alarm_name])
}

output "ses_verified_identities" {
  description = "Addresses the mail lane created identities for. Each one must be confirmed by clicking the AWS verification email before SES will send from or deliver to it."
  value       = sort([for identity in aws_sesv2_email_identity.mail : identity.email_identity])
}

output "ssm_prefix" {
  description = "Put the bots' secrets under this path as SecureStrings (see the runbook)."
  value       = var.ssm_prefix
}

output "render_ecr_repository_url" {
  description = "Push the render image here: infra/deploy.sh render."
  value       = aws_ecr_repository.render.repository_url
}

output "render_function_name" {
  description = "Invoked synchronously by the webapp. No schedule, no function URL — see render.tf."
  value       = aws_lambda_function.render.function_name
}

output "render_function_arn" {
  description = "The exact ARN the webapp's identity gets lambda:InvokeFunction on. Nothing may be granted invoke on a wildcard."
  value       = aws_lambda_function.render.arn
}
