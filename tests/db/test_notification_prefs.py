"""Notification preferences on `profiles`, executed against Postgres.

`tests/core/test_migrations.py` reads the SQL as text; it catches a function
nobody defined and cannot catch a logic error. Everything here RUNS.

What it proves that reading the migration cannot:

    the point   the thirteenth Config key that had nowhere to live now has a
                home, and the two load-bearing ones — the quiet window and the
                zone — round-trip in the exact spelling `core.channels` parses
    the door    a UTC offset is not a timezone and is refused by NAME; a
                one-ended window, a zero-length window and an out-of-range
                threshold are refused the same way, and refused again by the
                CHECK if the function is ever bypassed
    the fork    a notification write does not move `updated_at` (the Search
                Profile's token) and does not move `display_updated_at` — and
                0025's own property survives this file rewriting its trigger
    autosave    a write that changes nothing writes nothing; a stale token is a
                conflict, not a clobber; a double-submit is one event; a key
                reused for a DIFFERENT gesture is refused (the post-0026
                `hq_command_replay` + `request_hash` shape), never answered
                with the first gesture's result
    the gate    a second tenant, an anonymous session, and a pending, suspended
                or removed account are each refused — with the entitled owner
                doing the same thing successfully in the same test, because a
                gate that denied everybody would pass every refusal

WHY THE ERROR ASSERTIONS READ `diag.message_primary` AND NEVER `str(exc)`.
psycopg puts the whole CONTEXT block in `str(exc)`, and that block echoes the
RPC's own SQL — which contains every column name and most of the literals this
file checks for. A wrong-reason failure matches anyway and reads as green.

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_notification_prefs.py -q
"""
from __future__ import annotations

import json
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

from tests.db.test_profile import CRITERIA  # noqa: E402
from tests.db.test_write_path import (  # noqa: E402  (fixtures are shared on purpose)
    as_user,
    make_user,
    schema,  # noqa: F401 — session fixture
)

#: The columns this migration adds, in the order the store declares them. Used by
#: the per-column privilege sweep, which cannot use `has_table_privilege`:
#: `has_table_privilege(…, 'select')` is TRUE when ANY ONE column is readable, so
#: a column-level grant on a single new column reads clean and leaks.
NEW_COLUMNS = (
    "notify_digest",
    "notify_new_roles",
    "notify_status_change",
    "notify_oa_interview",
    "notify_stale_nudge",
    "notify_quiet_start",
    "notify_quiet_end",
    "notify_timezone",
    "push_new_jobs",
    "yoe_push_max",
    "stale_days",
    "notify_updated_at",
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def user(conn):
    # A fresh address per test: the signup trigger enforces uniqueness, so a
    # shared default would make every test after the first fail on a
    # UniqueViolation that says nothing about notification preferences.
    u = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, u)
    return u


#: `idem=AUTO` means "mint one"; `idem=""` has to reach the function verbatim, or
#: the blank-key probe tests this helper's `or` instead of the guard.
AUTO = object()


def prefs(
    conn,
    *,
    digest=None,
    new_roles=None,
    status_change=None,
    oa_interview=None,
    stale_nudge=None,
    quiet_start=None,
    quiet_end=None,
    quiet_off=False,
    timezone=None,
    push_new_jobs=None,
    yoe_push_max=None,
    stale_days=None,
    idem=AUTO,
    expected=None,
):
    return conn.execute(
        "select public.app_set_notification_prefs("
        "  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            digest,
            new_roles,
            status_change,
            oa_interview,
            stale_nudge,
            quiet_start,
            quiet_end,
            quiet_off,
            timezone,
            push_new_jobs,
            yoe_push_max,
            stale_days,
            uuid.uuid4().hex if idem is AUTO else idem,
            expected,
        ),
    ).fetchone()[0]


def commit_profile(conn, criteria=None, *, expected=None):
    return conn.execute(
        "select public.app_commit_profile(%s::jsonb, null, '[]'::jsonb, %s, %s)",
        (
            json.dumps(criteria if criteria is not None else CRITERIA),
            uuid.uuid4().hex,
            expected,
        ),
    ).fetchone()[0]


