"""The profile write path, actually executed against Postgres (migration 0012).

`tests/core/test_migrations.py` reads the SQL as text; it catches a function
nobody defined and cannot catch a logic error. Everything here RUNS.

What it proves that reading the migration cannot:

    G8/AC 18  a narrowed profile leaves an `interested` posting alone
    G8/AC 19  a widened profile does not reanimate a `dismissed` one, and DOES
              newly-qualify an untriaged one
    row 81    the "dry run" is `stable`, so Postgres refuses a write from
              inside it — the claim is enforced by the planner, not by review
    row 89    a double-submitted commit is one event, not two
    row 90    a stale version token is a conflict, not a clobber
    row 95    every re-gated row is locked in ascending key order, so two tabs
              saving in opposite display orders cannot deadlock

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q
"""
from __future__ import annotations

import json
import os
import re
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
    gate,
    make_posting,
    make_user,
    schema,  # noqa: F401 — session fixture
)

MIGRATION = Path(__file__).resolve().parents[2] / "db" / "migrations" / "0012_profile.sql"

CRITERIA = {
    "role_family": "product manager",
    "countries": ["United States"],
    "metros": [],
    "yoe_max": 4,
    "geo_unknown": "filter",
    "yoe_unknown": "seniority-proxy",
    "seniority_exclude": [],
    "comp_min": 0,
    "comp_unknown": "keep",
    "work_model_exclude": [],
    "titles_include": ["product manager"],
    "titles_exclude": [],
}


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def user(conn):
    # A fresh address per test: `make_user` defaults to one literal email and
    # the signup trigger enforces uniqueness, so the default would make every
    # test after the first fail on a UniqueViolation that says nothing about
    # the profile path.
    u = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, u)
    return u


#: `idem=AUTO` means "mint one"; `idem=""` has to reach the function verbatim, or
#: the blank-key probe tests the helper's `or` instead of the guard.
AUTO = object()


def commit(conn, *, criteria=None, notify=None, regate=None, idem=AUTO, expected=None):
    return conn.execute(
        "select public.app_commit_profile(%s::jsonb, %s::jsonb, %s::jsonb, %s, %s)",
        (
            json.dumps(criteria if criteria is not None else CRITERIA),
            json.dumps(notify) if notify is not None else None,
            json.dumps(regate if regate is not None else []),
            uuid.uuid4().hex if idem is AUTO else idem,
            expected,
        ),
    ).fetchone()[0]


def gated(conn, user_id, key, *, disposition="qualified", reason="", triage=""):
    """A user_postings row in a known state — the thing a re-gate acts on."""
    make_posting(conn, key)
    conn.execute(
        """insert into public.user_postings
             (user_id, posting_key, disposition, disposition_reason, triage)
           values (%s, %s, %s, %s, %s)
           on conflict (user_id, posting_key) do update
             set disposition = excluded.disposition,
                 disposition_reason = excluded.disposition_reason,
                 triage = excluded.triage""",
        (user_id, key, disposition, reason, triage),
    )
    return key


def row_of(conn, user_id, key):
    return conn.execute(
        """select disposition, disposition_reason, triage, updated_at
             from public.user_postings where user_id = %s and posting_key = %s""",
        (user_id, key),
    ).fetchone()


def events(conn, user_id, kind="profile.changed"):
    return conn.execute(
        "select payload from public.events where user_id = %s and kind = %s order by id",
        (user_id, kind),
    ).fetchall()


# ------------------------------------------------------------- the dry run

def test_the_preview_corpus_is_stable_so_postgres_refuses_a_write(conn, user):
    """Row 81, and it is a MECHANISM rather than a promise.

    A `stable` function cannot execute a data-modifying statement — Postgres
    raises 25006 — so "the dry run does not write" holds for any future edit to
    the body, including one made by somebody who never read this file.
    """
    volatility = conn.execute(
        "select provolatile from pg_proc where proname = 'app_preview_corpus'"
    ).fetchone()[0]
    assert volatility == "s", f"app_preview_corpus is {volatility!r}, not stable"

    # And the same claim from the other direction: a stable function with an
    # INSERT in it fails at call time, so the property is not merely declared.
    conn.execute(
        """create or replace function public.hq_tmp_stable_writer() returns int
             language plpgsql stable as $$
             begin insert into public.events (user_id, kind, actor)
                   values (auth.uid(), 'x', 'user'); return 1; end; $$"""
    )
    with pytest.raises(psycopg.errors.FeatureNotSupported):
        conn.execute("select public.hq_tmp_stable_writer()")
    conn.execute("drop function public.hq_tmp_stable_writer()")


