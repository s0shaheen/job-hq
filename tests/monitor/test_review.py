from monitor.models import Company, JobRecord
from monitor.review import review_feed
from monitor.sheet import FakeSheetStore
from monitor.tagging import Tags

TODAY = "2026-07-13"


def _rec(jid, company="Acme", status="New", url="http://x", first_seen=TODAY):
    return JobRecord(id=jid, company=company, title="PM", location="NYC",
                     url=url, status=status, first_seen=first_seen,
                     last_seen=TODAY, posted="")


def _store(records, companies=None):
    history = {r.id: r for r in records}
    return FakeSheetStore(companies or [Company("Acme", "greenhouse", "acme")], history)


def _fetch_const(text):
    def fetch(ats, native_id, slug, url, session):
        return text
    return fetch


def _extract_echo(jd, title, company, *, client=None):
    return Tags(yoe="5+", role_focus=jd[:10])


def test_tags_open_untagged_job_with_min_yoe():
    store = _store([_rec("greenhouse-1", status="Seen")])
    summary = review_feed(store, today=TODAY,
                          fetch=_fetch_const("Own the roadmap end to end"),
                          extract=_extract_echo)
    assert summary.tagged == 1
    assert store.tags_for("greenhouse-1").yoe == "5+"
    assert store.read_min_yoe()["greenhouse-1"] == "5"   # derived at write time
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-1"] == TODAY


def test_skips_closed_jobs():
    store = _store([_rec("greenhouse-1", status="Closed")])
    summary = review_feed(store, today=TODAY,
                          fetch=_fetch_const("text"), extract=_extract_echo)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1") is None


def test_skips_already_tagged_without_calling_fetch():
    store = _store([_rec("greenhouse-1")])
    store.write_tags({"greenhouse-1": Tags(yoe="old")}, "2026-07-01")

    def boom(*a, **k):
        raise AssertionError("must not fetch an already-tagged row")

    summary = review_feed(store, today=TODAY, fetch=boom, extract=_extract_echo)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1").yoe == "old"


def test_empty_jd_writes_no_jd_sentinel_so_it_stops_being_retried():
    store = _store([_rec("amazon-1")])
    summary = review_feed(store, today=TODAY,
                          fetch=_fetch_const(""), extract=_extract_echo)
    assert summary.tagged == 0
    assert summary.skipped_no_jd == 1
    assert store.tags_for("amazon-1") is None      # no tags written
    # sentinel stamped on tagged_at so the next sweep skips it (no more forever-retry)
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["amazon-1"].startswith("no-jd:")


def test_no_jd_sentinel_prevents_reprocessing_next_run():
    store = _store([_rec("amazon-1")])
    review_feed(store, today=TODAY, fetch=_fetch_const(""), extract=_extract_echo)

    def boom(*a, **k):
        raise AssertionError("a sentinel'd no-jd row must not be fetched again")

    summary = review_feed(store, today="2026-07-14", fetch=boom, extract=_extract_echo)
    assert summary.tagged == 0 and summary.skipped_no_jd == 0   # nothing pending


def test_per_job_failure_is_isolated():
    store = _store(
        [_rec("greenhouse-1", company="Good"), _rec("greenhouse-2", company="Bad")],
        companies=[Company("Good", "greenhouse", "good"),
                   Company("Bad", "greenhouse", "bad")],
    )

    def fetch(ats, native_id, slug, url, session):
        if slug == "bad":
            raise RuntimeError("boom")
        return "real jd"

    summary = review_feed(store, today=TODAY, fetch=fetch, extract=_extract_echo,
                          retry_max=0)
    assert summary.tagged == 1
    assert summary.failed == 1
    assert store.tags_for("greenhouse-1") is not None
    assert store.tags_for("greenhouse-2") is None            # left untagged -> retried
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-2"] == ""                   # young + failing -> stays pending


def test_id_with_hyphenated_native_id_parses_ats_and_full_id():
    seen = {}

    def fetch(ats, native_id, slug, url, session):
        seen["ats"] = ats
        seen["native_id"] = native_id
        return "jd"

    store = _store([_rec("lever-618c-cb22-baca")],
                   companies=[Company("Acme", "lever", "acme")])
    review_feed(store, today=TODAY, fetch=fetch, extract=_extract_echo)
    assert seen["ats"] == "lever"
    assert seen["native_id"] == "618c-cb22-baca"


# ---- retry, dead-letter, backlog, concurrency

