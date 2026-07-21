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


# ---- metro gate (a LOCAL search: dad's Chicagoland FP&A)

CHI = GateConfig(countries=["United States"], metros=["Chicago"], yoe_max=30,
                 yoe_unknown="keep")


def _chi_row(**kw):
    base = {"country": "United States", "remote": "", "metro": "Chicago",
            "min_yoe": "", "seniority": "", "tagged_at": "x"}
    base.update(kw)
    return base


def test_in_metro_qualifies():
    assert dispose(_chi_row(), CHI)[0] == QUALIFIED


def test_other_metro_filtered_with_reason():
    d, r = dispose(_chi_row(metro="Denver"), CHI)
    assert d == FILTERED and r == "metro:Denver"


def test_in_country_but_unplaceable_follows_the_geo_unknown_policy():
    d, r = dispose(_chi_row(metro=""), CHI)
    assert d == FILTERED and r == "metro-unknown"
    keep = GateConfig(countries=["United States"], metros=["Chicago"],
                      geo_unknown="keep", yoe_max=30, yoe_unknown="keep")
    assert dispose(_chi_row(metro=""), keep)[0] == QUALIFIED


def test_remote_bypasses_the_metro_gate():
    # a remote role is location-independent; a local search still wants it
    d, _ = dispose(_chi_row(metro="", remote="TRUE", country=""), CHI)
    assert d == QUALIFIED


def test_no_metros_configured_means_anywhere_in_country():
    national = GateConfig(countries=["United States"])
    assert dispose(_chi_row(metro="Denver", min_yoe="2"), national)[0] == QUALIFIED


def test_foreign_row_still_filtered_before_metro_is_considered():
    d, r = dispose(_chi_row(country="India", metro=""), CHI)
    assert d == FILTERED and r == "geo:India"


# ---- compensation gate: "I shouldn't even see jobs that pay $75k"

PAY = GateConfig(countries=["United States"], comp_min=120, yoe_max=30,
                 yoe_unknown="keep")


def _pay_row(comp, **kw):
    base = {"country": "United States", "remote": "", "metro": "",
            "min_yoe": "", "seniority": "", "tagged_at": "x",
            "work_model": "", "comp_range": comp}
    base.update(kw)
    return base


def test_band_below_the_floor_is_filtered():
    d, r = dispose(_pay_row("$75,000 - $85,000"), PAY)
    assert d == FILTERED and r == "comp:<120k"


def test_band_whose_top_clears_the_floor_is_kept():
    # a $110-160k posting can pay 120k; judging on the bottom of the band
    # would filter out most real negotiating ranges
    assert dispose(_pay_row("$110,000 - $160,000"), PAY)[0] == QUALIFIED


def test_unstated_comp_is_kept_by_default():
    # ~48% of live postings state no comp — defaulting to filter would
    # delete most of the feed
    assert dispose(_pay_row(""), PAY)[0] == QUALIFIED
    assert dispose(_pay_row("Competitive"), PAY)[0] == QUALIFIED


def test_unstated_comp_can_be_filtered_by_policy_once_tagged():
    strict = GateConfig(countries=["United States"], comp_min=120,
                        comp_unknown="filter", yoe_max=30, yoe_unknown="keep")
    assert dispose(_pay_row(""), strict) == (FILTERED, "comp-unknown")
    # ...but an UNTAGGED row is not judged on comp it hasn't been given yet
    assert dispose(_pay_row("", tagged_at=""), strict)[0] == NEEDS_INFO


def test_hourly_rates_are_never_read_as_salaries():
    assert dispose(_pay_row("$45/hour"), PAY)[0] == QUALIFIED   # unknown, not $45k


def test_comp_gate_off_by_default():
    off = GateConfig(countries=["United States"], yoe_max=30, yoe_unknown="keep")
    assert dispose(_pay_row("$40,000 - $50,000"), off)[0] == QUALIFIED


# ---- work-model gate

def test_work_model_exclusion():
    g = GateConfig(countries=["United States"], work_model_exclude=["onsite"],
                   yoe_max=30, yoe_unknown="keep")
    assert dispose(_pay_row("", work_model="Onsite — Austin, TX"), g) == \
        (FILTERED, "work-model:onsite")
    assert dispose(_pay_row("", work_model="Remote (US)"), g)[0] == QUALIFIED
    assert dispose(_pay_row("", work_model="Hybrid — Chicago"), g)[0] == QUALIFIED
