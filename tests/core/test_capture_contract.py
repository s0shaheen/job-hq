"""The capture row's shape, pinned across the four places it lives.

One classified Gmail event is described in four languages, and three of them have
no compiler that can see the fourth:

    core/schema.py                      HEADERS["email_events"] — the sheet tab
    appsscript/capture/Code.gs          the sender, PASTED into script.google.com
                                        with no CI, no typecheck, no local runtime
    webapp/lib/capture/schema.ts        the endpoint's closed-set validator
    db/migrations/0018_capture.sql      the columns and the CHECK constraints

`Code.gs` is the reason this file exists. It is the one component of this system
that lives outside the repo's gates: nothing builds it, nothing runs it, and a
field renamed in it is discovered when the endpoint rejects every event at 02:00
and the retry queue starts overflowing. A comment saying "keep in lockstep" has
sat above `EMAIL_EVENTS_HEADERS` since the file was written, and a comment is not
a mechanism (matrix rows 92, 130, 163, 192, 243 — the same finding five times).

So: parse all four, compare all four. `tests/fixtures/jobkeys.golden.json` and
`test_metro_names.py` are the shape being copied.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from core import schema

ROOT = Path(__file__).resolve().parents[2]
CODE_GS = (ROOT / "appsscript" / "capture" / "Code.gs").read_text()
TS = (ROOT / "webapp" / "lib" / "capture" / "schema.ts").read_text()
SQL = (ROOT / "db" / "migrations" / "0018_capture.sql").read_text()
GOLDEN = json.loads((ROOT / "tests" / "fixtures" / "capture-token.golden.json").read_text())

#: The two Email Events headers the SCRIPT has never written and the endpoint
#: refuses: they are stamped by `tracker/join.py` when it retires an event.
JOINER_OWNED = ("matched_key", "applied_status")

#: The one name that differs between the wire and the column, and why.
#: `from` is a reserved word in SQL; quoting it in every future query is a tax
#: paid forever for one column name. The rename happens once, in `parseEvent`.
WIRE_TO_COLUMN = {"from": "from_addr"}


def _call_args(src: str, fn: str) -> list[str]:
    """Every call to `fn(...)`, with its BALANCED argument text.

    `[^)]*` stops at the first close paren, which is wrong the moment an argument
    is itself a call — `getTabByGid_(SpreadsheetApp.openById(SHEET_ID), GID)` —
    and it reported a correct call as broken on the first run. Matrix row 92's
    shape, in a test that exists to catch exactly this kind of arity mistake.
    """
    out: list[str] = []
    needle = fn + "("
    at = src.find(needle)
    while at != -1:
        depth, i = 0, at + len(needle) - 1
        while i < len(src):
            if src[i] == "(":
                depth += 1
            elif src[i] == ")":
                depth -= 1
                if depth == 0:
                    out.append(src[at + len(needle) : i])
                    break
            i += 1
        at = src.find(needle, at + 1)
    return out


def _js_array(src: str, name: str) -> list[str]:
    """The string elements of a `const NAME = [ … ];` in JS/TS source."""
    m = re.search(rf"const {re.escape(name)}\s*=\s*\[(.*?)\]", src, re.S)
    assert m, f"no `const {name} = [...]` — did it move or get renamed?"
    return re.findall(r'"([^"]*)"', m.group(1))


def _sql_array(fn: str) -> list[str]:
    """The `array[...]` literal inside a `returns text[]` SQL function."""
    at = SQL.index(f"function public.{fn}(")
    body = SQL[at : SQL.index("$$;", at)]
    m = re.search(r"array\[(.*?)\]", body, re.S | re.I)
    assert m, f"no array literal in {fn}()"
    return re.findall(r"'([^']*)'", m.group(1))


def _insert_columns() -> list[str]:
    """The column list of 0018's `insert into public.email_events (...)`."""
    at = SQL.index("insert into public.email_events (")
    inner = SQL[at + len("insert into public.email_events (") : SQL.index(")", at)]
    return [c.strip() for c in inner.split(",") if c.strip()]