def test_transient_failure_retries_in_run_then_succeeds():
    store = _store([_rec("greenhouse-1")])
    calls = {"n": 0}

    def flaky(ats, native_id, slug, url, session):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("429 slow down")
        return "real jd"

    summary = review_feed(store, today=TODAY, fetch=flaky, extract=_extract_echo,
                          retry_max=2, sleep=lambda _s: None)
    assert calls["n"] == 2                       # failed once, retried, succeeded
    assert summary.tagged == 1 and summary.failed == 0
    assert store.tags_for("greenhouse-1") is not None


def test_deadletters_a_row_stuck_past_the_grace_window():
    # first_seen 12 days before today: it has failed every nightly sweep since
    old = _rec("greenhouse-1", first_seen="2026-07-01")   # TODAY = 2026-07-13
    store = _store([old])

    def boom(*a, **k):
        raise RuntimeError("delisted — 404 forever")

    summary = review_feed(store, today=TODAY, fetch=boom, extract=_extract_echo,
                          retry_max=0, deadletter_days=4)
    assert summary.failed == 1 and summary.deadlettered == 1
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-1"].startswith("failed:")   # given up on, stops retrying


def test_young_failing_row_stays_pending_not_deadlettered():
    store = _store([_rec("greenhouse-1", first_seen=TODAY),      # brand new
                    _rec("greenhouse-2", first_seen=TODAY)])

    def boom(*a, **k):
        raise RuntimeError("down")

    summary = review_feed(store, today=TODAY, fetch=boom, extract=_extract_echo,
                          retry_max=0, deadletter_days=4)
    assert summary.failed == 2 and summary.deadlettered == 0
    assert summary.backlog == 2                  # both still pending, none resolved
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-1"] == "" and tagged_at["greenhouse-2"] == ""


def test_concurrency_tags_a_large_batch():
    recs = [_rec(f"greenhouse-{i}") for i in range(50)]
    store = _store(recs)
    summary = review_feed(store, today=TODAY, workers=8,
                          fetch=_fetch_const("own the roadmap"), extract=_extract_echo)
    assert summary.tagged == 50 and summary.backlog == 0
    assert all(store.tags_for(f"greenhouse-{i}") is not None for i in range(50))


def test_time_budget_leaves_remainder_pending_as_backlog():
    recs = [_rec(f"greenhouse-{i}") for i in range(5)]
    store = _store(recs)
    # zero budget: the deadline is already past, so no row is processed
    summary = review_feed(store, today=TODAY, workers=1, time_budget_min=0,
                          fetch=_fetch_const("jd"), extract=_extract_echo)
    assert summary.tagged == 0
    assert summary.backlog == 5                  # everything deferred to the next run


# ---- main() wiring

def test_main_skips_cleanly_without_api_key(monkeypatch):
    import monitor.review as review_mod
    from core.sheets import HQ
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def explode(cls):
        raise AssertionError("HQ must not be opened when tagging is skipped")

    monkeypatch.setattr(HQ, "open", classmethod(explode))
    assert review_mod.main() == 0


def test_main_heartbeats_review(monkeypatch):
    import monitor.review as review_mod
    from core.fakes import fake_hq
    from core.sheets import HQ

    hq = fake_hq()
    monkeypatch.setattr(HQ, "open", classmethod(lambda cls: hq))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("HQ_SHEET_ID", "test-sheet")
    assert review_mod.main() == 0                    # empty feed -> clean pass
    beat = [r for r in hq.tab("config").records() if r["key"] == "heartbeat_review"]
    assert beat and beat[0]["value"] != ""


def test_main_ops_pushes_on_systemic_failure(monkeypatch):
    import core.notify
    import monitor.jobcontent as jobcontent_mod
    import monitor.review as review_mod
    from core.fakes import fake_hq
    from core.sheets import HQ

    hq = fake_hq()
    hq.tab("companies").append_records(
        [{"name": "Acme", "ats": "greenhouse", "slug": "acme", "monitor": "TRUE"}])
    hq.tab("feed").append_records(
        [{"key": "greenhouse-1", "company": "Acme", "title": "PM",
          "url": "http://x", "status": "New"}])
    hq.tab("config").append_records([{"key": "tag_retry_max", "value": "0"}])  # no backoff sleeps in test
    monkeypatch.setattr(HQ, "open", classmethod(lambda cls: hq))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("HQ_SHEET_ID", "test-sheet")

    def boom(*a, **k):
        raise RuntimeError("expired key")

    monkeypatch.setattr(jobcontent_mod, "fetch_description", boom)
    ops = []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append((title, body)))
    assert review_mod.main() == 1
    assert ops and "failed" in ops[0][1]
