"""No database dump enters this repository — asserted over the tracked BLOBS.

`tests/core/test_workflows.py` reads workflow YAML and `tests/test_runjob.py` reads the
Actions fallback lane. Both check the ROUTES a dump could travel. This file checks the
DESTINATION, which is the only claim that stays true when the route is one nobody
anticipated: a hand-run `pg_dump`, an `git add -f` of a debugging artifact, a restored
`pgdump.yml` from history, a future lane that writes somewhere new.

The rule (FP-OPS-001, PKT-DUMP-DISABLE): exactly ONE dump blob is tracked — the preserved
incident evidence at `snapshots/pg/hq.sql.gz` — and it is frozen. Its content hash is
pinned below, so a NEW nightly dump landing on the same path fails here even though the
path did not change, which is exactly the shape the old lane's commits had.

Deleting that evidence and rotating `SUPABASE_DB_URL` is a separate owner-approved packet
(docs/pilot-launch/packets/00-baseline-and-containment.md). When it happens, this file's
expectation becomes "no dump blob at all" — delete `FROZEN_EVIDENCE`, do not re-pin a new
hash.

MUTATION TARGETS: commit any `.sql`/`.sql.gz`/`.dump` file anywhere -> the sweep fails;
overwrite `snapshots/pg/hq.sql.gz` with a fresh dump -> the hash pin fails.
"""
import hashlib
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

#: The one tracked dump, and its sha256 as of PKT-DUMP-DISABLE. A hash and not a size:
#: a nightly dump of the same database is within a few percent of the old one's size, so
#: a size check is a guard that passes on the exact thing it exists to catch.
FROZEN_EVIDENCE = {
    "snapshots/pg/hq.sql.gz":
        "5c9fa0975a8361338073b5a41d51df32c2ff4421f1f42451544b2a47ae114874",
}

#: EVERY tracked file is opened — there is no extension allowlist and no size threshold.
#: Both were tried and both are escapes: a dump renamed `notes.txt` is still a dump, and a
#: dump of a young database is small. 969 files at 8 KB each is well under a second, which
#: is a cheaper price than a guard with a documented way around it.

#: What pg_dump actually writes, and the reason it is THIS line rather than the obvious
#: "-- PostgreSQL database dump" banner: that banner appears in prose, in `tracker/pgdump.py`
#: (which asserts the dump's closing twin) and in this file's own docstring, so a scan for it
#: flags three source files and the guard becomes a thing people disable. `Dumped by pg_dump
#: version` is emitted by every plain dump and by nothing that talks about one.
#:
#: Split so this file does not match its own literal — a self-flagging guard is the same
#: false positive one level up. `PGDMP` is the magic of the custom/directory formats, so
#: switching `--format` is not an escape either.
PLAIN_BANNER = b"-- Dumped by " + b"pg_dump version"
CUSTOM_MAGIC = b"PGDMP"


#: Directories a walk must not descend into when git is unavailable. Build output and
#: caches, never source — a dump hiding in one of these is a dump nobody committed.
_UNWALKED = {".git", "node_modules", ".next", "__pycache__", ".pytest_cache", ".venv",
             ".ruff_cache", ".mypy_cache", "test-results", "playwright-report",
             "dist", "build", ".turbo", "worktrees"}


def _tracked() -> list[str]:
    """Every file git tracks — or, where git cannot answer, every file in the tree.

    `-c safe.directory=*` because the verification image mounts this repo at /repo and
    runs as root, and git refuses a repository owned by another uid with exit 128. That
    is not hypothetical: the first version of this file used a plain `git ls-files`, was
    green on the laptop, and failed the moment it ran inside `scripts/verify.sh --image`.

    The fallback is a walk, and it is deliberately WIDER than git's answer rather than
    narrower: if git cannot tell us what is committed, "there is a dump sitting in the
    working tree" is still the finding this file exists to report. A guard that silently
    degrades to checking nothing is the failure mode being avoided here.
    """
    try:
        out = subprocess.run(["git", "-c", "safe.directory=*", "ls-files", "-z"],
                             cwd=REPO, check=True, capture_output=True, text=True).stdout
        return [p for p in out.split("\0") if p]
    except (OSError, subprocess.CalledProcessError):
        found = []
        for path in REPO.rglob("*"):
            if not path.is_file():
                continue
            if _UNWALKED & set(path.relative_to(REPO).parts):
                continue
            found.append(str(path.relative_to(REPO)))
        return found


