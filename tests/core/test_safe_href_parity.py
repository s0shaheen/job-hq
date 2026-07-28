"""`core.digest_links.safe_href` against the SHARED case list.

`tests/fixtures/safe-href-cases.json` is the one authority (see its header). The
TS twin `webapp/lib/url/safe-href.ts` is held to the same file by
`webapp/tests/unit/safe-href.test.ts`, so the guard the store trusts and the
guard the email trusts can no longer disagree by one backslash — which was the
C2 review's M6.

MUTATION TARGETS:
  * drop `\\` from `_UNSAFE_CHARS`        -> the `evil.com\\@good.com` case;
  * drop the `%` authority check          -> the `%40` case;
  * drop the empty-authority check        -> `https:///nohost`;
  * search the whole URL for `@`, not the authority -> the `/@handle` case.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.digest_links import safe_href

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / "tests" / "fixtures" / "safe-href-cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[repr(c["in"])[:40] for c in CASES])
def test_safe_href_matches_the_shared_fixture(case):
    assert safe_href(case["in"]) == case["out"], case["why"]


def test_the_corpus_did_not_shrink():
    # A fixture that quietly loses cases is a guard that quietly stopped being
    # tested. The TS side asserts the same floor.
    assert len(CASES) >= 30
