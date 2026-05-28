from src.jobcontent import (
    html_to_text, _greenhouse_text, _ashby_text, _lever_text,
    _smartrec_text, _workday_text, _workday_detail_url, fetch_description,
)


def test_html_to_text_unescapes_double_escaped_and_strips_tags():
    raw = "&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;Build &amp; ship&lt;/p&gt;"
    assert html_to_text(raw) == "About Build & ship"


def test_html_to_text_handles_plain_html_and_collapses_whitespace():
    assert html_to_text("<p>Hello   world</p>\n\n<p>Again</p>") == "Hello world\n\nAgain"


def test_html_to_text_empty():
    assert html_to_text("") == ""


def test_greenhouse_text():
    payload = {"content": "&lt;p&gt;Lead the roadmap&lt;/p&gt;"}
    assert _greenhouse_text(payload) == "Lead the roadmap"


def test_ashby_text_finds_job_by_id_prefers_plain():
    payload = {"jobs": [
        {"id": "abc", "descriptionPlain": "Plain desc", "descriptionHtml": "<p>x</p>"},
        {"id": "def", "descriptionPlain": "Other"},
    ]}
    assert _ashby_text(payload, "abc") == "Plain desc"


def test_ashby_text_missing_id_returns_empty():
    assert _ashby_text({"jobs": [{"id": "abc", "descriptionPlain": "x"}]}, "zzz") == ""


def test_lever_text_joins_description_lists_and_additional():
    payload = {
        "descriptionPlain": "We are hiring a PM.",
        "lists": [{"text": "Requirements", "content": "<li>SQL</li><li>5 yrs</li>"}],
        "additionalPlain": "Equal opportunity.",
    }
    out = _lever_text(payload)
    assert "We are hiring a PM." in out
    assert "Requirements" in out and "SQL" in out and "5 yrs" in out
    assert "Equal opportunity." in out


def test_smartrec_text_concatenates_sections_in_order():
    payload = {"jobAd": {"sections": {
        "companyDescription": {"title": "Company", "text": "<p>About us</p>"},
        "jobDescription": {"title": "Role", "text": "<p>Own the roadmap</p>"},
        "qualifications": {"title": "Quals", "text": "<p>5 years</p>"},
        "additionalInformation": {"title": "More", "text": "<p>Perks</p>"},
    }}}
    out = _smartrec_text(payload)
    assert out.index("About us") < out.index("Own the roadmap") < out.index("5 years")


def test_workday_text():
    payload = {"jobPostingInfo": {"jobDescription": "<p>Build NPI products</p>"}}
    assert _workday_text(payload) == "Build NPI products"


def test_workday_detail_url_reconstructs_cxs_endpoint():
    url = "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Remote/Senior-PM_JR1"
    assert _workday_detail_url(url) == (
        "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/"
        "NVIDIAExternalCareerSite/job/Remote/Senior-PM_JR1"
    )


def test_workday_detail_url_bad_input_returns_empty():
    assert _workday_detail_url("https://example.com/whatever") == ""


def test_fetch_description_unknown_or_amazon_ats_returns_empty_without_network():
    # session is None on purpose: must not be used for unsupported ATSes.
    assert fetch_description("amazon", "1", "amazon", "http://x", None) == ""
    assert fetch_description("nope", "1", "s", "http://x", None) == ""


def test_html_to_text_drops_script_and_style_bodies():
    raw = "<style>.foo{display:none}</style><p>Hello</p><script>x=1</script>"
    assert html_to_text(raw) == "Hello"


def test_html_to_text_converts_nbsp_to_space():
    assert html_to_text("Hello&nbsp;world") == "Hello world"


def test_workday_detail_url_missing_job_path_returns_empty():
    assert _workday_detail_url(
        "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/") == ""


def test_fetch_description_empty_slug_for_slug_ats_returns_empty_without_network():
    # session=None proves no network call is attempted
    for ats in ("greenhouse", "ashby", "lever", "smartrec"):
        assert fetch_description(ats, "123", "", "http://x", None) == ""
