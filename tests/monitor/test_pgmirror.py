"""Feed -> Postgres mirror transforms (pure; the HTTP layer is core/pg.py)."""
import pytest

from monitor.pgmirror import mirror_feed, posting_row, user_posting_row

UID = "00000000-0000-0000-0000-000000000001"


def _feed_row(**kw):
    base = {
        "key": "greenhouse-123", "company": "Stripe", "title": "Product Manager",
        "location": "New York, NY", "url": "http://x/123", "status": "New",
        "first_seen": "2026-07-19", "last_seen": "2026-07-19", "posted": "2026-07-18",
        "yoe": "2+ years", "seniority": "PM", "company_industry": "fintech",
        "role_focus": "payments", "skills": "APIs; SQL", "comp_range": "$150k",
        "work_model": "hybrid", "tagged_at": "2026-07-19", "min_yoe": "2",
        "city": "New York", "state": "NY", "country": "United States",
        "remote": "", "market": "US",
        "disposition": "qualified", "disposition_reason": "",
        "interested": "", "promoted_at": "", "pushed_at": "",
    }
    base.update(kw)
    return base


def test_posting_row_packs_tags_and_geo_jsonb():
    p = posting_row(_feed_row())
    assert p["key"] == "greenhouse-123" and p["status"] == "New"
    assert p["tags"]["min_yoe"] == "2" and p["tags"]["work_model"] == "hybrid"
    assert p["geo"] == {"city": "New York", "state": "NY",
                        "country": "United States", "market": "US"}
    assert p["posted"] == "2026-07-18"


def test_posting_row_blank_optionals_are_omitted_or_null():
    p = posting_row(_feed_row(posted="", yoe="", comp_range="", city=""))
    assert p["posted"] is None
    assert "yoe" not in p["tags"] and "comp_range" not in p["tags"]
    assert "city" not in p["geo"]


def test_posting_row_rejects_keyless_and_dateless_rows():
    assert posting_row(_feed_row(key="")) is None
    assert posting_row(_feed_row(first_seen="")) is None


def test_user_posting_row_maps_disposition_and_interest():
    u = user_posting_row(_feed_row(interested="TRUE"), UID)
    assert u == {"user_id": UID, "posting_key": "greenhouse-123",
                 "disposition": "qualified", "disposition_reason": "",
                 "triage": "interested"}


def test_pre_gate_rows_mirror_as_needs_info_never_hidden():
    u = user_posting_row(_feed_row(disposition="", disposition_reason=""), UID)
    assert u["disposition"] == "needs-info"


def test_mirror_feed_routes_to_both_tables(monkeypatch):
    import monitor.pgmirror as m
    calls = []
    monkeypatch.setattr(m.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None:
                        calls.append((table, len(rows), on_conflict)) or len(rows))
    rows = [_feed_row(), _feed_row(key="lever-9", first_seen=""),  # dropped
            _feed_row(key="")]                                     # dropped
    n1, n2, dropped = mirror_feed(rows, UID)
    # the dateless posting is dropped AND must not leave a dangling
    # user_postings FK — both tables see exactly the one well-formed row
    assert (n1, n2) == (1, 1)
    assert dropped == ["lever-9"]   # keyless row isn't reportable; dateless is
    assert calls[0] == ("postings", 1, "key")
    assert calls[1] == ("user_postings", 1, "user_id,posting_key")


# ---- date normalization: the live feed's `posted` column is NOT uniform.
# ~40% of real rows carry Workday prose or epoch millis; a raw pass-through
# would fail the whole 500-row PostgREST chunk on a date cast.

def test_iso_date_passes_iso_and_rejects_real_world_junk():
    from monitor.pgmirror import iso_date
    assert iso_date("2026-07-19") == "2026-07-19"
    assert iso_date("2026-07-19T14:03:00Z") == "2026-07-19"
    assert iso_date("1764070589246") == "2025-11-25"      # epoch millis
    assert iso_date("1764070589") == "2025-11-25"         # epoch seconds
    for junk in ("", "   ", "Posted 30+ Days Ago", "Posted Today",
                 "2026-13-45", "yesterday", "30+"):
        assert iso_date(junk) is None, junk


