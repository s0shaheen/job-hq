import pytest
import requests

from monitor.scripts.ingest_dork import (
    ats_slug_from_url,
    candidates,
    candidates_from_urls,
    run_searches,
    search_duckduckgo,
    write_csv,
)


# A representative "search results" fixture: greenhouse/ashby/lever hits (with the tails a
# real board URL carries) plus junk that must all extract to nothing.
SAMPLE_URLS = [
    # greenhouse — both hosts, /jobs/<id>, query string, encoded leading space, mixed case
    "https://boards.greenhouse.io/10xgenomics/jobs/7318082?gh_jid=7318082",
    "https://job-boards.greenhouse.io/10alabs",
    "https://boards.greenhouse.io/%20forbes/jobs/4633927004",
    "https://boards.greenhouse.io/Stripe",                      # case-folds -> stripe
    # ashby — bare slug + a posting-uuid tail
    "https://jobs.ashbyhq.com/ramp",
    "https://jobs.ashbyhq.com/notion/8f2a1b3c-1111-2222-3333-444455556666",
    # lever — bare slug + a uuid/apply tail for the SAME company (dedupes)
    "https://jobs.lever.co/brex",
    "https://jobs.lever.co/brex/2c0aa111-dead-beef-0000-abcabcabcabc/apply",
    # --- junk: every one of these must extract to nothing ---
    "https://boards.greenhouse.io/embed/job_board?for=acme",   # embed dropped
    "https://boards.greenhouse.io/",                            # bare host (trailing slash)
    "https://jobs.lever.co",                                    # bare host (no slash)
    "https://www.greenhouse.io/customers",                     # marketing host, not a board
    "https://www.lever.co/",                                    # marketing host
    "https://www.ashbyhq.com/",                                 # marketing host
    "https://example.com/careers",                             # unrelated host
    "",                                                         # empty
]

# What SAMPLE_URLS should reduce to, in first-seen order (brex deduped, all junk dropped).
EXPECTED = [
    ("greenhouse", "10xgenomics"),
    ("greenhouse", "10alabs"),
    ("greenhouse", "forbes"),
    ("greenhouse", "stripe"),
    ("ashby", "ramp"),
    ("ashby", "notion"),
    ("lever", "brex"),
]


# --- fake HTTP layer (no network in unit tests), mirrors test_ingest_commoncrawl.py ---

class _FakeResp:
    def __init__(self, status_code=200, *, text=""):
        self.status_code = status_code
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"status {self.status_code}")


class _FakeSession:
    """Answers the single POST search_duckduckgo makes; records the calls."""

    def __init__(self, resp):
        self._resp = resp
        self.calls = []

    def post(self, url, data=None, timeout=None, headers=None):
        self.calls.append({"url": url, "data": data, "headers": headers})
        return self._resp


def _fake_search(mapping):
    """An injected SearchFn: returns the canned result URLs for each query (else [])."""
    return lambda q: list(mapping.get(q, []))


# --- ats_slug_from_url: the extraction core, direct string cases ---

def test_extract_greenhouse_with_jobs_and_query():
    # trailing /jobs/<id> and a query string are both stripped; only (ats, slug) remains
    assert ats_slug_from_url(
        "https://boards.greenhouse.io/10xgenomics/jobs/7318082?gh_jid=7318082"
    ) == ("greenhouse", "10xgenomics")


def test_extract_greenhouse_job_boards_host():
    assert ats_slug_from_url("https://job-boards.greenhouse.io/10alabs") == ("greenhouse", "10alabs")


def test_extract_decodes_encoded_leading_space():
    # a genuine artifact: "%20forbes" -> " forbes" -> "forbes"
    assert ats_slug_from_url(
        "https://boards.greenhouse.io/%20forbes/jobs/4633927004"
    ) == ("greenhouse", "forbes")


