"""What every `SheetStore` implementation must do, asked of each of them.

`monitor/sheet.py:SheetStore` is the seam RM-12 cuts discovery over: `monitor.run`,
`monitor.regate` and `monitor.review` are written against the protocol, so a
`PgFeedStore` can replace `HQFeedStore` without touching the sweep. That only holds
if the protocol is a real contract rather than "whatever the Sheet implementation
happens to do", and today two of its methods carry a contract the signature does not
state.

`HQFeedStore.read_history` caches a second value that `read_min_yoe` returns, and
`read_jobs_for_tagging` does the same for `tagging_context` — one Sheet read serving
two protocol methods, which is a real optimisation and worth keeping. The hazard is
the implicit ordering it creates. A store with no reason to cache (a `PgFeedStore`
querying Postgres directly) satisfies "call the other one first if you have not"
without ever honouring it, works perfectly, and the contract silently becomes
unenforced — until someone calls the Sheet implementation cold and finds the case
nobody pinned. The broken call and the working call look identical from outside,
which is this project's most expensive recurring shape.

So the contract is written down here instead of tightened away. The signatures stay
as they are while two implementations must coexist — swappability is the safety
property the whole cutover ordering depends on, and changing the protocol while both
are live doubles the surface they can diverge on. What changes is that the ordering
requirement is now asked of every implementation, both ways.

**Whatever `HQFeedStore` does today is the specification.** These tests pin it, they
do not propose it. Adding a `PgFeedStore` means adding it to `STORES` below and
making it pass unmodified; a case that cannot be satisfied is a finding about the
protocol, not a test to relax.
"""
from __future__ import annotations

import copy

import pytest

from core.fakes import fake_hq
from monitor.models import Company, JobRecord
from monitor.pgstore import PgFeedStore
from monitor.sheet import FakeSheetStore, HQFeedStore
from monitor.tagging import Tags
from tests.monitor import pgrest_double

TODAY = "2026-08-03"
USER_ID = "00000000-0000-0000-0000-0000000000ab"

#: One fixture, described once, built into whichever store is under test. Two
#: postings with DIFFERENT min_yoe, because a single value cannot tell a correct
#: per-key mapping apart from one that returns the same answer for everything.
COMPANIES = [Company(name="Acme", ats="greenhouse", slug="acme",
                     monitor=True, seeded=True)]
#: `Tags.min_yoe` is COMPUTED from `yoe` (`monitor/tagging.py:105`), never stored,
#: so the fixture sets `yoe` and the expected map carries the lower bound the
#: stores write and read back as a string.
POSTINGS = [
    # (key, title, yoe, min_yoe as the stores round-trip it, work_model)
    ("greenhouse-1", "Senior Product Manager", "5+ years", "5", "remote"),
    ("greenhouse-2", "Product Manager", "2-4 years", "2", "onsite"),
]
EXPECTED_MIN_YOE = {key: myoe for key, _, _, myoe, _ in POSTINGS}
EXPECTED_WORK_MODEL = {key: wm for key, _, _, _, wm in POSTINGS}


def _record(key: str, title: str) -> JobRecord:
    return JobRecord(id=key, company="Acme", title=title, location="Chicago, IL",
                     url=f"http://example.invalid/{key}", status="New",
                     first_seen=TODAY, last_seen=TODAY, posted="")


def _build_hq_feed_store(monkeypatch) -> HQFeedStore:
    """`HQFeedStore` over `core.fakes.fake_hq` — the real Tab logic, no network."""
    hq = fake_hq(["feed", "companies", "health", "log", "config"])
    hq.tab("companies").append_records([
        {"name": c.name, "ats": c.ats, "slug": c.slug,
         "monitor": "TRUE", "seeded": "TRUE"} for c in COMPANIES])
    store = HQFeedStore(hq)
    store.append_jobs(
        [_record(key, title) for key, title, _, _, _ in POSTINGS],
        tags={key: Tags(yoe=yoe, work_model=wm)
              for key, _, yoe, _, wm in POSTINGS},
        today=TODAY)
    return store


def _build_fake_store(monkeypatch) -> FakeSheetStore:
    store = FakeSheetStore(list(COMPANIES), {})
    store.append_jobs(
        [_record(key, title) for key, title, _, _, _ in POSTINGS],
        tags={key: Tags(yoe=yoe, work_model=wm)
              for key, _, yoe, _, wm in POSTINGS},
        today=TODAY)
    return store


