"""The merge gate's own gate.

`scripts/land.sh` is the only sanctioned way to put a branch on main, which makes
it the one script in this repo whose failure mode is a *merge that should not
have happened*. It is 544 lines and, until this file, had no tests — while
`scripts/verify.sh`, its neighbour in size, has had twenty-four since the day it
was written. Five defects were found in land.sh by running it for real in a
single day; every one of them was a refusal that fired wrongly or failed to fire.

So each exit code is asserted here as a contract, against the real script:

     2  uncommitted TRACKED changes — and untracked files must NOT block
     3  HEAD is the base branch
     4  local gates failed
     5  rebase onto origin/<base> conflicted
     8  a failing or cancelled check the repo owns
     9  checks still pending when the timeout expired
    10  an empty / unreadable check set, a GitHub head mismatch, or a check set
        that is nothing but ignored checks
    11  `gh pr merge` failed AND the PR is genuinely not merged
     0  the branch really can land (the counterexample: without this every
        refusal test above would pass on a script that refuses everything)

Plus the two behaviours that are themselves fixes: `LAND_TIER=t0/t1` skips the
check wait but NOT the local gates and touches no variable the wait loop would
have set, and the ignored-check filter drops a failing `Vercel` without ever
emptying the set into a false pass.

HOW THIS RUNS — the precedent is `tests/core/test_verify_lane.py`: drive the bash
script from pytest, no new dependency. `gh` is a stub on PATH that emits canned
JSON per scenario and records every invocation. `git` is REAL, against a
throwaway repo with a local bare remote built by the fixture — a stubbed git
could not have caught the untracked-files defect, since that bug was in the
exact flags passed to `git status`.

ANTI-VACUITY: `test_mutations_break_the_properties` re-runs three of these
scenarios against a deliberately broken copy of land.sh and asserts each one
stops refusing. A safety gate whose tests have never been watched to fail is not
evidence.

DELIBERATELY NOT COVERED: exit 6 (push failed) and exit 7 (the PR could not be
created or read back) — both need a stubbed `git push` / a second writer racing
the branch, and neither can let a red commit onto main: they fail closed, before
any check is read. Exit 12 (`gh pr merge` claimed success but origin/<base> did
not move) is exercised only in its passing direction by the happy-path test; the
failing direction needs a remote that accepts a push and then discards it.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
LAND = REPO / "scripts" / "land.sh"

# land.sh reads every check set through jq, so a jq-less environment could only
# be tested by stubbing jq — which would replace the parsing logic under test
# with a fixture of itself. `gh` is stubbed (it is the network), `git` and `jq`
# are real. CI's `tests` job runs on ubuntu-latest, where jq is preinstalled, so
# these are gated there. The verification IMAGE does not ship jq today; adding it
# to infra/test-image/Dockerfile would let the --image lane run them too.
NO_JQ = ("jq is not installed here (the verification image does not ship it); "
         "land.sh cannot run at all without it, and stubbing jq would test the stub")

# A `gh` that never touches the network: it answers from the scenario's env vars
# and files, and appends every invocation to $GH_LOG so a test can assert on what
# was NOT called (the LAND_TIER fast path is exactly that assertion).
GH_STUB = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
json=""
for ((i=1; i<=$#; i++)); do
  if [ "${!i}" = "--json" ]; then j=$((i+1)); json="${!j}"; fi
done
case "$1" in
  auth) exit 0 ;;
  repo) printf 'acme/job-hq\n'; exit 0 ;;
  pr)
    case "$2" in
      list)   [ -n "${GH_NO_PR:-}" ] || printf '7\n'; exit 0 ;;
      create) : > "$STUB_DIR/pr-created"; exit "${GH_CREATE_FAIL:-0}" ;;
      checks) cat "${GH_CHECKS_FILE:-/nonexistent}" 2>/dev/null; exit 0 ;;
      view)
        case "$json" in
          headRefOid)
            printf '%s\n' "${GH_HEAD_OVERRIDE:-$(git rev-parse HEAD)}"; exit 0 ;;
          state)
            if [ -f "$STUB_DIR/merged" ]; then printf 'MERGED\n'; else printf 'OPEN\n'; fi
            exit 0 ;;
          state,mergeCommit)
            if [ -f "$STUB_DIR/merged" ]; then
              printf 'MERGED\t%s\n' "$(cat "$STUB_DIR/merged")"
            else
              printf 'OPEN\t\n'
            fi
            exit 0 ;;
          *) printf 'OPEN\tMERGEABLE\tCLEAN\n'; exit 0 ;;
        esac ;;
      merge)
        case "${GH_MERGE_MODE:-ok}" in
          ok)
            git push --quiet origin HEAD:main && git rev-parse HEAD > "$STUB_DIR/merged"
            exit 0 ;;
          fail_but_merged)
            # PRs #122 and #126: the merge happened, `--delete-branch` then failed
            # because a worktree still held the branch, and gh exited non-zero.
            git push --quiet origin HEAD:main && git rev-parse HEAD > "$STUB_DIR/merged"
            exit 1 ;;
          fail) exit 1 ;;
        esac ;;
    esac ;;
esac
exit 0
"""