def test_extract_case_folds_host_and_slug():
    assert ats_slug_from_url("https://JOBS.LEVER.CO/Brex") == ("lever", "brex")
    assert ats_slug_from_url("https://boards.greenhouse.io/Stripe/jobs/1") == ("greenhouse", "stripe")


def test_extract_ashby_bare_and_with_posting_uuid():
    assert ats_slug_from_url("https://jobs.ashbyhq.com/ramp") == ("ashby", "ramp")
    assert ats_slug_from_url(
        "https://jobs.ashbyhq.com/notion/8f2a1b3c-1111-2222-3333-444455556666"
    ) == ("ashby", "notion")


def test_extract_lever_with_apply_tail():
    assert ats_slug_from_url(
        "https://jobs.lever.co/brex/2c0aa111-dead-beef-0000-abcabcabcabc/apply"
    ) == ("lever", "brex")


def test_extract_rejects_bare_host_all_families():
    for u in (
        "https://boards.greenhouse.io/",
        "https://job-boards.greenhouse.io/",
        "https://jobs.ashbyhq.com/",
        "https://jobs.lever.co/",
        "https://jobs.lever.co",          # no trailing slash either
        "https://boards.greenhouse.io",
    ):
        assert ats_slug_from_url(u) is None


def test_extract_rejects_structural_first_segments():
    assert ats_slug_from_url("https://boards.greenhouse.io/embed/job_board?for=acme") is None
    assert ats_slug_from_url("https://boards.greenhouse.io/jobs/12345") is None


def test_extract_rejects_marketing_and_unrelated_hosts():
    # the corporate/marketing sites are NOT board hosts and must never yield a slug
    for u in (
        "https://www.greenhouse.io/customers",
        "https://greenhouse.io/",
        "https://www.lever.co/",
        "https://www.ashbyhq.com/",
        "https://example.com/careers",
        "https://boards.lever.co/acme",   # wrong lever host (board vs jobs)
    ):
        assert ats_slug_from_url(u) is None


def test_extract_rejects_empty_and_junk():
    assert ats_slug_from_url("") is None
    assert ats_slug_from_url(None) is None                       # defensive: never raise
    assert ats_slug_from_url("not a url") is None
    assert ats_slug_from_url("https://jobs.lever.co/bad slug") is None  # space -> invalid slug


# --- candidates_from_urls: parse + dedupe over the fixture ---

def test_candidates_from_urls_extracts_dedupes_and_orders():
    assert [(r["ats"], r["slug"]) for r in candidates_from_urls(SAMPLE_URLS)] == EXPECTED


def test_candidates_from_urls_row_shape():
    for r in candidates_from_urls(SAMPLE_URLS):
        assert r["name"] == ""
        assert r["source"] == "dork"
        assert r["category"] == ""
        assert set(r) == {"name", "source", "category", "ats", "slug"}


def test_same_slug_on_two_ats_families_kept_as_two_rows():
    # dedup key is (ats, slug), so greenhouse/ramp and ashby/ramp are distinct boards
    rows = candidates_from_urls([
        "https://boards.greenhouse.io/ramp",
        "https://jobs.ashbyhq.com/ramp",
        "https://boards.greenhouse.io/ramp/jobs/9",   # dup of the first -> dropped
    ])
    assert [(r["ats"], r["slug"]) for r in rows] == [("greenhouse", "ramp"), ("ashby", "ramp")]


# --- run_searches + candidates: injected fake search, end-to-end ---

def test_run_searches_concatenates_per_query_in_order():
    search = _fake_search({"a": ["u1", "u2"], "b": ["u3"]})
    assert run_searches(search, ["a", "b", "missing"]) == ["u1", "u2", "u3"]


