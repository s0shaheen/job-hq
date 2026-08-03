"""The referral finder's layer-0 write paths, executed against Postgres (0013).

`tests/core/test_migrations.py` reads the SQL as text. It catches an RPC the web
app calls that nobody defined; it cannot catch a regexp that is anchored on one
end, a generated column normalized with the wrong function, or a report whose
four numbers do not add up to the file. Everything here RUNS.

What it proves that reading the migration cannot:

    the closed set   `app_set_linkedin_company_id` takes digits or nothing, and
                     the regexp is anchored at BOTH ends — an unanchored
                     `~ '[0-9]{1,20}'` matches the digits inside `javascript:1`
                     and lets the whole string into a column a URL builder
                     concatenates
    row 96           `companies_touch` moves the shared row's version token on a
                     write that did NOT come through the RPC, so a backfill or a
                     psql fix cannot freeze the token under an open tab
    the nested row   `app_company_row` carries `linkedin_company_id` and the
                     company's own `updated_at` home inside `companies`, which is
                     where `toCompanyView` reads them
    0008's NBSP      `connections.company_key` is generated from
                     `company_name_key`, so a connection at "Goldman<NBSP>Sachs"
                     matches a posting at "Goldman Sachs" — `lower()` would not
    0010's blank     `hq_blank_trim`, never bare `btrim`: a name of one newline
                     is blank, is SKIPPED, and is counted as skipped
    0011's blank     a blank cell on re-import means "the file did not say", never
                     "delete what you have"
    row 169          inserted + updated + skipped + deduped == rows in, on a chunk
                     carrying at least one of each — a report that does not close
                     is one nobody can check afterwards
    row 95/191       two overlapping chunks handed to two connections in OPPOSITE
                     orders both commit, rather than one dying with 40P01

Run locally with a throwaway Postgres — see tests/db/test_write_path.py's
docstring. Without DATABASE_URL every test here skips.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import threading
import uuid
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from tests.db.test_write_path import (  # noqa: E402  (fixtures are shared on purpose)
    as_user,
    gate,  # noqa: F401 — imported with the rest of the shared set
    make_posting,
    make_user,
    schema,  # noqa: F401 — session fixture
)

MIGRATION = Path(__file__).resolve().parents[2] / "db" / "migrations" / "0013_referral.sql"


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def user(conn):
    # A fresh address per test: `make_user` defaults to one literal email and the
    # signup trigger enforces uniqueness, so the default would make every test
    # after the first fail on a UniqueViolation that says nothing about referrals.
    u = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, u)
    return u


#: `idem=AUTO` means "mint one"; `idem=""` has to reach the function verbatim, or
#: the blank-key probe tests the helper's `or` instead of the guard.
AUTO = object()


# ------------------------------------------------------------------ helpers

def make_company(conn, name=None, ats="greenhouse", slug=None):
    """A resolved shared-universe company row, as monitor.discover_universe writes one."""
    return conn.execute(
        """insert into public.companies
             (name, ats, slug, source, reliability_tier, resolution_method)
           values (%s, %s, %s, 'test', 1, 'discover-greenhouse') returning id""",
        (name or f"Co {uuid.uuid4().hex[:8]}", ats, slug or uuid.uuid4().hex[:8]),
    ).fetchone()[0]


def subscribe(conn, user_id, company_id, review_state="approved"):
    # `monitor` may only be true on an approved row (0008's CHECK), so it is
    # derived here rather than defaulted — a bare insert would raise.
    conn.execute(
        """insert into public.user_companies (user_id, company_id, monitor, review_state)
           values (%s, %s, %s, %s) on conflict (user_id, company_id) do nothing""",
        (user_id, company_id, review_state == "approved", review_state),
    )


@pytest.fixture
def watched(conn, user):
    """A user who watches one approved company — the door `app_set_linkedin_company_id` wants."""
    cid = make_company(conn)
    subscribe(conn, user, cid)
    return cid


def set_linkedin(conn, company_id, value, *, idem=AUTO, expected=None):
    return conn.execute(
        "select public.app_set_linkedin_company_id(%s, %s, %s, %s)",
        (company_id, value, uuid.uuid4().hex if idem is AUTO else idem, expected),
    ).fetchone()[0]


def company_of(conn, company_id):
    return conn.execute(
        "select linkedin_company_id, updated_at from public.companies where id = %s",
        (company_id,),
    ).fetchone()


def imp(conn, rows, *, source="linkedin-export", idem=AUTO):
    return conn.execute(
        "select public.app_import_connections(%s::jsonb, %s, %s)",
        (json.dumps(rows), source, uuid.uuid4().hex if idem is AUTO else idem),
    ).fetchone()[0]


def clear(conn, *, idem=AUTO):
    return conn.execute(
        "select public.app_clear_connections(%s)",
        (uuid.uuid4().hex if idem is AUTO else idem,),
    ).fetchone()[0]


def rows_of(conn, user_id):
    return conn.execute(
        """select full_name, first_name, last_name, company, company_key, title,
                  profile_url, connected_on, source
             from public.connections where user_id = %s order by id""",
        (user_id,),
    ).fetchall()


def events(conn, user_id, kind=None):
    if kind is None:
        return conn.execute(
            "select kind, payload from public.events where user_id = %s order by id",
            (user_id,),
        ).fetchall()
    return conn.execute(
        "select payload from public.events where user_id = %s and kind = %s order by id",
        (user_id, kind),
    ).fetchall()


# ================================================ app_set_linkedin_company_id


def test_a_pasted_id_rides_home_inside_the_nested_company_object(conn, user, watched):
    """The whole point of re-declaring `app_company_row` in this migration.

    The grid renders the row the WRITE returned, so an id that lands in the column
    but not in the returned object shows the paste vanishing until a reload.

    MUTATION REASON: delete `'linkedin_company_id', c.linkedin_company_id` (or
    `'updated_at', c.updated_at`) from `app_company_row`'s nested `companies`
    object — `toCompanyView` reads undefined and the deep link never renders.
    """
    row = set_linkedin(conn, watched, "1035")

    assert row["companies"]["linkedin_company_id"] == "1035"
    assert row["companies"]["id"] == watched
    # The shared row's own version token travels with it, distinct from the
    # subscription's — the two guard different writes.
    assert row["companies"]["updated_at"], "the company's version token is missing"
    assert row["updated_at"], "the subscription's version token is missing"
    assert row["companies"]["updated_at"] != row["updated_at"]
    assert company_of(conn, watched)[0] == "1035"


@pytest.mark.parametrize(
    "pasted",
    [
        " 1035 ",
        "\t1035\n",
        # NBSP and zero-width space written as escapes: an invisible character in
        # a test file is a test nobody can read. The NBSP is what copying the
        # number out of a rendered page leaves behind (0008's lesson), and it is
        # the one `btrim` does not strip.
        "\u00a01035\u00a0",
        "\u200b1035\u200b",
    ],
)
def test_whitespace_around_a_pasted_id_is_trimmed_off(conn, user, watched, pasted):
    """`hq_blank_trim`, not `btrim`.

    MUTATION REASON: swap `public.hq_blank_trim(coalesce(p_linkedin_id, ''))` for
    `btrim(...)` — btrim strips spaces only, so the NBSP and the zero-width space
    survive, the anchored regexp then refuses the value, and pasting the number
    the way every human pastes it reports "digits only" about a string of digits.
    """
    assert set_linkedin(conn, watched, pasted)["companies"]["linkedin_company_id"] == "1035"
    assert company_of(conn, watched)[0] == "1035"


def test_an_empty_string_clears_a_previously_set_id(conn, user, watched):
    """Somebody who pasted the wrong number has to be able to remove it, and there
    is no other gesture that can: the column is free-vocab, the browser cannot
    write it directly, and a wrong id points the deep link at another company.

    MUTATION REASON: drop the `v_id <> '' and` guard in front of the regexp check —
    `''` then fails `^[0-9]{1,20}$` and the clear becomes impossible. Wrapping the
    UPDATE in `if v_id <> ''` has the same effect more quietly: the call succeeds
    and the wrong id stays.
    """
    set_linkedin(conn, watched, "1035")
    assert company_of(conn, watched)[0] == "1035"

    row = set_linkedin(conn, watched, "")
    assert row["companies"]["linkedin_company_id"] == ""
    assert company_of(conn, watched)[0] == ""


@pytest.mark.parametrize(
    "bad",
    [
        # The anchoring probes. An unanchored `~ '[0-9]{1,20}'` finds a digit run
        # INSIDE each of these and lets the whole string through.
        "javascript:1",
        "12 34",
        "1" * 21,
        "1035/../evil",
        "1035%20",
        # …and the no-digits-at-all case, which even an unanchored regexp refuses,
        # so the parametrization is not all one mutant.
        "abc",
        "'; drop table connections;--",
    ],
)
def test_a_non_digit_linkedin_id_is_refused(conn, user, watched, bad):
    """MUTATION REASON: change `v_id !~ '^[0-9]{1,20}$'` to `v_id !~ '[0-9]{1,20}'`.

    `webapp/lib/referral/linkedin.ts` refuses to build a URL out of anything that
    is not digits, but the guard is needed at BOTH ends — this column is shared,
    every watcher of the company reads it, and the day the engine backfills it is
    the day somebody's company cell renders a link nobody wrote.
    """
    set_linkedin(conn, watched, "1035")
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        set_linkedin(conn, watched, bad)
    assert "digits only" in exc.value.diag.message_primary.lower()
    # And nothing was written: the refusal is not a partial paste.
    assert company_of(conn, watched)[0] == "1035"


def test_the_closed_set_admits_the_ids_that_are_real(conn, user, watched):
    """The positive control the refusals above are meaningless without: a test that
    refuses EVERY value passes the parametrization and breaks the feature."""
    for good in ("1", "1035", "9" * 20, "0"):
        assert set_linkedin(conn, watched, good)["companies"]["linkedin_company_id"] == good


@pytest.mark.parametrize("bad", ["", " ", "\n", "\u00a0", "x" * 201])
def test_a_blank_idempotency_key_is_refused_by_the_blank_trim_door(conn, user, watched, bad):
    """`command_idempotency`'s primary key is (user_id, idem_key) and `''` is a
    legal text value, so one caller sending a blank key would have every LATER
    blank key replay this gesture's result forever (matrix rows 110, 129, 218).

    MUTATION REASON: replace `public.hq_blank_trim(p_idem) = ''` with
    `length(p_idem) = 0`. A key of one space is blank to a person and length 1 to
    Postgres, so `' '` and `'\\n'` sail through — which is exactly the bug the
    `idem=""` sentinel in this file's helpers exists to keep reachable.
    """
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        set_linkedin(conn, watched, "1035", idem=bad)
    assert "idempotency key" in exc.value.diag.message_primary.lower()

    # The control, so this cannot pass for a function that refuses every key.
    assert set_linkedin(conn, watched, "1035", idem=uuid.uuid4().hex)["company_id"] == watched


def test_replaying_one_key_returns_the_first_result_and_writes_once(conn, user, watched):
    """The key names an OPERATION, not an intent: the offline outbox replays
    gestures precisely because it does not know whether they landed.

    MUTATION REASON: delete either idempotency lookup (the pre-lock one or the
    re-check behind `for update`) — the second call writes 9999 over 1035 and the
    audit trail grows a second row for one gesture.
    """
    idem = uuid.uuid4().hex
    first = set_linkedin(conn, watched, "1035", idem=idem)
    second = set_linkedin(conn, watched, "9999", idem=idem)

    assert first == second, "a replayed key returned a different result"
    assert company_of(conn, watched)[0] == "1035", "a replay wrote the second value"
    assert len(events(conn, user, "company.linkedin_id.set")) == 1


def test_a_stale_expectation_conflicts_and_writes_nothing(conn, user, watched):
    """Matrix row 9 on a SHARED row: two people watch one company, so the second
    paste has to be told it lost rather than clobber the first.

    `supabase-source.ts` matches /conflict|stale/i on the message, so the word is
    load-bearing rather than descriptive.

    MUTATION REASON: delete the `v_row.updated_at is distinct from
    p_expected_updated_at` branch — the stale write lands silently. Rewording the
    message to "someone else changed this" keeps the write correct and sends the
    client down the generic-error path instead of the re-read path.
    """
    stale = company_of(conn, watched)[1]
    set_linkedin(conn, watched, "1035", expected=stale)
    now = company_of(conn, watched)[1]
    assert now > stale, "the first write did not move the token — the probe below is vacuous"

    before_events = len(events(conn, user))
    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        set_linkedin(conn, watched, "9999", expected=stale)
    assert "conflict" in exc.value.diag.message_primary.lower()

    assert company_of(conn, watched)[0] == "1035", "a conflicted write landed anyway"
    assert len(events(conn, user)) == before_events, (
        "a conflicted write left an audit row for a save that never happened"
    )

    # …and the CURRENT token is accepted, so the refusal is about staleness.
    set_linkedin(conn, watched, "9999", expected=company_of(conn, watched)[1])
    assert company_of(conn, watched)[0] == "9999"


def test_a_caller_who_does_not_watch_the_company_is_refused(conn, user):
    """The door. `companies` is shared, the function is security definer, and
    without this check any session could stamp an id onto any company in the
    universe — including one it cannot even read.

    MUTATION REASON: delete the `select * into v_uc from public.user_companies`
    lookup and its `if not found` raise.
    """
    orphan = make_company(conn)
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        set_linkedin(conn, orphan, "1035")
    assert "no such company for this user" in exc.value.diag.message_primary.lower()
    assert company_of(conn, orphan)[0] == ""

    # The positive control, in the same breath: the identical call succeeds the
    # moment this caller watches the company. Without it, a function that refused
    # everybody would pass the assertion above.
    subscribe(conn, user, orphan)
    assert set_linkedin(conn, orphan, "1035")["companies"]["linkedin_company_id"] == "1035"


def test_an_unreviewed_proposal_may_still_carry_a_pasted_id(conn, user):
    """Deliberately NOT `app_set_company_flags`' gate, and the migration says why:
    pasting an id is research somebody does BEFORE deciding, on a row they are
    looking at in the review grid. Requiring approval would mean the id can only
    be added after the decision it helps make.

    MUTATION REASON: add `and v_uc.review_state = 'approved'` to the door.
    """
    cid = make_company(conn)
    subscribe(conn, user, cid, review_state="proposed")
    assert set_linkedin(conn, cid, "1035")["review_state"] == "proposed"
    assert company_of(conn, cid)[0] == "1035"


def test_a_plain_update_of_a_company_still_moves_its_version_token(conn, user, watched):
    """Matrix row 96, which cost `user_companies` a migration of its own.

    The RPC sets nothing itself — it relies on the trigger — but the failure this
    guards is the OTHER writer: the Python mirror, a backfill, a psql fix. Any of
    them changing the row and leaving the token where it was lets the next client
    holding the old value pass its conflict check and clobber a write it never saw.

    MUTATION REASON: delete the `companies_touch` trigger.
    """
    before = company_of(conn, watched)[1]
    conn.execute(
        "update public.companies set name = %s where id = %s",
        (f"Renamed {uuid.uuid4().hex[:8]}", watched),
    )
    assert company_of(conn, watched)[1] > before, (
        "a non-RPC update left the shared company's version token frozen"
    )


def test_a_no_op_upsert_from_the_mirror_leaves_the_version_token_alone(conn, user, watched):
    """The other half of row 96, and the half that was wrong.

    `public.companies` is the ONLY versioned table here that a bulk mirror
    rewrites wholesale: `monitor/discover_universe.upsert_universe` posts the
    whole ~640-row universe through PostgREST with `resolution=merge-duplicates`,
    which is `on conflict … do update` — and that fires a BEFORE UPDATE trigger
    on every row, including the overwhelming majority where every value is
    byte-identical to what is stored.

    Unconditional, the token becomes a mirror-activity timestamp rather than a
    content version, and the user-visible consequence is a lie: /jobs renders and
    captures the token, the sweep runs, the paste 409s, and `warm-cell.tsx` says
    "Somebody set this on another device. Reload to see their value." Nobody did.

    This is the SQL half of that claim. The next test is the claim itself.

    MUTATION REASON: drop `when (old.* is distinct from new.*)` from
    `companies_touch`.
    """
    name, ats, slug, before = conn.execute(
        "select name, ats, slug, updated_at from public.companies where id = %s",
        (watched,),
    ).fetchone()

    # The mirror's own statement shape, byte-identical values.
    conn.execute(
        """
        insert into public.companies (name, ats, slug)
        values (%s, %s, %s)
        on conflict (name, ats, slug) do update
          set name = excluded.name, ats = excluded.ats, slug = excluded.slug
        """,
        (name, ats, slug),
    )

    after = conn.execute(
        "select updated_at from public.companies where id = %s", (watched,)
    ).fetchone()[0]
    assert after == before, (
        f"a NO-OP upsert moved the shared token: {before} -> {after} — every paste "
        "held across a universe sweep now 409s on a row nobody touched"
    )


def test_a_paste_survives_a_no_op_sweep_between_the_read_and_the_write(conn, user, watched):
    """The claim, end to end, in the order a person performs it.

    The positive control lives in `test_a_stale_token_is_a_conflict_and_writes_nothing`:
    a token that is genuinely stale still 409s. This test is the other direction,
    and without it the fix above could be "never move the token" and pass.

    MUTATION REASON: the same one clause. Watched red — it raises
    `SerializationFailure: conflict: this company changed since you read it`.
    """
    # 1. The page renders and captures the token.
    token = company_of(conn, watched)[1]

    # 2. The universe sweep runs and writes nothing that differs.
    name, ats, slug = conn.execute(
        "select name, ats, slug from public.companies where id = %s", (watched,)
    ).fetchone()
    conn.execute(
        """
        insert into public.companies (name, ats, slug)
        values (%s, %s, %s)
        on conflict (name, ats, slug) do update
          set name = excluded.name, ats = excluded.ats, slug = excluded.slug
        """,
        (name, ats, slug),
    )

    # 3. The paste, carrying the token from step 1.
    row = set_linkedin(conn, watched, "1035", expected=token)
    assert row["companies"]["linkedin_company_id"] == "1035"


def test_one_event_per_call_records_the_before_and_the_after(conn, user, watched):
    """The column is shared, so "who put 1035 on Ramp, and when" is a question
    somebody will ask — and the answer has to name what it replaced.

    MUTATION REASON: drop `'before', v_before` from the payload, or move the
    `insert into public.events` above the UPDATE so `before` and `after` read the
    same value.
    """
    set_linkedin(conn, watched, "1035")
    set_linkedin(conn, watched, "9999")

    payloads = [p for (p,) in events(conn, user, "company.linkedin_id.set")]
    assert len(payloads) == 2, payloads
    assert payloads[0] == {"company_id": watched, "before": "", "after": "1035"}
    assert payloads[1] == {"company_id": watched, "before": "1035", "after": "9999"}

    actors = conn.execute(
        "select distinct actor from public.events where user_id = %s and kind = %s",
        (user, "company.linkedin_id.set"),
    ).fetchall()
    assert actors == [("user",)]


def test_an_unauthenticated_caller_cannot_paste_an_id(conn, user, watched):
    """The harness's auth.uid() stub is deliberately stricter than Supabase: no
    identity means null, so a path that forgot to establish one fails loudly."""
    conn.execute("select set_config('hq.test_user', '', false)")
    with pytest.raises(psycopg.errors.Error) as exc:
        set_linkedin(conn, watched, "1035")
    assert "not authenticated" in exc.value.diag.message_primary.lower()


# ============================================================== connections


def test_a_connection_matches_the_universe_through_the_normalized_key(conn, user):
    """0008's NBSP lesson, arriving on a new table.

    The match this table exists for — "does one of my connections work at the
    company on this posting" — compares `connections.company_key` to
    `company_name_key(<the row's company>)`. A name copied out of a web page
    carries a trailing NBSP, and 'Aon' typed in one session and 'aon' in another
    are one company.

    MUTATION REASON: change the generated column from
    `public.company_name_key(company)` to `lower(company)`. The NBSP survives,
    `company_name_key('Goldman Sachs')` no longer equals it, and the popover
    reports zero warm paths at a company where the user knows three people.
    """
    make_posting(conn, f"gh-gs-{uuid.uuid4().hex[:8]}", "Goldman Sachs")
    cid = make_company(conn, name="Goldman Sachs")
    subscribe(conn, user, cid)

    imp(conn, [
        # NBSP written as an escape: what pasting out of LinkedIn's web UI leaves.
        {"full_name": "Ada Lovelace", "company": "Goldman\u00a0Sachs",
         "profile_url": "https://www.linkedin.com/in/ada"},
        {"full_name": "Grace Hopper", "company": "  goldman sachs  ",
         "profile_url": "https://www.linkedin.com/in/grace"},
    ])

    # Through the posting the queue renders…
    assert conn.execute(
        """select count(*) from public.connections c
             join public.postings p
               on public.company_name_key(p.company) = c.company_key
            where c.user_id = %s and p.company = 'Goldman Sachs'""",
        (user,),
    ).fetchone()[0] == 2, "an NBSP in the export cut the connection off from the posting"

    # …and through the shared company row the /companies grid renders.
    assert conn.execute(
        """select count(*) from public.connections c
             join public.companies co
               on public.company_name_key(co.name) = c.company_key
            where c.user_id = %s and co.id = %s""",
        (user, cid),
    ).fetchone()[0] == 2

    # The raw strings really were different, so the join above is not passing
    # because the two happened to be spelled the same.
    stored = {r[3] for r in rows_of(conn, user)}
    assert len(stored) == 2, stored
    assert {r[4] for r in rows_of(conn, user)} == {"goldman sachs"}


def test_case_variants_of_one_company_share_one_key(conn, user):
    """'Aon' and 'aon' — 0008's other pair, on this side of the join."""
    imp(conn, [
        {"full_name": "A One", "company": "Aon", "profile_url": "https://x/in/a1"},
        {"full_name": "A Two", "company": "aon", "profile_url": "https://x/in/a2"},
        {"full_name": "A Three", "company": "AON\u200b", "profile_url": "https://x/in/a3"},
    ])
    keys = {r[4] for r in rows_of(conn, user)}
    assert keys == {"aon"}, keys


