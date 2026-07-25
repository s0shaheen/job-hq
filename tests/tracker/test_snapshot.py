import csv

import pytest

from core import schema
from core.fakes import fake_hq
from tracker import snapshot


@pytest.fixture(autouse=True)
def no_bucket(monkeypatch):
    """These are the git-mode tests; a stray S3 bucket in the env would divert every write."""
    monkeypatch.delenv(snapshot.S3_BUCKET_ENV, raising=False)


def test_every_tab_snapshotted_with_full_values(tmp_path):
    hq = fake_hq()
    hq.tab("pipeline").append_records([{"key": "greenhouse-1", "company": "Plaid",
                                        "notes": "has, comma"}])
    counts = snapshot.run(hq, tmp_path / "snaps")
    assert set(counts) == set(schema.TABS) - snapshot.NEVER_SNAPSHOT
    assert counts["pipeline"] == 1
    with open(tmp_path / "snaps" / "pipeline.csv", newline="") as f:
        rows = list(csv.reader(f))
    assert rows[0] == schema.HEADERS["pipeline"]
    rec = dict(zip(rows[0], rows[1]))
    assert rec["key"] == "greenhouse-1" and rec["notes"] == "has, comma"


def test_secret_bearing_tabs_never_reach_disk(tmp_path):
    """The scout-prefs tab is free text a human fills in, and the human filled
    it in with a live account password, a home address and a phone number —
    which the nightly job then committed to git seven times. A snapshot is
    permanent, so tabs that can hold things we must not publish are simply not
    written. Nothing validates free text, so nothing can make this safe."""
    hq = fake_hq()
    out = tmp_path / "snaps"
    counts = snapshot.run(hq, out)
    for logical in snapshot.NEVER_SNAPSHOT:
        assert logical in schema.TABS, f"{logical} is not a real tab — stale exclusion"
        assert logical not in counts
        assert not (out / f"{logical}.csv").exists()


def test_heartbeat_written(tmp_path):
    hq = fake_hq()
    snapshot.run(hq, tmp_path / "snaps")
    beats = {r["key"] for r in hq.tab("config").records()}
    assert "heartbeat_snapshot" in beats
    # never the S3 lane's beat: nothing was uploaded, and a git run must not make the S3
    # copy look alive (tests/tracker/test_snapshot_s3.py owns the other direction)
    assert "heartbeat_snapshot_s3" not in beats


def test_rerun_overwrites_cleanly(tmp_path):
    hq = fake_hq()
    out = tmp_path / "snaps"
    snapshot.run(hq, out)
    hq.tab("pipeline").append_records([{"key": "lever-aaaaaaaa-1111-2222-3333-444444444444"}])
    counts = snapshot.run(hq, out)
    assert counts["pipeline"] == 1
    with open(out / "pipeline.csv", newline="") as f:
        assert len(list(csv.reader(f))) == 2      # header + 1 row, no stale leftovers