# ---------------------------------------------------------------- the header row

def test_the_apps_script_header_row_is_the_schemas():
    """`EMAIL_EVENTS_HEADERS` in Code.gs == `HEADERS["email_events"]`.

    Order too, not only membership. `appendAligned_` writes by header NAME so a
    reorder is harmless in the sheet — but this list is also the source of the
    POST field list below, and two lists that drift in order are two lists a
    reviewer will diff by eye and call identical.
    """
    assert _js_array(CODE_GS, "EMAIL_EVENTS_HEADERS") == schema.HEADERS["email_events"]


def test_the_post_fields_are_the_header_row_minus_the_joiners_two():
    """The wire contract IS the tab's row, minus the cells the sender never owns.

    Derived rather than restated: if a column is added to `HEADERS`, this test
    decides whether it belongs on the wire, and somebody has to say which.
    """
    expected = [h for h in schema.HEADERS["email_events"] if h not in JOINER_OWNED]
    assert _js_array(CODE_GS, "CAPTURE_POST_FIELDS") == expected


def test_the_endpoint_accepts_exactly_what_the_script_sends():
    """Code.gs's `CAPTURE_POST_FIELDS` == schema.ts's `EVENT_FIELDS`.

    The endpoint REJECTS unknown fields (documented in `schema.ts`), so this is
    not a style pin: a field on one side and not the other means every event in
    every batch comes back rejected, silently, until somebody reads the retry
    queue.
    """
    assert _js_array(CODE_GS, "CAPTURE_POST_FIELDS") == _js_array(TS, "EVENT_FIELDS")


def test_every_wire_field_reaches_a_real_column():
    """…and the one rename is declared here rather than discovered in production."""
    columns = set(_insert_columns())
    for field in _js_array(TS, "EVENT_FIELDS"):
        column = WIRE_TO_COLUMN.get(field, field)
        assert column in columns, (
            f"the wire carries {field!r} and 0018 inserts no {column!r} column — "
            f"either the column is missing or the rename belongs in WIRE_TO_COLUMN"
        )


def test_the_rename_map_is_exact():
    """A rename that has been undone must come OUT of the map.

    `KNOWN_UNNAMED_REVOKES`' shape: a list of exceptions nobody has to remove is a
    list that grows into a licence.
    """
    columns = set(_insert_columns())
    stale = [w for w in WIRE_TO_COLUMN if w in columns]
    assert not stale, f"{stale} exist as columns now — drop them from WIRE_TO_COLUMN"


def test_the_columns_the_function_inserts_all_exist_on_the_table():
    """The `insert into … (cols)` list against the `create table` body.

    plpgsql resolves column names at RUN time, so a typo here is a 42703 raised
    inside the per-row exception block — which means it comes back as a per-row
    `rejected` with a reason nobody reads, on EVERY row, forever. The one failure
    shape this whole endpoint is built to make impossible, arriving through the
    one construct that hides it.
    """
    at = SQL.index("create table public.email_events (")
    body = SQL[at : SQL.index("\n);", at)]
    declared = set(re.findall(r"^\s{2}(\w+)\s+(?:bigint|uuid|text|numeric|timestamptz)", body, re.M))
    missing = [c for c in _insert_columns() if c not in declared]
    assert not missing, {"inserted but not declared": missing, "declared": sorted(declared)}


# ---------------------------------------------------------------- the vocabulary

def test_the_event_type_vocabulary_is_one_list_in_four_languages():
    assert _js_array(CODE_GS, "EVENT_TYPES") == schema.EMAIL_EVENT_TYPES
    assert _js_array(TS, "EVENT_TYPES") == schema.EMAIL_EVENT_TYPES
    assert _sql_array("hq_email_event_types") == schema.EMAIL_EVENT_TYPES


def test_the_type_check_uses_the_function_rather_than_a_fifth_copy():
    """A CHECK spelling the seven strings again would be the copy this closes."""
    assert re.search(
        r"check\s*\(\s*event_type\s*=\s*any\s*\(\s*public\.hq_email_event_types\(\)\s*\)\s*\)",
        SQL,
    ), "email_events_type_is_known does not read hq_email_event_types()"


