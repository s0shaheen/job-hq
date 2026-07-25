import errno
import json
import sys
import types

import pytest

import monitor.snapshot as snap
from monitor.models import JobRecord
from monitor.snapshot import write_snapshot

_HISTORY = {"greenhouse-1": JobRecord("greenhouse-1", "Stripe", "PM", "NYC",
                                     "http://x", "New", "2026-07-13", "2026-07-13")}


def _raise(err):
    def fake_open(*a, **k):
        raise OSError(err, "boom")
    return fake_open


@pytest.fixture(autouse=True)
def no_bucket(monkeypatch):
    """Default every test to the no-S3 world; the S3 tests opt in explicitly."""
    monkeypatch.delenv(snap.S3_BUCKET_ENV, raising=False)


class _FakeS3:
    def __init__(self, fail=False):
        self.fail = fail
        self.puts: list[dict] = []

    def put_object(self, **kw):
        if self.fail:
            raise RuntimeError("AccessDenied")
        self.puts.append(kw)


def _fake_boto3(monkeypatch, s3):
    # boto3 ships in the Lambda image but is not a repo dependency — tests only ever see this.
    monkeypatch.setitem(sys.modules, "boto3", types.SimpleNamespace(client=lambda n: s3))
    return s3


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


def test_read_only_filesystem_falls_back_to_s3(monkeypatch, capsys):
    monkeypatch.setenv(snap.S3_BUCKET_ENV, "job-hq-backups-123")
    s3 = _fake_boto3(monkeypatch, _FakeS3())
    monkeypatch.setattr("builtins.open", _raise(errno.EROFS))

    write_snapshot("/var/task/monitor/snapshots/hq.json", "hq", _HISTORY)

    assert len(s3.puts) == 1
    put = s3.puts[0]
    assert put["Bucket"] == "job-hq-backups-123" and put["Key"] == "feeds/hq.json"
    assert json.loads(put["Body"].decode())["jobs"][0]["id"] == "greenhouse-1"
    assert "Feed snapshot skipped" not in capsys.readouterr().out


def test_s3_upload_failure_warns_but_does_not_raise(monkeypatch, capsys):
    # The feed JSON is a convenience copy; a completed sweep must never die over it.
    monkeypatch.setenv(snap.S3_BUCKET_ENV, "job-hq-backups-123")
    _fake_boto3(monkeypatch, _FakeS3(fail=True))
    monkeypatch.setattr("builtins.open", _raise(errno.EROFS))

    write_snapshot("/var/task/monitor/snapshots/hq.json", "hq", _HISTORY)

    out = capsys.readouterr().out
    assert "Feed snapshot skipped" in out and "AccessDenied" in out


def test_local_write_never_touches_s3(monkeypatch, tmp_path):
    monkeypatch.setenv(snap.S3_BUCKET_ENV, "job-hq-backups-123")
    monkeypatch.setitem(sys.modules, "boto3", types.SimpleNamespace(
        client=lambda n: pytest.fail("a writable FS must not reach for S3")))
    path = tmp_path / "hq.json"
    write_snapshot(str(path), "hq", _HISTORY)
    assert json.loads(path.read_text())["count"] == 1
