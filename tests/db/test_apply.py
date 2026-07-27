"""The answer library and its policy rules, actually executed against Postgres.

`tests/core/test_migrations.py` reads 0014 as text: it catches a function nobody
defined, a missing revoke and a version token declared as a string. It cannot
catch a constraint that does not fire. Everything here RUNS.

The shape of this file is set by an adversarial review that EXECUTED the first
version's claims and got past three of four. Each of those exploits is now a
test in `class-of-attack` form, so the refusal is asserted from the direction it
was broken from rather than from the direction it was written from:

    authorship          `authored_by` is stamped by the server, never accepted.
                        The review's four working exploits — kind='freeform' on
                        an EEO answer, provenance='confirmed' on a knockout rule,
                        a direct service-role INSERT, and an UPDATE that omits
                        the column — are each run and each refused.
    the fact shape      a rule stores a SITUATION, and every way of storing a
                        blank one is refused in that kind's own terms
    the anchor          the key-shape constraint exercised through the COLUMN,
                        by swapping a broken normalizer in inside a transaction.
                        The old version asserted a hard-coded COPY of the regexp
                        and stayed green with the real one unanchored.
    the five survivors  the policies-side ratchet, racing upserts, the post-lock
                        re-check on the rule path, and (in test_migrations) the
                        GRANT direction — all four survived mutation before
    the golden fixture  `hq_question_key` against
                        `tests/fixtures/question-keys.golden.json`, the same file
                        `webapp/tests/unit/apply-normalize.test.ts` runs
    idempotency         a replayed key returns the FIRST result, including the
                        `deleted: true/false` distinction a second tap depends on
    RLS                 two real users, both directions, under `set role
                        authenticated` — and no direct write path at all

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q
"""
from __future__ import annotations

import json
import os
import threading
import time
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
    make_user,
    schema,  # noqa: F401 — session fixture
)

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "tests" / "fixtures" / "question-keys.golden.json"

#: The seven topics whose wrong answer ends an application. Duplicated from the
#: migration on purpose: a test that reads the constraint it is checking proves
#: only that the constraint is self-consistent.
#:
#: `background_check_consent` is here because the review found `criminal_history`
#: answering BOTH "have you been convicted?" and "will you consent to a
#: background check?" — opposite-signed questions about different facts, and one
#: rule answering both is how a stored "No" became "I refuse a background check".
KNOCKOUTS = (
    "work_authorization",
    "visa_sponsorship",
    "compensation",
    "criminal_history",
    "background_check_consent",
    "legal_name",
    "age_eligibility",
)

BOOL_FACT = {"kind": "boolean", "value": True}


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def user(conn):
    # A fresh address per test: `make_user` defaults to one literal email and the
    # signup trigger enforces uniqueness, so the default would make every test
    # after the first fail on a UniqueViolation that says nothing about answers.
    u = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, u)
    return u


#: `idem=AUTO` means "mint one"; `idem=""` has to reach the function verbatim, or
#: the blank-key probe tests this helper's `or` instead of the guard.
AUTO = object()


def save_answer(conn, question, answer="Yes", *, kind="freeform",
                provenance="user-entered", idem=AUTO, expected=None,
                company="", declined=False):
    return conn.execute(
        "select public.app_upsert_answer(%s, %s, %s, %s, %s, %s, %s, %s)",
        (question, answer, kind, provenance,
         uuid.uuid4().hex if idem is AUTO else idem, expected, company, declined),
    ).fetchone()[0]


def delete_answer(conn, question, *, company="", idem=AUTO):
    return conn.execute(
        "select public.app_delete_answer(%s, %s, %s)",
        (question, company, uuid.uuid4().hex if idem is AUTO else idem),
    ).fetchone()[0]


def save_rule(conn, topic, *, company="", fact=None, provenance="user-entered",
              note="", enabled=True, idem=AUTO, expected=None):
    return conn.execute(
        "select public.app_set_policy_rule(%s, %s, %s::jsonb, %s, %s, %s, %s, %s)",
        (topic, company, json.dumps(fact if fact is not None else BOOL_FACT),
         provenance, note, enabled,
         uuid.uuid4().hex if idem is AUTO else idem, expected),
    ).fetchone()[0]


def delete_rule(conn, topic, *, company="", idem=AUTO):
    return conn.execute(
        "select public.app_delete_policy_rule(%s, %s, %s)",
        (topic, company, uuid.uuid4().hex if idem is AUTO else idem),
    ).fetchone()[0]


def events(conn, user_id, kind):
    return conn.execute(
        "select payload, actor from public.events where user_id = %s and kind = %s order by id",
        (user_id, kind),
    ).fetchall()


def as_service(conn):
    """Drop the session identity — what a service-role connection looks like.

    `db/test-harness.sql` makes `auth.uid()` read a session setting, and the
    stub is deliberately STRICTER than Supabase: unset means NULL. That is
    exactly the signal `hq_authorship_guard` keys on, so this is a faithful
    stand-in for the engine lane the header promises the guard holds against.
    """
    conn.execute("select set_config('hq.test_user', '', false)")


# ------------------------------------------------ the normalizer, both languages

