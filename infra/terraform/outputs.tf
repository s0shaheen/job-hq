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

output "ssm_prefix" {
  description = "Put the bots' secrets under this path as SecureStrings (see the runbook)."
  value       = var.ssm_prefix
}
