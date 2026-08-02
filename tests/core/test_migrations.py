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


#: Migration numbers deliberately skipped on this branch, and by whom.
#:
#: The contiguity rule below exists because a gap normally means somebody's
#: migration never got committed. Parallel branches cut from one commit break
#: that assumption honestly: two sessions each claim a number up front so they
#: cannot collide on merge, and until both land the tree has a hole in it.
#:
#: Asserted EXACT in both directions, the `KNOWN_UNNAMED_REVOKES` shape: an
#: UNDECLARED gap still fails, and the day the reserved migration lands this list
#: goes red until its line is deleted. A reservation nobody has to remove is a
#: reservation that turns back into the silent hole it was standing in for.
RESERVED_MIGRATION_NUMBERS: dict[int, str] = {
    # 13 was reserved for the referral-finder branch; it merged (#81) and the
    # reservation came out the same hour — the mechanism working as designed.
    #
    # 20–24 were the redesign's prerequisite spine (docs 07 §4), five branches cut
    # from the same commit. E5 claimed 25 rather than 20 so that the four ahead of
    # it keep the numbers they were planned with; a reservation is cheap and
    # renumbering four branches mid-flight is not. 20 (#94), 23 (#102), and this
    # branch's 21 came out as each landed — the mechanism working as designed.
    22: "E1 — email events into Postgres",
    24: "phase 0, if the owner takes that fork",
}


def test_migrations_are_contiguously_numbered():
    """A gap means someone's migration never got committed — unless it is reserved."""
    numbers = [int(m.name.split("_", 1)[0]) for m in MIGRATIONS]
    assert numbers == sorted(set(numbers)), f"duplicate or unsorted migration numbers: {numbers}"
    expected = [n for n in range(1, max(numbers) + 1) if n not in RESERVED_MIGRATION_NUMBERS]
    assert numbers == expected, {
        "found": numbers,
        "expected": expected,
        "reserved": RESERVED_MIGRATION_NUMBERS,
    }


def test_the_reserved_migration_list_is_exact():
    """A reserved number that has LANDED must be removed from the list.

    Without this, `RESERVED_MIGRATION_NUMBERS` would grow into a permanent
    licence to skip numbers, and the next real hole would hide inside it.
    """
    present = {int(m.name.split("_", 1)[0]) for m in MIGRATIONS}
    landed = sorted(present & set(RESERVED_MIGRATION_NUMBERS))
    assert not landed, (
        f"migration(s) {landed} exist but are still listed as reserved — "
        "delete their lines from RESERVED_MIGRATION_NUMBERS"
    )


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
    """Parameter names declared for a function, in order — from its LAST definition.

    Migrations are applied in order, so a later file redefining a function is
    what the database ends up with; reading the first definition is reading
    history. 0017 grows `app_upsert_answer` two parameters that 0014 does not
    declare, and a first-match read would have compared the web app's call
    against the signature the migration before it replaced — reporting the
    correct code as broken, or (with the arguments the other way round) missing a
    real drift. Same class as row 92: a drift guard that cannot see what it
    guards.
    """
    matches = list(
        re.finditer(
            rf"create\s+or\s+replace\s+function\s+public\.{name}\s*\((.*?)\)\s*returns",
            sql,
            re.S | re.I,
        )
    )
    if not matches:
        return None
    return re.findall(r"(p_\w+)", matches[-1].group(1))


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


def test_the_capture_rpc_the_endpoint_calls_exists_and_takes_what_it_is_passed():
    """The same contract, for the RPC that lives OUTSIDE `supabase-source.ts`.

    `RPC_CALLS` is parsed from the data source, and `/api/capture` deliberately
    does not go through it — the data source is session-scoped and RLS-bound, and
    this caller is a bearer token with the service role
    (`webapp/lib/supabase/service.ts` argues it). Which means the one guard that
    would have caught a typo in the function name does not look at this call at
    all: the vitest suite drives a fake store, the db suite calls the SQL directly,
    and the string between them is checked by nothing. Exactly the gap
    `test_the_join_rpc_…` was written for, on a new caller.
    """
    src = (ROOT / "webapp" / "lib" / "supabase" / "service.ts").read_text()
    m = re.search(r'CAPTURE_RPC\s*=\s*"(\w+)"', src)
    assert m, "no CAPTURE_RPC constant in webapp/lib/supabase/service.ts — did it move?"
    fn = m.group(1)

    declared = set(_sql_function_params(ALL_SQL, fn) or [])
    assert declared, (
        f"/api/capture calls {fn}() but no migration defines it — every POSTed "
        f"batch would 404 into the script's retry queue and pile up there"
    )
    body = src[src.index("async storeEvents(") : src.index("if (error)", src.index("async storeEvents("))]
    passed = set(re.findall(r"(p_\w+):", body))
    assert passed, "no p_* arguments found in storeEvents() — parser out of date?"
    # EQUALITY for the engine's own RPCs (this app owns both ends): an argument
    # the function does not declare fails to resolve the overload at all, and one
    # the function declares that the caller stops passing is worse because it is
    # silent — `p_token_id` going missing loses the credential's proof of life
    # with every test still green.
    assert passed == declared, {
        "passed but not declared": sorted(passed - declared),
        "declared but not passed": sorted(declared - passed),
    }


