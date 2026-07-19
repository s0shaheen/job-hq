from monitor.gates import (FILTERED, NEEDS_INFO, QUALIFIED, GateConfig,
                           dispose, make_disposer)
from monitor.regate import regate_rows

G = GateConfig(countries=["United States"], geo_unknown="filter", yoe_max=4,
               yoe_unknown="seniority-proxy",
               seniority_exclude=["Senior", "Staff", "GPM", "Director", "VP"])


def _row(**kw):
    base = {"country": "United States", "remote": "", "min_yoe": "",
            "seniority": "", "tagged_at": ""}
    base.update(kw)
    return base


# ---- geo gate (free, first)

def test_us_row_with_ok_yoe_qualifies():
    assert dispose(_row(min_yoe="2", tagged_at="2026-07-19"), G) == (QUALIFIED, "")


def test_foreign_row_filtered_with_country_reason():
    d, r = dispose(_row(country="India", min_yoe="2"), G)
    assert d == FILTERED and r == "geo:India"


def test_blank_geo_non_remote_filtered_by_default():
    assert dispose(_row(country=""), G) == (FILTERED, "geo-unknown")


def test_blank_geo_keep_policy_falls_through_to_yoe():
    keep = GateConfig(countries=["United States"], geo_unknown="keep")
    assert dispose(_row(country="", min_yoe="1", tagged_at="x"), keep) == (QUALIFIED, "")


def test_remote_with_no_stated_country_passes_geo():
    d, _ = dispose(_row(country="", remote="TRUE", min_yoe="0", tagged_at="x"), G)
    assert d == QUALIFIED


def test_foreign_remote_still_filtered():
    d, r = dispose(_row(country="Canada", remote="TRUE", min_yoe="0"), G)
    assert d == FILTERED and r == "geo:Canada"


def test_country_aliases_normalize_both_sides():
    g = GateConfig(countries=["US"])
    assert dispose(_row(country="United States", min_yoe="1", tagged_at="x"), g)[0] == QUALIFIED


# ---- YoE gate (needs tags)

def test_over_bar_yoe_filtered_with_reason():
    d, r = dispose(_row(min_yoe="6", tagged_at="x"), G)
    assert d == FILTERED and r == "yoe:6>4"


def test_untagged_row_parks_as_needs_info():
    assert dispose(_row(), G) == (NEEDS_INFO, "awaiting-tags")


def test_tagged_but_yoe_unknown_senior_filtered_by_proxy():
    d, r = dispose(_row(tagged_at="x", seniority="Senior"), G)
    assert d == FILTERED and r == "seniority:Senior"


def test_tagged_but_yoe_unknown_pm_qualifies_with_badge():
    assert dispose(_row(tagged_at="x", seniority="PM"), G) == (QUALIFIED, "yoe-unknown")


def test_yoe_unknown_keep_policy_ignores_seniority():
    keep = GateConfig(countries=["United States"], yoe_unknown="keep")
    d, r = dispose(_row(tagged_at="x", seniority="Director"), keep)
    assert (d, r) == (QUALIFIED, "yoe-unknown")


def test_untaggable_sentinel_counts_as_tagged_for_the_policy():
    d, r = dispose(_row(tagged_at="no-jd:2026-07-19"), G)
    assert (d, r) == (QUALIFIED, "yoe-unknown")


def test_junk_min_yoe_falls_to_unknown_path():
    d, r = dispose(_row(min_yoe="3-5", tagged_at="x"), G)
    assert (d, r) == (QUALIFIED, "yoe-unknown")


def test_make_disposer_returns_column_dict():
    out = make_disposer(G)(_row(country="India"))
    assert out == {"disposition": FILTERED, "disposition_reason": "geo:India"}


# ---- regate sweep

def test_regate_uses_stored_geo_and_skips_unchanged_rows():
    rows = [
        # stored geo says India -> filtered (location string would say otherwise)
        {"key": "a-1", "location": "New York, NY", "country": "India",
         "remote": "", "market": "India", "min_yoe": "2", "seniority": "",
         "tagged_at": "x", "disposition": "", "disposition_reason": ""},
        # pre-geo row: no stored geo -> falls back to enriching the location
        {"key": "a-2", "location": "New York, NY", "country": "", "remote": "",
         "market": "", "min_yoe": "2", "seniority": "", "tagged_at": "x",
         "disposition": "", "disposition_reason": ""},
        # already stamped correctly -> no rewrite
        {"key": "a-3", "location": "Bengaluru, India", "country": "India",
         "remote": "", "market": "India", "min_yoe": "", "seniority": "",
         "tagged_at": "", "disposition": "filtered",
         "disposition_reason": "geo:India"},
    ]
    changes = regate_rows(rows, G)
    assert changes == {"a-1": (FILTERED, "geo:India"), "a-2": (QUALIFIED, "")}
