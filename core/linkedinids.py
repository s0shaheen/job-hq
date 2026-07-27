"""The identity of a LinkedIn company id — the Python mirror of
`webapp/lib/referral/linkedin.ts`.

Migration 0013 put `companies.linkedin_company_id` on the shared company row and
gave it exactly one writer: a person pasting a number off their own URL bar
(`app_set_linkedin_company_id`). This module exists because the engine is about
to become the second writer, and 0013's header already named the hazard that
creates:

    "a reader cannot assume the column holds digits, and
     `webapp/lib/referral/linkedin.ts` refuses to build a URL out of anything
     else. A free-vocab column whose only consumer is a URL builder needs the
     guard at BOTH ends or the day the engine backfills it is the day somebody's
     company cell renders a link nobody wrote."

So the engine's door enforces the SAME closed set as the browser's, spelled the
same way, and the canonical stored form is the one the paste box produces:
**bare digits, `^[0-9]{1,20}$`, and nothing else.** That is not a preference —
`peopleSearchUrl` DROPS any facet id failing `NUMERIC_ID`, so a slug stored here
would render as "everybody on LinkedIn" rather than as an error.

THREE IMPLEMENTATIONS, ONE RULE, and the agreement is pinned rather than
promised (`core/companykeys.py`'s posture, verbatim):

  * `webapp/lib/referral/linkedin.ts` — `isLinkedinId` / `extractLinkedinId`,
    the browser's paste box and URL builder;
  * `public.app_set_linkedin_company_id` (0013) and
    `public.hq_fill_linkedin_company_id` (0016) — the two database doors, both
    anchored `^[0-9]{1,20}$`;
  * this one — what the engine accepts out of a provider payload.

`tests/core/test_linkedinids.py` reads the TypeScript's own regex literals out of
the file and compares them to the constants below, so a change to either side
fails rather than drifting. It reads webapp/ and writes nothing there.

WHY `extract_linkedin_id` REFUSES MORE THAN IT ACCEPTS. A wrong company id is
worse than a missing one: the missing one renders a paste prompt, the wrong one
sends somebody's outreach to strangers at another company, silently, behind a
link that works. So this returns "" for everything it is not certain about,
including `linkedin.com/company/<slug>` — a slug is not an id, no arithmetic
turns it into one, and guessing is the failure mode the whole referral feature is
careful about. The engine's callers COUNT those refusals and log them; they never
substitute anything.
"""
from __future__ import annotations

import re

#: A numeric LinkedIn entity id: digits, bounded, nothing else. The literal is
#: `NUMERIC_ID` in linkedin.ts and the closed set in 0013/0016, character for
#: character. Anchored at BOTH ends on purpose — an unanchored `[0-9]{1,20}`
#: matches the digits inside `javascript:1` and lets the whole string through,
#: which is the bug tests/db/test_referral.py mutation-proves on the SQL side.
NUMERIC_ID = re.compile(r"^[0-9]{1,20}$")

#: `f_C=1035` / `currentCompany=%5B%221035%22%5D` — the "See all employees" URL,
#: in both the bare and the JSON-array-encoded shapes LinkedIn has used. Mirrors
#: linkedin.ts's `faceted` regexp, including its case-insensitivity.
FACETED_ID = re.compile(r'(?:f_C|currentCompany)=(?:%5B%22|\[")?([0-9]{1,20})', re.I)

#: Zero-width invisibles, dropped outright — `hq_blank_trim`'s HQ_BLANK_ZERO_WIDTH
#: (0010). Stripped FIRST: they are not separators, so no trim removes them, and a
#: value of one U+FEFF is blank to a person and length 1 to Postgres.
_ZERO_WIDTH_CHARS = (0x200B, 0x200C, 0x200D, 0xFEFF)

#: `hq_blank_trim`'s HQ_BLANK_SEPARATORS (0010): POSIX `[[:space:]]` — which in a
#: UTF-8 locale is these six ASCII characters — plus the unicode separators that
#: function enumerates by hand.
#:
#: Spelled as CODEPOINTS with the class built from them, for `core/companykeys.py`'s
#: two reasons: a character class of invisible characters is a rule nobody can read
#: or review, and Python's own `\s` is a SUPERSET of Postgres' `[[:space:]]` (it
#: adds U+0085 and U+001C-U+001F), so leaning on it would make this predicate
#: disagree with the database about exactly the strings it exists to settle.
_SEPARATOR_CHARS = (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20,
                    0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000)
_SEPARATOR_RANGES = ((0x2000, 0x200A),)   # EN QUAD .. HAIR SPACE


def _char_class(chars=(), ranges=()) -> str:
    body = "".join(chr(c) for c in chars)
    body += "".join(f"{chr(lo)}-{chr(hi)}" for lo, hi in ranges)
    return f"[{body}]"


_ZERO_WIDTH = re.compile(_char_class(_ZERO_WIDTH_CHARS))
_SEPARATORS = re.compile(_char_class(_SEPARATOR_CHARS, _SEPARATOR_RANGES))


def is_linkedin_id(value: str | None) -> bool:
    """Is this a LinkedIn entity id we are willing to put in a URL — and store?

    The predicate the paste form, the URL builder and both database doors share,
    so the layers agree by construction rather than by comment.
    """
    return bool(NUMERIC_ID.fullmatch((value or "").strip()))


def extract_linkedin_id(text: str | None) -> str:
    """The canonical id inside whatever a provider (or a person) handed us, or "".

    Accepts exactly what `extractLinkedinId` accepts: a bare number, or a string
    carrying `f_C=` / `currentCompany=`. Everything else — a company-page URL, a
    vanity slug, a name, a 21-digit number — answers "" rather than a guess, and
    the caller counts it as a miss. See the module docstring for why the asymmetry
    is deliberate.
    """
    s = (text or "").strip()
    if not s:
        return ""
    if NUMERIC_ID.fullmatch(s):
        return s
    m = FACETED_ID.search(s)
    return m.group(1) if m else ""


def is_blank(value: str | None) -> bool:
    """Is this cell blank the way `public.hq_blank_trim(x) = ''` means blank?

    Used to decide, LOCALLY, whether a company still needs an id — so a backfill
    does not spend a TheirStack credit re-fetching one the store already holds.
    The AUTHORITATIVE guard is inside `hq_fill_linkedin_company_id`, which
    re-checks emptiness under the row lock; this is an optimization, and it is
    allowed to be wrong only in the direction of spending a credit it did not
    need to.

    An anchored-class predicate rather than `value.strip()`: `str.strip()` strips
    U+0085 and the C1 separators that Postgres does not, and leaves the zero-width
    characters that Postgres does — divergence in both directions, on a column
    people paste into out of web pages. `tests/db/test_linkedin_fill.py` runs this
    function and `hq_blank_trim` over one corpus inside real Postgres.
    """
    return _SEPARATORS.sub("", _ZERO_WIDTH.sub("", value or "")) == ""
