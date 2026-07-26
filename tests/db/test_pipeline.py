"""The pipeline write path, actually executed against Postgres (migration 0010).

`tests/core/test_migrations.py` reads the SQL as text; it catches a function
nobody defined and cannot catch a logic error. Everything here RUNS.

What it proves that reading the migration cannot:

    AC 14  a bot cannot change a status a human chose — enforced by a TRIGGER,
           so it holds for the engine's service-role writes too, not only for
           callers polite enough to use our functions
    AC 26  two concurrent writes -> one succeeds, one 409s, exactly one event
    row 43 a note survives the next note verbatim (append-only, and `update`
           REVOKED rather than merely unused)
    row 44 the backfill copies `applications.notes` and never clears it
    row 42 rejecting a suggestion does not change the status
    row 57 a reopen with no note is refused by the database

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q
"""
from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# A suite that skips itself reports green, which is worse than not existing.
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError(
        "HQ_REQUIRE_DB=1 but DATABASE_URL is unset — the db suite would have "
        "skipped every test and reported success"
    )

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "db" / "test-harness.sql"
MIGRATIONS = sorted((ROOT / "db" / "migrations").glob("*.sql"))


@pytest.fixture(scope="session")
def schema():
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute("drop schema if exists public cascade")
        conn.execute("drop schema if exists auth cascade")
        conn.execute("create schema public")
        conn.execute(HARNESS.read_text())
        for m in MIGRATIONS:
            try:
                conn.execute(m.read_text())
            except Exception as exc:  # pragma: no cover - surfaces as a failure
                pytest.fail(f"{m.name} failed to apply: {exc}")
    return True


@pytest.fixture
def conn(schema):
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


# ------------------------------------------------------------------ helpers

def as_user(conn, user_id: str):
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))


def make_user(conn) -> str:
    email = f"{uuid.uuid4()}@example.com"
    uid = str(uuid.uuid4())
    conn.execute(
        "insert into public.allowed_emails (email) values (%s) on conflict do nothing",
        (email,),
    )
    conn.execute("insert into auth.users (id, email) values (%s, %s)", (uid, email))
    return uid


def make_posting(conn, key: str, status: str = "Open") -> str:
    conn.execute(
        """insert into public.postings
             (key, company, title, url, status, first_seen, last_seen)
           values (%s, 'Ramp', 'Product Manager', 'https://example.com/1', %s,
                   current_date, current_date)
           on conflict (key) do update set status = excluded.status""",
        (key, status),
    )
    return key


def gate(conn, user_id: str, key: str) -> None:
    conn.execute(
        """insert into public.user_postings (user_id, posting_key, disposition)
           values (%s, %s, 'qualified') on conflict do nothing""",
        (user_id, key),
    )


def make_app(conn, user_id: str, *, status="Applied", posting_key=None,
             notes="", suggested="", actor="system") -> int:
    """Insert an application the way the engine's mirror would: directly, with
    the service role, naming no function of ours. That is deliberate — the whole
    point of the trigger is that it holds for THIS writer."""
    return conn.execute(
        """insert into public.applications
             (user_id, posting_key, company, title, url, status, suggested_status,
              notes, status_actor)
           values (%s, %s, 'Ramp', 'Product Manager', 'https://example.com/1',
                   %s, %s, %s, %s)
           returning id""",
        (user_id, posting_key, status, suggested, notes, actor),
    ).fetchone()[0]


def app_row(conn, app_id: int) -> dict:
    cols = ("status", "status_actor", "suggested_status", "notes",
            "next_action", "next_action_date", "updated_at", "status_set_at")
    row = conn.execute(
        f"select {', '.join(cols)} from public.applications where id = %s", (app_id,)
    ).fetchone()
    return dict(zip(cols, row))


def notes_of(conn, app_id: int) -> list[tuple[str, str]]:
    return conn.execute(
        """select body, author from public.application_notes
            where application_id = %s order by created_at, id""",
        (app_id,),
    ).fetchall()


def events_of(conn, app_id: int) -> list[tuple[str, str]]:
    return conn.execute(
        "select kind, actor from public.events where application_id = %s order by id",
        (app_id,),
    ).fetchall()


def set_status(conn, app_id, status, *, note=None, idem=None, expected=None):
    return conn.execute(
        "select public.app_set_status(%s, %s, %s, %s, %s)",
        # `idem if idem is not None` and NOT `idem or` — the falsy-default
        # version silently replaced the empty string the bounds test passes in,
        # so that test could not fail.
        (app_id, status, note, idem if idem is not None else str(uuid.uuid4()), expected),
    ).fetchone()[0]


# ------------------------------------------------------- AC 14, the whole point

