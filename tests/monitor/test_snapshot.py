import json
from monitor.models import JobRecord
from monitor.snapshot import write_snapshot


def test_write_snapshot(tmp_path):
    history = {"gh-1": JobRecord("gh-1", "Stripe", "PM", "NYC", "http://x", "New", "2026-05-26", "2026-05-26")}
    path = tmp_path / "snap.json"
    write_snapshot(str(path), "pm", history)
    data = json.loads(path.read_text())
    assert data["profile"] == "pm"
    assert data["count"] == 1
    assert data["jobs"][0]["id"] == "gh-1"
