import yaml

from core import schema
from core.fakes import fake_hq
from tracker import bootstrap, selfheal


def _reg_file(tmp_path, hq, **overrides):
    reg = {"sheet_id": "SHEET123",
           "tabs": dict(hq.registry["tabs"]),
           "owner_email": "o@x.com", "service_account_email": "sa@x.com",
           "ntfy": {"jobs": "", "ops": ""}}
    reg.update(overrides)
    p = tmp_path / "hq.config.yaml"
    p.write_text(yaml.safe_dump(reg, sort_keys=False))
    return p


def test_repairs_deleted_header_and_alerts(tmp_path, monkeypatch):
    alerts = []
    monkeypatch.setattr("core.notify.ops_alert", lambda t, b, **k: alerts.append((t, b)))
    hq = fake_hq()
    ws = hq.tab("pipeline").ws
    ws._grid[0] = [h for h in ws._grid[0] if h != "status"]   # human deleted a bot column
    p = _reg_file(tmp_path, hq)
    repairs = selfheal.run(hq, reg_path=p)
    assert any("status" in r for r in repairs)
    assert "status" in ws.row_values(1)                       # restored (appended right)
    assert alerts and alerts[0][0] == "HQ self-heal made repairs"
    cfg = {r["key"]: r for r in hq.tab("config").records()}
    assert "heartbeat_selfheal" in cfg


def test_recreates_deleted_tab_and_repins_gids(tmp_path, capsys):
    hq = fake_hq()
    dead = hq.sh.worksheet(schema.TABS["digest"])
    hq.sh._sheets.remove(dead)                                # human deleted the tab
    p = _reg_file(tmp_path, hq)                               # registry still has old gid
    repairs = selfheal.run(hq, reg_path=p)
    assert any("created tab" in r for r in repairs)
    assert any("re-pinned" in r for r in repairs)
    live = {w.title: w.id for w in hq.sh.worksheets()}
    reg = yaml.safe_load(p.read_text())
    assert reg["tabs"]["digest"] == live[schema.TABS["digest"]]
    assert "digest" in capsys.readouterr().out                # corrected yaml printed


def test_quiet_run_no_repairs_no_alert(tmp_path, monkeypatch):
    alerts = []
    monkeypatch.setattr("core.notify.ops_alert", lambda t, b, **k: alerts.append(t))
    hq = fake_hq()
    p = _reg_file(tmp_path, hq)
    selfheal.run(hq, reg_path=p)     # first run: adds protections into the fake void
    # fake can't record protections; simulate a live sheet where they all exist
    specs = bootstrap._desired_protections(
        bootstrap.resolve_tabs(hq.sh, hq.registry["tabs"]), "o@x.com", "sa@x.com")
    existing = [{"_sheetId": s["ws"].id, "description": s["description"]} for s in specs]
    monkeypatch.setattr("core.sheets.list_protections", lambda sh: existing)
    alerts.clear()
    repairs = selfheal.run(hq, reg_path=p)
    assert repairs == []
    assert alerts == []


def test_first_run_without_registry_file_writes_one(tmp_path):
    hq = fake_hq()
    p = tmp_path / "hq.config.yaml"
    selfheal.run(hq, reg_path=p)
    reg = yaml.safe_load(p.read_text())
    assert set(reg["tabs"]) == set(schema.TABS)


def test_dedupe_keys_keeps_first_and_repairs(monkeypatch):
    from core.fakes import fake_hq
    from tracker import selfheal
    hq = fake_hq(["feed", "pipeline", "log", "config"])
    t = hq.tab("feed")
    t.append_records([
        {"key": "greenhouse-1", "company": "A", "title": "tagged first", "status": "New"},
        {"key": "greenhouse-2", "company": "B", "status": "New"},
        {"key": "greenhouse-1", "company": "A", "title": "raced dup", "status": "New"},
        {"key": "greenhouse-2", "company": "B", "status": "New"},
    ])
    repairs = selfheal.dedupe_keys(hq, "feed")
    assert len(repairs) == 2
    rows = t.records()
    assert [r["key"] for r in rows] == ["greenhouse-1", "greenhouse-2"]
    assert rows[0]["title"] == "tagged first"      # first occurrence kept
    t.key_index()                                   # no longer raises


