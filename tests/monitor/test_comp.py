"""Compensation parsing — formats taken verbatim from the live feed."""
from monitor.comp import meets_floor, parse_comp


def test_real_world_formats():
    assert parse_comp("$151,200 - $204,600") == (151.2, 204.6)
    assert parse_comp("$182,000 — $250,208") == (182.0, 250.208)   # em dash
    assert parse_comp("$160k-$190k") == (160.0, 190.0)
    assert parse_comp("$120,000 USD - $150,000") == (120.0, 150.0)


def test_open_ended_ranges():
    assert parse_comp("$150k+") == (150.0, None)
    assert parse_comp("up to $130k") == (None, 130.0)


def test_unknown_is_never_guessed():
    for s in ("", "   ", "Competitive", "DOE", "Salary not disclosed"):
        assert parse_comp(s) == (None, None), s


def test_non_annual_rates_are_refused():
    # $45/hour must never be read as $45k/year
    for s in ("$45/hour", "$45 per hour", "$1,200 weekly", "$8,000 monthly"):
        assert parse_comp(s) == (None, None), s


def test_implausible_values_are_dropped():
    assert parse_comp("$5 - $9") == (None, None)        # not an annual salary


def test_meets_floor_judges_the_top_of_the_band():
    assert meets_floor("$110,000 - $160,000", 120) is True
    assert meets_floor("$75,000 - $85,000", 120) is False
    assert meets_floor("$150k+", 120) is True
    assert meets_floor("", 120) is None
