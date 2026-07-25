"""Git-diffable JSON snapshot of feed history — the restore line of defense
the sheet's version history can't give us (owner-controlled, one commit away)."""
from __future__ import annotations
import errno
import json
from dataclasses import asdict

from monitor.models import JobRecord


def write_snapshot(path: str, label: str, history: dict[str, JobRecord]) -> None:
    jobs = [asdict(r) for r in sorted(history.values(), key=lambda r: r.id)]
    data = {"feed": label, "count": len(jobs), "jobs": jobs}
    try:
        with open(path, "w") as f:
            json.dump(data, f, indent=2, sort_keys=True)
    except OSError as e:
        # Read-only filesystem (AWS Lambda's /var/task): there is no repo to commit into from
        # there, and the nightly CSV snapshot still backs up the Feed tab. Warn loudly, but never
        # fail a completed sweep over its backup copy — that would report the whole run as dead.
        if e.errno not in (errno.EROFS, errno.EACCES):
            raise
        print(f"::warning title=Feed snapshot skipped::{path} is read-only ({e.strerror}) — "
              "sweep kept; JSON snapshot not written (nightly CSV snapshot still covers Feed)")
