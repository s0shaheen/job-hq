import pytest

from monitor.config import RuntimeConfig
from monitor.models import Company, Job, JobRecord
from monitor.run import RunSummary, run_monitor
from monitor.sheet import FakeSheetStore
from monitor.tagging import Tags

TODAY = "2026-07-13"

CFG = RuntimeConfig(include=["product manager"], exclude=["engineer"],
                    workday_search="product", yoe_push_max=4,
                    push_new_jobs=True, push_status_events=True)


def _job(nid, title="Product Manager", company="Stripe"):
    return Job("greenhouse", nid, company, title, "NYC", f"http://x/{nid}")


def _fetch_returns(mapping):
    def fake(ats, slug, company, session, workday_search="product"):
        return mapping.get(company, [])
    return fake


def _tagger_returns(yoe_by_id):
    """id -> yoe string; missing id -> Tags with blank yoe (min_yoe='')."""
    def tag(rec, slug):
        return Tags(yoe=yoe_by_id.get(rec.id, ""), comp_range="$150k")
    return tag


class _Pusher:
    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    def __call__(self, title, body, **kw):
        self.calls.append((title, body, kw))
        return self.ok


def _run(store, *, fetch, tagger=None, pusher=None, cfg=CFG, cap=None):
    return run_monitor(store, cfg, fetch=fetch, tagger=tagger, today=TODAY,
                       session=object(), pusher=pusher or _Pusher(),
                       inline_tag_max=60 if cap is None else cap)


# ---- reconcile semantics preserved from the old monitor

def test_first_run_seeds_without_pushing():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=False)], {})
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher)
    assert summary.new_count == 0                    # seeded silently
    assert store.read_history()["greenhouse-1"].status == "Seen"
    assert store.seeded_marks == ["Stripe"]
    assert pusher.calls == []


def test_second_run_surfaces_new_job_and_filters_titles():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    jobs = [_job("9", "Senior Product Manager"), _job("10", "Staff Engineer")]
    summary = _run(store, fetch=_fetch_returns({"Stripe": jobs}),
                   tagger=_tagger_returns({"greenhouse-9": "3+"}))
    assert summary.new_count == 1
    assert "greenhouse-9" in store.read_history()
    assert "greenhouse-10" not in store.read_history()


def test_zero_new_is_quiet_no_heartbeat_push():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": []}), pusher=pusher)
    assert summary.new_count == 0
    assert pusher.calls == []                        # digest/heartbeats replace ntfy noise


def test_fetch_error_quarantined_to_health_and_run_continues():
    def boom(ats, slug, company, session, workday_search="product"):
        if company == "Bad":
            raise RuntimeError("404")
        return [_job("1", company="Good")]
    store = FakeSheetStore([Company("Bad", "greenhouse", "bad", seeded=True),
                            Company("Good", "greenhouse", "good", seeded=True)], {})
    summary = _run(store, fetch=boom, tagger=_tagger_returns({}))
    assert summary.errored == 1 and summary.error_companies == ["Bad"]
    assert any(r["result"] == "ERROR" for r in store.health_rows)
    assert "greenhouse-1" in store.read_history()    # Good still processed


def test_closed_job_reappearing_reopens_and_surfaces():
    rec = JobRecord("greenhouse-1", "Stripe", "Product Manager", "NYC",
                    "http://x/1", "Closed", "2026-01-01", "2026-06-01")
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)],
                           {"greenhouse-1": rec}, min_yoe={"greenhouse-1": "2"})
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher)
    assert summary.new_count == 1
    assert store.read_history()["greenhouse-1"].status == "New"
    assert len(pusher.calls) == 1                    # reopened role reaches the push
    assert summary.pushed == 1                       # stored min_yoe=2 clears the bar


def test_stale_missing_job_closed():
    rec = JobRecord("greenhouse-1", "Stripe", "Product Manager", "NYC",
                    "http://x/1", "New", "2026-06-01", "2026-06-01")   # 42 days silent
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)],
                           {"greenhouse-1": rec})
    _run(store, fetch=_fetch_returns({"Stripe": []}))
    assert store.read_history()["greenhouse-1"].status == "Closed"


# ---- inline tagging

def test_inline_tag_cap_limits_attempts():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    jobs = [_job(str(i)) for i in range(5)]
    attempts = []

    def tagger(rec, slug):
        attempts.append(rec.id)
        return Tags(yoe="3+")

    summary = _run(store, fetch=_fetch_returns({"Stripe": jobs}), tagger=tagger, cap=2)
    assert len(attempts) == 2
    assert summary.tagged == 2
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert sum(1 for t in tagged_at.values() if t) == 2   # overflow left for review.py


