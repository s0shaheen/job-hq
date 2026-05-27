from src.models import Job, JobRecord
from src.dedup import reconcile_company

TODAY = "2026-05-26"


def _job(nid, title="PM"):
    return Job(ats="greenhouse", native_id=nid, company="Stripe",
               title=title, location="NYC", url="http://x", posted="")


def _rec(nid, status, last_seen):
    return JobRecord(id=f"greenhouse-{nid}", company="Stripe", title="PM",
                     location="NYC", url="http://x", status=status,
                     first_seen="2026-01-01", last_seen=last_seen)


def test_unseeded_company_seeds_all_without_new():
    r = reconcile_company({}, [_job("1"), _job("2")], seeded=False, today=TODAY, stale_days=14)
    assert {rec.id for rec in r.seed_records} == {"greenhouse-1", "greenhouse-2"}
    assert all(rec.status == "Seen" for rec in r.seed_records)
    assert r.new_records == []


def test_seeded_brand_new_job_is_new():
    r = reconcile_company({}, [_job("9")], seeded=True, today=TODAY, stale_days=14)
    assert [rec.id for rec in r.new_records] == ["greenhouse-9"]


def test_seeded_existing_new_job_seen_again_is_touched_only():
    history = {"greenhouse-1": _rec("1", "New", "2026-05-20")}
    r = reconcile_company(history, [_job("1")], seeded=True, today=TODAY, stale_days=14)
    assert r.new_records == []
    assert r.touched_ids == ["greenhouse-1"]


def test_closed_job_reappears_is_reopened():
    history = {"greenhouse-1": _rec("1", "Closed", "2026-04-01")}
    r = reconcile_company(history, [_job("1")], seeded=True, today=TODAY, stale_days=14)
    assert r.reopened_ids == ["greenhouse-1"]
    assert r.new_records == []


def test_user_status_job_missing_and_stale_is_not_closed():
    history = {"greenhouse-1": _rec("1", "Applied", "2026-01-01")}
    r = reconcile_company(history, [], seeded=True, today=TODAY, stale_days=14)
    assert r.closed_ids == []


def test_new_job_missing_and_stale_is_closed():
    history = {"greenhouse-1": _rec("1", "New", "2026-05-01")}  # 25 days ago
    r = reconcile_company(history, [], seeded=True, today=TODAY, stale_days=14)
    assert r.closed_ids == ["greenhouse-1"]


def test_new_job_missing_but_not_yet_stale_is_left_alone():
    history = {"greenhouse-1": _rec("1", "New", "2026-05-20")}  # 6 days ago
    r = reconcile_company(history, [], seeded=True, today=TODAY, stale_days=14)
    assert r.closed_ids == []
    assert r.touched_ids == []
