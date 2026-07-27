"""The import write path, actually executed against Postgres (migration 0011).

`tests/core/test_migrations.py` reads the SQL as text; it catches a function
nobody defined and cannot catch a logic error. Everything here RUNS.

What it proves that reading the migration cannot:

    AC 20  a file imported twice adds its rows once
    AC 21  undo puts back exactly what the batch wrote, and nothing else
    AC 23  a stale round-trip version cannot overwrite a newer edit — refused by
           the DATABASE, so a bad deploy of the wizard cannot write anyway
    row 28 a weak-keyed row NEVER merges into somebody's real application
    row 32 undo is idempotent on its key and refuses past the 24h window
    row 33 undo keeps rows the user edited after the import, and lists them
    row 43 an imported status never becomes an untouchable invented status
    0010's lock — a bulk import does not claim it, does not break it, and a
           round trip carrying the row's own version token does claim it

Run locally with a throwaway Postgres:

    docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
    DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres \\
      uv run --python 3.11 --with-requirements requirements.txt \\
      --with 'psycopg[binary]' --no-project -- pytest tests/db -q
"""
from __future__ import annotations

import json
import os
import re
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
    make_posting,
    make_user,
    schema,  # noqa: F401 — session fixture
)

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


@pytest.fixture
def user(conn):
    uid = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, uid)
    return uid


# ------------------------------------------------------------------ helpers
#
# These deliberately mirror what `webapp/lib/data/supabase-source.ts` sends, one
# argument for one argument. A helper that is kinder than the caller — filling a
# default the app never fills, say — is the fake-kinder-than-real disease with a
# different filename.


def create_batch(conn, *, filename="tracker.xlsx", kind="xlsx", rows=0, digest="", idem=None):
    idem = idem or str(uuid.uuid4())
    row = conn.execute(
        "select public.app_import_create(%s, %s, %s, %s, %s)",
        (idem, filename, kind, digest, rows),
    ).fetchone()[0]
    return row["id"]


def stage(conn, batch, rows):
    """rows: [(row_number, {header: value})]"""
    payload = [{"row_number": n, "raw": raw} for n, raw in rows]
    return conn.execute(
        "select public.app_import_stage(%s, %s)", (batch, json.dumps(payload))
    ).fetchone()[0]


def apply_mapping(conn, batch, rows, mapping=None, final=True, expected=None):
    """rows: [(row_number, mapped_dict, job_key, key_strength)]"""
    payload = [
        {"row_number": n, "mapped": mapped, "job_key": key, "key_strength": strength}
        for n, mapped, key, strength in rows
    ]
    return conn.execute(
        "select public.app_import_set_mapping(%s, %s, %s, %s, %s)",
        (batch, json.dumps(payload), json.dumps(mapping or {}), final, expected),
    ).fetchone()[0]


def preview(conn, batch):
    return conn.execute("select public.app_import_preview(%s)", (batch,)).fetchone()[0]


def commit(conn, batch, limit=200, idem=None):
    return conn.execute(
        "select public.app_import_commit_chunk(%s, %s, %s)",
        (batch, limit, idem or str(uuid.uuid4())),
    ).fetchone()[0]


def undo(conn, batch, idem=None):
    return conn.execute(
        "select public.app_import_undo(%s, %s)", (batch, idem or str(uuid.uuid4()))
    ).fetchone()[0]


def import_file(conn, rows, *, mapping=None, digest="", limit=200):
    """The whole pipeline for a list of `(mapped, job_key, strength)` tuples."""
    batch = create_batch(conn, rows=len(rows), digest=digest)
    stage(conn, batch, [(i + 1, {"raw": str(i)}) for i in range(len(rows))])
    apply_mapping(
        conn, batch,
        [(i + 1, m, k, s) for i, (m, k, s) in enumerate(rows)],
        mapping=mapping,
    )
    preview(conn, batch)
    result = commit(conn, batch, limit=limit)
    return batch, result


def apps(conn, user_id):
    return conn.execute(
        """select id, company, title, status, status_actor, next_action,
                  applied_date, import_batch_id
             from public.applications where user_id = %s order by id""",
        (user_id,),
    ).fetchall()


def row_states(conn, batch):
    return dict(
        conn.execute(
            "select row_number, match_kind from public.import_rows where batch_id = %s",
            (batch,),
        ).fetchall()
    )


def GH(n):  # a strong, ATS-derived key
    return f"greenhouse-{n}"


def NORM(company, title):  # what jobkeys.py builds when there is no ATS id
    return f"norm-{company}|{title}|"


# ---------------------------------------------------------------- AC 20

def test_a_clean_file_imports_every_row(conn, user):
    rows = [
        ({"company": f"Company {i}", "title": "Product Manager",
          "status": "Applied", "appliedDate": "2026-07-01"}, GH(1000 + i), "strong")
        for i in range(40)
    ]
    batch, result = import_file(conn, rows)
    assert result["created"] == 40, result
    assert result["remaining"] == 0
    assert len(apps(conn, user)) == 40
    assert result["batch"]["state"] == "committed"
    # Every created row is attributable to the batch that made it, which is the
    # only reason undo can find them.
    assert all(a[7] is not None for a in apps(conn, user))


def test_importing_the_same_file_again_adds_nothing(conn, user):
    """AC 20's other half, and the one people actually hit: a second import of
    the same spreadsheet must recognise its own rows rather than double them."""
    rows = [
        ({"company": f"Company {i}", "title": "Product Manager", "status": "Applied"},
         GH(2000 + i), "strong")
        for i in range(10)
    ]
    import_file(conn, rows)
    assert len(apps(conn, user)) == 10

    batch2, result2 = import_file(conn, rows)
    assert result2["created"] == 0, "a re-import created rows — every re-import doubles the pipeline"
    assert result2["updated"] == 10
    assert len(apps(conn, user)) == 10
    assert set(row_states(conn, batch2).values()) == {"matches-existing"}


def test_two_identical_rows_inside_one_file_import_once(conn, user):
    rows = [
        ({"company": "Ramp", "title": "PM", "status": "Applied"}, GH(3001), "strong"),
        ({"company": "Ramp", "title": "PM", "status": "Screen"}, GH(3001), "strong"),
    ]
    batch, result = import_file(conn, rows)
    assert result["created"] == 1
    assert result["skipped"] == 1
    assert row_states(conn, batch)[2] == "duplicate-in-file"
    # First wins: the second row's later status did not overwrite it.
    assert apps(conn, user)[0][3] == "Applied"


# ------------------------------------------------------- weak keys never merge