def test_posting_row_nulls_unparseable_posted_instead_of_failing():
    p = posting_row(_feed_row(posted="Posted 30+ Days Ago"))
    assert p["posted"] is None and p["key"] == "greenhouse-123"
    p2 = posting_row(_feed_row(posted="1764070589246"))
    assert p2["posted"] == "2025-11-25"


def test_unparseable_first_seen_drops_row_and_is_reported(monkeypatch):
    import monitor.pgmirror as m
    monkeypatch.setattr(m.pg, "upsert",
                        lambda table, rows, *, on_conflict, session=None: len(rows))
    rows = [_feed_row(), _feed_row(key="lever-9", first_seen="Posted 30+ Days Ago")]
    n1, n2, dropped = mirror_feed(rows, UID)
    # dropped rows are surfaced, never silently diverging from the sheet
    assert (n1, n2) == (1, 1) and dropped == ["lever-9"]


def test_human_edited_status_mirrors_verbatim():
    # the feed status cell is human-editable; the store must represent
    # whatever it holds (no CHECK constraint on postings.status)
    p = posting_row(_feed_row(status="Promoted"))
    assert p["status"] == "Promoted"


# ---- Phase C: the tail step stands down once the sweep owns the write.
# MUTATION: delete the first_class guard in main() -> this test sees a second
# full-Feed upsert per sweep, which is the double-write it exists to prevent.

def test_the_tail_step_stands_down_under_first_class(monkeypatch, capsys):
    import monitor.pgmirror as m
    from core import pgwrites
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setattr(m.pg, "enabled",
                        lambda: pytest.fail("the tail step still talked to pg"))
    monkeypatch.setattr(m, "mirror",
                        lambda *a, **k: pytest.fail("the Feed was mirrored twice"))
    assert m.main() == 0
    assert "the sweep mirrors the Feed itself" in capsys.readouterr().err


def test_the_tail_step_still_echoes_in_phase_a(monkeypatch):
    """The control: same entry point, flag unset, mirror still runs."""
    import monitor.pgmirror as m
    from core import pgwrites
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.setenv(pgwrites.USER_ENV, "u-1")
    monkeypatch.setattr(m.pg, "enabled", lambda: True)
    seen = []
    monkeypatch.setattr(m, "mirror",
                        lambda hq, uid, session=None: seen.append(uid) or (1, 1, []))
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(lambda cls: object()))
    assert m.main() == 0 and seen == ["u-1"]


# ---- RM-12: the second step of the monitor job must not undo the first one.
# This is the severe finding of the first review of the PgFeedStore branch: the
# `monitor` job is [("monitor.run", []), ("monitor.pgmirror", [])], and under
# HQ_FEED_STORE=pg the sweep writes postings/user_postings itself and never writes
# the Feed tab. Mirroring that tab afterwards rewrites status, tags, geo and
# disposition for every row still in it — exit 0, no alert.

def test_the_tail_step_stands_down_when_the_sweep_owns_the_store(monkeypatch, capsys):
    """Checked on the FEED-STORE flag and independently of HQ_PG_WRITES.

    Independence is the point. The defect shipped precisely because this module's
    only stand-down was keyed to `HQ_PG_WRITES=first_class`, which is not the
    default — so in the deployed configuration the guard was never reached. A module
    that can corrupt the previous step's output must not depend on a second,
    unrelated flag being set correctly.

    KILLED BY: deleting the feedstore guard, or moving it below the pgwrites branch.
    """
    import monitor.pgmirror as m
    from core import pgwrites
    from monitor import feedstore
    monkeypatch.setenv(feedstore.STORE_ENV, feedstore.PG)
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)      # the shipping default
    # Everything ELSE configured so the module would happily proceed: this test has
    # to fail on the guard, not on a missing credential that would mask its absence.
    monkeypatch.setenv(pgwrites.USER_ENV, "u-1")
    monkeypatch.setattr(m.pg, "enabled", lambda: True)
    monkeypatch.setattr(m, "mirror",
                        lambda *a, **k: pytest.fail(
                            "UNSAFE: the Feed tab was mirrored over a pg-mode sweep"))
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(
        lambda cls: pytest.fail("UNSAFE: pgmirror opened the SPREADSHEET after a "
                                "pg-mode sweep")))
    assert m.main() == 0
    err = capsys.readouterr().err
    assert "overwrite this run's own rows" in err
