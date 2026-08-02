"""`hq_fill_domain` and `hq_normalize_domain` (0021), executed against Postgres.

`tests/core/test_migrations.py` reads the SQL as text — it catches a missing revoke
and an outcome the Python does not classify. It cannot catch a blank guard that uses
`btrim`, a match that uses `=` instead of `company_name_key`, a domain stored without
canonicalization, or a version token that moves when nothing changed. Everything here
RUNS. It is `tests/db/test_linkedin_fill.py`, one column over — the same claim (bots
fill blanks, humans win) proved the same way, plus the one thing the domain has that
the id did not: a CANONICALIZER, because a wrong host renders a wrong logo.

Run locally with a throwaway Postgres — see tests/db/test_write_path.py's docstring.
Without DATABASE_URL every test here skips.
"""
from __future__ import annotations

import os
import uuid

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from core.domains import normalize_domain  # noqa: E402
from tests.core.test_domains import DOMAIN_CASES  # noqa: E402
from tests.db.test_referral import (  # noqa: E402  (shared fixtures on purpose)
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
    """A company name unique to this test — the file accumulates rows across a
    session and matches on the NAME, so a literal reused between tests would fill one
    test's leftover blank and report the wrong outcome (test_linkedin_fill's lesson)."""
    return f"Domainco {uuid.uuid4().hex[:8]}"


def fill(conn, name, domain, *, user_id, source=SOURCE):
    return conn.execute(
        "select public.hq_fill_domain(%s, %s, %s, %s)",
        (user_id, name, domain, source),
    ).fetchone()[0]


def domain_of(conn, company_id):
    return conn.execute(
        "select domain from public.companies where id = %s", (company_id,),
    ).fetchone()[0]


def source_of(conn, company_id):
    return conn.execute(
        "select domain_source from public.companies where id = %s", (company_id,),
    ).fetchone()[0]


def set_raw(conn, company_id, value):
    """Put a value in the cell WITHOUT any door — a psql fix, a bulk mirror, or the
    browser correction path the `domain_source` vocabulary is built for. The doors
    would refuse most of these, which is exactly why the guard cannot assume they are
    absent, and why `companies_domain_is_canonical` lives on the COLUMN."""
    conn.execute("update public.companies set domain = %s where id = %s",
                 (value, company_id))


def set_human(conn, company_id, value):
    """Simulate a person answering the domain (there is no browser door yet, but the
    provenance guard is built for the day there is). A direct write, domain_source
    stamped 'human' — including a CLEAR (`value=''`), the tombstone."""
    conn.execute(
        "update public.companies set domain = %s, domain_source = 'human' where id = %s",
        (value, company_id))


def events_of(conn, user_id, kind):
    return conn.execute(
        "select payload from public.events where user_id = %s and kind = %s order by id",
        (user_id, kind),
    ).fetchall()


# ---------------------------------------------------------------- the happy path

def test_a_blank_cell_takes_the_harvested_domain(conn, user, co):
    cid = make_company(conn, name=co)
    out = fill(conn, co, "ramp.com", user_id=user)
    assert out["outcome"] == "filled"
    assert out["company_ids"] == [cid]
    assert domain_of(conn, cid) == "ramp.com"
    assert source_of(conn, cid) == "engine"


def test_the_fill_writes_its_audit_event(conn, user, co):
    make_company(conn, name=co)
    fill(conn, co, "ramp.com", user_id=user)
    payloads = [p for (p,) in events_of(conn, user, "company.domain.filled")]
    assert len(payloads) == 1
    assert payloads[0]["domain"] == "ramp.com"
    assert payloads[0]["source"] == SOURCE
    assert payloads[0]["name"] == co


def test_a_no_op_run_does_not_append_a_second_event(conn, user, co):
    """MUTATION REASON: write the event unconditionally and a cron re-reading the same
    payload every morning files 365 identical rows a year into an append-only table."""
    make_company(conn, name=co)
    fill(conn, co, "ramp.com", user_id=user)
    fill(conn, co, "ramp.com", user_id=user)
    assert len(events_of(conn, user, "company.domain.filled")) == 1


def test_a_company_nobody_has_is_no_company_not_invented(conn, user):
    out = fill(conn, "Zzzq Nonexistent Holdings", "ramp.com", user_id=user)
    assert out["outcome"] == "no_company" and out["matched"] == 0
    assert conn.execute(
        "select count(*) from public.companies where name = 'Zzzq Nonexistent Holdings'"
    ).fetchone()[0] == 0


# ---------------------------------------------------------------- matching

@pytest.mark.parametrize("stored,sent", [
    ("Aon", "aon"), ("aon", "AON"),
    ("Northern  Trust", "Northern Trust"),
    ("Kraft Heinz", " Kraft Heinz "),
])
def test_the_match_is_normalized_never_raw_equality(conn, user, co, stored, sent):
    """MUTATION REASON: swap `company_name_key(name) = v_key` for `name = p_name` and
    every row here answers `no_company` — a provider's spelling arrives folded
    differently from ours."""
    tag = co.split()[-1]
    cid = make_company(conn, name=f"{stored} {tag}")
    assert fill(conn, f"{sent} {tag}", "ramp.com", user_id=user)["outcome"] == "filled"
    assert domain_of(conn, cid) == "ramp.com"


def test_every_board_of_one_company_is_filled(conn, user, co):
    """A domain is a fact about the COMPANY, so filling one board and leaving its
    sibling blank renders a monogram next to a logo for the same employer."""
    a = make_company(conn, name=co, ats="workday", slug="a-wd5")
    b = make_company(conn, name=co.lower() + " ", ats="greenhouse", slug="a-gh")
    out = fill(conn, co, "ramp.com", user_id=user)
    assert sorted(out["company_ids"]) == sorted([a, b])
    assert domain_of(conn, a) == domain_of(conn, b) == "ramp.com"


# ---------------------------------------------------------------- canonicalization

def test_a_raw_url_is_canonicalized_before_storing(conn, user, co):
    """MUTATION REASON: store `p_domain` raw instead of `hq_normalize_domain(p_domain)`
    and `HTTPS://WWW.Ramp.com/careers?x=1` lands in a column the LogoAvatar hands to
    logo.dev — a wrong logo or none. The door folds it to the bare host, the SAME
    value a clean `ramp.com` row produces."""
    cid = make_company(conn, name=co)
    fill(conn, co, "HTTPS://WWW.Ramp.com/careers?x=1", user_id=user)
    assert domain_of(conn, cid) == "ramp.com"


@pytest.mark.parametrize("bad", [
    "ramp", "localhost", "not a host", "javascript:alert(1)", "", "   ", "ramp.c",
    # IPs whose final label is 2+ characters, so ONLY the alphabetic-TLD rule can
    # refuse them. `1.2.3.4` alone is refused by the LENGTH bound, which is why it
    # was not enough: widening the TLD to `[a-z0-9]{2,63}` left the whole db suite
    # green while `hq_normalize_domain('192.168.1.10')` began answering
    # '192.168.1.10'. See tests/core/test_domains.py::test_an_ip_literal_is_refused.
    "1.2.3.4", "169.254.169.254", "192.168.1.10", "1.2.3.44", "ramp.c0m",
    # The rest of the network-address space, at the DOOR: the same metadata address
    # spelled in dotted hex and dotted octal (4-character final labels, so the length
    # bound never sees them — only `[a-z]` refuses these), the flat decimal/hex/octal
    # spellings, and IPv6 in every shape a paste delivers it.
    "0xa9.0xfe.0xa9.0xfe", "0251.0376.0251.0376", "192.168.001.010",
    "2130706433", "2852039166", "0xa9fea9fe", "017700000001",
    "127.0.0.1", "0.0.0.0",
    "::1", "[::1]", "[fd00::1]", "[fe80::1%25eth0]",
    "[::ffff:169.254.169.254]", "[2001:db8::1]:8080", "http://[::1]/latest",
    # The control-character and non-ASCII classes, at the DOOR rather than only in
    # the mirror: a caller that skipped `core.domains` must still be refused.
    "ramp.com\n/evil", "ramp\n.com", "RAMP.COİ", "café.com",
])
def test_garbage_is_refused_at_the_door(conn, user, co, bad):
    """The domain twin of the id's digits-only refusal: a value that does not
    normalize to a bare host RAISES rather than storing a string that renders the
    wrong company's logo. The harvest never sends these (it normalizes first), so this
    is defense in depth, exactly like 0016's anchored regex."""
    make_company(conn, name=co)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        fill(conn, co, bad, user_id=user)


# ------------------------------------------------- the column's own guard (CHECK)

@pytest.mark.parametrize("bad", [
    "HTTPS://WWW.Ramp.com/careers?x=1",   # not canonical: the door would have folded it
    "www.ramp.com", "Ramp.com", "ramp.com:8080", "ramp.com/careers", " ramp.com ",
    "ramp", "localhost", "not a host",
    # the network-address space, at the COLUMN — the doors are not the only writer
    "169.254.169.254", "0xa9.0xfe.0xa9.0xfe", "0251.0376.0251.0376", "192.168.001.010",
    "2130706433", "0xa9fea9fe", "127.0.0.1", "::1", "[::1]",
    "ramp.com\n/evil", "RAMP.COİ", "café.com",
])
def test_a_direct_write_cannot_put_a_non_canonical_host_in_the_column(conn, user, co, bad):
    """MUTATION REASON: drop `companies_domain_is_canonical` and every row here lands
    in the column, because NONE of these goes through `hq_fill_domain`.

    `hq_fill_domain` is not the only writer this column will ever have — the
    `domain_source = 'human'` vocabulary exists for a browser correction path, and a
    psql fix or a bulk mirror reaches the table with no door in front of it. A wrong
    host renders another company's logo behind an <img> that loads and looks right,
    so the invariant has to sit somewhere it cannot be routed around. This is
    `answers_company_is_a_key` (0014/0017) for a host.
    """
    cid = make_company(conn, name=co)
    with pytest.raises(psycopg.errors.CheckViolation):
        set_raw(conn, cid, bad)


def test_the_check_admits_a_canonical_host_and_the_blank(conn, user, co):
    """Non-vacuity for the test above: the constraint must not be refusing
    everything. '' is the absent state and `hq_normalize_domain('') = ''`."""
    cid = make_company(conn, name=co)
    for good in ("", "ramp.com", "jobs.ashbyhq.com", "northern-trust.co.uk",
                 "xn--caf-dma.com"):
        set_raw(conn, cid, good)
        assert domain_of(conn, cid) == good


def test_the_check_is_installed_and_names_the_canonicalizer(conn):
    """The constraint exists, is VALIDATED (not `not valid`), and is expressed as
    `domain = hq_normalize_domain(domain)` rather than a second copy of the regex —
    one definition of a host, so the CHECK cannot drift from the function the Python
    mirror is pinned against."""
    row = conn.execute("""
        select convalidated, pg_get_constraintdef(oid)
          from pg_constraint
         where conname = 'companies_domain_is_canonical'
    """).fetchone()
    assert row is not None, "companies_domain_is_canonical is not installed"
    validated, definition = row
    assert validated, "the constraint was left NOT VALID, so existing rows never proved it"
    assert "hq_normalize_domain" in definition, definition


def test_the_python_normalizer_agrees_with_the_database(conn):
    """The parity that keeps the harvest and the door from disagreeing about which
    strings are a host — `core.linkedinids.is_blank`'s pattern. A mismatch one way
    wastes an RPC on a domain the door rejects; the other way silently drops a domain
    the store would have taken."""
    for raw, _expected in DOMAIN_CASES:
        sql = conn.execute("select public.hq_normalize_domain(%s)", (raw,)).fetchone()[0]
        assert normalize_domain(raw) == sql, f"disagree on {raw!r}: py != sql ({sql!r})"


# ---------------------------------------------------------------- humans win

def test_the_engine_never_overwrites_a_human_domain(conn, user, co):
    cid = make_company(conn, name=co)
    set_human(conn, cid, "ramp.com")
    out = fill(conn, co, "other.com", user_id=user)
    assert out["outcome"] == "human_owned" and out["company_ids"] == []
    assert domain_of(conn, cid) == "ramp.com", "a bot overwrote a person's research"


def test_a_human_clear_is_a_tombstone_the_harvest_does_not_undo(conn, user, co):
    """MUTATION REASON: read blankness alone (`hq_blank_trim(domain) = ''`, no
    provenance) and this goes red with `filled` — a person's deliberate clear reverts
    to the harvested value the next morning, forever, on a lane that spends nothing."""
    cid = make_company(conn, name=co)
    set_human(conn, cid, "")            # "not this one"
    out = fill(conn, co, "ramp.com", user_id=user)
    assert out["outcome"] == "human_owned"
    assert domain_of(conn, cid) == "", "the daily harvest undid a deliberate clear"
    assert fill(conn, co, "other.com", user_id=user)["outcome"] == "human_owned"
    assert domain_of(conn, cid) == ""


def test_an_engine_value_reports_already_set(conn, user, co):
    make_company(conn, name=co)
    assert fill(conn, co, "ramp.com", user_id=user)["outcome"] == "filled"
    assert fill(conn, co, "ramp.com", user_id=user)["outcome"] == "already_set"


@pytest.mark.parametrize("odd", ["", "robot", "ENGINE", "Human"])
def test_an_unrecognised_provenance_does_not_lock_the_column_forever(conn, user, co, odd):
    """Anything not exactly 'human' is treated as not-human — the safe direction: an
    engine write is recoverable where a column locked against every run is not."""
    cid = make_company(conn, name=co)
    conn.execute("update public.companies set domain_source = %s where id = %s", (odd, cid))
    assert fill(conn, co, "ramp.com", user_id=user)["outcome"] == "filled"


def test_a_nameless_company_is_a_caller_bug_not_an_outcome(conn, user):
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        fill(conn, "   ", "ramp.com", user_id=user)


def test_no_user_is_refused(conn, co):
    make_company(conn, name=co)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        conn.execute("select public.hq_fill_domain(null, 'Ramp', 'ramp.com', 'x')")


# ---------------------------------------------------------------- per company, not per row

def test_a_human_domain_on_one_board_protects_its_siblings(conn, user, co):
    """MUTATION REASON: judge per row — put the blank guard in the UPDATE's WHERE and
    drop the whole-company counts — and this goes red with `filled`, leaving one
    employer with two different domains and no divergence signal anywhere."""
    a = make_company(conn, name=co, ats="workday", slug="d-wd5")
    b = make_company(conn, name=co.lower() + " ", ats="greenhouse", slug="d-gh")
    set_human(conn, a, "ramp.com")
    out = fill(conn, co, "other.com", user_id=user)
    assert out["outcome"] == "human_owned"
    assert domain_of(conn, a) == "ramp.com"
    assert domain_of(conn, b) == "", "one employer, two domains"


# ---------------------------------------------------------------- the version token

def test_a_no_op_fill_does_not_move_the_version_token(conn, user, co):
    """`companies.updated_at` is a tab's optimistic-concurrency token; 0013's touch
    trigger is conditional so a no-op fill must not move it. The blank guard being in
    the WHERE clause is what keeps a no-op fill from reaching the trigger at all."""
    cid = make_company(conn, name=co)
    fill(conn, co, "ramp.com", user_id=user)          # engine value now set
    before = company_of(conn, cid)[1]
    fill(conn, co, "ramp.com", user_id=user)          # already_set — returns before UPDATE
    assert company_of(conn, cid)[1] == before


def test_a_real_fill_does_move_the_version_token(conn, user, co):
    """Non-vacuity for the test above: a fill that DID write moves the token, so a tab
    holding the old value gets a truthful conflict (reloading shows the domain)."""
    cid = make_company(conn, name=co)
    before = company_of(conn, cid)[1]
    fill(conn, co, "ramp.com", user_id=user)
    assert company_of(conn, cid)[1] > before


# ---------------------------------------------------------------- concurrency

def test_two_engine_lanes_filling_at_once_write_one_value_and_one_event(conn, user, co):
    """Two lanes (two sweeps) can reach the same blank at once. One fills, the other
    finds it non-blank — not two events, not a lost update."""
    cid = make_company(conn, name=co)
    outcomes = []
    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        a.execute("select public.hq_fill_domain(%s,%s,%s,%s)", (user, co, "ramp.com", SOURCE))
        a.commit()
        row = b.execute("select public.hq_fill_domain(%s,%s,%s,%s)",
                        (user, co, "ramp.com", "wide-theirstack")).fetchone()[0]
        b.commit()
        outcomes.append(row["outcome"])
    assert outcomes == ["already_set"]
    assert domain_of(conn, cid) == "ramp.com"
    assert len(events_of(conn, user, "company.domain.filled")) == 1


# ---------------------------------------------------------------- the grid row

def test_the_domain_rides_home_inside_the_nested_company_object(conn, user, co):
    """0021 re-declares `app_company_row` to carry `domain`, and this is the only thing
    that proves it does — the web app reads the domain off that nested object to build
    the logo URL, so a builder that dropped the key would hand the grid `undefined`.

    MUTATION REASON: delete the `'domain', c.domain,` line from 0021's `app_company_row`
    and only this test fails. Read back through `app_set_linkedin_company_id`'s return
    (the one write door that emits the row), after an engine domain fill.
    """
    cid = make_company(conn, name=co)
    subscribe(conn, user, cid)
    fill(conn, co, "ramp.com", user_id=user)
    as_user(conn, user)
    row = set_linkedin(conn, cid, "1035")
    assert row["companies"]["domain"] == "ramp.com"
    # the fields 0013/0016 put there must still ride too — the new key displaced nothing
    assert row["companies"]["linkedin_company_id"] == "1035"
    assert "linkedin_id_source" in row["companies"]
