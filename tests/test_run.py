from src.models import Company, JobRecord, Profile
from src.sheet import FakeSheetStore
from src.run import run_profile

PROFILE = Profile(name="pm", sheet_id="S", ntfy_topic="t",
                  include=["product manager"], exclude=["engineer"])


def _profile_store(companies, history, contacts=None):
    return FakeSheetStore(companies, history, contacts or {})


def _fetch_returns(mapping):
    # mapping: company name -> list[Job]
    def fake(ats, slug, company, session, workday_search="product"):
        return mapping.get(company, [])
    return fake


def test_first_run_seeds_without_notifying():
    from src.models import Job
    store = _profile_store(
        [Company("Stripe", "greenhouse", "stripe", monitor=True, seeded=False)], {})
    jobs = [Job("greenhouse", "1", "Stripe", "Product Manager", "NYC", "http://x")]
    pushed = []
    summary = run_profile(
        PROFILE, store, fetch=_fetch_returns({"Stripe": jobs}),
        today="2026-05-26", notifier=lambda *a, **k: pushed.append(a),
        heartbeater=lambda *a, **k: None)
    assert summary.new_count == 0          # seeded silently
    assert "greenhouse-1" in store.read_history()
    assert store.read_history()["greenhouse-1"].status == "Seen"
    assert "Stripe" in store.seeded_marks
    assert pushed == []                    # no new-jobs push on seed run


def test_second_run_surfaces_new_job_and_filters_non_pm():
    from src.models import Job
    store = _profile_store(
        [Company("Stripe", "greenhouse", "stripe", monitor=True, seeded=True)], {})
    jobs = [
        Job("greenhouse", "9", "Stripe", "Senior Product Manager", "NYC", "http://9"),
        Job("greenhouse", "10", "Stripe", "Staff Engineer", "NYC", "http://10"),  # filtered out
    ]
    pushed = []
    summary = run_profile(
        PROFILE, store, fetch=_fetch_returns({"Stripe": jobs}),
        today="2026-05-26", notifier=lambda *a, **k: pushed.append(a))
    assert summary.new_count == 1
    assert "greenhouse-9" in store.read_history()
    assert "greenhouse-10" not in store.read_history()
    assert len(pushed) == 1                # new-jobs push fired


def test_zero_new_sends_heartbeat_not_silence():
    store = _profile_store(
        [Company("Stripe", "greenhouse", "stripe", monitor=True, seeded=True)], {})
    beats = []
    run_profile(PROFILE, store, fetch=_fetch_returns({"Stripe": []}),
                today="2026-05-26", notifier=lambda *a, **k: None,
                heartbeater=lambda *a, **k: beats.append(a))
    assert len(beats) == 1


def test_fetch_error_recorded_to_health_and_continues():
    def boom(ats, slug, company, session, workday_search="product"):
        raise RuntimeError("404")
    store = _profile_store(
        [Company("Bad", "greenhouse", "bad", monitor=True, seeded=True)], {})
    summary = run_profile(PROFILE, store, fetch=boom, today="2026-05-26",
                          notifier=lambda *a, **k: None, heartbeater=lambda *a, **k: None)
    assert summary.errored == 1
    assert any(row[2] == "ERROR" for row in store.health_rows)
