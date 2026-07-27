"""The Python job key, pinned against the golden corpus the TypeScript port also reads.

`webapp/lib/import/job-key.ts` is a second implementation of `core/jobkeys.py`, because
Import has to tell a user "you already have this job" in the browser while discovery keys
the same posting in a Lambda. Two implementations of one identity function drift, and the
drift is silent: a key that differs by one character makes every re-import a duplicate,
with no error anywhere, discovered weeks later as two rows for the same job.

So both sides assert against ONE file — `tests/fixtures/jobkeys.golden.json`, whose keys
were RECORDED from `core.jobkeys.job_key`, never hand-typed. This suite is the Python half
(`webapp/tests/unit/job-key.test.ts` is the other). Change either implementation without
mirroring it and exactly one language goes red. That is the mechanism; a comment saying
"keep these in step" is not one. (`docs/plans/PHASE-IMPORT.md` §4.1, matrix row 29.)

The coverage tests at the bottom are what stop this from rotting quietly. A pattern added
to `_PATTERNS` with no golden case would otherwise be untested in BOTH languages — the
corpus would still pass, the port would still pass, and the new ATS family would be the one
thing nobody checked.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.jobkeys import _PATTERNS, ats_of, is_strong, job_key

GOLDEN = Path(__file__).resolve().parents[1] / "fixtures" / "jobkeys.golden.json"
CASES = json.loads(GOLDEN.read_text())

#: Distinct ATS tokens in `_PATTERNS`, in first-appearance order. `eightfold` has three
#: patterns and `greenhouse` two, so this is shorter than `_PATTERNS`.
ATS_TOKENS = list(dict.fromkeys(ats for ats, _ in _PATTERNS))


def _first_matching_pattern(url: str) -> int | None:
    """The index of the pattern `job_key` would use — the same first-match-wins loop."""
    u = (url or "").strip()
    if not u:
        return None
    for i, (_ats, pat) in enumerate(_PATTERNS):
        if pat.search(u):
            return i
    return None


def test_the_corpus_is_actually_loaded():
    """Guards every parametrized case below from vacuously passing on an empty file."""
    assert len(CASES) >= 60, f"only {len(CASES)} cases — the corpus was trimmed"
    assert {"why", "url", "company", "title", "location", "key", "strong"} == set(CASES[0])
    whys = [c["why"] for c in CASES]
    assert len(set(whys)) == len(whys), "duplicate `why` labels make a failure unidentifiable"


@pytest.mark.parametrize("case", CASES, ids=[c["why"] for c in CASES])
def test_golden_corpus(case):
    assert job_key(case["url"], case["company"], case["title"], case["location"]) == case["key"]


@pytest.mark.parametrize("case", CASES, ids=[c["why"] for c in CASES])
def test_golden_strength(case):
    assert is_strong(case["key"]) is case["strong"]


def test_every_ats_token_is_exercised():
    """A pattern added to the Python without a golden case fails HERE, not silently.

    Asserted on the recorded keys rather than on the URLs, because that is what the
    TypeScript side compares too: a token nothing produces is a family neither language
    is testing.
    """
    produced = {c["key"].split("-", 1)[0] for c in CASES if c["strong"]}
    missing = [ats for ats in ATS_TOKENS if ats not in produced]
    assert not missing, f"no golden case produces a key for: {missing}"


def test_every_pattern_is_the_winner_for_some_case():
    """Stronger than the token check, and the one that catches a *new* pattern.

    `eightfold` has three separate patterns; a token-level check would call the family
    covered while two of the three went unexercised. And `sfsf` is deliberately last, so a
    pattern appended after it could never win a case that exists today — which is exactly
    the condition this asserts is impossible to leave in place.
    """
    winners = {_first_matching_pattern(c["url"]) for c in CASES}
    unexercised = [
        f"[{i}] {ats} /{pat.pattern}/"
        for i, (ats, pat) in enumerate(_PATTERNS)
        if i not in winners
    ]
    assert not unexercised, "patterns no golden case reaches:\n  " + "\n  ".join(unexercised)


def test_both_fallbacks_and_the_empty_key_are_in_the_corpus():
    """The three non-ATS outcomes. Losing any of them from the corpus would leave the
    hairiest half of the port — `_norm_token` truncation and the `urlparse` split —
    unguarded while the suite stayed green."""
    assert sum(1 for c in CASES if c["key"].startswith("norm-")) >= 10
    assert sum(1 for c in CASES if c["key"].startswith("url-")) >= 10
    assert sum(1 for c in CASES if c["key"] == "") >= 1


def test_weak_keys_are_never_recorded_as_strong():
    """`is_strong` is the only thing allowed to authorize an import merge, so a `strong:
    true` on a `norm-`/`url-` case would hand the TypeScript port permission to merge
    rows on a guess."""
    for case in CASES:
        weak = case["key"].startswith(("norm-", "url-")) or not case["key"]
        assert case["strong"] is (not weak), case["why"]


def test_ats_of_agrees_with_the_recorded_keys():
    for case in CASES:
        if case["strong"]:
            assert ats_of(case["key"]) in ATS_TOKENS, case["why"]
