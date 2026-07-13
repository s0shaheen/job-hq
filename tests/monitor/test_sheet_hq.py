"""HQFeedStore over core.fakes — the real write paths, including the
human-chaos cases (sorts mid-run, extra columns, missing headers)."""
import pytest

from core import schema
from core.fakes import fake_hq
from core.sheets import RowNotFound, SchemaAnomaly
from monitor.models import JobRecord
from monitor.sheet import HQFeedStore
from monitor.tagging import Tags

TODAY = "2026-07-13"


def _hq():
    return fake_hq(["feed", "companies", "health", "log", "config"])


def _rec(jid, company="Acme", title="PM", status="New"):
    return JobRecord(id=jid, company=company, title=title, location="NYC",
                     url=f"http://x/{jid}", status=status,
                     first_seen=TODAY, last_seen=TODAY, posted="")


def _feed_row(hq, key):
    rows = [r for r in hq.tab("feed").records() if r[schema.KEY] == key]
    assert len(rows) == 1, f"expected exactly one feed row for {key}"
    return rows[0]


# ---- companies

def test_read_companies_parses_flags_and_filters_monitor():
    hq = _hq()
    hq.tab("companies").append_records([
        {"name": "Stripe", "ats": "greenhouse", "slug": "stripe",
         "monitor": "TRUE", "seeded": "FALSE", "priority": "TRUE"},
        {"name": "Old", "ats": "lever", "slug": "old",
         "monitor": "FALSE", "seeded": "TRUE"},
        {"name": "", "ats": "", "slug": ""},   # human blank row is ignored
    ])
    got = HQFeedStore(hq).read_companies()
    assert [c.name for c in got] == ["Stripe"]
    assert got[0].priority is True and got[0].seeded is False


def test_mark_seeded_flips_only_named_companies():
    hq = _hq()
    hq.tab("companies").append_records([
        {"name": "Stripe", "ats": "greenhouse", "slug": "stripe", "monitor": "TRUE"},
        {"name": "Ramp", "ats": "ashby", "slug": "ramp", "monitor": "TRUE"},
    ])
    HQFeedStore(hq).mark_seeded(["Stripe"])
    rows = {r["name"]: r for r in hq.tab("companies").records()}
    assert rows["Stripe"]["seeded"] == "TRUE"
    assert rows["Ramp"]["seeded"] == ""


# ---- feed appends + reads

def test_append_and_read_history_roundtrip_on_key_column():
    hq = _hq()
    store = HQFeedStore(hq)
    store.append_jobs([_rec("greenhouse-1")])
    hist = store.read_history()
    assert hist["greenhouse-1"].title == "PM"
    assert _feed_row(hq, "greenhouse-1")["status"] == "New"


def test_append_with_tags_writes_tag_block_min_yoe_and_tagged_at():
    hq = _hq()
    store = HQFeedStore(hq)
    tags = Tags(yoe="3+", seniority="Senior", company_industry="Fintech",
                role_focus="Payments", skills="SQL; APIs", comp_range="$180k-$210k",
                work_model="Remote (US)")
    store.append_jobs([_rec("greenhouse-1")], tags={"greenhouse-1": tags}, today=TODAY)
    row = _feed_row(hq, "greenhouse-1")
    assert row["yoe"] == "3+"
    assert row["min_yoe"] == "3"
    assert row["comp_range"] == "$180k-$210k"
    assert row["tagged_at"] == TODAY


def test_append_without_tags_leaves_tag_columns_blank():
    hq = _hq()
    HQFeedStore(hq).append_jobs([_rec("lever-9")])
    row = _feed_row(hq, "lever-9")
    assert row["tagged_at"] == "" and row["min_yoe"] == "" and row["yoe"] == ""


def test_human_added_feed_column_never_breaks_appends():
    hq = _hq()
    ws = hq.tab("feed").ws
    ws._grid[0] = ["scratch"] + ws._grid[0]   # human inserts a column at A
    store = HQFeedStore(hq)
    store.append_jobs([_rec("greenhouse-7", company="Plaid")])
    row = _feed_row(hq, "greenhouse-7")
    assert row["company"] == "Plaid" and row["url"] == "http://x/greenhouse-7"


def test_missing_required_feed_header_aborts_loudly():
    hq = _hq()
    ws = hq.tab("feed").ws
    ws._grid[0] = [h for h in ws._grid[0] if h != "status"]   # header vandalism
    with pytest.raises(SchemaAnomaly):
        HQFeedStore(hq).append_jobs([_rec("greenhouse-1")])


