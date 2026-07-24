import json
from pathlib import Path

from core.jobkeys import job_key
from monitor.fetchers.icims import _native_id, parse

FIX = json.loads((Path(__file__).parent / "fixtures/icims.json").read_text())


def test_parse_icims():
    jobs = parse(FIX, company="Exelon")
    assert len(jobs) == 3
    j = jobs[0]
    assert j.ats == "icims"
    assert j.native_id == "comed-29866"                 # from apply_url, not the bare slug
    assert j.id == "icims-comed-29866"
    assert j.title == "Senior Recruiter"
    assert j.location == "OAKBROOK TERRACE, Illinois"
    assert j.url == "https://careers-comed.icims.com/jobs/29866"   # /login stripped
    assert j.posted == "2026-07-23T19:16:00+0000"


def test_parse_icims_native_id_varies_by_sibling_tenant():
    # One Exelon board spans multiple iCIMS tenants (comed/peco/exeloncorp) that reuse
    # slug numbers; keying off apply_url keeps them distinct.
    jobs = parse(FIX, company="Exelon")
    assert [j.native_id for j in jobs] == ["comed-29866", "peco-29504", "exeloncorp-29955"]


def test_icims_id_matches_jobkeys_for_gmail_autoadvance():
    # The adapter's Job.id must equal what core.jobkeys derives from the same iCIMS URL,
    # or an ATS confirmation email would never match the adapter-discovered Pipeline row.
    jobs = parse(FIX, company="Exelon")
    assert jobs[0].id == job_key(url="https://careers-comed.icims.com/jobs/29866/login")


def test_native_id_falls_back_to_slug_when_apply_url_is_not_classic():
    assert _native_id({"apply_url": "https://x.jibeapply.com/apply/42", "slug": "42"}) == "42"
    assert _native_id({"slug": "77", "req_id": "R77"}) == "77"
    assert _native_id({}) == ""


def test_parse_skips_jobs_with_no_id():
    assert parse({"jobs": [{"data": {}}]}, company="X") == []
