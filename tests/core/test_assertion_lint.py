"""The assertion-strength lint's own safety properties.

`scripts/assertion_lint.py` exists because this repo's most expensive recurring
defect is a test that passes with its own fix removed — seven occurrences, the
latest found by the pinned-mutant ledger on its first run. Two of those seven
were visible statically: one test asserted nothing, and one asserted only an
absence (`count == 0`) against a table its fixture never populated.

A lint for weak tests has the same failure mode as the tests it polices: it can
pass because it looks at nothing. So every property here is asserted against
the REAL module, driven with fixture files written on disk, in both directions:

  1. an assertion-free test is FLAGGED, and the same file with one assertion
     added is not (the counterexample);
  2. an absence-only test is FLAGGED, and the same file with one positive
     assertion added is not;
  3. a legitimate absence test WITH a justification comment PASSES, and the
     same test with the comment deleted is flagged again;
  4. the escape hatch cannot be a bare `noqa`: a reasonless waiver is its own
     failure, and one that no longer waives anything is too;
  5. the false-positive cases the repo actually contains — helper-only tests,
     `pytest.raises` blocks, `pytest.fail` callbacks, parametrised tests,
     unittest classes — are NOT flagged. This is the block that decides whether
     the lint survives its first week.
  6. the baseline holds pre-existing findings without failing, while a NEW one
     fails immediately, and a baseline entry that stops matching fails too.

Plus: the committed baseline is accurate, so `scripts/assertion_lint.py` on the
real tree is green and nobody learns to ignore it.

These run in the plain 3.11 suite (`pytest tests/core`) — stdlib only, no
Docker and no database.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
LINT = REPO / "scripts" / "assertion_lint.py"
BASELINE = REPO / "scripts" / "assertion_lint_baseline.json"

sys.path.insert(0, str(REPO / "scripts"))
import assertion_lint as lint  # noqa: E402


def write(tmp_path: Path, body: str, name: str = "test_fixture.py") -> Path:
    p = tmp_path / name
    p.write_text(body, encoding="utf-8")
    return p


def rules_for(tmp_path: Path, body: str) -> dict[str, str]:
    """{test name: rule} for the findings in one fixture file."""
    write(tmp_path, body)
    return {f.test: f.rule for f in lint.scan([tmp_path], repo=tmp_path)}


# ─────────────────────────────────────────── 1. a test that asserts nothing

ASSERTION_FREE = '''
def helper(x):
    return x + 1

def test_it_does_not_explode():
    """The shape of defect #4: calls the thing, checks nothing, passes with the
    whole implementation replaced by `pass`."""
    helper(1)
'''


def test_an_assertion_free_test_is_flagged(tmp_path: Path) -> None:
    assert rules_for(tmp_path, ASSERTION_FREE) == {"test_it_does_not_explode": "no-assertions"}


def test_the_same_test_with_one_assertion_is_clean(tmp_path: Path) -> None:
    """The counterexample. Without this, a lint that flagged EVERY test would
    pass the check above while being useless."""
    # assertion-lint: absence-only: "no findings" is the counterexample's whole
    # claim, and it is anchored by test_an_assertion_free_test_is_flagged above,
    # which proves the same fixture DOES get flagged before the assert is added.
    fixed = ASSERTION_FREE.replace("    helper(1)", "    assert helper(1) == 2")
    assert fixed != ASSERTION_FREE, "the fixture body moved; update this mutation"
    assert rules_for(tmp_path, fixed) == {}


# ────────────────────────────────────────── 2. a test that only asserts absence

ABSENCE_ONLY = '''
def test_the_table_stays_empty(conn):
    """Defect #7 exactly: the fixture never populated the table, so `== 0` was
    true before the fix, after it, and with the feature deleted."""
    rows = conn.execute("select count(*) from thing").fetchone()[0]
    assert rows == 0
'''


def test_an_absence_only_test_is_flagged(tmp_path: Path) -> None:
    assert rules_for(tmp_path, ABSENCE_ONLY) == {"test_the_table_stays_empty": "absence-only"}


def test_one_positive_assertion_clears_it(tmp_path: Path) -> None:
    """The counterexample for rule 2: a mixed test is a normal test."""
    # assertion-lint: absence-only: paired with test_an_absence_only_test_is_flagged,
    # which flags this exact fixture without the added positive assertion.
    fixed = ABSENCE_ONLY + '    assert conn.execute("select 1").fetchone()[0] == 1\n'
    assert rules_for(tmp_path, fixed) == {}


@pytest.mark.parametrize(
    "expr",
    [
        'x not in y',
        'x is None',
        'not x',
        'x != y',
        'x == []',
        'x == {}',
        'x == ""',
        'x == 0',
        'x == set()',
        'x == False',
        'len(x) == 0',
        'x is not y',
        'not x and y is None',
    ],
)
def test_every_negative_form_is_recognised(tmp_path: Path, expr: str) -> None:
    body = f"def test_only_negative(x=1, y=2):\n    assert {expr}\n"
    assert rules_for(tmp_path, body) == {"test_only_negative": "absence-only"}


@pytest.mark.parametrize(
    "expr",
    [
        'x in y',
        'x == 3',
        'x == [1]',
        'x is True',
        'x',
        'len(x) == 2',
        'x > 0',
        'not x or y == 3',       # one positive part is enough
    ],
)
def test_positive_forms_are_not_mistaken_for_absence(tmp_path: Path, expr: str) -> None:
    """The other direction. Over-flagging is the failure mode that gets a lint
    deleted, so each of these has to stay silent."""
    # assertion-lint: absence-only: the negative twin,
    # test_every_negative_form_is_recognised, proves the classifier fires at all,
    # so an empty result here is a decision and not a silent no-op.
    body = f"def test_positive(x=1, y=2):\n    assert {expr}\n"
    assert rules_for(tmp_path, body) == {}


# ──────────────────────────────────────────────── 3. the justification hatch

JUSTIFIED = '''
def test_the_dumped_file_contains_no_secret(dump):
    # assertion-lint: absence-only: absence IS the property under test, and the
    # positive half is covered by test_the_dump_contains_the_expected_tables.
    assert "SECRET" not in dump.read_text()
'''


def test_a_justified_absence_test_passes(tmp_path: Path) -> None:
    # assertion-lint: absence-only: this IS the "a waiver silences it" property;
    # test_deleting_the_justification_flags_it_again is its positive half.
    assert rules_for(tmp_path, JUSTIFIED) == {}


def test_deleting_the_justification_flags_it_again(tmp_path: Path) -> None:
    """Proves the pass above came from the comment and not from the lint failing
    to see the test at all."""
    stripped = "\n".join(l for l in JUSTIFIED.splitlines()
                         if "assertion-lint" not in l and "positive half" not in l)
    assert rules_for(tmp_path, stripped) == {
        "test_the_dumped_file_contains_no_secret": "absence-only"}


def test_a_no_assertions_waiver_works_too(tmp_path: Path) -> None:
    body = ASSERTION_FREE.replace(
        "    helper(1)",
        "    # assertion-lint: no-assertions: the property IS that this call does\n"
        "    # not raise; there is no return value to assert on.\n"
        "    helper(1)",
    )
    # assertion-lint: absence-only: same bargain as the absence-only waiver test;
    # ASSERTION_FREE without the comment is flagged two tests above.
    assert rules_for(tmp_path, body) == {}


# ───────────────────────────────────────────── 4. the hatch cannot be a noqa

def test_a_reasonless_waiver_is_itself_a_failure(tmp_path: Path) -> None:
    body = 'def test_x(y=1):\n    # assertion-lint: absence-only: nope\n    assert y is None\n'
    assert rules_for(tmp_path, body) == {"test_x": "waiver-no-reason"}


def test_a_bare_directive_with_no_reason_at_all_is_a_failure(tmp_path: Path) -> None:
    body = 'def test_x(y=1):\n    # assertion-lint: absence-only\n    assert y is None\n'
    assert rules_for(tmp_path, body) == {"test_x": "waiver-no-reason"}


def test_a_waiver_naming_an_unknown_rule_is_a_failure(tmp_path: Path) -> None:
    body = ('def test_x(y=1):\n'
            '    # assertion-lint: everything: I would simply like to be exempted from all of it\n'
            '    assert y is None\n')
    assert rules_for(tmp_path, body) == {"test_x": "waiver-no-reason"}


def test_a_waiver_that_no_longer_waives_anything_is_a_failure(tmp_path: Path) -> None:
    """A suppression that stops suppressing is how a gate quietly stops gating —
    the same bargain the copy lint's stale-allowlist rule makes."""
    body = ('def test_x(y=1):\n'
            '    # assertion-lint: absence-only: kept from when this only checked an absence\n'
            '    assert y == 1\n')
    assert rules_for(tmp_path, body) == {"test_x": "waiver-stale"}


