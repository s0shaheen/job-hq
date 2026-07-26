"""Migrations are code, and the web app's calls into them are a contract.

This file exists because of a specific, expensive discovery: the web app has
been calling `app_set_triage` since it was written, and no migration defined
it. Nothing noticed. The unit tests pass because they run against the fixture
data source, the E2E tests pass for the same reason, and typecheck cannot see
inside a string passed to `supabase.rpc()`. The first person to find out would
have been a human pressing `i` against a real database.

So the checks here are the ones no other layer can make: that every function
the TypeScript calls actually exists, with the parameters it passes, and that
the security properties a `security definer` function needs are present. This
is failure-mode-matrix row 20 ("types drift from the DB") for the write path.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / "db" / "migrations").glob("*.sql"))
SUPABASE_SOURCE = ROOT / "webapp" / "lib" / "data" / "supabase-source.ts"

ALL_SQL = "\n".join(m.read_text() for m in MIGRATIONS)


def test_there_are_migrations():
    assert MIGRATIONS, "no migrations found — wrong path?"


def test_migrations_are_contiguously_numbered():
    """A gap means someone's migration never got committed."""
    numbers = [int(m.name.split("_", 1)[0]) for m in MIGRATIONS]
    assert numbers == list(range(1, len(numbers) + 1)), numbers


# ---------------------------------------------------------------- the contract

def _rpc_calls(ts: str) -> dict[str, set[str]]:
    """Every `supabase.rpc("name", { p_x: ..., p_y: ... })` in the TypeScript."""
    calls: dict[str, set[str]] = {}
    for m in re.finditer(r"""\.rpc\(\s*["'](\w+)["']\s*,\s*\{(.*?)\}\s*\)""", ts, re.S):
        name, body = m.group(1), m.group(2)
        calls.setdefault(name, set()).update(re.findall(r"(\w+)\s*:", body))
    return calls


def _sql_function_params(sql: str, name: str) -> list[str] | None:
    """Parameter names declared for a function, in order."""
    m = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{name}\s*\((.*?)\)\s*returns",
        sql,
        re.S | re.I,
    )
    if not m:
        return None
    return re.findall(r"(p_\w+)", m.group(1))


RPC_CALLS = _rpc_calls(SUPABASE_SOURCE.read_text())


def test_the_web_app_actually_calls_something():
    # If this fails the parser broke, and every check below would vacuously pass.
    assert RPC_CALLS, "no supabase.rpc() calls found — parser out of date?"


@pytest.mark.parametrize("fn", sorted(RPC_CALLS), ids=lambda s: s)
def test_every_rpc_the_app_calls_exists_in_a_migration(fn):
    assert _sql_function_params(ALL_SQL, fn) is not None, (
        f"webapp calls {fn}() but no migration defines it — "
        f"every human write through this path fails at runtime"
    )


@pytest.mark.parametrize("fn", sorted(RPC_CALLS), ids=lambda s: s)
def test_rpc_arguments_match_the_function_signature(fn):
    declared = set(_sql_function_params(ALL_SQL, fn) or [])
    passed = RPC_CALLS[fn]
    # Postgres resolves named arguments by name, so an extra or misspelled key
    # is not a no-op — it fails to resolve the function at all.
    assert passed <= declared, (
        f"{fn}() is called with {sorted(passed - declared)}, "
        f"which it does not declare (declares {sorted(declared)})"
    )


def test_the_reconcile_rpc_the_engine_calls_exists_in_a_migration():
    """The same contract this file checks for the web app, for the one RPC the ENGINE calls.

    `monitor.discover_universe.RECONCILE_FN` is a string handed to `core.pg.rpc`, which is a
    `POST /rest/v1/rpc/<name>` — so a typo is a 404 at 03:00 and nothing else. The first version
    of that constant shipped fully green through both the unit suite (the RPC is monkeypatched)
    and the db suite (which calls the SQL function directly, never through the constant): two
    suites, one contract, and it was between them. Parsing the migrations closes it.
    """
    from monitor.discover_universe import RECONCILE_FN

    assert _sql_function_params(ALL_SQL, RECONCILE_FN) is not None, (
        f"monitor.discover_universe calls {RECONCILE_FN}() but no migration defines it — "
        f"every reconcile pass would 404 and every pasted row would stay a ghost"
    )