@pytest.mark.parametrize("blank", ["\n", "\t", "\u00a0", "\u200b", "  ", "\r\n"])
def test_a_nameless_line_is_skipped_and_counted_rather_than_inserted(conn, user, blank):
    """A connection with no name is not a person you can ask for anything.

    Skipped and COUNTED, not raised: one malformed line in a 3,000-row export must
    not refuse the other 2,999 — and the person reading the report has to be able
    to tell "we ignored a blank line" from "we merged a duplicate".

    MUTATION REASON: swap `public.hq_blank_trim(...)` for `btrim(...)` inside
    `hq_connection_rows`' `raw` CTE. Bare btrim trims SPACES ONLY, so a name of one
    newline, one tab, one NBSP or one zero-width space is content to Postgres and
    blank to everybody else — the row inserts, and the grid shows a nameless
    connection nobody can act on.
    """
    out = imp(conn, [
        {"full_name": blank, "company": "Ramp"},
        # The positive control, in the same chunk: without it a function that
        # skipped everything would pass.
        {"full_name": "Real Person", "company": "Ramp"},
    ])
    assert out == {"inserted": 1, "updated": 0, "skipped": 1, "deduped": 0}
    assert [r[0] for r in rows_of(conn, user)] == ["Real Person"]


def test_the_table_check_refuses_a_nameless_row_on_a_direct_insert(conn, user):
    """The same rule as a CONSTRAINT, not only as a filter inside one function.

    `hq_connection_rows` guards the browser's door; this guards every other one —
    a backfill, a psql fix, a future importer.

    MUTATION REASON: change the CHECK to `btrim(full_name) <> ''`.
    """
    for blank in ("\n", "\t", "\u00a0", "\u200b", "  ", ""):
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute(
                "insert into public.connections (user_id, full_name) values (%s, %s)",
                (user, blank),
            )
    # The control: the same insert is legal the moment the row names somebody.
    conn.execute(
        "insert into public.connections (user_id, full_name) values (%s, 'Real Person')",
        (user,),
    )


