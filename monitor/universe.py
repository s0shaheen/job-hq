"""The reviewed company universe, read from Postgres — the engine's side of P7's verdict.

`user_companies.review_state` (migration 0008) is where a human's decision about a company
lives: `proposed` awaits them, `approved` is in their universe, `dismissed` is a no. 0008 says
in its own header that *"the sweep must NOT pull"* a proposed row, and P7 shipped the grid that
records those decisions — but nothing in Python had ever read the column, so the verdict was a
value in a table that changed nothing. This module is the read.

Two questions, both answered here so neither is answered twice:

  * **What does the sweep pull for this person?** `swept_companies` — approved AND `monitor`,
    which is the pg spelling of the sheet's Companies-tab `monitor` checkbox. Both conditions
    are checked even though 0008's `user_companies_monitor_needs_approval` CHECK already makes
    `monitor` imply `approved`: a filter that relies on a constraint holding is a filter that
    silently widens the day the constraint is relaxed, and this is the one filter whose failure
    mode is fetching a company the human said no to.
  * **What must the discovery agent never propose again?** `dismissed_name_keys` — normalized
    through `core.companykeys`, because the agent proposes NAMES and the verdict is stored
    against a company row. `decided_name_keys` is the wider set (anything already in their
    universe, in any state), which is what the design's "score / dedup against the universe"
    step actually needs: re-proposing a company somebody already approved is noise, and
    re-proposing one they dismissed is worse than noise.

WHAT THIS MODULE IS NOT: a bridge between the sheet and Postgres. `monitor/run.py` still takes
its company list from the HQ spreadsheet's Companies tab, which is the right and only source
for the sheet-era operator — his universe is not in Postgres. Which store is authoritative for
which user is an OPEN FORK for the owner, written up in docs/plans/COMPANY-DISCOVERY.md
("Open fork: the sheet↔pg company bridge"); inventing a mirror in either direction here would
be answering a product question with a code change, and the two stores disagreeing about who is
watched is exactly the failure that costs a person their applications.

Reads are through `core.pg.select` — PostgREST, columns named, one request. Absent SUPABASE_*
every reader returns empty with a loud ::warning rather than crashing (house policy, matching
monitor.pgmirror and monitor.discover_universe): the engine still runs for a user who has no
v2 store.
"""
from __future__ import annotations

import uuid as _uuid
from dataclasses import dataclass, field

import requests

from core import pg
from core.companykeys import company_name_key
from monitor.models import Company

#: The three states 0008's CHECK admits. Spelled out so a typo in a caller's filter is a
#: KeyError here rather than a silently-empty result set from PostgREST.
REVIEW_STATES = ("proposed", "approved", "dismissed")

#: The embedded read the grid's own view uses: the per-user row plus the shared company it
#: points at. `companies(...)` is PostgREST's FK embed, so this is one round trip.
_SELECT = ("select=review_state,monitor,priority,seeded,"
           "companies(name,ats,slug,reliability_tier,resolution_method,source)")


@dataclass
class UniverseSlice:
    """What the sweep would pull for one person, and what it honestly cannot.

    `unpullable` is not an error list. A tier-3 row is the design's floor — "manual link /
    best-effort, tracked, not auto-pulled" — and a human can legitimately approve one. Handing
    it to `monitor.fetchers.get_jobs_for` with an empty `ats` would quarantine it as a fetch
    error every single sweep, which reads to an operator as a broken company rather than as a
    company nobody has grounded yet. Separating the two is the difference between a coverage
    meter that can be trusted and one that counts its own floor as breakage.
    """
    companies: list[Company] = field(default_factory=list)
    unpullable: list[str] = field(default_factory=list)


def _skip(what: str) -> None:
    print(f"::warning title=universe {what} skipped::SUPABASE_URL/SUPABASE_SERVICE_KEY unset — "
          f"the v2 store is not provisioned (db/README.md)")


def _uid(user_id: str) -> str:
    """Validate a user id as a UUID before it is interpolated into a query string.

    `users.id` is a uuid, so anything else is a caller bug — but this module builds a raw
    PostgREST query and runs it under the SERVICE ROLE, which RLS does not constrain. An
    unvalidated id is a filter-injection door: `?user_id=eq.x&select=*` would drop the tenant
    predicate and hand back rows for a user who never asked, and `&limit=` or an `or=` clause
    could widen it further. Parsing rather than escaping is what makes that unrepresentable —
    a value that survives `uuid.UUID()` has no `&`, `=`, `?` or `.` to inject with.

    Returns the canonical string form, so a braced or upper-case id still matches the column.
    """
    try:
        return str(_uuid.UUID(str(user_id)))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError(f"user_id must be a UUID, got {user_id!r}") from exc


def _rows(user_id: str, query: str, session: requests.Session | None = None) -> list[dict]:
    if not pg.enabled():
        return []
    return pg.select("user_companies", f"user_id=eq.{_uid(user_id)}&{query}", session=session)


def swept_companies(user_id: str, session: requests.Session | None = None) -> UniverseSlice:
    """The companies this user's sweep may pull: review_state='approved' AND monitor.

    Returns `monitor.models.Company` — deliberately the same shape `SheetStore.read_companies`
    returns, so the day the sheet↔pg fork above is settled this is a source swap and not a
    rewrite. `monitor=True` on every returned row is not a copy of the column, it is what the
    filter already proved.
    """
    _uid(user_id)          # validate BEFORE the store check: a bad id is a caller bug either way
    if not pg.enabled():
        _skip("swept_companies")
        return UniverseSlice()
    rows = _rows(user_id, f"review_state=eq.approved&monitor=is.true&{_SELECT}", session=session)
    out = UniverseSlice()
    for r in rows:
        c = r.get("companies") or {}
        name = (c.get("name") or "").strip()
        ats = (c.get("ats") or "").strip()
        slug = (c.get("slug") or "").strip()
        if not name and not slug:
            continue                       # a row with neither identity is not a company
        if not ats or not slug:
            out.unpullable.append(name)    # approved, tracked, no board — the tier-3 floor
            continue
        out.companies.append(Company(name=name, ats=ats, slug=slug, monitor=True,
                                     seeded=bool(r.get("seeded")),
                                     priority=bool(r.get("priority"))))
    return out


def decided_name_keys(user_id: str, session: requests.Session | None = None,
                      states: tuple[str, ...] = REVIEW_STATES) -> set[str]:
    """Normalized names this user has already ruled on — the agent's dedup set.

    Default is every state, including `proposed`: a name sitting in somebody's review pile is
    already asked, and proposing it again just makes the pile they have to work through longer.
    """
    _uid(user_id)          # validate BEFORE the store check (see _uid: this runs as service role)
    unknown = [s for s in states if s not in REVIEW_STATES]
    if unknown:
        raise ValueError(f"unknown review state(s): {unknown}")
    if not pg.enabled():
        _skip("decided_name_keys")
        return set()
    # PostgREST `in.(a,b)` — the states are from the closed tuple above, never caller text.
    filt = f"review_state=in.({','.join(states)})"
    rows = _rows(user_id, f"{filt}&select=companies(name)", session=session)
    return {k for r in rows
            if (k := company_name_key(((r.get("companies") or {}).get("name"))))}


def dismissed_name_keys(user_id: str, session: requests.Session | None = None) -> set[str]:
    """Normalized names this user said NO to. Nothing may propose these again."""
    return decided_name_keys(user_id, session=session, states=("dismissed",))
