"""The Python company-name key, pinned against the golden corpus — no database needed.

The same file `tests/db/test_universe_reconcile.py` feeds to `public.company_name_key`
inside real Postgres. Two suites, one corpus: this one proves Python does what the corpus
says, that one proves Postgres agrees, and together they are what lets a Python reconciler
drive a match the database performs.

Keeping the corpus in a file rather than inline is the point. An assertion written twice
drifts; a fixture read twice cannot.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.companykeys import company_name_key

GOLDEN = Path(__file__).resolve().parents[1] / "fixtures" / "company_name_key.golden.json"
CASES = json.loads(GOLDEN.read_text())

NBSP = chr(0x00A0)
ZWSP = chr(0x200B)
BOM = chr(0xFEFF)


def test_the_corpus_is_actually_loaded():
    """Guards every parametrized case below from vacuously passing on an empty file."""
    assert len(CASES) >= 30, f"only {len(CASES)} cases — the corpus was trimmed"
    assert {"why", "name", "key"} <= set(CASES[0])


@pytest.mark.parametrize("case", CASES, ids=[c["why"] for c in CASES])
def test_golden_corpus(case):
    assert company_name_key(case["name"]) == case["key"]


def test_none_is_the_empty_key():
    """The column is NOT NULL, but a candidate dict's `name` may be missing entirely —
    `.get("name")` hands this function None and it must not raise."""
    assert company_name_key(None) == ""


def test_the_key_is_idempotent():
    """Folding an already-folded name changes nothing. The reconciler compares a key
    against keys stored by another implementation, so a non-idempotent fold would make
    the match depend on how many times each side had normalized."""
    for case in CASES:
        once = company_name_key(case["name"])
        assert company_name_key(once) == once, case["why"]


#: Whitespace to Python's `\\s`, NOT to migration 0008's expression. Codepoints, never
#: typed in — these are control characters.
PY_ONLY_SPACES = (0x0085, 0x001C, 0x001D, 0x001E, 0x001F)


@pytest.mark.parametrize("cp", PY_ONLY_SPACES, ids=[f"U+{c:04X}" for c in PY_ONLY_SPACES])
def test_python_whitespace_that_postgres_does_not_fold_is_left_alone(cp):
    """The reason the character classes are spelled out instead of using `\\s`.

    Python's `\\s` matches U+0085 (NEL) and U+001C-U+001F; the expression in migration
    0008 does not. If this function leaned on `\\s` it would fold a name Postgres keeps
    distinct, and the reconciler would ask the database to upgrade a row whose key it
    computed differently — a match that silently never happens. The character has to
    SURVIVE, which is the assertion no amount of reading either implementation gives you.
    """
    ch = chr(cp)
    assert company_name_key(f"Aon{ch}Group") == f"aon{ch}group"
    assert ch in company_name_key(f"Aon{ch}Group")


def test_punctuation_is_never_folded():
    """Not a slugifier, deliberately: a wrong MERGE is unrecoverable from inside the app,
    where a duplicate is merely untidy."""
    assert company_name_key("Guggenheim Partners, LLC") != company_name_key(
        "Guggenheim Partners LLC")
    assert company_name_key("AT&T") == "at&t"
    assert company_name_key("Kraft-Heinz") != company_name_key("Kraft Heinz")


def test_the_three_bugs_it_was_written_for():
    """0008's header names them: two pastes in different cases, and the trailing NBSP a
    web page brings along that `btrim()` does not strip."""
    assert company_name_key("Aon") == company_name_key("aon") == company_name_key("AON")
    assert company_name_key("Aon" + NBSP) == "aon"
    assert company_name_key(BOM + "Aon" + ZWSP) == "aon"