def test_the_digest_rpc_the_landing_page_calls_exists_and_takes_what_it_is_passed():
    """The same contract, for the RPC behind `POST /d/<token>` (SHEET-SUNSET C3).

    `DIGEST_RPC` is a string handed to `supabase.rpc()` from a module the parser
    above does not read — `RPC_CALLS` comes from `supabase-source.ts`, and this
    caller deliberately does not go through the session-scoped data source. So the
    same gap the capture RPC has: the vitest suite drives a fake store, the db
    suite calls the SQL directly, and the string between them is checked by nothing
    else. A typo here is a 404 on a link somebody already has in their inbox.
    """
    src = (ROOT / "webapp" / "lib" / "supabase" / "service.ts").read_text()
    m = re.search(r'DIGEST_RPC\s*=\s*"(\w+)"', src)
    assert m, "no DIGEST_RPC constant in webapp/lib/supabase/service.ts — did it move?"
    fn = m.group(1)

    declared = set(_sql_function_params(ALL_SQL, fn) or [])
    assert declared, f"/d/<token> calls {fn}() but no migration defines it"
    body = src[src.index("async setTriage(") : src.index("if (error)", src.index("async setTriage("))]
    passed = set(re.findall(r"(p_\w+):", body))
    assert passed, "no p_* arguments found in setTriage() — parser out of date?"
    # EQUALITY, the engine-owns-both-ends rule: an undeclared argument fails to
    # resolve the overload at all, and one the function declares that the caller
    # stops passing is worse because it is silent — `p_idem` going missing would
    # turn every replay into a second write.
    assert passed == declared, {
        "passed but not declared": sorted(passed - declared),
        "declared but not passed": sorted(declared - passed),
    }


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


def test_the_seed_rpc_the_engine_calls_exists_and_takes_what_it_is_passed():
    """`tracker.pgseed`'s half of the same contract the join RPC gets."""
    import inspect

    from tracker import pgseed

    declared = set(_sql_function_params(ALL_SQL, pgseed.PG_SEED_FN) or [])
    assert declared, f"tracker.pgseed calls {pgseed.PG_SEED_FN}() but no migration defines it"
    passed = set(re.findall(r'"(p_\w+)":', inspect.getsource(pgseed.seed)))
    assert passed == declared, {
        "passed but not declared": sorted(passed - declared),
        "declared but not passed": sorted(declared - passed),
    }


def test_the_engine_only_rpcs_are_not_reachable_from_a_browser():
    """0009's two functions stamp a reliability tier and write audit events, and neither is a
    human gesture. 0015's takes the acting user as an ARGUMENT, so reachable from a browser it
    would let any session advance anyone else's pipeline. Supabase's default privileges grant
    execute on new functions to `anon` and `authenticated`, so `revoke from public` alone leaves
    both doors open — the revoke has to name the roles. Pinned here because the db suite can only
    prove it for a role it can `set role` to, and this is cheap and total."""
    for fn in ("reconcile_grounded_company", "note_grounding_blocked",
               "hq_apply_email_event", "hq_upsert_sheet_application",
               "hq_note_unapplied_event", "hq_fill_linkedin_company_id",
               # 0021's domain twin of the linkedin fill — same posture: takes the
               # acting user as an argument, writes a column every watcher reads.
               "hq_fill_domain",
               # 0018's four. `hq_capture_email_events` takes the acting user as an
               # argument the same way the join RPC does; the three token functions
               # MINT AND REVOKE A CREDENTIAL, which is the one thing on this list
               # a browser reaching it could turn into permanent access.
               "hq_capture_email_events", "hq_mint_capture_token",
               "hq_revoke_capture_tokens", "hq_rotate_capture_token",
               # 0019's. It takes the acting user as an argument because the
               # caller learned that user from an HMAC signature and not from a
               # session; reachable from a browser it would let any signed-in
               # visitor triage anybody's queue.
               "hq_digest_set_triage"):
        revokes = re.findall(rf"revoke\s+all\s+on\s+function\s+public\.{fn}\s*\([^)]*\)\s*\n?\s*"
                             rf"from\s+([^;]+);", ALL_SQL, re.I)
        assert revokes, f"{fn}() is never revoked"
        named = revokes[0].lower()
        for role in ("public", "anon", "authenticated"):
            assert role in named, f"{fn}() is not revoked from {role} — a browser can call it"


