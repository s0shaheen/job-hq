variable "project" {
  description = "Name prefix for every resource (lets other projects reuse this dir)."
  type        = string
  default     = "job-hq"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "ssm_prefix" {
  description = "SSM Parameter Store path holding the bots' secrets as SecureStrings."
  type        = string
  default     = "/job-hq/"
}

variable "image_tag" {
  description = "ECR image tag to deploy (the runbook pushes :latest; pin a digest later)."
  type        = string
  default     = "latest"
}

variable "timezone" {
  description = "Schedule timezone. UTC keeps the old GitHub Actions crons identical."
  type        = string
  default     = "UTC"
}

variable "timeout_seconds" {
  type    = number
  default = 900 # Lambda max; the wide/aggregator sweeps can run minutes
}

variable "memory_mb" {
  type    = number
  default = 512
}

# job name (matches JOBS in infra/lambda/handler.py) -> EventBridge cron.
# Ported 1:1 from .github/workflows/*.yml (UTC). EventBridge cron is 6-field:
#   cron(minute hour day-of-month month day-of-week year); one of DoM/DoW must be '?'.
variable "jobs" {
  type = map(object({ cron = string }))
  default = {
    monitor         = { cron = "cron(0 12 * * ? *)" }    # daily 12:00 UTC  (monitor.run)
    review          = { cron = "cron(0 15 * * ? *)" }    # daily 15:00 UTC  (regate + review)
    tracker         = { cron = "cron(31 0/2 * * ? *)" }  # every 2h at :31  (promote/quickadd/scout/stale/join)
    digest          = { cron = "cron(40 11 * * ? *)" }   # daily 11:40 UTC  (digest)
    selfheal        = { cron = "cron(23 8 * * ? *)" }    # daily 08:23 UTC  (schema re-assert)
    simplify        = { cron = "cron(7 14,23 * * ? *)" } # 14:07 & 23:07 UTC (migrate + simplify)
    wide_cafe       = { cron = "cron(30 13 * * ? *)" }   # daily 13:30 UTC  (wide --source cafe)
    wide_theirstack = { cron = "cron(50 13 * * ? *)" }   # daily 13:50 UTC  (wide --source theirstack)
  }
}
