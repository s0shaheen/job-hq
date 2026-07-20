"""Nightly CSV snapshot of every HQ tab into git.

    python -m tracker.snapshot [--out DIR]

Sheets version history is the second line of defense; a diffable snapshot the
owner controls is the first — restores from any human catastrophe without a
Mac. The calling workflow commits snapshots/<user>/*.csv.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from core import config, schema
from core.sheets import HQ


def run(hq: HQ, out_dir: Path) -> dict[str, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    for logical in schema.TABS:
        values = hq.tab(logical).ws.get_all_values()
        with open(out_dir / f"{logical}.csv", "w", newline="") as f:
            csv.writer(f).writerows(values)
        counts[logical] = max(0, len(values) - 1)   # data rows, header excluded
    hq.heartbeat("snapshot")
    return counts


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m tracker.snapshot")
    ap.add_argument("--out", default="")   # default resolves per user below
    args = ap.parse_args()
    hq = HQ.open()
    # snapshots/<user>/ so matrix legs never overwrite each other's backup
    out = Path(args.out) if args.out else (
        config.REPO_ROOT / "snapshots" / (hq.user or "hq"))
    counts = run(hq, out)
    print("[snapshot] " + "  ".join(f"{k}:{v}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