def test_trim_leading_blanks_collapses_bootstrap_gap():
    from core.fakes import fake_hq
    from tracker import selfheal
    hq = fake_hq(["feed"])
    ws = hq.tab("feed").ws
    ws._grid.extend([[] for _ in range(199)])                       # bootstrap's blank grid
    hq.tab("feed").append_records([{"key": "greenhouse-9", "company": "X", "status": "New"}])
    ws._grid.append(["greenhouse-10", "Y"])                         # data even further down
    assert selfheal.trim_leading_blanks(hq, "feed") == ["[feed] trimmed 199 blank rows above the data"]
    rows = hq.tab("feed").records()
    assert rows[0]["key"] == "greenhouse-9"                         # data now at row 2
    assert selfheal.trim_leading_blanks(hq, "feed") == []           # idempotent


def test_reconcile_adopts_renamed_tab_and_deletes_empty_duplicate():
    from core import schema
    from core.fakes import fake_hq
    from tracker import selfheal
    hq = fake_hq()
    # simulate the incident: user renamed Scout — Jobs; a title-based pass
    # recreated an empty duplicate and the registry got pinned to it
    real = hq.sh.worksheet(schema.TABS["scout_jobs"])
    real.title = "Raza — Jobs"
    hq.tab("scout_jobs").append_records({0: None} and [
        {"Job No": "SS", "Company": "Abridge", "Position": "PM",
         "Job Link": "https://jobs.ashbyhq.com/abridge/bdbe64c1-cb3e-4ba6-a0fe-0bf76372a673",
         "Applied": "TRUE"}])
    dup = hq.sh.add_worksheet(schema.TABS["scout_jobs"])
    dup.update([list(schema.HEADERS["scout_jobs"])], "A1")
    reg = {"tabs": dict(hq.registry["tabs"])}
    reg["tabs"]["scout_jobs"] = dup.id                      # mis-pinned at the empty one
    repairs = selfheal.reconcile_renamed(hq, reg)
    assert any("Raza — Jobs" in r for r in repairs)
    assert reg["tabs"]["scout_jobs"] == real.id             # re-pinned to the data tab
    assert all(w.title != schema.TABS["scout_jobs"] for w in hq.sh.worksheets())  # dup gone


def test_assert_structure_adopts_renamed_tab_by_gid():
    from core import schema
    from core.fakes import fake_hq
    from tracker import bootstrap
    hq = fake_hq()
    ws = hq.sh.worksheet(schema.TABS["feed"])
    ws.title = "My Custom Feed Name"
    before = len(hq.sh.worksheets())
    repairs = bootstrap.assert_structure(hq.sh, owner="o@x.com", sa_email="sa@x.com",
                                         tabs_gids=hq.registry["tabs"])
    assert len(hq.sh.worksheets()) == before                # nothing recreated
    assert not any("created tab" in r and "Feed" in r for r in repairs)


def test_trim_treats_checkbox_false_as_blank():
    from core.fakes import fake_hq
    from tracker import selfheal
    hq = fake_hq(["feed"])
    ws = hq.tab("feed").ws
    hmap = hq.tab("feed").header_map()
    icol = hmap["interested"]
    for _ in range(50):                                     # blank grid rows w/ materialized FALSE
        row = [""] * icol
        row[icol - 1] = "FALSE"
        ws._grid.append(row)
    ws._grid.append(["greenhouse-77", "RealCo"])
    assert selfheal.trim_leading_blanks(hq, "feed") == ["[feed] trimmed 50 blank rows above the data"]
    assert hq.tab("feed").records()[0]["key"] == "greenhouse-77"
