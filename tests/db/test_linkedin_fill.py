"""`hq_fill_linkedin_company_id` (0016), executed against Postgres.

`tests/core/test_migrations.py` reads the SQL as text: it catches a missing revoke
and an outcome the Python does not classify. It cannot catch a blank guard that
uses `btrim`, a match that uses `=` instead of `company_name_key`, or a version
token that moves when nothing changed. Everything here RUNS.

The claim this file exists to prove is one sentence — **bots fill blanks, humans
win** — and the reason it needs a database is that "win" is about ORDERING:

    the blank guard   a cell holding one tab, one NBSP or one zero-width space is
                      blank to a person and non-blank to `btrim`, so with the wrong
                      trim that company is probed every run and filled never
    human first       an engine write arriving after a paste finds a value and
                      leaves it alone — the guard is in the UPDATE's WHERE clause,
                      so this holds under concurrency and not merely in sequence
    human last        a paste arriving after an engine fill overwrites it, which is
                      the direction 0013 designed for and the engine must not break
    the race          two connections, both orders, interleaved inside open
                      transactions: the human's value is what stands
    row 96            a fill that changes nothing must not move `companies.updated_at`
                      — that token is a web app tab's optimistic-concurrency token,
                      and moving it under a no-op is the phantom conflict 0013's
                      `when (old.* is distinct from new.*)` clause was written for
    the closed set    the engine door refuses a non-digit exactly as the browser
                      door does, anchored at both ends
    parity            `core.linkedinids.is_blank` answers what `hq_blank_trim(x)=''`
                      answers, over one corpus, in this database

Run locally with a throwaway Postgres — see tests/db/test_write_path.py's docstring.
Without DATABASE_URL every test here skips.
"""
from __future__ import annotations

import os
import threading
import time
import uuid

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from core.linkedinids import is_blank  # noqa: E402
from tests.core.test_linkedinids import BLANK_CASES  # noqa: E402
from tests.db.test_referral import (  # noqa: E402  (fixtures are shared on purpose)
    company_of,
    conn,  # noqa: F401
    make_company,
    set_linkedin,
    subscribe,
    user,  # noqa: F401
)
from tests.db.test_write_path import as_user, schema  # noqa: E402,F401

__all__ = ["conn", "schema", "user"]     # re-exported fixtures; flake8 calls them unused

SOURCE = "wide-theirstack"


@pytest.fixture
def co():
    """A company name unique to this test.

    The `schema` fixture is session-scoped and `conn` does not truncate, so rows
    accumulate across the file — and this function matches on the NAME, not on an
    id. A literal "Ramp" in two tests means the second one fills the first one's
    leftover blank row and reports `filled` where `already_set` was the claim. That
    is not a hypothetical: it is what this file did on its first run.
    """
    return f"Ramp {uuid.uuid4().hex[:8]}"


def fill(conn, name, value, *, user_id, source=SOURCE):
    return conn.execute(
        "select public.hq_fill_linkedin_company_id(%s, %s, %s, %s)",
        (user_id, name, value, source),
    ).fetchone()[0]


def linkedin_of(conn, company_id):
    return conn.execute(
        "select linkedin_company_id from public.companies where id = %s",
        (company_id,),
    ).fetchone()[0]


def source_of(conn, company_id):
    return conn.execute(
        "select linkedin_id_source from public.companies where id = %s",
        (company_id,),
    ).fetchone()[0]


def set_raw(conn, company_id, value):
    """Put a value in the cell WITHOUT going through either door.

    How the pathological blanks get there in real life: a psql fix, a bulk mirror,
    or 0008's own note about the column being free-vocab. The doors would refuse
    most of these, which is exactly why the guard cannot assume they are absent.
    """
    conn.execute("update public.companies set linkedin_company_id = %s where id = %s",
                 (value, company_id))


def events_of(conn, user_id, kind):
    return conn.execute(
        "select payload from public.events where user_id = %s and kind = %s order by id",
        (user_id, kind),
    ).fetchall()


# ---------------------------------------------------------------- the happy path

def test_a_blank_cell_takes_the_harvested_id(conn, user, co):
    cid = make_company(conn, name=co)
    out = fill(conn, co, "1035", user_id=user)
    assert out["outcome"] == "filled"
    assert out["company_ids"] == [cid]
    assert linkedin_of(conn, cid) == "1035"