def test_the_join_rpc_the_engine_calls_exists_and_takes_what_it_is_passed():
    """The same contract, for Phase C's second engine RPC (`tracker/join.py`).

    `PG_APPLY_FN` is a string handed to `core.pg.rpc`, so a typo is a 404 in the middle of
    the 2-hourly tracker chain and nothing else — and the unit suite cannot catch it, because
    it monkeypatches the RPC, while the db suite calls the SQL function directly and never
    through the constant. Two suites, one contract, and it lives between them.
    """
    import inspect

    from tracker import join

    declared = set(_sql_function_params(ALL_SQL, join.PG_APPLY_FN) or [])
    assert declared, (
        f"tracker.join calls {join.PG_APPLY_FN}() but no migration defines it — "
        f"every matched email event would 404 and the store would never advance"
    )
    passed = set(re.findall(r'"(p_\w+)":', inspect.getsource(join._pg_apply)))
    assert passed, "no p_* arguments found in _pg_apply() — parser out of date?"
    # EQUALITY, not `passed <= declared`, and only for the engine's own RPCs (the
    # engine owns both ends; a webapp call may legitimately lean on a default).
    #
    # Both directions are live failures. An argument the function does not declare
    # fails to resolve it at all — PostgREST matches overloads by name — so the
    # tracker chain 404s at 02:31. And an argument the function declares that the
    # caller stops passing is worse, because it is SILENT: `p_current_status` /
    # `p_current_actor` are how the store learns that a human claimed the sheet row,
    # and a call that quietly omitted them would go back to advancing over somebody's
    # Offer with every test still green.
    assert passed == declared, {
        "passed but not declared": sorted(passed - declared),
        "declared but not passed": sorted(declared - passed),
    }


def _sql_function_body(sql: str, name: str) -> str:
    """The `$$ … $$` body of one function, so an outcome vocabulary can be read per
    function instead of per FILE — 0015 defines two engine RPCs with two different
    vocabularies, and scanning the whole file mixes them."""
    m = re.search(rf"create\s+or\s+replace\s+function\s+public\.{name}\s*\(.*?\$\$(.*?)\$\$",
                  sql, re.S | re.I)
    assert m, f"could not find {name}()'s body"
    return m.group(1)


def _outcomes(body: str) -> set[str]:
    return (set(re.findall(r"'outcome',\s*'(\w+)'", body))
            # the applied paths assign v_outcome rather than inlining it
            | set(re.findall(r"v_outcome\s*:=\s*'(\w+)'", body)))


@pytest.mark.parametrize("module,attr,fn,migration", [
    ("tracker.join", "PG_OUTCOMES", "hq_apply_email_event", "0015_engine_writes.sql"),
    ("tracker.pgseed", "PG_SEED_OUTCOMES", "hq_upsert_sheet_application",
     "0015_engine_writes.sql"),
    ("monitor.linkedin_backfill", "FILL_OUTCOMES", "hq_fill_linkedin_company_id",
     "0016_linkedin_fill.sql"),
    ("monitor.linkedin_backfill", "DOMAIN_FILL_OUTCOMES", "hq_fill_domain",
     "0021_company_domain.sql"),
], ids=lambda v: str(v))
def test_the_outcome_vocabulary_is_the_same_on_both_sides_of_the_wire(
        module, attr, fn, migration):
    """The engine branches on the strings these functions return, and nothing
    checked that the two agree.

    Renaming an outcome in SQL is caught only by the db suite; ADDING one was caught
    by nothing at all and would have been counted as a successful write — the number
    that tells the operator whether the two stores agree. Parsed from the migration,
    so the pin cannot go stale in the direction that matters.

    The migration FILE is a parameter, not a constant: 0016 defines a third engine
    RPC with a third vocabulary, and reading one hardcoded file would have quietly
    excused it from the check that exists for exactly this.
    """
    import importlib

    sql = _strip_sql_comments((ROOT / "db" / "migrations" / migration).read_text())
    declared = _outcomes(_sql_function_body(sql, fn))
    expected = set(getattr(importlib.import_module(module), attr))
    assert declared, f"no outcome literals found in {fn}() — parser out of date?"
    assert declared == expected, {
        "sql returns but python does not classify": sorted(declared - expected),
        "python expects but sql cannot return": sorted(expected - declared),
    }


