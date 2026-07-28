"""0019's emailed decision, executed against real Postgres.

`tests/core/test_migrations.py` reads the SQL as text: it proves the function is
revoked from every browser role and cannot prove that a replay returns the first
answer, that a re-tap writes nothing, or that clearing the triage takes the queued
application with it. Everything here RUNS.

What it proves that reading the migration cannot:

    * REPLAY. The same emailed link tapped again next week returns the answer the
      first tap produced and appends exactly ONE event — matrix row 26, which is
      the failure this whole lane is shaped around (a mail gateway may fire the
      POST, and a person will click the link again in a fortnight);
    * A NO-OP WRITES NOTHING, under a DIFFERENT idempotency key, so it is the
      short circuit doing the work and not the replay path: no `updated_at` bump,
      no second audit event. `updated_at` is the version token every open tab in
      the app is holding;
    * UNDO. `''` clears the triage and removes the `Queued` application it
      created, and appends a compensating event rather than deleting the original
      (acceptance criteria 10 and 11);
    * ROW 40, in the database rather than in the route: a posting the token's user
      was never gated raises a NAMED error, so the page can render "no longer
      listed" instead of a 500;
    * the function is unreachable from a signed-in browser, beside a positive
      control — a negative assertion alone passes when the session can do nothing
      at all (matrix row 42).

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q

MUTATION TARGETS this file is meant to catch (each run red before green):
  * drop the replay read ABOVE the lock    -> the replay test appends two events;
  * drop the replay read BEHIND the lock   -> survives this suite (it is a
    concurrency-only path) and is kept because 0003 measured it; the sequential
    half is what is asserted here;
  * drop the no-op short circuit           -> "a re-tap changes nothing" sees a
    bumped updated_at and a second event;
  * `for update` removed                   -> survives sequentially, same note;
  * accept 'snoozed'                       -> "only three values are legal";
  * `raise` -> `return null` on a missing row
                                           -> "a posting the user does not have";
  * delete the application on every triage -> "interested keeps its application";
  * grant execute to `authenticated`       -> the browser test triages anybody;
  * store the idempotency result under `app_set_triage`
                                           -> "the two doors are distinguishable".
"""
from __future__ import annotations

import os
import uuid

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError(
        "HQ_REQUIRE_DB=1 but DATABASE_URL is unset — the db suite would have "
        "skipped every test and reported success"
    )
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from tests.db.test_pipeline import (  # noqa: E402
    as_user, conn, gate, make_posting, make_user, schema,
)

__all__ = ["conn", "schema"]     # re-exported fixtures; flake8 would call them unused


# ------------------------------------------------------------------ helpers

def digest(conn, user, key, triage, idem):
    """`hq_digest_set_triage`, called the way the route calls it."""
    return conn.execute(
        "select public.hq_digest_set_triage(%s, %s, %s, %s)", (user, key, triage, idem)
    ).fetchone()[0]


def ready(conn, *, status="Open"):
    """A user with one gated posting, which is what a digest row is."""
    user = make_user(conn)
    key = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:8]}", status=status)
    gate(conn, user, key)
    return user, key


def row(conn, user, key):
    return conn.execute(
        "select triage, triage_reason, snooze_until, updated_at from public.user_postings"
        " where user_id = %s and posting_key = %s",
        (user, key),
    ).fetchone()


def events(conn, user):
    return conn.execute(
        "select kind, payload, actor from public.events where user_id = %s order by id", (user,)
    ).fetchall()


def apps(conn, user, key):
    return conn.execute(
        "select status from public.applications where user_id = %s and posting_key = %s", (user, key)
    ).fetchall()


# ------------------------------------------------------------------ the write

def test_one_tap_triages_the_row_and_leaves_the_trail(conn, schema):
    user, key = ready(conn)
    result = digest(conn, user, key, "interested", "jti-1")

    assert result["triage"] == "interested"
    # The page names the company and the title off THIS jsonb rather than off a
    # second read, so the shape is part of the contract.
    assert result["postings"]["company"] == "Ramp"
    assert row(conn, user, key)[0] == "interested"

    kinds = [(e[0], e[2]) for e in events(conn, user)]
    assert kinds == [("action.interested", "user")]
    # `actor` is 'user' because a person tapped a link in their own mail; `via`
    # records which door, which is the question an incident actually asks.
    assert events(conn, user)[0][1]["via"] == "digest"
    assert events(conn, user)[0][1]["idem"] == "jti-1"
    # Acceptance criterion 9, through a second door.
    assert apps(conn, user, key) == [("Queued",)]


