"""Is Postgres an echo of the sheet, or a writer in its own right — Phase C's switch.

    HQ_PG_WRITES unset (default)  Phase A, byte-for-byte: `monitor.pgmirror` echoes
                                  the Feed into the store as the LAST step of the
                                  monitor chain, `tracker.join` writes the sheet and
                                  only the sheet, and heartbeats live in Config alone.
                                  A pg failure fails that tail step and nothing else —
                                  the sweep has already flushed, snapshotted and
                                  heartbeat by the time the mirror runs.

    HQ_PG_WRITES=first_class      pg is load-bearing. The sweep writes the store
                                  itself and FAILS if it can't; `join` applies every
                                  email-event match to `applications` through 0010's
                                  status lock; the backup/digest beats land in both
                                  stores and the digest's watchdog reads both. The
                                  sheet is still written — dual-write runs until
                                  Phase D — it is just no longer the only store whose
                                  success counts.

Operator-owned env (SSM), not a Config-tab knob: the same class as
`HQ_COMPANIES_SOURCE` (monitor/companysource.py), with a blast radius of "which
store is authoritative" rather than a per-user preference.

Two refusals, both deliberate:

* **first_class without credentials** raises. A pg-first engine that silently
  degrades to sheet-only is Phase A wearing Phase C's name, and every hour it runs
  is an hour of divergence nobody is measuring.
* **an unrecognised value** raises rather than falling back to the echo. The
  Config-tab rule ("bad values fall back to defaults and alert") is for knobs a human
  types on a phone; this is a two-value cutover switch the operator sets once, and
  `HQ_PG_WRITES=firstclass` quietly running Phase A while everyone believes Phase C is
  live is exactly the silent divergence this phase exists to end.
"""
from __future__ import annotations

import os
import uuid as _uuid

FLAG_ENV = "HQ_PG_WRITES"
USER_ENV = "HQ_PG_USER_ID"

#: The echo. The default, and the value that means "change nothing".
MIRROR = "mirror"
#: pg writes are part of the job's contract; failing one fails the job.
FIRST_CLASS = "first_class"


def mode() -> str:
    """`MIRROR` or `FIRST_CLASS`. Anything else is a typo, and raises."""
    raw = os.environ.get(FLAG_ENV, "").strip().lower()
    if raw in ("", MIRROR):
        return MIRROR
    if raw == FIRST_CLASS:
        return FIRST_CLASS
    raise RuntimeError(
        f"{FLAG_ENV}={raw!r} is not a mode — use {FIRST_CLASS!r}, {MIRROR!r}, or "
        f"leave it unset; refusing to guess which store is authoritative")


def uid(raw: str) -> str:
    """Validate a `users.id` as a UUID, and return its canonical string form.

    ONE validator, because there were two behaviours for one bad value: the flag
    gate accepted any non-empty string while `core.beats` parsed it, so
    `HQ_PG_USER_ID=salman` gave the sweep an opaque PostgREST 4xx at 07:00 and the
    snapshot a clear message at 03:53. It is also the injection guard — every
    engine read interpolates this id into a raw PostgREST filter under the SERVICE
    ROLE, which RLS does not constrain, and a value that survives `uuid.UUID()`
    has no `&`, `=`, `?` or `.` to inject with.
    """
    try:
        return str(_uuid.UUID(str(raw).strip()))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError(f"pg user id must be a UUID, got {raw!r}") from exc


def user_id(user: str | None = None) -> str:
    """Whose lanes the engine writes in pg, for THIS invocation.

    Resolved through `core.config.pg_user_id`, which is registry-authoritative the
    moment a `users:` map exists — the env var is a single flat SSM value and
    `handler._select_user` cannot remap it per lane (see that function). Returns
    '' when nothing is configured; `first_class` is what turns that into a refusal.
    """
    from core import config
    return config.pg_user_id(user)


def first_class() -> bool:
    """True when pg writes are load-bearing for this invocation.

    Callers read this as "must I write pg, and must I die if I can't". False is
    the whole of Phase A, so the pg import stays lazy — a sheet-only run must not
    pay for a store it never touches.

    The refusal is per-LANE, not per-process. In a multi-user registry a lane
    whose block carries no `pg_user_id` must abort, never inherit: the fallback
    that "works" is the one that writes dad's feed into salman's store, and it
    would look exactly like success.
    """
    if mode() != FIRST_CLASS:
        return False
    from core import config, pg
    who = user_id()
    if not (pg.enabled() and who):
        from core.config import current_user
        lane = current_user() if (config._registry_doc().get("users") or {}) else ""
        where = (f"user {lane!r} has no pg_user_id in hq.config.yaml"
                 if lane else f"{USER_ENV} unset")
        raise RuntimeError(
            f"{FLAG_ENV}={FIRST_CLASS} but SUPABASE_URL/SUPABASE_SERVICE_KEY or the pg "
            f"user id is missing ({where}) — refusing to run pg-first against no pg, "
            f"and refusing to fall through to another tenant's uuid")
    uid(who)          # a malformed id fails HERE, at the gate, not at the first POST
    return True