def display(conn, *, density=None, theme=None):
    return conn.execute(
        "select public.app_set_display_prefs(%s, null, null, null, %s, %s, null)",
        (density, theme, uuid.uuid4().hex),
    ).fetchone()[0]


def row(conn, user_id):
    return conn.execute(
        """select notify_digest, notify_new_roles, notify_status_change,
                  notify_oa_interview, notify_stale_nudge, notify_quiet_start,
                  notify_quiet_end, notify_timezone, push_new_jobs,
                  yoe_push_max, stale_days, notify_updated_at,
                  updated_at, display_updated_at
             from public.profiles where user_id = %s""",
        (user_id,),
    ).fetchone()


def events(conn, user_id, kind="profile.notification_changed"):
    return [
        r[0]
        for r in conn.execute(
            "select payload from public.events where user_id = %s and kind = %s "
            "order by id",
            (user_id, kind),
        ).fetchall()
    ]


def as_authenticated(conn, user_id):
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


def as_anon(conn):
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")
    conn.execute("set role anon")


def as_operator(conn):
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', '', false)")


# ------------------------------------------------------------- the defaults

def test_the_defaults_are_the_committed_defaults_the_engine_runs_today(conn, user):
    """Every default is `core/config_defaults.yaml` as of this migration, and the
    reason is that a default which changes behaviour is not a default.

    The tempting alternative — default the five channels to `''` (inherit the
    `notify_channel` ceiling) — looks tidier and is a behaviour change: with the
    shipped `ntfy` ceiling, inherit resolves to `push` for all five, which starts
    pushing stale nudges (committed `none`) and stops mailing the digest
    (committed `both`).

    MUTATION REASON: change any default in the migration and this goes red by
    NAME, rather than as an engine that quietly notifies differently.
    """
    out = prefs(conn, digest="both")  # materialises the row
    assert out["notify"] == {
        "notify_digest": "both",
        "notify_new_roles": "push",
        "notify_status_change": "push",
        "notify_oa_interview": "push",
        "notify_stale_nudge": "none",
        "notify_quiet_hours": "21:00-06:30",
        "notify_timezone": "America/Chicago",
        "push_new_jobs": True,
        "yoe_push_max": 3,
        "stale_days": 30,
        "notify_updated_at": out["notify"]["notify_updated_at"],
    }


def test_a_preference_can_be_set_before_the_wizard_has_ever_run(conn, user):
    """Quiet hours is a thing somebody sets on day one, before they have
    finished onboarding. The function materialises the profile row with the
    never-onboarded `'{}'` criteria sentinel, so setting a preference must not
    look like finishing the wizard."""
    out = prefs(conn, timezone="Europe/Berlin")
    assert out["notify"]["notify_timezone"] == "Europe/Berlin", (
        "the preference itself did not land — the sentinel check below would "
        "pass vacuously on a write that did nothing"
    )
    criteria = conn.execute(
        "select criteria from public.profiles where user_id = %s", (user,)
    ).fetchone()[0]
    assert criteria == {}, "a notification write onboarded the user"


# ------------------------------------------------- the quiet window and zone

def test_the_quiet_window_round_trips_in_the_spelling_core_channels_parses(conn, user):
    """`core/channels.py:quiet_window` splits on `-` and `_hhmm` splits on `:`.
    The columns are two `time` values because that is what refuses `25:00`; the
    WIRE has to be the string the engine already knows, with no seconds field —
    `time`'s default text output is `21:00:00`, and a third component would
    reach `int("00")` as a surprise.

    MUTATION REASON: drop the `to_char(..., 'HH24:MI')` for a plain cast and the
    expected string gains `:00` twice.
    """
    out = prefs(conn, quiet_start="22:15", quiet_end="07:45")
    assert out["notify"]["notify_quiet_hours"] == "22:15-07:45"
    assert row(conn, user)[5].isoformat() == "22:15:00"


def test_a_window_that_crosses_midnight_is_stored_as_given(conn, user):
    """The shipped default IS a wrapping window. `wake_time()` computes
    `wraps = start > end` and resolves the wake instant on the user's local
    calendar day; a CHECK requiring start < end would refuse the product's own
    default, which is why there is no such constraint.
    """
    out = prefs(conn, quiet_start="23:30", quiet_end="00:30")
    assert out["notify"]["notify_quiet_hours"] == "23:30-00:30"


