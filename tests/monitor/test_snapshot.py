import errno
import json

import pytest

from monitor.models import JobRecord
from monitor.snapshot import write_snapshot

_HISTORY = {"greenhouse-1": JobRecord("greenhouse-1", "Stripe", "PM", "NYC",
                                     "http://x", "New", "2026-07-13", "2026-07-13")}


def _raise(err):
    def fake_open(*a, **k):
        raise OSError(err, "boom")
    return fake_open


def test_read_only_filesystem_warns_but_does_not_fail(monkeypatch, capsys):
    # AWS Lambda's /var/task: a completed sweep must not be reported dead over its backup copy
    monkeypatch.setattr("builtins.open", _raise(errno.EROFS))
    write_snapshot("/var/task/monitor/snapshots/hq.json", "hq", _HISTORY)
    assert "Feed snapshot skipped" in capsys.readouterr().out


def test_other_oserrors_still_raise(monkeypatch):
    monkeypatch.setattr("builtins.open", _raise(errno.ENOSPC))   # a full disk is a real failure
    with pytest.raises(OSError):
        write_snapshot("/tmp/hq.json", "hq", _HISTORY)


def test_write_snapshot(tmp_path):
    history = _HISTORY
    path = tmp_path / "hq.json"
    write_snapshot(str(path), "hq", history)
    data = json.loads(path.read_text())
    assert data["feed"] == "hq"
    assert data["count"] == 1
    assert data["jobs"][0]["id"] == "greenhouse-1"