def test_the_question_key_golden_fixture_matches_postgres(conn, user):
    """The SQL half of the two-language pin.

    `hq_question_key` is the identity every reused answer is keyed on, and
    `webapp/lib/apply/normalize.ts` computes it again inside a browser. That is
    the shape `job_key` already cost this repo once (matrix row 140).

    A case may carry `jsKey` — the ONE recorded cross-language divergence
    (U+0130). This side always asserts `key`; the TypeScript side asserts `jsKey`
    when present. Recording it beats asserting agreement that does not exist.
    """
    cases = json.loads(GOLDEN.read_text())
    assert cases, "empty golden fixture — the assertion below would be vacuous"
    for case in cases:
        got = conn.execute(
            "select public.hq_question_key(%s)", (case["label"],)
        ).fetchone()[0]
        assert got == case["key"], f"{case['why']}: {case['label']!r} -> {got!r}"


def test_the_recorded_divergence_is_exactly_one_case(conn, user):
    """A divergence list that grows quietly is a drift guard that stopped guarding.

    `jsKey` exists for one known expansion (U+0130). If a second one is ever
    added, this goes red and somebody has to decide whether the normalizer should
    change instead of the fixture.
    """
    cases = json.loads(GOLDEN.read_text())
    diverging = [c["label"] for c in cases if "jsKey" in c]
    assert diverging == ["İstanbul office preference"], diverging


def test_the_key_shape_constraint_is_exercised_through_the_column(conn, user):
    """The anchor, hit where it lives.

    The first version of this test ran four of its five cases as
    `select %s ~ '<a copy of the regexp>'` — so unanchoring the REAL constraint
    left every gate green. `question_key` is `generated always as`, so the only
    way to feed it a broken key is to break the generator: each case swaps in a
    mutant `hq_question_key`, inserts, and rolls back.

    Postgres will not `create or replace` a function an existing generated column
    depends on, so the column is dropped and rebuilt inside the same aborted
    transaction. Dropping the column also drops the constraint on it — so the
    constraint is re-added from `pg_get_constraintdef`, i.e. THE CATALOG'S OWN
    TEXT, never a copy typed here. Unanchor the migration and this test unanchors
    with it and stops raising, which is the failure it must have.
    """
    definition = conn.execute(
        "select pg_get_constraintdef(oid) from pg_constraint where conname = %s",
        ("answers_question_key_shape",),
    ).fetchone()[0]
    assert "question_key" in definition, definition

    mutants = [
        # lost its trim -> a trailing space reaches the column
        ("regexp_replace(lower(coalesce($1,'')), '[^a-z0-9]+', ' ', 'g')",
         "Are you 18?", "no trim"),
        # lost its punctuation strip -> '?' reaches the column
        ("btrim(lower(coalesce($1,'')))", "Are you 18?", "no strip"),
        # non-greedy class -> a doubled space reaches the column. Unreachable
        # from the real normalizer; this is what the third clause is FOR.
        ("btrim(regexp_replace(lower(coalesce($1,'')), '[^a-z0-9]', ' ', 'g'))",
         "Are you 18 - 21?", "no run collapse"),
    ]
    for body, label, why in mutants:
        with pytest.raises(psycopg.errors.CheckViolation, match="question_key_shape"), \
                conn.transaction(force_rollback=True):
            conn.execute("alter table public.answers drop column question_key")
            conn.execute(
                f"""create or replace function public.hq_question_key(p_label text)
                    returns text language sql immutable
                    set search_path = pg_catalog, pg_temp
                    as $fn$ select {body.replace('$1', 'p_label')} $fn$"""
            )
            conn.execute(
                """alter table public.answers add column question_key text
                     generated always as (public.hq_question_key(question)) stored"""
            )
            conn.execute(
                "alter table public.answers add constraint answers_question_key_shape "
                + definition
            )
            conn.execute(
                "insert into public.answers (user_id, question, answer) values (%s, %s, 'x')",
                (user, label),
            )
        # The rollback must have restored the real function, or every later test
        # in this session runs against a mutant.
        assert conn.execute(
            "select public.hq_question_key('Are you 18?')"
        ).fetchone()[0] == "are you 18", f"the {why} mutant leaked out of its transaction"

    # And the live path: a label with nothing normalizable in it produces the
    # empty key, which the same constraint refuses. This one needs no mutant.
    with pytest.raises(psycopg.errors.CheckViolation, match="question_key_shape"):
        conn.execute(
            "insert into public.answers (user_id, question, answer) values (%s, %s, %s)",
            (user, "??? — ???", "x"),
        )


def test_a_blank_answer_cannot_reach_the_library(conn, user):
    """0010's lesson, one table over (matrix row 110).

    SQL's bare `btrim(x)` trims SPACES ONLY, so an answer of one newline reads as
    content to every check that does not use `hq_blank_trim` — and a required ATS
    field submitted with a newline in it fails at the board with nothing on
    screen to explain why.
    """
    for blank in ("", " ", "\n", "\t", " ", " "):
        with pytest.raises(psycopg.errors.InvalidParameterValue, match="must not be blank"):
            save_answer(conn, "Anything at all", blank)

    with pytest.raises(psycopg.errors.CheckViolation) as exc:
        conn.execute(
            "insert into public.answers (user_id, question, answer) values (%s, %s, %s)",
            (user, "direct write", "\n\t"),
        )
    assert "answers_answer_is_not_blank" in str(exc.value)


# ═══════════════════════════════════════ authorship: the review's four exploits

