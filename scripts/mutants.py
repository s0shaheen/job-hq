#!/usr/bin/env python3
"""Run the pinned-mutant ledger: break each guard, watch its test go red, revert.

    scripts/mutants.py                  # the whole ledger
    scripts/mutants.py --list           # what is pinned, and by what
    scripts/mutants.py --dry-run        # validate the manifest and the patches
    scripts/mutants.py --only <id> ...  # one entry, while you are writing it

WHAT IT IS FOR. `tests/mutants/manifest.toml` holds the argument; this is the
part that executes it. For each entry: apply the mutation, run ONLY the named
tests, require them to go red, revert.

WHERE IT RUNS. In a scratch git worktree, never in yours. A runner that patches
the working tree and reverts it "afterwards" loses somebody's uncommitted work
the first time a test hangs and the run is killed, and this one is meant to be
run while you are mid-change.

THE FOUR RULES, and each is a failure mode rather than a preference:

  * A patch that no longer applies FAILS LOUDLY. It never skips. A skipped
    mutant is exactly the defect this ledger exists to catch, one level up.
  * A patch touching `tests/**` is refused at load time, before anything runs.
    Otherwise the cheapest way to satisfy the ledger is to break a test file.
  * A mutant whose named tests do not go red FAILS and names the guard. That
    result is the discovery worth having.
  * The number of failing CASES is asserted, not just "something failed". A
    mutation that reddens one of four parametrisations has found a partial
    guard, and only the count says so.

THE CONTROL. `[[control]]` entries are patches that must NOT redden anything --
the inert comment-only patch. The runner requires them to FAIL. Without that
inversion a green ledger is consistent with a runner that reports success
whatever it is handed.

THE GAPS. `[[gap]]` entries are properties nobody could pin because there is no
guard there yet to break. They run with the expectation inverted and are
reported as OPEN GAPS. The day the guard lands, the gap fails and has to be
promoted to a `[[mutant]]`. A gap is a recorded absence; it is not a skip.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LEDGER = REPO / "tests" / "mutants"
MANIFEST = LEDGER / "manifest.toml"
#: Re-applied by the pytest plugin after a `kind = "sql"` mutant. Every SQL
#: mutant in the ledger today belongs to this migration; a mutant against
#: another one adds a `restore` key rather than widening this.
#: A `kind = "sql"` mutant declares which migration OWNS the object it breaks,
#: and the plugin re-applies that migration to put it back. It is a glob rather
#: than a filename because `scripts/new-migration.sh` stamps a UTC timestamp onto
#: every name, and hard-coding one here would rot on the next rename.
#:
#: Defaulting this was a bug worth recording: with one hard-coded restore, the
#: `applications` mutant disabled a trigger that 0027 owns, the plugin re-applied
#: the AUTOPILOT migration, reported `restored = true`, and left the trigger off.
#: The schema is rebuilt per pytest process so nothing leaked, but the status the
#: runner trusts would have been a lie. A restore that names the wrong file is
#: not a restore.
DEFAULT_SQL_RESTORE = "*_autopilot_staging.sql"


def migration_matching(pattern: str) -> Path:
    hits = sorted((REPO / "db" / "migrations").glob(pattern))
    if not hits:
        raise ManifestError(
            f"restore = {pattern!r} matches no migration in db/migrations. "
            f"A sql mutant must name the migration that OWNS the object it breaks, "
            f"or the runner reports a restore it did not perform."
        )
    if len(hits) > 1:
        raise ManifestError(f"restore = {pattern!r} is ambiguous: {[h.name for h in hits]}")
    return hits[0]

IN_IMAGE = os.environ.get("HQ_TEST_IMAGE", "0") == "1"


def interpreters() -> dict[str, list[str]]:
    """The same two lanes `scripts/verify.sh` uses, resolved the same way.

    Inside the image both venvs are baked and resolve nothing. Outside it, the
    documented `uv` invocations, so this works with no Docker at all.
    """
    if IN_IMAGE:
        py311 = os.environ.get("HQ_PY311", "/opt/py311/bin/python")
        py312 = os.environ.get("HQ_PY312", "/opt/py312/bin/python")
        return {
            "pytest": [py311, "-m", "pytest"],
            "pytest312": [py312, "-m", "pytest"],
        }
    return {
        "pytest": [
            "uv", "run", "--python", "3.11",
            "--with-requirements", "requirements.txt",
            "--with", "psycopg[binary]", "--no-project", "--", "pytest",
        ],
        "pytest312": [
            "uv", "run", "--python", "3.12",
            "--with-requirements", "requirements.txt",
            "--with-requirements", "infra/render/requirements.txt",
            "--no-project", "--", "pytest",
        ],
    }


# ────────────────────────────────────────────────────────────── the manifest

@dataclass
class Entry:
    id: str
    role: str                     # mutant | control | gap
    kind: str                     # patch | sql
    runner: str                   # pytest | pytest312 | playwright
    property: str
    tests: list[str] = field(default_factory=list)
    spec: str = ""
    grep: str = ""
    failing: int = 0
    needs: list[str] = field(default_factory=list)
    guard: str = ""
    tier: str = ""
    patch: Path | None = None
    sql: Path | None = None
    restore: str = DEFAULT_SQL_RESTORE

    @property
    def must_redden(self) -> bool:
        """A mutant reddens. A control and a gap must not."""
        return self.role == "mutant"


class ManifestError(RuntimeError):
    pass


def _is_test_path(p: str) -> bool:
    parts = Path(p).parts
    if "tests" in parts or "test" in parts:
        return True
    name = Path(p).name
    return (
        name.startswith("test_")
        or name.endswith("_test.py")
        or name.endswith(".spec.ts")
        or name.endswith(".test.ts")
        or name.endswith(".spec.tsx")
        or name.endswith(".test.tsx")
    )


def patch_targets(text: str) -> list[str]:
    out: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^(?:---|\+\+\+) [ab]/(.+)$", line)
        if m and m.group(1) != "dev/null":
            out.append(m.group(1))
        m = re.match(r"^diff --git a/(\S+) b/(\S+)$", line)
        if m:
            out.extend(m.groups())
    return sorted(set(out))


def load(only: list[str] | None = None) -> list[Entry]:
    if not MANIFEST.exists():
        raise ManifestError(f"no manifest at {MANIFEST}")
    data = tomllib.loads(MANIFEST.read_text())
    entries: list[Entry] = []
    seen: set[str] = set()

    for role, key in (("mutant", "mutant"), ("control", "control"), ("gap", "gap")):
        for raw in data.get(key, []):
            eid = raw.get("id", "")
            if not eid:
                raise ManifestError(f"a [[{key}]] entry has no id")
            if eid in seen:
                raise ManifestError(f"duplicate entry id: {eid}")
            seen.add(eid)
            e = Entry(
                id=eid,
                role=role,
                kind=raw.get("kind", ""),
                runner=raw.get("runner", ""),
                property=" ".join(raw.get("property", "").split()),
                tests=list(raw.get("tests", [])),
                spec=raw.get("spec", ""),
                grep=raw.get("grep", ""),
                failing=int(raw.get("failing", 0)),
                needs=list(raw.get("needs", [])),
                guard=raw.get("guard", ""),
                tier=raw.get("tier", ""),
            )
            if not e.property:
                raise ManifestError(f"{eid}: every entry states its property in one line")
            if e.runner not in ("pytest", "pytest312", "playwright"):
                raise ManifestError(f"{eid}: unknown runner {e.runner!r}")
            if e.runner == "playwright":
                if not e.spec:
                    raise ManifestError(f"{eid}: a playwright entry names its spec file(s)")
            elif not e.tests:
                raise ManifestError(f"{eid}: names no tests, so it asserts nothing")

            if e.kind == "patch":
                e.patch = LEDGER / raw["patch"]
                if not e.patch.exists():
                    raise ManifestError(f"{eid}: no patch at {e.patch}")
                text = e.patch.read_text()
                if not text.strip():
                    raise ManifestError(f"{eid}: the patch is empty")
                targets = patch_targets(text)
                if not targets:
                    raise ManifestError(f"{eid}: the patch names no files")
                bad = [t for t in targets if _is_test_path(t)]
                if bad:
                    raise ManifestError(
                        f"{eid}: REFUSED. The patch touches a test file: {', '.join(bad)}.\n"
                        f"        A mutant proves a guard by breaking the GUARD. A patch that\n"
                        f"        edits a test satisfies this ledger while proving nothing, so\n"
                        f"        it is refused before anything runs."
                    )
            elif e.kind == "sql":
                e.sql = LEDGER / raw["sql"]
                if not e.sql.exists():
                    raise ManifestError(f"{eid}: no sql at {e.sql}")
                if not e.sql.read_text().strip():
                    raise ManifestError(f"{eid}: the sql mutant is empty")
                e.restore = raw.get("restore", DEFAULT_SQL_RESTORE)
                migration_matching(e.restore)   # resolves now, not mid-run
            else:
                raise ManifestError(f"{eid}: unknown kind {e.kind!r}")

            if e.role == "mutant" and e.failing <= 0:
                raise ManifestError(
                    f"{eid}: `failing` must say how many cases go red. "
                    f"'something failed' is the assertion this ledger exists to replace."
                )
            entries.append(e)

    if not any(e.role == "control" for e in entries):
        raise ManifestError(
            "the manifest has no [[control]]. Without an entry that must NOT redden, "
            "a green run is consistent with a runner that cannot tell."
        )
    if only:
        wanted = set(only)
        unknown = wanted - {e.id for e in entries}
        if unknown:
            raise ManifestError(f"--only names no such entry: {', '.join(sorted(unknown))}")
        entries = [e for e in entries if e.id in wanted]
    return entries


# ───────────────────────────────────────────────────────────── the scratch tree

#: Never copied into the scratch tree. Build output, caches and dependency trees
#: are not inputs to any test, and `.claude/worktrees` in the shared checkout
#: holds every other agent's copy of this entire repository.
NOT_AN_INPUT = {
    ".git", ".claude", "node_modules", ".next", "test-results", "playwright-report",
    "blob-report", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
    ".venv", ".turbo", ".vercel",
}
#: A file this big is not source. The shared checkout carries audio recordings.
MAX_COPIED_BYTES = 20 * 1024 * 1024


class Scratch:
    """A copy of your working tree, in /tmp, that no git command has to understand.

    IT IS A COPY AND NOT A `git worktree`, and that is the whole of the fix for
    the first landing attempt. `scripts/test-shell.sh` mounts the checkout into
    the verification image and says why in its own comment: "a worktree's .git is
    a FILE pointing into the parent checkout, so git inside the container would
    fail. Nothing here needs git." This runner needed git, so under
    `--full --image` — which is what `scripts/land.sh` runs — the ledger could
    not execute at all:

        fatal: not a git repository: /Users/.../.git/worktrees/agent-...

    A directory copy has no such opinion. `git apply` still applies the patches,
    but its cwd is INSIDE the scratch tree, which contains no `.git` of any kind,
    and git applies patches happily outside a repository.

    The copy is of the WORKING TREE, not of HEAD. The ledger is most useful while
    you are writing the guard, and a runner that tested HEAD would tell you about
    the guard you had an hour ago.
    """

    def __init__(self) -> None:
        self.path = Path(tempfile.mkdtemp(prefix="hq-mutants-"))
        self.tree = self.path / "tree"
        self.oversized: list[str] = []

    def create(self) -> None:
        self.tree.mkdir()
        for src_dir, dirnames, filenames in os.walk(REPO):
            rel_dir = Path(src_dir).relative_to(REPO)
            dirnames[:] = [
                d for d in dirnames
                if d not in NOT_AN_INPUT
                # A nested checkout or worktree. Copying one in would put another
                # branch's source inside this tree.
                and not (Path(src_dir) / d / ".git").exists()
            ]
            (self.tree / rel_dir).mkdir(parents=True, exist_ok=True)
            for name in filenames:
                # `.git` is a FILE in a linked worktree, pointing back into the
                # parent checkout, so pruning it out of `dirnames` alone misses
                # it — and copying it in makes the scratch tree claim to be a
                # repository whose git dir does not exist from here. That is the
                # exact `fatal: not a git repository` this class exists to avoid.
                if name in NOT_AN_INPUT:
                    continue
                src = Path(src_dir) / name
                if src.is_symlink() or not src.is_file():
                    continue
                try:
                    if src.stat().st_size > MAX_COPIED_BYTES:
                        self.oversized.append(str(rel_dir / name))
                        continue
                    shutil.copy2(src, self.tree / rel_dir / name)
                except OSError:
                    # A file that vanished mid-walk, or one this process cannot
                    # read. Neither is an input to a pinned guard.
                    continue
        # node_modules is ~1GB and is a function of the lockfile, so it is
        # borrowed rather than copied. Without it every browser mutant would fail
        # on "cannot find module" instead of on its mutation.
        for rel in ("webapp/node_modules", "node_modules"):
            src = REPO / rel
            if src.exists():
                dst = self.tree / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                if not dst.exists():
                    dst.symlink_to(src.resolve(), target_is_directory=True)
        self._warm_the_build_cache()

    def _warm_the_build_cache(self) -> None:
        """Carry `.next/cache` in, so `next build` is incremental rather than cold.

        WHY THIS AND NOT A BIGGER TIMEOUT. The browser mutant builds the app in
        the scratch tree, and a scratch tree starts with no `.next` at all. Inside
        the verification image, on a machine also running CI and two other agents,
        that cold build took 184s against a 180s budget, and then 783s against a
        600s one. Raising the number again would just move the cliff: the runner
        was fighting a cold compiler, and the verdict it produced — ERROR, "a
        fixture blew up" — is indistinguishable at a glance from a guard the
        mutation escaped. An infrastructure timeout must not be able to look like
        a finding.

        `.next/cache` ONLY, never the whole `.next`. Sharing a full `.next`
        between checkouts is a known failure in this repo (generated route types
        from another branch, which cost two agents a false diagnosis on
        2026-08-02); `scripts/test-shell.sh` keys its `.next` volume per checkout
        for exactly that reason. `cache` is the compiler's content-addressed
        store, which is what CI shares everywhere.

        COPIED, not symlinked, and that is the whole safety argument: the scratch
        build writes only to its own copy, so it can never corrupt the cache the
        host or the image volume is using, and two mutant runs cannot race.
        """
        src = REPO / "webapp" / ".next" / "cache"
        if not src.is_dir():
            return
        dst = self.tree / "webapp" / ".next" / "cache"
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True)
        except OSError:
            # A cold build is slow, not wrong. The webServer budget below is the
            # backstop, and this is an optimisation that is allowed to fail.
            pass

    def restore(self, rel_paths: list[str]) -> None:
        """Put the files a patch touched back the way your tree has them.

        Only the touched files, because that is exactly what changed: the scratch
        tree is a copy of the working tree, so the working tree IS the unmutated
        version of every one of them.
        """
        for rel in rel_paths:
            src, dst = REPO / rel, self.tree / rel
            if src.is_file():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            elif dst.exists():
                dst.unlink()

    def destroy(self) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


def run(cmd: list[str], *, cwd: Path, check: bool = False,
        env: dict | None = None, timeout: int | None = None) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, env=env, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(
            f"command failed ({r.returncode}): {' '.join(cmd)}\n{r.stdout}\n{r.stderr}"
        )
    return r


# ──────────────────────────────────────────────────────────────── running one

#: Counts come from MACHINE-READABLE reports, never from scraping the terminal.
#: The first version of this file parsed `N failed` out of stdout and read zero
#: from a run that had plainly failed: `pytest.ini` already sets `-q`, a second
#: `-q` suppresses the summary line entirely, and the runner reported the guard
#: as SURVIVING. A runner whose whole purpose is to not lie about a test result
#: cannot get its numbers from prose.


@dataclass
class Result:
    entry: Entry
    verdict: str          # KILLED | SURVIVED | ERROR | GAP-OPEN | GAP-CLOSED | CONTROL-OK | CONTROL-BAD
    failed: int
    passed: int
    seconds: float
    detail: str = ""
    log: str = ""

    @property
    def ok(self) -> bool:
        return self.verdict in ("KILLED", "CONTROL-OK", "GAP-OPEN")


def _pytest_skips(report: Path) -> list[str]:
    """The skip messages, so "nothing ran" can say WHY.

    A whole file self-skipping (no `jq`, no `DATABASE_URL`, no `rendercv`) and a
    test id that no longer exists both produce zero cases. They need different
    fixes, and a runner that reports the first as the second sends somebody to
    re-cut a patch that is fine.
    """
    import xml.etree.ElementTree as ET

    out = []
    for case in ET.parse(report).getroot().iter("testcase"):
        for sk in case.iter("skipped"):
            out.append(sk.get("message", "").strip() or "skipped")
    return out


def _pytest_counts(report: Path) -> tuple[int, int, int]:
    """(failed, passed, errored) from the JUnit XML pytest wrote.

    ERRORS ARE NOT FAILURES HERE, and the distinction is load-bearing. A fixture
    that blew up, a collection error, a database that was not there — all of
    those make pytest exit non-zero without any assertion having been evaluated.
    Counting them as "the guard was caught" is exactly the false green this
    ledger exists to prevent, so they get their own verdict.
    """
    import xml.etree.ElementTree as ET

    root = ET.parse(report).getroot()
    failed = passed = errored = skipped = 0
    for s in root.iter("testsuite"):
        total = int(s.get("tests", 0))
        f = int(s.get("failures", 0))
        er = int(s.get("errors", 0))
        sk = int(s.get("skipped", 0))
        failed += f
        errored += er
        skipped += sk
        passed += total - f - er - sk
    return failed, passed, errored


def _playwright_counts(report: Path) -> tuple[int, int, int]:
    """(failed, passed, errored) from Playwright's own JSON report."""
    data = json.loads(report.read_text())
    stats = data.get("stats", {})
    # A config or import error puts entries in `errors` and never runs a test.
    return int(stats.get("unexpected", 0)), int(stats.get("expected", 0)), len(data.get("errors", []))


