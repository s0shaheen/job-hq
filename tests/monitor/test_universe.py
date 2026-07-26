"""The pg-side read of P7's review verdict — filter shape and row mapping.

Two things can be wrong here and only one of them is a transform:

  * the FILTER — a `review_state=eq.approved&monitor=is.true` that loses either half is a
    sweep that fetches a company the human said no to. So the PostgREST query string is
    asserted directly, character for character in the parts that matter. There is no fake
    data source standing in for Postgres: `pg.select` is replaced with a recorder, and
    what it records is exactly the request `core.pg` would put on the wire. The SEMANTICS
    of those filters — that an approved-and-monitored row is the reviewed, enabled set —
    are proved against real Postgres in tests/db/test_universe_reconcile.py and
    tests/db/test_company_review.py, which is where they belong.
  * the MAPPING — an approved tier-3 row has no board, and handing it to a fetcher would
    quarantine it as an error every sweep. That split is asserted here.

Nothing in this file touches the network.
"""
from __future__ import annotations

import pytest

from monitor import universe as uni

UID = "00000000-0000-0000-0000-000000000001"


def _row(name="Stripe", ats="greenhouse", slug="stripe", tier=1, method="discover-greenhouse",
         source="edgar", monitor=True, priority=False, seeded=False, review_state="approved"):
    """A `user_companies` row with its embedded company, exactly as PostgREST returns it."""
    return {
        "review_state": review_state, "monitor": monitor,
        "priority": priority, "seeded": seeded,
        "companies": {"name": name, "ats": ats, "slug": slug, "reliability_tier": tier,
                      "resolution_method": method, "source": source},
    }


@pytest.fixture
def recorder(monkeypatch):
    """Replace `core.pg.select` with a recorder and force pg 'enabled'."""
    calls: list[tuple[str, str]] = []
    rows: list[dict] = []

    def fake_select(table, query="", *, session=None):
        calls.append((table, query))
        return list(rows)

    monkeypatch.setattr(uni.pg, "enabled", lambda: True)
    monkeypatch.setattr(uni.pg, "select", fake_select)
    return calls, rows


# ----------------------------------------------------------------- the filter

def test_swept_companies_filters_on_approved_and_monitor(recorder):
    calls, rows = recorder
    rows.append(_row())
    uni.swept_companies(UID)
    table, query = calls[0]
    assert table == "user_companies"
    assert f"user_id=eq.{UID}" in query
    # Both halves. Either one alone is a sweep that pulls what a human declined.
    assert "review_state=eq.approved" in query
    assert "monitor=is.true" in query
    # One round trip: the shared company rides along as a PostgREST FK embed.
    assert "companies(name,ats,slug" in query


def test_dismissed_name_keys_asks_only_for_dismissed(recorder):
    calls, rows = recorder
    uni.dismissed_name_keys(UID)
    _, query = calls[0]
    assert "review_state=in.(dismissed)" in query
    assert "approved" not in query and "proposed" not in query


def test_decided_name_keys_defaults_to_every_state(recorder):
    calls, rows = recorder
    uni.decided_name_keys(UID)
    _, query = calls[0]
    assert "review_state=in.(proposed,approved,dismissed)" in query


@pytest.mark.parametrize(
    "bad",
    [
        "x&select=*",                                    # drop the tenant predicate
        f"{UID}&limit=1000",                             # widen the result set
        f"{UID}&or=(review_state.eq.dismissed)",         # add a clause
        "eq.anything",
        "*", "", "   ", "null", "1 or 1=1",
    ],
)
def test_a_user_id_that_is_not_a_uuid_raises_instead_of_querying(recorder, bad):
    """This module builds a RAW PostgREST query and runs it under the SERVICE ROLE, which RLS
    does not constrain — so an unvalidated id is a filter-injection door, not a typo. Parsing
    it as a UUID makes the whole class unrepresentable: a value that survives `uuid.UUID()` has
    no `&`, `=`, `?` or `.` to inject with.

    The validation runs BEFORE the store check, so it holds whether or not SUPABASE_* is set.
    """
    calls, _ = recorder
    for fn in (uni.swept_companies, uni.decided_name_keys, uni.dismissed_name_keys):
        with pytest.raises(ValueError, match="must be a UUID"):
            fn(bad)
    assert calls == [], "a request went out with an unvalidated user_id"


def test_a_valid_uuid_is_canonicalized_before_it_is_interpolated(recorder):
    """Braced and upper-case forms are legitimate UUIDs and would not match the column as
    written, so they are normalized rather than rejected."""
    calls, rows = recorder
    uni.decided_name_keys("{" + UID.upper() + "}")
    assert f"user_id=eq.{UID}" in calls[0][1]