def test_a_bot_write_cannot_change_a_status_a_human_chose(conn):
    """The live defect, at the layer that actually stops it.

    `status_rank('Rejected')` is above `status_rank('Offer')`, so the engine's
    forward-only rule was no protection at all: a rejection classified at 0.99
    was a legal forward move over an Offer a person had chosen.

    This exercises the ENGINE's shape of write — a plain UPDATE with the service
    role, calling none of our functions — because that is the writer that caused
    the defect, and a rule living inside `app_set_status` would not see it.
    """
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Offer")            # the human claims the row
    assert app_row(conn, app)["status_actor"] == "user"

    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "update public.applications set status = 'Rejected' where id = %s", (app,)
        )
    assert "locked" in str(exc.value).lower()
    assert app_row(conn, app)["status"] == "Offer"


def test_the_human_flag_does_not_leak_past_the_statement_that_set_it(conn):
    """The escape hatch is a transaction-local session flag, so the thing to
    prove is that it is CLEARED. A flag left standing would unlock every later
    write in the same transaction — turning the one mechanism that protects the
    row into a door propped open by the last legitimate caller."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)

    with psycopg.connect(DATABASE_URL) as c:
        c.execute("select set_config('hq.test_user', %s, false)", (user,))
        c.execute("select public.app_set_status(%s,'Offer',null,%s,null)",
                  (app, str(uuid.uuid4())))
        # Same transaction, immediately after a legitimate human write.
        with pytest.raises(psycopg.errors.Error) as exc:
            c.execute("update public.applications set status='Rejected' where id=%s", (app,))
        assert "locked" in str(exc.value).lower()
        c.rollback()


def test_an_unclaimed_row_is_still_freely_advanced(conn):
    """The positive control. Without it the trigger could refuse every update
    and the test above would still pass — a negative assertion is only
    meaningful beside its positive one."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    conn.execute("update public.applications set status = 'Rejected' where id = %s", (app,))
    assert app_row(conn, app)["status"] == "Rejected"


def test_a_bot_may_still_touch_every_other_column_on_a_locked_row(conn):
    """The lock is on `status`, not on the row. A rejection email must still be
    able to record its evidence and its suggestion — acceptance criterion 14's
    second half is that the human sees the bot's opinion."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Offer")

    conn.execute(
        """update public.applications
              set suggested_status = 'Rejected', evidence = 'https://mail.example/1'
            where id = %s""",
        (app,),
    )
    row = app_row(conn, app)
    assert row["status"] == "Offer" and row["suggested_status"] == "Rejected"


def test_setting_status_actor_in_the_same_write_is_NOT_enough(conn):
    """The obvious escape hatch, and why it is not the one that shipped.

    "Allow the write when it also sets `status_actor = \'user\'`" reads correctly
    and does nothing: an UPDATE that does not mention a column carries the OLD
    value into `new`, so on a row that is ALREADY locked every bot write arrives
    with `new.status_actor = \'user\'` for free. The one row the guard exists to
    protect was the one row it waved through. Pinned here so nobody simplifies
    the trigger back to it.
    """
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Offer")

    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            """update public.applications
                  set status = 'Rejected', status_actor = 'user' where id = %s""",
            (app,),
        )
    assert "locked" in str(exc.value).lower()
    assert app_row(conn, app)["status"] == "Offer"


def test_a_writer_that_declares_a_human_change_may_move_a_locked_status(conn):
    """The escape hatch that does work. A sheet mirror relaying a human's own
    edit says so — refusing it would leave the two systems permanently
    disagreeing about a row the person changed."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Offer")

    with psycopg.connect(DATABASE_URL) as c:
        c.execute("select set_config('hq.status_write', 'human', true)")
        c.execute(
            """update public.applications
                  set status = 'Offer-Accepted', status_actor = 'user' where id = %s""",
            (app,),
        )
        c.commit()
    assert app_row(conn, app)["status"] == "Offer-Accepted"


def test_status_actor_is_a_closed_set(conn):
    user = make_user(conn)
    app = make_app(conn, user)
    with pytest.raises(psycopg.errors.Error):
        conn.execute(
            "update public.applications set status_actor = 'robot' where id = %s", (app,)
        )


# ------------------------------------------------------------- set_status

def test_setting_a_status_writes_the_row_the_event_and_the_lock(conn):
    user = make_user(conn)
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
    gate(conn, user, key)
    app = make_app(conn, user, status="Applied", posting_key=key, suggested="Rejected")
    as_user(conn, user)

    result = set_status(conn, app, "Interview")

    assert result["status"] == "Interview"
    assert result["status_actor"] == "user"
    # A human choosing a status answers the suggestion by making it moot —
    # otherwise the row reads "Interview · suggests Rejected" forever.
    assert result["suggested_status"] == ""
    assert result["posting_status"] == "Open"     # the delisted signal, derived
    assert events_of(conn, app) == [("action.status", "user")]
    assert app_row(conn, app)["status_set_at"] is not None