def test_quiet_hours_off_is_one_representation_and_reads_as_off(conn, user):
    """`core/channels.py:_QUIET_OFF` spells off four ways (`''`, `off`, `none`,
    `-`) because it is parsing a hand-edited cell. A store has one: both ends
    NULL. The wire value is `''`, which is in `_QUIET_OFF`, so the engine reads
    the round trip as off rather than as a window it cannot parse."""
    on = prefs(conn, quiet_start="22:00", quiet_end="06:00")
    assert on["notify"]["notify_quiet_hours"] == "22:00-06:00", (
        "the window never engaged — turning it off below would prove nothing"
    )
    out = prefs(conn, quiet_off=True)
    assert out["notify"]["notify_quiet_hours"] == ""
    assert row(conn, user)[5] is None and row(conn, user)[6] is None


def test_turning_quiet_hours_off_needs_its_own_parameter_because_null_means_leave_it(
    conn, user
):
    """The reason `p_quiet_off` exists at all. Every value parameter is nullable
    and NULL means "leave it", so `notify_quiet_start = null` cannot express
    "off" — and off is the one preference a person woken at 03:00 by a bug is
    most likely to reach for."""
    prefs(conn, quiet_start="22:00", quiet_end="06:00")
    out = prefs(conn, timezone="UTC")  # a write that passes no window at all
    assert out["notify"]["notify_timezone"] == "UTC", (
        "the unrelated write itself did not land"
    )
    got = row(conn, user)
    assert got[5] is not None and got[5].isoformat() == "22:00:00", (
        "an unrelated write cleared or moved the window"
    )


def test_a_utc_offset_is_not_a_timezone(conn, user):
    """The single sharpest reason these are columns rather than jsonb.

    `core/channels.py:_zone` accepts anything, falls back to America/Chicago and
    prints to a stderr nobody reads — correct for a bot that must not die of a
    preference, and it means a bad value is stored forever while the settings
    page shows a zone the engine is not using. `wake_time`'s header says why an
    offset is wrong in the first place: "06:30 wall clock tomorrow" is 8h30m away
    the night the clocks go back.

    MUTATION REASON: delete the `pg_timezone_names` probe and every one of these
    is stored happily.
    """
    for bad in ("UTC-5", "-05:00", "CST6CDT_", "Mars/Olympus", ""):
        with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
            prefs(conn, timezone=bad)
        assert "unknown timezone" in exc.value.diag.message_primary, (
            "refused for the wrong reason: "
            f"{exc.value.diag.message_primary!r}"
        )


def test_a_real_iana_zone_is_accepted(conn, user):
    """The positive control. Without it, a function that refused every string
    would pass the case above — and the failure would be a user who cannot set
    their timezone at all."""
    out = prefs(conn, timezone="Asia/Kolkata")
    assert out["notify"]["notify_timezone"] == "Asia/Kolkata"


# --------------------------------------------------- the version-token fork

def test_a_notification_write_does_not_move_the_search_profiles_version_token(conn, user):
    """0025's bug, one lane over. `updated_at` is the Search Profile form's
    optimistic-concurrency token and preferences AUTOSAVE, so without this
    file's `profiles_touch` clause "open /settings → change quiet hours → press
    Save changes" raises a phantom conflict over a gesture that touched nothing
    the form edits.

    MUTATION REASON: remove the notify half of the `when (…)` clause and this
    goes red; the two controls below keep that from being achievable by deleting
    the trigger outright.
    """
    commit_profile(conn)
    before = row(conn, user)[12]

    prefs(conn, stale_days=45)

    after = row(conn, user)
    assert after[10] == 45, "the preference did not land"
    assert after[12] == before, "a notification write moved the profile's version token"
    # Which means the form's token is still good — the failure stated as the
    # gesture a person makes rather than as a column value.
    commit_profile(conn, {**CRITERIA, "yoe_max": 9}, expected=before)


