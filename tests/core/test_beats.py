"""Heartbeats in `channel_runs` — the store half of the two-lane watchdog.

MUTATION TARGETS:
  * drop the LANES membership check in write() -> the guard test writes a beat
    the digest's watchdog does not iterate, which is coverage that isn't;
  * drop `_uid` -> the injection test interpolates `&or=` straight into a
    service-role query string and reads another user's health history;
  * change last_seen to one windowed request with a row cap -> the "a lane that
    died months ago is still reported" test regresses, because the dead lane's
    last beat is the OLDEST row in the table and a cap drops it first;
  * make `_parse` return `now` on junk -> the unparseable test reads a corrupt
    timestamp as a live lane.
"""
import datetime as _dt

import pytest

from core import beats

UID = "00000000-0000-0000-0000-000000000001"


def test_a_lane_the_watchdog_does_not_watch_is_refused(monkeypatch):
    monkeypatch.setattr("core.pg.insert",
                        lambda *a, **k: pytest.fail("an unwatched beat was written"))
    with pytest.raises(ValueError, match="core.beats.LANES"):
        beats.write("tracker", UID)


def test_every_lane_that_beats_is_a_lane_the_digest_watches():
    """The invariant this module's docstring claims, finally checked — in BOTH
    directions, because each one alone has already shipped broken.

    `digest` used to write a beat the watchdog never iterated (a lane whose death
    was invisible: coverage that isn't). And `snapshot` used to be watched in pg
    while its only writer, the Actions lane in selfheal.yml, had no pg credentials
    at all (a healthy backup reported dead, every morning).
    """
    from tracker import digest
    assert set(beats.LANES) == set(digest.PG_CADENCE_HOURS), {
        "write but unwatched": sorted(set(beats.LANES) - set(digest.PG_CADENCE_HOURS)),
        "watched but unwritten": sorted(set(digest.PG_CADENCE_HOURS) - set(beats.LANES)),
    }


def test_the_pg_cadence_table_is_not_a_slice_of_the_sheets():
    """Non-vacuity for the test above: the two stores really do hold different
    lanes, so a future refactor collapsing them into one table would be wrong."""
    from tracker import digest
    assert "pgdump" in beats.LANES and "pgdump" not in digest.CADENCE_HOURS
    assert "capture" in digest.CADENCE_HOURS and "capture" not in beats.LANES


def test_write_appends_one_row_for_the_lane(monkeypatch):
    sent = []
    monkeypatch.setattr("core.pg.insert",
                        lambda table, rows, session=None: sent.append((table, rows)))
    beats.write("snapshot_s3", UID)
    table, rows = sent[0]
    assert table == "channel_runs"
    assert rows == [{"user_id": UID, "channel": "snapshot_s3",
                     "detail": {"source": "engine"}}]


def test_a_non_uuid_user_never_reaches_the_query_string(monkeypatch):
    """These run as the service role, which RLS does not constrain."""
    monkeypatch.setattr("core.pg.insert",
                        lambda *a, **k: pytest.fail("an injectable id was interpolated"))
    monkeypatch.setattr("core.pg.select",
                        lambda *a, **k: pytest.fail("an injectable id was interpolated"))
    for bad in ("x&or=(user_id.gte.0)", "", None, "not-a-uuid"):
        with pytest.raises(ValueError, match="must be a UUID"):
            beats.write("digest", bad)
        with pytest.raises(ValueError, match="must be a UUID"):
            beats.last_seen(bad)


def test_last_seen_asks_each_lane_for_its_newest_row(monkeypatch):
    seen = []

    def fake_select(table, query, session=None):
        seen.append((table, query))
        return [{"ran_at": "2026-07-25T08:53:00+00"}] if "snapshot_s3" in query else []
    monkeypatch.setattr("core.pg.select", fake_select)

    got = beats.last_seen(UID)
    assert set(got) == set(beats.LANES)
    assert got["snapshot_s3"] == _dt.datetime(2026, 7, 25, 8, 53,
                                              tzinfo=_dt.timezone.utc)
    # a lane that has never beaten is None, not absent — the watchdog warns on it
    assert got["digest"] is None
    # exact requests, per lane, newest-first, capped at one: a shared window with a
    # row cap would drop the lane that died first, which is the one being looked for
    for table, q in seen:
        assert table == "channel_runs"
        assert "order=ran_at.desc" in q and "limit=1" in q and f"user_id=eq.{UID}" in q
    assert len(seen) == len(beats.LANES)


def test_an_unparseable_timestamp_reads_as_never_beaten(monkeypatch):
    """The safe direction: a corrupt beat warns rather than vouching for a lane."""
    monkeypatch.setattr("core.pg.select",
                        lambda *a, **k: [{"ran_at": "last tuesday"}])
    assert beats.last_seen(UID, ("digest",)) == {"digest": None}


def test_postgres_short_offsets_and_z_both_parse(monkeypatch):
    """Postgres renders +00:00 as +00 on its own; drivers and PostgREST differ."""
    for raw in ("2026-07-25T08:53:00+00", "2026-07-25T08:53:00Z",
                "2026-07-25T08:53:00+00:00", "2026-07-25T08:53:00.123456+00"):
        monkeypatch.setattr("core.pg.select", lambda *a, **k: [{"ran_at": raw}])
        got = beats.last_seen(UID, ("digest",))["digest"]
        assert got is not None and got.tzinfo is not None, raw
        assert (got.year, got.hour, got.minute) == (2026, 8, 53), raw