def test_authored_by_is_stamped_by_the_server_not_supplied_by_the_caller(conn, user):
    """The redesign, in one assertion.

    There is no `p_authored_by` and no column a caller can set. The trigger
    overwrites unconditionally — no "if the caller left it blank" branch, because
    that branch is the vulnerability: 0010's lesson is that an UPDATE which does
    not mention a column carries the OLD value into `new`.
    """
    save_answer(conn, "Website", "https://a.example")
    assert conn.execute(
        "select authored_by from public.answers where user_id=%s and question_key='website'",
        (user,),
    ).fetchone()[0] == "user"

    # A caller writing the column directly is overwritten, not obeyed.
    conn.execute(
        """insert into public.answers (user_id, question, answer, authored_by)
           values (%s, 'Direct', 'x', 'user')""",
        (user,),
    )
    assert conn.execute(
        "select authored_by from public.answers where user_id=%s and question_key='direct'",
        (user,),
    ).fetchone()[0] == "user", "an authenticated session really is a user write"

    as_service(conn)
    conn.execute(
        """insert into public.answers (user_id, question, answer, authored_by)
           values (%s, 'Sneaky', 'x', 'user')""",
        (user,),
    )
    assert conn.execute(
        "select authored_by from public.answers where user_id=%s and question_key='sneaky'",
        (user,),
    ).fetchone()[0] == "service", "a service write claimed to be a user and was believed"


@pytest.mark.parametrize("topic", KNOCKOUTS)
def test_a_knockout_rule_cannot_be_written_by_a_service_lane(conn, user, topic):
    """THE constraint, and this time against the writer that actually breaks it.

    The first version keyed on `provenance = 'suggested'` — a string the writer
    chooses — and the review walked past it by writing `'confirmed'`. Both
    attacks run here: the honest one and the dishonest one, and the dishonest one
    is now refused by the same constraint because `authored_by` is stamped.
    """
    as_service(conn)
    for claimed in ("suggested", "confirmed", "user-entered"):
        with pytest.raises(psycopg.errors.CheckViolation,
                           match="knockouts_are_human_authored"), \
                conn.transaction(force_rollback=True):
            conn.execute(
                """insert into public.answer_policies (user_id, topic, fact, provenance)
                   values (%s, %s, %s::jsonb, %s)""",
                (user, topic, json.dumps(BOOL_FACT), claimed),
            )


def test_a_knockout_rule_a_signed_in_person_writes_is_accepted(conn, user):
    """The positive control. Without it the check above also passes on a
    constraint that refused every rule, which is a different (and useless) schema."""
    out = save_rule(conn, "work_authorization",
                    fact={"kind": "countries", "value": ["united states"]})
    assert out["rule"]["authoredBy"] == "user"


def test_an_ordinary_topic_may_be_written_by_a_service_lane(conn, user):
    """The other positive control: only the seven knockouts are closed to a
    machine. Layer 3 exists so non-knockout fields CAN be drafted."""
    as_service(conn)
    conn.execute(
        """insert into public.answer_policies (user_id, topic, fact)
           values (%s, 'how_did_you_hear', %s::jsonb)""",
        (user, json.dumps({"kind": "text", "value": "LinkedIn"})),
    )
    assert conn.execute(
        "select authored_by from public.answer_policies where user_id=%s and topic='how_did_you_hear'",
        (user,),
    ).fetchone()[0] == "service"


def test_the_eeo_check_is_real_for_rows_that_declare_themselves(conn, user):
    """And the header now says what it does NOT cover.

    `kind` is a caller-supplied label. This constraint refuses a machine-written
    row that ADMITS to being a demographic answer, and the review's exploit —
    writing the same answer as `kind='freeform'` — is not refused here and is not
    claimed to be. The guard that catches it is engine-side
    (`prepare.ts`: `authored_by='user'` + an exact question-key match), which is
    where it can see that the FIELD is a demographic one.
    """
    as_service(conn)
    with pytest.raises(psycopg.errors.CheckViolation, match="self_id_is_human_authored"):
        conn.execute(
            """insert into public.answers (user_id, question, answer, kind)
               values (%s, 'Gender', 'Male', 'eeo')""",
            (user,),
        )

    # The exploit, run so the limit is a fact and not a footnote.
    conn.execute(
        """insert into public.answers (user_id, question, answer, kind)
           values (%s, 'Gender', 'Male', 'freeform')""",
        (user,),
    )
    row = conn.execute(
        "select kind, authored_by from public.answers where user_id=%s and question_key='gender'",
        (user,),
    ).fetchone()
    assert row == ("freeform", "service"), (
        "the row lands — and `authored_by='service'` is the signal the engine "
        "refuses it on, which is the whole reason the stamp exists"
    )


def test_a_service_write_may_not_overwrite_an_answer_the_user_authored(conn, user):
    """Durability contract rule 5 — "bots fill blanks; humans win" — in SQL, on
    the column a writer cannot forge."""
    save_answer(conn, "Website", "https://example.com")
    as_service(conn)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="service write"):
        conn.execute(
            "update public.answers set answer=%s where user_id=%s and question_key='website'",
            ("https://guessed.example", user),
        )
    assert conn.execute(
        "select answer, authored_by from public.answers where user_id=%s and question_key='website'",
        (user,),
    ).fetchone() == ("https://example.com", "user")


