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