def test_a_reason_may_wrap_across_comment_lines(tmp_path: Path) -> None:
    """Reasons are prose and prose wraps. If only the directive's own line
    counted, the length floor would be a formatting rule, not a substance one —
    and the cure would be writing one very long line, which nobody reads."""
    body = ('def test_x(y=1):\n'
            '    # assertion-lint: absence-only: short\n'
            '    # but continued across a second line, which is where the substance is\n'
            '    assert y is None\n')
    assert rules_for(tmp_path, body) == {}

    detached = body.replace("    # but continued", "\n    # but continued")
    assert rules_for(tmp_path, detached) == {"test_x": "waiver-no-reason"}, (
        "a non-contiguous comment must not be absorbed as the reason")


def test_a_waiver_belongs_to_the_test_it_sits_in(tmp_path: Path) -> None:
    """A directive must not leak to the next function, or one waiver disarms a
    whole file."""
    body = ('def test_first(y=1):\n'
            '    # assertion-lint: absence-only: this one really is an absence property\n'
            '    assert y is None\n'
            '\n'
            'def test_second(y=1):\n'
            '    assert y is None\n')
    assert rules_for(tmp_path, body) == {"test_second": "absence-only"}


# ──────────────────────────────── 5. the false positives that would kill it

NOT_FLAGGED = {
    "pytest.raises block": '''
import pytest
def test_it_refuses():
    with pytest.raises(ValueError):
        int("nope")
''',
    "unittest assertion": '''
import unittest
class TestThing(unittest.TestCase):
    def test_equal(self):
        self.assertEqual(1, 1)
''',
    "unittest assertRaises": '''
import unittest
class TestThing(unittest.TestCase):
    def test_raises(self):
        with self.assertRaises(ValueError):
            int("nope")
''',
    "a helper that asserts internally": '''
def expect_denied(exc):
    assert "permission denied" in str(exc)

def test_the_role_is_denied(exc):
    expect_denied(exc)
''',
    "a helper two hops away": '''
def inner(x):
    assert x

def outer(x):
    inner(x)

def test_via_two_hops(x=1):
    outer(x)
''',
    "a helper defined in another file": '''
from .helpers import expect_denied

def test_the_role_is_denied(exc):
    expect_denied(exc)
''',
    "pytest.fail in a callback": '''
import pytest
def test_nothing_is_written(monkeypatch):
    monkeypatch.setattr("core.pg.insert", lambda *a, **k: pytest.fail("wrote a row"))
    run()
''',
    "parametrised, one positive assert": '''
import pytest
@pytest.mark.parametrize("v", ["a", "b"])
def test_each_value_maps(v):
    assert lookup(v) == v.upper()
''',
    "an assert with a message": '''
def test_with_a_message(x=1):
    assert x == 1, "the message must not change the classification"
''',
    "a nested helper closure": '''
def test_uses_a_closure(rows):
    def check(row):
        assert row["id"]
    for row in rows:
        check(row)
''',
}