def test_the_service_ratchet_holds_on_a_write_that_omits_the_column(conn, user):
    """The gap the OLD ratchet had, closed by the stamp.

    An UPDATE that does not mention `authored_by` used to carry the human's value
    into `new` and sail through — 0010's `status_actor` bug. The trigger now
    writes the column itself before comparing, so "not mentioning it" is not a
    way to keep it.
    """
    save_answer(conn, "Website", "https://example.com")
    as_service(conn)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            "update public.answers set answer='rewritten' where user_id=%s", (user,)
        )


def test_the_provenance_ratchet_is_kept_and_labelled_advisory(conn, user):
    """It refuses the HONEST downgrade and cannot refuse a dishonest one.

    Both halves asserted, because a test that only showed the refusal would let a
    reader believe this is a security boundary. It is a UI guard on a field the
    caller controls; the security boundary is `authored_by`.
    """
    save_answer(conn, "Website", "https://example.com", provenance="user-entered")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="suggested answer"):
        save_answer(conn, "Website", "https://guessed.example", provenance="suggested")

    # The dishonest write is accepted — by design, and stamped honestly anyway.
    save_answer(conn, "Website", "https://claimed.example", provenance="confirmed")
    assert conn.execute(
        "select answer, provenance, authored_by from public.answers "
        "where user_id=%s and question_key='website'",
        (user,),
    ).fetchone() == ("https://claimed.example", "confirmed", "user")


def test_the_policies_side_ratchet_exists_at_all(conn, user):
    """A mutation survivor: the `answers` ratchet was tested and this one was not,
    so deleting the trigger from `answer_policies` left every gate green."""
    save_rule(conn, "relocation")
    as_service(conn)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="service write"):
        conn.execute(
            "update public.answer_policies set enabled=false where user_id=%s and topic='relocation'",
            (user,),
        )
    conn.execute("select set_config('hq.test_user', %s, false)", (user,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="suggested answer"):
        save_rule(conn, "relocation", provenance="suggested")


def test_the_audit_actor_comes_from_the_stamp_not_from_the_claim(conn, user):
    """An earlier version derived `events.actor` from the caller's provenance
    string, so a machine writing `'confirmed'` signed the trail as a human."""
    save_answer(conn, "Website", "https://a.example", provenance="confirmed")
    (saved,) = events(conn, user, "apply.answer_saved")
    assert saved[1] == "user" and saved[0]["authoredBy"] == "user"


# ═══════════════════════════════════════════════════ the fact, not the answer

def test_a_rule_stores_a_typed_fact_and_every_blank_shape_is_refused(conn, user):
    """"Empty" differs by kind, and each way of being empty looks configured on a
    settings screen while resolving to nothing."""
    bad = [
        ({"kind": "boolean", "value": "yes"}, "a string where a boolean belongs"),
        ({"kind": "countries", "value": []}, "an empty country list"),
        ({"kind": "countries", "value": "united states"}, "a bare string, not a list"),
        ({"kind": "money", "value": "180000"}, "a number as text"),
        ({"kind": "money", "value": -5}, "a negative minimum"),
        ({"kind": "text", "value": "\n"}, "a newline, which bare btrim calls content"),
        ({"kind": "date", "value": "August 17"}, "a date a person typed"),
        ({"kind": "directive", "value": "Monday Weeks Out"}, "a directive with spaces"),
        ({"kind": "directive", "value": "; drop table"}, "a directive with punctuation"),
        ({"kind": "enum", "value": ""}, "an empty enum"),
        ({"kind": "wishes", "value": "x"}, "an unknown kind"),
        ({"value": True}, "no kind at all"),
        ({"kind": "boolean"}, "no value at all"),
    ]
    for fact, why in bad:
        with pytest.raises(psycopg.errors.CheckViolation, match="fact_is_wellformed"), \
                conn.transaction(force_rollback=True):
            conn.execute(
                "insert into public.answer_policies (user_id, topic, fact) values (%s,'relocation',%s::jsonb)",
                (user, json.dumps(fact)),
            )

    good = [
        {"kind": "boolean", "value": False},
        {"kind": "countries", "value": ["united states", "canada"]},
        {"kind": "money", "value": 180000, "currency": "USD"},
        {"kind": "text", "value": "Chicago, IL"},
        {"kind": "date", "value": "2026-08-17"},
        {"kind": "directive", "value": "monday-weeks-out:3"},
        {"kind": "enum", "value": "none"},
    ]
    for fact in good:
        with conn.transaction(force_rollback=True):
            conn.execute(
                "insert into public.answer_policies (user_id, topic, fact) values (%s,'relocation',%s::jsonb)",
                (user, json.dumps(fact)),
            )


def test_a_company_scoped_rule_stores_a_key_not_a_name(conn, user):
    """Matrix row 93's lesson, one table over: a rule written against
    `'Coinbase '` would exist, look right on screen, and never match."""
    with pytest.raises(psycopg.errors.CheckViolation, match="company_is_a_key"):
        conn.execute(
            """insert into public.answer_policies (user_id, topic, company_key, fact)
               values (%s, 'relocation', 'Coinbase ', %s::jsonb)""",
            (user, json.dumps(BOOL_FACT)),
        )
    assert save_rule(conn, "relocation", company="  Coinbase Inc  ")["rule"]["companyKey"] \
        == "coinbase inc"


def test_an_unknown_topic_is_refused(conn, user):
    """`topic` routes the knockout rule. An open set would let one typo store a
    work-authorization fact under a topic nothing considers a knockout."""
    with pytest.raises(psycopg.errors.CheckViolation, match="topic_is_known"):
        conn.execute(
            "insert into public.answer_policies (user_id, topic, fact) values (%s,'work_auth',%s::jsonb)",
            (user, json.dumps(BOOL_FACT)),
        )


# ═════════════════════════════════════════════════════════════ the write path

def test_a_replayed_key_returns_the_first_result(conn, user):
    """`command_idempotency` stores the RESULT, so the offline outbox — which
    replays precisely because it does not know whether a gesture landed — gets
    back the row it needs to render, not a bare "already applied"."""
    first = save_answer(conn, "First name", "Salman", kind="identity", idem="k1")
    again = save_answer(conn, "First name", "CHANGED", kind="identity", idem="k1")
    assert again == first and first["created"] is True
    assert conn.execute(
        "select answer from public.answers where user_id=%s and question_key='first name'",
        (user,),
    ).fetchone()[0] == "Salman", "the replay applied a second time"
    assert len(events(conn, user, "apply.answer_saved")) == 1


def test_a_replayed_delete_keeps_saying_what_the_first_one_did(conn, user):
    """The `deleted: true/false` distinction exists for a person tapping twice on
    a flaky connection: the second tap must not report that nothing happened."""
    save_rule(conn, "relocation")
    assert delete_rule(conn, "relocation", idem="d1") == {"deleted": True}
    assert delete_rule(conn, "relocation", idem="d1") == {"deleted": True}
    assert delete_rule(conn, "relocation", idem="d2") == {"deleted": False}


def test_a_blank_idempotency_key_is_refused(conn, user):
    """'' is a legal text value and `command_idempotency`'s primary key is
    (user_id, idem_key), so one caller sending an empty key would have every
    later empty key replay the first gesture forever."""
    for bad in ("", " ", "\n", " "):
        with pytest.raises(psycopg.errors.InvalidParameterValue,
                           match="idempotency key required"):
            save_answer(conn, "First name", "Salman", idem=bad)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="idempotency key required"):
        save_rule(conn, "relocation", idem="")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="idempotency key required"):
        delete_rule(conn, "relocation", idem="")