PASSING_CHECKS = '[{"name":"webapp (1)","state":"SUCCESS","bucket":"pass","link":"u"}]'
FAILING_CHECKS = '[{"name":"webapp (1)","state":"FAILURE","bucket":"fail","link":"u"}]'
PENDING_CHECKS = (
    '[{"name":"webapp (1)","state":"SUCCESS","bucket":"pass","link":"u"},'
    ' {"name":"tests","state":"IN_PROGRESS","bucket":"pending","link":"u"}]'
)
IGNORED_FAIL_ONLY = '[{"name":"Vercel","state":"FAILURE","bucket":"fail","link":"u"}]'
IGNORED_FAIL_PLUS_PASS = (
    '[{"name":"Vercel","state":"FAILURE","bucket":"fail","link":"u"},'
    ' {"name":"webapp (1)","state":"SUCCESS","bucket":"pass","link":"u"}]'
)
SKIPPED_ONLY = '[{"name":"webapp (1)","state":"SKIPPED","bucket":"skipping","link":"u"}]'


@dataclass
class Land:
    """A throwaway checkout, a local bare origin, and a stubbed `gh`."""

    root: Path
    work: Path
    stub: Path
    gh_log: Path
    gate_marker: Path
    script: Path

    def run(self, *args: str, script: Path | None = None, **env: str):
        e = dict(os.environ)
        e["PATH"] = f"{self.stub}:{e['PATH']}"
        e["GH_LOG"] = str(self.gh_log)
        e["STUB_DIR"] = str(self.stub)
        # POP, not setdefault. `land.sh` is itself run with LAND_GATES set — that
        # is how anyone lands a change — so an inherited value survives a
        # setdefault and the land.sh under test recursively runs the caller's
        # whole verify suite instead of touching a marker. Five cases failed
        # exactly that way, and only when invoked from inside a real land, which
        # is the worst possible place for a test to be environment-sensitive.
        for k in ("LAND_GATES", "LAND_POLL_INTERVAL", "LAND_CHECK_GRACE",
                  "LAND_CHECK_TIMEOUT"):
            e.pop(k, None)
        e.setdefault("LAND_GATES", f"touch {self.gate_marker}")
        e.setdefault("LAND_POLL_INTERVAL", "0")
        e.setdefault("LAND_CHECK_GRACE", "0")
        e.setdefault("LAND_CHECK_TIMEOUT", "0")
        for k in ("LAND_TIER", "LAND_SKIP_GATES", "GH_CHECKS_FILE", "GH_HEAD_OVERRIDE",
                  "GH_MERGE_MODE", "GH_NO_PR"):
            e.pop(k, None)
        e.update(env)
        return subprocess.run(
            ["bash", str(script or self.script), *args],
            cwd=self.work, capture_output=True, text=True, env=e, timeout=180,
        )

    def checks(self, payload: str) -> str:
        """Write a check-set fixture and return the env value pointing at it."""
        p = self.root / "checks.json"
        p.write_text(payload)
        return str(p)

    def gh_calls(self) -> list[str]:
        return self.gh_log.read_text().splitlines() if self.gh_log.exists() else []