def execute(e: Entry, tree: Path, scratch: Scratch) -> Result:
    t0 = time.monotonic()
    env = dict(os.environ)
    env["HQ_DEMO"] = "1"
    # A skipped security test is not a passed one, and it is not a killed mutant
    # either. Both of these turn "the dependency is missing" from a silent skip
    # into a hard error, the way CI already spells them.
    if "database" in e.needs:
        env["HQ_REQUIRE_DB"] = "1"
    if "rendercv" in e.needs:
        env["HQ_REQUIRE_RENDERCV"] = "1"
    status_file = scratch.path / f"{e.id}.status.json"

    if e.kind == "sql":
        env["HQ_SQL_MUTANT"] = str(e.sql)
        env["HQ_SQL_MUTANT_RESTORE"] = str(migration_matching(e.restore))
        env["HQ_SQL_MUTANT_STATUS"] = str(status_file)

    report = scratch.path / f"{e.id}.report"
    if e.runner == "playwright":
        cwd = tree / "webapp"
        cmd = ["npx", "playwright", "test", *e.spec.split(), "--reporter=json"]
        if e.grep:
            cmd += ["--grep", e.grep]
        env["PLAYWRIGHT_JSON_OUTPUT_NAME"] = str(report)
        # The scratch tree is a fresh copy in /tmp, so `next build` starts cold
        # every time — no `.next`, and inside the verification image no volume
        # either. Measured at 184s there against playwright.config's 180s
        # webServer budget, which surfaced as an ERROR verdict that reads like a
        # guard the mutation escaped. The budget is raised for THIS runner only.
        env.setdefault("HQ_E2E_WEBSERVER_TIMEOUT_MS", "600000")
    else:
        cwd = tree
        cmd = interpreters()[e.runner] + [
            "--tb=line", "-p", "no:cacheprovider", f"--junitxml={report}", *e.tests,
        ]
        if e.kind == "sql":
            cmd += ["-p", "tests.mutants.pg_plugin"]
            # `-p` is resolved during pre-parse, before pytest puts rootdir on
            # sys.path, so the plugin is not importable without this.
            env["PYTHONPATH"] = os.pathsep.join(
                [str(tree), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])

    r = run(cmd, cwd=cwd, env=env, timeout=3600)
    out = r.stdout + r.stderr
    dt = time.monotonic() - t0

    failed = passed = errored = 0
    early = ""
    if not report.exists():
        early = f"the run produced no report at all (exit {r.returncode})"
    else:
        try:
            failed, passed, errored = (_playwright_counts if e.runner == "playwright"
                                       else _pytest_counts)(report)
        except Exception as exc:
            early = f"the report was unreadable: {type(exc).__name__}: {exc}"

    def res(verdict: str, detail: str = "") -> Result:
        return Result(e, verdict, failed, passed, dt, detail, out)

    if early:
        return res("ERROR", early)
    if errored:
        return res("ERROR",
                   f"{errored} case(s) ERRORED rather than failing an assertion. A fixture "
                   f"or a collection blew up, so nothing here is evidence about the guard.")
    # A run that collected nothing is not evidence about anything.
    if failed + passed == 0:
        skips = _pytest_skips(report) if e.runner.startswith("pytest") else []
        if skips:
            uniq = sorted(set(skips))
            return res("ERROR",
                       f"all {len(skips)} named case(s) SKIPPED, so the guard was never "
                       f"exercised: {uniq[0]}. Fix the environment, not the mutant — a "
                       f"skipped guard reports the same green as a working one.")
        return res("ERROR",
                   f"the named tests were not collected or ran zero cases "
                   f"(exit {r.returncode}). A stale test id is a mutant that silently "
                   f"stopped running.")

    if e.kind == "sql":
        if not status_file.exists():
            return res("ERROR", "the pg plugin never wrote its status file")
        st = json.loads(status_file.read_text())
        if not st.get("applied"):
            return res("ERROR", "the sql mutation was never applied, so the run proves nothing")
        if not st.get("restored"):
            return res("ERROR", f"the schema was not restored: {st.get('error') or 'unknown'}")

    if e.role == "mutant":
        if failed == 0:
            return res(
                "SURVIVED",
                f"{e.guard or e.id} was broken and the named tests stayed GREEN. "
                f"The guard is unprotected: the test passes with the fix removed.",
            )
        if failed != e.failing:
            return res(
                "SURVIVED",
                f"{failed} case(s) went red, the manifest pins {e.failing}. A mutation that "
                f"reddens some of the named cases has found a partial guard.",
            )
        return res("KILLED")

    if e.role == "control":
        if failed == 0:
            return res("CONTROL-OK")
        return res("CONTROL-BAD", f"the inert patch reddened {failed} case(s); it should redden none")

    # gap
    if failed == 0:
        return res("GAP-OPEN", "the mutation is a no-op today: there is no guard here to break")
    return res("GAP-CLOSED",
               f"{failed} case(s) went red, so a guard now EXISTS here. Promote this "
               f"[[gap]] to a [[mutant]].")


