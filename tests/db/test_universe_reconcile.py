"""The paste→grounding reconciler (0009), executed against real Postgres.

This file exists to make one sentence true, the one P7 shipped as an apology in three
places at once (the add form's on-screen copy, the propose route's header, 0008's own
comment): *"nothing upgrades a pasted tier-3 row when the resolver later grounds the
same name — it writes a second row, and the subscription stays on the first."*

The scenario the P7 review demanded is `test_a_pasted_row_is_upgraded_in_place`: a human
pastes a name, gets a tier-3 placeholder and a subscription to it, the resolver grounds
that name a week later, and the SAME row becomes the board with the SAME id — so the
subscription needs no repoint and does not get one. Everything else here is the ways
that can go wrong.

Reading the SQL cannot prove any of it. `tests/core/test_migrations.py` reads it as text
and would happily pass an UPDATE that matched nothing. Run locally with a throwaway
Postgres — see tests/db/test_write_path.py's docstring. Without DATABASE_URL every test
here skips.

MUTATION TARGETS this file is meant to catch (each was run red before being run green):
  * delete the migration, or gut the UPDATE → the placeholder stays tier 3 and a second
    row appears;
  * drop the `for update` → the concurrency test's second caller upgrades a row that is
    no longer ungrounded;
  * drop the collision guard → a raw duplicate-key error, or two rows on one board;
  * let the UPDATE rewrite `name` or `source` → the human's spelling and the row's
    provenance are silently replaced;
  * grant it to `authenticated` → a browser can assert tier 1 on any name.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from core.companykeys import company_name_key                       # noqa: E402
from tests.db.test_company_review import as_user, make_company      # noqa: E402,F401
from tests.db.test_write_path import make_user, schema              # noqa: E402,F401

GOLDEN = (Path(__file__).resolve().parents[1] / "fixtures"
          / "company_name_key.golden.json")

#: Written as codepoints, never typed in: an invisible character in a test file is a
#: test nobody can read (0008's own test file says the same thing).
NBSP = chr(0x00A0)
ZWSP = chr(0x200B)
BOM = chr(0xFEFF)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


# ------------------------------------------------------------------ helpers

def reconcile(conn, name, ats, slug, tier=1, method="discover-greenhouse"):
    """The ENGINE's grounding call — `reconcile_grounded_company` is granted to no
    browser role, and the engine reaches it with the service key, which carries no
    JWT subject.

    So the identity is cleared for the duration, and since 0027 that is
    load-bearing: this function fans `company.grounded` events out to EVERY
    subscriber of the shared row, and `hq_entitlement_guard` refuses a browser
    session writing a row owned by somebody else. Running it with a leftover
    `hq.test_user` was the fixture asking the store to permit a cross-user write
    from a browser session — which is the state the guard exists to refuse and
    which the engine is never in.
    """
    prior = conn.execute("select current_setting('hq.test_user', true)").fetchone()[0]
    conn.execute("select set_config('hq.test_user', '', false)")
    try:
        return conn.execute(
            "select public.reconcile_grounded_company(%s,%s,%s,%s::smallint,%s)",
            (name, ats, slug, tier, method),
        ).fetchone()[0]
    finally:
        conn.execute("select set_config('hq.test_user', %s, false)", (prior or "",))


def propose(conn, names, source="paste"):
    """The browser's paste path — 0008's function, called exactly as the route calls it."""
    return conn.execute(
        "select public.app_propose_companies(%s,%s,%s)",
        (names, source, str(uuid.uuid4())),
    ).fetchone()[0]


def company(conn, cid):
    return conn.execute(
        "select name, ats, slug, source, reliability_tier, resolution_method "
        "from public.companies where id=%s", (cid,)
    ).fetchone()


def rows_named(conn, name):
    return conn.execute(
        "select count(*) from public.companies "
        "where public.company_name_key(name) = public.company_name_key(%s)", (name,)
    ).fetchone()[0]


# ------------------------------------------------- the scenario P7 demanded

def test_a_pasted_row_is_upgraded_in_place(conn):
    """Paste → placeholder + subscription → resolver grounds → the SAME row is the board.

    The whole feature, in one test. The assertions that matter are the id (an in-place
    upgrade needs no subscription repoint, so there must be nothing to repoint) and the
    count (one row for this name, not a placeholder plus a sibling).
    """
    name = f"Ramp Pasted {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)

    pasted = propose(conn, [name])["rows"][0]
    cid = pasted["company_id"]
    assert pasted["companies"]["reliability_tier"] == 3         # the honest floor 0008 writes
    assert (pasted["companies"]["ats"], pasted["companies"]["slug"]) == ("", "")

    out = reconcile(conn, name, "ashby", "ramp", 1, "discover-ashby")
    assert out == {"outcome": "upgraded", "company_id": cid}

    row = company(conn, cid)
    assert row[1:3] == ("ashby", "ramp")
    assert row[4:6] == (1, "discover-ashby")
    assert rows_named(conn, name) == 1, "the resolver minted a sibling beside the paste"

    # The subscription is untouched and still points at the row it always pointed at.
    assert conn.execute(
        "select company_id, review_state from public.user_companies where user_id=%s",
        (user,),
    ).fetchall() == [(cid, "proposed")]


def test_the_upgrade_survives_approval_and_reaches_the_swept_set(conn):
    """Approve the pasted company, THEN ground it — the sweep's filter must now find a board.

    `swept_companies` reads `review_state='approved' AND monitor`; before 0009 that query
    returned a row with an empty ats, i.e. a company the human approved and nothing could
    ever fetch. This asserts the post-upgrade shape that read depends on.
    """
    name = f"Grainger Pasted {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    cid = propose(conn, [name])["rows"][0]["company_id"]
    conn.execute("select public.app_set_company_review_bulk(%s,%s,%s,%s)",
                 ([cid], "approved", str(uuid.uuid4()), None))

    reconcile(conn, name, "sfsf", "grainger", 1, "discover-sfsf")

    assert conn.execute(
        """select c.ats, c.slug, uc.review_state, uc.monitor
             from public.user_companies uc join public.companies c on c.id = uc.company_id
            where uc.user_id = %s and uc.review_state = 'approved' and uc.monitor""",
        (user,),
    ).fetchall() == [("sfsf", "grainger", "approved", True)]


# ------------------------------------------------------------ name identity

@pytest.mark.parametrize(
    "label, spell",
    [
        ("as pasted", lambda s: s),
        ("upper-cased by the resolver", lambda s: s.upper()),
        ("lower-cased by the resolver", lambda s: s.lower()),
        ("padded with spaces", lambda s: f"  {s}  "),
        ("trailing NBSP from a web page", lambda s: s + NBSP),
        ("interior NBSP where a space belongs", lambda s: s.replace(" ", NBSP)),
        ("trailing zero-width space", lambda s: s + ZWSP),
        ("leading BOM", lambda s: BOM + s),
    ],
)
def test_case_and_invisible_variants_still_match_the_placeholder(conn, label, spell):
    """The resolver's spelling of a name is not the human's, and must not have to be.

    'aon', 'AON' and a name carrying the NBSP a web page pasted in are one company to
    `company_name_key`; if the reconciler matched raw strings, every one of these would
    leave the placeholder behind and mint the sibling this whole migration removes.
    """
    stem = f"Aon {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    cid = propose(conn, [stem])["rows"][0]["company_id"]

    out = reconcile(conn, spell(stem), "icims", f"aon{uuid.uuid4().hex[:6]}")

    assert out == {"outcome": "upgraded", "company_id": cid}, label
    assert rows_named(conn, stem) == 1


def test_punctuation_is_not_folded_so_two_real_companies_stay_two(conn):
    """`company_name_key` is not a slugifier, and the reconciler inherits that.

    "Guggenheim Partners, LLC" and "Guggenheim Partners LLC" are different registered
    names; folding them would MERGE two companies, which is unrecoverable from inside the
    app in a way a duplicate is not.
    """
    stem = f"Guggenheim {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    with_comma = propose(conn, [f"{stem} Partners, LLC"])["rows"][0]["company_id"]

    out = reconcile(conn, f"{stem} Partners LLC", "greenhouse", f"g{uuid.uuid4().hex[:6]}")
    assert out["outcome"] == "none"                     # no placeholder for THAT name
    assert company(conn, with_comma)[1:3] == ("", "")   # and the other one is untouched


def test_python_and_postgres_fold_names_identically(conn):
    """The parity that lets a Python reconciler drive a Postgres match at all.

    Three implementations of `company_name_key` now exist (SQL 0008, TS view-models,
    `core/companykeys.py`). If Python folds more than Postgres the reconciler asks to
    upgrade a row that does not match and quietly does nothing; if it folds less, the
    ghost comes back. The corpus is the contract, and it is the same file
    `tests/core/test_companykeys.py` pins the Python side against.

    A case carrying `sql_key` is a DOCUMENTED divergence, not a pass: Postgres's `lower()`
    is locale-dependent where Python's is not (U+0130 folds to a bare 'i' here and to
    'i'+U+0307 in Python/JS). Those cases assert the measured behaviour on BOTH sides, so
    the day a collation change moves either one this test says so instead of shrugging.
    """
    cases = json.loads(GOLDEN.read_text())
    assert len(cases) >= 35, "the corpus was trimmed — this check is only as good as it is"
    assert any("sql_key" in c for c in cases), (
        "no divergence case left in the corpus — the locale caveat in core/companykeys.py "
        "would then be prose nothing proves")
    for case in cases:
        sql = conn.execute("select public.company_name_key(%s)", (case["name"],)).fetchone()[0]
        expected_sql = case.get("sql_key", case["key"])
        assert sql == expected_sql, f"Postgres disagrees with the golden file: {case['why']}"
        assert company_name_key(case["name"]) == case["key"], (
            f"Python disagrees with the golden file: {case['why']} ({case['name']!r})")


def test_a_documented_divergence_cannot_produce_a_wrong_match(conn):
    """Why the İ divergence is survivable, asserted rather than argued.

    `reconcile_grounded_company` is handed the RAW name and computes the key ITSELF, so the
    match is Postgres-vs-Postgres and Python's disagreeing fold never enters it. The proof:
    a placeholder pasted under one spelling of a name whose fold diverges is still found and
    upgraded when the resolver grounds the other spelling.
    """
    cases = [c for c in json.loads(GOLDEN.read_text()) if "sql_key" in c]
    assert cases, "no divergence case to exercise"
    for case in cases:
        name = case["name"] + f" {uuid.uuid4().hex[:6]}"
        user = make_user(conn, f"{uuid.uuid4()}@example.com")
        as_user(conn, user)
        cid = propose(conn, [name])["rows"][0]["company_id"]
        # Python and Postgres key this name differently; Postgres is the one that matches.
        assert company_name_key(name) != conn.execute(
            "select public.company_name_key(%s)", (name,)).fetchone()[0]
        out = reconcile(conn, name.upper(), "icims", f"dv{uuid.uuid4().hex[:6]}")
        assert out == {"outcome": "upgraded", "company_id": cid}, case["why"]


# --------------------------------------------------------- the refusals

def test_no_placeholder_is_reported_as_none_and_writes_nothing(conn):
    """The common case — the resolver grounds a name nobody pasted. It must not invent a row."""
    name = f"Never Pasted {uuid.uuid4().hex[:6]}"
    before = conn.execute("select count(*) from public.companies").fetchone()[0]
    # Randomized slug: `companies_board_identity_key` is global, so a fixed one would make
    # this test's answer depend on which other test ran first.
    assert reconcile(conn, name, "lever", f"np{uuid.uuid4().hex[:6]}") == {
        "outcome": "none", "company_id": None}
    assert conn.execute("select count(*) from public.companies").fetchone()[0] == before


def test_a_grounded_row_is_never_touched(conn):
    """A company the resolver already grounded is not a placeholder; leave it alone.

    Without the `ats='' and slug=''` predicate this would re-point an existing board at
    whatever the newest call passed — a resolver bug becoming a data loss.
    """
    name = f"Already Real {uuid.uuid4().hex[:6]}"
    slug = f"real{uuid.uuid4().hex[:6]}"
    cid = make_company(conn, name=name, ats="greenhouse", slug=slug, tier=1,
                       method="discover-greenhouse")
    assert reconcile(conn, name, "ashby", f"else{uuid.uuid4().hex[:6]}")["outcome"] == "none"
    assert company(conn, cid)[1:3] == ("greenhouse", slug)


def test_a_board_that_already_has_its_own_row_is_a_collision_not_a_merge(conn):
    """Pre-0009 wreckage: a placeholder AND the grounded sibling that motivated all this.

    Collapsing the two means repointing a subscription from one company id to another.
    0009 refuses, on purpose — the caller warns and a human decides. The important part
    is that it refuses WITHOUT raising a duplicate-key error that would take the whole
    discovery batch down.
    """
    name = f"Both Shapes {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    placeholder = propose(conn, [name])["rows"][0]["company_id"]
    sibling = make_company(conn, name=name, ats="greenhouse", slug=f"bs{uuid.uuid4().hex[:6]}")
    real_slug = company(conn, sibling)[2]

    out = reconcile(conn, name, "greenhouse", real_slug)
    assert out == {"outcome": "collision", "company_id": sibling}
    assert company(conn, placeholder)[1:3] == ("", ""), "the placeholder was upgraded anyway"
    assert conn.execute(
        "select company_id from public.user_companies where user_id=%s", (user,)
    ).fetchone()[0] == placeholder      # nothing was repointed behind the human's back


def test_a_board_held_under_a_different_name_is_also_a_collision(conn):
    """(ats, slug) IS the board's identity — the table's key is (name, ats, slug), so a
    second row on one board under a different spelling is a duplicate, not a second fact.
    A guard that only checked the exact conflict key would have let this one through."""
    slug = f"dup{uuid.uuid4().hex[:6]}"
    other = make_company(conn, name=f"Board Owner {uuid.uuid4().hex[:6]}",
                         ats="ashby", slug=slug)
    name = f"Same Board {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    placeholder = propose(conn, [name])["rows"][0]["company_id"]

    assert reconcile(conn, name, "ashby", slug) == {"outcome": "collision", "company_id": other}
    assert company(conn, placeholder)[1:3] == ("", "")


def test_a_second_spelling_with_no_placeholder_is_a_collision_not_none(conn):
    """The outcome that used to be 'none', and used to fail a whole 500-row upsert chunk.

    'AON' resolves to the board 'Aon' already holds. There is no placeholder, so an earlier
    version answered 'none' — and the caller's upsert then INSERTED (its (name, ats, slug)
    triple is new), which `companies_board_identity_key` refuses, taking every other row in
    that chunk down with it. Answering 'collision' with no placeholder present is what lets
    the caller hold back one row and keep going.
    """
    slug = f"aon{uuid.uuid4().hex[:6]}"
    owner = make_company(conn, name=f"Aon {uuid.uuid4().hex[:6]}", ats="greenhouse", slug=slug)
    before = conn.execute("select count(*) from public.companies").fetchone()[0]

    out = reconcile(conn, f"AON {uuid.uuid4().hex[:6]}", "greenhouse", slug)

    assert out == {"outcome": "collision", "company_id": owner}
    assert conn.execute("select count(*) from public.companies").fetchone()[0] == before


def test_the_board_identity_index_forbids_two_rows_on_one_board(conn):
    """The constraint under the check. A check-then-write is only as good as this.

    One board belongs to one company row; two rows claiming it is never two facts. The
    table's own (name, ats, slug) key cannot express that — it is exactly what lets two
    spellings both hold greenhouse/aon.
    """
    slug = f"one{uuid.uuid4().hex[:6]}"
    make_company(conn, name=f"First {uuid.uuid4().hex[:6]}", ats="greenhouse", slug=slug)
    with pytest.raises(psycopg.errors.UniqueViolation):
        make_company(conn, name=f"Second {uuid.uuid4().hex[:6]}", ats="greenhouse", slug=slug)


def test_placeholders_are_exempt_from_the_board_index(conn):
    """PARTIAL for a reason: every placeholder has ats='' and slug='', so a non-partial index
    would let exactly ONE unresolved company exist in the whole table. 0008's
    `companies_unresolved_name_key` is what keeps placeholders unique, by NAME."""
    a = make_company(conn, name=f"Ph A {uuid.uuid4().hex[:6]}", ats="", slug="", tier=3,
                     method="manual")
    b = make_company(conn, name=f"Ph B {uuid.uuid4().hex[:6]}", ats="", slug="", tier=3,
                     method="manual")
    assert a != b
    # And one company legitimately has two boards — that must still be allowed.
    stem = f"Two Boards {uuid.uuid4().hex[:6]}"
    make_company(conn, name=stem, ats="greenhouse", slug=f"tb{uuid.uuid4().hex[:6]}")
    make_company(conn, name=stem, ats="workday", slug=f"tb{uuid.uuid4().hex[:6]}")


def test_a_blocked_grounding_tells_the_people_whose_row_is_stuck(conn):
    """The trace that makes the collision honest.

    A collision leaves somebody's pasted row at tier 3 permanently. Reporting that only in
    the caller's log means the one person who needs to know is the only one who cannot see
    it — the warning goes to a Lambda log and they are looking at a grid. The event is the
    smallest mechanism the schema already has; it is queryable, per-user, and next to the
    paste that created the row.
    """
    slug = f"blk{uuid.uuid4().hex[:6]}"
    owner = make_company(conn, name=f"Owner {uuid.uuid4().hex[:6]}", ats="ashby", slug=slug)
    name = f"Stuck Co {uuid.uuid4().hex[:6]}"
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, a)
    cid = propose(conn, [name])["rows"][0]["company_id"]
    as_user(conn, b)
    propose(conn, [name])

    assert reconcile(conn, name, "ashby", slug)["outcome"] == "collision"

    got = conn.execute(
        "select user_id, payload->>'blocked_by_company_id', payload->>'reason', actor "
        "from public.events where kind = 'company.grounding_blocked' "
        "and (payload->>'company_id')::bigint = %s", (cid,),
    ).fetchall()
    assert sorted(str(r[0]) for r in got) == sorted([str(a), str(b)])
    assert {r[1] for r in got} == {str(owner)}
    assert all("repoint" in r[2] and r[3] == "system" for r in got)


def test_a_collision_with_nobody_subscribed_writes_no_event(conn):
    """`events.user_id` is a real FK. An unconditional insert of a null user would fail the
    whole reconcile for the ingesters' normal case — a company discovered before anyone
    subscribes."""
    slug = f"nos{uuid.uuid4().hex[:6]}"
    make_company(conn, name=f"Owner {uuid.uuid4().hex[:6]}", ats="lever", slug=slug)
    name = f"Nobody {uuid.uuid4().hex[:6]}"
    make_company(conn, name=name, ats="", slug="", tier=3, method="manual")
    before = conn.execute(
        "select count(*) from public.events where kind='company.grounding_blocked'"
    ).fetchone()[0]
    assert reconcile(conn, name, "lever", slug)["outcome"] == "collision"
    assert conn.execute(
        "select count(*) from public.events where kind='company.grounding_blocked'"
    ).fetchone()[0] == before


def test_a_slug_only_candidate_is_skipped_not_matched(conn):
    """Common Crawl rows carry no human name. `company_name_key('')` is '', and every
    placeholder would match an empty key if the guard were missing — the resolver would
    upgrade an unrelated company on its first mined slug."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    victim = propose(conn, [f"Innocent {uuid.uuid4().hex[:6]}"])["rows"][0]["company_id"]
    assert reconcile(conn, "", "greenhouse", "airbnb") == {"outcome": "skipped",
                                                           "company_id": None}
    assert reconcile(conn, "  " + ZWSP + " ", "greenhouse", "airbnb")["outcome"] == "skipped"
    assert company(conn, victim)[1:3] == ("", "")


