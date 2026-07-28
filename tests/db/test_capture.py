"""0018's capture lane, executed against real Postgres.

`tests/core/test_capture_contract.py` reads the SQL as text: it proves the field
lists agree in four languages and cannot prove that replaying a batch stores it
once, or that a signed-in browser cannot read somebody else's mail. Everything
here RUNS.

What it proves that reading the migration cannot:

    * `(user_id, event_id)` really dedupes — the same message twice, from two
      mailboxes, and from two overlapping calls;
    * ONE BAD ROW DOES NOT DROP THE BATCH. The per-row exception block is the
      whole reason `hq_capture_email_events` is a loop rather than one
      `insert … select`, and the difference is invisible until a CHECK fires;
    * RLS, both directions: the owner reads their own events, another signed-in
      user reads none of them, and `capture_tokens` is invisible to everybody —
      each beside a positive control, because a negative assertion alone passes
      when the test cannot read anything at all (matrix row 42);
    * the digest Postgres stores for a minted token is the one `node:crypto`
      computes for the same secret, pinned to the shared golden;
    * rotate revokes only its own label, and a revoked token stays on the row.

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q

MUTATION TARGETS this file is meant to catch (each run red before green):
  * drop the per-row `exception when others` block -> the mixed-batch test loses
    the good rows with the bad one;
  * `on conflict do nothing` -> a bare insert    -> the replay test raises;
  * `on conflict do update`                      -> the replay test sees the
    stored row rewritten by a re-classified resend;
  * drop `unique (user_id, event_id)`            -> the replay test inserts twice;
  * make the unique key `event_id` alone         -> the two-users test denies the
    second person their own copy of a shared message;
  * grant the function to `authenticated`        -> the browser test writes into
    another user's lane;
  * add a read policy to `capture_tokens`        -> the digest-invisible test;
  * `hq_rotate_capture_token` revoking by user   -> the alt-token survives test.
"""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path

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
    as_user, conn, make_user, schema,
)

__all__ = ["conn", "schema"]     # re-exported fixtures; flake8 would call them unused

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = json.loads((ROOT / "tests" / "fixtures" / "capture-token.golden.json").read_text())


# ------------------------------------------------------------------ helpers

def event(**over) -> dict:
    """One wire row as the endpoint hands it over — COLUMN names, normalized."""
    row = {
        "event_id": f"<{uuid.uuid4()}@mail.gmail.com>",
        "account": "main",
        "received_at": "2026-07-27T14:02:11.000Z",
        "from_addr": "Ramp Recruiting <no-reply@greenhouse.io>",
        "subject": "Thank you for applying to Ramp",
        "snippet": "We received your application.",
        "event_type": "received",
        "company": "Ramp",
        "title": "Product Manager",
        "ats": "greenhouse",
        "job_url": "https://boards.greenhouse.io/ramp/jobs/1",
        "confidence": 0.93,
        "evidence": "We received your application",
        "thread_link": "https://mail.google.com/mail/u/0/#all/18f",
        "processed_at": "2026-07-27T14:02:19.000Z",
    }
    row.update(over)
    return row


def capture(conn, user, events, token_id=None) -> list[dict]:
    """`hq_capture_email_events`, called the way the route calls it."""
    got = conn.execute(
        "select public.hq_capture_email_events(%s, %s, %s::jsonb)",
        (user, token_id, json.dumps(events)),
    ).fetchone()[0]
    return got["results"]


def outcomes(results) -> list[str]:
    return [r["outcome"] for r in results]


def mint(conn, user, label="main") -> dict:
    return conn.execute(
        "select public.hq_mint_capture_token(%s, %s)", (user, label)
    ).fetchone()[0]


def stored(conn, user, event_id) -> dict | None:
    row = conn.execute(
        """select event_type, company, confidence, account, subject,
                  received_at, processed_at, captured_at, matched_key
             from public.email_events where user_id = %s and event_id = %s""",
        (user, event_id),
    ).fetchone()
    if row is None:
        return None
    keys = ("event_type", "company", "confidence", "account", "subject",
            "received_at", "processed_at", "captured_at", "matched_key")
    return dict(zip(keys, row))


# ------------------------------------------------------------------ storing

