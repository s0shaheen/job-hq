"""Discovery agent — generate → ground → verify (the recall-only loop).

The design's core discipline (docs/plans/COMPANY-DISCOVERY.md): inference is RECALL, never
truth. The LLM proposes company names a curated list would miss; every name it emits is
discarded unless the resolution waterfall (monitor.discover) grounds it to a real, pullable
board. Hallucinations self-correct because an ungrounded name simply drops out.

This module is the generate→ground core: propose candidate names for a facet, then resolve
each through the existing waterfall (greenhouse/ashby/lever/smartrec via discover(), Workday via
discover_workday()). Grounded names become Tier-1 companies; the rest are handed to the
aggregator/manual tiers, not trusted as-is. Scoring coverage against the oracle (monitor.oracle)
and the "find more like these" expansion compose on top of this and live in later increments.

THE HUMAN'S VERDICT IS AN INPUT. The design's trust model is review-and-bulk-approve, and a
review surface that re-asks a question you already answered is one people stop using. So the
loop takes `exclude_keys` — normalized names (`core.companykeys`) this person has already ruled
on — and drops them before grounding, which also means a ruled-out name costs no HTTP probes.
`discover_for_user` is the wiring: `monitor.universe.decided_name_keys` fills the set from
`user_companies.review_state`, so a DISMISSED company is never proposed a second time. Anything
skipped is reported on the result rather than silently vanishing; a filter you cannot see the
effect of is a filter nobody can debug.

Cost: generate_candidates makes ONE Haiku call (cents); grounding is keyless HTTP. No writes.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import requests

from core import llm
from core.companykeys import company_name_key
from monitor.discover import discover as _resolve_ats
from monitor.discover import discover_workday


@dataclass
class Resolved:
    name: str
    ats: str
    slug: str
    tier: int = 1   # grounded to a direct adapter → Tier 1 (day-of)


@dataclass
class DiscoveryResult:
    facet: str
    resolved: list[Resolved] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)  # proposed but ungrounded → Tier-2/manual
    skipped: list[str] = field(default_factory=list)     # already reviewed by this human

    @property
    def recall(self) -> float:
        """Fraction of proposed names the waterfall could ground (a within-batch signal,
        not the oracle's market recall).

        `skipped` is excluded from the denominator on purpose: a name the human already ruled
        on was never a test of the resolver, and counting it would make recall drift downward
        for the users who have reviewed the most — the opposite of the truth.
        """
        total = len(self.resolved) + len(self.unresolved)
        return (len(self.resolved) / total) if total else 0.0


def generate_candidates(facet: str, n: int = 30, *, model: str | None = None) -> list[str]:
    """LLM = recall. Returns candidate company NAMES (unverified — grounding decides truth).

    Empty list on any LLM failure (no key, timeout, bad JSON): a hiccup degrades to "found
    nothing this pass", never a crash or a bad write.
    """
    prompt = (
        f"List up to {n} real, currently-operating companies that match this description:\n"
        f"  {facet}\n\n"
        "Only real companies (no placeholders, no made-up names). Prefer well-known and "
        "mid-market names over obvious giants only. Return STRICT JSON and nothing else:\n"
        '{"companies": ["Company One", "Company Two"]}'
    )
    obj = llm.json_call(prompt, max_tokens=1500, model=model)
    names = (obj or {}).get("companies") or []
    out, seen = [], set()
    for x in names:
        if not isinstance(x, str):
            continue
        name = x.strip()
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            out.append(name)
    return out[:n]


def ground(names: list[str], session: requests.Session | None = None,
           exclude_keys: set[str] | None = None) -> tuple[list[Resolved], list[str], list[str]]:
    """Resolve each proposed name through the waterfall.

    Grounded → Resolved; ungrounded → unresolved; already ruled on by this human → skipped,
    before the resolver is asked (a dismissed name must cost neither a probe nor a re-ask).

    Within-batch dedup moved from `name.lower()` to the normalized key, so the two things this
    function compares names with are the same thing. The old `lower()` let 'Northern Trust'
    and the same name with a U+00A0 between the words through as two candidates, while
    `exclude_keys` would have matched either — so a batch could propose a name the exclusion
    had already removed.
    """
    session = session or requests.Session()
    exclude = exclude_keys or set()
    resolved: list[Resolved] = []
    unresolved: list[str] = []
    skipped: list[str] = []
    seen: set[str] = set()
    for name in names:
        key = company_name_key(name)
        if key in seen:
            continue
        seen.add(key)
        if key in exclude:
            skipped.append(name)
            continue
        ats, slug = _resolve_ats(name, session=session)
        if not ats:
            wd = discover_workday(name, session=session)
            if wd:
                ats, slug = "workday", wd
        if ats and slug:
            resolved.append(Resolved(name=name, ats=ats, slug=slug))
        else:
            unresolved.append(name)
    return resolved, unresolved, skipped


def discover_companies(facet: str, n: int = 30, *, session: requests.Session | None = None,
                       model: str | None = None,
                       exclude_keys: set[str] | None = None) -> DiscoveryResult:
    """Generate candidate names for a facet, then ground them. The whole loop, once."""
    names = generate_candidates(facet, n, model=model)
    resolved, unresolved, skipped = ground(names, session=session, exclude_keys=exclude_keys)
    return DiscoveryResult(facet=facet, resolved=resolved, unresolved=unresolved,
                           skipped=skipped)


def discover_for_user(facet: str, user_id: str, n: int = 30, *,
                      session: requests.Session | None = None,
                      model: str | None = None) -> DiscoveryResult:
    """`discover_companies` with this person's review verdicts already applied.

    The one call site that makes P7's decisions mean something to the engine: everything in
    their universe — approved, dismissed, or still waiting in the review pile — is excluded
    before a single board is probed. Without a v2 store `decided_name_keys` warns and returns
    an empty set, so this degrades to the plain loop rather than failing.
    """
    from monitor import universe   # local: keeps the keyless agent importable without core.pg

    return discover_companies(facet, n, session=session, model=model,
                              exclude_keys=universe.decided_name_keys(user_id, session=session))


if __name__ == "__main__":
    import os
    import sys

    facet = " ".join(sys.argv[1:]) or "proprietary trading firms headquartered in Chicago"
    # HQ_PG_USER_ID makes the CLI honor that person's verdicts, exactly as the scheduled pass
    # would. Without it this printed — and probed — every name they had already dismissed,
    # which made the CLI a demo of behaviour the product no longer has.
    _user = os.environ.get("HQ_PG_USER_ID", "")
    result = (discover_for_user(facet, _user, n=15) if _user
              else discover_companies(facet, n=15))
    print(f"facet: {result.facet}")
    print(f"grounded {len(result.resolved)}/{len(result.resolved) + len(result.unresolved)} "
          f"(within-batch recall {result.recall:.0%}):")
    for r in result.resolved:
        print(f"  ✓ {r.name}  →  {r.ats}/{r.slug}")
    if result.unresolved:
        print("  unresolved (→ aggregator/manual): " + ", ".join(result.unresolved))
    if result.skipped:
        print("  skipped (already reviewed): " + ", ".join(result.skipped))