def test_a_stale_version_token_is_a_conflict_not_a_clobber(conn, user):
    """And the word "conflict" is load-bearing: `supabase-source.ts` decides
    between the conflict path and a generic error by matching on it."""
    save_answer(conn, "Website", "https://a.example")
    stale = conn.execute(
        "select updated_at - interval '1 second' from public.answers "
        "where user_id=%s and question_key='website'",
        (user,),
    ).fetchone()[0]
    with pytest.raises(psycopg.errors.SerializationFailure, match="conflict"):
        save_answer(conn, "Website", "https://b.example", expected=stale)
    fresh = conn.execute(
        "select updated_at from public.answers where user_id=%s and question_key='website'",
        (user,),
    ).fetchone()[0]
    assert save_answer(conn, "Website", "https://b.example",
                       expected=fresh)["answer"]["answer"] == "https://b.example"


def test_a_first_write_with_a_version_token_is_not_a_phantom_conflict(conn, user):
    """The row did not exist, so the caller read `null` and has no token that
    could be stale."""
    assert save_answer(conn, "Brand new question", "Yes",
                       expected="2020-01-01T00:00:00+00:00")["created"] is True


def test_the_same_question_in_two_spellings_is_one_library_row(conn, user):
    """The promise AUTO-APPLY.md makes — "the same question never asks twice" —
    is false on its first punctuation variation unless the identity is the key."""
    save_answer(conn, "Are you at least 18 years of age?", "Yes")
    save_answer(conn, "ARE YOU AT LEAST 18 YEARS OF AGE", "Yes")
    rows = conn.execute(
        "select question, answer from public.answers where user_id=%s", (user,)
    ).fetchall()
    assert len(rows) == 1 and rows[0][0] == "ARE YOU AT LEAST 18 YEARS OF AGE", rows


# ------------------------------------------------------ 0017: scope and decline


def test_one_question_can_hold_a_global_answer_and_a_company_one(conn, user):
    """The row 0014 could not store, and the reason M1 was reachable at all.

    0001's primary key was `(user_id, question)` — the RAW text — so a second row
    for the same question at a different scope could not exist, whatever the
    unique index said. 0017 moves the key; this is the assertion that the move
    did what it was for.
    """
    save_answer(conn, "Have you worked here before?", "No")
    save_answer(conn, "Have you worked here before?", "Yes", company="Stripe")
    assert conn.execute(
        "select company_key, answer from public.answers where user_id=%s "
        "and question_key='have you worked here before' order by company_key",
        (user,),
    ).fetchall() == [("", "No"), ("stripe", "Yes")]


def test_the_scope_is_part_of_the_identity_and_the_key_still_is_too(conn, user):
    """Both halves, or the change traded one bug for another: two spellings of one
    question at ONE company are still one row."""
    save_answer(conn, "Are you 18?", "Yes", company="Stripe")
    save_answer(conn, "ARE YOU 18", "No", company="  stripe  ")
    assert conn.execute(
        "select count(*), max(answer) from public.answers where user_id=%s and company_key='stripe'",
        (user,),
    ).fetchone() == (1, "No")


