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

    resolved, unresolved, skipped = ground(
        ["Stripe", "Ramp", "Northern Trust", "Nonexistent Co", "stripe"])
    assert [(r.name, r.ats, r.slug, r.tier) for r in resolved] == [
        ("Stripe", "greenhouse", "stripe", 1),
        ("Ramp", "ashby", "ramp", 1),
        ("Northern Trust", "workday", "ntrs.wd1.myworkdayjobs.com/northerntrust", 1),
    ]
    assert unresolved == ["Nonexistent Co"]   # the LLM name that couldn't be grounded; "stripe" deduped
    assert skipped == []                      # nothing excluded: no verdicts were passed in


def test_discover_companies_end_to_end_and_recall(monkeypatch):
    monkeypatch.setattr("core.llm.json_call", lambda *a, **k: {"companies": ["Stripe", "Ghost Co"]})
    monkeypatch.setattr(da, "_resolve_ats",
                        lambda name, session=None: ("greenhouse", "stripe") if name == "Stripe" else (None, None))
    monkeypatch.setattr(da, "discover_workday", lambda name, session=None: None)

    res = discover_companies("fintech", n=5)
    assert isinstance(res, DiscoveryResult)
    assert [r.name for r in res.resolved] == ["Stripe"]
    assert res.unresolved == ["Ghost Co"]      # proposed but ungrounded → not trusted
    assert res.skipped == []
    assert res.recall == 0.5


# --- the human's verdict is an input: a reviewed name is never re-proposed ---------------------

def _resolver_that_grounds_everything(monkeypatch, probed):
    def fake_resolve(name, session=None):
        probed.append(name)
        return ("greenhouse", name.lower().replace(" ", ""))

    def boom(*a, **k):
        raise AssertionError("Workday must not be tried once discover() grounds the name")

    monkeypatch.setattr(da, "_resolve_ats", fake_resolve)
    monkeypatch.setattr(da, "discover_workday", boom)


def test_an_excluded_name_is_skipped_before_the_resolver_is_asked(monkeypatch):
    """A dismissed company must cost neither a re-ask nor an HTTP probe. `probed` is the
    assertion that makes the second half real — a filter applied AFTER grounding would
    still pay for every board."""
    probed: list[str] = []
    _resolver_that_grounds_everything(monkeypatch, probed)

    resolved, unresolved, skipped = ground(["Stripe", "Northern Trust"],
                                           exclude_keys={"northern trust"})
    assert [r.name for r in resolved] == ["Stripe"]
    assert skipped == ["Northern Trust"]
    assert unresolved == []
    assert probed == ["Stripe"], "the excluded name was probed anyway"


def test_exclusion_matches_on_the_normalized_key_not_the_raw_string(monkeypatch):
    """The LLM's spelling is not the human's. 'AON', 'aon' and a name carrying the NBSP a
    web page pasted in are one company; a raw-string comparison lets the re-proposal
    through on any of them."""
    probed: list[str] = []
    _resolver_that_grounds_everything(monkeypatch, probed)
    variants = ["AON", "aon", "  Aon  ", "Aon" + chr(0x00A0) + "Group"]

    resolved, _, skipped = ground(variants, exclude_keys={"aon"})
    assert skipped == ["AON"]                       # the first spelling; the rest dedupe to it
    assert [r.name for r in resolved] == ["Aon" + chr(0x00A0) + "Group"]   # a DIFFERENT company
    assert probed == ["Aon" + chr(0x00A0) + "Group"]


def test_within_batch_dedup_uses_the_same_key_as_the_exclusion(monkeypatch):
    """These were two different comparisons — `name.lower()` for dedup, the normalized key
    for exclusion — so a batch could propose a name the exclusion had already removed."""
    probed: list[str] = []
    _resolver_that_grounds_everything(monkeypatch, probed)
    resolved, _, skipped = ground(["Northern Trust", "  northern   trust  "])
    assert [r.name for r in resolved] == ["Northern Trust"]
    assert skipped == [] and probed == ["Northern Trust"]


def test_skipped_names_do_not_drag_recall_down(monkeypatch):
    """A name the human already ruled on was never a test of the resolver. Counting it
    would make recall drift downward for exactly the users who have reviewed the most."""
    monkeypatch.setattr("core.llm.json_call",
                        lambda *a, **k: {"companies": ["Stripe", "Ghost Co", "Dismissed Co"]})
    monkeypatch.setattr(da, "_resolve_ats",
                        lambda name, session=None: ("greenhouse", "stripe")
                        if name == "Stripe" else (None, None))
    monkeypatch.setattr(da, "discover_workday", lambda name, session=None: None)

    res = discover_companies("fintech", n=5, exclude_keys={"dismissed co"})
    assert res.skipped == ["Dismissed Co"]
    assert res.recall == 0.5      # 1 of 2 CONSIDERED, not 1 of 3


def test_discover_for_user_pulls_the_exclusions_from_the_review_verdicts(monkeypatch):
    """The wiring that makes P7's grid mean something to the engine."""
    from monitor import universe

    monkeypatch.setattr("core.llm.json_call",
                        lambda *a, **k: {"companies": ["Stripe", "Dismissed Co"]})
    probed: list[str] = []
    _resolver_that_grounds_everything(monkeypatch, probed)
    asked: list[str] = []

    def fake_decided(user_id, session=None, states=universe.REVIEW_STATES):
        asked.append(user_id)
        return {"dismissed co"}

    monkeypatch.setattr(universe, "decided_name_keys", fake_decided)

    res = da.discover_for_user("fintech", "user-1", n=5)
    assert asked == ["user-1"]
    assert res.skipped == ["Dismissed Co"]
    assert [r.name for r in res.resolved] == ["Stripe"]
