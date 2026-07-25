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

Writes go through ``core.pg.upsert("companies", …, on_conflict="name,ats,slug")`` ONLY — columns
addressed by name, never positionally (the durability contract extends to the pg store; the
metadata columns arrived additively in migration 0007). No new dependency: the keyless HTTP
resolver and PostgREST are both requests-only.

Cost: resolution is keyless HTTP (a few probes per name); the upsert is one bulk POST. There is
NO LLM call here — candidate naming/recall already happened upstream in the ingesters.
"""
from __future__ import annotations

import requests

from core import pg
from monitor.discover import discover as _resolve_ats
from monitor.discover import discover_workday

# Every row this stage emits was grounded to a direct ATS adapter, so it is day-of pullable.
# The universe design reserves tier 2 for aggregators (lagged) and tier 3 for manual/best-
# effort; both are produced elsewhere and are deliberately never written from here.
TIER_DIRECT = 1

# Exactly the public.companies columns this stage writes. The row shape is pinned so a stray
# ingester key (e.g. `category`) can never leak into a pg write as an unknown column.
COMPANY_COLUMNS = ("name", "ats", "slug", "source", "reliability_tier", "resolution_method")


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


def assemble(candidates: list[dict], session: requests.Session | None = None) -> list[dict]:
    """Ingested candidates → deduped, grounded `companies` rows (out-of-scope names dropped).

    Per candidate:
      • already carries ats+slug (pre-resolved, e.g. Common Crawl) → passthrough with
        ``resolution_method="ingested-slug"``; the resolver is NOT invoked.
      • name-only → resolve via the waterfall; grounded → ``resolution_method="discover-<ats>"``
        (or ``"workday-redirect"``); ungrounded → DROPPED (Tier-2/manual, not this stage's job).

    Every emitted row is a direct adapter → ``reliability_tier=1`` and carries the candidate's
    `source` through. Rows are deduped on (name, ats, slug) — the upsert conflict key — with
    first-seen winning, so the same slug mined twice, or two names landing on one board, is
    written once.
    """
    session = session or requests.Session()
    seen: set[tuple[str, str, str]] = set()
    rows: list[dict] = []
    for c in candidates:
        name = c.get("name") or ""
        source = c.get("source") or ""
        ats = (c.get("ats") or "").strip()
        slug = (c.get("slug") or "").strip()
        if ats and slug:
            method = "ingested-slug"          # pre-resolved: the mined slug is the board
        else:
            grounded = _resolve(name, session)
            if not grounded:
                continue                      # ungrounded name → Tier-2/manual, out of scope
            ats, slug, method = grounded
        key = (name, ats, slug)
        if key in seen:
            continue
        seen.add(key)
        rows.append(_company_row(name, ats, slug, source, method))
    return rows


def upsert_universe(rows: list[dict], session: requests.Session | None = None) -> int:
    """Write assembled rows through the ONE pg path; returns the row count sent.

    Thin by design — chunking, header-by-name addressing, and the fail-loud posture live in
    core.pg.upsert and must not be reimplemented here. The conflict key name,ats,slug matches
    the companies unique constraint, so re-runs are idempotent (merge-duplicates).
    """
    return pg.upsert("companies", rows, on_conflict="name,ats,slug", session=session)


def run(candidates: list[dict], session: requests.Session | None = None) -> dict:
    """assemble → upsert; return counts. The integration entrypoint used when pg creds exist.

    When SUPABASE_* is unset the write is skipped cleanly with a loud ::warning (house policy,
    matching monitor.pgmirror): a caller without the v2 store still gets assembled counts and a
    0 upsert instead of a crash. Returns {candidates, assembled, upserted}.
    """
    candidates = list(candidates)
    session = session or requests.Session()
    rows = assemble(candidates, session=session)
    if not pg.enabled():
        print(f"::warning title=discover_universe skipped::SUPABASE_URL/SUPABASE_SERVICE_KEY "
              f"unset — assembled {len(rows)} companies but the v2 store is not provisioned "
              f"(db/README.md)")
        upserted = 0
    else:
        upserted = upsert_universe(rows, session=session)
    return {"candidates": len(candidates), "assembled": len(rows), "upserted": upserted}


if __name__ == "__main__":
    # Demo: assemble a few real candidates through the LIVE keyless resolver and print the
    # resulting companies rows. No pg write — this path exists for eyeballing resolution and
    # runs fine without SUPABASE_* creds. run() is the entrypoint that also upserts.
    demo = [
        {"name": "Stripe", "source": "demo", "category": "fintech"},
        {"name": "Ramp", "source": "demo", "category": "fintech"},
        {"name": "Databricks", "source": "demo", "category": "data"},
        {"name": "Zzzq Nonexistent Holdings", "source": "demo", "category": "ghost"},
        {"name": "", "source": "commoncrawl", "category": "",       # pre-resolved passthrough
         "ats": "greenhouse", "slug": "airbnb"},
    ]
    assembled = assemble(demo)
    print(f"assembled {len(assembled)}/{len(demo)} candidate(s) into companies rows:")
    for r in assembled:
        label = r["name"] or "(slug-only)"
        print(f"  {label:26} → {r['ats']}/{r['slug']}  "
              f"[tier {r['reliability_tier']}, {r['resolution_method']}, src={r['source']}]")
    dropped = len(demo) - len(assembled)
    if dropped:
        print(f"  dropped {dropped} ungrounded candidate(s) → Tier-2/manual, out of scope here")