def test_a_weak_key_never_merges_into_an_existing_application(conn, user):
    """Row 28. `isStrong()` is the only merge authorisation there is.

    A `norm-` key is a normalised guess at a company and a title. Two roles with
    the same title at the same company is not a hypothetical, and a merge is
    unrecoverable where a duplicate is merely untidy.
    """
    conn.execute(
        """insert into public.applications (user_id, company, title, status, notes)
           values (%s, 'Ramp', 'Product Manager', 'Interview', 'my real notes')""",
        (user,),
    )
    before = apps(conn, user)[0]

    batch, result = import_file(conn, [
        ({"company": "Ramp", "title": "Product Manager", "status": "Applied"},
         NORM("ramp", "product-manager"), "weak"),
    ])

    assert row_states(conn, batch)[1] == "suggestion"
    after = [a for a in apps(conn, user) if a[0] == before[0]][0]
    assert after[3] == "Interview", "a weak key overwrote a real application's status"
    # The suggestion is inserted separately — except that this one collides with
    # the existing row's (company, title) on 0002's manual-dedup index, so it is
    # SKIPPED rather than duplicated. Both outcomes are correct; what must never
    # happen is the update.
    assert result["updated"] == 0
    notice = conn.execute(
        "select notice from public.import_rows where batch_id = %s and row_number = 1",
        (batch,),
    ).fetchone()[0]
    assert "prove" in notice, "the suggestion is unflagged — the user is never told"


def test_a_suggestion_really_is_inserted_separately_when_it_can_be(conn, user):
    """The outcome the docs promised and no test showed.

    The case above ends in `skipped`, because its look-alike has the same
    (company, title) with no posting_key and `applications_manual_dedup` (0002)
    forbids a second one. That is correct, and it meant the "inserted separately"
    half of the rule had never been executed anywhere.

    Here the existing row CAME FROM THE SWEEP -- it carries a posting_key -- so the
    partial index does not apply and the suggestion lands as its own row: two
    applications, the original untouched, the new one flagged. That is the whole
    point of refusing to merge on a weak key.
    """
    key = make_posting(conn, GH(9600))
    conn.execute(
        """insert into public.applications
             (user_id, posting_key, company, title, status, notes)
           values (%s, %s, 'Ramp', 'Product Manager', 'Interview', 'my real notes')""",
        (user, key),
    )
    before = apps(conn, user)[0]

    batch, result = import_file(conn, [
        ({"company": "Ramp", "title": "Product Manager", "status": "Applied"},
         NORM("ramp", "product-manager"), "weak"),
    ])

    assert row_states(conn, batch)[1] == "suggestion"
    assert result["updated"] == 0, "a weak key merged"
    assert result["created"] == 1, "the suggestion was not inserted separately"
    rows = apps(conn, user)
    assert len(rows) == 2
    kept = [a for a in rows if a[0] == before[0]][0]
    assert kept[3] == "Interview", "the existing row was touched"
    notice = conn.execute(
        "select notice from public.import_rows where batch_id = %s and row_number = 1",
        (batch,),
    ).fetchone()[0]
    assert "prove" in notice


def test_a_weak_key_with_nothing_to_match_is_imported(conn, user):
    batch, result = import_file(conn, [
        ({"company": "Unheard Of Inc", "title": "PM", "status": "Applied"},
         NORM("unheard-of-inc", "pm"), "weak"),
    ])
    assert row_states(conn, batch)[1] == "unkeyable"
    assert result["created"] == 1


# ------------------------------------------------------- the human-status lock

def test_a_bulk_import_does_not_overwrite_a_status_a_human_chose(conn, user):
    """0010's lock, from the one direction 0011 introduces.

    Two things have to hold at once and only one is obvious. The status must
    survive — and the CHUNK must survive, because the trigger raises 42501 and
    an unguarded write would take 199 innocent rows down with it.
    """
    conn.execute(
        """insert into public.applications (user_id, company, title, status, status_actor)
           values (%s, 'Ramp', 'PM', 'Offer', 'user')""",
        (user,),
    )
    batch, result = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Rejected",
          "nextAction": "chase recruiter"}, GH(4001), "strong"),
        ({"company": "Other", "title": "PM", "status": "Applied"}, GH(4002), "strong"),
    ])
    assert result["failed"] == 0, "one locked row killed the chunk"
    assert result["updated"] == 1 and result["created"] == 1

    ramp = [a for a in apps(conn, user) if a[1] == "Ramp"][0]
    assert ramp[3] == "Offer", "a bulk import overwrote a status a human had chosen"
    # The rest of the row still imported: the lock is on `status`, not on the row.
    assert ramp[5] == "chase recruiter"

    report = conn.execute(
        """select column_name, rows_affected from public.import_column_reports
            where batch_id = %s and disposition = 'locked'""",
        (batch,),
    ).fetchall()
    assert report == [("Status", 1)], (
        "the status was silently not written — G13's whole point is that a value "
        "which did not land is reported, never dropped in silence"
    )


def test_an_imported_row_is_left_advanceable_by_the_engine(conn, user):
    """The other half, and the reason the import does NOT claim the lock.

    If importing claimed it, a person who arrives with 2,000 rows would have
    2,000 rows the Gmail capture can never advance again — the system's whole
    value, switched off by the act of onboarding.

    BOTH paths, because they set `status_actor` in different places and the first
    version of this test only covered the insert. A mutant that claimed the lock
    on every UPDATE survived it: the update path is the one an existing row takes,
    which is exactly the row somebody has been receiving email about.
    """
    batch, _ = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Applied"}, GH(4100), "strong"),
    ])
    created = apps(conn, user)[0]
    assert created[4] == "system", "an imported NEW row claimed the human lock"

    # Now the update path: the same file again, with the status moved on.
    import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Screen"}, GH(4100), "strong"),
    ])
    updated = [a for a in apps(conn, user) if a[0] == created[0]][0]
    assert updated[3] == "Screen", "the update path did not write the status at all"
    assert updated[4] == "system", (
        "an imported UPDATE claimed the human lock — the engine can never advance "
        "this row again, and nobody chose that"
    )


# ------------------------------------------------------------- the round trip

def _roundtrip_setup(conn, user, *, stale=False):
    app_id = conn.execute(
        """insert into public.applications (user_id, company, title, status, next_action)
           values (%s, 'Ramp', 'PM', 'Applied', 'send follow-up') returning id""",
        (user,),
    ).fetchone()[0]
    version = conn.execute(
        "select updated_at from public.applications where id = %s", (app_id,)
    ).fetchone()[0]
    if stale:
        # Somebody else moved the row after the export was taken. `updated_at`
        # advances; the token in the file does not.
        conn.execute(
            "update public.applications set status = 'Screen' where id = %s", (app_id,)
        )
    return app_id, version.isoformat()


