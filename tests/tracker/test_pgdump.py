"""The store's backup lane: pg_dump -> versioned S3, never git.

The lane it replaces committed production dumps into the repository until
PKT-DUMP-DISABLE closed it (FP-OPS-001), and closing it left the store with no
watched backup while `tracker.digest` kept watching the `pgdump` beat. So these
tests pin the properties that make the replacement worth trusting, each of which
is a way a backup lane lies:

  * it dumps the PUBLIC schema and nothing else — `auth` holds identities,
    sessions and refresh tokens, and those may not reach an object store;
  * it refuses a pg_dump older than the server BEFORE connecting, because the
    unversioned wrapper resolving to 16 against a 17.6 server is a thing that
    actually happened in production (PR #89);
  * every failure path — small file, bad gzip, truncated dump, managed-schema
    rows, failed upload — raises AND leaves no heartbeat. A beat reachable by a
    failed dump vouches for a backup that does not exist;
  * the beat is stamped only after the object landed, and only in the store,
    which is where `tracker.digest` looks for it.

MUTATION TARGETS (each kills exactly one test below):
  * widen `dump_argv` to `--schema=*` or drop the flag -> the argv test, and the
    managed-schema test once auth rows appear;
  * lower `MIN_MAJOR` to 16 -> the stale-client test;
  * move `_beat()` above `_upload()` -> every "no heartbeat" test;
  * make `verify` warn instead of raise -> the three corruption tests;
  * drop the redaction in `_run_dump` -> the secret-in-the-error test.
"""
import gzip
import subprocess
import sys
import types
from pathlib import Path

import pytest

from tracker import pgdump

DB_URL = "postgresql://postgres:hunter2@db.example.supabase.co:5432/postgres"
BUCKET = "job-hq-backups-123"

BODY = (
    "--\n-- PostgreSQL database dump\n--\n"
    "CREATE TABLE public.applications (id uuid);\n"
    "COPY public.applications (id) FROM stdin;\n\\.\n"
    + "-- filler so the size gate has something to weigh\n" * 400
    + "--\n-- PostgreSQL database dump complete\n--\n"
)


class FakeS3:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.uploads: list[tuple[str, str, bytes]] = []

    def upload_file(self, filename, bucket, key):
        if self.fail:
            raise RuntimeError("AccessDenied")
        self.uploads.append((bucket, key, Path(filename).read_bytes()))


@pytest.fixture
def s3(monkeypatch):
    fake = FakeS3()
    monkeypatch.setitem(sys.modules, "boto3",
                        types.SimpleNamespace(client=lambda name: fake))
    return fake


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv(pgdump.DB_URL_ENV, DB_URL)
    monkeypatch.setenv(pgdump.S3_BUCKET_ENV, BUCKET)
    monkeypatch.setenv(pgdump.PGDUMP_BIN_ENV, "/opt/pg17/bin/pg_dump")
    monkeypatch.delenv("HQ_USER", raising=False)
    monkeypatch.delenv(pgdump.MIN_BYTES_ENV, raising=False)


