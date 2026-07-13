import pytest
import requests

from core import llm, schema
from core.fakes import fake_hq
from core.sheets import SchemaAnomaly
from tracker import quickadd

B = schema.BOT
URL = "https://boards.greenhouse.io/acme/jobs/77"      # -> greenhouse-77
HTML = ("<html><head><style>.x{color:red}</style></head><body>"
        "<h1>Acme &amp; Co</h1><p>Product Manager</p>"
        "<script>var x=1;</script>4+ years experience</body></html>")
FIELDS = {"company": "Acme", "title": "Product Manager", "location": "Remote",
          "comp": "$150K-$180K", "min_yoe": "4+"}


class _Resp:
    def __init__(self, text, status=200):
        self.text, self.status_code = text, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} error")


def _qa(hq, **kw):
    rec = {"url": URL, "note": "ref from Sam", "priority": "high"}
    rec.update(kw)
    hq.tab("quick_add").append_records([rec])


def _qa_row(hq, url=URL):
    return [r for r in hq.tab("quick_add").records() if r["url"] == url][0]


def _pipeline_rows(hq):
    return [r for r in hq.tab("pipeline").records() if r["key"]]


def test_adds_row_with_llm_fields(monkeypatch):
    hq = fake_hq()
    _qa(hq)
    monkeypatch.setattr(quickadd.requests, "get", lambda url, **kw: _Resp(HTML))
    monkeypatch.setattr(llm, "json_call", lambda prompt, **kw: dict(FIELDS))
    counts = quickadd.run(hq)
    assert counts == {"added": 1, "duplicate": 0, "error": 0}
    row = _pipeline_rows(hq)[0]
    assert row["key"] == "greenhouse-77"
    assert row["source"] == "manual" and row["status"] == "Queued"
    assert row["company"] == "Acme" and row["title"] == "Product Manager"
    assert row["comp"] == "$150K-$180K"
    assert row["min_yoe"] == "4"                 # digits only
    assert row["priority"] == "high" and row["notes"] == "ref from Sam"
    qa = _qa_row(hq)
    assert qa[B + "status"] == "added"
    assert qa[B + "key"] == "greenhouse-77"
    assert qa[B + "processed_at"] != ""


def test_llm_prompt_gets_visible_text_only(monkeypatch):
    hq = fake_hq()
    _qa(hq)
    seen = {}
    monkeypatch.setattr(quickadd.requests, "get", lambda url, **kw: _Resp(HTML))
    monkeypatch.setattr(llm, "json_call",
                        lambda prompt, **kw: seen.update(prompt=prompt) or None)
    quickadd.run(hq)
    assert "Acme & Co" in seen["prompt"]          # entities unescaped
    assert "<script>" not in seen["prompt"] and "var x=1" not in seen["prompt"]
    assert ".x{color:red}" not in seen["prompt"]


def test_key_already_in_pipeline_marks_duplicate_without_fetching(monkeypatch):
    hq = fake_hq()
    hq.tab("pipeline").append_records([{"key": "greenhouse-77", "status": "Applied"}])
    _qa(hq)

    def _no_fetch(url, **kw):
        raise AssertionError("must not fetch a known-duplicate URL")
    monkeypatch.setattr(quickadd.requests, "get", _no_fetch)
    counts = quickadd.run(hq)
    assert counts["duplicate"] == 1
    qa = _qa_row(hq)
    assert qa[B + "status"] == "duplicate"
    assert qa[B + "key"] == "greenhouse-77"
    assert qa[B + "processed_at"] != ""
    assert len(_pipeline_rows(hq)) == 1          # no second row


def test_fetch_error_marks_error_and_never_retries(monkeypatch):
    hq = fake_hq()
    _qa(hq)
    calls = {"n": 0}

    def _boom(url, **kw):
        calls["n"] += 1
        raise requests.ConnectionError("dns exploded")
    monkeypatch.setattr(quickadd.requests, "get", _boom)
    counts = quickadd.run(hq)
    assert counts["error"] == 1
    qa = _qa_row(hq)
    assert qa[B + "status"].startswith("error: ")
    assert "dns exploded" in qa[B + "status"]
    assert qa[B + "processed_at"] != ""
    assert not _pipeline_rows(hq)
    quickadd.run(hq)                             # non-blank status = no retry
    assert calls["n"] == 1


def test_http_error_status_is_an_error(monkeypatch):
    hq = fake_hq()
    _qa(hq)
    monkeypatch.setattr(quickadd.requests, "get", lambda url, **kw: _Resp("gone", 404))
    quickadd.run(hq)
    assert _qa_row(hq)[B + "status"].startswith("error: ")


def test_llm_none_still_creates_row_with_blank_fields(monkeypatch):
    hq = fake_hq()
    _qa(hq)
    monkeypatch.setattr(quickadd.requests, "get", lambda url, **kw: _Resp(HTML))
    monkeypatch.setattr(llm, "json_call", lambda prompt, **kw: None)
    counts = quickadd.run(hq)
    assert counts["added"] == 1
    row = _pipeline_rows(hq)[0]
    assert row["key"] == "greenhouse-77" and row["url"] == URL
    assert row["company"] == "" and row["title"] == ""
    assert _qa_row(hq)[B + "status"] == "added"


def test_duplicate_urls_in_tab_abort_loudly(monkeypatch):
    hq = fake_hq()
    _qa(hq)
    _qa(hq)                                      # same URL pasted twice
    monkeypatch.setattr(quickadd.requests, "get", lambda url, **kw: _Resp(HTML))
    with pytest.raises(SchemaAnomaly):
        quickadd.run(hq)


def test_blank_url_and_processed_rows_skipped(monkeypatch):
    hq = fake_hq()
    hq.tab("quick_add").append_records([{"url": "", "note": "just a thought"}])
    _qa(hq, **{B + "status": "added"})           # already processed

    def _no_fetch(url, **kw):
        raise AssertionError("nothing should be fetched")
    monkeypatch.setattr(quickadd.requests, "get", _no_fetch)
    counts = quickadd.run(hq)
    assert counts == {"added": 0, "duplicate": 0, "error": 0}