def test_the_engine_vocabularies_really_are_different():
    """Non-vacuity for the parse above: if `_sql_function_body` silently returned
    the whole file, the two 0015 cases would compare the same union and pass
    together."""
    from monitor import linkedin_backfill
    from tracker import join, pgseed
    assert set(join.PG_OUTCOMES) != set(pgseed.PG_SEED_OUTCOMES)
    assert set(join.PG_NOTHING_TO_APPLY) < set(join.PG_OUTCOMES)
    assert set(linkedin_backfill.FILL_OUTCOMES) not in (
        set(join.PG_OUTCOMES), set(pgseed.PG_SEED_OUTCOMES))


def test_the_linkedin_fill_rpc_the_engine_calls_exists_and_takes_what_it_is_passed():
    """The same contract, for the referral finder's engine RPC (0016).

    Two lanes call it — `monitor.wide`'s free harvest and `monitor.linkedin_backfill`'s
    probe — through one `fill()`, so a typo in `FILL_FN` is a 404 in both at once and
    the ids simply stop appearing. The unit suite monkeypatches the RPC and the db
    suite calls the SQL directly, so the constant itself is only checked here.
    """
    import inspect

    from monitor import linkedin_backfill

    declared = set(_sql_function_params(ALL_SQL, linkedin_backfill.FILL_FN) or [])
    assert declared, (
        f"monitor.linkedin_backfill calls {linkedin_backfill.FILL_FN}() but no migration "
        f"defines it — every harvested id would 404 into nothing"
    )
    passed = set(re.findall(r'"(p_\w+)":', inspect.getsource(linkedin_backfill.fill)))
    # EQUALITY, the engine-owned-both-ends rule: an undeclared argument fails to
    # resolve the function at all (PostgREST matches overloads by name), and a
    # declared one the caller stops passing is worse because it is silent.
    assert passed == declared, {
        "passed but not declared": sorted(passed - declared),
        "declared but not passed": sorted(declared - passed),
    }


def test_the_domain_fill_rpc_the_engine_calls_exists_and_takes_what_it_is_passed():
    """The same contract, for the LogoAvatar's engine RPC (0021).

    The domain harvest rides the SAME wide sweep as the id harvest, through
    `fill_domains`, so a typo in `DOMAIN_FILL_FN` is a 404 that stops domains
    appearing while every other test stays green — the unit suite monkeypatches the
    RPC and the db suite calls the SQL directly, so the constant is only checked here.
    """
    import inspect

    from monitor import linkedin_backfill

    declared = set(_sql_function_params(ALL_SQL, linkedin_backfill.DOMAIN_FILL_FN) or [])
    assert declared, (
        f"monitor.linkedin_backfill calls {linkedin_backfill.DOMAIN_FILL_FN}() but no "
        f"migration defines it — every harvested domain would 404 into nothing"
    )
    passed = set(re.findall(r'"(p_\w+)":', inspect.getsource(linkedin_backfill.fill_domains)))
    # EQUALITY, the engine-owned-both-ends rule (see the linkedin fill above).
    assert passed == declared, {
        "passed but not declared": sorted(passed - declared),
        "declared but not passed": sorted(declared - passed),
    }


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


@pytest.mark.parametrize("name", CALLABLE)
def test_definer_functions_are_granted_only_to_authenticated(name):
    """The check above reads the REVOKE. Nothing read the GRANT.

    An adversarial review added `grant execute … to authenticated, anon` on a
    0014 function and every gate stayed green: `test_definer_revokes_name_the_roles…`
    is satisfied by the revoke line that precedes it, and a grant on the next line
    hands the door straight back. That is the same mutant class the
    `KNOWN_UNNAMED_REVOKES` docstring records surviving on `app_preview_corpus` —
    found once, guarded on one side only.

    `service_role` is allowed: it bypasses RLS anyway and a token route granting
    to it is a deliberate act, not an accident. `anon` and `public` are not.
    """
    grants = re.findall(
        rf"grant\s+execute\s+on\s+function\s+public\.{name}\s*\([^)]*\)\s*\n?\s*to\s+([^;]+);",
        ALL_SQL,
        re.I | re.S,
    )
    assert grants, f"{name}() is never granted to anything — the app cannot call it"
    for clause in grants:
        roles = {r.strip().lower() for r in clause.split(",")}
        assert not (roles & {"anon", "public"}), (
            f"{name}() is granted to {sorted(roles & {'anon', 'public'})} — "
            "an anonymous caller can execute a security-definer function"
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
