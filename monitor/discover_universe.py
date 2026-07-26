"""Discovery integration — ingested candidates → resolved shared-universe rows → Postgres.

The P5 ingestion modules (ingest_edgar / ingest_commoncrawl / ingest_formadv / …) each expose
`candidates() -> list[dict]`; this module is the last mile that turns those candidates into
`public.companies` rows and upserts them through the one pg write path.

Two candidate shapes arrive:
  - name-only (EDGAR, Form ADV): ``{name, source, category}`` — the name is RECALL, not truth;
    it must be grounded to a real board before it can be trusted.
  - pre-resolved (Common Crawl): ``{name:"", source, category:"", ats:"greenhouse", slug}`` —
    the mined slug already IS the board, so no name→slug resolution step is needed.

Discipline (docs/plans/COMPANY-DISCOVERY.md): a proposed name self-corrects because an
ungrounded name simply drops out. Every name-only candidate is discarded unless the resolution
waterfall (monitor.discover: greenhouse/ashby/lever/smartrec, then Workday) grounds it to a
real, pullable board. An ungrounded name is Tier-2/aggregator or manual territory and is OUT OF
SCOPE here, so it is DROPPED rather than written as a half-row — a guessed write is corruption.
Only grounded rows reach Postgres, each a direct first-party adapter → ``reliability_tier=1``.

Writes go through ``core.pg.upsert("companies", …, on_conflict="name,ats,slug")`` and the
``reconcile_grounded_company`` RPC (migration 0009) ONLY — columns addressed by name, never
positionally (the durability contract extends to the pg store; the metadata columns arrived
additively in migration 0007). No new dependency: the keyless HTTP resolver and PostgREST are
both requests-only.

RECONCILE BEFORE UPSERT, and that ordering is the whole point of the step. A human can paste a
company name into the review grid before the resolver has ever seen it; 0008 writes that as an
UNGROUNDED row (ats='', slug='', tier 3 / 'manual') and binds their subscription to it. The
plain upsert conflicts on (name, ats, slug), a key that row cannot hold, so grounding the same
name later wrote a SECOND row and left the human subscribed to the unresolved one — watched,
never pulled. `reconcile()` asks Postgres to upgrade THAT row in place first, matching on the
normalized name (`core.companykeys`, the mirror of 0008's `company_name_key`); an in-place
upgrade needs no subscription repoint, so the paste and its grounding end up as one row and one
subscription. Rows the reconciler upgraded are then held OUT of the upsert: the upgraded row
keeps the human's spelling of the name, so re-upserting the resolver's spelling on the same
board would mint the very sibling this removes.

Cost: resolution is keyless HTTP (a few probes per name); reconcile is one small POST per
grounded NAME (slug-only Common Crawl rows are skipped locally — they have no name to match),
and the upsert is one bulk POST. There is NO LLM call here — candidate naming/recall already
happened upstream in the ingesters.
"""
from __future__ import annotations

import requests

from core import pg
from core.companykeys import company_name_key
from monitor.discover import discover as _resolve_ats
from monitor.discover import discover_workday

# Every row this stage emits was grounded to a direct ATS adapter, so it is day-of pullable.
# The universe design reserves tier 2 for aggregators (lagged) and tier 3 for manual/best-
# effort; both are produced elsewhere and are deliberately never written from here.
TIER_DIRECT = 1

# Exactly the public.companies columns this stage writes. The row shape is pinned so a stray
# ingester key (e.g. `category`) can never leak into a pg write as an unknown column.
COMPANY_COLUMNS = ("name", "ats", "slug", "source", "reliability_tier", "resolution_method")

# The reconciler in migration 0009.
#
# A constant, not an inline string, because the name is a CONTRACT with a migration and
# nothing about a wrong one is visible: a typo'd `pg.rpc()` name is a 404 from PostgREST at
# 03:00, and the earlier version of this shipped fully green through both suites because no
# test compared the two sides. `tests/core/test_migrations.py::
# test_the_reconcile_rpc_the_engine_calls_exists_in_a_migration` now parses the migrations for
# `create or replace function public.<this>` — the same check that file already makes for every
# RPC the web app calls, extended to the one the engine calls.
RECONCILE_FN = "reconcile_grounded_company"