def test_a_blank_cell_on_re_import_does_not_erase_what_is_stored(conn, user):
    """0011's answer, verbatim: a blank cell is "the file did not say", never
    "delete what you have".

    The failure is quiet and total — a user who maps only the Name column on a
    second import loses every title, company and date they had.

    MUTATION REASON: replace any `case when excluded.x <> '' then excluded.x else
    connections.x end` with a bare `excluded.x`, or `coalesce(excluded.connected_on,
    connections.connected_on)` with a bare `excluded.connected_on`.
    """
    url = "https://www.linkedin.com/in/ada"
    imp(conn, [{"full_name": "Ada Lovelace", "first_name": "Ada", "last_name": "Lovelace",
                "company": "Ramp", "title": "Staff Engineer", "profile_url": url,
                "connected_on": "2023-03-21"}])

    out = imp(conn, [{"full_name": "Ada Lovelace", "first_name": "", "last_name": "",
                      "company": "", "title": "", "profile_url": url, "connected_on": ""}])
    assert out["updated"] == 1 and out["inserted"] == 0

    (full, first, last, company, key, title, purl, connected, _src), = rows_of(conn, user)
    assert (full, first, last) == ("Ada Lovelace", "Ada", "Lovelace")
    assert (company, key) == ("Ramp", "ramp")
    assert title == "Staff Engineer"
    assert connected == dt.date(2023, 3, 21)
    assert purl == url