# ──────────────────────────────────────────────────────────────────── reporting

BAR = "─" * 78


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true",
                    help="load the manifest, prove every patch still applies, run no tests")
    ap.add_argument("--verbose", action="store_true", help="print each run's output")
    args = ap.parse_args()

    try:
        entries = load(args.only)
    except ManifestError as exc:
        print(f"mutants: {exc}", file=sys.stderr)
        return 3

    if args.list:
        for e in entries:
            print(f"{e.role:8s} {e.id}")
            print(f"         guard:    {e.guard or '-'}")
            print(f"         property: {e.property}")
            print(f"         tests:    {', '.join(e.tests) or e.spec}")
        return 0

    if (any(e.runner == "playwright" for e in entries) and not args.dry_run
            and not (REPO / "webapp" / "node_modules").exists()):
        print(
            "mutants: a playwright entry is selected and webapp/node_modules is absent.\n"
            "         The scratch worktree borrows it from here rather than installing a\n"
            "         second copy, so there is nothing to borrow. Fix: cd webapp && npm install.",
            file=sys.stderr,
        )
        return 4

    needs_db = any("database" in e.needs for e in entries)
    if needs_db and not os.environ.get("DATABASE_URL") and not args.dry_run:
        print(
            "mutants: entries in this run need DATABASE_URL and it is unset.\n"
            "         tests/db self-skips without it AND STILL REPORTS SUCCESS, so a mutant\n"
            "         run against no database would report every database guard as surviving.\n"
            "         Fix: scripts/verify.sh --image, or export DATABASE_URL.",
            file=sys.stderr,
        )
        return 4

    print(BAR)
    print(f"pinned mutants: {len(entries)} entr{'y' if len(entries) == 1 else 'ies'} from "
          f"{MANIFEST.relative_to(REPO)}")
    print(BAR)

    scratch = Scratch()
    results: list[Result] = []
    try:
        scratch.create()
        if scratch.oversized:
            print(f"note: {len(scratch.oversized)} file(s) over "
                  f"{MAX_COPIED_BYTES // (1024 * 1024)}MB were not copied into the scratch "
                  f"tree: {', '.join(scratch.oversized[:3])}"
                  f"{' ...' if len(scratch.oversized) > 3 else ''}")
        for e in entries:
            label = f"{e.role}/{e.id}"
            if e.kind == "patch":
                check = run(["git", "apply", "--check", str(e.patch)], cwd=scratch.tree)
                if check.returncode != 0:
                    print(f"✗ {label}: THE PATCH NO LONGER APPLIES.")
                    print(f"  {e.patch.relative_to(REPO)} was written against code that has since")
                    print("  changed. This is a hard failure and never a skip: a mutant that")
                    print("  quietly stops running is the same defect one level up. Re-cut it:")
                    print(f"    edit the guard, git diff -- <file> > {e.patch.relative_to(REPO)}")
                    print(f"  git said: {check.stderr.strip()}")
                    results.append(Result(e, "ERROR", 0, 0, 0.0, "the patch no longer applies"))
                    continue
                if args.dry_run:
                    print(f"· {label}: the patch applies")
                    continue
                run(["git", "apply", str(e.patch)], cwd=scratch.tree, check=True)
            elif args.dry_run:
                print(f"· {label}: sql mutant present")
                continue

            print(f"▶ {label}")
            print(f"  {e.property}")
            try:
                r = execute(e, scratch.tree, scratch)
            except subprocess.TimeoutExpired:
                r = Result(e, "ERROR", 0, 0, 0.0, "timed out")
            finally:
                if e.kind == "patch":
                    scratch.restore(patch_targets(e.patch.read_text()))
            results.append(r)
            mark = "✓" if r.ok else "✗"
            print(f"  {mark} {r.verdict}  {r.failed} failed, {r.passed} passed, {r.seconds:.0f}s")
            if r.detail:
                print(f"    {r.detail}")
            if args.verbose or not r.ok:
                tail = "\n".join(r.log.splitlines()[-25:])
                print("\n".join(f"    | {line}" for line in tail.splitlines()))
            print()
    finally:
        scratch.destroy()

    if args.dry_run:
        print(BAR)
        stale = [r for r in results if r.verdict == "ERROR"]
        if stale:
            print(f"DRY RUN FAIL — {len(stale)} patch(es) no longer apply: "
                  f"{', '.join(r.entry.id for r in stale)}")
            return 1
        # COUNTED, not just "nothing failed". "No patch failed to apply" is exactly
        # as true of a ledger holding zero patches, so the count is what lets
        # tests/core/test_mutant_ledger.py bind the population it is walking. The
        # assertion-strength lint (#144) found that hole in the first version of
        # that test and it is the same defect class this whole ledger exists for.
        n_patch = sum(1 for e in entries if e.kind == "patch")
        n_sql = sum(1 for e in entries if e.kind == "sql")
        print(f"checked: {n_patch} patch(es) apply, {n_sql} sql mutant(s) present")
        print("DRY RUN — the manifest loaded and every patch applies. No test was run.")
        return 0

    print(BAR)
    print(f"{'entry':52s} {'verdict':12s} {'red':>4s} {'s':>5s}")
    for r in results:
        print(f"{r.entry.id:52s} {r.verdict:12s} {r.failed:4d} {r.seconds:5.0f}")
    print(BAR)

    bad = [r for r in results if not r.ok]
    gaps = [r for r in results if r.verdict == "GAP-OPEN"]
    if gaps:
        print(f"OPEN GAPS ({len(gaps)}) — a property nobody could pin, recorded rather than forgotten:")
        for r in gaps:
            print(f"  {r.entry.id}: {r.entry.property}")
        print()
    if bad:
        print(f"MUTANT LEDGER FAIL — {len(bad)} of {len(results)} entries.")
        for r in bad:
            print(f"  {r.entry.id}: {r.verdict} — {r.detail}")
        return 1
    killed = sum(1 for r in results if r.verdict == "KILLED")
    print(f"MUTANT LEDGER PASS — {killed} guard(s) broken and caught, "
          f"{sum(1 for r in results if r.verdict == 'CONTROL-OK')} control(s) correctly rejected, "
          f"{len(gaps)} open gap(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