# ---- keyed updates

def test_set_status_and_last_seen_by_key():
    hq = _hq()
    store = HQFeedStore(hq)
    store.append_jobs([_rec("greenhouse-1"), _rec("greenhouse-2")])
    store.set_status({"greenhouse-1": "Closed"})
    store.set_last_seen(["greenhouse-2"], "2026-07-14")
    assert _feed_row(hq, "greenhouse-1")["status"] == "Closed"
    assert _feed_row(hq, "greenhouse-2")["last_seen"] == "2026-07-14"
    assert _feed_row(hq, "greenhouse-2")["status"] == "New"   # untouched


def test_bulk_updates_survive_human_sort_between_read_and_write():
    hq = _hq()
    store = HQFeedStore(hq)
    store.append_jobs([_rec(f"greenhouse-{i}", title=f"PM {i}") for i in range(5)])
    hq.tab("feed").ws.sort_data_rows(by_col=3, reverse=True)   # sort by title desc
    store.set_status({"greenhouse-0": "Closed"})
    assert _feed_row(hq, "greenhouse-0")["status"] == "Closed"
    assert _feed_row(hq, "greenhouse-4")["status"] == "New"


def test_set_status_unknown_key_aborts_loudly():
    hq = _hq()
    store = HQFeedStore(hq)
    store.append_jobs([_rec("greenhouse-1")])
    with pytest.raises(RowNotFound):
        store.set_status({"vanished-999": "Closed"})


def test_mark_pushed_fills_blank_only():
    hq = _hq()
    store = HQFeedStore(hq)
    store.append_jobs([_rec("greenhouse-1")])
    store.mark_pushed(["greenhouse-1"], TODAY)
    store.mark_pushed(["greenhouse-1"], "2026-07-20")   # re-mark must not clobber
    assert _feed_row(hq, "greenhouse-1")["pushed_at"] == TODAY


# ---- tagging IO

def test_read_jobs_for_tagging_returns_tagged_at():
    hq = _hq()
    store = HQFeedStore(hq)
    store.append_jobs([_rec("greenhouse-1")],
                      tags={"greenhouse-1": Tags(yoe="2-4")}, today="2026-07-01")
    store.append_jobs([_rec("greenhouse-2")])
    by_id = {r.id: t for r, t in store.read_jobs_for_tagging()}
    assert by_id["greenhouse-1"] == "2026-07-01"
    assert by_id["greenhouse-2"] == ""


def test_write_tags_updates_block_min_yoe_and_stamp():
    hq = _hq()
    store = HQFeedStore(hq)
    store.append_jobs([_rec("greenhouse-1")])
    store.write_tags({"greenhouse-1": Tags(yoe="2-4", seniority="PM", skills="SQL")},
                     TODAY)
    row = _feed_row(hq, "greenhouse-1")
    assert row["yoe"] == "2-4" and row["min_yoe"] == "2"
    assert row["skills"] == "SQL" and row["tagged_at"] == TODAY


def test_read_min_yoe_serves_from_feed():
    hq = _hq()
    store = HQFeedStore(hq)
    store.append_jobs([_rec("greenhouse-1")], tags={"greenhouse-1": Tags(yoe="5+")},
                      today=TODAY)
    fresh = HQFeedStore(hq)   # cold store: read_min_yoe triggers its own read
    assert fresh.read_min_yoe()["greenhouse-1"] == "5"


# ---- health

def test_write_health_full_snapshot_replaces_previous_rows():
    hq = _hq()
    store = HQFeedStore(hq)
    store.write_health([
        {"company": "A", "ats": "greenhouse", "result": "OK", "count": 3,
         "message": "", "checked_at": TODAY},
        {"company": "B", "ats": "lever", "result": "ERROR", "count": 0,
         "message": "boom", "checked_at": TODAY},
        {"company": "C", "ats": "ashby", "result": "ZERO", "count": 0,
         "message": "", "checked_at": TODAY},
    ])
    store.write_health([
        {"company": "A", "ats": "greenhouse", "result": "OK", "count": 4,
         "message": "", "checked_at": "2026-07-14"},
    ])
    live = [r for r in hq.tab("health").records() if r["company"]]
    assert len(live) == 1
    assert live[0]["count"] == "4"


def test_write_health_unknown_column_aborts():
    hq = _hq()
    with pytest.raises(SchemaAnomaly):
        HQFeedStore(hq).write_health([{"company": "A", "made_up": "x"}])