def test_an_invented_status_is_accepted(conn):
    """The sheet allows one and `status_rank` ranks it highest by construction.
    Refusing it here would make the app strictly less capable than the
    spreadsheet it replaces."""
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)
    assert set_status(conn, app, "waiting on referral")["status"] == "waiting on referral"


def test_an_empty_or_oversized_status_is_refused_before_any_write(conn):
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    for bad in ("", "   ", "x" * 81):
        with pytest.raises(psycopg.errors.Error):
            set_status(conn, app, bad)
    assert app_row(conn, app)["status"] == "Applied"
    assert events_of(conn, app) == []


def test_an_idempotency_key_is_required_and_bounded(conn):
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)
    for bad in ("", "k" * 201):
        with pytest.raises(psycopg.errors.Error) as exc:
            set_status(conn, app, "Interview", idem=bad)
        assert "idempotency" in str(exc.value).lower()


def test_replaying_a_status_key_returns_the_first_result_and_writes_once(conn):
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    idem = str(uuid.uuid4())

    first = set_status(conn, app, "Interview", idem=idem)
    second = set_status(conn, app, "Offer", idem=idem)   # same key, different intent

    assert first == second, "a replay returned something other than the first result"
    assert app_row(conn, app)["status"] == "Interview"
    assert len(events_of(conn, app)) == 1


def test_reselecting_the_same_status_writes_nothing(conn):
    """0003's no-op rule. The UPDATE bumps `updated_at`, which is every other
    tab's version token, so a gesture that changes nothing used to invalidate
    them all and append an audit event about a non-event."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Interview")
    before = app_row(conn, app)

    set_status(conn, app, "Interview")

    after = app_row(conn, app)
    assert after["updated_at"] == before["updated_at"]
    assert len(events_of(conn, app)) == 1


def test_reselecting_a_status_a_bot_set_still_claims_the_lock(conn):
    """Not a no-op, even though `status` does not move: the human is asserting
    "this one is mine now", and the whole value of the gesture is the lock."""
    user = make_user(conn)
    app = make_app(conn, user, status="Offer", actor="system")
    as_user(conn, user)
    set_status(conn, app, "Offer")
    assert app_row(conn, app)["status_actor"] == "user"


def test_a_stale_version_token_is_a_conflict(conn):
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    stale = app_row(conn, app)["updated_at"]
    set_status(conn, app, "Interview")          # somebody else's write

    with pytest.raises(psycopg.errors.Error) as exc:
        set_status(conn, app, "Offer", expected=stale)
    # The word is load-bearing: supabase-source.ts matches /conflict|stale/i to
    # choose the conflict path over a generic "Couldn't save that".
    assert "conflict" in str(exc.value).lower()
    assert app_row(conn, app)["status"] == "Interview"


def test_another_users_application_is_invisible_to_this_one(conn):
    a, b = make_user(conn), make_user(conn)
    app = make_app(conn, a)
    as_user(conn, b)
    with pytest.raises(psycopg.errors.Error) as exc:
        set_status(conn, app, "Interview")
    assert "no such application" in str(exc.value).lower()


# ---------------------------------------------------------------- reopen

def test_reopening_without_a_note_is_refused_by_the_database(conn):
    """Matrix row 57. "Why is this alive again" is exactly what the audit trail
    exists to answer, and enforcing it in SQL rather than in the dialog means it
    holds for every caller — including a replayed outbox gesture."""
    user = make_user(conn)
    app = make_app(conn, user, status="Rejected")
    as_user(conn, user)

    for empty in (None, "", "   "):
        with pytest.raises(psycopg.errors.Error) as exc:
            set_status(conn, app, "Applied", note=empty)
        assert "note" in str(exc.value).lower()
    assert app_row(conn, app)["status"] == "Rejected"
    assert notes_of(conn, app) == []


def test_reopening_with_a_note_lands_applied_and_keeps_the_reason(conn):
    user = make_user(conn)
    app = make_app(conn, user, status="Withdrawn")
    as_user(conn, user)

    set_status(conn, app, "Applied", note="Recruiter emailed back")

    assert app_row(conn, app)["status"] == "Applied"
    assert notes_of(conn, app) == [("Recruiter emailed back", "user")]


def test_a_normal_status_change_needs_no_note(conn):
    """The positive control for the two above: the note requirement must bind on
    a reopen and nowhere else, or it is just a nuisance."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    assert set_status(conn, app, "Interview")["status"] == "Interview"


def test_moving_between_two_terminal_states_is_not_a_reopen(conn):
    user = make_user(conn)
    app = make_app(conn, user, status="Rejected")
    as_user(conn, user)
    assert set_status(conn, app, "Closed")["status"] == "Closed"


# ------------------------------------------------------------- suggestions

