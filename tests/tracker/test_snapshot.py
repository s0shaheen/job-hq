import csv

from core import schema
from core.fakes import fake_hq
from tracker import snapshot


def test_every_tab_snapshotted_with_full_values(tmp_path):
    hq = fake_hq()
    hq.tab("pipeline").append_records([{"key": "greenhouse-1", "company": "Plaid",
                                        "notes": "has, comma"}])
    counts = snapshot.run(hq, tmp_path / "snaps")
    assert set(counts) == set(schema.TABS)
    assert counts["pipeline"] == 1
    with open(tmp_path / "snaps" / "pipeline.csv", newline="") as f:
        rows = list(csv.reader(f))
    assert rows[0] == schema.HEADERS["pipeline"]
    rec = dict(zip(rows[0], rows[1]))
    assert rec["key"] == "greenhouse-1" and rec["notes"] == "has, comma"


def test_heartbeat_written(tmp_path):
    hq = fake_hq()
    snapshot.run(hq, tmp_path / "snaps")
    assert any(r["key"] == "heartbeat_snapshot" for r in hq.tab("config").records())


def test_rerun_overwrites_cleanly(tmp_path):
    hq = fake_hq()
    out = tmp_path / "snaps"
    snapshot.run(hq, out)
    hq.tab("pipeline").append_records([{"key": "lever-aaaaaaaa-1111-2222-3333-444444444444"}])
    counts = snapshot.run(hq, out)
    assert counts["pipeline"] == 1
    with open(out / "pipeline.csv", newline="") as f:
        assert len(list(csv.reader(f))) == 2      # header + 1 row, no stale leftovers
