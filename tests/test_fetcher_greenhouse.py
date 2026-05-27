import json
from pathlib import Path
from src.fetchers.greenhouse import parse

FIX = json.loads((Path(__file__).parent / "fixtures/greenhouse.json").read_text())


def test_parse_greenhouse():
    jobs = parse(FIX, company="Stripe")
    assert len(jobs) == 2
    j = jobs[0]
    assert j.ats == "greenhouse"
    assert j.native_id == "401"
    assert j.title == "Senior Product Manager"
    assert j.location == "New York"
    assert j.url == "https://boards.greenhouse.io/stripe/jobs/401"
    assert j.posted == "2026-05-20T10:00:00-04:00"
