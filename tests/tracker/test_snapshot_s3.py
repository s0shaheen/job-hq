"""S3 backup sink — the copy that does not die when GitHub does.

The git copy silently stopped for 21 h on 2026-07-24 (Actions billing lapse) and nothing
noticed, so these tests pin the three properties that make the S3 copy trustworthy: every
non-excluded tab actually lands, a failed upload is loud (raises, no heartbeat) rather than a
backup that only looks like it happened, and the two lanes beat SEPARATELY — a shared
heartbeat would let the nightly Actions run keep it fresh while the S3 copy was dead, which is
the same silent death one layer up.
"""
import csv
import sys
import types

import pytest

from core import schema
from core.fakes import fake_hq
from tracker import snapshot


class FakeS3:
    """Records upload_file calls; optionally blows up like AccessDenied would."""

    def __init__(self, fail: bool = False):
        self.fail = fail
        self.uploads: list[tuple[str, str, str]] = []      # (bucket, key, file contents)

    def upload_file(self, filename, bucket, key):
        if self.fail:
            raise RuntimeError("AccessDenied")
        with open(filename, newline="") as f:
            self.uploads.append((bucket, key, f.read()))


@pytest.fixture
def s3(monkeypatch):
    """Installs a fake `boto3` module — the real one is not a repo dependency."""
    fake = FakeS3()
    monkeypatch.setitem(sys.modules, "boto3",
                        types.SimpleNamespace(client=lambda name: fake))
    return fake


def _beats(hq) -> set[str]:
    """Every snapshot-lane heartbeat the run left behind, by exact name."""
    return {r["key"] for r in hq.tab("config").records()
            if r.get("key", "").startswith("heartbeat_snapshot")}


def test_s3_mode_uploads_every_tab_and_writes_nothing_to_the_repo(monkeypatch, tmp_path, s3):
    monkeypatch.setenv(snapshot.S3_BUCKET_ENV, "job-hq-backups-123")
    hq = fake_hq()
    hq.tab("pipeline").append_records([{"key": "greenhouse-1", "company": "Plaid"}])
    out = tmp_path / "snaps"

    counts = snapshot.run(hq, out)

    expected = set(schema.TABS) - snapshot.NEVER_SNAPSHOT
    assert set(counts) == expected
    assert {k for _, k, _ in s3.uploads} == {f"snapshots/hq/{t}.csv" for t in expected}
    assert {b for b, _, _ in s3.uploads} == {"job-hq-backups-123"}
    assert not out.exists()                       # the repo path is never touched in S3 mode
    assert _beats(hq) == {"heartbeat_snapshot_s3"}   # its OWN lane, never the git lane's beat

    body = next(b for _, k, b in s3.uploads if k.endswith("/pipeline.csv"))
    rows = list(csv.reader(body.splitlines()))
    assert rows[0] == schema.HEADERS["pipeline"]
    assert dict(zip(rows[0], rows[1]))["key"] == "greenhouse-1"


def test_s3_keys_are_per_user(monkeypatch, tmp_path, s3):
    monkeypatch.setenv(snapshot.S3_BUCKET_ENV, "job-hq-backups-123")
    hq = fake_hq()
    hq.user = "salman"                            # multi-user: legs must not overwrite each other
    snapshot.run(hq, tmp_path / "snaps")
    assert all(k.startswith("snapshots/salman/") for _, k, _ in s3.uploads)


def test_never_snapshot_tabs_never_reach_s3(monkeypatch, tmp_path, s3):
    """A snapshot is forever, and S3 is no different from git on that count."""
    monkeypatch.setenv(snapshot.S3_BUCKET_ENV, "job-hq-backups-123")
    hq = fake_hq()
    snapshot.run(hq, tmp_path / "snaps")
    keys = {k for _, k, _ in s3.uploads}
    for logical in snapshot.NEVER_SNAPSHOT:
        assert logical in schema.TABS, f"{logical} is not a real tab — stale exclusion"
        assert f"snapshots/hq/{logical}.csv" not in keys


def test_upload_failure_raises_and_leaves_no_heartbeat(monkeypatch, tmp_path):
    """Fail loud: a backup that silently didn't happen is worse than none — it reads as one."""
    monkeypatch.setenv(snapshot.S3_BUCKET_ENV, "job-hq-backups-123")
    fake = FakeS3(fail=True)
    monkeypatch.setitem(sys.modules, "boto3", types.SimpleNamespace(client=lambda name: fake))
    hq = fake_hq()

    with pytest.raises(RuntimeError, match="backup upload failed"):
        snapshot.run(hq, tmp_path / "snaps")
    assert _beats(hq) == set()