def test_the_reconcile_rpc_is_called_with_the_parameters_it_declares():
    """Postgres resolves named arguments by name, so an extra or misspelled key does not land
    in the wrong slot — it fails to resolve the function at all. Same check as the web app's."""
    import inspect

    from monitor import discover_universe

    declared = set(_sql_function_params(ALL_SQL, discover_universe.RECONCILE_FN) or [])
    src = inspect.getsource(discover_universe.reconcile)
    passed = set(re.findall(r'"(p_\w+)":', src))
    assert passed, "no p_* arguments found in reconcile() — parser out of date?"
    assert passed <= declared, (
        f"reconcile() passes {sorted(passed - declared)}, which "
        f"{discover_universe.RECONCILE_FN}() does not declare (declares {sorted(declared)})"
    )


def test_the_engine_only_rpcs_are_not_reachable_from_a_browser():
    """0009's two functions stamp a reliability tier and write audit events, and neither is a
    human gesture. Supabase's default privileges grant execute on new functions to `anon` and
    `authenticated`, so `revoke from public` alone leaves both doors open — the revoke has to
    name the roles. Pinned here because the db suite can only prove it for a role it can
    `set role` to, and this is cheap and total."""
    for fn in ("reconcile_grounded_company", "note_grounding_blocked"):
        revokes = re.findall(rf"revoke\s+all\s+on\s+function\s+public\.{fn}\s*\([^)]*\)\s*\n?\s*"
                             rf"from\s+([^;]+);", ALL_SQL, re.I)
        assert revokes, f"{fn}() is never revoked"
        named = revokes[0].lower()
        for role in ("public", "anon", "authenticated"):
            assert role in named, f"{fn}() is not revoked from {role} — a browser can call it"


def test_conflict_path_keeps_the_word_the_client_matches_on():
    """`supabase-source.ts` decides between the conflict path and a generic
    error by matching /conflict|stale/i on the message. That coupling is
    invisible from either side alone, so it is pinned from here: rewording the
    exception turns a handled conflict into 'Couldn't save that.'"""
    assert re.search(r"raise\s+exception\s+'(conflict|stale)", ALL_SQL, re.I), (
        "no exception message starts with 'conflict'/'stale' — the client's "
        "conflict detection in supabase-source.ts will silently stop working"
    )


# ---------------------------------------------------------------- security

def _strip_sql_comments(sql: str) -> str:
    """Drop `-- …` comments.

    Without this the detector below matches the phrase "security definer"
    inside a comment explaining why a function is deliberately NOT one — which
    is exactly what happened, and it flagged a correct function as a
    vulnerability. A checker that reads prose is a checker that will be worked
    around by rewording, which is the opposite of what it is for.
    """
    return re.sub(r"--[^\n]*", "", sql)


def _definer_functions(sql: str) -> dict[str, str]:
    """name -> full text, for every security-definer function."""
    sql = _strip_sql_comments(sql)
    out: dict[str, str] = {}
    for m in re.finditer(
        r"create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(.*?\$\$(.*?)\$\$",
        sql,
        re.S | re.I,
    ):
        whole = m.group(0)
        if re.search(r"security\s+definer", whole, re.I):
            out[m.group(1)] = whole
    return out


DEFINERS = _definer_functions(ALL_SQL)

# Trigger functions are fired by Postgres against a row, not called by a client.
# They have no caller to revoke from and no session to read auth.uid() out of —
# `handle_new_auth_user` runs on the auth.users insert and reads `new.email`.
# The checks below that assume a caller apply only to the callable ones.
CALLABLE = sorted(n for n, b in DEFINERS.items() if not re.search(r"returns\s+trigger", b, re.I))
ALL_DEFINERS = sorted(DEFINERS)