def test_the_fill_writes_its_audit_event(conn, user, co):
    """A state change without its event is a silent edit — and this column is
    SHARED, so "who put 1035 on Ramp" is a question somebody will ask. After this
    migration the answer is sometimes "a bot did, off a TheirStack row"."""
    make_company(conn, name=co)
    fill(conn, co, "1035", user_id=user)
    payloads = [p for (p,) in events_of(conn, user, "company.linkedin_id.filled")]
    assert len(payloads) == 1
    assert payloads[0]["linkedin_company_id"] == "1035"
    assert payloads[0]["source"] == SOURCE
    assert payloads[0]["name"] == co


def test_a_no_op_run_does_not_append_a_second_event(conn, user, co):
    """MUTATION REASON: write the event unconditionally (0013's paste path does,
    deliberately) and a bot re-reading the same TheirStack payload every morning
    files 365 identical rows a year into an append-only table. A person
    re-confirming a value is information; a cron re-reading one is not."""
    make_company(conn, name=co)
    fill(conn, co, "1035", user_id=user)
    fill(conn, co, "1035", user_id=user)
    assert len(events_of(conn, user, "company.linkedin_id.filled")) == 1


def test_a_company_nobody_has_is_answered_not_invented(conn, user):
    """`public.companies` rows are minted by the resolver and the review grid. A
    provider's job payload is recall, not grounding — inventing a row here would
    put ungrounded ghosts in the shared universe on the strength of a job ad."""
    out = fill(conn, "Zzzq Nonexistent Holdings", "1035", user_id=user)
    assert out["outcome"] == "no_company" and out["matched"] == 0
    assert conn.execute(
        "select count(*) from public.companies where name = 'Zzzq Nonexistent Holdings'"
    ).fetchone()[0] == 0


def test_the_acting_user_need_not_watch_the_company(conn, user, co):
    """0013 put this column on the SHARED row and accepted the consequence. Gating
    the engine on a subscription would mean one lane's harvest silently dropping an
    id for a company somebody else watches — `public.companies` is the design's
    monotonically-growing shared asset, and one person's list must not decide what
    is true about a company for everybody."""
    cid = make_company(conn, name=co)                # deliberately NOT subscribed
    assert fill(conn, co, "1035", user_id=user)["outcome"] == "filled"
    assert linkedin_of(conn, cid) == "1035"


# ---------------------------------------------------------------- matching

@pytest.mark.parametrize("stored,sent", [
    ("Aon", "aon"),
    ("aon", "AON"),
    ("Goldman Sachs", "Goldman Sachs"),      # NBSP out of a web page
    ("Northern  Trust", "Northern Trust"),         # collapsed run
    ("Kraft Heinz", " Kraft Heinz "),
])
def test_the_match_is_normalized_never_raw_equality(conn, user, co, stored, sent):
    """MUTATION REASON: swap `public.company_name_key(name) = v_key` for
    `name = p_name` and every row here answers `no_company` — the provider's
    spelling of a name is exactly the string that arrives folded differently from
    ours, so the harvest would report misses on companies we are watching."""
    tag = co.split()[-1]                 # unique per test; the folding must survive it
    cid = make_company(conn, name=f"{stored} {tag}")
    assert fill(conn, f"{sent} {tag}", "1035", user_id=user)["outcome"] == "filled"
    assert linkedin_of(conn, cid) == "1035"


def test_every_board_of_one_company_is_filled(conn, user, co):
    """0008's reading of the schema: one company legitimately holds more than one
    row when it has more than one board. A LinkedIn id is a fact about the COMPANY,
    so filling one and leaving its sibling blank renders a paste prompt next to a
    working link for the same employer."""
    a = make_company(conn, name=co, ats="workday", slug="abbott-wd5")
    b = make_company(conn, name=co.lower() + " ", ats="greenhouse", slug="abbott-gh")
    out = fill(conn, co, "1035", user_id=user)
    assert sorted(out["company_ids"]) == sorted([a, b])
    assert linkedin_of(conn, a) == linkedin_of(conn, b) == "1035"


# ---------------------------------------------------------------- the closed set

