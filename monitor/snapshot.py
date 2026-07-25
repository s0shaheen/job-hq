"""Git-diffable JSON snapshot of feed history — the restore line of defense
the sheet's version history can't give us (owner-controlled, one commit away)."""
from __future__ import annotations
import errno
import json
import os
from dataclasses import asdict

from monitor.models import JobRecord

#: Same switch tracker.snapshot reads: set only on Lambda (infra/terraform/backups.tf).
S3_BUCKET_ENV = "HQ_BACKUP_S3_BUCKET"


def _put_s3(bucket: str, key: str, body: str) -> None:
    """Best-effort S3 copy of the feed JSON.

    Never raises, unlike tracker.snapshot's uploader: this file is a convenience
    copy (the nightly CSV snapshot is the Feed tab's real backup), and the sweep
    that produced it already succeeded. Failing a completed sweep over its backup
    copy would report the whole run as dead — the same philosophy as the
    read-only-FS branch below. boto3 is imported lazily: it exists in the Lambda
    image but not in requirements.txt.
    """
    try:
        import boto3
        boto3.client("s3").put_object(Bucket=bucket, Key=key,
                                      Body=body.encode(), ContentType="application/json")
        print(f"[snapshot] feed JSON -> s3://{bucket}/{key}")
    except Exception as e:
        print(f"::warning title=Feed snapshot skipped::upload to s3://{bucket}/{key} failed "
              f"({type(e).__name__}: {e}) — sweep kept; JSON snapshot not written "
              "(nightly CSV snapshot still covers Feed)")


def write_snapshot(path: str, label: str, history: dict[str, JobRecord]) -> None:
    jobs = [asdict(r) for r in sorted(history.values(), key=lambda r: r.id)]
    data = {"feed": label, "count": len(jobs), "jobs": jobs}
    body = json.dumps(data, indent=2, sort_keys=True)
    try:
        with open(path, "w") as f:
            f.write(body)
    except OSError as e:
        # Read-only filesystem (AWS Lambda's /var/task): there is no repo to commit into from
        # there, and the nightly CSV snapshot still backs up the Feed tab. Warn loudly, but never
        # fail a completed sweep over its backup copy — that would report the whole run as dead.
        if e.errno not in (errno.EROFS, errno.EACCES):
            raise
        bucket = os.environ.get(S3_BUCKET_ENV, "").strip()
        if bucket:                       # Lambda has a sink after all — use it, still best-effort
            _put_s3(bucket, f"feeds/{label}.json", body)
            return
        print(f"::warning title=Feed snapshot skipped::{path} is read-only ({e.strerror}) — "
              "sweep kept; JSON snapshot not written (nightly CSV snapshot still covers Feed)")