def test_the_preview_corpus_sees_rows_the_user_was_never_gated(conn, user):
    """The whole reason it is `security definer`.

    A user onboarding has ZERO `user_postings` rows, and `0002_invariants.sql`
    scopes `postings` to rows they were gated. Under RLS their preview would run
    against an empty universe and answer "0 qualified" — which is the exact
    silent starvation this screen exists to remove.
    """
    make_posting(conn, f"gh-nobody-{uuid.uuid4().hex[:8]}")
    seen = conn.execute("select count(*) from public.app_preview_corpus(30)").fetchone()[0]
    assert seen > 0
    mine = conn.execute(
        "select count(*) from public.user_postings where user_id = %s", (user,)
    ).fetchone()[0]
    assert mine == 0, "the point of this test is that the user has no gated rows"


def test_the_preview_corpus_excludes_closed_postings(conn, user):
    """AC 16's rule: a dead posting is not evidence about tomorrow's queue."""
    key = f"gh-closed-{uuid.uuid4().hex[:8]}"
    make_posting(conn, key)
    conn.execute("update public.postings set status = 'Closed' where key = %s", (key,))
    keys = [r[0] for r in conn.execute("select key from public.app_preview_corpus(90)").fetchall()]
    assert key not in keys


def test_the_preview_corpus_clamps_its_window(conn, user):
    """5,000 rows / 90 days at the SQL boundary (row 91). A caller asking for
    3,650 days must not be able to make a page render walk the whole table."""
    old = f"gh-old-{uuid.uuid4().hex[:8]}"
    make_posting(conn, old)
    conn.execute(
        "update public.postings set last_seen = current_date - 120 where key = %s", (old,)
    )
    for days in (36500, -5, None):
        keys = [
            r[0]
            for r in conn.execute(
                "select key from public.app_preview_corpus(%s)", (days,)
            ).fetchall()
        ]
        assert old not in keys, f"a {days}-day window reached a 120-day-old posting"


def test_the_preview_corpus_carries_no_url(conn, user):
    """The widening is bounded by its projection as well as its row count."""
    cols = [
        r[0]
        for r in conn.execute(
            """select p.attname from pg_proc f
                 join lateral unnest(f.proargnames, f.proargmodes) as p(attname, mode) on true
                where f.proname = 'app_preview_corpus' and p.mode = 't'"""
        ).fetchall()
    ]
    assert cols and "url" not in cols, cols


# ------------------------------------------------------------ the save, G8

def test_a_narrowed_profile_leaves_an_interested_posting_alone(conn, user):
    """Acceptance criterion 18. The plan explicitly asks for the row to be
    filtered; the WHERE clause refuses, on the server, where a client bug
    cannot route around it."""
    key = gated(conn, user, f"gh-int-{uuid.uuid4().hex[:8]}", triage="interested")
    before = row_of(conn, user, key)
    out = commit(
        conn,
        regate=[{"key": key, "disposition": "filtered", "reason": "metro:Denver"}],
    )
    assert out["restamped"] == 0
    assert row_of(conn, user, key) == before


def test_a_widened_profile_does_not_reanimate_a_dismissed_row(conn, user):
    """Acceptance criterion 19's second half, and edge case G3."""
    key = gated(
        conn,
        user,
        f"gh-dis-{uuid.uuid4().hex[:8]}",
        disposition="filtered",
        reason="geo:India",
        triage="dismissed",
    )
    before = row_of(conn, user, key)
    out = commit(conn, regate=[{"key": key, "disposition": "qualified", "reason": ""}])
    assert out["restamped"] == 0
    assert out["newly_qualified_keys"] == []
    assert row_of(conn, user, key) == before


def test_a_widened_profile_does_qualify_an_untriaged_row(conn, user):
    """The positive control the two tests above are meaningless without: with
    the WHERE clause deleted they would still pass if nothing was ever
    restamped at all."""
    key = gated(
        conn,
        user,
        f"gh-new-{uuid.uuid4().hex[:8]}",
        disposition="filtered",
        reason="geo:India",
    )
    out = commit(conn, regate=[{"key": key, "disposition": "qualified", "reason": ""}])
    assert out["restamped"] == 1
    assert out["newly_qualified_keys"] == [key]
    assert row_of(conn, user, key)[:3] == ("qualified", "", "")