def test_a_round_trip_edit_writes_the_five_writable_columns(conn, user):
    app_id, version = _roundtrip_setup(conn, user)
    batch, result = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Interview",
          "nextAction": "prep loop", "nextActionDate": "2026-08-01",
          "hqId": str(app_id), "hqVersion": version}, GH(5001), "strong"),
    ])
    assert row_states(conn, batch)[1] == "round-trip"
    assert result["updated"] == 1
    row = conn.execute(
        "select status, status_actor, next_action, next_action_date from public.applications where id = %s",
        (app_id,),
    ).fetchone()
    assert row[0] == "Interview"
    assert row[2] == "prep loop"
    assert str(row[3]) == "2026-08-01"
    # A round trip IS a human gesture: the file carried this row's own version
    # token, which is exactly the proof `app_set_status` demands.
    assert row[1] == "user", "a round-trip status change did not claim the row"


def test_a_round_trip_may_change_a_status_the_human_had_already_locked(conn, user):
    """The combination the trigger actually governs, and the one nothing else
    covered: a row a person claimed by hand, edited in Excel and imported back.

    Both failure directions are live here. Without the declaration the trigger
    raises 42501 and the chunk dies on the one row somebody cared most about;
    with a declaration on every import, a bulk file would silently overwrite it.
    The version token is what separates the two — and it is present here.
    """
    app_id = conn.execute(
        """insert into public.applications
             (user_id, company, title, status, status_actor)
           values (%s, 'Ramp', 'PM', 'Offer', 'user') returning id""",
        (user,),
    ).fetchone()[0]
    version = conn.execute(
        "select updated_at from public.applications where id = %s", (app_id,)
    ).fetchone()[0].isoformat()

    batch, result = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Offer-Accepted",
          "hqId": str(app_id), "hqVersion": version}, GH(5300), "strong"),
    ])
    assert result["failed"] == 0, "the trigger killed the chunk on a declared human write"
    assert result["updated"] == 1
    row = conn.execute(
        "select status, status_actor from public.applications where id = %s", (app_id,)
    ).fetchone()
    assert row == ("Offer-Accepted", "user"), (
        "a round trip could not change a status the same human had set — the file "
        "carried the row's own version token, which is all app_set_status asks for"
    )


def test_a_stale_round_trip_version_blocks_the_whole_commit(conn, user):
    """AC 23, enforced in the DATABASE.

    A UI-only guard is one bad deploy away from writing anyway, and what it
    would overwrite is an edit somebody made after the export was taken.
    """
    app_id, version = _roundtrip_setup(conn, user, stale=True)
    batch = create_batch(conn, rows=1)
    stage(conn, batch, [(1, {"c": "Ramp"})])
    apply_mapping(conn, batch, [
        (1, {"company": "Ramp", "title": "PM", "status": "Rejected",
             "hqId": str(app_id), "hqVersion": version}, GH(5002), "strong"),
    ])
    result = preview(conn, batch)
    assert result["unresolved"] == 1

    with pytest.raises(psycopg.errors.Error) as exc:
        commit(conn, batch)
    assert "unresolved" in str(exc.value)

    assert conn.execute(
        "select status from public.applications where id = %s", (app_id,)
    ).fetchone()[0] == "Screen", "the commit was refused and wrote anyway"

    conflict = conn.execute(
        "select conflict from public.import_rows where batch_id = %s and row_number = 1",
        (batch,),
    ).fetchone()[0]
    assert conflict["status"] == {"mine": "Screen", "theirs": "Rejected"}


def test_an_edit_between_preview_and_commit_blocks_that_row(conn, user):
    """AC 23's OTHER window, the one the review's probe corrupted data through.

    The preview passes clean — the file's token matches. THEN a human moves the
    row (Offer, claimed). The commit must re-compare the token inside the
    transaction that writes, app_set_status's shape: the file's stale value may
    not overwrite the newer edit, and one stale row must not wedge the batch.
    """
    app_id, version = _roundtrip_setup(conn, user)
    batch = create_batch(conn, rows=1)
    stage(conn, batch, [(1, {"c": "Ramp"})])
    apply_mapping(conn, batch, [
        (1, {"company": "Ramp", "title": "PM", "status": "Interview",
             "hqId": str(app_id), "hqVersion": version}, GH(5008), "strong"),
    ])
    result = preview(conn, batch)
    assert result["unresolved"] == 0, "the file was fresh at preview time"

    # The human-shaped gap between preview and commit: the row moves and is
    # claimed. The touch trigger advances updated_at, so the file is now stale.
    conn.execute(
        """update public.applications set status = 'Offer', status_actor = 'user'
           where id = %s""", (app_id,))

    result = commit(conn, batch)
    assert result.get("updated", 0) == 0, "the stale row was written anyway"

    row = conn.execute(
        "select status, status_actor from public.applications where id = %s",
        (app_id,)).fetchone()
    assert row == ("Offer", "user"), f"the human edit was clobbered: {row}"

    outcome, error = conn.execute(
        "select outcome, error from public.import_rows where batch_id = %s and row_number = 1",
        (batch,)).fetchone()
    assert outcome == "failed"
    assert "changed after the preview" in error


def test_resolving_a_conflict_writes_only_the_chosen_cells(conn, user):
    app_id, version = _roundtrip_setup(conn, user, stale=True)
    batch = create_batch(conn, rows=1)
    stage(conn, batch, [(1, {"c": "Ramp"})])
    apply_mapping(conn, batch, [
        (1, {"company": "Ramp", "title": "PM", "status": "Rejected",
             "nextAction": "archive it", "hqId": str(app_id), "hqVersion": version},
         GH(5003), "strong"),
    ])
    preview(conn, batch)
    conn.execute(
        "select public.app_import_resolve(%s, %s, %s)",
        (batch, 1, json.dumps({"status": "mine", "next_action": "theirs"})),
    )
    result = commit(conn, batch)
    assert result["updated"] == 1
    row = conn.execute(
        "select status, next_action from public.applications where id = %s", (app_id,)
    ).fetchone()
    assert row[0] == "Screen", "'keep mine' still wrote the file's value"
    assert row[1] == "archive it", "'take theirs' did not write"


def test_an_hq_id_from_someone_elses_file_matches_nothing(conn):
    """A round-trip identity is scoped to the owner inside the FUNCTION.

    An id resolving to "some row" rather than to nothing is a cross-tenant write
    dressed up as a spreadsheet.
    """
    other = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, other)
    victim = conn.execute(
        """insert into public.applications (user_id, company, title, status)
           values (%s, 'Ramp', 'PM', 'Offer') returning id""",
        (other,),
    ).fetchone()[0]

    mine = make_user(conn, f"{uuid.uuid4()}@example.com")
    as_user(conn, mine)
    batch, result = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Rejected",
          "hqId": str(victim), "hqVersion": "2026-07-01T00:00:00+00:00"}, GH(5100), "strong"),
    ])
    assert row_states(conn, batch)[1] != "round-trip"
    assert conn.execute(
        "select status from public.applications where id = %s", (victim,)
    ).fetchone()[0] == "Offer", "an hq_id from another user's file wrote to their row"
    notice = conn.execute(
        "select notice from public.import_rows where batch_id = %s and row_number = 1",
        (batch,),
    ).fetchone()[0]
    assert "matched none" in notice, "the row was silently treated as new"