def _head(path: Path, n: int = 8192) -> bytes:
    """First `n` bytes, transparently decompressing gzip — a dump's identity does not
    change because someone piped it through gzip, which is how the old lane stored it.

    GZIP ONLY, deliberately. xz, zstd, bzip2, a zip, or base64 in a text file would all get
    past this. That is proportionate to the threat this file exists for: the defect was a
    nightly job committing `.sql.gz`, not an adversary smuggling the database out of a repo
    they can already read. Widening it is cheap if the threat model ever changes; pretending
    it is already wide is what would be expensive."""
    raw = path.read_bytes()[: 4 * 1024 * 1024]
    if raw[:2] == b"\x1f\x8b":
        import gzip
        try:
            return gzip.decompress(raw[: 1024 * 1024])[:n]
        except (OSError, EOFError):        # truncated read of a valid member
            import zlib
            try:
                return zlib.decompressobj(31).decompress(raw, n)
            except zlib.error:
                return b""
    return raw[:n]


def _is_dump(path: str) -> bool:
    """Decided by CONTENT, so `db/migrations/0001_init.sql` passes (authored schema, no
    pg_dump banner) and a dump renamed `notes.txt` does not escape."""
    blob = REPO / path
    if not blob.is_file():
        return False
    head = _head(blob)
    return PLAIN_BANNER in head or head[:5] == CUSTOM_MAGIC


def test_the_only_tracked_dump_is_the_frozen_evidence():
    """A second dump blob is a dump that entered git, whatever route it took."""
    found = sorted(p for p in _tracked() if _is_dump(p))
    assert found == sorted(FROZEN_EVIDENCE), (
        f"tracked dump-shaped files are {found}; expected only {sorted(FROZEN_EVIDENCE)}. "
        f"No database dump may enter this repository (FP-OPS-001) — the backup lane writes "
        f"to the versioned S3 bucket (tracker/pgdump.py)")


@pytest.mark.parametrize("rel,expected", sorted(FROZEN_EVIDENCE.items()))
def test_the_frozen_evidence_has_not_been_rewritten(rel, expected):
    """The path-based test above cannot see a nightly dump committed OVER the evidence —
    same filename, new database contents, which is precisely what the old lane did every
    night. The hash can."""
    blob = REPO / rel
    assert blob.exists(), (
        f"{rel} is gone. If the containment packet deleted it, delete its entry from "
        f"FROZEN_EVIDENCE too — do not re-pin a replacement")
    digest = hashlib.sha256(blob.read_bytes()).hexdigest()
    assert digest == expected, (
        f"{rel} changed ({digest[:16]}... != {expected[:16]}...). A dump was written into "
        f"the repository. Backups go to S3; this file is frozen incident evidence")


def test_the_file_list_survives_git_being_unavailable():
    """The fallback is the interesting half: with git broken this must still enumerate
    the tree, not return an empty list. An empty list makes every assertion above pass.

    MUTATION: make `_tracked` return `[]` on the exception path -> this fails, and so does
    nothing else, which is precisely why it is asserted separately."""
    real = subprocess.run

    def broken(argv, **kw):
        if argv and argv[0] == "git":
            raise FileNotFoundError("git")
        return real(argv, **kw)

    orig = subprocess.run
    subprocess.run = broken
    try:
        walked = _tracked()
    finally:
        subprocess.run = orig
    assert "snapshots/pg/hq.sql.gz" in walked, "the fallback walk found nothing"
    assert any(p.startswith("tracker/") for p in walked), "the fallback skipped source"
    assert not any(".git/" in p or "node_modules" in p for p in walked), \
        "the fallback descended into a directory it must skip"
    assert sorted(p for p in walked if _is_dump(p)) == sorted(FROZEN_EVIDENCE), \
        "the walk disagrees with git about which blobs are dumps"


def test_the_dump_evidence_is_not_growing_a_directory_of_friends():
    """The old lane's product was one path. A new lane that keeps date-stamped dumps would
    put them next to it, and every one of them would be dump-shaped only if it kept the
    extension — so count the directory instead of trusting the suffix list."""
    entries = sorted(p for p in _tracked() if p.startswith("snapshots/pg/"))
    assert entries == ["snapshots/pg/hq.sql.gz"], \
        f"snapshots/pg/ holds {entries}; it is a frozen single-file exhibit"