def test_re_importing_the_same_file_inserts_nothing_the_second_time(conn, user):
    """Re-importing the export every month must merge, never duplicate — and the
    report has to SAY it merged, or the person cannot tell an idempotent re-run
    from a no-op that silently failed."""
    rows = [
        {"full_name": "Ada Lovelace", "company": "Ramp",
         "profile_url": "https://www.linkedin.com/in/ada"},
        {"full_name": "Grace Hopper", "company": "Ramp",
         "profile_url": "https://www.linkedin.com/in/grace"},
        {"full_name": "Mononym", "company": "Ramp"},
    ]
    first = imp(conn, rows)
    assert first == {"inserted": 3, "updated": 0, "skipped": 0, "deduped": 0}

    second = imp(conn, rows)
    assert second == {"inserted": 0, "updated": 3, "skipped": 0, "deduped": 0}
    assert len(rows_of(conn, user)) == 3


def test_a_profile_url_is_one_person_in_any_case(conn, user):
    """LinkedIn's own export is inconsistent about the case of vanity slugs, and
    the host is case-insensitive by spec. Two spellings of one URL that became two
    rows would double-count every warm path at a company.

    MUTATION REASON: drop the `lower()` from `connections_by_profile` and from the
    `on conflict (user_id, lower(profile_url))` inference clause.
    """
    imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "title": "first",
                "profile_url": "https://www.linkedin.com/in/ada"}])
    out = imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "title": "second",
                      "profile_url": "https://WWW.linkedin.com/in/ADA"}])

    assert out == {"inserted": 0, "updated": 1, "skipped": 0, "deduped": 0}
    stored = rows_of(conn, user)
    assert len(stored) == 1, stored
    assert stored[0][5] == "second"


def test_url_less_rows_dedupe_on_name_and_company(conn, user):
    """LinkedIn omits the URL for connections who have restricted it, and
    (name, company) is the best identity available. The merge risk that carries is
    stated on the index and accepted, because this table is re-imported wholesale
    from a file the user can re-download."""
    imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "title": "first"}])
    out = imp(conn, [{"full_name": "  ada lovelace  ", "company": "ramp", "title": "second"}])

    assert out == {"inserted": 0, "updated": 1, "skipped": 0, "deduped": 0}
    stored = rows_of(conn, user)
    assert len(stored) == 1, stored
    assert stored[0][5] == "second"