def test_a_round_trip_without_a_version_column_claims_nothing(conn, user):
    """Row 40's other edge. `hq_id` still matches by id, but a file whose
    `hq_version` column was deleted is no longer evidence that anybody read the
    current value — so it writes like a plain import and must not claim the lock
    on a row a human had chosen."""
    app_id = conn.execute(
        """insert into public.applications (user_id, company, title, status, status_actor)
           values (%s, 'Ramp', 'PM', 'Offer', 'user') returning id""",
        (user,),
    ).fetchone()[0]
    batch, result = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Rejected",
          "hqId": str(app_id)}, GH(5200), "strong"),
    ])
    assert row_states(conn, batch)[1] == "round-trip"
    row = conn.execute(
        "select status, status_actor from public.applications where id = %s", (app_id,)
    ).fetchone()
    assert row == ("Offer", "user"), "a version-less round trip overwrote a human status"


# ------------------------------------------------------------------- AC 21

def test_undo_removes_exactly_what_the_batch_created(conn, user):
    conn.execute(
        """insert into public.applications (user_id, company, title, status)
           values (%s, 'Pre-existing', 'PM', 'Interview')""",
        (user,),
    )
    batch, _ = import_file(conn, [
        ({"company": f"Company {i}", "title": "PM", "status": "Applied"}, GH(6000 + i), "strong")
        for i in range(5)
    ])
    assert len(apps(conn, user)) == 6

    report = undo(conn, batch)
    assert report["deleted"] == 5
    remaining = apps(conn, user)
    assert len(remaining) == 1
    assert remaining[0][1] == "Pre-existing", "undo ate a row the import never touched"
    assert report["batch"]["state"] == "rolled_back"

    kinds = [
        r[0] for r in conn.execute(
            "select kind from public.events where user_id = %s order by id", (user,)
        ).fetchall()
    ]
    assert "import.rolled_back" in kinds, "an undo left no trace in the audit trail"


def test_undo_restores_the_values_an_update_overwrote(conn, user):
    app_id = conn.execute(
        """insert into public.applications (user_id, company, title, status, next_action)
           values (%s, 'Ramp', 'PM', 'Applied', 'original action') returning id""",
        (user,),
    ).fetchone()[0]
    batch, result = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Screen",
          "nextAction": "imported action"}, GH(6100), "strong"),
    ])
    assert result["updated"] == 1

    undo(conn, batch)
    row = conn.execute(
        "select status, next_action from public.applications where id = %s", (app_id,)
    ).fetchone()
    assert row == ("Applied", "original action")


def test_undo_keeps_a_row_edited_after_the_import_and_says_so(conn, user):
    """Row 33. The import's own token is what distinguishes "nobody has touched
    this since" from "somebody has", and throwing away the second is throwing
    away work nobody asked to lose."""
    batch, _ = import_file(conn, [
        ({"company": "Kept", "title": "PM", "status": "Applied"}, GH(6200), "strong"),
        ({"company": "Reverted", "title": "PM", "status": "Applied"}, GH(6201), "strong"),
    ])
    kept_id = [a[0] for a in apps(conn, user) if a[1] == "Kept"][0]
    conn.execute(
        "select public.app_set_status(%s, %s, %s, %s, %s)",
        (kept_id, "Interview", "moved it myself", str(uuid.uuid4()), None),
    )

    report = undo(conn, batch)
    assert report["deleted"] == 1
    assert report["kept"] == 1
    assert kept_id in report["kept_ids"]
    survivors = apps(conn, user)
    assert [s[1] for s in survivors] == ["Kept"]
    assert survivors[0][3] == "Interview", "undo reverted an edit made after the import"


def test_undo_is_idempotent_on_its_key_and_refuses_a_second_gesture(conn, user):
    batch, _ = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Applied"}, GH(6300), "strong"),
    ])
    key = str(uuid.uuid4())
    first = undo(conn, batch, idem=key)
    replay = undo(conn, batch, idem=key)
    assert replay == first, "a replayed undo recomputed instead of returning its result"

    # A genuinely NEW gesture against an already-undone batch is not a replay,
    # and answering it with a cheerful no-op would tell somebody their second
    # undo did something.
    with pytest.raises(psycopg.errors.Error) as exc:
        undo(conn, batch)
    assert "already been undone" in str(exc.value)


def test_undo_refuses_once_the_window_has_closed(conn, user):
    batch, _ = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Applied"}, GH(6400), "strong"),
    ])
    # The window is read from the ROW, so moving the row is the honest way to
    # test it — a client clock is not evidence of anything.
    conn.execute(
        "update public.import_batches set undo_expires_at = now() - interval '1 minute' where id = %s",
        (batch,),
    )
    with pytest.raises(psycopg.errors.Error) as exc:
        undo(conn, batch)
    assert "undo window" in str(exc.value)
    assert len(apps(conn, user)) == 1, "a refused undo deleted rows anyway"


def test_a_failed_undo_reverts_nothing_and_leaves_the_batch_undoable(conn, user):
    """What this test actually defends, said accurately.

    It does NOT prove that the revert is one transaction: one call of one
    function is one transaction whatever the body looks like, so Postgres owns
    that and crediting the code for it is crediting the wrong thing. What it
    defends is the mutant Postgres would NOT catch -- an `exception when others`
    handler anywhere in the loop. Swallow the failure and the function returns
    normally, the batch is marked `rolled_back`, and half the rows are gone with
    the undo already spent. `pytest.raises` is therefore load-bearing here: it is
    the assertion that nothing caught it.

    Forced with a trigger that raises on the second delete.
    """
    batch, _ = import_file(conn, [
        ({"company": "First", "title": "PM", "status": "Applied"}, GH(6500), "strong"),
        ({"company": "Second", "title": "PM", "status": "Applied"}, GH(6501), "strong"),
    ])
    second_id = [a[0] for a in apps(conn, user) if a[1] == "Second"][0]
    conn.execute(
        """create or replace function pg_temp_boom() returns trigger language plpgsql as $$
           begin raise exception 'boom'; end $$"""
    )
    conn.execute(
        """create trigger boom before delete on public.applications
           for each row when (old.id = %s) execute function pg_temp_boom()"""
        % second_id
    )
    try:
        with pytest.raises(psycopg.errors.Error):
            undo(conn, batch)
    finally:
        conn.execute("drop trigger boom on public.applications")

    assert len(apps(conn, user)) == 2, "a failed undo left the batch half-reverted"
    assert conn.execute(
        "select state from public.import_batches where id = %s", (batch,)
    ).fetchone()[0] == "committed", "a failed undo still marked the batch rolled back"
    # And the batch is still undoable rather than spent: the rows kept their
    # `created` outcome, which is what a later retry reads.
    assert conn.execute(
        """select count(*) from public.import_rows
            where batch_id = %s and outcome = 'created'""",
        (batch,),
    ).fetchone()[0] == 2
    # The retry, now that the trigger is gone, does the whole job.
    report = undo(conn, batch)
    assert report["deleted"] == 2
    assert apps(conn, user) == []


