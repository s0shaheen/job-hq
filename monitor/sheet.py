"""Feed storage over the HQ spreadsheet — the monitor's only sheet surface.

Everything goes through core.sheets.Tab (gid-addressed tabs, header-map column
identity, keyed verified writes), so a human sort, rename, or extra column can
never land a write on the wrong row. Row identity in the feed tab is
schema.KEY; JobRecord.id IS the key (jobkeys "{ats}-{native_id}" format).

Dropped from the old per-profile store, deliberately:
- contact_count: the HQ schema has no Contacts tab and the push format no
  longer carries a contact hint.
- ensure_tag_columns: bots never invent columns (core.sheets aborts on unknown
  headers); bootstrap/self-heal own the feed schema, header_map() asserts it.
"""
from __future__ import annotations

from typing import Any, Protocol, TYPE_CHECKING

from core import schema
from core.sheets import RowNotFound, SchemaAnomaly
from monitor import geo
from monitor.models import Company, JobRecord

if TYPE_CHECKING:
    from core.sheets import HQ
    from monitor.tagging import Tags

# Tag block written by the monitor/review passes. min_yoe rides along, derived
# from yoe at write time (Tags.min_yoe), so filterers never re-parse yoe.
TAG_FIELDS = ["yoe", "seniority", "company_industry", "role_focus",
              "skills", "comp_range", "work_model"]


def _truthy(cell: str) -> bool:
    return str(cell).strip().upper() in ("TRUE", "1", "YES")


def _tag_values(tags: "Tags") -> dict[str, Any]:
    vals = {f: getattr(tags, f) for f in TAG_FIELDS}
    vals["min_yoe"] = tags.min_yoe
    return vals


class SheetStore(Protocol):
    def read_companies(self) -> list[Company]: ...
    def read_history(self) -> dict[str, JobRecord]: ...
    def read_min_yoe(self) -> dict[str, str]: ...
    def append_jobs(self, records: list[JobRecord],
                    tags: dict[str, "Tags"] | None = None, today: str = "") -> None: ...
    def set_status(self, id_to_status: dict[str, str]) -> None: ...
    def set_last_seen(self, ids: list[str], today: str) -> None: ...
    def mark_seeded(self, company_names: list[str]) -> None: ...
    def mark_pushed(self, ids: list[str], today: str) -> None: ...
    def write_health(self, rows: list[dict]) -> None: ...
    def read_jobs_for_tagging(self) -> list[tuple[JobRecord, str]]: ...
    def write_tags(self, id_to_tags: dict[str, "Tags"], today: str) -> None: ...


