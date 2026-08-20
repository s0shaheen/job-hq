"""One idempotency key names one command — the pre-0026 half (#288).

`0003_write_path.sql` established a replay lookup that selects on
`(user_id, idem_key)` and never read the `command` column, though that column has
been `not null` and written by every command since the table was created. 49
lookups across 29 functions carried that shape until
`20260820_013851_replay_compares_the_command.sql`.

THE TWO PROPERTIES THIS FILE HOLDS, and they are different in kind:

  BEHAVIOUR — a key minted by one command is refused by another (`22023`, the
  wording `hq_command_replay` already uses), a key reused against its OWN command
  still replays byte-for-byte, and a suspended account can no longer reach a
  POST-0026 command's protected result through a pre-0026 sibling. That last one
  is the #287 security review's demonstrated bypass, closed.

  THE TRIPWIRE — both families are derived from `pg_proc` rather than listed, and
  the inline set is a baseline that may only SHRINK
  (`scripts/assertion_lint_baseline.json`'s precedent). A NEW command written in
  the inline shape fails immediately; a function that leaves the set fails until
  its entry is deleted in the same commit. That is what makes adopting
  `hq_command_replay` opportunistically (route (c)) safe: the set cannot grow
  behind anybody's back while it shrinks.

WHAT IS DELIBERATELY NOT CLAIMED HERE. These 29 functions still do not check
entitlement in their replay path, so a suspended account replaying its OWN key
against the SAME pre-0026 command still receives its own stored result. The test
names below say `…through_a_pre_0026_sibling`, not "cannot replay", for
`test_default_deny.py`'s reason: a test named for a system property it does not
prove is a lie by omission. `test_the_pre_0026_lookup_still_has_no_entitlement
_check` asserts that residual from the other side, so it cannot be quietly
forgotten and cannot quietly change.

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db/test_replay_command_scope.py -q
"""
from __future__ import annotations

import os
import re
import uuid

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from tests.db.test_default_deny import (  # noqa: E402  (shared on purpose)
    _add_job,
    _as,
    _system,
)
from tests.db.test_write_path import (  # noqa: E402
    gate,
    make_posting,
    make_user,
    schema,  # noqa: F401 — session fixture
)


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


# ════════════════════════════════════════════════════ the baseline, and only it

#: The functions that read `command_idempotency` WITHOUT going through
#: `hq_command_replay`, name -> the migration that last declared the body
#: `20260820_013851` rewrote. Twenty-seven `app_*` browser commands and TWO
#: `hq_*` engine lanes, enumerated out of `pg_proc` rather than counted by hand.
#:
#: THIS LIST MAY ONLY SHRINK. It is the pre-0026 replay shape's obituary, not a
#: registry: a function that adopts `hq_command_replay` (route (c)) deletes its
#: line in the same commit, and nothing may ever be added. `test_the_inline
#: _replay_set_may_only_shrink` asserts both directions.
INLINE_REPLAY_BASELINE: dict[str, str] = {
    "app_add_note": "0010_pipeline.sql",
    "app_clear_connections": "0013_referral.sql",
    "app_commit_profile": "0012_profile.sql",
    "app_delete_answer": "0017_answer_scope.sql",
    "app_delete_policy_rule": "0014_apply_answers.sql",
    "app_delete_view": "0005_saved_views.sql",
    "app_import_commit_chunk": "20260813_011502_import_unset_marker.sql",
    "app_import_connections": "0013_referral.sql",
    "app_import_create": "0011_import.sql",
    "app_import_discard": "0011_import.sql",
    "app_import_undo": "0011_import.sql",
    "app_pin_warm_intro": "0020_warm_referral.sql",
    "app_propose_companies": "0008_company_review.sql",
    "app_resolve_suggestion": "0010_pipeline.sql",
    "app_save_view": "0005_saved_views.sql",
    "app_set_company_flags": "0008_company_review.sql",
    "app_set_company_review_bulk": "0008_company_review.sql",
    "app_set_display_prefs": "0025_display_prefs.sql",
    "app_set_linkedin_company_id": "0016_linkedin_fill.sql",
    "app_set_next_action": "0010_pipeline.sql",
    "app_set_policy_rule": "0014_apply_answers.sql",
    "app_set_status": "0010_pipeline.sql",
    "app_set_triage": "0003_write_path.sql",
    "app_set_triage_bulk": "0006_bulk_triage.sql",
    "app_start_warm_search": "20260817_011844_per_user_rate_bounds.sql",
    "app_unpin_warm_intro": "0020_warm_referral.sql",
    "app_upsert_answer": "0017_answer_scope.sql",
    "hq_apply_email_event": "0015_engine_writes.sql",
    "hq_digest_set_triage": "0019_digest_action.sql",
}

