from monitor.models import Company, JobRecord
from monitor.sheet import FakeSheetStore, TAG_COLUMNS, JOBS_HEADER
from monitor.tagging import Tags


def test_fake_read_companies_filters_monitor_false():
    store = FakeSheetStore(
        companies=[
            Company("Stripe", "greenhouse", "stripe", monitor=True, seeded=False),
            Company("Old", "lever", "old", monitor=False, seeded=True),
        ],
        history={}, contacts_by_company={},
    )
    active = store.read_companies()
    assert [c.name for c in active] == ["Stripe"]


def test_fake_append_and_read_history():
    store = FakeSheetStore(companies=[], history={}, contacts_by_company={})
    rec = JobRecord("greenhouse-1", "Stripe", "PM", "NYC", "http://x", "New", "2026-05-26", "2026-05-26")
    store.append_jobs([rec])
    assert store.read_history()["greenhouse-1"].title == "PM"


def test_fake_set_status_and_last_seen():
    rec = JobRecord("greenhouse-1", "Stripe", "PM", "NYC", "http://x", "Closed", "2026-01-01", "2026-01-01")
    store = FakeSheetStore(companies=[], history={"greenhouse-1": rec}, contacts_by_company={})
    store.set_status({"greenhouse-1": "New"})
    store.set_last_seen(["greenhouse-1"], "2026-05-26")
    h = store.read_history()
    assert h["greenhouse-1"].status == "New"
    assert h["greenhouse-1"].last_seen == "2026-05-26"


def test_fake_contact_count():
    store = FakeSheetStore(companies=[], history={}, contacts_by_company={"ramp": 2})
    assert store.contact_count("Ramp") == 2
    assert store.contact_count("Unknown") == 0


def _store_with(records):
    history = {r.id: r for r in records}
    return FakeSheetStore([], history, {})


def test_jobs_header_ends_with_tag_columns():
    assert JOBS_HEADER[-len(TAG_COLUMNS):] == TAG_COLUMNS
    assert TAG_COLUMNS == ["yoe", "seniority", "company_industry", "role_focus",
                           "skills", "comp_range", "work_model", "tagged_at"]


def _rec(jid, status="New"):
    return JobRecord(id=jid, company="Acme", title="PM", location="NYC",
                     url="http://x", status=status, first_seen="2026-05-27",
                     last_seen="2026-05-27", posted="")


def test_read_jobs_for_tagging_returns_record_and_blank_tagged_at():
    store = _store_with([_rec("greenhouse-1")])
    rows = store.read_jobs_for_tagging()
    assert len(rows) == 1
    rec, tagged_at = rows[0]
    assert rec.id == "greenhouse-1"
    assert tagged_at == ""


def test_write_tags_records_tags_and_stamps_tagged_at():
    store = _store_with([_rec("greenhouse-1")])
    store.write_tags({"greenhouse-1": Tags(yoe="5+", seniority="Senior", skills="SQL; AB")}, "2026-05-27")
    rows = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert rows["greenhouse-1"] == "2026-05-27"
    assert store.tags_for("greenhouse-1").yoe == "5+"
    assert store.tags_for("greenhouse-1").skills == "SQL; AB"