def test_a_criteria_write_still_moves_it(conn, user):
    """The control. A trigger DELETED rather than made conditional passes the
    test above and breaks every conflict check in `app_commit_profile`."""
    commit_profile(conn)
    before = row(conn, user)[12]
    commit_profile(conn, {**CRITERIA, "yoe_max": 9})
    assert row(conn, user)[12] > before, "a criteria write stopped touching updated_at"


def test_a_criteria_write_that_changes_nothing_still_moves_it(conn, user):
    """The clause is written as "the preference tuples did NOT change", never as
    "some other column DID", and this is the difference. The second spelling
    stops bumping `updated_at` for a save that rewrites `criteria` to the same
    value — which `settings/page.tsx` renders as `data-profile-version` and the
    e2e suite waits on CHANGING. A person who presses Save without editing
    anything would hang that wait forever."""
    commit_profile(conn)
    before = row(conn, user)[12]
    commit_profile(conn)  # byte-identical criteria
    assert row(conn, user)[12] > before


def test_0025s_property_survives_this_files_rewrite_of_the_trigger(conn, user):
    """This migration REPLACES `profiles_touch` rather than adding a second
    trigger, so it can break the display lane by omission — and the display
    suite would still pass, because it does not know this file exists.

    MUTATION REASON: drop the display half of the new `when (…)` clause and this
    goes red while every test in `test_display_prefs.py` stays green.
    """
    commit_profile(conn)
    before = row(conn, user)[12]
    display(conn, theme="dark")
    assert row(conn, user)[12] == before, "a display write moved the profile's token"


def test_the_three_lanes_have_independent_tokens(conn, user):
    """Search Profile, display, notifications: three autosaving surfaces on one
    row, and none of them may invalidate another's token. Nothing about the
    trigger enforces the third pairing, so it gets its own case."""
    prefs(conn, push_new_jobs=False)
    notify_token = row(conn, user)[11]

    commit_profile(conn, {**CRITERIA, "yoe_max": 3})
    display(conn, density="comfortable")

    out = prefs(conn, yoe_push_max=7, expected=notify_token)
    assert out["notify"]["yoe_push_max"] == 7


def test_a_display_write_does_not_move_the_notification_token(conn, user):
    """The same fork, the other direction."""
    prefs(conn, stale_days=44)
    token = row(conn, user)[11]
    display(conn, theme="light")
    assert row(conn, user)[11] == token


# ------------------------------------------------------------ autosave shape

def test_a_write_that_changes_nothing_writes_nothing(conn, user):
    """Autosave fires on gestures that are frequently no-ops. The token holding
    still across them is what stops a tab invalidating its own token.

    MUTATION REASON: delete the `is distinct from` guard on the UPDATE and both
    assertions go red — the token moves and a second event appears.
    """
    prefs(conn, timezone="Europe/Berlin")
    token = row(conn, user)[11]
    assert len(events(conn, user)) == 1

    out = prefs(conn, timezone="Europe/Berlin")

    assert out["changed"] is False
    assert row(conn, user)[11] == token, "a no-op autosave bumped the version token"
    assert len(events(conn, user)) == 1, "a no-op autosave appended an event"


def test_a_real_change_reports_itself_and_appends_exactly_one_event(conn, user):
    """The positive control for the case above: a function that refused every
    write would pass it."""
    prefs(conn, timezone="Europe/Berlin")
    out = prefs(conn, stale_nudge="email")
    assert out["changed"] is True
    payloads = events(conn, user)
    assert len(payloads) == 2
    assert payloads[1]["before"]["notify_stale_nudge"] == "none"
    assert payloads[1]["after"]["notify_stale_nudge"] == "email"


def test_the_audit_payload_carries_settings_and_no_notification_content(conn, user):
    """`events` is readable by the owner's own browser session. A topic, an
    address or a rendered notification body in an audit row is private content
    (or a credential) sitting somewhere it was never scoped for."""
    prefs(conn, quiet_start="22:00", quiet_end="06:00")
    payload = events(conn, user)[0]
    assert set(payload) == {"before", "after"}
    assert set(payload["after"]) == {
        "notify_digest", "notify_new_roles", "notify_status_change",
        "notify_oa_interview", "notify_stale_nudge", "notify_quiet_hours",
        "notify_timezone", "push_new_jobs", "yoe_push_max", "stale_days",
        "notify_updated_at",
    }


