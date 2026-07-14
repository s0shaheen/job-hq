from core.fakes import fake_hq
from monitor.config import get_runtime_config, unconfigured_reason


def test_runtime_config_defaults_from_committed_file():
    cfg = get_runtime_config(fake_hq(["config"]))
    assert "product manager" in cfg.include
    assert "product marketing" in cfg.exclude
    assert cfg.workday_search == "product"
    assert cfg.yoe_push_max == 3
    assert cfg.push_new_jobs is True
    assert cfg.problems == []


def test_runtime_config_sheet_overrides_win():
    hq = fake_hq(["config"])
    hq.tab("config").append_records([
        {"key": "yoe_push_max", "value": "6"},
        {"key": "push_new_jobs", "value": "false"},
        {"key": "titles_include", "value": "product manager, product lead"},
        {"key": "workday_search", "value": "platform"},
    ])
    cfg = get_runtime_config(hq)
    assert cfg.yoe_push_max == 6
    assert cfg.push_new_jobs is False
    assert cfg.include == ["product manager", "product lead"]
    assert cfg.workday_search == "platform"


def test_runtime_config_invalid_value_falls_back_and_reports():
    hq = fake_hq(["config"])
    hq.tab("config").append_records([{"key": "yoe_push_max", "value": "banana"}])
    cfg = get_runtime_config(hq)
    assert cfg.yoe_push_max == 3                       # committed default kept
    assert any("yoe_push_max" in p for p in cfg.problems)


def test_unconfigured_reason_when_sheet_id_unset(monkeypatch):
    monkeypatch.setattr("core.config.sheet_id", lambda: "")
    reason = unconfigured_reason()
    assert reason is not None and "bootstrap" in reason


def test_unconfigured_reason_none_when_pinned(monkeypatch):
    monkeypatch.setattr("core.config.sheet_id", lambda: "1RealSheetId")
    assert unconfigured_reason() is None