#: The engine lanes, which are the reason this set is NOT simply "the app_*
#: commands". Named so that a reviewer of the entitlement work (#256, whose gate
#: reads `auth.uid()`) sees immediately that two members have no browser session.
ENGINE_LANES = {"hq_apply_email_event", "hq_digest_set_triage"}


# ═════════════════════════════════════════════════ the enumerations, out of pg_proc
#
# Every structural assertion below goes through one of these, and the
# counterexample test calls the same functions — which is what makes it a proof
# rather than a second opinion.

def _bodies(conn) -> dict[str, str]:
    """name -> the body Postgres actually stored, for every function in `public`.

    `prosrc`, not the migration text: a function re-declared by a later migration
    is read once, in the shape that is actually live.
    """
    return dict(
        conn.execute(
            """select p.proname, p.prosrc
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'"""
        ).fetchall()
    )


def _uncommented(body: str) -> str:
    """`--` comments dropped. `test_default_deny._uncommented`'s lesson: a comment
    NAMING the lookup is not a lookup, and the prose in these bodies quotes the
    shape it is explaining."""
    return re.sub(r"--[^\n]*", "", body)


#: A `select … from public.command_idempotency` that reads `result` — the replay
#: read, as distinct from the `insert … on conflict` every command ends with.
LOOKUP = re.compile(
    r"select\s+result\s*(?P<cmdcol>,\s*command\s*)?into\s+(?P<var>\w+)"
    r"(?P<rest>[^;]*?)from\s+public\.command_idempotency\b",
    re.I | re.S,
)


def inline_replay_users(conn) -> dict[str, str]:
    """Every function carrying the INLINE replay read, excluding the primitive.

    `hq_command_replay` itself is excluded by name and not by shape: it is the
    one function that is *supposed* to read the table directly, and it has
    compared the command since `0026_resume.sql`.
    """
    return {
        name: body
        for name, body in _bodies(conn).items()
        if name != "hq_command_replay"
        and "hq_command_replay" not in _uncommented(body)
        and LOOKUP.search(_uncommented(body))
    }


def replay_primitive_users(conn) -> set[str]:
    """Every function that reaches the table through `hq_command_replay`."""
    return {
        name
        for name, body in _bodies(conn).items()
        if name != "hq_command_replay" and "hq_command_replay" in _uncommented(body)
    }


def audit_lookups(body: str, command: str) -> tuple[int, int, list[str]]:
    """(inline reads, reads that compare the command, why the rest do not).

    The offenders are text rather than a count, so a failure names the statement
    it is talking about.
    """
    clean = _uncommented(body)
    total = guarded = 0
    bad: list[str] = []
    for m in LOOKUP.finditer(clean):
        total += 1
        if not m.group("cmdcol"):
            bad.append(f"reads `result` alone: {m.group(0)[:90]!r}")
            continue
        tail = clean[m.end():m.end() + 600]
        if f"v_replay_command is distinct from '{command}'" not in tail:
            bad.append(f"selects the command and never compares it: {m.group(0)[:90]!r}")
            continue
        guarded += 1
    return total, guarded, bad


def unguarded_lookups(conn, body: str, command: str) -> list[str]:
    """The inline reads in `body` that do NOT compare the command."""
    return audit_lookups(body, command)[2]


