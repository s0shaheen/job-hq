from monitor import discovery_agent as da
from monitor.discovery_agent import (
    DiscoveryResult,
    discover_companies,
    generate_candidates,
    ground,
)


def test_generate_candidates_parses_dedupes_and_cleans(monkeypatch):
    monkeypatch.setattr("core.llm.json_call",
                        lambda *a, **k: {"companies": ["Stripe", "stripe ", "Ramp", 42, ""]})
    # case-insensitive dedupe; non-strings and blanks dropped
    assert generate_candidates("fintech", n=10) == ["Stripe", "Ramp"]


def test_generate_candidates_empty_on_llm_failure(monkeypatch):
    # LLM hiccup (no key / bad JSON) → [] , never a crash
    monkeypatch.setattr("core.llm.json_call", lambda *a, **k: None)
    assert generate_candidates("x") == []


def test_ground_splits_resolved_and_unresolved(monkeypatch):
    def fake_resolve(name, session=None):
        return {"Stripe": ("greenhouse", "stripe"), "Ramp": ("ashby", "ramp")}.get(name, (None, None))

    def fake_workday(name, session=None):
        return "ntrs.wd1.myworkdayjobs.com/northerntrust" if name == "Northern Trust" else None

    monkeypatch.setattr(da, "_resolve_ats", fake_resolve)
    monkeypatch.setattr(da, "discover_workday", fake_workday)

    resolved, unresolved = ground(["Stripe", "Ramp", "Northern Trust", "Nonexistent Co", "stripe"])
    assert [(r.name, r.ats, r.slug, r.tier) for r in resolved] == [
        ("Stripe", "greenhouse", "stripe", 1),
        ("Ramp", "ashby", "ramp", 1),
        ("Northern Trust", "workday", "ntrs.wd1.myworkdayjobs.com/northerntrust", 1),
    ]
    assert unresolved == ["Nonexistent Co"]   # the LLM name that couldn't be grounded; "stripe" deduped


def test_discover_companies_end_to_end_and_recall(monkeypatch):
    monkeypatch.setattr("core.llm.json_call", lambda *a, **k: {"companies": ["Stripe", "Ghost Co"]})
    monkeypatch.setattr(da, "_resolve_ats",
                        lambda name, session=None: ("greenhouse", "stripe") if name == "Stripe" else (None, None))
    monkeypatch.setattr(da, "discover_workday", lambda name, session=None: None)

    res = discover_companies("fintech", n=5)
    assert isinstance(res, DiscoveryResult)
    assert [r.name for r in res.resolved] == ["Stripe"]
    assert res.unresolved == ["Ghost Co"]      # proposed but ungrounded → not trusted
    assert res.recall == 0.5