def git(cwd: Path, *args: str) -> None:
    env = dict(os.environ)
    env.update(
        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid",
        GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null",
    )
    subprocess.run(["git", *args], cwd=cwd, check=True, env=env,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@pytest.fixture
def land(tmp_path: Path) -> Land:
    # Skips at the FIXTURE, not the module, so the static assertions at the
    # bottom of this file still run everywhere.
    if shutil.which("jq") is None:
        pytest.skip(NO_JQ)
    root = tmp_path
    remote = root / "remote.git"
    work = root / "work"
    stub = root / "bin"
    stub.mkdir()
    work.mkdir()

    (stub / "gh").write_text(GH_STUB)
    (stub / "gh").chmod(0o755)

    subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)],
                   check=True, stdout=subprocess.DEVNULL)
    git(work, "init", "-b", "main")
    git(work, "remote", "add", "origin", str(remote))
    (work / "file.txt").write_text("base\n")
    git(work, "add", "-A")
    git(work, "commit", "-m", "base")
    git(work, "push", "-u", "origin", "main")

    # The branch under test: one commit main does not have.
    git(work, "checkout", "-b", "feat/thing")
    (work / "feature.txt").write_text("feature\n")
    git(work, "add", "-A")
    git(work, "commit", "-m", "feat: a thing")

    return Land(
        root=root, work=work, stub=stub,
        gh_log=root / "gh.log",
        gate_marker=root / "gates-ran",
        script=LAND,
    )


def test_stdout_carries_only_the_result_not_the_narration(land: Land) -> None:
    """`land.sh > out` must leave `out` holding the summary and nothing else.

    Two ways this was false: the script's own `step`/`info`/`ok` wrote to stdout,
    and — less obviously — the gate command it invokes inherited stdout, so a
    successful land handed the caller a full verify.sh report where the summary
    should have been. The second survived the first fix, which is why this
    asserts over the WHOLE stream rather than the absence of one phrase.
    """
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS),
                 LAND_GATES="echo GATE-NOISE-ON-STDOUT; true")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "GATE-NOISE-ON-STDOUT" not in r.stdout, "the gate's output leaked into the result"
    assert "GATE-NOISE-ON-STDOUT" in r.stderr, "the gate's output has to go somewhere"
    for line in r.stdout.splitlines():
        assert not line.startswith("==> "), f"a step header reached stdout: {line!r}"


def refusal(r: subprocess.CompletedProcess[str]) -> str:
    return r.stderr


# ───────────────────────────────────────────────── 0. the counterexample first
#
# Every test below asserts a refusal. Without this one they would all pass on a
# script that refuses unconditionally, which is the classic vacuous safety suite.

def test_a_clean_green_branch_actually_lands(land: Land) -> None:
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "LANDED" in r.stdout
    assert land.gate_marker.exists(), "local gates did not run on the happy path"
    # And origin/main really moved — the script's own final claim, re-checked here.
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=land.work,
                          capture_output=True, text=True).stdout.strip()
    base = subprocess.run(["git", "rev-parse", "origin/main"], cwd=land.work,
                          capture_output=True, text=True).stdout.strip()
    assert head == base


# ─────────────────────────────────────────── exit 2: uncommitted TRACKED changes

def test_modified_tracked_file_refuses_with_2(land: Land) -> None:
    (land.work / "file.txt").write_text("edited\n")
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 2, r.stdout + r.stderr
    assert "uncommitted TRACKED changes" in refusal(r)
    assert "file.txt" in refusal(r), "a refusal must name the offending path"
    assert not land.gate_marker.exists(), "refused, yet the gates still ran"


def test_staged_but_uncommitted_change_refuses_with_2(land: Land) -> None:
    (land.work / "new.txt").write_text("x\n")
    git(land.work, "add", "new.txt")
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 2
    assert "new.txt" in refusal(r)


def test_untracked_files_do_not_block(land: Land) -> None:
    """The inverse, and a fix that had to be made.

    The owner's real checkout carries unversioned personal directories. Refusing
    on them made land.sh unusable, and an untracked file cannot break the
    property the check protects: it is in neither the tested tree nor the merged
    commit. It must still be NAMED, because the one case where it matters is a
    new source file nobody ran `git add` on.
    """
    (land.work / "personal-notes.md").write_text("private\n")
    (land.work / "scratch").mkdir()
    (land.work / "scratch" / "junk.bin").write_text("x")
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 0, r.stdout + r.stderr
    # `warn` goes to stdout, the file listing it introduces goes to stderr.
    assert "untracked files present" in r.stderr
    assert "personal-notes.md" in r.stderr, "untracked files must be named, not silently ignored"


# ────────────────────────────────────────────── exit 3: HEAD is the base branch

def test_head_is_base_refuses_with_3(land: Land) -> None:
    git(land.work, "checkout", "main")
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 3, r.stdout + r.stderr
    assert "HEAD is main" in refusal(r)
    assert "never pushed to directly" in refusal(r)


