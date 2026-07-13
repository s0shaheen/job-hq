import json
from pathlib import Path
from monitor.fetchers.ashby import parse

FIX = json.loads((Path(__file__).parent / "fixtures/ashby.json").read_text())


def test_parse_ashby():
    jobs = parse(FIX, company="Ramp")
    assert len(jobs) == 2
    j = jobs[0]
    assert j.ats == "ashby"
    assert j.native_id == "uuid-aaa"
    assert j.title == "Product Manager"
    assert j.location == "San Francisco"
    assert j.url == "https://jobs.ashbyhq.com/ramp/uuid-aaa"
    assert j.posted == "2026-05-22"
