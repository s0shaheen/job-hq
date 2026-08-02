"""The two PostgREST verbs E3 added to core/pg.py — the ones `insert`/`select`
could not be: an append that returns the generated id, and a targeted update.

Nothing else exercises them (the beats/runlog tests monkeypatch pg's functions,
not its HTTP), so the request each builds — the Prefer header that decides
whether an id comes back, the query that decides which rows a PATCH touches — is
pinned here or nowhere.
"""
from __future__ import annotations

import json

import pytest

from core import pg


class FakeResp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = [] if body is None else body
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, resp):
        self.resp = resp
        self.calls = []

    def post(self, url, data=None, headers=None, timeout=None):
        self.calls.append(("POST", url, json.loads(data), headers))
        return self.resp

    def patch(self, url, data=None, headers=None, timeout=None):
        self.calls.append(("PATCH", url, json.loads(data), headers))
        return self.resp


def test_insert_returning_asks_for_representation_and_hands_back_the_row():
    sess = FakeSession(FakeResp(201, [{"id": 42, "job": "monitor"}]))
    out = pg.insert_returning("bot_runs", [{"job": "monitor"}], session=sess)
    assert out == [{"id": 42, "job": "monitor"}]
    method, url, body, headers = sess.calls[0]
    assert method == "POST" and url.endswith("/rest/v1/bot_runs")
    # This is the whole reason it exists — `insert` asks for return=minimal.
    assert headers["Prefer"] == "return=representation"
    assert body == [{"job": "monitor"}]


def test_insert_returning_on_no_rows_makes_no_request():
    sess = FakeSession(FakeResp(201, []))
    assert pg.insert_returning("bot_runs", [], session=sess) == []
    assert sess.calls == []


def test_patch_targets_exactly_the_query_and_returns_nothing():
    sess = FakeSession(FakeResp(204, []))
    pg.patch("bot_runs", "id=eq.42", {"ok": True, "fetched": 38}, session=sess)
    method, url, body, headers = sess.calls[0]
    assert method == "PATCH" and url.endswith("/rest/v1/bot_runs?id=eq.42")
    assert headers["Prefer"] == "return=minimal"
    assert body == {"ok": True, "fetched": 38}


def test_patch_refuses_an_empty_query_rather_than_rewriting_the_table():
    """A PATCH with no filter updates every row. Refuse it at the door."""
    sess = FakeSession(FakeResp(204, []))
    with pytest.raises(pg.PgError, match="every row"):
        pg.patch("bot_runs", "", {"ok": True}, session=sess)
    assert sess.calls == []


def test_a_non_2xx_response_raises_pgerror_with_the_body():
    sess = FakeSession(FakeResp(403, {"message": "permission denied"}))
    with pytest.raises(pg.PgError, match="permission denied"):
        pg.insert_returning("bot_runs", [{"job": "x"}], session=sess)