# ---------------------------------------------------------------- the credential

def test_the_token_shape_the_migration_mints_is_the_one_the_route_parses():
    """`hqc_<16 hex>_<64 hex>`, asserted from the SQL that builds it.

    The golden token is checked against this regexp AND against the route's own
    (in `capture-token.test.ts`), so the two ends of the credential agree on its
    grammar without either one generating the example.
    """
    assert "'hqc_' || v_selector || '_' || v_secret" in SQL, (
        "hq_mint_capture_token no longer composes the token this way"
    )
    # 16 hex from the left of a uuid, 64 from two more.
    assert "left(replace(gen_random_uuid()::text, '-', ''), 16)" in SQL
    assert re.fullmatch(r"hqc_[0-9a-f]{16}_[0-9a-f]{64}", GOLDEN["token"]), GOLDEN["token"]
    assert GOLDEN["token"] == f"hqc_{GOLDEN['selector']}_{GOLDEN['secret']}"


def test_the_digest_is_sha256_of_the_secret_half_and_nothing_else():
    """Python's answer for the golden secret, which SQL and TS are both held to.

    Three implementations of "the digest of this token" — `hashlib` here,
    `encode(sha256(convert_to(…,'UTF8')),'hex')` in the migration, `node:crypto`
    in the route. Two of them agreeing is a coincidence; all three agreeing on a
    constant none of them generated is a contract.
    """
    import hashlib

    assert hashlib.sha256(GOLDEN["secret"].encode("utf-8")).hexdigest() == GOLDEN["sha256"]
    assert "encode(sha256(convert_to(v_secret, 'UTF8')), 'hex')" in SQL


def test_the_script_never_carries_the_token_in_source():
    """Script Properties, never the file.

    `Code.gs` is pasted into a Google project whose source is readable by anybody
    with edit access to the account, and it is committed here in a public repo. A
    literal `hqc_…` in it is a credential in two places at once.
    """
    assert not re.search(r"hqc_[0-9a-f]{8}", CODE_GS), "a real capture token is in Code.gs"
    assert 'getProperty(CAPTURE_TOKEN_PROP)' in CODE_GS
    assert 'getProperty(CAPTURE_URL_PROP)' in CODE_GS


# ---------------------------------------------------------------- the dual-write

def test_the_sheet_append_still_happens_before_the_post():
    """Phase C2's whole contract in one ordering.

    The sheet is authoritative until phase D, so `appendAligned_` must run before
    anything is handed to the store, and the POST must be outside the per-message
    loop. Both are read off the source because there is no runtime here to observe
    them in.
    """
    body = CODE_GS[CODE_GS.index("function capturePass_(") : CODE_GS.index("function buildEvent_(")]
    append_at = body.index("appendAligned_(events, hmap, ev)")
    wire_at = body.index("fresh.push(wireEvent_(ev))")
    deliver_at = body.index("deliverToStore_(fresh, stats)")
    assert append_at < wire_at < deliver_at


def test_the_store_lane_cannot_throw_into_the_capture_run():
    """`deliverToStore_` swallows, `postChunk_` mutes HTTP exceptions.

    A store outage that threw here would ops-push, rethrow (the file does that on
    purpose so Google's trigger-failure mail fires), skip the heartbeat, and leave
    the run looking like Gmail capture itself had died — which is the one alarm in
    this system that means "statuses are not advancing".
    """
    body = CODE_GS[CODE_GS.index("function deliverToStore_(") : CODE_GS.index("function postChunk_(")]
    assert "try {" in body and "catch (err)" in body
    assert "throw" not in body
    post = CODE_GS[CODE_GS.index("function postChunk_(") : CODE_GS.index("function queueLoad_(")]
    assert "muteHttpExceptions: true" in post
    assert "throw" not in post