def test_confirming_a_suggestion_applies_it_and_claims_the_row(conn):
    user = make_user(conn)
    app = make_app(conn, user, status="Applied", suggested="Rejected")
    as_user(conn, user)

    result = conn.execute(
        "select public.app_resolve_suggestion(%s, 'confirm', %s, null)",
        (app, str(uuid.uuid4())),
    ).fetchone()[0]

    assert result["status"] == "Rejected"
    assert result["suggested_status"] == ""
    assert result["status_actor"] == "user"
    assert events_of(conn, app) == [("action.status.confirmed", "user")]


def test_rejecting_a_suggestion_leaves_the_status_completely_alone(conn):
    """Matrix row 42: a "no thanks" that quietly applies the thing it declined.

    `status_actor` is checked too, and stays `system` on purpose: declining one
    suggestion is not a claim over the row, and a later better-evidenced email
    should still be able to advance it.
    """
    user = make_user(conn)
    app = make_app(conn, user, status="Applied", suggested="Rejected")
    as_user(conn, user)

    result = conn.execute(
        "select public.app_resolve_suggestion(%s, 'reject', %s, null)",
        (app, str(uuid.uuid4())),
    ).fetchone()[0]

    assert result["status"] == "Applied"
    assert result["suggested_status"] == ""
    assert result["status_actor"] == "system"
    assert events_of(conn, app) == [("action.status.rejected", "user")]


def test_confirming_twice_applies_once(conn):
    """Matrix row 41. Two taps on a slow connection are one decision."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied", suggested="Rejected")
    as_user(conn, user)
    idem = str(uuid.uuid4())

    a = conn.execute("select public.app_resolve_suggestion(%s,'confirm',%s,null)",
                     (app, idem)).fetchone()[0]
    b = conn.execute("select public.app_resolve_suggestion(%s,'confirm',%s,null)",
                     (app, idem)).fetchone()[0]

    assert a == b
    assert len(events_of(conn, app)) == 1


def test_resolving_when_there_is_nothing_to_resolve_is_free(conn):
    """A second Confirm arriving after the first honestly means "already done".
    Raising would turn a free gesture into a red toast about a thing that
    worked."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    result = conn.execute("select public.app_resolve_suggestion(%s,'confirm',%s,null)",
                          (app, str(uuid.uuid4()))).fetchone()[0]
    assert result["status"] == "Applied"
    assert events_of(conn, app) == []


def test_an_unknown_decision_is_refused(conn):
    user = make_user(conn)
    app = make_app(conn, user, suggested="Rejected")
    as_user(conn, user)
    with pytest.raises(psycopg.errors.Error):
        conn.execute("select public.app_resolve_suggestion(%s,'maybe',%s,null)",
                     (app, str(uuid.uuid4())))


# ------------------------------------------------------------------ notes

def test_notes_are_append_only_and_the_first_survives_verbatim(conn):
    """Matrix row 43. The flat column lost note #1 the moment note #2 arrived."""
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)

    conn.execute("select public.app_add_note(%s,%s,%s)",
                 (app, "Panel is 3 rounds", str(uuid.uuid4())))
    result = conn.execute("select public.app_add_note(%s,%s,%s)",
                          (app, "Moved to Thursday", str(uuid.uuid4()))).fetchone()[0]

    assert notes_of(conn, app) == [("Panel is 3 rounds", "user"),
                                   ("Moved to Thursday", "user")]
    assert result["note_count"] == 2
    assert result["latest_note"]["body"] == "Moved to Thursday"


def test_the_append_only_privileges_are_absent_from_the_catalog(conn):
    """The same claim as the test below, asserted as a FACT rather than as a
    behaviour.

    The behavioural version flaked once in seven runs under load ("did not
    raise"), and was not reproducible afterwards. Per docs/WEBAPP-BUILD.md row 45
    a one-in-seven failure reads as a real one, so rather than retry it: the
    harness ordering was checked (the platform grants land at CREATE time inside
    0010, the revoke follows in the same file, and `conn` is function-scoped so no
    leftover `set role` can cross tests — nothing order-dependent found), and this
    assertion was added beside it. It reads `information_schema` instead of
    provoking an error, so it cannot depend on timing, session state or load. If
    the two ever disagree, the privilege is the truth.
    """
    for priv in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
        for role in ("anon", "authenticated"):
            granted = conn.execute(
                "select has_table_privilege(%s, 'public.application_notes', %s)",
                (role, priv),
            ).fetchone()[0]
            assert granted is False, f"{role} holds {priv} on an append-only table"
    # The positive control: SELECT is still granted, or the table is unreadable
    # and every negative above is vacuous.
    assert conn.execute(
        "select has_table_privilege('authenticated', 'public.application_notes', 'SELECT')"
    ).fetchone()[0] is True


