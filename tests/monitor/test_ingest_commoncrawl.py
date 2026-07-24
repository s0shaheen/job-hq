from pathlib import Path

import pytest
import requests

from monitor.scripts.ingest_commoncrawl import (
    COLLINFO_URL,
    candidates,
    fetch_cdx_page,
    latest_cdx_api,
    slug_from_url,
    slugs_from_cdx_lines,
    write_csv,
)

FIXTURE = Path(__file__).parent / "fixtures/commoncrawl_cdx.jsonl"


# --- fake HTTP layer (no network in unit tests), mirrors tests/monitor/test_discover.py ---

class _FakeResp:
    def __init__(self, status_code=200, *, body=None, text=""):
        self.status_code = status_code
        self._body = body
        self.text = text

    def json(self):
        if self._body is None:
            raise ValueError("no json body")
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"status {self.status_code}")


class _FakeSession:
    """Answers the two GETs the ingester makes: collinfo.json, then the cdx-api query."""

    def __init__(self, *, collinfo=None, cdx_text="", cdx_status=200):
        self._collinfo = collinfo
        self._cdx_text = cdx_text
        self._cdx_status = cdx_status
        self.calls = []

    def get(self, url, params=None, timeout=None, headers=None):
        self.calls.append((url, params))
        if url == COLLINFO_URL:
            return _FakeResp(200, body=self._collinfo)
        return _FakeResp(self._cdx_status, text=self._cdx_text)


# --- slug_from_url: the extraction function, direct string cases ---

def test_slug_from_url_normal_with_jobs_and_query():
    # trailing /jobs/<id> and a query string are both stripped; only the slug remains
    assert slug_from_url(
        "https://boards.greenhouse.io/10xgenomics/jobs/7318082?gh_jid=7318082"
    ) == "10xgenomics"


def test_slug_from_url_decodes_encoded_leading_space():
    # a genuine crawl artifact: "%20forbes" -> " forbes" -> "forbes"
    assert slug_from_url("https://boards.greenhouse.io/%20forbes/jobs/4633927004") == "forbes"


def test_slug_from_url_handles_job_boards_host():
    assert slug_from_url("https://job-boards.greenhouse.io/10alabs") == "10alabs"
    assert slug_from_url("https://job-boards.greenhouse.io/%20forbes?error=true") == "forbes"


def test_slug_from_url_case_folds():
    assert slug_from_url("https://boards.greenhouse.io/Stripe/jobs/1") == "stripe"


def test_slug_from_url_rejects_bare_host_and_embed():
    assert slug_from_url("https://job-boards.greenhouse.io/") is None
    assert slug_from_url("https://boards.greenhouse.io/") is None
    assert slug_from_url("https://boards.greenhouse.io") is None
    assert slug_from_url("https://boards.greenhouse.io/embed/job_board?for=acme") is None


def test_slug_from_url_rejects_non_greenhouse_and_empty():
    assert slug_from_url("https://boards.lever.co/acme") is None
    assert slug_from_url("https://example.com/careers") is None
    assert slug_from_url("") is None
    assert slug_from_url(None) is None  # defensive: never raise on junk input


# --- slugs_from_cdx_lines: parse + dedupe over the saved real fixture ---

def test_slugs_from_fixture_dedupes_across_lines_and_hosts():
    lines = FIXTURE.read_text().splitlines()
    slugs = slugs_from_cdx_lines(lines)
    # 7 fixture lines -> forbes, 10beauty, 10xgenomics(x2), bare-host(skip),
    # forbes(dup cross-host), 10alabs  ==> 4 distinct, first-seen order preserved.
    assert slugs == ["forbes", "10beauty", "10xgenomics", "10alabs"]


def test_slugs_from_lines_skips_blank_and_malformed():
    lines = [
        "",
        "   ",
        "not json at all",
        '{"url": "https://boards.greenhouse.io/stripe/jobs/1"}',
        "[]",  # valid JSON, wrong shape (list not dict) -> skipped, not fatal
        '{"no_url_key": 1}',
        '{"url": "https://boards.greenhouse.io/stripe/jobs/2"}',  # dup slug
    ]
    assert slugs_from_cdx_lines(lines) == ["stripe"]


