import pytest

from core import schema
from core.fakes import fake_hq
from core.sheets import RowNotFound, SchemaAnomaly, ensure_headers


def _pipeline(hq):
    return hq.tab("pipeline")


def test_append_and_records_roundtrip():
    hq = fake_hq(["pipeline", "log", "config"])
    t = _pipeline(hq)
    t.append_records([{"key": "greenhouse-1", "company": "Plaid", "title": "PM", "status": "Queued"}])
    recs = t.records()
    assert recs[0]["key"] == "greenhouse-1"
    assert recs[0]["company"] == "Plaid"
    assert recs[0]["notes"] == ""


def test_append_unknown_column_aborts():
    hq = fake_hq(["pipeline"])
    with pytest.raises(SchemaAnomaly):
        _pipeline(hq).append_records([{"key": "x", "made_up_col": "v"}])


def test_set_by_key_only_if_blank_human_wins():
    hq = fake_hq(["pipeline"])
    t = _pipeline(hq)
    t.append_records([{"key": "k1", "company": "A", "notes": "human wrote this"}])
    out = t.set_by_key("k1", {"notes": "bot value", "comp": "$150K"}, only_if_blank=True)
    assert out == {"notes": "kept", "comp": "written"}
    recs = t.records()
    assert recs[0]["notes"] == "human wrote this"
    assert recs[0]["comp"] == "$150K"


def test_set_by_key_survives_human_sort_between_reads():
    hq = fake_hq(["pipeline"])
    t = _pipeline(hq)
    t.append_records([{"key": f"k{i}", "company": f"C{i}"} for i in range(5)])
    t.ws.sort_data_rows(by_col=2, reverse=True)   # human sorts by company desc
    t.set_by_key("k1", {"status": "Applied"})
    rec = [r for r in t.records() if r["key"] == "k1"][0]
    assert rec["status"] == "Applied"
    others = [r for r in t.records() if r["key"] != "k1"]
    assert all(r["status"] == "" for r in others)


def test_reordered_and_extra_columns_are_harmless():
    hq = fake_hq(["pipeline"])
    t = _pipeline(hq)
    # human inserts a personal column at A and reorders by rewriting the header
    grid = t.ws._grid
    grid[0] = ["my color"] + grid[0]
    for r in grid[1:]:
        r.insert(0, "")
    t.append_records([{"key": "k9", "company": "Rho"}])
    t.set_by_key("k9", {"location": "NYC"})
    rec = [r for r in t.records() if r["key"] == "k9"][0]
    assert rec["company"] == "Rho" and rec["location"] == "NYC"


def test_duplicate_key_aborts_loudly():
    hq = fake_hq(["pipeline"])
    t = _pipeline(hq)
    t.append_records([{"key": "dup"}, {"key": "dup"}])
    with pytest.raises(SchemaAnomaly):
        t.set_by_key("dup", {"company": "X"})


def test_missing_required_header_aborts():
    hq = fake_hq(["pipeline"])
    t = _pipeline(hq)
    t.ws._grid[0] = [h for h in t.ws._grid[0] if h != "status"]   # human deleted a bot column
    with pytest.raises(SchemaAnomaly):
        t.header_map()


def test_row_not_found():
    hq = fake_hq(["pipeline"])
    with pytest.raises(RowNotFound):
        _pipeline(hq).set_by_key("nope", {"company": "X"})


def test_advance_status_forward_only_and_human_status_untouchable():
    hq = fake_hq(["pipeline"])
    t = _pipeline(hq)
    t.append_records([{"key": "k1", "status": "Queued"},
                      {"key": "k2", "status": "Interview"},
                      {"key": "k3", "status": "my custom stage"}])
    assert t.advance_status("k1", "Applied", evidence="gmail://x") == "advanced"
    assert t.advance_status("k2", "Applied") == "kept"        # never downgrade
    assert t.advance_status("k3", "Offer") == "kept"          # human status wins
    rec = [r for r in t.records() if r["key"] == "k1"][0]
    assert rec["evidence"] == "gmail://x"
    assert rec["last_activity"] != ""


def test_status_rank_ordering():
    assert schema.status_rank("Inbox") < schema.status_rank("Applied") < schema.status_rank("Offer")
    assert schema.status_rank("Rejected") > schema.status_rank("Offer")
    assert schema.status_rank("weird human thing") > schema.status_rank("Rejected")


def test_ensure_headers_appends_missing_to_right_only():
    hq = fake_hq(["pipeline"])
    ws = hq.tab("pipeline").ws
    ws._grid[0] = ["key", "company", "my notes col"]           # human-trimmed sheet
    repairs = ensure_headers(ws, schema.HEADERS["pipeline"])
    assert repairs
    hdr = ws.row_values(1)
    assert hdr[:3] == ["key", "company", "my notes col"]       # human layout untouched
    assert set(schema.HEADERS["pipeline"]).issubset(set(hdr))  # bot columns restored


def test_log_and_heartbeat_never_raise():
    hq = fake_hq(["log", "config"])
    hq.log("test", "did_thing", "k", "detail")
    hq.heartbeat("unit")
    cfg_rows = hq.tab("config").records()
    assert any(r["key"] == "heartbeat_unit" for r in cfg_rows)
    hq.heartbeat("unit")   # upsert path
    assert sum(1 for r in hq.tab("config").records() if r["key"] == "heartbeat_unit") == 1


def test_user_config_validation_falls_back():
    hq = fake_hq(["config"])
    hq.tab("config").append_records([
        {"key": "yoe_push_max", "value": "6"},
        {"key": "stale_days", "value": "banana"},
        {"key": "unknown_key", "value": "whatever"},
    ])
    cfg = hq.user_config()
    assert cfg["yoe_push_max"] == 6
    assert cfg["stale_days"] == 30            # default kept
    assert any("stale_days" in p for p in cfg.problems)
