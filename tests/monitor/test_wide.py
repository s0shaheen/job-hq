import json
from urllib.parse import unquote

import pytest

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
    # the nightly wide_theirstack job sends exactly this — byte-identical to the
    # pre-E-024 shape (its company fence already satisfies the mandatory rule,
    # so no posted_at_gte is added and nothing about production changes)
    from monitor.wide import theirstack_body
    b = theirstack_body("cur", ["pm"], companies=["Acme"])
    assert b == {"limit": wide.TS_LIMIT, "offset": 0, "discovered_at_gte": "cur",
                 "job_title_or": ["pm"], "company_name_case_insensitive_or": ["Acme"]}
    assert list(b) == ["limit", "offset", "discovered_at_gte",
                       "job_title_or", "company_name_case_insensitive_or"]
    assert "posted_at_gte" not in b and "job_location_or" not in b


def test_preview_mode_blurs_and_drops_company_filter():
    # blurred previews are free (no credits) and are how a query gets sized
    # before it is paid for; the vendor rejects blur + company identifiers
    from monitor.wide import theirstack_body
    b = theirstack_body("cur", ["fp&a"], companies=["Acme"],
                        location_ids=[1], preview=True)
    assert b["blur_company_data"] is True
    assert "company_name_case_insensitive_or" not in b
    assert "company_domain_or" not in b
    b2 = theirstack_body("cur", ["fp&a"], company_domains=["acme.com"], preview=True)
    assert b2["blur_company_data"] is True and "company_domain_or" not in b2


def test_date_cursor_is_always_present():
    # TheirStack REQUIRES a date filter on any non-company-fenced query, and
    # the cursor is also what stops us re-buying yesterday's rows
    from monitor.wide import theirstack_body
    assert theirstack_body("cur", ["x"], location_ids=[1])["discovered_at_gte"] == "cur"


# ---- E-024: discovered_at_gte does not satisfy the mandatory-filter rule
# (keyed probe 2026-07-26; oracle.py is the prior art)

# Verbatim from the 422 body; job_id_or/job_export_key_or are on the API's list
# too but this module never sends per-job ids, so they are not options here.
E024_FILTERS = ("posted_at_max_age_days", "posted_at_gte", "posted_at_lte",
                "company_name_or", "company_name_case_insensitive_or",
                "company_name_partial_match_or", "company_id_or",
                "company_domain_or", "company_linkedin_url_or")


def _assert_satisfies_e024(body, label):
    """The invariant TheirStack enforces: at least ONE of the mandatory filters.
    Pinning *which* one would pin a mechanism we are free to change; the API
    only cares that the set is non-empty (and `discovered_at_gte` is not in it)."""
    assert [k for k in E024_FILTERS if k in body], \
        f"{label} body carries no E-024 mandatory filter: {sorted(body)}"


def _posted_filters(body):
    return {k: v for k, v in body.items() if k.startswith("posted_at")}


def test_every_unfenced_body_satisfies_the_mandatory_filter_rule():
    from monitor.wide import theirstack_body
    _assert_satisfies_e024(
        theirstack_body(CURSOR, ["fp&a"], location_ids=[4887398]), "geo")
    _assert_satisfies_e024(
        theirstack_body(CURSOR, ["fp&a"], companies=["Acme"], preview=True), "preview")
    _assert_satisfies_e024(theirstack_body(CURSOR, ["fp&a"]), "bare")
    # the cursor rides along on all of them — it narrows, it just cannot satisfy E-024
    assert theirstack_body(CURSOR, ["fp&a"], location_ids=[1])["discovered_at_gte"] == CURSOR


def test_the_mandatory_filter_is_not_derived_from_the_cursor():
    """A cursor-derived posted floor would AND a *discovered_at* high-water mark
    onto a *posted* bound, permanently dropping every late-discovered job (~14%
    of rows lag >=1 day). Moving the cursor must not move the posted window."""
    from monitor.wide import theirstack_body
    old = theirstack_body("2026-01-01T00:00:00Z", ["fp&a"], location_ids=[1])
    new = theirstack_body("2026-07-20T12:34:56Z", ["fp&a"], location_ids=[1])
    assert _posted_filters(old) == _posted_filters(new)
    assert _posted_filters(new) == {"posted_at_max_age_days": wide.TS_UNFENCED_MAX_AGE_DAYS}
    assert old["discovered_at_gte"] != new["discovered_at_gte"]   # only the cursor moved


def test_domain_fence_replaces_the_name_fence_when_domains_are_given():
    # probe 2026-07-26: name fences are fuzzy ("Kraft Heinz" -> 3 companies,
    # "Allstate" -> 6); company_domain_or is exact. Names stay the fallback.
    from monitor.wide import theirstack_body
    b = theirstack_body("cur", ["pm"], companies=["Acme"],
                        company_domains=["acme.com", "acme.io"])
    assert b["company_domain_or"] == ["acme.com", "acme.io"]
    assert "company_name_case_insensitive_or" not in b
    _assert_satisfies_e024(b, "domain-fenced")
    assert _posted_filters(b) == {}        # a domain fence satisfies E-024 by itself