def test_a_null_parameter_leaves_that_column_alone(conn, user):
    """The reason every value parameter is nullable. A call that restated all
    ten would replay whatever the tab last READ into the other nine, so changing
    the timezone on a phone would quietly revert a quiet-hours edit the laptop
    made thirty seconds earlier.

    MUTATION REASON: drop a `coalesce(...)` in the UPDATE and the untouched
    column comes back NULL, which the NOT NULL refuses, loudly.
    """
    prefs(conn, digest="email", yoe_push_max=6, quiet_start="23:00", quiet_end="05:00")
    prefs(conn, stale_days=99)
    got = row(conn, user)
    assert got[0] == "email"
    assert got[9] == 6
    assert got[10] == 99
    assert got[5].isoformat() == "23:00:00"


def test_a_stale_version_token_is_a_conflict_not_a_clobber(conn, user):
    """And the word "conflict" is load-bearing — the client matches on it."""
    prefs(conn, stale_days=40)
    stale = row(conn, user)[11]
    prefs(conn, stale_days=41)
    with pytest.raises(psycopg.errors.SerializationFailure) as exc:
        prefs(conn, stale_days=42, expected=stale)
    assert "conflict" in exc.value.diag.message_primary, (
        f"the client's match word is gone: {exc.value.diag.message_primary!r}"
    )
    assert row(conn, user)[10] == 41, "the losing write landed anyway"


def test_a_double_submitted_write_is_one_event_not_two(conn, user):
    """Durable result lookup: a true replay — same key, same arguments — returns
    the first result rather than applying twice. The donor branch's version of
    this test replayed the key with DIFFERENT arguments and expected the first
    result back; that is the pre-0026 shape, and the current contract refuses it
    instead (the case below)."""
    key = uuid.uuid4().hex
    first = prefs(conn, stale_days=50, idem=key)
    second = prefs(conn, stale_days=50, idem=key)
    assert first == second
    assert second["changed"] is True, (
        "the replay re-ran the command (a fresh no-op) instead of returning the "
        "stored result"
    )
    assert row(conn, user)[10] == 50
    assert len(events(conn, user)) == 1


def test_one_key_reused_for_a_different_gesture_is_refused(conn, user):
    """`hq_command_replay` + `request_hash` (0026, the `app_add_job` shape): a
    key that arrives with different arguments is a client bug — two gestures
    sharing one key — and answering it with the FIRST gesture's stored result
    would silently drop the second gesture on the floor while reporting success.

    MUTATION REASON: swap the replay call back to a bare `command_idempotency`
    lookup (the donor's pre-0026 shape) and this goes red: the second call
    returns the first result instead of raising.
    """
    key = uuid.uuid4().hex
    prefs(conn, stale_days=50, idem=key)
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        prefs(conn, stale_days=77, idem=key)
    assert "different arguments" in exc.value.diag.message_primary, (
        f"refused for the wrong reason: {exc.value.diag.message_primary!r}"
    )
    assert row(conn, user)[10] == 50, "the refused write landed anyway"
    assert len(events(conn, user)) == 1


def test_a_blank_idempotency_key_is_refused(conn, user):
    """0012's tighter door: `hq_blank_trim` rather than `length(p_idem) = 0`, so
    a key of one NEWLINE is blank here the way it is blank to a person. One
    caller sending a blank key would have every LATER blank key replay the first
    gesture's result forever."""
    for bad in ("", " ", "\n"):
        with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
            prefs(conn, stale_days=30, idem=bad)
        assert "idempotency" in exc.value.diag.message_primary


# ------------------------------------------------------------------- the door

