"""`core.linkedinids` — the engine's half of a rule three languages implement.

The rule is "what counts as a LinkedIn company id", and it is enforced at four
doors: the browser's paste form and URL builder (`webapp/lib/referral/linkedin.ts`),
`app_set_linkedin_company_id` (0013), `hq_fill_linkedin_company_id` (0016), and
this module. Three of those four write the same column, so a disagreement is not
cosmetic — it is either a slug landing in a string the web app concatenates into a
URL, or an id the engine refuses that a human can paste happily.

What is proved here that reading the code cannot:

    the anchors   an unanchored `[0-9]{1,20}` matches the digits INSIDE
                  `javascript:1` and lets the whole string through — the exact bug
                  0013's regexp is anchored against, arriving from the engine side
                  where the input is a provider payload rather than a person
    the refusals  `linkedin.com/company/ramp` carries no id, and answering "ramp"
                  — or worse, a guess — is how somebody's outreach reaches
                  strangers at another company behind a link that works
    the parity    the constants here ARE the TypeScript's regex literals, read out
                  of the file rather than retyped
    the blank     `is_blank` is `hq_blank_trim(x) = ''`, never `str.strip()`

Invisible characters are spelled as ESCAPES throughout, 0010's rule applied to test
data: a parametrize row nobody can read is a case nobody can review, and which
invisible character it is IS the case.
"""
import re as _re
from pathlib import Path

import pytest

from core.linkedinids import (
    FACETED_ID,
    NUMERIC_ID,
    extract_linkedin_id,
    is_blank,
    is_linkedin_id,
)

TS = Path(__file__).resolve().parents[2] / "webapp" / "lib" / "referral" / "linkedin.ts"
MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


# ---------------------------------------------------------------- the closed set

@pytest.mark.parametrize("value", ["1035", "0", "1", "9" * 20, " 1035 ", "1035\n"])
def test_a_bare_number_is_an_id(value):
    assert is_linkedin_id(value)
    assert extract_linkedin_id(value) == value.strip()


@pytest.mark.parametrize("value", [
    "",
    "   ",
    None,
    "9" * 21,                      # past the bound 0013 chose; finite is the point
    "ramp",
    "10-35",
    "1035 2077",
    "linkedin.com/company/ramp",
    "https://www.linkedin.com/company/ramp/",
    # MUTATION REASON: drop the `$` anchor from NUMERIC_ID and this passes — the
    # match succeeds on the leading digits and the whole string reaches a column
    # `peopleSearchUrl` reads.
    "1035; drop table companies",
    # MUTATION REASON: drop the `^` anchor and this passes.
    "javascript:1035",
])
def test_everything_else_is_not_an_id(value):
    assert not is_linkedin_id(value)


# ---------------------------------------------------------------- extraction

@pytest.mark.parametrize("text,expected", [
    # The "See all employees" URL, bare and JSON-array-encoded — both shapes
    # LinkedIn has used, both shapes the paste box accepts.
    ("https://www.linkedin.com/search/results/people/?f_C=1035&origin=X", "1035"),
    ("https://www.linkedin.com/search/results/people/?f_C=%5B%221035%22%5D", "1035"),
    ('https://www.linkedin.com/search/results/people/?currentCompany=["2077"]', "2077"),
    ("?F_c=1035", "1035"),                       # the TS literal carries /i
    ("1035", "1035"),
])
def test_extraction_finds_the_id_the_paste_box_finds(text, expected):
    assert extract_linkedin_id(text) == expected


@pytest.mark.parametrize("text", [
    "",
    None,
    # The company page. It genuinely carries no id — the browser refuses it BY NAME
    # with instructions, and the engine has nobody to instruct, so it skips.
    "https://www.linkedin.com/company/ramp?trk=public_jobs",
    # MUTATION REASON: the tempting "fallback" is to take the last path segment when
    # it is all digits. Company slugs are free vocabulary, and a wrong id is a
    # working link to the wrong employer — strictly worse than no link at all.
    "https://www.linkedin.com/company/1035",
    "Ramp",
    "f_C=",
    "f_C=abc",
])
def test_extraction_answers_nothing_rather_than_a_guess(text):
    assert extract_linkedin_id(text) == ""


