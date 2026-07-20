"""Durable Google Sheets access — the ONLY write path to the HQ spreadsheet.

The contract that makes human chaos safe (each rule verified against the
Sheets API docs + gspread 6.2.1 source, 2026-07-13):

1. Tabs are addressed by immutable sheetId (gid) from the committed registry
   (hq.config.yaml), falling back to display title. Renames are harmless.
2. Column identity is a header map rebuilt from row 1 on every access cycle.
   Required headers must exist EXACTLY once — anything else is a loud abort
   (SchemaAnomaly -> ops push by the caller), never a guessed write.
3. Row identity is a key column, located AT WRITE TIME — row numbers are never
   cached across API calls, because a human may sort mid-run.
4. Writes are cell-targeted (never whole rows), RAW (no date/number mangling),
   appends use INSERT_ROWS anchored at A1 (documented table detection).
5. Every keyed write is read back and verified; on mismatch the row is
   re-located once and retried, then aborted loudly.
6. Bots fill blanks and move statuses forward; `only_if_blank=True` and
   forward-only status logic enforce "humans win" mechanically.
7. One BackOff-wrapped client; batch reads/writes; ~5% of the 60 req/min/user
   quota at this system's scale.

Structure operations (create tabs, dropdowns, protections, frozen rows) live
at the bottom — used by tracker/bootstrap.py and tracker/selfheal.py only.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
from typing import Any, Iterable

from core import schema


class SchemaAnomaly(RuntimeError):
    """The sheet no longer matches the schema in a way we refuse to guess about."""


class RowNotFound(LookupError):
    pass


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def today() -> str:
    return _dt.date.today().isoformat()


# --------------------------------------------------------------------- client

def _client():
    import gspread
    info = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    try:
        return gspread.service_account_from_dict(info, http_client=gspread.BackOffHTTPClient)
    except TypeError:  # older gspread without the kwarg — still works, just no backoff client
        return gspread.service_account_from_dict(info)


# ------------------------------------------------------------------------ Tab

class Tab:
    """One worksheet, addressed durably. All reads/writes go through here."""

    def __init__(self, ws, logical: str, required_headers: list[str] | None = None):
        self.ws = ws
        self.logical = logical
        self.required = list(required_headers if required_headers is not None
                             else schema.HEADERS.get(logical, []))

    # ---- headers

    def header_row(self) -> list[str]:
        return [str(h).strip() for h in self.ws.row_values(1)]

    def header_map(self) -> dict[str, int]:
        """Header -> 1-based column index. Asserts every required header exists
        exactly once. Duplicate or missing required headers abort the run."""
        row = self.header_row()
        seen: dict[str, int] = {}
        dups: set[str] = set()
        for i, h in enumerate(row, start=1):
            if not h:
                continue
            if h in seen:
                dups.add(h)
            else:
                seen[h] = i
        problems = []
        for h in self.required:
            if h in dups:
                problems.append(f"duplicate header {h!r}")
            elif h not in seen:
                problems.append(f"missing header {h!r}")
        if problems:
            raise SchemaAnomaly(
                f"[{self.logical}] header anomaly: " + "; ".join(problems) +
                " — fix the header row (or run self-heal); no writes attempted.")
        return seen

    def col(self, header: str, hmap: dict[str, int] | None = None) -> int:
        hmap = hmap or self.header_map()
        if header not in hmap:
            raise SchemaAnomaly(f"[{self.logical}] required column {header!r} not found")
        return hmap[header]

    # ---- reads

    def records(self) -> list[dict[str, str]]:
        """All data rows as {header: str-value}, using OUR header map (not
        get_all_records — duplicate/blank human headers must not corrupt keys).
        Row numbers are (index in list + 2) only at the instant of the read."""
        values = self.ws.get_all_values()
        if not values:
            return []
        hmap = self._map_from_row(values[0])
        out = []
        for raw in values[1:]:
            rec = {}
            for h, idx in hmap.items():
                rec[h] = str(raw[idx - 1]).strip() if idx - 1 < len(raw) else ""
            out.append(rec)
        return out

    def _map_from_row(self, row: list) -> dict[str, int]:
        seen: dict[str, int] = {}
        for i, h in enumerate([str(x).strip() for x in row], start=1):
            if h and h not in seen:
                seen[h] = i
        for h in self.required:
            if h not in seen:
                raise SchemaAnomaly(f"[{self.logical}] missing header {h!r}")
        return seen

    def key_index(self, key_header: str = schema.KEY) -> dict[str, int]:
        """key value -> 1-based row number, fresh. Duplicate keys abort."""
        kcol = self.col(key_header)
        vals = self.ws.col_values(kcol)
        idx: dict[str, int] = {}
        dups = set()
        for rownum, v in enumerate(vals[1:], start=2):
            v = str(v).strip()
            if not v:
                continue
            if v in idx:
                dups.add(v)
            idx[v] = rownum
        if dups:
            raise SchemaAnomaly(f"[{self.logical}] duplicate keys: {sorted(dups)[:5]}")
        return idx

    # ---- writes

    def append_records(self, records: list[dict[str, Any]]) -> int:
        """Append rows aligned to the LIVE header. A record key that has no
        matching column is schema drift -> abort (bots must never invent
        columns on the fly; bootstrap/self-heal own the schema)."""
        if not records:
            return 0
        hmap = self.header_map()
        ncols = max(hmap.values())
        rows = []
        for rec in records:
            unknown = [k for k in rec if k not in hmap]
            if unknown:
                raise SchemaAnomaly(f"[{self.logical}] no column for {unknown} — run self-heal/bootstrap first")
            row = [""] * ncols
            for k, v in rec.items():
                row[hmap[k] - 1] = "" if v is None else str(v)
            rows.append(row)
        self.ws.append_rows(rows, value_input_option="RAW",
                            insert_data_option="INSERT_ROWS", table_range="A1")
        return len(rows)

    def set_by_key(self, key: str, values: dict[str, Any], *,
                   key_header: str = schema.KEY, only_if_blank: bool = False,
                   _attempt: int = 0) -> dict[str, str]:
        """Update cells on the row whose key column equals `key`.

        only_if_blank=True: a non-empty existing cell wins (human wins).
        Returns {header: "written"|"kept"} per field. Verifies by read-back;
        on mismatch (row moved mid-write) re-locates once, then aborts.
        """
        from gspread.utils import rowcol_to_a1
        hmap = self.header_map()
        rownum = self.key_index(key_header).get(key)
        if rownum is None:
            raise RowNotFound(f"[{self.logical}] key {key!r} not found")

        current = self.ws.row_values(rownum)

        def cur(h: str) -> str:
            i = hmap[h] - 1
            return str(current[i]).strip() if i < len(current) else ""

        outcome: dict[str, str] = {}
        updates = []
        expect: list[tuple[str, str]] = []   # (a1, value)
        for h, v in values.items():
            if h not in hmap:
                raise SchemaAnomaly(f"[{self.logical}] no column {h!r}")
            v = "" if v is None else str(v)
            if only_if_blank and cur(h):
                outcome[h] = "kept"
                continue
            a1 = rowcol_to_a1(rownum, hmap[h])
            updates.append({"range": a1, "values": [[v]]})
            expect.append((a1, v))
            outcome[h] = "written"
        if not updates:
            return outcome

        # key guard: verify the row still holds our key in the same batch read
        key_a1 = rowcol_to_a1(rownum, hmap[key_header])
        self.ws.batch_update(updates, value_input_option="RAW")
        got = self.ws.batch_get([key_a1] + [a1 for a1, _ in expect])
        got_key = (got[0][0][0] if got and got[0] and got[0][0] else "")
        ok = str(got_key).strip() == key and all(
            str((got[i + 1][0][0] if got[i + 1] and got[i + 1][0] else "")).strip() == v.strip()
            for i, (_, v) in enumerate(expect))
        if ok:
            return outcome
        if _attempt == 0:
            # a human sorted mid-flight — re-locate the row and retry once
            return self.set_by_key(key, values, key_header=key_header,
                                   only_if_blank=only_if_blank, _attempt=1)
        raise SchemaAnomaly(f"[{self.logical}] verified write failed twice for key {key!r} "
                            f"(sheet changing under us?) — aborting, no further writes")

    def advance_status(self, key: str, new_status: str, *, evidence: str = "",
                       status_header: str = "status",
                       key_header: str = schema.KEY) -> str:
        """Move status FORWARD only. Never downgrades, never touches a
        human-invented status. Returns 'advanced'|'kept'."""
        hmap = self.header_map()
        rownum = self.key_index(key_header).get(key)
        if rownum is None:
            raise RowNotFound(f"[{self.logical}] key {key!r} not found")
        current = str(self.ws.cell(rownum, hmap[status_header]).value or "").strip()
        if schema.status_rank(new_status) <= schema.status_rank(current):
            return "kept"
        vals: dict[str, Any] = {status_header: new_status, "last_activity": today()}
        if evidence and "evidence" in hmap:
            vals["evidence"] = evidence
        self.set_by_key(key, vals, key_header=key_header)
        return "advanced"


# ------------------------------------------------------------------------- HQ

class HQ:
    """The spreadsheet, opened durably from env + committed registry."""

    def __init__(self, spreadsheet, registry: dict):
        self.sh = spreadsheet
        self.registry = registry
        self._tabs: dict[str, Tab] = {}

    @classmethod
    def open(cls) -> "HQ":
        from core.config import registry
        reg = registry()
        sheet_id = os.environ.get("HQ_SHEET_ID") or reg.get("sheet_id", "")
        if not sheet_id:
            raise SchemaAnomaly("HQ sheet_id unset — run tracker.bootstrap first "
                                "(hq.config.yaml: sheet_id)")
        gc = _client()
        return cls(gc.open_by_key(sheet_id), reg)

    def tab(self, logical: str) -> Tab:
        if logical in self._tabs:
            return self._tabs[logical]
        gid = (self.registry.get("tabs") or {}).get(logical)
        ws = None
        if gid not in (None, ""):
            try:
                ws = self.sh.get_worksheet_by_id(int(gid))
            except Exception:
                ws = None
        if ws is None:  # registry stale — fall back to title; self-heal re-pins gids
            title = schema.TABS[logical]
            try:
                ws = self.sh.worksheet(title)
            except Exception as e:
                raise SchemaAnomaly(f"tab {logical!r} not found by gid {gid!r} or title "
                                    f"{title!r} — was it deleted? ({e})")
        t = Tab(ws, logical)
        self._tabs[logical] = t
        return t

    # ---- cross-cutting helpers

    def log(self, actor: str, action: str, key: str = "", detail: str = "") -> None:
        """Append-only audit line. Never raises — logging must not kill a run."""
        try:
            self.tab("log").append_records([{
                "ts": _now(), "actor": actor, "action": action,
                "key": key, "detail": str(detail)[:500],
            }])
        except Exception:
            pass

    def heartbeat(self, name: str) -> None:
        """Upsert heartbeat_{name}=now into Config. Watchdogs read these."""
        try:
            t = self.tab("config")
            k = f"heartbeat_{name}"
            try:
                t.set_by_key(k, {"value": _now()}, key_header="key")
            except RowNotFound:
                t.append_records([{"key": k, "value": _now(),
                                   "description": f"(auto) last successful {name} run"}])
        except Exception:
            pass

    def user_config(self):
        from core.config import UserConfig
        return UserConfig.load(self)


# ----------------------------------------------------- structure operations
# Used ONLY by tracker/bootstrap.py and tracker/selfheal.py.

GRID_HEADROOM = 6      # spare columns so the next schema addition needs no widen


def ensure_tab(sh, title: str, rows: int = 200, cols: int = 26,
               headers: list[str] | None = None):
    """Create the tab if absent. The grid is sized to the SCHEMA, not to
    Sheets' 26-column default: a tab narrower than its header row cannot be
    written at all ("exceeds grid limits"), which silently blocks every writer
    on that tab until someone widens it by hand."""
    for ws in sh.worksheets():
        if ws.title == title:
            return ws, False
    if headers:
        cols = max(cols, len(headers) + GRID_HEADROOM)
    return sh.add_worksheet(title=title, rows=rows, cols=cols), True


def ensure_headers(ws, headers: list[str]) -> list[str]:
    """Make row 1 contain every required header exactly once. New tabs get the
    exact row; existing tabs get MISSING bot headers appended to the right —
    human columns and human order are never touched. Returns repairs made."""
    if not headers:
        return []
    from gspread.utils import rowcol_to_a1
    current = [str(h).strip() for h in ws.row_values(1)]
    repairs = []
    if not any(current):
        ws.update([headers], "A1", value_input_option="RAW")
        return [f"wrote header row ({len(headers)} cols)"]
    missing = [h for h in headers if h not in current]
    if missing:
        start = len(current) + 1
        end = start + len(missing) - 1
        # A worksheet's grid has a fixed width (a fresh sheet is 26 columns).
        # Writing past it is a 400 "exceeds grid limits", NOT an auto-grow —
        # which means self-heal cannot add a new schema column to a full-width
        # tab, and every writer stays blocked on the missing header. Widen the
        # grid first.
        col_count = getattr(ws, "col_count", None)
        if isinstance(col_count, int) and end > col_count:
            try:
                ws.add_cols(end - col_count)
                repairs.append(f"widened grid to {end} columns")
            except Exception as e:      # loud, not silent: the header write
                raise SchemaAnomaly(    # below would fail anyway
                    f"[{ws.title}] cannot widen grid to {end} columns for "
                    f"{missing}: {e}")
        rng = f"{rowcol_to_a1(1, start)}:{rowcol_to_a1(1, end)}"
        ws.update([missing], rng, value_input_option="RAW")
        repairs.append(f"appended missing headers {missing}")
    counts = {h: current.count(h) for h in headers}
    dups = [h for h, c in counts.items() if c > 1]
    if dups:
        raise SchemaAnomaly(f"[{ws.title}] duplicate required headers {dups} — resolve manually")
    return repairs


def freeze_header(sh, ws) -> None:
    sh.batch_update({"requests": [{"updateSheetProperties": {
        "properties": {"sheetId": ws.id, "gridProperties": {"frozenRowCount": 1}},
        "fields": "gridProperties.frozenRowCount"}}]})


def set_dropdown(sh, ws, col_idx: int, options: list[str], strict: bool = True) -> None:
    sh.batch_update({"requests": [{"setDataValidation": {
        "range": {"sheetId": ws.id, "startRowIndex": 1,
                  "startColumnIndex": col_idx - 1, "endColumnIndex": col_idx},
        "rule": {"condition": {"type": "ONE_OF_LIST",
                               "values": [{"userEnteredValue": o} for o in options]},
                 "strict": strict, "showCustomUi": True}}}]})


def protect(sh, ws, *, description: str, warning_only: bool = False,
            editors: list[str] | None = None,
            row_span: tuple[int, int] | None = None,
            col_span: tuple[int, int] | None = None) -> None:
    """Add a protected range. Full protection (warning_only=False) must ONLY be
    used on whole bot tabs and header rows — protecting columns of a shared tab
    blocks humans from sorting it (verified Sheets behavior)."""
    rng: dict = {"sheetId": ws.id}
    if row_span:
        rng["startRowIndex"], rng["endRowIndex"] = row_span
    if col_span:
        rng["startColumnIndex"], rng["endColumnIndex"] = col_span
    pr: dict = {"range": rng, "description": description}
    if warning_only:
        pr["warningOnly"] = True
    else:
        pr["editors"] = {"users": editors or []}
    sh.batch_update({"requests": [{"addProtectedRange": {"protectedRange": pr}}]})


def list_protections(sh) -> list[dict]:
    meta = sh.fetch_sheet_metadata(params={"fields": "sheets(properties(sheetId,title),protectedRanges)"})
    out = []
    for s in meta.get("sheets", []):
        for pr in s.get("protectedRanges", []) or []:
            pr["_sheetId"] = s["properties"]["sheetId"]
            pr["_sheetTitle"] = s["properties"]["title"]
            out.append(pr)
    return out
