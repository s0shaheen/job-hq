import errno

import pytest
import yaml

from core import config, schema
from core.fakes import FakeSpreadsheet
from tracker import bootstrap


def _fresh_sheet() -> FakeSpreadsheet:
    sh = FakeSpreadsheet()
    sh.add_worksheet("Sheet1")     # what a newborn spreadsheet looks like
    return sh


def _run(sh, tmp_path, **kw):
    return bootstrap.run(
        sh, sheet_id="SHEET123", owner="salman@example.com",
        sa_email="bot@sa.iam.gserviceaccount.com",
        reg_path=tmp_path / "hq.config.yaml", **kw)


def test_creates_all_tabs_and_renames_sheet1(tmp_path):
    sh = _fresh_sheet()
    _run(sh, tmp_path)
    titles = [w.title for w in sh.worksheets()]
    assert sorted(titles) == sorted(schema.TABS.values())
    assert "Sheet1" not in titles                      # folded into Pipeline
    assert len(titles) == len(schema.TABS)


def test_headers_written_per_schema(tmp_path):
    sh = _fresh_sheet()
    _run(sh, tmp_path)
    assert sh.worksheet("Pipeline").row_values(1) == schema.HEADERS["pipeline"]
    assert sh.worksheet("Feed").row_values(1) == schema.HEADERS["feed"]
    assert sh.worksheet("Scout — Jobs").row_values(1) == schema.HEADERS["scout_jobs"]


def test_scout_prefs_page_content(tmp_path):
    sh = _fresh_sheet()
    _run(sh, tmp_path)
    flat = " | ".join(c for row in sh.worksheet("Scout — Preferences").get_all_values()
                      for c in row if c)
    assert "Search Preferences — Salman Shaheen" in flat
    assert "1540 Trenton Lane" in flat and "Bartlett, IL 60103" in flat
    assert "DuPage" in flat
    assert "salmanshaheen.t@gmail.com" in flat
    assert "Salman sends it to you directly" in flat          # never the password itself
    assert "LinkedIn" in flat and "dna_companies" in flat
    assert "<RESUME_ALT_FOLDER_LINK>" in flat
    for t in list(config.defaults()["titles_include"])[:6]:   # top 6 titles listed
        assert t in flat


def test_config_seeded_from_defaults_with_descriptions(tmp_path):
    sh = _fresh_sheet()
    _run(sh, tmp_path)
    rows = {r[0]: (r[1], r[2]) for r in sh.worksheet("Config").get_all_values()[1:]}
    assert rows["yoe_push_max"][0] == "3"
    assert rows["push_new_jobs"][0] == "true"
    assert rows["titles_include"][0].startswith("product manager, associate product manager")
    assert "Capital One" in rows["dna_companies"][0]
    assert all(desc for _, desc in rows.values())              # every knob explained


def test_idempotent_rerun_no_duplicate_seeds(tmp_path):
    sh = _fresh_sheet()
    _run(sh, tmp_path)
    n_cfg = len(sh.worksheet("Config").get_all_values())
    n_tabs = len(sh.worksheets())
    _run(sh, tmp_path)
    assert len(sh.worksheet("Config").get_all_values()) == n_cfg
    assert len(sh.worksheets()) == n_tabs
    assert sh.worksheet("Pipeline").row_values(1) == schema.HEADERS["pipeline"]


def test_seed_companies_merges_and_bigtech_priority_wins(tmp_path):
    csv_dir = tmp_path / "monitor"
    csv_dir.mkdir()
    (csv_dir / "companies.seed.csv").write_text(
        "name,ats,slug,monitor,seeded\n"
        "Plaid,greenhouse,plaid,TRUE,FALSE\n"
        "Stripe,greenhouse,stripe,TRUE,FALSE\n")
    (csv_dir / "companies.bigtech.csv").write_text(     # note: casefold dup 'stripe'
        "name,ats,slug,monitor\n"
        "stripe,workday,stripe-wd,TRUE\n"
        "Google,google,google,TRUE\n")
    sh = _fresh_sheet()
    _run(sh, tmp_path, seed_companies_flag=True, csv_dir=csv_dir)
    rows = {r[0]: dict(zip(schema.HEADERS["companies"], r))
            for r in sh.worksheet("Companies").get_all_values()[1:]}
    assert set(rows) == {"Plaid", "Stripe", "Google"}
    assert rows["Stripe"]["ats"] == "greenhouse"        # first file wins ats/slug
    assert rows["Stripe"]["priority"] == "TRUE"         # bigtech flag merged on
    assert rows["Google"]["priority"] == "TRUE"         # bigtech default priority
    # re-run: no duplicates
    _run(sh, tmp_path, seed_companies_flag=True, csv_dir=csv_dir)
    assert len(sh.worksheet("Companies").get_all_values()) == 4


def test_registry_written_with_gids_and_preserves_other_keys(tmp_path):
    reg_path = tmp_path / "hq.config.yaml"
    reg_path.write_text("sheet_id: ''\ntabs: {}\nntfy:\n  jobs: t1\n  ops: t2\n")
    sh = _fresh_sheet()
    bootstrap.run(sh, sheet_id="SHEET123", owner="o@x.com", sa_email="sa@x.com",
                  reg_path=reg_path)
    reg = yaml.safe_load(reg_path.read_text())
    assert reg["sheet_id"] == "SHEET123"
    assert reg["owner_email"] == "o@x.com"
    assert reg["service_account_email"] == "sa@x.com"
    assert reg["ntfy"] == {"jobs": "t1", "ops": "t2"}          # untouched
    assert set(reg["tabs"]) == set(schema.TABS)
    assert all(isinstance(g, int) for g in reg["tabs"].values())
    assert reg_path.read_text().startswith("# Machine registry")


def _raise_oserror(errnum):
    def _f(*a, **k):
        raise OSError(errnum, "simulated")
    return _f


def test_write_registry_tolerates_read_only_fs(tmp_path, monkeypatch, capsys):
    # Lambda's /var/task is read-only: write_registry must skip the persist (not crash) so
    # selfheal's schema-heal still completes; an unrelated OSError must still fail loud.
    reg_path = tmp_path / "hq.config.yaml"
    monkeypatch.setattr(type(reg_path), "write_text", _raise_oserror(errno.EROFS))
    bootstrap.write_registry({"tabs": {}}, reg_path)               # tolerated, no raise
    assert "read-only" in capsys.readouterr().out
    assert not reg_path.exists()                                   # nothing persisted

    monkeypatch.setattr(type(reg_path), "write_text", _raise_oserror(errno.ENOSPC))
    with pytest.raises(OSError):
        bootstrap.write_registry({"tabs": {}}, reg_path)           # unrelated OSError still raises


def test_dry_run_touches_nothing(tmp_path):
    sh = _fresh_sheet()
    out = _run(sh, tmp_path, dry_run=True)
    assert out["dry_run"] is True
    assert len(out["missing_tabs"]) == len(schema.TABS)
    assert [w.title for w in sh.worksheets()] == ["Sheet1"]
    assert not (tmp_path / "hq.config.yaml").exists()
