"""The fallback detector, proven before the thing it will guard.

`sheet_poison.poisoned_hq()` is the acceptance evidence for every RM-12 lane cutover:
a lane that completes against it did not touch a Sheet. That claim is only worth
something if the poison actually fires on the paths the Sheet implementation really
uses — a detector with a hole in it produces a green cutover test and a lane still
quietly reading the spreadsheet, which is the precise failure it exists to prevent.

So it is verified against the REAL `HQFeedStore`, the one implementation that is
guaranteed to touch a Sheet. Every protocol method that reads or writes must raise.
The list is derived from `SheetStore` rather than hand-written, so a method added to
the protocol later fails HERE, unproven, instead of silently going uncovered.

This is the "prove the test can fail" step, done in advance of the test.
"""
from __future__ import annotations

import typing

import pytest

from monitor.models import JobRecord
from monitor.sheet import HQFeedStore, SheetStore
from monitor.tagging import Tags
from tests.monitor.sheet_poison import PoisonedHQ, SheetTouched, poisoned_hq

TODAY = "2026-08-03"

#: Every protocol method, with arguments that make it callable. Derived-and-checked
#: below rather than trusted: if `SheetStore` grows a method, this map stops matching
#: it and the test that compares them fails.
CALLS: dict[str, tuple] = {
    "read_companies": (),
    "read_history": (),
    "read_min_yoe": (),
    "read_jobs_for_tagging": (),
    "tagging_context": (),
    "read_sweep_cursor": (),
    "write_sweep_cursor": ("Acme",),
    "append_jobs": ([JobRecord(id="gh-1", company="Acme", title="PM", location="",
                               url="http://x/1", status="New", first_seen=TODAY,
                               last_seen=TODAY, posted="")],),
    "set_status": ({"gh-1": "Closed"},),
    "set_last_seen": (["gh-1"], TODAY),
    "mark_seeded": (["Acme"],),
    "mark_pushed": (["gh-1"], TODAY),
    "write_health": ([{"company": "Acme", "ats": "greenhouse", "result": "ok"}],),
    "write_tags": ({"gh-1": Tags(yoe="5+ years")}, TODAY),
    "mark_untaggable": (["gh-1"], TODAY, "no-jd"),
    "set_disposition": ({"gh-1": ("filtered", "yoe")},),
}


def _protocol_methods() -> set[str]:
    return {n for n in typing.get_type_hints(SheetStore, include_extras=True)} | {
        n for n in vars(SheetStore) if not n.startswith("_")
        and callable(getattr(SheetStore, n, None))
    }


def test_the_call_map_covers_the_whole_protocol():
    """The sanity floor. Every test below iterates `CALLS`, so a protocol method
    missing from it would be silently unproven — the shape of coverage gap that
    makes a detector look complete while having a hole in it.

    KILLED BY: adding a method to `SheetStore` without adding it here.
    """
    assert _protocol_methods() == set(CALLS)


@pytest.mark.parametrize("method", sorted(CALLS))
def test_every_sheet_store_method_trips_the_poison(method):
    """The whole claim, one method at a time, against the REAL Sheet store.

    If any of these completes quietly, a cutover test using this detector would
    pass while the lane read or wrote a spreadsheet.

    KILLED BY: `PoisonedHQ.tab` returning a fake tab instead of raising.
    """
    store = HQFeedStore(poisoned_hq())
    with pytest.raises(SheetTouched) as exc:
        getattr(store, method)(*CALLS[method])
    assert "reached for the spreadsheet" in str(exc.value) or "tab" in str(exc.value)


def test_the_failure_names_the_tab_so_a_traceback_is_actionable():
    """A detector that fires without saying what it caught turns a cutover failure
    into a bisect. `diag`-style specificity: the message must name the tab, not
    merely report that something happened.
    """
    with pytest.raises(SheetTouched) as exc:
        HQFeedStore(poisoned_hq()).read_companies()
    assert "'companies'" in str(exc.value)


def test_identity_stays_readable_because_a_pg_lane_needs_it():
    """`user` and `registry` are NOT poisoned, deliberately.

    They carry a user label and the tab-id map, no spreadsheet data, and a
    Postgres lane reads them for identity while doing entirely pg work. Poisoning
    them would fail a cutover run for a reason unrelated to Sheets and make a
    green result impossible to obtain honestly — a detector nobody can satisfy
    gets deleted, not fixed.
    """
    hq = poisoned_hq(user="dad", registry={"tabs": {"feed": 7}, "ntfy": {}})
    assert hq.user == "dad"
    assert hq.registry["tabs"]["feed"] == 7


def test_an_unknown_attribute_names_its_full_path_rather_than_its_first_segment():
    """`hq.sh.worksheets()` must report the whole path. A failure that said only
    "hq.sh" would send the reader to the wrong line.
    """
    with pytest.raises(SheetTouched) as exc:
        poisoned_hq().sh.worksheets()
    assert "hq.sh.worksheets" in str(exc.value)


def test_truthiness_is_an_access_and_not_a_free_pass():
    """`if hq.some_handle:` is a real reach for the spreadsheet. A `__bool__` that
    returned True would let that pattern slip through silently, which is the whole
    class of bug this object exists to catch.
    """
    with pytest.raises(SheetTouched):
        bool(poisoned_hq().anything)


def test_repr_never_raises_because_pytest_builds_failure_output_from_it():
    """The one exemption, and it is load-bearing: pytest repr()s locals when an
    assertion fails, so a raising repr would replace every real failure message in
    a cutover run with an unrelated internal error.
    """
    assert repr(poisoned_hq().whatever) == "<poisoned hq.whatever>"


def test_the_detector_raises_an_assertion_not_a_product_error():
    """`monitor/run.py` quarantines per-company failures with a broad `except
    Exception`. An AssertionError IS an Exception, so that DOES catch this — the
    class is not a bypass and this test does not claim it is.

    What the class buys is legibility: a reviewer reading a quarantined traceback
    sees a test assertion, not a product error, and knows immediately that the
    detector fired rather than that a board flaked. Any cutover test using this
    detector must therefore assert on the RUN's outcome, not merely that no
    exception escaped — a swallowing lane is exactly the fallback shape being
    hunted, and the poison alone cannot defeat it.

    KILLED BY: `class SheetTouched(RuntimeError)`.
    """
    assert issubclass(SheetTouched, AssertionError)


def test_the_poison_is_not_an_hq_and_cannot_be_mistaken_for_one():
    """Type identity, so nothing decides to take a Sheet path because `isinstance`
    said it had a real HQ."""
    from core.sheets import HQ
    assert not isinstance(poisoned_hq(), HQ)
    assert isinstance(poisoned_hq(), PoisonedHQ)