def test_every_truncation_goes_through_safe_truncate():
    """No bare `.slice(0, n)` may survive in the classification path.

    A `.slice` counts UTF-16 units, so it cuts emoji in half, and an unpaired
    surrogate makes the POST body invalid at the store's jsonb cast — above the
    per-row exception block, so the WHOLE batch is refused and then replayed at
    the front of the queue for weeks. Review measured it: `snippet` at 300 units
    plus five truncations in `llmClassify_`, every one reachable from ordinary
    recruiter mail.

    `webapp/tests/unit/capture-appsscript.test.ts` EXECUTES `safeTruncate_` and
    proves it never splits a pair. This proves it is the thing being called —
    reverting any one site is the killing mutation.
    """
    body = CODE_GS[CODE_GS.index("function buildEvent_(") : CODE_GS.index("function ruleClassify_(")]
    bare = re.findall(r"\.slice\(0,\s*\d+\)", body)
    assert not bare, (
        f"{len(bare)} bare truncation(s) left in the build/classify path: {bare} — "
        f"each one can cut an emoji in half and take the whole batch down"
    )
    # The helper really exists, so the assertion above cannot pass because
    # somebody deleted the code instead of fixing it.
    assert "function safeTruncate_(s, n)" in CODE_GS
    assert CODE_GS.count("safeTruncate_(") >= 8   # 7 call sites + the definition


def test_the_two_stores_are_separate_and_both_bounded():
    """The retry queue and the refusals pen are different properties.

    Review found the documented mitigation false: a per-row `rejected` arrives
    inside a 200, `postChunk_` returned true, and the rows were dropped with no
    queue entry, no counter and no push — while three documents said the queue
    held them. They are held in their own store now, and the reason it is a SECOND
    store is that a refused row may never sit in front of fresh mail.
    """
    for name in ("HQ_CAPTURE_QUEUE", "HQ_CAPTURE_PARKED"):
        assert name in CODE_GS
    for bound in ("CAPTURE_QUEUE_MAX_EVENTS", "CAPTURE_QUEUE_MAX_CHARS",
                  "CAPTURE_PARKED_MAX_EVENTS", "CAPTURE_PARKED_MAX_CHARS"):
        assert re.search(rf"const {bound} = \d+;", CODE_GS), bound
    body = CODE_GS[CODE_GS.index("function deliverToStore_(") : CODE_GS.index("function postChunk_(")]
    # The pen is drained AFTER the transport queue.
    assert body.index("queueLoad_()") < body.index("if (!down && parked.length)")
    # A refusal is never promoted into the transport queue.
    assert "queueSave_(failed)" in body and "parkedSave_(refused)" in body


def test_a_rejected_row_is_retained_and_reported():
    """The claim `schema.ts`, the README and matrix row 277 all make, enforced.

    `postChunk_` has to read the 2xx body — a 200 carrying `rejected` is the
    deploy-order hazard arriving, and it used to produce a Logger line nobody
    reads. Killing mutation: delete the park branch, and this goes red beside the
    store test above.
    """
    post = CODE_GS[CODE_GS.index("function postChunk_(") : CODE_GS.index("function rejectedFrom_(")]
    assert "refused: rejectedFrom_(chunk, text)" in post
    # 401/403 QUEUE (a rotation mid-paste); any other 4xx PARKS, because a request
    # shaped like that will never be accepted — which is also what finally makes
    # the documented 413/400 split mean something instead of resending the
    # identical chunk at the identical size forever.
    assert "code === 401 || code === 403" in post
    report = CODE_GS[CODE_GS.index("function captureBacklogReport_(") :
                     CODE_GS.index("function alertOncePerDay_(")]
    # The GUARD, not merely the word. Asserting `"stats.parked" in report` passed
    # a mutant that replaced the branch condition with `false` — the identifier
    # survived inside the now-dead push. A source-text test has to pin the line
    # that decides, or it pins nothing.
    assert "if (stats.parked) {" in report, "the refusal push is not reached by stats.parked"
    assert "if (stats.dropped) {" in report, "the eviction push is not reached by stats.dropped"
    assert "stats.reason" in report and "opsPush_" in report


