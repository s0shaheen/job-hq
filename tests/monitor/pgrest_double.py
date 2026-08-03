"""An in-memory PostgREST, narrow on purpose and loud where it is narrow.

`PgFeedStore` talks to Postgres the way every other engine module does: through
`core.pg`, which builds a PostgREST query string and puts it on the wire. Testing it
therefore needs something on the other end of `core.pg`, and there are two honest
options. A recorder (the `tests/monitor/test_universe.py` pattern) proves the request
is the one intended but can never prove the sweep did any work, and "the sweep
completed" is exactly the claim the cutover has to make. So this is a store: requests
go in, rows change, later reads see them.

**Why a double you can trust more than the usual one.** The failure mode of a hand-
written fake backend is that it quietly ignores a filter it does not understand — and
an ignored `pushed_at=is.null` is the fill-blank latch turning into an overwrite, with
every test still green because the row count never changes. So this one refuses:
every filter term must parse into a predicate it actually applies, and anything else
raises `UnsupportedQuery` naming the term. The grammar is small because `PgFeedStore`
emits a small grammar; growing the store means growing this and seeing the failure
that demands it.

It also enforces the three schema rules that make a wrong write look right without
them: `user_postings.posting_key` must reference a posting that exists,
`user_postings.disposition` must be one of the CHECK's three values, and
`postings.first_seen` is NOT NULL. Those are cheap here and they are the constraints a
mis-shaped upsert would otherwise sail past. Everything else about real Postgres —
RLS, grants, the entitlement gate, the migration itself — is proven where it can only
be proven, against a real server in `tests/db/`.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import unquote

#: table -> primary key columns. Upserts merge on these; PostgREST's `on_conflict`
#: is checked against them so a caller that conflicts on the wrong column is a
#: failure here rather than a duplicate row.
PRIMARY_KEYS = {
    "companies": ("id",),
    "user_companies": ("user_id", "company_id"),
    "postings": ("key",),
    "user_postings": ("user_id", "posting_key"),
    "monitor_sweep_state": ("user_id",),
}

#: table -> {embed name: (local column, foreign table, foreign column)}. The only
#: FK embeds `PgFeedStore` and `monitor.universe` ask for.
EMBEDS = {
    "user_postings": {"postings": ("posting_key", "postings", "key")},
    "user_companies": {"companies": ("company_id", "companies", "id")},
}

DISPOSITIONS = ("qualified", "filtered", "needs-info")


class UnsupportedQuery(AssertionError):
    """A filter term this double cannot apply.

    An `AssertionError` because a silently-dropped predicate is a test lying, not a
    product error — and dropping one is how a fake backend passes a test the real
    server would fail.
    """


def _split_in_list(raw: str) -> list[str]:
    """`("a","b,c")` -> ['a', 'b,c']. Quotes are what make a comma in a company
    name survive, so they are parsed rather than stripped."""
    body = raw[1:-1] if raw.startswith("(") and raw.endswith(")") else raw
    if not body:
        return []
    out, cur, in_quotes, escaped = [], [], False, False
    for ch in body:
        if escaped:
            cur.append(ch)
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            in_quotes = not in_quotes
        elif ch == "," and not in_quotes:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return out


def _coerce(value: Any, like: Any) -> Any:
    """Compare a query-string value against a stored one of any type.

    PostgREST filters arrive as text; the stored column may be an int (company_id) or
    a bool. Comparing "3" to 3 as strings would match nothing, and a filter that
    matches nothing is the successful-looking no-op this module exists to prevent.
    """
    if isinstance(like, bool):
        return str(value).lower() in ("true", "t", "1")
    if isinstance(like, int) and not isinstance(like, bool):
        try:
            return int(value)
        except (TypeError, ValueError):
            return value
    return value


def _predicate(term: str):
    """One `col=op.value` term -> a row predicate, or raise."""
    col, sep, rest = term.partition("=")
    if not sep:
        raise UnsupportedQuery(f"not a filter term: {term!r}")
    op, _, raw = rest.partition(".")
    raw = unquote(raw)
    if op == "eq":
        return lambda row: str(row.get(col)) == str(_coerce(raw, row.get(col)))
    if op == "in":
        wanted = _split_in_list(raw)
        return lambda row: any(
            str(row.get(col)) == str(_coerce(w, row.get(col))) for w in wanted)
    if op == "is":
        if raw == "null":
            return lambda row: row.get(col) is None
        if raw in ("true", "false"):
            want = raw == "true"
            return lambda row: bool(row.get(col)) is want
        raise UnsupportedQuery(f"is.{raw!r} is not supported")
    raise UnsupportedQuery(f"operator {op!r} is not supported (term {term!r})")


_EMBED = re.compile(r"^(\w+)\((.*)\)$")


def _parse_select(spec: str) -> tuple[list[str], dict[str, list[str]]]:
    """`a,b,tbl(c,d)` -> (['a','b'], {'tbl': ['c','d']}). One embed level, which is
    all PostgREST is asked for here."""
    cols, embeds, depth, cur = [], {}, 0, []
    for ch in spec:
        if ch == "," and depth == 0:
            cols.append("".join(cur))
            cur = []
            continue
        depth += ch == "("
        depth -= ch == ")"
        cur.append(ch)
    if cur:
        cols.append("".join(cur))
    plain = []
    for c in cols:
        m = _EMBED.match(c.strip())
        if m:
            embeds[m.group(1)] = [x.strip() for x in m.group(2).split(",")]
        elif c.strip():
            plain.append(c.strip())
    return plain, embeds


class PgRestDouble:
    """The store. Install it with `install(monkeypatch)`."""

    def __init__(self) -> None:
        self.tables: dict[str, list[dict]] = {t: [] for t in PRIMARY_KEYS}
        #: Every request, in order — so a test can assert on the wire form as well
        #: as on the outcome.
        self.calls: list[tuple[str, str, str]] = []   # (verb, table, query)

    # ------------------------------------------------------------- constraints

    def _check(self, table: str, row: dict) -> None:
        if table == "postings" and not row.get("first_seen"):
            raise AssertionError("postings.first_seen is NOT NULL")
        if table == "user_postings":
            d = row.get("disposition")
            if d not in DISPOSITIONS:
                raise AssertionError(
                    f"user_postings.disposition check: {d!r} not in {DISPOSITIONS}")
            keys = {r["key"] for r in self.tables["postings"]}
            if row.get("posting_key") not in keys:
                raise AssertionError(
                    f"user_postings.posting_key -> postings.key: "
                    f"{row.get('posting_key')!r} does not exist")

    # ------------------------------------------------------------------ verbs

    def _where(self, table: str, query: str):
        preds, select = [], ""
        for term in [t for t in query.split("&") if t]:
            if term.startswith("select="):
                select = term[len("select="):]
                continue
            preds.append(_predicate(term))
        rows = [r for r in self.tables[table] if all(p(r) for p in preds)]
        return rows, select

    def select(self, table: str, query: str = "", *, session=None) -> list[dict]:
        self.calls.append(("GET", table, query))
        rows, select = self._where(table, query)
        if not select:
            return [dict(r) for r in rows]
        plain, embeds = _parse_select(select)
        out = []
        for r in rows:
            item = {c: r.get(c) for c in plain}
            for name, cols in embeds.items():
                local, ftable, fcol = EMBEDS[table][name]
                match = next((f for f in self.tables[ftable]
                              if f.get(fcol) == r.get(local)), None)
                item[name] = {c: match.get(c) for c in cols} if match else None
            out.append(item)
        return out

    def upsert(self, table: str, rows: list[dict], *, on_conflict: str,
               session=None) -> int:
        self.calls.append(("POST", table, f"on_conflict={on_conflict}"))
        pk = PRIMARY_KEYS[table]
        if tuple(c.strip() for c in on_conflict.split(",")) != pk:
            raise UnsupportedQuery(
                f"on_conflict={on_conflict!r} is not {table}'s primary key {pk}")
        for row in rows:
            existing = next(
                (r for r in self.tables[table]
                 if all(r.get(c) == row.get(c) for c in pk)), None)
            if existing is None:
                merged = dict(row)
                self._check(table, merged)
                self.tables[table].append(merged)
            else:
                merged = {**existing, **row}
                self._check(table, merged)
                existing.update(row)
        return len(rows)

    def insert(self, table: str, rows: list[dict], *, session=None,
               timeout=None) -> int:
        self.calls.append(("POST", table, "insert"))
        for row in rows:
            self._check(table, row)
            self.tables[table].append(dict(row))
        return len(rows)

    def patch(self, table: str, query: str, values: dict, *, session=None,
              timeout=None) -> None:
        if not query:
            raise AssertionError("patch with an empty query would update every row")
        self.calls.append(("PATCH", table, query))
        rows, _ = self._where(table, query)
        for r in rows:
            merged = {**r, **values}
            self._check(table, merged)
            r.update(values)

    # ------------------------------------------------------------- test setup

    def add_company(self, name: str, ats: str = "greenhouse", slug: str = "",
                    *, user_id: str, monitor: bool = True, seeded: bool = False,
                    review_state: str = "approved", priority: bool = False) -> int:
        cid = len(self.tables["companies"]) + 1
        self.tables["companies"].append(
            {"id": cid, "name": name, "ats": ats, "slug": slug or name.lower(),
             "reliability_tier": 1, "resolution_method": "manual",
             "source": "fixture"})
        self.tables["user_companies"].append(
            {"user_id": user_id, "company_id": cid, "monitor": monitor,
             "priority": priority, "seeded": seeded, "review_state": review_state})
        return cid

    def postings_for(self, user_id: str) -> dict[str, dict]:
        """The user's slice, joined — what "the sweep actually wrote" looks like."""
        by_key = {p["key"]: p for p in self.tables["postings"]}
        return {u["posting_key"]: {**by_key.get(u["posting_key"], {}), **u}
                for u in self.tables["user_postings"]
                if u["user_id"] == user_id}


def install(monkeypatch, double: PgRestDouble | None = None) -> PgRestDouble:
    """Point `core.pg` at the double for the duration of a test.

    Patched on `core.pg` itself, not on each importer, so a module that reaches
    `core.pg` by a path nobody predicted still lands here rather than on the network.
    """
    from core import pg

    d = double or PgRestDouble()
    monkeypatch.setenv("SUPABASE_URL", "http://pg.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "test-key-not-a-secret")
    monkeypatch.setattr(pg, "select", d.select)
    monkeypatch.setattr(pg, "upsert", d.upsert)
    monkeypatch.setattr(pg, "insert", d.insert)
    monkeypatch.setattr(pg, "patch", d.patch)
    return d
