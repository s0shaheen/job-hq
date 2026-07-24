from monitor.discover import (
    _greenhouse_board_name,
    _name_plausible,
    _probe,
    candidate_slugs,
    discover,
    interpret,
)

_GH = "https://boards-api.greenhouse.io/v1/boards"


class _FakeResp:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class _FakeSession:
    def __init__(self, by_url):
        self._by_url = by_url

    def get(self, url, timeout=None):
        return self._by_url.get(url, _FakeResp(404))


def test_probe_greenhouse_404_means_no_match():
    s = _FakeSession({"https://boards-api.greenhouse.io/v1/boards/x/jobs?content=false": _FakeResp(404)})
    assert _probe("greenhouse", "x", s) is False


def test_probe_smartrec_200_but_empty_is_NOT_a_match():
    # The real-world bug: smartrec returns 200 + totalFound=0 for unknown slugs.
    url = "https://api.smartrecruiters.com/v1/companies/nope/postings?limit=1"
    s = _FakeSession({url: _FakeResp(200, {"totalFound": 0, "content": []})})
    assert _probe("smartrec", "nope", s) is False


def test_probe_smartrec_200_with_postings_is_a_match():
    url = "https://api.smartrecruiters.com/v1/companies/canva/postings?limit=1"
    s = _FakeSession({url: _FakeResp(200, {"totalFound": 287, "content": [{"id": "1"}]})})
    assert _probe("smartrec", "canva", s) is True


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


# --- board-name verification (the grounded false-positive fix) ---

def test_name_plausible_accepts_exact_and_subset():
    assert _name_plausible("Stripe", "Stripe") is True
    assert _name_plausible("Cockroach Labs", "Cockroach Labs") is True
    assert _name_plausible("Scale AI", "Scale") is True          # board name is a subset


def test_name_plausible_is_suffix_insensitive():
    assert _name_plausible("Stripe", "Stripe, Inc.") is True
    assert _name_plausible("The Trade Desk", "Trade Desk") is True


def test_name_plausible_rejects_collision():
    # The grounded bug: slug "archer" (from "Archer Daniels Midland") resolves to a real
    # Greenhouse board named "Archer Veterinary Clinic". Sharing only "archer" is not enough.
    assert _name_plausible("Archer Daniels Midland", "Archer Veterinary Clinic") is False
    assert _name_plausible("Databricks", "Snowflake") is False


def test_greenhouse_board_name_reads_name():
    s = _FakeSession({f"{_GH}/stripe": _FakeResp(200, {"name": "Stripe"})})
    assert _greenhouse_board_name("stripe", s) == "Stripe"
    assert _greenhouse_board_name("missing", s) is None          # 404 -> None


def test_discover_rejects_greenhouse_collision():
    # "Archer Daniels Midland" -> candidate slug "archer" hits a real board, but the board
    # is "Archer Veterinary Clinic". Old code returned ("greenhouse","archer"); we reject it.
    s = _FakeSession({
        f"{_GH}/archer/jobs?content=false": _FakeResp(200),
        f"{_GH}/archer": _FakeResp(200, {"name": "Archer Veterinary Clinic"}),
    })
    assert discover("Archer Daniels Midland", session=s) == (None, None)


def test_discover_accepts_verified_greenhouse():
    s = _FakeSession({
        f"{_GH}/stripe/jobs?content=false": _FakeResp(200),
        f"{_GH}/stripe": _FakeResp(200, {"name": "Stripe"}),
    })
    assert discover("Stripe", session=s) == ("greenhouse", "stripe")


def test_discover_accepts_greenhouse_when_board_name_unavailable():
    # If the board-name endpoint is down (None), we do NOT over-reject a live posting hit.
    s = _FakeSession({
        f"{_GH}/acme/jobs?content=false": _FakeResp(200),
        f"{_GH}/acme": _FakeResp(500),
    })
    assert discover("Acme", session=s) == ("greenhouse", "acme")
