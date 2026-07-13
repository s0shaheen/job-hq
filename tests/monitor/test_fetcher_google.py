import json
from unittest.mock import MagicMock

from core.jobkeys import job_key
from monitor.fetchers import google
from monitor.fetchers.google import af_data, find_entry, get_jobs, parse

# 21-field entry per the verified index map (only the indices parse() reads
# need real values); [3]=responsibilities [4]=qualifications [9]=locations
# [10]=description [12]=posted epoch
ENTRY_1 = ["103512847018459846", "Senior Product Manager, Search", None,
           [None, "<p>Lead the roadmap</p>"], [None, "<ul><li>BA degree</li></ul>"],
           None, None, None, None,
           [["Mountain View, CA, USA"], ["New York, NY, USA"]],
           [None, "<p>About the job</p>"], None, [1752105600, 0]]
ENTRY_2 = ["103512847018459999", "Product Manager, Cloud", None,
           [None, ""], [None, ""], None, None, None, None,
           [["Austin, TX, USA"]], [None, "<p>Cloud PM role</p>"], None,
           [1752105600, 0]]


def _page(entries, key="ds:1"):
    """List pages wrap the results list at data[0]; a job's own page (ds:0)
    wraps the entry itself at data[0]."""
    data = json.dumps([entries])
    return ("<html><script>AF_initDataCallback({key: '" + key
            + "', hash: '2', data:" + data + ", sideChannel: {}});</script></html>")


def test_parse_list_page():
    google.DESCRIPTIONS.clear()
    jobs = parse(_page([ENTRY_1, ENTRY_2]), company="Google")
    j = jobs[0]
    assert j.ats == "google"
    assert j.native_id == "103512847018459846"
    assert j.title == "Senior Product Manager, Search"
    assert j.location == "Mountain View, CA, USA (+1 more)"
    assert j.url == ("https://www.google.com/about/careers/applications"
                     "/jobs/results/103512847018459846")
    assert j.posted == "2025-07-10"
    assert jobs[1].location == "Austin, TX, USA"


def test_parse_fills_descriptions_cache_with_full_jd():
    google.DESCRIPTIONS.clear()
    parse(_page([ENTRY_1]), company="Google")
    jd = google.DESCRIPTIONS["103512847018459846"]
    assert "About the job" in jd            # description
    assert "BA degree" in jd                # qualifications
    assert "Responsibilities:" in jd and "Lead the roadmap" in jd


def test_job_key_parity():
    for j in parse(_page([ENTRY_1, ENTRY_2]), company="Google"):
        assert job_key(j.url) == j.id == f"google-{j.native_id}"


def test_find_entry_handles_both_blob_wrappings():
    jid = "103512847018459846"
    ds1 = af_data(_page([ENTRY_1, ENTRY_2], key="ds:1"), "ds:1")   # list page
    ds0 = af_data(_page(ENTRY_1, key="ds:0"), "ds:0")              # detail page
    assert find_entry(ds1, jid)[1] == "Senior Product Manager, Search"
    assert find_entry(ds0, jid)[1] == "Senior Product Manager, Search"
    assert find_entry(ds1, "000") is None


def test_get_jobs_stops_on_short_page():
    session = MagicMock()
    resp = MagicMock()
    resp.text = _page([ENTRY_1, ENTRY_2])
    resp.raise_for_status = lambda: None
    session.get.return_value = resp
    jobs = get_jobs("google", "Google", session, search="product manager")
    assert len(jobs) == 2                    # 2 < PAGE(20) -> one request
    assert session.get.call_count == 1
    assert "q=product%20manager" in session.get.call_args[0][0]