@pytest.mark.parametrize("bad", [
    "ramp",
    "javascript:1035",          # MUTATION REASON: unanchor `^` and this lands
    "1035; drop table x",       # MUTATION REASON: unanchor `$` and this lands
    "9" * 21,
    "10 35",
    "",
    " ",
])
def test_a_non_digit_id_is_refused_by_name(conn, user, co, bad):
    """The same closed set `app_set_linkedin_company_id` enforces, at the door a
    PROVIDER's payload arrives at — which is the one that most needs it, since
    nobody is looking at the value when it is written."""
    make_company(conn, name=co)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        fill(conn, co, bad, user_id=user)


def test_a_nameless_company_is_a_caller_bug_not_an_outcome(conn, user):
    """Answering `no_company` would let a payload whose name field is empty look
    exactly like a company we simply do not watch."""
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        fill(conn, "   ", "1035", user_id=user)


def test_no_user_is_refused(conn, co):
    make_company(conn, name=co)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        conn.execute("select public.hq_fill_linkedin_company_id(null, 'Ramp', '1', 'x')")


# ---------------------------------------------------------------- humans win

def test_the_engine_never_overwrites_a_pasted_id(conn, user, co):
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    as_user(conn, user)
    set_linkedin(conn, cid, "2077")

    out = fill(conn, co, "1035", user_id=user)
    assert out["outcome"] == "human_owned" and out["company_ids"] == []
    assert linkedin_of(conn, cid) == "2077", "a bot overwrote a person's research"


def test_an_engine_value_reports_already_set_and_a_human_one_reports_human_owned(conn, user, co):
    """The two are never collapsed, because they call for opposite reactions: one says
    the store is ahead of the provider, the other says stop asking."""
    make_company(conn, name=co)
    assert fill(conn, co, "1035", user_id=user)["outcome"] == "filled"
    assert fill(conn, co, "1035", user_id=user)["outcome"] == "already_set"
    cid = conn.execute("select id from public.companies where name = %s", (co,)).fetchone()[0]
    subscribe(conn, user, cid)
    as_user(conn, user)
    set_linkedin(conn, cid, "2077", expected=company_of(conn, cid)[1])
    assert fill(conn, co, "1035", user_id=user)["outcome"] == "human_owned"


# ---------------------------------------------------------------- the tombstone

def test_a_human_clearing_a_wrong_bot_id_is_not_undone_the_next_morning(conn, user, co):
    """CRIT-2, and the reason `linkedin_id_source` exists.

    0013 accepts `''` as a legal paste, so blanking the cell is how somebody says "the
    id in here is wrong and I do not have the right one" — and given that a bot is now
    the first writer for hundreds of companies, it is the correction they are most
    likely to make. The harvest rides the DAILY `wide_theirstack` cron and spends
    nothing, so nothing throttles it.

    MUTATION REASON: read blankness alone (`hq_blank_trim(...) = ''` with no
    provenance check) and this goes red with `filled` — which is what the first version
    did. The correction survived until 08:50 CT the next morning and then reverted,
    forever.
    """
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    as_user(conn, user)
    set_linkedin(conn, cid, "1035")                     # the bot's id, as a paste would land
    set_linkedin(conn, cid, "", expected=company_of(conn, cid)[1])   # "not this one"
    assert linkedin_of(conn, cid) == ""

    out = fill(conn, co, "1035", user_id=user)
    assert out["outcome"] == "human_owned"
    assert linkedin_of(conn, cid) == "", "the daily harvest undid a deliberate clear"
    # And again tomorrow, and the day after: the tombstone is not a one-run reprieve.
    assert fill(conn, co, "9999", user_id=user)["outcome"] == "human_owned"
    assert linkedin_of(conn, cid) == ""


def test_a_person_re_pasting_the_bots_id_claims_it(conn, user, co):
    """MUTATION REASON: keep 0013's `if v_before is distinct from v_id` alone, without
    the `or source <> 'human'` half, and the row stays ENGINE-owned no matter how many
    times somebody re-pastes the same number — so their later clear would be the first
    human write, on a row the engine had been free to rewrite all along."""
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    assert fill(conn, co, "1035", user_id=user)["outcome"] == "filled"
    assert source_of(conn, cid) == "engine"

    as_user(conn, user)
    set_linkedin(conn, cid, "1035", expected=company_of(conn, cid)[1])
    assert source_of(conn, cid) == "human"
    assert fill(conn, co, "2077", user_id=user)["outcome"] == "human_owned"


