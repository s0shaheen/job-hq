"""Chunked/concurrent sweep semantics: per-chunk flushes, the soft time
budget, partial-run safety, and gate-aware pushes (monitor/run.py rewrite)."""
import pytest

import monitor.run as run_mod
from monitor.config import RuntimeConfig
from monitor.gates import GateConfig
from monitor.models import Company, Job
from monitor.run import run_monitor
from monitor.sheet import FakeSheetStore
from monitor.tagging import Tags

TODAY = "2026-07-19"


def _cfg(**kw):
    base = dict(include=["product manager"], exclude=[], workday_search="product",
                yoe_push_max=4, push_new_jobs=True, push_status_events=True)
    base.update(kw)
    return RuntimeConfig(**base)


def _companies(n, seeded=True):
    return [Company(name=f"Co{i}", ats="greenhouse", slug=f"co{i}",
                    monitor=True, seeded=seeded) for i in range(n)]


def _fetch_returns(mapping):
    def fake(ats, slug, company, session, workday_search="product"):
        return mapping.get(company, [])
    return fake


class _Pusher:
    def __init__(self):
        self.calls = []

    def __call__(self, title, body, **kw):
        self.calls.append((title, body, kw))
        return True


class _FlushSpy(FakeSheetStore):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.append_calls = 0

    def append_jobs(self, records, tags=None, today=""):
        self.append_calls += 1
        super().append_jobs(records, tags=tags, today=today)


def test_appends_flush_per_chunk_not_at_the_end(monkeypatch):
    monkeypatch.setattr(run_mod, "FETCH_CHUNK", 2)
    cos = _companies(5)
    jobs = {c.name: [Job("greenhouse", f"{c.name}-1", c.name,
                         "Product Manager", "New York, NY", "http://x")]
            for c in cos}
    store = _FlushSpy(cos, {})
    s = run_monitor(store, _cfg(), fetch=_fetch_returns(jobs), today=TODAY,
                    session=object(), pusher=_Pusher(), fetch_workers=1)
    assert store.append_calls == 3          # ceil(5/2) chunks, one flush each
    assert s.boards_done == 5 and not s.partial
    assert len(store.read_history()) == 5


def test_budget_zero_stops_before_any_board_and_skips_health(monkeypatch):
    monkeypatch.setattr(run_mod, "FETCH_CHUNK", 2)
    cos = _companies(4)
    store = _FlushSpy(cos, {})
    called = {"n": 0}

    def counting_fetch(ats, slug, company, session, workday_search="product"):
        called["n"] += 1
        return []

    s = run_monitor(store, _cfg(), fetch=counting_fetch, today=TODAY,
                    session=object(), pusher=_Pusher(), fetch_workers=1,
                    budget_min=0)
    assert s.partial and s.boards_done == 0 and called["n"] == 0
    assert store.health_rows == []          # full-tab rewrite skipped on partial


def test_health_written_only_after_a_complete_pass():
    cos = _companies(3)
    store = FakeSheetStore(cos, {})
    s = run_monitor(store, _cfg(), fetch=_fetch_returns({}), today=TODAY,
                    session=object(), pusher=_Pusher(), fetch_workers=1)
    assert not s.partial
    assert len(store.health_rows) == 3


def test_push_respects_geo_gate_when_gates_configured():
    gates_cfg = GateConfig(countries=["United States"])
    cos = [Company(name="Stripe", ats="greenhouse", slug="s", monitor=True, seeded=True),
           Company(name="Wise", ats="greenhouse", slug="w", monitor=True, seeded=True)]
    jobs = {
        "Stripe": [Job("greenhouse", "us1", "Stripe", "Product Manager",
                       "New York, NY", "http://x/us")],
        "Wise": [Job("greenhouse", "uk1", "Wise", "Product Manager",
                     "London, United Kingdom", "http://x/uk")],
    }

    def tagger(rec, slug):
        return Tags(yoe="2+ years")         # both clear the YoE bar

    pusher = _Pusher()
    store = FakeSheetStore(cos, {})
    s = run_monitor(store, _cfg(gates=gates_cfg), fetch=_fetch_returns(jobs),
                    tagger=tagger, today=TODAY, session=object(), pusher=pusher,
                    fetch_workers=1)
    assert s.pushed == 1
    (title, body, _kw) = pusher.calls[0]
    assert "Stripe" in body and "Wise" not in body