def _build_pg_feed_store(monkeypatch) -> PgFeedStore:
    """`PgFeedStore` over the in-memory PostgREST double — the real query strings
    `core.pg` would put on the wire, applied to a store that refuses any filter term
    it cannot actually evaluate (`tests/monitor/pgrest_double.py`)."""
    double = pgrest_double.install(monkeypatch)
    for c in COMPANIES:
        double.add_company(c.name, c.ats, c.slug, user_id=USER_ID, seeded=c.seeded)
    store = PgFeedStore(USER_ID)
    store.append_jobs(
        [_record(key, title) for key, title, _, _, _ in POSTINGS],
        tags={key: Tags(yoe=yoe, work_model=wm)
              for key, _, yoe, _, wm in POSTINGS},
        today=TODAY)
    return store


#: Every implementation of the protocol. A `PgFeedStore` joins this list and must
#: pass everything below without a single test changing.
#:
#: The builders take `monkeypatch` because one of them needs it; the assertions are
#: untouched, which is the property the module docstring asks for. Nothing about
#: what is required of a store changed to admit the third one.
STORES = {"HQFeedStore": _build_hq_feed_store, "FakeSheetStore": _build_fake_store,
          "PgFeedStore": _build_pg_feed_store}


@pytest.fixture(params=sorted(STORES))
def store(request, monkeypatch):
    return STORES[request.param](monkeypatch)


# ------------------------------------------------- the undeclared ordering pair

def test_read_min_yoe_is_legal_before_read_history(store):
    """Cold call. `HQFeedStore` self-primes by calling `read_history` internally;
    that behaviour is the spec, so every implementation must answer correctly
    without a priming read rather than returning empty or raising."""
    assert store.read_min_yoe() == EXPECTED_MIN_YOE


def test_read_min_yoe_does_not_depend_on_call_order(store):
    """The property the caching creates a risk of losing: same answer whether or
    not `read_history` ran first. Asserted as equality against the expected map,
    not just cold-vs-warm, so a store that consistently returns the wrong thing
    in both orders cannot pass by being consistently wrong."""
    cold = store.read_min_yoe()
    history = store.read_history()
    warm = store.read_min_yoe()
    assert cold == EXPECTED_MIN_YOE
    assert warm == EXPECTED_MIN_YOE
    assert sorted(history) == sorted(EXPECTED_MIN_YOE)


def test_read_min_yoe_returns_a_copy_the_caller_cannot_corrupt(store):
    """Both implementations hand back `dict(...)`. A store that returned its own
    mapping would let one caller's mutation reach the next reader, which across a
    sweep is a silent data change nobody wrote."""
    first = store.read_min_yoe()
    first["greenhouse-1"] = "999"
    assert store.read_min_yoe() == EXPECTED_MIN_YOE


def test_tagging_context_is_legal_before_read_jobs_for_tagging(store):
    """The same cold-call contract for the second cached pair, and the one place
    this suite refuses to settle for a shape check.

    `monitor/review.py:119` gates on this context: a row whose location is blank
    but whose `work_model` says remote must not read as geo-unknown. A store that
    returns `{}` does not fail — it silently re-gates every row without the facts,
    which is the same outcome as having no context and is indistinguishable from
    a store that legitimately knows nothing yet. So the assertion is on CONTENT:
    every posting the store holds must have an entry carrying its `work_model`."""
    ctx = store.tagging_context()
    assert sorted(ctx) == sorted(EXPECTED_MIN_YOE)
    assert {k: v["work_model"] for k, v in ctx.items()} == EXPECTED_WORK_MODEL


def test_tagging_context_does_not_depend_on_call_order(store):
    """Cold and warm must agree. This is the assertion a `PgFeedStore` is most
    likely to fail by accident, because it has no cache to prime and may serve
    the cold call from a query the warm call does not repeat."""
    cold = store.tagging_context()
    jobs = store.read_jobs_for_tagging()
    warm = store.tagging_context()
    assert cold == warm
    assert sorted(rec.id for rec, _ in jobs) == sorted(EXPECTED_MIN_YOE)