def test_candidates_end_to_end_with_injected_search():
    mapping = {
        "gh": ["https://boards.greenhouse.io/stripe/jobs/1",
               "https://boards.greenhouse.io/stripe/jobs/2"],   # same slug twice -> one row
        "ashby": ["https://jobs.ashbyhq.com/ramp", "https://www.ashbyhq.com/"],  # junk mixed in
        "lever": ["https://jobs.lever.co/brex", "https://example.com/x"],
    }
    rows = candidates(_fake_search(mapping), queries=["gh", "ashby", "lever"])
    assert [(r["ats"], r["slug"]) for r in rows] == [
        ("greenhouse", "stripe"), ("ashby", "ramp"), ("lever", "brex")]
    for r in rows:
        assert r["name"] == "" and r["source"] == "dork" and r["category"] == ""
        assert set(r) == {"name", "source", "category", "ats", "slug"}


def test_candidates_strict_fails_loud_on_zero_slugs():
    # a healthy board-host dork always returns some; zero must raise, never silently succeed
    with pytest.raises(RuntimeError, match="zero board slugs"):
        candidates(_fake_search({"x": ["https://example.com/nope"]}), queries=["x"])


def test_candidates_non_strict_allows_empty():
    assert candidates(_fake_search({}), queries=["x"], strict=False) == []


# --- search_duckduckgo: default backend over a mocked session ---

def test_search_duckduckgo_harvests_board_urls_from_wrapped_html():
    # DDG wraps result links in /l/?uddg=<percent-encoded>; we url-decode then harvest.
    html = (
        '<a class="result__a" href="//duckduckgo.com/l/?uddg='
        'https%3A%2F%2Fjobs.lever.co%2Facme%2F123%2Fapply&rut=abc">Acme</a>'
        '<a href="https://boards.greenhouse.io/stripe/jobs/9">Stripe</a>'
        '<a href="https://www.lever.co/">marketing</a>'
    )
    sess = _FakeSession(_FakeResp(200, text=html))
    urls = search_duckduckgo("site:jobs.lever.co Chicago", sess)

    # lever harvested via the decoded redirect (stops at '&'); greenhouse harvested directly;
    # the marketing host is never harvested
    assert "https://jobs.lever.co/acme/123/apply" in urls
    assert "https://boards.greenhouse.io/stripe/jobs/9" in urls
    assert all("www.lever.co" not in u for u in urls)
    # sent the dork to the DDG endpoint
    assert sess.calls[0]["url"].endswith("html.duckduckgo.com/html/")
    assert sess.calls[0]["data"] == {"q": "site:jobs.lever.co Chicago"}
    # and the harvested URLs extract to the right (ats, slug)
    assert candidates_from_urls(urls) == [
        {"name": "", "source": "dork", "category": "", "ats": "lever", "slug": "acme"},
        {"name": "", "source": "dork", "category": "", "ats": "greenhouse", "slug": "stripe"},
    ]


def test_search_duckduckgo_raises_on_http_error():
    sess = _FakeSession(_FakeResp(429, text="rate limited"))
    with pytest.raises(requests.HTTPError):
        search_duckduckgo("q", sess)


def test_candidates_default_backend_uses_duckduckgo(monkeypatch):
    # search=None -> the default backend calls search_duckduckgo once per query
    import monitor.scripts.ingest_dork as mod
    seen = []

    def fake_ddg(query, session=None):
        seen.append(query)
        return ["https://jobs.lever.co/brex"]

    monkeypatch.setattr(mod, "search_duckduckgo", fake_ddg)
    rows = candidates(queries=["q1", "q2"])
    assert seen == ["q1", "q2"]
    assert [(r["ats"], r["slug"]) for r in rows] == [("lever", "brex")]


# --- write_csv: header + row shape ---

def test_write_csv_roundtrip(tmp_path):
    rows = [
        {"name": "", "source": "dork", "category": "", "ats": "greenhouse", "slug": "stripe"},
        {"name": "", "source": "dork", "category": "", "ats": "lever", "slug": "brex"},
    ]
    out = tmp_path / "candidates_dork.csv"
    write_csv(rows, out)
    lines = out.read_text().splitlines()
    assert lines[0] == "name,source,category,ats,slug"
    assert lines[1] == ",dork,,greenhouse,stripe"
    assert lines[2] == ",dork,,lever,brex"