def test_a_company_scoped_answer_stores_a_key_not_a_name(conn, user):
    """`company_name_key`, never `lower()` — 0008's NBSP lesson, with the CHECK
    that makes it true for every writer rather than for this one."""
    save_answer(conn, "Referred by an employee?", "Yes", company="  Modern Treasury  ")
    assert conn.execute(
        "select company_key from public.answers where user_id=%s", (user,)
    ).fetchone()[0] == "modern treasury"
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "insert into public.answers (user_id, question, company_key, answer, kind) "
            "values (%s, 'Q', 'Modern Treasury ', 'x', 'freeform')",
            (user,),
        )


def test_a_decline_is_recorded_as_a_choice_and_survives_the_round_trip(conn, user):
    """A person picking "I don't wish to answer" is a legitimate answer, and 0014
    had nowhere to put it: the review screen stored the option's LABEL, which no
    engine layer may ever select, so the question gapped as `option-mismatch`
    forever after. The flag is what the engine replays."""
    row = save_answer(conn, "Gender", "I don't wish to answer", kind="eeo", declined=True)
    assert row["answer"]["declined"] is True
    assert row["answer"]["companyKey"] == ""
    assert row["created"] is True
    (payload, actor) = events(conn, user, "apply.answer_saved")[0]
    assert payload["declined"] is True and actor == "user"


def test_a_decline_cannot_be_written_by_a_service_lane(conn, user):
    """The door's half of "the ENGINE never declines".

    `authored_by` is the trigger's stamp from `auth.uid()`, so this refuses a
    direct service-role INSERT rather than merely a caller that admits what it
    is — `answers_self_id_is_human_authored`'s shape, one column over.
    """
    as_service(conn)
    with pytest.raises(psycopg.errors.CheckViolation,
                       match="declined_is_human_authored"):
        conn.execute(
            "insert into public.answers (user_id, question, answer, kind, declined) "
            "values (%s, 'Gender', 'I do not wish to answer', 'freeform', true)",
            (user,),
        )


def test_clearing_a_decline_is_an_ordinary_overwrite(conn, user):
    """Somebody who declines and then changes their mind must not be stuck: the
    flag is a column on the row, not a state the row cannot leave."""
    first = save_answer(conn, "Gender", "I don't wish to answer", kind="eeo", declined=True)
    again = save_answer(conn, "Gender", "Woman", kind="eeo",
                        expected=first["answer"]["updatedAt"])
    assert again["answer"]["declined"] is False and again["answer"]["answer"] == "Woman"


def test_deleting_an_answer_removes_that_scope_and_leaves_the_other(conn, user):
    """0014 had no delete for `answers` and the settings page said so on screen.
    The scope makes it matter: removing a one-company answer must not remove the
    one every other board uses."""
    save_answer(conn, "Have you worked here before?", "No")
    save_answer(conn, "Have you worked here before?", "Yes", company="Stripe")
    assert delete_answer(conn, "Have you worked here before?", company="Stripe") == {"deleted": True}
    assert conn.execute(
        "select company_key from public.answers where user_id=%s", (user,)
    ).fetchall() == [("",)]


def test_a_replayed_answer_delete_keeps_saying_what_the_first_one_did(conn, user):
    """Idempotent by RESULT, not by effect — `app_delete_policy_rule`'s rule, and
    the reason a second tap on a flaky connection is not told it did nothing."""
    save_answer(conn, "Website", "https://a.example")
    key = uuid.uuid4().hex
    assert delete_answer(conn, "Website", idem=key) == {"deleted": True}
    assert delete_answer(conn, "Website", idem=key) == {"deleted": True}
    assert delete_answer(conn, "Website", idem=uuid.uuid4().hex) == {"deleted": False}


def test_deleting_an_answer_appends_its_event_even_when_nothing_went(conn, user):
    """"Somebody asked to remove an answer that was not there" is a real thing to
    be able to read afterwards."""
    delete_answer(conn, "Never stored")
    (payload, actor) = events(conn, user, "apply.answer_deleted")[0]
    assert payload == {"questionKey": "never stored", "companyKey": "", "deleted": False}
    assert actor == "user"


def test_the_answer_delete_refuses_the_same_junk_every_other_write_refuses(conn, user):
    """A third write path is a third place to forget the two guards the other two
    have — the blank key that would replay one gesture forever, and a question
    that normalizes to nothing."""
    for bad in ("", " \n\t"):
        with pytest.raises(psycopg.errors.InvalidParameterValue,
                           match="idempotency key required"):
            delete_answer(conn, "Website", idem=bad)
    with pytest.raises(psycopg.errors.InvalidParameterValue,
                       match="must contain letters or digits"):
        delete_answer(conn, "!!! ???")


def test_a_user_cannot_delete_another_users_answer(conn, two_users):
    """The definer function derives `auth.uid()` and takes no user id, so there is
    no argument to point at somebody else's row — and it is aimed at exactly the
    question key B holds, so a leak would take it."""
    u = two_users
    as_authenticated(conn, u["a"])
    try:
        answered = conn.execute(
            "select public.app_delete_answer('Question for beta', '', %s)",
            (uuid.uuid4().hex,),
        ).fetchone()[0]
    finally:
        conn.execute("reset role")
    assert answered == {"deleted": False}
    assert conn.execute(
        "select count(*) from public.answers where user_id=%s", (u["b"],)
    ).fetchone()[0] == 1


