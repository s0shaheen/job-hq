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
    specs = bootstrap._desired_protections(hq.sh, "o@x.com", "sa@x.com")
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