def test_without_the_env_var_behaviour_is_unchanged(monkeypatch, tmp_path):
    monkeypatch.delenv(snapshot.S3_BUCKET_ENV, raising=False)
    exploding = types.SimpleNamespace(
        client=lambda name: pytest.fail("local run must never touch S3"))
    monkeypatch.setitem(sys.modules, "boto3", exploding)
    hq = fake_hq()
    out = tmp_path / "snaps"

    counts = snapshot.run(hq, out)

    assert set(counts) == set(schema.TABS) - snapshot.NEVER_SNAPSHOT
    assert (out / "pipeline.csv").exists()
    assert _beats(hq) == {"heartbeat_snapshot"}


def test_each_lane_beats_only_for_itself(monkeypatch, tmp_path, s3):
    """The bug this guards: one shared `heartbeat_snapshot` for both lanes. Actions runs the git
    copy nightly, so the shared beat would read fresh forever while the S3 copy was dead — the
    digest would say "backed up" and the 21 h silent outage of 2026-07-24 would be rebuilt one
    layer up. Two lanes, two beats, two independent liveness signals."""
    hq = fake_hq()
    monkeypatch.delenv(snapshot.S3_BUCKET_ENV, raising=False)
    snapshot.run(hq, tmp_path / "snaps")                       # git lane
    assert _beats(hq) == {"heartbeat_snapshot"}

    monkeypatch.setenv(snapshot.S3_BUCKET_ENV, "job-hq-backups-123")
    snapshot.run(hq, tmp_path / "snaps")                       # S3 lane, same instance
    assert _beats(hq) == {"heartbeat_snapshot", "heartbeat_snapshot_s3"}


def test_both_lanes_are_watched_by_the_digest():
    """A beat nobody watches is not a monitor. The names live in two modules, so pin them:
    dropping either from BACKUP_BEATS/CADENCE_HOURS silently un-monitors a whole backup."""
    from tracker import digest
    for beat in (snapshot.HEARTBEAT_GIT, snapshot.HEARTBEAT_S3):
        assert beat in digest.CADENCE_HOURS, f"{beat} is unwatched by the digest"
        assert beat in digest.BACKUP_BEATS, f"{beat} would print but never page"


# ------------------------------------------------- Phase C1: the same beat, in pg
#
# MUTATION TARGETS:
#   * drop the first_class guard in `_beat` -> the Phase-A test writes to a store
#     nobody enabled;
#   * write a single hard-coded lane name to pg -> the per-lane test finds the S3
#     run beating for the git lane, which is the shared-beat bug rebuilt in the
#     new store;
#   * make the pg beat best-effort -> the failure test reports a backup that only
#     looks like it happened, which is the whole reason this file exists.

def _first_class(monkeypatch):
    from core import pgwrites
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, "00000000-0000-0000-0000-000000000001")
    monkeypatch.setattr("core.pg.enabled", lambda: True)


def test_phase_a_writes_no_pg_beat(monkeypatch, tmp_path):
    from core import pgwrites
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.delenv(snapshot.S3_BUCKET_ENV, raising=False)
    monkeypatch.setattr("core.pg.insert",
                        lambda *a, **k: pytest.fail("a pg beat with the flag unset"))
    snapshot.run(fake_hq(), tmp_path / "snaps")


def test_each_lane_beats_for_itself_in_pg_too(monkeypatch, tmp_path, s3):
    """The shared-beat bug does not get to come back in the new store."""
    _first_class(monkeypatch)
    lanes = []
    monkeypatch.setattr("core.pg.insert",
                        lambda table, rows, session=None:
                        lanes.append((table, rows[0]["channel"])))

    monkeypatch.delenv(snapshot.S3_BUCKET_ENV, raising=False)
    snapshot.run(fake_hq(), tmp_path / "snaps")                # git lane
    monkeypatch.setenv(snapshot.S3_BUCKET_ENV, "job-hq-backups-123")
    snapshot.run(fake_hq(), tmp_path / "snaps")                # S3 lane
    assert lanes == [("channel_runs", snapshot.HEARTBEAT_GIT),
                     ("channel_runs", snapshot.HEARTBEAT_S3)]


def test_a_pg_beat_failure_fails_the_snapshot(monkeypatch, tmp_path):
    """Same posture as a failed S3 upload: a backup that silently did not record
    itself is worse than no backup, because it looks like one."""
    from core import pg
    _first_class(monkeypatch)
    monkeypatch.delenv(snapshot.S3_BUCKET_ENV, raising=False)

    def boom(*a, **k):
        raise pg.PgError("insert channel_runs -> HTTP 503")
    monkeypatch.setattr("core.pg.insert", boom)
    with pytest.raises(pg.PgError):
        snapshot.run(fake_hq(), tmp_path / "snaps")