def test_a_21_digit_faceted_id_is_truncated_to_20_exactly_like_the_paste_box():
    """Not a nicety: the two doors have to agree on a pathological value, or one
    stores something the other would have refused."""
    assert extract_linkedin_id("?f_C=" + "9" * 21) == "9" * 20


# ---------------------------------------------------------------- parity

def test_the_numeric_id_pattern_is_the_typescripts_own():
    """Read out of the file rather than retyped, so the pin cannot be satisfied by
    a stale copy of the pattern (`tests/core/test_companykeys.py`'s posture for the
    same class of cross-language rule). Nothing here writes to webapp/."""
    m = _re.search(r"const NUMERIC_ID = /(.*)/[a-z]*;", TS.read_text())
    assert m, f"could not find `const NUMERIC_ID = /…/` in {TS.name} — did it move?"
    assert NUMERIC_ID.pattern == m.group(1)


def test_the_faceted_pattern_is_the_typescripts_own():
    """`extractLinkedinId` assigns its faceted regexp inline rather than to a const,
    so it is matched by its distinctive use site instead of by name."""
    m = _re.search(r"const faceted = /(.*)/i\.exec", TS.read_text())
    assert m, "extractLinkedinId's faceted regexp moved — re-derive the pin"
    assert FACETED_ID.pattern == m.group(1)


@pytest.mark.parametrize("migration", ["0013_referral.sql", "0016_linkedin_fill.sql"])
def test_the_database_doors_use_the_same_closed_set(migration):
    """Both write the column; a migration that relaxed one of them would admit a
    value the other three layers refuse."""
    sql = (MIGRATIONS / migration).read_text()
    assert "'^[0-9]{1,20}$'" in sql, f"{migration} no longer anchors the LinkedIn id set"


# ---------------------------------------------------------------- blankness

#: Everything `hq_blank_trim` folds away: POSIX `[[:space:]]`, the unicode
#: separators 0010 enumerates, and the zero-width characters it strips first.
BLANK_CASES = [
    "", None, " ", "\t", "\n", "\v", "\f", "\r", "  \t\n  ",
    " ",                                  # NBSP — what a web-page paste leaves
    " ", " ", " ", " ",     # OGHAM .. HAIR SPACE
    " ", " ", " ", " ", "　",
    "​", "‌", "‍", "﻿",     # zero-width: stripped, not trimmed
    "​ \t",
]


@pytest.mark.parametrize("value", BLANK_CASES, ids=lambda v: repr(v))
def test_blank_means_what_hq_blank_trim_means(value):
    assert is_blank(value)


@pytest.mark.parametrize("value", ["0", "1035", " 1035 ", "ramp", "-", "​1"],
                         ids=lambda v: repr(v))
def test_a_cell_with_content_is_not_blank(value):
    assert not is_blank(value)


@pytest.mark.parametrize("ch", ["", "", "", "", ""],
                         ids=lambda v: repr(v))
def test_a_c1_separator_is_not_blank_here_because_it_is_not_blank_in_postgres(ch):
    """MUTATION REASON: implement `is_blank` as `not (value or "").strip()` — or
    build its class from Python's own `\\s` — and every one of these flips.

    U+0085 (NEL) and U+001C-U+001F are whitespace to `str.strip()` and are NOT in
    POSIX `[[:space:]]`, which is what `hq_blank_trim` uses. Following Python would
    make the engine believe a cell is empty that the database then refuses to
    overwrite — a permanent, silent disagreement about which companies still need an
    id, costing one credit per run forever.
    """
    assert not is_blank(ch)
