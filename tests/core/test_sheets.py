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


# ---- grid width: a worksheet's column count is FIXED, not auto-growing.
# This is what blocked self-heal in production: the Feed schema grew past the
# 26-column default, so the header write returned 400 "exceeds grid limits" —
# and until the header exists, every writer on that tab aborts.

def test_ensure_headers_widens_the_grid_before_writing_past_it():
    from core import fakes, schema, sheets
    ws = fakes.FakeWorksheet("Feed", col_count=26)
    ws.update([["key", "company"]], "A1")
    headers = schema.HEADERS["feed"]
    assert len(headers) > 26, "this test is only meaningful past the default width"

    repairs = sheets.ensure_headers(ws, headers)

    assert ws.col_count >= len(headers)
    assert any("widened" in r for r in repairs)
    live = [h for h in ws.row_values(1) if h]
    for h in headers:
        assert h in live, h


def test_a_narrow_grid_rejects_writes_instead_of_growing():
    # the fake models the real API: without the widen above, this is a 400
    from core import fakes
    ws = fakes.FakeWorksheet("Feed", col_count=26)
    with pytest.raises(fakes.GridLimitError):
        ws.update([["x"]], "AA1")


def test_new_tabs_are_created_wide_enough_for_their_schema():
    # provisioning a fresh sheet must not create a tab too narrow to hold its
    # own header row (which would fail on the very first write)
    from core import fakes, schema, sheets
    sh = fakes.FakeSpreadsheet()
    ws, created = sheets.ensure_tab(sh, "Feed", headers=schema.HEADERS["feed"])
    assert created and ws.col_count >= len(schema.HEADERS["feed"])
    sheets.ensure_headers(ws, schema.HEADERS["feed"])   # must not raise


# ------------------------------------------------ the human-wins lock (AC 14)

def test_advance_status_refuses_a_row_a_human_claimed():
    """Acceptance criterion 14, at the sheet layer.

    Rank alone cannot express "a person chose this": `Rejected` ranks above
    `Offer`, so a 0.99-confidence rejection used to overwrite an Offer a human
    had set. `status_actor = user` is the lock, and it holds for EVERY
    canonical target — including ones that rank far above the current value.
    """
    hq = fake_hq(["pipeline"])
    t = _pipeline(hq)
    t.append_records([{"key": "locked", "status": "Offer", "status_actor": "user"},
                      {"key": "open", "status": "Offer", "status_actor": "system"},
                      {"key": "blank", "status": "Applied"}])

    for target in schema.STATUSES:
        assert t.advance_status("locked", target) == "locked", target
    assert [r for r in t.records() if r["key"] == "locked"][0]["status"] == "Offer"

    # The positive control. Without it this test would keep passing with the
    # lock hardcoded to fire on every row — the "a negative assertion is only
    # meaningful beside its positive control" rule from docs/WEBAPP-BUILD.md.
    assert t.advance_status("open", "Rejected") == "advanced"
    assert t.advance_status("blank", "Interview") == "advanced"


def test_advance_status_lock_is_case_and_whitespace_tolerant():
    """The cell is a dropdown, but a human can paste over a dropdown and the
    sheet keeps the pasted text. A lock that only recognises exactly `user` is
    a lock that silently opens."""
    hq = fake_hq(["pipeline"])
    t = _pipeline(hq)
    t.append_records([{"key": "k1", "status": "Applied", "status_actor": " User "}])
    assert t.advance_status("k1", "Interview") == "locked"


def test_resolved_statuses_outrank_terminal_and_stay_below_invented():
    assert (schema.status_rank("Offer")
            < schema.status_rank("Rejected")
            < schema.status_rank("Offer-Accepted")
            < schema.status_rank("some human thing"))


def test_no_bot_rule_can_name_a_human_only_status():
    """`STATUS_RESOLVED` is human-only, and the enforcement is that the table of
    bot-writable statuses cannot name one. Asserted here because that table is
    hand-edited: adding an `offer_accepted` event type with a hard rule would
    otherwise end someone\'s search from a classified email."""
    named = {s for s, _hard in schema.EVENT_STATUS_RULES.values() if s}
    assert named.isdisjoint(schema.STATUS_RESOLVED), named & set(schema.STATUS_RESOLVED)


def test_status_vocabulary_has_no_duplicates_across_its_three_tiers():
    """A value in two tiers would rank as whichever branch ran first, which is
    an ordering nobody wrote down."""
    assert len(schema.STATUSES) == len(set(schema.STATUSES))