# ════════════════════════════════════════════════════════════ 1. THE TRIPWIRE

def test_the_inline_replay_set_may_only_shrink(conn):
    """Both directions, out of `pg_proc`, against a baseline that only shrinks.

    The issue said 27 `app_*` plus 2 `hq_*`; the database says the same, and the
    database is what is asserted. The two directions carry different meanings and
    both are failures:

      * a name in the schema and not in the list is a NEW command written in the
        retired shape — the tripwire, and the whole reason this test exists;
      * a name in the list and not in the schema is a function that adopted
        `hq_command_replay` without deleting its line, which is how a baseline
        stops describing anything.

    KILLED BY: `test_the_tripwire_catches_a_new_inline_command`, which builds
    exactly the first mistake in the live schema and watches this detector report
    it.
    """
    found = inline_replay_users(conn)
    assert sorted(found) == sorted(INLINE_REPLAY_BASELINE), {
        "in the schema, not in the baseline — a NEW command in the retired shape":
            sorted(set(found) - set(INLINE_REPLAY_BASELINE)),
        "in the baseline, not in the schema — delete the line in the same commit":
            sorted(set(INLINE_REPLAY_BASELINE) - set(found)),
    }
    assert len(found) == 29, len(found)
    assert {n for n in found if not n.startswith("app_")} == ENGINE_LANES, (
        "the non-browser members of this set are load-bearing: an entitlement check "
        "modelled on #256 reads auth.uid(), which an engine lane does not have")


def test_every_inline_lookup_compares_its_own_command(conn):
    """The property #288 bought, asserted per statement rather than per function.

    A function with two lookups that guards only one is the half-fix this shape
    invites — 20 of the 29 read the table twice, once before the row lock and once
    behind it (`0003_write_path.sql:166-182`), and the second read is the one a
    concurrent retry lands on.

    Counted positively — guarded lookups per function, not "no offenders" — so
    the test cannot pass by finding nothing to look at, and the two named shapes
    below pin both arities to a body a reader can go and open.

    KILLED BY: `test_the_tripwire_catches_a_new_inline_command` (an unguarded
    lookup), and by reverting any single body in the migration.
    """
    audited: dict[str, tuple[int, int]] = {}
    for name, body in inline_replay_users(conn).items():
        total, guarded, bad = audit_lookups(body, name)
        assert total >= 1, f"{name} was enumerated as an inline caller and reads nothing"
        assert guarded == total, {name: bad}
        audited[name] = (total, guarded)

    assert audited["app_set_triage"] == (2, 2), (
        "0003's own shape: read before the row lock and again behind it, both compared")
    assert audited["app_save_view"] == (1, 1), (
        "the single-lookup shape, compared too")
    assert sum(g for _, g in audited.values()) == sum(t for t, _ in audited.values()) >= 29, (
        "every inline read in the schema compares its command")


def test_the_two_replay_families_are_disjoint_and_account_for_the_table(conn):
    """No third shape, and no function in both.

    A command that reads the table through neither route — a hand-rolled join, a
    `case` over `command`, a helper of its own — would be outside both this file's
    baseline and `test_default_deny.REPLAY_FAMILY`, which is precisely the gap the
    27 spent two years in.

    The TOTAL is what is asserted, not either half: a function adopting
    `hq_command_replay` (route (c)) moves between the two sets and the sum does
    not change, so this assertion survives the shrink it is meant to allow.
    """
    bodies = _bodies(conn)
    inline = set(inline_replay_users(conn))
    modern = replay_primitive_users(conn)
    participants = {
        name
        for name, body in bodies.items()
        if name != "hq_command_replay"
        and ("public.command_idempotency" in _uncommented(body)
             or "hq_command_replay" in _uncommented(body))
    }

    assert inline | modern == participants, {
        "touches command idempotency through neither route":
            sorted(participants - inline - modern),
        "claimed by a family and touches nothing":
            sorted((inline | modern) - participants),
    }
    assert len(inline) + len(modern) == len(participants) == 39, (
        f"inline={len(inline)} modern={len(modern)} participants={len(participants)} — "
        "a function left both families, or joined one twice")
    assert inline.isdisjoint(modern), sorted(inline & modern)

    # And the shape the two sets would otherwise swallow: a function that calls
    # the primitive AND hand-rolls a read of its own. `inline_replay_users`
    # excludes anything mentioning `hq_command_replay`, so such a function would
    # be counted as fully modern and never audited for the comparison.
    both = {
        name for name in modern
        if re.search(r"select\s+result[^;]*?from\s+public\.command_idempotency",
                     _uncommented(bodies[name]), re.I | re.S)
    }
    assert not both, {"calls hq_command_replay and also reads the table directly": sorted(both)}


