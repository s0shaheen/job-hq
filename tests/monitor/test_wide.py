import json
from urllib.parse import unquote

from core.config import defaults
from core.fakes import fake_hq
from monitor import wide
from monitor.wide import map_cafe_item, map_theirstack_job, run, search_terms, search_url

TODAY = "2026-07-13"
CURSOR = "2026-07-12T00:00:00Z"
GH_URL = "https://boards.greenhouse.io/plaid/jobs/123456"


def _hq(companies=None, feed=None, pipeline=None, config=None):
    hq = fake_hq()
    if companies:
        hq.tab("companies").append_records(companies)
    if feed:
        hq.tab("feed").append_records(feed)
    if pipeline:
        hq.tab("pipeline").append_records(pipeline)
    if config:
        hq.tab("config").append_records(config)
    return hq


def cafe_item(apply_url=GH_URL, title="Senior Product Manager", company="Plaid",
              location="United States", posted="2026-07-13T04:00:00.000Z",
              yoe=4, yoe_missing=False, work_model="Remote",
              lo=150000, hi=180000, seniority="Mid/Senior Level"):
    return {
        "apply_url": apply_url,
        "job_information": {"title": title},
        "v5_processed_company_data": {"name": company},
        "v5_processed_job_data": {
            "core_job_title": title,
            "formatted_workplace_location": location,
            "estimated_publish_date": posted,
            "min_industry_and_role_yoe": yoe,
            "is_min_industry_and_role_yoe_not_mentioned": yoe_missing,
            "workplace_type": work_model,
            "yearly_min_compensation": lo,
            "yearly_max_compensation": hi,
            "seniority_level": seniority,
        },
    }


def ts_job(**kw):
    j = {"job_title": "Product Manager, Payments",
         "url": "https://theirstack.com/job/x",
         "final_url": "https://jobs.lever.co/plaid/f47ac10b-58cc-4372-a567-0e02b2c3d479",
         "company": {"name": "Plaid"},
         "location": "New York, New York, United States",
         "short_location": "New York, NY",
         "remote": True,
         "date_posted": "2026-07-12",
         "discovered_at": "2026-07-13T06:00:00Z",
         "salary_string": "$170k-$200k",
         "seniority": "mid_level"}
    j.update(kw)
    return j


class FakeApify:
    """Mimics the apify-client slice wide.py uses. First actor call returns
    the fixture items; subsequent term runs return empty datasets."""

    def __init__(self, items=None, fail=False):
        self.items = items or []
        self.fail = fail
        self.actor_ids = []
        self.inputs = []
        self._datasets = {}
        self._did = None

    def actor(self, actor_id):
        self.actor_ids.append(actor_id)
        return self

    def call(self, run_input=None, **kw):
        if self.fail:
            raise RuntimeError("actor exploded")
        self.inputs.append(run_input)
        did = f"D{len(self.inputs)}"
        self._datasets[did] = self.items if len(self.inputs) == 1 else []
        return {"defaultDatasetId": did}

    def dataset(self, did):
        self._did = did
        return self

    def iterate_items(self):
        return iter(self._datasets.get(self._did, []))


class FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, payload=None, exc=None):
        self.calls = []
        self._payload = payload if payload is not None else {"data": []}
        self._exc = exc

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        if self._exc:
            raise self._exc
        return FakeResp(self._payload)


class PushSpy:
    def __init__(self):
        self.calls = []

    def __call__(self, title, body, **kw):
        self.calls.append((title, body, kw))
        return True


def _run(hq, client, monkeypatch=None, session=None, push=None):
    return run(hq, session=session or FakeSession(),
               client_factory=lambda token: client, push=push or PushSpy(), today=TODAY)


# ---------------------------------------------------------------- pure mapping

def test_search_terms_drop_subsumed_and_cap():
    inc = ["Product Manager", "senior product manager", "head of product",
           "director of product", "vp of product", "technical product manager",
           "deployment strategist", "forward deployed", "product strategist"]
    assert search_terms(inc) == ["product manager", "head of product", "director of product",
                                 "vp of product", "deployment strategist", "forward deployed"]