def test_each_alert_kind_has_its_own_latch_slot():
    """One property per kind, and the key is the DAY — nothing that grows.

    THE BEHAVIOUR is asserted where it can be executed:
    `webapp/tests/unit/capture-appsscript.test.ts` evaluates
    `captureBacklogReport_` out of this file with stubbed Google globals and
    COUNTS the pushes over eight same-day runs. This test only pins the two facts
    a source read can honestly establish, and it exists because the version it
    replaces asserted `report.count("alertOncePerDay_(") == 2` — a call-site
    count, which a latch that does not latch satisfies perfectly. It did not
    latch: 6 pushes over 8 runs of a drop storm, 9 over 6 of the refusal storm,
    because the key carried a running total and both kinds shared one slot.

    Counting call sites is the exact defect this branch names three tests later
    in its own words: a source-text test has to pin the line that decides.
    """
    assert "function alertOncePerDay_(slot, send)" in CODE_GS, (
        "the latch takes a message again — the parameter names are the tell. "
        "`send` is the push itself, because the latch may only be stamped by a "
        "push that DELIVERED (C2 review P-1)."
    )
    for slot in ("CAPTURE_ALERT_DROPPED_PROP", "CAPTURE_ALERT_PARKED_PROP"):
        assert re.search(rf'const {slot} = "HQ_CAPTURE_ALERT_\w+";', CODE_GS), slot
    latch = CODE_GS[CODE_GS.index("function alertOncePerDay_(") :]
    latch = latch[: latch.index("\n}")]
    # The stored value is the day and only the day. A `+` in there is how a count
    # gets back in.
    assert "props.getProperty(slot) === today" in latch
    assert "props.setProperty(slot, today)" in latch
    # P-1: `ntfy_` swallowed everything and never read the response, so an ntfy
    # blip at the moment of the day's only alert set the latch, deleted the
    # running count, and suppressed every same-day retry. The order below is the
    # fix: send FIRST, stamp only on a 2xx. `webapp/tests/unit/capture-appsscript.test.ts`
    # executes it; this pins the line that decides.
    assert "const code = send();" in latch
    assert "code >= 200 && code < 300" in latch
    assert latch.index("const code = send();") < latch.index("props.setProperty(slot, today)")


def test_the_backlog_report_cannot_throw_either():
    """It is called from `runCapture` and `backfill` OUTSIDE any local try, in the
    section whose first line is "nothing here may throw" — so a PropertiesService
    hiccup inside it rethrew, ops-pushed "HQ capture failed" and fired Google's
    trigger-failure mail: the "Gmail capture itself died" alarm this section
    exists to prevent. The contract test only read `deliverToStore_` and
    `postChunk_`, so it could not see it."""
    body = CODE_GS[CODE_GS.index("function captureBacklogReport_(") :
                   CODE_GS.index("function alertOncePerDay_(")]
    assert body.index("try {") < body.index("if (!stats) return;")
    assert "catch (err)" in body
    assert "throw" not in body


def test_the_pipeline_tab_lookup_passes_both_arguments():
    """`getTabByGid_(ss, gid)` — the instant Feed->Pipeline promote called it with
    ONE argument since the day it was written, so `ss` was the number 0,
    `ss.getSheets()` threw into the edit trigger's own catch, and the feature has
    never run. Silent for the life of the file, carried the whole time by the
    2-hourly Python `promote`. Pre-existing on main; fixed here because it is four
    lines from the code C2 touches."""
    for args in _call_args(CODE_GS, "getTabByGid_"):
        assert "," in args, f"getTabByGid_({args}) passes one argument; it takes (ss, gid)"


@pytest.mark.parametrize("prop", ["HQ_CAPTURE_URL", "HQ_CAPTURE_TOKEN"])
def test_the_lane_is_off_without_its_script_properties(prop):
    """Named here so `appsscript/README.md`'s provisioning step cannot drift from
    the code that reads them — the failure being a step somebody follows exactly
    and a lane that stays silently off."""
    assert prop in CODE_GS
    assert prop in (ROOT / "appsscript" / "README.md").read_text()
