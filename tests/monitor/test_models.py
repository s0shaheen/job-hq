from monitor.models import Company, Job


def test_job_id_combines_ats_and_native_id():
    job = Job(ats="greenhouse", native_id="123", company="Stripe",
              title="PM", location="NYC", url="http://x", posted="2026-05-01")
    assert job.id == "greenhouse-123"


def test_job_to_record_sets_dates_and_status():
    job = Job(ats="ashby", native_id="abc", company="Ramp",
              title="Sr PM", location="NY", url="http://y", posted="2026-05-20")
    rec = job.to_record(status="New", today="2026-07-13")
    assert rec.id == "ashby-abc"
    assert rec.status == "New"
    assert rec.first_seen == "2026-07-13"
    assert rec.last_seen == "2026-07-13"
    assert rec.company == "Ramp"


def test_company_priority_defaults_false():
    c = Company("Stripe", "greenhouse", "stripe")
    assert c.priority is False
    assert Company("Plaid", "lever", "plaid", priority=True).priority is True
