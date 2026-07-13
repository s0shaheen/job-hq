import json
from pathlib import Path
from unittest.mock import MagicMock
from monitor.fetchers.workday import parse, get_jobs

FIX = json.loads((Path(__file__).parent / "fixtures/workday.json").read_text())
SLUG = "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"


def test_parse_workday_builds_id_and_url():
    jobs = parse(FIX, company="Nvidia", slug=SLUG)
    j = jobs[0]
    assert j.ats == "workday"
    assert j.native_id == "JR2018040"
    assert j.title == "Principal Product Manager"
    assert j.location == "US, CA, Santa Clara"
    assert j.url == ("https://nvidia.wd5.myworkdayjobs.com/en-US/"
                     "NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Principal-PM_JR2018040")


def test_get_jobs_stops_when_total_reached():
    session = MagicMock()
    resp = MagicMock()
    resp.json.return_value = FIX
    resp.raise_for_status = lambda: None
    session.post.return_value = resp
    jobs = get_jobs(SLUG, "Nvidia", session, search="product")
    assert len(jobs) == 2
    assert session.post.call_count == 1  # total=2, one page of 20 covers it


def test_native_id_prefers_path_req_and_never_uses_location():
    from monitor.fetchers.workday import _native_id
    # normal tenant: req in path, bullet matches
    assert _native_id({"externalPath": "/job/Waltham-MA/PM_R168260", "bulletFields": ["R168260"]}) == "R168260"
    # variant suffix collapses to base req (parity with core.jobkeys)
    assert _native_id({"externalPath": "/job/San-Jose/PM_R168260-1", "bulletFields": ["R168260-1"]}) == "R168260"
    # BROKEN tenant: bullet is a location -> path token wins
    assert _native_id({"externalPath": "/job/x/PM_JR-4411", "bulletFields": ["Waltham, MA (MA54)"]}) == "JR-4411"
    # no req anywhere: unique path beats colliding location bullet
    assert _native_id({"externalPath": "/job/loc/Some-Job_ABC", "bulletFields": ["Waltham, MA (MA54)"]}) == "/job/loc/Some-Job_ABC"
    # Visa-style REF ids
    assert _native_id({"externalPath": "/job/Austin/PM_REF085011W", "bulletFields": [""]}) == "REF085011W"


def test_parse_job_key_parity():
    from core.jobkeys import job_key
    from monitor.fetchers.workday import parse
    payload = {"jobPostings": [{"title": "PM", "externalPath": "/job/SJ/PM_R168260-1",
                                "bulletFields": ["Waltham, MA (MA54)"], "locationsText": "SJ",
                                "postedOn": "Posted Today"}]}
    (job,) = parse(payload, "Adobe", "adobe.wd5.myworkdayjobs.com/external_experienced")
    assert f"{job.ats}-{job.native_id}" == job_key(job.url) == "workday-R168260"