def test_undo_works_from_a_different_timezone_than_the_commit(conn, user):
    """Committed under UTC, undone under America/Chicago.

    `revert.wrote_updated_at` is written with `to_jsonb(timestamptz)`, which
    renders using the SESSION's TimeZone -- so the same instant is `...+00:00`
    in one session and `...-05:00` in another. Compared as STRINGS, every row of
    every cross-timezone undo reads as "somebody edited this since", nothing is
    reverted, and the batch is still marked rolled_back: the one gesture that
    takes an import back is spent and did nothing.

    Both timezones are real: `pg_dump`/psql sessions, a pooler, and a Supabase
    function invocation do not all agree on TimeZone, and neither does a laptop.
    The same failure `hq_import_version` exists to prevent on the round-trip
    token, one function away (matrix row 146).
    """
    conn.execute("set time zone 'UTC'")
    batch, _ = import_file(conn, [
        ({"company": "Kestrel", "title": "PM", "status": "Applied"}, GH(6700), "strong"),
        ({"company": "Ironwood", "title": "PM", "status": "Applied"}, GH(6701), "strong"),
    ])
    assert len(apps(conn, user)) == 2

    conn.execute("set time zone 'America/Chicago'")
    try:
        report = undo(conn, batch)
        assert report["deleted"] == 2, "the undo reverted nothing across a timezone change"
        assert report["kept"] == 0, "rows nobody touched were reported as edited since"
        assert apps(conn, user) == []
    finally:
        conn.execute("set time zone 'UTC'")


def test_an_imported_note_survives_an_undo_of_a_row_that_survives(conn, user):
    """`application_notes` is append-only by GRANT (0010). Undoing an import is
    not a licence to delete history — and the report says how many stayed, which
    is the difference between a documented limitation and a surprise."""
    app_id = conn.execute(
        """insert into public.applications (user_id, company, title, status)
           values (%s, 'Ramp', 'PM', 'Applied') returning id""",
        (user,),
    ).fetchone()[0]
    second_id = conn.execute(
        """insert into public.applications (user_id, company, title, status)
           values (%s, 'Kestrel', 'PM', 'Applied') returning id""",
        (user,),
    ).fetchone()[0]
    # TWO surviving rows, each carrying an imported note, because one cannot tell
    # `v_notes := count(*)` from `v_notes := v_notes + count(*)` apart. The
    # migration's own comment says the first version overwrote the count each
    # iteration and a 200-row undo reported whatever the last row happened to
    # have; with a single row that mutant lived here untouched.
    batch, _ = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "notes": "from the spreadsheet"},
         GH(6600), "strong"),
        ({"company": "Kestrel", "title": "PM", "notes": "and this one"},
         GH(6601), "strong"),
    ])
    report = undo(conn, batch)
    assert report["notes_kept"] == 2, (
        "the kept-note count is not accumulating across the rows of one undo"
    )
    bodies = {
        r[0] for r in conn.execute(
            """select body from public.application_notes
                where application_id in (%s, %s)""",
            (app_id, second_id),
        ).fetchall()
    }
    assert bodies == {"from the spreadsheet", "and this one"}


# ------------------------------------------------------- never destroy on write

def test_a_blank_cell_never_erases_a_value(conn, user):
    """An empty spreadsheet cell means "I did not fill this in", not "delete
    what you have". The other reading makes an import unrecoverable."""
    app_id = conn.execute(
        """insert into public.applications
             (user_id, company, title, status, next_action, applied_date)
           values (%s, 'Ramp', 'PM', 'Interview', 'call Priya', '2026-06-01') returning id""",
        (user,),
    ).fetchone()[0]
    import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "", "nextAction": "",
          "appliedDate": ""}, GH(7000), "strong"),
    ])
    row = conn.execute(
        "select status, next_action, applied_date from public.applications where id = %s",
        (app_id,),
    ).fetchone()
    assert row[0] == "Interview"
    assert row[1] == "call Priya"
    assert str(row[2]) == "2026-06-01"


@pytest.mark.parametrize(
    "label,blank",
    [
        ("tab and newline", "\t\n"),
        ("non-breaking space", "\u00a0"),
        ("zero-width space", "\u200b"),
        ("ideographic space", "\u3000"),
        ("BOM", "\ufeff"),
    ],
)
def test_a_cell_that_only_looks_blank_never_erases_a_value(conn, user, label, blank):
    """The same rule, in the characters a spreadsheet actually contains.

    `hq_import_mapped_value` reads every cell through `hq_blank_trim`, which
    strips zero-widths and the exotic separators as well as the ASCII ones. The
    TypeScript fake used bare `.trim()`, which leaves U+200B alone -- so a cell
    holding one zero-width space was blank here and content there, and the fake
    was the more forgiving of the two in the direction that writes. This is the
    Postgres half of that pair; the fake half is
    `webapp/tests/unit/import-fixture.test.ts`.
    """
    app_id = conn.execute(
        """insert into public.applications
             (user_id, company, title, status, next_action, applied_date)
           values (%s, 'Ramp', 'PM', 'Interview', 'call Priya', '2026-06-01') returning id""",
        (user,),
    ).fetchone()[0]
    import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": blank, "nextAction": blank,
          "appliedDate": blank, "notes": blank}, GH(7050), "strong"),
    ])
    row = conn.execute(
        "select status, next_action, applied_date from public.applications where id = %s",
        (app_id,),
    ).fetchone()
    assert row[0] == "Interview", label
    assert row[1] == "call Priya", label
    assert str(row[2]) == "2026-06-01", label
    # And nothing invisible landed in the append-only trail, which has no delete.
    assert conn.execute(
        "select count(*) from public.application_notes where application_id = %s", (app_id,)
    ).fetchone()[0] == 0, label


def test_a_note_is_appended_and_never_overwrites(conn, user):
    """plans/README C5: the import appends via the notes entity, author
    `import`. The flat column is what an export reads and it is not touched."""
    app_id = conn.execute(
        """insert into public.applications (user_id, company, title, status, notes)
           values (%s, 'Ramp', 'PM', 'Applied', 'my own note') returning id""",
        (user,),
    ).fetchone()[0]
    import_file(conn, [
        ({"company": "Ramp", "title": "PM", "notes": "the file's note"}, GH(7100), "strong"),
    ])
    assert conn.execute(
        "select notes from public.applications where id = %s", (app_id,)
    ).fetchone()[0] == "my own note", "the import overwrote the flat notes column"
    notes = conn.execute(
        "select body, author from public.application_notes where application_id = %s order by id",
        (app_id,),
    ).fetchall()
    assert ("the file's note", "import") in notes


