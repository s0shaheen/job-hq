"""The Pipeline -> pg `applications` seed (the drain for pre-flag applications).

The reconcile RULES are SQL and are exercised against real Postgres in
tests/db/test_engine_writes.py. What is provable here is the wiring: which rows go,
which columns cross, what happens to the ones that cannot, and that nothing runs at
all with the flag unset.

MUTATION TARGETS:
  * drop the first_class guard in main() -> the Phase-A test writes to a store
    nobody enabled, with an unvalidated user id;
  * silently skip a row whose RPC answers `no_posting` -> the unseedable test's
    keys stop being reported, and "18 rows have no pg twin" becomes invisible;
  * accept an unknown outcome -> the unknown-outcome test counts a row the store
    never wrote as seeded.
"""
import pytest

from core import pgwrites
from core.fakes import fake_hq
from tracker import pgseed

UID = "11111111-1111-1111-1111-111111111111"


def _first_class(monkeypatch):
    monkeypatch.setenv(pgwrites.FLAG_ENV, pgwrites.FIRST_CLASS)
    monkeypatch.setenv(pgwrites.USER_ENV, UID)
    monkeypatch.setattr("core.pg.enabled", lambda: True)


def _rpc(monkeypatch, handler):
    calls = []

    def fake(fn, params, *, session=None):
        calls.append((fn, params))
        return handler(params) if callable(handler) else handler
    monkeypatch.setattr("core.pg.rpc", fake)
    return calls


def test_phase_a_seeds_nothing(monkeypatch):
    monkeypatch.delenv(pgwrites.FLAG_ENV, raising=False)
    monkeypatch.setattr("core.pg.rpc",
                        lambda *a, **k: pytest.fail("seeded with the flag unset"))
    assert pgseed.main() == 0


def test_every_column_that_means_something_crosses(monkeypatch):
    """A Pipeline column silently dropped here is a column the store never learns.
    Asserted against the payload rather than the row, because most of that tab
    (min_yoe, comp, priority, resume_version, contact, stale) has no home in
    `applications` and must NOT be invented into one."""
    row = {"key": "greenhouse-1", "company": "Ramp", "title": "PM",
           "url": "https://x/1", "source": "monitor", "status": "Interview",
           "status_actor": "user", "suggested_status": "Rejected",
           "evidence": "https://mail/1", "applied_date": "2026-06-01",
           "applied_via": "self", "applied_email": "main",
           "last_activity": "2026-07-01", "next_action": "follow up",
           "next_action_date": "2026-07-30", "notes": "phone screen booked",
           "min_yoe": "3", "comp": "$180k", "priority": "TRUE", "stale": "31d"}
    p = pgseed.payload(row)
    assert set(p) == set(pgseed.SEED_COLUMNS)
    assert p["status"] == "Interview" and p["status_actor"] == "user"
    assert p["notes"] == "phone screen booked" and p["applied_date"] == "2026-06-01"
    for sheet_only in ("min_yoe", "comp", "priority", "stale", "key"):
        assert sheet_only not in p


def test_it_reconciles_every_keyed_row_and_counts_the_answers(monkeypatch):
    _first_class(monkeypatch)
    rows = [{"key": "greenhouse-1"}, {"key": "greenhouse-2"}, {"key": ""},
            {"key": "norm-acme|pm"}]
    outcomes = {"greenhouse-1": "created", "greenhouse-2": "unchanged",
                "norm-acme|pm": "no_posting"}
    calls = _rpc(monkeypatch, lambda p: {"outcome": outcomes[p["p_posting_key"]]})
    out = pgseed.seed(rows, UID)
    assert len(calls) == 3, "a keyless row was sent to the store"
    assert out["counts"] == {"created": 1, "updated": 0, "unchanged": 1, "no_posting": 1}
    assert out["unseedable"] == ["norm-acme|pm"]
    assert calls[0][1]["p_user_id"] == UID


def test_the_rows_it_cannot_seed_are_named_not_just_counted(monkeypatch, capsys):
    """"18 rows could not be seeded" is a number nobody can act on. The keys say
    WHICH applications have no pg twin — and why nothing here may invent one."""
    _first_class(monkeypatch)
    hq = fake_hq()
    hq.tab("pipeline").append_records(
        [{"key": "norm-mastercard|pm", "company": "Mastercard"},
         {"key": "norm-hsbc|pm", "company": "HSBC"}])
    _rpc(monkeypatch, {"outcome": "no_posting"})
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(lambda cls: hq))
    assert pgseed.main() == 0
    said = capsys.readouterr()
    assert "norm-mastercard|pm" in said.out and "norm-hsbc|pm" in said.out
    assert "foreign key" in said.out