def test_the_parser_found_the_definer_functions():
    # Guards every parametrized check below from vacuously passing on zero cases.
    assert "app_set_triage" in CALLABLE, sorted(DEFINERS)


@pytest.mark.parametrize("name", ALL_DEFINERS)
def test_definer_functions_pin_search_path(name):
    """A security-definer function that inherits the caller's search_path can be
    tricked into calling a shadowed function with elevated rights. This is the
    standard hardening and it is cheap; the failure mode is privilege
    escalation, which is not a thing to leave to review."""
    body = DEFINERS[name]
    assert re.search(r"set\s+search_path\s*=", body, re.I), (
        f"{name}() is security definer without a pinned search_path"
    )


@pytest.mark.parametrize("name", CALLABLE)
def test_definer_functions_never_take_a_user_id(name):
    """The acting user comes from auth.uid(), never from an argument.

    A `p_user_id` parameter on a security-definer function is an authorization
    bypass with extra steps: the function runs with the definer's rights, so
    whatever the caller names, it gets. Server actions are publicly invokable
    by anyone with a session — the caller is not trusted."""
    body = DEFINERS[name]
    params = re.search(r"\((.*?)\)\s*returns", body, re.S)
    assert params, f"could not parse {name}()'s parameters"
    assert not re.search(r"p_user_?id", params.group(1), re.I), (
        f"{name}() accepts a user id as an argument; it must derive auth.uid()"
    )
    assert "auth.uid()" in body, f"{name}() never reads auth.uid()"


@pytest.mark.parametrize("name", CALLABLE)
def test_definer_functions_are_revoked_from_public(name):
    """`public` includes anonymous visitors. The function rejects them anyway,
    but an un-revoked security-definer function is what becomes a hole three
    schema changes from now."""
    assert re.search(rf"revoke\s+all\s+on\s+function\s+public\.{name}\b", ALL_SQL, re.I), (
        f"{name}() is never revoked from public"
    )
    assert re.search(rf"grant\s+execute\s+on\s+function\s+public\.{name}\b.*?to\s+authenticated",
                     ALL_SQL, re.I | re.S), (
        f"{name}() is never granted to authenticated — the app cannot call it"
    )


def test_browser_still_has_no_direct_write_policy():
    """The durability contract: browsers write through functions or not at all.
    An `for insert`/`for update` policy appearing here would quietly reopen the
    direct-write path that 0001_init.sql closes on purpose."""
    offenders = re.findall(
        r"create\s+policy\s+(\w+)[^;]*?for\s+(insert|update|delete)", ALL_SQL, re.I | re.S
    )
    assert not offenders, f"direct write policies added: {offenders}"


def test_the_write_path_writes_its_audit_event():
    """A state change without its event is a silent edit. The events table is
    the audit trail the spreadsheet never had; the row and the event are
    written in the same function body or the trail has holes in it."""
    body = DEFINERS["app_set_triage"]
    assert re.search(r"insert\s+into\s+public\.events", body, re.I), (
        "app_set_triage changes triage state without appending an event"
    )


def test_idempotency_is_stored_with_its_result():
    """Replaying a key must return what the first call returned. The offline
    outbox replays gestures precisely because it does not know whether they
    landed; a bare 'already applied' would leave the client unable to render
    the row it just changed."""
    assert re.search(r"create\s+table.*?command_idempotency", ALL_SQL, re.I | re.S)
    assert re.search(r"result\s+jsonb\s+not\s+null", ALL_SQL, re.I)


def test_row_is_locked_before_the_conflict_check():
    """Without `for update`, two concurrent gestures both read the same
    updated_at, both pass the conflict check, and both write — which is exactly
    the race acceptance criterion 26 describes."""
    body = DEFINERS["app_set_triage"]
    lock = body.lower().find("for update")
    check = body.lower().find("p_expected_updated_at is not null")
    assert lock != -1, "app_set_triage does not lock the row"
    assert lock < check, "the conflict check runs before the row is locked"
