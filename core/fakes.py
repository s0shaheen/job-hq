"""In-memory doubles for unit tests across monitor/ and tracker/.

FakeWorksheet mimics exactly the slice of gspread's Worksheet that
core.sheets.Tab uses, so Tab logic (header maps, keyed verified writes,
forward-only status) is tested for real. FakeHQ wires Tabs over
FakeWorksheets with the standard schema.
"""
from __future__ import annotations

import re
from typing import Any

from core import schema
from core.sheets import HQ, Tab

_A1 = re.compile(r"^([A-Z]+)(\d+)$")


def _col_to_idx(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


class FakeWorksheet:
    _next_id = 1000

    def __init__(self, title: str, rows: list[list[str]] | None = None):
        self.title = title
        self._grid: list[list[str]] = [list(map(str, r)) for r in (rows or [])]
        FakeWorksheet._next_id += 1
        self.id = FakeWorksheet._next_id

    # -- helpers
    def _ensure(self, row: int, col: int) -> None:
        while len(self._grid) < row:
            self._grid.append([])
        r = self._grid[row - 1]
        while len(r) < col:
            r.append("")

    def _get(self, row: int, col: int) -> str:
        if row - 1 < len(self._grid) and col - 1 < len(self._grid[row - 1]):
            return str(self._grid[row - 1][col - 1])
        return ""

    # -- gspread surface used by Tab
    def row_values(self, n: int) -> list[str]:
        return list(self._grid[n - 1]) if n - 1 < len(self._grid) else []

    def col_values(self, n: int) -> list[str]:
        return [self._get(r, n) for r in range(1, len(self._grid) + 1)]

    def get_all_values(self) -> list[list[str]]:
        return [list(r) for r in self._grid]

    def cell(self, row: int, col: int):
        class _C:
            def __init__(self, v):
                self.value = v
        return _C(self._get(row, col))

    def append_rows(self, rows, value_input_option=None, insert_data_option=None, table_range=None):
        for r in rows:
            self._grid.append([str(x) for x in r])

    def batch_update(self, updates, value_input_option=None):
        for u in updates:
            m = _A1.match(u["range"].split(":")[0])
            row, col = int(m.group(2)), _col_to_idx(m.group(1))
            for dr, values_row in enumerate(u["values"]):
                for dc, v in enumerate(values_row):
                    self._ensure(row + dr, col + dc)
                    self._grid[row + dr - 1][col + dc - 1] = str(v)

    def batch_get(self, ranges):
        out = []
        for rng in ranges:
            m = _A1.match(rng.split(":")[0])
            row, col = int(m.group(2)), _col_to_idx(m.group(1))
            v = self._get(row, col)
            out.append([[v]] if v != "" else [])
        return out

    def update(self, values, range_name=None, value_input_option=None):
        # supports ws.update([row], "A1"-style) used by ensure_headers
        m = _A1.match((range_name or "A1").split(":")[0])
        row, col = int(m.group(2)), _col_to_idx(m.group(1))
        for dr, values_row in enumerate(values):
            for dc, v in enumerate(values_row):
                self._ensure(row + dr, col + dc)
                self._grid[row + dr - 1][col + dc - 1] = str(v)

    # convenience for tests
    def sort_data_rows(self, by_col: int, reverse: bool = False) -> None:
        """Simulate a human sorting the tab (header row stays)."""
        body = self._grid[1:]
        body.sort(key=lambda r: (r[by_col - 1] if by_col - 1 < len(r) else ""), reverse=reverse)
        self._grid = self._grid[:1] + body


class FakeSpreadsheet:
    def __init__(self):
        self._sheets: list[FakeWorksheet] = []

    def worksheets(self):
        return list(self._sheets)

    def worksheet(self, title: str):
        for ws in self._sheets:
            if ws.title == title:
                return ws
        raise KeyError(title)

    def get_worksheet_by_id(self, gid: int):
        for ws in self._sheets:
            if ws.id == gid:
                return ws
        raise KeyError(gid)

    def add_worksheet(self, title: str, rows: int = 100, cols: int = 26):
        ws = FakeWorksheet(title)
        self._sheets.append(ws)
        return ws

    def batch_update(self, body):   # structure ops are no-ops in the fake
        return body

    def fetch_sheet_metadata(self, params=None):
        return {"sheets": [{"properties": {"sheetId": w.id, "title": w.title}} for w in self._sheets]}


def fake_hq(with_tabs: list[str] | None = None) -> HQ:
    """An HQ over an in-memory spreadsheet, standard headers pre-written."""
    sh = FakeSpreadsheet()
    reg: dict = {"tabs": {}, "ntfy": {"jobs": "", "ops": ""}}
    for logical in (with_tabs or list(schema.TABS)):
        ws = sh.add_worksheet(schema.TABS[logical])
        headers = schema.HEADERS.get(logical) or []
        if headers:
            ws.update([headers], "A1")
        reg["tabs"][logical] = ws.id
    return HQ(sh, reg)