def test_the_engine_stamps_its_own_provenance(conn, user, co):
    cid = make_company(conn, name=co)
    fill(conn, co, "1035", user_id=user)
    assert source_of(conn, cid) == "engine"


def test_the_provenance_rides_home_inside_the_nested_company_object(conn, user, co):
    """`app_company_row` is re-declared in 0016 to carry `linkedin_id_source`, and this
    is the only thing that proves it does.

    The web app gates its correction control on this field, so a row builder that
    dropped the key would hand the grid `undefined`, `isEngineWrittenId` would answer
    false for every company, and the control would silently never appear again — the
    lock-out returning with every test green. `types-contract.test.ts` compares the
    TABLE's columns to the TS type and never reads this function; the e2e drives the
    fixture source and never reaches this SQL.

    MUTATION REASON: delete the `'linkedin_id_source', c.linkedin_id_source,` line from
    0016's `app_company_row` and only this test fails.
    """
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    as_user(conn, user)
    row = set_linkedin(conn, cid, "2077")
    assert row["companies"]["linkedin_company_id"] == "2077"
    assert row["companies"]["linkedin_id_source"] == "human"
    # The shared row's token still rides INSIDE `companies`, where `toCompanyView`
    # unwraps it — the new key must not have displaced 0013's own contract.
    assert "updated_at" in row["companies"] and "updated_at" in row


def test_ids_that_predate_the_column_are_labelled_human(conn, user, co):
    """The migration's one data statement. Before 0016 the only writer was the paste
    box, so every value that already existed was a person's — leaving them at `''`
    would classify their research as unowned.

    Simulated the only way a pre-0016 row can be: value in, provenance blanked out.
    """
    cid = make_company(conn, name=co)
    set_raw(conn, cid, "2077")
    conn.execute("update public.companies set linkedin_id_source = '' where id = %s", (cid,))
    conn.execute("""update public.companies set linkedin_id_source = 'human'
                     where public.hq_blank_trim(linkedin_company_id) <> ''
                       and linkedin_id_source = ''""")
    assert source_of(conn, cid) == "human"
    assert fill(conn, co, "1035", user_id=user)["outcome"] == "human_owned"


@pytest.mark.parametrize("odd", ["", "robot", "ENGINE", "Human"])
def test_an_unrecognised_provenance_does_not_lock_the_column_forever(conn, user, co, odd):
    """Anything that is not exactly 'human' is treated as not-human. The safe
    direction for THIS guard: an engine write is recoverable (a person can paste over
    it) where a column locked against every future run is not."""
    cid = make_company(conn, name=co)
    conn.execute("update public.companies set linkedin_id_source = %s where id = %s",
                 (odd, cid))
    assert fill(conn, co, "1035", user_id=user)["outcome"] == "filled"


# ---------------------------------------------------------------- per company, not per row

def test_a_paste_on_one_board_protects_its_siblings(conn, user, co):
    """MAJOR-1. `app_set_linkedin_company_id` writes ONE company row; this function
    matches every row sharing the normalized name, and 0008's reading is that one
    company legitimately holds several (one per board). So the person answered on the
    row they could see, and the engine filled the sibling.

    MUTATION REASON: judge per row — put the blank guard in the UPDATE's WHERE and drop
    the whole-company counts — and this goes red with `filled`, leaving ONE EMPLOYER
    carrying TWO DIFFERENT LinkedIn ids and no divergence signal in the outcome, the
    event or the summary. Executed on the first version: `outcome: filled  a = 2077
    b = 1035`.
    """
    a = make_company(conn, name=co, ats="workday", slug="a-wd5")
    b = make_company(conn, name=co.lower() + " ", ats="greenhouse", slug="a-gh")
    subscribe(conn, user, a)
    as_user(conn, user)
    set_linkedin(conn, a, "2077")

    out = fill(conn, co, "1035", user_id=user)
    assert out["outcome"] == "human_owned"
    assert linkedin_of(conn, a) == "2077"
    assert linkedin_of(conn, b) == "", "one employer, two LinkedIn ids"


def test_a_clear_on_one_board_protects_its_siblings_too(conn, user, co):
    """The tombstone and the per-company rule in the same case, which is the one a
    multi-board company actually produces: the person can only clear the row the grid
    showed them."""
    a = make_company(conn, name=co, ats="workday", slug="b-wd5")
    b = make_company(conn, name=co, ats="greenhouse", slug="b-gh")
    subscribe(conn, user, a)
    as_user(conn, user)
    set_linkedin(conn, a, "1035")
    set_linkedin(conn, a, "", expected=company_of(conn, a)[1])

    assert fill(conn, co, "1035", user_id=user)["outcome"] == "human_owned"
    assert linkedin_of(conn, a) == "" and linkedin_of(conn, b) == ""


