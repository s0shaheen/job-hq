"""The cutover switch, and the four ways it must refuse rather than revert.

`monitor/feedstore.py` decides which store discovery reconciles through. The whole
risk of that decision is one shape: a pg-mode run that quietly used the spreadsheet
instead. It sweeps the same boards, writes the same number of rows, returns the same
exit code and prints the same summary, so nothing downstream can tell it apart from
the cutover working. The only place it is visible is the moment of choosing.

So each test below drives the resolver into a state where reverting would be the
convenient thing to do, and asserts on the exception — never on "the Sheet store was
not returned", which is the absence-shaped claim that also passes when the resolver
returned nothing at all.
"""
from __future__ import annotations

import pytest

from monitor import feedstore
from monitor.pgstore import PgFeedStore
from monitor.sheet import HQFeedStore
from tests.monitor import pgrest_double

UID = "00000000-0000-0000-0000-0000000000ab"


class _Tripwire:
    """An `hq_factory` that fails the test if a pg-mode run opens a spreadsheet."""

    def __init__(self):
        self.calls = 0

    def __call__(self):
        self.calls += 1
        raise AssertionError("pg mode opened the spreadsheet to build its store")


@pytest.fixture
def sheet_hq():
    from core.fakes import fake_hq
    return lambda: fake_hq(["feed", "companies", "health", "log", "config"])


# ------------------------------------------------------------------ the modes

def test_the_default_is_the_sheet_and_the_default_is_unchanged(monkeypatch, sheet_hq):
    """Nothing about a run that has never heard of this switch may change. The
    cutover is opt-in per environment, and an unset variable is the pre-cutover
    world exactly."""
    monkeypatch.delenv(feedstore.STORE_ENV, raising=False)
    store, chosen = feedstore.resolve(hq_factory=sheet_hq)
    assert chosen == feedstore.SHEET
    assert isinstance(store, HQFeedStore)


def test_pg_mode_returns_a_postgres_store_and_never_opens_a_spreadsheet(monkeypatch):
    """The positive claim. Both halves matter: the right store came back, AND the
    factory that would have opened a Sheet was never called.

    KILLED BY: building the Sheet store first and swapping it, a shape that reads
    as harmless and makes every pg-mode run a Sheet-mode run with an extra object.
    """
    pgrest_double.install(monkeypatch)
    monkeypatch.setenv(feedstore.STORE_ENV, "pg")
    monkeypatch.setenv("HQ_PG_USER_ID", UID)
    monkeypatch.setenv("HQ_PG_WRITES", "first_class")
    tripwire = _Tripwire()
    store, chosen = feedstore.resolve(hq_factory=tripwire)
    assert chosen == feedstore.PG
    assert isinstance(store, PgFeedStore)
    assert store.user_id == UID
    assert tripwire.calls == 0


def test_the_chosen_store_is_printed_so_a_run_log_records_which_one(
        monkeypatch, sheet_hq, capsys):
    """A cutover nobody can read afterwards is a cutover nobody can audit. The run
    log has to say which store swept, in the run itself, not by inference from
    what changed."""
    monkeypatch.setenv(feedstore.STORE_ENV, "sheet")
    feedstore.resolve(hq_factory=sheet_hq)
    assert "[feedstore] source=sheet store=HQFeedStore" in capsys.readouterr().err


# --------------------------------------------------------------- the refusals

def test_a_misspelled_mode_is_a_refusal_and_not_a_default(monkeypatch):
    """`HQ_FEED_STORE=postgres` silently meaning "sheet" is the silent revert
    arriving through the spelling. The message names both legal values.

    KILLED BY: `raw if raw in MODES else SHEET`.
    """
    monkeypatch.setenv(feedstore.STORE_ENV, "postgres")
    with pytest.raises(RuntimeError, match="is not a store"):
        feedstore.mode()


def test_pg_without_a_user_id_refuses_rather_than_reverting(monkeypatch):
    """No user id means no tenant, and a store with no tenant has nothing to read.
    Reverting here would sweep correctly off the spreadsheet and report success.

    KILLED BY: falling through to the Sheet branch when `uid` is empty.
    """
    pgrest_double.install(monkeypatch)
    monkeypatch.setenv(feedstore.STORE_ENV, "pg")
    monkeypatch.delenv("HQ_PG_USER_ID", raising=False)
    with pytest.raises(RuntimeError, match="refusing to fall back"):
        feedstore.resolve(hq_factory=_Tripwire())


