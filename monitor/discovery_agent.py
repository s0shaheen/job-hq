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

Cost: generate_candidates makes ONE Haiku call (cents); grounding is keyless HTTP. No writes.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import requests

from core import llm
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

    @property
    def recall(self) -> float:
        """Fraction of proposed names the waterfall could ground (a within-batch signal,
        not the oracle's market recall)."""
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


def ground(names: list[str], session: requests.Session | None = None) -> tuple[list[Resolved], list[str]]:
    """Resolve each proposed name through the waterfall. Grounded → Resolved; else unresolved."""
    session = session or requests.Session()
    resolved: list[Resolved] = []
    unresolved: list[str] = []
    seen: set[str] = set()
    for name in names:
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        ats, slug = _resolve_ats(name, session=session)
        if not ats:
            wd = discover_workday(name, session=session)
            if wd:
                ats, slug = "workday", wd
        if ats and slug:
            resolved.append(Resolved(name=name, ats=ats, slug=slug))
        else:
            unresolved.append(name)
    return resolved, unresolved


def discover_companies(facet: str, n: int = 30, *, session: requests.Session | None = None,
                       model: str | None = None) -> DiscoveryResult:
    """Generate candidate names for a facet, then ground them. The whole loop, once."""
    names = generate_candidates(facet, n, model=model)
    resolved, unresolved = ground(names, session=session)
    return DiscoveryResult(facet=facet, resolved=resolved, unresolved=unresolved)


if __name__ == "__main__":
    import sys

    facet = " ".join(sys.argv[1:]) or "proprietary trading firms headquartered in Chicago"
    result = discover_companies(facet, n=15)
    print(f"facet: {result.facet}")
    print(f"grounded {len(result.resolved)}/{len(result.resolved) + len(result.unresolved)} "
          f"(within-batch recall {result.recall:.0%}):")
    for r in result.resolved:
        print(f"  ✓ {r.name}  →  {r.ats}/{r.slug}")
    if result.unresolved:
        print("  unresolved (→ aggregator/manual): " + ", ".join(result.unresolved))
