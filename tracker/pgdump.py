"""Nightly `pg_dump` of the store's **public** schema into the versioned S3 bucket.

    python -m tracker.pgdump

WHY THIS EXISTS, AND WHY IT LOOKS LIKE `tracker.snapshot`
--------------------------------------------------------
`pgdump.yml` used to dump production and COMMIT the gzipped SQL into git, nightly.
PKT-DUMP-DISABLE closed that lane (FP-OPS-001: no database dump may enter git) and
`tests/core/test_workflows.py` now statically rejects any workflow that could bring
it back — `pg_dump` has no business in ANY Actions run block. The cost of closing it
was that the store had NO watched backup at all while `tracker.digest` kept watching
the `pgdump` lane, so under `HQ_PG_WRITES=first_class` its "HQ backups stale" page was
correct and unactionable. This is the replacement, and it is deliberately the SAME
shape as the S3 half of `tracker.snapshot`: Lambda writes straight to
`s3://<HQ_BACKUP_S3_BUCKET>/...` on a schedule AWS owns end to end, stable key, bucket
versioning IS the history. A backup whose only path to storage is the scheduler that
died is not a backup (Actions, 2026-07-24, 21 h of silence).

PUBLIC SCHEMA ONLY, and that is a security boundary, not a size optimisation.
Supabase's `auth` schema holds identities, sessions and refresh tokens. Those must
never leave the database into an object store, and a restore must not collide with
the schemas the platform manages. `--schema=public` is the only schema selector here
and `_reject_managed_schema_data` re-checks the produced bytes rather than trusting
the flag.

FAIL LOUD, NEVER STORE A BAD BACKUP. Four gates stand between `pg_dump` exiting 0 and
the heartbeat: the client must be major >= the server's (see `MIN_MAJOR`), the file
must be plausibly large, the gzip must decompress cleanly AND carry pg_dump's own
end-of-dump marker, and no managed-schema table data may appear. Only after the object
lands in S3 is the `pgdump` beat stamped. A beat reachable by a failed dump vouches for
a backup that does not exist, which is worse than no beat: it reads as coverage.
"""
from __future__ import annotations

import gzip
import os
import re
import subprocess
import tempfile
import zlib
from pathlib import Path

from core import beats, pgwrites

#: The database to dump. Same SSM parameter the deleted workflow used.
DB_URL_ENV = "SUPABASE_DB_URL"

#: The sink. Shared with `tracker.snapshot` on purpose — one backup bucket, one
#: lifecycle policy, one restore story (infra/terraform/backups.tf).
S3_BUCKET_ENV = "HQ_BACKUP_S3_BUCKET"

#: THE VERSIONED BINARY PATH, and this default is the whole lesson of PR #89.
#: The first live run against production (server 17.6) had `postgresql-client-17`
#: installed and `/usr/bin/pg_dump` still ran 16.14: on Debian/Ubuntu that path is
#: postgresql-common's perl wrapper and it resolves by CLUSTER, not by newest client.
#: pg_dump ABORTS when the server major exceeds the client's, so the unversioned name
#: is not merely unlucky, it is untrustworthy. The Lambda image builds 17 into
#: /opt/pg17 (infra/Dockerfile) and this points straight at the binary.
PGDUMP_BIN_ENV = "HQ_PGDUMP_BIN"
DEFAULT_PGDUMP_BIN = "/opt/pg17/bin/pg_dump"

#: The client major this lane refuses to run below. The server is Supabase 17.x; a 16
#: client does not produce a smaller dump, it produces no dump — but only after the
#: connection, which is late enough that a careless caller could treat the failure as
#: transient. Checked BEFORE connecting, so the refusal names the real cause.
MIN_MAJOR = 17

#: Size plausibility floor, in bytes of the COMPRESSED file. A schema-only or
#: connected-to-the-wrong-database dump is small; the real one is orders of magnitude
#: above this. Override per environment (the restore drill dumps a toy database).
MIN_BYTES_ENV = "HQ_PGDUMP_MIN_BYTES"
DEFAULT_MIN_BYTES = 50_000

#: Wall-clock ceiling for one dump. Lambda's own timeout is 900 s; stopping first
#: means the failure is this module's, with a message, rather than a killed runtime.
TIMEOUT_ENV = "HQ_PGDUMP_TIMEOUT_S"
DEFAULT_TIMEOUT_S = 600

