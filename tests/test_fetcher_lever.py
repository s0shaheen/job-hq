import json
from pathlib import Path
from src.fetchers.lever import parse

FIX = json.loads((Path(__file__).parent / "fixtures/lever.json").read_text())


def test_parse_lever():
    jobs = parse(FIX, company="Spotify")
    assert len(jobs) == 2
    j = jobs[0]
    assert j.ats == "lever"
    assert j.native_id == "lev-1"
    assert j.title == "Group Product Manager"
    assert j.location == "New York"
    assert j.url == "https://jobs.lever.co/spotify/lev-1"