def test_an_unreadable_date_is_null_rather_than_a_wrong_date(conn, user):
    import_file(conn, [
        ({"company": "Ramp", "title": "PM", "appliedDate": "not a date"}, GH(7200), "strong"),
    ])
    assert apps(conn, user)[0][6] is None


# ------------------------------------------------------------ chunk + resume

def test_a_batch_commits_in_chunks_and_the_cursor_survives(conn, user):
    rows = [
        ({"company": f"Company {i}", "title": "PM", "status": "Applied"}, GH(8000 + i), "strong")
        for i in range(25)
    ]
    batch = create_batch(conn, rows=len(rows))
    stage(conn, batch, [(i + 1, {"n": str(i)}) for i in range(len(rows))])
    apply_mapping(conn, batch, [(i + 1, m, k, s) for i, (m, k, s) in enumerate(rows)])
    preview(conn, batch)

    first = commit(conn, batch, limit=10)
    assert first["created"] == 10 and first["remaining"] == 15
    assert first["batch"]["state"] == "committing", (
        "a half-committed batch reports as finished — the failure this state exists for"
    )
    assert first["batch"]["committed_count"] == 10

    commit(conn, batch, limit=10)
    last = commit(conn, batch, limit=10)
    assert last["remaining"] == 0
    assert last["batch"]["state"] == "committed"
    assert len(apps(conn, user)) == 25


def test_a_replayed_chunk_does_not_commit_twice(conn, user):
    rows = [({"company": "Ramp", "title": "PM", "status": "Applied"}, GH(8100), "strong")]
    batch = create_batch(conn, rows=1)
    stage(conn, batch, [(1, {"n": "1"})])
    apply_mapping(conn, batch, [(1, rows[0][0], rows[0][1], rows[0][2])])
    preview(conn, batch)
    key = str(uuid.uuid4())
    first = commit(conn, batch, idem=key)
    replay = commit(conn, batch, idem=key)
    assert replay == first
    assert len(apps(conn, user)) == 1


def test_two_concurrent_chunks_of_one_batch_are_serialised(conn, user):
    """Two callers commit the same batch WHILE OVERLAPPING inside the function.

    Written this way after the FIRST version passed with the lock removed, which
    is the mistake this repo has already made twice — and the reason it passed is
    worth recording. On a batch in state `previewed`, the first caller's own
    `set state = 'committing'` takes the row's write lock, so the second caller
    blocked on that regardless. The hole is a batch ALREADY `committing`: chunk
    two onwards touches no batch column until the very end, so nothing but the
    explicit `for update` stands between two callers and the same pending rows.
    This test therefore commits one chunk first and races the SECOND.

    The DISCRIMINATOR is not the application count — 0002's manual-dedup index
    keeps that at 12 either way, which is what made the first version unable to
    fail. It is the batch's own record of what it did: with the lock, b finds
    nothing pending and every row stays `created`. Without it, b re-processes
    rows 7-12, every insert loses to the unique index, and their outcome flips
    to `skipped` — which is not merely a wrong number. `skipped` rows carry no
    `revert`, so undo can no longer find those applications, and six rows nobody
    chose become permanent.
    """
    import threading

    rows = [
        ({"company": f"Company {i}", "title": "PM", "status": "Applied"}, GH(8200 + i), "strong")
        for i in range(12)
    ]
    batch = create_batch(conn, rows=len(rows))
    stage(conn, batch, [(i + 1, {"n": str(i)}) for i in range(len(rows))])
    apply_mapping(conn, batch, [(i + 1, m, k, s) for i, (m, k, s) in enumerate(rows)])
    preview(conn, batch)
    # Chunk one, alone. The batch is now `committing` with six rows pending —
    # the state the race actually lives in.
    assert commit(conn, batch, limit=6)["remaining"] == 6

    a = psycopg.connect(DATABASE_URL)
    b = psycopg.connect(DATABASE_URL)
    late: dict = {}

    def second_caller():
        try:
            b.execute("set lock_timeout = '15s'")
            b.execute("select set_config('hq.test_user', %s, false)", (user,))
            late["result"] = b.execute(
                "select public.app_import_commit_chunk(%s, %s, %s)",
                (batch, 6, str(uuid.uuid4())),
            ).fetchone()[0]
            b.commit()
        except Exception as exc:  # surfaced by the assertions below
            late["error"] = exc

    try:
        a.execute("select set_config('hq.test_user', %s, false)", (user,))
        a.execute(
            "select public.app_import_commit_chunk(%s, %s, %s)",
            (batch, 6, str(uuid.uuid4())),
        )
        t = threading.Thread(target=second_caller)
        t.start()
        t.join(timeout=1.5)
        assert t.is_alive(), (
            "the second caller returned while the first transaction was still open — "
            "nothing serialised them"
        )
        a.commit()
        t.join(timeout=20)
        assert not t.is_alive(), "the second caller never unblocked"
    finally:
        a.close()
        b.close()

    assert "error" not in late, late.get("error")
    assert len(apps(conn, user)) == 12
    assert late["result"]["created"] == 0, "the second caller committed the same rows again"
    outcomes = sorted(
        r[0] for r in conn.execute(
            "select outcome from public.import_rows where batch_id = %s", (batch,)
        ).fetchall()
    )
    assert outcomes == ["created"] * 12, (
        f"the batch's record of what it did was rewritten by the second caller: {outcomes}"
    )
    # The consequence, asserted rather than argued: a corrupted outcome is an
    # application undo cannot reach.
    assert undo(conn, batch)["deleted"] == 12
    assert apps(conn, user) == []


def test_a_mapping_that_missed_rows_is_refused(conn, user):
    batch = create_batch(conn, rows=2)
    stage(conn, batch, [(1, {"n": "1"}), (2, {"n": "2"})])
    with pytest.raises(psycopg.errors.Error) as exc:
        apply_mapping(conn, batch, [(1, {"company": "Ramp", "title": "PM"}, GH(8300), "strong")])
    assert "never got a mapping" in str(exc.value)


def test_a_second_tab_remapping_the_same_batch_conflicts(conn, user):
    batch = create_batch(conn, rows=1)
    stage(conn, batch, [(1, {"n": "1"})])
    stale = conn.execute(
        "select updated_at from public.import_batches where id = %s", (batch,)
    ).fetchone()[0]
    apply_mapping(conn, batch, [(1, {"company": "Ramp", "title": "PM"}, GH(8400), "strong")])
    with pytest.raises(psycopg.errors.Error) as exc:
        apply_mapping(
            conn, batch,
            [(1, {"company": "Other", "title": "PM"}, GH(8401), "strong")],
            expected=stale,
        )
    assert "conflict" in str(exc.value)


