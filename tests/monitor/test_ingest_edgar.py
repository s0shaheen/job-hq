import json
from pathlib import Path

import requests

from monitor.scripts import ingest_edgar as ingest

FIX = json.loads((Path(__file__).parent / "fixtures/edgar_il.json").read_text())
EMPTY = {"hits": {"total": {"value": 6, "relation": "eq"}, "hits": []}}


# --- fake HTTP (no network in unit tests), mirrors tests/monitor/test_discover.py ---

class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"status {self.status_code}")

    def json(self):
        return self._payload


class _FakeSession:
    """Serves the fixture on the first page (from=0) and an empty page after,
    recording the query params of every call so tests can assert form/paging."""

    def __init__(self, page0, later=EMPTY):
        self.page0 = page0
        self.later = later
        self.calls = []

    def get(self, url, params=None, timeout=None):
        params = params or {}
        self.calls.append(params)
        payload = self.page0 if int(params.get("from", 0)) == 0 else self.later
        return _FakeResp(payload)


# --- clean_name: strip the "(TICKER)"/"(CIK …)" groups SEC appends ---

def test_clean_name_strips_ticker_and_cik():
    assert ingest.clean_name("AAR CORP  (AIR)  (CIK 0000001750)") == "AAR CORP"


def test_clean_name_no_ticker():
    assert ingest.clean_name("Veradigm Inc.  (CIK 0001124804)") == "Veradigm Inc."


def test_clean_name_multiple_tickers():
    assert ingest.clean_name(
        "Viskase Holdings, Inc.  (ENZN, ENZND)  (CIK 0000727510)"
    ) == "Viskase Holdings, Inc."


def test_clean_name_plain_and_whitespace():
    assert ingest.clean_name("  Some Company LLC  ") == "Some Company LLC"


def test_clean_name_preserves_internal_parens():
    # only TRAILING parenthetical groups are SEC-appended; an internal one is the name
    assert ingest.clean_name("Foo (Bar) Inc.  (CIK 1)") == "Foo (Bar) Inc."


def test_clean_name_never_strips_to_empty():
    # a degenerate "(…)"-only value keeps its last non-empty form, never returns ""
    assert ingest.clean_name("(CIK 123)") == "(CIK 123)"
    assert ingest.clean_name("") == ""


# --- parse_page: flatten every display_names entry, clean, keep order + dupes ---

def test_parse_page_flattens_and_cleans():
    names = ingest.parse_page(FIX)
    assert names == [
        "AAR CORP",
        "Veradigm Inc.",
        "Viskase Holdings, Inc.",
        "AAR CORP",                                    # repeat filing (kept here; caller dedups)
        "Invesco DB Oil Fund",
        "Invesco DB Multi-Sector Commodity Trust",     # co-registrant flattened out
        "Invesco DB Energy Fund",
        "Invesco DB Multi-Sector Commodity Trust",     # same co-registrant on a 2nd filing
    ]
    # 6 hits -> 8 names because two filings each carry a co-registrant
    assert len(names) == 8


def test_parse_page_empty():
    assert ingest.parse_page(EMPTY) == []
    assert ingest.parse_page({}) == []


def test_page_total():
    assert ingest._page_total(FIX) == 6
    assert ingest._page_total({}) == 0
    assert ingest._page_total({"hits": {"total": {}}}) == 0


# --- candidates: dedup across pages/forms + emit the documented dict shape ---

def test_candidates_dedups_and_shapes():
    s = _FakeSession(FIX)
    rows = ingest.candidates(session=s, forms=("10-K",))
    assert [r["name"] for r in rows] == [
        "AAR CORP",
        "Veradigm Inc.",
        "Viskase Holdings, Inc.",
        "Invesco DB Oil Fund",
        "Invesco DB Multi-Sector Commodity Trust",
        "Invesco DB Energy Fund",
    ]
    # 8 raw names -> 6 unique (AAR CORP + the shared Invesco trust each collapse)
    assert len(rows) == 6
    assert all(r["source"] == "edgar" for r in rows)
    assert all(r["category"] == "il-public-filer" for r in rows)
    assert set(rows[0].keys()) == {"name", "source", "category"}
    # total (6) < page_size, so a single page settles it — no needless second fetch
    assert len(s.calls) == 1
    assert s.calls[0]["forms"] == "10-K"
    assert s.calls[0]["locationCodes"] == "IL"


def test_candidates_respects_max():
    s = _FakeSession(FIX)
    rows = ingest.candidates(session=s, forms=("10-K",), max_names=2)
    assert [r["name"] for r in rows] == ["AAR CORP", "Veradigm Inc."]


def test_candidates_two_forms_dedup_globally():
    s = _FakeSession(FIX)
    rows = ingest.candidates(session=s, forms=("10-K", "DEF 14A"))
    names = [r["name"] for r in rows]
    # the second form serves the same fixture -> contributes no new names
    assert names == [
        "AAR CORP",
        "Veradigm Inc.",
        "Viskase Holdings, Inc.",
        "Invesco DB Oil Fund",
        "Invesco DB Multi-Sector Commodity Trust",
        "Invesco DB Energy Fund",
    ]
    assert len(names) == len(set(names))                      # deduped across forms
    assert {c["forms"] for c in s.calls} == {"10-K", "DEF 14A"}  # both forms queried


def test_candidates_stops_on_empty_page():
    s = _FakeSession(EMPTY)
    assert ingest.candidates(session=s, forms=("10-K",)) == []


# --- fail-loud + the SEC User-Agent contract ---

def test_fetch_page_raises_on_http_error():
    class _ErrSession:
        def get(self, url, params=None, timeout=None):
            return _FakeResp({}, status=403)

    try:
        ingest._fetch_page(_ErrSession(), "10-K", "IL", 0, 100)
        assert False, "expected HTTPError to propagate (fail loud, never guess)"
    except requests.HTTPError:
        pass


def test_session_sets_descriptive_user_agent():
    # SEC 403s any request without a descriptive, contactable User-Agent.
    ua = ingest._session().headers.get("User-Agent")
    assert ua == ingest.UA
    assert "@" in ua
