from unittest.mock import MagicMock

from core.jobkeys import job_key
from monitor.fetchers.eightfold import get_jobs, parse_pcsx, parse_smartapply

# SmartApply shape (Netflix tenant, verified 2026-07-13)
SMARTAPPLY = {"count": 2, "positions": [
    {"id": 790298012207, "name": "Product Manager, Ads Platform",
     "location": "Los Gatos, California",
     "locations": ["Los Gatos, California", "Remote"],
     "department": "Product", "t_update": 1752105600,
     "canonicalPositionUrl": "https://explore.jobs.netflix.net/careers/job/790298012207"},
    {"id": 790298099999, "name": "Senior Product Manager", "location": "",
     "locations": ["Remote, USA", "New York, NY"], "t_update": 1752105600000,
     "canonicalPositionUrl": "https://explore.jobs.netflix.net/careers/job/790298099999"},
]}

# PCSX shape (Microsoft/PayPal tenants, verified 2026-07-13). count=1 so the
# get_jobs fallback test finishes in one PCSX page.
PCSX = {"status": 200, "data": {"count": 1, "positions": [
    {"id": 1868732000001, "name": "Principal Product Manager",
     "atsJobId": "1868732", "displayJobId": "1868732",
     "locations": ["Redmond, Washington, United States"],
     "postedTs": 1752105600, "positionUrl": "/careers/job/1868732000001",
     "department": "Product Management", "workLocationOption": "hybrid"},
]}}


def test_parse_smartapply_uses_canonical_url():
    jobs = parse_smartapply(SMARTAPPLY, "Netflix", "explore.jobs.netflix.net", "netflix.com")
    j = jobs[0]
    assert j.ats == "eightfold"
    assert j.native_id == "790298012207"
    assert j.title == "Product Manager, Ads Platform"
    assert j.location == "Los Gatos, California"
    assert j.url == "https://explore.jobs.netflix.net/careers/job/790298012207"
    assert j.posted == "2025-07-10"


def test_parse_smartapply_locations_fallback_and_ms_timestamps():
    j = parse_smartapply(SMARTAPPLY, "Netflix", "explore.jobs.netflix.net", "netflix.com")[1]
    assert j.location == "Remote, USA (+1 more)"
    assert j.posted == "2025-07-10"   # milliseconds normalized


def test_parse_pcsx_custom_domain_falls_back_to_pid_deeplink():
    # apply.careers.microsoft.com/careers/job/{id} has no jobkeys pattern;
    # the ?pid= deep link does — posting_url must pick it.
    jobs = parse_pcsx(PCSX, "Microsoft", "apply.careers.microsoft.com", "microsoft.com")
    j = jobs[0]
    assert j.native_id == "1868732000001"
    assert j.url == ("https://apply.careers.microsoft.com/careers"
                     "?pid=1868732000001&domain=microsoft.com")
    assert j.location == "Redmond, Washington, United States"
    assert j.posted == "2025-07-10"


def test_job_key_parity_both_variants():
    both = (parse_smartapply(SMARTAPPLY, "Netflix", "explore.jobs.netflix.net", "netflix.com")
            + parse_pcsx(PCSX, "Microsoft", "apply.careers.microsoft.com", "microsoft.com"))
    for j in both:
        assert job_key(j.url) == j.id == f"eightfold-{j.native_id}"


def test_get_jobs_smartapply_single_page():
    session = MagicMock()
    resp = MagicMock(status_code=200)
    resp.json.return_value = SMARTAPPLY
    resp.raise_for_status = lambda: None
    session.get.return_value = resp
    jobs = get_jobs("explore.jobs.netflix.net|netflix.com", "Netflix", session,
                    search="product manager")
    assert [j.native_id for j in jobs] == ["790298012207", "790298099999"]
    assert session.get.call_count == 1
    assert "/api/apply/v2/jobs?domain=netflix.com" in session.get.call_args[0][0]


def test_get_jobs_falls_back_to_pcsx_on_403_denial():
    session = MagicMock()
    denied = MagicMock(status_code=403, text='{"message": "Not authorized for PCSX"}')
    denied.raise_for_status.side_effect = AssertionError("denial must branch, not raise")
    pcsx = MagicMock(status_code=200)
    pcsx.json.return_value = PCSX
    pcsx.raise_for_status = lambda: None
    session.get.side_effect = [denied, pcsx]
    jobs = get_jobs("apply.careers.microsoft.com|microsoft.com", "Microsoft", session)
    assert [j.id for j in jobs] == ["eightfold-1868732000001"]
    urls = [c[0][0] for c in session.get.call_args_list]
    assert "/api/apply/v2/jobs" in urls[0]
    assert "/api/pcsx/search" in urls[1]
