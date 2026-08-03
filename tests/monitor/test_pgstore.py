"""`PgFeedStore` at the boundary: the request it makes, and what the store then holds.

`tests/monitor/test_store_conformance.py` already asks this store every question the
`SheetStore` protocol asks, and it passes them unmodified. That is the substitutability
proof and it is deliberately implementation-blind — it reads back through the protocol,
so it cannot see a filter that is missing from a query as long as the answer happens to
come out right on a single-tenant fixture.

This file looks at the things that only go wrong with a second user, a second run, or a
company whose name has a comma in it:

  * the TENANT PREDICATE, asserted on the query string, because a read that forgot it
    returns another person's postings and every assertion about the answer still passes
    on a fixture with one user;
  * the PUSH LATCH, which is a filter (`pushed_at=is.null`) and not a read-then-write,
    asserted on the stored date rather than a row count — an update that clobbered the
    original affects exactly as many rows as one that correctly did nothing;
  * the JSONB MERGE, because PostgREST writes the column whole and a partial write is
    silent loss of every tag the field being written does not carry;
  * the `in.(...)` QUOTING, because "Booz Allen, Inc" unquoted becomes two filter values
    that match nothing, and a predicate matching nothing reads as "no rows to update".

Nothing here touches the network. `tests/db/test_sweep_state.py` runs the same schema
against a real server, which is where RLS, the grants and the entitlement gate are
proven.
"""
from __future__ import annotations

import typing

import pytest

from monitor.models import JobRecord
from monitor.pgstore import PgFeedStore, in_list
from monitor.sheet import SheetStore
from monitor.tagging import Tags
from tests.monitor import pgrest_double

TODAY = "2026-08-03"
UID = "00000000-0000-0000-0000-0000000000ab"
OTHER = "00000000-0000-0000-0000-0000000000cd"


def _rec(key: str, company: str = "Acme", location: str = "Chicago, IL") -> JobRecord:
    return JobRecord(id=key, company=company, title="Product Manager",
                     location=location, url=f"http://example.invalid/{key}",
                     status="New", first_seen=TODAY, last_seen=TODAY, posted="")


@pytest.fixture
def double(monkeypatch):
    return pgrest_double.install(monkeypatch)


@pytest.fixture
def store(double):
    double.add_company("Acme", "greenhouse", "acme", user_id=UID)
    return PgFeedStore(UID)


# --------------------------------------------------------------- the protocol

def _protocol_methods() -> set[str]:
    return {n for n in typing.get_type_hints(SheetStore, include_extras=True)} | {
        n for n in vars(SheetStore)
        if not n.startswith("_") and callable(getattr(SheetStore, n, None))
    }


def test_pgfeedstore_implements_every_protocol_method():
    """Derived from `SheetStore`, not listed, so a method added to the protocol
    later fails HERE as unimplemented instead of at 12:00 UTC in the sweep.

    Asserted as an equality between two sets rather than as "nothing is missing":
    the empty-difference form passes just as happily when `_protocol_methods()`
    itself returns nothing, which is the failure that makes a coverage check look
    complete while checking no methods at all.

    KILLED BY: renaming any `PgFeedStore` method, or adding one to the protocol.
    """
    protocol = _protocol_methods()
    assert len(protocol) == 16, "SheetStore is a 16-method protocol"
    implemented = {m for m in protocol if callable(getattr(PgFeedStore, m, None))}
    assert implemented == protocol


def test_a_store_without_the_postgres_credentials_refuses_to_exist(monkeypatch):
    """Fail loud, never empty. A store that answered every read with nothing would
    reopen every role and re-notify the whole feed on the next run — a silent
    catastrophe that looks like a first sweep.

    KILLED BY: dropping the `pg.enabled()` guard from `__init__`.
    """
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    with pytest.raises(RuntimeError, match="SUPABASE_URL"):
        PgFeedStore(UID)


def test_a_user_id_that_is_not_a_uuid_is_refused_before_any_query(double):
    """This module runs as the service role, which RLS does not constrain, so an
    unvalidated id interpolated into a PostgREST query is a filter-injection door
    rather than a bad lookup."""
    with pytest.raises(ValueError, match="must be a UUID"):
        PgFeedStore("me&user_id=neq.nobody")
    assert double.calls == [], "a rejected id must not have reached the store"


# ---------------------------------------------------------- the tenant predicate

@pytest.mark.parametrize("call", [
    lambda s: s.read_history(),
    lambda s: s.read_jobs_for_tagging(),
    lambda s: s.read_sweep_cursor(),
    lambda s: s.mark_pushed(["greenhouse-1"], TODAY),
    lambda s: s.set_disposition({"greenhouse-1": ("filtered", "yoe")}),
])
def test_every_per_user_request_carries_the_tenant_predicate(store, double, call):
    """The per-user tables are `user_postings`, `user_companies` and
    `monitor_sweep_state`. A request to one of them without `user_id=eq.` reads or
    writes every tenant's rows, and a single-user fixture cannot tell the difference.

    KILLED BY: dropping `user_id=eq.{self.user_id}` from any of those queries.
    """
    double.calls.clear()
    call(store)
    per_user = [(verb, table, q) for verb, table, q in double.calls
                if table in ("user_postings", "user_companies",
                             "monitor_sweep_state")]
    assert per_user, "the call under test made no per-user request"
    for verb, table, q in per_user:
        assert f"user_id=eq.{UID}" in q, f"{verb} {table} has no tenant predicate"