def test_search_url_encodes_probe_verified_state():
    u = search_url("product manager")
    assert u.startswith("https://hiring.cafe/?searchState=")
    state = json.loads(unquote(u.split("searchState=", 1)[1]))
    assert state == {"searchQuery": "product manager", "sortBy": "date"}


def test_map_cafe_item_full_mapping():
    rec, posted = map_cafe_item(cafe_item(), TODAY)
    assert rec["key"] == "greenhouse-123456"
    assert rec["company"] == "Plaid" and rec["title"] == "Senior Product Manager"
    assert rec["url"] == GH_URL and rec["status"] == "New"
    assert rec["first_seen"] == TODAY and rec["last_seen"] == TODAY
    assert rec["posted"] == "2026-07-13"
    assert posted == "2026-07-13T04:00:00.000Z"
    assert rec["comp_range"] == "$150k-$180k"
    assert rec["work_model"] == "Remote"
    assert rec["seniority"] == "Mid/Senior Level"
    assert rec["min_yoe"] == "4"


def test_map_cafe_item_weak_key_or_unstated_yoe():
    assert map_cafe_item(cafe_item(apply_url="https://example.com/careers/1"), TODAY) is None
    rec, _ = map_cafe_item(cafe_item(yoe=4, yoe_missing=True), TODAY)
    assert rec["min_yoe"] == ""              # not-mentioned flag wins over the number


def test_map_theirstack_job():
    rec, discovered = map_theirstack_job(ts_job(), TODAY)
    assert rec["key"] == "lever-f47ac10b-58cc-4372-a567-0e02b2c3d479"
    assert rec["company"] == "Plaid" and rec["location"] == "New York, NY"
    assert rec["comp_range"] == "$170k-$200k" and rec["work_model"] == "Remote"
    assert rec["min_yoe"] == "" and rec["posted"] == "2026-07-12"
    assert discovered == "2026-07-13T06:00:00Z"
    assert map_theirstack_job(ts_job(final_url="https://example.com/x", url=""), TODAY) is None


# ---------------------------------------------------------------- run() paths

def test_no_token_skips_cleanly_but_heartbeats(monkeypatch):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    hq = fake_hq()
    factory_calls = []
    s = run(hq, session=FakeSession(),
            client_factory=lambda token: factory_calls.append(token), today=TODAY)
    assert s.skipped and not s.ok
    assert factory_calls == []
    assert hq.tab("feed").records() == []
    assert any(r["key"] == "heartbeat_wide" for r in hq.tab("config").records())
    assert any(r["action"] == "skip" for r in hq.tab("log").records())


def test_actor_input_shape_one_run_per_term(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])
    client = FakeApify(items=[cafe_item()])
    _run(hq, client)
    assert set(client.actor_ids) == {wide.ACTOR_ID}
    n_terms = len(search_terms(defaults()["titles_include"]))
    assert len(client.inputs) == n_terms     # one small newest-first run per distinct term
    first = client.inputs[0]
    assert first["maxItems"] == wide.MAX_PER_TERM
    assert first["enrichDescription"] is False
    state = json.loads(unquote(first["startUrls"][0]["url"].split("searchState=", 1)[1]))
    assert state["searchQuery"] == "product manager" and state["sortBy"] == "date"


def test_appends_filters_and_advances_cursor(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])
    items = [
        cafe_item(),                                                        # kept
        cafe_item(apply_url="https://boards.greenhouse.io/x/jobs/222",
                  posted="2026-07-11T09:00:00.000Z"),                       # older than cursor
        cafe_item(apply_url="https://boards.greenhouse.io/x/jobs/333",
                  title="Staff Accountant"),                                # title filtered
        cafe_item(apply_url="https://example.com/careers/1"),               # weak key
    ]
    s = _run(hq, FakeApify(items=items))
    assert s.ok and s.fetched == 4 and s.appended == 1
    recs = hq.tab("feed").records()
    assert [r["key"] for r in recs] == ["greenhouse-123456"]
    assert recs[0]["tagged_at"] == ""        # untagged: nightly review owns tagging
    cur = [r for r in hq.tab("config").records() if r["key"] == "wide_cursor"]
    assert cur[0]["value"] == "2026-07-13T04:00:00.000Z"
    assert any(r["action"] == "sweep" for r in hq.tab("log").records())
    assert any(r["key"] == "heartbeat_wide" for r in hq.tab("config").records())