def _company_row(name: str, ats: str, slug: str, source: str, method: str) -> dict:
    """Shape a grounded candidate EXACTLY as public.companies expects.

    `name` and `source` are coalesced to "" (never None): both columns are NOT NULL, and
    Common Crawl carries no human name — its identity is the slug, so "" is the correct
    pre-resolved name. Emitting exactly COMPANY_COLUMNS keeps the upsert positional-free and
    drops any non-column ingester keys.
    """
    return {
        "name": name or "",
        "ats": ats,
        "slug": slug,
        "source": source or "",
        "reliability_tier": TIER_DIRECT,
        "resolution_method": method,
    }


def _resolve(name: str, session: requests.Session) -> tuple[str, str, str] | None:
    """Ground a name via the direct-adapter waterfall, or None if it can't be grounded.

    Order mirrors monitor.discovery_agent.ground exactly — discover() first (its Greenhouse
    hits are verified against the board's own name), Workday only as the fallback — so the two
    grounding call sites can never drift apart. Returns (ats, slug, resolution_method).
    """
    ats, slug = _resolve_ats(name, session=session)
    if ats and slug:
        return ats, slug, f"discover-{ats}"
    wd = discover_workday(name, session=session)
    if wd:
        return "workday", wd, "workday-redirect"
    return None


def assemble(candidates: list[dict], session: requests.Session | None = None,
             exclude_keys: set[str] | None = None) -> list[dict]:
    """Ingested candidates → deduped, grounded `companies` rows (out-of-scope names dropped).

    Per candidate:
      • already carries ats+slug (pre-resolved, e.g. Common Crawl) → passthrough with
        ``resolution_method="ingested-slug"``; the resolver is NOT invoked.
      • name-only → resolve via the waterfall; grounded → ``resolution_method="discover-<ats>"``
        (or ``"workday-redirect"``); ungrounded → DROPPED (Tier-2/manual, not this stage's job).

    Every emitted row is a direct adapter → ``reliability_tier=1`` and carries the candidate's
    `source` through.

    DEDUP IS ON TWO KEYS, and the raw name is not one of them:

      • **(normalized name, ats, slug)** — first-seen wins. Deduping on the RAW name let
        'Aon' and 'AON ' both survive a batch, and since both ground to greenhouse/aon the
        upsert then wrote two grounded rows for one company — the ghost this feature exists to
        remove, arriving from the other direction. `company_name_key` is the same fold 0008
        indexes and `reconcile` matches on, so the batch and the database now agree about which
        strings are one company.
      • **(ats, slug) — board identity.** One board belongs to one company row (enforced from
        0009 by `companies_board_identity_key`). A second spelling landing on a board this
        batch has already claimed is a COLLISION, not a duplicate to drop quietly: the two
        names may be two real companies whose resolver output is wrong, so it is counted and
        warned about, and the row is left out. Dropping it silently would hide a resolver bug;
        letting it through would fail the upsert's whole 500-row chunk on the unique index.

    `exclude_keys` is a CALLER-SUPPLIED set of normalized names to skip, checked before the
    resolver runs (so a ruled-out name costs no HTTP probes). `run(user_id=…)` fills it from
    `monitor.universe.dismissed_name_keys`, which is how "the human said no" reaches the engine.
    It is deliberately a parameter and not a rule baked in here: `public.companies` is the
    design's monotonically-growing SHARED asset, and one person's dismissal must never decide
    whether a company exists for everybody else.

    Returns (rows, counts) where counts carries `batch_collisions` — 0 on every healthy run.
    """
    session = session or requests.Session()
    exclude = exclude_keys or set()
    seen: set[tuple[str, str, str]] = set()
    boards: dict[tuple[str, str], str] = {}
    counts = {"batch_collisions": 0}
    rows: list[dict] = []
    for c in candidates:
        name = c.get("name") or ""
        source = c.get("source") or ""
        ats = (c.get("ats") or "").strip()
        slug = (c.get("slug") or "").strip()
        key = company_name_key(name)
        if name and key in exclude:
            continue                          # already ruled on by this caller's human
        if ats and slug:
            method = "ingested-slug"          # pre-resolved: the mined slug is the board
        else:
            grounded = _resolve(name, session)
            if not grounded:
                continue                      # ungrounded name → Tier-2/manual, out of scope
            ats, slug, method = grounded
        if (key, ats, slug) in seen:
            continue                          # same company, same board, second spelling
        board = (ats, slug)
        if board in boards:
            # Two DIFFERENT normalized names on one board. Never two facts — and never
            # silently dropped either, because the likeliest cause is the resolver grounding
            # one of them wrongly (the ADM→'archer' shape P1 fixed once already).
            counts["batch_collisions"] += 1
            print(f"::warning title=discover_universe batch collision::{name!r} grounded to "
                  f"{ats}/{slug}, which {boards[board]!r} already claims in this batch — "
                  f"one board belongs to one company, so {name!r} was NOT written; check the "
                  f"resolver before adding it by hand")
            continue
        seen.add((key, ats, slug))
        boards[board] = name
        rows.append(_company_row(name, ats, slug, source, method))
    return rows, counts


