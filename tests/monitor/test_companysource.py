"""The Phase B switch. All pg stubbed; the default path must be byte-faithful to the sheet."""
import pytest

from monitor import companysource as cs
from monitor.models import Company
from monitor.universe import UniverseSlice


class _Store:
    def __init__(self, companies):
        self._c = companies
        self.reads = 0
    def read_companies(self):
        self.reads += 1
        return self._c


SHEET = [Company(name="Stripe", ats="greenhouse", slug="stripe", monitor=True),
         Company(name="Plaid", ats="greenhouse", slug="plaid", monitor=True)]


def _pg_slice(companies, unpullable=()):
    s = UniverseSlice()
    s.companies.extend(companies)
    s.unpullable.extend(unpullable)
    return s


def test_default_is_the_sheet_and_pg_is_never_consulted(monkeypatch):
    monkeypatch.delenv(cs.SOURCE_ENV, raising=False)
    monkeypatch.setattr("core.pg.enabled", lambda: False)
    monkeypatch.setattr("monitor.universe.swept_companies",
                        lambda uid, session=None: pytest.fail("pg consulted in sheet mode with pg off"))
    store = _Store(SHEET)
    assert cs.resolve(store) == SHEET and store.reads == 1


def test_sheet_mode_with_pg_logs_the_soak_delta(monkeypatch, capsys):
    monkeypatch.setenv(cs.SOURCE_ENV, "sheet")
    monkeypatch.setenv(cs.USER_ENV, "u-1")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    monkeypatch.setattr("monitor.universe.swept_companies",
                        lambda uid, session=None: _pg_slice(SHEET[:1]))
    assert cs.resolve(_Store(SHEET)) == SHEET
    out = capsys.readouterr().out
    assert "soak delta" in out and "sheet=2 pg=1" in out and "greenhouse/plaid" in out


def test_soak_delta_failure_never_fails_the_sweep(monkeypatch, capsys):
    monkeypatch.setenv(cs.SOURCE_ENV, "sheet")
    monkeypatch.setenv(cs.USER_ENV, "u-1")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    def boom(uid, session=None): raise RuntimeError("pg down")
    monkeypatch.setattr("monitor.universe.swept_companies", boom)
    assert cs.resolve(_Store(SHEET)) == SHEET
    assert "soak delta unavailable" in capsys.readouterr().out


def test_pg_mode_swaps_the_source(monkeypatch, capsys):
    monkeypatch.setenv(cs.SOURCE_ENV, "pg")
    monkeypatch.setenv(cs.USER_ENV, "u-1")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    monkeypatch.setattr("monitor.universe.swept_companies",
                        lambda uid, session=None: _pg_slice(SHEET[:1], unpullable=["Mystery"]))
    store = _Store(SHEET)
    assert cs.resolve(store) == SHEET[:1]
    assert store.reads == 0                        # the sheet is no longer consulted
    assert "approved-but-boardless" in capsys.readouterr().out


def test_pg_mode_without_creds_refuses_loudly(monkeypatch):
    monkeypatch.setenv(cs.SOURCE_ENV, "pg")
    monkeypatch.delenv(cs.USER_ENV, raising=False)
    monkeypatch.setattr("core.pg.enabled", lambda: False)
    with pytest.raises(RuntimeError, match="refusing to sweep nothing"):
        cs.resolve(_Store(SHEET))


def test_pg_mode_empty_universe_against_a_full_sheet_aborts(monkeypatch):
    monkeypatch.setenv(cs.SOURCE_ENV, "pg")
    monkeypatch.setenv(cs.USER_ENV, "u-1")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    monkeypatch.setattr("monitor.universe.swept_companies",
                        lambda uid, session=None: _pg_slice([]))
    with pytest.raises(RuntimeError, match="misconfigured universe"):
        cs.resolve(_Store(SHEET))