def test_the_same_name_at_two_companies_stays_two_people(conn, user):
    """The positive control the merge test above is meaningless without: an
    identity that collapsed every same-named connection into one row would pass
    it, and would quietly delete half of somebody's network.

    MUTATION REASON: drop `company_key` from `connections_by_name`.
    """
    out = imp(conn, [
        {"full_name": "Ada Lovelace", "company": "Ramp"},
        {"full_name": "Ada Lovelace", "company": "Plaid"},
    ])
    assert out == {"inserted": 2, "updated": 0, "skipped": 0, "deduped": 0}
    assert sorted(r[3] for r in rows_of(conn, user)) == ["Plaid", "Ramp"]


def test_a_url_less_line_for_somebody_who_already_has_a_url_is_not_a_second_row(conn, user):
    """The `not exists` guard, and the gap it closes.

    `connections_by_name` is predicated on `profile_url = ''`, so a row this person
    ALREADY has with a URL cannot conflict with a URL-less line for the same human
    — and somebody who removes their public URL between two monthly exports would
    otherwise arrive as a second row that never merges again.

    MUTATION REASON: delete the `and not exists (...)` clause from the second
    upsert. The row inserts, the person appears twice in every popover, and the
    duplicate is permanent.
    """
    imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "title": "with url",
                "profile_url": "https://www.linkedin.com/in/ada"}])

    out = imp(conn, [{"full_name": "ADA LOVELACE", "company": "ramp", "title": "no url"}])
    assert out == {"inserted": 0, "updated": 0, "skipped": 0, "deduped": 1}, (
        "the URL-less line was not counted as deduped"
    )

    stored = rows_of(conn, user)
    assert len(stored) == 1, stored
    # The row with the URL is the better record, and it is the one the deep link
    # needs — so it is kept UNTOUCHED rather than overwritten by the poorer line.
    assert stored[0][5] == "with url"
    assert stored[0][6] == "https://www.linkedin.com/in/ada"


# ------------------------------------------------------------ the promotion


def test_a_stored_url_less_row_is_promoted_when_the_url_arrives(conn, user):
    """The OTHER direction of the same gap, and the one the first version of this
    function left open.

    LinkedIn withholds a connection's URL while they have it restricted. They
    un-restrict it; next month's export carries the URL — and
    `connections_by_profile` sees no conflict with a row whose `profile_url` is
    `''`, so the same human lands twice and can never merge again. Both reports
    say `deduped: 0`, so nothing on screen says anything went wrong and the person
    is double-counted in every warm-path popover from then on.

    PROMOTED, not deleted-and-reinserted: the stored row holds a `title` and a
    `connected_on` this line does not, and the blank rule says an import never
    destroys what the file did not say. That is the difference this test's last
    two assertions exist to pin.

    MUTATION REASON: delete the `update public.connections c set profile_url =
    i.profile_url ... from public.hq_connection_rows(p_rows) i` statement — the row
    count goes to 2 and `updated` goes to 0.
    """
    url = "https://www.linkedin.com/in/ada"
    imp(conn, [{"full_name": "Ada Lovelace", "first_name": "Ada", "company": "Ramp",
                "title": "Staff Engineer", "connected_on": "2023-03-21"}])
    assert rows_of(conn, user)[0][6] == "", "the setup row was supposed to have no URL"

    out = imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "profile_url": url}])
    assert out == {"inserted": 0, "updated": 1, "skipped": 0, "deduped": 0}, out

    stored = rows_of(conn, user)
    assert len(stored) == 1, stored
    full, first, _last, company, _key, title, purl, connected, _src = stored[0]
    assert (full, company, purl) == ("Ada Lovelace", "Ramp", url)
    # What the file did not say is still there.
    assert (first, title, connected) == ("Ada", "Staff Engineer", dt.date(2023, 3, 21))


def test_a_promotion_that_would_collide_leaves_the_url_less_row_alone(conn, user):
    """The collision the promotion creates, and the `not exists` that survives it.

    If a row for that URL ALREADY exists, promoting the URL-less row would violate
    `connections_by_profile` and abort the WHOLE chunk — a 3,000-row import failing
    on a state the person cannot see, let alone fix. Skipped instead: it is then a
    genuine duplicate they can clear and re-import.

    The URL-less row is planted directly rather than imported, because the
    URL-bearing row is exactly what stops the RPC from creating it (the test above
    it). Owner-level, which is also the state a pre-0013 backfill would leave.

    MUTATION REASON: delete the `and not exists (select 1 from public.connections x
    ... lower(x.profile_url) = lower(i.profile_url))` from the promotion — the
    import dies with a unique violation instead of landing.
    """
    url = "https://www.linkedin.com/in/ada"
    imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "title": "with url",
                "profile_url": url}])
    conn.execute(
        """insert into public.connections (user_id, full_name, company, title)
           values (%s, 'Ada Lovelace', 'Ramp', 'no url')""",
        (user,),
    )

    out = imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "title": "again",
                      "profile_url": url}])
    assert out == {"inserted": 0, "updated": 1, "skipped": 0, "deduped": 0}, out

    stored = sorted(rows_of(conn, user), key=lambda r: r[6])
    assert len(stored) == 2, stored
    assert (stored[0][5], stored[0][6]) == ("no url", ""), "the URL-less row was disturbed"
    assert (stored[1][5], stored[1][6]) == ("again", url)


def test_a_promotion_does_not_reach_a_row_with_a_different_name(conn, user):
    """The bound on the promotion. It matches on the SAME identity
    `connections_by_name` uses — normalized name AND `company_key` — so a line for
    somebody else at the same company is a second person, and staying two rows is
    the correct answer rather than a missed merge.

    MUTATION REASON: drop `lower(public.hq_blank_trim(c.full_name)) =
    lower(i.full_name)` (or the `company_key` comparison) from the promotion's
    WHERE — one person's URL lands on another person's row, which is the worst
    failure this table can have: a warm path pointing at a stranger.
    """
    imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "title": "no url"}])
    out = imp(conn, [{"full_name": "Ada L", "company": "Ramp",
                      "profile_url": "https://www.linkedin.com/in/ada"}])

    assert out == {"inserted": 1, "updated": 0, "skipped": 0, "deduped": 0}, out
    stored = sorted(rows_of(conn, user), key=lambda r: r[0])
    assert [(r[0], r[6]) for r in stored] == [
        ("Ada L", "https://www.linkedin.com/in/ada"),
        ("Ada Lovelace", ""),
    ], stored


def test_a_url_bearing_line_for_a_stranger_still_inserts(conn, user):
    """The positive control the promotion must not break: the ordinary case, where
    nobody is stored under that name at all, is still an INSERT.

    Without it, a promotion pass that swallowed every URL-bearing line would pass
    all three tests above.
    """
    imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp"}])
    out = imp(conn, [{"full_name": "Grace Hopper", "company": "Ramp",
                      "profile_url": "https://www.linkedin.com/in/grace"}])
    assert out == {"inserted": 1, "updated": 0, "skipped": 0, "deduped": 0}, out
    assert len(rows_of(conn, user)) == 2


