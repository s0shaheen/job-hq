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


#: Tabs that are never written to git, because their contents are not ours to
#: publish and a snapshot is forever.
#:
#: ``scout_prefs`` is a free-text tab a human fills in. In practice that human
#: pasted an email address, a home address, a phone number and a **live account
#: password** into it, and the nightly job faithfully committed all of it seven
#: times. Nothing validates a free-text tab, and nothing ever will — so the tab
#: does not get committed.
#:
#: ``email_events`` holds sender, subject and snippet for real email, which is
#: third-party personal data that no backup requirement justifies keeping in
#: perpetuity. It is also derived: Gmail is the source of truth and capture
#: rebuilds it.
#:
#: Both remain fully backed up by Sheets' own version history. Removing a name
#: from this set is a deliberate decision to publish that tab's contents.
NEVER_SNAPSHOT = frozenset({"scout_prefs", "email_events"})


def run(hq: HQ, out_dir: Path) -> dict[str, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    for logical in schema.TABS:
        if logical in NEVER_SNAPSHOT:
            continue
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