def test_a_committed_batch_cannot_be_remapped(conn, user):
    batch, _ = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Applied"}, GH(8500), "strong"),
    ])
    with pytest.raises(psycopg.errors.Error) as exc:
        apply_mapping(conn, batch, [(1, {"company": "Nope", "title": "PM"}, GH(8501), "strong")])
    assert "no longer be re-mapped" in str(exc.value)


def test_an_excluded_row_is_not_written(conn, user):
    rows = [
        ({"company": "Wanted", "title": "PM", "status": "Applied"}, GH(8600), "strong"),
        ({"company": "Vetoed", "title": "PM", "status": "Applied"}, GH(8601), "strong"),
    ]
    batch = create_batch(conn, rows=2)
    stage(conn, batch, [(1, {"n": "1"}), (2, {"n": "2"})])
    apply_mapping(conn, batch, [(i + 1, m, k, s) for i, (m, k, s) in enumerate(rows)])
    preview(conn, batch)
    conn.execute("select public.app_import_set_included(%s, %s, false)", (batch, [2]))
    result = commit(conn, batch)
    assert result["created"] == 1
    assert [a[1] for a in apps(conn, user)] == ["Wanted"]
    assert result["batch"]["state"] == "committed", (
        "an excluded row left the batch pending forever, so it never reads as finished"
    )


# ------------------------------------------------------------------- bounds

def test_a_file_over_the_row_cap_is_refused_by_name(conn, user):
    with pytest.raises(psycopg.errors.Error) as exc:
        create_batch(conn, rows=5001)
    assert "the limit is 5000" in str(exc.value)


def test_an_unsupported_source_kind_is_refused(conn, user):
    with pytest.raises(psycopg.errors.Error) as exc:
        create_batch(conn, kind="numbers")
    assert "unsupported import source" in str(exc.value)


def test_a_resolver_choice_outside_the_writable_set_is_refused(conn, user):
    app_id, version = _roundtrip_setup(conn, user, stale=True)
    batch = create_batch(conn, rows=1)
    stage(conn, batch, [(1, {"c": "Ramp"})])
    apply_mapping(conn, batch, [
        (1, {"company": "Ramp", "title": "PM", "status": "Rejected",
             "hqId": str(app_id), "hqVersion": version}, GH(9000), "strong"),
    ])
    preview(conn, batch)
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute(
            "select public.app_import_resolve(%s, %s, %s)",
            (batch, 1, json.dumps({"company": "theirs"})),
        )
    assert "not one an import may write" in str(exc.value)


def test_the_batch_is_not_content_addressed_so_a_file_can_be_reimported(conn, user):
    """Stated as a test because the opposite is a tempting reading of "a
    re-import must be idempotent": content-addressing the BATCH would make AC
    20's own scenario — import the file again, see 40 matches, add zero —
    impossible to perform. Idempotency lives at the row level."""
    rows = [({"company": "Ramp", "title": "PM", "status": "Applied"}, GH(9100), "strong")]
    b1, _ = import_file(conn, rows, digest="sha-identical")
    b2, r2 = import_file(conn, rows, digest="sha-identical")
    assert b1 != b2
    assert r2["created"] == 0 and r2["updated"] == 1


def test_the_same_upload_gesture_twice_creates_one_batch(conn, user):
    key = str(uuid.uuid4())
    first = create_batch(conn, idem=key)
    second = create_batch(conn, idem=key)
    assert first == second


# ------------------------------------------------------------------ discard

def test_an_unfinished_import_can_be_discarded(conn, user):
    """`app_import_create` refuses a 21st batch with "finish or discard one
    first". Without a discard that sentence named a gesture nobody implemented —
    and after twenty abandoned uploads a person could never import again, told to
    do something the system did not offer."""
    batch = create_batch(conn, rows=1)
    stage(conn, batch, [(1, {"c": "Ramp"})])
    result = conn.execute(
        "select public.app_import_discard(%s, %s)", (batch, str(uuid.uuid4()))
    ).fetchone()[0]
    assert result["discarded"] == batch
    assert conn.execute(
        "select count(*) from public.import_batches where id = %s", (batch,)
    ).fetchone()[0] == 0
    # The rows go with it (cascade); the trail does not.
    assert conn.execute(
        "select count(*) from public.import_rows where batch_id = %s", (batch,)
    ).fetchone()[0] == 0
    kinds = [r[0] for r in conn.execute(
        "select kind from public.events where user_id = %s", (user,)).fetchall()]
    assert "import.discarded" in kinds, "a discarded import left no trace"


def test_a_committed_import_cannot_be_discarded(conn, user):
    """Undo is the way to reverse a commit, and it leaves a trail. A delete would
    leave none — and would take `import_rows` with it, which is the only record of
    what the file actually said."""
    batch, _ = import_file(conn, [
        ({"company": "Ramp", "title": "PM", "status": "Applied"}, GH(9400), "strong"),
    ])
    with pytest.raises(psycopg.errors.Error) as exc:
        conn.execute("select public.app_import_discard(%s, %s)", (batch, str(uuid.uuid4())))
    assert "undo it instead" in str(exc.value)
    assert len(apps(conn, user)) == 1


def test_the_in_progress_cap_is_escapable(conn, user):
    """The cap and its escape hatch, asserted as a pair: twenty unfinished
    batches refuse the twenty-first, and discarding one lets it through. Either
    half alone is a claim about a number rather than about a person being stuck."""
    batches = [create_batch(conn, rows=0) for _ in range(20)]
    with pytest.raises(psycopg.errors.Error) as exc:
        create_batch(conn, rows=0)
    assert "still in progress" in str(exc.value)
    conn.execute("select public.app_import_discard(%s, %s)", (batches[0], str(uuid.uuid4())))
    assert create_batch(conn, rows=0)


# -------------------------------------------------------------- the report