def reconcile(rows: list[dict], session: requests.Session | None = None) -> tuple[list[dict], dict]:
    """Upgrade ungrounded placeholders in place; return (rows still needing an upsert, counts).

    One `reconcile_grounded_company` RPC (migration 0009) per NAMED row. The database does the
    deciding and the writing in one locked step — see that migration's header for why this is
    not a select-then-patch from here.

    Four outcomes, and each is reported rather than smoothed over:
      • ``upgraded``  — the placeholder became this board. The row is REMOVED from the upsert
        list: the upgraded row keeps the human's spelling of the name, and re-upserting the
        resolver's spelling on the same board is exactly the sibling row this removes.
      • ``none``      — no placeholder for this name AND the board is free; the row upserts as
        it always did.
      • ``collision`` — the board already has a row. The row is **held out of the upsert**, and
        that is load-bearing: upserting the colliding spelling conflicts on nothing (its
        (name, ats, slug) triple is new) so it INSERTS, which mints a third row and now fails
        against `companies_board_identity_key` — one racing spelling would take the whole
        500-row chunk down with it. 0009 also writes a `company.grounding_blocked` event to
        every subscriber of the stuck placeholder, so the person whose row stays tier 3 can see
        why. Merging is what nobody does silently: it repoints a subscription.
      • ``skipped``   — the candidate has no human name (Common Crawl slug-only). Never sent.

    An outcome this function does not recognise leaves the row in the upsert list. The upsert
    is idempotent, so keeping it is recoverable where silently discarding it is data loss.
    """
    session = session or requests.Session()
    counts = {"upgraded": 0, "collisions": 0}
    remaining: list[dict] = []
    for row in rows:
        if not company_name_key(row["name"]):
            remaining.append(row)             # slug-only: nothing to match, no round trip
            continue
        out = pg.rpc(RECONCILE_FN, {
            "p_name": row["name"],
            "p_ats": row["ats"],
            "p_slug": row["slug"],
            "p_tier": row["reliability_tier"],
            "p_method": row["resolution_method"],
        }, session=session) or {}
        outcome = out.get("outcome")
        if outcome == "upgraded":
            counts["upgraded"] += 1
            continue
        if outcome == "collision":
            counts["collisions"] += 1
            # stdout, like every other ::warning in this module — GitHub Actions only renders
            # the annotation on stdout, and one of these on stderr was invisible in the log
            # exactly where it mattered.
            print(f"::warning title=discover_universe collision::{row['name']!r} grounded to "
                  f"{row['ats']}/{row['slug']}, which company id {out.get('company_id')} "
                  f"already holds — merging would repoint a subscription, so both rows stand "
                  f"and {row['name']!r} was NOT written. Subscribers got a "
                  f"company.grounding_blocked event; resolve by hand "
                  f"(db/migrations/0009_universe_reconcile.sql)")
            continue
        remaining.append(row)
    return remaining, counts


def upsert_universe(rows: list[dict], session: requests.Session | None = None) -> int:
    """Write assembled rows through the ONE pg path; returns the row count sent.

    Thin by design — chunking, header-by-name addressing, and the fail-loud posture live in
    core.pg.upsert and must not be reimplemented here. The conflict key name,ats,slug matches
    the companies unique constraint, so re-runs are idempotent (merge-duplicates).
    """
    return pg.upsert("companies", rows, on_conflict="name,ats,slug", session=session)