# --- latest_cdx_api: newest-first selection + fail-loud ---

def test_latest_cdx_api_picks_first_collection():
    s = _FakeSession(collinfo=[
        {"id": "CC-MAIN-2026-25", "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2026-25-index"},
        {"id": "CC-MAIN-2026-20", "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2026-20-index"},
    ])
    assert latest_cdx_api(s) == "https://index.commoncrawl.org/CC-MAIN-2026-25-index"


def test_latest_cdx_api_fails_loud_on_empty_list():
    with pytest.raises(RuntimeError):
        latest_cdx_api(_FakeSession(collinfo=[]))


def test_latest_cdx_api_fails_loud_when_entry_missing_cdx_api():
    with pytest.raises(RuntimeError):
        latest_cdx_api(_FakeSession(collinfo=[{"id": "CC-MAIN-2026-25"}]))


# --- fetch_cdx_page: 404 = empty, other errors raise ---

def test_fetch_cdx_page_404_is_empty_not_error():
    s = _FakeSession(cdx_status=404)
    assert fetch_cdx_page("https://index.commoncrawl.org/x-index", "boards.greenhouse.io/*", s) == []


def test_fetch_cdx_page_500_raises():
    s = _FakeSession(cdx_status=500, cdx_text="oops")
    with pytest.raises(requests.HTTPError):
        fetch_cdx_page("https://index.commoncrawl.org/x-index", "boards.greenhouse.io/*", s)


def test_fetch_cdx_page_returns_text_lines():
    s = _FakeSession(cdx_text="line1\nline2\n")
    assert fetch_cdx_page("https://index.commoncrawl.org/x-index", "boards.greenhouse.io/*", s) == [
        "line1", "line2"
    ]


# --- candidates: end-to-end over the fake session, dict shape + fail-loud ---

def test_candidates_shape_and_dedup_over_fixture():
    s = _FakeSession(
        collinfo=[{"id": "CC-MAIN-2026-25", "cdx-api": "https://index.commoncrawl.org/x-index"}],
        cdx_text=FIXTURE.read_text(),
    )
    rows = candidates(s)
    assert [r["slug"] for r in rows] == ["forbes", "10beauty", "10xgenomics", "10alabs"]
    for r in rows:
        assert r["name"] == ""
        assert r["source"] == "commoncrawl"
        assert r["category"] == ""
        assert r["ats"] == "greenhouse"
        assert set(r) == {"name", "source", "category", "ats", "slug"}


def test_candidates_uses_explicit_cdx_api_without_fetching_index():
    # passing cdx_api skips collinfo.json entirely
    s = _FakeSession(cdx_text=FIXTURE.read_text())
    rows = candidates(s, cdx_api="https://index.commoncrawl.org/x-index")
    assert len(rows) == 4
    assert all(call[0] != COLLINFO_URL for call in s.calls)


def test_candidates_fails_loud_on_zero_slugs():
    # a healthy query always returns some; zero must raise, never silently succeed
    s = _FakeSession(
        collinfo=[{"id": "CC-MAIN-2026-25", "cdx-api": "https://index.commoncrawl.org/x-index"}],
        cdx_text="",
    )
    with pytest.raises(RuntimeError, match="zero Greenhouse slugs"):
        candidates(s)


# --- write_csv: header + row shape ---

def test_write_csv_roundtrip(tmp_path):
    rows = [
        {"name": "", "source": "commoncrawl", "category": "", "ats": "greenhouse", "slug": "stripe"},
        {"name": "", "source": "commoncrawl", "category": "", "ats": "greenhouse", "slug": "airbnb"},
    ]
    out = tmp_path / "candidates_commoncrawl.csv"
    write_csv(rows, out)
    lines = out.read_text().splitlines()
    assert lines[0] == "name,source,category,ats,slug"
    assert lines[1] == ",commoncrawl,,greenhouse,stripe"
    assert lines[2] == ",commoncrawl,,greenhouse,airbnb"