def test_pg_without_the_store_credentials_refuses_rather_than_reverting(monkeypatch):
    """The outage case, which is the one that will actually happen: the switch is
    set, the store is unreachable, and the spreadsheet is right there.

    KILLED BY: catching the RuntimeError and building `HQFeedStore` instead.
    """
    monkeypatch.setenv(feedstore.STORE_ENV, "pg")
    monkeypatch.setenv("HQ_PG_USER_ID", UID)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    with pytest.raises(RuntimeError, match="refusing to fall back"):
        feedstore.resolve(hq_factory=_Tripwire())


def test_set_but_empty_is_not_unset(monkeypatch):
    """The fifth silent-revert state, found by review.

    `(os.environ.get(ENV) or SHEET)` treats `""` as absent, so `" "` raised while
    `""` quietly returned `sheet`. A terraform variable that defaults to `""` reads
    to an operator as "the cutover is configured", and it would have swept the
    spreadsheet while every dashboard said pg.

    KILLED BY: `raw = (os.environ.get(STORE_ENV) or SHEET)`.
    """
    monkeypatch.setenv(feedstore.STORE_ENV, "")
    with pytest.raises(RuntimeError, match="is not a store"):
        feedstore.mode()


def test_unset_is_still_the_sheet(monkeypatch):
    """The other side of that fix: genuinely absent must keep meaning `sheet`, or
    every pre-cutover environment starts failing."""
    monkeypatch.delenv(feedstore.STORE_ENV, raising=False)
    assert feedstore.mode() == feedstore.SHEET


def test_pg_refuses_while_the_deployment_says_the_sheet_is_authoritative(monkeypatch):
    """Finding 1's root, and the reason it shipped: `HQ_PG_WRITES` DEFAULTS to
    `mirror`, which means "the Sheet is truth and Postgres is an echo". Discovery
    reading from Postgres under that flag is not a configuration, it is two answers —
    and concretely it left `monitor.pgmirror` running as the monitor job's second
    step, overwriting the sweep's own rows from a Feed tab it never wrote.

    KILLED BY: deleting the `pgwrites.mode()` check — the combination the deployed
    environment actually has then resolves happily.
    """
    pgrest_double.install(monkeypatch)
    monkeypatch.setenv(feedstore.STORE_ENV, "pg")
    monkeypatch.setenv("HQ_PG_USER_ID", UID)
    monkeypatch.delenv("HQ_PG_WRITES", raising=False)   # the shipping default
    with pytest.raises(RuntimeError, match="disagree about which store is authoritative"):
        feedstore.resolve(hq_factory=_Tripwire())


def test_refuse_if_pg_stops_a_sheet_only_lane_and_names_it(monkeypatch):
    """`regate` and `review` cannot be swapped to Postgres, so under pg mode they
    must stop rather than run against a Feed tab the sweep never wrote. The message
    has to name the lane: an unattended job's only channel is its failure.
    """
    monkeypatch.setenv(feedstore.STORE_ENV, "pg")
    with pytest.raises(RuntimeError, match=r"monitor\.review .* no Postgres lane"):
        feedstore.refuse_if_pg("monitor.review", "builds HQFeedStore directly and has "
                                                "no Postgres lane yet")


def test_refuse_if_pg_is_inert_in_sheet_mode_and_the_lane_still_resolves(
        monkeypatch, sheet_hq):
    """The guard must be inert in the configuration that ships today, or every
    nightly review starts failing for a cutover nobody enabled.

    Asserted by letting the lane carry on and CHECKING IT GOT ITS STORE, rather than
    by the call merely not raising: "no exception" is also what a guard that was
    deleted produces, and it is what this test would claim if the whole function
    were removed.
    """
    monkeypatch.delenv(feedstore.STORE_ENV, raising=False)
    feedstore.refuse_if_pg("monitor.review", "would be refused under pg")
    store, chosen = feedstore.resolve(hq_factory=sheet_hq)
    assert chosen == feedstore.SHEET
    assert isinstance(store, HQFeedStore)


def test_a_user_id_that_is_not_a_uuid_refuses_before_the_store_is_built(monkeypatch):
    """`HQ_PG_USER_ID=salman` used to be an opaque PostgREST 4xx at 07:00. It is a
    named refusal at the switch instead."""
    pgrest_double.install(monkeypatch)
    monkeypatch.setenv(feedstore.STORE_ENV, "pg")
    monkeypatch.setenv("HQ_PG_USER_ID", "salman")
    with pytest.raises(ValueError, match="must be a UUID"):
        feedstore.resolve(hq_factory=_Tripwire())
