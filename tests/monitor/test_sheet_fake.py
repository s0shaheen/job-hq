"""FakeSheetStore must mirror HQFeedStore's protocol semantics — run/review
logic tests lean on it, so drift here would make those tests lie."""
from monitor.models import Company, JobRecord
from monitor.sheet import FakeSheetStore
from monitor.tagging import Tags


def _rec(jid, status="New"):
    return JobRecord(id=jid, company="Acme", title="PM", location="NYC",
                     url="http://x", status=status, first_seen="2026-07-13",
                     last_seen="2026-07-13", posted="")


def _store_with(records, **kw):
    return FakeSheetStore([], {r.id: r for r in records}, **kw)


def test_read_companies_filters_monitor_false():
    store = FakeSheetStore(
        [Company("Stripe", "greenhouse", "stripe", monitor=True),
         Company("Old", "lever", "old", monitor=False, seeded=True)], {})
    assert [c.name for c in store.read_companies()] == ["Stripe"]


def test_append_and_read_history():
    store = FakeSheetStore([], {})
    store.append_jobs([_rec("greenhouse-1")])
    assert store.read_history()["greenhouse-1"].title == "PM"


def test_append_with_tags_stamps_tagged_at_and_min_yoe():
    store = FakeSheetStore([], {})
    store.append_jobs([_rec("greenhouse-1")],
                      tags={"greenhouse-1": Tags(yoe="3+")}, today="2026-07-13")
    assert store.tags_for("greenhouse-1").yoe == "3+"
    assert store.read_min_yoe()["greenhouse-1"] == "3"
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-1"] == "2026-07-13"


def test_set_status_and_last_seen():
    store = _store_with([_rec("greenhouse-1", status="Closed")])
    store.set_status({"greenhouse-1": "New"})
    store.set_last_seen(["greenhouse-1"], "2026-07-14")
    h = store.read_history()
    assert h["greenhouse-1"].status == "New"
    assert h["greenhouse-1"].last_seen == "2026-07-14"


def test_mark_seeded_and_mark_pushed():
    store = FakeSheetStore([Company("Stripe", "greenhouse", "stripe")], {})
    store.mark_seeded(["Stripe"])
    assert store.seeded_marks == ["Stripe"]
    assert store.read_companies()[0].seeded is True
    store.mark_pushed(["greenhouse-1"], "2026-07-13")
    store.mark_pushed(["greenhouse-1"], "2026-07-14")   # once only, like the sheet
    assert store.pushed_marks == ["greenhouse-1"]


def test_write_tags_records_tags_min_yoe_and_stamp():
    store = _store_with([_rec("greenhouse-1")])
    store.write_tags({"greenhouse-1": Tags(yoe="5+", seniority="Senior", skills="SQL; AB")},
                     "2026-07-13")
    tagged_at = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert tagged_at["greenhouse-1"] == "2026-07-13"
    assert store.tags_for("greenhouse-1").skills == "SQL; AB"
    assert store.read_min_yoe()["greenhouse-1"] == "5"


def test_read_jobs_for_tagging_blank_when_untagged():
    store = _store_with([_rec("greenhouse-1")])
    rec, tagged_at = store.read_jobs_for_tagging()[0]
    assert rec.id == "greenhouse-1" and tagged_at == ""


def test_seedable_min_yoe_for_reopened_roles():
    store = _store_with([_rec("greenhouse-1", status="Closed")],
                        min_yoe={"greenhouse-1": "2"})
    assert store.read_min_yoe() == {"greenhouse-1": "2"}