def test_detached_head_refuses_with_3(land: Land) -> None:
    git(land.work, "checkout", "--detach", "HEAD")
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 3
    assert "HEAD is detached" in refusal(r)


def test_a_non_default_base_is_honoured(land: Land) -> None:
    """--base must move the exit-3 refusal with it, or the check is decorative."""
    git(land.work, "checkout", "-b", "release")
    r = land.run("--base", "release", GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 3
    assert "HEAD is release" in refusal(r)


# ────────────────────────────────────────────────── exit 5: rebase conflict

def test_rebase_conflict_refuses_with_5(land: Land) -> None:
    # origin/main gains a conflicting edit to the same line the branch touched.
    git(land.work, "checkout", "main")
    (land.work / "file.txt").write_text("mainline change\n")
    git(land.work, "add", "-A")
    git(land.work, "commit", "-m", "main moves")
    git(land.work, "push", "origin", "main")
    git(land.work, "checkout", "feat/thing")
    (land.work / "file.txt").write_text("branch change\n")
    git(land.work, "add", "-A")
    git(land.work, "commit", "-m", "branch moves")
    git(land.work, "reset", "--hard", "HEAD")

    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 5, r.stdout + r.stderr
    assert "hit a conflict" in refusal(r)
    assert not land.gate_marker.exists()
    # The rebase must be ABORTED, not left half-applied for the next agent.
    state = subprocess.run(["git", "status", "--porcelain"], cwd=land.work,
                           capture_output=True, text=True)
    assert state.stdout.strip() == "", f"conflict left the tree dirty:\n{state.stdout}"


def test_nothing_to_land_refuses_with_5(land: Land) -> None:
    git(land.work, "checkout", "-B", "feat/empty", "origin/main")
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 5
    assert "no commits that origin/main does not already have" in refusal(r)


# ───────────────────────────────────────────────────── exit 4: local gates fail

def test_failing_gates_refuse_with_4(land: Land) -> None:
    r = land.run(LAND_GATES="exit 1", GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 4, r.stdout + r.stderr
    assert "Local gates failed" in refusal(r)
    assert "Do not weaken the test" in refusal(r)
    # Nothing may be pushed or merged after a gate failure.
    assert not any(c.startswith("pr merge") for c in land.gh_calls())


def test_failed_gates_clear_the_stamp_so_a_rerun_reruns_them(land: Land) -> None:
    """The gate stamp is what makes land.sh re-runnable. A stamp that survived a
    failure would let the next run skip the gates entirely."""
    stamp = land.work / ".git" / "land-gates-passed"
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=land.work,
                          capture_output=True, text=True).stdout.strip()
    stamp.write_text(head)
    r = land.run("--dry-run", LAND_GATES="exit 1", GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    # The stamp matched, so the gates were skipped and the run got further; the
    # point is the stamp cannot be forged into a pass for a DIFFERENT commit.
    assert r.returncode == 0, r.stdout + r.stderr
    stamp.write_text("0" * 40)
    r2 = land.run("--dry-run", LAND_GATES="exit 1", GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r2.returncode == 4, "a stamp for another commit must not skip the gates"
    assert not stamp.exists(), "a failed gate run must remove the stamp"


def _verify_lane(land: Land, image_present: bool) -> Path:
    """Give the throwaway checkout a scripts/verify.sh and a `docker` that
    answers whether the verification image exists. Returns the file the fake
    verify.sh writes its argv into."""
    argv = land.root / "verify-argv"
    lane = land.work / "scripts"
    lane.mkdir(exist_ok=True)
    (lane / "verify.sh").write_text(
        f'#!/usr/bin/env bash\nprintf "%s\\n" "$*" > {argv}\nexit 0\n'
    )
    (lane / "verify.sh").chmod(0o755)
    (land.stub / "docker").write_text(
        "#!/usr/bin/env bash\n"
        f'[ "$1" = "image" ] && exit {0 if image_present else 1}\nexit 0\n'
    )
    (land.stub / "docker").chmod(0o755)
    return argv


def test_the_default_gate_asks_for_the_image_when_it_is_built(land: Land) -> None:
    """Without --image the lane has no DATABASE_URL, so every database gate
    REFUSES rather than self-skipping into a meaningless green. That refusal is
    correct of verify.sh and useless here: on 2026-08-03 it turned PRs #141 and
    #142 — both ready, both green in CI — into exit-4 refusals whose only defect
    was that land.sh was standing outside the image."""
    argv = _verify_lane(land, image_present=True)
    r = land.run("--dry-run", LAND_GATES="",
                 GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 0, r.stdout + r.stderr
    assert argv.read_text().strip() == "--image", "the gate ran without --image"


def test_the_default_gate_says_so_rather_than_asking_for_an_absent_image(
    land: Land,
) -> None:
    """`docker run` against an image that is not built fails in a way that reads
    as a gate failure. Degrade to the host lane and say which gates that costs."""
    argv = _verify_lane(land, image_present=False)
    r = land.run("--dry-run", LAND_GATES="",
                 GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 0, r.stdout + r.stderr
    assert argv.read_text().strip() == "", "asked for an image that is not built"
    assert "image is not built" in r.stderr
    assert "infra/test-image/build.sh" in r.stderr


def test_land_gates_still_wins_over_the_image_default(land: Land) -> None:
    """The override exists so a caller can run something narrower. A default
    that quietly outranked it would make LAND_GATES a lie."""
    argv = _verify_lane(land, image_present=True)
    r = land.run("--dry-run", LAND_GATES=f"touch {land.gate_marker}",
                 GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 0, r.stdout + r.stderr
    assert land.gate_marker.exists()
    assert not argv.exists(), "LAND_GATES was set and verify.sh ran anyway"


# ───────────────────────────────────────────── exit 8: a failing/cancelled check

def test_failing_check_refuses_with_8(land: Land) -> None:
    r = land.run(GH_CHECKS_FILE=land.checks(FAILING_CHECKS))
    assert r.returncode == 8, r.stdout + r.stderr
    assert "failing or cancelled check" in refusal(r)
    assert "webapp (1)" in refusal(r), "the refusal must name the check"
    assert not any(c.startswith("pr merge") for c in land.gh_calls())


def test_cancelled_check_refuses_with_8(land: Land) -> None:
    r = land.run(GH_CHECKS_FILE=land.checks(
        '[{"name":"tests","state":"CANCELLED","bucket":"cancel","link":"u"}]'))
    assert r.returncode == 8
    assert "cancel" in refusal(r)


def test_head_moving_between_the_checks_and_the_merge_refuses_with_8(land: Land) -> None:
    """The last-moment re-read. Green checks that belong to another commit are
    not green checks for this one."""
    checks = land.checks(PASSING_CHECKS)
    # A stub that agrees with HEAD once (inside the loop) and then disagrees.
    counter = land.stub / "headcount"
    moved = GH_STUB.replace(
        'printf \'%s\\n\' "${GH_HEAD_OVERRIDE:-$(git rev-parse HEAD)}"; exit 0 ;;',
        'n=$(( $(cat "$STUB_DIR/headcount" 2>/dev/null || printf 0) + 1 ));'
        ' printf "%s" "$n" > "$STUB_DIR/headcount";'
        ' if [ "$n" -ge 2 ]; then printf \'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\\n\';'
        ' else git rev-parse HEAD; fi; exit 0 ;;')
    assert moved != GH_STUB, "the gh stub's headRefOid branch moved; update this test"
    (land.stub / "gh").write_text(moved)
    (land.stub / "gh").chmod(0o755)
    counter.unlink(missing_ok=True)
    r = land.run(GH_CHECKS_FILE=checks)
    assert r.returncode == 8, r.stdout + r.stderr
    assert "head moved" in refusal(r)
    assert not any(c.startswith("pr merge") for c in land.gh_calls())


# ────────────────────────────────────────────── exit 9: still pending at timeout

def test_pending_checks_at_timeout_refuse_with_9(land: Land) -> None:
    r = land.run(GH_CHECKS_FILE=land.checks(PENDING_CHECKS),
                 LAND_CHECK_TIMEOUT="0")
    assert r.returncode == 9, r.stdout + r.stderr
    assert "PENDING check" in refusal(r)
    assert "tests" in refusal(r)
    assert "Pending is not green" in refusal(r)
    assert not any(c.startswith("pr merge") for c in land.gh_calls())


# ─────────────────────────────── exit 10: empty, unreadable, mismatched, ignored

def test_empty_check_set_refuses_with_10(land: Land) -> None:
    """The #108/#109 hole. An empty check set is a refusal, never a pass."""
    r = land.run(GH_CHECKS_FILE=land.checks("[]"))
    assert r.returncode == 10, r.stdout + r.stderr
    assert "EMPTY or UNREADABLE check set" in refusal(r)
    assert not any(c.startswith("pr merge") for c in land.gh_calls())


def test_unreadable_check_set_refuses_with_10(land: Land) -> None:
    """Not-JSON is indistinguishable from nothing-is-running, and must be read
    the same way."""
    r = land.run(GH_CHECKS_FILE=land.checks("this is not json"))
    assert r.returncode == 10
    assert "EMPTY or UNREADABLE check set" in refusal(r)


def test_absent_check_output_refuses_with_10(land: Land) -> None:
    """`gh pr checks` printing nothing at all (API error, rate limit)."""
    r = land.run(GH_CHECKS_FILE="/nonexistent/checks.json")
    assert r.returncode == 10
    assert "EMPTY or UNREADABLE check set" in refusal(r)


def test_github_head_mismatch_refuses_with_10(land: Land) -> None:
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS),
                 GH_HEAD_OVERRIDE="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
    assert r.returncode == 10, r.stdout + r.stderr
    assert "not the gated" in refusal(r)
    assert "refusal, not a pass" in refusal(r)
    # It must never have read the checks: they would belong to another commit.
    assert not any(c.startswith("pr checks") for c in land.gh_calls())


def test_only_skipped_checks_refuses_with_10(land: Land) -> None:
    r = land.run(GH_CHECKS_FILE=land.checks(SKIPPED_ONLY))
    assert r.returncode == 10
    assert "NONE of them passed" in refusal(r)


def test_only_ignored_checks_waits_during_grace_then_refuses_with_10(land: Land) -> None:
    """PR #126's defect, from both sides.

    The first version of the filter kept the UNFILTERED set whenever filtering
    emptied it — so on a PR where the only check registered so far was the
    ignored one, it gated on exactly the check the list exists to ignore. The
    fix waits during the grace window and refuses after it. Both halves are
    asserted: the wait must happen, and the wait must not become a pass.
    """
    r = land.run(GH_CHECKS_FILE=land.checks(IGNORED_FAIL_ONLY),
                 LAND_CHECK_GRACE="2", LAND_POLL_INTERVAL="1")
    assert r.returncode == 10, r.stdout + r.stderr
    assert "only ignored checks so far" in r.stderr, "it must WAIT during grace, not refuse instantly"
    assert "no checks this repository owns" in refusal(r)
    assert not any(c.startswith("pr merge") for c in land.gh_calls())


# ──────────────────────────────────────────────── the ignored-check filter

def test_a_failing_vercel_does_not_gate(land: Land) -> None:
    """`Vercel` is the editor project's preview deploy, rate-limited at the
    account level on 2026-08-02. It does not speak for this repo — but it is
    still printed."""
    r = land.run(GH_CHECKS_FILE=land.checks(IGNORED_FAIL_PLUS_PASS))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "NOT gating on them" in r.stderr
    assert "Vercel" in r.stderr, "an ignored check must still be visible"


def test_a_failing_owned_check_still_gates_beside_an_ignored_one(land: Land) -> None:
    """The filter must be a list, not a mood. `webapp (1)` is owned."""
    r = land.run(GH_CHECKS_FILE=land.checks(
        '[{"name":"Vercel","state":"FAILURE","bucket":"fail","link":"u"},'
        ' {"name":"webapp (1)","state":"FAILURE","bucket":"fail","link":"u"}]'))
    assert r.returncode == 8, r.stdout + r.stderr
    assert "webapp (1)" in refusal(r)


def test_the_ignore_list_is_not_a_pattern(land: Land) -> None:
    """A name that merely CONTAINS an ignored name is a different check.
    A pattern would quietly absorb the next check somebody adds."""
    r = land.run(GH_CHECKS_FILE=land.checks(
        '[{"name":"Vercel Build (webapp)","state":"FAILURE","bucket":"fail","link":"u"},'
        ' {"name":"webapp (1)","state":"SUCCESS","bucket":"pass","link":"u"}]'))
    assert r.returncode == 8, "an unlisted check whose name contains 'Vercel' must still gate"
    assert "Vercel Build (webapp)" in refusal(r)


# ────────────────────────────────────────────────────── exit 11: the merge call

def test_merge_failure_with_an_unmerged_pr_refuses_with_11(land: Land) -> None:
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS), GH_MERGE_MODE="fail")
    assert r.returncode == 11, r.stdout + r.stderr
    assert "gh pr merge failed" in refusal(r)
    assert "Nothing was landed" in refusal(r)
    base = subprocess.run(["git", "rev-parse", "origin/main"], cwd=land.work,
                          capture_output=True, text=True).stdout.strip()
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=land.work,
                          capture_output=True, text=True).stdout.strip()
    assert base != head, "the fixture claimed a failure but the base moved"


def test_a_failed_branch_delete_is_not_a_failed_merge(land: Land) -> None:
    """The other half of the same fix. `gh pr merge --delete-branch` exits
    non-zero when a worktree still holds the branch — the normal state in this
    repo. PRs #122 and #126 both merged cleanly and were reported as failures.
    The exit code is a claim; GitHub's PR state is the evidence.
    """
    r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS),
                 GH_MERGE_MODE="fail_but_merged")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "LANDED" in r.stdout
    assert "is MERGED" in r.stderr, "it must say why it proceeded"
    assert "branch delete failed" in r.stderr


