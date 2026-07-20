from monitor.geo import enrich


def test_us_city_state():
    g = enrich("Chicago, IL")
    assert g == {"city": "Chicago", "state": "IL", "country": "United States",
                 "remote": "", "market": "US", "metro": "Chicago"}


def test_full_form_with_usa_and_multi_location():
    g = enrich("Bellevue, WA, USA | Chicago, IL, USA | New York, NY, USA")
    assert (g["city"], g["state"], g["country"], g["market"]) == ("Bellevue", "WA", "United States", "US")


def test_remote_beats_everything_for_market():
    g = enrich("Remote - US")
    assert g["remote"] == "TRUE" and g["market"] == "Remote" and g["country"] == "United States"
    g2 = enrich("Toronto, ON, Canada", "Remote")
    assert g2["market"] == "Remote" and g2["country"] == "Canada"


def test_foreign_and_unknown():
    assert enrich("London")["market"] == "United Kingdom"
    g = enrich("Toronto, Canada")
    assert g["country"] == "Canada" and g["market"] == "Canada" and g["city"] == "Toronto"
    assert enrich("")["market"] == ""


def test_state_full_name_and_hybrid_work_model():
    g = enrich("Austin, Texas", "Hybrid — Austin")
    assert g["state"] == "TX" and g["market"] == "US" and g["remote"] == ""


def test_us_city_shorthands_resolve_country_without_state_token():
    for loc in ("NYC", "San Francisco Bay Area", "Chicagoland", "Washington, D.C."):
        assert enrich(loc)["country"] == "United States", loc


def test_city_hint_never_blanks_a_real_city():
    g = enrich("San Francisco, CA")
    assert g["city"] == "San Francisco" and g["state"] == "CA" \
        and g["country"] == "United States"
    g2 = enrich("New York City, NY")
    assert g2["city"] == "New York City" and g2["country"] == "United States"


# ---- city/state collisions (pre-existing parser bug: "New York, NY" parsed
# as state-only, blanking the city on one of the densest job markets)

def test_city_that_shares_its_state_name_still_parses_as_a_city():
    g = enrich("New York, NY")
    assert g["city"] == "New York" and g["state"] == "NY"
    g2 = enrich("Washington, DC")
    assert g2["city"] == "Washington" and g2["state"] == "DC"


def test_bare_state_name_still_reads_as_a_state():
    g = enrich("Illinois")
    assert g["state"] == "IL" and g["city"] == ""
    # ...and a bare collision name keeps its state reading too
    assert enrich("Washington")["state"] == "WA"


# ---- metro resolution (the grain a LOCAL search needs)

def test_chicago_metro_spans_three_states():
    for loc in ("Chicago, IL", "Naperville, IL", "Deerfield, IL", "Oak Brook, IL",
                "Schaumburg, IL", "Hammond, IN", "Merrillville, IN", "Kenosha, WI"):
        assert enrich(loc)["metro"] == "Chicago", loc


def test_downstate_illinois_is_not_the_chicago_metro():
    for loc in ("Peoria, IL", "Springfield, IL", "Champaign, IL"):
        assert enrich(loc)["metro"] == "", loc


def test_ambiguous_city_resolves_by_state_only():
    assert enrich("Aurora, IL")["metro"] == "Chicago"
    assert enrich("Aurora, CO")["metro"] == "Denver"
    assert enrich("Aurora")["metro"] == ""        # no state -> never guess


def test_metro_blank_for_remote_and_foreign():
    assert enrich("Remote - US")["metro"] == ""
    assert enrich("Bengaluru, India")["metro"] == ""
    assert enrich("")["metro"] == ""


def test_spelled_out_state_still_resolves_when_it_is_the_only_state_token():
    # regression: a collision-name guard that fires unconditionally blanked
    # state AND country here, which then reads as geo-unknown and filters the
    # row out of the feed entirely
    for loc, st in (("Seattle, Washington", "WA"), ("Redmond, Washington", "WA"),
                    ("Buffalo, New York", "NY"), ("New York, New York", "NY")):
        g = enrich(loc)
        assert g["state"] == st, loc
        assert g["country"] == "United States", loc
        assert g["market"] == "US", loc
    assert enrich("New York, New York")["city"] == "New York"
    assert enrich("Seattle, Washington")["city"] == "Seattle"


def test_suburb_names_never_resolve_without_a_state():
    # Duluth is a metro-Atlanta suburb AND a Minnesota city; Louisville is a
    # Denver suburb AND a Kentucky city. Placing those from the name alone is
    # the confident guess metros.py promises not to make.
    for loc in ("Duluth, United States", "Louisville, USA", "Salem", "Lexington",
                "Plymouth", "Franklin"):
        assert enrich(loc)["metro"] == "", loc
    # ...but with a state they resolve correctly
    assert enrich("Duluth, GA")["metro"] == "Atlanta"
    assert enrich("Louisville, CO")["metro"] == "Denver"


def test_anchor_city_names_resolve_without_a_state():
    for loc, metro in (("Chicago", "Chicago"), ("New York", "New York"),
                       ("San Francisco", "San Francisco Bay Area")):
        assert enrich(loc)["metro"] == metro, loc
