from core.fakes import fake_hq
from monitor.models import Job
from monitor.priority import known_keys, run, truthy
from monitor.tagging import Tags

TODAY = "2026-07-13"


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


def company(name="Plaid", ats="greenhouse", slug="plaid",
            monitor="TRUE", seeded="TRUE", priority="TRUE"):
    return {"name": name, "ats": ats, "slug": slug,
            "monitor": monitor, "seeded": seeded, "priority": priority}


def _fetch(mapping, calls=None):
    def fetch(ats, slug, name, session, workday_search="product"):
        if calls is not None:
            calls.append(name)
        v = mapping.get(name, [])
        if isinstance(v, Exception):
            raise v
        return v
    return fetch


class PushSpy:
    def __init__(self):
        self.calls = []

    def __call__(self, title, body, **kw):
        self.calls.append((title, body, kw))
        return True


def test_truthy_helper():
    assert truthy("TRUE") and truthy(" yes ") and truthy("1")
    assert not truthy("") and not truthy("FALSE") and not truthy(None)


def test_new_role_appended_and_pushed_immediately():
    hq = _hq(companies=[company()])
    jobs = [Job("greenhouse", "11", "Plaid", "Senior Product Manager", "NYC", "http://11"),
            Job("greenhouse", "12", "Plaid", "Staff Engineer", "NYC", "http://12")]  # filtered
    push = PushSpy()
    s = run(hq, fetch=_fetch({"Plaid": jobs}), push=push, tagger=None, today=TODAY)

    assert s.new == 1 and s.pushes == 1
    recs = hq.tab("feed").records()
    assert len(recs) == 1
    r = recs[0]
    assert r["key"] == "greenhouse-11"
    assert r["status"] == "New"
    assert r["first_seen"] == TODAY and r["last_seen"] == TODAY
    assert r["pushed_at"] != ""

    title, body, kw = push.calls[0]
    assert title == "Priority: Plaid posted 1 role(s)"
    assert body == "• Senior Product Manager — NYC"
    assert kw["kind"] == "jobs" and kw["tags"] == ["dart"] and kw["priority"] == "high"
    assert kw["click"] == "http://11"
    # appends are audit-logged
    assert any(row["action"] == "new_role" and row["key"] == "greenhouse-11"
               for row in hq.tab("log").records())


def test_keys_already_in_feed_or_pipeline_are_skipped():
    hq = _hq(companies=[company()],
             feed=[{"key": "greenhouse-1", "company": "Plaid", "title": "PM",
                    "status": "Seen", "first_seen": "2026-07-01", "last_seen": "2026-07-12"}],
             pipeline=[{"key": "greenhouse-2", "company": "Plaid", "title": "PM", "status": "Applied"}])
    jobs = [Job("greenhouse", "1", "Plaid", "Product Manager", "NYC", "http://1"),
            Job("greenhouse", "2", "Plaid", "Product Manager, Core", "NYC", "http://2")]
    push = PushSpy()
    s = run(hq, fetch=_fetch({"Plaid": jobs}), push=push, tagger=None, today=TODAY)
    assert s.new == 0 and push.calls == []
    assert len(hq.tab("feed").records()) == 1   # nothing re-appended


def test_only_seeded_priority_companies_are_fetched():
    hq = _hq(companies=[
        company(name="Plaid"),
        company(name="NotPriority", priority="FALSE"),
        company(name="NotMonitored", monitor=""),
        company(name="Unseeded", seeded=""),
    ])
    calls = []
    s = run(hq, fetch=_fetch({}, calls=calls), push=PushSpy(), tagger=None, today=TODAY)
    assert calls == ["Plaid"]
    assert s.attempted == 1 and s.skipped_unseeded == 1


def test_one_company_error_never_kills_the_run():
    hq = _hq(companies=[company(name="Bad", slug="bad"), company(name="Good", slug="good")])
    jobs = [Job("greenhouse", "7", "Good", "Product Manager", "Remote", "http://7")]
    push = PushSpy()
    s = run(hq, fetch=_fetch({"Bad": RuntimeError("boom"), "Good": jobs}),
            push=push, tagger=None, today=TODAY)
    assert s.errors == ["Bad: boom"]
    assert s.new == 1 and len(push.calls) == 1
    assert any(r["action"] == "fetch_error" for r in hq.tab("log").records())
    # partial failure still heartbeats (the watch ran)
    assert any(r["key"] == "heartbeat_priority" for r in hq.tab("config").records())


