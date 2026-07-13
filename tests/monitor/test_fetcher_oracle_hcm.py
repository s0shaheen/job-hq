from unittest.mock import MagicMock

from core.jobkeys import job_key
from monitor.fetchers.oracle_hcm import get_jobs, parse

SLUG = "eeho.fa.us2.oraclecloud.com|CX_45001"

FIX = {"items": [{"TotalJobsCount": 2, "requisitionList": [
    {"Id": "337997", "Title": "Principal Product Manager",
     "PostedDate": "2026-07-01", "PrimaryLocation": "United States"},
    {"Id": "301496", "Title": "Senior Product Manager, OCI",
     "PostedDate": "2026-06-20", "PrimaryLocation": "Austin, TX, United States"},
]}]}


def test_parse_builds_candidate_experience_url():
    jobs = parse(FIX, company="Oracle", slug=SLUG)
    j = jobs[0]
    assert j.ats == "oraclehcm"
    assert j.native_id == "337997"
    assert j.title == "Principal Product Manager"
    assert j.location == "United States"
    assert j.url == ("https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience"
                     "/en/sites/CX_45001/job/337997")
    assert j.posted == "2026-07-01"


def test_parse_empty_payload():
    assert parse({}, company="Oracle", slug=SLUG) == []
    assert parse({"items": []}, company="Oracle", slug=SLUG) == []


def test_job_key_parity():
    for j in parse(FIX, company="Oracle", slug=SLUG):
        assert job_key(j.url) == j.id == f"oraclehcm-{j.native_id}"


def test_get_jobs_stops_at_total_and_builds_raw_finder():
    session = MagicMock()
    resp = MagicMock()
    resp.json.return_value = FIX
    resp.raise_for_status = lambda: None
    session.get.return_value = resp
    jobs = get_jobs(SLUG, "Oracle", session, search="product manager")
    assert len(jobs) == 2
    assert session.get.call_count == 1   # TotalJobsCount=2, one page covers it
    url = session.get.call_args[0][0]
    # the finder's ; and , separators must stay unencoded, keyword %22-quoted
    assert "finder=findReqs;siteNumber=CX_45001,keyword=%22product%20manager%22" in url
    assert "expand=requisitionList.secondaryLocations" in url
