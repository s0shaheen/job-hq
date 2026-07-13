import json
from monitor.models import JobRecord
from monitor.snapshot import write_snapshot


def test_write_snapshot(tmp_path):
    history = {"greenhouse-1": JobRecord("greenhouse-1", "Stripe", "PM", "NYC",
                                         "http://x", "New", "2026-07-13", "2026-07-13")}
    path = tmp_path / "hq.json"
    write_snapshot(str(path), "hq", history)
    data = json.loads(path.read_text())
    assert data["feed"] == "hq"
    assert data["count"] == 1
    assert data["jobs"][0]["id"] == "greenhouse-1"