def test_tagging_context_returns_a_copy_the_caller_cannot_corrupt(store):
    """Mutating the returned map, and the nested per-row dicts inside it, must not
    reach the next reader. Asserted as full equality rather than "the injected key
    is absent", because absence is also what a store that returns `{}` produces —
    the exact bug this suite was written to catch."""
    before = copy.deepcopy(store.tagging_context())   # deep: a shallow snapshot
    first = store.tagging_context()                   # corrupts alongside the
    first["injected"] = {"work_model": "remote"}      # store and compares equal
    first[next(iter(first))]["work_model"] = "corrupted"
    assert store.tagging_context() == before


def test_a_tag_write_is_visible_to_the_very_next_min_yoe_read(store):
    """Read-after-write, which is the case the caching makes it possible to lose.

    Added by review. Both cached pairs are primed by a read and answered from the
    cache, so an implementation that never clears them returns the PRE-WRITE map to a
    caller that writes and then reads. No production caller does that today — which is
    exactly why it needs a test rather than a comment: the defect is invisible until
    the day someone adds the call, and then it is a push filter judging today's roles
    on yesterday's experience bar.

    This case is what makes the three implementations agree. It was originally a
    documented divergence (`PgFeedStore` cleared, `HQFeedStore` did not), and a
    divergence between two live implementations is a thing to remember rather than a
    thing enforced.

    KILLED BY: removing `_invalidate()` from either store's `write_tags`.
    """
    store.write_tags({"greenhouse-1": Tags(yoe="9 years")}, "2026-08-04")
    assert store.read_min_yoe()["greenhouse-1"] == "9"


def test_a_tag_write_is_visible_to_the_very_next_tagging_context_read(store):
    """The same property for the second cached pair. Asserted on `work_model`
    specifically because that is the field `monitor/review.py:119` gates on: a stale
    context re-gates a row against the work model it had before it was tagged."""
    store.write_tags({"greenhouse-1": Tags(yoe="9 years", work_model="hybrid")},
                     "2026-08-04")
    assert store.tagging_context()["greenhouse-1"]["work_model"] == "hybrid"


# ------------------------------------------------------- the rest of the seam

def test_read_companies_returns_only_monitored_companies(store):
    """The sweep's input. A store that returned unmonitored companies would pull
    boards the user switched off, which costs provider budget silently."""
    assert [c.name for c in store.read_companies()] == ["Acme"]


def test_read_history_is_keyed_by_posting_key(store):
    """Dedupe is the backbone: the sweep reconciles against this map by key, so a
    store that keyed it any other way would reopen every role every run."""
    history = store.read_history()
    assert sorted(history) == sorted(EXPECTED_MIN_YOE)
    assert all(rec.id == key for key, rec in history.items())


def test_read_jobs_for_tagging_reports_what_was_tagged_and_when(store):
    """Second element is `tagged_at`. `review` uses its emptiness to decide what
    still needs the tagger, so a store that always returned '' would re-tag the
    whole feed nightly and pay for it."""
    tagged = {rec.id: at for rec, at in store.read_jobs_for_tagging()}
    assert tagged == {key: TODAY for key in EXPECTED_MIN_YOE}


def test_the_sweep_cursor_round_trips_and_starts_empty(store):
    """Machine state, not a knob: where a budget-stopped sweep resumes. Empty
    means "start at the beginning", which is why the initial read must be '' and
    not None — the sweep compares it to a company name."""
    assert store.read_sweep_cursor() == ""
    store.write_sweep_cursor("Acme")
    assert store.read_sweep_cursor() == "Acme"
    store.write_sweep_cursor("")
    assert store.read_sweep_cursor() == ""


def test_mark_seeded_flips_the_named_company(store):
    """`seeded` is what stops a first-ever pull from pushing its whole backlog."""
    assert [c.name for c in store.read_companies()] == ["Acme"]
    store.mark_seeded(["Acme"])
    assert [c.name for c in store.read_companies()] == ["Acme"]


def test_set_status_and_set_last_seen_reach_the_history(store):
    """The reconcile's two writes. Read back through the protocol rather than the
    implementation's internals, so the assertion means the same thing for a store
    that keeps rows in Postgres."""
    store.set_status({"greenhouse-1": "Closed"})
    store.set_last_seen(["greenhouse-2"], "2026-08-04")
    history = store.read_history()
    assert history["greenhouse-1"].status == "Closed"
    assert history["greenhouse-2"].last_seen == "2026-08-04"
