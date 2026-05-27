from src.models import Company, JobRecord
from src.sheet import FakeSheetStore


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