def test_dismissing_writes_no_application(conn, schema):
    user, key = ready(conn)
    digest(conn, user, key, "dismissed", "jti-1")
    assert row(conn, user, key)[0] == "dismissed"
    assert apps(conn, user, key) == []
    assert [e[0] for e in events(conn, user)] == ["action.dismissed"]


# ------------------------------------------------------------------ replay

def test_replaying_one_token_returns_the_first_answer_and_appends_one_event(conn, schema):
    """Matrix row 26, and the reason the token's `jti` is the idempotency key.

    A mail gateway can fire the POST, and a person will click the same link again
    in a fortnight. Both must be free.
    """
    user, key = ready(conn)
    first = digest(conn, user, key, "interested", "jti-1")
    second = digest(conn, user, key, "interested", "jti-1")
    third = digest(conn, user, key, "interested", "jti-1")

    # Byte-identical, including `updated_at` — the replay returns what was STORED,
    # not a fresh read of a row that may have moved since.
    assert second == first
    assert third == first
    assert [e[0] for e in events(conn, user)] == ["action.interested"]
    assert apps(conn, user, key) == [("Queued",)]


def test_the_idempotency_row_names_this_door(conn, schema):
    """`app_set_triage` and this function share a keyspace, so they must not share
    a name: 'which command produced this stored result' is unanswerable otherwise,
    and the two have different authorization stories."""
    user, key = ready(conn)
    digest(conn, user, key, "interested", "jti-1")
    assert conn.execute(
        "select command from public.command_idempotency where user_id = %s and idem_key = %s",
        (user, "jti-1"),
    ).fetchone()[0] == "hq_digest_set_triage"


def test_a_re_tap_under_a_NEW_key_changes_nothing_and_bumps_nothing(conn, schema):
    """The no-op short circuit, isolated from the replay path.

    The idempotency key is DIFFERENT here on purpose — next week's digest mints a
    new token for a row the person already decided, so the replay read cannot be
    what saves this. Without the short circuit the UPDATE bumps `updated_at`,
    which is the version token every open tab in the app is holding, and appends a
    second audit event about a write that changed nothing.
    """
    user, key = ready(conn)
    digest(conn, user, key, "interested", "jti-1")
    before = row(conn, user, key)

    again = digest(conn, user, key, "interested", "jti-2")

    after = row(conn, user, key)
    assert after == before, "a gesture that changed nothing bumped the row"
    # The caller still gets the row to render — a no-op answers, it does not
    # refuse. The route renders "already decided" off exactly this.
    assert again["triage"] == "interested"
    assert [e[0] for e in events(conn, user)] == ["action.interested"]
    assert apps(conn, user, key) == [("Queued",)]


def test_a_re_tap_does_not_erase_a_reason_the_human_typed(conn, schema):
    """0003 clears `triage_reason` whenever the caller passes none, which is right
    for a form that had the field and left it empty. This caller has no field at
    all, so a re-tap of a link for a decision the row already carries must not
    quietly delete a note somebody wrote in the app."""
    user, key = ready(conn)
    digest(conn, user, key, "interested", "jti-1")
    conn.execute(
        "update public.user_postings set triage_reason = 'ledger work'"
        " where user_id = %s and posting_key = %s", (user, key),
    )
    digest(conn, user, key, "interested", "jti-2")
    assert row(conn, user, key)[1] == "ledger work"


# ------------------------------------------------------------------ undo

def test_clearing_the_triage_is_the_undo(conn, schema):
    """`''` is a legal value here precisely so Undo works, and Undo is what makes a
    one-tap action from an inbox safe to offer at all."""
    user, key = ready(conn)
    digest(conn, user, key, "interested", "jti-1")
    result = digest(conn, user, key, "", "jti-undo")

    assert result["triage"] == ""
    assert row(conn, user, key)[0] == ""
    # Acceptance criterion 11: the application it created goes with it, while it
    # is still bot-untouched.
    assert apps(conn, user, key) == []
    # Acceptance criterion 10: append-only. The original event survives and a
    # compensating one lands beside it.
    assert [e[0] for e in events(conn, user)] == ["action.interested", "action.untriage"]