def test_the_delete_hint_names_the_worktree_that_actually_holds_a_branch(
    land: Land,
) -> None:
    """On PR #155 the hint blamed the feature branch and the real holder was a
    worktree on `main`: `--delete-branch` checks the BASE out locally first, so
    either one trips it. A hint that names the wrong branch costs the reader the
    minutes it exists to save, so it must name whichever is actually held."""
    held = land.root / "held-worktree"
    git(land.work, "worktree", "add", "-q", str(held), "main")
    try:
        r = land.run(GH_CHECKS_FILE=land.checks(PASSING_CHECKS),
                     GH_MERGE_MODE="fail_but_merged")
        assert r.returncode == 0, r.stdout + r.stderr
        assert str(held) in r.stderr, "the hint must name the holding worktree"
        assert "main is held by" in r.stderr, "and say which branch it holds"
    finally:
        git(land.work, "worktree", "remove", "--force", str(held))


# ──────────────────────────────────────────────────────── the LAND_TIER fast path

@pytest.mark.parametrize("tier", ["t0", "t1"])
def test_land_tier_skips_the_check_wait_but_not_the_gates(land: Land, tier: str) -> None:
    """Below T2 the full check set is twelve idle minutes. The fast path is
    allowed to skip WAITING for CI. It is not allowed to skip the local gates,
    and it must not reference a variable only the wait loop sets — that exact
    unbound-variable bug shipped twice.
    """
    r = land.run(LAND_TIER=tier, GH_CHECKS_FILE=land.checks(FAILING_CHECKS))
    assert r.returncode == 0, r.stdout + r.stderr
    assert land.gate_marker.exists(), "LAND_TIER skipped the LOCAL gates"
    assert not any(c.startswith("pr checks") for c in land.gh_calls()), \
        "the fast path still polled the check API"
    assert "unbound variable" not in r.stderr, r.stderr
    assert "checks not waited on" in r.stderr, "the run must say it did not wait"
    assert "LANDED" in r.stdout