@pytest.mark.parametrize(
    "kwargs, phrase",
    [
        ({"digest": "shout"}, "unknown notification channel"),
        ({"stale_nudge": "PUSH"}, "unknown notification channel"),
        ({"quiet_start": "22:00"}, "both a start and an end"),
        ({"quiet_end": "06:00"}, "both a start and an end"),
        ({"quiet_start": "22:00", "quiet_end": "22:00"}, "zero length"),
        ({"quiet_off": True, "quiet_start": "22:00", "quiet_end": "06:00"},
         "both off and set"),
        ({"yoe_push_max": 31}, "yoe_push_max out of range"),
        ({"yoe_push_max": -1}, "yoe_push_max out of range"),
        ({"stale_days": 2}, "stale_days out of range"),
        ({"stale_days": 366}, "stale_days out of range"),
    ],
    ids=lambda v: str(v)[:40],
)
def test_a_refused_value_is_refused_for_the_stated_reason(conn, user, kwargs, phrase):
    """22023 with the knob and the value named, so a person is told WHICH
    setting was refused. A CHECK violation would also refuse most of these —
    that is the door that stays shut if a later writer forgets this one — but it
    arrives as 23514 with a constraint name in it, which the client classifies
    as a generic "Couldn't save that".

    The assertion is on `diag.message_primary`, never `str(exc)`: psycopg's
    CONTEXT block echoes the function's SQL, which contains every one of these
    phrases, so a wrong-reason refusal would match.
    """
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        prefs(conn, **kwargs)
    assert phrase in exc.value.diag.message_primary, (
        f"refused for the wrong reason: {exc.value.diag.message_primary!r}"
    )


@pytest.mark.parametrize(
    "sql, error",
    [
        ("notify_digest = 'shout'", psycopg.errors.CheckViolation),
        ("notify_quiet_start = '22:00'::time, notify_quiet_end = null",
         psycopg.errors.CheckViolation),
        ("notify_quiet_start = '22:00'::time, notify_quiet_end = '22:00'::time",
         psycopg.errors.CheckViolation),
        ("notify_timezone = ''", psycopg.errors.CheckViolation),
        ("yoe_push_max = 31", psycopg.errors.CheckViolation),
        ("stale_days = 2", psycopg.errors.CheckViolation),
        ("notify_timezone = null", psycopg.errors.NotNullViolation),
    ],
    ids=lambda v: str(v)[:40],
)
def test_the_check_constraints_refuse_it_too(conn, user, sql, error):
    """The function is not the only door, and this is the one that holds if a
    later migration adds a second writer that forgets to validate. Driven as the
    OWNER (`reset role`), because the point is that even a writer with every
    privilege cannot store these values."""
    prefs(conn, stale_days=30)
    as_operator(conn)
    with pytest.raises(error):
        conn.execute(
            f"update public.profiles set {sql} where user_id = %s", (user,)
        )


def test_the_off_state_itself_is_storable(conn, user):
    """The positive control for the two window constraints above. Written as a
    disjunction rather than `is distinct from` precisely so that both-null — the
    off state — is legal; the tidier spelling refuses it, and quiet hours would
    become impossible to turn off through any door at all."""
    prefs(conn, stale_days=30)
    as_operator(conn)
    cur = conn.execute(
        "update public.profiles set notify_quiet_start = null, "
        "notify_quiet_end = null where user_id = %s",
        (user,),
    )
    assert cur.rowcount == 1, (
        "the off state reached no row — a constraint refused it, or the row "
        "was never materialised, and either way off is unstorable"
    )


# ------------------------------------------------------------ tenancy and gate