def fake_subprocess(monkeypatch, *, version="pg_dump (PostgreSQL) 17.6\n",
                    body: str = BODY, returncode: int = 0, stderr: str = "",
                    corrupt: bool = False):
    """Stand in for both `pg_dump --version` and the dump itself.

    Writes a REAL gzip file at the `--file=` path the module chose, so the verify
    gates run against bytes rather than against a mock's say-so."""
    calls: list[list[str]] = []

    def run(argv, **kw):
        calls.append(list(argv))
        if "--version" in argv:
            return subprocess.CompletedProcess(argv, 0, stdout=version, stderr="")
        out = Path(next(a for a in argv if a.startswith("--file="))[len("--file="):])
        if returncode == 0:
            data = gzip.compress(body.encode())
            out.write_bytes(data[:len(data) // 2] if corrupt else data)
        return subprocess.CompletedProcess(argv, returncode, stdout="", stderr=stderr)

    monkeypatch.setattr(pgdump.subprocess, "run", run)
    return calls


def no_beat(monkeypatch):
    """Any heartbeat write at all becomes a test failure."""
    monkeypatch.setattr(pgdump, "_beat",
                        lambda: pytest.fail("heartbeat written on a failed backup"))


# ------------------------------------------------------------------ the command

def test_the_dump_is_public_schema_only():
    """`auth` holds identities, sessions and refresh tokens. A dump that carries
    them into an object store is an exfiltration, not a backup — and a restore of
    one collides with the schemas Supabase manages."""
    argv = pgdump.dump_argv("/opt/pg17/bin/pg_dump", Path("/tmp/x.sql.gz"))
    schemas = [a for a in argv if a.startswith("--schema")]
    assert schemas == ["--schema=public"]
    assert "--no-owner" in argv and "--no-privileges" in argv


def test_the_dump_connects_over_TLS(monkeypatch, env, s3):
    """Supabase is reachable without TLS from nowhere that matters, but a default is a
    decision: an unset PGSSLMODE lets libpq fall back to a cleartext connection carrying
    the whole database. The drill overrides it to `disable` for a throwaway container,
    which is exactly why the DEFAULT has to be asserted here.

    (The connection URI is the last argv element, not PGDATABASE. That alternative is
    written up in `_run_dump`: libpq expands a URI only for an explicitly supplied
    dbname, so PGDATABASE would be read as a literal database name and every real dump
    would fail. It passed a fake-subprocess unit test before the drill caught it.)"""
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "100")
    monkeypatch.setattr(pgdump, "_beat", lambda: None)
    envs: list[dict] = []
    calls = fake_subprocess(monkeypatch)
    real = pgdump.subprocess.run

    def spy(argv, **kw):
        envs.append(kw.get("env") or {})       # per call: `--version` runs without one
        return real(argv, **kw)

    monkeypatch.setattr(pgdump.subprocess, "run", spy)
    pgdump.run()

    dump_at = next(i for i, c in enumerate(calls) if "--version" not in c)
    assert envs[dump_at]["PGSSLMODE"] == "require", \
        "production must not be dumped over a cleartext connection"
    assert calls[dump_at][-1] == DB_URL, "the dump connected to something else"


def test_a_client_older_than_the_server_is_refused_before_connecting(monkeypatch, env, s3):
    """PR #89, live, server 17.6: postgresql-client-17 was installed and
    /usr/bin/pg_dump still ran 16.14, because that path is a wrapper resolving by
    cluster. The refusal has to happen on the version check, not on the connection."""
    calls = fake_subprocess(monkeypatch, version="pg_dump (PostgreSQL) 16.14\n")
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError, match="pg_dump 16, need >= 17"):
        pgdump.run()
    assert all("--version" in c for c in calls), "connected anyway with a stale client"
    assert not s3.uploads


def test_a_missing_bucket_has_no_fallback(monkeypatch, env):
    monkeypatch.delenv(pgdump.S3_BUCKET_ENV, raising=False)
    with pytest.raises(RuntimeError, match="FP-OPS-001"):
        pgdump.run()


def test_a_missing_database_url_is_not_guessed(monkeypatch, env):
    monkeypatch.delenv(pgdump.DB_URL_ENV, raising=False)
    with pytest.raises(RuntimeError, match="refusing to guess"):
        pgdump.run()


# ------------------------------------------------------------------ the happy path

def test_a_good_dump_lands_on_a_stable_key_and_then_beats(monkeypatch, env, s3):
    beats: list[str] = []
    monkeypatch.setattr(pgdump, "_beat", lambda: beats.append(pgdump.HEARTBEAT))
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "100")
    fake_subprocess(monkeypatch)

    out = pgdump.run()

    assert [(b, k) for b, k, _ in s3.uploads] == [(BUCKET, "pgdump/public.sql.gz")]
    assert gzip.decompress(s3.uploads[0][2]).decode() == BODY
    assert out["key"] == "pgdump/public.sql.gz"
    assert beats == [pgdump.HEARTBEAT]


def test_the_key_is_NOT_per_user(monkeypatch, env, s3):
    """The sheet lane keys by user because each user has their own sheet. This one must
    not: every user's rows are in the same `public` schema of the same database, so a
    per-user key stores N identical dumps and — the part that actually hurts — writes N
    heartbeats for a backup that happened once. `local.system_jobs` keeps the schedule
    single for the same reason."""
    monkeypatch.setenv("HQ_USER", "salman")
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "100")
    monkeypatch.setattr(pgdump, "_beat", lambda: None)
    fake_subprocess(monkeypatch)
    pgdump.run()
    assert s3.uploads[0][1] == pgdump.KEY == "pgdump/public.sql.gz"


