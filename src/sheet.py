from __future__ import annotations
import json
import os
from typing import Protocol

from src.models import Company, JobRecord

JOBS_HEADER = ["id", "company", "title", "location", "url", "status", "first_seen", "last_seen", "posted"]
HEALTH_HEADER = ["company", "ats", "result", "count", "message", "checked_at"]


class SheetStore(Protocol):
    def read_companies(self) -> list[Company]: ...
    def read_history(self) -> dict[str, JobRecord]: ...
    def contact_count(self, company: str) -> int: ...
    def append_jobs(self, records: list[JobRecord]) -> None: ...
    def set_status(self, id_to_status: dict[str, str]) -> None: ...
    def set_last_seen(self, ids: list[str], today: str) -> None: ...
    def mark_seeded(self, company_names: list[str]) -> None: ...
    def write_health(self, rows: list[list]) -> None: ...


class FakeSheetStore:
    """In-memory SheetStore for tests."""

    def __init__(self, companies, history, contacts_by_company):
        self._companies = companies
        self._history = dict(history)
        self._contacts = {k.lower(): v for k, v in contacts_by_company.items()}
        self.health_rows: list[list] = []
        self.seeded_marks: list[str] = []

    def read_companies(self):
        return [c for c in self._companies if c.monitor]

    def read_history(self):
        return dict(self._history)

    def contact_count(self, company):
        return self._contacts.get(company.lower(), 0)

    def append_jobs(self, records):
        for r in records:
            self._history[r.id] = r

    def set_status(self, id_to_status):
        for jid, status in id_to_status.items():
            if jid in self._history:
                self._history[jid].status = status

    def set_last_seen(self, ids, today):
        for jid in ids:
            if jid in self._history:
                self._history[jid].last_seen = today

    def mark_seeded(self, company_names):
        self.seeded_marks.extend(company_names)
        for c in self._companies:
            if c.name in company_names:
                c.seeded = True

    def write_health(self, rows):
        self.health_rows = rows


class GspreadSheetStore:
    """Real SheetStore backed by a Google Sheet via gspread."""

    def __init__(self, sheet_id: str):
        import gspread
        creds = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
        gc = gspread.service_account_from_dict(creds)
        self._sh = gc.open_by_key(sheet_id)

    def _ws(self, title: str):
        return self._sh.worksheet(title)

    def read_companies(self):
        rows = self._ws("Companies").get_all_records()
        out = []
        for r in rows:
            out.append(Company(
                name=str(r.get("name", "")).strip(),
                ats=str(r.get("ats", "")).strip(),
                slug=str(r.get("slug", "")).strip(),
                monitor=str(r.get("monitor", "")).strip().upper() in ("TRUE", "1", "YES"),
                seeded=str(r.get("seeded", "")).strip().upper() in ("TRUE", "1", "YES"),
            ))
        return [c for c in out if c.monitor]

    def read_history(self):
        rows = self._ws("Jobs").get_all_records()
        out = {}
        for r in rows:
            jid = str(r.get("id", "")).strip()
            if not jid:
                continue
            out[jid] = JobRecord(
                id=jid, company=str(r.get("company", "")), title=str(r.get("title", "")),
                location=str(r.get("location", "")), url=str(r.get("url", "")),
                status=str(r.get("status", "")) or "New",
                first_seen=str(r.get("first_seen", "")), last_seen=str(r.get("last_seen", "")),
                posted=str(r.get("posted", "")),
            )
        return out

    def contact_count(self, company):
        try:
            rows = self._ws("Contacts").get_all_records()
        except Exception:
            return 0
        return sum(1 for r in rows if str(r.get("company", "")).strip().lower() == company.lower())

    def _id_to_row(self) -> dict[str, int]:
        ids = self._ws("Jobs").col_values(1)  # includes header at row 1
        return {v: i + 1 for i, v in enumerate(ids) if i > 0}

    def append_jobs(self, records):
        if not records:
            return
        rows = [[r.id, r.company, r.title, r.location, r.url, r.status,
                 r.first_seen, r.last_seen, r.posted] for r in records]
        self._ws("Jobs").append_rows(rows, value_input_option="RAW")

    def set_status(self, id_to_status):
        if not id_to_status:
            return
        ws, mapping = self._ws("Jobs"), self._id_to_row()
        updates = [{"range": f"F{mapping[jid]}", "values": [[st]]}
                   for jid, st in id_to_status.items() if jid in mapping]
        if updates:
            ws.batch_update(updates, value_input_option="RAW")

    def set_last_seen(self, ids, today):
        if not ids:
            return
        ws, mapping = self._ws("Jobs"), self._id_to_row()
        updates = [{"range": f"H{mapping[jid]}", "values": [[today]]}
                   for jid in ids if jid in mapping]
        if updates:
            ws.batch_update(updates, value_input_option="RAW")

    def mark_seeded(self, company_names):
        if not company_names:
            return
        ws = self._ws("Companies")
        records = ws.get_all_records()
        names = {n for n in company_names}
        updates = []
        for i, r in enumerate(records):
            if str(r.get("name", "")).strip() in names:
                updates.append({"range": f"E{i + 2}", "values": [["TRUE"]]})
        if updates:
            ws.batch_update(updates, value_input_option="RAW")

    def write_health(self, rows):
        ws = self._ws("Health")
        ws.clear()
        ws.update([HEALTH_HEADER] + rows, value_input_option="RAW")
