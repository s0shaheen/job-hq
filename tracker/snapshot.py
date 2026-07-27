"""Nightly CSV snapshot of every HQ tab into git — or into S3.

    python -m tracker.snapshot [--out DIR]

Sheets version history is the second line of defense; a diffable snapshot the
owner controls is the first — restores from any human catastrophe without a
Mac. The calling workflow commits snapshots/<user>/*.csv.

With ``HQ_BACKUP_S3_BUCKET`` set (AWS Lambda, per infra/terraform/backups.tf)
the same CSVs go to s3://<bucket>/snapshots/<user>/<tab>.csv instead: Lambda's
FS is read-only outside /tmp and there is no repo to commit into anyway. The
two copies are deliberately independent — the git one died silently for 21 h
when GitHub Actions stopped running (billing, 2026-07-24), which is exactly the
outage a backup must not share.
"""
from __future__ import annotations

import argparse
import csv
import os
import tempfile
from pathlib import Path

from core import beats, config, pgwrites, schema
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
#: ``outbox`` is the first tab that carries RENDERED NOTIFICATION CONTENT — the
#: title and body of a push, verbatim, in `title`/`body` columns. Same rationale
#: as ``scout_prefs``: whatever a notification says about somebody's job search
#: ends up in it, and a git commit is forever. It is also short-lived working
#: state, not history worth restoring — a flushed queue is empty.
#:
#: All three remain fully backed up by Sheets' own version history. Removing a
#: name from this set is a deliberate decision to publish that tab's contents.
NEVER_SNAPSHOT = frozenset({"scout_prefs", "email_events", "outbox"})


#: Env var naming the S3 backup bucket. Set only on Lambda (backups.tf); unset
#: everywhere else, so local and Actions runs behave exactly as they always did.
S3_BUCKET_ENV = "HQ_BACKUP_S3_BUCKET"

#: One heartbeat per LANE, never one shared beat. The git copy (Actions) and the S3
#: copy (Lambda) are independent backups on independent schedulers, so their liveness
#: is independent too: a shared beat means the nightly Actions run refreshes it and the
#: digest reads "backed up" while the S3 lane has been dead for a week (and vice versa)
#: — rebuilding, one layer up, the exact silent-death failure this whole branch exists
#: to kill. Watched by tracker.digest's BACKUP_BEATS; both must be in CADENCE_HOURS.
#:
#: Under `HQ_PG_WRITES=first_class` each of these lands in BOTH stores under the same
#: lane name (`_beat` below), and the digest holds each store to the cadence on its
#: own — the same doctrine one level up (core/beats.py, tracker/digest.py).
HEARTBEAT_GIT = "snapshot"
HEARTBEAT_S3 = "snapshot_s3"


def _write_csvs(hq: HQ, out_dir: Path) -> tuple[dict[str, int], list[tuple[str, Path]]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    files: list[tuple[str, Path]] = []
    for logical in schema.TABS:
        if logical in NEVER_SNAPSHOT:
            continue
        values = hq.tab(logical).ws.get_all_values()
        path = out_dir / f"{logical}.csv"
        with open(path, "w", newline="") as f:
            csv.writer(f).writerows(values)
        counts[logical] = max(0, len(values) - 1)   # data rows, header excluded
        files.append((logical, path))
    return counts, files


def _upload(bucket: str, prefix: str, files: list[tuple[str, Path]]) -> None:
    """Push every tab CSV to s3://bucket/prefix/<tab>.csv.

    Stable keys on purpose: bucket versioning is the history, so a restore is
    "give me yesterday's version of pipeline.csv", not a date-stamped hunt.

    boto3 is imported here, not at module import: it ships in the Lambda image
    but is deliberately not in requirements.txt, so no local run or test may
    depend on it existing. A failed upload RAISES — the run reports dead and
    ops gets paged, because a backup that silently didn't happen is worse than
    no backup at all (it looks like one).
    """
    import boto3
    s3 = boto3.client("s3")
    for logical, path in files:
        key = f"{prefix}/{logical}.csv"
        try:
            s3.upload_file(str(path), bucket, key)
        except Exception as e:
            raise RuntimeError(f"backup upload failed: s3://{bucket}/{key}: {e}") from e


def _beat(hq: HQ, lane: str) -> None:
    """Stamp this lane in BOTH stores — Config, and (first_class) `channel_runs`.

    Same lane name in both, so the digest's watchdog compares like with like. The
    pg write is not best-effort: under first_class a beat that silently failed to
    land is a backup lane that reads dead on the day the sheet goes away, which is
    the failure this whole two-lane arrangement exists to remove.
    """
    hq.heartbeat(lane)
    if pgwrites.first_class():
        beats.write(lane, pgwrites.user_id())


def run(hq: HQ, out_dir: Path) -> dict[str, int]:
    bucket = os.environ.get(S3_BUCKET_ENV, "").strip()
    if not bucket:
        counts, _ = _write_csvs(hq, out_dir)
        _beat(hq, HEARTBEAT_GIT)
        return counts
    # S3 mode: stage under the tempdir (Lambda sets TMPDIR=/tmp, its only writable
    # path) and let it evaporate — the bucket, not the FS, is where this lands.
    with tempfile.TemporaryDirectory(prefix="hq-snapshot-") as tmp:
        counts, files = _write_csvs(hq, Path(tmp))
        _upload(bucket, f"snapshots/{hq.user or 'hq'}", files)
    print(f"[snapshot] {len(files)} tabs -> s3://{bucket}/snapshots/{hq.user or 'hq'}/")
    # Only after every tab landed: the heartbeat means "backed up". And it is the S3
    # lane's OWN beat — see HEARTBEAT_S3 above; writing the git lane's beat here would
    # let either scheduler cover for the other's death.
    _beat(hq, HEARTBEAT_S3)
    return counts


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m tracker.snapshot")
    ap.add_argument("--out", default="")   # default resolves per user below
    args = ap.parse_args()
    hq = HQ.open()
    # snapshots/<user>/ so matrix legs never overwrite each other's backup
    # (ignored in S3 mode — run() stages to a tempdir and uploads under the same per-user prefix)
    out = Path(args.out) if args.out else (
        config.REPO_ROOT / "snapshots" / (hq.user or "hq"))
    counts = run(hq, out)
    print("[snapshot] " + "  ".join(f"{k}:{v}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
