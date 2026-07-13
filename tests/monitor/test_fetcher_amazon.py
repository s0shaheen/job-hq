from unittest.mock import MagicMock

from core.jobkeys import job_key
from monitor.fetchers.amazon import DESCRIPTIONS, get_jobs, parse

PAGE1 = {"hits": 3, "jobs": [
    {"id_icims": "3200676", "title": "Senior Product Manager",
     "normalized_location": "Austin, Texas, USA",
     "job_path": "/en/jobs/3200676/senior-product-manager", "posted_date": "March 10, 2026",
     "description": "Own the roadmap for FBA capacity.",
     "basic_qualifications": "5+ years of product management",
     "preferred_qualifications": "MBA"},
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


def test_job_key_parity():
    for j in parse(PAGE1, company="Amazon") + parse(PAGE2, company="Amazon"):
        assert job_key(j.url) == j.id == f"amazon-{j.native_id}"


def test_parse_fills_descriptions_cache_from_search_json():
    DESCRIPTIONS.clear()
    parse(PAGE1, company="Amazon")
    jd = DESCRIPTIONS["3200676"]
    assert "Own the roadmap for FBA capacity." in jd
    assert "Basic qualifications:" in jd and "5+ years" in jd
    assert "Preferred qualifications:" in jd and "MBA" in jd
    # a job search.json returned without JD fields must not cache an empty JD
    assert "10415084" not in DESCRIPTIONS


def test_get_jobs_paginates_until_hits():
    session = MagicMock()
    r1, r2 = MagicMock(), MagicMock()
    r1.json.return_value, r2.json.return_value = PAGE1, PAGE2
    r1.raise_for_status = r2.raise_for_status = (lambda: None)
    session.get.side_effect = [r1, r2]
    jobs = get_jobs("amazon", "Amazon", session, search="product manager")
    assert [j.native_id for j in jobs] == ["3200676", "10415084", "3142769"]
    assert session.get.call_count == 2


def test_get_jobs_uses_result_limit_pagination_not_size_start():
    session = MagicMock()
    r1, r2 = MagicMock(), MagicMock()
    r1.json.return_value, r2.json.return_value = PAGE1, PAGE2
    r1.raise_for_status = r2.raise_for_status = (lambda: None)
    session.get.side_effect = [r1, r2]
    get_jobs("amazon", "Amazon", session, search="product manager")
    urls = [c[0][0] for c in session.get.call_args_list]
    assert "result_limit=100" in urls[0] and "offset=0" in urls[0]
    assert "offset=2" in urls[1]             # advanced by jobs actually returned
    for u in urls:                           # the old params are silently ignored
        assert "size=" not in u and "start=" not in u
