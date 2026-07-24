"""Universe discovery-metadata columns (0007), against real Postgres.

The `db` CI job applies every migration to a clean database in order — a migration
that does not apply cannot ship. These tests additionally pin the *shape* the
discovery system relies on: the three columns exist with the right types, the
reliability_tier CHECK admits only {null,1,2,3}, and the two text columns default
to '' so the existing sheet→pg mirror (which inserts name/ats/slug only) keeps working.

Run locally with a throwaway Postgres — see tests/db/test_write_path.py's docstring.
Without DATABASE_URL every test skips.
"""
from __future__ import annotations

import os

import pytest

psycopg = pytest.importorskip("psycopg", reason="psycopg not installed")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL and os.environ.get("HQ_REQUIRE_DB") == "1":
    raise RuntimeError("HQ_REQUIRE_DB=1 but DATABASE_URL is unset")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="no DATABASE_URL")

from tests.db.test_write_path import schema  # noqa: E402,F401


@pytest.fixture
def conn(schema):  # noqa: F811
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        yield c


def _cols(conn):
    return {
        r[0]: (r[1], r[2])
        for r in conn.execute(
            "select column_name, data_type, column_default "
            "from information_schema.columns "
            "where table_schema = 'public' and table_name = 'companies'"
        ).fetchall()
    }


def test_metadata_columns_exist_with_types(conn):
    cols = _cols(conn)
    assert cols["source"][0] == "text"
    assert cols["reliability_tier"][0] == "smallint"
    assert cols["resolution_method"][0] == "text"


def test_text_columns_default_to_empty(conn):
    # the sheet->pg mirror inserts name/ats/slug only; the new columns must not force a value
    conn.execute("insert into public.companies (name, ats, slug) values ('P2 Defco', 'ashby', 'p2def')")
    row = conn.execute(
        "select source, resolution_method, reliability_tier from public.companies where name = 'P2 Defco'"
    ).fetchone()
    assert row == ("", "", None)


def test_reliability_tier_check_admits_only_valid_tiers(conn):
    for tier in (1, 2, 3, None):
        conn.execute(
            "insert into public.companies (name, ats, slug, reliability_tier) values (%s, 'greenhouse', %s, %s)",
            (f"P2 tier {tier}", f"p2t{tier}", tier),
        )
    for bad in (0, -1, 4, 9):   # 0 and negatives are the likelier fat-finger, not just >3
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute(
                "insert into public.companies (name, ats, slug, reliability_tier) values (%s, 'greenhouse', %s, %s)",
                (f"P2 bad {bad}", f"p2b{bad}", bad),
            )


def test_text_columns_reject_explicit_null(conn):
    # NOT NULL is real, not just a default — a writer passing null must be refused
    for col in ("source", "resolution_method"):
        with pytest.raises(psycopg.errors.NotNullViolation):
            conn.execute(
                f"insert into public.companies (name, ats, slug, {col}) values (%s, 'lever', %s, null)",
                (f"P2 null {col}", f"p2n{col}"),
            )