@pytest.mark.parametrize("label,body", sorted(NOT_FLAGGED.items()))
def test_real_repo_patterns_are_not_false_positives(tmp_path: Path, label: str, body: str) -> None:
    # The cross-file helper case needs the helper to exist somewhere in the tree,
    # which is the whole point of the registry being tree-wide and name-based.
    write(tmp_path, 'def expect_denied(exc):\n    assert "denied" in str(exc)\n', "test_helpers.py")
    # assertion-lint: absence-only: "the lint found nothing" IS the property, and
    # every one of these bodies is paired with a flagged variant elsewhere in
    # this file, so an empty result here cannot come from the lint seeing nothing.
    assert rules_for(tmp_path, body) == {}, label


def test_the_helper_registry_only_registers_asserting_helpers(tmp_path: Path) -> None:
    """The counterexample for the registry: a helper that does NOT assert must
    not rescue its caller, or every test that calls any function is exempt."""
    body = '''
def build_payload(x):
    return {"x": x}

def test_builds_a_payload():
    build_payload(1)
'''
    assert rules_for(tmp_path, body) == {"test_builds_a_payload": "no-assertions"}


# ──────────────────────────────────────────────────────────── 6. the baseline

def test_a_baselined_finding_does_not_fail_but_a_new_one_does(tmp_path: Path) -> None:
    write(tmp_path, ABSENCE_ONLY)
    findings = lint.scan([tmp_path], repo=tmp_path)
    baseline = lint.baseline_document(findings)
    assert baseline["entries"], "the baseline document recorded nothing"
    assert baseline["generated"], "the baseline must be dated"

    new, held, stale = lint.apply_baseline(findings, baseline)
    assert not new and not stale
    assert len(held) == 1

    # Now add a SECOND weak test. The baselined one stays held; the new one fails.
    write(tmp_path, ABSENCE_ONLY + '\ndef test_new_weak_one(v=1):\n    assert v is None\n')
    new, held, stale = lint.apply_baseline(lint.scan([tmp_path], repo=tmp_path), baseline)
    assert [f.test for f in new] == ["test_new_weak_one"], new
    assert len(held) == 1