def test_a_row_already_carrying_the_planned_tuple_is_not_rewritten(conn, user):
    """`monitor/regate.py`'s idempotence. A no-op write bumps the version token
    every other open tab holds, so it manufactures a conflict banner about a
    change that never happened."""
    key = gated(conn, user, f"gh-same-{uuid.uuid4().hex[:8]}")
    before = row_of(conn, user, key)
    out = commit(conn, regate=[{"key": key, "disposition": "qualified", "reason": ""}])
    assert out["restamped"] == 0
    assert row_of(conn, user, key)[3] == before[3], "updated_at moved on a no-op"


def test_a_filtered_entry_with_no_reason_is_refused_not_applied(conn, user):
    """0002's `filtered_rows_state_a_reason` would abort the WHOLE save. The
    entry is skipped instead, so one malformed plan row cannot lose the other
    four thousand."""
    bad = gated(conn, user, f"gh-bad-{uuid.uuid4().hex[:8]}")
    good = gated(conn, user, f"gh-good-{uuid.uuid4().hex[:8]}")
    out = commit(
        conn,
        regate=[
            {"key": bad, "disposition": "filtered", "reason": ""},
            {"key": good, "disposition": "filtered", "reason": "geo:India"},
        ],
    )
    assert out["restamped"] == 1
    assert row_of(conn, user, bad)[:2] == ("qualified", "")
    assert row_of(conn, user, good)[:2] == ("filtered", "geo:India")


def test_an_invented_disposition_is_refused(conn, user):
    """The plan arrives from a browser. `user_postings` has no CHECK on
    disposition, so an unrecognised value would be written and every later read
    would render a state no code understands."""
    key = gated(conn, user, f"gh-inv-{uuid.uuid4().hex[:8]}")
    out = commit(conn, regate=[{"key": key, "disposition": "amazing", "reason": "x"}])
    assert out["restamped"] == 0
    assert row_of(conn, user, key)[0] == "qualified"


def test_a_plan_naming_another_users_row_reaches_nothing(conn):
    """Every lookup is `auth.uid()`-scoped, so a fabricated key touches only the
    caller's own rows — the same argument 0011 makes for carrying `job_key` as
    data (matrix row 141)."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, b)
    key = gated(conn, b, f"gh-b-{uuid.uuid4().hex[:8]}")
    before = row_of(conn, b, key)
    as_user(conn, a)
    out = commit(conn, regate=[{"key": key, "disposition": "filtered", "reason": "geo:India"}])
    assert out["restamped"] == 0
    assert row_of(conn, b, key) == before


# ------------------------------------------------- idempotency and conflict

def test_a_double_submitted_commit_writes_one_event(conn, user):
    """Matrix row 89. The stored RESULT is replayed, so the second call answers
    what the first did rather than a bare "already applied" the client cannot
    render."""
    key = gated(conn, user, f"gh-idem-{uuid.uuid4().hex[:8]}", disposition="filtered", reason="geo:India")
    idem = uuid.uuid4().hex
    first = commit(conn, regate=[{"key": key, "disposition": "qualified", "reason": ""}], idem=idem)
    second = commit(conn, regate=[{"key": key, "disposition": "qualified", "reason": ""}], idem=idem)
    assert first == second
    assert len(events(conn, user)) == 1


def test_a_stale_version_token_conflicts_and_writes_nothing(conn, user):
    """Matrix row 90. And it writes NOTHING — not even an audit row, which is
    the half that would otherwise leave a trail of saves that did not happen."""
    key = gated(conn, user, f"gh-conf-{uuid.uuid4().hex[:8]}", disposition="filtered", reason="geo:India")
    commit(conn)  # creates the row and moves updated_at
    with pytest.raises(psycopg.errors.SerializationFailure) as err:
        commit(
            conn,
            criteria={**CRITERIA, "yoe_max": 9},
            regate=[{"key": key, "disposition": "qualified", "reason": ""}],
            expected="2020-01-01T00:00:00Z",
        )
    assert "conflict" in str(err.value).lower()
    assert row_of(conn, user, key)[0] == "filtered"
    assert len(events(conn, user)) == 1


def test_the_matching_version_token_is_accepted(conn, user):
    """The control. Without it the conflict test passes for a function that
    refuses every expectation."""
    commit(conn)
    token = conn.execute(
        "select updated_at from public.profiles where user_id = %s", (user,)
    ).fetchone()[0]
    out = commit(conn, criteria={**CRITERIA, "yoe_max": 9}, expected=token)
    assert out["profile"]["criteria"]["yoe_max"] == 9


def test_an_empty_criteria_object_is_refused(conn, user):
    """`{}` is the never-onboarded sentinel the middleware redirect reads.
    Writing one would send somebody who just finished the wizard straight back
    into it, forever, with nothing on screen to explain why."""
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        commit(conn, criteria={})


def test_notify_is_preserved_when_the_commit_does_not_send_one(conn, user):
    """The digest phase owns that column. A profile save that blanked it would
    silently switch somebody's notifications back to the default."""
    commit(conn, notify={"notify_channel": "email"})
    commit(conn, criteria={**CRITERIA, "yoe_max": 7})
    row = conn.execute(
        "select notify from public.profiles where user_id = %s", (user,)
    ).fetchone()[0]
    assert row == {"notify_channel": "email"}


