import pytest
from src.fetchers import get_jobs_for


def test_registry_routes_greenhouse(monkeypatch):
    called = {}
    def fake(slug, company, session, **kw):
        called["slug"] = slug
        return []
    import src.fetchers as f
    monkeypatch.setitem(f._REGISTRY, "greenhouse", fake)
    get_jobs_for("greenhouse", "stripe", "Stripe", session=None, workday_search="product")
    assert called["slug"] == "stripe"


def test_registry_unknown_ats_raises():
    with pytest.raises(ValueError):
        get_jobs_for("bogus", "x", "X", session=None, workday_search="product")