def test_push_fires_before_tagging_and_ignores_yoe_gate():
    hq = _hq(companies=[company()])
    jobs = [Job("greenhouse", "9", "Plaid", "Product Manager", "SF", "http://9")]
    events = []

    def push(title, body, **kw):
        events.append("push")
        return True

    def tagger(job, slug):
        events.append("tag")
        return Tags(yoe="10+", seniority="Director", company_industry="Fintech",
                    role_focus="Payments", skills="APIs; SQL", comp_range="$220k-$260k",
                    work_model="Remote (US)")

    s = run(hq, fetch=_fetch({"Plaid": jobs}), push=push, tagger=tagger, today=TODAY)
    assert events == ["push", "tag"]          # min_yoe 10 > yoe_push_max 4: pushed anyway
    assert s.pushes == 1 and s.tagged == 1
    r = hq.tab("feed").records()[0]
    assert r["yoe"] == "10+" and r["min_yoe"] == "10"
    assert r["seniority"] == "Director" and r["skills"] == "APIs; SQL"
    assert r["tagged_at"] == TODAY


def test_implausible_yoe_writes_blank_min_yoe():
    """min_yoe comes from Tags.min_yoe (0-30 cap), same as the daily monitor
    and nightly review — junk like a year must land as unknown, not 2026."""
    hq = _hq(companies=[company()])
    jobs = [Job("greenhouse", "4", "Plaid", "Product Manager", "SF", "http://4")]

    def tagger(job, slug):
        return Tags(yoe="class of 2026")

    run(hq, fetch=_fetch({"Plaid": jobs}), push=PushSpy(), tagger=tagger, today=TODAY)
    r = hq.tab("feed").records()[0]
    assert r["min_yoe"] == "" and r["tagged_at"] == TODAY


def test_tagging_failure_never_blocks_the_push():
    hq = _hq(companies=[company()])
    jobs = [Job("greenhouse", "3", "Plaid", "Product Manager", "SF", "http://3")]
    push = PushSpy()

    def tagger(job, slug):
        raise RuntimeError("LLM down")

    s = run(hq, fetch=_fetch({"Plaid": jobs}), push=push, tagger=tagger, today=TODAY)
    assert len(push.calls) == 1 and s.new == 1 and s.tagged == 0
    r = hq.tab("feed").records()[0]
    assert r["tagged_at"] == ""               # review retries tonight
    assert any(row["action"] == "tag_error" for row in hq.tab("log").records())


def test_health_untouched_and_heartbeat_written():
    hq = _hq(companies=[company()])
    jobs = [Job("greenhouse", "5", "Plaid", "Product Manager", "SF", "http://5")]
    run(hq, fetch=_fetch({"Plaid": jobs}), push=PushSpy(), tagger=None, today=TODAY)
    assert hq.tab("health").records() == []   # Health belongs to the daily monitor
    assert any(r["key"] == "heartbeat_priority" for r in hq.tab("config").records())


def test_all_companies_failing_skips_heartbeat():
    hq = _hq(companies=[company(name="A"), company(name="B")])
    s = run(hq, fetch=_fetch({"A": RuntimeError("x"), "B": RuntimeError("y")}),
            push=PushSpy(), tagger=None, today=TODAY)
    assert len(s.errors) == 2
    assert not any(r["key"] == "heartbeat_priority" for r in hq.tab("config").records())


def test_known_keys_merges_feed_and_pipeline():
    hq = _hq(feed=[{"key": "greenhouse-1", "company": "A", "title": "t", "status": "New",
                    "first_seen": TODAY, "last_seen": TODAY}],
             pipeline=[{"key": "lever-abc", "company": "B", "title": "t", "status": "Applied"}])
    assert known_keys(hq) == {"greenhouse-1", "lever-abc"}


def test_multi_role_push_body_lists_each_role():
    hq = _hq(companies=[company()])
    jobs = [Job("greenhouse", "21", "Plaid", "Product Manager, Ledger", "NYC", "http://21"),
            Job("greenhouse", "22", "Plaid", "Group Product Manager", "", "http://22")]
    push = PushSpy()
    run(hq, fetch=_fetch({"Plaid": jobs}), push=push, tagger=None, today=TODAY)
    title, body, kw = push.calls[0]
    assert title == "Priority: Plaid posted 2 role(s)"
    assert body.splitlines() == ["• Product Manager, Ledger — NYC",
                                 "• Group Product Manager"]
    assert kw["click"] == "http://21"
