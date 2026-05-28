import pytest
from src.sheet import GspreadSheetStore, BASE_JOBS_HEADER, TAG_COLUMNS
from src.tagging import Tags


class FakeWS:
    def __init__(self, header, records=None, ids_col=None):
        self._header = header
        self._records = records or []
        self._ids_col = ids_col or []
        self.batch_calls = []

    def row_values(self, n):
        return list(self._header)

    def get_all_records(self):
        return [dict(r) for r in self._records]

    def col_values(self, n):
        return ["id"] + self._ids_col   # header + ids

    def batch_update(self, updates, value_input_option=None):
        self.batch_calls.append(updates)


class FakeSheet:
    def __init__(self, ws):
        self._ws = ws

    def worksheet(self, title):
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
