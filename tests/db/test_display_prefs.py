"""Display preferences on `profiles`, actually executed against Postgres (0025).

`tests/core/test_migrations.py` reads the SQL as text; it catches a function
nobody defined and cannot catch a logic error. Everything here RUNS.

What it proves that reading the migration cannot:

    the fix    a display write does NOT move `profiles.updated_at`, so an
               autosaved preference cannot make an open Search Profile form
               raise a phantom conflict — while a criteria write still does
    autosave   a write that changes nothing writes nothing: no bumped token,
               no event, no second audit row
    partial    a null value parameter leaves that column alone, so two devices
               turning two different knobs cannot revert each other
    the door   an unknown density/theme is refused with the value named, and
               refused again by the CHECK if the function is ever bypassed
    row 90     a stale version token is a conflict, not a clobber
    row 89     a double-submitted write is one event, not two
    privacy    B cannot read A's preferences, with the positive control in the
               same breath (tests/db/test_rls.py's rule)

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q
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


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def user(conn):
    # A fresh address per test: the signup trigger enforces uniqueness, so a
    # shared default would make every test after the first fail on a
    # UniqueViolation that says nothing about display preferences.
    u = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, u)
    return u


#: `idem=AUTO` means "mint one"; `idem=""` has to reach the function verbatim,
#: or the blank-key probe tests the helper's `or` instead of the guard.
AUTO = object()


def prefs(
    conn,
    *,
    density=None,
    type_scale=None,
    hints=None,
    landing_view=None,
    theme=None,
    idem=AUTO,
    expected=None,
):
    return conn.execute(
        "select public.app_set_display_prefs(%s, %s, %s, %s, %s, %s, %s)",
        (
            density,
            type_scale,
            hints,
            landing_view,
            theme,
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


def row(conn, user_id):
    return conn.execute(
        """select display_density, display_type_scale, display_keyboard_hints,
                  display_landing_view, display_theme, display_updated_at, updated_at
             from public.profiles where user_id = %s""",
        (user_id,),
    ).fetchone()


def events(conn, user_id, kind="profile.display_changed"):
    return conn.execute(
        "select payload from public.events where user_id = %s and kind = %s order by id",
        (user_id, kind),
    ).fetchall()


# ------------------------------------------------------------- the defaults

def test_the_defaults_are_what_the_app_renders_today(conn, user):
    """Every default here is the state an account with no cookie and no
    localStorage already renders, and that is the whole reason this migration
    lands without re-recording a visual baseline.

    MUTATION REASON: change any default in 0025 and this goes red by NAME —
    which matters because the symptom otherwise is a container visual job
    failing on four unrelated-looking screenshots.
    """
    out = prefs(conn, density="dense")  # materialises the row
    assert out["display"] == {
        "display_density": "dense",
        "display_type_scale": "default",
        "display_keyboard_hints": True,
        "display_landing_view": "",
        "display_theme": "system",
        # The keys are the COLUMN names, prefix and all, so one TypeScript
        # mapper serves both this jsonb and a plain select of the same row.
        "display_updated_at": out["display"]["display_updated_at"],
    }


def test_a_preference_can_be_set_before_the_wizard_has_ever_run(conn, user):
    """Somebody who cannot READ the wizard has to be able to enlarge the type
    first. The function materialises the profile row with the never-onboarded
    `'{}'` criteria sentinel, so setting a preference must not look like
    finishing onboarding."""
    prefs(conn, type_scale="large")
    criteria = conn.execute(
        "select criteria from public.profiles where user_id = %s", (user,)
    ).fetchone()[0]
    assert criteria == {}, "a display write onboarded the user"


# --------------------------------------------------- the version-token fix

def test_a_display_write_does_not_move_the_search_profiles_version_token(conn, user):
    """THE bug this migration's trigger clause exists for.

    `updated_at` is the Search Profile's optimistic-concurrency token, 0001
    bumped it on every update to `profiles`, and Preferences AUTOSAVE. So
    without the conditional trigger the sequence "open /settings → tick Larger
    text → press Save changes" raises `conflict: this profile changed since you
    read it` over a gesture that touched nothing the form edits.

    MUTATION REASON: drop the `when (…)` clause from `profiles_touch` and this
    goes red; the second half below keeps that from being achievable by
    deleting the trigger outright.
    """
    commit_profile(conn)
    before = row(conn, user)[6]

    prefs(conn, type_scale="large")

    after = row(conn, user)
    assert after[1] == "large", "the preference did not land"
    assert after[6] == before, "a display write moved the Search Profile's version token"
    # The profile form's token is therefore still good, which is the failure
    # stated as the gesture a person makes rather than as a column value.
    commit_profile(conn, {**CRITERIA, "yoe_max": 9}, expected=before)


def test_a_criteria_write_still_moves_it(conn, user):
    """The control, and it is not decoration: a trigger deleted rather than
    made conditional passes the test above and breaks every conflict check in
    `app_commit_profile`."""
    commit_profile(conn)
    before = row(conn, user)[6]
    commit_profile(conn, {**CRITERIA, "yoe_max": 9})
    assert row(conn, user)[6] > before, "a criteria write stopped touching updated_at"


def test_a_criteria_write_that_changes_nothing_still_moves_it(conn, user):
    """The conditional clause is written as "the display tuple did NOT change",
    never as "a non-display column DID", and this is the difference.

    The second spelling would stop bumping `updated_at` for a save that
    rewrites `criteria` to the same value — which `settings/page.tsx` renders
    as `data-profile-version` and the e2e suite waits on CHANGING. A person who
    presses Save without editing anything would hang the wait forever.
    """
    commit_profile(conn)
    before = row(conn, user)[6]
    commit_profile(conn)  # byte-identical criteria
    assert row(conn, user)[6] > before


def test_the_two_lanes_have_independent_tokens(conn, user):
    """A Search Profile save must not invalidate the popover's token either.
    Same fork, other direction — and nothing about the trigger enforces this
    half, so it gets its own case."""
    prefs(conn, density="comfortable")
    token = row(conn, user)[5]
    commit_profile(conn, {**CRITERIA, "yoe_max": 3})
    out = prefs(conn, type_scale="large", expected=token)
    assert out["display"]["display_type_scale"] == "large"


# ------------------------------------------------------------ autosave shape

def test_a_write_that_changes_nothing_writes_nothing(conn, user):
    """Autosave fires on gestures that are frequently no-ops. The token holding
    still across them is what stops a tab invalidating its own token, and the
    event guard is what keeps the append-only trail readable.

    MUTATION REASON: delete the `is distinct from` guard on the UPDATE and
    both assertions go red — the token moves and a second event appears.
    """
    prefs(conn, density="comfortable")
    token = row(conn, user)[5]
    assert len(events(conn, user)) == 1

    out = prefs(conn, density="comfortable")

    assert out["changed"] is False
    assert row(conn, user)[5] == token, "a no-op autosave bumped the version token"
    assert len(events(conn, user)) == 1, "a no-op autosave appended an event"


def test_a_real_change_reports_itself_and_appends_exactly_one_event(conn, user):
    """The positive control for the case above. Without it, a function that
    refused every write would pass it."""
    prefs(conn, density="comfortable")
    out = prefs(conn, theme="dark")
    assert out["changed"] is True
    payloads = [r[0] for r in events(conn, user)]
    assert len(payloads) == 2
    assert payloads[1]["before"]["display_theme"] == "system"
    assert payloads[1]["after"]["display_theme"] == "dark"


def test_a_null_parameter_leaves_that_column_alone(conn, user):
    """The reason every value parameter is nullable.

    A call that had to restate all five would replay whatever the tab last READ
    into the other four, so flipping density on the phone would quietly revert
    the type scale the laptop set thirty seconds earlier.

    MUTATION REASON: drop a `coalesce(...)` in the UPDATE and the untouched
    column comes back as NULL — which the NOT NULL refuses, loudly.
    """
    prefs(conn, type_scale="large", hints=False, landing_view="jobs")
    prefs(conn, density="comfortable")
    got = row(conn, user)
    assert got[:5] == ("comfortable", "large", False, "jobs", "system")


# ------------------------------------------------------------------- the door

@pytest.mark.parametrize(
    "kwargs",
    [
        {"density": "cozy"},
        {"type_scale": "enormous"},
        {"theme": "sepia"},
        {"landing_view": "x" * 65},
    ],
    ids=lambda k: next(iter(k)),
)
def test_an_unknown_value_is_refused_by_the_function(conn, user, kwargs):
    """Refused with the offending value named, at 22023.

    A CHECK violation would also refuse it — that is the door that stays shut
    if a later writer forgets this one — but it arrives as 23514 with a
    constraint name in it, which `supabase-source.ts` classifies as a generic
    error and shows as "Couldn't save that".
    """
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        prefs(conn, **kwargs)


def test_the_check_constraints_refuse_it_too(conn, user):
    """The function is not the only door, and this is the one that holds if a
    later migration adds a second writer that forgets to validate."""
    prefs(conn, density="dense")
    conn.execute("reset role")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "update public.profiles set display_theme = 'sepia' where user_id = %s",
            (user,),
        )


def test_a_blank_idempotency_key_is_refused(conn, user):
    """0012's tighter door, copied outward as its comment asked: `hq_blank_trim`
    rather than `length(p_idem) = 0`, so a key of one NEWLINE is blank here the
    way it is blank to a person (matrix rows 110, 129). One caller sending a
    blank key would have every LATER blank key replay the first gesture forever.
    """
    for bad in ("", " ", "\n"):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            prefs(conn, density="comfortable", idem=bad)


def test_an_unauthenticated_caller_is_refused(conn):
    """The stub `auth.uid()` returns NULL unless a test sets a user, which is
    deliberately stricter than Supabase — so this exercises the line that
    refuses to write a row with a null `user_id`."""
    conn.execute("select set_config('hq.test_user', '', false)")
    with pytest.raises(psycopg.errors.InvalidAuthorizationSpecification):
        prefs(conn, density="comfortable")


# --------------------------------------------------------- concurrency

def test_a_stale_version_token_conflicts_and_writes_nothing(conn, user):
    """Matrix row 90. And it writes NOTHING — not even an audit row, which is
    the half that would otherwise leave a trail of saves that did not happen."""
    prefs(conn, density="comfortable")
    with pytest.raises(psycopg.errors.SerializationFailure) as err:
        prefs(conn, density="dense", expected="2020-01-01T00:00:00Z")
    assert "conflict" in str(err.value).lower()
    assert row(conn, user)[0] == "comfortable"
    assert len(events(conn, user)) == 1


def test_the_matching_version_token_is_accepted(conn, user):
    """The control. Without it the conflict test passes for a function that
    refuses every expectation."""
    prefs(conn, density="comfortable")
    token = row(conn, user)[5]
    out = prefs(conn, density="dense", expected=token)
    assert out["display"]["display_density"] == "dense"


def test_a_double_submitted_write_applies_once(conn, user):
    """Matrix row 89. The offline outbox replays gestures precisely because it
    does not know whether they landed."""
    idem = uuid.uuid4().hex
    first = prefs(conn, theme="dark", idem=idem)
    second = prefs(conn, theme="dark", idem=idem)
    assert first == second
    assert len(events(conn, user)) == 1


# ------------------------------------------------------------------ privacy

def test_b_cannot_read_as_preferences(conn):
    """`profiles` has RLS and exactly one policy; new COLUMNS inherit it. That
    is true and it is an inheritance, so it is proven from a second user's
    session rather than assumed.

    Both halves matter, per tests/db/test_rls.py's rule: the positive control is
    what keeps "B read 0 rows" from passing because B can read nothing at all.
    """
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, a)
    prefs(conn, type_scale="large")
    as_user(conn, b)
    prefs(conn, type_scale="default")

    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(b),))
    conn.execute("set role authenticated")
    try:
        mine = conn.execute(
            "select count(*) from public.profiles where user_id = %s", (b,)
        ).fetchone()[0]
        theirs = conn.execute(
            "select display_type_scale from public.profiles where user_id = %s", (a,)
        ).fetchall()
    finally:
        conn.execute("reset role")

    assert mine == 1, "B cannot read its own profile — the test proves nothing"
    assert theirs == [], f"B read A's display preferences: {theirs}"


def test_b_cannot_write_as_preferences(conn):
    """The function derives the acting user from `auth.uid()`, so there is no
    argument to point at somebody else — and no direct write policy to route
    around it with."""
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, a)
    prefs(conn, theme="dark")

    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(b),))
    conn.execute("set role authenticated")
    try:
        prefs(conn, theme="light")
        # A direct UPDATE is not an ERROR under RLS, it is a SILENT no-op: with
        # no update policy on `profiles` the statement matches zero rows and
        # reports success. So the assertion is on the row count, because
        # `pytest.raises` here would be waiting for an exception that never
        # comes and a `try/except` version would pass on a wide-open table.
        direct = conn.execute(
            "update public.profiles set display_theme = 'light' where user_id = %s",
            (a,),
        )
        assert direct.rowcount == 0, "a browser session updated another user's profile row"
    finally:
        conn.execute("reset role")

    assert row(conn, a)[4] == "dark", "B's write reached A's row"
