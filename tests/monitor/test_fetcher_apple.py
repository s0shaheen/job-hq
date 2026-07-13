from unittest.mock import MagicMock

from core.jobkeys import job_key
from monitor.fetchers.apple import get_jobs, parse

# Live card anatomy of 2026-07-13: ids carry a -variant suffix, every row
# token is the constant "1", and each card repeats its link as a trailing
# "See full role description" anchor.
HTML = """
<h3><a class="link-inline t-intro" aria-label="Manager, AirPods Product Management 200670580"
   href="/en-us/details/200670580-0836/manager-airpods-product-management?team=MKTG"
   data-discover="true">Manager, AirPods Product Management</a></h3>
<span id="search-Marketing-1" class="team-name mt-0">Marketing</span>
<span class="job-posted-date" id="search-job-posted-date-1">Jul 08, 2026</span>
<div id="search-location-search-job-title-200670580-0836-1" class="job-title-location">
  <span class="a11y">Location</span><span id="search-store-name-container-1">Cupertino</span>
</div>
<a class="link more" href="/en-us/details/200670580-0836/manager-airpods-product-management?team=MKTG">See full role description</a>
<h3><a href="/en-us/details/200660667-0351/ai-product-manager?team=SLDEV">AI Product Manager</a></h3>
<span class="job-posted-date" id="search-job-posted-date-1">Jul 07, 2026</span>
<div id="search-location-search-job-title-200660667-0351-1">
  <span class="a11y">Location</span><span id="search-store-name-container-1">Austin</span>
</div>
<a href="/en-us/details/200660667-0351/ai-product-manager?team=SLDEV">See full role description</a>
"""

# The pre-2026 markup (PIPE- ids, per-row numbering, no store-name span) —
# the fallback path must still read it.
OLD_HTML = """
<a href="/en-us/details/200612639/senior-product-manager-services?team=MKTG">Senior Product Manager, Services</a>
<span class="job-posted-date" id="search-job-posted-date-0">Jul 10, 2026</span>
<div id="search-location-search-job-title-PIPE-200612639-0">
  <span class="a11y">Location</span>Cupertino
</div>
"""


def test_parse_cards_by_document_order():
    jobs = parse(HTML, company="Apple")
    assert len(jobs) == 2                    # see-full anchors don't duplicate
    j = jobs[0]
    assert j.ats == "apple"
    assert j.native_id == "200670580"        # requisition digits, variant dropped
    assert j.title == "Manager, AirPods Product Management"
    assert j.location == "Cupertino"
    assert j.posted == "Jul 08, 2026"
    # digits-only public URL (variant pages resolve to the same requisition)
    assert j.url == ("https://jobs.apple.com/en-us/details/200670580"
                     "/manager-airpods-product-management")
    assert jobs[1].native_id == "200660667"
    assert jobs[1].location == "Austin"
    assert jobs[1].posted == "Jul 07, 2026"  # order-joined despite identical ids


def test_parse_older_markup_fallback():
    j = parse(OLD_HTML, company="Apple")[0]
    assert j.native_id == "200612639"
    assert j.location == "Cupertino"         # a11y label stripped
    assert j.posted == "Jul 10, 2026"


def test_job_key_parity():
    for j in parse(HTML, company="Apple") + parse(OLD_HTML, company="Apple"):
        assert job_key(j.url) == j.id == f"apple-{j.native_id}"


def test_get_jobs_stops_on_short_page():
    session = MagicMock()
    resp = MagicMock()
    resp.text = HTML
    resp.raise_for_status = lambda: None
    session.get.return_value = resp
    jobs = get_jobs("apple", "Apple", session, search="product manager")
    assert len(jobs) == 2                    # 2 < PAGE(20) -> one request
    assert session.get.call_count == 1
    url = session.get.call_args[0][0]
    assert "search=product%20manager" in url
    assert "sort=relevance" in url           # load-bearing: title matches first
