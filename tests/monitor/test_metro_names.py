"""The metro list exists in two languages. This is the mechanism that keeps it one list.

`monitor/metros.py` owns metro RESOLUTION — 250 lines of per-metro suburb
tables that turn "Naperville, IL" into "Chicago" — and none of that is ported.
The engine already wrote its answer into `postings.geo.metro`; the web app reads
it. What IS duplicated is the list of metro NAMES the profile wizard offers as
options, because there is no way for a browser to enumerate a Python dict.

A name spelled differently on the two sides is a filter that matches nothing:
`dispose` compares `geo.metro` against the profile's list with `==`, so
"Washington DC" here and "Washington D.C." there produces an empty queue and no
error anywhere. That is the exact silent starvation the profile phase exists to
remove, arriving through its own settings page.

Same shape as `status.test.ts` parsing `core/schema.py` (matrix row 105): a
comment saying "keep in step" is not a mechanism.
"""
from __future__ import annotations

import re
from pathlib import Path

from monitor.metros import METROS

TS = Path(__file__).resolve().parents[2] / "webapp" / "lib" / "profile" / "metros.ts"


def _ts_metro_names() -> list[str]:
    src = TS.read_text(encoding="utf-8")
    m = re.search(r"export const METRO_NAMES[^=]*=\s*\[(.*?)\]\s*as const;", src, re.S)
    assert m, "could not find METRO_NAMES in webapp/lib/profile/metros.ts"
    return re.findall(r'"([^"]+)"', m.group(1))


def test_the_parser_found_names():
    """Guards both assertions below from passing over an empty list — the
    vacuous-guard shape this repo has now been bitten by four times (matrix
    rows 92, 130, 163, 165)."""
    assert len(_ts_metro_names()) >= 10


def test_the_two_metro_lists_are_identical():
    """Same members AND same order.

    Order matters for a reason that is not cosmetic: the wizard renders these as
    a list, `METROS` is ordered roughly by size, and a re-ordering here would be
    a silent UI change nobody asked for. Comparing as lists rather than sets
    costs nothing and catches it.
    """
    assert _ts_metro_names() == list(METROS)