def test_a_policy_rule_and_its_company_override_coexist(conn, user):
    """The plan's "per-company override possible", as a property of the key."""
    save_rule(conn, "prior_employment", fact={"kind": "boolean", "value": False})
    save_rule(conn, "prior_employment", company="Coinbase",
              fact={"kind": "boolean", "value": True})
    assert conn.execute(
        "select company_key, fact->>'value' from public.answer_policies "
        "where user_id=%s and topic='prior_employment' order by company_key",
        (user,),
    ).fetchall() == [("", "false"), ("coinbase", "true")]


def test_every_write_appends_its_event(conn, user):
    """A state change without its event is a silent edit."""
    save_answer(conn, "Website", "https://a.example")
    save_rule(conn, "relocation")
    delete_rule(conn, "relocation")
    (saved,) = events(conn, user, "apply.answer_saved")
    assert saved[0]["questionKey"] == "website" and saved[1] == "user"
    (rule,) = events(conn, user, "apply.policy_saved")
    assert rule[0]["topic"] == "relocation" and rule[0]["factKind"] == "boolean"
    (gone,) = events(conn, user, "apply.policy_deleted")
    assert gone[0] == {"topic": "relocation", "companyKey": "", "deleted": True}


def test_the_version_token_moves_on_every_write(conn, user):
    """Matrix row 96: `user_companies` was the one versioned table without
    `touch_updated_at`, and the column looked fine because the RPCs set it
    themselves — until a backfill moved the row and left the token behind."""
    save_rule(conn, "relocation")
    before = conn.execute(
        "select updated_at from public.answer_policies where user_id=%s and topic='relocation'",
        (user,),
    ).fetchone()[0]
    conn.execute(
        "update public.answer_policies set note='poked' where user_id=%s and topic='relocation'",
        (user,),
    )
    assert conn.execute(
        "select updated_at from public.answer_policies where user_id=%s and topic='relocation'",
        (user,),
    ).fetchone()[0] > before


# ═══════════════════════════════════ concurrency — the two mutation survivors

def _interleave(user_id, first_sql, first_args, second_sql, second_args, lock_sql, lock_args):
    """Run `second` while `first` holds the row lock, then let `first` commit.

    Sequentially, neither of the tests below can fail: the second caller's
    pre-lock check finds whatever the first one stored and returns early. The
    interleaving is the test.
    """
    results, errors = [], []

    def call(c, sql, args):
        try:
            row = c.execute(sql, args).fetchone()[0]
            c.commit()
            results.append(row)
        except psycopg.errors.Error as exc:
            c.rollback()
            errors.append(exc)

    with psycopg.connect(DATABASE_URL) as a, psycopg.connect(DATABASE_URL) as b:
        for c in (a, b):
            c.execute("select set_config('hq.test_user', %s, false)", (user_id,))
            c.commit()
        b.execute("set lock_timeout = '10s'")
        a.execute("begin")
        a.execute(lock_sql, lock_args)

        t = threading.Thread(target=call, args=(b, second_sql, second_args))
        t.start()
        time.sleep(1.0)          # let B reach the lock and block on it
        call(a, first_sql, first_args)
        t.join(timeout=20)
        assert not t.is_alive(), "the concurrent caller never returned"
    return results, errors


def test_two_racing_upserts_of_one_answer_do_not_both_win(conn, user):
    """`for update` in `app_upsert_answer`, which survived mutation before.

    `test_row_is_locked_before_the_conflict_check` inspects `app_set_triage` and
    nothing else, so removing the lock here was invisible. Two tabs holding the
    same `updated_at` both pass the conflict check without it, and the second
    write silently replaces the first with no conflict banner anywhere.
    """
    save_answer(conn, "Website", "https://original.example")
    seen = conn.execute(
        "select updated_at from public.answers where user_id=%s and question_key='website'",
        (user,),
    ).fetchone()[0]

    sql = "select public.app_upsert_answer('Website', %s, 'freeform', 'user-entered', %s, %s)"
    results, errors = _interleave(
        user,
        sql, ("https://a.example", uuid.uuid4().hex, seen),
        sql, ("https://b.example", uuid.uuid4().hex, seen),
        "select 1 from public.answers where user_id=%s and question_key='website' for update",
        (user,),
    )
    assert len(results) == 1, f"both writers won: {results}"
    assert len(errors) == 1 and "conflict" in str(errors[0]), errors
    assert conn.execute(
        "select answer from public.answers where user_id=%s and question_key='website'",
        (user,),
    ).fetchone()[0] == "https://a.example"


def test_a_concurrent_replay_of_one_rule_key_is_a_replay_not_a_conflict(conn, user):
    """The post-lock re-check in `app_set_policy_rule`, which also survived.

    Two tabs share one outbox and both flush on the same 'online' event, so the
    same key arrives twice at once — both past the pre-lock check before either
    writes. Without the second check behind the lock the loser raises a conflict
    about a change nobody made.
    """
    # The row has to EXIST for the lock below to hold anything, so this seed
    # writes one event of its own; the assertion at the end counts from here.
    save_rule(conn, "relocation", fact={"kind": "boolean", "value": False})
    seeded = len(events(conn, user, "apply.policy_saved"))
    idem = uuid.uuid4().hex
    sql = ("select public.app_set_policy_rule('relocation','',%s::jsonb,"
           "'user-entered','',true,%s,null)")
    results, errors = _interleave(
        user,
        sql, (json.dumps({"kind": "boolean", "value": True}), idem),
        sql, (json.dumps({"kind": "boolean", "value": True}), idem),
        "select 1 from public.answer_policies where user_id=%s and topic='relocation' for update",
        (user,),
    )
    assert not errors, f"a concurrent replay of one key errored: {errors}"
    assert len(results) == 2 and results[0] == results[1], results
    # One gesture, one audit row, however many times it arrives.
    assert len(events(conn, user, "apply.policy_saved")) == seeded + 1


