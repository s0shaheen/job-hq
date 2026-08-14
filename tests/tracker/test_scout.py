import pytest

from core import schema
from core.fakes import fake_hq
from core.sheets import SchemaAnomaly
from tracker import scout

B = schema.BOT
LINK = "https://boards.greenhouse.io/acme/jobs/123"    # -> greenhouse-123
HIS_HEADERS = [h for h in schema.HEADERS["scout_jobs"] if not h.startswith(B)]


def _row(hq, **kw):
    rec = {"Job No": "1", "Company": "Acme", "City": "Austin", "State": "TX",
           "Position": "Product Manager", "Job ID": "A-9",
           "Remote / Hybrid / Onsite": "Hybrid", "Salary Range": "$150K-$170K",
           "Date Searched": "7/10/2026", "Min Experience": "3+ years",
           "Expected Salary": "$160K", "Job Link": LINK,
           "Comments": "spoke to recruiter", "Next Step Date": "", "Contact": "Jane R",
           "Email": "jane@acme.com", "Applied": ""}
    rec.update(kw)
    hq.tab("scout_jobs").append_records([rec])
    return rec


def _scout_row(hq, link=LINK):
    return [r for r in hq.tab("scout_jobs").records() if r["Job Link"] == link][0]


def _pipeline_rows(hq):
    return [r for r in hq.tab("pipeline").records() if r["key"]]


def test_his_columns_are_never_touched():
    hq = fake_hq()
    original = _row(hq)
    scout.run(hq)
    row = _scout_row(hq)
    for h in HIS_HEADERS:
        assert row[h] == original[h], f"bot modified his column {h!r}"
    assert row[B + "min_yoe"] == "3"             # digits from "3+ years"
    assert row[B + "validation"] == ""
    assert row[B + "synced_at"] != ""


def test_duplicate_flag_shows_pipeline_status():
    hq = fake_hq()
    hq.tab("pipeline").append_records([{"key": "greenhouse-123", "status": "Screen"}])
    _row(hq)
    scout.run(hq)
    assert _scout_row(hq)[B + "duplicate"] == "⚠ already in Pipeline (Screen)"


def test_dup_flag_clears_when_row_leaves_pipeline():
    hq = fake_hq()
    _row(hq, **{B + "duplicate": "⚠ already in Pipeline (Applied)"})
    scout.run(hq)                                # bot-owned: recompute clears it
    assert _scout_row(hq)[B + "duplicate"] == ""


def test_do_not_apply_flag_from_config_list():
    # The committed defaults carry NO denylist (RM-40 Step 4) — the user's own
    # Config tab names theirs, and only that list flags anything.
    hq = fake_hq()
    hq.tab("config").append_records(
        [{"key": "dna_companies", "value": "Vandelay Industries"}])
    _row(hq, Company="Vandelay Industries Inc")
    scout.run(hq)
    assert _scout_row(hq)[B + "do_not_apply"] == \
        "⚠ Vandelay Industries Inc matches the do-not-apply list"
    # clean companies stay unflagged
    hq2 = fake_hq()
    _row(hq2)
    scout.run(hq2)
    assert _scout_row(hq2)[B + "do_not_apply"] == ""


def test_no_denylist_configured_flags_nothing():
    """An unset denylist is the filter OFF — nothing is flagged, and nothing is
    inherited from anybody's committed list."""
    hq = fake_hq()
    _row(hq, Company="Vandelay Industries Inc")
    out = scout.run(hq)
    assert out["synced"] == 1                    # the row WAS processed…
    assert _scout_row(hq)[B + "do_not_apply"] == ""   # …and nothing flagged it


def test_validation_lists_missing_required_fields():
    hq = fake_hq()
    _row(hq, Company="", Position="")
    scout.run(hq)
    assert _scout_row(hq)[B + "validation"] == "missing: Company, Position"


