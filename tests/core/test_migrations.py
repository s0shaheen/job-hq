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

def _brace_body(ts: str, start: int) -> tuple[str, int]:
    """The text between `ts[start] == '{'` and its BALANCED close.

    `(.*?)\\}` stops at the first brace, which is wrong the moment an argument is
    itself an object — `p_rows: rows.map((r) => ({ row_number: r.n }))`. The
    non-greedy version cut the argument list at that inner brace, so the outer
    keys after it were invisible and the inner ones were read as arguments. That
    is matrix row 92's shape: a drift guard that cannot see what it guards.
    """
    depth = 0
    for i in range(start, len(ts)):
        if ts[i] == "{":
            depth += 1
        elif ts[i] == "}":
            depth -= 1
            if depth == 0:
                return ts[start + 1 : i], i
    return "", len(ts)


def _top_level_keys(body: str) -> set[str]:
    """`key:` names at nesting depth 0 — the arguments, not their contents."""
    keys: set[str] = set()
    depth = 0
    token = ""
    for ch in body:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        elif ch == ":" and depth == 0:
            name = token.strip().split()[-1] if token.strip() else ""
            if re.fullmatch(r"\w+", name):
                keys.add(name)
            token = ""
            continue
        elif ch == "," and depth == 0:
            token = ""
            continue
        token += ch
    return keys


def _rpc_calls(ts: str) -> dict[str, set[str]]:
    """Every `supabase.rpc("name", { p_x: ..., p_y: ... })` in the TypeScript."""
    calls: dict[str, set[str]] = {}
    for m in re.finditer(r"""\.rpc\(\s*["'](\w+)["']\s*,\s*(?=\{)""", ts):
        name = m.group(1)
        body, _ = _brace_body(ts, m.end())
        calls.setdefault(name, set()).update(_top_level_keys(body))
    return calls