def test_a_second_tenant_cannot_read_or_write_these_columns(conn):
    """Privacy, with the positive control in the same breath — `test_rls.py`'s
    rule, because "B reads nothing" is equally true of a policy that lets nobody
    read anything."""
    a = make_user(conn, f"a-{uuid.uuid4()}@example.com")
    b = make_user(conn, f"b-{uuid.uuid4()}@example.com")

    as_user(conn, a)
    prefs(conn, timezone="Asia/Tokyo")

    as_authenticated(conn, a)
    assert conn.execute(
        "select notify_timezone from public.profiles"
    ).fetchall() == [("Asia/Tokyo",)], "the owner cannot read their own preference"

    as_authenticated(conn, b)
    assert conn.execute(
        "select notify_timezone from public.profiles where user_id = %s", (a,)
    ).fetchall() == [], "a second tenant read another account's timezone"

    # And the write is a NO-OP, not an error, which is what "no write policy"
    # actually looks like from a browser: Supabase grants `authenticated` UPDATE
    # on every table in `public` so that RLS can be the decider, so the statement
    # is accepted and matches zero rows. Asserting on an exception here would
    # have been asserting on a privilege the platform does not withhold — and
    # `hq_entitlement_guard` is a BEFORE ROW trigger, so it never fires either.
    # The proof is the row.
    cur = conn.execute(
        "update public.profiles set notify_timezone = 'UTC' where user_id = %s", (a,)
    )
    assert cur.rowcount == 0, "a second tenant's UPDATE matched a row"
    as_operator(conn)
    assert conn.execute(
        "select notify_timezone from public.profiles where user_id = %s", (a,)
    ).fetchone() == ("Asia/Tokyo",), "a second tenant overwrote a preference"


def test_a_browser_session_has_no_direct_write_to_its_own_columns(conn, user):
    """0001's rule — "browsers write through functions or not at all". The
    columns inherit it because `profiles` has exactly ONE policy and it is a
    SELECT policy: with no permissive policy for UPDATE, even the owner's own
    row is invisible to a direct write. The RPC is this lane's only door."""
    prefs(conn, stale_days=30)
    as_authenticated(conn, user)
    cur = conn.execute(
        "update public.profiles set stale_days = 300 where user_id = %s", (user,)
    )
    assert cur.rowcount == 0, "a browser session wrote profiles directly"
    as_operator(conn)
    assert conn.execute(
        "select stale_days from public.profiles where user_id = %s", (user,)
    ).fetchone() == (30,)


@pytest.mark.parametrize("column", NEW_COLUMNS)
def test_anon_cannot_read_any_new_column(conn, column):
    """PER COLUMN, and that is the whole point of the case.

    `has_table_privilege(role, table, 'select')` is TRUE when the role can read
    ANY ONE column, so a column-level grant on exactly one of these twelve reads
    clean at table granularity and leaks. `has_column_privilege` is the question
    that matches the risk.

    SELECT only, deliberately. `anon` does hold INSERT/UPDATE on every table in
    `public` — Supabase grants them so that RLS is the decider, and
    `20260802_205716_anon_select_revoke.sql` took back the read and not the
    writes. Asserting otherwise would be asserting the platform's model away; the
    write side is proven by the row instead, in the case below.

    `authenticated` is the positive control: it keeps column-level SELECT (RLS
    and `profiles_self_read` decide WHICH rows), so a revoke sweep broad enough
    to strip everybody would go red here rather than reading as extra safety.
    """
    assert conn.execute(
        "select has_column_privilege('authenticated', 'public.profiles', %s, 'select')",
        (column,),
    ).fetchone()[0], (
        f"authenticated lost select on profiles.{column} — the self-read policy "
        "has no privilege left to decide over"
    )
    assert not conn.execute(
        "select has_column_privilege('anon', 'public.profiles', %s, 'select')",
        (column,),
    ).fetchone()[0], f"anon holds select on profiles.{column}"


def test_an_anonymous_session_writes_nothing(conn, user):
    """The write half of the case above, proven at the row rather than at the
    grant. An anonymous UPDATE is accepted by the privilege system, sees no row
    through RLS, and changes nothing."""
    prefs(conn, stale_days=30)
    as_anon(conn)
    cur = conn.execute("update public.profiles set stale_days = 300")
    assert cur.rowcount == 0, "an anonymous session wrote a preference"
    as_operator(conn)
    assert conn.execute(
        "select stale_days from public.profiles where user_id = %s", (user,)
    ).fetchone() == (30,)


def test_an_anonymous_session_cannot_call_the_rpc(conn):
    """`authenticated` is the only grant. The revoke names `public`, `anon` and
    `authenticated`, because `revoke … from public` alone leaves a role Supabase
    granted to BY NAME still holding the door."""
    as_anon(conn)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "select public.app_set_notification_prefs("
            "  'push', null, null, null, null, null, null, false, null, null,"
            "  null, null, 'k', null)"
        )