def test_dedupe_against_feed_and_pipeline(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    hq = _hq(feed=[{"key": "greenhouse-123456", "company": "Plaid", "title": "PM",
                    "status": "Seen", "first_seen": "2026-07-01", "last_seen": "2026-07-12"}],
             pipeline=[{"key": "greenhouse-777", "company": "X", "title": "PM", "status": "Applied"}],
             config=[{"key": "wide_cursor", "value": CURSOR}])
    items = [cafe_item(),
             cafe_item(apply_url="https://boards.greenhouse.io/x/jobs/777")]
    s = _run(hq, FakeApify(items=items))
    assert s.appended == 0
    assert len(hq.tab("feed").records()) == 1
    # cursor still advances: the sweep did cover those publish dates
    cur = [r for r in hq.tab("config").records() if r["key"] == "wide_cursor"]
    assert cur[0]["value"] == "2026-07-13T04:00:00.000Z"


def test_push_gating_by_yoe(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    items = [cafe_item(yoe=3),                                              # gated in
             cafe_item(apply_url="https://boards.greenhouse.io/x/jobs/222",
                       title="Principal Product Manager", yoe=10),          # above gate
             cafe_item(apply_url="https://boards.greenhouse.io/x/jobs/333",
                       title="Group Product Manager", yoe=0, yoe_missing=True)]  # unknown
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])
    push = PushSpy()
    s = _run(hq, FakeApify(items=items), push=push)
    assert s.appended == 3 and s.pushed == 1
    title, body, kw = push.calls[0]
    assert title == "Wide sweep: 1 matching role(s)"
    assert body == "• Senior Product Manager — Plaid"
    assert kw["kind"] == "jobs" and kw["click"] == GH_URL


def test_push_disabled_by_config(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR},
                     {"key": "push_new_jobs", "value": "FALSE"}])
    push = PushSpy()
    s = _run(hq, FakeApify(items=[cafe_item(yoe=2)]), push=push)
    assert s.appended == 1 and s.pushed == 0 and push.calls == []


