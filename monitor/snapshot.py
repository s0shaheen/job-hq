"""Git-diffable JSON snapshot of feed history — the restore line of defense
the sheet's version history can't give us (owner-controlled, one commit away)."""
from __future__ import annotations
import json
from dataclasses import asdict

from monitor.models import JobRecord


def write_snapshot(path: str, label: str, history: dict[str, JobRecord]) -> None:
    jobs = [asdict(r) for r in sorted(history.values(), key=lambda r: r.id)]
    data = {"feed": label, "count": len(jobs), "jobs": jobs}
    with open(path, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
