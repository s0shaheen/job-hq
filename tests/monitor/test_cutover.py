"""The cutover, proven the only way it can be: one sweep, two stores, one poisoned.

RM-12's acceptance question is not "does `PgFeedStore` work" — the conformance suite
answers that. It is "did the sweep run on Postgres, or did it run on the spreadsheet
and look identical". Two things that do not answer it, both tried elsewhere and both
rejected in `tests/monitor/sheet_poison.py`'s own docstring:

  * a row count in Postgres cannot tell "wrote pg" from "wrote both";
  * an unchanged spreadsheet cannot tell "never read it" from "read it and wrote
    nothing".

So the detection is structural. The Sheet handle is `poisoned_hq()`, every access to
which raises, and the store the sweep is handed holds no handle at all. A run that
COMPLETES against that did not read or write a Sheet — not because anything was
checked afterwards, but because there was nothing there to read.

**Completing is half the claim, and the weaker half.** `SheetTouched` is an
`AssertionError` and `monitor/run.py:187` quarantines per-company failures with a
broad `except Exception`, so the poison buys legibility in a traceback, not immunity:
a sweep that swallowed sixteen poisoned accesses and produced nothing would raise
nothing either. Every assertion here is therefore on the OUTCOME — the boards the
summary says it visited, the postings that are in the store afterwards, the tags on
them, and the push latch that was set — read back out of the store the sweep wrote
THROUGH.

And the negative control is a test rather than a note. `test_the_same_sweep_dies_...`
runs the identical fixture with the switch flipped back to `sheet`, which is the
forced fallback, and requires it to die naming the tab it reached for. Without that,
the positive test proves only that this fixture can pass — not that it can fail.
"""
from __future__ import annotations

import pytest

from core import notify, outbox as core_outbox
from core.profile import Profile
from monitor import feedstore
from monitor.config import RuntimeConfig
from monitor.models import Job
from monitor.pgstore import PgFeedStore
from monitor.run import run_monitor
from monitor.sheet import HQFeedStore
from monitor.tagging import Tags
from tests.monitor import pgrest_double
from tests.monitor.sheet_poison import SheetTouched, poisoned_hq

TODAY = "2026-08-03"
UID = "00000000-0000-0000-0000-0000000000ab"

CFG = RuntimeConfig(include=["product manager"], exclude=["engineer"],
                    workday_search="product", yoe_push_max=4,
                    push_new_jobs=True, push_status_events=True)

#: Two roles on one board, one of which the title filter must drop. A fixture where
#: everything matches cannot tell a sweep that filtered from one that never ran.
BOARD = [
    Job("greenhouse", "1", "Acme", "Product Manager", "Chicago, IL", "http://x/1"),
    Job("greenhouse", "2", "Acme", "Senior Product Manager", "Remote", "http://x/2"),
    Job("greenhouse", "3", "Acme", "Staff Engineer", "Chicago, IL", "http://x/3"),
]


def _fetch(ats, slug, company, session, workday_search="product"):
    return list(BOARD) if company == "Acme" else []


def _tagger(rec, slug):
    return Tags(yoe="3 years", work_model="remote", skills="sql")


class _Pusher:
    def __init__(self):
        self.calls = []

    def __call__(self, title, body, **kw):
        self.calls.append(title)
        return True


@pytest.fixture
def cutover(monkeypatch):
    """One fixture, two switch positions. Everything except `HQ_FEED_STORE` is
    identical between the passing run and the dying one, so the difference between
    them is the switch and nothing else.

    `HQ_PG_WRITES` and `HQ_COMPANIES_SOURCE` are set because pg mode now REFUSES
    without them, which is finding 1 and finding 4 of the first review: under
    `HQ_PG_WRITES=mirror` the Feed-tab mirror still runs as the monitor job's second
    step, and the `sheet` company branch reads the list through the store, so with a
    Postgres store it silently becomes the pg branch. Those refusals have their own
    tests in `test_feedstore.py` and `test_companysource.py`; here they are just the
    configuration a real pg run has to have.
    """
    double = pgrest_double.install(monkeypatch)
    double.add_company("Acme", "greenhouse", "acme", user_id=UID, seeded=True)
    monkeypatch.setenv("HQ_PG_USER_ID", UID)
    monkeypatch.setenv("HQ_PG_WRITES", "first_class")
    monkeypatch.setenv("HQ_COMPANIES_SOURCE", "pg")
    return double


def _sweep(monkeypatch, mode: str, double, *, pusher=None, profile=None):
    """Resolve a store the way `monitor/run.py:main` does, then run one sweep.

    The spreadsheet handle is poisoned and is handed to the resolver AND to the
    outbox. Whether the outbox path is actually ENTERED depends on the pusher: the
    `_Pusher` stub below never touches it, so the quiet-hours case passes the real
    `core.notify.push` instead. The first review caught this docstring claiming both
    paths were exercised when only one was.
    """
    monkeypatch.setenv(feedstore.STORE_ENV, mode)
    hq = poisoned_hq()
    store, chosen = feedstore.resolve(hq_factory=lambda: hq, user="salman")
    pusher = pusher if pusher is not None else _Pusher()
    summary = run_monitor(store, CFG, fetch=_fetch, tagger=_tagger, today=TODAY,
                          pusher=pusher, outbox=core_outbox.sink(hq), user="salman",
                          profile=profile)
    return store, chosen, summary, pusher