@pytest.mark.parametrize(
    "args",
    [("", "slug", 1, "m"), ("greenhouse", "", 1, "m"), ("greenhouse", "s", 4, "m"),
     ("greenhouse", "s", 1, ""), ("  ", "s", 1, "m")],
)
def test_a_half_resolved_board_is_refused_loudly(conn, args):
    """Fail loud, never guess. An empty ats/slug would write a placeholder back onto
    itself while stamping a tier; an out-of-range tier would fail 0007's CHECK deeper in,
    with a message about a constraint rather than about the call."""
    name = f"Half {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    propose(conn, [name])
    ats, slug, tier, method = args
    with pytest.raises(psycopg.errors.Error):
        reconcile(conn, name, ats, slug, tier, method)


# ------------------------------------------------- what it must NOT rewrite

def test_the_humans_name_and_the_rows_provenance_survive_the_upgrade(conn):
    """`name` is the human's — they typed it, and the keys already match, so rewriting it
    is a bot overwriting a person. `source` records where the company ENTERED the universe,
    which really was the paste; what changed is how it RESOLVED."""
    name = f"Kept Spelling {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    cid = propose(conn, [name], source="paste")["rows"][0]["company_id"]

    reconcile(conn, name.upper(), "icims", "kept", 1, "discover-icims")

    row = company(conn, cid)
    assert row[0] == name, "the resolver rewrote the human's spelling"
    assert row[3] == "paste", "the row's provenance was replaced by the resolver's"
    assert row[5] == "discover-icims"