def test_the_history_read_is_this_users_slice_and_not_the_shared_table(store, double):
    """Two users, one shared posting, one gate row each. The sweep reconciles
    against history by key: a read that came off `postings` instead of the user's
    `user_postings` slice would hand this user the other's role, and dedupe would
    then treat somebody else's posting as already seen."""
    store.append_jobs([_rec("greenhouse-1")], today=TODAY)
    other = PgFeedStore(OTHER)
    other.append_jobs([_rec("greenhouse-2")], today=TODAY)
    assert sorted(store.read_history()) == ["greenhouse-1"]
    assert sorted(other.read_history()) == ["greenhouse-2"]


# ------------------------------------------------------------------ the latch

def test_mark_pushed_filters_on_null_rather_than_reading_first(store, double):
    """The latch is the filter. A read-then-write has a window in which two sweeps
    both see NULL and both write, and being notified twice is the one thing this
    column exists to prevent.

    KILLED BY: removing `&pushed_at=is.null` from `mark_pushed`.
    """
    store.append_jobs([_rec("greenhouse-1")], today=TODAY)
    double.calls.clear()
    store.mark_pushed(["greenhouse-1"], TODAY)
    patches = [q for verb, table, q in double.calls
               if verb == "PATCH" and table == "user_postings"]
    assert patches, "mark_pushed issued no update"
    assert all("pushed_at=is.null" in q for q in patches)


def test_a_second_sweep_never_moves_the_push_date(store):
    """Asserted on the stored DATE, not on a count: an update that clobbered the
    original affects exactly as many rows as one that correctly did nothing.

    KILLED BY: the same removal as above — the second call then overwrites.
    """
    store.append_jobs([_rec("greenhouse-1")], today=TODAY)
    store.mark_pushed(["greenhouse-1"], TODAY)
    store.mark_pushed(["greenhouse-1"], "2026-08-04")
    row = store._slice()[0]
    assert row is not None
    pushed = [u["pushed_at"] for u in
              [r for r in _user_rows(store)] if u["posting_key"] == "greenhouse-1"]
    assert pushed == [TODAY]


def _user_rows(store):
    from core import pg
    return pg.select("user_postings", f"user_id=eq.{store.user_id}")


# ------------------------------------------------------------- the jsonb merge

def test_a_tag_write_keeps_the_tags_it_does_not_carry(store, double):
    """PostgREST writes `postings.tags` WHOLE. The review sweep writes tags a pass at
    a time, so sending only the new fields would erase every tag an earlier pass
    wrote — and the row would still look tagged, because `tagged_at` is one of the
    fields being sent.

    KILLED BY: replacing `_merge_tags` with a plain upsert of the new fields.
    """
    store.append_jobs([_rec("greenhouse-1")],
                      tags={"greenhouse-1": Tags(yoe="5+ years", skills="sql;python",
                                                 work_model="remote")}, today=TODAY)
    store.mark_untaggable(["greenhouse-1"], "2026-08-04", "no-jd")
    tags = double.tables["postings"][0]["tags"]
    assert tags["tagged_at"] == "no-jd:2026-08-04"
    assert tags["skills"] == "sql;python", "an untouched tag was erased"
    assert tags["min_yoe"] == "5"


def test_write_tags_updates_the_min_yoe_the_push_filter_reads(store):
    """`read_min_yoe` is what decides whether a reopened role clears the push bar.
    It is served from `postings.tags`, so a tag write that did not land there would
    leave the sweep judging today's roles on yesterday's experience bar."""
    store.append_jobs([_rec("greenhouse-1")], today=TODAY)
    assert store.read_min_yoe() == {"greenhouse-1": ""}
    store.write_tags({"greenhouse-1": Tags(yoe="7 years")}, "2026-08-04")
    assert store.read_min_yoe() == {"greenhouse-1": "7"}


# ------------------------------------------------------------------ the quoting

def test_in_list_quotes_a_value_that_would_otherwise_split_the_filter():
    """A comma in a company name is not exotic — "Booz Allen Hamilton, Inc" is a
    real board. Unquoted it becomes two filter values matching nothing, and a
    predicate that matches nothing reads to every caller as "no rows to update".

    KILLED BY: `f"in.({','.join(values)})"`.
    """
    q = in_list(["Booz Allen, Inc", 'Say "Hi"'])
    assert q.startswith("in.(") and q.endswith(")")
    assert q.count("%2C") == 0 or "%22" in q      # commas only ever inside quotes
    assert "%22Booz%20Allen%2C%20Inc%22" in q


def test_mark_seeded_reaches_a_company_whose_name_contains_a_comma(double):
    """The end of that story: `mark_seeded` resolves names to ids, and a name that
    split would resolve to nothing and silently leave `seeded` false — which makes
    the next sweep treat an established company as brand new and push its whole
    backlog."""
    double.add_company("Booz Allen, Inc", "greenhouse", "booz", user_id=UID)
    store = PgFeedStore(UID)
    store.mark_seeded(["Booz Allen, Inc"])
    row = [r for r in double.tables["user_companies"] if r["user_id"] == UID][0]
    assert row["seeded"] is True


# ------------------------------------------------------------------- the gaps

def test_write_health_persists_nothing_and_says_so(store, double, capsys):
    """The one protocol capability this store does NOT have. The Health tab has no
    reader anywhere in Python, so there is no table; the run log still carries the
    count a human took from the tab. Asserted positively — the printed line and an
    unchanged store — rather than as "nothing happened"."""
    double.calls.clear()
    store.write_health([{"company": "Acme", "result": "OK", "count": 3},
                        {"company": "Beta", "result": "ERROR", "count": 0}])
    assert double.calls == []
    err = capsys.readouterr().err
    assert "health not persisted" in err and "2 boards" in err
    assert "OK=1" in err and "ERROR=1" in err
    assert "Acme" not in err, "a company name is the user's universe, not log content"
