"""The pinned-mutant ledger's own rules, as a machine.

`scripts/mutants.py` is the thing that says whether every T3/T4 guard in this
repo is really guarded. Its refusals are therefore load-bearing, and a refusal
nobody has watched fire is a refusal that passes because it looks at nothing:

  * a patch that no longer applies must FAIL, never skip;
  * a patch that touches `tests/**` must be refused before anything runs;
  * an entry with no `failing` count must be refused, because "something went
    red" is the assertion this ledger exists to replace;
  * a manifest with no control entry must be refused, because a ledger whose
    entries all redden is consistent with a runner that cannot tell.

The committed manifest is loaded here too. That is the check that keeps this
file from being a test of a fixture: the shipped ledger has to satisfy its own
rules, and a patch re-cut against a moved guard fails at `--dry-run` rather than
at the end of a CI run.
"""
from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "scripts" / "mutants.py"


def _load_runner():
    spec = importlib.util.spec_from_file_location("hq_mutants", RUNNER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["hq_mutants"] = mod
    spec.loader.exec_module(mod)
    return mod


mutants = _load_runner()


# ───────────────────────────────────────────── the shipped ledger, on its own terms

def test_the_committed_manifest_loads_and_every_entry_is_complete():
    entries = mutants.load()
    assert entries, "the ledger is empty"
    assert any(e.role == "mutant" for e in entries)
    assert any(e.role == "control" for e in entries)
    for e in entries:
        assert e.property, e.id
        assert e.tests or e.spec, e.id


def test_the_ledger_holds_mutants_of_both_kinds():
    """BOTH backends are populated, asserted as a count rather than as an absence.

    Three of the six defects this ledger backfills lived in the database, and the
    SQL entries are the only thing pinning them. "No sql mutant is broken" is
    trivially true of a ledger that has none, so the population is bound here:
    if the sql entries ever vanish — a renamed directory, a dropped section — this
    reddens instead of the suite quietly getting cheaper.
    """
    entries = mutants.load()
    patches = [e for e in entries if e.kind == "patch"]
    sql = [e for e in entries if e.kind == "sql"]
    assert len(patches) >= 1, "no patch mutants"
    assert len(sql) >= 3, f"only {len(sql)} sql mutant(s); the database guards are unpinned"
    for e in sql:
        body = e.sql.read_text()
        assert body.strip(), e.id
        # A mutation that does not change the schema cannot break a guard, and a
        # file of pure comments would sail past every other check here.
        statements = [ln for ln in body.splitlines()
                      if ln.strip() and not ln.strip().startswith("--")]
        assert statements, f"{e.id}: the sql mutant is all comment, so it mutates nothing"


def patch_entries() -> list:
    return [e for e in mutants.load() if e.kind == "patch"]


def test_every_committed_patch_still_applies():
    """The `--dry-run` gate, as a test. A patch that stopped applying is a mutant
    that stopped running, and this is the cheapest place to hear about it.

    THE COUNT IS THE POINT, and the first version of this test did not have it.
    `assert r.returncode == 0` says "no patch failed to apply", which is exactly
    as true of a ledger holding ZERO patches — a manifest that lost its `[[mutant]]`
    entries, or a `patch =` key that stopped resolving, would have passed here
    while verifying nothing. The assertion-strength lint (#144) named it
    `absence-only` and it is precisely the defect class this branch exists to
    catch, so it is fixed rather than waived.

    `test_the_population_check_reddens_when_the_ledger_holds_no_patches` drives
    that empty ledger and proves this goes red under it.
    """
    expected = len(patch_entries())
    assert expected > 0, "the ledger holds no patch mutants at all"

    r = subprocess.run([sys.executable, str(RUNNER), "--dry-run"],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    # And the runner agrees about how many it looked at. A dry run that silently
    # examined fewer patches than the manifest declares is the same hole again,
    # one process further out.
    m = re.search(r"checked: (\d+) patch\(es\) apply", r.stdout)
    assert m, f"the runner did not report how many patches it checked:\n{r.stdout}"
    assert int(m.group(1)) == expected, (
        f"the runner checked {m.group(1)} patches; the manifest declares {expected}"
    )


def test_no_committed_patch_touches_a_test_file():
    """The refusal, asserted over the whole committed population.

    Also counted, for the reason above: "none of them patches a test file" is
    trivially true of an empty list, and an empty list is what a broken manifest
    produces.
    """
    entries = patch_entries()
    assert entries, "the ledger holds no patch mutants at all"
    examined = 0
    for e in entries:
        targets = mutants.patch_targets(e.patch.read_text())
        assert targets, f"{e.id}: the patch names no files, so it mutates nothing"
        bad = [t for t in targets if mutants._is_test_path(t)]
        assert not bad, f"{e.id} patches {bad}"
        examined += 1
    assert examined == len(entries), "a patch entry was skipped without saying so"


def test_the_population_check_reddens_when_the_ledger_holds_no_patches(ledger):
    """The counterexample for the two tests above, driven rather than argued.

    A ledger whose entries are all `kind = "sql"` is a legal manifest that
    contains not one patch. Before the count went in, BOTH tests above passed
    against it — `returncode == 0` and a `for` loop over an empty list. This
    shows each of them going red on the same input, which is the difference
    between a check and a decoration.
    """
    write(ledger, """
        [[mutant]]
        id = "s"
        kind = "sql"
        sql = "sql/only.sql"
        property = "a ledger with no patch entries at all"
        runner = "pytest"
        tests = ["tests/core/test_thing.py::test_x"]
        failing = 1

        [[control]]
        id = "c"
        kind = "sql"
        sql = "sql/only.sql"
        property = "must not redden"
        runner = "pytest"
        tests = ["tests/core/test_thing.py::test_x"]
    """)
    (ledger / "sql").mkdir()
    (ledger / "sql" / "only.sql").write_text("select 1;\n")

    assert patch_entries() == [], "the fixture did not produce a patch-free ledger"
    for check in (test_every_committed_patch_still_applies,
                  test_no_committed_patch_touches_a_test_file):
        with pytest.raises(AssertionError) as exc:
            check()
        assert "no patch mutants at all" in str(exc.value), (
            f"{check.__name__} failed for some other reason, so this proves nothing "
            f"about the population check: {exc.value}"
        )


# ───────────────────────────────────────────────────── the refusals, fired on purpose

@pytest.fixture
def ledger(tmp_path, monkeypatch):
    """A throwaway ledger directory, so the refusals below are driven for real.

    Monkeypatching the module's paths rather than building a whole repo: the
    rules under test are the manifest loader's, and the loader reads exactly
    these two names.
    """
    (tmp_path / "patches").mkdir()
    monkeypatch.setattr(mutants, "LEDGER", tmp_path)
    monkeypatch.setattr(mutants, "MANIFEST", tmp_path / "manifest.toml")
    return tmp_path


def write(ledger: Path, manifest: str, patches: dict[str, str] | None = None) -> None:
    (ledger / "manifest.toml").write_text(textwrap.dedent(manifest))
    for name, body in (patches or {}).items():
        (ledger / "patches" / name).write_text(body)


GOOD_PATCH = """\
diff --git a/core/thing.py b/core/thing.py
--- a/core/thing.py
+++ b/core/thing.py
@@ -1 +1 @@
-guard()
+pass
"""

TEST_PATCH = """\
diff --git a/tests/core/test_thing.py b/tests/core/test_thing.py
--- a/tests/core/test_thing.py
+++ b/tests/core/test_thing.py
@@ -1 +1 @@
-assert guarded
+assert True
"""

CONTROL = """
[[control]]
id = "c"
kind = "patch"
patch = "patches/good.patch"
property = "must not redden"
runner = "pytest"
tests = ["tests/core/test_thing.py::test_x"]
"""


def test_a_patch_that_edits_a_test_file_is_refused(ledger):
    """The one that matters most. Without it the cheapest way to satisfy this
    ledger is to break a test file, which proves nothing about any guard."""
    write(ledger, f"""
        [[mutant]]
        id = "cheat"
        kind = "patch"
        patch = "patches/cheat.patch"
        property = "p"
        runner = "pytest"
        tests = ["tests/core/test_thing.py::test_x"]
        failing = 1
        {CONTROL}
    """, {"cheat.patch": TEST_PATCH, "good.patch": GOOD_PATCH})
    with pytest.raises(mutants.ManifestError) as exc:
        mutants.load()
    assert "touches a test file" in str(exc.value)
    assert "tests/core/test_thing.py" in str(exc.value)


def test_a_webapp_spec_file_counts_as_a_test_file(ledger):
    """`webapp/tests/e2e/*.spec.ts` is not under a top-level `tests/`, and a rule
    written as a `tests/` prefix would have let it through."""
    spec_patch = GOOD_PATCH.replace("core/thing.py", "webapp/tests/e2e/layout.spec.ts")
    write(ledger, f"""
        [[mutant]]
        id = "cheat"
        kind = "patch"
        patch = "patches/cheat.patch"
        property = "p"
        runner = "playwright"
        spec = "tests/e2e/layout.spec.ts"
        failing = 1
        {CONTROL}
    """, {"cheat.patch": spec_patch, "good.patch": GOOD_PATCH})
    with pytest.raises(mutants.ManifestError) as exc:
        mutants.load()
    assert "touches a test file" in str(exc.value)


def test_a_mutant_without_a_failing_count_is_refused(ledger):
    write(ledger, f"""
        [[mutant]]
        id = "vague"
        kind = "patch"
        patch = "patches/good.patch"
        property = "p"
        runner = "pytest"
        tests = ["tests/core/test_thing.py::test_x"]
        {CONTROL}
    """, {"good.patch": GOOD_PATCH})
    with pytest.raises(mutants.ManifestError) as exc:
        mutants.load()
    assert "failing" in str(exc.value)


def test_a_manifest_with_no_control_is_refused(ledger):
    write(ledger, """
        [[mutant]]
        id = "m"
        kind = "patch"
        patch = "patches/good.patch"
        property = "p"
        runner = "pytest"
        tests = ["tests/core/test_thing.py::test_x"]
        failing = 1
    """, {"good.patch": GOOD_PATCH})
    with pytest.raises(mutants.ManifestError) as exc:
        mutants.load()
    assert "no [[control]]" in str(exc.value)


def test_an_empty_patch_is_refused(ledger):
    write(ledger, f"""
        [[mutant]]
        id = "empty"
        kind = "patch"
        patch = "patches/empty.patch"
        property = "p"
        runner = "pytest"
        tests = ["tests/core/test_thing.py::test_x"]
        failing = 1
        {CONTROL}
    """, {"empty.patch": "   \n", "good.patch": GOOD_PATCH})
    with pytest.raises(mutants.ManifestError) as exc:
        mutants.load()
    assert "empty" in str(exc.value)


def test_a_missing_patch_file_is_refused_rather_than_skipped(ledger):
    write(ledger, f"""
        [[mutant]]
        id = "gone"
        kind = "patch"
        patch = "patches/gone.patch"
        property = "p"
        runner = "pytest"
        tests = ["tests/core/test_thing.py::test_x"]
        failing = 1
        {CONTROL}
    """, {"good.patch": GOOD_PATCH})
    with pytest.raises(mutants.ManifestError) as exc:
        mutants.load()
    assert "no patch at" in str(exc.value)


def test_an_entry_with_no_property_is_refused(ledger):
    """The one-line statement of what the guard is FOR. Without it the ledger is
    a list of diffs and nobody can review whether the mutation is the right one."""
    write(ledger, f"""
        [[mutant]]
        id = "mute"
        kind = "patch"
        patch = "patches/good.patch"
        runner = "pytest"
        tests = ["tests/core/test_thing.py::test_x"]
        failing = 1
        {CONTROL}
    """, {"good.patch": GOOD_PATCH})
    with pytest.raises(mutants.ManifestError) as exc:
        mutants.load()
    assert "property" in str(exc.value)


# ───────────────────────────────────────── the counters, which decide every verdict

def test_pytest_errors_are_not_counted_as_failures(tmp_path):
    """A fixture that blew up is not a guard that was caught. The first version of
    the runner added `errors` to `failures`, which would have reported a database
    that was not there as ten guards working perfectly."""
    report = tmp_path / "r.xml"
    report.write_text(
        '<testsuites><testsuite tests="4" failures="1" errors="2" skipped="0">'
        "</testsuite></testsuites>"
    )
    failed, passed, errored = mutants._pytest_counts(report)
    assert (failed, passed, errored) == (1, 1, 2)


def test_skipped_pytest_cases_are_neither_red_nor_green(tmp_path):
    report = tmp_path / "r.xml"
    report.write_text(
        '<testsuites><testsuite tests="3" failures="0" errors="0" skipped="3">'
        "</testsuite></testsuites>"
    )
    assert mutants._pytest_counts(report) == (0, 0, 0)


def test_playwright_counts_come_from_its_own_stats(tmp_path):
    report = tmp_path / "r.json"
    report.write_text('{"stats": {"unexpected": 8, "expected": 1, "skipped": 1}, "errors": []}')
    assert mutants._playwright_counts(report) == (8, 1, 0)
