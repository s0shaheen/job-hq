import pytest
from unittest.mock import MagicMock

from core.jobkeys import job_key
from monitor.fetchers.goldman import get_jobs, parse

PAYLOAD = {"data": {"roleSearch": {"totalCount": 2, "items": [
    {"roleId": "168945_GS_MID_CAREER", "jobTitle": "Vice President, Product Manager",
     "division": "Platform Solutions",
     "locations": [{"city": "Dallas", "country": "United States"},
                   {"city": "New York", "country": "United States"}],
     "externalSource": {"sourceId": "168945"}},
    {"roleId": "171203_GS_MID_CAREER", "jobTitle": "Product Manager, Transaction Banking",
     "division": "Engineering",
     "locations": [{"city": "London", "country": "United Kingdom"}],
     "externalSource": None},
]}}}


def test_parse_prefers_external_source_id():
    jobs = parse(PAYLOAD, company="Goldman Sachs")
    j = jobs[0]
    assert j.ats == "goldman"
    assert j.native_id == "168945"           # externalSource.sourceId
    assert j.title == "Vice President, Product Manager"
    assert j.location == "Dallas, United States (+1 more)"
    assert j.url == "https://higher.gs.com/roles/168945"


def test_parse_falls_back_to_role_id_digit_prefix():
    j = parse(PAYLOAD, company="Goldman Sachs")[1]
    assert j.native_id == "171203"           # digits of roleId when sourceId absent
    assert j.location == "London, United Kingdom"


def test_get_jobs_stops_at_total_and_sends_origin():
    session = MagicMock()
    resp = MagicMock()
    resp.json.return_value = PAYLOAD
    resp.raise_for_status = lambda: None
    session.post.return_value = resp
    jobs = get_jobs("goldman", "Goldman Sachs", session, search="product manager")
    assert len(jobs) == 2
    assert session.post.call_count == 1      # totalCount=2 reached on page 0
    kw = session.post.call_args.kwargs
    assert kw["headers"]["Origin"] == "https://higher.gs.com"
    body = kw["json"]
    assert body["operationName"] == "GetRoles"
    assert body["variables"]["searchQueryInput"]["searchTerm"] == "product manager"


@pytest.mark.xfail(strict=False, reason=(
    "core/jobkeys.py has no goldman pattern yet — the fetcher's URLs are the "
    "canonical public ones, so parity needs the integrator to add "
    r"""("goldman", re.compile(r"higher\.gs\.com/roles/(\d+)")) to _PATTERNS; """
    "this test starts passing the moment that lands"))
def test_job_key_parity():
    for j in parse(PAYLOAD, company="Goldman Sachs"):
        assert job_key(j.url) == j.id == f"goldman-{j.native_id}"
