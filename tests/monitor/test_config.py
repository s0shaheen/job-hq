from core import config as core_config
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


def test_empty_titles_is_a_reported_problem(monkeypatch):
    """#252: a resolved title filter that comes back EMPTY is a halted
    discovery, not a quiet day — it must land in .problems, which
    monitor.run.main() already pages before the sweep. Emptiness is injected
    at the committed-defaults layer because that is exactly the state RM-40
    Step 4 ships (persona-free defaults) plus a blank/absent Config cell."""
    bare = {**core_config.defaults(), "titles_include": []}
    monkeypatch.setattr("core.config.defaults", lambda: bare)
    cfg = get_runtime_config(fake_hq(["config"]))
    assert cfg.include == []
    assert any("titles_include" in p for p in cfg.problems), cfg.problems


def test_present_titles_report_no_titles_problem():
    """The counterexample: a configured search stays problem-free, so the
    live lane's runs page nothing new."""
    hq = fake_hq(["config"])
    hq.tab("config").append_records([
        {"key": "titles_include", "value": "product manager"}])
    cfg = get_runtime_config(hq)
    assert cfg.include == ["product manager"]
    assert not any("titles_include" in p for p in cfg.problems)


def test_unconfigured_reason_when_sheet_id_unset(monkeypatch):
    monkeypatch.setattr("core.config.sheet_id", lambda: "")
    reason = unconfigured_reason()
    assert reason is not None and "bootstrap" in reason


def test_unconfigured_reason_none_when_pinned(monkeypatch):
    monkeypatch.setattr("core.config.sheet_id", lambda: "1RealSheetId")
    assert unconfigured_reason() is None