#: pg_dump writes this as the last line of a COMPLETE plain-text dump. Its absence is
#: how a truncated upload (or a dump killed mid-stream) is caught: gzip alone can be
#: perfectly valid and still hold half a database.
COMPLETION_MARKER = "PostgreSQL database dump complete"

#: Schemas whose ROW DATA may never appear in an object-store backup. `auth` holds
#: identities, sessions and refresh tokens; `storage` and `vault` are the platform's
#: too. DDL cross-references (a foreign key to `auth.users`) are fine and expected —
#: this looks only for `COPY <schema>.` / `INSERT INTO <schema>.`, i.e. actual rows.
MANAGED_SCHEMAS = ("auth", "storage", "vault", "supabase_migrations")

#: The lane name. `core.beats.LANES` and `tracker.digest.PG_CADENCE_HOURS` already
#: carry it — they have been watching for a backup that did not exist since
#: PKT-DUMP-DISABLE. This is what makes that watch real.
HEARTBEAT = "pgdump"


#: THE key. Stable, and deliberately NOT per-user.
#:
#: `tracker.snapshot` writes `snapshots/<user>/<tab>.csv` because every user has their own
#: sheet. This lane does not: every user's rows live in the same `public` schema of the same
#: database. A per-user key would store N identical copies of one dump, cost N times as much,
#: and — worse — write N heartbeats for a backup that happened once, any one of which would
#: make the digest read healthy. One database, one object. The schedule agrees:
#: `local.system_jobs` in infra/terraform/main.tf keeps this job out of the per-user fan-out,
#: so there is exactly one lane however many users the registry grows.
#:
#: Bucket versioning is the history (backups.tf), so a restore is "give me the version from
#: the 3rd", not a date-stamped hunt through a listing the writer role may not even perform.
KEY = "pgdump/public.sql.gz"


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise RuntimeError(f"{name}={raw!r} is not an integer") from e


def check_client_major(binary: str) -> int:
    """Run `<binary> --version` and refuse anything below `MIN_MAJOR`.

    Deliberately executed against the RESOLVED path we are about to use, not against
    whatever `pg_dump` is on PATH: the two were different in production once already,
    and the one on PATH was the one that could not talk to the server."""
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True,
                             timeout=30, check=True).stdout
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(f"pg_dump not usable at {binary!r}: {e}") from e
    m = re.search(r"(\d+)(?:\.\d+)?", out)
    if not m:
        raise RuntimeError(f"could not read a version out of {out.strip()!r} ({binary})")
    major = int(m.group(1))
    if major < MIN_MAJOR:
        raise RuntimeError(
            f"{binary} is pg_dump {major}, need >= {MIN_MAJOR}: the server is 17.x and "
            f"pg_dump aborts when the server major exceeds the client's. Point "
            f"{PGDUMP_BIN_ENV} at the VERSIONED binary — an unversioned /usr/bin/pg_dump "
            f"is a wrapper that resolves to the wrong cluster (PR #89, server 17.6, "
            f"wrapper picked 16.14)")
    return major


def dump_argv(binary: str, out_path: Path) -> list[str]:
    """The exact command. Kept as one function so the restore drill in docs/RUNBOOK.md
    and the test that pins these flags read the same source as the lane does.

    `--schema=public` is the security boundary (see the module docstring).
    `--no-owner --no-privileges` because a restore lands in a THROWAWAY database owned
    by whoever is drilling, and role grants that do not exist there turn a restore into
    a wall of errors. `--compress=9` makes pg_dump emit the gzip itself, so there is no
    second process whose failure could be swallowed by a pipe."""
    return [binary, "--schema=public", "--no-owner", "--no-privileges",
            "--compress=9", f"--file={out_path}"]