def test_a_note_cannot_be_edited_or_deleted_even_by_an_authenticated_session(conn):
    """Append-only is a GRANT, not a convention. `revoke update, delete` is what
    makes "editing a note means appending a correction" true rather than
    aspirational.

    Flake note (row 45): this raised nothing once in seven runs under load and
    never again. The catalog assertion above is the deterministic half; if THIS
    one ever fails alone, suspect the session's role rather than the schema.
    """
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)
    conn.execute("select public.app_add_note(%s,%s,%s)", (app, "original", str(uuid.uuid4())))

    conn.execute("set role authenticated")
    try:
        # Asserted, not assumed: if `set role` silently did not take, every
        # `pytest.raises` below would be testing the superuser and the whole test
        # would pass for the wrong reason — which is the shape of the observed flake.
        assert conn.execute("select current_user").fetchone()[0] == "authenticated"
        for stmt in ("update public.application_notes set body = 'edited'",
                     "delete from public.application_notes"):
            with pytest.raises(psycopg.errors.Error) as exc:
                conn.execute(stmt)
            assert "permission denied" in str(exc.value).lower()
    finally:
        conn.execute("reset role")
    assert notes_of(conn, app) == [("original", "user")]


def test_an_empty_note_is_refused_before_any_write(conn):
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)
    for empty in (None, "", "   ", "\n\t "):
        with pytest.raises(psycopg.errors.Error):
            conn.execute("select public.app_add_note(%s,%s,%s)",
                         (app, empty, str(uuid.uuid4())))
    assert notes_of(conn, app) == []
    assert events_of(conn, app) == []


def test_adding_a_note_does_not_bump_the_application_version(conn):
    """A note is not a change to the application row. Bumping `updated_at`
    would invalidate every open tab's token and produce a phantom conflict on
    the next real gesture — for typing a comment."""
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)
    before = app_row(conn, app)["updated_at"]
    conn.execute("select public.app_add_note(%s,%s,%s)", (app, "hello", str(uuid.uuid4())))
    assert app_row(conn, app)["updated_at"] == before


def test_a_replayed_note_is_written_once(conn):
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)
    idem = str(uuid.uuid4())
    conn.execute("select public.app_add_note(%s,%s,%s)", (app, "once", idem))
    conn.execute("select public.app_add_note(%s,%s,%s)", (app, "once", idem))
    assert notes_of(conn, app) == [("once", "user")]


def test_the_backfill_copied_the_flat_column_and_left_it_in_place(conn):
    """Matrix row 44. Spec §E round-trips `notes` and the export column reads
    it, so clearing it here would silently blank a column in every export."""
    # Re-run the migration's backfill against a row that predates it — the same
    # statement, so this tests the shipped SQL rather than a paraphrase of it.
    user = make_user(conn)
    app = make_app(conn, user, notes="Referred by a UIUC alum.")
    backfill = next(m for m in MIGRATIONS if m.name.startswith("0010"))
    stmt = backfill.read_text().split("insert into public.application_notes (user_id, application_id, body, author, created_at)")[1]
    conn.execute(
        "insert into public.application_notes (user_id, application_id, body, author, created_at)"
        + stmt.split(";")[0]
    )

    assert app_row(conn, app)["notes"] == "Referred by a UIUC alum."
    assert notes_of(conn, app) == [("Referred by a UIUC alum.", "import")]

    # And it is idempotent: running it twice does not duplicate.
    conn.execute(
        "insert into public.application_notes (user_id, application_id, body, author, created_at)"
        + stmt.split(";")[0]
    )
    assert len(notes_of(conn, app)) == 1


# -------------------------------------------------------------- next action

def test_next_action_round_trips_and_a_blur_on_an_unchanged_field_writes_nothing(conn):
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)

    result = conn.execute(
        "select public.app_set_next_action(%s,%s,%s,%s,null)",
        (app, "Prep the ledger case study", "2026-08-01", str(uuid.uuid4())),
    ).fetchone()[0]
    assert result["next_action"] == "Prep the ledger case study"
    assert str(result["next_action_date"]) == "2026-08-01"

    before = app_row(conn, app)["updated_at"]
    conn.execute("select public.app_set_next_action(%s,%s,%s,%s,null)",
                 (app, "Prep the ledger case study", "2026-08-01", str(uuid.uuid4())))
    assert app_row(conn, app)["updated_at"] == before
    assert len(events_of(conn, app)) == 1