def test_every_subscriber_gets_an_event(conn):
    """The one shared-table write a human is owed a note about: they were told on screen
    that a pasted row stays tracked, and it just became a real board."""
    name = f"Evented {uuid.uuid4().hex[:6]}"
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, a)
    cid = propose(conn, [name])["rows"][0]["company_id"]
    as_user(conn, b)
    propose(conn, [name])          # b binds to the same shared row

    slug = f"ev{uuid.uuid4().hex[:6]}"
    reconcile(conn, name, "lever", slug, 1, "discover-lever")

    got = conn.execute(
        "select user_id, payload->>'ats', payload->>'slug', actor from public.events "
        "where kind = 'company.grounded' and (payload->>'company_id')::bigint = %s "
        "order by user_id", (cid,),
    ).fetchall()
    assert sorted(str(r[0]) for r in got) == sorted([str(a), str(b)])
    assert {(r[1], r[2], r[3]) for r in got} == {("lever", slug, "system")}


def test_a_company_nobody_watches_upgrades_without_an_event(conn):
    """No subscriber, no note — and no crash. `events.user_id` is a real FK, so an
    unconditional insert of a null user would fail the whole reconcile for the ingesters'
    normal case (a company discovered before anyone subscribes)."""
    name = f"Unwatched {uuid.uuid4().hex[:6]}"
    slug = f"unw{uuid.uuid4().hex[:6]}"
    cid = make_company(conn, name=name, ats="", slug="", tier=3, method="manual")
    assert reconcile(conn, name, "lever", slug)["outcome"] == "upgraded"
    assert company(conn, cid)[1:3] == ("lever", slug)


