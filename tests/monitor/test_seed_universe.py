"""The sheet->pg universe seeder. Everything stubbed: no sheet, no pg, no HTTP."""
import pytest

from monitor import seed_universe as su


ROWS = [
    {"name": "Stripe", "ats": "greenhouse", "slug": "stripe", "monitor": "TRUE", "priority": ""},
    {"name": "Plaid ", "ats": "Greenhouse", "slug": "plaid", "monitor": "FALSE", "priority": "TRUE"},
    {"name": "Mystery Co", "ats": "", "slug": "", "monitor": "TRUE", "priority": ""},
    {"name": "", "ats": "lever", "slug": "ghost", "monitor": "", "priority": ""},
]


def test_candidates_carry_only_resolved_boards_and_count_the_rest():
    cands, skipped = su.sheet_candidates(ROWS)
    assert [(c["name"], c["ats"], c["slug"]) for c in cands] == [
        ("Stripe", "greenhouse", "stripe"), ("Plaid", "greenhouse", "plaid")]
    assert all(c["source"] == "sheet-seed" for c in cands)
    assert skipped == 1                     # Mystery Co: unresolved, never guessed


def test_subscribe_matches_on_normalized_identity_and_upserts(monkeypatch):
    sent = {}
    monkeypatch.setattr(su.pg, "select", lambda t, q, session=None: [
        {"id": 11, "name": "Stripe", "ats": "greenhouse", "slug": "stripe"},
        {"id": 12, "name": "plaid", "ats": "greenhouse", "slug": "plaid"},   # case-folded match
    ])
    monkeypatch.setattr(su.pg, "upsert",
                        lambda t, rows, on_conflict, session=None: sent.update({t: rows, "key": on_conflict}) or len(rows))
    cands, _ = su.sheet_candidates(ROWS)
    n = su.subscribe("u-1", cands,
                     monitor_by_key={"stripe": True, "plaid": False},
                     priority_by_key={"stripe": False, "plaid": True})
    assert n == 2 and sent["key"] == "user_id,company_id"
    by_id = {r["company_id"]: r for r in sent["user_companies"]}
    assert by_id[11] == {"user_id": "u-1", "company_id": 11, "review_state": "approved",
                        "monitor": True, "priority": False}
    assert by_id[12]["monitor"] is False and by_id[12]["priority"] is True


def test_a_collision_dropped_company_is_skipped_not_crashed(monkeypatch):
    monkeypatch.setattr(su.pg, "select", lambda t, q, session=None: [])   # nothing landed
    monkeypatch.setattr(su.pg, "upsert", lambda *a, **k: pytest.fail("nothing to upsert"))
    cands, _ = su.sheet_candidates(ROWS)
    assert su.subscribe("u-1", cands, monitor_by_key={}, priority_by_key={}) == 0
