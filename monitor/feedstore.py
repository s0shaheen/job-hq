"""Which store discovery runs on — the RM-12 cutover switch, and its refusal.

    HQ_FEED_STORE=sheet   (default) `HQFeedStore` over the HQ spreadsheet, exactly
                          as before. Nothing about a sheet-mode run changes.
    HQ_FEED_STORE=pg      `PgFeedStore`. The spreadsheet is not opened for the
                          sweep's data at all.

Operator-owned env (SSM), not a Config-tab knob — the same class as
`HQ_COMPANIES_SOURCE`, and for the same reason: this decides which store the product
reconciles against, which is an infrastructure cutover and not a per-user preference.

**There is no fallback, and that is the whole design.** `HQ_FEED_STORE=pg` with no
Postgres behind it raises. It does not open the spreadsheet instead, it does not warn
and continue, and it does not return an empty store. A silent revert to the Sheet is
indistinguishable from a successful pg run — same boards swept, same rows written,
same exit code, same summary — so the only moment it can be caught is this one, before
anything runs. That is exactly what `tests/monitor/sheet_poison.py` exists to detect
after the fact, and a detector is a second line, not the first.

The refusal is also not symmetrical, on purpose. Sheet mode has no equivalent check:
the Sheet path already fails loudly at `HQ.open()` when its credential is missing.

WHAT THIS SWITCH DOES NOT CUT OVER, stated because "the sweep runs on Postgres" is
easy to over-read.

**`HQ_FEED_STORE=pg` IS NOT A DEPLOYABLE CONFIGURATION YET**, and it says so by
refusing rather than by a comment nobody reads. The first review of this branch found
the reason, and it is the finding worth keeping: proving that the STORE cannot silently
revert is worth nothing while other lanes in the same job still open the spreadsheet
and write over what the sweep just did. Three of them did.

  * `monitor.pgmirror` is the SECOND STEP OF THE SAME `monitor` JOB
    (`infra/app/handler.py:36`). Its input is the Feed TAB, so under pg mode it would
    read a tab the sweep never wrote and upsert it over `postings`/`user_postings` —
    rewriting status, tags, geo and disposition for every row still in that tab, exit
    0, no alert. It now stands down on this mode, the way it already stands down under
    `HQ_PG_WRITES=first_class`.
  * `monitor.regate` and `monitor.review` build `HQFeedStore` directly and run at 15:00
    UTC. Under pg mode the sweep leaves most rows untagged ON PURPOSE — `run.py` says
    review drains them nightly — so a review that tags the spreadsheet instead means
    the Postgres rows are never tagged and never re-gated. Neither can simply be
    swapped: `regate` reads `hq.tab("feed").records()` raw, not through the protocol.
    Both now REFUSE under pg rather than run against the wrong store.
  * The quiet-hours hold writes the Outbox TAB (`core/outbox.py`), which has no
    Postgres home at all — no table, no RPC, per the inventory. A pg-mode sweep that
    hits quiet hours reaches the spreadsheet. That is a real hole, not a hypothetical
    one, and `tests/monitor/test_cutover.py` drives it through the real
    `core.notify.push` to pin that it fails LOUDLY instead of being swallowed.

So the switch is honest about being partial: everything downstream of it either moves
or refuses, and nothing quietly does the wrong thing. Before pg mode is deployable it
needs a Postgres `review`/`regate` and an Outbox with a Postgres home.

WHAT IT WOULD STILL NOT CUT OVER even then. It selects the STORE that `run_monitor`
reconciles through — the sixteen `SheetStore` methods, which is where the feed, the
company list, the tags, the dispositions, the push latch and the sweep cursor live.
`monitor/run.py:main` still reads the Config tab for its `RuntimeConfig` and the
profile overlay, and still heartbeats into Config. Those are the cross-cutting
facilities the RM-12 inventory lists as having no Postgres home
(`docs/plans/SHEET-INVENTORY.md` §3), and none of them can move until the Config-tab
authority question is answered.

And per the inventory's ordering rule (§6): cutting over does NOT delete a writer.
Every Sheet writer in the repository is untouched by this file. The Sheet is still the
authoritative store, `tracker/snapshot.py` and `selfheal.yml` are still its only two
backups, and the Postgres backup that would replace them is hard-disabled pending
RM-01.
"""
from __future__ import annotations

import os
import sys

STORE_ENV = "HQ_FEED_STORE"
SHEET = "sheet"
PG = "pg"
MODES = (SHEET, PG)


