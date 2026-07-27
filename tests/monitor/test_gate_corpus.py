"""The Python half of the two-language gate contract.

`tests/fixtures/gate-corpus.json` is executed here and, case for case, in
`webapp/tests/unit/gate-corpus.test.ts`. The reason it exists is a specific
silent failure: the profile preview tells somebody "your settings would have
qualified 61 of these 4,182 postings", and if the TypeScript gate disagrees
with `monitor/gates.py` by one branch, that number is a lie the person cannot
check. It is the same shape as `job_key` (matrix row 140), where a key
differing by one character made every re-import a duplicate — and the answer is
the same one: one fixture, asserted from both languages.

This file is deliberately thin. It asserts the corpus against the AUTHORITY
(`monitor.gates.dispose`) rather than against a paraphrase of it, so a case
whose `expect` is wrong fails here first and gets fixed in the fixture.
"""
from __future__ import annotations

import json
from dataclasses import fields
from pathlib import Path

import pytest

from monitor.gates import FILTERED, NEEDS_INFO, QUALIFIED, GateConfig, dispose

CORPUS_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "gate-corpus.json"
CORPUS = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
CASES = CORPUS["cases"]

DISPOSITIONS = {QUALIFIED, FILTERED, NEEDS_INFO}


def _reason_kind(reason: str) -> str:
    """The part of a reason before its colon — `geo:India` -> `geo`, `` -> ``."""
    return reason.split(":")[0]


def test_the_corpus_loaded_and_has_cases():
    """Guards every parametrised check below from vacuously passing on zero cases.

    Matrix rows 92/130/163: a guard that cannot read its own contract passes
    silently and is counted. A typo in CORPUS_PATH would otherwise turn this
    whole file green.
    """
    assert len(CASES) >= 50, len(CASES)


def test_case_ids_are_unique():
    """The ids are what a failure names. Two cases sharing one id means a
    failure report points at the wrong row, and a duplicate id is how a case
    gets silently replaced during an edit."""
    ids = [c["id"] for c in CASES]
    assert len(set(ids)) == len(ids), sorted({i for i in ids if ids.count(i) > 1})


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["id"])
def test_python_dispose_matches_the_corpus(case):
    g = GateConfig(**case["config"])
    assert list(dispose(case["row"], g)) == case["expect"], case["why"]


def test_the_corpus_defaults_are_gateconfigs_defaults():
    """The corpus's `defaults` block is what the TypeScript port implements, so
    it has to BE `GateConfig()`'s defaults rather than a copy that once was.

    Without this, changing `yoe_max`'s default in Python leaves every corpus
    case that names `yoe_max` green while the two languages silently disagree
    about every case that does not.
    """
    declared = CORPUS["defaults"]
    actual = GateConfig()
    for name, value in declared.items():
        assert hasattr(actual, name), f"corpus declares a default for unknown field {name}"
        assert getattr(actual, name) == value, name
    # And the other direction: a NEW GateConfig field with no entry here is a
    # knob the TypeScript port has never heard of.
    gate_fields = {f.name for f in fields(GateConfig)}
    assert gate_fields == set(declared), sorted(gate_fields ^ set(declared))


def test_every_reason_kind_in_the_closed_set_has_a_case():
    """docs/PRODUCT-SPEC.md A2 lists the closed set. A gate rule added with no
    corpus row would otherwise be untested in BOTH languages, which is the
    failure mode this whole fixture exists to remove (matrix row 79)."""
    produced = {
        _reason_kind(dispose(c["row"], GateConfig(**c["config"]))[1]) for c in CASES
    }
    missing = set(CORPUS["kinds"]) - produced
    assert not missing, f"no corpus case produces these reason kinds: {sorted(missing)}"


def test_no_case_produces_a_reason_kind_outside_the_closed_set():
    """The other half. A new kind Python starts emitting is a string the web
    app's `explainReason` renders raw — "metro:Chicago" in front of a human."""
    for case in CASES:
        _, reason = dispose(case["row"], GateConfig(**case["config"]))
        kind = _reason_kind(reason)
        assert kind in CORPUS["kinds"], f"{case['id']} produced unknown reason kind {kind!r}"


def test_every_case_expects_a_real_disposition():
    """A typo'd `expect[0]` ("qualifed") would make the TypeScript assertion
    agree with the Python one about a value neither implementation can return."""
    for case in CASES:
        assert case["expect"][0] in DISPOSITIONS, case["id"]


def test_every_case_says_why_it_exists():
    """The corpus is the contract, and a case with no stated reason is a case
    the next person deletes when it becomes inconvenient."""
    for case in CASES:
        assert case.get("why", "").strip(), case["id"]