def _run_dump(binary: str, db_url: str, out_path: Path, timeout_s: int) -> None:
    """Run the dump. The connection URI is the last ARGUMENT, and that is a considered
    choice rather than the lazy one.

    Passing it as `PGDATABASE` instead would keep the password out of the process table,
    which is worth wanting — but it does not work: libpq expands a URI only for a `dbname`
    that was supplied explicitly (`expand_dbname`), while environment defaults are filled
    in afterwards, so `PGDATABASE="postgresql://..."` is taken as a LITERAL database name.
    That change was written, unit-tested green against a fake subprocess, and would have
    failed against every real server — which is why the drill exists and why this comment
    does. Do not re-apply it without `scripts/restore-drill.sh` passing.

    What that leaves is one process's argv on a single-tenant Lambda runtime, for the
    seconds the dump runs. `_redact` keeps the string out of every failure path that
    anyone reads."""
    env = dict(os.environ)
    env.setdefault("PGSSLMODE", "require")   # never dump production over cleartext
    env["PGCONNECT_TIMEOUT"] = env.get("PGCONNECT_TIMEOUT", "30")
    try:
        proc = subprocess.run([*dump_argv(binary, out_path), db_url],
                              capture_output=True, text=True, timeout=timeout_s, env=env)
    except subprocess.TimeoutExpired as e:
        # `from None`, NOT `from e`, and that is the whole point of this except block.
        # `TimeoutExpired.__str__` interpolates `self.cmd`, and `self.cmd` is the argv
        # above — whose last element is the connection URI, password included. The
        # message raised here is clean, but Lambda prints the FULL traceback of an
        # unhandled exception including the `__cause__` chain, so `from e` publishes
        # the credential to CloudWatch on the lane's MOST LIKELY failure: the database
        # outgrowing this timeout (the same growth the ephemeral_storage note in
        # infra/terraform/main.tf plans for). Suppressed, and `e.stderr` is re-stated
        # through `_redact` so the diagnostic is not lost with it.
        # `e.stderr` is bytes on some timeout paths even under text=True (it is filled in
        # from the raw pipe when the child is killed), so it is decoded rather than
        # trusted to be a str — a TypeError here would replace the real diagnosis.
        err = e.stderr.decode("utf-8", "replace") if isinstance(e.stderr, bytes) else e.stderr
        raise RuntimeError(
            f"pg_dump exceeded {timeout_s}s ({TIMEOUT_ENV}); raise it, or the database "
            f"has outgrown one invocation: {_redact(err or '', db_url)}") from None
    if proc.returncode != 0:
        # stderr can echo the connection string on some failures; redact before it
        # reaches a log line, an ops push or a CloudWatch stream.
        raise RuntimeError(f"pg_dump exited {proc.returncode}: {_redact(proc.stderr, db_url)}")


def _redact(text: str, db_url: str) -> str:
    out = (text or "").strip()[:800]
    if db_url:
        out = out.replace(db_url, "<SUPABASE_DB_URL>")
    return re.sub(r"://[^/@\s]+@", "://<redacted>@", out)


def verify(path: Path, min_bytes: int) -> int:
    """Every gate between "pg_dump exited 0" and "this is a backup". Returns the
    uncompressed byte count.

    Order matters: cheapest first, and the completion marker last because it is the
    one that requires reading the whole stream. Each raises `RuntimeError`, because
    the caller's contract is that a failure leaves NO heartbeat."""
    size = path.stat().st_size if path.exists() else 0
    if size < min_bytes:
        raise RuntimeError(
            f"dump is implausibly small: {size} bytes < {min_bytes} ({MIN_BYTES_ENV}). "
            f"An empty or schema-only dump that gets stored looks exactly like a backup")
    raw = 0
    tail = b""
    carry = b""      # see below: a statement may straddle two reads
    try:
        with gzip.open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                raw += len(chunk)
                tail = (tail + chunk)[-4096:]
                # Scan `carry + chunk`, not `chunk`: a `COPY auth.` split across a read
                # boundary is invisible to a per-chunk search, and the scan that misses
                # it is the one guarding session tokens. 64 bytes is comfortably longer
                # than the longest statement prefix this looks for.
                _reject_managed_schema_data(carry + chunk)
                carry = chunk[-64:]
    # A half-written gzip surfaces three different ways depending on where it was cut:
    # BadGzipFile (an OSError) on a bad header, zlib.error on a bad CRC, and a bare
    # EOFError when the stream simply stops. Catching only OSError leaves the most
    # likely one — a truncated upload — propagating as an unhandled EOFError.
    except (OSError, EOFError, zlib.error) as e:
        raise RuntimeError(f"dump failed its gzip integrity check: {e}") from e
    if COMPLETION_MARKER not in tail.decode("utf-8", "replace"):
        raise RuntimeError(
            f"dump does not end with {COMPLETION_MARKER!r} — it is truncated. "
            f"Valid gzip is not the same as a complete dump")
    return raw