def test_applied_creates_pipeline_row():
    hq = fake_hq()
    _row(hq, Applied="TRUE")
    counts = scout.run(hq)
    assert counts["applied_created"] == 1
    row = _pipeline_rows(hq)[0]
    assert row["key"] == "greenhouse-123"
    assert row["source"] == "scout" and row["status"] == "Applied"
    assert row["applied_via"] == "scout" and row["applied_email"] == "alt"
    assert row["applied_date"] == "2026-07-10"   # from Date Searched, normalized
    assert row["location"] == "Austin, TX"
    assert row["comp"] == "$150K-$170K" and row["contact"] == "Jane R"
    assert row["min_yoe"] == "3"
    assert row["title"] == "Product Manager" and row["url"] == LINK


def test_applied_existing_row_fills_blanks_only():
    hq = fake_hq()
    hq.tab("pipeline").append_records([
        {"key": "greenhouse-123", "status": "OA", "applied_via": "self"}])
    _row(hq, Applied="TRUE")
    counts = scout.run(hq)
    assert counts["applied_backfilled"] == 1
    row = _pipeline_rows(hq)[0]
    assert row["applied_via"] == "self"          # human's value wins
    assert row["applied_email"] == "alt"         # blank got filled
    assert row["applied_date"] == "2026-07-10"
    assert row["status"] == "OA"                 # never touched


def test_rerun_creates_no_duplicates_and_no_rewrites():
    hq = fake_hq()
    _row(hq, Applied="TRUE")
    _row(hq, **{"Job No": "2", "Job Link": "https://jobs.example.com/x",
                "Company": "Rho", "Position": "PM"})
    scout.run(hq)
    quiet_before = _scout_row(hq, "https://jobs.example.com/x")[B + "synced_at"]
    scout.run(hq)
    assert len(_pipeline_rows(hq)) == 1          # applied row not re-created
    quiet_after = _scout_row(hq, "https://jobs.example.com/x")[B + "synced_at"]
    assert quiet_after == quiet_before           # unchanged row = no write


def test_daily_counts_grouped_by_search_date():
    hq = fake_hq()
    hq.tab("pipeline").append_records([{"key": "greenhouse-999", "status": "Applied"}])
    _row(hq, Applied="TRUE")                     # 7/10 applied
    _row(hq, **{"Job No": "2", "Job Link": "https://boards.greenhouse.io/z/jobs/999",
                "Company": "Zeta", "Position": "PM"})            # 7/10 dup-flagged
    _row(hq, **{"Job No": "3", "Job Link": "https://jobs.example.com/y",
                "Company": "Rho", "Position": "PM",
                "Date Searched": "7/11/2026"})                   # 7/11 plain
    scout.run(hq)
    daily = [r for r in hq.tab("scout_daily").records() if r["date"]]
    assert daily == [
        {"date": "2026-07-10", "jobs_added": "2", "applied": "1", "duplicates_flagged": "1"},
        {"date": "2026-07-11", "jobs_added": "1", "applied": "0", "duplicates_flagged": "0"},
    ]
    scout.run(hq)                                # rebuild, not append
    daily2 = [r for r in hq.tab("scout_daily").records() if r["date"]]
    # the applied row is now in the pipeline, so 7/10 gains a duplicate flag
    assert daily2[0]["duplicates_flagged"] == "2"
    assert len(daily2) == 2


def test_rows_without_link_get_no_flags_but_count_daily():
    hq = fake_hq()
    _row(hq, **{"Job Link": ""})
    scout.run(hq)
    row = hq.tab("scout_jobs").records()[0]
    assert row[B + "validation"] == "" and row[B + "synced_at"] == ""
    daily = [r for r in hq.tab("scout_daily").records() if r["date"]]
    assert daily == [{"date": "2026-07-10", "jobs_added": "1", "applied": "0",
                      "duplicates_flagged": "0"}]


def test_duplicate_links_abort_loudly():
    hq = fake_hq()
    _row(hq)
    _row(hq, **{"Job No": "2"})                  # same link pasted twice
    with pytest.raises(SchemaAnomaly):
        scout.run(hq)
