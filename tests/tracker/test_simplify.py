from core.fakes import fake_hq
from core.sheets import today
from tracker import simplify


class FakeResp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, validate=200, pages=None):
        self.validate = validate
        self.pages = pages or []
        self.posts, self.gets = [], []

    def post(self, url, **kw):
        self.posts.append((url, kw))
        return FakeResp(self.validate)

    def get(self, url, params=None, **kw):
        self.gets.append((url, params, kw))
        page = params["page"]
        if page < len(self.pages):
            items = self.pages[page]
            return FakeResp(200, {"total": sum(len(p) for p in self.pages), "items": items})
        return FakeResp(200, {"total": 0, "items": []})


ENV = {"SIMPLIFY_AUTH_COOKIE": "jwt", "SIMPLIFY_CSRF": "tok"}


def _gh(n):
    return f"https://boards.greenhouse.io/co/jobs/{n}"


def test_skips_with_heartbeat_when_disabled_or_secrets_unset():
    hq = fake_hq()
    hq.tab("config").append_records([{"key": "simplify_enabled", "value": "false"}])
    assert simplify.run(hq, session=FakeSession(), env=ENV) is None
    assert any(r["key"] == "heartbeat_simplify" for r in hq.tab("config").records())

    hq2 = fake_hq()      # enabled by default, but no secrets
    assert simplify.run(hq2, session=FakeSession(), env={}) is None
    assert any(r["key"] == "heartbeat_simplify" for r in hq2.tab("config").records())


def test_auth_failure_alerts_once_per_day_no_heartbeat(monkeypatch):
    alerts = []
    monkeypatch.setattr("core.notify.ops_alert", lambda t, b, **k: alerts.append(t))
    hq = fake_hq()
    assert simplify.run(hq, session=FakeSession(validate=401), env=ENV) is None
    assert simplify.run(hq, session=FakeSession(validate=401), env=ENV) is None
    assert alerts == ["Simplify auth expired"]           # deduped same-day
    cfg = {r["key"]: r["value"] for r in hq.tab("config").records()}
    assert cfg["simplify_alert_date"] == today()
    assert "heartbeat_simplify" not in cfg               # broken auth must stay visible


def test_happy_path_maps_statuses(monkeypatch):
    monkeypatch.setattr(simplify, "PAGE_DELAY", 0)
    hq = fake_hq()
    hq.tab("pipeline").append_records([
        {"key": "greenhouse-222", "company": "Co", "title": "PM",
         "status": "Applied", "applied_via": "self"}])
    items = [
        {"status": 1, "job_posting": {"title": "PM I", "url": _gh(111),
                                      "company": {"name": "SavedCo"}}},
        {"status": 2, "job_posting": {"title": "PM", "url": _gh(222),
                                      "company": {"name": "Co"}},
         "date_applied": "2026-07-10T08:00:00Z"},
        {"status": 12, "title": "PM Platform", "url": _gh(333),   # flat fallbacks
         "company_name": "NewCo", "created_at": "2026-07-11T00:00:00Z"},
        {"status": 23, "job_posting": {"title": "PM", "url": _gh(222),
                                       "company": {"name": "Co"}}},
        {"status": 23, "job_posting": {"title": "X", "url": _gh(444),
                                       "company": {"name": "GoneCo"}}},
    ]
    session = FakeSession(pages=[items])
    counts = simplify.run(hq, session=session, env=ENV)
    assert counts == {"saved_new": 1, "filled": 1, "created": 1,
                      "suggested": 1, "skipped": 1, "unkeyed": 0}

    recs = {r["key"]: r for r in hq.tab("pipeline").records()}
    assert recs["greenhouse-111"]["status"] == "Inbox"
    assert recs["greenhouse-111"]["source"] == "simplify"
    assert recs["greenhouse-222"]["applied_via"] == "self"       # human value kept
    assert recs["greenhouse-222"]["applied_date"] == "2026-07-10"  # blank filled
    assert recs["greenhouse-222"]["suggested_status"] == "Rejected"
    assert recs["greenhouse-222"]["status"] == "Applied"         # status never touched
    assert recs["greenhouse-333"]["status"] == "Interview"
    assert recs["greenhouse-333"]["company"] == "NewCo"
    assert "greenhouse-444" not in recs                          # no row just to bury it

    cfg = [r["key"] for r in hq.tab("config").records()]
    assert "heartbeat_simplify" in cfg
    log = hq.tab("log").records()
    assert any(r["action"] == "sync" for r in log if r["actor"] == "simplify")
    # per-key audit rows feed the digest's Status changes section
    created = [r for r in log if r["actor"] == "simplify" and r["action"] == "created"]
    assert [r["key"] for r in created] == ["greenhouse-333"]
    assert "Interview" in created[0]["detail"]
    suggested = [r for r in log if r["actor"] == "simplify" and r["action"] == "suggested"]
    assert [r["key"] for r in suggested] == ["greenhouse-222"]
    assert "Rejected" in suggested[0]["detail"]

    _, kw = session.posts[0]
    assert kw["headers"]["x-csrf-token"] == "tok"
    assert kw["headers"]["Origin"] == "https://simplify.jobs"
    assert kw["cookies"] == {"authorization": "jwt", "csrf": "tok"}


def test_pagination_and_idempotent_rerun(monkeypatch):
    monkeypatch.setattr(simplify, "PAGE_DELAY", 0)
    monkeypatch.setattr(simplify, "PAGE_SIZE", 2)
    hq = fake_hq()
    pages = [
        [{"status": 1, "job_posting": {"title": "A", "url": _gh(1), "company": {"name": "C1"}}},
         {"status": 1, "job_posting": {"title": "B", "url": _gh(2), "company": {"name": "C2"}}}],
        [{"status": 1, "job_posting": {"title": "C", "url": _gh(3), "company": {"name": "C3"}}}],
    ]
    counts = simplify.run(hq, session=FakeSession(pages=pages), env=ENV)
    assert counts["saved_new"] == 3
    counts2 = simplify.run(hq, session=FakeSession(pages=pages), env=ENV)
    assert counts2["saved_new"] == 0 and counts2["skipped"] == 3
    assert len(hq.tab("pipeline").records()) == 3
