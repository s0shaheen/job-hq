"""Which store feeds the sweep its company list — SHEET-SUNSET Phase B's switch.

    HQ_COMPANIES_SOURCE=sheet   (default) the Companies tab, exactly as before —
                                plus, when pg creds exist, a per-sweep DELTA log
                                against `swept_companies`: the soak instrument
                                the flip decision reads. Logging is the whole
                                point of the soak; it never alters the sweep.
    HQ_COMPANIES_SOURCE=pg      the pg universe (approved AND monitored), the
                                sheet no longer consulted for companies.

Operator-owned env (SSM), not a Config-tab knob: this is an infrastructure
cutover with a blast radius of "what does discovery sweep", not a per-user
preference — the same class as HQ_BACKUP_S3_BUCKET.

Fail-loud guard on the pg path: an empty pg universe while the sheet still
lists companies is a misconfiguration (wrong HQ_PG_USER_ID, unseeded store),
and quietly sweeping NOTHING is the silent-death shape this repo forbids —
abort the run instead; the ops push names this module.
"""
from __future__ import annotations

import os

from monitor.models import Company

SOURCE_ENV = "HQ_COMPANIES_SOURCE"
USER_ENV = "HQ_PG_USER_ID"
_DELTA_SAMPLE = 8


def _delta(sheet: list[Company], pg_rows: list[Company]) -> str:
    s = {(c.ats, c.slug) for c in sheet}
    p = {(c.ats, c.slug) for c in pg_rows}
    only_s = sorted(f"{a}/{g}" for a, g in s - p)
    only_p = sorted(f"{a}/{g}" for a, g in p - s)
    return (f"sheet={len(s)} pg={len(p)} sheet_only={len(only_s)} pg_only={len(only_p)}"
            + (f" sheet_only_sample={only_s[:_DELTA_SAMPLE]}" if only_s else "")
            + (f" pg_only_sample={only_p[:_DELTA_SAMPLE]}" if only_p else ""))


def resolve(store) -> list[Company]:
    """The sweep's company list, per the env switch. See module docstring."""
    from core import pg                      # local: keeps sheet-only paths import-light
    from monitor import universe

    from monitor import feedstore   # local: same import-weight reasoning as `pg`

    source = os.environ.get(SOURCE_ENV, "sheet").strip().lower() or "sheet"
    user_id = os.environ.get(USER_ENV, "")
    store_is_pg = feedstore.mode() == feedstore.PG

    # The sheet branch below calls `store.read_companies()`, and under a Postgres feed
    # store that IS `universe.swept_companies` — so the soak delta would compare pg
    # against pg and report perfect agreement by construction, forever
    # (`sheet=1 pg=1 sheet_only=0 pg_only=0`), while the flip decision is read off it.
    # An instrument that cannot disagree is not an instrument. Refuse instead of
    # quietly becoming the pg branch under the sheet branch's name.
    if store_is_pg and source != "pg":
        raise RuntimeError(
            f"{feedstore.STORE_ENV}={feedstore.PG} requires {SOURCE_ENV}=pg, but it is "
            f"{source!r}. The sheet branch reads the company list THROUGH the store, "
            f"so with a Postgres store it would silently be the pg branch — and the "
            f"soak delta it logs would compare Postgres against itself")

    if source == "pg":
        if not (pg.enabled() and user_id):
            raise RuntimeError(
                f"{SOURCE_ENV}=pg but SUPABASE_*/{USER_ENV} unset — refusing to sweep nothing")
        slice_ = universe.swept_companies(user_id)
        if not slice_.companies:
            # With a Postgres feed store there is no second opinion to ask: the
            # comparison below would run the SAME query and answer 0, so the guard
            # would pass and the sweep would visit no boards, quarantine nothing and
            # exit 0 — the silent death this module's docstring forbids. An empty
            # pullable universe is fatal on its own facts.
            if store_is_pg:
                raise RuntimeError(
                    f"{SOURCE_ENV}=pg returned 0 pullable companies and the feed store "
                    f"is Postgres, so there is no independent list to compare against "
                    f"— refusing to sweep nothing")
            sheet_n = len(store.read_companies())
            if sheet_n:
                raise RuntimeError(
                    f"{SOURCE_ENV}=pg returned 0 pullable companies while the sheet lists "
                    f"{sheet_n} — misconfigured universe, refusing to sweep nothing")
        if slice_.unpullable:
            print(f"[companysource] pg: {len(slice_.unpullable)} approved-but-boardless "
                  f"(tier-3) companies not sweepable")
        print(f"[companysource] source=pg companies={len(slice_.companies)}")
        return slice_.companies

    companies = store.read_companies()
    if pg.enabled() and user_id:
        try:
            slice_ = universe.swept_companies(user_id)
            print(f"[companysource] soak delta: {_delta(companies, slice_.companies)}")
        except Exception as e:               # the soak must never fail a sweep
            print(f"[companysource] soak delta unavailable: {type(e).__name__}: {e}")
    return companies