# ------------------------------------------------------------------ fail loud

def test_an_implausibly_small_dump_is_not_stored(monkeypatch, env, s3):
    """The gate exists for the dump that succeeds against the wrong database, or
    against a database whose tables are gone. Stored, it looks like a backup."""
    fake_subprocess(monkeypatch, body="-- PostgreSQL database dump complete\n")
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError, match="implausibly small"):
        pgdump.run()
    assert not s3.uploads


def test_a_corrupt_gzip_is_not_stored(monkeypatch, env, s3):
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "10")
    fake_subprocess(monkeypatch, corrupt=True)
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError, match="gzip integrity"):
        pgdump.run()
    assert not s3.uploads


def test_a_truncated_dump_is_not_stored(monkeypatch, env, s3):
    """Valid gzip is not a complete dump. pg_dump's own end marker is the proof."""
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "10")
    fake_subprocess(monkeypatch, body=BODY.replace(pgdump.COMPLETION_MARKER, "cut here"))
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError, match="truncated"):
        pgdump.run()
    assert not s3.uploads


def test_managed_schema_rows_are_refused_even_if_the_flag_was_widened(monkeypatch, env, s3):
    """The belt to `--schema=public`'s braces. Someone widens the flag to get "the
    whole database" and the thing that leaves is every session and refresh token."""
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "10")
    fake_subprocess(monkeypatch, body=BODY.replace(
        "COPY public.applications", "COPY auth.refresh_tokens"))
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError, match="auth row data"):
        pgdump.run()
    assert not s3.uploads


def test_managed_schema_rows_are_caught_across_a_read_boundary(monkeypatch, env, s3):
    """`verify` reads the stream in 1 MiB chunks. A per-chunk search misses a `COPY
    auth.` that straddles two of them, and a dump big enough for that to happen is
    every real dump. MUTATION: drop the `carry +` in `verify` -> this passes garbage
    through while the test above still goes green."""
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "10")
    stmt = "COPY auth.refresh_tokens (id, token) FROM stdin;\n"
    # Land the statement ACROSS the boundary rather than hoping: `verify` reads exactly
    # 1 MiB at a time, so start the statement five bytes before that mark and the first
    # read ends inside "COPY ".
    prefix = "-- filler\n" * 10_000
    prefix += " " * ((1 << 20) - 5 - len(prefix))
    body = prefix + stmt + f"--\n-- {pgdump.COMPLETION_MARKER}\n--\n"
    assert len(prefix.encode()) == (1 << 20) - 5
    fake_subprocess(monkeypatch, body=body)
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError, match="auth row data"):
        pgdump.run()
    assert not s3.uploads


def test_a_failed_upload_raises_and_leaves_no_heartbeat(monkeypatch, env):
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "100")
    monkeypatch.setitem(sys.modules, "boto3",
                        types.SimpleNamespace(client=lambda n: FakeS3(fail=True)))
    fake_subprocess(monkeypatch)
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError, match="backup upload failed"):
        pgdump.run()


def test_a_failing_pg_dump_never_reaches_the_bucket(monkeypatch, env, s3):
    fake_subprocess(monkeypatch, returncode=1, stderr="connection refused")
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError, match="pg_dump exited 1"):
        pgdump.run()
    assert not s3.uploads


def test_the_failure_message_does_not_carry_the_credentials(monkeypatch, env, s3):
    """CloudWatch, an ops push and a PR comment all end up holding this string."""
    fake_subprocess(monkeypatch, returncode=1,
                    stderr=f'pg_dump: error: connection to "{DB_URL}" failed')
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError) as e:
        pgdump.run()
    assert "hunter2" not in str(e.value)
    assert "<SUPABASE_DB_URL>" in str(e.value)