# ------------------------------------------------------------------- the claim

def test_the_sweep_runs_to_completion_on_postgres_with_no_spreadsheet_at_all(
        monkeypatch, cutover):
    """The cutover. Asserted on what the run DID, in the store it wrote through.

    KILLED BY: the negative control below — flip `HQ_FEED_STORE` back to `sheet`
    and this same sweep dies on `hq.tab('companies')`.
    """
    store, chosen, summary, pusher = _sweep(monkeypatch, "pg", cutover)
    assert chosen == feedstore.PG
    assert isinstance(store, PgFeedStore)

    # 1. the run reported success, not a quarantined nothing
    assert summary.boards_done == summary.boards_total == 1
    assert summary.errored == 0 and summary.error_companies == []
    assert summary.partial is False
    assert summary.new_count == 2, "the title filter dropped the engineer role"
    assert summary.tagged == 2

    # 2. the postings are in Postgres, with the content the board carried
    landed = cutover.postings_for(UID)
    assert sorted(landed) == ["greenhouse-1", "greenhouse-2"]
    assert landed["greenhouse-1"]["title"] == "Product Manager"
    assert landed["greenhouse-1"]["company"] == "Acme"
    assert landed["greenhouse-1"]["first_seen"] == TODAY

    # 3. the tags the sweep computed inline reached the store, not just the run
    assert landed["greenhouse-2"]["tags"]["min_yoe"] == "3"
    assert landed["greenhouse-2"]["tags"]["tagged_at"] == TODAY

    # 4. the push happened and the latch was written, which is the one write that
    #    is per-user and the one whose absence would re-notify tomorrow
    assert len(pusher.calls) == 1
    assert summary.pushed == 2
    assert landed["greenhouse-1"]["pushed_at"] == TODAY

    # 5. it was written THROUGH the pg store — the requests are on the wire log
    written = {table for verb, table, _ in cutover.calls if verb in ("POST", "PATCH")}
    assert written == {"postings", "user_postings"}


def test_the_same_sweep_dies_when_the_switch_is_forced_back_to_the_sheet(
        monkeypatch, cutover):
    """The negative control, and the reason the test above means anything.

    Identical fixture, identical run, one environment variable different. If this
    passed, the positive test would be proving that a sweep can complete without
    reading anything — which is also what a broken fixture does.

    The failure must also be ATTRIBUTABLE: the message names the call, so a future
    reader knows which access tripped rather than that something did. It is the
    CONFIG tab rather than the companies tab because `HQ_COMPANIES_SOURCE=pg` is
    already set — the company list comes from Postgres either way, so the first thing
    a Sheet store reaches for is `read_sweep_cursor`. Pinning which one keeps this
    from passing on an unrelated failure.
    """
    with pytest.raises(SheetTouched, match=r"hq\.tab\('config'\)"):
        _sweep(monkeypatch, "sheet", cutover)


def test_the_forced_fallback_leaves_postgres_empty(monkeypatch, cutover):
    """The other half of the control. A sweep that died on the Sheet must not have
    written the store either, or "postings landed" in the passing test would be
    satisfiable by a run that did both."""
    with pytest.raises(SheetTouched):
        _sweep(monkeypatch, "sheet", cutover)
    assert cutover.postings_for(UID) == {}


# ------------------------------------------------- the hole the review found

def test_a_quiet_hours_push_reaches_the_outbox_tab_and_fails_loudly(
        monkeypatch, cutover):
    """The quiet-hours path is NOT cut over, and this is the test that says so.

    The Outbox tab is the quiet-hours queue and it has no Postgres home — no table,
    no RPC, per the RM-12 inventory. So a pg-mode sweep whose push lands inside quiet
    hours reaches the spreadsheet. That is a real hole in the cutover, and the only
    two acceptable behaviours are "it does not happen" and "it fails where somebody
    sees it". This pins the second.

    It also closes the detector hole the review found. `core/notify.py:_hold` wrapped
    the sink in `except Exception`, and `SheetTouched` is an `AssertionError` — so the
    poison fired, `_hold` swallowed it, paged ops, returned False, and the run
    finished with `errored == 0`. The detector reported the thing it exists to catch
    as a healthy run.

    Driven through the REAL `core.notify.push`, not the `_Pusher` stub, because the
    stub discards `outbox` and never enters the path at all.

    KILLED BY: restoring the bare `except Exception` in `core/notify.py:_hold` — the
    sweep then completes and this raises nothing.
    """
    always_quiet = Profile(name="salman", quiet_hours="00:00-23:59", timezone="UTC")
    with pytest.raises(SheetTouched, match=r"hq\.tab\('outbox'\)"):
        _sweep(monkeypatch, "pg", cutover,
               pusher=notify.push, profile=always_quiet)


def test_the_sheet_store_is_what_the_forced_fallback_builds(monkeypatch, cutover):
    """Names the thing being controlled for. The run above dies inside the sweep;
    this pins that the object it died in is `HQFeedStore` over the poisoned handle,
    so the control is the fallback and not some unrelated failure."""
    monkeypatch.setenv(feedstore.STORE_ENV, "sheet")
    store, chosen = feedstore.resolve(hq_factory=poisoned_hq, user="salman")
    assert chosen == feedstore.SHEET
    assert isinstance(store, HQFeedStore)
