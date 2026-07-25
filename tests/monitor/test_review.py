import time

import monitor.run as run_mod
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


def _extract_echo(jd, title, company, *, client=None, domain=None):
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


# ---- runtime deadline clamp (REVIEW_TIME_BUDGET_MIN defaults to 40m; Lambda kills at 900s)
#
# Unclamped, the nightly sweep believes it has 40 minutes inside a 15-minute runtime and gets
# SIGKILLed mid-flight: the final flush, mark_untaggable, set_disposition and the heartbeat all
# die with it, so the same rows are re-fetched (and re-billed) the next night forever.

FLUSH_EVERY = 100        # review_feed's default chunk; two chunks need one row more


def _two_chunk_review(monkeypatch, *, jump_to, time_budget_min=30):
    """A sweep whose clock moves EXACTLY once: between tagging chunk 1 and chunk 2.

    Same shape as tests/monitor/test_run.py's clamp-consumption harness, and non-tautological
    for the same reason: the clock lands past the CLAMPED deadline but short of the
    `time_budget_min` one, so a review_feed that computed the clamp and then ignored it would
    finish the sweep and fail these assertions.
    """
    clock = {"t": 1_000.0}
    monkeypatch.setattr(time, "monotonic", lambda: clock["t"])
    monkeypatch.setattr(time, "time", lambda: 5_000.0)      # _clamp_deadline's wall clock
    n = FLUSH_EVERY + 1
    store = _store([_rec(f"greenhouse-{i:03d}") for i in range(n)])
    calls = {"n": 0}

    def fetch(ats, native_id, slug, url, session):
        calls["n"] += 1
        if calls["n"] == FLUSH_EVERY:                       # last row of chunk 1
            clock["t"] = jump_to
        return "own the roadmap"

    summary = review_feed(store, today=TODAY, workers=1, flush_every=FLUSH_EVERY,
                          time_budget_min=time_budget_min, fetch=fetch,
                          extract=_extract_echo)
    return summary, store


def test_the_clamped_deadline_is_what_actually_stops_the_review(monkeypatch, capsys):
    # 100s of runtime left at t=5000 -> clamped stop at monotonic 1100; the 30m budget would
    # not stop until 2800, and the clock only ever reaches 2000.
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, "5100")
    summary, store = _two_chunk_review(monkeypatch, jump_to=2_000.0)
    assert summary.tagged == FLUSH_EVERY                    # chunk 1 tagged and flushed
    assert summary.backlog == 1                             # chunk 2 deferred, not lost
    assert store.tags_for("greenhouse-100") is None         # the row the deadline skipped
    err = capsys.readouterr().err
    assert "clamping to 1.7m" in err and "time budget reached" in err


def test_without_the_runtime_hint_the_same_clock_finishes_the_review(monkeypatch):
    """The control: identical clock, identical budget, only the env var differs."""
    monkeypatch.delenv(run_mod.RUNTIME_DEADLINE_ENV, raising=False)
    summary, store = _two_chunk_review(monkeypatch, jump_to=2_000.0)
    assert summary.tagged == FLUSH_EVERY + 1 and summary.backlog == 0
    assert store.tags_for("greenhouse-100") is not None


def test_malformed_runtime_deadline_never_skips_the_review(monkeypatch, capsys):
    monkeypatch.setenv(run_mod.RUNTIME_DEADLINE_ENV, "soonish")
    summary, _ = _two_chunk_review(monkeypatch, jump_to=2_000.0)
    assert summary.tagged == FLUSH_EVERY + 1                # a bad hint is not a reason to stop
    assert "malformed" in capsys.readouterr().err


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
          "url": "http://x", "status": "New",
          "location": "New York, NY"}])   # US row: stays in the tagging set post-gates
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


# ---- gate-aware tagging (WS1): the stored disposition is the authority

def _gate_cfg():
    from monitor.gates import GateConfig
    return GateConfig(countries=["United States"],
                      seniority_exclude=["Senior", "Staff", "GPM", "Director", "VP"])


def test_stored_filtered_disposition_skips_tagging_entirely():
    store = _store([_rec("greenhouse-1")])
    store.tag_ctx = {"greenhouse-1": {"disposition": "filtered",
                                      "country": "India", "remote": "",
                                      "market": "India", "work_model": "",
                                      "seniority": ""}}
    calls = []
    s = review_feed(store, today=TODAY, fetch=lambda *a, **k: calls.append(a) or "jd",
                    extract=lambda *a, **k: Tags(yoe="2"), workers=1,
                    gate_cfg=_gate_cfg())
    assert calls == [] and s.tagged == 0


def test_producer_needs_info_disposition_is_tagged_even_if_geo_unparseable():
    # priority admits geo-unknown rows under keep; review must honor that
    # stamp instead of re-deriving geo blind and starving the row
    rec = _rec("greenhouse-2")
    rec.location = "HQ - Anywhere"
    store = _store([rec])
    store.tag_ctx = {"greenhouse-2": {"disposition": "needs-info",
                                      "country": "", "remote": "",
                                      "market": "", "work_model": "",
                                      "seniority": ""}}
    s = review_feed(store, today=TODAY, fetch=lambda *a, **k: "jd",
                    extract=lambda *a, **k: Tags(yoe="2"), workers=1,
                    gate_cfg=_gate_cfg())
    assert s.tagged == 1


def test_legacy_remote_row_kept_via_stored_geo_columns():
    # pre-disposition row whose remoteness lives in stored geo (work_model
    # arrived at append): the pre-tag gate must use stored geo, not re-enrich
    rec = _rec("greenhouse-3")
    rec.location = ""
    store = _store([rec])
    store.tag_ctx = {"greenhouse-3": {"disposition": "",
                                      "country": "", "remote": "TRUE",
                                      "market": "Remote", "work_model": "Remote",
                                      "seniority": ""}}
    s = review_feed(store, today=TODAY, fetch=lambda *a, **k: "jd",
                    extract=lambda *a, **k: Tags(yoe="1"), workers=1,
                    gate_cfg=_gate_cfg())
    assert s.tagged == 1


def test_untaggable_regate_uses_stored_geo_and_seniority():
    rec = _rec("greenhouse-4")
    rec.location = ""
    store = _store([rec])
    store.tag_ctx = {"greenhouse-4": {"disposition": "needs-info",
                                      "country": "", "remote": "TRUE",
                                      "market": "Remote", "work_model": "Remote",
                                      "seniority": "Director"}}
    s = review_feed(store, today=TODAY, fetch=lambda *a, **k: "",   # no JD -> untaggable
                    extract=lambda *a, **k: None, workers=1, gate_cfg=_gate_cfg())
    assert s.skipped_no_jd == 1
    # remote row stays geo-qualified, but Director seniority + unknown YoE
    # falls to the seniority proxy -> filtered, NOT geo-unknown
    d, reason = store.dispositions["greenhouse-4"]
    assert d == "filtered" and reason == "seniority:Director"
