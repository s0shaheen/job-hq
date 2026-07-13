import json

from monitor.jobcontent import (
    html_to_text, _greenhouse_text, _ashby_text, _lever_text,
    _smartrec_text, _workday_text, _workday_detail_url, fetch_description,
    _eightfold_text, _oraclehcm_text, _apple_text, _goldman_text,
    _radancy_jsonld_text,
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


def test_fetch_description_unknown_ats_returns_empty_without_network():
    # session is None on purpose: must not be used for unsupported ATSes.
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


# --- big-tech extractors (pure, per the 2026-07-13 verified shapes) ---

def test_eightfold_text_handles_both_variants():
    assert _eightfold_text({"job_description": "<p>SmartApply JD</p>"}) == "SmartApply JD"
    assert _eightfold_text({"data": {"jobDescription": "<p>PCSX JD</p>"}}) == "PCSX JD"
    assert _eightfold_text({}) == ""


def test_oraclehcm_text_orders_desc_resp_quals():
    payload = {"items": [{
        "ExternalDescriptionStr": "<p>About Oracle</p>",
        "ExternalQualificationsStr": "<p>5 years</p>",
        "ExternalResponsibilitiesStr": "<p>Own OCI roadmap</p>",
    }]}
    out = _oraclehcm_text(payload)
    assert out.index("About Oracle") < out.index("Own OCI roadmap") < out.index("5 years")
    assert _oraclehcm_text({}) == ""


def test_apple_text_concatenates_res_fields():
    payload = {"res": {
        "postingTitle": "Senior PM",
        "jobSummary": "<p>Imagine what you could do here.</p>",
        "description": "<p>Drive the roadmap.</p>",
        "minimumQualifications": "<ul><li>5 years PM</li></ul>",
        "preferredQualifications": "<ul><li>MBA</li></ul>",
    }}
    out = _apple_text(payload)
    assert (out.index("Imagine what") < out.index("Drive the roadmap")
            < out.index("5 years PM") < out.index("MBA"))
    assert _apple_text({}) == ""


def test_goldman_text():
    assert _goldman_text({"data": {"role": {"descriptionHtml": "<p>GS role</p>"}}}) == "GS role"
    assert _goldman_text({"data": {"role": None}}) == ""


def test_radancy_jsonld_skips_non_jobposting_and_bad_json():
    page = (
        '<script type="application/ld+json">{not json}</script>'
        '<script type="application/ld+json">{"@type": "Organization", "name": "Intuit"}</script>'
        '<script type="application/ld+json">'
        '{"@type": "JobPosting", "description": "<p>Own the QuickBooks roadmap &amp; ship</p>"}'
        "</script>")
    assert _radancy_jsonld_text(page) == "Own the QuickBooks roadmap & ship"
    assert _radancy_jsonld_text("<html>no ld</html>") == ""


# --- big-tech routing (stub sessions, zero network) ---

class _Resp:
    def __init__(self, json_data=None, text="", status_code=200, headers=None):
        self._json = json_data
        self.text = text
        self.status_code = status_code
        self.headers = headers or {}

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"unexpected raise_for_status: {self.status_code}")


class _Session:
    """Plain object (not MagicMock) so getattr(session, '_apple_csrf', '')
    behaves like a real requests.Session."""

    def __init__(self, gets=(), posts=()):
        self.gets, self.posts = list(gets), list(posts)
        self.get_calls, self.post_calls = [], []

    def get(self, url, **kw):
        self.get_calls.append((url, kw))
        return self.gets.pop(0)

    def post(self, url, **kw):
        self.post_calls.append((url, kw))
        return self.posts.pop(0)


def test_fetch_description_amazon_cache_hit_needs_no_session(monkeypatch):
    from monitor.fetchers import amazon
    monkeypatch.setattr(amazon, "DESCRIPTIONS", {"3200676": "<p>Cached JD</p>"})
    assert fetch_description("amazon", "3200676", "amazon", "http://x", None) == "Cached JD"


def test_fetch_description_amazon_cold_cache_without_session_returns_empty(monkeypatch):
    from monitor.fetchers import amazon
    monkeypatch.setattr(amazon, "DESCRIPTIONS", {})
    assert fetch_description("amazon", "3200676", "amazon", "http://x", None) == ""


def test_fetch_description_amazon_cold_cache_warms_via_by_id_search(monkeypatch):
    from monitor.fetchers import amazon
    monkeypatch.setattr(amazon, "DESCRIPTIONS", {})
    session = _Session(gets=[_Resp(json_data={"hits": 1, "jobs": [
        {"id_icims": "777001", "title": "PM", "job_path": "/en/jobs/777001/pm",
         "description": "Full Amazon desc", "basic_qualifications": "BQ text"}]})])
    out = fetch_description("amazon", "777001", "amazon",
                            "https://www.amazon.jobs/en/jobs/777001/pm", session)
    assert "Full Amazon desc" in out and "BQ text" in out
    assert "base_query=777001" in session.get_calls[0][0]
    assert "777001" in amazon.DESCRIPTIONS   # warmed for the rest of the sweep