def _reject_managed_schema_data(chunk: bytes) -> None:
    """Refuse ROW DATA from a schema this lane must never copy out of the database.

    A belt to `--schema=public`'s braces: the flag is one edit away from being widened
    by someone who wants "the whole database", and the thing that edit would exfiltrate
    is every user's session and refresh token.

    SCOPE, stated so nobody mistakes this for a parser: the match is literal and exact, so
    `COPY "auth".`, a doubled space, a lowercase `copy`, or a newline between the keyword and
    the name would all pass. None of those spellings is producible by `pg_dump`, which emits
    exactly `COPY auth.refresh_tokens (...) FROM stdin;` — this is hardening against the
    widened-flag mistake, not a defence against an attacker choosing the dump's bytes. If
    something can choose those bytes, it already had the database."""
    text = chunk.decode("utf-8", "replace")
    for schema in MANAGED_SCHEMAS:
        for stmt in (f"COPY {schema}.", f"INSERT INTO {schema}."):
            if stmt in text:
                raise RuntimeError(
                    f"dump contains {schema} row data ({stmt.strip()}...). The backup "
                    f"is public-schema only: {schema} holds platform-managed data that "
                    f"must not leave the database")


def _upload(bucket: str, key: str, path: Path) -> None:
    """Same idiom, and the same posture, as `tracker.snapshot._upload`: boto3 is
    imported here because it ships in the Lambda image and is deliberately NOT in
    requirements.txt, and a failed upload RAISES so the run reports dead."""
    import boto3
    s3 = boto3.client("s3")
    try:
        s3.upload_file(str(path), bucket, key)
    except Exception as e:
        raise RuntimeError(f"backup upload failed: s3://{bucket}/{key}: {e}") from e


def _beat() -> None:
    """Stamp `pgdump` in the store, and ONLY here — after the object landed.

    There is no sheet beat for this lane and there never was: its product is a pg dump
    and nothing writes a Config row for it (`tracker.digest.PG_CADENCE_HOURS` says so).
    Under Phase A (`HQ_PG_WRITES` unset) nothing is written at all and nothing reads
    it either, which is why that is silent rather than a lie."""
    if pgwrites.first_class():
        beats.write(HEARTBEAT, pgwrites.user_id())


def run() -> dict[str, int | str]:
    """Dump -> verify -> upload -> beat. Returns a small summary for the log line."""
    db_url = (os.environ.get(DB_URL_ENV) or "").strip()
    if not db_url:
        raise RuntimeError(f"{DB_URL_ENV} is unset — refusing to guess a database")
    bucket = (os.environ.get(S3_BUCKET_ENV) or "").strip()
    if not bucket:
        raise RuntimeError(
            f"{S3_BUCKET_ENV} is unset. This lane has exactly one sink and it is the "
            f"versioned S3 bucket; there is no local or git fallback by design "
            f"(FP-OPS-001)")
    binary = (os.environ.get(PGDUMP_BIN_ENV) or "").strip() or DEFAULT_PGDUMP_BIN
    min_bytes = _int_env(MIN_BYTES_ENV, DEFAULT_MIN_BYTES)
    timeout_s = _int_env(TIMEOUT_ENV, DEFAULT_TIMEOUT_S)

    major = check_client_major(binary)
    key = KEY
    # Lambda's filesystem is read-only outside /tmp, and the dump is not meant to
    # outlive the invocation anyway: the bucket, not the FS, is where this lands.
    with tempfile.TemporaryDirectory(prefix="hq-pgdump-") as tmp:
        path = Path(tmp) / "public.sql.gz"
        _run_dump(binary, db_url, path, timeout_s)
        raw = verify(path, min_bytes)
        size = path.stat().st_size
        _upload(bucket, key, path)
    print(f"[pgdump] pg_dump {major}: {size} bytes gz ({raw} raw) "
          f"-> s3://{bucket}/{key}")
    _beat()          # last, and only here: the beat means "the object landed"
    return {"bytes": size, "raw_bytes": raw, "key": key, "client_major": major}


def main() -> int:
    run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