# ---- the Apify call must never block the sweep indefinitely

def test_actor_that_never_finishes_is_a_logged_miss_not_a_hang(monkeypatch):
    """Apify's .call() blocks until the run finishes, and on the free tier a
    run can sit QUEUED forever waiting for credit — which is how this sweep
    went from 2-4 minutes to hitting the workflow timeout with no output."""
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.delenv("THEIRSTACK_API_KEY", raising=False)
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])

    class QueuedForever:
        """Returns a run that never produced a dataset (still QUEUED)."""
        def actor(self, _id):
            outer = self
            class A:
                def call(self, run_input=None, timeout_secs=None, wait_secs=None):
                    outer.bounds = (timeout_secs, wait_secs)
                    return {"status": "RUNNING"}      # no defaultDatasetId
            return A()
        def dataset(self, _id):
            raise AssertionError("must not read a dataset that never existed")

    client = QueuedForever()
    s = _run(hq, client, session=FakeSession())

    # every bound was actually passed — an unbounded call is the bug
    assert client.bounds == (wide.CAFE_RUN_TIMEOUT, wide.CAFE_WAIT)
    # ...and the sweep completed instead of hanging, with the reason recorded
    assert s.errors and "did not finish" in s.errors[0]
    assert s.appended == 0


# ---- independent sources (they share a destination and nothing else)

def test_cafe_only_never_touches_theirstack(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.setenv("THEIRSTACK_API_KEY", "tsk")
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])
    session = FakeSession()
    s = wide.run(hq, session=session, client_factory=lambda t: FakeApify(items=[]),
                 push=lambda *a, **k: True, today=TODAY, sources=("cafe",))
    assert session.calls == []            # no TheirStack HTTP at all
    assert s.ts_fetched == 0


def test_theirstack_only_never_starts_an_apify_run(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.setenv("THEIRSTACK_API_KEY", "tsk")
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])

    class Boom:
        def actor(self, _i):
            raise AssertionError("theirstack-only run must not call Apify")
    s = wide.run(hq, session=FakeSession(), client_factory=lambda t: Boom(),
                 push=lambda *a, **k: True, today=TODAY, sources=("theirstack",))
    assert s.fetched == 0


def test_theirstack_runs_even_when_apify_is_unset(monkeypatch):
    """The coupling bug in one line: with both sources in one job, a missing
    or stalled Apify meant TheirStack never ran."""
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.setenv("THEIRSTACK_API_KEY", "tsk")
    hq = _hq(config=[{"key": "wide_cursor", "value": CURSOR}])
    s = wide.run(hq, session=FakeSession(), client_factory=lambda t: None,
                 push=lambda *a, **k: True, today=TODAY, sources=("theirstack",))
    assert s.skipped is False             # NOT skipped for someone else's token


def test_each_source_writes_its_own_heartbeat():
    from monitor.wide import _beat
    assert _beat(("cafe",)) == "cafe"
    assert _beat(("theirstack",)) == "theirstack"
    assert _beat(("cafe", "theirstack")) == "wide"


# ------------------------------------------------- LinkedIn ids, riding along free

def _ts_job_with_firmographics(name="Plaid", linkedin_id="1035"):
    """The probe-verified payload shape: every TheirStack row carries a
    `company_object` blob, LinkedIn id included (probe #2, 2026-07-26)."""
    j = ts_job()
    j["company_object"] = {"name": name, "domain": "plaid.com", "linkedin_id": linkedin_id,
                           "industry": "Financial Services", "employee_count": 1200}
    return j


def _ts_hq():
    return _hq(companies=[{"name": "Plaid", "ats": "lever", "slug": "plaid",
                           "monitor": "TRUE", "seeded": "TRUE", "priority": "TRUE"}],
               config=[{"key": "wide_cursor", "value": CURSOR},
                       {"key": "wide_theirstack_cursor", "value": CURSOR}])


def _store(monkeypatch, rpc):
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.setenv("THEIRSTACK_API_KEY", "tsk")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    monkeypatch.setattr("core.pgwrites.user_id", lambda: "u-1")
    monkeypatch.setattr("core.pg.rpc", rpc)