def test_concurrent_fetch_reassembles_results_deterministically():
    # workers>1 exercises the real thread pool; results must map back by index
    cos = _companies(6)
    jobs = {c.name: [Job("greenhouse", f"{c.name}-1", c.name,
                         "Product Manager", "Chicago, IL", "http://x")]
            for c in cos}
    store = FakeSheetStore(cos, {})
    s = run_monitor(store, _cfg(), fetch=_fetch_returns(jobs), today=TODAY,
                    session=object(), pusher=_Pusher(), fetch_workers=4)
    assert s.boards_done == 6 and s.new_count == 6
    assert sorted(r.company for r in store.read_history().values()) == \
        sorted(c.name for c in cos)


def test_fetch_error_still_quarantined_under_concurrency():
    cos = _companies(3)

    def flaky(ats, slug, company, session, workday_search="product"):
        if company == "Co1":
            raise RuntimeError("boom")
        return []

    store = FakeSheetStore(cos, {})
    s = run_monitor(store, _cfg(), fetch=flaky, today=TODAY, session=object(),
                    pusher=_Pusher(), fetch_workers=2)
    assert s.errored == 1 and s.error_companies == ["Co1"]
    assert s.ok + s.zero == 2 and not s.partial
    assert len(store.health_rows) == 3      # ERROR row included, health complete


def test_budget_stop_parks_cursor_and_next_run_resumes_there(monkeypatch):
    monkeypatch.setattr(run_mod, "FETCH_CHUNK", 2)
    cos = _companies(6)
    seen = []

    def recording_fetch(ats, slug, company, session, workday_search="product"):
        seen.append(company)
        return []

    store = FakeSheetStore(cos, {})
    s = run_monitor(store, _cfg(), fetch=recording_fetch, today=TODAY,
                    session=object(), pusher=_Pusher(), fetch_workers=1,
                    budget_min=0)
    assert s.partial and store.sweep_cursor == "Co0"

    # next run (with budget) starts at the cursor and clears it when complete
    store2 = FakeSheetStore(cos, {})
    store2.sweep_cursor = "Co3"
    seen.clear()
    s2 = run_monitor(store2, _cfg(), fetch=recording_fetch, today=TODAY,
                     session=object(), pusher=_Pusher(), fetch_workers=1)
    assert seen[:3] == ["Co3", "Co4", "Co5"]      # rotation: cursor first, wraps
    assert not s2.partial and store2.sweep_cursor == ""


def test_mid_chunk_deadline_flushes_and_parks_cursor(monkeypatch):
    monkeypatch.setattr(run_mod, "FETCH_CHUNK", 4)
    cos = _companies(4)
    jobs = {c.name: [Job("greenhouse", f"{c.name}-1", c.name,
                         "Product Manager", "Chicago, IL", "http://x")]
            for c in cos}

    real_map = run_mod.tagworker.map_concurrent

    def truncated_map(items, fn, *, workers, deadline=None):
        out = real_map(list(items)[:2], fn, workers=workers)   # pool "ran out of time"
        return out                                             # indices 2,3 missing

    monkeypatch.setattr(run_mod.tagworker, "map_concurrent", truncated_map)
    store = _FlushSpy(cos, {})
    s = run_monitor(store, _cfg(), fetch=_fetch_returns(jobs), today=TODAY,
                    session=object(), pusher=_Pusher(), fetch_workers=1)
    assert s.partial and s.boards_done == 2
    assert store.append_calls == 1                 # completed boards still flushed
    assert len(store.read_history()) == 2
    assert store.sweep_cursor == "Co2"             # first unfetched board
    assert store.health_rows == []                 # partial -> no health rewrite


def test_email_only_user_never_gets_a_phone_push():
    # dad's profile says notify_channel: email — the digest carries his
    # matches; an ntfy push would go to a topic he does not watch
    cos = [Company(name="Acme", ats="greenhouse", slug="a", monitor=True, seeded=True)]
    jobs = {"Acme": [Job("greenhouse", "1", "Acme", "Product Manager",
                         "Chicago, IL", "http://x")]}
    pusher = _Pusher()
    store = FakeSheetStore(cos, {})
    s = run_monitor(store, _cfg(), fetch=_fetch_returns(jobs),
                    tagger=lambda rec, slug: Tags(yoe="2+ years"),
                    today=TODAY, session=object(), pusher=pusher,
                    fetch_workers=1, push_channel="email")
    assert s.new_count == 1 and s.pushed == 0 and pusher.calls == []