def test_the_report_still_closes_across_a_promotion(conn, user):
    """Matrix row 169 again, on the path that was added after it.

    A promotion moves a row from the URL-less half of the table to the URL half
    BEFORE either upsert counts anything, which is exactly the shape that quietly
    stops a derived-by-subtraction number from adding up. It has to keep adding up.

    MUTATION REASON: count `deduped` rather than deriving it — the promoted row is
    then reported in neither `inserted` nor `deduped` and the report comes up one
    short of the file.
    """
    url = "https://www.linkedin.com/in/ada"
    imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp", "title": "no url"}])

    chunk = [
        # the promotion: stored without a URL, arriving with one
        {"full_name": "Ada Lovelace", "company": "Ramp", "profile_url": url},
        # the same person again, so the chunk also carries a dupe
        {"full_name": "Ada Lovelace", "company": "Ramp", "title": "dupe", "profile_url": url},
        # a plain insert
        {"full_name": "Grace Hopper", "company": "Ramp",
         "profile_url": "https://www.linkedin.com/in/grace"},
        # and a nameless line
        {"full_name": "\t"},
    ]
    out = imp(conn, chunk)

    assert out == {"inserted": 1, "updated": 1, "skipped": 1, "deduped": 1}, out
    assert sum(out.values()) == len(chunk), (
        f"the report does not add up to the file: {out} for {len(chunk)} rows"
    )
    assert len(rows_of(conn, user)) == 2


def test_the_report_closes_on_a_chunk_with_one_of_every_bucket(conn, user):
    """Matrix row 169, and it gets its own test because it is the assertion the
    whole four-number shape exists for: `inserted + updated + skipped + deduped`
    must equal the rows handed in.

    Only the commit knows which bucket a line went to, so a report that does not
    close is one nobody can re-derive afterwards — "3,000 in, 2,860 accounted for"
    is unanswerable from outside.

    `deduped` is derived by SUBTRACTION rather than counted, and that is what makes
    it close: it absorbs BOTH ways a named line can land nowhere — the same person
    listed twice, and a URL-less line shadowed by a record that already has the URL.

    MUTATION REASON: count `deduped` instead (e.g. `select count(*) ... where
    is_dupe`). The shadowed line then falls out of every bucket and the report is
    permanently one short of the file.
    """
    seeded = "https://www.linkedin.com/in/carol"
    imp(conn, [{"full_name": "Carol Shaw", "company": "Ramp", "title": "before",
                "profile_url": seeded}])

    chunk = [
        # updated: already stored, arriving again with a new title
        {"full_name": "Carol Shaw", "company": "Ramp", "title": "after", "profile_url": seeded},
        # inserted
        {"full_name": "Ada Lovelace", "company": "Ramp",
         "profile_url": "https://www.linkedin.com/in/ada"},
        # deduped (a): the same profile URL twice in one chunk
        {"full_name": "Ada Lovelace", "company": "Ramp", "title": "dupe",
         "profile_url": "https://www.linkedin.com/in/ada"},
        # skipped: no name
        {"full_name": "\u00a0", "company": "Ramp"},
        # deduped (b): a URL-less line for somebody who already has a URL row
        {"full_name": "Carol Shaw", "company": "Ramp"},
    ]
    out = imp(conn, chunk)

    assert out == {"inserted": 1, "updated": 1, "skipped": 1, "deduped": 2}, out
    assert sum(out.values()) == len(chunk), (
        f"the report does not add up to the file: {out} for {len(chunk)} rows"
    )

    # The same four numbers ride into the audit trail, so the report survives the
    # tab that rendered it.
    (payload,), = events(conn, user, "connections.imported")[-1:]
    assert {k: payload[k] for k in ("inserted", "updated", "skipped", "deduped")} == out
    assert payload["source"] == "linkedin-export"


def test_the_last_occurrence_in_a_chunk_wins(conn, user):
    """What a sequence of single-row writes would have left behind, which is what
    the person expects when their export lists somebody twice.

    Filtering duplicates is ALSO required rather than cosmetic: Postgres refuses an
    `on conflict do update` that would touch one row twice in a single statement.

    MUTATION REASON: change `row_number() over (partition by k.ident order by k.n
    desc)` to `order by k.n` — the FIRST occurrence wins and a re-exported file
    keeps the stale copy of every changed row. Deleting the `order by` inside the
    window makes the winner whatever the plan produced, which is worse: it is
    right most of the time.
    """
    url = "https://www.linkedin.com/in/ada"
    chunk = [
        {"full_name": "Ada Lovelace", "company": "Ramp", "title": "first", "profile_url": url},
        {"full_name": "Ada Lovelace", "company": "Ramp", "title": "second", "profile_url": url},
    ]

    # The helper itself: exactly one row survives, and it is the LAST one.
    surviving = conn.execute(
        "select title from public.hq_connection_rows(%s::jsonb) where not is_dupe",
        (json.dumps(chunk),),
    ).fetchall()
    assert surviving == [("second",)], surviving
    assert conn.execute(
        "select count(*) from public.hq_connection_rows(%s::jsonb) where is_dupe",
        (json.dumps(chunk),),
    ).fetchone()[0] == 1

    # …and that is what lands.
    out = imp(conn, chunk)
    assert out == {"inserted": 1, "updated": 0, "skipped": 0, "deduped": 1}
    assert rows_of(conn, user)[0][5] == "second"


@pytest.mark.parametrize(
    "cell,expected",
    [
        ("2023-03-21", dt.date(2023, 3, 21)),
        # LinkedIn's own format, which `lib/import/read.ts` is what parses…
        ("21 Mar 2023", None),
        # …and the ambiguous one it deliberately REFUSES rather than guess.
        ("03/04/2026", None),
        ("", None),
        ("   ", None),
        ("yesterday", None),
    ],
)
def test_connected_on_is_an_iso_date_or_null_and_never_an_exception(conn, user, cell, expected):
    """`connected_on` is display-only — the match does not read it — so a cell this
    function cannot prove must be NULL rather than a guess, and must not take the
    other 999 rows down with it.

    MUTATION REASON: replace `public.hq_iso_date(r.connected_on)` with a bare
    `r.connected_on::date`. Every LinkedIn export in the world says "21 Mar 2023",
    so the first real file raises 22007 and the whole import fails.

    The half a regexp cannot carry — a string with the ISO SHAPE that is not a DAY
    — is the two tests below.
    """
    out = imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp",
                      "connected_on": cell}])
    assert out["inserted"] == 1, out
    assert rows_of(conn, user)[0][7] == expected