def test_a_batch_lands_and_the_row_is_what_was_sent(conn, schema):
    user = make_user(conn)
    ev = event(event_id="<one@x>")
    assert outcomes(capture(conn, user, [ev])) == ["inserted"]

    row = stored(conn, user, "<one@x>")
    assert row["event_type"] == "received"
    assert row["company"] == "Ramp"
    assert float(row["confidence"]) == pytest.approx(0.93)
    assert row["received_at"].isoformat().startswith("2026-07-27T14:02:11")
    # The third stamp exists and is not either of the other two: it is how long
    # the POST lane was down, and nothing else in the row can say it.
    assert row["captured_at"] > row["processed_at"]
    # Engine-owned, and the endpoint may not write it. '' rather than NULL, so
    # "the join lane has not retired this" is one comparison forever.
    assert row["matched_key"] == ""


def test_replaying_a_batch_stores_it_once(conn, schema):
    """The retry queue replays WHOLE batches; a replay has to be free."""
    user = make_user(conn)
    batch = [event(event_id="<a@x>"), event(event_id="<b@x>")]
    assert outcomes(capture(conn, user, batch)) == ["inserted", "inserted"]
    assert outcomes(capture(conn, user, batch)) == ["duplicate", "duplicate"]
    assert conn.execute(
        "select count(*) from public.email_events where user_id = %s", (user,)
    ).fetchone()[0] == 2


def test_a_partly_delivered_batch_reports_each_half_honestly(conn, schema):
    user = make_user(conn)
    capture(conn, user, [event(event_id="<a@x>")])
    assert outcomes(capture(conn, user, [event(event_id="<a@x>"), event(event_id="<b@x>")])) == [
        "duplicate", "inserted",
    ]


def test_a_replay_does_not_overwrite_what_was_stored(conn, schema):
    """`do nothing`, not `do update`, and this is the reason.

    The classifier is an LLM: the same message re-read can come back with a
    different type at a different confidence. The row is the record of one message
    AS CLASSIFIED WHEN IT WAS CAPTURED, and the join lane may already have acted on
    it — 0015 handles a changed mind in its idempotency key, which is where that
    decision belongs.
    """
    user = make_user(conn)
    capture(conn, user, [event(event_id="<a@x>", event_type="received", confidence=0.6)])
    capture(conn, user, [event(event_id="<a@x>", event_type="rejection", confidence=0.99)])
    row = stored(conn, user, "<a@x>")
    assert row["event_type"] == "received"
    assert float(row["confidence"]) == pytest.approx(0.6)


def test_the_forwarded_copy_from_the_alt_mailbox_dedupes(conn, schema):
    """`appsscript/README.md`: the RFC-822 Message-ID survives forwarding, so the
    alt inbox's copy is the same event. The sheet lane relies on this."""
    user = make_user(conn)
    capture(conn, user, [event(event_id="<a@x>", account="main")])
    assert outcomes(capture(conn, user, [event(event_id="<a@x>", account="alt")])) == ["duplicate"]
    assert stored(conn, user, "<a@x>")["account"] == "main"   # first capture wins


def test_two_users_each_get_their_own_copy_of_one_message(conn, schema):
    """Why the key is (user_id, event_id) and not event_id alone.

    Two people on one thread receive the same Message-ID. A global key would let
    whichever mailbox captured it first deny the other person their own row —
    silently, and only for the events that matter most (a shared intro).
    """
    a, b = make_user(conn), make_user(conn)
    assert outcomes(capture(conn, a, [event(event_id="<shared@x>")])) == ["inserted"]
    assert outcomes(capture(conn, b, [event(event_id="<shared@x>")])) == ["inserted"]
    assert conn.execute(
        "select count(*) from public.email_events where event_id = %s", ("<shared@x>",)
    ).fetchone()[0] == 2


# ------------------------------------------------------------------ refusals

def test_one_bad_row_does_not_drop_the_batch(conn, schema):
    """The whole reason this function is a loop with a per-row exception block."""
    user = make_user(conn)
    results = capture(conn, user, [
        event(event_id="<good1@x>"),
        event(event_id="<bad-type@x>", event_type="maybe"),
        event(event_id="<good2@x>"),
    ])
    assert outcomes(results) == ["inserted", "rejected", "inserted"]
    assert results[1]["reason"] and "email_events_type_is_known" in results[1]["reason"]
    # The good rows are really there — a rollback of the whole statement would
    # leave this at zero while the outcomes still said "inserted".
    assert conn.execute(
        "select count(*) from public.email_events where user_id = %s", (user,)
    ).fetchone()[0] == 2