def test_the_command_comparison_sits_above_the_charge(conn):
    """`20260817_011844` decision 4, for the half of the order this file touches.

    The comparison is inside the replay check, which is strictly above the meter
    and the write — so a refused key consumes no rate-bound unit and leaves no
    counter row. `app_start_warm_search` is the only member of this set that
    charges a meter today, so the assertion is narrow by construction and stated
    that way rather than dressed up as a family property.
    """
    charged = {}
    for name, body in inline_replay_users(conn).items():
        clean = _uncommented(body)
        charge = clean.find("hq_charge_rate_bound")
        if charge < 0:
            continue
        last_compare = clean.rfind("v_replay_command is distinct from")
        charged[name] = (last_compare, charge)
        assert 0 <= last_compare < charge, (
            f"{name}: the command comparison must precede the meter, or a refused "
            f"key costs the account a unit")
    assert "app_start_warm_search" in charged, (
        "the metered member of this set disappeared — re-derive the assertion "
        "rather than deleting it")


# ═══════════════════════════════════════════ 2. the tripwire, watched failing

_OLD_SHAPE = """
create or replace function public.app_counterexample_inline(p_idem text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  -- the retired shape, verbatim: keyed on (user_id, idem_key) and blind to the
  -- command that owns the row
  select result into v_result
    from public.command_idempotency
   where user_id = v_user and idem_key = p_idem;
  if found then
    return v_result;
  end if;
  v_result := jsonb_build_object('counterexample', true);
  insert into public.command_idempotency (user_id, idem_key, command, result)
  values (v_user, p_idem, 'app_counterexample_inline', v_result)
  on conflict (user_id, idem_key) do nothing;
  return v_result;
end;
$$;
"""


def test_the_tripwire_catches_a_new_inline_command(conn):
    """The mistake, built in the live schema, reported by the SAME detectors.

    A structural test nobody has watched fail is a structural test that passes
    because it looks at nothing. This builds the exact thing #288 exists to
    prevent — a new command written in the retired shape — re-runs the two
    functions the assertions above call, and requires both to name it. Then drops
    it, so the schema the rest of the session sees is unchanged.
    """
    _system(conn)
    conn.execute(_OLD_SHAPE)
    try:
        found = inline_replay_users(conn)
        assert "app_counterexample_inline" in found, (
            "the enumeration did not see a function carrying the inline shape — "
            "the tripwire is looking at nothing")
        assert set(found) - set(INLINE_REPLAY_BASELINE) == {"app_counterexample_inline"}, (
            "the baseline comparison did not flag the new command")
        assert unguarded_lookups(conn, found["app_counterexample_inline"],
                                 "app_counterexample_inline"), (
            "the per-statement check did not flag an unguarded lookup")
    finally:
        conn.execute("drop function if exists public.app_counterexample_inline(text)")

    assert "app_counterexample_inline" not in inline_replay_users(conn)


# ═══════════════════════════════════════════════════════════════ 3. BEHAVIOUR

def _save_view(conn, idem: str, *, name: str = "View"):
    return conn.execute(
        "select public.app_save_view(%s,%s,%s,%s::jsonb,%s,%s,%s)",
        (None, name, "jobs", "{}", False, idem, None),
    ).fetchone()[0]


