"""Bulk triage, executed against real Postgres.

app_set_triage_bulk (0006) repeats app_set_triage's body per key inside one
transaction, so the two must AGREE — this file and test_write_path.py together
are that agreement. The property that only a real database can prove is
atomicity: a conflict on one row of a batch leaves NONE of the batch applied,
not the rows the loop happened to reach first.
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

from tests.db.test_write_path import gate, make_posting, make_user, schema  # noqa: E402,F401


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def as_user(conn, user_id):
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))


def seed(conn, n=3):
    """A user gated to n fresh postings; returns (user, [keys])."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    keys = []
    for _ in range(n):
        k = make_posting(conn, f"gh-{uuid.uuid4().hex[:8]}")
        gate(conn, user, k)
        keys.append(k)
    as_user(conn, user)
    return user, keys


def bulk(conn, keys, triage, *, idem=None, expected=None, snooze=None, reason=""):
    return conn.execute(
        "select public.app_set_triage_bulk(%s,%s,%s,%s,%s,%s)",
        (keys, triage, snooze, reason, idem or str(uuid.uuid4()), expected),
    ).fetchone()[0]


def triage_of(conn, user, key):
    return conn.execute(
        "select triage from public.user_postings where user_id=%s and posting_key=%s",
        (user, key),
    ).fetchone()[0]


# ---------------------------------------------------------------- happy path

def test_one_gesture_triages_the_whole_selection(conn):
    user, keys = seed(conn, 4)
    result = bulk(conn, keys, "dismissed")
    assert len(result["rows"]) == 4
    for k in keys:
        assert triage_of(conn, user, k) == "dismissed"


def test_interested_creates_one_application_per_row_and_one_event_each(conn):
    user, keys = seed(conn, 3)
    bulk(conn, keys, "interested")
    assert conn.execute(
        "select count(*) from public.applications where user_id=%s and status='Queued'", (user,)
    ).fetchone()[0] == 3
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and kind='action.interested'", (user,)
    ).fetchone()[0] == 3


# ---------------------------------------------------------------- atomicity

def test_a_conflict_on_one_row_rolls_back_the_whole_batch(conn):
    """The property that matters: one stale row leaves NONE applied.

    A second device has advanced the last key, so the expected version the
    batch carries for it is stale. Everything up to it in the loop was already
    written when the exception fires — the transaction must undo all of it.
    """
    user, keys = seed(conn, 4)
    expected = [
        conn.execute(
            "select updated_at::text from public.user_postings where user_id=%s and posting_key=%s",
            (user, k),
        ).fetchone()[0]
        for k in keys
    ]
    # Someone else moves the last key, invalidating its expected version.
    bulk(conn, [keys[-1]], "interested")

    with pytest.raises(psycopg.errors.Error) as exc:
        bulk(conn, keys, "dismissed", expected=expected)
    assert "conflict" in str(exc.value).lower()

    # None of the earlier keys were left dismissed, though the loop reached them.
    for k in keys[:-1]:
        assert triage_of(conn, user, k) == "", f"{k} was left written after a batch conflict"


def test_an_unknown_key_in_the_batch_rolls_it_all_back(conn):
    user, keys = seed(conn, 2)
    with pytest.raises(psycopg.errors.Error) as exc:
        bulk(conn, keys + ["greenhouse-does-not-exist"], "dismissed")
    assert "no such posting" in str(exc.value).lower()
    for k in keys:
        assert triage_of(conn, user, k) == ""


# ---------------------------------------------------------------- idempotency

def test_replaying_a_batch_key_returns_the_first_result_and_writes_once(conn):
    user, keys = seed(conn, 3)
    idem = str(uuid.uuid4())
    first = bulk(conn, keys, "interested", idem=idem)
    again = bulk(conn, keys, "interested", idem=idem)
    assert first == again
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and kind='action.interested'", (user,)
    ).fetchone()[0] == 3  # not 6
    assert conn.execute(
        "select count(*) from public.applications where user_id=%s", (user,)
    ).fetchone()[0] == 3


# ---------------------------------------------------------------- validation

def test_an_empty_selection_is_refused(conn):
    seed(conn, 1)
    with pytest.raises(psycopg.errors.Error) as exc:
        bulk(conn, [], "dismissed")
    assert "no postings selected" in str(exc.value).lower()


@pytest.mark.parametrize("bad", ["maybe", "INTERESTED", "'; drop table users;--"])
def test_an_invalid_triage_value_is_refused(conn, bad):
    _, keys = seed(conn, 1)
    with pytest.raises(psycopg.errors.Error) as exc:
        bulk(conn, keys, bad)
    assert "invalid triage" in str(exc.value).lower()


def test_a_user_cannot_bulk_triage_another_users_postings(conn):
    owner, keys = seed(conn, 2)
    attacker = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, attacker)
    with pytest.raises(psycopg.errors.Error) as exc:
        bulk(conn, keys, "dismissed")
    assert "no such posting" in str(exc.value).lower()
    as_user(conn, owner)
    for k in keys:
        assert triage_of(conn, owner, k) == ""