def test_a_no_op_fill_does_not_move_the_version_token(conn, user, co):
    """Matrix row 96, from the other side. `companies.updated_at` is the token an
    open tab holds; 0013 made the touch trigger conditional precisely so a bulk
    writer could not turn it into an activity timestamp. A fill that writes nothing
    must not reach the trigger at all — the blank guard being in the WHERE clause is
    what guarantees that, and a guard moved into an `if` around an unconditional
    UPDATE would break it silently."""
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    as_user(conn, user)
    set_linkedin(conn, cid, "2077")
    before = company_of(conn, cid)[1]

    fill(conn, co, "1035", user_id=user)
    assert company_of(conn, cid)[1] == before


def test_a_real_fill_does_move_the_version_token(conn, user, co):
    """Non-vacuity for the test above, and the truthful half of matrix row 96: the
    value a tab is holding really did change, so its next write SHOULD conflict —
    and unlike the phantom case, reloading now shows an id."""
    cid = make_company(conn, name=co)
    before = company_of(conn, cid)[1]
    fill(conn, co, "1035", user_id=user)
    assert company_of(conn, cid)[1] > before


def test_a_paste_after_an_engine_fill_wins(conn, user, co):
    """The direction 0013 designed for, which this migration must not break: the
    person looked at the cell, disagreed with what the bot found, and said so."""
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    as_user(conn, user)
    fill(conn, co, "1035", user_id=user)

    set_linkedin(conn, cid, "2077", expected=company_of(conn, cid)[1])
    assert linkedin_of(conn, cid) == "2077"


def test_a_paste_holding_a_pre_fill_token_gets_a_truthful_conflict(conn, user, co):
    """The tab captured the row before the harvest ran. `warm-cell.tsx` says
    "Somebody set this on another device. Reload to see their value." — and here
    that sentence is TRUE, which is the whole difference between this and the
    phantom conflict 0013's conditional trigger removed."""
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    as_user(conn, user)
    stale = company_of(conn, cid)[1]
    fill(conn, co, "1035", user_id=user)

    with pytest.raises(psycopg.errors.SerializationFailure) as e:
        set_linkedin(conn, cid, "2077", expected=stale)
    assert "conflict" in str(e.value)
    assert linkedin_of(conn, cid) == "1035"


@pytest.mark.parametrize("human_first", [True, False])
def test_a_paste_and_a_harvest_in_sequence_leave_the_persons_value(conn, user, co,
                                                                   human_first):
    """The simple ordering, both ways round: whichever ran last, the id in the cell
    is the one the PERSON chose. The interleaved version is the test below."""
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    as_user(conn, user)

    if human_first:
        set_linkedin(conn, cid, "2077")
        fill(conn, co, "1035", user_id=user)
    else:
        fill(conn, co, "1035", user_id=user)
        # The tab re-reads before saving, which is what a client does after a
        # conflict. The point of this leg is that the paste still lands.
        set_linkedin(conn, cid, "2077", expected=company_of(conn, cid)[1])

    assert linkedin_of(conn, cid) == "2077"


