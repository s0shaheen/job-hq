import json
from pathlib import Path
from unittest.mock import MagicMock
from monitor.fetchers.smartrecruiters import parse, get_jobs

P1 = json.loads((Path(__file__).parent / "fixtures/smartrec_page1.json").read_text())
P2 = json.loads((Path(__file__).parent / "fixtures/smartrec_page2.json").read_text())


def test_parse_smartrec():
    jobs = parse(P1, company="Canva", slug="canva")
    j = jobs[0]
    assert j.ats == "smartrec"
    assert j.native_id == "sr-1"
    assert j.title == "Product Manager"
    assert j.location == "Sydney"
    assert j.url == "https://jobs.smartrecruiters.com/canva/sr-1"


def test_get_jobs_paginates_until_total():
    session = MagicMock()
    r1, r2 = MagicMock(), MagicMock()
    r1.json.return_value, r2.json.return_value = P1, P2
    r1.raise_for_status, r2.raise_for_status = (lambda: None), (lambda: None)
    session.get.side_effect = [r1, r2]
    jobs = get_jobs("canva", "Canva", session)
    assert [j.native_id for j in jobs] == ["sr-1", "sr-2", "sr-3"]
    assert session.get.call_count == 2