def mode() -> str:
    """The configured store, validated.

    A typo is a refusal rather than a default. `HQ_FEED_STORE=postgres` silently
    meaning "sheet" is the same silent revert this module exists to prevent, arriving
    through the spelling instead of through the failure path.

    SET-BUT-EMPTY IS NOT UNSET. `(os.environ.get(ENV) or SHEET)` treats `""` as
    absent, so `HQ_FEED_STORE=" "` raised while `HQ_FEED_STORE=""` quietly returned
    `sheet` — and a terraform variable that defaults to `""` reads to an operator as
    "the cutover is configured". Presence is therefore tested with `in os.environ`,
    and an empty value is a refusal like any other unusable one.
    """
    if STORE_ENV not in os.environ:
        return SHEET
    raw = os.environ[STORE_ENV].strip().lower()
    if raw not in MODES:
        raise RuntimeError(
            f"{STORE_ENV}={raw!r} is not a store — use {SHEET!r} or {PG!r}, or unset "
            f"it entirely; refusing to guess which store discovery runs on. An empty "
            f"value is not 'unset': a variable that defaults to '' reads as configured")
    return raw


def refuse_if_pg(lane: str, why: str) -> None:
    """A Sheet-only lane must not run while the feed store is Postgres.

    Not a stand-down — a REFUSAL. Standing down would mean the lane's work silently
    does not happen, and for `review` that is "nothing is ever tagged" presented as a
    clean run. Raising puts the reason in the job's failure, which is the only channel
    an unattended lane has.

    The distinction matters and is made per caller: `monitor.pgmirror` genuinely has
    nothing to do under pg mode (the sweep already wrote the store), so it stands down
    and says so. `regate` and `review` have work to do that they cannot do, so they
    stop.
    """
    if mode() == PG:
        raise RuntimeError(
            f"{STORE_ENV}={PG} but {lane} {why}. Refusing to run it against the "
            f"spreadsheet: under pg mode the sweep does not write the Feed tab, so "
            f"this lane would read stale rows and write its results where nothing "
            f"reads them. See monitor/feedstore.py on what pg mode does not yet cover")


def resolve(*, hq_factory, user: str = "", disposer=None, session=None):
    """(store, mode). Loud on the way through, and never quietly the other one.

    `hq_factory` is a zero-argument callable rather than an open `HQ`, so a pg-mode
    run never opens the spreadsheet to build the store. The caller may still need an
    `HQ` for the Config-tab facilities named in the module docstring; that is its
    decision to make and to justify, not one this function makes on its behalf.
    """
    chosen = mode()
    if chosen == PG:
        from core import pg, pgwrites
        from monitor.pgstore import PgFeedStore

        uid = pgwrites.user_id(user)
        if not uid:
            raise RuntimeError(
                f"{STORE_ENV}={PG} but no pg user id is configured for user "
                f"{user or '(default)'} — refusing to fall back to the spreadsheet, "
                f"which would look exactly like a successful cutover")
        # Validated HERE, before the environment checks below, so a caller bug is
        # reported as a caller bug. `HQ_PG_USER_ID=<slug>` reaching the flag-coherence
        # error instead would send an operator to fix the wrong variable.
        from monitor.pgstore import user_uuid
        user_uuid(uid)
        if not pg.enabled():
            raise RuntimeError(
                f"{STORE_ENV}={PG} but SUPABASE_URL/SUPABASE_SERVICE_KEY are unset — "
                f"refusing to fall back to the spreadsheet")
        # The two flags must agree about which store is authoritative, and by default
        # they do NOT: `core/pgwrites.py` defaults to MIRROR, which means "the Sheet
        # is truth and Postgres is an echo". Discovery reading from Postgres while the
        # deployment says Postgres is an echo is not a configuration, it is two
        # answers — and the shipping combination was the live defect the first review
        # found: MIRROR left `monitor.pgmirror` running as the monitor job's second
        # step, overwriting the sweep's own rows from a Feed tab it never wrote.
        if pgwrites.mode() != pgwrites.FIRST_CLASS:
            raise RuntimeError(
                f"{STORE_ENV}={PG} requires {pgwrites.FLAG_ENV}="
                f"{pgwrites.FIRST_CLASS}, but it is {pgwrites.mode()!r}. Those two "
                f"disagree about which store is authoritative, and under "
                f"{pgwrites.MIRROR} the Feed-tab mirror still runs after this sweep "
                f"and would overwrite everything it just wrote")
        store = PgFeedStore(uid, disposer=disposer, session=session)
        print(f"[feedstore] source={PG} store=PgFeedStore", file=sys.stderr)
        return store, PG

    from monitor.sheet import HQFeedStore

    store = HQFeedStore(hq_factory(), disposer=disposer)
    print(f"[feedstore] source={SHEET} store=HQFeedStore", file=sys.stderr)
    return store, SHEET