def test_theirstack_request_mapping_and_cursor(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.setenv("THEIRSTACK_API_KEY", "tsk")
    hq = _hq(companies=[{"name": "Plaid", "ats": "lever", "slug": "plaid",
                         "monitor": "TRUE", "seeded": "TRUE", "priority": "TRUE"},
                        {"name": "NotPriority", "ats": "lever", "slug": "np",
                         "monitor": "TRUE", "seeded": "TRUE", "priority": ""}],
             config=[{"key": "wide_cursor", "value": CURSOR},
                     {"key": "wide_theirstack_cursor", "value": CURSOR}])
    session = FakeSession(payload={"data": [ts_job()]})
    s = _run(hq, FakeApify(items=[]), session=session)

    assert len(session.calls) == 1
    call = session.calls[0]
    assert call["url"] == wide.TS_URL
    assert call["headers"]["Authorization"] == "Bearer tsk"
    body = call["json"]
    assert body["limit"] == wide.TS_LIMIT and body["offset"] == 0
    assert body["discovered_at_gte"] == CURSOR
    assert body["company_name_case_insensitive_or"] == ["Plaid"]   # priority companies only
    assert body["job_title_or"][0] == "product manager"

    assert s.ts_fetched == 1 and s.appended == 1
    assert hq.tab("feed").records()[0]["key"] == "lever-f47ac10b-58cc-4372-a567-0e02b2c3d479"
    cur = [r for r in hq.tab("config").records() if r["key"] == "wide_theirstack_cursor"]
    assert cur[0]["value"] == "2026-07-13T06:00:00Z"


def test_theirstack_failure_never_fatal(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.setenv("THEIRSTACK_API_KEY", "tsk")
    hq = _hq(companies=[{"name": "Plaid", "ats": "lever", "slug": "plaid",
                         "monitor": "TRUE", "seeded": "TRUE", "priority": "TRUE"}],
             config=[{"key": "wide_cursor", "value": CURSOR}])
    session = FakeSession(exc=RuntimeError("402 out of credits"))
    s = _run(hq, FakeApify(items=[cafe_item()]), session=session)
    assert s.ok and s.appended == 1          # cafe rows landed regardless
    assert any("theirstack" in e for e in s.errors)
    assert any(r["action"] == "theirstack_error" for r in hq.tab("log").records())
    assert any(r["key"] == "heartbeat_wide" for r in hq.tab("config").records())


def test_theirstack_skipped_without_priority_companies(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.setenv("THEIRSTACK_API_KEY", "tsk")
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])
    session = FakeSession()
    s = _run(hq, FakeApify(items=[]), session=session)
    assert session.calls == []               # no credits burned market-wide
    assert s.ok
    assert any(r["action"] == "theirstack_skip" for r in hq.tab("log").records())


def test_total_actor_failure_skips_heartbeat(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])
    s = _run(hq, FakeApify(fail=True))
    n_terms = len(search_terms(defaults()["titles_include"]))
    assert not s.ok and len(s.errors) == n_terms   # every term quarantined
    assert not any(r["key"] == "heartbeat_wide" for r in hq.tab("config").records())
    assert hq.tab("feed").records() == []


def test_first_activation_defaults_cursor_and_upserts(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    hq = fake_hq()                            # no wide_cursor row yet
    s = _run(hq, FakeApify(items=[cafe_item()]))
    assert s.appended == 1
    cur = [r for r in hq.tab("config").records() if r["key"] == "wide_cursor"]
    assert len(cur) == 1 and cur[0]["value"] == "2026-07-13T04:00:00.000Z"
    assert cur[0]["description"].startswith("(auto)")


# ---- geo-first mode (WS4): "any employer in this metro"

def test_geo_first_body_drops_the_company_fence_and_sends_location_ids():
    from monitor.wide import theirstack_body
    b = theirstack_body("2026-07-01T00:00:00Z", ["fp&a", "treasury"],
                        companies=["Acme"], location_ids=[4887398], limit=50)
    assert b["job_location_or"] == [{"id": 4887398}]
    assert b["limit"] == 50
    assert b["discovered_at_gte"] == "2026-07-01T00:00:00Z"
    assert b["job_title_or"] == ["fp&a", "treasury"]
    assert b["company_name_case_insensitive_or"] == ["Acme"]


def test_company_fenced_body_unchanged_when_no_location_ids():
    from monitor.wide import theirstack_body
    b = theirstack_body("cur", ["pm"], companies=["Acme"])
    assert "job_location_or" not in b
    assert b["company_name_case_insensitive_or"] == ["Acme"]


def test_preview_mode_blurs_and_drops_company_filter():
    # blurred previews are free (no credits) and are how a query gets sized
    # before it is paid for; the vendor rejects blur + company identifiers
    from monitor.wide import theirstack_body
    b = theirstack_body("cur", ["fp&a"], companies=["Acme"],
                        location_ids=[1], preview=True)
    assert b["blur_company_data"] is True
    assert "company_name_case_insensitive_or" not in b


def test_date_cursor_is_always_present():
    # TheirStack REQUIRES a date filter on any non-company-fenced query, and
    # the cursor is also what stops us re-buying yesterday's rows
    from monitor.wide import theirstack_body
    assert theirstack_body("cur", ["x"], location_ids=[1])["discovered_at_gte"] == "cur"