@pytest.mark.parametrize(
    "cell,expected",
    [
        ("2024-03-01", dt.date(2024, 3, 1)),
        ("2024-02-29", dt.date(2024, 2, 29)),      # a leap day that IS a day
        # The shape-only guard's blind spot: each of these matches
        # `^\d{4}-\d{2}-\d{2}$` and none of them is a date.
        ("2026-13-45", None),
        ("2026-02-31", None),
        ("2026-02-30", None),
        ("2025-02-29", None),                      # not a leap year
        ("0000-00-00", None),
        # …and the shapes that never reach the cast at all, so the parametrization
        # is not all one branch.
        ("21 Mar 2023", None),
        ("03/04/2026", None),
        ("", None),
        (None, None),
    ],
)
def test_hq_iso_date_answers_null_instead_of_raising(conn, cell, expected):
    """The conversion, isolated from the import that calls it.

    A regexp proves a SHAPE and not a DAY. `2026-13-45` has the shape, and
    `'2026-13-45'::date` raises 22008 — so the guard has to be somewhere a raise
    can be CAUGHT, which in SQL means a plpgsql exception block.

    NULL rather than a rolled-over neighbour is the other half of the claim:
    `connected_on` is display-only, and a date silently a month out is worse than
    a blank one.

    MUTATION REASON: replace the body with a bare `return p_text::date;` after the
    regexp (i.e. delete the `exception when others then return null` block) — the
    two shaped-but-impossible days go red immediately.
    """
    assert conn.execute("select public.hq_iso_date(%s)", (cell,)).fetchone()[0] == expected


def test_one_impossible_date_does_not_take_the_rest_of_the_chunk_down(conn, user):
    """The chunk-level claim, which is the one that matters and the one the old
    shape-only guard could not make.

    `hq_connection_rows` is a single set-returning statement: an exception raised
    while evaluating row 1 aborts the whole thing, so ONE cell somebody typed by
    hand — or one row a future mapper mis-parses — took 999 good rows with it and
    the person saw "import failed" with nothing to fix.

    MUTATION REASON: as above — a bare `p_text::date` inside `hq_iso_date`. The
    import raises 22008 and NOTHING lands, rather than three rows landing with two
    blank dates.
    """
    out = imp(conn, [
        {"full_name": "Bad Month", "company": "Ramp", "connected_on": "2026-13-45"},
        {"full_name": "Bad Day", "company": "Ramp", "connected_on": "2026-02-31"},
        {"full_name": "Good Date", "company": "Ramp", "connected_on": "2023-03-21"},
    ])
    assert out == {"inserted": 3, "updated": 0, "skipped": 0, "deduped": 0}, out

    stored = {r[0]: r[7] for r in rows_of(conn, user)}
    assert stored == {"Bad Month": None, "Bad Day": None, "Good Date": dt.date(2023, 3, 21)}


def test_a_very_long_cell_is_truncated_rather_than_refused(conn, user):
    """`left(...)` on every field, because these are columns a browser fills. A
    3,000-character "name" is a malformed row, not a reason to refuse the file.

    MUTATION REASON: delete the `left(r.full_name, 200)` bounds in the `bounded`
    CTE — nothing raises (text has no length), so the only visible symptom is an
    unbounded write from a function granted to `authenticated`.
    """
    out = imp(conn, [{"full_name": "a" * 500, "first_name": "b" * 400,
                      "company": "c" * 500, "title": "d" * 500,
                      "profile_url": "https://x/in/" + "e" * 900}])
    assert out["inserted"] == 1, out
    full, first, _last, company, _key, title, purl, _c, _s = rows_of(conn, user)[0]
    assert (len(full), len(first), len(company), len(title), len(purl)) == (200, 100, 200, 200, 500)


def test_replaying_an_import_key_writes_nothing_more(conn, user):
    """Two tabs sharing one outbox both flush on the same 'online' event. A replay
    that re-ran the chunk would be harmless for the upserts and NOT harmless for
    the report: the second answer would say "0 inserted" about a file that
    installed 3,000 rows."""
    rows = [{"full_name": "Ada Lovelace", "company": "Ramp",
             "profile_url": "https://www.linkedin.com/in/ada"}]
    idem = uuid.uuid4().hex
    first = imp(conn, rows, idem=idem)
    # A DIFFERENT chunk under the same key: the key names the gesture, not its
    # arguments, so the stored result comes back untouched and nothing lands.
    second = imp(conn, rows + [{"full_name": "Grace Hopper", "company": "Ramp"}], idem=idem)

    assert first == second == {"inserted": 1, "updated": 0, "skipped": 0, "deduped": 0}
    assert len(rows_of(conn, user)) == 1
    assert len(events(conn, user, "connections.imported")) == 1


@pytest.mark.parametrize("bad", ["", " ", "\n", "\u00a0", "x" * 201])
def test_a_blank_import_idempotency_key_is_refused(conn, user, bad):
    """Matrix row 218, on the import door.

    MUTATION REASON: `public.hq_blank_trim(p_idem) = ''` -> `length(p_idem) = 0`.
    """
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        imp(conn, [{"full_name": "Ada"}], idem=bad)
    assert "idempotency key" in exc.value.diag.message_primary.lower()
    # The control, so this cannot pass for a function that refuses every key.
    assert imp(conn, [{"full_name": "Ada"}], idem=uuid.uuid4().hex)["inserted"] == 1


def test_a_chunk_past_the_bound_is_refused(conn, user):
    """A bound on a public endpoint. This function is granted to `authenticated`,
    so the browser can post whatever array it likes and a TypeScript check is
    advisory.

    MUTATION REASON: raise MAX_CHUNK, or move the check below the upserts.
    """
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        imp(conn, [{"full_name": f"P{i}"} for i in range(1001)])
    assert "too many connections in one call" in exc.value.diag.message_primary.lower()
    assert rows_of(conn, user) == []

    # The control: one under the bound is accepted, so the refusal is about SIZE.
    assert imp(conn, [{"full_name": f"P{i}"} for i in range(1000)])["inserted"] == 1000


def test_an_unknown_source_tag_is_refused(conn, user):
    """`source` is a reporting dimension, and a function granted to `authenticated`
    with an unbounded string writes a novel into a group-by (0008's argument for
    `ALLOWED_SOURCES`).

    MUTATION REASON: delete the `v_source = any (ALLOWED_SOURCES)` check.
    """
    for tag in ("linkedin-export", "manual", "import", "MANUAL", "", "  "):
        assert imp(conn, [{"full_name": f"Src {uuid.uuid4().hex[:6]}"}], source=tag)["inserted"] == 1
    # Folded to lower case, and a blank tag falls back to the export rather than
    # writing '' into a column the coverage report groups by.
    assert {r[8] for r in rows_of(conn, user)} == {"linkedin-export", "manual", "import"}

    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        imp(conn, [{"full_name": "Nope"}], source="a-novel-about-provenance")
    assert "unknown source tag" in exc.value.diag.message_primary.lower()


@pytest.mark.parametrize("payload", ['{"full_name": "Ada"}', "null", '"a string"', "42", "true"])
def test_a_non_array_rows_argument_is_refused(conn, user, payload):
    """`jsonb_array_elements` raises 22023 on a non-array with a message about
    internal types; the guard turns that into a sentence, and refuses BEFORE the
    row count and the locks.

    MUTATION REASON: delete the `jsonb_typeof(p_rows) <> 'array'` check.
    """
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        conn.execute(
            "select public.app_import_connections(%s::jsonb, 'manual', %s)",
            (payload, uuid.uuid4().hex),
        )
    assert "rows must be an array" in exc.value.diag.message_primary.lower()

    # The control: the same call with a real array lands.
    assert imp(conn, [{"full_name": "Ada"}])["inserted"] == 1