def test_an_unknown_tier_is_not_a_fast_path(land: Land) -> None:
    """LAND_TIER=t3 (or a typo) must fall through to the full wait, not silently
    behave like t1."""
    r = land.run(LAND_TIER="t3", GH_CHECKS_FILE=land.checks(FAILING_CHECKS))
    assert r.returncode == 8, r.stdout + r.stderr
    assert "failing or cancelled check" in refusal(r)


def test_land_tier_does_not_suppress_the_dirty_worktree_refusal(land: Land) -> None:
    (land.work / "file.txt").write_text("edited\n")
    r = land.run(LAND_TIER="t1", GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 2
    assert "uncommitted TRACKED changes" in refusal(r)


# ───────────────────────────────────────────────────────────────── --dry-run

def test_dry_run_never_merges(land: Land) -> None:
    r = land.run("--dry-run", GH_CHECKS_FILE=land.checks(PASSING_CHECKS))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "stopping before the merge" in r.stderr
    assert not any(c.startswith("pr merge") for c in land.gh_calls())


def test_dry_run_still_refuses_on_red(land: Land) -> None:
    r = land.run("--dry-run", GH_CHECKS_FILE=land.checks(FAILING_CHECKS))
    assert r.returncode == 8


def test_unknown_argument_refuses_with_20(land: Land) -> None:
    r = land.run("--merge-it-anyway")
    assert r.returncode == 20
    assert "Unknown argument" in refusal(r)


# ══════════════════════════════════════════════════════════ ANTI-VACUITY
#
# Three of the properties above are the ones that actually keep red off main.
# Each is re-run here against a copy of land.sh with that one property broken,
# and must stop refusing. A test that has never been watched to fail is not
# evidence that anything is enforced.

MIXED_CHECKS = (
    '[{"name":"webapp (1)","state":"FAILURE","bucket":"fail","link":"u"},'
    ' {"name":"tests","state":"SUCCESS","bucket":"pass","link":"u"}]'
)

MUTATIONS = [
    pytest.param(
        "empty check set refuses",
        (
            '    refuse 10 "PR #${PR_NUM} reports an EMPTY or UNREADABLE check set after ${elapsed}s." \\',
            '    ok "no checks reported — proceeding"; SKIP_CHECK_WAIT=1; break\n'
            '    refuse 10 "PR #${PR_NUM} reports an EMPTY or UNREADABLE check set after ${elapsed}s." \\',
        ),
        {"GH_CHECKS_FILE": "[]"},
        10,
        id="empty-check-set",
    ),
    pytest.param(
        "a failing owned check refuses",
        (
            '  if [ "$fail_n" -gt 0 ]; then',
            '  if [ "$fail_n" -gt 99 ]; then',
        ),
        {"GH_CHECKS_FILE": MIXED_CHECKS},
        8,
        id="failing-owned-check",
    ),
    pytest.param(
        "LAND_TIER does not skip the local gates",
        (
            '  if [ "${LAND_SKIP_GATES:-0}" = "1" ]; then',
            '  if [ "${LAND_SKIP_GATES:-0}" = "1" ] || [ -n "${LAND_TIER:-}" ]; then',
        ),
        {"LAND_TIER": "t1", "GH_CHECKS_FILE": PASSING_CHECKS},
        None,  # asserted on the gate marker, not on an exit code
        id="tier-skips-gates",
    ),
]


@pytest.mark.parametrize("name,mutation,scenario,expected_code", MUTATIONS)
def test_mutations_break_the_properties(
    land: Land, name: str, mutation: tuple[str, str], scenario: dict, expected_code: int | None
) -> None:
    """Both runs are `--dry-run` so neither can move the throwaway origin/main;
    the two runs then differ only in the mutation."""
    old, new = mutation
    original = LAND.read_text()
    assert original.count(old) == 1, f"the mutation target moved; update it: {old!r}"
    mutant = land.root / "land-mutant.sh"
    mutant.write_text(original.replace(old, new))

    env = dict(scenario)
    env["GH_CHECKS_FILE"] = land.checks(env["GH_CHECKS_FILE"])

    # The real script holds the property...
    good = land.run("--dry-run", **env)
    if expected_code is not None:
        assert good.returncode == expected_code, f"{name}: {good.stdout}{good.stderr}"
    else:
        assert land.gate_marker.exists(), f"{name}: gates did not run on the real script"

    # ...and the mutant does not, which is what makes the assertion above evidence.
    land.gate_marker.unlink(missing_ok=True)
    (land.work / ".git" / "land-gates-passed").unlink(missing_ok=True)
    land.gh_log.unlink(missing_ok=True)

    bad = land.run("--dry-run", script=mutant, **env)
    if expected_code is not None:
        assert bad.returncode != expected_code, (
            f"{name}: the mutated script STILL refused with {expected_code} — "
            f"the test is not detecting the property it claims to.\n{bad.stdout}{bad.stderr}"
        )
    else:
        assert not land.gate_marker.exists(), (
            f"{name}: the mutated script still ran the gates — the assertion is vacuous."
        )


# ───────────────────────────────────────────────── the script is what it claims

def test_every_documented_exit_code_is_reachable_in_the_script() -> None:
    """A code in the header comment that no `refuse` uses is documentation of a
    gate that does not exist."""
    import re

    text = LAND.read_text()
    documented = {int(m) for m in re.findall(r"^#\s+(\d+)\s+\S", text, re.MULTILINE)}
    used = {int(m) for m in re.findall(r"\brefuse (\d+)", text)}
    documented.discard(0)   # success is not a refusal
    documented.discard(6)   # push failure — see the module docstring
    missing = documented - used
    assert not missing, f"documented exit codes with no refusal behind them: {sorted(missing)}"


def test_the_script_is_not_run_with_set_e() -> None:
    """`set -e` here would turn a poll that legitimately fails into a silent
    exit 1 — a refusal with no message, which is worse than either outcome."""
    assert "set -uo pipefail" in LAND.read_text()
    assert "set -euo" not in LAND.read_text()