def test_an_outcome_this_version_does_not_know_is_refused(monkeypatch):
    """Still refused and still not counted — now attributed to the row instead of
    abandoning the rest of the pipeline."""
    _first_class(monkeypatch)
    _rpc(monkeypatch, {"outcome": "merged"})
    out = pgseed.seed([{"key": "greenhouse-1"}], UID)
    assert out["counts"] == {o: 0 for o in pgseed.PG_SEED_OUTCOMES}
    assert out["failed"] == [{"key": "greenhouse-1",
                              "error": out["failed"][0]["error"]}]
    assert "does not understand" in out["failed"][0]["error"]


# ---- one bad row must not end the seed
#
# A status of `Offer-Accepted` typed into the Pipeline with the actor dropdown left
# blank is refused by the SQL — the rule working. It used to abort the run partway
# with an error naming no row, so the operator learned neither which row was wrong
# nor how much of the pipeline had been seeded.
#
# MUTATION TARGETS:
#   * abort on the first failure (drop the try/except) -> the continue test sees
#     one RPC call instead of three and the good row never lands;
#   * swallow and continue silently (drop `failed`, or return 0 from main) -> the
#     reporting test goes green on a partial seed that claims success.

def test_one_bad_row_does_not_end_the_seed(monkeypatch):
    _first_class(monkeypatch)
    rows = [{"key": "greenhouse-bad"}, {"key": "greenhouse-ok"},
            {"key": "greenhouse-worse"}]

    def answer(p):
        if p["p_posting_key"] == "greenhouse-bad":
            raise RuntimeError("Offer-Accepted is a human-only ending")
        if p["p_posting_key"] == "greenhouse-worse":
            raise RuntimeError("some other refusal")
        return {"outcome": "created"}
    calls = _rpc(monkeypatch, answer)

    out = pgseed.seed(rows, UID)
    assert len(calls) == 3, "the seed stopped at the first bad row"
    assert out["counts"]["created"] == 1, "the good row after a failure never landed"
    assert [f["key"] for f in out["failed"]] == ["greenhouse-bad", "greenhouse-worse"]
    assert "human-only ending" in out["failed"][0]["error"]


def test_a_failed_row_names_itself_and_makes_the_run_report_failure(monkeypatch, capsys):
    """A partial seed that exits 0 is how the residue becomes permanent."""
    _first_class(monkeypatch)
    hq = fake_hq()
    hq.tab("pipeline").append_records(
        [{"key": "greenhouse-1", "status": "Offer-Accepted"},
         {"key": "greenhouse-2"},
         {"key": "greenhouse-3", "status": "Offer-Declined"}])

    def answer(p):
        if p["p_posting_key"] == "greenhouse-2":
            return {"outcome": "created"}
        raise RuntimeError("human-only ending")
    _rpc(monkeypatch, answer)
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(lambda cls: hq))

    assert pgseed.main() == 1, "a partial seed reported success"
    said = capsys.readouterr()
    both = said.out + said.err
    # EVERY failed row, not a sample and not a count
    assert "greenhouse-1" in both and "greenhouse-3" in both
    assert "human-only ending" in both


def test_a_clean_seed_still_reports_success(monkeypatch):
    """The control: without it, "returns 1" would be equally true of a seed that
    always fails."""
    _first_class(monkeypatch)
    hq = fake_hq()
    hq.tab("pipeline").append_records([{"key": "greenhouse-1"}])
    _rpc(monkeypatch, {"outcome": "created"})
    monkeypatch.setattr("core.sheets.HQ.open", classmethod(lambda cls: hq))
    assert pgseed.main() == 0


def test_the_seed_is_a_dispatchable_job_and_never_a_scheduled_one():
    """`seed_universe`'s posture: a bridge run deliberately. A cron entry would
    make a job that rewrites the pipeline's twin fire at 03:00 unattended."""
    import importlib.util
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "hq_handler_seed_test", root / "infra" / "app" / "handler.py")
    handler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(handler)
    assert handler.JOBS["seed_pipeline"] == [("tracker.pgseed", [])]
    tf = (root / "infra" / "terraform" / "variables.tf").read_text()
    assert "seed_pipeline" not in tf, "the seed job acquired a schedule"
