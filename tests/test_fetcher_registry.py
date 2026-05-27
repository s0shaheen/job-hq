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


def test_registry_routes_apify(monkeypatch):
    captured = {}
    def fake_apify_get(slug, company, session, token):
        captured["slug"] = slug
        captured["company"] = company
        captured["token"] = token
        return []
    monkeypatch.setattr("src.apify.get_jobs", fake_apify_get)
    monkeypatch.setenv("APIFY_TOKEN", "TOK123")
    from src.fetchers import get_jobs_for
    get_jobs_for("apify", "actor7:https://careers.meta.com", "Meta", session=None, workday_search="product")
    assert captured["slug"] == "actor7:https://careers.meta.com"
    assert captured["company"] == "Meta"
    assert captured["token"] == "TOK123"


def test_registry_apify_without_token_uses_empty_string(monkeypatch):
    captured = {}
    def fake_apify_get(slug, company, session, token):
        captured["token"] = token
        return []
    monkeypatch.setattr("src.apify.get_jobs", fake_apify_get)
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    from src.fetchers import get_jobs_for
    get_jobs_for("apify", "a:u", "X", session=None)
    assert captured["token"] == ""