# ═══════════════════════════════════════════════════════════════════════ RLS

def as_authenticated(conn, user_id):
    """Become a signed-in browser session: an identity AND the role.

    Skipping `set role` is the difference between testing RLS and testing
    nothing — `postgres` is a superuser and policies do not apply to it.
    """
    conn.execute("reset role")
    conn.execute("select set_config('hq.test_user', %s, false)", (str(user_id),))
    conn.execute("set role authenticated")


@pytest.fixture
def two_users(conn):
    a = make_user(conn, f"{uuid.uuid4()}@example.com")
    b = make_user(conn, f"{uuid.uuid4()}@example.com")
    for uid, tag in ((a, "alpha"), (b, "beta")):
        as_user(conn, uid)
        save_answer(conn, f"Question for {tag}", tag)
        save_rule(conn, "relocation", fact={"kind": "text", "value": tag})
    conn.execute("reset role")
    return {"a": a, "b": b}


def test_a_user_reads_their_own_answers_and_none_of_the_other_users(conn, two_users):
    """Both halves matter. "A reads 0 of B's rows" is equally true when A can read
    nothing at all, which is what happened before `test-harness.sql` granted what
    Supabase grants."""
    u = two_users
    as_authenticated(conn, u["a"])
    for table in ("answers", "answer_policies"):
        mine = conn.execute(
            f"select count(*) from public.{table} where user_id = %s", (u["a"],)
        ).fetchone()[0]
        theirs = conn.execute(
            f"select count(*) from public.{table} where user_id = %s", (u["b"],)
        ).fetchone()[0]
        assert mine > 0, f"A cannot read its own {table} — the test proves nothing"
        assert theirs == 0, f"A read {theirs} of B's {table} rows"
    conn.execute("reset role")


def test_the_answer_policies_positive_control_is_load_bearing(conn, two_users):
    """The meta-test: drop the policy and the assertion above must go RED."""
    u = two_users
    conn.execute("reset role")
    conn.execute("alter table public.answer_policies disable row level security")
    try:
        as_authenticated(conn, u["a"])
        leaked = conn.execute(
            "select count(*) from public.answer_policies where user_id = %s", (u["b"],)
        ).fetchone()[0]
        assert leaked > 0, (
            "with RLS disabled A still could not see B's rules — the test is "
            "measuring something other than the policy"
        )
    finally:
        conn.execute("reset role")
        conn.execute("alter table public.answer_policies enable row level security")


def test_a_session_has_no_direct_write_to_either_table(conn, two_users):
    """0001's closing note: a browser writes through the functions or not at all.

    THE TWO HALVES REFUSE DIFFERENTLY, and it is worth stating because "no direct
    write" reads as "it errors" and only half of it does. An INSERT with no
    `with check` policy RAISES (42501). An UPDATE or DELETE with no policy does
    NOT raise — the rows are invisible to it, so it reports success having
    touched nothing. A `pytest.raises` around all six would have gone red on a
    correct schema; a row-count assertion alone would have gone green on a schema
    that allowed the UPDATE.
    """
    u = two_users
    as_authenticated(conn, u["a"])
    try:
        for sql, args in [
            ("insert into public.answers (user_id, question, answer) values (%s,'x','y')",
             (u["a"],)),
            ("""insert into public.answer_policies (user_id, topic, fact)
                values (%s, 'onsite_commitment', '{"kind":"boolean","value":true}'::jsonb)""",
             (u["a"],)),
        ]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege), \
                    conn.transaction(force_rollback=True):
                conn.execute(sql, args)

        for sql in [
            "update public.answers set answer='HIJACKED'",
            "delete from public.answers",
            "update public.answer_policies set note='HIJACKED'",
            "delete from public.answer_policies",
        ]:
            touched = conn.execute(sql).rowcount
            assert touched == 0, f"{sql!r} reached {touched} rows through a read-only policy"
    finally:
        conn.execute("reset role")

    # Read back as the superuser: "0 rows" from inside RLS is exactly what a leak
    # would also look like from inside RLS.
    for uid, expect in ((u["a"], "alpha"), (u["b"], "beta")):
        assert conn.execute(
            "select fact->>'value' from public.answer_policies where user_id=%s and topic='relocation'",
            (uid,),
        ).fetchone() == (expect,)
        assert conn.execute(
            "select count(*) from public.answers where user_id=%s", (uid,)
        ).fetchone()[0] == 1


def test_a_user_cannot_write_a_rule_onto_another_users_account(conn, two_users):
    """The definer functions derive `auth.uid()` and take no user id, so there is
    no argument to point at somebody else."""
    u = two_users
    as_authenticated(conn, u["a"])
    try:
        conn.execute(
            "select public.app_set_policy_rule('relocation','',"
            "'{\"kind\":\"text\",\"value\":\"HIJACKED\"}'::jsonb,'user-entered','',true,%s,null)",
            (uuid.uuid4().hex,),
        )
    finally:
        conn.execute("reset role")
    assert conn.execute(
        "select fact->>'value' from public.answer_policies where user_id=%s and topic='relocation'",
        (u["b"],),
    ).fetchone()[0] == "beta"