@pytest.mark.parametrize("bad,constraint", [
    ({"event_id": "   "}, "email_events_event_id_present"),
    ({"event_type": "maybe"}, "email_events_type_is_known"),
    ({"confidence": 9}, "email_events_confidence_is_a_probability"),
    ({"confidence": -1}, "email_events_confidence_is_a_probability"),
])
def test_every_check_refuses_its_row_and_names_itself(conn, schema, bad, constraint):
    user = make_user(conn)
    results = capture(conn, user, [event(**bad)])
    assert outcomes(results) == ["rejected"]
    assert constraint in results[0]["reason"]


@pytest.mark.parametrize("field", ["received_at", "processed_at"])
def test_an_unparseable_stamp_is_one_rejected_row_not_a_failed_batch(conn, schema, field):
    """A cast error raises a DIFFERENT errcode than a CHECK (22007/22008 vs 23514),
    which is exactly why the handler is `when others` — a narrower catch leaks the
    one it did not name, and a leak here aborts the batch."""
    user = make_user(conn)
    results = capture(conn, user, [event(**{field: "not a stamp"}), event(event_id="<ok@x>")])
    assert outcomes(results) == ["rejected", "inserted"]
    assert "timestamp with time zone" in results[0]["reason"]


def test_the_index_and_event_id_come_back_so_a_row_can_be_named(conn, schema):
    user = make_user(conn)
    results = capture(conn, user, [event(event_id="<a@x>"), event(event_id="<b@x>", confidence=9)])
    assert [(r["index"], r["event_id"]) for r in results] == [(0, "<a@x>"), (1, "<b@x>")]


def test_a_nul_or_an_unpaired_surrogate_takes_the_WHOLE_call_down(conn, schema):
    """The refusal that lives ABOVE the per-row exception block, executed.

    This is the one shape "one bad row never drops the batch" does NOT cover, and
    the test exists to keep that fact visible rather than to assert a fix — there
    is nothing to fix here. `jsonb` refuses these at the CAST, before
    `hq_capture_email_events` has a single statement to run, so no exception
    handler inside it can ever see them:

        U+0000            -> 22P05 unsupported Unicode escape sequence
        unpaired surrogate -> 22P02 invalid input syntax for type json

    Which is why `webapp/lib/capture/schema.ts:storable()` exists and why
    `Code.gs:safeTruncate_` stops manufacturing the second one. Review measured
    the cost of not having them: one poisoned row in a batch of 50 lost all 50,
    every run, until the row aged out of a 40-event retry queue.
    """
    user = make_user(conn)
    poison = [("\u0000", "22P05"), ("\ud83c", "22P02"), ("\udfaf", "22P02")]
    for ch, sqlstate in poison:
        # Sent the way supabase-js sends it: `json.dumps` produces the same
        # \uXXXX escape PostgREST would.
        with pytest.raises(psycopg.Error) as caught:
            capture(conn, user, [event(event_id="<a@x>", snippet=f"hi{ch}")])
        assert caught.value.sqlstate == sqlstate, (ch, caught.value.sqlstate)
    # NOTHING was written by any of them — not the good fields, not a partial row.
    assert conn.execute(
        "select count(*) from public.email_events where user_id = %s", (user,)
    ).fetchone()[0] == 0
    # The positive control: the SAME batch, repaired the way the route repairs it,
    # lands. Without this the test above passes on a store that refuses everything.
    assert outcomes(capture(conn, user, [event(event_id="<a@x>", snippet="hi\ufffd")])) == [
        "inserted",
    ]


def test_the_batch_cap_is_enforced_by_the_store_too(conn, schema):
    """The route caps at 200 in a TypeScript file; this cap holds for every caller
    the function ever grows (matrix row 185's discipline)."""
    user = make_user(conn)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        capture(conn, user, [event() for _ in range(501)])