def test_the_rpc_parser_reads_nested_arguments_correctly():
    """The parser is itself load-bearing, so it gets a case of its own.

    Both halves are real shapes from `supabase-source.ts`: `app_import_stage`
    passes an array of objects, and the old regex reported `row_number`/`raw` as
    arguments of the function while missing nothing only by luck.
    """
    sample = """
      await this.supabase.rpc("app_import_stage", {
        p_batch: input.batchId,
        p_rows: input.rows.map((r) => ({ row_number: r.rowNumber, raw: r.raw })),
      });
      await this.supabase.rpc("plain_one", { p_a: 1, p_b: 2 });
    """
    calls = _rpc_calls(sample)
    assert calls["app_import_stage"] == {"p_batch", "p_rows"}, calls["app_import_stage"]
    assert calls["plain_one"] == {"p_a", "p_b"}


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
    exception turns a handled conflict into "Couldn't save that."

    PER MIGRATION, not over the concatenation. Searching ALL_SQL meant 0010's
    three `conflict: this application changed` lines satisfied the assertion on
    behalf of every other file -- so 0011's import-conflict message could have
    been reworded to anything and this stayed green. A guard one file can satisfy
    for another is not a guard (matrix rows 92, 130, 163).
    """
    pattern = re.compile(r"raise\s+exception\s+'(conflict|stale)", re.I)
    # Every migration that RAISES on an optimistic-concurrency check has to use
    # the word. Detected by the check itself rather than by a hand-kept list, so
    # a new migration with a conflict path is covered the day it lands.
    for m in MIGRATIONS:
        text = m.read_text()
        if "expected_updated_at" not in text and "p_expected" not in text:
            continue
        assert pattern.search(text), (
            f"{m.name} takes an expected-version argument but raises no "
            "'conflict'/'stale' message — supabase-source.ts will classify its "
            "refusal as a generic error and show the wrong toast"
        )


def test_job_key_is_never_computed_in_sql():
    """The rule 0011's own header states, with nothing enforcing it until now.

    `job_key` is computed in exactly two places -- `core/jobkeys.py` and
    `webapp/lib/import/job-key.ts` -- pinned to one golden fixture asserted from
    both languages. A THIRD implementation in SQL would need its own guard, and
    the failure it produces is silent: a key differing by one character makes
    every re-import a duplicate.

    So the only thing SQL may do with a job key is carry it in from the caller's
    payload and compare it. Any line that BUILDS one -- a `norm-`/`url-`/ats
    prefix concatenated together, or a `job_key :=` assignment -- is the third
    implementation arriving.
    """
    building = re.compile(
        r"job_key\s*:=|'(norm|url)-'\s*\|\||\|\|\s*'(norm|url)-'",
        re.I,
    )
    for m in MIGRATIONS:
        text = _strip_sql_comments(m.read_text())
        hit = building.search(text)
        assert not hit, (
            f"{m.name} looks like it computes a job key ({hit.group(0)!r}) — that is a "
            "third implementation of the most drift-prone function in the system, "
            "and the golden fixture guards only two"
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
#: Callable security-definer functions whose `revoke all … from public` does NOT
#: name `anon`/`authenticated`.
#:
#: Supabase's bootstrap grants execute on new functions to those roles BY NAME
#: (`alter default privileges … grant execute on functions to anon, authenticated`),
#: and revoking from `public` does not touch a grant made to a named role — so
#: every function here is reachable by an ANONYMOUS caller today. Each of them
#: rejects an anonymous session on its own (`auth.uid()` is null → raise), which is
#: why this is debt rather than an open door, and it is still the wrong shape: the
#: revoke is supposed to be what closes the door, not the function body.
#:
#: The list is asserted to be EXACTLY this set, in both directions. A new function
#: cannot join it silently, and fixing one means deleting its line. Closing the
#: remaining 21 is one clause each in the migration that defines them; it belongs
#: to those phases, not to a profile branch.
KNOWN_UNNAMED_REVOKES = frozenset({
    "app_add_note",
    "app_delete_view",
    "app_import_commit_chunk",
    "app_import_create",
    "app_import_discard",
    "app_import_preview",
    "app_import_report",
    "app_import_resolve",
    "app_import_set_included",
    "app_import_set_mapping",
    "app_import_stage",
    "app_import_undo",
    "app_propose_companies",
    "app_resolve_suggestion",
    "app_save_view",
    "app_set_company_flags",
    "app_set_company_review_bulk",
    "app_set_next_action",
    "app_set_status",
    "app_set_triage",
    "app_set_triage_bulk",
})


def _revoked_roles(name: str) -> str:
    revokes = re.findall(
        rf"revoke\s+all\s+on\s+function\s+public\.{name}\s*\([^)]*\)\s*\n?\s*"
        rf"from\s+([^;]+);",
        ALL_SQL,
        re.I | re.S,
    )
    assert revokes, f"{name}() is never revoked"
    return " ".join(revokes).lower()


@pytest.mark.parametrize("name", [n for n in CALLABLE if n not in KNOWN_UNNAMED_REVOKES])
def test_definer_revokes_name_the_roles_supabase_grants_to(name):
    """`revoke all … from public` alone closes nothing.

    The generic "revoked from public" check above passes on a function that
    `anon` can still call, because Supabase granted to `anon` by name. A mutant
    adding `grant execute … to anon` on `app_preview_corpus` survived that check
    — on the one function in the schema that deliberately bypasses RLS.

    `authenticated` is expected to be re-granted immediately afterwards; what
    matters is that the revoke NAMES both roles, so the grant that follows is the
    single explicit statement of who may call.
    """
    named = _revoked_roles(name)
    for role in ("public", "anon", "authenticated"):
        assert role in named, (
            f"{name}() is revoked from `{named.strip()}` — `{role}` is not named, and "
            "Supabase grants execute to it by name, so the door is still open"
        )


def test_the_unnamed_revoke_debt_list_is_exact():
    """A debt list that drifts is a debt list that hides a new offender.

    Both directions: nothing in `KNOWN_UNNAMED_REVOKES` may have been fixed
    without being removed from it, and nothing outside it may be missing its
    named roles.
    """
    actually_unnamed = {
        n for n in CALLABLE
        if not all(r in _revoked_roles(n) for r in ("public", "anon", "authenticated"))
    }
    assert actually_unnamed == set(KNOWN_UNNAMED_REVOKES), {
        "fixed but still listed": sorted(set(KNOWN_UNNAMED_REVOKES) - actually_unnamed),
        "unlisted and open": sorted(actually_unnamed - set(KNOWN_UNNAMED_REVOKES)),
    }


@pytest.mark.parametrize("name", CALLABLE)
def test_the_version_token_is_compared_as_an_instant(name):
    """A version token is an INSTANT, never two renderings of one compared as text.

    Matrix rows 146 and 168 are both that bug: PostgREST renders `+00:00`,
    `toISOString()` renders `Z`, and `to_jsonb` renders whatever the session's
    TimeZone says. One moment, three strings.

    Satisfied two ways, and both are in the schema: declare the parameter
    `timestamptz` (0003/0005/0010/0012), or take `text[]` for a parallel-array
    gesture and cast it — `p_expected_updated_at::timestamptz[]` — before any
    comparison (0006/0008). What is refused is a text token that reaches a
    comparison uncast, which nothing was checking for.
    """
    body = DEFINERS[name]
    params = re.search(r"\((.*?)\)\s*returns", body, re.S)
    assert params, f"could not parse {name}()'s parameters"
    for token, declared in re.findall(r"(p_expected\w*)\s+([\w\[\]]+)", params.group(1), re.I):
        if declared.lower().startswith("timestamptz"):
            continue
        assert re.search(rf"{token}\s*(\[i\])?\s*::\s*timestamptz", body, re.I), (
            f"{name}() declares {token} as {declared} and never casts it to timestamptz — "
            "two renderings of one instant will be compared as strings"
        )