def test_next_action_on_a_locked_row_is_allowed(conn):
    """The lock is on `status` alone. A row a human claimed is still a row they
    keep working on."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Offer")
    conn.execute("select public.app_set_next_action(%s,%s,null,%s,null)",
                 (app, "Negotiate", str(uuid.uuid4())))
    assert app_row(conn, app)["next_action"] == "Negotiate"


# ------------------------------------------------------------- delisted (G2)

def test_the_delisted_signal_follows_the_posting_and_is_never_stored(conn):
    """Matrix row 54: a stored flag lies the moment the board reposts the role.
    Same application, two reads, two answers."""
    user = make_user(conn)
    key = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}", status="Closed")
    gate(conn, user, key)
    app = make_app(conn, user, posting_key=key)
    as_user(conn, user)

    assert set_status(conn, app, "Interview")["posting_status"] == "Closed"
    conn.execute("update public.postings set status = 'Open' where key = %s", (key,))
    assert set_status(conn, app, "Final")["posting_status"] == "Open"


def test_an_application_with_no_posting_reports_no_posting_status(conn):
    """A manually-added application. Renders as not-delisted, which is a false
    NEGATIVE — the right way round, since the other direction tells someone a
    live job is dead."""
    user = make_user(conn)
    app = make_app(conn, user, posting_key=None)
    as_user(conn, user)
    assert set_status(conn, app, "Interview")["posting_status"] is None


# ------------------------------------------------------------------ AC 26

def test_two_concurrent_status_writes_produce_one_success_and_one_event(conn):
    """Both sessions read the same `updated_at`, then both write. Without the
    row lock both pass the conflict check and both commit — two events for one
    decision, and a silent clobber."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    seen = app_row(conn, app)["updated_at"]

    outcomes: list[str] = []
    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        for c in (a, b):
            c.execute("select set_config('hq.test_user', %s, false)", (user,))
            c.commit()   # or a later rollback discards the identity with the tx
        # A bounded wait turns "blocked" into a visible outcome instead of a hang.
        b.execute("set lock_timeout = '5s'")

        try:
            a.execute("select public.app_set_status(%s,'Interview',null,%s,%s)",
                      (app, str(uuid.uuid4()), seen))
            outcomes.append("a-ok")
        except psycopg.errors.Error as exc:
            outcomes.append(f"a-fail:{exc}")
        a.commit()

        try:
            b.execute("select public.app_set_status(%s,'Rejected',null,%s,%s)",
                      (app, str(uuid.uuid4()), seen))
            b.commit()
            outcomes.append("b-ok")
        except psycopg.errors.Error as exc:
            b.rollback()
            outcomes.append(f"b-fail:{exc}")

    assert sum(o.endswith("-ok") for o in outcomes) == 1, outcomes
    assert any("conflict" in o.lower() for o in outcomes if "fail" in o), outcomes
    # The loser wrote nothing at all, not even an audit row.
    assert len(events_of(conn, app)) == 1
    assert app_row(conn, app)["status"] == "Interview"


def test_a_concurrent_replay_of_one_status_key_is_a_replay_not_a_conflict(conn):
    """Two tabs share one localStorage outbox and both flush on the same
    'online' event, so the same key arrives twice at once — both past the
    pre-lock check before either writes.

    Without the SECOND check behind the lock, the loser raises a duplicate-key
    error out of `command_idempotency` or a phantom conflict. Both are wrong: a
    replay is free by definition.

    The lock holder must perform the REAL write while the other caller is
    already blocked, or the race never occurs and the test passes with the fix
    removed — that mistake was made twice before it was caught (WEBAPP-BUILD).
    """
    import threading
    import time

    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    idem = str(uuid.uuid4())

    results, errors = [], []

    def call(conn_, status):
        try:
            row = conn_.execute("select public.app_set_status(%s,%s,null,%s,null)",
                                (app, status, idem)).fetchone()[0]
            conn_.commit()
            results.append(row)
        except Exception as exc:                      # noqa: BLE001 - reported below
            conn_.rollback()
            errors.append(str(exc))

    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        for c in (a, b):
            c.execute("select set_config('hq.test_user', %s, false)", (user,))
            # Committed: the setting is session-scoped but was applied inside an
            # implicit transaction, and A holds a transaction open below —
            # ending it would take A's identity with it and the call would fail
            # "not authenticated", for a reason unrelated to what is asserted.
            c.commit()
        b.execute("set lock_timeout = '10s'")

        # A takes the row lock and KEEPS the transaction open. B then enters
        # app_set_status, clears the PRE-lock idempotency check (the table is
        # still empty) and blocks. A — still inside that same transaction —
        # performs the real write and commits, which both stores the key and
        # releases the lock. B acquires it having already decided the key was
        # unseen, so only the post-lock re-check can save it.
        #
        # Releasing A's lock before A writes is the version that CANNOT FAIL:
        # the two never overlap inside the function, and B simply wins. That
        # mistake has been made twice in this repo.
        a.execute("begin")
        a.execute("select 1 from public.applications where id = %s for update", (app,))

        # B replays the key asking for a DIFFERENT status, which isolates the
        # post-lock re-check from the no-op guard below it — with identical
        # arguments the two fixes overlap and the test cannot tell them apart.
        t = threading.Thread(target=call, args=(b, "Rejected"))
        t.start()
        time.sleep(1.0)          # let B reach the lock and block on it
        call(a, "Interview")     # A writes and commits, releasing the lock to B
        t.join(timeout=30)
        assert not t.is_alive(), "the concurrent caller never returned"

    assert not errors, f"a concurrent replay of one key errored: {errors}"
    assert len(results) == 2, results
    assert results[0] == results[1], "the same key returned two different results"
    assert len(events_of(conn, app)) == 1
    assert app_row(conn, app)["status"] == "Interview"