def test_a_missing_user_or_a_non_array_is_a_refusal_not_a_guess(conn, schema):
    user = make_user(conn)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        capture(conn, None, [event()])
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        conn.execute(
            "select public.hq_capture_email_events(%s, null, %s::jsonb)",
            (user, json.dumps({"events": []})),
        )


def test_an_empty_batch_is_an_empty_answer(conn, schema):
    user = make_user(conn)
    assert capture(conn, user, []) == []


# ------------------------------------------------------------------ the credential

def test_the_digest_postgres_stores_is_the_one_the_route_computes(conn, schema):
    """The shared golden, from the third of its three implementations.

    `hashlib` here, `node:crypto` in `capture-token.test.ts`, and Postgres below.
    Two of them agreeing is a coincidence; three agreeing on a constant none of
    them generated is a contract — and the failure it prevents is a minted token
    that 401s with nothing anywhere saying why.
    """
    assert hashlib.sha256(GOLDEN["secret"].encode()).hexdigest() == GOLDEN["sha256"]
    from_pg = conn.execute(
        "select encode(sha256(convert_to(%s, 'UTF8')), 'hex')", (GOLDEN["secret"],)
    ).fetchone()[0]
    assert from_pg == GOLDEN["sha256"]


def test_minting_returns_the_plaintext_once_and_stores_only_a_digest(conn, schema):
    user = make_user(conn)
    got = mint(conn, user, "main")
    token = got["token"]
    assert token.startswith(f"hqc_{got['selector']}_")

    secret = token.split("_", 2)[2]
    row = conn.execute(
        "select secret_sha256, label, revoked_at, last_used_at from public.capture_tokens"
        " where id = %s", (got["token_id"],),
    ).fetchone()
    assert row[0] == hashlib.sha256(secret.encode()).hexdigest()
    assert row[1] == "main"
    assert row[2] is None and row[3] is None
    # The plaintext exists nowhere in the row. Searched rather than reasoned
    # about: a "convenience" column added later is exactly the regression.
    assert conn.execute(
        "select count(*) from public.capture_tokens where selector = %s or secret_sha256 = %s",
        (secret, secret),
    ).fetchone()[0] == 0


def test_two_mints_never_collide(conn, schema):
    user = make_user(conn)
    tokens = {mint(conn, user, "main")["token"] for _ in range(5)}
    assert len(tokens) == 5


def test_minting_for_a_user_that_does_not_exist_is_refused(conn, schema):
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        mint(conn, str(uuid.uuid4()), "main")


def test_using_a_token_stamps_its_proof_of_life(conn, schema):
    user = make_user(conn)
    tok = mint(conn, user, "main")
    capture(conn, user, [event()], token_id=tok["token_id"])
    assert conn.execute(
        "select last_used_at from public.capture_tokens where id = %s", (tok["token_id"],)
    ).fetchone()[0] is not None


def test_the_stamp_means_used_and_not_stored(conn, schema):
    """A batch whose every row was refused still stamps, deliberately.

    Review measured this against a comment claiming the opposite. The comment was
    wrong and the behaviour is right: the question `last_used_at` exists to answer
    is "can I revoke this credential", and a script POSTing rows the schema
    refuses is emphatically still using it. Stamping only on a successful INSERT
    would make a misconfigured sender look dead and get its token revoked out from
    under it.
    """
    user = make_user(conn)
    tok = mint(conn, user, "main")
    assert outcomes(capture(conn, user, [event(event_type="maybe")],
                            token_id=tok["token_id"])) == ["rejected"]
    assert conn.execute(
        "select last_used_at from public.capture_tokens where id = %s", (tok["token_id"],)
    ).fetchone()[0] is not None