def test_undo_leaves_an_application_a_bot_has_advanced(conn, schema):
    """Once a confirmation email has moved it, the application is evidence of
    something that really happened and must survive an undo."""
    user, key = ready(conn)
    digest(conn, user, key, "interested", "jti-1")
    conn.execute(
        "update public.applications set status = 'Applied', status_actor = 'system'"
        " where user_id = %s and posting_key = %s", (user, key),
    )
    digest(conn, user, key, "", "jti-undo")
    assert apps(conn, user, key) == [("Applied",)]


def test_changing_your_mind_removes_the_queued_application(conn, schema):
    """A row moved from interested to dismissed must not leave a live `Queued` row
    in the pipeline for a job the person explicitly rejected."""
    user, key = ready(conn)
    digest(conn, user, key, "interested", "jti-1")
    digest(conn, user, key, "dismissed", "jti-2")
    assert apps(conn, user, key) == []
    assert row(conn, user, key)[0] == "dismissed"


def test_a_snoozed_row_loses_its_wake_date(conn, schema):
    """A dismissed row carrying a stale snooze date is a row that reanimates
    itself — and a `snooze_until` still set is why the no-op short circuit checks
    it rather than looking at the triage alone."""
    user, key = ready(conn)
    # Both columns in ONE statement: `snooze_has_a_date` refuses a snoozed row
    # with no wake date, which is the constraint this behaviour exists to honour.
    conn.execute(
        "update public.user_postings set triage = 'snoozed', snooze_until = current_date + 7"
        " where user_id = %s and posting_key = %s", (user, key),
    )
    digest(conn, user, key, "dismissed", "jti-1")
    assert row(conn, user, key)[2] is None


# ------------------------------------------------------------------ refusals

@pytest.mark.parametrize("bad", ["snoozed", "Interested", "maybe", " ", None])
def test_only_three_values_are_legal_and_the_refusal_names_the_value(conn, schema, bad):
    """`snoozed` passes the column's CHECK and is refused anyway: it needs a wake
    date, and an emailed link has no way to ask for one. A named error beats a
    constraint violation surfacing to somebody as a wall of Postgres text."""
    user, key = ready(conn)
    with pytest.raises(psycopg.errors.InvalidParameterValue) as caught:
        digest(conn, user, key, bad, "jti-1")
    assert "invalid triage value" in str(caught.value)
    assert row(conn, user, key)[0] == ""
    assert events(conn, user) == []


def test_a_posting_the_user_does_not_have_raises_a_NAMED_error(conn, schema):
    """Matrix row 40, enforced in the database as well as in the route.

    The acting user comes out of an HMAC signature, so a token replayed against a
    posting only somebody else was gated arrives here — and it must be
    distinguishable from a real fault, because the route renders it as "no longer
    listed" and anything else would be a 500 on a page reached from an inbox.
    """
    mine, key = ready(conn)
    stranger = make_user(conn)

    with pytest.raises(psycopg.Error) as caught:
        digest(conn, stranger, key, "interested", "jti-1")
    assert caught.value.sqlstate == "P0002"
    assert "no such posting for this user" in str(caught.value)

    # Nothing was written for either party, and no idempotency row was stored —
    # a recorded "result" for a call that raised would make the retry a lie.
    assert events(conn, stranger) == []
    assert row(conn, mine, key)[0] == ""
    assert conn.execute(
        "select count(*) from public.command_idempotency where user_id = %s", (stranger,)
    ).fetchone()[0] == 0
    # The positive control: the owner's own tap still works.
    assert digest(conn, mine, key, "interested", "jti-2")["triage"] == "interested"


def test_a_closed_posting_is_refused_and_creates_no_application(conn, schema):
    """C3 review M1 / matrix row 41, enforced in the database as well as the route.

    The board closed the listing between the send and the tap. `digestGet` renders
    "no longer listed"; a first POST must NOT then write a triage or mint a
    `Queued` application for a dead role. Same errcode as not-found, because the
    page is the same and the store maps both to "gone".
    """
    user, key = ready(conn, status="Closed")

    with pytest.raises(psycopg.Error) as caught:
        digest(conn, user, key, "interested", "jti-1")
    assert caught.value.sqlstate == "P0002"
    assert "no longer open" in str(caught.value)

    # Nothing written: no triage, no application, no event, no idempotency row.
    assert row(conn, user, key)[0] == ""
    assert apps(conn, user, key) == []
    assert events(conn, user) == []
    assert conn.execute(
        "select count(*) from public.command_idempotency where user_id = %s", (user,)
    ).fetchone()[0] == 0