def _set_triage(conn, key: str, idem: str, triage: str = "interested"):
    return conn.execute(
        "select public.app_set_triage(%s,%s,%s,%s,%s,%s)",
        (key, triage, None, "", idem, None),
    ).fetchone()[0]


def _clear_connections(conn, idem: str):
    return conn.execute(
        "select public.app_clear_connections(%s)", (idem,)
    ).fetchone()[0]


def _stored(conn, uid: str, idem: str):
    row = conn.execute(
        "select command, result from public.command_idempotency "
        "where user_id = %s and idem_key = %s",
        (uid, idem),
    ).fetchone()
    return row


def test_the_same_key_against_the_same_command_still_replays(conn):
    """The positive control, and the contract that must NOT have changed.

    Every idempotency test in `tests/db` is this shape, and if #288 had broken it
    the failure would be a double-applied gesture rather than a red test — so it
    is asserted here too, on a pre-0026 command, with DIFFERENT arguments under
    the same key. Answering the first result to different arguments is the
    pre-0026 contract (no `request_hash` before 0026); this file scopes the
    COMMAND and deliberately leaves the payload dimension exactly where it was.

    KILLED BY: adding `and command = …` as a WHERE predicate WITHOUT the
    comparison — that shape also passes here, which is why the refusal tests
    below exist.
    """
    uid = make_user(conn, f"replay-same-{uuid.uuid4()}@example.com")
    idem = str(uuid.uuid4())

    _as(conn, uid)
    first = _save_view(conn, idem, name="Original")
    again = _save_view(conn, idem, name="Renamed")
    assert again == first, "a key reused against its own command must replay verbatim"

    _system(conn)
    assert conn.execute(
        "select count(*) from public.saved_views where user_id = %s", (uid,)
    ).fetchone()[0] == 1, "the replay wrote a second row — it was not a replay"


@pytest.mark.parametrize(
    "owner,victim",
    [
        pytest.param("app_add_job", "app_save_view", id="post_0026_key_pre_0026_victim"),
        pytest.param("app_add_job", "app_clear_connections", id="the_second_demonstrated_sibling"),
        pytest.param("app_save_view", "app_set_triage", id="pre_0026_key_pre_0026_victim"),
    ],
)
def test_a_key_minted_by_another_command_is_refused(conn, owner, victim):
    """The correctness half, for an ENTITLED caller — #288 consequence (2).

    Because the lookup never compared the command, any caller reusing one key
    across two commands received the FIRST command's stored result back from the
    second: a payload of an unrelated shape, reported as this command's answer.
    Nobody had hit it because keys are minted per gesture in practice, and nothing
    enforced that.

    The two `app_add_job` rows are the #287 review's own demonstration, run here
    with the account ACTIVE — which is the point. The bypass is closed
    structurally, by key scoping, not by an entitlement check the pre-0026 lookup
    still does not have.

    Measured before the fix, this harness, same script: `app_save_view` returned
    `{'outcome': 'added', 'posting': …}` — `app_add_job`'s answer, handed back as
    a saved view.

    KILLED BY: re-declaring the victim function from its original migration; the
    call answers with the owner's stored result again.
    """
    uid = make_user(conn, f"replay-x-{uuid.uuid4()}@example.com")
    idem = str(uuid.uuid4())
    key = f"gh-{uuid.uuid4().hex[:8]}"

    _system(conn)
    make_posting(conn, key)
    gate(conn, uid, key)

    _as(conn, uid)
    if owner == "app_add_job":
        stored = _add_job(conn, f"add-{uuid.uuid4().hex[:8]}", idem)
    else:
        stored = _save_view(conn, idem, name="Owner")

    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        if victim == "app_save_view":
            _save_view(conn, idem, name="Victim")
        elif victim == "app_clear_connections":
            _clear_connections(conn, idem)
        else:
            _set_triage(conn, key, idem)

    message = exc.value.diag.message_primary
    assert f"already used by {owner}" in message, message
    assert f"{victim} cannot replay it" in message, message

    _system(conn)
    command, result = _stored(conn, uid, idem)
    assert command == owner, "the refusal must not re-key the stored row"
    assert result == stored, "the refusal must not overwrite the stored result"
    if victim == "app_save_view":
        assert conn.execute(
            "select count(*) from public.saved_views where user_id = %s", (uid,)
        ).fetchone()[0] == (1 if owner == "app_save_view" else 0), (
            "the refused call wrote anyway — the raise is below the write")
    if victim == "app_set_triage":
        assert conn.execute(
            "select triage from public.user_postings where user_id=%s and posting_key=%s",
            (uid, key),
        ).fetchone()[0] == "", "the refused call applied the triage anyway"