def test_no_tagger_appends_untagged():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), tagger=None)
    assert summary.tagged == 0
    assert store.tags_for("greenhouse-1") is None
    assert "greenhouse-1" in store.read_history()


def test_tag_failure_is_isolated_job_still_appended():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})

    def tagger(rec, slug):
        raise RuntimeError("LLM down")

    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), tagger=tagger)
    assert summary.tag_failed == 1
    assert "greenhouse-1" in store.read_history()    # append never blocked by tagging


def test_seeds_are_never_inline_tagged():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=False)], {})
    attempts = []

    def tagger(rec, slug):
        attempts.append(rec.id)
        return Tags(yoe="3+")

    _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), tagger=tagger)
    assert attempts == []                            # seed run burns zero LLM calls


# ---- YoE push policy

def test_push_lists_only_roles_within_yoe_bar_and_counts_rest():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    jobs = [_job("1", "Product Manager, Payments"),
            _job("2", "Principal Product Manager"),
            _job("3", "Product Manager, Growth")]
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": jobs}), pusher=pusher,
                   tagger=_tagger_returns({"greenhouse-1": "3+",
                                           "greenhouse-2": "8+"}))  # 3 untagged -> ""
    assert len(pusher.calls) == 1
    title, body, kw = pusher.calls[0]
    assert "1 new role" in title
    assert "Product Manager, Payments" in body and "Stripe" in body
    assert "$150k" in body                           # comp shown when known
    assert "Principal" not in body                   # 8+ filtered out
    assert "2 more in Feed" in body
    assert kw["click"] == "http://x/1"
    assert summary.pushed == 1
    assert store.pushed_marks == ["greenhouse-1"]


def test_no_push_when_nothing_clears_the_bar():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher()
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher,
                   tagger=_tagger_returns({"greenhouse-1": "8+"}))
    assert pusher.calls == []
    assert summary.pushed == 0 and summary.new_count == 1


def test_untagged_roles_are_never_pushed():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher()
    _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher,
         tagger=None)                                # no min_yoe -> not pushable
    assert pusher.calls == []


def test_push_toggle_off_silences_pushes():
    cfg = RuntimeConfig(include=["product manager"], exclude=[], push_new_jobs=False)
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher()
    _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher,
         tagger=_tagger_returns({"greenhouse-1": "0-2"}), cfg=cfg)
    assert pusher.calls == []


def test_failed_push_does_not_mark_pushed():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe", seeded=True)], {})
    pusher = _Pusher(ok=False)                       # topic unset / send failed
    summary = _run(store, fetch=_fetch_returns({"Stripe": [_job("1")]}), pusher=pusher,
                   tagger=_tagger_returns({"greenhouse-1": "3+"}))
    assert len(pusher.calls) == 1
    assert store.pushed_marks == [] and summary.pushed == 0


# ---- main() wiring: config problems -> ops push; heartbeat at end

def test_main_pushes_config_problems_to_ops_and_heartbeats(monkeypatch, tmp_path):
    from core.fakes import fake_hq
    from core.sheets import HQ
    import core.notify
    import monitor.run as run_mod

    hq = fake_hq()
    hq.tab("config").append_records([{"key": "yoe_push_max", "value": "banana"}])
    monkeypatch.setattr(HQ, "open", classmethod(lambda cls: hq))
    monkeypatch.setenv("HQ_SHEET_ID", "test-sheet")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(run_mod, "snapshot_path", lambda user="": str(tmp_path / "hq.json"))
    ops, pushes = [], []
    monkeypatch.setattr(core.notify, "ops_alert",
                        lambda title, body, session=None: ops.append((title, body)))
    monkeypatch.setattr(core.notify, "push",
                        lambda *a, **k: pushes.append(a) or True)

    assert run_mod.main() == 0
    assert ops and "yoe_push_max" in ops[0][1]
    beat = [r for r in hq.tab("config").records() if r["key"] == "heartbeat_monitor"]
    assert beat and beat[0]["value"] != ""
    assert (tmp_path / "hq.json").exists()


def test_main_unconfigured_gives_actionable_message(monkeypatch, capsys):
    import monitor.run as run_mod
    monkeypatch.setattr("core.config.sheet_id", lambda: "")   # nothing pinned anywhere
    assert run_mod.main() == 1
    assert "bootstrap" in capsys.readouterr().err
