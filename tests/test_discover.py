from src.discover import candidate_slugs, interpret


def test_candidate_slugs_generates_variants():
    cands = candidate_slugs("Cerebras Systems")
    assert "cerebras" in cands
    assert "cerebrassystems" in cands
    assert "cerebras-systems" in cands


def test_interpret_picks_first_hit():
    probes = {"greenhouse:cerebras": False, "ashby:cerebras": True, "lever:cerebras": False}
    ats, slug = interpret(probes)
    assert ats == "ashby"
    assert slug == "cerebras"


def test_interpret_returns_none_when_no_hit():
    assert interpret({"greenhouse:x": False}) == (None, None)
