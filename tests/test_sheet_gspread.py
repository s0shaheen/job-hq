import pytest
from src.sheet import GspreadSheetStore, BASE_JOBS_HEADER, TAG_COLUMNS, _retry_on_quota
from src.tagging import Tags


class FakeWS:
    def __init__(self, header, records=None, ids_col=None):
        self._header = header
        self._records = records or []
        self._ids_col = ids_col or []
        self.batch_calls = []
        self.get_all_records_calls = 0

    def row_values(self, n):
        return list(self._header)

    def get_all_records(self):
        self.get_all_records_calls += 1
        return [dict(r) for r in self._records]

    def col_values(self, n):
        return ["id"] + self._ids_col   # header + ids

    def batch_update(self, updates, value_input_option=None):
        self.batch_calls.append(updates)


class FakeSheet:
    def __init__(self, ws):
        self._ws = ws
        self.worksheet_calls = 0

    def worksheet(self, title):
        self.worksheet_calls += 1
        return self._ws


def _store(ws):
    s = GspreadSheetStore.__new__(GspreadSheetStore)   # bypass __init__ (needs creds)
    s._sh = FakeSheet(ws)
    return s


def test_ensure_tag_columns_appends_missing_block_when_absent():
    ws = FakeWS(header=list(BASE_JOBS_HEADER))
    _store(ws).ensure_tag_columns()
    assert len(ws.batch_calls) == 1
    upd = ws.batch_calls[0][0]
    # 9 base cols -> tags start at column 10 (J), end at column 17 (Q), header row 1
    assert upd["range"] == "J1:Q1"
    assert upd["values"] == [TAG_COLUMNS]


def test_ensure_tag_columns_noop_when_present():
    ws = FakeWS(header=list(BASE_JOBS_HEADER) + list(TAG_COLUMNS))
    _store(ws).ensure_tag_columns()
    assert ws.batch_calls == []


def test_read_jobs_for_tagging_reads_record_and_tagged_at():
    ws = FakeWS(
        header=list(BASE_JOBS_HEADER) + list(TAG_COLUMNS),
        records=[{"id": "greenhouse-1", "company": "Acme", "title": "PM",
                  "status": "New", "tagged_at": ""},
                 {"id": "lever-2", "company": "B", "title": "PM",
                  "status": "Closed", "tagged_at": "2026-05-26"}],
    )
    rows = _store(ws).read_jobs_for_tagging()
    by_id = {rec.id: (rec, t) for rec, t in rows}
    assert by_id["greenhouse-1"][1] == ""
    assert by_id["lever-2"][0].status == "Closed"
    assert by_id["lever-2"][1] == "2026-05-26"


def test_write_tags_writes_contiguous_block_per_row():
    ws = FakeWS(
        header=list(BASE_JOBS_HEADER) + list(TAG_COLUMNS),
        ids_col=["greenhouse-1"],   # row 2
    )
    tags = Tags(yoe="5+", seniority="Senior", company_industry="Fintech",
                role_focus="Checkout", skills="SQL; AB", comp_range="$1", work_model="Remote")
    _store(ws).write_tags({"greenhouse-1": tags}, "2026-05-27")
    upd = ws.batch_calls[0][0]
    assert upd["range"] == "J2:Q2"
    assert upd["values"] == [["5+", "Senior", "Fintech", "Checkout",
                              "SQL; AB", "$1", "Remote", "2026-05-27"]]


def test_ensure_tag_columns_raises_on_partial_migration():
    ws = FakeWS(header=list(BASE_JOBS_HEADER) + ["yoe", "seniority"])
    with pytest.raises(RuntimeError):
        _store(ws).ensure_tag_columns()
    assert ws.batch_calls == []


# --- read-quota mitigations -------------------------------------------------

def test_ws_handles_are_cached():
    # Resolving the same tab repeatedly must not re-issue worksheet() metadata
    # reads, which otherwise burn the per-minute read quota.
    ws = FakeWS(header=list(BASE_JOBS_HEADER))
    s = _store(ws)
    s._ws("Jobs")
    s._ws("Jobs")
    s._ws("Jobs")
    assert s._sh.worksheet_calls == 1


def test_contact_count_reads_contacts_only_once():
    # run.py calls contact_count once per new job; it must read the Contacts
    # sheet a single time, not once per lookup.
    ws = FakeWS(header=["company"], records=[{"company": "Acme"}, {"company": "Acme"},
                                             {"company": "Ramp"}])
    s = _store(ws)
    assert s.contact_count("Acme") == 2
    assert s.contact_count("acme") == 2   # case-insensitive
    assert s.contact_count("Ramp") == 1
    assert s.contact_count("Unknown") == 0
    assert ws.get_all_records_calls == 1


def _api_error(status, retry_after=None):
    import gspread.exceptions

    class _Resp:
        status_code = status
        text = "quota"
        headers = {"Retry-After": str(retry_after)} if retry_after is not None else {}

        def json(self):
            return {"error": {"code": status, "message": "quota", "status": "RESOURCE_EXHAUSTED"}}

    return gspread.exceptions.APIError(_Resp())


def test_retry_on_quota_retries_429_then_succeeds(monkeypatch):
    import src.sheet
    monkeypatch.setattr(src.sheet.time, "sleep", lambda *_: None)  # don't actually wait
    calls = {"n": 0}

    @_retry_on_quota
    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise _api_error(429)
        return "ok"

    assert flaky() == "ok"
    assert calls["n"] == 3


def test_retry_on_quota_reraises_non_429():
    @_retry_on_quota
    def boom():
        raise _api_error(404)

    import gspread.exceptions
    with pytest.raises(gspread.exceptions.APIError):
        boom()


def test_retry_on_quota_gives_up_after_max_retries(monkeypatch):
    import src.sheet
    monkeypatch.setattr(src.sheet.time, "sleep", lambda *_: None)
    calls = {"n": 0}

    @_retry_on_quota
    def always_429():
        calls["n"] += 1
        raise _api_error(429)

    import gspread.exceptions
    with pytest.raises(gspread.exceptions.APIError):
        always_429()
    assert calls["n"] == src.sheet._QUOTA_MAX_RETRIES