class HQFeedStore:
    """SheetStore over the HQ spreadsheet's feed/companies/health tabs."""

    def __init__(self, hq: "HQ"):
        self._hq = hq
        self._min_yoe: dict[str, str] | None = None

    # ---- reads

    def read_companies(self) -> list[Company]:
        out = []
        for r in self._hq.tab("companies").records():
            name = r.get("name", "")
            if not name:
                continue   # humans leave blank rows; not an anomaly
            out.append(Company(
                name=name, ats=r.get("ats", ""), slug=r.get("slug", ""),
                monitor=_truthy(r.get("monitor", "")),
                seeded=_truthy(r.get("seeded", "")),
                priority=_truthy(r.get("priority", "")),
            ))
        return [c for c in out if c.monitor]

    def _feed_record(self, r: dict) -> JobRecord:
        return JobRecord(
            id=r.get(schema.KEY, ""), company=r.get("company", ""),
            title=r.get("title", ""), location=r.get("location", ""),
            url=r.get("url", ""), status=r.get("status", "") or "New",
            first_seen=r.get("first_seen", ""), last_seen=r.get("last_seen", ""),
            posted=r.get("posted", ""),
        )

    def read_history(self) -> dict[str, JobRecord]:
        out: dict[str, JobRecord] = {}
        min_yoe: dict[str, str] = {}
        for r in self._hq.tab("feed").records():
            rec = self._feed_record(r)
            if not rec.id:
                continue
            out[rec.id] = rec
            min_yoe[rec.id] = r.get("min_yoe", "")
        self._min_yoe = min_yoe   # same read serves read_min_yoe — no second fetch
        return out

    def read_min_yoe(self) -> dict[str, str]:
        if self._min_yoe is None:
            self.read_history()
        return dict(self._min_yoe or {})

    def read_jobs_for_tagging(self) -> list[tuple[JobRecord, str]]:
        out = []
        for r in self._hq.tab("feed").records():
            rec = self._feed_record(r)
            if rec.id:
                out.append((rec, r.get("tagged_at", "")))
        return out

    # ---- writes

    def append_jobs(self, records: list[JobRecord],
                    tags: dict[str, "Tags"] | None = None, today: str = "") -> None:
        if not records:
            return
        tags = tags or {}
        rows = []
        for r in records:
            row: dict[str, Any] = {
                schema.KEY: r.id, "company": r.company, "title": r.title,
                "location": r.location, "url": r.url, "status": r.status,
                "first_seen": r.first_seen, "last_seen": r.last_seen,
                "posted": r.posted,
            }
            t = tags.get(r.id)
            if t is not None:   # discovery-time tags ride the append itself
                row.update(_tag_values(t))
                row["tagged_at"] = today
            row.update(geo.enrich(r.location, row.get("work_model", "")))
            rows.append(row)
        self._hq.tab("feed").append_records(rows)
        self._hq.log("monitor", "feed_append", detail=f"{len(rows)} rows ({len(tags)} tagged inline)")

    def fill_missing_geo(self, chunk: int = 120) -> int:
        """Nightly backfill: derive city/state/country/remote/market for feed
        rows that lack them (pre-geo rows, or work_model arrived after append).
        Deterministic — no LLM. Chunked to keep batch payloads sane."""
        rows = self._hq.tab("feed").records()
        todo: dict[str, dict[str, Any]] = {}
        for r in rows:
            key = r.get(schema.KEY, "")
            if not key or r.get("market", "").strip():
                continue
            if not (r.get("location", "").strip() or r.get("work_model", "").strip()):
                continue
            todo[key] = dict(geo.enrich(r.get("location", ""), r.get("work_model", "")))
        keys = list(todo)
        for i in range(0, len(keys), chunk):
            self._bulk_set_by_key({k: todo[k] for k in keys[i:i + chunk]})
        if todo:
            self._hq.log("review", "geo_fill", detail=f"{len(todo)} rows")
        return len(todo)

    def _bulk_set_by_key(self, values_by_key: dict[str, dict[str, Any]]) -> None:
        """Batched keyed writes on the feed tab: rows located fresh, one
        batch_update, one verifying batch_get (key cell + every written cell).
        Any row that moved mid-flight is redone through Tab.set_by_key, which
        re-locates and verifies again. Same guarantees as set_by_key at ~4 API
        calls total instead of ~5 per row — the hourly last_seen sweep touches
        every open role, which would otherwise eat the 60 req/min quota.
        """
        if not values_by_key:
            return
        from gspread.utils import rowcol_to_a1
        t = self._hq.tab("feed")
        hmap = t.header_map()
        idx = t.key_index()
        updates = []
        checks: list[tuple[str, str, str]] = []   # (key, a1, expected value)
        for key, vals in values_by_key.items():
            rownum = idx.get(key)
            if rownum is None:   # feed is bot-only; a vanished row is an anomaly
                raise RowNotFound(f"[feed] key {key!r} not found")
            checks.append((key, rowcol_to_a1(rownum, hmap[schema.KEY]), key))
            for h, v in vals.items():
                if h not in hmap:
                    raise SchemaAnomaly(f"[feed] no column {h!r}")
                a1 = rowcol_to_a1(rownum, hmap[h])
                v = "" if v is None else str(v)
                updates.append({"range": a1, "values": [[v]]})
                checks.append((key, a1, v))
        t.ws.batch_update(updates, value_input_option="RAW")
        # values_batch_get is a GET — too many ranges overflows the URL and
        # Google answers with an HTML error page. Sub-batch the verify reads.
        a1s = [a1 for _, a1, _ in checks]
        got = []
        for _i in range(0, len(a1s), 150):
            got.extend(t.ws.batch_get(a1s[_i:_i + 150]))
        moved = set()
        for (key, _a1, want), cell in zip(checks, got):
            have = str(cell[0][0] if cell and cell[0] else "").strip()
            if have != want.strip():
                moved.add(key)
        for key in moved:
            t.set_by_key(key, values_by_key[key])

    def set_status(self, id_to_status: dict[str, str]) -> None:
        self._bulk_set_by_key({jid: {"status": st} for jid, st in id_to_status.items()})
        if id_to_status:
            self._hq.log("monitor", "feed_status", detail=str(id_to_status)[:400])

    def set_last_seen(self, ids: list[str], today: str) -> None:
        self._bulk_set_by_key({jid: {"last_seen": today} for jid in ids})

    def mark_seeded(self, company_names: list[str]) -> None:
        t = self._hq.tab("companies")
        for name in company_names:
            t.set_by_key(name, {"seeded": "TRUE"}, key_header="name")
        if company_names:
            self._hq.log("monitor", "seeded", detail=", ".join(company_names)[:400])

    def mark_pushed(self, ids: list[str], today: str) -> None:
        """Fill-blank only: a role is pushed once; re-marks never clobber."""
        t = self._hq.tab("feed")
        for jid in ids:
            t.set_by_key(jid, {"pushed_at": today}, only_if_blank=True)

    def write_tags(self, id_to_tags: dict[str, "Tags"], today: str) -> None:
        updates = {}
        for jid, tags in id_to_tags.items():
            vals = _tag_values(tags)
            vals["tagged_at"] = today
            updates[jid] = vals
        self._bulk_set_by_key(updates)
        if id_to_tags:
            self._hq.log("review", "tags_written", detail=f"{len(id_to_tags)} rows")

    def write_health(self, rows: list[dict]) -> None:
        """Full snapshot per run: rewrite the bot-only health tab in place,
        blank-padding to the previous extent so stale rows vanish without a
        separate clear call (one RAW write, schema asserted first)."""
        t = self._hq.tab("health")
        hmap = t.header_map()   # loud abort BEFORE the destructive rewrite
        ncols = max(hmap.values())
        header = [""] * ncols
        for h, i in hmap.items():
            header[i - 1] = h
        grid = [header]
        for rec in rows:
            unknown = [k for k in rec if k not in hmap]
            if unknown:
                raise SchemaAnomaly(f"[health] no column for {unknown}")
            row = [""] * ncols
            for k, v in rec.items():
                row[hmap[k] - 1] = "" if v is None else str(v)
            grid.append(row)
        prev = len(t.ws.get_all_values())
        while len(grid) < prev:
            grid.append([""] * ncols)
        t.ws.update(grid, "A1", value_input_option="RAW")


