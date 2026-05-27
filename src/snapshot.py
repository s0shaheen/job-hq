from __future__ import annotations
import json
from dataclasses import asdict

from src.models import JobRecord


def write_snapshot(path: str, profile_name: str, history: dict[str, JobRecord]) -> None:
    jobs = [asdict(r) for r in sorted(history.values(), key=lambda r: r.id)]
    data = {"profile": profile_name, "count": len(jobs), "jobs": jobs}
    with open(path, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