def test_the_event_records_before_and_after(conn, user):
    """One event per save, carrying what changed. `restamped_n` and
    `newly_qualified_keys` come from what the UPDATE ACTUALLY did — a report
    counted from the plan is matrix row 169's shape."""
    key = gated(conn, user, f"gh-ev-{uuid.uuid4().hex[:8]}", disposition="filtered", reason="geo:India")
    commit(conn, criteria={**CRITERIA, "yoe_max": 3})
    payload = commit(
        conn,
        criteria={**CRITERIA, "yoe_max": 8},
        regate=[{"key": key, "disposition": "qualified", "reason": ""}],
    )
    rows = events(conn, user)
    assert len(rows) == 2
    last = rows[-1][0]
    assert last["before"]["yoe_max"] == 3
    assert last["after"]["yoe_max"] == 8
    assert last["restamped_n"] == 1
    assert last["newly_qualified_keys"] == [key]
    assert payload["restamped"] == 1


def test_the_first_save_creates_the_row_nobody_created_at_signup(conn, user):
    """`handle_new_auth_user` writes `users` only. Without the upsert the very
    first save of every user's life raises."""
    assert (
        conn.execute(
            "select count(*) from public.profiles where user_id = %s", (user,)
        ).fetchone()[0]
        == 0
    )
    commit(conn)
    assert (
        conn.execute(
            "select count(*) from public.profiles where user_id = %s", (user,)
        ).fetchone()[0]
        == 1
    )


def test_an_oversized_plan_is_refused_rather_than_walked(conn, user):
    """A bound on a public endpoint."""
    plan = [{"key": f"k{i}", "disposition": "qualified", "reason": ""} for i in range(20001)]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        commit(conn, regate=plan)


# ----------------------------------------- the halves nothing was checking

def test_a_reason_only_restamp_is_not_reported_as_newly_qualified(conn, user):
    """The `b.was <> 'qualified'` half of the newly-qualified filter.

    A row can move from `qualified`/`""` to `qualified`/`yoe-unknown` — the gate
    reached a different branch and the disposition did not change. That IS a
    restamp and it is NOT news: the banner says "N previously-filtered postings
    now qualify" and links somebody at rows that were never filtered and have
    been in their queue the whole time. A mutant dropping the `was` comparison
    survived 383 tests.
    """
    reason_only = gated(conn, user, f"gh-ro-{uuid.uuid4().hex[:8]}", disposition="qualified", reason="")
    really_new = gated(
        conn, user, f"gh-rn-{uuid.uuid4().hex[:8]}", disposition="filtered", reason="geo:India"
    )
    out = commit(
        conn,
        regate=[
            {"key": reason_only, "disposition": "qualified", "reason": "yoe-unknown"},
            {"key": really_new, "disposition": "qualified", "reason": ""},
        ],
    )
    # Both rows were written…
    assert out["restamped"] == 2
    # …and exactly one of them is news.
    assert out["newly_qualified_keys"] == [really_new]
    assert row_of(conn, user, reason_only)[:2] == ("qualified", "yoe-unknown")


