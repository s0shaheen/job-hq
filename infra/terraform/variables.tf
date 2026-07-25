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
  description = <<-EOT
    Sized off the real ceiling job, not a guess: the first twice-daily monitor sweep on Lambda
    (2026-07-25, 644 boards) reported Max Memory Used 486 MB — 95% of the old 512. An OOM kill is
    also the one failure class handler.py cannot report (the process dies mid-push), leaving only
    the CloudWatch alarm. 1024 buys real headroom, and since Lambda scales vCPU with memory it
    shortens the sweep against the hard 900 s timeout too. Free-tier safe: every job at 1 GB is
    ~50k of the 400k GB-s/month.
  EOT
  type        = number
  default     = 1024
}

variable "alert_email" {
  description = <<-EOT
    Optional second alert channel (SNS email) for the day ntfy.sh is down. Empty = ntfy only.
    Setting it sends one AWS confirmation email you must accept; until then the subscription is
    pending and delivers nothing.
  EOT
  type        = string
  default     = ""
}

# job name (matches JOBS in infra/lambda/handler.py) -> EventBridge cron.
# Ported 1:1 from .github/workflows/*.yml (UTC). EventBridge cron is 6-field:
#   cron(minute hour day-of-month month day-of-week year); one of DoM/DoW must be '?'.
variable "jobs" {
  type = map(object({ cron = string }))
  default = {
    # TWICE daily — 07:00 + 18:00 CT. The second sweep is the whole reason the hourly priority
    # watch could be retired; a once-a-day port would have quietly halved discovery freshness.
    monitor         = { cron = "cron(0 12,23 * * ? *)" }  # daily 12:00 + 23:00 UTC (monitor.run)
    review          = { cron = "cron(0 15 * * ? *)" }    # daily 15:00 UTC  (regate + review)
    tracker         = { cron = "cron(31 0/2 * * ? *)" }  # every 2h at :31  (promote/quickadd/scout/stale/join)
    digest          = { cron = "cron(40 11 * * ? *)" }   # daily 11:40 UTC  (digest)
    # selfheal intentionally NOT scheduled: the nightly job that re-asserts the schema also
    # writes the CSV snapshots and the re-pinned registry AND COMMITS THEM — git is its output,
    # so it stays on GitHub Actions (selfheal.yml). Lambda's read-only FS silently drops both
    # halves of that backup. The rule for this split: if a job's product is a git commit, it
    # stays on Actions. Still dispatchable here by hand (handler.JOBS keeps "selfheal").
    # simplify intentionally NOT scheduled: it replays expiring simplify.jobs session cookies
    # (a fragile secret you'd babysit), and its applications already reach Pipeline via Gmail
    # capture. To revive: re-add a line here + put SIMPLIFY_AUTH_COOKIE/SIMPLIFY_CSRF in SSM.
    wide_cafe       = { cron = "cron(30 13 * * ? *)" }   # daily 13:30 UTC  (wide --source cafe)
    wide_theirstack = { cron = "cron(50 13 * * ? *)" }   # daily 13:50 UTC  (wide --source theirstack)
  }
}
