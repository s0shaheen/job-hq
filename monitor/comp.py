"""Compensation-range parsing for the intake gates.

`comp_range` arrives as free text from two places: the LLM tagger (which
copies whatever the posting stated) and aggregator fields. Real values in the
live feed, in frequency order:

    "$151,200 - $204,600"      most common — full dollars, hyphen
    "$182,000 — $250,208"      em dash, not hyphen
    "$160k-$190k"              k-suffixed
    "$150k+"                   floor only
    "up to $130k"              ceiling only
    "$120,000 USD - $150,000"  currency noise
    ""                         48% of rows state nothing at all

Everything is normalized to THOUSANDS of dollars, because that is the unit a
human sets a floor in ("don't show me anything under 120k").

Deliberately conservative: anything that doesn't parse cleanly returns
(None, None) — "unknown", which the gate treats under an explicit policy
knob. Guessing a number here would silently hide real jobs, and with ~half of
all postings stating no comp at all, an aggressive parser is far more
dangerous than a shy one.
"""
from __future__ import annotations

import re

# A money token: $150,000 / 150000 / $150k / 150K
_MONEY = re.compile(r"\$?\s*(\d[\d,]*\.?\d*)\s*([kK])?")
# Hourly/daily rates must never be read as salaries
_NON_ANNUAL = re.compile(r"\b(hour|hourly|/hr|per hour|day|daily|week|weekly|month|monthly)\b", re.I)

MIN_PLAUSIBLE_K = 10        # below this it isn't an annual salary in $k
MAX_PLAUSIBLE_K = 2000      # above this it's a typo or equity, not base


def _to_k(raw: str, k_suffix: bool) -> float | None:
    try:
        v = float(raw.replace(",", ""))
    except ValueError:
        return None
    if k_suffix:
        return v                      # "150k" -> 150
    if v >= 1000:
        return v / 1000.0             # "150000" -> 150
    return v                          # bare "150" already reads as $150k


def parse_comp(text: str) -> tuple[float | None, float | None]:
    """comp_range -> (min_k, max_k) in thousands of dollars.

    Either side may be None ("$150k+" has no ceiling; "up to $130k" has no
    floor). Both None means "unknown" — never assume.
    """
    s = (text or "").strip()
    if not s or _NON_ANNUAL.search(s):
        return (None, None)

    vals = []
    for m in _MONEY.finditer(s):
        v = _to_k(m.group(1), bool(m.group(2)))
        if v is not None and MIN_PLAUSIBLE_K <= v <= MAX_PLAUSIBLE_K:
            vals.append(v)
    if not vals:
        return (None, None)

    low = s.casefold()
    if len(vals) == 1:
        v = vals[0]
        if "up to" in low or low.startswith(("max", "under", "below")):
            return (None, v)          # ceiling only
        if "+" in s or "at least" in low or "starting" in low or "from" in low:
            return (v, None)          # floor only
        return (v, v)                 # a single stated figure
    return (min(vals), max(vals))


def meets_floor(text: str, floor_k: float) -> bool | None:
    """Does this comp range clear a floor (in $k)? None = unknown.

    Judged on the range's TOP: a posting listed at $110-160k clears a $120k
    floor, because the band the employer published includes it. Judging on the
    bottom would filter out most real negotiating ranges.
    """
    lo, hi = parse_comp(text)
    if lo is None and hi is None:
        return None
    ceiling = hi if hi is not None else lo
    return ceiling >= floor_k
