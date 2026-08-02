"""The verification lane's own safety properties.

`scripts/verify.sh` decides which gates a change gets. That makes it the one
script in the repo whose failure mode is *silence*: a bad map does not error, it
just verifies less than you think it did and prints a green summary. Three
properties keep that from happening, and each is asserted here against the real
script rather than a description of it.

  1. An UNMAPPED path runs everything. Not knowing what a path affects is the
     opposite of knowing it affects little.
  2. A rule pointing at a suite that does not exist FAILS THE RUN. Otherwise a
     renamed suite turns into a rule that quietly selects nothing.
  3. Every suite in the registry points at a target that exists — the same
     failure from the other direction (a deleted test directory would leave a
     suite that "runs" and asserts nothing).

Plus: the fast lane must never describe itself as a full gate.

These run in the plain 3.11 suite (`pytest tests/core`) — bash and git only, no
Docker, so they hold in CI's `tests` job as well as locally.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
VERIFY = REPO / "scripts" / "verify.sh"


def run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    import os

    e = dict(os.environ)
    e.pop("HQ_VERIFY_PATHS", None)          # the --image handoff must not leak in
    e.update(env or {})
    return subprocess.run(
        ["bash", str(VERIFY), "--dry-run", *args],
        cwd=REPO, capture_output=True, text=True, env=e, timeout=120,
    )


def selected(out: str) -> set[str]:
    """The suite ids under RUNNING, plus the ones folded into a wider suite.

    Folded-in suites ARE run — inside their parent — so for "did this get
    verified" purposes they count.
    """
    ids: set[str] = set()
    section = None
    for line in out.splitlines():
        if line.startswith("RUNNING"):
            section = "run"
            continue
        if line.startswith("FOLDED IN"):
            section = "folded"
            continue
        if line.startswith(("SKIPPED", "verify:", "paths:", "mapped to", "────")) or not line.strip():
            if not line.startswith(" "):
                section = None
            continue
        if section in ("run", "folded"):
            ids.add(line.split()[0])
    return ids


def registry_suite_ids() -> list[str]:
    """Parse the `suite <id> <target> <cmd>` lines out of the script itself."""
    text = VERIFY.read_text()
    return re.findall(r"^suite\s+(\S+)\s", text, re.MULTILINE)


def registry_targets() -> dict[str, str]:
    text = VERIFY.read_text()
    return dict(re.findall(r"^suite\s+(\S+)\s+(\S+)\s", text, re.MULTILINE))


def test_the_script_is_executable_and_self_describing() -> None:
    assert VERIFY.exists(), "scripts/verify.sh is gone; every agent instruction that cites it is now a lie"
    assert registry_suite_ids(), "no suites parsed out of the registry"


# ─────────────────────────────────────────────── 1. the unmapped-path fallback
#
# THE safety property. If this ever stops holding, a change to a directory
# nobody added a rule for gets *no* verification and a cheerful summary.

@pytest.mark.parametrize(
    "path",
    [
        "some/directory/nobody/mapped.txt",
        "brand_new_package/thing.py",
        "webapp/newlayer/thing.ts",          # under webapp/, still not a mapped subtree
        "Makefile",
    ],
)
def test_unmapped_path_falls_back_to_full(path: str) -> None:
    r = run(path)
    assert r.returncode == 0, r.stderr
    assert "FULL (fallback)" in r.stdout, f"{path} did not trigger the fallback:\n{r.stdout}"
    assert path in r.stdout, "the run must name the path that forced the fallback"

    ran = selected(r.stdout)
    missing = set(registry_suite_ids()) - ran
    assert not missing, f"the FULL fallback failed to select: {sorted(missing)}"


def test_a_mapped_path_does_not_fall_back() -> None:
    """The counterexample. Without this, a fallback that fired on EVERYTHING
    would pass the test above while making the fast lane pointless."""
    r = run("webapp/lib/dates.ts")
    assert r.returncode == 0, r.stderr
    assert "FULL (fallback)" not in r.stdout
    assert selected(r.stdout) == {"typecheck", "vitest"}, r.stdout


def test_an_unmapped_path_beside_a_mapped_one_still_forces_full() -> None:
    """A partial understanding of a change is not a scoped one."""
    r = run("webapp/lib/dates.ts", "who/knows/what.bin")
    assert "FULL (fallback)" in r.stdout
    assert set(registry_suite_ids()) <= selected(r.stdout)


# ────────────────────────────────── 2. a rule cannot point at a missing suite

def test_rule_selecting_an_unknown_suite_fails_loudly() -> None:
    r = run("zz/thing.txt", env={"HQ_VERIFY_EXTRA_MAP": "zz/*=nosuchsuite"})
    assert r.returncode != 0, "a map that names a nonexistent suite must not run"
    assert "not in the registry" in r.stderr, r.stderr
    assert "nosuchsuite" in r.stderr
    # And it must fail BEFORE selecting anything, so nobody reads the plan as a result.
    assert "RUNNING" not in r.stdout


def test_a_valid_extra_rule_still_works() -> None:
    """The counterexample for the check above: the hook itself is not just
    broken-by-construction."""
    r = run("zz/thing.txt", env={"HQ_VERIFY_EXTRA_MAP": "zz/*=vitest"})
    assert r.returncode == 0, r.stderr
    assert "vitest" in selected(r.stdout)


# ─────────────────────────────── 3. every registered suite points at a target

def test_every_suite_target_exists() -> None:
    missing = {sid: t for sid, t in registry_targets().items() if not (REPO / t).exists()}
    assert not missing, (
        f"suites point at paths that do not exist: {missing}. A suite whose tests "
        f"moved or were deleted would run nothing and report success."
    )


def test_missing_suite_target_fails_the_run(tmp_path: Path) -> None:
    """Prove the check above is enforced by the SCRIPT, not only by this test.

    A copy of verify.sh with one target repointed at a nonexistent path must
    refuse to run.
    """
    # A shadow checkout: every real top-level entry symlinked in, so ONLY the
    # one repointed target is missing. Without this the copy would resolve an
    # empty repo and fail for the boring reason that nothing exists.
    shadow = tmp_path / "repo"
    (shadow / "scripts").mkdir(parents=True)
    for entry in REPO.iterdir():
        if entry.name != "scripts":
            (shadow / entry.name).symlink_to(entry)
    for entry in (REPO / "scripts").iterdir():
        if entry.name != "verify.sh":
            (shadow / "scripts" / entry.name).symlink_to(entry)

    original = VERIFY.read_text()
    text = original.replace(
        "suite vitest           webapp/tests/unit ",
        "suite vitest           webapp/tests/unit-DELETED ",
    )
    assert text != original, "the vitest registry line moved; update this mutation"
    broken = shadow / "scripts" / "verify.sh"
    broken.write_text(text)

    r = subprocess.run(
        ["bash", str(broken), "--dry-run", "webapp/lib/dates.ts"],
        cwd=shadow, capture_output=True, text=True, timeout=120,
    )
    assert r.returncode != 0, "a suite pointing at a deleted target must not run"
    assert "vitest" in r.stderr and "does not exist" in r.stderr, r.stderr
    assert "RUNNING" not in r.stdout

    # The counterexample: the same shadow checkout with the UNMODIFIED script
    # runs fine, so the failure above is the mutation and not the scaffolding.
    broken.write_text(original)
    ok = subprocess.run(
        ["bash", str(broken), "--dry-run", "webapp/lib/dates.ts"],
        cwd=shadow, capture_output=True, text=True, timeout=120,
    )
    assert ok.returncode == 0, ok.stderr


# ─────────────────────────────────────────────────────────── 4. honest labels

def test_fast_lane_never_claims_to_be_a_full_gate() -> None:
    r = run("webapp/lib/dates.ts")
    assert "this is NOT a full gate" in r.stdout
    assert "FULL GATE PASS" not in r.stdout


def test_full_mode_selects_every_suite() -> None:
    r = subprocess.run(
        ["bash", str(VERIFY), "--full", "--dry-run"],
        cwd=REPO, capture_output=True, text=True, timeout=120,
    )
    assert r.returncode == 0, r.stderr
    assert set(registry_suite_ids()) <= selected(r.stdout)
    assert "verify: FULL" in r.stdout


def test_zero_suites_is_not_reported_as_a_pass() -> None:
    """A prose-only change verifies nothing, and must say so in those words.

    'PASS' over an empty selection is the precise lie this script exists to
    avoid. (This is also the case that crashed on macOS bash 3.2 — an empty
    array under `set -u` — which is why it is asserted on a real run, not a
    dry one.)
    """
    r = subprocess.run(
        ["bash", str(VERIFY), "docs/pilot-launch/README.md"],
        cwd=REPO, capture_output=True, text=True, timeout=120,
    )
    assert r.returncode == 0, r.stderr
    assert "NOTHING RAN" in r.stdout, r.stdout
    assert "PARTIAL PASS" not in r.stdout
    assert "FULL GATE PASS" not in r.stdout


def test_deliberate_no_suite_paths_are_printed_not_hidden() -> None:
    """docs/** maps to nothing on purpose. That decision has to be visible, or
    it is indistinguishable from a hole in the map."""
    r = run("docs/pilot-launch/README.md")
    assert "mapped to no suites (deliberate)" in r.stdout
    assert "docs/pilot-launch/README.md" in r.stdout


# ──────────────────────────────────────────────── 5. the mapping is meaningful

@pytest.mark.parametrize(
    "path,expected",
    [
        ("webapp/lib/grid/sort.ts", {"typecheck", "vitest"}),
        # `vitest` belongs to a migration change: webapp/tests/unit/
        # types-contract.test.ts PARSES db/migrations/*.sql to derive the row
        # types, so a migration-only edit can turn it red with no webapp file
        # touched. Commit d3aef9e is that failure, and it got past this lane.
        ("db/migrations/0029_x.sql", {"py-db", "py-migrations", "vitest"}),
        ("infra/render/render.py", {"py-render", "py-infra"}),
        (".github/workflows/ci.yml", {"py-workflows", "sysmap"}),
        ("monitor/fetchers/lever.py", {"py-monitor"}),
        ("tracker/digest.py", {"py-tracker"}),
        ("webapp/tests/e2e/visual.spec.ts", {"e2e-visual"}),
    ],
)
def test_expected_selection(path: str, expected: set[str]) -> None:
    r = run(path)
    assert r.returncode == 0, r.stderr
    assert "FULL (fallback)" not in r.stdout, r.stdout
    assert selected(r.stdout) == expected, r.stdout


def test_app_changes_reach_the_browser_gates() -> None:
    """A rendered-page change must select the suites that read rendered pages —
    the anti-slop computed-style sweep among them."""
    r = run("webapp/app/queue/page.tsx")
    got = selected(r.stdout)
    for needed in ("e2e", "e2e-slop", "lint-copy", "build", "typecheck"):
        assert needed in got, f"{needed} missing for an app/ change:\n{r.stdout}"


def test_core_change_is_not_treated_as_local() -> None:
    """core/ is imported by monitor, tracker and the db write path."""
    got = selected(run("core/pgwrites.py").stdout)
    assert {"py-core", "py-monitor", "py-tracker", "py-db"} <= got
