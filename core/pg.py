"""Thin PostgREST client for the v2 Postgres store (Supabase).

Deliberately requests-only (no new dependency, no DB driver): the engine
talks to Supabase's PostgREST endpoint exactly the way it talks to every
other HTTP API in this repo. Service-role key = full access; this module is
ENGINE-ONLY and must never be imported by anything that ships to a browser.

Failure posture matches core.sheets: loud. A non-2xx response raises
PgError with the response body — a skipped mirror pass is recoverable, a
guessed write is corruption. Callers that treat the mirror as best-effort
(dual-write phase, sheet remains truth) catch PgError and count it.

Config: SUPABASE_URL + SUPABASE_SERVICE_KEY env vars. Absent -> enabled()
is False and callers skip cleanly (with a loud ::warning, per house policy).
"""
from __future__ import annotations

import json
import os
from typing import Any

import requests

TIMEOUT = 30


class PgError(RuntimeError):
    """PostgREST refused a request; body included. Never guess past it."""


def base_url() -> str:
    return os.environ.get("SUPABASE_URL", "").rstrip("/")


def service_key() -> str:
    return os.environ.get("SUPABASE_SERVICE_KEY", "")


def enabled() -> bool:
    return bool(base_url() and service_key())


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    k = service_key()
    h = {"apikey": k, "Authorization": f"Bearer {k}",
         "Content-Type": "application/json"}
    h.update(extra or {})
    return h


def _check(resp: requests.Response, what: str) -> None:
    if resp.status_code // 100 != 2:
        raise PgError(f"{what} -> HTTP {resp.status_code}: {resp.text[:500]}")


def upsert(table: str, rows: list[dict[str, Any]], *, on_conflict: str,
           session: requests.Session | None = None) -> int:
    """Bulk upsert via PostgREST merge-duplicates. Returns row count sent.
    Chunked so a big backfill never builds a pathological payload."""
    if not rows:
        return 0
    s = session or requests.Session()
    url = f"{base_url()}/rest/v1/{table}?on_conflict={on_conflict}"
    headers = _headers({"Prefer": "resolution=merge-duplicates,return=minimal"})
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        resp = s.post(url, data=json.dumps(chunk), headers=headers,
                      timeout=TIMEOUT)
        _check(resp, f"upsert {table} ({len(chunk)} rows)")
    return len(rows)


def insert(table: str, rows: list[dict[str, Any]], *,
           session: requests.Session | None = None) -> int:
    """Plain append (events, channel_runs)."""
    if not rows:
        return 0
    s = session or requests.Session()
    url = f"{base_url()}/rest/v1/{table}"
    headers = _headers({"Prefer": "return=minimal"})
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        resp = s.post(url, data=json.dumps(chunk), headers=headers,
                      timeout=TIMEOUT)
        _check(resp, f"insert {table} ({len(chunk)} rows)")
    return len(rows)


def select(table: str, query: str = "", *,
           session: requests.Session | None = None) -> list[dict]:
    """GET rows; query is a raw PostgREST query string (caller-built)."""
    s = session or requests.Session()
    url = f"{base_url()}/rest/v1/{table}"
    if query:
        url += f"?{query}"
    resp = s.get(url, headers=_headers(), timeout=TIMEOUT)
    _check(resp, f"select {table}")
    return resp.json()
