import datetime as dt

import pytest

from core.fakes import fake_hq
from tracker import stale

TODAY = dt.date(2026, 7, 13)


def _pipe(hq, **kw):
    rec = {"key": "k1", "company": "Acme", "status": "Applied",
           "last_activity": "2026-06-03"}
    rec.update(kw)
    hq.tab("pipeline").append_records([rec])


def _row(hq, key="k1"):
    return [r for r in hq.tab("pipeline").records() if r["key"] == key][0]


def test_flags_silent_applied_row():
    hq = fake_hq()
    _pipe(hq)                                    # 40 days silent, default gate 30
    counts = stale.run(hq, today=TODAY)
    assert counts == {"flagged": 1, "cleared": 0}
    assert _row(hq)["stale"] == "⏳ 40d silent"


def test_fresh_row_with_leftover_flag_is_cleared():
    hq = fake_hq()
    _pipe(hq, last_activity="2026-07-10", stale="⏳ 99d silent")
    counts = stale.run(hq, today=TODAY)
    assert counts == {"flagged": 0, "cleared": 1}
    assert _row(hq)["stale"] == ""


def test_exactly_stale_days_is_not_yet_stale():
    hq = fake_hq()
    _pipe(hq, last_activity="2026-06-13")        # exactly 30 days: "older than" only
    assert stale.run(hq, today=TODAY) == {"flagged": 0, "cleared": 0}
    assert _row(hq)["stale"] == ""


@pytest.mark.parametrize("status", ["Inbox", "Queued"])
def test_pre_applied_rows_never_flagged(status):
    hq = fake_hq()
    _pipe(hq, status=status)
    stale.run(hq, today=TODAY)
    assert _row(hq)["stale"] == ""


@pytest.mark.parametrize("status", ["OA", "Screen", "Interview", "Final", "Offer"])
def test_everything_from_applied_through_offer_in_scope(status):
    hq = fake_hq()
    _pipe(hq, status=status)
    stale.run(hq, today=TODAY)
    assert _row(hq)["stale"] == "⏳ 40d silent"


@pytest.mark.parametrize("status", ["Rejected", "Withdrawn", "his custom stage"])
def test_out_of_scope_leftover_flags_are_cleared(status):
    hq = fake_hq()
    _pipe(hq, status=status, stale="⏳ 40d silent")
    counts = stale.run(hq, today=TODAY)
    assert counts["cleared"] == 1
    assert _row(hq)["stale"] == ""


def test_unparseable_last_activity_is_unjudgeable():
    hq = fake_hq()
    _pipe(hq, last_activity="soonish", stale="⏳ 40d silent")
    stale.run(hq, today=TODAY)
    assert _row(hq)["stale"] == ""               # can't judge -> no flag kept


def test_stale_days_read_from_config_tab():
    hq = fake_hq()
    hq.tab("config").append_records([{"key": "stale_days", "value": "5"}])
    _pipe(hq, last_activity="2026-07-06")        # 7 days silent
    stale.run(hq, today=TODAY)
    assert _row(hq)["stale"] == "⏳ 7d silent"


def test_flag_refreshes_as_days_accumulate():
    hq = fake_hq()
    _pipe(hq)
    stale.run(hq, today=TODAY)
    stale.run(hq, today=dt.date(2026, 7, 20))
    assert _row(hq)["stale"] == "⏳ 47d silent"
