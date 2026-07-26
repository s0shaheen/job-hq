"""The identity of a company NAME — the Python mirror of `public.company_name_key(text)`.

Three implementations of one rule now exist, and they must agree or the feature they
serve is worse than not having it:

  * `public.company_name_key(text)` (migration 0008) — the one the *database* indexes
    and the paste path matches on;
  * `companyNameKey` in `webapp/lib/data/view-models.ts` — the one the browser's fake
    data source matches on;
  * this one — the one the **resolver** matches on when it decides whether a grounded
    board upgrades an existing ungrounded row or mints a sibling beside it
    (`monitor.discover_universe.reconcile`).

The agreement is PINNED, not asserted in prose:
`tests/db/test_universe_reconcile.py` runs this function and `public.company_name_key`
over one corpus (`tests/fixtures/company_name_key.golden.json`) inside real Postgres, and
`tests/core/test_companykeys.py` pins this side against the same file without a database.

WHERE THEY DIVERGE, AND WHY IT IS SURVIVABLE. They are not identical functions and the
corpus says so out loud. `lower()` in Postgres folds 'İ' (U+0130) to a single 'i';
Python's `str.lower()` (and `str.casefold()`, and JS's `toLowerCase()`) produce 'i' plus
a combining dot, U+0307. That is a real, measured disagreement, recorded in the corpus as
a `sql_key` on the affected case rather than papered over.

It is survivable because **this function's output never reaches SQL.**
`reconcile_grounded_company` is handed the RAW name and computes the key itself, so every
match the database performs is Postgres-vs-Postgres. This port is used only for LOCAL
decisions — deduping a batch, and "has this user already ruled on this name", where both
sides of the comparison come from here. The worst a divergence buys is a redundant HTTP
probe or a skip that did not happen; it cannot produce a wrong write. What WOULD matter is
a disagreement about whether a name folds to the empty string at all (that decides
"skipped" on both sides), and no known locale does that.

The folded sets are listed as CODEPOINTS and the patterns built from them, rather than
typed into a string literal. Two reasons, both learned in this feature: a character class
of invisible characters is a rule nobody can review (0008's test file says the same thing
about test data), and Python's own `\\s` is a superset of what Postgres folds here — it
adds U+0085 and U+001C-U+001F — so leaning on it would quietly make Python disagree with
the database on exactly the strings this exists to settle. (The TypeScript port DOES use
JS's `\\s`, alongside the same enumerated unicode spaces; that works because JS's `\\s`
happens not to include U+0085 or the C1 controls. Python's does, which is why only this
port has to spell ASCII whitespace out.)

`.strip(" ")` — not `.strip()` — mirrors `btrim(text)`, which removes spaces and nothing
else; by then every run of whitespace has already collapsed to one plain space, so the
two agree.

Deliberately NOT a slugifier. Punctuation survives: "Guggenheim Partners, LLC" and
"Guggenheim Partners LLC" are different registered names, and a wrong MERGE is
unrecoverable where a duplicate is merely untidy.
"""
from __future__ import annotations

import re

#: Zero-width invisibles, dropped outright. 0008 runs this pass FIRST and the order
#: matters: U+FEFF must be gone before the space pass rather than folded into a space,
#: or a name ending in a BOM and the same name ending in a space would key differently.
_ZERO_WIDTH_CHARS = (0x200B, 0x200C, 0x200D, 0xFEFF)

#: Every separator 0008's expression treats as whitespace: ASCII whitespace (tab, LF,
#: VT, FF, CR, space) plus the unicode spaces it enumerates by hand.
_SPACE_CHARS = (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20,
                0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000)
_SPACE_RANGES = ((0x2000, 0x200A),)   # EN QUAD .. HAIR SPACE


def _char_class(chars=(), ranges=()) -> str:
    body = "".join(chr(c) for c in chars)
    body += "".join(f"{chr(lo)}-{chr(hi)}" for lo, hi in ranges)
    return f"[{body}]"


_ZERO_WIDTH = re.compile(_char_class(_ZERO_WIDTH_CHARS))
_SPACES = re.compile(_char_class(_SPACE_CHARS, _SPACE_RANGES) + "+")


def company_name_key(name: str | None) -> str:
    """Normalized company-name identity: case- and whitespace-folded, punctuation kept."""
    return _SPACES.sub(" ", _ZERO_WIDTH.sub("", name or "")).strip(" ").lower()
