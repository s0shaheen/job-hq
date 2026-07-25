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
    aws_cloudwatch_metric_alarm.bots_silent.alarm_name])
}

output "ssm_prefix" {
  description = "Put the bots' secrets under this path as SecureStrings (see the runbook)."
  value       = var.ssm_prefix
}
