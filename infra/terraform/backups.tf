# S3 sink for the backups — the copies that cannot share fate with GitHub.
#
# TWO LANES, ONE BUCKET:
#   snapshots/<user>/<tab>.csv       tracker.snapshot — the SHEET's copy
#   pgdump/public.sql.gz             tracker.pgdump   — the STORE's copy, public schema only.
#                                    ONE object for the whole store: one database, not one per user
#
# The second lane is why `pg_dump` is not on GitHub Actions at all: dumps used to be COMMITTED
# to this repository nightly until PKT-DUMP-DISABLE closed that lane (FP-OPS-001), and a
# workflow test now statically rejects any run block that invokes pg_dump. Object storage is
# the only sanctioned sink, and it is this bucket.
#
# `auth` is deliberately absent from the dump: identities, sessions and refresh tokens do not
# leave the database. See tracker/pgdump.py.

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
    filter {} # whole bucket: snapshots/<user>/*.csv AND pgdump/public.sql.gz

    # 90 days of daily versions is a deep restore window; unbounded versioning of a daily
    # overwrite is just a bill that grows forever. ONE rule for both lanes on purpose —
    # two rules matching the same object make the effective retention a question about
    # S3's conflict resolution, and a backup's retention must not be a trivia question.
    #
    # `newer_noncurrent_versions` is the floor, and it is the interesting half. Age alone
    # says "keep 90 days of history", which is the same sentence as "if this lane dies for
    # 90 days, delete every good copy and keep only the last bad one" — the failure mode of
    # a lane whose deaths are exactly what a backup exists to survive. With the floor, the
    # 30 newest noncurrent versions survive regardless of age, so a month of nightly dumps
    # is always restorable even if nothing has run since. At dump sizes measured in tens of
    # MB that floor costs cents a month.
    noncurrent_version_expiration {
      noncurrent_days           = 90
      newer_noncurrent_versions = 30
    }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}

# Write-only by design: PutObject on the objects, nothing else. The bots never need to read a
# backup back, so a compromised (or buggy) bot can only add versions — it cannot exfiltrate the
# sheet's history, list it, or delete it. Restores are a human with their own credentials.
#
# That mattered less when the objects were CSVs of the operator's own sheet. It is the whole
# security story now that one of them is a dump of the product database: `s3:GetObject` on this
# bucket would let anything reaching the bots' role read every user's rows out of an object
# store, which is a far softer target than the database itself. It is absent, and
# tests/infra/test_backups_terraform.py fails if it comes back.
#
# Scoped to the two prefixes the two lanes write, not the whole bucket: a role that can PutObject
# anywhere in a versioned bucket can also bury the real backups under an unbounded pile of
# objects it chose the names of. There is exactly one writer and it writes exactly two paths.
#
# `s3:DeleteObject`/`DeleteObjectVersion` are likewise absent, which is what makes versioning a
# defense rather than a decoration — the writer cannot remove a version, so yesterday's good
# dump survives today's bad one no matter what the bot does.
resource "aws_iam_role_policy" "write_backups" {
  name = "write-backups"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow", Action = ["s3:PutObject"],
        Resource = [
          "${aws_s3_bucket.backups.arn}/snapshots/*", # tracker.snapshot — the sheet's CSVs
          "${aws_s3_bucket.backups.arn}/pgdump/*",    # tracker.pgdump   — the store's dump
        ]
      },
    ]
  })
}
