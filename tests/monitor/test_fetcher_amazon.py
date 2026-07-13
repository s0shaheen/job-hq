from unittest.mock import MagicMock
from monitor.fetchers.amazon import parse, get_jobs

PAGE1 = {"hits": 3, "jobs": [
    {"id_icims": "3200676", "title": "Senior Product Manager",
     "normalized_location": "Austin, Texas, USA",
     "job_path": "/en/jobs/3200676/senior-product-manager", "posted_date": "March 10, 2026"},
    {"id_icims": "10415084", "title": "Product Manager, Ads",
     "normalized_location": "Seattle, WA",
     "job_path": "/en/jobs/10415084/pm-ads", "posted_date": "March 9, 2026"},
]}
PAGE2 = {"hits": 3, "jobs": [
    {"id_icims": "3142769", "title": "Principal Product Manager",
     "normalized_location": "Bengaluru, IND",
     "job_path": "/en/jobs/3142769/principal-pm", "posted_date": "March 8, 2026"},
]}


def test_parse_amazon():
    jobs = parse(PAGE1, company="Amazon")
    j = jobs[0]
    assert j.ats == "amazon"
    assert j.native_id == "3200676"
    assert j.title == "Senior Product Manager"
    assert j.location == "Austin, Texas, USA"
    assert j.url == "https://www.amazon.jobs/en/jobs/3200676/senior-product-manager"
    assert j.posted == "March 10, 2026"


def test_get_jobs_paginates_until_hits():
    session = MagicMock()
    r1, r2 = MagicMock(), MagicMock()
    r1.json.return_value, r2.json.return_value = PAGE1, PAGE2
    r1.raise_for_status = r2.raise_for_status = (lambda: None)
    session.get.side_effect = [r1, r2]
    jobs = get_jobs("amazon", "Amazon", session, search="product manager")
    assert [j.native_id for j in jobs] == ["3200676", "10415084", "3142769"]
    assert session.get.call_count == 2