def test_fetch_description_google_cache_hit(monkeypatch):
    from monitor.fetchers import google
    monkeypatch.setattr(google, "DESCRIPTIONS", {"103512847018459846": "<p>G JD</p>"})
    assert fetch_description("google", "103512847018459846", "google",
                             "http://x", None) == "G JD"


def test_fetch_description_google_cold_cache_parses_job_page_blob(monkeypatch):
    from monitor.fetchers import google
    monkeypatch.setattr(google, "DESCRIPTIONS", {})
    entry = ["103512847018459846", "SPM", None, [None, "<p>Resp text</p>"],
             [None, "<p>Quals text</p>"], None, None, None, None,
             [["MTV"]], [None, "<p>Desc text</p>"], None, [1752105600, 0]]
    page = ("<script>AF_initDataCallback({key: 'ds:0', hash: '1', data:"
            + json.dumps([entry]) + ", sideChannel: {}});</script>")
    session = _Session(gets=[_Resp(text=page)])
    url = "https://www.google.com/about/careers/applications/jobs/results/103512847018459846"
    out = fetch_description("google", "103512847018459846", "google", url, session)
    assert "Desc text" in out and "Quals text" in out and "Resp text" in out
    assert session.get_calls[0][0] == url


def test_fetch_description_eightfold_smartapply_then_pcsx_fallback():
    session = _Session(gets=[
        _Resp(text='{"message": "Not authorized for PCSX"}', status_code=403),
        _Resp(json_data={"data": {"jobDescription": "<p>PCSX JD</p>"}}),
    ])
    out = fetch_description("eightfold", "1868732000001",
                            "apply.careers.microsoft.com|microsoft.com", "http://x", session)
    assert out == "PCSX JD"
    assert "/api/apply/v2/jobs/1868732000001" in session.get_calls[0][0]
    assert "/api/pcsx/position_details?position_id=1868732000001" in session.get_calls[1][0]


def test_fetch_description_eightfold_smartapply_direct():
    session = _Session(gets=[_Resp(json_data={"job_description": "<p>Netflix JD</p>"})])
    out = fetch_description("eightfold", "790298012207",
                            "explore.jobs.netflix.net|netflix.com", "http://x", session)
    assert out == "Netflix JD"
    assert len(session.get_calls) == 1


def test_fetch_description_pipe_slug_ats_with_malformed_slug_returns_empty():
    # slug carries host|domain / host|site; without the pipe there is no tenant
    for ats in ("eightfold", "oraclehcm"):
        assert fetch_description(ats, "1", "not-a-pipe-slug", "http://x", None) == ""
        assert fetch_description(ats, "1", "", "http://x", None) == ""


def test_fetch_description_oraclehcm_builds_by_id_finder():
    session = _Session(gets=[_Resp(json_data={"items": [
        {"ExternalDescriptionStr": "<p>Oracle JD</p>"}]})])
    out = fetch_description("oraclehcm", "301496",
                            "eeho.fa.us2.oraclecloud.com|CX_45001", "http://x", session)
    assert out == "Oracle JD"
    url = session.get_calls[0][0]
    assert "recruitingCEJobRequisitionDetails" in url
    assert "finder=ById;siteNumber=CX_45001,Id=%22301496%22" in url


def test_fetch_description_apple_handshake_then_token_reuse():
    session = _Session(gets=[
        _Resp(headers={"x-apple-csrf-token": "tok123"}),
        _Resp(json_data={"res": {"description": "<p>Apple JD</p>"}}),
        _Resp(json_data={"res": {"description": "<p>Second JD</p>"}}),
    ])
    assert fetch_description("apple", "200612639", "apple", "http://x", session) == "Apple JD"
    assert session.get_calls[0][0].endswith("/api/v1/csrfToken")
    assert "/api/v1/jobDetails/200612639" in session.get_calls[1][0]
    assert session.get_calls[1][1]["headers"]["X-Apple-CSRF-Token"] == "tok123"
    # second job on the same session skips the handshake
    assert fetch_description("apple", "200670580", "apple", "http://x", session) == "Second JD"
    assert len(session.get_calls) == 3


def test_fetch_description_goldman_graphql():
    session = _Session(posts=[_Resp(json_data={"data": {"role": {
        "jobTitle": "VP", "descriptionHtml": "<p>GS JD</p>"}}})])
    out = fetch_description("goldman", "168945", "goldman",
                            "https://higher.gs.com/roles/168945", session)
    assert out == "GS JD"
    url, kw = session.post_calls[0]
    assert url == "https://api-higher.gs.com/gateway/api/v1/graphql"
    assert 'role(externalSourceId: "168945")' in kw["json"]["query"]
    assert kw["headers"]["Origin"] == "https://higher.gs.com"


def test_fetch_description_radancy_fetches_job_page():
    page = ('<script type="application/ld+json">'
            '{"@type": "JobPosting", "description": "<p>Intuit JD</p>"}</script>')
    session = _Session(gets=[_Resp(text=page)])
    url = "https://jobs.intuit.com/job/mountain-view/principal-product-manager/27595/85039348256"
    assert fetch_description("radancy", "85039348256", "jobs.intuit.com", url, session) == "Intuit JD"
    assert session.get_calls[0][0] == url
    assert fetch_description("radancy", "85039348256", "jobs.intuit.com", "", None) == ""