def test_an_engine_write_that_blocks_on_a_paste_re_reads_and_stands_down(conn, user, co):
    """The claim under REAL contention, which is the only place the guard's position
    matters.

    The person's transaction writes and holds the row lock without committing. The
    engine's UPDATE then blocks on that lock — asserted, because a version of this
    test where nothing actually contends proves nothing — and when the paste commits,
    Postgres re-evaluates the engine's WHERE clause against the row as it now stands
    (read-committed's EvalPlanQual). The blank guard is IN that WHERE clause, so it
    is re-checked after the wait and matches nothing.

    MUTATION REASON: take the guard out of the UPDATE and decide from a value read
    beforehand — `select … into v_row` then `if hq_blank_trim(v_row.…) = '' then
    update …` — and this test fails while every sequential test above still passes.
    The read happens before the person's commit and the write happens after it, so a
    bot silently overwrites research somebody did thirty milliseconds earlier. That
    is the whole reason this function is one statement.
    """
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    out: dict = {}

    with psycopg.connect(DATABASE_URL) as human, psycopg.connect(DATABASE_URL) as engine:
        # Session-scoped, but applied inside a transaction — commit it, or the
        # paste below runs as nobody (the harness's auth.uid() stub returns NULL).
        human.execute("select set_config('hq.test_user', %s, false)", (user,))
        human.commit()
        token = company_of(conn, cid)[1]

        human.execute("select public.app_set_linkedin_company_id(%s,%s,%s,%s)",
                      (cid, "2077", uuid.uuid4().hex, token))          # NOT committed

        def engine_fill():
            out["row"] = engine.execute(
                "select public.hq_fill_linkedin_company_id(%s,%s,%s,%s)",
                (user, co, "1035", SOURCE)).fetchone()[0]
            engine.commit()

        t = threading.Thread(target=engine_fill)
        t.start()
        time.sleep(0.5)
        assert t.is_alive(), "the engine write never blocked — this test contends nothing"
        human.commit()
        t.join(timeout=15)
        assert not t.is_alive(), "the engine write never unblocked"

    assert out["row"]["outcome"] == "human_owned"
    assert linkedin_of(conn, cid) == "2077"


def test_two_engine_lanes_filling_at_once_write_one_value_and_one_event(conn, user, co):
    """Two lanes (a sweep harvest and a backfill) can reach the same blank at the
    same instant. One fills, the other finds it non-blank — not two events, and not
    a lost update."""
    cid = make_company(conn, name=co)
    outcomes: list[str] = []

    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        a.execute("select public.hq_fill_linkedin_company_id(%s,%s,%s,%s)",
                  (user, co, "1035", "wide-theirstack"))
        a.commit()
        row = b.execute("select public.hq_fill_linkedin_company_id(%s,%s,%s,%s)",
                        (user, co, "1035", "linkedin-backfill")).fetchone()[0]
        b.commit()
        outcomes.append(row["outcome"])

    assert outcomes == ["already_set"]
    assert linkedin_of(conn, cid) == "1035"
    assert len(events_of(conn, user, "company.linkedin_id.filled")) == 1


# ---------------------------------------------------------------- what blank means

@pytest.mark.parametrize("stored", [c for c in BLANK_CASES if c is not None],
                         ids=lambda v: repr(v))
def test_a_whitespace_only_cell_is_still_blank_to_the_engine(conn, user, co, stored):
    """MUTATION REASON: swap `public.hq_blank_trim(linkedin_company_id) = ''` for
    `btrim(linkedin_company_id) = ''` and every non-space case here stops being
    fillable — a tab, an NBSP or a zero-width space reads as ALREADY SET, so that
    company is probed on every backfill run, costs a credit every time, and never
    gets an id. `btrim(x)` with no second argument trims spaces and nothing else.
    """
    cid = make_company(conn, name=co)
    set_raw(conn, cid, stored)
    assert fill(conn, co, "1035", user_id=user)["outcome"] == "filled"
    assert linkedin_of(conn, cid) == "1035"


@pytest.mark.parametrize("stored", [c for c in BLANK_CASES if c is not None],
                         ids=lambda v: repr(v))
def test_the_python_blankness_mirror_agrees_with_the_database(conn, stored):
    """`monitor.linkedin_backfill.candidates` filters on the Python side to avoid
    spending a credit on a company the store already has an id for. Disagreement in
    one direction wastes a credit; in the other it means a company is never probed
    at all, forever, and nothing says so."""
    sql_blank = conn.execute("select public.hq_blank_trim(%s) = ''", (stored,)).fetchone()[0]
    assert is_blank(stored) is sql_blank


@pytest.mark.parametrize("stored", ["0", "1035", " 1035 ", "ramp",
                                    "1", "1", "​1"],
                         ids=lambda v: repr(v))
def test_the_mirror_agrees_on_content_too(conn, stored):
    """The C1 cases are the ones that separate `hq_blank_trim` from `str.strip()`:
    Python strips U+0085 and U+001C-U+001F, POSIX `[[:space:]]` does not. A mirror
    built on `str.strip()` calls `'\\u0085'` blank and the database does not."""
    sql_blank = conn.execute("select public.hq_blank_trim(%s) = ''", (stored,)).fetchone()[0]
    assert is_blank(stored) is sql_blank is False