def test_a_decision_made_before_the_board_closed_still_replays_its_recorded_answer(conn, schema):
    """The other half of M1: the closed check sits AFTER the replay check, so a
    token whose first tap landed while the posting was open keeps returning that
    answer even after the board closes it — the replay must not start raising
    'no longer open' about a decision that really happened."""
    user, key = ready(conn, status="Open")
    first = digest(conn, user, key, "interested", "jti-1")
    assert first["triage"] == "interested"

    conn.execute("update public.postings set status = 'Closed' where key = %s", (key,))

    replay = digest(conn, user, key, "interested", "jti-1")
    assert replay["triage"] == "interested"          # the recorded answer, not a raise
    assert apps(conn, user, key) == [("Queued",)]     # still exactly one application
    assert [e[0] for e in events(conn, user)] == ["action.interested"]


def test_the_replay_is_scoped_to_the_posting_the_token_names(conn, schema):
    """C3 review m1. The idempotency key is `(user_id, idem_key)`, and a `jti` is
    128 random bits minted per (user, posting, action) so a cross-posting
    collision is not reachable — but a replay that returned a row the caller never
    named would put the wrong company on the success page. The guard is one
    predicate: a stored result for a different posting is not a replay, so the
    call falls through to the posting the token actually signs."""
    user = make_user(conn)
    key_a = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:8]}", status="Open")
    key_b = make_posting(conn, f"greenhouse-{uuid.uuid4().hex[:8]}", status="Open")
    gate(conn, user, key_a)
    gate(conn, user, key_b)

    # A first tap on posting A stores an idempotency row under jti-shared.
    digest(conn, user, key_a, "interested", "jti-shared")

    # The same key arriving for posting B must apply to B, not replay A's answer.
    out = digest(conn, user, key_b, "dismissed", "jti-shared")
    assert out["posting_key"] == key_b
    assert row(conn, user, key_b)[0] == "dismissed"
    assert row(conn, user, key_a)[0] == "interested"   # A untouched


def test_a_missing_user_or_key_is_a_refusal_not_a_guess(conn, schema):
    user, key = ready(conn)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        digest(conn, None, key, "interested", "jti-1")
    for bad_idem in (None, "", "x" * 201):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            digest(conn, user, key, "interested", bad_idem)
    assert events(conn, user) == []


# ------------------------------------------------------------------ reachability

def test_the_function_is_unreachable_from_a_signed_in_browser(conn, schema):
    """It takes the acting user as an ARGUMENT, so a browser that could call it
    could triage anybody's queue. `tests/core/test_migrations.py` pins the revoke
    as text; this proves the privilege for a role it can become."""
    user, key = ready(conn)
    with psycopg.connect(DATABASE_URL, autocommit=True) as browser:
        browser.execute("set role authenticated")
        as_user(browser, user)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            browser.execute(
                "select public.hq_digest_set_triage(%s, %s, 'interested', 'jti-1')", (user, key)
            )
        # The positive control: this session CAN act, through the door meant for
        # it. Without this the refusal above would pass on a connection that
        # cannot do anything at all (matrix row 42).
        browser.execute(
            "select public.app_set_triage(%s, 'interested', null, null, 'jti-2', null)", (key,)
        )
    assert row(conn, user, key)[0] == "interested"


def test_the_two_doors_agree_about_what_a_decision_means(conn, schema):
    """0006 accepted a copied body with a stated reason and pinned the agreement
    in a test rather than in an abstraction. This is that pin: the same gesture
    through both functions produces the same row, the same application and the
    same event kind."""
    a, key_a = ready(conn)
    b, key_b = ready(conn)

    digest(conn, a, key_a, "interested", "jti-1")
    with psycopg.connect(DATABASE_URL, autocommit=True) as browser:
        browser.execute("set role authenticated")
        as_user(browser, b)
        browser.execute(
            "select public.app_set_triage(%s, 'interested', null, null, 'jti-1', null)", (key_b,)
        )

    assert row(conn, a, key_a)[0] == row(conn, b, key_b)[0] == "interested"
    assert apps(conn, a, key_a) == apps(conn, b, key_b) == [("Queued",)]
    assert [e[0] for e in events(conn, a)] == [e[0] for e in events(conn, b)] == [
        "action.interested",
    ]