def test_a_suspended_account_cannot_reach_a_post_0026_result_through_a_pre_0026_sibling(conn):
    """#287's demonstrated bypass of #256's fix, closed — the security half.

    `20260817_051941_replay_respects_entitlement.sql` put the entitlement check
    inside `hq_command_replay`, so the ten post-0026 commands refuse a suspended
    account. The review then showed the fix was one call away from being no fix:
    the suspended account sent THE SAME KEY to any of the 29 pre-0026 siblings and
    received the protected command's stored result verbatim, because those lookups
    keyed on `(user_id, idem_key)` alone. `app_save_view` and
    `app_clear_connections` each returned an `app_add_job` result to a suspended
    caller.

    READ THE REFUSAL FOR WHAT IT IS. It is `22023` — "this key belongs to
    app_add_job" — and NOT `42501`. The pre-0026 lookup still has no entitlement
    check; what is closed is reaching ANOTHER command's result, which is what
    made this a bypass rather than a neighbouring hole. The account's own
    pre-0026 results remain reachable, and
    `test_the_pre_0026_lookup_still_has_no_entitlement_check` says so out loud.

    The account is ACTIVE when it stores the result, and the entitled replay is
    the positive control — so the refusal below is key scoping doing it, not an
    empty table and not a mangled key. The stored row is re-read afterwards to
    prove the same point from the other side: the result is still there, and the
    account simply may not have it through THIS door.

    KILLED BY: re-declaring `app_save_view` from `0005_saved_views.sql` — the
    suspended call answers with `app_add_job`'s result again.
    """
    uid = make_user(conn, f"replay-bypass-{uuid.uuid4()}@example.com")
    key, idem = f"gh-{uuid.uuid4().hex[:8]}", str(uuid.uuid4())

    _as(conn, uid)
    protected = _add_job(conn, key, idem)
    assert protected["outcome"] == "added"
    assert _add_job(conn, key, idem) == protected, (
        "positive control: an entitled caller replaying its own key against its own "
        "command must still get the durable result")

    _system(conn)
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (uid,))

    _as(conn, uid)
    for call in (lambda: _save_view(conn, idem, name="Bypass"),
                 lambda: _clear_connections(conn, idem)):
        with pytest.raises(psycopg.errors.Error) as exc:
            got = call()
            pytest.fail(f"the sibling answered a suspended caller with {got!r}")
        assert "already used by app_add_job" in (exc.value.diag.message_primary or ""), (
            exc.value.diag.message_primary)

    _system(conn)
    command, result = _stored(conn, uid, idem)
    assert (command, result) == ("app_add_job", protected), (
        "a refusal that works by having deleted or re-keyed the row is not the "
        "property under test")