def run(candidates: list[dict], session: requests.Session | None = None,
        exclude_keys: set[str] | None = None, user_id: str = "") -> dict:
    """assemble → reconcile → upsert; return counts. The entrypoint used when pg creds exist.

    `user_id` makes this a PER-USER pass: absent an explicit `exclude_keys`, the names that
    user has dismissed are read from `monitor.universe.dismissed_name_keys` and skipped before
    the resolver runs. Dismissals only — not the whole decided set — because an APPROVED
    company still belongs in the shared universe and still wants its board refreshed; it is
    only "no" that means "stop bringing me this".

    When SUPABASE_* is unset both writes are skipped cleanly with a loud ::warning (house
    policy, matching monitor.pgmirror): a caller without the v2 store still gets assembled
    counts instead of a crash. Reconcile is skipped in that case too, and it must be — it is a
    write, and a reconcile that "ran" against no database would report upgrades that did not
    happen. (`dismissed_name_keys` warns and returns empty on the same condition, so a
    `user_id` without a store degrades to an unfiltered pass rather than an empty one.)

    Returns {candidates, assembled, reconciled, collisions, batch_collisions, upserted}.
    `reconciled` is the number of pasted placeholders that became real boards, which is the
    number this whole change exists to make non-zero; the two collision counts are 0 on every
    healthy run and are the ones worth alerting on.
    """
    from monitor import universe   # local: keeps the import graph acyclic

    candidates = list(candidates)
    session = session or requests.Session()
    if exclude_keys is None and user_id:
        exclude_keys = universe.dismissed_name_keys(user_id, session=session)
    rows, acounts = assemble(candidates, session=session, exclude_keys=exclude_keys)
    if not pg.enabled():
        print(f"::warning title=discover_universe skipped::SUPABASE_URL/SUPABASE_SERVICE_KEY "
              f"unset — assembled {len(rows)} companies but the v2 store is not provisioned "
              f"(db/README.md)")
        return {"candidates": len(candidates), "assembled": len(rows), "reconciled": 0,
                "collisions": 0, "batch_collisions": acounts["batch_collisions"],
                "upserted": 0}
    to_upsert, counts = reconcile(rows, session=session)
    upserted = upsert_universe(to_upsert, session=session)
    return {"candidates": len(candidates), "assembled": len(rows),
            "reconciled": counts["upgraded"], "collisions": counts["collisions"],
            "batch_collisions": acounts["batch_collisions"], "upserted": upserted}


if __name__ == "__main__":
    # Demo: assemble a few real candidates through the LIVE keyless resolver and print the
    # resulting companies rows. No pg write — this path exists for eyeballing resolution and
    # runs fine without SUPABASE_* creds. run() is the entrypoint that also upserts.
    #
    # HQ_PG_USER_ID applies that user's dismissals first, so the demo shows the same filtered
    # candidate set a real per-user pass would resolve rather than a rosier one.
    import os

    from monitor import universe

    demo = [
        {"name": "Stripe", "source": "demo", "category": "fintech"},
        {"name": "Ramp", "source": "demo", "category": "fintech"},
        {"name": "Databricks", "source": "demo", "category": "data"},
        {"name": "Zzzq Nonexistent Holdings", "source": "demo", "category": "ghost"},
        {"name": "", "source": "commoncrawl", "category": "",       # pre-resolved passthrough
         "ats": "greenhouse", "slug": "airbnb"},
    ]
    _user = os.environ.get("HQ_PG_USER_ID", "")
    _excl = universe.dismissed_name_keys(_user) if _user else None
    if _excl:
        print(f"applying {len(_excl)} dismissal(s) recorded by {_user}")
    assembled, _counts = assemble(demo, exclude_keys=_excl)
    print(f"assembled {len(assembled)}/{len(demo)} candidate(s) into companies rows:")
    for r in assembled:
        label = r["name"] or "(slug-only)"
        print(f"  {label:26} → {r['ats']}/{r['slug']}  "
              f"[tier {r['reliability_tier']}, {r['resolution_method']}, src={r['source']}]")
    dropped = len(demo) - len(assembled) - _counts["batch_collisions"]
    if dropped:
        print(f"  dropped {dropped} ungrounded/dismissed candidate(s) → out of scope here")
    if _counts["batch_collisions"]:
        print(f"  {_counts['batch_collisions']} batch collision(s) — see the warnings above")