def test_an_unauthenticated_caller_cannot_import_or_clear(conn, user):
    conn.execute("select set_config('hq.test_user', '', false)")
    for call in (lambda: imp(conn, [{"full_name": "Ghost"}]), lambda: clear(conn)):
        with pytest.raises(psycopg.errors.Error) as exc:
            call()
        assert "not authenticated" in exc.value.diag.message_primary.lower()


# ------------------------------------------------------------ ordered locking


def test_two_overlapping_chunks_in_opposite_orders_do_not_deadlock(conn, user):
    """Matrix rows 95 and 191, arriving on the import path.

    Two tabs replaying one outbox hand this function overlapping chunks in whatever
    order their own reads produced, and each holding the row the other wants next
    is a 40P01 surfaced to a person as a generic failure for a perfectly valid
    gesture.

    Forty rows rather than two, deliberately: the window between the first and last
    lock is what the race needs. Verified reachable — with the pre-lock statement
    deleted, `order by lower(i.profile_url)` deleted from the first upsert AND
    `hq_connection_rows` made to emit input order, this test raised
    DeadlockDetected on every one of five rounds at exactly this size.

    HONEST NOTE ON THE MUTANT, because a test whose failure mode nobody has seen is
    a test nobody should trust: the property is protected THREE times over in the
    shipped SQL, and deleting `order by c.id` alone does NOT redden this test. The
    pre-lock's plan drives from the `connections_by_company` index scan (so its
    order is caller-independent either way), and `hq_connection_rows`' window
    function already sorts its output by `ident`, which erases the caller's chunk
    order before any lock is taken. The single-edit mutant for the ORDER BY itself
    is pinned by the test below.
    """
    rows = [{"full_name": f"Person {i:02d}", "company": f"Co {i:02d}",
             "profile_url": f"https://www.linkedin.com/in/p{i:02d}"} for i in range(40)]
    assert imp(conn, rows)["inserted"] == 40

    forward = [dict(r, title="forward") for r in rows]
    reverse = list(reversed([dict(r, title="reverse") for r in rows]))

    errors: list[str] = []

    def call(conn_, chunk):
        try:
            conn_.execute(
                "select public.app_import_connections(%s::jsonb, 'linkedin-export', %s)",
                (json.dumps(chunk), uuid.uuid4().hex),
            )
            conn_.commit()
        except psycopg.errors.Error as exc:
            conn_.rollback()
            errors.append(f"{exc.__class__.__name__}: {exc}")

    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        for c in (a, b):
            c.execute("select set_config('hq.test_user', %s, false)", (user,))
            # Commit it: the setting is session-scoped but was applied inside an
            # implicit transaction, and a rollback below would take the identity.
            c.commit()
        start = threading.Barrier(2)

        def run(conn_, chunk):
            start.wait()
            call(conn_, chunk)

        ta = threading.Thread(target=run, args=(a, forward))
        tb = threading.Thread(target=run, args=(b, reverse))
        ta.start()
        tb.start()
        ta.join(timeout=60)
        tb.join(timeout=60)
        assert not ta.is_alive() and not tb.is_alive(), "a caller never returned"

    assert not [e for e in errors if "deadlock" in e.lower()], errors
    assert not errors, errors
    # Both landed, and neither duplicated anybody.
    assert len(rows_of(conn, user)) == 40
    assert {r[5] for r in rows_of(conn, user)} <= {"forward", "reverse"}


def test_every_row_a_chunk_touches_is_locked_in_id_order_before_any_write(conn):
    """The single-edit mutant for the ORDER BY, asserted on the SQL for
    `test_profile.py:test_every_regated_row_is_locked_in_ascending_key_order`'s
    stated reason: the race above is only observable when the two callers' orders
    actually differ, and three separate things in this file conspire to make sure
    they never do. What is worth pinning is that the total order did not get
    dropped in an edit — the day a plan change or a rewritten
    `hq_connection_rows` lets the caller's chunk order reach the lock sequence,
    this statement is the only thing left.

    MUTATION REASON: delete `order by c.id` from the pre-lock statement, or move
    the whole `perform 1 ... for update of c` below the first upsert.
    """
    sql = MIGRATION.read_text()
    body = re.search(r"perform 1\s*\n(.*?)for update of c;", sql, re.S)
    assert body, "the ordered pre-lock statement is gone"
    assert "order by c.id" in body.group(1), body.group(1)
    # …and it comes BEFORE anything that writes.
    assert sql.index("perform 1") < sql.index("insert into public.connections")


# ---------------------------------------------------------------- clearing


def test_clearing_deletes_only_the_callers_own_rows(conn, user):
    """"Delete mine and upload again" is the whole recovery story for a wrong
    merge, and it is the argument `connections_by_name` leans on to justify its one
    merge risk. A clear that reached past the caller would turn that recovery into
    a second, larger incident.

    MUTATION REASON: delete `where user_id = v_user` from the DELETE.
    """
    other = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, other)
    imp(conn, [{"full_name": "Their Person", "company": "Ramp"}])

    as_user(conn, user)
    imp(conn, [{"full_name": "My Person", "company": "Ramp"},
               {"full_name": "My Other Person", "company": "Plaid"}])

    assert clear(conn) == {"deleted": 2}
    assert rows_of(conn, user) == []
    assert [r[0] for r in rows_of(conn, other)] == ["Their Person"], (
        "a clear deleted another user's connections"
    )

    # One audit row, naming what it removed.
    assert [p for (p,) in events(conn, user, "connections.cleared")] == [{"deleted": 2}]


def test_clearing_replays_under_one_key_without_deleting_a_later_import(conn, user):
    """The replay that matters: clear, re-upload, and then the outbox flushes the
    clear again. Without the stored result the second call would delete the file
    the person just uploaded to replace it.

    MUTATION REASON: delete the `command_idempotency` lookup at the top.
    """
    imp(conn, [{"full_name": "Ada Lovelace", "company": "Ramp"}])
    idem = uuid.uuid4().hex
    assert clear(conn, idem=idem) == {"deleted": 1}

    imp(conn, [{"full_name": "Grace Hopper", "company": "Ramp"}])
    assert clear(conn, idem=idem) == {"deleted": 1}, "the replay re-ran the delete"
    assert [r[0] for r in rows_of(conn, user)] == ["Grace Hopper"]
    assert len(events(conn, user, "connections.cleared")) == 1

    # The control: a FRESH key really does clear, so the assertion above is not
    # passing because the function stopped working.
    assert clear(conn) == {"deleted": 1}
    assert rows_of(conn, user) == []


@pytest.mark.parametrize("bad", ["", " ", "\n", "x" * 201])
def test_a_blank_clear_idempotency_key_is_refused(conn, user, bad):
    """The most destructive gesture on this surface gets the same door.

    MUTATION REASON: `public.hq_blank_trim(p_idem) = ''` -> `length(p_idem) = 0`.
    """
    imp(conn, [{"full_name": "Ada Lovelace"}])
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        clear(conn, idem=bad)
    assert "idempotency key" in exc.value.diag.message_primary.lower()
    assert len(rows_of(conn, user)) == 1
    # The control.
    assert clear(conn, idem=uuid.uuid4().hex) == {"deleted": 1}