def test_the_entitlement_guard_trigger_is_present_and_enabled(conn):
    """`exists(pg_trigger)` is TRUE for a DISABLED trigger, which is the
    adjacent question that has produced a clean-looking wrong answer in this
    repo before. `tgenabled = 'O'` is the origin-enabled state; 'D' is disabled
    and would sail past an existence check.

    The trigger is 0027's, inherited because `profiles` is a pre-0027 table —
    which is the substantive advantage of putting these columns there rather
    than in a new table, and therefore worth asserting rather than assuming.
    """
    got = conn.execute(
        """select tgenabled from pg_trigger
            where tgrelid = 'public.profiles'::regclass
              and tgname = 'profiles_entitlement_guard'"""
    ).fetchone()
    assert got is not None, "profiles lost its entitlement guard"
    assert got[0] == "O", f"the guard exists but is not enabled: tgenabled={got[0]!r}"

    policy = conn.execute(
        """select permissive from pg_policies
            where schemaname = 'public' and tablename = 'profiles'
              and policyname = 'profiles_entitled'"""
    ).fetchone()
    assert policy is not None, "profiles lost its restrictive entitlement policy"
    assert policy[0] == "RESTRICTIVE", (
        "profiles_entitled is PERMISSIVE — ORed with the owner-read policy instead "
        "of ANDed with it, which grants rather than gates"
    )


def test_the_gate_refuses_a_pending_a_suspended_and_a_removed_account(conn):
    """The three not-active states, each driven over the real RPC, with the
    entitled owner doing the same thing successfully FIRST — a gate that refused
    everybody would otherwise pass every refusal in this test.

    The refusal comes from `hq_entitlement_guard`, not from RLS: the RPC is
    security definer and so bypasses the policy entirely. That is exactly the
    hole 0027's trigger exists to close, and why "the policy is there" is not
    evidence.

    THE REFUSAL HAS TO NAME `public.profiles`, and this test passed for the wrong
    reason until it did. `hq_entitlement_guard` raises the same sentence for every
    gated table, and this RPC also writes `events` and `command_idempotency`,
    which are gated too. With `profiles_entitlement_guard` DISABLED the write
    landed and the refusal still arrived — from the `events` insert one statement
    later — so a bare "not entitled to write" matched a mutation that had already
    stored a suspended account's preference. Observed, then fixed by naming the
    table.

    KILLED BY: dropping or disabling `profiles_entitlement_guard`, or making the
    RPC's write bypass the trigger.
    """
    owner = make_user(conn, f"owner-{uuid.uuid4()}@example.com")

    as_authenticated(conn, owner)
    assert prefs(conn, stale_days=31)["notify"]["stale_days"] == 31, (
        "an entitled owner cannot write — the positive control failed, so every "
        "refusal below proves nothing"
    )

    # PENDING: an account that signed up uninvited.
    as_operator(conn)
    pending = conn.execute(
        "insert into auth.users (id, email) values (%s, %s) returning id",
        (str(uuid.uuid4()), f"pending-{uuid.uuid4()}@example.com"),
    ).fetchone()[0]
    as_authenticated(conn, pending)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        prefs(conn, stale_days=32)
    assert "not entitled to write public.profiles" in exc.value.diag.message_primary, (
        f"refused for the wrong reason: {exc.value.diag.message_primary!r}"
    )

    # SUSPENDED: an account the operator turned off.
    as_operator(conn)
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (owner,))
    as_authenticated(conn, owner)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        prefs(conn, stale_days=33)
    assert "not entitled to write public.profiles" in exc.value.diag.message_primary

    # REMOVED: no entitlement row at all. Absence is never permission.
    as_operator(conn)
    conn.execute("delete from public.entitlements where user_id = %s", (owner,))
    as_authenticated(conn, owner)
    with pytest.raises(psycopg.errors.InsufficientPrivilege) as exc:
        prefs(conn, stale_days=34)
    assert "not entitled to write public.profiles" in exc.value.diag.message_primary

    as_operator(conn)
    assert conn.execute(
        "select stale_days from public.profiles where user_id = %s", (owner,)
    ).fetchone() == (31,), "one of the refused writes landed anyway"
