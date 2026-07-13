import pytest

from core.fakes import fake_hq
from tracker import promote


def _feed(hq, **kw):
    rec = {"key": "greenhouse-1", "company": "Plaid", "title": "PM - Core",
           "url": "https://boards.greenhouse.io/plaid/jobs/1", "location": "NYC",
           "comp_range": "$160k-$190k", "min_yoe": "4", "interested": "TRUE"}
    rec.update(kw)
    hq.tab("feed").append_records([rec])


def _pipeline_rows(hq):
    return [r for r in hq.tab("pipeline").records() if r["key"]]


def test_promotes_interested_row_with_feed_fields():
    hq = fake_hq()
    _feed(hq)
    counts = promote.run(hq)
    assert counts == {"promoted": 1, "already": 0}
    rows = _pipeline_rows(hq)
    assert len(rows) == 1
    row = rows[0]
    assert row["key"] == "greenhouse-1"
    assert row["source"] == "monitor"
    assert row["status"] == "Queued"
    assert row["comp"] == "$160k-$190k"          # feed comp_range -> pipeline comp
    assert row["min_yoe"] == "4"
    assert row["location"] == "NYC"
    assert row["last_activity"] != ""
    feed_row = hq.tab("feed").records()[0]
    assert feed_row["promoted_at"] != ""


def test_rerun_is_idempotent():
    hq = fake_hq()
    _feed(hq)
    promote.run(hq)
    counts = promote.run(hq)                     # promoted_at latch skips the row
    assert counts == {"promoted": 0, "already": 0}
    assert len(_pipeline_rows(hq)) == 1


def test_key_already_in_pipeline_only_stamps_feed():
    hq = fake_hq()
    hq.tab("pipeline").append_records([{"key": "greenhouse-1", "status": "Applied"}])
    _feed(hq)
    counts = promote.run(hq)
    assert counts == {"promoted": 0, "already": 1}
    rows = _pipeline_rows(hq)
    assert len(rows) == 1 and rows[0]["status"] == "Applied"   # untouched
    assert hq.tab("feed").records()[0]["promoted_at"] != ""


@pytest.mark.parametrize("interested", ["", "FALSE", "no", "0"])
def test_not_interested_rows_untouched(interested):
    hq = fake_hq()
    _feed(hq, interested=interested)
    counts = promote.run(hq)
    assert counts == {"promoted": 0, "already": 0}
    assert not _pipeline_rows(hq)
    assert hq.tab("feed").records()[0]["promoted_at"] == ""


@pytest.mark.parametrize("interested", ["TRUE", "true", "x", "✓", "1"])
def test_checkbox_truthiness_variants(interested):
    hq = fake_hq()
    _feed(hq, interested=interested)
    assert promote.run(hq)["promoted"] == 1
