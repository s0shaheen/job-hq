import pytest
from unittest.mock import MagicMock

from core.jobkeys import job_key
from monitor.fetchers.radancy import get_jobs, parse, total_pages

RESULTS_HTML = """
<section id="search-results" data-total-pages="1" data-total-results="2">
<a href="/job/mountain-view/principal-product-manager/27595/85039348256">
  <h2>Principal Product Manager</h2>
  <span class="job-location">Mountain View, California</span>
</a>
<a href="/job/san-diego/senior-product-manager-ai/27595/85039349999">
  <h2>Senior Product Manager, AI</h2>
  <span class="job-location">San Diego, California</span>
</a>
</section>
"""
PAYLOAD = {"results": RESULTS_HTML, "hasJobs": True}


def test_parse_cards_out_of_results_html():
    jobs = parse(RESULTS_HTML, company="Intuit", host="jobs.intuit.com")
    j = jobs[0]
    assert j.ats == "radancy"
    assert j.native_id == "85039348256"      # trailing path segment, not site id 27595
    assert j.title == "Principal Product Manager"
    assert j.location == "Mountain View, California"
    assert j.url == ("https://jobs.intuit.com/job/mountain-view"
                     "/principal-product-manager/27595/85039348256")
    assert len(jobs) == 2


def test_total_pages_read_from_section_tag():
    assert total_pages(RESULTS_HTML) == 1
    assert total_pages("<div>no attr</div>") == 1


def test_get_jobs_single_page_and_module_name_param():
    session = MagicMock()
    resp = MagicMock()
    resp.json.return_value = PAYLOAD
    resp.raise_for_status = lambda: None
    session.get.return_value = resp
    jobs = get_jobs("jobs.intuit.com", "Intuit", session, search="product manager")
    assert len(jobs) == 2
    assert session.get.call_count == 1       # data-total-pages=1
    url = session.get.call_args[0][0]
    assert "Keywords=product+manager" in url
    # without this param the endpoint answers 200 with an empty results string
    assert "SearchResultsModuleName=Search+Results" in url


@pytest.mark.xfail(strict=False, reason=(
    "core/jobkeys.py has no radancy pattern yet — the fetcher's URLs are the "
    "canonical public ones, so parity needs the integrator to add "
    r'''("radancy", re.compile(r"jobs\.intuit\.com/job/(?:[^/]+/)+(\d{6,})(?:[/?#]|$)")) '''
    "to _PATTERNS (host-scoped to avoid false positives); this test starts "
    "passing the moment that lands"))
def test_job_key_parity():
    for j in parse(RESULTS_HTML, company="Intuit", host="jobs.intuit.com"):
        assert job_key(j.url) == j.id == f"radancy-{j.native_id}"
