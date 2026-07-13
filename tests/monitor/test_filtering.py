# tests/test_filtering.py
from monitor.filtering import title_matches

INCLUDE = ["product manager", "head of product", "technical product manager"]
EXCLUDE = ["product marketing", "product design", "program manager"]


def test_matches_basic_pm_title():
    assert title_matches("Senior Product Manager", INCLUDE, EXCLUDE) is True


def test_case_insensitive():
    assert title_matches("HEAD OF PRODUCT", INCLUDE, EXCLUDE) is True


def test_exclude_wins_over_include():
    # contains "product manager" (include) AND "product marketing" (exclude)
    assert title_matches("Product Manager, Product Marketing", INCLUDE, EXCLUDE) is False


def test_program_manager_excluded():
    assert title_matches("Technical Program Manager", INCLUDE, EXCLUDE) is False


def test_unrelated_title_not_matched():
    assert title_matches("Staff Software Engineer", INCLUDE, EXCLUDE) is False