def test_a_needs_info_row_becoming_qualified_IS_newly_qualified(conn, user):
    """The other side of the same filter: `was` only has to DIFFER from
    'qualified', not to be 'filtered'. A row parked as `needs-info` that the tag
    pass has since resolved is a posting the user has never been offered."""
    key = gated(
        conn, user, f"gh-ni-{uuid.uuid4().hex[:8]}", disposition="needs-info", reason="awaiting-tags"
    )
    out = commit(conn, regate=[{"key": key, "disposition": "qualified", "reason": ""}])
    assert out["newly_qualified_keys"] == [key]


def test_the_preview_corpus_caps_at_five_thousand_rows(conn, user):
    """The cap is the only thing bounding a page render's work, and nothing
    executed it — a mutant raising the limit to 500,000 survived. The probe is
    deliberately just over: 5,100 rows in the window, 5,000 returned."""
    conn.execute(
        """insert into public.postings (key, company, title, url, status, first_seen, last_seen)
           select 'cap-' || g, 'Co', 'Product Manager', 'https://example.com/' || g,
                  'Open', current_date, current_date
             from generate_series(1, 5100) g
           on conflict (key) do nothing"""
    )
    n = conn.execute("select count(*) from public.app_preview_corpus(30)").fetchone()[0]
    assert n == 5000, n


def test_the_preview_corpus_returns_nothing_without_a_session(conn, user):
    """The `auth.uid() is not null` belt, EXECUTED rather than read.

    It was pinned only by a text search for the phrase, so a mutant rewriting it
    to a tautology (`auth.uid() is not null or true`) passed. The harness derives
    `auth.uid()` from `hq.test_user`, so clearing it is what an unauthenticated
    caller looks like from inside the function.
    """
    make_posting(conn, f"gh-belt-{uuid.uuid4().hex[:8]}")
    assert conn.execute("select count(*) from public.app_preview_corpus(30)").fetchone()[0] > 0
    conn.execute("select set_config('hq.test_user', '', false)")
    assert conn.execute("select count(*) from public.app_preview_corpus(30)").fetchone()[0] == 0


def test_a_blank_idempotency_key_is_refused(conn, user):
    """`command_idempotency`'s primary key is (user_id, idem_key) and `''` is a
    legal text value, so an empty key would make every LATER empty key replay the
    first gesture's result forever — a profile save that silently does nothing."""
    # A single space is the one worth spelling out: blank to a person, length 1 to
    # `length()`, and the shape `hq_blank_trim` exists for.
    for bad in ("", " ", "\n", "x" * 201):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            commit(conn, idem=bad)
    # …and the control, so this cannot pass by refusing everything.
    assert commit(conn, idem=uuid.uuid4().hex)["restamped"] == 0


def test_an_oversized_criteria_object_is_refused(conn, user):
    """Stored verbatim, granted to `authenticated`, and reachable by anyone with a
    session posting straight to /rest/v1/rpc. Both dimensions, because either
    alone is trivially avoided."""
    big_value = {"role_family": "x" * 70000}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        commit(conn, criteria=big_value)

    many_keys = {f"k{i}": i for i in range(250)}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        commit(conn, criteria=many_keys)

    with pytest.raises(psycopg.errors.InvalidParameterValue):
        commit(conn, criteria=CRITERIA, notify={"x": "y" * 70000})

    # The control: a real profile is nowhere near either bound.
    assert commit(conn)["restamped"] == 0


# ----------------------------------------------------------- ordered locking

def test_every_regated_row_is_locked_in_ascending_key_order(conn, user):
    """Matrix row 95, arriving on a new surface.

    Two tabs saving a profile hand this function the same keys in whatever order
    their own reads produced — a name-sorted grid and a comp-sorted one give
    opposite sequences — and each holding the row the other wants next is a
    40P01 surfaced to a person as a generic failure for a valid gesture. The
    lock is taken in one ordered statement before anything is written.

    Asserted on the SQL rather than by racing, because the race is only
    observable when the two orders differ AND both callers are mid-transaction;
    the concurrency proof for this shape already lives in
    `test_company_review.py`, and what is worth pinning here is that the ORDER
    BY did not get dropped in an edit.
    """
    sql = MIGRATION.read_text()
    body = re.search(r"perform 1\s*\n(.*?)for update;", sql, re.S)
    assert body, "the ordered pre-lock statement is gone"
    assert "order by up.posting_key" in body.group(1), body.group(1)
    # …and it comes BEFORE the update that writes them.
    assert sql.index("perform 1") < sql.index("update public.user_postings up")
