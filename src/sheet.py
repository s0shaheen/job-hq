from __future__ import annotations
import json
import os
from typing import Protocol, TYPE_CHECKING

if TYPE_CHECKING:
    from src.tagging import Tags

from src.models import Company, JobRecord

TAG_COLUMNS = ["yoe", "seniority", "company_industry", "role_focus",
               "skills", "comp_range", "work_model", "tagged_at"]
BASE_JOBS_HEADER = ["id", "company", "title", "location", "url", "status",
                    "first_seen", "last_seen", "posted"]
JOBS_HEADER = BASE_JOBS_HEADER + TAG_COLUMNS
HEALTH_HEADER = ["company", "ats", "result", "count", "message", "checked_at"]


def _row_to_record(r: dict) -> "JobRecord":
    return JobRecord(
        id=str(r.get("id", "")).strip(), company=str(r.get("company", "")),
        title=str(r.get("title", "")), location=str(r.get("location", "")),
        url=str(r.get("url", "")), status=str(r.get("status", "")) or "New",
        first_seen=str(r.get("first_seen", "")), last_seen=str(r.get("last_seen", "")),
        posted=str(r.get("posted", "")),
    )


class SheetStore(Protocol):
    def read_companies(self) -> list[Company]: ...
    def read_history(self) -> dict[str, JobRecord]: ...
    def contact_count(self, company: str) -> int: ...
    def append_jobs(self, records: list[JobRecord]) -> None: ...
    def set_status(self, id_to_status: dict[str, str]) -> None: ...
    def set_last_seen(self, ids: list[str], today: str) -> None: ...
    def mark_seeded(self, company_names: list[str]) -> None: ...
    def write_health(self, rows: list[list]) -> None: ...
    def ensure_tag_columns(self) -> None: ...
    def read_jobs_for_tagging(self) -> list[tuple[JobRecord, str]]: ...
    def write_tags(self, id_to_tags: dict[str, "Tags"], today: str) -> None: ...


class FakeSheetStore:
    """In-memory SheetStore for tests."""

    def __init__(self, companies, history, contacts_by_company):
        self._companies = companies
        self._history = dict(history)
        self._contacts = {k.lower(): v for k, v in contacts_by_company.items()}
        self.health_rows: list[list] = []
        self.seeded_marks: list[str] = []
        self._tags: dict = {}
        self._tagged_at: dict = {}

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

    def ensure_tag_columns(self):  # no-op for the in-memory store
        return

    def read_jobs_for_tagging(self):
        return [(r, self._tagged_at.get(r.id, "")) for r in self._history.values()]

    def write_tags(self, id_to_tags, today):
        for jid, tags in id_to_tags.items():
            self._tags[jid] = tags
            self._tagged_at[jid] = today

    def tags_for(self, jid):
        return self._tags.get(jid)


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
            rec = _row_to_record(r)
            if not rec.id:
                continue
            out[rec.id] = rec
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

    def ensure_tag_columns(self):
        from gspread.utils import rowcol_to_a1
        ws = self._ws("Jobs")
        header = ws.row_values(1)
        missing = [c for c in TAG_COLUMNS if c not in header]
        if not missing:
            return
        # Fail loud on a partial/manual migration rather than appending duplicate
        # columns and silently corrupting the contiguous tag block write_tags relies on.
        if len(missing) < len(TAG_COLUMNS):
            present = [c for c in TAG_COLUMNS if c in header]
            raise RuntimeError(
                f"Jobs sheet has only some tag columns present ({present}); "
                f"expected all or none. Fix the header manually before running."
            )
        # Append the full tag block as one contiguous run to the right of existing columns.
        start = len(header) + 1
        end = start + len(TAG_COLUMNS) - 1
        rng = f"{rowcol_to_a1(1, start)}:{rowcol_to_a1(1, end)}"
        ws.batch_update([{"range": rng, "values": [TAG_COLUMNS]}], value_input_option="RAW")

    def read_jobs_for_tagging(self):
        rows = self._ws("Jobs").get_all_records()
        out = []
        for r in rows:
            rec = _row_to_record(r)
            if not rec.id:
                continue
            out.append((rec, str(r.get("tagged_at", "")).strip()))
        return out

    def write_tags(self, id_to_tags, today):
        if not id_to_tags:
            return
        from gspread.utils import rowcol_to_a1
        ws = self._ws("Jobs")
        header = ws.row_values(1)
        start = header.index("yoe") + 1            # tag block is contiguous, yoe..tagged_at
        mapping = self._id_to_row()
        updates = []
        for jid, tags in id_to_tags.items():
            row = mapping.get(jid)
            if not row:
                continue
            values = [tags.yoe, tags.seniority, tags.company_industry, tags.role_focus,
                      tags.skills, tags.comp_range, tags.work_model, today]
            rng = f"{rowcol_to_a1(row, start)}:{rowcol_to_a1(row, start + len(values) - 1)}"
            updates.append({"range": rng, "values": [values]})
        if updates:
            # One batch_update covers all rows — fine at this project's scale (tens–hundreds of roles).
            ws.batch_update(updates, value_input_option="RAW")