class FakeSheetStore:
    """In-memory SheetStore for pure-logic tests (run/review flows). The real
    write paths are covered by HQFeedStore over core.fakes.fake_hq."""

    def __init__(self, companies, history, min_yoe: dict[str, str] | None = None):
        self._companies = list(companies)
        self._history = dict(history)
        self._min_yoe: dict[str, str] = dict(min_yoe or {})
        self._tags: dict[str, Any] = {}
        self._tagged_at: dict[str, str] = {}
        self.health_rows: list[dict] = []
        self.seeded_marks: list[str] = []
        self.pushed_marks: list[str] = []

    def read_companies(self):
        return [c for c in self._companies if c.monitor]

    def read_history(self):
        return dict(self._history)

    def read_min_yoe(self):
        return dict(self._min_yoe)

    def append_jobs(self, records, tags=None, today=""):
        tags = tags or {}
        for r in records:
            self._history[r.id] = r
            t = tags.get(r.id)
            if t is not None:
                self._tags[r.id] = t
                self._tagged_at[r.id] = today
                self._min_yoe[r.id] = str(t.min_yoe)

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

    def mark_pushed(self, ids, today):
        self.pushed_marks.extend(i for i in ids if i not in self.pushed_marks)

    def write_health(self, rows):
        self.health_rows = rows

    def read_jobs_for_tagging(self):
        return [(r, self._tagged_at.get(r.id, "")) for r in self._history.values()]

    def write_tags(self, id_to_tags, today):
        for jid, tags in id_to_tags.items():
            self._tags[jid] = tags
            self._tagged_at[jid] = today
            self._min_yoe[jid] = str(tags.min_yoe)

    def tags_for(self, jid):
        return self._tags.get(jid)