# ------------------------------------------------------------- concurrency

def test_two_sweeps_grounding_the_same_name_produce_one_row(conn):
    """The race the `for update` exists for.

    Two runs ground the same pasted name at the same moment. Without the lock both see the
    placeholder, both UPDATE, and the second either duplicates the board or clobbers the
    first's resolution. Exactly one must win; the other must report `collision` or `none`
    and leave a single row standing.
    """
    name = f"Raced {uuid.uuid4().hex[:6]}"
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    cid = propose(conn, [name])["rows"][0]["company_id"]

    outcomes: list[dict] = []
    errors: list[Exception] = []
    barrier = threading.Barrier(2)

    def worker(ats, slug):
        try:
            with psycopg.connect(DATABASE_URL, autocommit=True) as c:
                barrier.wait(timeout=10)
                outcomes.append(reconcile(c, name, ats, slug))
        except Exception as exc:                       # pragma: no cover - surfaces below
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=a)
               for a in (("greenhouse", f"r{uuid.uuid4().hex[:6]}"),
                         ("ashby", f"r{uuid.uuid4().hex[:6]}"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    assert not errors, errors
    assert sorted(o["outcome"] for o in outcomes) == ["none", "upgraded"]
    assert rows_named(conn, name) == 1
    assert company(conn, cid)[1] in ("greenhouse", "ashby")


def test_reconciling_twice_is_idempotent(conn):
    """A re-run of the same discovery pass must not do anything the first did not.

    There is no idempotency key here on purpose — the operation is naturally idempotent
    because the second call finds no placeholder. Asserting it means a future change that
    breaks that property is caught rather than discovered in a nightly.
    """
    name = f"Twice {uuid.uuid4().hex[:6]}"
    slug = f"tw{uuid.uuid4().hex[:6]}"
    cid = make_company(conn, name=name, ats="", slug="", tier=3, method="manual")
    assert reconcile(conn, name, "lever", slug)["outcome"] == "upgraded"
    # Second pass: the placeholder is gone, and the board is now held by THIS row — which the
    # `id is distinct from v_id` guard has to exclude, or a re-run would report a collision
    # with itself.
    assert reconcile(conn, name, "lever", slug)["outcome"] == "none"
    assert rows_named(conn, name) == 1
    assert company(conn, cid)[4] == 1


def test_two_lanes_grounding_one_board_cannot_both_win(conn):
    """The TOCTOU the collision READ could not close, driven as a deliberate interleave.

    Two DIFFERENT pasted names, so the two calls do not serialize on the placeholder's
    `for update` — that lock protects one row, and this race is about one BOARD. Both lanes
    read "nobody holds this board", both proceed, and before `companies_board_identity_key`
    existed both UPDATEs committed: two rows on one board, zero collisions reported.

    Interleaved by hand rather than raced with a barrier, because a barrier proves it only
    when the timing happens to land:

      A: begin; reconcile(name_a -> greenhouse/slug)  -> 'upgraded', NOT yet committed
      B: begin; reconcile(name_b -> greenhouse/slug)  -> blocks on the unique index
      A: commit
      B: unblocks -> unique_violation -> handler -> 'collision'

    The handler is what turns B's loss into an answer the caller can act on instead of an
    exception that fails a 500-row batch.
    """
    slug = f"race{uuid.uuid4().hex[:6]}"
    name_a = f"Lane A {uuid.uuid4().hex[:6]}"
    name_b = f"Lane B {uuid.uuid4().hex[:6]}"
    id_a = make_company(conn, name=name_a, ats="", slug="", tier=3, method="manual")
    id_b = make_company(conn, name=name_b, ats="", slug="", tier=3, method="manual")

    result_b: list = []
    errors: list = []

    def lane_b():
        try:
            with psycopg.connect(DATABASE_URL) as cb:      # autocommit off: a real transaction
                result_b.append(reconcile(cb, name_b, "greenhouse", slug))
                cb.commit()
        except Exception as exc:                            # pragma: no cover - surfaces below
            errors.append(exc)

    with psycopg.connect(DATABASE_URL) as ca:
        assert reconcile(ca, name_a, "greenhouse", slug) == {"outcome": "upgraded",
                                                             "company_id": id_a}
        t = threading.Thread(target=lane_b)
        t.start()
        # Give B time to reach the index and block on A's uncommitted row. If it has not, the
        # test still passes on the pre-read path — it just proves less, which the assertion
        # below reports rather than hides.
        time.sleep(1.0)
        blocked = t.is_alive()
        ca.commit()

    t.join(timeout=20)
    assert not errors, errors
    assert blocked, ("lane B never blocked on the index — the interleave did not happen, so "
                     "this run did not exercise the unique-violation handler")
    assert result_b == [{"outcome": "collision", "company_id": id_a}]
    assert company(conn, id_a)[1:3] == ("greenhouse", slug)
    assert company(conn, id_b)[1:3] == ("", ""), "lane B upgraded anyway — two rows, one board"
    assert conn.execute(
        "select count(*) from public.companies where ats = 'greenhouse' and slug = %s", (slug,)
    ).fetchone()[0] == 1


# ---------------------------------------------------------------- privilege

def test_a_browser_session_cannot_assert_a_reliability_tier(conn):
    """The reason this is not a `security definer` function granted to `authenticated`.

    `app_propose_companies` writes tier 3 / 'manual' precisely because nothing reachable
    from the web app probes an ATS. A browser-callable function that stamps tier 1 onto a
    name is the fabricated day-of promise that rule exists to prevent — and Supabase's
    default privileges grant execute on new functions to `authenticated`, so
    `revoke from public` alone would NOT have closed this door.
    """
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user),))
    conn.execute("set role authenticated")
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            reconcile(conn, "Anything", "greenhouse", "anything")
    finally:
        conn.execute("reset role")