def test_the_sweep_keeps_the_linkedin_id_it_was_already_paying_for(monkeypatch):
    """The whole first increment: the id was in the payload, the sweep was parsing
    that payload for the Feed, and the id was going in the bin. Zero extra requests —
    asserted, because a harvest that quietly bought its own page would be a cost
    regression nobody notices until the free tier runs out."""
    sent = []
    _store(monkeypatch, lambda fn, params, session=None: (
        sent.append((fn, params)) or {"outcome": "filled"}))
    session = FakeSession(payload={"data": [_ts_job_with_firmographics()]})
    s = _run(_ts_hq(), FakeApify(items=[]), session=session)

    assert len(session.calls) == 1, "the harvest must not send a request of its own"
    assert s.linkedin_seen == 1 and s.linkedin_filled == 1
    fn, params = sent[0]
    assert fn == "hq_fill_linkedin_company_id"
    assert params["p_name"] == "Plaid" and params["p_linkedin_id"] == "1035"
    assert params["p_source"] == "wide-theirstack"


def test_a_row_that_fails_the_title_gate_still_donates_its_companys_id(monkeypatch):
    """The id is a fact about the EMPLOYER and the row is bought either way. Harvest
    after the Feed mapping instead and a company whose only match this week is a
    Sales role keeps its empty cell."""
    _store(monkeypatch, lambda fn, params, session=None: {"outcome": "filled"})
    job = _ts_job_with_firmographics()
    job["job_title"] = "Account Executive"          # vetoed by titles_exclude/include
    s = _run(_ts_hq(), FakeApify(items=[]), session=FakeSession(payload={"data": [job]}))
    assert s.appended == 0 and s.linkedin_filled == 1


def test_a_store_failure_costs_the_id_and_not_the_sweep(monkeypatch):
    """Deliberate exception to fail-loud, stated in `_harvest_linkedin`: this is an
    enrichment riding an already-optional lane, and `monitor.linkedin_backfill` picks
    up whatever it drops. Losing a day of discovery over it is the expensive half."""
    _store(monkeypatch, lambda *a, **k: (_ for _ in ()).throw(RuntimeError("PostgREST 503")))
    hq = _ts_hq()
    s = _run(hq, FakeApify(items=[]),
             session=FakeSession(payload={"data": [_ts_job_with_firmographics()]}))
    assert s.ok and s.appended == 1 and s.linkedin_filled == 0
    assert any(r["action"] == "linkedin_error" for r in hq.tab("log").records())


def test_one_malformed_row_in_a_bought_page_still_lands_every_other_posting(monkeypatch):
    """MAJOR-2, the regression this ordering exists to prevent — and it was a
    regression against `main`, proven both ways: with the harvest ahead of the Feed
    loop and its parse outside the envelope, a single `null` element gave
    `appended=0` where main gave 1, with exit code 0 and the heartbeat written, so
    nothing anywhere said a day of postings had been dropped.

    MUTATION REASON: move the `_harvest_linkedin` call back above `for job in
    ts_jobs:`, or lift `harvest_all` out of its `try`, and this goes red while every
    other test in this file stays green.
    """
    _store(monkeypatch, lambda fn, params, session=None: {"outcome": "filled"})
    hq = _ts_hq()
    page = {"data": [_ts_job_with_firmographics(), None]}
    s = _run(hq, FakeApify(items=[]), session=FakeSession(payload=page))
    assert s.appended == 1, "the sweep's own product must survive a bad row"
    assert s.ok and hq.tab("feed").records()[0]["company"] == "Plaid"
    # And the good row's id was still harvested: a malformed neighbour costs one id.
    assert s.linkedin_filled == 1


def test_the_harvest_cannot_reach_the_sweeps_error_list(monkeypatch):
    """The envelope, from the other side: an exploding harvest must not appear as a
    TheirStack failure, because that is the signal the ops watchdog reads."""
    _store(monkeypatch, lambda *a, **k: {"outcome": "filled"})
    monkeypatch.setattr("monitor.linkedin_backfill.harvest_all",
                        lambda jobs: (_ for _ in ()).throw(RuntimeError("boom")))
    hq = _ts_hq()
    s = _run(hq, FakeApify(items=[]),
             session=FakeSession(payload={"data": [_ts_job_with_firmographics()]}))
    assert s.appended == 1 and s.ok
    assert not any("theirstack" in e for e in s.errors)


def test_no_store_configured_is_a_clean_skip(monkeypatch):
    """Phase A, and any lane whose registry block carries no pg id. The ids are still
    COUNTED as seen, so the log does not imply the payload never carried them."""
    monkeypatch.setenv("APIFY_TOKEN", "tok")
    monkeypatch.setenv("THEIRSTACK_API_KEY", "tsk")
    monkeypatch.setattr("core.pg.enabled", lambda: False)
    monkeypatch.setattr("core.pg.rpc", lambda *a, **k: pytest.fail("wrote with no store"))
    s = _run(_ts_hq(), FakeApify(items=[]),
             session=FakeSession(payload={"data": [_ts_job_with_firmographics()]}))
    assert s.ok and s.linkedin_seen == 1 and s.linkedin_filled == 0