def test_a_baseline_entry_that_stops_matching_fails(tmp_path: Path) -> None:
    """The baseline may only shrink. Fixing a test means deleting its entry in
    the same commit, and a dead entry hides a live one."""
    write(tmp_path, ABSENCE_ONLY)
    baseline = lint.baseline_document(lint.scan([tmp_path], repo=tmp_path))

    fixed = ABSENCE_ONLY.replace("    assert rows == 0", "    assert rows == 0\n    assert rows < 1")
    write(tmp_path, fixed)
    new, held, stale = lint.apply_baseline(lint.scan([tmp_path], repo=tmp_path), baseline)
    assert not held
    assert len(stale) == 1, stale
    assert stale[0]["test"] == "test_the_table_stays_empty"


def test_a_waiver_failure_can_never_be_baselined(tmp_path: Path) -> None:
    """A broken escape hatch is a defect in the lint's own contract. Letting it
    be recorded as pre-existing would make the hatch unenforceable."""
    write(tmp_path, 'def test_x(y=1):\n    # assertion-lint: absence-only: nope\n    assert y is None\n')
    findings = lint.scan([tmp_path], repo=tmp_path)
    fake = {"entries": [{"file": f.file, "test": f.test, "rule": f.rule} for f in findings]}
    new, held, _ = lint.apply_baseline(findings, fake)
    assert [f.rule for f in new] == ["waiver-no-reason"], new
    # And the rule itself still trips, because a reasonless waiver waives nothing.
    assert [f.rule for f in held] == ["absence-only"], held


# ─────────────────────────────────────── the real tree, and the real CLI

def test_the_committed_baseline_is_accurate() -> None:
    """The lint must be GREEN on the tree as committed. A lint that is red on
    arrival is a lint everyone learns to ignore."""
    r = subprocess.run([sys.executable, "-W", "ignore", str(LINT)],
                       cwd=REPO, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert "0 new" in r.stdout, r.stdout


def test_the_baseline_is_dated_and_explains_itself() -> None:
    doc = json.loads(BASELINE.read_text())
    assert doc["generated"], "an undated baseline is a list nobody knows the age of"
    assert len(doc["note"]) > 80, "the baseline must say what it is and that it may only shrink"
    assert doc["entries"], "an empty baseline means the lint stopped finding anything; verify that"
    for e in doc["entries"]:
        assert e["rule"] in lint.RULES, e
        assert (REPO / e["file"]).exists(), f"baseline names a file that is gone: {e['file']}"


def test_the_cli_exits_nonzero_on_a_new_finding(tmp_path: Path) -> None:
    """End to end through the actual command CI runs, not the library."""
    write(tmp_path, ABSENCE_ONLY)
    empty = tmp_path / "baseline.json"
    empty.write_text('{"generated": "2026-08-02", "entries": []}')
    r = subprocess.run(
        [sys.executable, "-W", "ignore", str(LINT), "--root", str(tmp_path), "--baseline", str(empty)],
        cwd=REPO, capture_output=True, text=True, timeout=120)
    assert r.returncode == 1, r.stdout
    assert "absence-only" in r.stderr
    assert "test_the_table_stays_empty" in r.stderr
    assert "# assertion-lint: absence-only:" in r.stderr, "the failure must name its own hatch"


def test_the_cli_exits_zero_when_clean(tmp_path: Path) -> None:
    """The counterexample for the CLI check: the harness itself is not just
    broken-by-construction."""
    write(tmp_path, 'def test_ok(x=1):\n    assert x == 1\n')
    empty = tmp_path / "baseline.json"
    empty.write_text('{"generated": "2026-08-02", "entries": []}')
    r = subprocess.run(
        [sys.executable, "-W", "ignore", str(LINT), "--root", str(tmp_path), "--baseline", str(empty)],
        cwd=REPO, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    # `returncode == 0` alone would pass on a run that scanned nothing, which is
    # the exact defect this lint exists for, so the run has to say what it saw.
    assert "clean" in r.stdout and "0 new" in r.stdout, r.stdout


def test_an_unparseable_test_file_is_loud_not_skipped(tmp_path: Path) -> None:
    """Silently skipping a file it cannot read is how a lint reports a clean
    tree it never looked at."""
    write(tmp_path, "def test_broken(:\n")
    with pytest.raises(SystemExit) as exc:
        lint.scan([tmp_path], repo=tmp_path)
    assert "cannot parse" in str(exc.value)