def test_engine_owned_columns_are_reported_rather_than_dropped(conn, user):
    """G13. A value that did not land is reported with a count and samples; the
    alternative — a silent drop — is what makes people distrust an import."""
    # Matched by POSTING KEY, not by name — the point is a row that matches
    # while its other columns disagree, and a name-matched row cannot disagree
    # about its name.
    key = make_posting(conn, GH(9200))
    conn.execute(
        """insert into public.applications (user_id, posting_key, company, title, status, url)
           values (%s, %s, 'Ramp', 'PM', 'Applied', 'https://real.example/job')""",
        (user, key),
    )
    batch, _ = import_file(
        conn,
        [({"company": "Ramp", "title": "Senior PM", "url": "https://stale.example/job",
           "status": "Screen"}, GH(9200), "strong")],
        mapping={"unmapped": [{"name": "Recruiter", "disposition": "unknown-column"},
                              {"name": "Source", "disposition": "unmapped"}]},
    )
    conn.execute("select public.app_import_report(%s)", (batch,))
    report = {
        (r[0], r[1]): (r[2], r[3])
        for r in conn.execute(
            """select column_name, disposition, rows_affected, sample
                 from public.import_column_reports where batch_id = %s""",
            (batch,),
        ).fetchall()
    }
    assert ("Title", "read-only") in report, "an engine-owned difference went unreported"
    assert report[("Title", "read-only")][1] == ["Senior PM"]
    assert ("URL", "read-only") in report
    assert ("Recruiter", "unknown-column") in report
    assert ("Source", "unmapped") in report
    assert ("Status", "imported") in report
    assert conn.execute(
        "select title from public.applications where user_id = %s", (user,)
    ).fetchone()[0] == "PM", "an engine-owned column was written"


def test_the_name_fallback_folds_an_interior_nbsp_run(conn, user):
    """M5, killed. `company_name_key`, never `lower()`.

    The strong-key name fallback is the second import of a file finding the rows
    the first one made -- and it goes through `company_name_key`, which collapses
    every run of space-like characters (including U+00A0 and the zero-widths) to
    one space before folding case. `lower()` alone folds case and nothing else.

    Every existing case survived swapping one for the other, because none of them
    differed by anything but case. This one does: "Goldman<NBSP>Sachs" is what a
    paste out of a web page puts in a spreadsheet cell, and under `lower()` it is
    a different company from the "Goldman Sachs" already in the pipeline -- so the
    import adds a second row and the person's pipeline quietly grows a duplicate
    of a company they are already talking to.
    """
    conn.execute(
        """insert into public.applications (user_id, company, title, status)
           values (%s, 'Goldman Sachs', 'Product  Manager', 'Applied')""",
        (user,),
    )
    before = len(apps(conn, user))
    batch, result = import_file(conn, [
        ({"company": "Goldman\u00a0Sachs", "title": "Product\u00a0Manager",
          "status": "Screen"}, GH(9500), "strong"),
    ])
    assert result["created"] == 0, "an NBSP in the name created a duplicate company"
    assert result["updated"] == 1
    assert len(apps(conn, user)) == before
    assert conn.execute(
        """select match_kind from public.import_rows
            where batch_id = %s and row_number = 1""",
        (batch,),
    ).fetchone()[0] == "matches-existing"


def test_a_column_can_carry_two_verdicts_in_one_report(conn, user):
    """Keyed on (batch, column) alone, the commit's "Status — locked, 1 row" was
    overwritten by the report pass's "Status — imported, N rows": the only line
    saying something did NOT land, erased by the line saying everything did."""
    conn.execute(
        """insert into public.applications (user_id, company, title, status, status_actor)
           values (%s, 'Locked Co', 'PM', 'Offer', 'user')""",
        (user,),
    )
    batch, _ = import_file(conn, [
        ({"company": "Locked Co", "title": "PM", "status": "Rejected"}, GH(9300), "strong"),
        ({"company": "Open Co", "title": "PM", "status": "Applied"}, GH(9301), "strong"),
    ])
    conn.execute("select public.app_import_report(%s)", (batch,))
    verdicts = {
        r[0] for r in conn.execute(
            """select disposition from public.import_column_reports
                where batch_id = %s and column_name = 'Status'""",
            (batch,),
        ).fetchall()
    }
    assert verdicts == {"locked", "imported"}
    # And the two lines account for two DIFFERENT rows. The first version counted
    # `imported` from the file's value rather than from what landed, so the
    # locked row appeared on both lines: one row, two verdicts, and a report
    # adding up to more than the batch.
    counts = {
        r[0]: r[1] for r in conn.execute(
            """select disposition, rows_affected from public.import_column_reports
                where batch_id = %s and column_name = 'Status'""",
            (batch,),
        ).fetchall()
    }
    assert counts == {"locked": 1, "imported": 1}


def test_a_cell_the_resolver_kept_is_not_reported_as_imported(conn, user):
    """"Keep mine" discards the file's value, and the report has to say so.

    The `imported` count read the FILE, so a cell the person explicitly chose not
    to take was counted as one that landed — the report saying a value was
    imported while the row still holds the old one is worse than saying nothing,
    because it is checkable and wrong.
    """
    app_id = conn.execute(
        """insert into public.applications
             (user_id, company, title, status, next_action)
           values (%s, 'Ramp', 'PM', 'Screen', 'call Priya') returning id""",
        (user,),
    ).fetchone()[0]
    batch = create_batch(conn, rows=1)
    stage(conn, batch, [(1, {"n": "1"})])
    apply_mapping(
        conn,
        batch,
        [(1, {"company": "Ramp", "title": "PM", "status": "Final",
              "nextAction": "book the panel", "hqId": str(app_id),
              "hqVersion": "2020-01-01T00:00:00.000Z"}, GH(9400), "strong")],
        mapping={"roundTrip": True},
    )
    result = preview(conn, batch)
    assert result["unresolved"] == 1
    conn.execute(
        "select public.app_import_resolve(%s, %s, %s)",
        (batch, 1, json.dumps({"status": "mine", "next_action": "theirs"})),
    )
    commit(conn, batch)
    conn.execute("select public.app_import_report(%s)", (batch,))

    row = conn.execute(
        "select status, next_action from public.applications where id = %s", (app_id,)
    ).fetchone()
    assert row == ("Screen", "book the panel"), "the resolver's answers were not honoured"

    report = {
        (r[0], r[1]): r[2]
        for r in conn.execute(
            """select column_name, disposition, rows_affected
                 from public.import_column_reports where batch_id = %s""",
            (batch,),
        ).fetchall()
    }
    assert ("Next action", "imported") in report
    assert ("Status", "imported") not in report, (
        "a cell the person chose to keep was reported as imported"
    )


# ------------------------------------------------------------- the twin lists

def test_the_writable_column_set_matches_the_typescript(conn):
    """`hq_import_writable_columns()` is spelled out again in
    `webapp/lib/import/round-trip.ts`. A comment saying "keep in step" is not a
    mechanism — this parses the TypeScript."""
    ts = (ROOT / "webapp" / "lib" / "import" / "round-trip.ts").read_text()
    m = re.search(r"WRITABLE_COLUMNS\s*=\s*\[(.*?)\]", ts, re.S)
    assert m, "WRITABLE_COLUMNS not found in webapp/lib/import/round-trip.ts"
    from_ts = [x for x in re.findall(r'"([^"]+)"', m.group(1))]
    from_sql = conn.execute("select public.hq_import_writable_columns()").fetchone()[0]
    assert from_ts == from_sql, (
        "the columns an import may write differ between SQL and TypeScript — "
        "the wizard would offer a resolver for a column the database refuses"
    )