def test_the_injection_shape_is_refused_even_with_no_store(monkeypatch):
    """The early `_skip` return must not become a hole: a bad id is a caller bug either way,
    and a silent empty set is exactly how one gets shipped."""
    monkeypatch.setattr(uni.pg, "enabled", lambda: False)
    with pytest.raises(ValueError, match="must be a UUID"):
        uni.swept_companies("x&select=*")


def test_an_unknown_review_state_is_refused_before_any_request(recorder):
    """Fail loud, never guess. PostgREST answers a bogus `in.(...)` member with an empty
    set, so a typo would read as 'this user has decided nothing' — and the agent would
    re-propose everything the human already dismissed."""
    calls, _ = recorder
    with pytest.raises(ValueError, match="unknown review state"):
        uni.decided_name_keys(UID, states=("approved", "aproved"))
    assert calls == [], "a request went out with an invalid filter"


# ---------------------------------------------------------------- the mapping

def test_swept_companies_returns_sheet_shaped_company_rows(recorder):
    """Deliberately the same shape `SheetStore.read_companies` returns, so settling the
    sheet/pg fork is a source swap and not a rewrite."""
    calls, rows = recorder
    rows.append(_row(name="Stripe", ats="greenhouse", slug="stripe", priority=True, seeded=True))
    got = uni.swept_companies(UID)
    assert [(c.name, c.ats, c.slug, c.monitor, c.priority, c.seeded) for c in got.companies] == [
        ("Stripe", "greenhouse", "stripe", True, True, True)]
    assert got.unpullable == []


def test_an_approved_row_with_no_board_is_unpullable_not_a_company(recorder):
    """The tier-3 floor: "tracked, not auto-pulled". Handing this to `get_jobs_for` with an
    empty `ats` would quarantine it as a fetch ERROR every sweep, which reads to an operator
    as a broken company rather than as one nobody has grounded yet."""
    calls, rows = recorder
    rows.extend([_row(name="Real Co"),
                 _row(name="Pasted Co", ats="", slug="", tier=3, method="manual"),
                 _row(name="Half Co", ats="greenhouse", slug="")])
    got = uni.swept_companies(UID)
    assert [c.name for c in got.companies] == ["Real Co"]
    assert got.unpullable == ["Pasted Co", "Half Co"]


def test_whitespace_only_identity_is_dropped_entirely(recorder):
    calls, rows = recorder
    rows.append(_row(name="  ", ats="  ", slug="  "))
    got = uni.swept_companies(UID)
    assert got.companies == [] and got.unpullable == []


def test_name_keys_are_normalized_not_raw(recorder):
    """The agent proposes NAMES and the verdict is stored against a company row, so the
    two only meet through `company_name_key`. Raw strings here would let 'AON' come back
    from the LLM and sail past a dismissal recorded as 'Aon'."""
    calls, rows = recorder
    rows.extend([_row(name="AON", review_state="dismissed"),
                 _row(name="  Northern   Trust  ", review_state="dismissed"),
                 _row(name="Aon" + chr(0x00A0), review_state="dismissed")])
    assert uni.dismissed_name_keys(UID) == {"aon", "northern trust"}


def test_a_nameless_company_contributes_no_key(recorder):
    """Common Crawl rows are slug-only. An empty key in the exclusion set would match
    every nameless candidate and silently drop them all."""
    calls, rows = recorder
    rows.extend([_row(name=""), _row(name="Stripe")])
    assert uni.decided_name_keys(UID) == {"stripe"}


# ------------------------------------------------- no store, no invented answer

def test_every_reader_skips_loudly_without_a_v2_store(monkeypatch, capsys):
    """House policy (monitor.pgmirror, monitor.discover_universe): absent SUPABASE_* the
    engine still runs. It must not crash, and it must SAY so — an empty exclusion set that
    arrived silently looks exactly like a user who has decided nothing."""
    monkeypatch.setattr(uni.pg, "enabled", lambda: False)

    def boom(*a, **k):
        raise AssertionError("no request may go out without a configured store")

    monkeypatch.setattr(uni.pg, "select", boom)

    assert uni.swept_companies(UID) == uni.UniverseSlice()
    assert uni.decided_name_keys(UID) == set()
    assert uni.dismissed_name_keys(UID) == set()
    out = capsys.readouterr().out
    assert out.count("::warning title=universe") == 3