def test_the_function_refuses_a_token_that_is_not_this_users_live_credential(conn, schema):
    """The pairing, enforced where the comments say it is.

    Review demonstrated both halves: user B's token stamped for rows stored under
    user A, and a REVOKED token id storing rows normally — revocation was enforced
    only in the route. Neither is reachable through today's one caller, which
    always passes `live.user_id` and `live.id` together. A function whose comment
    claims an invariant it does not hold is a function the NEXT caller trusts.
    """
    a, b = make_user(conn), make_user(conn)
    a_token = mint(conn, a, "main")
    b_token = mint(conn, b, "main")

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        capture(conn, a, [event()], token_id=b_token["token_id"])

    conn.execute("select public.hq_revoke_capture_tokens(%s, null)", (a,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        capture(conn, a, [event()], token_id=a_token["token_id"])

    # Nothing was written by either refusal — checked first, so the rejected call
    # never starts work it would have to roll back.
    assert conn.execute(
        "select count(*) from public.email_events where user_id = %s", (a,)
    ).fetchone()[0] == 0
    # Positive control: b's own live token still works.
    assert outcomes(capture(conn, b, [event()], token_id=b_token["token_id"])) == ["inserted"]


def test_rotate_revokes_this_label_only(conn, schema):
    """The alt mailbox runs its own copy of the script with its own token, so
    rotating `main` must not be a silent way to stop the scout's lane."""
    user = make_user(conn)
    main = mint(conn, user, "main")
    alt = mint(conn, user, "alt")

    rotated = conn.execute(
        "select public.hq_rotate_capture_token(%s, %s)", (user, "main")
    ).fetchone()[0]
    assert rotated["revoked"] == 1
    assert rotated["token"] != main["token"]

    live = dict(conn.execute(
        "select label, count(*) from public.capture_tokens"
        " where user_id = %s and revoked_at is null group by label", (user,),
    ).fetchall())
    assert live == {"main": 1, "alt": 1}
    assert conn.execute(
        "select revoked_at is not null from public.capture_tokens where id = %s",
        (main["token_id"],),
    ).fetchone()[0]
    # Revocation is a stamp, never a DELETE: "which credential was live when that
    # batch landed" is a question an incident asks.
    assert conn.execute(
        "select count(*) from public.capture_tokens where id = %s", (main["token_id"],)
    ).fetchone()[0] == 1
    assert alt["token_id"] is not None


def test_revoking_with_a_null_label_takes_them_all(conn, schema):
    user = make_user(conn)
    mint(conn, user, "main")
    mint(conn, user, "alt")
    n = conn.execute(
        "select public.hq_revoke_capture_tokens(%s, null)", (user,)
    ).fetchone()[0]
    assert n == 2
    assert conn.execute(
        "select count(*) from public.capture_tokens where user_id = %s and revoked_at is null",
        (user,),
    ).fetchone()[0] == 0
    # Idempotent: a second revoke finds nothing live and says so rather than
    # re-stamping rows whose revoked_at is the record of when it happened.
    assert conn.execute(
        "select public.hq_revoke_capture_tokens(%s, null)", (user,)
    ).fetchone()[0] == 0


def test_minting_and_revoking_leave_an_audit_trail(conn, schema):
    user = make_user(conn)
    mint(conn, user, "main")
    conn.execute("select public.hq_revoke_capture_tokens(%s, null)", (user,))
    kinds = [r[0] for r in conn.execute(
        "select kind from public.events where user_id = %s order by id", (user,)
    ).fetchall()]
    assert kinds == ["capture.token_minted", "capture.tokens_revoked"]


@pytest.mark.parametrize("bad", ["nothex", "0" * 15, "0" * 17, "ABCDEF0123456789"])
def test_a_selector_that_is_not_16_lowercase_hex_cannot_be_stored(conn, schema, bad):
    """The shape the route's regexp expects, enforced by the column.

    Without it a hand-inserted row could hold a selector the route can never
    parse — a token that exists, looks live in every query, and 401s forever.
    """
    user = make_user(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "insert into public.capture_tokens (user_id, selector, secret_sha256)"
            " values (%s, %s, %s)", (user, bad, "0" * 64),
        )


# ------------------------------------------------------------------ RLS

def test_the_owner_reads_their_own_events_and_nobody_elses(conn, schema):
    a, b = make_user(conn), make_user(conn)
    capture(conn, a, [event(event_id="<mine@x>")])
    capture(conn, b, [event(event_id="<theirs@x>")])

    with psycopg.connect(DATABASE_URL, autocommit=True) as browser:
        browser.execute("set role authenticated")
        as_user(browser, a)
        seen = [r[0] for r in browser.execute(
            "select event_id from public.email_events"
        ).fetchall()]
    # The positive control and the negative in one assertion: a session that can
    # read NOTHING passes a bare "cannot see theirs" (matrix row 42).
    assert seen == ["<mine@x>"]


def test_a_browser_session_cannot_write_an_event(conn, schema):
    """There is deliberately no insert policy: the endpoint's service role is the
    only writer. 0001's closing sentence, on a new table."""
    a = make_user(conn)
    with psycopg.connect(DATABASE_URL, autocommit=True) as browser:
        browser.execute("set role authenticated")
        as_user(browser, a)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            browser.execute(
                "insert into public.email_events (user_id, event_id, received_at)"
                " values (%s, %s, now())", (a, "<forged@x>"),
            )


def test_a_browser_session_cannot_edit_or_delete_its_own_events(conn, schema):
    """It RAISES now, and the story of why is worth keeping.

    First version of this test asserted `pytest.raises` and failed: an INSERT with
    no policy raises 42501, but an UPDATE or DELETE with no policy simply matches
    nothing and reports success with a row count of zero. So it was rewritten
    around the row count — the honest assertion for a table whose writes were shut
    by the ABSENCE of a policy.

    Review then pointed out that this is the weaker of the two doors (a future
    `for all` policy walks straight through it), the grants were revoked by name,
    and the assertion goes back to a raise — this time because the privilege is
    gone rather than because a rule happens not to exist.
    """
    a = make_user(conn)
    capture(conn, a, [event(event_id="<mine@x>", subject="original")])
    with psycopg.connect(DATABASE_URL, autocommit=True) as browser:
        browser.execute("set role authenticated")
        as_user(browser, a)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            browser.execute("update public.email_events set subject = 'x'")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            browser.execute("delete from public.email_events")
    assert stored(conn, a, "<mine@x>")["subject"] == "original"


def test_email_events_write_privileges_are_gone_not_merely_unpoliced(conn, schema):
    """A read policy plus absent write POLICIES is not the same as absent write
    PRIVILEGES, and review proved the difference with one plausible future
    migration: adding `for all using (user_id = auth.uid())` to this table let a
    browser session update and delete its own captured mail, while the same policy
    on `capture_tokens` still hit 42501 because that table's grants were revoked.
    """
    for privilege in ("insert", "update", "delete", "truncate"):
        assert conn.execute(
            "select has_table_privilege('authenticated', 'public.email_events', %s)",
            (privilege,),
        ).fetchone()[0] is False, privilege
        assert conn.execute(
            "select has_table_privilege('anon', 'public.email_events', %s)", (privilege,),
        ).fetchone()[0] is False, privilege
    # The positive control: SELECT survives, because RLS is what decides reads.
    assert conn.execute(
        "select has_table_privilege('authenticated', 'public.email_events', 'select')"
    ).fetchone()[0] is True


def test_capture_tokens_are_invisible_to_a_signed_in_browser(conn, schema):
    """No policy at all, plus a named revoke on top.

    RLS with no policies already hides every row; the revoke is the belt, so a
    future migration adding a well-meaning read policy still cannot hand a
    browser a digest. Asserted as "the privilege is gone", which is the stronger
    of the two.
    """
    a = make_user(conn)
    mint(conn, a, "main")
    with psycopg.connect(DATABASE_URL, autocommit=True) as browser:
        browser.execute("set role authenticated")
        as_user(browser, a)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            browser.execute("select secret_sha256 from public.capture_tokens")
        # The positive control: this session CAN read something, so the refusal
        # above is about the table and not about the connection.
        assert browser.execute("select count(*) from public.email_events").fetchone()[0] == 0


@pytest.mark.parametrize("fn,args", [
    ("hq_capture_email_events", "%s, null, '[]'::jsonb"),
    ("hq_mint_capture_token", "%s, 'main'"),
    ("hq_revoke_capture_tokens", "%s, null"),
    ("hq_rotate_capture_token", "%s, 'main'"),
])
def test_the_endpoint_functions_are_unreachable_from_a_browser(conn, schema, fn, args):
    """Every one of them takes the acting user as an ARGUMENT, so a browser that
    could call them could act as anybody. `tests/core/test_migrations.py` pins the
    revokes as text; this proves the privilege for a role it can become."""
    a = make_user(conn)
    with psycopg.connect(DATABASE_URL, autocommit=True) as browser:
        browser.execute("set role authenticated")
        as_user(browser, a)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            browser.execute(f"select public.{fn}({args})", (a,))