# ------------------------------------------------------------------ RLS

def test_a_user_cannot_read_another_users_notes(conn):
    """Spec §I's two-real-user requirement, on the new table. Run under `set
    role authenticated` so RLS is actually in force — the harness grants what
    Supabase grants, which is what makes this assertion mean anything."""
    a, b = make_user(conn), make_user(conn)
    app_a = make_app(conn, a)
    as_user(conn, a)
    conn.execute("select public.app_add_note(%s,%s,%s)", (app_a, "A's private note",
                                                          str(uuid.uuid4())))

    conn.execute("set role authenticated")
    try:
        as_user(conn, a)
        mine = conn.execute("select count(*) from public.application_notes").fetchone()[0]
        as_user(conn, b)
        theirs = conn.execute("select count(*) from public.application_notes").fetchone()[0]
    finally:
        conn.execute("reset role")

    # The positive control first: without it, "B sees nothing" passes when
    # NOBODY can read the table, and would keep passing with every policy dropped.
    assert mine == 1, "the owner cannot read their own note — the policy is wrong"
    assert theirs == 0, "another user can read these notes"

# ---------------------------------------------------- hq_blank_trim (findings 1+2)

def test_the_trim_does_not_eat_a_leading_or_trailing_letter(conn):
    """Silent data corruption, and the reason the trim is a regex.

    The first version passed the character set as `btrim`'s SECOND ARGUMENT,
    written `E' \\t\\r\\n\\f\\v\\u00A0…'`. Postgres E-strings have no `\\v` escape, so
    that string contained the LETTER v — and btrim's second argument is a set of
    characters, not a pattern. Every note, status and next action lost a leading
    or trailing "v" on the way into an append-only table.
    """
    for value in ("verify comp band with Priya", "video screen prep", "v",
                  "review", "prep v", "vv"):
        got = conn.execute("select public.hq_blank_trim(%s)", (value,)).fetchone()[0]
        assert got == value, f"hq_blank_trim({value!r}) mangled it to {got!r}"


def test_the_trim_removes_every_space_like_character_from_both_ends(conn):
    # U+000B is here on purpose: it is what the broken escape was TRYING to name,
    # and the old version left it in place entirely.
    cases = {
        " x ": "x",
        "\tx\t": "x",
        "\nx\n": "x",
        "\rx\r": "x",
        "\x0bx\x0b": "x",      # vertical tab — the one \v was meant to be
        "\x0cx\x0c": "x",      # form feed
        "\u00a0x\u00a0": "x",  # NBSP, which no ASCII class contains
        "\u3000x\u3000": "x",
        "\u2009x\u2009": "x",  # inside the \u2000-\u200A range
        "\u200bx\u200b": "x",  # zero-width, stripped before the trim
    }
    for raw, want in cases.items():
        got = conn.execute("select public.hq_blank_trim(%s)", (raw,)).fetchone()[0]
        assert got == want, f"hq_blank_trim({raw!r}) = {got!r}, wanted {want!r}"


def test_the_trim_leaves_the_interior_alone(conn):
    """Trim, not collapse. A note's own line breaks and spacing are content —
    which is why this is NOT 0008's `company_name_key` shape, that one folds
    interior runs because it computes an identity."""
    for value in ("a  b", "a\nb", "a\tb", "line one\n\nline two"):
        got = conn.execute("select public.hq_blank_trim(%s)", (value,)).fetchone()[0]
        assert got == value, f"interior changed: {value!r} -> {got!r}"


def test_a_vertical_tab_note_is_refused_like_any_other_blank(conn):
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)
    for blank in ("\x0b", "\x0c", "\x0b\x0c \t"):
        with pytest.raises(psycopg.errors.Error):
            conn.execute("select public.app_add_note(%s,%s,%s)",
                         (app, blank, str(uuid.uuid4())))
    assert notes_of(conn, app) == []


def test_a_note_that_merely_starts_with_a_v_is_stored_verbatim(conn):
    user = make_user(conn)
    app = make_app(conn, user)
    as_user(conn, user)
    conn.execute("select public.app_add_note(%s,%s,%s)",
                 (app, "  verify comp band  ", str(uuid.uuid4())))
    assert notes_of(conn, app) == [("verify comp band", "user")]


