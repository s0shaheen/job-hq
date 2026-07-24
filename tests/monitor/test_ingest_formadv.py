import io
import zipfile
from pathlib import Path

import pytest

from monitor.scripts.ingest_formadv import (
    IA_URL,
    candidates,
    fetch_csv_text,
    parse_csv,
)

FIXTURE = (Path(__file__).parent / "fixtures/formadv_sample.csv").read_text()


def _zip_bytes(csv_text: str, member="IA_SEC_-_FIRM_ROSTER_FOIA_DOWNLOAD_-_1.CSV") -> bytes:
    """Wrap CSV text in a zip, exactly as the SEC serves the monthly file."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(member, csv_text)
    return buf.getvalue()


class _FakeResp:
    def __init__(self, status_code=200, content=b""):
        self.status_code = status_code
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")


class _FakeSession:
    """Records the request and returns a canned zip response (no network)."""

    def __init__(self, resp):
        self._resp = resp
        self.calls = []

    def get(self, url, timeout=None, headers=None):
        self.calls.append({"url": url, "timeout": timeout, "headers": headers})
        return self._resp


# --- parser: filter + dedup + shape -----------------------------------------

def test_parse_keeps_only_illinois():
    rows = parse_csv(FIXTURE)
    names = [r["name"] for r in rows]
    assert "SOME MANHATTAN CAPITAL LLC" not in names   # NY dropped
    assert "NO STATE ADVISORS LLC" not in names        # blank state dropped
    assert set(names) == {
        "ROTHSCHILD INVESTMENT",
        "WILLIAM BLAIR & COMPANY, L.L.C.",
        "ROMANO WEALTH MANAGEMENT",
    }


def test_parse_dedups_exact_and_case_insensitively():
    # Fixture has "ROTHSCHILD INVESTMENT" twice (exact) plus "rothschild investment".
    rows = parse_csv(FIXTURE)
    roths = [r for r in rows if r["name"].lower() == "rothschild investment"]
    assert len(roths) == 1
    assert roths[0]["name"] == "ROTHSCHILD INVESTMENT"   # first-seen casing wins


def test_parse_skips_blank_name_rows():
    # The IL row with an empty Primary Business Name must not produce a candidate.
    assert all(r["name"] for r in parse_csv(FIXTURE))


def test_parse_handles_comma_inside_quoted_name():
    # Quoted field carrying a comma must survive CSV parsing intact.
    names = [r["name"] for r in parse_csv(FIXTURE)]
    assert "WILLIAM BLAIR & COMPANY, L.L.C." in names


def test_parse_tags_source_and_category():
    rows = parse_csv(FIXTURE)
    assert rows and all(r["source"] == "formadv" for r in rows)
    assert all(r["category"] == "il-ria" for r in rows)
    # plain-name source: no board resolved here
    assert all("ats" not in r and "slug" not in r for r in rows)


def test_parse_fails_loud_when_required_column_missing():
    bad = '"Firm Name","State"\n"Acme","IL"\n'   # neither expected header present
    with pytest.raises(ValueError, match="missing expected column"):
        parse_csv(bad)


# --- fetch: unzip a mocked download -----------------------------------------

def test_fetch_csv_text_unzips_single_member():
    sess = _FakeSession(_FakeResp(200, _zip_bytes(FIXTURE)))
    text = fetch_csv_text(sess)
    assert "ROTHSCHILD INVESTMENT" in text
    # sent the required SEC User-Agent to the pinned URL
    assert sess.calls[0]["url"] == IA_URL
    assert "@" in (sess.calls[0]["headers"] or {}).get("User-Agent", "")


def test_fetch_csv_text_fails_loud_on_multi_csv_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.CSV", FIXTURE)
        zf.writestr("b.CSV", FIXTURE)
    sess = _FakeSession(_FakeResp(200, buf.getvalue()))
    with pytest.raises(ValueError, match="exactly one CSV"):
        fetch_csv_text(sess)


# --- end-to-end through a mocked session ------------------------------------

def test_candidates_end_to_end_with_mocked_session():
    sess = _FakeSession(_FakeResp(200, _zip_bytes(FIXTURE)))
    rows = candidates(session=sess)
    assert len(rows) == 3
    assert {r["name"] for r in rows} == {
        "ROTHSCHILD INVESTMENT",
        "WILLIAM BLAIR & COMPANY, L.L.C.",
        "ROMANO WEALTH MANAGEMENT",
    }
