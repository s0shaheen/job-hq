# S3 sink for the sheet backups — the copy that cannot share fate with GitHub.
#
# WHY: every durable copy of the HQ sheet used to reach storage through a GitHub Actions
# git-commit (selfheal.yml runs tracker.snapshot, then commits snapshots/<user>/*.csv). On
# 2026-07-24 Actions stopped running on a billing lapse and the backups silently stopped for
# 21 hours — nothing alerted, because the job that would have complained never started. A
# backup whose only path to storage is the scheduler that died is not a backup. The Lambda
# now writes the same CSVs straight here, on a schedule AWS owns end to end.
#
# Versioning IS the history (stable keys, one object per tab), so there is nothing to prune
# but old versions — capped at 90 days below.

resource "aws_s3_bucket" "backups" {
  bucket = "${local.name}-backups-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Overwrites become new versions, so a bot that writes garbage (or writes nothing) cannot
# destroy yesterday's good copy — the restore is a version, not a prayer.
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {} # whole bucket

    # 90 days of daily versions per tab is a deep restore window; unbounded versioning of a
    # daily overwrite is just a bill that grows forever.
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}

# Write-only by design: PutObject on the objects, nothing else. The bots never need to read a
# backup back, so a compromised (or buggy) bot can only add versions — it cannot exfiltrate the
# sheet's history, list it, or delete it. Restores are a human with their own credentials.
resource "aws_iam_role_policy" "write_backups" {
  name = "write-backups"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.backups.arn}/*" },
    ]
  })
}
