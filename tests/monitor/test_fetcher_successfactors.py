from pathlib import Path

from core.jobkeys import job_key
from monitor.fetchers.successfactors import parse

FIX = (Path(__file__).parent / "fixtures/successfactors.html").read_text()
HOST = "jobs.grainger.com"


def test_parse_successfactors():
    jobs = parse(FIX, company="Grainger", host=HOST)
    assert len(jobs) == 3
    j = jobs[0]
    assert j.ats == "sfsf"
    assert j.native_id == "1344992400"
    assert j.id == "sfsf-1344992400"
    assert j.title == "Sr Product Manager"
    assert j.location == "CHICAGO, IL, US, 60654-4203"
    assert j.url == "https://jobs.grainger.com/job/CHICAGO-Sr-Product-Manager-IL-60654-4203/1344992400/"


def test_parse_dedups_mobile_and_desktop_tile_links():
    # each tile carries two jobTitle-links (hidden-phone + visible-phone) — one Job per tile
    jobs = parse(FIX, company="Grainger", host=HOST)
    assert [j.native_id for j in jobs] == ["1344992400", "1372668800", "1404125600"]


def test_parse_cleans_location_more_suffix_and_entities():
    jobs = parse(FIX, company="Grainger", host=HOST)
    assert jobs[1].location == "LAKE FOREST, IL, US, 60045-5202"   # " +1 more…" stripped
    assert jobs[2].title == "Warehouse Associate (Days)"


def test_sfsf_id_matches_jobkeys_for_gmail_autoadvance():
    # the fetcher contract (core/jobkeys docstring): Job.id MUST equal job_key(public url)
    for j in parse(FIX, company="Grainger", host=HOST):
        assert j.id == job_key(url=j.url)
