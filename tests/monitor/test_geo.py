from monitor.geo import enrich


def test_us_city_state():
    g = enrich("Chicago, IL")
    assert g == {"city": "Chicago", "state": "IL", "country": "United States",
                 "remote": "", "market": "US"}


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