def test_the_pre_0026_lookup_still_has_no_entitlement_check(conn):
    """The residual, asserted so it cannot be mistaken for the guarantee.

    #288 scopes the key to its command. It does NOT put an entitlement check in
    these 29 bodies — that is route (c), adopting `hq_command_replay` one function
    at a time, and the migration says so. So a suspended account replaying its OWN
    key against the SAME pre-0026 command still receives its own stored result:
    the lookup returns above every write, so `hq_entitlement_guard()` never fires.

    This test EXPECTS that. It is here because an unasserted residual is a residual
    somebody quotes the headline over — and because when route (c) reaches
    `app_save_view`, this test goes red and the person doing it has to come here,
    delete it, and move the line in `INLINE_REPLAY_BASELINE`. That is the shrink,
    made visible.
    """
    uid = make_user(conn, f"replay-residual-{uuid.uuid4()}@example.com")
    idem = str(uuid.uuid4())

    _as(conn, uid)
    first = _save_view(conn, idem, name="Own")

    _system(conn)
    conn.execute("select public.hq_suspend_user(%s, 'abuse')", (uid,))

    _as(conn, uid)
    assert _save_view(conn, idem, name="Own") == first, (
        "a suspended account replaying its own key against its own pre-0026 command "
        "still gets its own stored result — if this now RAISES, route (c) reached "
        "app_save_view: delete this test and shrink INLINE_REPLAY_BASELINE")


def test_another_accounts_key_is_unchanged_and_is_simply_a_key_this_account_never_used(conn):
    """Wrong owner, asserted because the change could have moved it and did not.

    The lookup is scoped to `user_id` first and always has been, so B sending A's
    key has never been a replay and is not one now: it is B's own first call. The
    property worth holding is that #288 did not turn it into a refusal — B's key
    space is B's, and a `22023` here would make one account's key collisions
    another account's outage.
    """
    a = make_user(conn, f"replay-a-{uuid.uuid4()}@example.com")
    b = make_user(conn, f"replay-b-{uuid.uuid4()}@example.com")
    idem = str(uuid.uuid4())

    _as(conn, a)
    a_view = _save_view(conn, idem, name="A's view")

    _as(conn, b)
    b_view = _save_view(conn, idem, name="B's view")
    assert b_view != a_view, "B received A's stored result"
    assert b_view["name"] == "B's view", b_view

    _system(conn)
    assert conn.execute(
        "select count(*) from public.saved_views where user_id = %s", (b,)
    ).fetchone()[0] == 1
    assert _stored(conn, a, idem)[1] == a_view, "B's call rewrote A's stored row"


def test_the_engine_lanes_keep_their_own_replay(conn):
    """The two `hq_*` members, driven rather than reasoned about.

    `hq_digest_set_triage` is the lane a one-click email link lands on, and its
    lookup already carried a THIRD predicate before this change
    (`result->>'posting_key' = p_posting_key`, 0019 review m1) whose documented
    behaviour on a mismatch is to FALL THROUGH, not raise. #288 adds the command
    comparison AFTER the lookup precisely so that predicate and that fall-through
    are untouched — a refusal there would break the digest's undo path.

    So: the token's `jti` replays against its own command, and a browser key
    minted by `app_set_triage` cannot be spent through the digest lane.
    """
    uid = make_user(conn, f"replay-digest-{uuid.uuid4()}@example.com")
    key, jti = f"gh-{uuid.uuid4().hex[:8]}", str(uuid.uuid4())

    _system(conn)
    make_posting(conn, key)
    gate(conn, uid, key)

    first = conn.execute(
        "select public.hq_digest_set_triage(%s,%s,%s,%s)",
        (uid, key, "interested", jti),
    ).fetchone()[0]
    again = conn.execute(
        "select public.hq_digest_set_triage(%s,%s,%s,%s)",
        (uid, key, "interested", jti),
    ).fetchone()[0]
    assert again == first, "the digest lane stopped replaying its own token"

    _as(conn, uid)
    with pytest.raises(psycopg.errors.InvalidParameterValue) as exc:
        _set_triage(conn, key, jti, "dismissed")
    assert "already used by hq_digest_set_triage" in exc.value.diag.message_primary

    _system(conn)
    assert conn.execute(
        "select triage from public.user_postings where user_id=%s and posting_key=%s",
        (uid, key),
    ).fetchone()[0] == "interested", "the refused browser call overwrote the digest's write"