# ------------------------------------------------- the latch itself (finding 4)

def test_the_lock_defends_its_own_latch(conn):
    """Guarding `status` alone left a ONE-STATEMENT UNLOCK.

    `update applications set status_actor = 'system'` passed cleanly, and the bot
    write behind it then passed too — a lock with the key taped to it. Releasing
    the row is a human gesture, and no UI in this phase performs it.
    """
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Offer")

    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "update public.applications set status_actor = 'system' where id = %s", (app,)
        )
    assert "locked" in str(exc.value).lower()
    assert app_row(conn, app)["status_actor"] == "user"

    # And the two-step version is refused at the first step, so the second never
    # gets its chance.
    with pytest.raises(psycopg.errors.Error):
        conn.execute(
            """update public.applications
                  set status_actor = 'system', status = 'Rejected' where id = %s""",
            (app,),
        )
    assert app_row(conn, app)["status"] == "Offer"


def test_a_declared_human_write_may_still_release_the_row(conn):
    """The positive control, and the gesture PHASE-PIPELINE explicitly defers:
    "let the bots drive this one again". The mechanism exists; no UI reaches it."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Offer")

    with psycopg.connect(DATABASE_URL) as c:
        c.execute("select set_config('hq.status_write', 'human', true)")
        c.execute(
            "update public.applications set status_actor = 'system' where id = %s", (app,)
        )
        c.commit()
    assert app_row(conn, app)["status_actor"] == "system"


def test_a_bot_may_still_write_other_columns_on_a_locked_row(conn):
    """The latch guard must not become a whole-row freeze — a rejection email
    still has to record its evidence and its suggestion."""
    user = make_user(conn)
    app = make_app(conn, user, status="Applied")
    as_user(conn, user)
    set_status(conn, app, "Offer")
    conn.execute(
        """update public.applications
              set suggested_status = 'Rejected', evidence = 'https://mail/1',
                  next_action = 'call back'
            where id = %s""",
        (app,),
    )
    row = app_row(conn, app)
    assert row["status"] == "Offer" and row["suggested_status"] == "Rejected"


# ------------------------------------------------- finished statuses (finding 5)

def test_un_ending_a_finished_search_needs_a_reason(conn):
    """`Offer-Accepted -> Applied` with no note used to go straight through.

    The reopen check named only the three TERMINAL states, so the two RESOLVED
    ones — the most consequential ending there is — were not reopens at all. It is
    reachable from the shipped Select, which offers every STATUS_ORDER value while
    only the Reopen button is gated on terminality.
    """
    for finished in ("Offer-Accepted", "Offer-Declined", "Rejected", "Withdrawn", "Closed"):
        user = make_user(conn)
        app = make_app(conn, user, status=finished)
        as_user(conn, user)
        with pytest.raises(psycopg.errors.Error) as exc:
            set_status(conn, app, "Applied")
        assert "note" in str(exc.value).lower(), finished
        assert app_row(conn, app)["status"] == finished
        # With a reason it goes through, so the rule is a prompt and not a wall.
        set_status(conn, app, "Applied", note=f"reopened from {finished}")
        assert app_row(conn, app)["status"] == "Applied"


def test_moving_between_two_finished_states_is_not_a_reopen(conn):
    user = make_user(conn)
    app = make_app(conn, user, status="Offer-Accepted")
    as_user(conn, user)
    assert set_status(conn, app, "Closed")["status"] == "Closed"


def test_the_finished_list_matches_the_typescript_and_python_copies(conn):
    """One list, three languages. It was four hand-typed copies and one of them
    was wrong, which is the whole reason `hq_finished_statuses()` exists."""
    sql = conn.execute("select public.hq_finished_statuses()").fetchone()[0]

    ts = (ROOT / "webapp" / "lib" / "status.ts").read_text()
    def ts_list(name: str) -> list[str]:
        m = re.search(rf"{name} = \[(.*?)\] as const", ts, re.S)
        assert m, f"{name} not found in status.ts"
        return re.findall(r'"([^"]+)"', m.group(1))

    py = (ROOT / "core" / "schema.py").read_text()
    def py_list(name: str) -> list[str]:
        m = re.search(rf"^{name} = \[(.*?)\]", py, re.M | re.S)
        assert m, f"{name} not found in schema.py"
        return re.findall(r'"([^"]+)"', m.group(1))

    expected = ts_list("STATUS_TERMINAL") + ts_list("STATUS_RESOLVED")
    assert sorted(sql) == sorted(expected), (sorted(sql), sorted(expected))
    assert sorted(expected) == sorted(py_list("STATUS_TERMINAL") + py_list("STATUS_RESOLVED"))