def test_no_failure_path_leaks_the_credentials_through_a_CHAINED_traceback(monkeypatch, env, s3):
    """`str(exc)` is not what CloudWatch gets. The Lambda runtime prints the FULL
    traceback of an unhandled exception, `__cause__` chain and all, so a redacted
    message raised `from` an exception that embeds the argv publishes the connection
    string anyway — the one above passes while the log holds `hunter2`.

    `subprocess.TimeoutExpired.__str__` interpolates `self.cmd`, and this module puts
    the URI in argv on purpose (see `_run_dump`). A timeout is also the MOST LIKELY
    failure of this lane: the documented growth story is "the database outgrew the
    600 s budget", which is the exact path that would print the credential.

    MUTATION: change `from None` back to `from e` in `_run_dump` -> this fails, and
    `test_the_failure_message_does_not_carry_the_credentials` still passes, which is
    why it is asserted separately and over `format_exception`."""
    import traceback

    def timing_out(argv, **kw):
        if "--version" in argv:
            return subprocess.CompletedProcess(argv, 0, stdout="pg_dump (PostgreSQL) 17.6\n",
                                               stderr="")
        # BYTES, not str: `subprocess.run` fills `TimeoutExpired.stderr` from the raw pipe
        # when it kills the child, so text mode does not guarantee a decoded string here.
        # A `str.replace` against bytes raises TypeError, which would replace the timeout
        # diagnosis with a traceback about the redactor — and that traceback carries argv.
        raise subprocess.TimeoutExpired(
            cmd=list(argv), timeout=kw.get("timeout", 600),
            stderr=f'pg_dump: error: connection to "{DB_URL}" was lost'.encode())

    monkeypatch.setattr(pgdump.subprocess, "run", timing_out)
    no_beat(monkeypatch)
    with pytest.raises(RuntimeError) as e:
        pgdump.run()

    # The positive first: this really is the timeout path, and the argv this test
    # claims to be worried about really did contain the secret. An absence check over
    # a run that never reached pg_dump would pass for every string at once.
    assert "exceeded" in str(e.value), f"not the timeout path: {e.value}"
    rendered = "".join(traceback.format_exception(type(e.value), e.value,
                                                  e.value.__traceback__))
    assert DB_URL in repr(pgdump.dump_argv("/opt/pg17/bin/pg_dump", Path("/tmp/x")) + [DB_URL]), \
        "the URI is no longer in argv, so this test is guarding nothing"
    assert "hunter2" not in rendered, (
        f"the connection password reaches CloudWatch through the exception chain:\n{rendered}")
    assert DB_URL not in rendered
    assert not s3.uploads


# ------------------------------------------------------------------ the watch is real

def test_the_beat_is_the_one_the_digest_has_been_watching():
    """PKT-DUMP-DISABLE left `pgdump` in both watch tables with nothing writing it,
    so the store's "HQ backups stale" page was correct and unactionable. This lane
    is what makes that watch mean something — if the names drift, it is a lie again."""
    from core import beats as core_beats
    from tracker import digest
    assert pgdump.HEARTBEAT in core_beats.LANES
    assert pgdump.HEARTBEAT in digest.PG_CADENCE_HOURS
    assert pgdump.HEARTBEAT in digest.BACKUP_BEATS, "it would print but never page"


def test_phase_a_writes_no_beat(monkeypatch, env, s3):
    """With HQ_PG_WRITES unset nothing reads pg beats, so writing one is noise."""
    from core import pgwrites
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "100")
    monkeypatch.setattr("core.pg.insert",
                        lambda *a, **k: pytest.fail("a pg beat with the flag unset"))
    fake_subprocess(monkeypatch)
    pgdump.run()
    assert s3.uploads


def test_first_class_beats_in_channel_runs(monkeypatch, env, s3):
    from core import pgwrites
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, "00000000-0000-0000-0000-000000000001")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    monkeypatch.setenv(pgdump.MIN_BYTES_ENV, "100")
    written: list[tuple[str, str]] = []
    monkeypatch.setattr("core.pg.insert", lambda table, rows, session=None:
                        written.append((table, rows[0]["channel"])))
    fake_subprocess(monkeypatch)
    pgdump.run()
    assert written == [("channel_runs", "pgdump")]


def test_the_lane_is_a_registered_lambda_job():
    """A module nothing schedules is a backup nobody takes."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "infra" / "app"))
    try:
        import handler
    finally:
        sys.path.pop(0)
    assert handler.JOBS["pgdump"] == [("tracker.pgdump", [])]
