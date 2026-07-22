"""Saved views, executed against real Postgres.

app_save_view / app_delete_view mirror app_set_triage's write discipline
(0005_saved_views.sql), and the reasons they need behavioural tests are the same
ones app_set_triage did: the properties that look right when you read them and
are wrong when you run them — idempotent replay, optimistic concurrency, and the
one-default-per-surface invariant that a partial unique index turns into a loud
error only if the function clears the old default first.

Run locally with a throwaway Postgres — see tests/db/test_write_path.py's
docstring. Without DATABASE_URL every test skips.
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

from tests.db.test_write_path import make_user, schema  # noqa: E402,F401


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def as_user(conn, user_id: str):
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))


def save(conn, *, vid=None, name="View", surface="jobs", state="{}",
         is_default=False, idem=None, expected=None):
    return conn.execute(
        "select public.app_save_view(%s,%s,%s,%s::jsonb,%s,%s,%s)",
        (vid, name, surface, state, is_default, idem or str(uuid.uuid4()), expected),
    ).fetchone()[0]


def rows(conn, user_id):
    return conn.execute(
        "select id, name, is_default, updated_at from public.saved_views "
        "where user_id=%s order by name",
        (user_id,),
    ).fetchall()


# ---------------------------------------------------------------- create

def test_creating_a_view_stores_it_and_writes_an_event(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    view = save(conn, name="Payments", state='{"q":"pay"}')

    assert view["name"] == "Payments"
    assert view["state"] == {"q": "pay"}
    assert view["is_default"] is False
    assert view["id"]

    events = conn.execute(
        "select kind, actor from public.events where user_id=%s and kind='view.saved'",
        (user,),
    ).fetchall()
    assert events == [("view.saved", "user")]


def test_a_nameless_view_is_refused(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    with pytest.raises(psycopg.errors.Error) as exc:
        save(conn, name="   ")
    assert "needs a name" in str(exc.value).lower()


def test_a_duplicate_name_is_refused_case_insensitively(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    save(conn, name="Payments")
    with pytest.raises(psycopg.errors.UniqueViolation):
        save(conn, name="payments")  # same view to a human


# ---------------------------------------------------------------- default

def test_setting_a_new_default_clears_the_old_one(conn):
    """At most one landing view. The partial unique index is a backstop; the
    function has to clear the old default itself, and if it forgets, the second
    save raises instead of quietly producing two landing pages."""
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    save(conn, name="First", is_default=True)
    save(conn, name="Second", is_default=True)

    defaults = [r for r in rows(conn, user) if r[2]]  # is_default column
    assert len(defaults) == 1
    assert defaults[0][1] == "Second"


def test_two_users_may_each_have_a_default(conn):
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, a)
    save(conn, name="A", is_default=True)
    as_user(conn, b)
    save(conn, name="B", is_default=True)
    assert len([r for r in rows(conn, a) if r[2]]) == 1
    assert len([r for r in rows(conn, b) if r[2]]) == 1


# ---------------------------------------------------------------- update

def test_updating_in_place_keeps_the_id_and_bumps_the_version(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    v1 = save(conn, name="V", state='{"q":"a"}')
    v2 = save(conn, vid=v1["id"], name="V", state='{"q":"b"}', expected=v1["updated_at"])
    assert v2["id"] == v1["id"]
    assert v2["state"] == {"q": "b"}
    assert v2["updated_at"] != v1["updated_at"]
    assert len(rows(conn, user)) == 1


def test_a_stale_expected_updated_at_conflicts(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    v1 = save(conn, name="V")
    save(conn, vid=v1["id"], name="V", state='{"q":"x"}', expected=v1["updated_at"])
    # A second device still holding the original version.
    with pytest.raises(psycopg.errors.Error) as exc:
        save(conn, vid=v1["id"], name="V", state='{"q":"y"}', expected=v1["updated_at"])
    assert "conflict" in str(exc.value).lower()


# ---------------------------------------------------------------- idempotency

def test_replaying_a_save_key_returns_the_first_result_and_writes_once(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    idem = str(uuid.uuid4())
    first = save(conn, name="Once", idem=idem)
    again = save(conn, name="Once", idem=idem)
    assert first == again
    assert len(rows(conn, user)) == 1
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and kind='view.saved'", (user,)
    ).fetchone()[0] == 1


# ---------------------------------------------------------------- delete

def test_delete_removes_the_view_and_records_it(conn):
    user = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, user)
    v = save(conn, name="Doomed")
    res = conn.execute(
        "select public.app_delete_view(%s,%s)", (v["id"], str(uuid.uuid4()))
    ).fetchone()[0]
    assert res == {"deleted": v["id"]}
    assert rows(conn, user) == []
    assert conn.execute(
        "select count(*) from public.events where user_id=%s and kind='view.deleted'", (user,)
    ).fetchone()[0] == 1


def test_deleting_another_users_view_is_refused(conn):
    owner = make_user(conn, f"{uuid.uuid4()}@example.com")
    attacker = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, owner)
    v = save(conn, name="Mine")
    as_user(conn, attacker)
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("select public.app_delete_view(%s,%s)", (v["id"], str(uuid.uuid4())))
    assert "no such view" in str(exc.value).lower()
    # And it is still there for its owner.
    as_user(conn, owner)
    assert len(rows(conn, owner)) == 1


def test_an_unauthenticated_caller_cannot_save(conn):
    conn.execute("select set_config('hq.test_user', '', false)")
    with pytest.raises(psycopg.errors.Error) as exc:
        save(conn, name="Nope")
    assert "not authenticated" in str(exc.value).lower()
