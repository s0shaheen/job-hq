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


# ---- RM-12: the sheet branch is not the sheet branch when the store is Postgres.

def test_the_sheet_branch_refuses_while_the_feed_store_is_postgres(monkeypatch):
    """Finding 4 of the first review, and it disabled two instruments at once.

    This module's `sheet` branch reads the company list THROUGH the store. With a
    Postgres feed store that call IS `universe.swept_companies`, so the soak delta —
    the measurement the flip decision is read off — compared Postgres against
    Postgres and reported `sheet=1 pg=1 sheet_only=0 pg_only=0`, perfect agreement by
    construction, forever. An instrument that cannot disagree is not an instrument.

    KILLED BY: deleting the guard — the sheet branch then silently becomes the pg
    branch under the sheet branch's name.
    """
    from monitor import feedstore
    monkeypatch.setenv(feedstore.STORE_ENV, feedstore.PG)
    monkeypatch.delenv(cs.SOURCE_ENV, raising=False)
    with pytest.raises(RuntimeError, match=r"requires HQ_COMPANIES_SOURCE=pg"):
        cs.resolve(_Store(SHEET))


def test_an_empty_pg_universe_is_fatal_when_there_is_no_sheet_to_compare_with(
        monkeypatch):
    """The other half of finding 4: the empty-universe guard compared the pg count
    against `store.read_companies()`, which under a Postgres store runs the SAME
    query and answers 0 — so the guard passed, the sweep visited no boards,
    quarantined nothing and exited 0. That is the silent-death shape this module's
    own docstring forbids, arriving through the guard meant to prevent it.

    KILLED BY: removing the `store_is_pg` arm — the run then returns an empty list.
    """
    from monitor import feedstore
    monkeypatch.setenv(feedstore.STORE_ENV, feedstore.PG)
    monkeypatch.setenv(cs.SOURCE_ENV, "pg")
    monkeypatch.setenv(cs.USER_ENV, "u-1")
    monkeypatch.setattr("core.pg.enabled", lambda: True)
    monkeypatch.setattr("monitor.universe.swept_companies",
                        lambda uid, session=None: _pg_slice([]))
    with pytest.raises(RuntimeError, match="no independent list to compare against"):
        cs.resolve(_Store([]))
